import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { accessSection, exportsFor, previousSection, withAccessSection } from "../extract/plugin-exports.js";
import { join } from "node:path";
import { captureDesign, captureScreenshots, type DesignCapture, screenName, withBrowser } from "../audit/browser.js";
import { type Discovery, discoverRest, discoverSitemaps, type UrlSource } from "../audit/discover.js";
import { fingerprint } from "../audit/fingerprint.js";
import { fetchUrl, mapLimit } from "../audit/http.js";
import { scanIntegrations } from "../audit/integrations.js";
import { type PageSnapshot, parsePage } from "../audit/page.js";
import { captureHeaderScroll, captureMenu, type HeaderScrollCapture, type MenuCapture, motionRecipe } from "../audit/interactions.js";
import { auditReport, integrationsReport, interactionsReport, pluginMatrixReport } from "../audit/report.js";
import { isInternal, looksLikeAsset, matchesExclude, normalizeUrl, pathKey, siteHosts } from "../audit/urls.js";
import { loadOverrides } from "../config/overrides.js";
import type { GateCheck } from "../core/state.js";
import type { PhaseContext } from "./index.js";

export interface UrlRecord {
	url: string;
	path: string;
	sources: UrlSource[];
	status: number;
	finalUrl: string;
	redirects: { url: string; status: number }[];
	kind: "page" | "redirect" | "error" | "non-html";
	contentType: string;
	error?: string;
	wp?: { id: number; type: string };
	noindex: boolean;
	inSitemap: boolean;
	screenshot: boolean;
}

export interface LinkCheck {
	href: string;
	status: number;
	finalUrl: string;
	error?: string;
	foundOn: string[];
}

