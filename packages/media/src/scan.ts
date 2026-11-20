/**
 * Media health: what the library holds and where each file is used.
 *
 * Usage is a READ-ONLY scan of the site's D1 database through the Worker's binding (SELECT only), not EmDash's media
 * usage index: that index (migrations 046–094, `_emdash_media_usage*`) covers content entries only, is internal
 * (generations, overlays, reconciliation) and has no plugin API — its REST route needs a signed-in user. The scan reads
 * content (`ec_*`, trashed entries included), settings, menus, widgets, sections, SEO rows, bylines, taxonomies, plugin
 * storage, other plugins' settings and page history, and counts ANY mention of a media id or storage key as a use.
 * Conservative on purpose: a file is "unused" only when nothing in the database names it, and when the scan could not
 * read everything (row cap) nothing is called unused.
 *
 * Everything below `readLibrary`/`readSources` is pure and unit-tested.
 */
import { DEFAULT_LIMITS, type MediaLimits } from "./index.js";
import { MEDIA_PLUGIN } from "./meta.js";

export interface D1Stmt {
	bind(...values: unknown[]): D1Stmt;
	all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}
export interface D1Db {
	prepare(query: string): D1Stmt;
}

export interface MediaRow {
	id: string;
	filename: string;
	mimeType: string;
	size: number | null;
	width: number | null;
	height: number | null;
	alt: string | null;
	storageKey: string;
	contentHash: string | null;
	folderId: string | null;
	createdAt: string;
	focalX?: number | null;
	focalY?: number | null;
}

export type RefKind = "content" | "trashed" | "settings" | "menu" | "widget" | "section" | "seo" | "byline" | "taxonomy" | "plugin" | "revision" | "other";

export interface Ref {
	kind: RefKind;
	/** What a person reads: "Page: About us", "Site settings (logo)", "Menu", … */
	label: string;
	collection?: string;
	entryId?: string;
	/** The nearest section heading, for alt text suggestions (content only). */
	heading?: string;
}

/** A reference to a media file that no longer exists. */
export interface BrokenRef extends Ref {
	/** The missing media id or storage key. */
	missing: string;
}

export interface SourceTable {
	name: string;
	rows: Record<string, unknown>[];
}

