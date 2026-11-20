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
import { backupsOptions } from "../scaffold/backups.js";
import { healthOptions, mailBaselineFrom } from "../scaffold/health.js";
import { analyticsOptions, carriedAnalytics, describeCarried, detectFromSnapshot, hasCarried, lookupRumSite } from "../scaffold/analytics.js";
import { credentialsFor } from "../commands/provision.js";
import { carriedWidgets } from "../scaffold/widgets.js";
import { loadSiteEnv } from "../extract/credentials.js";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MenuCapture } from "../audit/interactions.js";
import type { BricksHeaderLook, BricksLayout } from "../adapters/bricks/layout.js";
import type { KitConfig } from "../config/schema.js";
import { siteEnvironments } from "../core/environments.js";
import { KIT_ROOT } from "../core/paths.js";
import type { GateCheck } from "../core/state.js";
import type { IrPage, IrSite } from "../ir/schema.js";
import { resolveGoogleHref, selfHostGoogleFonts } from "../scaffold/fonts.js";
import { clientRepoFiles, deployScripts, writeClientRepo } from "../scaffold/client-repo.js";
import { loadOverrides } from "../config/overrides.js";
import { applySensitivePolicy, fluentFormToDefinition, type FormDefinitionOut } from "../scaffold/forms.js";
import { applyStackBreakpoint, buildMotion, buildSiteConfig, buildTokens, type DesignCapture, fluid, type HeaderCapture, headerTokens, panelExtras, stackBreakpoint } from "../scaffold/generate.js";
import { buildSeed, type MediaInfo, seedMediaResolver } from "../scaffold/seed.js";
import { astroPerf, brandHashes, imageHosts, type PerfConfig, perfSite, withWarmup, wranglerPerf, writePerfFiles } from "../scaffold/perf.js";
import { BLOCK_TYPES } from "../starter/library.js";
import { customStylesheet } from "../transform/custom-css.js";
import type { WpUrlRules } from "../transform/wp-urls.js";
import type { MediaEntry } from "./extract.js";
import type { PhaseContext } from "./index.js";

/**
 * Worker vars for the form outbox (kit.config forms.outbox), the same in both environments — staging adds its own hold
 * when it has no test inbox. keepSent → FORM_OUTBOX_KEEP_SENT="1": every message is kept, also once emailed.
 */
export function outboxVars(outbox: { days: number; hold: boolean; keepSent?: boolean } | undefined): Record<string, string> {
	if (!outbox) return {};
	return { FORM_OUTBOX_DAYS: String(outbox.days), ...(outbox.hold ? { FORM_OUTBOX_HOLD: "1" } : {}), ...(outbox.keepSent ? { FORM_OUTBOX_KEEP_SENT: "1" } : {}) };
}

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

export interface CloudflareResources {
	staging?: { d1?: { name: string; id: string; fingerprint?: string }; r2?: { bucket: string }; worker?: { url?: string }; outbox?: { id: string }; session?: { id: string } };
	production?: { d1?: { name: string; id: string; fingerprint?: string }; r2?: { bucket: string }; worker?: { url?: string }; live?: boolean; outbox?: { id: string }; session?: { id: string } };
}

/**
 * KV bindings of one environment in wrangler.jsonc: the form outbox (sites that keep one) and SESSION (Astro sessions)
 * once provision recorded its namespace. An explicit SESSION binding keeps the Cloudflare adapter from adding a bare one
 * that Wrangler auto-provisions on the first deploy (docs/spikes/M8-findings.md).
 */
export function kvBindings(cf: CloudflareResources, e: "staging" | "production", outbox: boolean): { binding: string; id: string }[] {
	return [...(outbox && cf[e]?.outbox?.id ? [{ binding: "FORM_OUTBOX", id: cf[e]?.outbox?.id as string }] : []), ...(cf[e]?.session?.id ? [{ binding: "SESSION", id: cf[e]?.session?.id as string }] : [])];
}

const readJson = <T>(file: string): T | undefined => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined);

