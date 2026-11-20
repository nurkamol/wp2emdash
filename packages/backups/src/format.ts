/**
 * The backup file: what goes in, what never does, and how its keys and rows read. Pure (no EmDash, no Worker APIs), so
 * the kit and tests can read a downloaded backup with the same rules.
 *
 * What goes in is an ALLOWLIST, checked against EmDash 1.5's tables (docs/spikes/backup-findings.md): every content
 * table (`ec_*`, drafts and trash included) plus the tables below. A table EmDash adds later is left out until it is
 * classified here, and listed in the file's `skipped` section — never dropped silently. The options table is filtered
 * to the site settings (`site:*`) and three identity keys, the same rule EmDash's own backup uses: plugin settings
 * (`plugin:*`, which hold encrypted secrets), the preview secret, passkey challenges and setup state never go in.
 */

export const FORMAT = "wp2emdash-backup";
export const FORMAT_VERSION = 1;

/** Tables copied in full (besides `ec_*` content tables), and what they hold. */
export const INCLUDED_TABLES: Readonly<Record<string, string>> = Object.freeze({
	_emdash_collections: "collection definitions",
	_emdash_fields: "field definitions",
	_emdash_block_types: "section (block) types",
	_emdash_block_type_versions: "section type versions",
	_emdash_taxonomy_defs: "taxonomy definitions",
	_emdash_taxonomy_def_groups: "taxonomy groups",
	taxonomies: "categories, tags and other terms",
	content_taxonomies: "terms assigned to entries",
	_emdash_menus: "menus",
	_emdash_menu_items: "menu items",
	_emdash_sections: "reusable sections",
	_emdash_widget_areas: "widget areas",
	_emdash_widgets: "widgets",
	_emdash_seo: "SEO fields of entries",
	_emdash_redirects: "redirects",
	_emdash_bylines: "bylines (public author profiles)",
	_emdash_content_bylines: "bylines credited on entries",
	_emdash_byline_fields: "byline custom fields",
	_emdash_byline_field_values: "byline field values",
	_emdash_byline_field_group_values: "byline field group values",
	_emdash_relations: "relations between collections",
	_emdash_content_references: "references between entries",
	media: "media library records (the files stay in R2: see the media manifest)",
	media_folders: "media folders",
	revisions: "saved revisions and drafts",
	options: "site settings only (site:* and the site title, tagline and locale) and change requests",
	_emdash_migrations: "the database schema version",
});

/**
 * Tables that are NEVER copied, with the reason (listed in each backup's `skipped`). Anything not in either list is
 * skipped as "not classified". Auth data, secrets, form messages and personal data stay out by design.
 */
export const EXCLUDED_TABLES: Readonly<Record<string, string>> = Object.freeze({
	users: "user accounts (auth data)",
	credentials: "passkeys (auth data)",
	auth_tokens: "sign-in tokens (auth data)",
	oauth_accounts: "linked sign-in accounts (auth data)",
	auth_challenges: "passkey challenges (auth data)",
	allowed_domains: "sign-up domains (auth configuration)",
	_emdash_api_tokens: "API tokens (secrets)",
	_emdash_oauth_tokens: "OAuth tokens (secrets)",
	_emdash_oauth_clients: "OAuth clients (secrets)",
	_emdash_device_codes: "device sign-in codes (secrets)",
	_emdash_authorization_codes: "authorization codes (secrets)",
	_plugin_storage: "plugin data (may hold form messages or other personal data)",
	_plugin_state: "plugin install state",
	_plugin_indexes: "plugin storage indexes",
	_emdash_comments: "comments (visitors' names and email addresses)",
	_emdash_comment_reactions: "comment reactions (personal data)",
	audit_logs: "audit log (who signed in and changed what)",
	_emdash_404_log: "404 log (visitor requests)",
	_emdash_rate_limits: "rate limits (runtime state)",
	_emdash_entry_locks: "edit locks (runtime state)",
	_emdash_rooms: "live editing rooms (runtime state)",
	_emdash_room_updates: "live editing updates (runtime state)",
	_emdash_cron_tasks: "scheduled tasks (runtime state)",
	_emdash_migrations_lock: "migration lock (runtime state)",
	_emdash_revision_prune_queue: "revision cleanup queue (runtime state)",
	_emdash_redirect_write_lock: "redirect lock (runtime state)",
	_emdash_redirect_state: "redirect cache state (rebuilt by EmDash)",
	_emdash_redirect_artifacts: "redirect cache (rebuilt by EmDash)",
	_emdash_redirect_generation_artifacts: "redirect cache (rebuilt by EmDash)",
});

