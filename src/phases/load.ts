/**
 * Phase 5 — load. IR → a running EmDash site (local dev server by default; staging with
 * WP2EMDASH_LOAD_TARGET=staging, target.stagingUrl and EMDASH_TOKEN). Idempotent:
 * an id-map links every WordPress document/media item to its EmDash id, media dedupes by sha1,
 * updates use the entry's revision. The gate re-reads everything from the target.
 */
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { externalMediaDecision, loadOverrides } from "../config/overrides.js";
import type { GateCheck } from "../core/state.js";
import { loadSiteEnv } from "../extract/credentials.js";
import type { IrPage, IrSite, MediaRef, Section } from "../ir/schema.js";
import { routeToSlug } from "../scaffold/seed.js";
import { BLOCK_TYPES } from "../starter/library.js";
import { EmDashApi, type MediaItem } from "../targets/emdash/api.js";
import { sectionToBlock } from "../targets/emdash/blocks.js";
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
	media: Record<string, { id: string; sha1: string; url?: string; mime: string }>;
	content: Record<string, { collection: string; id: string; slug: string }>;
}

const MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp", ".avif": "image/avif", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".webm": "video/webm", ".pdf": "application/pdf", ".ico": "image/x-icon" };
const mimeOf = (f: string) => MIME[extname(f).toLowerCase()] ?? "application/octet-stream";
const mediaKey = (m: MediaRef) => (m.wpId ? `wp:${m.wpId}` : `url:${m.url}`);

const COLLECTION: Record<IrPage["kind"], string> = { page: "pages", post: "pages", partial: "site_parts", popup: "popups" };

