/**
 * Phase 5 — load. IR → a running EmDash site. Target (src/core/environments.ts): a single-environment site loads into
 * production once provisioned (its workers.dev address before go-live; EMDASH_TOKEN_PRODUCTION or EMDASH_TOKEN); a
 * site with opt-in staging loads into the local dev server unless WP2EMDASH_LOAD_TARGET=staging|production. After
 * go-live a production load needs --force and records a D1 Time Travel bookmark first (src/targets/d1-backup.ts). Idempotent:
 * an id-map links every WordPress document/media item to its EmDash id, media dedupes by sha1,
 * updates use the entry's revision. The gate re-reads everything from the target.
 */
import { defaultTarget, noProductionTargets, readCf, siteEnvironments } from "../core/environments.js";
import { guardLiveProductionWrite } from "../targets/d1-backup.js";
import { remoteTarget, targetName } from "../targets/remote.js";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { externalMediaDecision, loadOverrides } from "../config/overrides.js";
import type { GateCheck } from "../core/state.js";
import { loadSiteEnv } from "../extract/credentials.js";
import type { IrPage, IrSite, MediaRef, Section } from "../ir/schema.js";
import { menuItemExtras, POSTS_COLLECTION, productionCanonical, routeToSlug } from "../scaffold/seed.js";
import type { BlogPlan } from "../transform/blog.js";
import { BLOCK_TYPES } from "../starter/library.js";
import { svgToPng } from "../targets/emdash/svg.js";
import { type ContentItem, EmDashApi, EmDashHttpError, type MediaItem } from "../targets/emdash/api.js";
import { blockKey, sectionToBlock } from "../targets/emdash/blocks.js";
import { faststart, needsFaststart } from "../targets/emdash/faststart.js";
import { desiredSettings, planSettings, type SettingsRecord } from "../targets/emdash/settings.js";
import type { IrSettings } from "../transform/settings.js";
import { kitFetch, pinHost } from "../targets/emdash/net.js";
import type { MediaEntry } from "./extract.js";
import type { PhaseContext } from "./index.js";

const readJson = <T>(file: string): T | undefined => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined);
const write = (file: string, data: unknown) => {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
};

export interface IdMap {
	target: string;
	baseUrl: string;
	media: Record<string, { id: string; sha1: string; url?: string; mime: string; faststart?: boolean }>;
	content: Record<string, { collection: string; id: string; slug: string }>;
}

const MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".webm": "video/webm", ".pdf": "application/pdf", ".ico": "image/x-icon" };
const mimeOf = (f: string) => MIME[extname(f).toLowerCase()] ?? "application/octet-stream";
const mediaKey = (m: MediaRef) => (m.wpId ? `wp:${m.wpId}` : `url:${m.url}`);

/** Builder posts went to `pages` before the blog milestone; blog sites (ir/blog.json) load every post into `posts`. */
const COLLECTION: Record<IrPage["kind"], string> = { page: "pages", post: "pages", partial: "site_parts", popup: "popups" };
const collectionOf = (doc: IrPage, blog: boolean) => (doc.kind === "post" && blog && doc.post ? "posts" : COLLECTION[doc.kind]);

/**
 * A post body for the target: media marked by transform (`_media`) become EmDash media (image asset id + file URL, or
 * the URL of a file/cover/video field). Unresolved media keep the WordPress URL (load's leftovers check reports it).
 */
export function resolvePostBody(body: unknown[], media: (m: MediaRef) => { id: string; url?: string } | undefined): unknown[] {
	const fix = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(fix);
		if (!v || typeof v !== "object") return v;
		const { _media, ...o } = v as Record<string, unknown> & { _media?: MediaRef & { field?: string } };
		const out: Record<string, unknown> = Object.fromEntries(Object.entries(o).map(([k, x]) => [k, fix(x)]));
		const e = _media ? media(_media) : undefined;
		if (e && out.asset && typeof out.asset === "object") out.asset = { _type: "reference", _ref: e.id, ...(e.url ? { url: e.url } : {}) };
		else if (e?.url && _media?.field) out[_media.field] = e.url;
		return out;
	};
	return body.map(fix);
}

/** Status on the target for a post: published (with its date), scheduled, or draft (overrides.ts protectedPosts). */
export function postAction(doc: IrPage, protectedDecision: "draft" | "skip" | "publish" | undefined, now = Date.now()): "publish" | "schedule" | "draft" {
	const visibility = doc.post?.visibility ?? "public";
	if (visibility !== "public") return protectedDecision === "publish" && (doc.source.status === "publish" || doc.source.status === "private") ? "publish" : "draft";
	if (doc.source.status === "publish") return "publish";
	if (doc.source.status === "future") return doc.post?.publishedAt && Date.parse(doc.post.publishedAt) > now ? "schedule" : "publish";
	return "draft";
}

