/**
 * Phase 4 — scaffold. Generates sites/<slug>/project/: the starter + per-site tokens, motion,
 * header config, forms, seed (section library, collections, menus, and the migrated content for
 * local preview). Installs, builds, measures the Worker bundle. Never deploys: staging deploy is
 * an owner-approved step (load, M6).
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import type { OgCardOptions } from "../../packages/og/src/index.js";
import { OG_DEPENDENCIES, ogColors, ogFonts } from "../scaffold/og.js";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MenuCapture } from "../audit/interactions.js";
import { KIT_ROOT } from "../core/paths.js";
import type { GateCheck } from "../core/state.js";
import type { IrPage, IrSite } from "../ir/schema.js";
import { selfHostGoogleFonts } from "../scaffold/fonts.js";
import { clientRepoFiles, deployScripts, writeClientRepo } from "../scaffold/client-repo.js";
import { applySensitivePolicy, fluentFormToDefinition, type FormDefinitionOut } from "../scaffold/forms.js";
import { applyStackBreakpoint, buildMotion, buildSiteConfig, buildTokens, type DesignCapture, fluid, type HeaderCapture, headerTokens, panelExtras, stackBreakpoint } from "../scaffold/generate.js";
import { buildSeed, type MediaInfo, seedMediaResolver } from "../scaffold/seed.js";
import { BLOCK_TYPES } from "../starter/library.js";
import type { MediaEntry } from "./extract.js";
import type { PhaseContext } from "./index.js";

/** Versions verified together in docs/spikes (M0 + M5). Upgrades are deliberate: bump here, rerun verify. */
export const STACK = {
	node: ">=24",
	astro: "7.4.12",
	emdash: "1.5.0",
	"@emdash-cms/cloudflare": "1.5.0",
	"@astrojs/cloudflare": "14.4.8",
	"@astrojs/react": "7.1.9",
	react: "19.2.4",
	"react-dom": "19.2.4",
	wrangler: "4.163.0",
	"@cloudflare/workers-types": "5.20261116.1",
	"@astrojs/check": "0.9.12",
	/** astro check (via @astrojs/check) supports TypeScript 5–6 only; without a pin the newest (7) is picked up. */
	typescript: "6.0.3",
	pnpm: "11.18.0",
} as const;

interface CloudflareResources {
	staging?: { d1?: { name: string; id: string; fingerprint?: string }; r2?: { bucket: string }; worker?: { url?: string }; outbox?: { id: string } };
	production?: { d1?: { name: string; id: string; fingerprint?: string }; r2?: { bucket: string }; live?: boolean; outbox?: { id: string } };
}

const readJson = <T>(file: string): T | undefined => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined);
const write = (file: string, data: string | object) => {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, typeof data === "string" ? data : `${JSON.stringify(data, null, 2)}\n`);
};

function run(cmd: string, args: string[], cwd: string, onLine: (l: string) => void, timeoutMs = 600_000): Promise<{ code: number; out: string }> {
	return new Promise((resolve) => {
		const p = spawn(cmd, args, { cwd, env: { ...process.env, CI: "1", FORCE_COLOR: "0", ASTRO_TELEMETRY_DISABLED: "1" } });
		let out = "";
		const take = (b: Buffer) => {
			const s = b.toString();
			out += s;
			for (const l of s.split("\n")) if (l.trim()) onLine(l.trim().slice(0, 200));
		};
		p.stdout.on("data", take);
		p.stderr.on("data", take);
		const t = setTimeout(() => p.kill("SIGTERM"), timeoutMs);
		p.on("close", (code) => {
			clearTimeout(t);
			resolve({ code: code ?? 1, out });
		});
		p.on("error", (e) => {
			clearTimeout(t);
			resolve({ code: 1, out: String(e) });
		});
	});
}

export interface ScaffoldOptions {
	install?: boolean;
	build?: boolean;
}

