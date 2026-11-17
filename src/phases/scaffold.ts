/**
 * Phase 4 — scaffold. Generates sites/<slug>/project/: the starter + per-site tokens, motion,
 * header config, forms, seed (section library, collections, menus, and the migrated content for
 * local preview). Installs, builds, measures the Worker bundle. Never deploys: staging deploy is
 * an owner-approved step (load, M6).
 */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MenuCapture } from "../audit/interactions.js";
import { KIT_ROOT } from "../core/paths.js";
import type { GateCheck } from "../core/state.js";
import type { IrPage, IrSite } from "../ir/schema.js";
import { fluentFormToDefinition, type FormDefinitionOut } from "../scaffold/forms.js";
import { buildMotion, buildSiteConfig, buildTokens, type DesignCapture, type HeaderCapture, headerTokens } from "../scaffold/generate.js";
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
	pnpm: "11.18.0",
} as const;

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
		return `/brand/${name}.${ext}`;
	};
	const header = interactions.headers.find((h) => h.viewport === "desktop") ?? interactions.headers[0];
	const desktopDesign = designs.find((d) => d.viewport === "desktop");

	// Copy the starter (kit-owned files are overwritten; content lives in the database, not in files).
	mkdirSync(project, { recursive: true });
	cpSync(join(KIT_ROOT, "starter"), project, { recursive: true, filter: (src) => !/node_modules|\/dist\//.test(src) });
	const brand = {
		logo: brandFile(header?.scrolled.logoSrc ?? desktopDesign?.logo?.src, "logo"),
		logoOnTop: header?.top.logoSrc && header.top.logoSrc !== header.scrolled.logoSrc ? brandFile(header.top.logoSrc, "logo-on-dark") : undefined,
		favicon: brandFile(desktopDesign?.favicon, "favicon"),
	};
	const lang = (readJson<{ site?: { language?: string } }>(join(paths.raw, "exporter", "probe.json"))?.site?.language ?? "en").split(/[-_]/)[0] ?? "en";
	const trailing = config.target.trailingSlash === "preserve" ? (pages.every((p) => !p.route || p.route.path === "/" || p.route.path.endsWith("/")) ? "always" : "never") : config.target.trailingSlash;
	const siteConfig = { ...buildSiteConfig(config, tokens, motion, interactions.menus, interactions.headers, brand, lang), trailingSlash: trailing };
	write(join(project, "src", "site.config.json"), siteConfig);
	write(join(project, "src", "styles", "tokens.css"), tokens.css + headerTokens(interactions.headers));
	write(join(project, "src", "styles", "motion.css"), motion.css);

	// Forms (generated files are cleared first so removed forms do not linger)
	for (const f of existsSync(join(project, "src", "forms")) ? readdirSync(join(project, "src", "forms")) : []) if (f.endsWith(".json")) rmSync(join(project, "src", "forms", f));
	const forms: FormDefinitionOut[] = [];
	const ffDir = join(paths.raw, "forms", "fluent-forms");
	if (existsSync(ffDir)) {
		for (const f of readdirSync(ffDir)) {
			const raw = readJson<{ id: string; title: string; status: string; form: { form_fields?: Record<string, unknown> }; settings?: Record<string, unknown> }>(join(ffDir, f));
			if (!raw || !/^publish(ed)?$/.test(raw.status)) continue; // never "unpublished"
			const def = fluentFormToDefinition(raw, config.sensitiveData);
			forms.push(def);
			const { warnings: _w, ...out } = def;
			write(join(project, "src", "forms", `${def.id}.json`), out);
		}
	}

	// Seed (with the migrated content for local preview)
	const sep = /\s([-–—|·•])\s/.exec(pages.find((p) => p.route?.isFrontPage)?.seo.title ?? "")?.[1] ?? "-";
	const drops: string[] = [];
	const seed = buildSeed({ name: config.name, site, pages, partials, popups, media, titleSeparator: sep, forms, includeContent: true, onDrop: (m) => drops.push(m) });
	for (const d of drops) reporter.emit({ type: "log", level: "info", message: `not stored (no matching field): ${d}` });
	write(join(project, "seed", "seed.json"), seed);

	// package.json, astro.config.mjs, wrangler.jsonc
	const today = new Date().toISOString().slice(0, 10);
	const workerName = `${config.slug}`.replace(/[^a-z0-9-]/g, "-");
	write(join(project, "package.json"), {
		name: `${config.slug}-site`,
		version: "0.1.0",
		private: true,
		type: "module",
		engines: { node: STACK.node },
		packageManager: `pnpm@${STACK.pnpm}`,
		emdash: { label: config.name, seed: "seed/seed.json" },
		scripts: { dev: "astro dev", build: "astro build", preview: "astro preview", check: "astro check", "deploy:staging": "astro build && wrangler deploy --env staging", deploy: "astro build && wrangler deploy" },
		dependencies: {
			"@astrojs/cloudflare": STACK["@astrojs/cloudflare"],
			"@astrojs/react": STACK["@astrojs/react"],
			"@emdash-cms/cloudflare": STACK["@emdash-cms/cloudflare"],
			astro: STACK.astro,
			emdash: STACK.emdash,
			react: STACK.react,
			"react-dom": STACK["react-dom"],
		},
		devDependencies: { "@astrojs/check": STACK["@astrojs/check"], "@cloudflare/workers-types": STACK["@cloudflare/workers-types"], wrangler: STACK.wrangler },
	});
	write(
		join(project, "astro.config.mjs"),
		`// Generated by wp2emdash scaffold. Runtime: workerd (V8) with nodejs_compat; build: Node ${STACK.node}.
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";

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
			mcp: false,
		}),
	],
	devToolbar: { enabled: false },
});
`,
	);
	write(
		join(project, "wrangler.jsonc"),
		`// Generated by wp2emdash scaffold. Workers Paid plan required (EmDash Worker > 3 MB).
{
	"$schema": "node_modules/wrangler/config-schema.json",
	"name": ${JSON.stringify(workerName)},
	"main": "./src/worker.ts",
	"compatibility_date": ${JSON.stringify(today)},
	"compatibility_flags": ["nodejs_compat"],
	"d1_databases": [{ "binding": "DB", "database_name": ${JSON.stringify(`${workerName}-db`)} }],
	"r2_buckets": [{ "binding": "MEDIA", "bucket_name": ${JSON.stringify(`${workerName}-media`)} }],
	"triggers": { "crons": ["*/5 * * * *"] },
	"observability": { "enabled": true },
	"env": {
		"staging": {
			"name": ${JSON.stringify(`${workerName}-staging`)},
			"vars": { "STAGING": "1" },
			"d1_databases": [{ "binding": "DB", "database_name": ${JSON.stringify(`${workerName}-staging-db`)} }],
			"r2_buckets": [{ "binding": "MEDIA", "bucket_name": ${JSON.stringify(`${workerName}-staging-media`)} }]
		}
	}
}
`,
	);
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
	const inst = await run("pnpm", ["install", "--prefer-offline"], project, (l) => reporter.emit({ type: "step:progress", step: "Install dependencies", done: 0, item: l }));
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