const write = (file: string, data: unknown) => writeFileSync(file, typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`);

export async function runAudit({ config, paths, reporter }: PhaseContext): Promise<GateCheck[]> {
	const site = siteHosts(config.source.url, config.source.alternateHosts);
	const snap = paths.snapshot;
	const reportDir = join(paths.reports, "audit");
	// Each audit is a fresh baseline: stale files from an earlier run must not survive.
	for (const d of [join(snap, "pages"), join(snap, "html"), join(snap, "screens"), join(snap, "interactions"), reportDir]) rmSync(d, { recursive: true, force: true });
	for (const d of [snap, join(snap, "pages"), join(snap, "html"), reportDir]) mkdirSync(d, { recursive: true });

	// 1. Discovery
	const sm = await discoverSitemaps(site, reporter);
	const rest = await discoverRest(site, reporter);
	const discovery: Discovery = { ...sm, ...rest };

	const sources = new Map<string, Set<UrlSource>>();
	const seed = (url: string, src: UrlSource) => {
		if (!isInternal(url, site) || looksLikeAsset(url) || matchesExclude(url, config.audit.exclude)) return;
		const key = normalizeUrl(url, site);
		const set = sources.get(key) ?? new Set();
		set.add(src);
		sources.set(key, set);
	};
	seed(`${site.origin}/`, "home");
	for (const u of discovery.sitemapUrls.keys()) seed(u, "sitemap");
	for (const i of discovery.items) seed(i.link, "rest");
	for (const t of discovery.terms) if (t.count > 0) seed(t.link, "rest");
	for (const a of discovery.authors) seed(a.link, "rest");

	// 2. Crawl + snapshot (breadth-first, bounded)
	const queue = [...sources.keys()];
	const visited = new Set<string>();
	const snapshots = new Map<string, PageSnapshot>();
	const records = new Map<string, UrlRecord>();
	const htmlSamples: string[] = [];
	let truncated = false;
	reporter.emit({ type: "step:start", step: "Crawl & snapshot" });

	while (queue.length) {
		const batch = queue.splice(0, config.audit.concurrency * 2).filter((u) => !visited.has(u));
		for (const u of batch) visited.add(u);
		await mapLimit(batch, config.audit.concurrency, async (url) => {
			const r = await fetchUrl(url);
			const isHtml = /text\/html|application\/xhtml/.test(r.contentType);
			const redirected = r.redirects.length > 0;
			const rec: UrlRecord = {
				url,
				path: pathKey(url),
				sources: [...(sources.get(url) ?? new Set<UrlSource>(["crawl"]))],
				status: r.status,
				finalUrl: r.finalUrl,
				redirects: r.redirects,
				kind: r.status === 0 || r.status >= 400 ? "error" : redirected ? "redirect" : isHtml ? "page" : "non-html",
				contentType: r.contentType,
				error: r.error,
				noindex: /noindex/i.test(r.headers["x-robots-tag"] ?? ""),
				inSitemap: discovery.sitemapUrls.has(url),
				screenshot: false,
			};
			if (isHtml && r.status === 200) {
				const page = parsePage(r.body, { url, finalUrl: r.finalUrl, status: r.status, redirects: r.redirects, contentType: r.contentType, ms: r.ms, xRobotsTag: r.headers["x-robots-tag"] }, site);
				snapshots.set(url, page);
				if (/noindex/i.test(page.seo.robots ?? "")) rec.noindex = true;
				if (page.wpId) rec.wp = { id: page.wpId, type: page.wpType ?? "unknown" };
				const name = screenName(url);
				write(join(snap, "html", `${name}.html`), r.body);
				write(join(snap, "pages", `${name}.json`), page);
				if (htmlSamples.length < 5) htmlSamples.push(r.body);
				if (!redirected) {
					for (const l of page.links) {
						if (!l.internal || looksLikeAsset(l.href) || matchesExclude(l.href, config.audit.exclude) || /\/wp-content\//.test(l.href)) continue;
						if (!sources.has(l.href)) sources.set(l.href, new Set(["crawl"]));
						if (!visited.has(l.href) && !queue.includes(l.href)) {
							if (visited.size + queue.length >= config.audit.maxUrls) truncated = true;
							else queue.push(l.href);
						}
					}
				}
			}
			// A redirect to another internal page: make sure the target is audited too.
			if (redirected && isInternal(r.finalUrl, site)) {
				const target = normalizeUrl(r.finalUrl, site);
				if (!sources.has(target)) sources.set(target, new Set(["crawl"]));
				if (!visited.has(target) && !queue.includes(target)) queue.push(target);
			}
			records.set(url, rec);
			reporter.emit({ type: "step:progress", step: "Crawl & snapshot", done: records.size, total: records.size + queue.length, item: rec.path });
		});
	}
	const urlRecords = [...records.values()].sort((a, b) => a.path.localeCompare(b.path));
	const fetchErrors = urlRecords.filter((r) => r.status === 0);
	reporter.emit({
		type: "step:end",
		step: "Crawl & snapshot",
		ok: fetchErrors.length === 0,
		detail: `${urlRecords.length} URLs: ${urlRecords.filter((r) => r.kind === "page").length} pages, ${urlRecords.filter((r) => r.kind === "redirect").length} redirects, ${urlRecords.filter((r) => r.kind === "error").length} errors${truncated ? " (TRUNCATED at maxUrls)" : ""}`,
	});

	// 3. Link check (external + internal 404s)
	reporter.emit({ type: "step:start", step: "Link check" });
	const linkMap = new Map<string, Set<string>>();
	for (const p of snapshots.values()) {
		for (const l of p.links) {
			if (/^(mailto|tel|sms|whatsapp):/i.test(l.href)) continue;
			if (l.internal && records.has(l.href)) continue; // already fetched
			if (l.internal && matchesExclude(l.href, config.audit.exclude)) continue;
			const set = linkMap.get(l.href) ?? new Set();
			set.add(pathKey(p.url));
			linkMap.set(l.href, set);
		}
	}
	const linkTargets = [...linkMap.keys()];
	let checked = 0;
	const linkChecks: LinkCheck[] = await mapLimit(linkTargets, 6, async (href) => {
		const r = await fetchUrl(href, { headOnly: true, timeoutMs: 15_000, retries: 1 });
		reporter.emit({ type: "step:progress", step: "Link check", done: ++checked, total: linkTargets.length, item: href.slice(0, 70) });
		return { href, status: r.status, finalUrl: r.finalUrl, error: r.error, foundOn: [...(linkMap.get(href) ?? [])].slice(0, 10) };
	});
	const brokenInternal = [
		...urlRecords.filter((r) => r.kind === "error" && r.sources.every((s) => s === "crawl")),
		...linkChecks.filter((l) => isInternal(l.href, site) && (l.status === 0 || l.status >= 400)),
	];
	const brokenExternal = linkChecks.filter((l) => !isInternal(l.href, site) && (l.status === 0 || l.status >= 400));
	reporter.emit({ type: "step:end", step: "Link check", ok: true, detail: `${linkChecks.length} checked, ${brokenInternal.length} broken internal, ${brokenExternal.length} external not OK (often bot-blocking)` });

	// 4. Screenshots + design capture
	const screenTargets = urlRecords.filter((r) => r.kind === "page").map((r) => r.url);
	const pagesForDesign = pickDesignPages(screenTargets, snapshots, site.origin);
	const { screens, design, menus, headers } = await withBrowser(async (browser) => {
		const screens = await captureScreenshots(browser, screenTargets, config, join(snap, "screens"), reporter);
		reporter.emit({ type: "step:start", step: "Design capture", total: pagesForDesign.length });
		const design: DesignCapture[] = [];
		const desktop = config.audit.viewports.at(-1) ?? { name: "desktop", width: 1440, height: 900 };
		const mobile = config.audit.viewports[0] ?? { name: "mobile", width: 390, height: 844 };
		for (const [i, url] of pagesForDesign.entries()) {
			// Tablet too when configured (between the two): page gutter and spacing often follow their own rule there.
			const tablet = config.audit.viewports.find((v) => v.name === "tablet" && v !== desktop && v !== mobile);
			for (const vp of [desktop, mobile, ...(tablet ? [tablet] : [])]) {
				try {
					design.push(await captureDesign(browser, url, vp, config.audit.maskSelectors));
				} catch (e) {
					reporter.emit({ type: "log", level: "warn", message: `design capture failed for ${url} (${vp.name}): ${(e as Error).message.split("\n")[0]}` });
				}
			}
			reporter.emit({ type: "step:progress", step: "Design capture", done: i + 1, total: pagesForDesign.length, item: new URL(url).pathname });
		}
		reporter.emit({ type: "step:end", step: "Design capture", ok: design.length > 0, detail: `${design.length} capture(s)` });

		// Interactions: navigation menu (open/close motion, behaviour) and header-on-scroll, per viewport, on the home page.
		reporter.emit({ type: "step:start", step: "Interactions", total: config.audit.viewports.length });
		const menus: MenuCapture[] = [];
		const headers: HeaderScrollCapture[] = [];
		for (const [i, vp] of config.audit.viewports.entries()) {
			menus.push(await captureMenu(browser, pagesForDesign[0] as string, vp, join(snap, "interactions")));
			const h = await captureHeaderScroll(browser, pagesForDesign[0] as string, vp, join(snap, "interactions")).catch(() => undefined);
			if (h) headers.push(h);
			reporter.emit({ type: "step:progress", step: "Interactions", done: i + 1, total: config.audit.viewports.length, item: vp.name });
		}
		const menuSummary = menus.map((m) => `${m.viewport}: ${m.found ? `${m.panel?.type ?? "panel?"} ${m.items.length} items, ${m.animations.length} anim` : "no toggle"}${m.error ? " (error)" : ""}`).join("; ");
		reporter.emit({ type: "step:end", step: "Interactions", ok: menus.every((m) => !m.error), detail: menuSummary });
		return { screens, design, menus, headers };
	});
	const screenOk = new Set(screens.filter((s) => s.file).map((s) => `${s.url}|${s.viewport}`));
	for (const r of urlRecords) r.screenshot = config.audit.viewports.every((vp) => screenOk.has(`${r.url}|${vp.name}`));

	// 5. Fingerprint + integrations
	reporter.emit({ type: "step:start", step: "Fingerprint & integrations" });
	const pages = [...snapshots.values()];
	const fp = fingerprint(pages, discovery.restNamespaces, htmlSamples, discovery.media.map((m) => m.sourceUrl));
	const integrations = scanIntegrations(pages);
	reporter.emit({
		type: "step:end",
		step: "Fingerprint & integrations",
		ok: true,
		detail: `theme ${fp.childTheme ?? fp.parentTheme ?? "?"}, builders ${Object.keys(fp.builders).join("+") || "none"}, ${fp.plugins.length} plugins, ${integrations.length} integrations`,
	});

	// 6. Write snapshot + reports
	const { sitemapUrls, ...discoveryRest } = discovery;
	write(join(snap, "discovery.json"), { ...discoveryRest, sitemapUrls: Object.fromEntries(sitemapUrls) });
	write(join(snap, "urls.json"), urlRecords);
	write(join(snap, "links.json"), linkChecks);
	write(join(snap, "screens.json"), screens);
	write(join(snap, "design.json"), design);
	write(join(snap, "interactions.json"), { menus: menus.map((m) => ({ ...m, recipe: motionRecipe(m) })), headers });
	write(join(snap, "fingerprint.json"), fp);
	write(join(snap, "integrations.json"), integrations);

	const ctx = { config, discovery, records: urlRecords, pages, linkChecks, brokenInternal, brokenExternal, screens, design, fp, integrations, truncated };
	write(join(reportDir, "audit.md"), auditReport(ctx));
	write(join(reportDir, "integrations.md"), integrationsReport(ctx));
	write(join(reportDir, "plugin-matrix.md"), pluginMatrixReport(ctx));
	// Plugin data the REST API does not expose: ask the owner for the exports, in ACCESS.md (rewritten each audit, ticks kept).
	const signals = [...fp.plugins.map((p) => p.name), ...integrations.flatMap((i) => (i.kind === "form" && i.form ? [i.form.provider] : []))];
	const exportsNeeded = exportsFor(signals);
	if (existsSync(paths.access)) {
		const access = readFileSync(paths.access, "utf8");
		write(paths.access, withAccessSection(access, accessSection(exportsNeeded, config.slug, previousSection(access))));
	}
	write(join(reportDir, "interactions.md"), interactionsReport({ config, menus, headers }));
	reporter.emit({ type: "log", level: "info", message: `Reports: ${reportDir}` });

	// 7. Gate
	const home = records.get(normalizeUrl(`${site.origin}/`, site));
	const failedScreens = screens.filter((s) => s.error);
	const unsupportedBuilders = Object.keys(fp.builders).filter((b) => ["elementor", "divi"].includes(b));
	const outOfScope = fp.plugins.filter((p) => p.action === "out-of-scope");
	// A form the owner decided to handle elsewhere (overrides.ts → integrations: "replace" | "drop", e.g. a waiver signed
	// in the booking system) is not rebuilt on the site, so it does not make the site sensitive.
	const decisions = (await loadOverrides(paths.overrides).catch(() => undefined))?.integrations ?? {};
	const handledElsewhere = (id: string) => decisions[id] === "replace" || decisions[id] === "drop";
	const sensitiveForms = integrations.filter((i) => i.form && i.form.sensitiveFields.length > 0 && !handledElsewhere(i.id));
	const parsedAll = urlRecords.filter((r) => r.kind === "page").every((r) => snapshots.has(r.url));

	return [
		{ id: "home-reachable", label: "Home page returns 200", ok: home?.status === 200, detail: home ? `HTTP ${home.status}` : "not fetched" },
		{ id: "no-fetch-errors", label: "Every discovered URL fetched (no network errors)", ok: fetchErrors.length === 0, detail: fetchErrors.length ? fetchErrors.slice(0, 5).map((r) => `${r.path}: ${r.error}`).join("; ") : `${urlRecords.length} URLs` },
		{ id: "not-truncated", label: `Crawl finished within maxUrls (${config.audit.maxUrls})`, ok: !truncated, detail: truncated ? "raise audit.maxUrls or add exclude patterns" : undefined },
		{ id: "snapshots", label: "Every HTML page snapshotted", ok: parsedAll },
		{ id: "screenshots", label: `Screenshots at ${config.audit.viewports.map((v) => v.width).join("/")}px for every page`, ok: failedScreens.length === 0, detail: failedScreens.length ? `${failedScreens.length} failed: ${failedScreens.slice(0, 3).map((s) => `${new URL(s.url).pathname}@${s.viewport}`).join(", ")}` : `${screens.length} captured` },
		{ id: "design", label: "Design captured for the home page", ok: design.some((d) => d.url === pagesForDesign[0]) },
		{
			id: "menu-captured",
			label: "Navigation menu captured (open state, motion, behaviour) where a toggle exists",
			ok: menus.every((m) => !m.error && (!m.found || (!!m.files.open && m.items.length > 0))),
			detail: menus.map((m) => `${m.viewport}: ${m.error ? `error ${m.error}` : m.found ? `${m.items.length} items` : "no toggle (inline nav)"}`).join("; "),
		},
		{ id: "builders-supported", label: "All page builders supported in v1", ok: unsupportedBuilders.length === 0, detail: unsupportedBuilders.length ? `found ${unsupportedBuilders.join(", ")} — accept only if those pages are rebuilt by hand` : Object.keys(fp.builders).join(", ") },
		{ id: "no-out-of-scope", label: "No out-of-scope plugins (shop, multilingual, membership)", ok: outOfScope.length === 0, detail: outOfScope.map((p) => p.name).join(", ") || undefined },
		{
			id: "sensitive-data-flag",
			label: "Sensitive form fields match the sensitiveData setting",
			ok: sensitiveForms.length === 0 || config.sensitiveData,
			detail: sensitiveForms.length ? `${sensitiveForms.map((f) => `${f.name}: ${f.form?.sensitiveFields.join(", ")}`).join("; ")}${config.sensitiveData ? "" : " — set sensitiveData: true in kit.config.ts"}` : undefined,
		},
	];
}

/** Home first, then one page per distinct builder/template signature, max 4. */
function pickDesignPages(urls: string[], snapshots: Map<string, PageSnapshot>, origin: string): string[] {
	const home = urls.find((u) => new URL(u).pathname === "/") ?? `${origin}/`;
	const out = [home];
	const seen = new Set<string>();
	// Text-rich pages first: they show the site's type and buttons; booking or map embeds bring their own styles.
	urls = [...urls].sort((a, b) => (snapshots.get(b)?.wordCount ?? 0) - (snapshots.get(a)?.wordCount ?? 0));
	for (const u of urls) {
		if (out.length >= 4) break;
		if (u === home) continue;
		const s = snapshots.get(u);
		const sig = `${s?.wpType}|${s?.builders.join("+")}|${s?.bodyClasses.find((c) => c.startsWith("page-template")) ?? ""}`;
		if (seen.has(sig)) continue;
		seen.add(sig);
		out.push(u);
	}
	// One page with a content button, so their style is measured (the header button is often a different one).
	const count = (u: string) => snapshots.get(u)?.buttonCount ?? 0;
	const floor = Math.min(...urls.map(count));
	const hasContent = (u: string) => count(u) > floor;
	const withButton = urls.find(hasContent);
	if (withButton && !out.slice(1).some(hasContent)) {
		if (out.length >= 4) out.pop();
		out.push(withButton);
	}
	// Fill up to four pages even when they share a template: type sizes are voted across pages, and the home page
	// (often a one-off hero) must not decide them alone.
	for (const u of urls) {
		if (out.length >= 4) break;
		if (!out.includes(u)) out.push(u);
	}
	// One page with a form, so the fields' look is measured (an extra page: it does not displace a type sample).
	const hasForm = (u: string) => (snapshots.get(u)?.forms ?? []).some((f) => f.provider !== "wp-search" && !f.inPopup);
	const withForm = urls.find(hasForm);
	if (withForm && !out.some(hasForm)) out.push(withForm);
	return out;
}
