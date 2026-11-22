/**
 * `wp2emdash sync-staging`: the pure parts — what is copied from production to staging, what never is, the plan, the
 * refusals and the SQL. No network, no Wrangler (src/commands/sync-staging.ts does the I/O).
 *
 * What is copied is an ALLOWLIST of tables, classified against EmDash 1.5's migrations 001_initial … 097_room_storage
 * (docs/spikes/staging-sync-findings.md): every content table (`ec_*`) plus SYNC_TABLES below. Everything else stays as
 * staging has it — users, sessions, passkeys, tokens, OAuth clients, form messages and every other plugin's storage,
 * comments, logs, runtime state — and is listed in the plan's `skipped`, never left out silently. The options table is
 * filtered to the site settings (minus the two that belong to the deployment: `site:url`, `site:staging`), EmDash's
 * three identity keys and an allowlist of kit plugin configuration rows that hold no secrets and no personal data.
 */
import { EXCLUDED_PREFIXES, EXCLUDED_TABLES, OPTION_KEYS, SAFE_TABLE } from "../../packages/backups/src/format.js";

export type Row = Record<string, unknown>;
/** A read-only query (SELECT / PRAGMA table_info / PRAGMA foreign_key_list) against one database. */
export type Query = (sql: string) => Promise<Row[]>;

/** Tables copied in full (besides `ec_*`), and what they hold. Same set as a backup minus the schema version. */
export const SYNC_TABLES: Readonly<Record<string, string>> = Object.freeze({
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
	media: "media library records (the files are copied bucket to bucket)",
	media_folders: "media folders",
	revisions: "saved revisions and drafts",
	options: "site settings and allowlisted plugin configuration (filtered rows)",
});

/** Never copied, with the reason. Auth data, secrets, form messages, personal data and runtime state stay as staging has them. */
export const SYNC_EXCLUDED: Readonly<Record<string, string>> = Object.freeze({
	...EXCLUDED_TABLES,
	_emdash_migrations: "the schema version (staging keeps its own; its deploys run the migrations)",
});

/** Options rows that belong to the deployment: staging keeps its own. */
export const DEPLOYMENT_OPTIONS: Readonly<Record<string, string>> = Object.freeze({
	"site:url": "the site address belongs to staging",
	"site:staging": "the staging switch (noindex everywhere) belongs to staging",
});

/**
 * Kit plugin KV rows (EmDash 1.5 keeps plugin KV as `plugin:<id>:<key>` rows of `options`) that are site configuration
 * — no secrets, no personal data, no runtime state. A key ending in ":" is a prefix. Everything else under `plugin:`
 * stays out: form recipients, CRM and chat settings (secrets, ids, addresses), CRM retry jobs, change requests (names
 * and emails), the sharing-card signing secret, analytics (staging must never count into production's), caches,
 * logs, locks, health state and coming-soon mode (deployment state).
 */
export const PLUGIN_CONFIG_OPTIONS: Readonly<Record<string, string>> = Object.freeze({
	"plugin:site-seo:business": "business details switch (SEO & Analytics)",
	"plugin:site-seo:social:": "sharing image and text per entry (SEO panel)",
	"plugin:site-seo:term:": "SEO of category and tag pages",
	"plugin:site-seo:kw:": "focus keywords per entry (SEO panel)",
	"plugin:privacy-consent:settings": "cookie banner settings",
	"plugin:motion:settings": "animation settings",
	"plugin:site-og:settings": "sharing card design",
});

/** Bucket prefixes that are never media (backups, site-transfer staging). */
export const NOT_MEDIA_PREFIXES = ["backups/", "transfers/"] as const;

export type TableDecision = { include: true; why: string } | { include: false; why: string };

/** Whether a table is copied to staging, and why (pure). */
export function classifySyncTable(name: string): TableDecision {
	if (!SAFE_TABLE.test(name)) return { include: false, why: "unusual table name" };
	if (SYNC_EXCLUDED[name]) return { include: false, why: SYNC_EXCLUDED[name] as string };
	for (const [p, why] of Object.entries(EXCLUDED_PREFIXES)) if (name.startsWith(p)) return { include: false, why };
	if (name.startsWith("ec_")) return { include: true, why: `content of the "${name.slice(3)}" collection` };
	if (SYNC_TABLES[name]) return { include: true, why: SYNC_TABLES[name] as string };
	return { include: false, why: "not classified yet (a newer EmDash table): staging keeps its own" };
}