/** Start `pnpm dev` in the project when nothing listens yet; returns a stop function. */
async function ensureDevServer(project: string, port: number, log: (m: string) => void): Promise<() => void> {
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

export async function runLoad({ config, paths, reporter }: PhaseContext): Promise<GateCheck[]> {
	const checks: GateCheck[] = [];
	const check = (id: string, label: string, ok: boolean, detail?: string) => checks.push({ id, label, ok, ...(detail ? { detail } : {}) });
	const target = (process.env.WP2EMDASH_LOAD_TARGET ?? "local") as "local" | "staging";
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
	if (target === "staging") {
		if (!config.target.stagingUrl || !env.EMDASH_TOKEN) {
			check("target", "Staging target configured", false, "Set target.stagingUrl in kit.config.ts and EMDASH_TOKEN (an EmDash API token) in .env");
			return checks;
		}
		api = new EmDashApi(config.target.stagingUrl, { token: env.EMDASH_TOKEN });
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
		// ── Schema on the target ─────────────────────────────────────────────────
		try {
			const [bt, cols] = await Promise.all([api.blockTypes(), api.collections()]);
			const missing = [...BLOCK_TYPES.map((b) => b.slug).filter((s) => !bt.some((x) => x.slug === s)), ...["pages", "site_parts", "popups"].filter((c) => !cols.some((x) => x.slug === c))];
			check("target", `Target reachable and authenticated (${target})`, true, api.baseUrl);
			check("schema", "Section library and collections present on the target", missing.length === 0, missing.join(", ") || `${bt.length} block types`);
			if (missing.length) return checks;
		} catch (e) {
			check("target", `Target reachable and authenticated (${target})`, false, (e as Error).message);
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

		// ── Media ────────────────────────────────────────────────────────────────
		const refs = new Map<string, MediaRef>();
		const collect = (v: unknown) => {
			if (!v || typeof v !== "object") return;
			if (Array.isArray(v)) return v.forEach(collect);
			const o = v as Record<string, unknown>;
			if (("wpId" in o || "url" in o) && (o.kind === "image" || o.kind === "video" || o.kind === "file")) refs.set(mediaKey(o as MediaRef), o as MediaRef);
			else for (const x of Object.values(o)) collect(x);
		};
		for (const d of docs) collect([d.sections, d.featuredImage]);

		reporter.emit({ type: "step:start", step: "Media", total: refs.size });
		const existing = await api.mediaList();
		const bySha = new Map(existing.filter((m) => m.contentHash).map((m) => [String(m.contentHash).replace(/^sha1:/, ""), m]));
		const existingIds = new Set(existing.map((m) => m.id));
		let uploaded = 0;
		let reused = 0;
		const mediaErrors: string[] = [];
		let n = 0;
		for (const [key, ref] of refs) {
			reporter.emit({ type: "step:progress", step: "Media", done: ++n, total: refs.size, item: key });
			const known = idMap.media[key];
			if (known && existingIds.has(known.id)) continue;
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
				const sha1 = createHash("sha1").update(bytes).digest("hex");
				let item: MediaItem | undefined = bySha.get(sha1);
				if (item) reused++;
				else {
					item = await api.mediaUpload(bytes, filename, mimeOf(filename), ref.alt);
					bySha.set(sha1, item);
					uploaded++;
				}
				idMap.media[key] = { id: item.id, sha1, mime: item.mimeType ?? mimeOf(filename), ...(item.url ? { url: item.url } : {}) };
			} catch (e) {
				mediaErrors.push(`${key}: ${(e as Error).message}`);
			}
		}
		saveMap();
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

		// ── Content ──────────────────────────────────────────────────────────────
		reporter.emit({ type: "step:start", step: "Content", total: docs.length });
		const existingByCollection = new Map<string, Awaited<ReturnType<typeof api.list>>>();
		for (const c of ["pages", "site_parts", "popups"]) existingByCollection.set(c, await api.list(c));
		const contentErrors: string[] = [];
		const drops: string[] = [];
		let created = 0;
		let updated = 0;
		let adopted = 0;
		const sep = /\s([-–—|·•])\s/.exec(docs.find((d) => d.route?.isFrontPage)?.seo.title ?? "")?.[1] ?? "-";
		for (const [i, doc] of docs.entries()) {
			const collection = COLLECTION[doc.kind];
			const slug = doc.kind === "page" || doc.kind === "post" ? routeToSlug(doc.route?.path ?? doc.source.slug) : doc.source.slug;
			const key = `${doc.source.type}:${doc.source.wpId}`;
			reporter.emit({ type: "step:progress", step: "Content", done: i + 1, total: docs.length, item: `${collection}/${slug}` });
			try {
				const sections = fixLinks(doc.sections) as Section[];
				const content = sections.map((s, j) => sectionToBlock(s, `${doc.source.slug}-${j}`, resolver, (d) => drops.push(`${slug} ${s.type}#${j}: ${d.join(", ")}`)));
				const data: Record<string, unknown> = { title: doc.title, content };
				if (doc.kind === "popup") {
					const sel = doc.popup?.selectors.filter((s) => !s.includes("popmake")).join(", ");
					if (sel) data.selectors = sel;
					if (doc.popup?.autoOpen) data.auto_open_delay = doc.popup.autoOpen.delayMs;
				}
				const seoTitle = doc.seo.title?.replace(new RegExp(`\\s*[${sep}]\\s*${site.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`), "").trim();
				const seo = doc.kind === "page" || doc.kind === "post" ? { ...(seoTitle ? { title: seoTitle } : {}), ...(doc.seo.description ? { description: doc.seo.description.slice(0, 500) } : {}), ...(doc.seo.canonical && /^https?:/.test(doc.seo.canonical) ? { canonical: doc.seo.canonical } : {}), ...(/noindex/i.test(doc.seo.robots ?? "") ? { noIndex: true } : {}) } : undefined;

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
				if (entryId) {
					const cur = await api.get(collection, entryId);
					await api.update(collection, entryId, { data, slug, ...(seo ? { seo } : {}), ...(cur._rev ? { _rev: cur._rev } : {}) });
					updated++;
				} else {
					const item = await api.create(collection, { data, slug, ...(seo ? { seo } : {}) });
					entryId = item.id;
					created++;
				}
				idMap.content[key] = { collection, id: entryId, slug };
				saveMap();
				const shouldPublish = doc.source.status === "publish";
				if (shouldPublish) await api.publish(collection, entryId);
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
						const created = await api.createMenuItem(role, { type: "custom", label: it.label, customUrl: it.opensPopup ? `#${it.opensPopup}` : fixHref(it.href), sortOrder: i, ...(it.newTab ? { target: "_blank" } : {}), ...(it.opensPopup ? { cssClasses: `popup-${it.opensPopup}` } : {}), ...(parentId ? { parentId } : {}) });
						if (it.children.length) await add(it.children, created.id);
					}
				};
				await add(m.items);
			} catch (e) {
				menuErrors.push(`${role}: ${(e as Error).message}`);
			}
		}
		try {
			await api.updateSettings({ title: site.title, ...(site.tagline ? { tagline: site.tagline } : {}), /* noindex until cutover */ staging: true, seo: { titleSeparator: sep } });
		} catch (e) {
			menuErrors.push(`settings: ${(e as Error).message}`);
		}
		check("menus", "Menus and site settings written", menuErrors.length === 0, menuErrors.join("; ") || site.menus.map((m) => `${m.role} ${m.items.length}`).join(", "));

		if (overrides.redirects.source === "file") check("redirects", "Redirects imported", false, "raw/redirects.csv import is not implemented yet");

		// ── Verify on the target ───────────────────────────────────────────────────
		reporter.emit({ type: "step:start", step: "Verify target" });
		const leftovers: string[] = [];
		const missingMedia: string[] = [];
		const mediaIds = new Set((await api.mediaList()).map((m) => m.id));
		const counts: string[] = [];
		const dupes: string[] = [];
		for (const c of ["pages", "site_parts", "popups"]) {
			const items = await api.list(c);
			const expected = docs.filter((d) => COLLECTION[d.kind] === c).length;
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
		check("counts", "Entry counts on the target equal the IR, no duplicate slugs", counts.length === 0 && dupes.length === 0, [...counts, ...dupes.map((d) => `duplicate ${d}`)].join("; ") || undefined);
		check("no-wordpress-leftovers", "No WordPress links, upload URLs or shortcodes in stored content", leftovers.length === 0, [...new Set(leftovers)].slice(0, 8).join("; ") || undefined);
		check("media-integrity", "Every media id in stored content exists on the target", missingMedia.length === 0, missingMedia.slice(0, 5).join("; ") || undefined);
		const idMapComplete = docs.every((d) => idMap.content[`${d.source.type}:${d.source.wpId}`]);
		check("id-map", "id-map covers every document", idMapComplete, `load/id-map.${target}.json`);

		// Every published page renders and shows its first heading.
		const renderFails: string[] = [];
		for (const d of docs.filter((x) => x.kind === "page" && x.source.status === "publish")) {
			const path = d.route?.path ?? "/";
			try {
				const r = await fetch(`${api.baseUrl}${path}`, { redirect: "manual" });
				const html = await r.text();
				const firstHeading = d.sections.flatMap((s) => (Array.isArray((s.fields as { heading?: unknown }).heading) ? ((s.fields as { heading: { children: { text: string }[] }[] }).heading) : [])).flatMap((b) => b.children.map((c) => c.text))[0];
				if (r.status !== 200) renderFails.push(`${path} HTTP ${r.status}`);
				else if (firstHeading && !html.includes(firstHeading.replace(/&/g, "&amp;").slice(0, 30)) && !html.includes(firstHeading.slice(0, 30))) renderFails.push(`${path}: "${firstHeading.slice(0, 30)}" not in HTML`);
			} catch (e) {
				renderFails.push(`${path}: ${(e as Error).message}`);
			}
		}
		reporter.emit({ type: "step:end", step: "Verify target", ok: renderFails.length === 0 });
		check("render", "Every published page renders on the target", renderFails.length === 0, renderFails.slice(0, 6).join("; ") || `${docs.filter((x) => x.kind === "page" && x.source.status === "publish").length} pages`);
		return checks;
	}
}