const TURNSTILE_TEST = { TURNSTILE_SITE_KEY: "1x00000000000000000000AA", TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA" };

/**
 * Worker vars per environment. Forms: provider and addresses are config (not secrets); the API key and Turnstile
 * secret are Wrangler secrets.
 * - production: FORM_TO = email.to. Single environment (no staging): also FORM_LIVE_HOST (the production host) and
 *   FORM_TEST_TO (email.stagingTo): a message sent from any other host — workers.dev before go-live, Workers preview
 *   URLs after it — is a test, emailed only to FORM_TEST_TO and never to FORM_TO (@wp2emdash/forms, outbox.ts →
 *   isTestRequest). Host-based, so nothing has to be flipped or redeployed at go-live.
 * - staging (opt-in): never emails the client — only email.stagingTo, else every message stays held in the outbox;
 *   Cloudflare's always-pass Turnstile test keys (developers.cloudflare.com/turnstile/troubleshooting/testing).
 */
export function workerVars(config: Pick<KitConfig, "email" | "forms">, o: { staging: boolean; productionHost: string }): { production: Record<string, string>; staging: Record<string, string> } {
	const formVars: Record<string, string> = { ...outboxVars(config.forms.outbox), EMAIL_PROVIDER: config.email.provider, ...(config.email.from ? { FORM_FROM: config.email.from } : {}), ...(config.email.to.length ? { FORM_TO: config.email.to.join(",") } : {}) };
	const single = o.staging ? {} : { FORM_LIVE_HOST: o.productionHost.replace(/^www\./, ""), ...(config.email.stagingTo.length ? { FORM_TEST_TO: config.email.stagingTo.join(",") } : {}) };
	const production = { ...formVars, ...single, ...(config.forms.turnstileSiteKey ? { TURNSTILE_SITE_KEY: config.forms.turnstileSiteKey } : {}) };
	const stagingMail = config.email.stagingTo.length ? { FORM_TO: config.email.stagingTo.join(",") } : { FORM_TO: "", ...(config.forms.outbox ? { FORM_OUTBOX_HOLD: "1" } : {}) };
	const { FORM_OUTBOX_HOLD: _prodHold, ...formVarsNoHold } = formVars;
	return { production, staging: { STAGING: "1", ...formVarsNoHold, ...stagingMail, ...TURNSTILE_TEST } };
}

/**
 * wrangler.jsonc. Top level = production. Single environment (default): no `env` block; `workers_dev` and
 * `preview_urls` on, so the Worker answers on workers.dev until go-live and every `wrangler versions upload` gets a
 * preview URL (docs/spikes/single-env-findings.md). Opt-in staging: `env.staging` with its own Worker, data and vars
 * (unchanged from before 2026-11-20).
 */
export function wranglerJsonc(o: { config: Pick<KitConfig, "email" | "forms">; workerName: string; compatibilityDate: string; cf: CloudflareResources; staging: boolean; sandboxedEnvs: string[][]; seoPanel: boolean; health?: boolean; backups?: boolean; productionHost: string; perf?: PerfConfig; live?: boolean; keepWorkersDev?: boolean }): string {
	const { config, workerName, cf } = o;
	// SELF: the SEO dashboard and Site health request the site's own pages through the Worker itself; Backups restores
	// through EmDash's own API as the admin who confirmed.
	const self = o.seoPanel || !!o.health || !!o.backups;
	const loader = (e: "staging" | "production") => o.sandboxedEnvs.some((envs) => envs.includes(e));
	const d1 = (env: "staging" | "production", fallback: string) => JSON.stringify({ binding: "DB", database_name: cf[env]?.d1?.name ?? fallback, ...(cf[env]?.d1?.id ? { database_id: cf[env]?.d1?.id } : {}) });
	const r2 = (env: "staging" | "production", fallback: string) => JSON.stringify({ binding: "MEDIA", bucket_name: cf[env]?.r2?.bucket ?? fallback });
	// KV: the form outbox, and SESSION (Astro sessions) bound explicitly once provision recorded it. Without an id the
	// Cloudflare adapter adds a bare SESSION binding and Wrangler auto-provisions it on the first deploy, which leaves an
	// orphan "<worker>-session" namespace when that deploy fails (docs/spikes/M8-findings.md).
	const kvJson = (e: "staging" | "production") => {
		const kv = kvBindings(cf, e, !!config.forms.outbox);
		return kv.length ? `,\n\t"kv_namespaces": [${kv.map((x) => JSON.stringify(x)).join(", ")}]` : "";
	};
	const vars = workerVars(config, { staging: o.staging, productionHost: o.productionHost });
	// Rate-limit namespaces are account-wide integers: derived from the Worker name so sites don't share one.
	const ns = 1000 + ([...workerName].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 8000) * 2;
	const limiter = (id: number) => JSON.stringify([{ name: "FORM_LIMITER", namespace_id: String(id), simple: { limit: config.forms.rateLimit.limit, period: config.forms.rateLimit.period } }]);
	const stagingEnv = `
	"env": {
		"staging": {
			"name": ${JSON.stringify(`${workerName}-staging`)},
			"vars": ${JSON.stringify(vars.staging)},
			"ratelimits": ${limiter(ns + 1)}${kvJson("staging").replace(/\n\t/g, "\n\t\t\t")},
			"d1_databases": [${d1("staging", `${workerName}-staging-db`)}],
			"r2_buckets": [${r2("staging", `${workerName}-staging-media`)}]${loader("staging") ? `,
			"worker_loaders": [{ "binding": "LOADER" }]` : ""}${self ? `,
			"services": [${JSON.stringify({ binding: "SELF", service: `${workerName}-staging` })}]` : ""}
		}
	}`;
	const singleEnv = `
	// One environment: production. workers.dev serves it until go-live (Worker routes are added by wp2emdash golive, not
	// here, so workers.dev stays on); preview_urls gives every \`wrangler versions upload\` a review link.
	"workers_dev": ${o.live && !o.keepWorkersDev ? "false" : "true"},${o.live && !o.keepWorkersDev ? "\n\t// Live: the domain serves the site, so the workers.dev copy is off (target.keepWorkersDev: true keeps it)." : ""}
	"preview_urls": true`;
	return `// Generated by wp2emdash scaffold. Workers Paid plan required (EmDash Worker > 3 MB).
{
	"$schema": "node_modules/wrangler/config-schema.json",
	"name": ${JSON.stringify(workerName)},
	"main": "./src/worker.ts",
	"compatibility_date": ${JSON.stringify(o.compatibilityDate)},
	"compatibility_flags": ["nodejs_compat"],
	"d1_databases": [${d1("production", `${workerName}-db`)}],
	"r2_buckets": [${r2("production", `${workerName}-media`)}],
	"vars": ${JSON.stringify(vars.production)},
	"ratelimits": ${limiter(ns)}${kvJson("production")},
	"triggers": { "crons": ["*/5 * * * *"] },${loader("production") ? `
	// Runs the sandboxed plugins (Cloudflare Worker Loader, Workers Paid).
	"worker_loaders": [{ "binding": "LOADER" }],` : ""}${self ? `
	// The SEO dashboard and Site health read this site's pages, robots.txt and sitemap through itself (a fetch to its own
	// address would skip the Worker: on workers.dev nothing answers, on the domain the old origin would).
	"services": [${JSON.stringify({ binding: "SELF", service: workerName })}],` : ""}
${o.perf ? wranglerPerf(o.perf) : ""}	"observability": { "enabled": true },${o.staging ? stagingEnv : singleEnv}
}
`;
}

/**
 * Bricks sites: the theme style's body font weight (typographyBody, e.g. 300 for a light body font). Other builders do
 * not write bricks-design.json, so their pages keep the browser default (400).
 */
export function bricksBodyWeight(design: { typography?: Record<string, Record<string, unknown>> } | undefined): string {
	const w = Number(design?.typography?.typographyBody?.["font-weight"]);
	return Number.isInteger(w) && w >= 100 && w <= 900 && w !== 400 ? `:root { --body-weight: ${w}; } /* Bricks theme style body weight; bold text is "bolder" than the text around it, as on the live site (${w} → ${w < 400 ? 400 : 700}; a 400 text element → 700) */\n` : "";
}

/**
 * Bricks sites: the header template's look (bricks-design.json `header`) plus how the live menu panel looked when open
 * (audit capture: panel background, item font, overlay, slide direction and timing). Undefined for other builders.
 */
export function bricksHeaderConfig(look: BricksHeaderLook | undefined, menu: MenuCapture | undefined, bodyFont: string): (BricksHeaderLook & { panelStyle?: Record<string, string | number> }) | undefined {
	if (!look || !Object.keys(look).length) return undefined;
	const m = menu as unknown as { panel?: { background?: string; rect?: { width: number } }; overlay?: { background?: string }; itemStyle?: Record<string, string>; animations?: { target: string; name: string; durationMs: number; easing: string; keyframes: Record<string, string>[] }[] } | undefined;
	const slide = m?.animations?.find((a) => a.name === "transform" && /offcanvas|panel|menu/i.test(a.target) && /translate/.test(a.keyframes[0]?.transform ?? ""));
	const from = /translate(?:X)?\(-100%/.test(slide?.keyframes[0]?.transform ?? "") ? "left" : /translate(?:X)?\(100%/.test(slide?.keyframes[0]?.transform ?? "") ? "right" : undefined;
	const it = m?.itemStyle ?? {};
	const COLOR = /^(?:#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i;
	const style: Record<string, string | number> = {
		...(COLOR.test(m?.panel?.background ?? "") ? { bg: m?.panel?.background as string } : {}),
		...(COLOR.test(it.color ?? "") ? { color: it.color as string } : {}),
		...(/^\d{3}$/.test(it.fontWeight ?? "") ? { weight: Number(it.fontWeight) } : {}),
		...(/^\d+(?:\.\d+)?px$/.test(it.lineHeight ?? "") ? { lineHeight: it.lineHeight as string } : {}),
		...(it.fontFamily && bodyFont.replace(/"/g, "").toLowerCase().includes(it.fontFamily.replace(/"/g, "").toLowerCase()) ? { font: "body" } : {}),
		...(COLOR.test(m?.overlay?.background ?? "") ? { overlay: m?.overlay?.background as string } : {}),
		...(from ? { from } : {}),
		...(slide ? { ms: Math.round(slide.durationMs), ease: slide.easing } : {}),
	};
	return { ...look, ...(Object.keys(style).length ? { panelStyle: style } : {}) };
}

/**
 * Bricks sites: the layout the live site draws (bricks-design.json `layout`, src/adapters/bricks/layout.ts) — content
 * width and page gutter (section side padding), and Automatic.css text rules, image radius and button geometry. Other
 * builders do not write bricks-design.json, so nothing is added for them.
 */
export function bricksLayoutTokens(layout: BricksLayout | undefined): string {
	if (!layout) return "";
	const r2 = (n: number) => Math.round(n * 100) / 100;
	const root: string[] = [];
	const rules: string[] = [];
	if (layout.container) root.push(`--container: ${layout.container}px;`);
	const g = layout.gutter;
	if (g?.mobile !== undefined && g.desktop !== undefined) {
		root.push(`--gutter: ${fluid(g.mobile, g.desktop)};`);
		const line = g.mobile + ((g.desktop - g.mobile) * (768 - 390)) / (1440 - 390);
		if (g.tablet !== undefined && Math.abs(g.tablet - line) > 2) rules.push(`@media (min-width: 691px) and (max-width: 999.98px) { :root { --gutter: ${r2(g.tablet)}px; } }`);
	}
	if (layout.imageRadius !== undefined) root.push(`--radius-media: ${r2(layout.imageRadius)}px;`);
	if (layout.paragraphSpacing !== undefined) root.push(`--para-gap: ${r2(layout.paragraphSpacing)}em;`);
	if (layout.button?.size) root.push(`--btn-size: ${fluid(layout.button.size.mobile, layout.button.size.desktop)};`);
	if (/^calc\(\d+(?:\.\d+)?px \+ \d+(?:\.\d+)?ex\)$/.test(layout.textLeading ?? "")) rules.push(`:where(p, li) { line-height: ${layout.textLeading}; }`);
	const WRAP = /^(?:pretty|balance|wrap|stable)$/;
	if (WRAP.test(layout.textWrap ?? "")) rules.push(`body { text-wrap: ${layout.textWrap}; }`);
	if (WRAP.test(layout.headingWrap ?? "")) rules.push(`:where(h1, h2, h3, h4, h5, h6) { text-wrap: ${layout.headingWrap}; }`);
	// Automatic.css rounds every image outside the header; section and column backgrounds are pictures here, not there.
	// Automatic.css links in text: its link colour. The underline stays even where the source has none: a link in a
	// paragraph must be told apart from the text without colour alone (WCAG 1.4.1; verify's axe check gates on it).
	if (layout.link?.color && /^(?:#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i.test(layout.link.color)) rules.push(`.section .prose a:not(.btn) { color: ${layout.link.color}; }`);
	if (layout.imageRadius !== undefined) rules.push(`:where(.section__inner, .site-footer) img:not(.columns__bg) { border-radius: var(--radius-media); }`);
	const b = layout.button;
	const btn = [b?.leading !== undefined ? `line-height: ${b.leading};` : "", b?.border !== undefined ? `border-width: ${r2(b.border)}px;` : ""].filter(Boolean).join(" ");
	if (btn) rules.push(`.section .btn:not(.btn--link, .btn--plain) { ${btn} }`);
	if (!root.length && !rules.length) return "";
	return `/* Bricks layout (theme style container, measured section side padding) and Automatic.css text, image and button rules. */\n${root.length ? `:root { ${root.join(" ")} }\n` : ""}${rules.join("\n")}${rules.length ? "\n" : ""}`;
}
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
	const sandboxed = config.sandboxedPlugins;
	// A projectDir outside the kit must be empty or a project this kit generated: never write into some other folder.
	if (!project.startsWith(paths.root) && existsSync(project) && readdirSync(project).filter((f) => f !== ".DS_Store").length > 0 && !existsSync(join(project, "wrangler.jsonc")) && !existsSync(join(project, "seed", "seed.json"))) {
		return [{ id: "project-dir", label: "projectDir is empty or a project made by this kit", ok: false, detail: `${project} has other files: point projectDir at an empty folder or at this site's project` }];
	}

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
	// SEO & Analytics (@wp2emdash/seo): always copied — the starter reads its tracker list, CSP host table and events
	// (packages/seo/src/analytics); the plugin itself is registered only with seo.panel (below).
	rmSync(join(project, "packages", "seo"), { recursive: true, force: true });
	cpSync(join(KIT_ROOT, "packages", "seo"), join(project, "packages", "seo"), { recursive: true, filter: (src) => !/node_modules/.test(src) });
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
	// Analytics: the config's choice, else every tracker the audit saw in the old pages' HTML (UA- listed as retired).
	const snapPages = readdirSync(join(paths.snapshot, "pages")).map((f) => readJson<{ trackingIds?: string[]; seo?: { og?: Record<string, string>; verification?: Record<string, string> } }>(join(paths.snapshot, "pages", f)) ?? {});
	// Ownership meta tags (Search Console etc.) from any captured page.
	const verification = Object.assign({}, ...snapPages.map((p) => p.seo?.verification ?? {})) as Record<string, string>;
	const audited = [...new Set(snapPages.flatMap((p) => p.trackingIds ?? []))];
	// og:locale as the SEO plugin published it (en_US); EmDash's head does not emit one.
	const ogLocale = snapPages.map((p) => p.seo?.og?.["og:locale"]).find((l) => l && /^[a-z]{2}(?:_[A-Z]{2})?$/.test(l));
	// Cloudflare Web Analytics site of the domain (read-only, build token): its site tag for Visits, and whether
	// Cloudflare injects the beacon itself (then a beacon found in the old HTML is not loaded a second time).
	const cfRecord = readJson<{ accountId?: string; production?: { accountId?: string } }>(join(paths.root, "cloudflare.json")) ?? {};
	const cfCreds: { token?: string; accountId?: string } = config.analytics === false ? {} : credentialsFor("production", loadSiteEnv(paths.root), cfRecord as never);
	const rum = await lookupRumSite({ ...(cfCreds.token ? { token: cfCreds.token } : {}), ...(cfCreds.accountId ? { accountId: cfCreds.accountId } : {}), host: new URL(config.target.productionUrl).host });
	const analytics = carriedAnalytics(config.analytics, detectFromSnapshot(paths.snapshot, audited), rum);
	const hasAnalytics = hasCarried(analytics);
	if (analytics && hasAnalytics) reporter.emit({ type: "log", level: "info", message: `analytics carried over (production domain only): ${describeCarried(analytics)}${rum ? `; Cloudflare Web Analytics site found${rum.autoInstall ? " (beacon added by Cloudflare)" : ""}` : ""}` });
	// Bricks: the header template's own look (container, toggle, buttons, offcanvas panel) with the captured panel style.
	const bricksDesignOut = readJson<{ typography?: Record<string, Record<string, unknown>>; layout?: BricksLayout; header?: BricksHeaderLook; entranceAnimations?: number }>(join(paths.reports, "transform", "bricks-design.json"));
	const bricksHeader = bricksHeaderConfig(bricksDesignOut?.header, mobileMenu, tokens.fonts.body);
	const siteWidgets = carriedWidgets(config.siteWidgets, paths.ir);
	if (siteWidgets.length) reporter.emit({ type: "log", level: "info", message: `site widgets (production domain only): ${siteWidgets.map((w) => `${w.provider} ${w.id}`).join(", ")}` });
	const siteConfig = {
		...baseConfig,
		header: { ...baseConfig.header, ...(bricksHeader ? { bricks: bricksHeader } : {}), panelExtras: panelExtras(interactions.menus, primaryLabels, (site.menus.find((mm) => mm.role === "secondary")?.items ?? []).filter((i) => i.button).map((i) => i.label)), ...(Number.isFinite(itemPx(mobileMenu)) ? { panelItemSize: Number.isFinite(itemPx(desktopMenu)) ? fluid(itemPx(mobileMenu), itemPx(desktopMenu)) : `${itemPx(mobileMenu)}px` } : {}) },
		trailingSlash: trailing,
		...(hasAnalytics ? { analytics } : {}),
		// Trackers managed in SEO & Analytics, starting from `analytics`; seo.panel false or analytics: false turn it off.
		...(config.seo.panel && config.analytics !== false ? { analyticsAdmin: true } : {}),
		...(ogLocale ? { ogLocale } : {}),
		// Chat / reviews badge / consent tool by provider + ID (src/scaffold/widgets.ts); the CSP allows their hosts only.
		...(siteWidgets.length ? { siteWidgets } : {}),
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
			// Only styles Google has (a refused request would leave the site without its fonts, render-blocking).
			const resolved = await resolveGoogleHref(siteConfig.fonts.googleHref);
			if (resolved.reduced.length || resolved.dropped.length) reporter.emit({ type: "log", level: resolved.dropped.length ? "warn" : "info", message: `Google Fonts: ${[...resolved.reduced, ...resolved.dropped.map((d) => `${d} not on Google Fonts (system fallback)`)].join("; ")}` });
			if (resolved.href) siteConfig.fonts.googleHref = resolved.href;
			else {
				const { googleHref: _g, ...rest } = siteConfig.fonts;
				siteConfig.fonts = rest;
			}
		} catch {}
	}
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
	// Calm entrance motion: the owner's setting, else on for a Bricks site whose live pages animate content on entry.
	const entranceMotion = config.motion ?? ((bricksDesignOut?.entranceAnimations ?? 0) >= 3 ? "calm" : undefined);
	if (entranceMotion === "calm") (siteConfig as { motion?: string }).motion = "calm";
	// Background videos on phones too (owner choice per site; default: phones keep the picture).
	if (config.performance.phoneVideo) (siteConfig as { phoneVideo?: boolean }).phoneVideo = true;
	// Sharing cards (@wp2emdash/og, on by default): fonts as TTF, colours from the tokens, the logo; og: { cards: false } turns them off.
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
	// SEO & Analytics plugin (@wp2emdash/seo, on by default); seo: { panel: false } turns the whole suite off.
	// IndexNow key: derived from the production host (stable across reruns, nothing to store); its file sits at the
	// domain root so it covers every URL. Submissions start once production.live is set (after the switch).
	const indexNowKey = createHash("sha256").update(`indexnow:${new URL(siteConfig.productionUrl).host}`).digest("hex").slice(0, 32);
	for (const f of existsSync(join(project, "public")) ? readdirSync(join(project, "public")) : []) if (/^[0-9a-f]{32}\.txt$/.test(f) && f !== `${indexNowKey}.txt`) rmSync(join(project, "public", f));
	if (config.seo.panel) writeFileSync(join(project, "public", `${indexNowKey}.txt`), indexNowKey);
	else rmSync(join(project, "public", `${indexNowKey}.txt`), { force: true });
	const seoPanel = config.seo.panel ? { productionUrl: siteConfig.productionUrl, titleSeparator: /\s([-–—|·•])\s/.exec(pages.find((p) => p.route?.isFrontPage)?.seo.title ?? "")?.[1] ?? "-", collections: ["pages"], ...(og ? { ogCards: true } : {}), indexNow: { key: indexNowKey, live: !!readJson<CloudflareResources>(join(paths.root, "cloudflare.json"))?.production?.live }, ...(config.analytics !== false ? { analytics: analyticsOptions({ seed: analytics, ...(cfCreds.accountId ? { accountId: cfCreds.accountId } : {}), ...(rum ? { rum } : {}), stateFile: paths.state, ...(Object.keys(verification).length ? { verification } : {}) }) } : {}) } : undefined;
	// Site health & monthly report (@wp2emdash/health, on by default); health: false turns it off.
	rmSync(join(project, "packages", "health"), { recursive: true, force: true });
	const health = healthOptions({
		config,
		productionUrl: siteConfig.productionUrl,
		live: !!readJson<CloudflareResources>(join(paths.root, "cloudflare.json"))?.production?.live,
		...(brand.logo ? { logo: brand.logo } : {}),
		colors: ogColors(tokens.css),
		...(seoPanel ? { seo: { titleSeparator: seoPanel.titleSeparator, ...(og ? { ogCards: true } : {}) } } : {}),
		...(analytics && hasAnalytics ? { analyticsSeed: analytics } : {}),
		...(rum?.autoInstall ? { zoneBeacon: true } : {}),
		visits: { ...(cfCreds.accountId ? { accountId: cfCreds.accountId } : {}), ...(rum?.siteTag ? { siteTag: rum.siteTag } : {}) },
		...(await mailBaselineFrom(join(paths.root, "cutover")).then((mail) => (mail ? { mail } : {}))),
	});
	if (health) {
		cpSync(join(KIT_ROOT, "packages", "health"), join(project, "packages", "health"), { recursive: true, filter: (src) => !/node_modules/.test(src) });
		reporter.emit({ type: "log", level: "info", message: `site health on (@wp2emdash/health): alerts to ${health.alertsTo.length} address(es), monthly report to ${health.reportTo.length}${health.mail ? `, mail DNS baseline of ${health.mail.records.length} record(s)` : ", no mail DNS baseline yet (cutover preflight)"}${health.live ? "" : "; emails start once production.live is set"}` });
		if (!health.alertsTo.length) reporter.emit({ type: "log", level: "warn", message: "site health: no alert recipients (set health.alertsTo or email.stagingTo in kit.config.ts); admins can add them on the page" });
	}
	// Backups & Restore (@wp2emdash/backups, on by default); backups: false turns it off.
	rmSync(join(project, "packages", "backups"), { recursive: true, force: true });
	const cfNow = readJson<CloudflareResources>(join(paths.root, "cloudflare.json"));
	const backups = backupsOptions({ config, productionUrl: siteConfig.productionUrl, live: !!cfNow?.production?.live, ...(cfNow?.production?.d1?.name ? { database: cfNow.production.d1.name } : {}) });
	if (backups) {
		cpSync(join(KIT_ROOT, "packages", "backups"), join(project, "packages", "backups"), { recursive: true, filter: (src) => !/node_modules/.test(src) });
		reporter.emit({ type: "log", level: "info", message: `backups on (@wp2emdash/backups): nightly at ~${backups.hourUtc ?? "01–03"} UTC, keep ${backups.retention?.daily} daily + ${backups.retention?.monthly} monthly, alerts to ${backups.alertsTo.length} address(es)${backups.offsite ? `, off-site copy to ${new URL(backups.offsite.endpoint).host} (set BACKUP_S3_ACCESS_KEY_ID / BACKUP_S3_SECRET_ACCESS_KEY on the Worker)` : ""}` });
	}
	// Performance package (src/scaffold/perf.ts): route-cache defaults, hashed brand files with sizes, favicons.
	const perf = await perfSite(join(project, "public"), config.performance, brand, siteConfig.header.logoHeight);
	Object.assign(siteConfig, perf.site, { header: { ...siteConfig.header, ...perf.header } }, brandHashes(join(project, "public"), brand));
	// WordPress addresses with no page here (feeds, search, archives, attachment pages, query forms): transform's rule
	// set (ir/wp-urls.json), applied by the middleware; verify judges every audited URL with the same rules.
	const wpUrlPlan = readJson<{ rules: WpUrlRules }>(join(ir, "wp-urls.json"));
	if (wpUrlPlan) (siteConfig as { wpUrls?: WpUrlRules }).wpUrls = { ...wpUrlPlan.rules, trailingSlash: trailing };
	// Customizer Additional CSS, only when the owner decided "carry": its own file, linked after the starter's CSS.
	mkdirSync(join(project, "public", "styles"), { recursive: true });
	for (const f of readdirSync(join(project, "public", "styles"))) if (/^custom-[0-9a-f]{10}\.css$/.test(f)) rmSync(join(project, "public", "styles", f));
	const carriedCss = readJson<{ decision: string | null; css: string }>(join(ir, "custom-css.json"));
	if (carriedCss?.decision === "carry" && carriedCss.css.trim()) {
		const sheet = customStylesheet(carriedCss.css);
		writeFileSync(join(project, "public", "styles", sheet.file), sheet.content);
		(siteConfig as { customCss?: string }).customCss = `/styles/${sheet.file}`;
	}
	write(join(project, "src", "site.config.json"), siteConfig);
	write(join(project, "src", "styles", "tokens.css"), tokens.css + bricksBodyWeight(bricksDesignOut) + bricksLayoutTokens(bricksDesignOut?.layout) + headerTokens(interactions.headers, siteConfig.header.breakpoint));
	write(join(project, "src", "styles", "motion.css"), motion.css);
	const basePath = join(project, "src", "styles", "base.css");
	write(basePath, applyStackBreakpoint(readFileSync(basePath, "utf8"), stackBreakpoint(designs)));

	// Forms (generated files are cleared first so removed forms do not linger)
	for (const f of existsSync(join(project, "src", "forms")) ? readdirSync(join(project, "src", "forms")) : []) if (f.endsWith(".json")) rmSync(join(project, "src", "forms", f));
	const forms: FormDefinitionOut[] = [];
	// Every provider extract wrote: Fluent Forms in its REST shape, the others (plugin exports) with a ready definition.
	const formsDir = join(paths.raw, "forms");
	const scaffoldOverrides = await loadOverrides(paths.overrides);
	const formFiles = existsSync(formsDir) ? readdirSync(formsDir).flatMap((p) => (statSync(join(formsDir, p)).isDirectory() ? readdirSync(join(formsDir, p)).filter((f) => f.endsWith(".json")).map((f) => join(formsDir, p, f)) : [])) : [];
	{
		for (const file of formFiles) {
			const raw = readJson<{ id: string; title: string; status: string; form?: { form_fields?: Record<string, unknown> }; settings?: Record<string, unknown>; definition?: FormDefinitionOut }>(file);
			if (!raw || !/^publish(ed)?$/.test(raw.status)) continue; // never "unpublished"
			// The owner moved this form elsewhere (overrides.ts → integrations "form:<provider>:<id>": replace | drop).
			const provider = file.split(/[\\/]/).at(-2) ?? "";
			const decision = scaffoldOverrides.integrations[`form:${provider}:${raw.id}`];
			if (decision === "replace" || decision === "drop") {
				reporter.emit({ type: "log", level: "info", message: `form ${provider} #${raw.id} not rebuilt: integration decision "${decision}" in overrides.ts` });
				continue;
			}
			const base: FormDefinitionOut | undefined = raw.definition ? { ...raw.definition, warnings: raw.definition.warnings ?? [], ...(config.sensitiveData ? { sensitive: true } : {}) } : raw.form ? fluentFormToDefinition({ ...raw, form: raw.form }, config.sensitiveData) : undefined;
			if (!base) continue;
			const def = applySensitivePolicy(base, config.forms.sensitive, config.forms.notice);
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
	// One environment (production) unless the site opted into staging (src/core/environments.ts).
	const envs = siteEnvironments(config, cf as never);
	reporter.emit({ type: "log", level: "info", message: envs.staging ? `environments: staging + production (staging: ${envs.why})` : "environments: production only (single environment; staging is opt-in: target.staging)" });
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
		scripts: { dev: "astro dev", build: "astro build", preview: "astro preview", check: "astro check", ...withWarmup(deployScripts({ staging: envs.staging, stagingFingerprint: cf.staging?.d1?.fingerprint, productionFingerprint: cf.production?.d1?.fingerprint }), { staging: cf.staging?.worker?.url, production: cf.production?.live ? siteConfig.productionUrl : (cf.production as { worker?: { url?: string } } | undefined)?.worker?.url }, config.performance) },
		dependencies: {
			"@astrojs/cloudflare": STACK["@astrojs/cloudflare"],
			"@astrojs/react": STACK["@astrojs/react"],
			"@emdash-cms/cloudflare": STACK["@emdash-cms/cloudflare"],
			"@wp2emdash/forms": "link:./packages/forms",
			...(og ? { "@wp2emdash/og": "link:./packages/og", ...OG_DEPENDENCIES } : {}),
			"@wp2emdash/seo": "link:./packages/seo",
			...(health ? { "@wp2emdash/health": "link:./packages/health" } : {}),
			...(backups ? { "@wp2emdash/backups": "link:./packages/backups" } : {}),
			...Object.fromEntries(config.sandboxedPlugins.map((sp) => [sp.package, sp.version])),
			astro: STACK.astro,
			emdash: STACK.emdash,
			react: STACK.react,
			"react-dom": STACK["react-dom"],
		},
		devDependencies: { "@astrojs/check": STACK["@astrojs/check"], "@cloudflare/workers-types": STACK["@cloudflare/workers-types"], typescript: STACK.typescript, wrangler: STACK.wrangler },
	});
	writePerfFiles(project, config.performance);
	const pagePaths = pages.flatMap((p) => (p.source.status === "publish" && p.route?.path ? [p.route.path] : []));
	const ap = astroPerf(config.performance, pagePaths, imageHosts([siteConfig.productionUrl, cf.staging?.worker?.url, (cf.production as { worker?: { url?: string } } | undefined)?.worker?.url]));
	write(
		join(project, "astro.config.mjs"),
		`// Generated by wp2emdash scaffold. Runtime: workerd (V8) with nodejs_compat; build: Node ${STACK.node}.
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";${ap.imports}${config.forms.outbox ? '\nimport { formsPlugin } from "@wp2emdash/forms";' : ""}${og ? '\nimport { ogPlugin } from "@wp2emdash/og";' : ""}${seoPanel ? '\nimport { seoPlugin } from "@wp2emdash/seo";' : ""}${health ? '\nimport { healthPlugin } from "@wp2emdash/health";' : ""}${backups ? '\nimport { backupsPlugin } from "@wp2emdash/backups";' : ""}${sandboxed.length ? `\nimport { sandbox } from "@emdash-cms/cloudflare";\n${sandboxed.map((sp, i) => `import sandboxed${i} from ${JSON.stringify(sp.package)};`).join("\n")}\n\n// Sandboxed plugins (reviewed, pinned in kit.config.ts), per environment: the build picks the environment (CLOUDFLARE_ENV).\nconst buildEnv = process.env.CLOUDFLARE_ENV || "production";\nconst sandboxedHere = [${sandboxed.map((sp, i) => `[sandboxed${i}, ${JSON.stringify(sp.environments)}]`).join(", ")}].filter(([, envs]) => envs.includes(buildEnv)).map(([p]) => p);` : ""}

export default defineConfig({
	site: ${JSON.stringify(siteConfig.productionUrl)},
	output: "server",
	// "ignore": EmDash's own routes (/_emdash/…) must match without a slash. The site's URL style
	// (${trailing}) is enforced for page paths in src/middleware.ts via site.config.json.
	trailingSlash: "ignore",
	adapter: cloudflare(),
${ap.options}	integrations: [
		react(),
		emdash({
			database: d1({ binding: "DB", session: "auto", coalesce: true }),
			storage: r2({ binding: "MEDIA" }),
			mcp: false,${config.forms.outbox || og || seoPanel || health || backups ? `
			// Admin plugins: Form messages (form outbox, admins only — @wp2emdash/forms), Sharing images (@wp2emdash/og),
			// SEO & Analytics (@wp2emdash/seo): editor panel, dashboard, tracking codes, conversion events, Visits;
			// Site health (@wp2emdash/health, admins only): scheduled checks, alerts, monthly report;
			// Backups (@wp2emdash/backups, admins only): nightly backups to R2, downloads, restore with a preview.
			plugins: [${[config.forms.outbox ? "formsPlugin()" : "", og ? `ogPlugin(${JSON.stringify(og)})` : "", seoPanel ? `seoPlugin(${JSON.stringify(seoPanel)})` : "", health ? `healthPlugin(${JSON.stringify(health)})` : "", backups ? `backupsPlugin(${JSON.stringify(backups)})` : ""].filter(Boolean).join(", ")}],` : ""}${sandboxed.length ? `
			// Only the reviewed plugins above: no installs from the public registry through the admin.
			...(sandboxedHere.length ? { sandboxed: sandboxedHere, sandboxRunner: sandbox(), registry: false } : {}),` : ""}
		}),
	],
	devToolbar: { enabled: false },
});
`,
	);
	for (const e of envs.staging ? (["staging", "production"] as const) : (["production"] as const)) if (cf[e]?.d1?.id && !cf[e]?.session?.id) reporter.emit({ type: "log", level: "warn", message: `${e}: no SESSION namespace recorded in cloudflare.json; run \`wp2emdash provision ${config.slug} ${e}\` so the first deploy does not auto-provision it` });
	if (!envs.staging && !config.forms.turnstileSiteKey && forms.length) reporter.emit({ type: "log", level: "warn", message: `single environment: production forms refuse messages until forms.turnstileSiteKey is set (one Turnstile widget for ${new URL(siteConfig.productionUrl).host} and the account's workers.dev subdomain) and its secret is put (wrangler secret put TURNSTILE_SECRET_KEY)` });
	write(join(project, "wrangler.jsonc"), wranglerJsonc({ config, workerName, compatibilityDate: today, cf, staging: envs.staging, sandboxedEnvs: sandboxed.map((sp) => sp.environments), seoPanel: !!seoPanel, health: !!health, backups: !!backups, productionHost: new URL(siteConfig.productionUrl).host, perf: config.performance, live: !!cf.production?.live, keepWorkersDev: config.target.keepWorkersDev }));
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
			staging: envs.staging,
			...(cf.production?.worker?.url ? { workersDevUrl: cf.production.worker.url } : {}),
			ciDeploy: config.target.ciDeploy,
			testTo: config.email.stagingTo,
			...(envs.staging && cf.staging?.worker?.url ? { stagingUrl: cf.staging.worker.url } : {}),
			...(cf.staging?.d1?.fingerprint ? { stagingFingerprint: cf.staging.d1.fingerprint } : {}),
			...(cf.production?.d1?.fingerprint ? { productionFingerprint: cf.production.d1.fingerprint } : {}),
			// Live = traffic switched (cutover records production.live); resources alone do not make the site live.
			productionReady: !!cf.production?.live,
			sections: BLOCK_TYPES.filter((b) => used.has(b.slug)).map((b) => ({ slug: b.slug, label: b.label, description: b.description ?? "" })),
			forms: forms.map((f) => ({ id: f.id, title: f.title, fields: f.fields.map((x) => x.label), withheld: f.withheld ?? [] })),
			email: { provider: config.email.provider, ...(config.email.from ? { from: config.email.from } : {}), to: config.email.to },
			turnstileProduction: !!config.forms.turnstileSiteKey,
			...(config.forms.outbox ? { outbox: { days: config.forms.outbox.days, hold: config.forms.outbox.hold, keepSent: config.forms.outbox.keepSent } } : {}),
			...(hasAnalytics && analytics ? { analytics } : {}),
			...(seoPanel?.analytics ? { analyticsAdmin: true } : {}),
			...(og ? { ogCards: true } : {}),
			...(seoPanel ? { seoPanel: true } : {}),
			...(config.performance.routeCache ? { routeCache: true } : {}),
			...(health ? { health: { alertsTo: health.alertsTo, reportTo: health.reportTo, footer: health.brand.footer } } : {}),
			...(backups ? { backups: { alertsTo: backups.alertsTo, daily: backups.retention?.daily ?? 30, monthly: backups.retention?.monthly ?? 12, offsite: !!backups.offsite, ...(backups.database ? { database: backups.database } : {}) } } : {}),
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