/** Prefixes of tables that are never copied (EmDash's media-usage index and site-transfer staging are derived/runtime). */
export const EXCLUDED_PREFIXES: Readonly<Record<string, string>> = Object.freeze({
	_emdash_media_usage: "media usage index (rebuilt by EmDash)",
	_emdash_media_upload_attempts: "upload attempts (runtime state)",
	_emdash_transfer_: "site-transfer staging (runtime state)",
	_emdash_fts_: "search index (rebuilt by EmDash)",
	_cf_: "Cloudflare internal",
	sqlite_: "SQLite internal",
	d1_: "D1 internal",
});

/** Options rows that may go in: EmDash's own backup allowlist (api/handlers/backup.ts in emdash 1.5). */
export const OPTION_PREFIXES = ["site:"] as const;
export const OPTION_KEYS = ["emdash:site_title", "emdash:site_tagline", "emdash:locale"] as const;
/**
 * Plugin rows that are the client's site content and hold no secrets — allowed one prefix at a time (the rest of
 * `plugin:*` stays out): the Change requests plugin's requests (`plugin:change-requests:req:<id>`: titles,
 * descriptions, statuses, comments, attachment names, the requester's name and email). Their files stay in R2.
 */
export const PLUGIN_DATA_PREFIXES: Readonly<Record<string, string>> = Object.freeze({ "plugin:change-requests:req:": "change requests" });

export const SAFE_TABLE = /^[a-z_][a-z0-9_]*$/;

export type TableDecision = { include: true; why: string } | { include: false; why: string };

/** Whether a table goes into a backup, and why (pure). */
export function classifyTable(name: string): TableDecision {
	if (!SAFE_TABLE.test(name)) return { include: false, why: "unusual table name" };
	if (EXCLUDED_TABLES[name]) return { include: false, why: EXCLUDED_TABLES[name] as string };
	for (const [p, why] of Object.entries(EXCLUDED_PREFIXES)) if (name.startsWith(p)) return { include: false, why };
	if (name.startsWith("ec_")) return { include: true, why: `content of the "${name.slice(3)}" collection` };
	if (INCLUDED_TABLES[name]) return { include: true, why: INCLUDED_TABLES[name] as string };
	return { include: false, why: "not classified yet (a newer EmDash table): covered by D1 Time Travel only" };
}

/** Whether an options row may go into a backup (pure). Encrypted plugin-setting envelopes never do, whatever the key. */
export function optionAllowed(name: string, value: unknown): boolean {
	if (!(OPTION_KEYS as readonly string[]).includes(name) && !OPTION_PREFIXES.some((p) => name.startsWith(p)) && !Object.keys(PLUGIN_DATA_PREFIXES).some((p) => name.startsWith(p))) return false;
	if (typeof value === "string" && value.includes('"$emdash"')) return false;
	return true;
}

// ── The file ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type Trigger = "nightly" | "manual" | "pre-restore" | "pre-delete";

export interface MediaObject {
	key: string;
	size: number;
	/** R2's ETag: the MD5 of the file for single-part uploads. */
	etag: string;
	uploaded?: string;
}

export interface BackupCounts {
	/** Entries per collection (drafts and trash included). */
	entries: Record<string, number>;
	menus: number;
	menuItems: number;
	redirects: number;
	media: number;
	mediaFiles: number;
	settings: number;
	sections: number;
	taxonomies: number;
	revisions: number;
}

export interface BackupDoc {
	format: typeof FORMAT;
	version: typeof FORMAT_VERSION;
	id: string;
	createdAt: string;
	trigger: Trigger;
	site: { name: string; url: string };
	/** The last EmDash migration applied when the backup was made (schema version). */
	schema?: string;
	/** Full-site restore: D1 Time Travel to this moment (30 days on Workers Paid), from the project directory. */
	timeTravel: { timestamp: string; database?: string; command?: string; sessionBookmark?: string };
	tables: Record<string, { columns: string[]; rows: Record<string, unknown>[] }>;
	/** Every table NOT in the backup, with the reason: nothing is left out silently. */
	skipped: { table: string; why: string }[];
	/** The media files in the bucket when the backup was made (keys, sizes, hashes) — the files themselves stay in R2. */
	media: { objects: MediaObject[]; truncated: boolean };
	counts: BackupCounts;
}