const sqlString = (s: string) => `'${s.replace(/'/g, "''")}'`;
export const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** Whether an options row is copied (pure). Encrypted envelopes (`"$emdash"`) never are, whatever the key. */
export function optionAllowedForSync(name: string, value: unknown): boolean {
	if (DEPLOYMENT_OPTIONS[name]) return false;
	if (typeof value === "string" && value.includes('"$emdash"')) return false;
	if (name.startsWith("site:")) return true;
	if ((OPTION_KEYS as readonly string[]).includes(name)) return true;
	return Object.keys(PLUGIN_CONFIG_OPTIONS).some((k) => (k.endsWith(":") ? name.startsWith(k) : name === k));
}

/** The same rule in SQL: the rows read from production and the rows replaced on staging. */
export function optionsWhere(): string {
	const exact = [...OPTION_KEYS, ...Object.keys(PLUGIN_CONFIG_OPTIONS).filter((k) => !k.endsWith(":"))];
	const prefixes = Object.keys(PLUGIN_CONFIG_OPTIONS).filter((k) => k.endsWith(":"));
	const parts = [`(substr(name, 1, 5) = 'site:' AND name NOT IN (${Object.keys(DEPLOYMENT_OPTIONS).map(sqlString).join(", ")}))`, `name IN (${exact.map(sqlString).join(", ")})`, ...prefixes.map((p) => `substr(name, 1, ${p.length}) = ${sqlString(p)}`)];
	return `(${parts.join(" OR ")}) AND instr(value, '"$emdash"') = 0`;
}

// ── Read-only guard ─────────────────────────────────────────────────────────────────────────────────────────────

const WRITE_WORDS = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH|VACUUM|REINDEX|ANALYZE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|UPSERT|TRUNCATE)\b/i;

/**
 * Every query sent to a database over the REST API goes through this: one statement, SELECT or PRAGMA table_info /
 * foreign_key_list, no write keyword outside quotes. Production is only ever read; staging is read here and written
 * only through the import (one atomic file).
 */
export function assertReadOnly(sql: string): void {
	const bare = sql
		.trim()
		.replace(/'(?:[^']|'')*'/g, "''")
		.replace(/"(?:[^"]|"")*"/g, '""')
		.replace(/;\s*$/, "");
	if (bare.includes(";")) throw new Error("Refused: one read-only statement per query");
	if (!/^(SELECT\s|PRAGMA\s+(table_info|foreign_key_list)\s*\(\s*""\s*\)$)/i.test(bare)) throw new Error("Refused: only SELECT / PRAGMA table_info / foreign_key_list are sent");
	if (WRITE_WORDS.test(bare)) throw new Error("Refused: a read-only query may not contain a write keyword");
}

// ── Schema ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ColumnInfo {
	name: string;
	type: string;
	notnull: boolean;
	dflt: string | null;
	pk: number;
}
export interface TableInfo {
	name: string;
	sql: string | null;
	columns: ColumnInfo[];
	/** Foreign keys: column → referenced table. */
	fks: { from: string; table: string }[];
	/** CREATE INDEX statements (named indexes only). */
	indexes: string[];
}
export interface DbSchema {
	/** Every table name in the database. */
	all: string[];
	/** Details of the tables the sync would copy. */
	tables: Record<string, TableInfo>;
	/** Applied EmDash migrations (sorted). */
	migrations: string[];
}

/** The schema of the tables the sync would copy, plus every table name and the applied migrations (read-only). */
export async function readSchema(q: Query): Promise<DbSchema> {
	const master = await q("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name");
	const all = master.filter((r) => r.type === "table").map((r) => String(r.name));
	const tables: Record<string, TableInfo> = {};
	for (const name of all) {
		if (!classifySyncTable(name).include) continue;
		const cols = await q(`PRAGMA table_info(${quoteIdent(name)})`);
		const fks = await q(`PRAGMA foreign_key_list(${quoteIdent(name)})`);
		tables[name] = {
			name,
			sql: (master.find((r) => r.type === "table" && r.name === name)?.sql as string | null | undefined) ?? null,
			columns: cols.map((c) => ({ name: String(c.name), type: String(c.type ?? ""), notnull: Number(c.notnull) === 1, dflt: c.dflt_value === null || c.dflt_value === undefined ? null : String(c.dflt_value), pk: Number(c.pk ?? 0) })),
			fks: fks.map((f) => ({ from: String(f.from), table: String(f.table) })),
			indexes: master.filter((r) => r.type === "index" && r.tbl_name === name && typeof r.sql === "string" && r.sql).map((r) => String(r.sql)),
		};
	}
	const migrations = all.includes("_emdash_migrations") ? (await q("SELECT name FROM _emdash_migrations ORDER BY name")).map((r) => String(r.name)).sort() : [];
	return { all, tables, migrations };
}

