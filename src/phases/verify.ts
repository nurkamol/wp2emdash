/**
 * Phase 6 — verify. The old live site (audit snapshot) against the migrated site, URL by URL:
 * URLs, content, headings, SEO, links, forms, security, visual diff, accessibility, performance and
 * the burger-menu motion. Target: staging when target.stagingUrl is set (WP2EMDASH_TARGET=local for
 * the local dev server). Report: reports/verify/index.html (side-by-side screenshots) + verify.json.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { captureScreenshots, screenName } from "../audit/browser.js";
import { captureMenu, type MenuCapture, motionRecipe } from "../audit/interactions.js";
import { type PageSnapshot, parsePage } from "../audit/page.js";
import { siteHosts } from "../audit/urls.js";
import type { GateCheck } from "../core/state.js";
import type { IrPage } from "../ir/schema.js";
import { kitFetch, pinHost } from "../targets/emdash/net.js";
import { sourceText } from "../transform/coverage.js";
import { accessibility, type A11yResult, launchFor, measurePerformance, type PerfResult, visualDiff, type VisualResult } from "../verify/browser.js";
import { compareHeadings, compareMotion, compareSeo, compareText, type HeadingResult, missingExternalLinks, missingMenuItems, type SeoResult, type TextResult } from "../verify/compare.js";
import { verifyReport } from "../verify/report.js";
import type { PhaseContext } from "./index.js";
import { ensureDevServer } from "./load.js";

const readJson = <T>(file: string): T | undefined => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined);
const write = (file: string, data: unknown) => {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`);
};

export interface PageResult {
	path: string;
	name: string;
	sourceUrl: string;
	targetUrl: string;
	status: number;
	redirectedTo?: string;
	text?: TextResult;
	headings?: HeadingResult;
	seo?: SeoResult;
	missingExternal: string[];
	imagesWithoutAlt: string[];
	forms: { ok: boolean; detail: string }[];
	visual: Record<string, VisualResult>;
	a11y?: A11yResult;
	perf?: PerfResult;
}

export interface VerifyResult {
	target: string;
	targetUrl: string;
	ranAt: string;
	pages: PageResult[];
	brokenLinks: { href: string; status: number; on: string[] }[];
	security: { headers: Record<string, string | undefined>; missing: string[]; wpPaths: { path: string; status: number }[] };
	menu?: { itemsMissing: string[]; motion: { ok: boolean; diffs: string[] }; behaviour: Record<string, boolean | string | undefined> };
	forms: { endpoint: string; status: number }[];
}

export async function runVerify({ config, paths, reporter }: PhaseContext): Promise<GateCheck[]> {
	const checks: GateCheck[] = [];
	const check = (id: string, label: string, ok: boolean, detail?: string) => checks.push({ id, label, ok, ...(detail ? { detail } : {}) });
	const g = config.gates;

	// ── Target ─────────────────────────────────────────────────────────────────
	const want = (process.env.WP2EMDASH_TARGET ?? process.env.WP2EMDASH_LOAD_TARGET ?? (config.target.stagingUrl ? "staging" : "local")) as "local" | "staging";
	let base: string;
	let stop = () => {};
	const pins: { host: string; addresses: string[] }[] = [];
	if (want === "staging") {
		if (!config.target.stagingUrl) {
			check("target", "Verify target available", false, "Set target.stagingUrl or run with WP2EMDASH_TARGET=local");
			return checks;
		}
		base = config.target.stagingUrl.replace(/\/$/, "");
		const cf = readJson<{ staging?: { worker?: { addresses?: string[] } } }>(join(paths.root, "cloudflare.json"));
		const addresses = cf?.staging?.worker?.addresses ?? [];
		if (addresses.length) {
			const host = new URL(base).hostname;
			pinHost(host, addresses);
			pins.push({ host, addresses });
		}
	} else {
		const port = Number(process.env.WP2EMDASH_DEV_PORT ?? 4399);
		stop = await ensureDevServer(paths.project, port, (m) => reporter.emit({ type: "log", level: "info", message: m }));
		base = `http://localhost:${port}`;
	}

	try {
		return await verify();
	} finally {
		stop();
	}

	async function verify(): Promise<GateCheck[]> {
		const urls = readJson<{ url: string; path: string; status: number; kind: string; noindex?: boolean; wp?: { id: number } }[]>(join(paths.snapshot, "urls.json")) ?? [];
		const baseline = urls.filter((u) => u.kind === "page" && u.status === 200);
		const irPages = existsSync(join(paths.ir, "pages")) ? readdirSync(join(paths.ir, "pages")).map((f) => readJson<IrPage>(join(paths.ir, "pages", f)) as IrPage) : [];
		const published = new Set(irPages.filter((p) => p.source.status === "publish").map((p) => p.route?.path));
		const pagesToCheck = baseline.filter((u) => published.has(u.path) || published.has(u.path.replace(/\/$/, "")) || u.path === "/");
		const outDir = join(paths.reports, "verify");
		rmSync(join(outDir, "screens"), { recursive: true, force: true });
		rmSync(join(outDir, "diff"), { recursive: true, force: true });
		const tHosts = siteHosts(base);
		const prod = config.target.productionUrl.replace(/\/$/, "");

		// ── HTTP: every page, SEO, content, headings, links, forms ───────────────
		reporter.emit({ type: "step:start", step: "Pages", total: pagesToCheck.length });
		const results: PageResult[] = [];
		const targetSnaps = new Map<string, PageSnapshot>();
		for (const [i, u] of pagesToCheck.entries()) {
			const name = screenName(u.url);
			const targetUrl = `${base}${u.path}`;
			reporter.emit({ type: "step:progress", step: "Pages", done: i + 1, total: pagesToCheck.length, item: u.path });
			const r: PageResult = { path: u.path, name, sourceUrl: u.url, targetUrl, status: 0, missingExternal: [], imagesWithoutAlt: [], forms: [], visual: {} };
			try {
				const res = await kitFetch(targetUrl, { redirect: "manual" });
				r.status = res.status;
				if (res.status >= 300 && res.status < 400) r.redirectedTo = res.headers.get("location") ?? undefined;
				const html = await res.text();
				if (res.status === 200) {
					const snap = parsePage(html, { url: targetUrl, finalUrl: targetUrl, status: 200, redirects: [], contentType: res.headers.get("content-type") ?? "", ms: 0, ...(res.headers.get("x-robots-tag") ? { xRobotsTag: res.headers.get("x-robots-tag") as string } : {}) }, tHosts);
					targetSnaps.set(u.path, snap);
					const source = readJson<PageSnapshot>(join(paths.snapshot, "pages", `${name}.json`));
					const sourceHtml = existsSync(join(paths.snapshot, "html", `${name}.html`)) ? readFileSync(join(paths.snapshot, "html", `${name}.html`), "utf8") : "";
					if (source) {
						r.text = compareText(sourceText(sourceHtml), sourceText(html));
						r.headings = compareHeadings(source.headings, snap.headings);
						r.seo = compareSeo(source.seo, snap.seo, `${prod}${u.path}`, want === "staging");
						r.missingExternal = missingExternalLinks(source.links, snap.links);
						r.imagesWithoutAlt = snap.images.filter((im) => im.alt === undefined).map((im) => im.src);
						// Content forms only: the theme's search box is site chrome, not a migrated form.
						for (const sf of source.forms.filter((f) => !/search/i.test(f.provider ?? "") && !f.fields.every((x) => x.name === "s" || x.type === "hidden") && f.fields.some((x) => x.type !== "hidden"))) {
							const visible = (f: { type: string }) => !["hidden", "submit", "button"].includes(f.type);
							const want2 = sf.fields.filter(visible).map((x) => (x.type === "textarea" ? "textarea" : x.type)).sort();
							const tf = snap.forms.find((f) => f.fields.filter(visible).length >= want2.length);
							const have = (tf?.fields.filter(visible) ?? []).map((x) => (x.type === "textarea" ? "textarea" : x.type)).sort();
							const lacking = want2.filter((t, k) => want2.indexOf(t) === k && have.filter((h) => h === t).length < want2.filter((w) => w === t).length);
							r.forms.push({ ok: !!tf && lacking.length === 0, detail: tf ? (lacking.length ? `missing field types: ${lacking.join(", ")}` : `${have.length} fields`) : "form missing" });
						}
					}
				}
			} catch (e) {
				r.status = 0;
				r.redirectedTo = (e as Error).message;
			}
			results.push(r);
		}
		reporter.emit({ type: "step:end", step: "Pages", ok: results.every((r) => r.status === 200) });

		// Internal links found on the migrated pages must resolve.
		const linkMap = new Map<string, Set<string>>();
		for (const [path, snap] of targetSnaps) for (const l of snap.links) if (l.internal && !l.href.includes("#") && !/\/_emdash\//.test(l.href)) (linkMap.get(l.href) ?? linkMap.set(l.href, new Set()).get(l.href))?.add(path);
		const brokenLinks: VerifyResult["brokenLinks"] = [];
		for (const [href, on] of linkMap) {
			try {
				const res = await kitFetch(href.startsWith("http") ? href : `${base}${href}`, { redirect: "manual" });
				await res.body?.cancel();
				let status = res.status;
				if (status >= 300 && status < 400) {
					const loc = res.headers.get("location");
					const next = loc ? await kitFetch(new URL(loc, base).href, { redirect: "manual" }) : undefined;
					await next?.body?.cancel();
					status = next?.status ?? status;
				}
				if (status >= 400) brokenLinks.push({ href, status, on: [...on] });
			} catch {
				brokenLinks.push({ href, status: 0, on: [...on] });
			}
		}

		// Security headers and WordPress endpoints.
		const home = await kitFetch(`${base}/`);
		await home.body?.cancel();
		const want3 = ["strict-transport-security", "x-content-type-options", "referrer-policy", "permissions-policy", "content-security-policy"];
		const headers = Object.fromEntries(want3.map((h) => [h, home.headers.get(h) ?? undefined]));
		const frameOk = !!home.headers.get("x-frame-options") || /frame-ancestors/.test(home.headers.get("content-security-policy") ?? "");
		const missingHeaders = [...want3.filter((h) => !headers[h] && !(want === "local" && h === "strict-transport-security")), ...(frameOk ? [] : ["x-frame-options / frame-ancestors"])];
		const wpPaths: VerifyResult["security"]["wpPaths"] = [];
		for (const p of ["/wp-admin/", "/wp-login.php", "/xmlrpc.php", "/wp-json/"]) {
			const res = await kitFetch(`${base}${p}`, { redirect: "manual" });
			await res.body?.cancel();
			wpPaths.push({ path: p, status: res.status });
		}

		// Form endpoints (the starter posts to /api/forms/<id>).
		const formEndpoints: VerifyResult["forms"] = [];
		const formIds = new Set(irPages.flatMap((p) => p.sections.flatMap((s) => (s.type === "form" ? [`${s.fields.formRef.provider}-${s.fields.formRef.id}`] : []))));
		for (const id of formIds) {
			const res = await kitFetch(`${base}/api/forms/${id}`, { method: "POST", body: new URLSearchParams({ _hp: "" }), headers: { accept: "application/json", origin: base } });
			await res.body?.cancel();
			formEndpoints.push({ endpoint: `/api/forms/${id}`, status: res.status });
		}

		// ── Browser: screenshots + visual diff, accessibility, performance, menu ─
		const browser = await launchFor(pins);
		let menu: VerifyResult["menu"];
		try {
			const shots = await captureScreenshots(browser, results.filter((r) => r.status === 200).map((r) => r.targetUrl), config, join(outDir, "screens"), reporter);
			reporter.emit({ type: "step:start", step: "Visual diff", total: shots.length });
			for (const s of shots) {
				const r = results.find((x) => x.targetUrl === s.url);
				if (!r || !s.file) continue;
				const src = join(paths.snapshot, "screens", s.viewport, `${r.name}.png`);
				r.visual[s.viewport] = existsSync(src) ? visualDiff(src, s.file, join(outDir, "diff", s.viewport, `${r.name}.png`)) : { ratio: 1, comparedHeight: 0, sourceHeight: 0, targetHeight: s.height ?? 0, error: "no audit screenshot" };
			}
			reporter.emit({ type: "step:end", step: "Visual diff", ok: true });

			reporter.emit({ type: "step:start", step: "Accessibility & performance", total: results.length });
			for (const [i, r] of results.entries()) {
				if (r.status !== 200) continue;
				reporter.emit({ type: "step:progress", step: "Accessibility & performance", done: i + 1, total: results.length, item: r.path });
				r.a11y = await accessibility(browser, r.targetUrl);
				r.perf = await measurePerformance(browser, r.targetUrl);
			}
			reporter.emit({ type: "step:end", step: "Accessibility & performance", ok: true });

			// Burger menu: same capture as the audit, compared with the source recipe.
			const src = readJson<{ menus: MenuCapture[] }>(join(paths.snapshot, "interactions.json"))?.menus.find((m) => m.found && m.viewport === "mobile");
			const vp = config.audit.viewports.find((v) => v.name === "mobile") ?? { name: "mobile", width: 390, height: 844 };
			if (src) {
				const tgt = await captureMenu(browser, `${base}/`, vp, join(outDir, "interactions"));
				menu = {
					itemsMissing: tgt.found ? missingMenuItems(src.items, tgt.items) : ["menu toggle not found"],
					motion: tgt.found ? compareMotion(motionRecipe(src), motionRecipe(tgt)) : { ok: false, diffs: ["menu not captured"] },
					behaviour: { found: tgt.found, ...tgt.behaviour },
				};
			}
		} finally {
			await browser.close();
		}

		// ── Gate ────────────────────────────────────────────────────────────────
		const notOk = results.filter((r) => r.status !== 200);
		check("urls", "Every audited page answers 200 at the same path", notOk.length === 0, notOk.map((r) => `${r.path} ${r.status}${r.redirectedTo ? ` → ${r.redirectedTo}` : ""}`).join("; ") || `${results.length} pages`);
		const lowText = results.filter((r) => r.text && r.text.recall < g.textSimilarity);
		check("content", `Page text kept ≥ ${(g.textSimilarity * 100).toFixed(0)}%`, lowText.length === 0, lowText.map((r) => `${r.path} ${((r.text?.recall ?? 0) * 100).toFixed(1)}% (${r.text?.missing.slice(0, 5).join(", ")})`).join("; ") || `lowest ${(Math.min(...results.map((r) => r.text?.recall ?? 1)) * 100).toFixed(1)}%`);
		const badHead = results.filter((r) => r.headings && !r.headings.ok);
		check("headings", "Headings: same h1, every h1–h3 kept", badHead.length === 0, badHead.map((r) => `${r.path}: ${r.headings?.h1Source !== r.headings?.h1Target ? `h1 "${r.headings?.h1Target ?? "—"}" vs "${r.headings?.h1Source}"` : ""} ${r.headings?.missing.slice(0, 3).join(" | ")}`).join("; ") || undefined);
		const seoFail = (k: keyof SeoResult) => results.filter((r) => r.seo && !r.seo[k].ok).map((r) => r.path);
		check("seo-title", "SEO titles identical", seoFail("title").length === 0, seoFail("title").join(", ") || undefined);
		check("seo-description", "Meta descriptions identical", seoFail("description").length === 0, seoFail("description").join(", ") || undefined);
		check("seo-canonical", "Canonical URLs point at the production URL", seoFail("canonical").length === 0, seoFail("canonical").slice(0, 3).map((p) => `${p}: ${results.find((r) => r.path === p)?.seo?.canonical.target ?? "none"}`).join("; ") || undefined);
		check("seo-robots", want === "staging" ? "Staging is noindex" : "Indexability kept", seoFail("robots").length === 0, seoFail("robots").join(", ") || undefined);
		check("seo-jsonld", "Structured data types kept", seoFail("jsonLd").length === 0, [...new Set(results.flatMap((r) => r.seo?.jsonLd.missing ?? []))].join(", ") ? `missing: ${[...new Set(results.flatMap((r) => r.seo?.jsonLd.missing ?? []))].join(", ")}` : undefined);
		check("seo-og", "OpenGraph tags present", seoFail("og").length === 0, [...new Set(results.flatMap((r) => r.seo?.og.missing ?? []))].join(", ") || undefined);
		check("links-internal", "No broken internal links", brokenLinks.length === 0, brokenLinks.slice(0, 6).map((b) => `${b.href} (${b.status})`).join("; ") || `${linkMap.size} links checked`);
		const extMissing = results.filter((r) => r.missingExternal.length);
		check("links-external", "Booking, phone, email and social links kept", extMissing.length === 0, extMissing.map((r) => `${r.path}: ${r.missingExternal.slice(0, 3).join(", ")}`).join("; ") || undefined);
		const altMissing = results.filter((r) => r.imagesWithoutAlt.length);
		check("images-alt", "Every image has an alt attribute", altMissing.length === 0, altMissing.map((r) => `${r.path}: ${r.imagesWithoutAlt.length}`).join(", ") || undefined);
		const formFail = results.filter((r) => r.forms.some((f) => !f.ok));
		check("forms-fields", "Forms present with the same fields", formFail.length === 0, formFail.map((r) => `${r.path}: ${r.forms.map((f) => f.detail).join(", ")}`).join("; ") || undefined);
		const endpointFail = formEndpoints.filter((f) => f.status === 404 || f.status >= 500);
		check("forms-submit", "Form endpoints accept submissions", endpointFail.length === 0, endpointFail.map((f) => `${f.endpoint} HTTP ${f.status}`).join("; ") || formEndpoints.map((f) => `${f.endpoint} ${f.status}`).join(", ") || "no forms");
		check("security-headers", "Security headers set", missingHeaders.length === 0, missingHeaders.length ? `missing: ${missingHeaders.join(", ")}` : undefined);
		const wpOpen = wpPaths.filter((w) => w.status !== 404 && w.status !== 410);
		check("wp-endpoints", "WordPress endpoints gone (404/410)", wpOpen.length === 0, wpOpen.map((w) => `${w.path} ${w.status}`).join(", ") || undefined);
		const visualFails = results.flatMap((r) => Object.entries(r.visual).filter(([, v]) => v.ratio > g.visualDiff).map(([vp, v]) => `${r.path} ${vp} ${(v.ratio * 100).toFixed(1)}%`));
		check("visual", `Visual difference ≤ ${(g.visualDiff * 100).toFixed(0)}% per page × viewport`, visualFails.length === 0, visualFails.length ? `${visualFails.length} over: ${visualFails.slice(0, 6).join("; ")}` : undefined);
		const a11y = results.filter((r) => r.a11y && (r.a11y.serious.length || r.a11y.error));
		check("a11y", "Accessibility: no serious or critical axe violations", a11y.length === 0, a11y.map((r) => `${r.path}: ${r.a11y?.error ?? r.a11y?.serious.map((v) => v.id).join(", ")}`).slice(0, 6).join("; ") || undefined);
		const perfFail = results.filter((r) => r.perf && ((r.perf.lcpMs ?? 0) > g.maxLcpMs || (r.perf.cls ?? 0) > g.maxCls || r.perf.error));
		check("performance", `Lab LCP ≤ ${g.maxLcpMs} ms and CLS ≤ ${g.maxCls} (mobile)`, perfFail.length === 0, perfFail.map((r) => `${r.path}: ${r.perf?.error ?? `LCP ${r.perf?.lcpMs} ms, CLS ${r.perf?.cls}`}`).join("; ") || `worst LCP ${Math.max(...results.map((r) => r.perf?.lcpMs ?? 0))} ms`);
		if (menu) {
			const behaviourBad = Object.entries(menu.behaviour).filter(([k, v]) => k !== "closeButton" && v === false).map(([k]) => k);
			check("menu", "Burger menu: same items, timings within ±15%, accessible behaviour", menu.itemsMissing.length === 0 && menu.motion.ok && behaviourBad.length === 0, [menu.itemsMissing.length ? `missing items: ${menu.itemsMissing.join(", ")}` : "", ...menu.motion.diffs, behaviourBad.length ? `behaviour: ${behaviourBad.join(", ")}` : ""].filter(Boolean).join("; ") || undefined);
		}

		const out: VerifyResult = { target: want, targetUrl: base, ranAt: new Date().toISOString(), pages: results, brokenLinks, security: { headers, missing: missingHeaders, wpPaths }, ...(menu ? { menu } : {}), forms: formEndpoints };
		write(join(outDir, "verify.json"), out);
		write(join(outDir, "index.html"), verifyReport(config.name, out, checks, g.visualDiff));
		reporter.emit({ type: "log", level: "info", message: `Report: ${join(outDir, "index.html")}` });
		return checks;
	}
}