/** One line in the plugin's list of backups (plugin KV) and in the R2 object's custom metadata. */
export interface BackupEntry {
	id: string;
	key: string;
	at: string;
	trigger: Trigger;
	/** Compressed size in bytes. */
	bytes: number;
	counts: BackupCounts;
	/** Off-site copy: ok, failed (with a short reason) or not configured. */
	offsite?: "ok" | "failed";
	/** Who asked (display name; nightly runs have none). */
	by?: string;
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** `backups/<yyyy-mm-dd>/<hhmmss>-<trigger>-<8 hex>.json.gz`, under the prefix EmDash's media route never serves. */
export function backupKey(at: Date, trigger: Trigger, rand: string): string {
	const d = at.toISOString();
	return `backups/${d.slice(0, 10)}/${d.slice(11, 13)}${d.slice(14, 16)}${d.slice(17, 19)}-${trigger}-${rand}.json.gz`;
}
export const KEY_PATTERN = /^backups\/(\d{4}-\d{2}-\d{2})\/(\d{6})-(nightly|manual|pre-restore|pre-delete)-([0-9a-f]{8})\.json\.gz$/;
export const isBackupKey = (k: string) => KEY_PATTERN.test(k);
/** The id people see and links carry: `<yyyy-mm-dd>-<hhmmss>-<8 hex>`. */
export function idOfKey(key: string): string | undefined {
	const m = KEY_PATTERN.exec(key);
	return m ? `${m[1]}-${m[2]}-${m[4]}` : undefined;
}
export const ID_PATTERN = /^\d{4}-\d{2}-\d{2}-\d{6}-[0-9a-f]{8}$/;

/** Kit markers: the kit writes one before it changes a live site (load --force, golive). */
export const MARKER_PREFIX = "backups/markers/";
export interface KitMarker {
	at: string;
	reason: string;
	by: "wp2emdash";
	d1?: { database: string; bookmark?: string; restore?: string };
}

/** EmDash's content table columns that are not fields (database/repositories/content.ts SYSTEM_COLUMNS, emdash 1.5). */
export const SYSTEM_COLUMNS = new Set(["id", "slug", "status", "author_id", "primary_byline_id", "created_at", "updated_at", "published_at", "scheduled_at", "deleted_at", "version", "live_revision_id", "draft_revision_id", "locale", "translation_group"]);

/** A stored value as EmDash reads it back (JSON-looking strings parsed, like its deserializeValue). */
export function deserialize(value: unknown): unknown {
	if (typeof value === "string" && (value.startsWith("{") || value.startsWith("["))) {
		try {
			return JSON.parse(value);
		} catch {
			return value;
		}
	}
	return value;
}

/** An entry's field values (the API's `data`) from its content-table row. */
export function entryData(row: Record<string, unknown>): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(row)) if (!SYSTEM_COLUMNS.has(k) && !k.startsWith("_")) out[k] = deserialize(v);
	return out;
}

/** A readable title for an entry row: its title/name/heading field, else the slug, else the id. */
export function entryTitle(row: Record<string, unknown>): string {
	for (const k of ["title", "name", "heading", "label"]) if (typeof row[k] === "string" && (row[k] as string).trim()) return (row[k] as string).trim().slice(0, 120);
	return (typeof row.slug === "string" && row.slug) || String(row.id ?? "");
}

/** The SEO input (as the content API takes it) from an `_emdash_seo` row. */
export function seoInput(row: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
	if (!row) return undefined;
	return { title: row.seo_title ?? null, description: row.seo_description ?? null, image: row.seo_image ?? null, canonical: row.seo_canonical ?? null, noIndex: !!row.seo_no_index };
}

/** The site settings stored in a backup, keyed like the settings API (`site:title` → `title`), values decoded. */
export function settingsOf(doc: Pick<BackupDoc, "tables">): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const r of doc.tables.options?.rows ?? []) {
		const name = String(r.name ?? "");
		if (!name.startsWith("site:")) continue;
		try {
			out[name.slice(5)] = JSON.parse(String(r.value));
		} catch {
			out[name.slice(5)] = r.value;
		}
	}
	return out;
}