// ── Plan ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface TablePlan {
	table: string;
	why: string;
	/** replace: staging's rows are replaced; create: the table (a collection new on production) is created first. */
	action: "replace" | "create";
	/** Columns copied (production ∩ staging, production order; all production columns for a new table). */
	columns: string[];
	/** Columns of a content table only production has (a field added there): added to staging first. */
	addColumns: ColumnInfo[];
	/** Columns written as NULL: foreign keys to tables staging keeps (e.g. a byline's linked user account). */
	nullColumns: { column: string; why: string }[];
	/** Rows matched on each side (options: the filtered rows). Filled by the command. */
	productionRows?: number;
	stagingRows?: number;
}

export interface SyncPlan {
	tables: TablePlan[];
	skipped: { table: string; why: string }[];
	/** Delete order (dependents first) and insert order (referenced tables first). */
	order: { delete: string[]; insert: string[] };
	blockers: string[];
	warnings: string[];
	schema: { production?: string; staging?: string };
}

const createSql = (sql: string, name: string) => sql.replace(/^\s*CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?("(?:[^"]|"")+"|`[^`]+`|\[[^\]]+\]|[A-Za-z0-9_]+)/i, `CREATE TABLE IF NOT EXISTS ${quoteIdent(name)}`);

/** What a sync would do, from the two schemas (pure). */
export function buildPlan(prod: DbSchema, stg: DbSchema): SyncPlan {
	const blockers: string[] = [];
	const warnings: string[] = [];
	const skipped: SyncPlan["skipped"] = [];
	const tables: TablePlan[] = [];
	const behind = prod.migrations.filter((m) => !stg.migrations.includes(m));
	const ahead = stg.migrations.filter((m) => !prod.migrations.includes(m));
	if (behind.length) blockers.push(`Staging's database is behind production's schema (${behind.length} migration(s) missing, up to ${behind.at(-1)}): deploy staging at production's version first, then sync.`);
	if (ahead.length) warnings.push(`Staging's schema is ahead of production's (${ahead.length} newer migration(s), up to ${ahead.at(-1)}): rows are copied column by column; new columns keep their defaults.`);

	for (const name of prod.all) {
		const c = classifySyncTable(name);
		if (!c.include) {
			skipped.push({ table: name, why: c.why });
			continue;
		}
		const p = prod.tables[name];
		if (!p) continue;
		const s = stg.tables[name];
		if (!s) {
			if (name.startsWith("ec_") && p.sql) {
				tables.push({ table: name, why: c.why, action: "create", columns: p.columns.map((x) => x.name), addColumns: [], nullColumns: [] });
				warnings.push(`${name}: a collection staging does not have yet — the table is created on staging (search for it stays off until enabled there).`);
			} else blockers.push(`${name} is missing on staging (its schema is older than production's?): deploy staging at production's version first.`);
			continue;
		}
		const stgCols = new Set(s.columns.map((x) => x.name));
		const prodCols = new Set(p.columns.map((x) => x.name));
		const addColumns: ColumnInfo[] = [];
		for (const col of p.columns) {
			if (stgCols.has(col.name)) continue;
			if (name.startsWith("ec_")) {
				if (col.notnull && col.dflt === null) blockers.push(`${name}.${col.name}: a required field only production has, with no default: deploy staging at production's version first.`);
				else addColumns.push(col);
			} else warnings.push(`${name}.${col.name} is not on staging: its values are not copied.`);
		}
		for (const col of s.columns) if (!prodCols.has(col.name) && col.notnull && col.dflt === null && col.pk === 0) blockers.push(`${name}.${col.name} is required on staging but production has no such column.`);
		const columns = p.columns.map((x) => x.name).filter((n) => stgCols.has(n) || addColumns.some((a) => a.name === n));
		const nullColumns: TablePlan["nullColumns"] = [];
		for (const fk of s.fks) {
			if (fk.table === name || classifySyncTable(fk.table).include) continue;
			if (!columns.includes(fk.from)) continue;
			const col = s.columns.find((x) => x.name === fk.from);
			if (col?.notnull) blockers.push(`${name}.${fk.from} must reference ${fk.table}, which staging keeps as it is: cannot copy.`);
			else nullColumns.push({ column: fk.from, why: `references ${fk.table} (staging keeps its own)` });
		}
		tables.push({ table: name, why: c.why, action: "replace", columns, addColumns, nullColumns });
	}
	for (const name of stg.all) if (classifySyncTable(name).include && !prod.all.includes(name)) warnings.push(`${name} exists only on staging: left as it is.`);
	if (!tables.some((t) => t.table === "options")) blockers.push("No options table on one side: is this an EmDash database?");

	// Dependency order from staging's foreign keys (the target's constraints) among the copied tables.
	const names = tables.map((t) => t.table);
	const deps = new Map<string, Set<string>>(names.map((n) => [n, new Set((stg.tables[n] ?? prod.tables[n])?.fks.map((f) => f.table).filter((t) => t !== n && names.includes(t)) ?? [])]));
	const insert: string[] = [];
	const seen = new Set<string>();
	const visit = (n: string, path: Set<string>) => {
		if (seen.has(n) || path.has(n)) return;
		path.add(n);
		for (const d of [...(deps.get(n) ?? [])].sort()) visit(d, path);
		path.delete(n);
		seen.add(n);
		insert.push(n);
	};
	for (const n of [...names].sort()) visit(n, new Set());
	return { tables, skipped, order: { delete: [...insert].reverse(), insert }, blockers, warnings, schema: { ...(prod.migrations.length ? { production: prod.migrations.at(-1) as string } : {}), ...(stg.migrations.length ? { staging: stg.migrations.at(-1) as string } : {}) } };
}

