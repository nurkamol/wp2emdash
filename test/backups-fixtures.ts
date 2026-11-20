/**
 * Stand-ins for the @wp2emdash/backups tests: a real SQLite database (node:sqlite) behind the D1 binding's shape, with
 * a synthetic subset of EmDash 1.5's tables — including the auth, secret and personal-data tables a backup must never
 * contain, filled with sentinel values the tests search for — and an in-memory R2 bucket.
 */
import { DatabaseSync } from "node:sqlite";
import type { D1Db, R2Like, R2ObjectLike } from "../packages/backups/src/export.js";

/** Values that must never appear in a backup, a log line or an email. */
export const SECRETS = {
	email: "owner-account@example.com",
	passwordHash: "SENTINEL-PASSWORD-HASH",
	passkey: "SENTINEL-PASSKEY-PUBLIC-KEY",
	apiToken: "SENTINEL-API-TOKEN-HASH",
	oauthToken: "SENTINEL-OAUTH-TOKEN",
	authToken: "SENTINEL-MAGIC-LINK-TOKEN",
	pluginSecret: "SENTINEL-ENCRYPTED-PLUGIN-SECRET",
	pluginData: "SENTINEL-FORM-MESSAGE-BODY",
	previewSecret: "SENTINEL-PREVIEW-SECRET",
	passkeyPending: "SENTINEL-PASSKEY-CHALLENGE",
	commenter: "commenter@example.com",
	audit: "SENTINEL-AUDIT-IP",
	s3Secret: "SENTINELs3SecretAccessKey0123456789",
	s3KeyId: "SENTINELKEYID0123456",
};

const SCHEMA = `
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, name TEXT, password_hash TEXT, role INTEGER);
CREATE TABLE credentials (id TEXT PRIMARY KEY, user_id TEXT, public_key TEXT);
CREATE TABLE auth_tokens (hash TEXT PRIMARY KEY, user_id TEXT);
CREATE TABLE _emdash_api_tokens (id TEXT PRIMARY KEY, token_hash TEXT, user_id TEXT);
CREATE TABLE _emdash_oauth_tokens (id TEXT PRIMARY KEY, token TEXT);
CREATE TABLE _plugin_storage (plugin_id TEXT, collection TEXT, id TEXT, data TEXT);
CREATE TABLE _emdash_comments (id TEXT PRIMARY KEY, author_email TEXT, body TEXT);
CREATE TABLE audit_logs (id TEXT PRIMARY KEY, ip TEXT);
CREATE TABLE _emdash_cron_tasks (id TEXT PRIMARY KEY, plugin_id TEXT, task_name TEXT);
CREATE TABLE _emdash_future_feature (id TEXT PRIMARY KEY, v TEXT);
CREATE TABLE options (name TEXT PRIMARY KEY, value TEXT, revision TEXT DEFAULT '1');
CREATE TABLE _emdash_migrations (name TEXT PRIMARY KEY, timestamp TEXT);
CREATE TABLE _emdash_collections (id TEXT PRIMARY KEY, slug TEXT, label TEXT);
CREATE TABLE _emdash_fields (id TEXT PRIMARY KEY, collection_id TEXT, slug TEXT, type TEXT);
CREATE TABLE ec_pages (id TEXT PRIMARY KEY, slug TEXT, status TEXT, author_id TEXT, created_at TEXT, updated_at TEXT, published_at TEXT, deleted_at TEXT, version INTEGER, live_revision_id TEXT, draft_revision_id TEXT, locale TEXT, translation_group TEXT, title TEXT, body TEXT, hero TEXT);
CREATE TABLE _emdash_seo (collection TEXT, content_id TEXT, seo_title TEXT, seo_description TEXT, seo_image TEXT, seo_canonical TEXT, seo_no_index INTEGER, created_at TEXT, updated_at TEXT);
CREATE TABLE _emdash_menus (id TEXT PRIMARY KEY, name TEXT, label TEXT, created_at TEXT, updated_at TEXT, locale TEXT, translation_group TEXT);
CREATE TABLE _emdash_menu_items (id TEXT PRIMARY KEY, menu_id TEXT, parent_id TEXT, sort_order INTEGER, type TEXT, reference_collection TEXT, reference_id TEXT, custom_url TEXT, label TEXT, title_attr TEXT, target TEXT, css_classes TEXT, created_at TEXT, locale TEXT, translation_group TEXT);
CREATE TABLE _emdash_redirects (id TEXT PRIMARY KEY, source TEXT, destination TEXT, type INTEGER);
CREATE TABLE media (id TEXT PRIMARY KEY, filename TEXT, storage_key TEXT, content_hash TEXT, alt TEXT);
`;

