/**
 * Making a backup: a READ-ONLY dump of the site's D1 database through the Worker's D1 binding (SELECT and PRAGMA only),
 * filtered by format.ts's allowlist, plus a manifest of the media files in the R2 bucket (keys, sizes, ETags — the
 * files themselves are not copied: they already live in R2, and EmDash's load and uploads never overwrite a key).
 *
 * Why not EmDash's own backup? EmDash 1.5 has one (Settings → Backups, `backups/emdash-backup-*.json`), but its
 * generator is internal (not exported to plugins), keeps at most 30 copies, leaves out redirects, bylines and
 * relations, and has no restore. Site transfer (`emdash site export/import`) needs the CLI and imports only into an
 * EMPTY site. Rows are read the way EmDash's snapshot reads them (rowid-ordered pages), with the same options rule.
 */
import { type BackupCounts, type BackupDoc, classifyTable, FORMAT, FORMAT_VERSION, type MediaObject, OPTION_KEYS, optionAllowed, PLUGIN_DATA_PREFIXES, type Trigger } from "./format.js";

export interface D1Stmt {
	bind(...values: unknown[]): D1Stmt;
	all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
}
export interface D1Db {
	prepare(query: string): D1Stmt;
	/** D1 Sessions API (workers-types): its bookmark names a point in the database's history. */
	withSession?(constraint?: string): { prepare(query: string): D1Stmt; getBookmark(): string | null };
}

export interface R2ObjectLike {
	key: string;
	size: number;
	etag: string;
	uploaded: Date;
	customMetadata?: Record<string, string>;
}
export interface R2Like {
	put(key: string, value: Uint8Array | string, o?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
	get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; customMetadata?: Record<string, string> } | null>;
	head?(key: string): Promise<{ size: number } | null>;
	delete(keys: string | string[]): Promise<void>;
	list(o?: { prefix?: string; cursor?: string; limit?: number; include?: ("customMetadata" | "httpMetadata")[] }): Promise<{ objects: R2ObjectLike[]; truncated: boolean; cursor?: string }>;
}

const PAGE_ROWS = 500;
/** Media manifest cap: a marketing site holds a few thousand files at most. */
export const MAX_MEDIA_OBJECTS = 50_000;
/** Bucket prefixes that are not media: backups (ours and EmDash's) and site-transfer staging. */
export const NOT_MEDIA = ["backups/", "transfers/"];

const quote = (name: string) => `"${name.replace(/"/g, '""')}"`;

export async function listTables(db: D1Db | { prepare: D1Db["prepare"] }): Promise<string[]> {
	const r = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all<{ name: string }>();
	return r.results.map((x) => x.name);
}

async function columnsOf(db: { prepare: D1Db["prepare"] }, table: string): Promise<string[]> {
	try {
		return (await db.prepare(`PRAGMA table_info(${quote(table)})`).all<{ name: string }>()).results.map((c) => c.name);
	} catch {
		return [];
	}
}

/** Every row of a table, in rowid pages (D1 caps a result at 50 MB); tables without rowid are read at once. */
export async function readRows(db: { prepare: D1Db["prepare"] }, table: string, where = "1 = 1", binds: unknown[] = []): Promise<Record<string, unknown>[]> {
	const rows: Record<string, unknown>[] = [];
	let after: number | null = null;
	for (;;) {
		let page: Record<string, unknown>[];
		try {
			const sql = `SELECT rowid AS __bk_rowid, * FROM ${quote(table)} WHERE (${where})${after === null ? "" : " AND rowid > ?"} ORDER BY rowid LIMIT ${PAGE_ROWS}`;
			page = (await db.prepare(sql).bind(...binds, ...(after === null ? [] : [after])).all()).results;
		} catch (e) {
			if (after === null && /rowid/i.test((e as Error)?.message ?? "")) return (await db.prepare(`SELECT * FROM ${quote(table)} WHERE (${where})`).bind(...binds).all()).results;
			throw e;
		}
		for (const r of page) {
			after = Number(r.__bk_rowid);
			delete r.__bk_rowid;
			rows.push(r);
		}
		if (page.length < PAGE_ROWS) return rows;
	}
}