// ── Refusals ────────────────────────────────────────────────────────────────────────────────────────────────────

interface CfSide {
	accountId?: string;
	d1?: { id?: string; name?: string };
	r2?: { bucket?: string };
	sessions?: { bucket?: string };
	restoreDrill?: { id?: string; name?: string };
	worker?: { url?: string };
}
export interface SyncCf {
	accountId?: string;
	production?: CfSide;
	staging?: CfSide;
	[k: string]: unknown;
}

/** Why a sync must not run at all (pure): no staging, nothing recorded, or staging shares a D1/R2 resource with production. */
export function syncRefusals(hasStaging: boolean, cf: SyncCf): string[] {
	const out: string[] = [];
	if (!hasStaging) return ["This site has one environment (production); sync-staging is only for sites with staging (target.staging: true, docs/staging-setup.md)."];
	const p = cf.production ?? {};
	const s = cf.staging ?? {};
	if (!p.d1?.id) out.push("No production D1 database recorded in cloudflare.json (production.d1.id): provision production first.");
	if (!s.d1?.id || !s.d1.name) out.push("No staging D1 database recorded in cloudflare.json (staging.d1.id / name): wp2emdash provision <slug> staging.");
	if (!p.r2?.bucket) out.push("No production R2 bucket recorded in cloudflare.json (production.r2.bucket).");
	if (!s.r2?.bucket) out.push("No staging R2 bucket recorded in cloudflare.json (staging.r2.bucket): wp2emdash provision <slug> staging.");
	const prodD1 = [p.d1?.id, p.restoreDrill?.id].filter((x): x is string => !!x);
	if (s.d1?.id && prodD1.includes(s.d1.id)) out.push(`Refused: staging's D1 database id is production's (${s.d1.id}). Staging must have its own database.`);
	const acct = (side: CfSide) => side.accountId ?? cf.accountId;
	if (s.d1?.name && p.d1?.name && s.d1.name === p.d1.name && (!acct(p) || !acct(s) || acct(p) === acct(s))) out.push(`Refused: staging and production name the same D1 database (${s.d1.name}).`);
	const buckets = (side: CfSide) => [side.r2?.bucket, side.sessions?.bucket].filter((x): x is string => !!x);
	for (const b of buckets(s)) {
		if (!buckets(p).includes(b)) continue;
		if (acct(p) && acct(s) && acct(p) !== acct(s)) continue;
		out.push(`Refused: staging and production share the R2 bucket ${b}. Staging must have its own buckets.`);
	}
	return out;
}

/** The write chokepoint: only staging's database, never production's (or its restore-test database). */
export function assertStagingDatabase(id: string, cf: SyncCf): void {
	const p = cf.production ?? {};
	if (!id || id === p.d1?.id || id === p.restoreDrill?.id) throw new Error("Refused: the write target resolves to a production database.");
	if (id !== cf.staging?.d1?.id) throw new Error("Refused: the write target is not staging's recorded database.");
}