export function seed(db: DatabaseSync): void {
	db.exec(SCHEMA);
	const ins = (table: string, row: Record<string, unknown>) => db.prepare(`INSERT INTO ${table} (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`).run(...(Object.values(row) as never[]));
	ins("users", { id: "u1", email: SECRETS.email, name: "Owner", password_hash: SECRETS.passwordHash, role: 50 });
	ins("credentials", { id: "c1", user_id: "u1", public_key: SECRETS.passkey });
	ins("auth_tokens", { hash: SECRETS.authToken, user_id: "u1" });
	ins("_emdash_api_tokens", { id: "t1", token_hash: SECRETS.apiToken, user_id: "u1" });
	ins("_emdash_oauth_tokens", { id: "o1", token: SECRETS.oauthToken });
	ins("_plugin_storage", { plugin_id: "forms", collection: "messages", id: "m1", data: JSON.stringify({ message: SECRETS.pluginData }) });
	ins("_emdash_comments", { id: "cm1", author_email: SECRETS.commenter, body: "Nice" });
	ins("audit_logs", { id: "a1", ip: SECRETS.audit });
	ins("_emdash_cron_tasks", { id: "x1", plugin_id: "site-backups", task_name: "nightly" });
	ins("_emdash_future_feature", { id: "f1", v: "unclassified" });
	for (const [name, value] of Object.entries({
		"site:title": "Acme Studio",
		"site:tagline": "Pilates in Houston",
		"site:url": "https://acme.example",
		"site:staging": false,
		"site:logo": { mediaId: "med1", alt: "Acme" },
		"site:seo": { titleSeparator: "|", googleVerification: "g-123" },
		"site:social": { instagram: "acme" },
		"emdash:site_title": "Acme Studio",
		"emdash:preview_secret": SECRETS.previewSecret,
		"emdash:passkey_pending:abc": SECRETS.passkeyPending,
		"plugin:forms:settings:apiKey": { $emdash: "plugin-setting", v: 1, data: SECRETS.pluginSecret },
		"plugin:site-health:state": { v: 1 },
		"emdash:setup_complete": true,
	})) ins("options", { name, value: JSON.stringify(value) });
	ins("_emdash_migrations", { name: "001_initial", timestamp: "2026-01-01" });
	ins("_emdash_migrations", { name: "092_plugin_kv_options", timestamp: "2026-11-01" });
	ins("_emdash_collections", { id: "col1", slug: "pages", label: "Pages" });
	for (const [id, slug] of [["fl1", "title"], ["fl2", "body"], ["fl3", "hero"]]) ins("_emdash_fields", { id, collection_id: "col1", slug, type: slug === "title" ? "string" : "portableText" });
	ins("ec_pages", { id: "p1", slug: "about", status: "published", created_at: "2026-10-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", published_at: "2026-10-01T00:00:00Z", version: 3, locale: "en", translation_group: "p1", title: "About us", body: JSON.stringify([{ _type: "block", children: [{ text: "We teach Pilates." }] }]), hero: JSON.stringify({ heading: "Hello" }) });
	ins("ec_pages", { id: "p2", slug: "draft-page", status: "draft", created_at: "2026-11-02T00:00:00Z", updated_at: "2026-11-02T00:00:00Z", version: 1, locale: "en", translation_group: "p2", title: "Draft page", body: "[]" });
	ins("ec_pages", { id: "p3", slug: "old", status: "published", created_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-01T00:00:00Z", deleted_at: "2026-11-03T00:00:00Z", version: 2, locale: "en", translation_group: "p3", title: "Old page", body: "[]" });
	ins("_emdash_seo", { collection: "pages", content_id: "p1", seo_title: "About Acme", seo_description: "Who we are", seo_no_index: 0 });
	ins("_emdash_menus", { id: "mn1", name: "primary", label: "Main menu", locale: "en" });
	ins("_emdash_menu_items", { id: "mi1", menu_id: "mn1", sort_order: 0, type: "page", reference_collection: "pages", reference_id: "p1", label: "About", locale: "en" });
	ins("_emdash_menu_items", { id: "mi2", menu_id: "mn1", sort_order: 1, type: "custom", custom_url: "/contact", label: "Contact", locale: "en" });
	ins("_emdash_menu_items", { id: "mi3", menu_id: "mn1", parent_id: "mi1", sort_order: 0, type: "custom", custom_url: "/team", label: "Team", locale: "en" });
	ins("_emdash_redirects", { id: "r1", source: "/old", destination: "/about", type: 301 });
	ins("media", { id: "med1", filename: "logo.png", storage_key: "01abc.png", content_hash: "h1", alt: "Acme" });
}

/** The D1 binding's shape over node:sqlite. `fail` makes every query throw (a broken database). */
export function d1(db: DatabaseSync, o: { fail?: () => boolean } = {}): D1Db & { sql: DatabaseSync } {
	const stmt = (q: string, binds: unknown[] = []) => ({
		bind: (...v: unknown[]) => stmt(q, [...binds, ...v]),
		all: async <T>() => {
			if (o.fail?.()) throw new Error("D1_ERROR: database unavailable");
			return { results: db.prepare(q).all(...(binds as never[])).map((r) => ({ ...r })) as T[] };
		},
	});
	return { sql: db, prepare: (q: string) => stmt(q) };
}

export function freshDb(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	seed(db);
	return db;
}

/** In-memory R2 bucket. */
export function memoryR2(): R2Like & { store: Map<string, { body: Uint8Array; customMetadata?: Record<string, string>; uploaded: Date }> } {
	const store = new Map<string, { body: Uint8Array; customMetadata?: Record<string, string>; uploaded: Date }>();
	return {
		store,
		async put(key, value, o) {
			store.set(key, { body: typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value), ...(o?.customMetadata ? { customMetadata: o.customMetadata } : {}), uploaded: new Date() });
		},
		async get(key) {
			const e = store.get(key);
			return e ? { arrayBuffer: async () => e.body.slice().buffer as ArrayBuffer, ...(e.customMetadata ? { customMetadata: e.customMetadata } : {}) } : null;
		},
		async delete(keys) {
			for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
		},
		async list(o) {
			const objects: R2ObjectLike[] = [...store.entries()]
				.filter(([k]) => k.startsWith(o?.prefix ?? ""))
				.sort(([a], [b]) => (a < b ? -1 : 1))
				.map(([key, e]) => ({ key, size: e.body.byteLength, etag: `etag-${key.length}`, uploaded: e.uploaded, ...(o?.include?.includes("customMetadata") && e.customMetadata ? { customMetadata: e.customMetadata } : {}) }));
			return { objects, truncated: false };
		},
	};
}