const ULID = /[0-9A-HJKMNP-TV-Z]{26}/g;
const ULID_ONLY = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const FILE_URL = /\/_emdash\/api\/media\/(?:file\/([^"'\s)?#\\]+)|asset\/([0-9A-HJKMNP-TV-Z]{26})\/)/g;

/** Tables never read: the media library itself, EmDash's internal usage index, auth, people, logs, queues, transfer. */
const SKIP = [/^media$/, /^media_folders$/, /^_emdash_media_/, /^sqlite_/, /^_cf_/, /^d1_/, /^users$/, /^credentials$/, /^auth_/, /^oauth_/, /^allowed_domains$/, /^audit_logs$/, /^_emdash_migrations$/, /^_emdash_(api|oauth)_tokens$/, /^_emdash_(device|authorization)_codes$/, /^_emdash_oauth_clients$/, /^_emdash_rate_limits$/, /^_emdash_rooms?/, /^_emdash_room_updates$/, /^_emdash_transfer_/, /^_emdash_cron_tasks$/, /^_emdash_entry_locks$/, /^_emdash_redirect/, /^_emdash_revision_prune_queue$/, /^_emdash_comment/, /^_plugin_(state|indexes)$/, /^_emdash_collections$/, /^_emdash_fields$/, /^_emdash_byline_fields$/, /^_emdash_taxonomy_def/, /^content_taxonomies$/, /^_emdash_relations$/, /^_emdash_content_references$/, /^_emdash_menus$/, /^_emdash_block_type/];

export function tableKind(name: string): RefKind | undefined {
	if (SKIP.some((r) => r.test(name))) return undefined;
	if (name.startsWith("ec_")) return "content";
	if (name === "options") return "settings";
	if (name === "_emdash_menu_items") return "menu";
	if (name.startsWith("_emdash_widget")) return "widget";
	if (name === "_emdash_sections") return "section";
	if (name === "_emdash_seo") return "seo";
	if (name.startsWith("_emdash_byline")) return "byline";
	if (name === "taxonomies") return "taxonomy";
	if (name === "_plugin_storage") return "plugin";
	if (name === "revisions") return "revision";
	return "other";
}

const KIND_LABEL: Record<RefKind, string> = { content: "Page", trashed: "Entry in the trash", settings: "Site settings", menu: "Menu", widget: "Widget", section: "Saved section", seo: "SEO settings", byline: "Author profile", taxonomy: "Category or tag", plugin: "Plugin data", revision: "An older version of a page", other: "Other site data" };

const titleCase = (s: string) => s.replace(/[_-]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());

function refOf(table: string, kind: RefKind, row: Record<string, unknown>): Ref {
	if (kind === "content") {
		const collection = table.slice(3);
		const title = String(row.title ?? row.name ?? row.slug ?? row.id ?? "").slice(0, 120);
		const trashed = !!row.deleted_at;
		const singular = titleCase(collection.replace(/s$/, ""));
		return { kind: trashed ? "trashed" : "content", label: `${trashed ? `${KIND_LABEL.trashed} — ` : ""}${singular}: ${title || "(untitled)"}${row.status && row.status !== "published" && !trashed ? ` (${String(row.status)})` : ""}`, collection, ...(typeof row.id === "string" ? { entryId: row.id } : {}) };
	}
	if (kind === "settings") {
		const name = String(row.name ?? "");
		if (name.startsWith("plugin:")) return { kind: "plugin", label: `Plugin settings (${name.split(":")[1] ?? "plugin"})` };
		return { kind: "settings", label: `Site settings (${name.replace(/^site:/, "") || "settings"})` };
	}
	if (kind === "menu") return { kind, label: `Menu item${row.label ? `: ${String(row.label).slice(0, 60)}` : ""}` };
	if (kind === "revision") return { kind, label: KIND_LABEL.revision, ...(typeof row.collection === "string" ? { collection: row.collection } : {}), ...(typeof row.entry_id === "string" ? { entryId: row.entry_id } : {}) };
	return { kind, label: `${KIND_LABEL[kind]}${kind === "other" ? ` (${table})` : ""}` };
}

/** Parses JSON-looking strings (EmDash keeps field values as JSON text in D1). */
function parsed(v: unknown): unknown {
	if (typeof v !== "string") return v;
	const t = v.trim();
	if (!(t.startsWith("{") || t.startsWith("["))) return v;
	try {
		return JSON.parse(t);
	} catch {
		return v;
	}
}

/** A media reference object as EmDash's image/file fields store it: `{ id, provider?, src?, mimeType?, … }`. */
function isMediaObject(o: Record<string, unknown>): boolean {
	if (typeof o.id !== "string" || !ULID_ONLY.test(o.id)) return false;
	if ("provider" in o) return o.provider === undefined || o.provider === null || o.provider === "local";
	return typeof o.mimeType === "string" && /^(image|video|audio)\/|^application\/pdf$/.test(o.mimeType) && ("src" in o || "url" in o || "filename" in o);
}

const isPortableBlock = (o: Record<string, unknown>) => o._type === "block";
const blockText = (o: Record<string, unknown>) => (Array.isArray(o.children) ? (o.children as { text?: unknown }[]).map((c) => (typeof c.text === "string" ? c.text : "")).join("") : "");

interface Found {
	ids: Set<string>;
	keys: Set<string>;
	/** Structured media objects and file URLs (for broken references), with the heading above them. */
	structured: { id?: string; key?: string; heading?: string }[];
}

/** Every media id / storage key mentioned in a value, plus structured references with the nearest heading. Pure. */
export function mentions(value: unknown): Found {
	const out: Found = { ids: new Set(), keys: new Set(), structured: [] };
	let heading: string | undefined;
	const walk = (v: unknown): void => {
		v = parsed(v);
		if (typeof v === "string") {
			for (const m of v.match(ULID) ?? []) out.ids.add(m);
			for (const m of v.matchAll(FILE_URL)) {
				if (m[1]) {
					const key = decodeURIComponent(m[1]);
					out.keys.add(key);
					out.structured.push({ key, ...(heading ? { heading } : {}) });
				} else if (m[2]) out.structured.push({ id: m[2], ...(heading ? { heading } : {}) });
			}
			return;
		}
		if (Array.isArray(v)) return v.forEach(walk);
		if (!v || typeof v !== "object") return;
		const o = v as Record<string, unknown>;
		if (isPortableBlock(o) && /^h[1-6]$/.test(String(o.style ?? ""))) heading = blockText(o).trim().slice(0, 120) || heading;
		else if (typeof o.heading === "string" && o.heading.trim()) heading = o.heading.trim().slice(0, 120);
		if (isMediaObject(o)) out.structured.push({ id: o.id as string, ...(heading ? { heading } : {}) });
		for (const x of Object.values(o)) walk(x);
	};
	walk(value);
	return out;
}

export interface Usage {
	/** Uses per media id. */
	refs: Map<string, Ref[]>;
	broken: BrokenRef[];
	/** Every source table was read completely (no row cap hit). */
	complete: boolean;
}

/** Where each media file is used, and references to files that no longer exist. Pure. */
export function collectUsage(media: MediaRow[], tables: SourceTable[], complete = true): Usage {
	const ids = new Set(media.map((m) => m.id));
	const byKey = new Map(media.map((m) => [m.storageKey, m.id]));
	// Storage keys are "<ulid>.<ext>": the ulid alone also identifies the file.
	const byKeyUlid = new Map(media.map((m) => [m.storageKey.split(".")[0] as string, m.id]));
	const refs = new Map<string, Ref[]>();
	const broken: BrokenRef[] = [];
	const add = (id: string, r: Ref) => {
		const list = refs.get(id) ?? [];
		if (!list.some((x) => x.label === r.label && x.entryId === r.entryId)) list.push(r);
		refs.set(id, list);
	};
	for (const t of tables) {
		const kind = tableKind(t.name);
		if (!kind) continue;
		for (const row of t.rows) {
			// Our own KV rows name media ids (trash ledger, suggestions): never a use.
			if (t.name === "options" && String(row.name ?? "").startsWith(`plugin:${MEDIA_PLUGIN.id}:`)) continue;
			const f = mentions(row);
			if (!f.ids.size && !f.keys.size) continue;
			const base = refOf(t.name, kind, row);
			const headingOf = new Map<string, string>();
			for (const s of f.structured) {
				const id = s.id ?? (s.key ? (byKey.get(s.key) ?? byKeyUlid.get(s.key.split(".")[0] as string)) : undefined);
				if (id && s.heading && !headingOf.has(id)) headingOf.set(id, s.heading);
			}
			for (const id of f.ids) {
				const mid = ids.has(id) ? id : byKeyUlid.get(id);
				if (mid) add(mid, { ...base, ...(headingOf.get(mid) ? { heading: headingOf.get(mid) } : {}) });
			}
			for (const key of f.keys) {
				const mid = byKey.get(key) ?? byKeyUlid.get(key.split(".")[0] as string);
				if (mid) add(mid, base);
			}
			// Broken: structured references (image fields, file URLs) whose file is gone. Live content and settings only.
			if (kind === "revision" || base.kind === "trashed") continue;
			for (const s of f.structured) {
				const exists = s.id ? ids.has(s.id) || byKeyUlid.has(s.id) : s.key ? byKey.has(s.key) || byKeyUlid.has(s.key.split(".")[0] as string) : true;
				const missing = (s.id ?? s.key) as string;
				if (!exists && !broken.some((b) => b.missing === missing && b.label === base.label)) broken.push({ ...base, missing });
			}
		}
	}
	return { refs, broken, complete };
}

// ─── Analysis ────────────────────────────────────────────────────────────────

export type FileType = "image" | "video" | "audio" | "document" | "other";
export const typeOf = (mime: string): FileType => (mime.startsWith("image/") ? "image" : mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : mime === "application/pdf" ? "document" : "other");

/** Folder name of the media trash (EmDash media folders, migration 072). */
export const TRASH_FOLDER = "Trash (Media Assistant)";

/** File names that look like brand files: never offered for the trash (on top of anything settings name). */
export const BRAND = /(?:^|[^a-z])(logo|logotype|favicon|brand|icon|apple-touch|wordmark|og-default|social-card)(?:[^a-z]|$)/i;

export interface Item {
	m: MediaRow;
	refs: Ref[];
}
export interface Oversized extends Item {
	reasons: string[];
}
export interface FormatIssue extends Item {
	issue: "png-photo" | "svg" | "legacy" | "big-gif";
	text: string;
}
export interface Unused extends Item {
	/** Only older versions of pages name it. */
	historyOnly: boolean;
	protected?: string;
}

export interface Report {
	at: string;
	complete: boolean;
	totals: { files: number; bytes: number; byType: Record<FileType, { files: number; bytes: number }> };
	oversized: Oversized[];
	missingAlt: Item[];
	unused: Unused[];
	duplicates: { hash: string; items: Item[] }[];
	formats: FormatIssue[];
	broken: BrokenRef[];
	/** Files in the trash folder (shown in Trash, left out of the other lists). */
	trashed: string[];
	/** Files in the trash folder that something on the site names again. */
	trashedInUse: string[];
	/** Where each file is used (first 10 places per file). */
	uses: Record<string, Ref[]>;
}

const LIVE: RefKind[] = ["content", "settings", "menu", "widget", "section", "seo", "byline", "taxonomy", "plugin", "other", "trashed"];
export const isUsed = (refs: Ref[]) => refs.some((r) => LIVE.includes(r.kind));

export const kb = (n: number | null | undefined) => (n === null || n === undefined ? "?" : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

/** The media health report. Pure. */
export function analyse(media: MediaRow[], usage: Usage, o: { limits?: MediaLimits; trashFolderId?: string | null; protect?: string[]; now?: number } = {}): Report {
	const L = o.limits ?? DEFAULT_LIMITS;
	const now = o.now ?? Date.now();
	const byType: Report["totals"]["byType"] = { image: { files: 0, bytes: 0 }, video: { files: 0, bytes: 0 }, audio: { files: 0, bytes: 0 }, document: { files: 0, bytes: 0 }, other: { files: 0, bytes: 0 } };
	const protect = (o.protect ?? []).map((p) => new RegExp(p, "i"));
	const trashed = media.filter((m) => o.trashFolderId && m.folderId === o.trashFolderId).map((m) => m.id);
	const live = media.filter((m) => !trashed.includes(m.id));
	const r: Report = { at: new Date(now).toISOString(), complete: usage.complete, totals: { files: media.length, bytes: 0, byType }, oversized: [], missingAlt: [], unused: [], duplicates: [], formats: [], broken: usage.broken, trashed, trashedInUse: trashed.filter((id) => isUsed(usage.refs.get(id) ?? [])), uses: Object.fromEntries([...usage.refs.entries()].map(([id, refs]) => [id, refs.slice(0, 10)])) };
	for (const m of media) {
		const t = typeOf(m.mimeType);
		byType[t].files++;
		byType[t].bytes += m.size ?? 0;
		r.totals.bytes += m.size ?? 0;
	}
	const hashes = new Map<string, Item[]>();
	for (const m of live) {
		const refs = usage.refs.get(m.id) ?? [];
		const it: Item = { m, refs };
		const t = typeOf(m.mimeType);
		const svg = m.mimeType === "image/svg+xml";
		// Oversized originals.
		const reasons: string[] = [];
		if (t === "image" && !svg) {
			const side = Math.max(m.width ?? 0, m.height ?? 0);
			if (side > L.maxDimension) reasons.push(`${m.width}×${m.height} px (more than ${L.maxDimension} px)`);
			if ((m.size ?? 0) > L.maxImageBytes) reasons.push(`${kb(m.size)} (more than ${kb(L.maxImageBytes)})`);
		}
		if (t === "video" && (m.size ?? 0) > L.maxVideoBytes) reasons.push(`${kb(m.size)} (more than ${kb(L.maxVideoBytes)})`);
		if (reasons.length) r.oversized.push({ ...it, reasons });
		// Alt text (images only: videos and files have none).
		if (t === "image" && !m.alt?.trim()) r.missingAlt.push(it);
		// Formats.
		if (svg) r.formats.push({ ...it, issue: "svg", text: "SVG: EmDash does not accept SVG uploads (an SVG can carry scripts). Replace it with PNG or WebP, or put the drawing in the theme." });
		else if (m.mimeType === "image/png" && (m.size ?? 0) > 300 * 1024 && Math.max(m.width ?? 0, m.height ?? 0) >= 1000) r.formats.push({ ...it, issue: "png-photo", text: "A large PNG, probably a photo: as JPEG or WebP it would be a fraction of the size. Optimize resizes it in place; for a new format upload a JPEG/WebP and swap it on the pages." });
		else if (/^image\/(bmp|tiff|heic|heif|x-icon|vnd\.microsoft\.icon)$/.test(m.mimeType)) r.formats.push({ ...it, issue: "legacy", text: `${m.mimeType.slice(6).toUpperCase()}: not shown by every browser. Upload it again as JPEG or WebP.` });
		else if (m.mimeType === "image/gif" && (m.size ?? 0) > 2 * 1024 * 1024) r.formats.push({ ...it, issue: "big-gif", text: "A large GIF: a short MP4 or WebM video is usually ten times smaller." });
		// Unused: nothing names it, not brand, not uploaded in the last day (someone may be about to use it).
		if (!isUsed(refs)) {
			const recent = now - Date.parse(m.createdAt) < 24 * 3600_000;
			const isProtected = BRAND.test(m.filename) ? "Looks like a brand file (logo, icon)." : protect.some((p) => p.test(m.filename)) ? "Protected in kit.config (media.protect)." : recent ? "Uploaded in the last 24 hours." : undefined;
			if (usage.complete) r.unused.push({ ...it, historyOnly: refs.some((x) => x.kind === "revision"), ...(isProtected ? { protected: isProtected } : {}) });
		}
		if (m.contentHash) hashes.set(m.contentHash, [...(hashes.get(m.contentHash) ?? []), it]);
	}
	r.duplicates = [...hashes.entries()].filter(([, items]) => items.length > 1).map(([hash, items]) => ({ hash, items }));
	// Most useful first.
	r.oversized.sort((a, b) => (b.m.size ?? 0) - (a.m.size ?? 0));
	r.missingAlt.sort((a, b) => Number(isUsed(b.refs)) - Number(isUsed(a.refs)) || b.refs.length - a.refs.length);
	r.unused.sort((a, b) => (b.m.size ?? 0) - (a.m.size ?? 0));
	return r;
}

/** Whether a file may be moved to the trash right now: unused, not protected, not already there. Pure. */
export function trashable(r: Report, id: string): { ok: true } | { ok: false; reason: string } {
	if (!r.complete) return { ok: false, reason: "the usage scan was incomplete" };
	if (r.trashed.includes(id)) return { ok: false, reason: "already in the trash" };
	const u = r.unused.find((x) => x.m.id === id);
	if (!u) return { ok: false, reason: "it is used on the site" };
	if (u.protected) return { ok: false, reason: u.protected.replace(/\.$/, "").toLowerCase() };
	return { ok: true };
}

// ─── Reading D1 (read-only) ───────────────────────────────────────────────────

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;
const PAGE = 500;
/** Rows read across all source tables per scan; beyond it the scan is incomplete and nothing is called unused. */
export const MAX_ROWS = 40_000;

export async function readLibrary(db: D1Db): Promise<MediaRow[]> {
	const out: MediaRow[] = [];
	for (let offset = 0; ; offset += PAGE) {
		const rows = (await db.prepare("SELECT id, filename, mime_type, size, width, height, alt, storage_key, content_hash, folder_id, created_at, focal_x, focal_y FROM media WHERE status = 'ready' ORDER BY id LIMIT ? OFFSET ?").bind(PAGE, offset).all<Record<string, unknown>>()).results;
		for (const r of rows) out.push({ id: String(r.id), filename: String(r.filename ?? ""), mimeType: String(r.mime_type ?? ""), size: r.size === null ? null : Number(r.size), width: r.width === null ? null : Number(r.width), height: r.height === null ? null : Number(r.height), alt: (r.alt as string | null) ?? null, storageKey: String(r.storage_key ?? ""), contentHash: (r.content_hash as string | null) ?? null, folderId: (r.folder_id as string | null) ?? null, createdAt: String(r.created_at ?? ""), focalX: (r.focal_x as number | null) ?? null, focalY: (r.focal_y as number | null) ?? null });
		if (rows.length < PAGE) break;
	}
	return out;
}

export async function folderIdByName(db: D1Db, name: string): Promise<string | null> {
	const r = (await db.prepare("SELECT id FROM media_folders WHERE name = ? LIMIT 1").bind(name).all<{ id: string }>()).results[0];
	return r?.id ?? null;
}

export async function readSources(db: D1Db, maxRows = MAX_ROWS): Promise<{ tables: SourceTable[]; complete: boolean }> {
	const names = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all<{ name: string }>()).results.map((x) => x.name).filter((n) => tableKind(n));
	// Revisions last: they only matter when everything else fit.
	names.sort((a, b) => Number(a === "revisions") - Number(b === "revisions"));
	const tables: SourceTable[] = [];
	let read = 0;
	let complete = true;
	for (const name of names) {
		const rows: Record<string, unknown>[] = [];
		const where = name === "options" ? ` WHERE name NOT LIKE 'plugin:${MEDIA_PLUGIN.id}:%'` : "";
		for (let offset = 0; ; offset += PAGE) {
			if (read >= maxRows) {
				complete = false;
				break;
			}
			const page = (await db.prepare(`SELECT * FROM ${quote(name)}${where} LIMIT ? OFFSET ?`).bind(PAGE, offset).all<Record<string, unknown>>()).results;
			rows.push(...page);
			read += page.length;
			if (page.length < PAGE) break;
		}
		tables.push({ name, rows });
		if (!complete) break;
	}
	return { tables, complete };
}

/** One full scan: library + usage + report. */
export async function scan(db: D1Db, o: { limits?: MediaLimits; protect?: string[]; now?: number } = {}): Promise<{ media: MediaRow[]; report: Report }> {
	const [media, sources, trashFolderId] = await Promise.all([readLibrary(db), readSources(db), folderIdByName(db, TRASH_FOLDER)]);
	const usage = collectUsage(media, sources.tables, sources.complete);
	return { media, report: analyse(media, usage, { ...o, trashFolderId }) };
}

/** What Site health and the widget read: counts only. */
export interface Summary {
	at: string;
	files: number;
	bytes: number;
	missingAlt: number;
	/** Images without alt text that pages use. */
	missingAltUsed: number;
	oversized: number;
	unused: number;
	duplicates: number;
	broken: number;
	formats: number;
	complete: boolean;
}

export function summaryOf(r: Report): Summary {
	return { at: r.at, files: r.totals.files, bytes: r.totals.bytes, missingAlt: r.missingAlt.length, missingAltUsed: r.missingAlt.filter((x) => isUsed(x.refs)).length, oversized: r.oversized.length, unused: r.unused.filter((u) => !u.protected).length, duplicates: r.duplicates.length, broken: r.broken.length, formats: r.formats.length, complete: r.complete };
}