/** The media chokepoint: objects are only ever written to staging's media bucket. */
export function assertStagingBucket(bucket: string, cf: SyncCf): void {
	const p = cf.production ?? {};
	const acctP = p.accountId ?? cf.accountId;
	const acctS = cf.staging?.accountId ?? cf.accountId;
	const sameAccount = !acctP || !acctS || acctP === acctS;
	if (!bucket || (sameAccount && [p.r2?.bucket, p.sessions?.bucket].includes(bucket))) throw new Error("Refused: the media write target is a production bucket.");
	if (bucket !== cf.staging?.r2?.bucket) throw new Error("Refused: the media write target is not staging's recorded bucket.");
}

// ── SQL ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/** D1's documented maximum SQL statement length (100 KB). */
export const MAX_STATEMENT_BYTES = 100_000;

/** A value as an SQL literal (rows come back from D1's REST API as JSON). */
export function sqlLiteral(v: unknown): string {
	if (v === null || v === undefined) return "NULL";
	if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
	if (typeof v === "bigint") return v.toString();
	if (typeof v === "boolean") return v ? "1" : "0";
	if (Array.isArray(v) && v.length && v.every((n) => Number.isInteger(n) && n >= 0 && n < 256)) return `X'${Buffer.from(v as number[]).toString("hex")}'`;
	if (typeof v === "object") return sqlString(JSON.stringify(v));
	return sqlString(String(v));
}

const columnDef = (c: ColumnInfo) => `${quoteIdent(c.name)}${c.type ? ` ${c.type}` : ""}${c.dflt !== null ? ` DEFAULT (${c.dflt})` : ""}${c.notnull && c.dflt !== null ? " NOT NULL" : ""}`;

export interface SyncSql {
	sql: string;
	statements: number;
	/** Rows inserted per table. */
	rows: Record<string, number>;
	/** INSERT statements longer than D1's statement limit (the import would fail as a whole, staging unchanged). */
	oversized: number;
}

/**
 * The file staging imports in one go (D1 import is atomic: a failure leaves staging as it was). Foreign keys are
 * deferred to the end; staging's rows are deleted dependents first and production's inserted referenced tables
 * first. Options: only the allowlisted rows are deleted and inserted.
 */
export function buildSyncSql(plan: SyncPlan, prod: DbSchema, rows: Record<string, Row[]>): SyncSql {
	const out: string[] = ["PRAGMA defer_foreign_keys = true;"];
	const counts: Record<string, number> = {};
	let oversized = 0;
	const byName = new Map(plan.tables.map((t) => [t.table, t]));
	for (const t of plan.tables) {
		if (t.action === "create") {
			const p = prod.tables[t.table];
			if (p?.sql) out.push(`${createSql(p.sql, t.table)};`, ...p.indexes.map((i) => `${i.replace(/^\s*CREATE\s+(UNIQUE\s+)?INDEX\s+(IF\s+NOT\s+EXISTS\s+)?/i, (_m, u) => `CREATE ${u ?? ""}INDEX IF NOT EXISTS `)};`));
		}
		for (const c of t.addColumns) out.push(`ALTER TABLE ${quoteIdent(t.table)} ADD COLUMN ${columnDef(c)};`);
	}
	for (const name of plan.order.delete) {
		const t = byName.get(name);
		if (!t || t.action === "create") continue;
		out.push(name === "options" ? `DELETE FROM "options" WHERE ${optionsWhere()};` : `DELETE FROM ${quoteIdent(name)};`);
	}
	for (const name of plan.order.insert) {
		const t = byName.get(name);
		if (!t) continue;
		const nulls = new Set(t.nullColumns.map((n) => n.column));
		const list = (rows[name] ?? []).filter((r) => name !== "options" || optionAllowedForSync(String(r.name ?? ""), r.value));
		counts[name] = list.length;
		const cols = t.columns.map(quoteIdent).join(", ");
		for (const r of list) {
			const stmt = `INSERT INTO ${quoteIdent(name)} (${cols}) VALUES (${t.columns.map((c) => (nulls.has(c) ? "NULL" : sqlLiteral(r[c]))).join(", ")});`;
			if (Buffer.byteLength(stmt) > MAX_STATEMENT_BYTES) oversized++;
			out.push(stmt);
		}
	}
	return { sql: `${out.join("\n")}\n`, statements: out.length, rows: counts, oversized };
}

/** A storage key that may be copied: relative, no `..`, not a backup or transfer object. */
export function mediaKeyAllowed(key: string): boolean {
	if (!key || key.length > 1024 || key.startsWith("/") || key.split("/").includes("..")) return false;
	return !NOT_MEDIA_PREFIXES.some((p) => key.startsWith(p));
}