/** Start `pnpm dev` in the project when nothing listens yet; returns a stop function. */
export async function ensureDevServer(project: string, port: number, log: (m: string) => void): Promise<() => void> {
	const url = `http://localhost:${port}/_emdash/api/setup/status`;
	const up = async () => {
		try {
			const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
			await r.body?.cancel();
			return r.status < 500;
		} catch {
			return false;
		}
	};
	if (await up()) return () => {};
	log(`starting dev server on :${port}`);
	const p = spawn("pnpm", ["dev", "--port", String(port)], { cwd: project, env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" }, stdio: "ignore", detached: false });
	// Astro 7 runs the dev server as a daemon: stop it with `astro dev stop`, not by killing pnpm.
	const stopServer = () => {
		p.kill("SIGTERM");
		spawn("pnpm", ["exec", "astro", "dev", "stop"], { cwd: project, stdio: "ignore" });
	};
	for (let i = 0; i < 90; i++) {
		if (await up()) return stopServer;
		await new Promise((r) => setTimeout(r, 1000));
	}
	stopServer();
	throw new Error("dev server did not start within 90 s");
}

export async function runLoad({ config, paths, reporter, force, overwriteSettings, only }: PhaseContext): Promise<GateCheck[]> {
	const onlySettings = only === "settings";
	const checks: GateCheck[] = [];
	const check = (id: string, label: string, ok: boolean, detail?: string) => checks.push({ id, label, ok, ...(detail ? { detail } : {}) });
	// Default target: local for a site with opt-in staging; production (workers.dev before go-live) for a single-environment
	// site once provisioned (src/core/environments.ts). WP2EMDASH_LOAD_TARGET=local|staging|production overrides it.
	const cf = readCf(paths.root);
	const envs = siteEnvironments(config, cf);
	const target = targetName(process.env.WP2EMDASH_LOAD_TARGET, defaultTarget("load", envs, { noProduction: noProductionTargets() }));
	if (target === "production" && noProductionTargets()) {
		check("target", "production target allowed", false, "Refused: this run may not target production (WP2EMDASH_NO_PRODUCTION=1, the MCP server). Production load is the operator's step.");
		return checks;
	}
	if (target === "staging" && !envs.staging) {
		check("target", "staging target configured", false, "This site has one environment (production); staging is opt-in: set target.staging: true in kit.config.ts and provision it (docs/staging-setup.md)");
		return checks;
	}
	if (!process.env.WP2EMDASH_LOAD_TARGET) reporter.emit({ type: "log", level: "info", message: `target: ${target} (default for a ${envs.staging ? "site with staging" : "single-environment site"}; set WP2EMDASH_LOAD_TARGET to choose)` });
	const env = loadSiteEnv(paths.root);
	const overrides = await loadOverrides(paths.overrides);
	const site = readJson<IrSite>(join(paths.ir, "site.json"));
	if (!site || !existsSync(join(paths.project, "package.json"))) {
		check("inputs", "Transform and scaffold output present", false, "Run transform and scaffold first");
		return checks;
	}
	const siteIr: IrSite = site;

	// ── Target ─────────────────────────────────────────────────────────────────
	let api: EmDashApi;
	let stop = () => {};
	/** The address the site answers on now (workers.dev before the switch, the real domain after it): EmDash's Site URL. */
	let siteOrigin: string | undefined;
	/** Production after go-live: settings already there without a load record are an editor's (kept). */
	let remoteLive = false;
	if (target !== "local") {
		const t = remoteTarget(paths.root, config, env, target);
		if ("error" in t || !t.token) {
			check("target", `${target} target configured`, false, "error" in t ? t.error : `Set ${t.tokenName} (an EmDash API token from that site's admin) in .env`);
			return checks;
		}
		// After go-live: --force, and a D1 Time Travel bookmark before the first write.
		if (target === "production") {
			const g = await guardLiveProductionWrite({ live: t.live, force: !!force, slug: config.slug, cf: cf as never, vars: { ...process.env, ...env }, bookmarksFile: join(paths.root, "load", "d1-bookmarks.jsonl") });
			if (!g.ok) {
				check("live-guard", "Reload of live production allowed", false, g.detail);
				return checks;
			}
			if (g.bookmark) {
				check("d1-bookmark", "D1 Time Travel bookmark recorded before writing to live production", true, `${g.bookmark.bookmark} (load/d1-bookmarks.jsonl). Restore: cd <project> && ${g.restore}`);
				reporter.emit({ type: "log", level: "warn", message: `Live production: bookmark ${g.bookmark.bookmark} recorded. To undo this load: cd ${paths.project} && ${g.restore}` });
			}
		}
		siteOrigin = new URL(t.url).origin;
		remoteLive = !!t.live;
		// Optional pinned addresses for a fresh workers.dev host (see docs/staging-setup.md → DNS).
		if (t.addresses.length) {
			pinHost(new URL(t.url).hostname, t.addresses);
			reporter.emit({ type: "log", level: "info", message: `connecting to ${new URL(t.url).hostname} via pinned addresses (${t.addresses.join(", ")})` });
		}
		api = new EmDashApi(t.url, { token: t.token });
	} else {
		const port = Number(process.env.WP2EMDASH_DEV_PORT ?? 4399);
		stop = await ensureDevServer(paths.project, port, (m) => reporter.emit({ type: "log", level: "info", message: m }));
		const base = `http://localhost:${port}`;
		const status = (await (await fetch(`${base}/_emdash/api/setup/status`)).json()) as { data?: { needsSetup?: boolean; isComplete?: boolean; complete?: boolean } };
		const needsSetup = status.data?.needsSetup ?? !(status.data?.isComplete ?? status.data?.complete ?? false);
		if (needsSetup) {
			// Structure only (block types, collections, menus, settings): content comes from this phase, not the seed.
			const r = await fetch(`${base}/_emdash/api/setup/dev-bypass?content=0`, { method: "POST", headers: { "X-EmDash-Request": "1", Origin: base, "Content-Type": "application/json" } });
			await r.body?.cancel();
			reporter.emit({ type: "log", level: "info", message: `local site set up from seed (structure only): HTTP ${r.status}` });
		}
		api = new EmDashApi(base, { devBypass: true });
	}

	try {
		return await load();
	} finally {
		stop();
	}

	async function load(): Promise<GateCheck[]> {
		const site = siteIr;
		const blogPlan = readJson<BlogPlan>(join(paths.ir, "blog.json"));
		// ── Schema on the target ─────────────────────────────────────────────────
		try {
			const [bt, cols] = await Promise.all([api.blockTypesFull(), api.collections()]);
			check("target", `Target reachable and authenticated (${target})`, true, api.baseUrl);
			// Schema sync: block types live in the target's database (seeded once at setup). When the kit's section
			// library gains fields, update them before writing content that uses those fields.
			// EmDash stores field definitions with its own key order: compare with keys sorted at every level.
			const sortKeys = (v: unknown): unknown => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)])) : v);
			const canon = (v: unknown) => JSON.stringify(sortKeys(v));
			const schemaChanges: string[] = [];
			const schemaErrors: string[] = [];
			for (const lib of BLOCK_TYPES) {
				const want = lib.versions[lib.versions.length - 1]?.fields ?? [];
				const have = bt.find((x) => x.slug === lib.slug);
				try {
					if (!have) {
						await api.createBlockType({ slug: lib.slug, label: lib.label, description: lib.description, category: lib.category, fields: want });
						schemaChanges.push(`${lib.slug} created`);
						continue;
					}
					const active = have.versions.find((v) => v.active) ?? have.versions.find((v) => v.version === have.currentVersion);
					if (active && canon(active.fields) !== canon(want)) {
						await api.updateBlockType(lib.slug, { expectedFingerprint: active.fingerprint, fields: want });
						schemaChanges.push(`${lib.slug} updated`);
					}
				} catch (e) {
					const err = e as EmDashHttpError;
					schemaErrors.push(`${lib.slug}: ${err.code === "INSUFFICIENT_SCOPE" ? "the API token needs the schema:write scope" : err.code === "BLOCK_TYPE_BREAKING_CHANGE" ? "incompatible change — needs a new block type version (owner decision)" : err.message}`);
				}
			}
			// Blog sites: the posts collection (seeded on a new site; created here on a site set up before the blog existed).
			if (blogPlan && !cols.some((x) => x.slug === "posts")) {
				try {
					const { fields, dateField: _d, ...col } = POSTS_COLLECTION;
					await api.createCollection({ ...col, supports: [...col.supports], hasSeo: true, sortOrder: 2 });
					for (const f of fields) await api.createField("posts", { ...f });
					cols.push({ slug: "posts" });
					schemaChanges.push("collection posts created");
				} catch (e) {
					const err = e as EmDashHttpError;
					schemaErrors.push(`posts: ${err.code === "INSUFFICIENT_SCOPE" ? "the API token needs the schema:write scope" : err.message}`);
				}
			}
			const missingCols = ["pages", "site_parts", "popups", ...(blogPlan ? ["posts"] : [])].filter((c) => !cols.some((x) => x.slug === c));
			check("schema", "Section library in sync and collections present on the target", schemaErrors.length === 0 && missingCols.length === 0, [...schemaErrors.slice(0, 4), ...missingCols.map((c) => `collection ${c} missing`)].join("; ") || (schemaChanges.length ? schemaChanges.join(", ") : `${bt.length} block types up to date`));
			if (schemaErrors.length || missingCols.length) return checks;
		} catch (e) {
			const cause = (e as { cause?: { code?: string; message?: string } }).cause;
			check("target", `Target reachable and authenticated (${target})`, false, `${(e as Error).message}${cause ? ` (${cause.code ?? ""} ${cause.message ?? ""})`.trimEnd() : ""}`);
			return checks;
		}

		// ── Inputs ───────────────────────────────────────────────────────────────
		const loadDir = (d: string) => (existsSync(join(paths.ir, d)) ? readdirSync(join(paths.ir, d)).filter((f) => f.endsWith(".json")).map((f) => readJson<IrPage>(join(paths.ir, d, f)) as IrPage) : []);
		const docs: IrPage[] = [...loadDir("pages"), ...loadDir("posts"), ...site.partials.map((p) => readJson<IrPage>(join(paths.ir, p.file)) as IrPage), ...site.popups.map((p) => readJson<IrPage>(join(paths.ir, p.file)) as IrPage)].filter(Boolean);
		const manifest = readJson<MediaEntry[]>(join(paths.raw, "media-manifest.json")) ?? [];
		const byWpId = new Map(manifest.filter((m) => m.id && m.file).map((m) => [m.id as number, m]));
		const mapFile = join(paths.root, "load", `id-map.${target}.json`);
		const idMap: IdMap = readJson<IdMap>(mapFile) ?? { target, baseUrl: api.baseUrl, media: {}, content: {} };
		const saveMap = () => write(mapFile, idMap);
		const siteHosts = new Set([new URL(config.source.url).host, ...config.source.alternateHosts].map((h) => h.replace(/^www\./, "")));
		const uploadsRe = /\/(?:wp-content\/uploads|storage)\/\d{4}\/\d{2}\/[^\s"')]+/i;

		const sep = /\s([-–—|·•])\s/.exec(docs.find((d) => d.route?.isFrontPage)?.seo.title ?? "")?.[1] ?? "-";
		// Media already on the target, by content hash (filled by the media step; settings looks its uploads up here too).
		const bySha = new Map<string, Awaited<ReturnType<typeof api.mediaList>>[number]>();
		if (onlySettings) for (const m of await api.mediaList()) if (m.contentHash) bySha.set(String(m.contentHash).replace(/^sha1:/, ""), m);
		// --only settings: just Settings (General, Social Links, SEO) — the safe way to apply them to a live site without
		// rewriting pages an editor may have changed since launch.
		if (!onlySettings) {
		// ── Media ────────────────────────────────────────────────────────────────
		const refs = new Map<string, MediaRef>();
		const collect = (v: unknown) => {
			if (!v || typeof v !== "object") return;
			if (Array.isArray(v)) return v.forEach(collect);
			const o = v as Record<string, unknown>;
			if (("wpId" in o || "url" in o) && (o.kind === "image" || o.kind === "video" || o.kind === "file")) refs.set(mediaKey(o as MediaRef), o as MediaRef);
			else for (const x of Object.values(o)) collect(x);
		};
		for (const d of docs) collect([d.sections, d.featuredImage, d.post?.body ?? []]);
		for (const b of blogPlan?.bylines ?? []) if (b.avatar) refs.set(mediaKey(b.avatar), b.avatar);
		// Social sharing image (og:image from the SEO plugin): uploaded like any other picture and set as the page's SEO image.
		const uploadPath = (u: string) => /\/(?:wp-content\/uploads|storage)\/(.+)$/.exec(u.split(/[?#]/)[0] ?? "")?.[1]?.replace(/-\d+x\d+(?=\.[a-z0-9]+$)/i, "").toLowerCase();
		const ogRef = (d: IrPage): MediaRef | undefined => {
			const u = d.seo.ogImage;
			if (!u || !/^https?:/.test(u)) return undefined;
			const path = uploadPath(u);
			const m = path ? manifest.find((x) => x.id && x.file?.toLowerCase() === path) : undefined;
			return m ? { kind: "image", wpId: m.id as number, ...(m.alt ? { alt: m.alt } : {}) } : siteHosts.has(new URL(u).host.replace(/^www\./, "")) ? undefined : { kind: "image", url: u };
		};
		for (const d of docs) {
			const r = ogRef(d);
			if (r) refs.set(mediaKey(r), r);
		}

		reporter.emit({ type: "step:start", step: "Media", total: refs.size });
		const existing = await api.mediaList();
		for (const m of existing) if (m.contentHash) bySha.set(String(m.contentHash).replace(/^sha1:/, ""), m);
		const existingIds = new Set(existing.map((m) => m.id));
		let uploaded = 0;
		let reused = 0;
		const mediaErrors: string[] = [];
		let n = 0;
		const slowVideos: string[] = [];
		const svgConverted: string[] = [];
		let svgBrowser: import("playwright").Browser | undefined;
		for (const [key, ref] of refs) {
			reporter.emit({ type: "step:progress", step: "Media", done: ++n, total: refs.size, item: key });
			const known = idMap.media[key];
			// An mp4 loaded before the index-first rewrite is checked again (its bytes change once).
			if (known && existingIds.has(known.id) && !(known.mime === "video/mp4" && !known.faststart)) continue;
			try {
				let bytes: Buffer;
				let filename: string;
				if (ref.wpId) {
					const m = byWpId.get(ref.wpId);
					if (!m?.file) throw new Error("not in raw/media (rerun extract)");
					bytes = readFileSync(join(paths.raw, "media", m.file));
					filename = m.file.split("/").pop() as string;
				} else {
					const url = ref.url as string;
					const decision = externalMediaDecision(overrides, url);
					if (decision !== "copy") throw new Error(decision === "hotlink" ? "hotlinked media is not supported by the EmDash target yet; set overrides.media.external to copy" : "no decision in overrides.media.external (copy or hotlink)");
					const cache = join(paths.raw, "media", "external", `${createHash("sha1").update(url).digest("hex").slice(0, 12)}-${url.split("/").pop()?.split("?")[0]}`);
					if (!existsSync(cache)) {
						const r = await fetch(url);
						if (!r.ok) throw new Error(`download HTTP ${r.status}`);
						mkdirSync(dirname(cache), { recursive: true });
						writeFileSync(cache, Buffer.from(await r.arrayBuffer()));
					}
					bytes = readFileSync(cache);
					filename = url.split("/").pop()?.split("?")[0] ?? "file";
				}
				// EmDash refuses SVG uploads: draw it to a sharp PNG (see targets/emdash/svg.ts).
				if (mimeOf(filename) === "image/svg+xml" || /\.svg$/i.test(filename)) {
					svgBrowser ??= await (await import("playwright")).chromium.launch();
					bytes = await svgToPng(bytes, svgBrowser);
					filename = filename.replace(/\.svg$/i, "") + ".png";
					svgConverted.push(filename);
				}
				if (mimeOf(filename) === "video/mp4" && needsFaststart(bytes)) {
					const fixed = faststart(bytes);
					if ("bytes" in fixed) bytes = fixed.bytes;
					else slowVideos.push(`${filename}: ${fixed.error}`);
				}
				const sha1 = createHash("sha1").update(bytes).digest("hex");
				if (known && known.sha1 === sha1 && existingIds.has(known.id)) continue;
				let item: MediaItem | undefined = bySha.get(sha1);
				if (item) reused++;
				else {
					item = await api.mediaUpload(bytes, filename, mimeOf(filename), ref.alt);
					bySha.set(sha1, item);
					uploaded++;
				}
				const mime = item.mimeType ?? mimeOf(filename);
				idMap.media[key] = { id: item.id, sha1, mime, ...(item.url ? { url: item.url } : {}), ...(mime === "video/mp4" && !needsFaststart(bytes) ? { faststart: true } : {}) };
			} catch (e) {
				mediaErrors.push(`${key}: ${(e as Error).message}`);
			}
		}
		saveMap();
		if (slowVideos.length) reporter.emit({ type: "log", level: "warn", message: `Videos left with the index last (slower start): ${slowVideos.join("; ")}` });
		if (svgBrowser) await svgBrowser.close().catch(() => {});
		if (svgConverted.length) reporter.emit({ type: "log", level: "info", message: `SVG drawn to PNG (EmDash's media library takes no SVG): ${svgConverted.join(", ")}` });
		reporter.emit({ type: "step:end", step: "Media", ok: mediaErrors.length === 0, detail: `${uploaded} uploaded, ${reused} reused, ${refs.size} referenced` });
		check("media", "Every referenced media item is on the target", mediaErrors.length === 0, mediaErrors.slice(0, 6).join("; ") || `${refs.size} items (${uploaded} uploaded, ${reused} already there)`);

		const resolver = (m: MediaRef | undefined) => {
			if (!m) return undefined;
			const e = idMap.media[mediaKey(m)];
			return e ? { provider: "local", id: e.id, ...(m.alt ? { alt: m.alt } : {}) } : undefined;
		};

		// ── Link fix-ups: absolute site links → paths; upload links → EmDash media ──
		const fixHref = (href: string): string => {
			try {
				const u = new URL(href, config.source.url);
				if (siteHosts.has(u.host.replace(/^www\./, ""))) {
					if (uploadsRe.test(u.pathname)) {
						const key = [...byWpId.values()].find((m) => m.file && u.pathname.toLowerCase().endsWith(m.file.toLowerCase()));
						const mapped = key?.id ? idMap.media[`wp:${key.id}`]?.url : undefined;
						if (mapped) return mapped;
					}
					if (/^https?:/i.test(href)) return `${u.pathname}${u.search}${u.hash}`;
				}
			} catch {}
			return href;
		};
		const fixLinks = <T>(v: T): T => {
			if (Array.isArray(v)) return v.map(fixLinks) as T;
			if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, k === "href" && typeof x === "string" ? fixHref(x) : fixLinks(x)])) as T;
			return v;
		};

		// ── Blog: taxonomy definitions, terms (parents first), bylines — before the posts that reference them ──────
		const bylineIds = new Map<string, string>();
		if (blogPlan) {
			const taxErrors: string[] = [];
			let termsCreated = 0;
			try {
				const defs = await api.taxonomies();
				for (const t of blogPlan.taxonomies) {
					try {
						const def = defs.find((d) => d.name === t.name);
						if (!def) await api.createTaxonomy({ name: t.name, label: t.label, labelSingular: t.labelSingular, hierarchical: t.hierarchical, collections: ["posts"] });
						else if (!def.collections.includes("posts")) taxErrors.push(`${t.name}: exists on the target without the posts collection (add it in the admin: Taxonomies → ${t.label})`);
						const have = new Map((await api.terms(t.name)).map((x) => [x.slug, x]));
						for (const term of t.terms) {
							if (have.has(term.slug)) continue;
							const parentId = term.parent ? have.get(term.parent)?.id : undefined;
							const made = await api.createTerm(t.name, { slug: term.slug, label: term.label, ...(parentId ? { parentId } : {}), ...(term.description ? { description: term.description } : {}) });
							have.set(term.slug, made);
							termsCreated++;
						}
					} catch (e) {
						taxErrors.push(`${t.name}: ${(e as EmDashHttpError).code === "INSUFFICIENT_SCOPE" ? "the API token needs content:write (or taxonomies:manage)" : (e as Error).message}`);
					}
				}
			} catch (e) {
				taxErrors.push((e as Error).message);
			}
			check("taxonomies", "Blog taxonomies and terms on the target", taxErrors.length === 0, taxErrors.slice(0, 4).join("; ") || `${blogPlan.taxonomies.map((t) => `${t.name} ${t.terms.length}`).join(", ")} terms (${termsCreated} created)`);
			if (blogPlan.bylines.length) {
				const bylineErrors: string[] = [];
				let bylinesCreated = 0;
				try {
					const have = new Map((await api.bylines()).map((b) => [b.slug, b]));
					for (const b of blogPlan.bylines) {
						const known = have.get(b.slug);
						if (known) {
							bylineIds.set(b.slug, known.id);
							continue;
						}
						const avatar = b.avatar ? idMap.media[mediaKey(b.avatar)]?.id : undefined;
						// Guest bylines: names on posts, never user accounts.
						const made = await api.createByline({ slug: b.slug, displayName: b.displayName, ...(b.bio ? { bio: b.bio } : {}), ...(avatar ? { avatarMediaId: avatar } : {}), isGuest: true });
						bylineIds.set(b.slug, made.id);
						bylinesCreated++;
					}
				} catch (e) {
					bylineErrors.push((e as EmDashHttpError).code === "INSUFFICIENT_SCOPE" ? "the API token needs the admin scope (EmDash 1.5 serves bylines under /_emdash/api/admin/bylines; docs/staging-setup.md)" : (e as Error).message);
				}
				check("bylines", "Bylines from the WordPress authors on the target (no user accounts)", bylineErrors.length === 0, bylineErrors.join("; ") || `${blogPlan.bylines.length} bylines (${bylinesCreated} created)`);
			}
		}
		const postMedia = (m: MediaRef) => idMap.media[mediaKey(m)];

		// ── Content ──────────────────────────────────────────────────────────────
		reporter.emit({ type: "step:start", step: "Content", total: docs.length });
		const existingByCollection = new Map<string, Awaited<ReturnType<typeof api.list>>>();
		for (const c of ["pages", "site_parts", "popups", ...(blogPlan ? ["posts"] : [])]) existingByCollection.set(c, await api.list(c));
		const contentErrors: string[] = [];
		const drops: string[] = [];
		let created = 0;
		let updated = 0;
		let adopted = 0;
		for (const [i, doc] of docs.entries()) {
			const collection = collectionOf(doc, !!blogPlan);
			const slug = doc.kind === "page" || doc.kind === "post" ? routeToSlug(doc.route?.path ?? doc.source.slug) : doc.source.slug;
			const key = `${doc.source.type}:${doc.source.wpId}`;
			reporter.emit({ type: "step:progress", step: "Content", done: i + 1, total: docs.length, item: `${collection}/${slug}` });
			try {
				const sections = fixLinks(doc.sections) as Section[];
				const content = sections.map((s, j) => sectionToBlock(s, blockKey(doc.source.slug, j, s.type), resolver, (d) => drops.push(`${slug} ${s.type}#${j}: ${d.join(", ")}`)));
				const data: Record<string, unknown> = { title: doc.title, content };
				const isPost = collection === "posts" && !!doc.post;
				if (isPost && doc.post) {
					data.body = fixLinks(resolvePostBody(doc.post.body, postMedia));
					if (doc.post.excerpt) data.excerpt = doc.post.excerpt;
					const featured = resolver(doc.featuredImage);
					if (featured) data.featured_image = featured;
					data.featured = !!doc.post.sticky;
					if (doc.post.format) data.format = doc.post.format;
				}
				if (doc.kind === "popup") {
					const sel = doc.popup?.selectors.filter((s) => !s.includes("popmake")).join(", ");
					if (sel) data.selectors = sel;
					if (doc.popup?.autoOpen) data.auto_open_delay = doc.popup.autoOpen.delayMs;
				}
				// The starter adds " – Site" to the page title; any other title is printed as written. So the source title
				// is stored without the suffix when that leaves the page title, and as the live site printed it otherwise
				// (a custom SEO title, with or without the site name).
				const stripped = doc.seo.title?.replace(new RegExp(`\\s*[${sep}]\\s*${site.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`), "").trim();
				const seoTitle = stripped && stripped !== doc.title.trim() ? doc.seo.title?.trim() : stripped;
				const seo = doc.kind === "page" || doc.kind === "post" ? { ...(seoTitle ? { title: seoTitle } : {}), ...(doc.seo.description ? { description: doc.seo.description.slice(0, 500) } : {}), ...(doc.seo.canonical && /^https?:/.test(doc.seo.canonical) ? { canonical: productionCanonical(doc.seo.canonical, siteHosts, config.target.productionUrl) } : {}), ...(/noindex/i.test(doc.seo.robots ?? "") ? { noIndex: true } : {}), ...(() => {
					const r = ogRef(doc);
					// The file path, not the media id: EmDash expands a bare id to /media/file/<id>, which 404s (files are served by storage key).
					const url = r ? idMap.media[mediaKey(r)]?.url : undefined;
					return url?.startsWith("/_emdash/api/media/file/") ? { image: url } : {};
				})() } : undefined;

				let entryId = idMap.content[key]?.id;
				const list = existingByCollection.get(collection) ?? [];
				if (entryId && !list.some((e) => e.id === entryId)) entryId = undefined; // deleted on the target
				if (!entryId) {
					const bySlug = list.find((e) => e.slug === slug);
					if (bySlug) {
						entryId = bySlug.id;
						adopted++;
						reporter.emit({ type: "log", level: "info", message: `adopted existing ${collection}/${slug} (first load into this target)` });
					}
				}
				// Posts: bylines (byline ids), term assignments (taxonomy → term slugs) and the WordPress publish date.
				const postExtras = isPost && doc.post ? { bylines: doc.post.bylines.flatMap((b) => (bylineIds.get(b) ? [{ bylineId: bylineIds.get(b) as string }] : [])), taxonomies: doc.post.terms, ...(doc.post.publishedAt && doc.source.status === "publish" ? { publishedAt: doc.post.publishedAt } : {}) } : {};
				if (entryId) {
					const cur = await api.get(collection, entryId);
					await api.update(collection, entryId, { data, slug, ...(seo ? { seo } : {}), ...postExtras, ...(cur._rev ? { _rev: cur._rev } : {}) });
					updated++;
				} else {
					const item = await api.create(collection, { data, slug, ...(seo ? { seo } : {}), ...postExtras });
					entryId = item.id;
					created++;
				}
				idMap.content[key] = { collection, id: entryId, slug };
				saveMap();
				const action = isPost ? postAction(doc, overrides.protectedPosts?.as) : doc.source.status === "publish" ? "publish" : "draft";
				if (action === "publish") await api.publish(collection, entryId, isPost ? doc.post?.publishedAt : undefined);
				else if (action === "schedule" && doc.post?.publishedAt) await api.schedule(collection, entryId, doc.post.publishedAt);
				else {
					const cur = await api.get(collection, entryId);
					if (cur.status === "published") await api.unpublish(collection, entryId);
				}
			} catch (e) {
				contentErrors.push(`${collection}/${slug}: ${(e as Error).message}`);
			}
		}
		reporter.emit({ type: "step:end", step: "Content", ok: contentErrors.length === 0, detail: `${created} created, ${updated} updated${adopted ? `, ${adopted} adopted` : ""}` });
		for (const d of drops) reporter.emit({ type: "log", level: "info", message: `not stored (no matching field): ${d}` });
		check("content", "Every IR document written to the target", contentErrors.length === 0, contentErrors.slice(0, 5).join("; ") || `${docs.length} documents (${created} created, ${updated} updated)`);

		// ── Menus & settings ─────────────────────────────────────────────────────
		const menuErrors: string[] = [];
		for (const role of ["primary", "secondary", "footer"] as const) {
			const m = site.menus.find((x) => x.role === role);
			if (!m) continue;
			try {
				if (await api.menu(role)) await api.deleteMenu(role);
				await api.createMenu(role, `${role[0]?.toUpperCase()}${role.slice(1)} navigation`);
				const add = async (items: typeof m.items, parentId?: string) => {
					for (const [i, it] of items.entries()) {
						const created = await api.createMenuItem(role, { type: "custom", label: it.label, customUrl: it.opensPopup ? `#${it.opensPopup}` : fixHref(it.href), sortOrder: i, ...(it.newTab ? { target: "_blank" } : {}), ...menuItemExtras(it), ...(parentId ? { parentId } : {}) });
						if (it.children.length) await add(it.children, created.id);
					}
				};
				await add(m.items);
			} catch (e) {
				menuErrors.push(`${role}: ${(e as Error).message}`);
			}
		}
		try {
			await api.updateSettings({
				/* EmDash's staging flag puts noindex on every page. Production must not carry it, or the launched domain is
			   noindexed (seen at a go-live). Pre-launch hosts are still kept out of search: the starter middleware sends
			   X-Robots-Tag noindex on any host that is not the production hostname, and staging sets STAGING=1. */
				staging: target !== "production",
				/* Site URL (site:url): sign-in links, invites and password resets are built from it. Without it EmDash
			   falls back to the address recorded at first setup — usually the workers.dev host — so a launched site
			   sent people back to workers.dev after a magic-link sign-in. Before the switch it is the workers.dev address
			   (the real domain still serves WordPress); `golive` sets the real domain. */
				...(siteOrigin ? { url: siteOrigin } : {}),
			});
		} catch (e) {
			menuErrors.push(`settings: ${(e as Error).message}`);
		}
		check("menus", "Menus written", menuErrors.length === 0, menuErrors.join("; ") || site.menus.map((m) => `${m.role} ${m.items.length}`).join(", "));
		}

		// ── Site settings (Settings → General, Social Links, SEO) from ir/settings.json ──────────────────────
		// What load wrote is remembered per setting: a value an editor changed in the admin since is kept
		// (src/targets/emdash/settings.ts) unless --overwrite-settings.
		{
			const irS = readJson<IrSettings>(join(paths.ir, "settings.json"));
			const settingsFile = join(paths.root, "load", `settings.${target}.json`);
			const errors: string[] = [];
			const media: Record<string, { mediaId: string; alt?: string } | undefined> = {};
			// Logo and favicon: the brand files scaffold put in public/brand (what the header shows; the starter keeps serving
			// their optimized copies while the setting points at them), else the WordPress attachment.
			const projectConfig = readJson<{ header?: { logo?: string }; favicon?: string; icons?: { href: string; type: string; sizes?: string }[] }>(join(paths.project, "src", "site.config.json")) ?? {};
			const brandBytes = (p: string | undefined) => (p?.startsWith("/brand/") && existsSync(join(paths.project, "public", p)) ? readFileSync(join(paths.project, "public", p)) : undefined);
			const uploadable = (f: string) => /\.(png|jpe?g|gif|webp|avif|svg)$/i.test(f);
			const settingMedia = async (name: "logo" | "favicon" | "og", brandPath: string | undefined, ref: MediaRef | undefined, alt: string) => {
				try {
					const original = brandBytes(brandPath);
					let bytes: Buffer | undefined;
					let file: string | undefined;
					if (original && brandPath) {
						// Named after the original's hash: the starter recognises the migrated file even when it had to be converted (sharp PNG of an SVG, PNG icon of an .ico).
						const mark = `wp2emdash-${name}-${createHash("sha1").update(original).digest("hex").slice(0, 10)}`;
						if (uploadable(brandPath)) [bytes, file] = [original, `${mark}${extname(brandPath).toLowerCase()}`];
						else {
							const icon = (projectConfig.icons ?? []).filter((i) => /image\/(png|webp)/.test(i.type)).sort((a, b) => Number.parseInt(b.sizes ?? "0", 10) - Number.parseInt(a.sizes ?? "0", 10))[0];
							const b = brandBytes(icon?.href);
							if (b && icon) [bytes, file] = [b, `${mark}${extname(icon.href).toLowerCase()}`];
						}
					}
					if (!bytes && ref?.wpId) {
						const m = byWpId.get(ref.wpId);
						if (m?.file && uploadable(m.file)) [bytes, file] = [readFileSync(join(paths.raw, "media", m.file)), m.file.split("/").pop() as string];
					}
					if (!bytes && ref?.url && /^https?:/.test(ref.url)) {
						const known = idMap.media[mediaKey(ref)];
						if (known && (await mediaIdsNow()).has(known.id)) return { mediaId: known.id, alt };
					}
					if (!bytes || !file) return undefined;
					if (/\.svg$/i.test(file)) {
						const b = await (await import("playwright")).chromium.launch();
						try {
							bytes = await svgToPng(bytes, b);
						} finally {
							await b.close().catch(() => {});
						}
						file = file.replace(/\.svg$/i, ".png");
					}
					const sha1 = createHash("sha1").update(bytes).digest("hex");
					const item = bySha.get(sha1) ?? (await api.mediaUpload(bytes, file, mimeOf(file), alt));
					bySha.set(sha1, item);
					idMap.media[`settings:${name}`] = { id: item.id, sha1, mime: item.mimeType ?? mimeOf(file), ...(item.url ? { url: item.url } : {}) };
					return { mediaId: item.id, alt };
				} catch (e) {
					errors.push(`${name}: ${(e as Error).message}`);
					return undefined;
				}
			};
			let mediaIdsCache: Set<string> | undefined;
			const mediaIdsNow = async () => (mediaIdsCache ??= new Set((await api.mediaList()).map((m) => m.id)));
			media.logo = await settingMedia("logo", projectConfig.header?.logo, irS?.logo, site.title);
			media.favicon = await settingMedia("favicon", projectConfig.favicon, irS?.favicon, site.title);
			media.og = irS?.seo.defaultOgImage ? await settingMedia("og", undefined, irS.seo.defaultOgImage, site.title) : undefined;
			saveMap();
			const desired = desiredSettings(site, irS, { titleSeparator: sep, logo: media.logo, favicon: media.favicon, defaultOgImage: media.og });
			try {
				const current = await api.settings();
				const plan = planSettings({ desired, current, ...(existsSync(settingsFile) ? { record: readJson<SettingsRecord>(settingsFile) } : {}), overwrite: !!overwriteSettings, live: target === "production" && remoteLive });
				if (Object.keys(plan.payload).length) await api.updateSettings(plan.payload);
				write(settingsFile, plan.record);
				if (plan.staleRecord) reporter.emit({ type: "log", level: "info", message: `settings: load/settings.${target}.json matched nothing on the target (a new or reset database): written as a first load` });
				for (const k of plan.kept) reporter.emit({ type: "log", level: "warn", message: `settings: kept editor's value for ${k} (changed in the admin since the last load; --overwrite-settings replaces it)` });
				check("settings", "Site settings written (General, Social Links, SEO)", errors.length === 0, [errors.length ? `media: ${errors.join("; ")}` : "", `${plan.written.length} written${plan.written.length ? ` (${plan.written.join(", ")})` : ""}, ${plan.unchanged.length} unchanged${plan.kept.length ? `, kept editor's value: ${plan.kept.join(", ")}` : ""}`].filter(Boolean).join("; "));
			} catch (e) {
				check("settings", "Site settings written (General, Social Links, SEO)", false, (e as Error).message);
			}
		}

		// Redirects from the plugin exports (raw/redirects.json, made by extract). Kit rules are tagged with a group so a
		// rerun updates them and never touches redirects someone added in the admin.
		const redirectsFile = join(paths.raw, "redirects.json");
		if (!onlySettings && overrides.redirects.source !== "none" && existsSync(redirectsFile)) {
			const { rules = [] } = JSON.parse(readFileSync(redirectsFile, "utf8")) as { rules?: { source: string; destination: string; type: number }[] };
			const errors: string[] = [];
			let created = 0;
			let updated = 0;
			let same = 0;
			try {
				const existing = new Map((await api.listRedirects()).map((r) => [r.source, r]));
				for (const r of rules) {
					const have = existing.get(r.source);
					try {
						if (!have) {
							await api.createRedirect({ source: r.source, destination: r.destination, type: r.type, groupName: "wordpress" });
							created++;
						} else if (have.groupName !== "wordpress") errors.push(`${r.source}: already set in the admin (kept)`);
						else if (have.destination !== r.destination || have.type !== r.type) {
							await api.updateRedirect(have.id, { destination: r.destination, type: r.type });
							updated++;
						} else same++;
					} catch (e) {
						errors.push(`${r.source}: ${(e as Error).message}`);
					}
				}
			} catch (e) {
				errors.push(`list: ${(e as Error).message}`);
			}
			check("redirects", "Redirects imported", errors.length === 0, `${created} created, ${updated} updated, ${same} unchanged${errors.length ? `; ${errors.slice(0, 5).join("; ")}${errors.length > 5 ? "; …" : ""}` : ""}`);
		} else if (!onlySettings && overrides.redirects.source === "file") check("redirects", "Redirects imported", false, "redirects.source is \"file\" but raw/redirects.json is missing: put the redirect export in raw/plugin-exports/ and rerun extract");

		// ── Verify on the target ───────────────────────────────────────────────────
		reporter.emit({ type: "step:start", step: "Verify target" });
		const leftovers: string[] = [];
		const missingMedia: string[] = [];
		const mediaIds = new Set((await api.mediaList()).map((m) => m.id));
		const counts: string[] = [];
		const dupes: string[] = [];
		// Posts: the WordPress publish date kept, read back from the target.
		const dateErrors: string[] = [];
		for (const c of ["pages", "site_parts", "popups", ...(blogPlan ? ["posts"] : [])]) {
			const items = await api.list(c);
			const expected = docs.filter((d) => collectionOf(d, !!blogPlan) === c).length;
			if (c === "posts") {
				for (const d of docs.filter((x) => collectionOf(x, true) === "posts" && x.source.status === "publish" && x.post?.publishedAt && postAction(x, overrides.protectedPosts?.as) === "publish")) {
					const it = items.find((x) => x.id === idMap.content[`${d.source.type}:${d.source.wpId}`]?.id) as (ContentItem & { publishedAt?: string | null }) | undefined;
					const at = it?.publishedAt ? Date.parse(it.publishedAt) : Number.NaN;
					if (!it) dateErrors.push(`${d.source.slug}: not on the target`);
					else if (it.status !== "published") dateErrors.push(`${d.source.slug}: ${it.status}`);
					else if (Math.abs(at - Date.parse(d.post?.publishedAt as string)) > 1000) dateErrors.push(`${d.source.slug}: published ${it.publishedAt ?? "—"} vs ${d.post?.publishedAt} on WordPress`);
				}
			}
			if (items.length !== expected) counts.push(`${c}: ${items.length} on target vs ${expected} in IR`);
			const slugs = items.map((x) => x.slug);
			for (const s of new Set(slugs.filter((s, i) => slugs.indexOf(s) !== i))) dupes.push(`${c}/${s}`);
			for (const it of items) {
				const full = await api.get(c, it.id);
				const json = JSON.stringify(full.data);
				for (const h of siteHosts) if (json.includes(`//${h}`) || json.includes(`//www.${h}`)) leftovers.push(`${c}/${it.slug}: link to ${h}`);
				if (uploadsRe.test(json)) leftovers.push(`${c}/${it.slug}: WordPress upload URL`);
				if (/\[(vc_|nectar|\/?[a-z_]+\s+[a-z_]+=")/i.test(json)) leftovers.push(`${c}/${it.slug}: raw shortcode`);
				for (const m of json.matchAll(/"provider":"local","id":"([^"]+)"/g)) if (!mediaIds.has(m[1] as string)) missingMedia.push(`${c}/${it.slug}: media ${m[1]}`);
			}
		}
		if (!onlySettings) check("counts", "Entry counts on the target equal the IR, no duplicate slugs", counts.length === 0 && dupes.length === 0, [...counts, ...dupes.map((d) => `duplicate ${d}`)].join("; ") || undefined);
		if (!onlySettings && blogPlan) check("post-dates", "Published posts keep their WordPress publish date", dateErrors.length === 0, dateErrors.slice(0, 6).join("; ") || `${docs.filter((x) => x.kind === "post" && x.source.status === "publish").length} posts`);
		check("no-wordpress-leftovers", "No WordPress links, upload URLs or shortcodes in stored content", leftovers.length === 0, [...new Set(leftovers)].slice(0, 8).join("; ") || undefined);
		check("media-integrity", "Every media id in stored content exists on the target", missingMedia.length === 0, missingMedia.slice(0, 5).join("; ") || undefined);
		const idMapComplete = docs.every((d) => idMap.content[`${d.source.type}:${d.source.wpId}`]);
		check("id-map", "id-map covers every document", idMapComplete, `load/id-map.${target}.json`);

		// Every published page renders and shows its first heading.
		const renderFails: string[] = [];
		const rendered = docs.filter((x) => (x.kind === "page" && x.source.status === "publish") || (blogPlan && x.kind === "post" && x.post && postAction(x, overrides.protectedPosts?.as) === "publish"));
		for (const d of rendered) {
			const path = d.route?.path ?? "/";
			try {
				const r = await kitFetch(`${api.baseUrl}${path}`, { redirect: "manual" });
				const html = await r.text();
				const firstHeading = d.kind === "post" ? d.title : d.sections.flatMap((s) => (Array.isArray((s.fields as { heading?: unknown }).heading) ? ((s.fields as { heading: { children: { text: string }[] }[] }).heading) : [])).flatMap((b) => b.children.map((c) => c.text))[0];
				if (r.status !== 200) renderFails.push(`${path} HTTP ${r.status}`);
				else if (firstHeading && !html.includes(firstHeading.replace(/&/g, "&amp;").slice(0, 30)) && !html.includes(firstHeading.slice(0, 30))) renderFails.push(`${path}: "${firstHeading.slice(0, 30)}" not in HTML`);
			} catch (e) {
				renderFails.push(`${path}: ${(e as Error).message}`);
			}
		}
		reporter.emit({ type: "step:end", step: "Verify target", ok: renderFails.length === 0 });
		check("render", "Every published page renders on the target", renderFails.length === 0, renderFails.slice(0, 6).join("; ") || `${rendered.filter((x) => x.kind === "page").length} pages${blogPlan ? `, ${rendered.filter((x) => x.kind === "post").length} posts` : ""}`);
		return checks;
	}
}