export async function runScaffold({ config, paths, reporter }: PhaseContext, opts: ScaffoldOptions = { install: true, build: true }): Promise<GateCheck[]> {
	const checks: GateCheck[] = [];
	const check = (id: string, label: string, ok: boolean, detail?: string) => checks.push({ id, label, ok, ...(detail ? { detail } : {}) });
	if (config.target.kind !== "emdash") {
		check("target", "Target supported by scaffold", false, `target.kind "${config.target.kind}" is planned for M10`);
		return checks;
	}
	const ir = paths.ir;
	const site = readJson<IrSite>(join(ir, "site.json"));
	if (!site) {
		check("ir-present", "Transform output present", false, "Run transform first (ir/site.json missing)");
		return checks;
	}
	const loadDir = (d: string) => (existsSync(join(ir, d)) ? readdirSync(join(ir, d)).filter((f) => f.endsWith(".json")).map((f) => readJson<IrPage>(join(ir, d, f)) as IrPage) : []);
	const pages = loadDir("pages");
	const partials = site.partials.map((p) => readJson<IrPage>(join(ir, p.file))).filter((p): p is IrPage => !!p);
	const popups = site.popups.map((p) => readJson<IrPage>(join(ir, p.file))).filter((p): p is IrPage => !!p);

	// ── Inputs from the audit ──────────────────────────────────────────────────
	const designs = readJson<DesignCapture[]>(join(paths.snapshot, "design.json")) ?? [];
	const interactions = readJson<{ menus: MenuCapture[]; headers: HeaderCapture[] }>(join(paths.snapshot, "interactions.json")) ?? { menus: [], headers: [] };
	const fingerprint = readJson<{ uploadsBase?: string; restUploadsBase?: string; hiddenWpPaths?: boolean }>(join(paths.snapshot, "fingerprint.json")) ?? {};
	const manifest = readJson<MediaEntry[]>(join(paths.raw, "media-manifest.json")) ?? [];
	const project = paths.project;

	reporter.emit({ type: "step:start", step: "Generate project" });
	const tokens = buildTokens(designs);
	const motion = buildMotion(interactions.menus);

	// Media: live URLs (WordPress stays up during the migration); hidden upload paths rewritten to the public one.
	const library = new Map<number, MediaInfo>(manifest.filter((m) => m.id).map((m) => [m.id as number, { id: m.id, url: m.url, ...(m.alt ? { alt: m.alt } : {}) }]));
	const rewrite = (u: string) => (fingerprint.hiddenWpPaths && fingerprint.restUploadsBase && fingerprint.uploadsBase ? u.replace(fingerprint.restUploadsBase, fingerprint.uploadsBase) : u);
	const media = seedMediaResolver(library, (u) => rewrite(u.startsWith("/") ? `${config.source.url.replace(/\/$/, "")}${u}` : u));

	// Brand assets: copy captured logos/favicon from raw/media into public/brand.
	const legacyFiles: Record<string, string> = {};
	const brandFile = (url: string | undefined, name: string): string | undefined => {
		if (!url) return undefined;
		// Match by uploads path, ignoring WordPress size variants (-32x32, -scaled): the library holds the original.
		const norm = (u: string) => decodeURIComponent(u.split(/[?#]/)[0] ?? "").replace(/^.*\/(?:wp-content\/uploads|storage)\//, "").replace(/-\d+x\d+(?=\.[a-z0-9]+$)/i, "").replace(/-scaled(?=\.[a-z0-9]+$)/i, "").toLowerCase();
		const key = norm(url);
		const entry = manifest.find((m) => m.file && norm(`/storage/${m.file}`) === key);
		if (!entry?.file) return url; // not in the library: keep the live URL, flagged below
		const ext = entry.file.split(".").pop();
		const dest = join(project, "public", "brand", `${name}.${ext}`);
		mkdirSync(dirname(dest), { recursive: true });
		cpSync(join(paths.raw, "media", entry.file), dest);
		const local = `/brand/${name}.${ext}`;
		// The old address keeps working (other sites, email signatures, cached previews): middleware 301s it here.
		try {
			legacyFiles[new URL(url, config.source.url).pathname] = local;
		} catch {}
		return local;
	};
	const header = interactions.headers.find((h) => h.viewport === "desktop") ?? interactions.headers[0];
	const desktopDesign = designs.find((d) => d.viewport === "desktop");

	// Copy the starter (kit-owned files are overwritten; content lives in the database, not in files).
	mkdirSync(project, { recursive: true });
	// The starter's README documents the starter for kit developers; the client gets its own (client-repo.ts).
	cpSync(join(KIT_ROOT, "starter"), project, { recursive: true, filter: (src) => !/node_modules|\/dist\//.test(src) && src !== join(KIT_ROOT, "starter", "README.md") });
	// Forms live in the kit's @wp2emdash/forms package; the project gets its own copy (linked from package.json) so the
	// client repository builds on its own. Files from before the package existed are removed.
	rmSync(join(project, "packages", "forms"), { recursive: true, force: true });
	cpSync(join(KIT_ROOT, "packages", "forms"), join(project, "packages", "forms"), { recursive: true, filter: (src) => !/node_modules/.test(src) });
	for (const old of ["src/forms/deliver.ts", "src/forms/outbox.ts", "src/plugins"]) rmSync(join(project, old), { recursive: true, force: true });
	const brand = {
		logo: brandFile(header?.scrolled.logoSrc ?? desktopDesign?.logo?.src, "logo"),
		logoOnTop: header?.top.logoSrc && header.top.logoSrc !== header.scrolled.logoSrc ? brandFile(header.top.logoSrc, "logo-on-dark") : undefined,
		favicon: brandFile(desktopDesign?.favicon, "favicon"),
	};
	const lang = (readJson<{ site?: { language?: string } }>(join(paths.raw, "exporter", "probe.json"))?.site?.language ?? "en").split(/[-_]/)[0] ?? "en";
	const trailing = config.target.trailingSlash === "preserve" ? (pages.every((p) => !p.route || p.route.path === "/" || p.route.path.endsWith("/")) ? "always" : "never") : config.target.trailingSlash;
	const baseConfig = buildSiteConfig(config, tokens, motion, interactions.menus, interactions.headers, brand, lang);
	const primaryLabels = (site.menus.find((mm) => mm.role === "primary")?.items ?? []).map((i) => i.label);
	const mobileMenu = interactions.menus.find((mm) => mm.found && mm.viewport === "mobile");
	const desktopMenu = interactions.menus.find((mm) => mm.found && mm.viewport === "desktop");
	const itemPx = (mm?: MenuCapture) => Number.parseFloat((mm as unknown as { itemStyle?: { fontSize?: string } } | undefined)?.itemStyle?.fontSize ?? "");
	// Analytics: the config's choice, else the ids the audit saw on the live pages (UA- is retired and dropped).
	const snapPages = readdirSync(join(paths.snapshot, "pages")).map((f) => readJson<{ trackingIds?: string[]; seo?: { og?: Record<string, string>; verification?: Record<string, string> } }>(join(paths.snapshot, "pages", f)) ?? {});
	// Ownership meta tags (Search Console etc.) from any captured page.
	const verification = Object.assign({}, ...snapPages.map((p) => p.seo?.verification ?? {})) as Record<string, string>;
	const audited = [...new Set(snapPages.flatMap((p) => p.trackingIds ?? []))];
	// og:locale as the SEO plugin published it (en_US); EmDash's head does not emit one.
	const ogLocale = snapPages.map((p) => p.seo?.og?.["og:locale"]).find((l) => l && /^[a-z]{2}(?:_[A-Z]{2})?$/.test(l));
	const analytics = config.analytics === false ? undefined : (config.analytics ?? { google: audited.filter((id) => /^(?:GT|G|AW)-/.test(id)).sort(), ...(audited.find((id) => id.startsWith("GTM-")) ? { gtm: audited.find((id) => id.startsWith("GTM-")) } : {}) });
	const hasAnalytics = !!analytics && (analytics.google.length > 0 || !!analytics.gtm || !!analytics.cloudflareToken);
	if (hasAnalytics) reporter.emit({ type: "log", level: "info", message: `analytics on the production domain: ${[...(analytics?.google ?? []), analytics?.gtm, analytics?.cloudflareToken ? "Cloudflare beacon" : ""].filter(Boolean).join(", ")}` });
	const siteConfig = {
		...baseConfig,
		header: { ...baseConfig.header, panelExtras: panelExtras(interactions.menus, primaryLabels), ...(Number.isFinite(itemPx(mobileMenu)) ? { panelItemSize: Number.isFinite(itemPx(desktopMenu)) ? fluid(itemPx(mobileMenu), itemPx(desktopMenu)) : `${itemPx(mobileMenu)}px` } : {}) },
		trailingSlash: trailing,
		...(hasAnalytics ? { analytics } : {}),
		...(ogLocale ? { ogLocale } : {}),
		...(Object.keys(legacyFiles).length ? { legacyFiles } : {}),
		// WordPress numeric links (/?p=40, /?page_id=40) keep resolving: post id → path of each published page/post.
		wpIds: Object.fromEntries(pages.flatMap((p) => (p.source.wpId && p.route?.path && p.source.status === "publish" ? [[String(p.source.wpId), p.route.path]] : []))),
		...(Object.keys(verification).length ? { verification } : {}),
		// Structured data: the business (from the live site's JSON-LD) and each page's schema type (AboutPage, ContactPage…).
		structuredData: {
			...(site.business ? { business: site.business } : {}),
			pageTypes: Object.fromEntries(pages.flatMap((p) => {
				const t = (p.seo.jsonLdTypes ?? []).flatMap((x) => x.split("+")).find((x) => /^(AboutPage|ContactPage|FAQPage|CollectionPage|ItemPage|ProfilePage|CheckoutPage|MedicalWebPage)$/.test(x));
				return p.route && t ? [[p.route.path, t]] : [];
			})),
		},
	};
	// Fonts: self-host Google Fonts (faster, no swap shift, no visitor IPs to Google); the Google link stays as fallback.
	let fontsCss = "/* No self-hosted fonts (none on Google Fonts, or the download failed). */\n";
	if (siteConfig.fonts.googleHref) {
		try {
			const hosted = await selfHostGoogleFonts(siteConfig.fonts.googleHref, join(project, "public"), { body: siteConfig.fonts.body, display: siteConfig.fonts.display, displayWeight: siteConfig.fonts.displayWeight ?? 400 });
			if (hosted) {
				fontsCss = hosted.css;
				const { googleHref: _g, ...rest } = siteConfig.fonts;
				siteConfig.fonts = { ...rest, selfHosted: true, preload: hosted.preload };
				reporter.emit({ type: "log", level: "info", message: `fonts self-hosted: ${hosted.files} files, ${hosted.preload.length} preloaded` });
			}
		} catch (e) {
			reporter.emit({ type: "log", level: "warn", message: `fonts not self-hosted (Google Fonts kept): ${(e as Error).message}` });
		}
	}
	write(join(project, "src", "styles", "fonts.css"), fontsCss);
	// Experimental sharing cards (@wp2emdash/og): fonts as TTF, colours from the tokens, the logo; off unless og.cards.
	rmSync(join(project, "packages", "og"), { recursive: true, force: true });
	let og: OgCardOptions | undefined;
	if (config.og.cards) {
		try {
			const productionHost = new URL(siteConfig.productionUrl).host.replace(/^www\./, "");
			og = { siteName: config.name, domain: productionHost, ...(brand.logo?.startsWith("/") ? { logo: brand.logo } : {}), colors: ogColors(tokens.css), fonts: await ogFonts(join(project, "public"), { display: siteConfig.fonts.display, body: siteConfig.fonts.body, ...(siteConfig.fonts.displayWeight ? { displayWeight: siteConfig.fonts.displayWeight } : {}) }), ...(siteConfig.fonts.displayWeight ? { displayWeight: siteConfig.fonts.displayWeight } : {}) };
			cpSync(join(KIT_ROOT, "packages", "og"), join(project, "packages", "og"), { recursive: true, filter: (src) => !/node_modules/.test(src) });
			(siteConfig as { ogCards?: boolean }).ogCards = true;
			reporter.emit({ type: "log", level: "info", message: "sharing cards on (@wp2emdash/og)" });
		} catch (e) {
			reporter.emit({ type: "log", level: "warn", message: `sharing cards off: ${(e as Error).message}` });
		}
	}
	// Experimental SEO panel in the page editor (@wp2emdash/seo); off unless seo.panel.
	rmSync(join(project, "packages", "seo"), { recursive: true, force: true });
	// IndexNow key: derived from the production host (stable across reruns, nothing to store); its file sits at the
	// domain root so it covers every URL. Submissions start once production.live is set (after the switch).
	const indexNowKey = createHash("sha256").update(`indexnow:${new URL(siteConfig.productionUrl).host}`).digest("hex").slice(0, 32);
	for (const f of existsSync(join(project, "public")) ? readdirSync(join(project, "public")) : []) if (/^[0-9a-f]{32}\.txt$/.test(f) && f !== `${indexNowKey}.txt`) rmSync(join(project, "public", f));
	if (config.seo.panel) writeFileSync(join(project, "public", `${indexNowKey}.txt`), indexNowKey);
	else rmSync(join(project, "public", `${indexNowKey}.txt`), { force: true });
	const seoPanel = config.seo.panel ? { productionUrl: siteConfig.productionUrl, titleSeparator: /\s([-–—|·•])\s/.exec(pages.find((p) => p.route?.isFrontPage)?.seo.title ?? "")?.[1] ?? "-", collections: ["pages"], ...(og ? { ogCards: true } : {}), indexNow: { key: indexNowKey, live: !!readJson<CloudflareResources>(join(paths.root, "cloudflare.json"))?.production?.live } } : undefined;
	if (seoPanel) cpSync(join(KIT_ROOT, "packages", "seo"), join(project, "packages", "seo"), { recursive: true, filter: (src) => !/node_modules/.test(src) });
	write(join(project, "src", "site.config.json"), siteConfig);
	write(join(project, "src", "styles", "tokens.css"), tokens.css + headerTokens(interactions.headers, siteConfig.header.breakpoint));
	write(join(project, "src", "styles", "motion.css"), motion.css);
	const basePath = join(project, "src", "styles", "base.css");
	write(basePath, applyStackBreakpoint(readFileSync(basePath, "utf8"), stackBreakpoint(designs)));

	// Forms (generated files are cleared first so removed forms do not linger)
	for (const f of existsSync(join(project, "src", "forms")) ? readdirSync(join(project, "src", "forms")) : []) if (f.endsWith(".json")) rmSync(join(project, "src", "forms", f));
	const forms: FormDefinitionOut[] = [];
	const ffDir = join(paths.raw, "forms", "fluent-forms");
	if (existsSync(ffDir)) {
		for (const f of readdirSync(ffDir)) {
			const raw = readJson<{ id: string; title: string; status: string; form: { form_fields?: Record<string, unknown> }; settings?: Record<string, unknown> }>(join(ffDir, f));
			if (!raw || !/^publish(ed)?$/.test(raw.status)) continue; // never "unpublished"
			const def = applySensitivePolicy(fluentFormToDefinition(raw, config.sensitiveData), config.forms.sensitive, config.forms.notice);
			forms.push(def);
			if (def.withheld?.length) reporter.emit({ type: "log", level: "info", message: `${def.id}: not collected under forms.sensitive="${config.forms.sensitive}": ${def.withheld.join(", ")}` });
			const { warnings: _w, withheld: _h, ...out } = def;
			write(join(project, "src", "forms", `${def.id}.json`), out);
		}
	}
	// Bricks form elements: definitions taken from the element settings by transform (ir/forms, recipients never copied).
	const irForms = join(paths.ir, "forms");
	for (const f of existsSync(irForms) ? readdirSync(irForms).filter((x) => x.endsWith(".json")) : []) {
		const raw = readJson<FormDefinitionOut>(join(irForms, f));
		if (!raw) continue;
		const def = applySensitivePolicy({ ...raw, ...(config.sensitiveData ? { sensitive: true } : {}) }, config.forms.sensitive, config.forms.notice);
		forms.push(def);
		if (def.withheld?.length) reporter.emit({ type: "log", level: "info", message: `${def.id}: not collected under forms.sensitive="${config.forms.sensitive}": ${def.withheld.join(", ")}` });
		const { warnings: _w, withheld: _h, ...out } = def;
		write(join(project, "src", "forms", `${def.id}.json`), out);
	}

	// Seed (with the migrated content for local preview)
	const sep = /\s([-–—|·•])\s/.exec(pages.find((p) => p.route?.isFrontPage)?.seo.title ?? "")?.[1] ?? "-";
	const drops: string[] = [];
	const seed = buildSeed({ name: config.name, site, pages, partials, popups, media, titleSeparator: sep, forms, includeContent: true, onDrop: (m) => drops.push(m) });
	for (const d of drops) reporter.emit({ type: "log", level: "info", message: `not stored (no matching field): ${d}` });
	write(join(project, "seed", "seed.json"), seed);

	// package.json, astro.config.mjs, wrangler.jsonc
	// Compatibility date: keep the project's existing one (a rerun must not silently change runtime behaviour);
	// a new (or under-a-week-old) one uses a week back, because the local workerd binary can lag today's date by a few days.
	const prevWrangler = existsSync(join(project, "wrangler.jsonc")) ? readFileSync(join(project, "wrangler.jsonc"), "utf8") : "";
	const weekBack = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
	const kept = /"compatibility_date":\s*"(\d{4}-\d{2}-\d{2})"/.exec(prevWrangler)?.[1];
	const today = kept && kept < weekBack ? kept : weekBack;
	const workerName = `${config.slug}`.replace(/[^a-z0-9-]/g, "-");
	// Cloudflare resource ids (created once, owner-approved) live in sites/<slug>/cloudflare.json.
	const cf = readJson<CloudflareResources>(join(paths.root, "cloudflare.json")) ?? {};
	write(join(project, "package.json"), {
		name: `${config.slug}-site`,
		version: "0.1.0",
		private: true,
		type: "module",
		engines: { node: STACK.node },
		packageManager: `pnpm@${STACK.pnpm}`,
		emdash: { label: config.name, seed: "seed/seed.json" },
		// The Cloudflare adapter flattens wrangler.jsonc at BUILD time: the environment is chosen with CLOUDFLARE_ENV during
		// the build. EmDash core migrations run BEFORE the new build serves traffic; emdash migrate reads
		// CLOUDFLARE_API_TOKEN/ACCOUNT_ID from the shell. Not named "deploy": that is a pnpm built-in command.
		scripts: { dev: "astro dev", build: "astro build", preview: "astro preview", check: "astro check", ...deployScripts(cf.staging?.d1?.fingerprint, cf.production?.d1?.fingerprint) },
		dependencies: {
			"@astrojs/cloudflare": STACK["@astrojs/cloudflare"],
			"@astrojs/react": STACK["@astrojs/react"],
			"@emdash-cms/cloudflare": STACK["@emdash-cms/cloudflare"],
			"@wp2emdash/forms": "link:./packages/forms",
			...(og ? { "@wp2emdash/og": "link:./packages/og", ...OG_DEPENDENCIES } : {}),
			...(seoPanel ? { "@wp2emdash/seo": "link:./packages/seo" } : {}),
			astro: STACK.astro,
			emdash: STACK.emdash,
			react: STACK.react,
			"react-dom": STACK["react-dom"],
		},
		devDependencies: { "@astrojs/check": STACK["@astrojs/check"], "@cloudflare/workers-types": STACK["@cloudflare/workers-types"], typescript: STACK.typescript, wrangler: STACK.wrangler },
	});
	write(
		join(project, "astro.config.mjs"),
		`// Generated by wp2emdash scaffold. Runtime: workerd (V8) with nodejs_compat; build: Node ${STACK.node}.
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";${config.forms.outbox ? '\nimport { formsPlugin } from "@wp2emdash/forms";' : ""}${og ? '\nimport { ogPlugin } from "@wp2emdash/og";' : ""}${seoPanel ? '\nimport { seoPlugin } from "@wp2emdash/seo";' : ""}

export default defineConfig({
	site: ${JSON.stringify(siteConfig.productionUrl)},
	output: "server",
	// "ignore": EmDash's own routes (/_emdash/…) must match without a slash. The site's URL style
	// (${trailing}) is enforced for page paths in src/middleware.ts via site.config.json.
	trailingSlash: "ignore",
	adapter: cloudflare(),
	image: { layout: "constrained", responsiveStyles: true },
	integrations: [
		react(),
		emdash({
			database: d1({ binding: "DB", session: "auto", coalesce: true }),
			storage: r2({ binding: "MEDIA" }),
			mcp: false,${config.forms.outbox || og || seoPanel ? `
			// Admin plugins: Form messages (form outbox, admins only — @wp2emdash/forms), Sharing images (@wp2emdash/og),
			// SEO panel in the page editor (@wp2emdash/seo).
			plugins: [${[config.forms.outbox ? "formsPlugin()" : "", og ? `ogPlugin(${JSON.stringify(og)})` : "", seoPanel ? `seoPlugin(${JSON.stringify(seoPanel)})` : ""].filter(Boolean).join(", ")}],` : ""}
		}),
	],
	devToolbar: { enabled: false },
});
`,
	);
	const d1 = (env: "staging" | "production", fallback: string) => JSON.stringify({ binding: "DB", database_name: cf[env]?.d1?.name ?? fallback, ...(cf[env]?.d1?.id ? { database_id: cf[env]?.d1?.id } : {}) });
	const r2 = (env: "staging" | "production", fallback: string) => JSON.stringify({ binding: "MEDIA", bucket_name: cf[env]?.r2?.bucket ?? fallback });
	// Forms: provider and addresses are config (not secrets); the API key and Turnstile secret are Wrangler secrets.
	// Staging uses Cloudflare's always-pass Turnstile test keys (public test values, developers.cloudflare.com/turnstile/troubleshooting/testing).
	const outboxDays = config.forms.outbox ? { FORM_OUTBOX_DAYS: String(config.forms.outbox.days), ...(config.forms.outbox.hold ? { FORM_OUTBOX_HOLD: "1" } : {}) } : {};
	const outboxKv = (e: "staging" | "production") => (config.forms.outbox && cf[e]?.outbox?.id ? `,\n\t"kv_namespaces": [${JSON.stringify({ binding: "FORM_OUTBOX", id: cf[e]?.outbox?.id })}]` : "");
	const formVars = { ...outboxDays, EMAIL_PROVIDER: config.email.provider, ...(config.email.from ? { FORM_FROM: config.email.from } : {}), ...(config.email.to.length ? { FORM_TO: config.email.to.join(",") } : {}) };
	const prodVars = { ...formVars, ...(config.forms.turnstileSiteKey ? { TURNSTILE_SITE_KEY: config.forms.turnstileSiteKey } : {}) };
	const stagingVars = { STAGING: "1", ...formVars, TURNSTILE_SITE_KEY: "1x00000000000000000000AA", TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA" };
	// Rate-limit namespaces are account-wide integers: derived from the Worker name so sites don't share one.
	const ns = 1000 + ([...workerName].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 8000) * 2;
	const limiter = (id: number) => JSON.stringify([{ name: "FORM_LIMITER", namespace_id: String(id), simple: { limit: config.forms.rateLimit.limit, period: config.forms.rateLimit.period } }]);
	write(
		join(project, "wrangler.jsonc"),
		`// Generated by wp2emdash scaffold. Workers Paid plan required (EmDash Worker > 3 MB).
{
	"$schema": "node_modules/wrangler/config-schema.json",
	"name": ${JSON.stringify(workerName)},
	"main": "./src/worker.ts",
	"compatibility_date": ${JSON.stringify(today)},
	"compatibility_flags": ["nodejs_compat"],
	"d1_databases": [${d1("production", `${workerName}-db`)}],
	"r2_buckets": [${r2("production", `${workerName}-media`)}],
	"vars": ${JSON.stringify(prodVars)},
	"ratelimits": ${limiter(ns)}${outboxKv("production")},
	"triggers": { "crons": ["*/5 * * * *"] },${seoPanel ? `
	// The SEO dashboard reads this site's robots.txt, sitemap and home page through itself (a fetch to its own
	// address would skip the Worker: on workers.dev nothing answers, on the domain the old origin would).
	"services": [${JSON.stringify({ binding: "SELF", service: workerName })}],` : ""}
	"observability": { "enabled": true },
	"env": {
		"staging": {
			"name": ${JSON.stringify(`${workerName}-staging`)},
			"vars": ${JSON.stringify(stagingVars)},
			"ratelimits": ${limiter(ns + 1)}${outboxKv("staging").replace(/\n\t/g, "\n\t\t\t")},
			"d1_databases": [${d1("staging", `${workerName}-staging-db`)}],
			"r2_buckets": [${r2("staging", `${workerName}-staging-media`)}]${seoPanel ? `,
			"services": [${JSON.stringify({ binding: "SELF", service: `${workerName}-staging` })}]` : ""}
		}
	}
}
`,
	);
	// Local dev: Turnstile's always-pass test keys so forms work under `astro dev` (kept if the developer edited the file).
	const devVars = join(project, ".dev.vars");
	if (!existsSync(devVars)) write(devVars, "# Local only (gitignored). Turnstile always-pass test keys; add EMAIL_API_KEY and FORM_FROM to test real delivery.\nTURNSTILE_SITE_KEY=1x00000000000000000000AA\nTURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA\n");
	// Client repository: README, docs, CI, .env.example.
	const used = new Set([...pages, ...partials, ...popups].flatMap((d) => d.sections.map((s) => `section_${s.type}`)));
	const keptDocs = writeClientRepo(
		project,
		clientRepoFiles({
			name: config.name,
			slug: config.slug,
			sourceUrl: config.source.url,
			productionUrl: siteConfig.productionUrl,
			workerName,
			...(cf.staging?.worker?.url ? { stagingUrl: cf.staging.worker.url } : {}),
			...(cf.staging?.d1?.fingerprint ? { stagingFingerprint: cf.staging.d1.fingerprint } : {}),
			...(cf.production?.d1?.fingerprint ? { productionFingerprint: cf.production.d1.fingerprint } : {}),
			// Live = traffic switched (cutover records production.live); resources alone do not make the site live.
			productionReady: !!cf.production?.live,
			sections: BLOCK_TYPES.filter((b) => used.has(b.slug)).map((b) => ({ slug: b.slug, label: b.label, description: b.description ?? "" })),
			forms: forms.map((f) => ({ id: f.id, title: f.title, fields: f.fields.map((x) => x.label), withheld: f.withheld ?? [] })),
			email: { provider: config.email.provider, ...(config.email.from ? { from: config.email.from } : {}), to: config.email.to },
			turnstileProduction: !!config.forms.turnstileSiteKey,
			...(config.forms.outbox ? { outbox: { days: config.forms.outbox.days, hold: config.forms.outbox.hold } } : {}),
			...(hasAnalytics && analytics ? { analytics } : {}),
			...(og ? { ogCards: true } : {}),
			...(seoPanel ? { seoPanel: true } : {}),
			sensitiveData: config.sensitiveData,
			stack: { node: STACK.node, astro: STACK.astro, emdash: STACK.emdash, wrangler: STACK.wrangler },
		}),
	);
	if (keptDocs.length) reporter.emit({ type: "log", level: "info", message: `Client repo files taken over by hand, left as they are: ${keptDocs.join(", ")}` });
	reporter.emit({ type: "step:end", step: "Generate project", ok: true, detail: `${pages.length} pages, ${forms.length} forms, panel ${motion.panel}` });

	// ── Static checks ──────────────────────────────────────────────────────────
	const usedTypes = new Set([...pages, ...partials, ...popups].flatMap((d) => d.sections.map((s) => `section_${s.type}`)));
	const componentSrc = readFileSync(join(project, "src", "components", "Sections.astro"), "utf8");
	const missingComponents = [...usedTypes].filter((t) => !BLOCK_TYPES.some((b) => b.slug === t) || !componentSrc.includes(`${t}:`));
	check("section-components", "Every section type used by the IR has a block type and a component", missingComponents.length === 0, missingComponents.join(", ") || `${usedTypes.size} types used`);
	const formIds = new Set(forms.map((f) => f.id));
	const missingForms = [...pages, ...partials, ...popups].flatMap((d) => d.sections.flatMap((s) => (s.type === "form" && !formIds.has(`${s.fields.formRef.provider}-${s.fields.formRef.id}`) ? [`${d.source.slug}: ${s.fields.formRef.provider}#${s.fields.formRef.id}`] : [])));
	const formWarnings = forms.flatMap((f) => f.warnings.map((w) => `${f.id}: ${w}`));
	check("forms", "Every form section has a generated form definition", missingForms.length === 0 && formWarnings.length === 0, [...missingForms, ...formWarnings].join("; ") || `${forms.length} form(s)`);
	const brandRemote = Object.entries(brand).filter(([, v]) => v && /^https?:/.test(v)).map(([k]) => k);
	check("brand-assets", "Logo and favicon copied into the project", !!brand.logo && brandRemote.length === 0, brandRemote.length ? `still remote: ${brandRemote.join(", ")}` : brand.logo ? "logo, favicon in public/brand" : "no logo captured");

	if (!opts.install) return checks;

	// ── Install, validate seed, build, measure ─────────────────────────────────
	reporter.emit({ type: "step:start", step: "Install dependencies" });
	const inst = await run("pnpm", ["install", "--prefer-offline", "--no-frozen-lockfile"], project, (l) => reporter.emit({ type: "step:progress", step: "Install dependencies", done: 0, item: l }));
	reporter.emit({ type: "step:end", step: "Install dependencies", ok: inst.code === 0 });
	check("install", "Dependencies install", inst.code === 0, inst.code === 0 ? `astro ${STACK.astro}, emdash ${STACK.emdash}` : inst.out.split("\n").slice(-6).join(" "));
	if (inst.code !== 0) return checks;

	const val = await run("node", ["--input-type=module", "-e", `import { validateSeed } from "emdash/seed"; import { readFileSync } from "node:fs"; const r = validateSeed(JSON.parse(readFileSync("seed/seed.json","utf8"))); console.log(JSON.stringify(r)); process.exit(r.valid ? 0 : 1);`], project, () => {});
	let seedDetail = val.out.trim().split("\n").at(-1) ?? "";
	try {
		const r = JSON.parse(seedDetail) as { errors: string[]; warnings: string[] };
		seedDetail = r.errors.length ? r.errors.slice(0, 5).join("; ") : `valid${r.warnings.length ? `, ${r.warnings.length} warnings` : ""}`;
	} catch {}
	check("seed-valid", "seed.json passes EmDash's validator", val.code === 0, seedDetail);

	if (!opts.build) return checks;
	// Type-check the project as its CI does (pnpm check), so starter type errors fail here, not on the client's repo.
	reporter.emit({ type: "step:start", step: "Type-check" });
	const tc = await run("pnpm", ["check"], project, () => {});
	reporter.emit({ type: "step:end", step: "Type-check", ok: tc.code === 0 });
	check("typecheck", "Project type-checks (astro check)", tc.code === 0, tc.code === 0 ? undefined : tc.out.replace(/\x1b\[[0-9;]*m/g, "").split("\n").filter((l) => / error ts\(/.test(l)).slice(0, 4).join(" | "));
	reporter.emit({ type: "step:start", step: "Build" });
	const build = await run("pnpm", ["build"], project, (l) => reporter.emit({ type: "step:progress", step: "Build", done: 0, item: l }));
	reporter.emit({ type: "step:end", step: "Build", ok: build.code === 0 });
	check("build", "Project builds", build.code === 0, build.code === 0 ? "astro build ok" : build.out.split("\n").filter((l) => /error|Error/.test(l)).slice(0, 4).join(" ") || build.out.slice(-400));
	if (build.code !== 0) return checks;

	const dry = await run("pnpm", ["exec", "wrangler", "deploy", "--dry-run", "--outdir", ".wrangler/dry"], project, () => {});
	const m = /Total Upload:\s*([\d.]+)\s*KiB\s*\/\s*gzip:\s*([\d.]+)\s*KiB/.exec(dry.out);
	const gzipMb = m ? Number(m[2]) / 1024 : Number.NaN;
	check("worker-size", "Worker bundle within the Workers Paid limit (10 MB gzip)", dry.code === 0 && Number.isFinite(gzipMb) && gzipMb < 10, m ? `${(Number(m[1]) / 1024).toFixed(1)} MB raw / ${gzipMb.toFixed(2)} MB gzip` : dry.out.split("\n").slice(-4).join(" "));
	rmSync(join(project, ".wrangler", "dry"), { recursive: true, force: true });
	const distSize = existsSync(join(project, "dist")) ? dirSize(join(project, "dist")) : 0;
	reporter.emit({ type: "log", level: "info", message: `Project: ${project} (dist ${(distSize / 1e6).toFixed(1)} MB). Preview: cd ${project} && pnpm dev` });
	return checks;
}

function dirSize(d: string): number {
	let n = 0;
	for (const e of readdirSync(d, { withFileTypes: true })) n += e.isDirectory() ? dirSize(join(d, e.name)) : statSync(join(d, e.name)).size;
	return n;
}