/** The options rows a backup may hold (site settings and allowed plugin data; filtered in SQL, then again in code). */
export async function readSettingsRows(db: { prepare: D1Db["prepare"] }): Promise<Record<string, unknown>[]> {
	const plugin = Object.keys(PLUGIN_DATA_PREFIXES);
	const rows = await readRows(db, "options", `name LIKE 'site:%' OR name IN (${OPTION_KEYS.map(() => "?").join(", ")})${plugin.map(() => " OR substr(name, 1, ?) = ?").join("")}`, [...OPTION_KEYS, ...plugin.flatMap((p) => [p.length, p])]);
	return rows.filter((r) => optionAllowed(String(r.name ?? ""), r.value));
}

/** The bucket's media files (not backups, not transfer staging). */
export async function mediaManifest(bucket: R2Like): Promise<{ objects: MediaObject[]; truncated: boolean }> {
	const objects: MediaObject[] = [];
	let cursor: string | undefined;
	for (;;) {
		const page = await bucket.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
		for (const o of page.objects) {
			if (NOT_MEDIA.some((p) => o.key.startsWith(p))) continue;
			objects.push({ key: o.key, size: o.size, etag: o.etag, uploaded: new Date(o.uploaded).toISOString() });
			if (objects.length >= MAX_MEDIA_OBJECTS) return { objects, truncated: true };
		}
		if (!page.truncated || !page.cursor) return { objects, truncated: false };
		cursor = page.cursor;
	}
}

export function countsOf(tables: BackupDoc["tables"], mediaFiles: number): BackupCounts {
	const n = (t: string) => tables[t]?.rows.length ?? 0;
	const entries: Record<string, number> = {};
	for (const [t, v] of Object.entries(tables)) if (t.startsWith("ec_")) entries[t.slice(3)] = v.rows.length;
	return { entries, menus: n("_emdash_menus"), menuItems: n("_emdash_menu_items"), redirects: n("_emdash_redirects"), media: n("media"), mediaFiles, settings: (tables.options?.rows ?? []).filter((r) => String(r.name).startsWith("site:")).length, sections: n("_emdash_sections"), taxonomies: n("taxonomies"), revisions: n("revisions") };
}

export interface ExportInput {
	db: D1Db;
	bucket: R2Like;
	id: string;
	trigger: Trigger;
	now: number;
	site: { name: string; url: string };
	database?: string;
}

/** Builds the backup document (read-only). */
export async function exportSite(i: ExportInput): Promise<BackupDoc> {
	// A D1 session gives the reads one point in time where it can, and a bookmark naming it (informational: Time Travel
	// restores by timestamp, which is documented; whether a session bookmark is a valid Time Travel bookmark is not).
	let sessionBookmark: string | undefined;
	let reader: { prepare: D1Db["prepare"] } = i.db;
	if (i.db.withSession) {
		try {
			const s = i.db.withSession("first-primary");
			await s.prepare("SELECT 1").all();
			sessionBookmark = s.getBookmark() ?? undefined;
			reader = s;
		} catch {
			reader = i.db;
		}
	}
	const tables: BackupDoc["tables"] = {};
	const skipped: BackupDoc["skipped"] = [];
	for (const name of await listTables(reader)) {
		const c = classifyTable(name);
		if (!c.include) {
			skipped.push({ table: name, why: c.why });
			continue;
		}
		const rows = name === "options" ? await readSettingsRows(reader) : await readRows(reader, name);
		tables[name] = { columns: await columnsOf(reader, name), rows };
	}
	const migrations = tables._emdash_migrations?.rows.map((r) => String(r.name ?? "")).filter(Boolean).sort();
	const media = await mediaManifest(i.bucket);
	const createdAt = new Date(i.now).toISOString();
	return {
		format: FORMAT,
		version: FORMAT_VERSION,
		id: i.id,
		createdAt,
		trigger: i.trigger,
		site: i.site,
		...(migrations?.length ? { schema: migrations.at(-1) as string } : {}),
		timeTravel: { timestamp: createdAt, ...(i.database ? { database: i.database, command: `npx wrangler d1 time-travel restore ${i.database} --timestamp=${createdAt}` } : {}), ...(sessionBookmark ? { sessionBookmark } : {}) },
		tables,
		skipped,
		media,
		counts: countsOf(tables, media.objects.length),
	};
}
