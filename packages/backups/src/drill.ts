/**
 * The restore test ("restore drill"): proof, once a month, that the newest backup can actually be restored.
 *
 * Where it restores to (docs/spikes/backup-findings.md, "Restore test"):
 * - **Scratch database** (the real test): an EMPTY D1 database bound to the Worker as `RESTORE_DRILL_DB`, created by
 *   `wp2emdash provision` next to the site's database and bound by the scaffold only once its id is recorded. The test
 *   creates every table of the backup there (columns, types, NOT NULL / defaults and primary keys taken from the LIVE
 *   schema, so a backup that no longer fits the site's schema fails here and not on the day it is needed), inserts every
 *   row of the file, counts them back, then drops everything again. A Worker cannot create a D1 database without an
 *   account token, so the scratch database is provisioned once, ahead of time.
 * - **Dry run** (fallback, when the binding is missing — e.g. sites built before 0.2.0): the same file checks and the
 *   same plan against the live schema (every table, column, NOT NULL column, primary key and D1 limit), with NO write.
 *
 * Safety: the live database is only READ (sqlite_master, PRAGMA table_info, the schema version). The scratch database
 * is written only if it is empty or carries the test's own marker table `_wp2emdash_restore_drill`; anything else (a
 * binding pointing at a real database by mistake) refuses before the first write. Results hold counts, table names and
 * dates — never row values; form messages are not in a backup in the first place (format.ts) and the privacy check
 * counts plugin rows by name only.
 *
 * Time budget: a run is split across cron ticks (task `restore-drill`, every 15 minutes at minutes fixed per site): at
 * most DRILL_TICK_STATEMENTS statements and DRILL_TICK_MS per tick, progress kept in plugin KV, its own lock.
 */
import type { BackupsOptions } from "./index.js";
import { type BackupDoc, type BackupEntry, classifyTable, FORMAT, FORMAT_VERSION, isBackupKey, optionAllowed, SAFE_TABLE } from "./format.js";
import { countsOf, type D1Db, listTables, type R2Like } from "./export.js";
import { alertMail, sendMail } from "./email.js";
import { adminUrl, alertBlocked, alertRecipients, type RunDeps, settingsOf } from "./run.js";
import { nightlyHour } from "./schedule.js";
import { acquireLock, KEYS, type Kv, readIndex, releaseLock } from "./store.js";
import { DAY, gunzip, hash32, HOUR, MINUTE, sha256Hex, shortTime } from "./util.js";

export const DRILL_TASK = "restore-drill";
export const DRILL_BINDING = "RESTORE_DRILL_DB";
/** The scratch database's marker table: the test writes only to an empty database or one holding this table. */
export const DRILL_MARKER = "_wp2emdash_restore_drill";
export const DRILL_DEFAULTS = { everyDays: 30, mediaSample: 12, tolerancePct: 0 } as const;
/** Per cron tick (EmDash's hook timeout for this plugin is 120 s; D1 allows 1,000 queries per invocation on Paid). */
export const DRILL_TICK_MS = 60_000;
export const DRILL_TICK_STATEMENTS = 400;
/** "Run restore test now" runs its first slice inside the admin request, with a smaller budget. */
export const DRILL_MANUAL_MS = 20_000;
export const DRILL_MANUAL_STATEMENTS = 200;
export const DRILL_LOCK_MS = 3 * MINUTE;
/** "Run restore test now" at most every 10 minutes. */
export const DRILL_MANUAL_EVERY = 10 * MINUTE;
/** A run that has not finished within a day is abandoned (and reported as failed). */
export const DRILL_MAX_RUN_MS = DAY;
/** D1 limits (developers.cloudflare.com/d1/platform/limits, 2026-11-22). */
export const D1_MAX_PARAMS = 100;
export const D1_MAX_COLUMNS = 100;
export const D1_MAX_ROW_BYTES = 2_000_000;
const BATCH_STATEMENTS = 50;
const BATCH_BYTES = 4_000_000;
const HISTORY = 12;

// ── Types ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ScratchStmt {
	bind(...values: unknown[]): ScratchStmt;
	all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
	run(): Promise<unknown>;
}
/** The scratch D1 binding (prepare/run, and batch — one transaction per batch — when the binding has it). */
export interface ScratchDb {
	prepare(query: string): ScratchStmt;
	batch?(statements: ScratchStmt[]): Promise<unknown[]>;
}

export type DrillMode = "scratch" | "dry-run";
export interface DrillCheck {
	id: string;
	label: string;
	ok: boolean;
	/** Counts, table names, dates — never values. */
	detail?: string;
}
export interface DrillResult {
	at: string;
	startedAt: string;
	ok: boolean;
	mode: DrillMode;
	trigger: "schedule" | "manual";
	by?: string;
	backupId?: string;
	backupAt?: string;
	tables: number;
	rows: number;
	mediaSampled: number;
	mediaMissing: number;
	ticks: number;
	checks: DrillCheck[];
	/** Short reason of a failure (never content). */
	reason?: string;
}
export interface DrillRun {
	startedAt: string;
	trigger: "schedule" | "manual";
	by?: string;
	mode: DrillMode;
	backupId: string;
	backupKey: string;
	/** Next table (index into the plan's tables) and row to insert; `prepared` once the scratch tables exist. */
	cursor: { table: number; row: number; prepared: boolean };
	inserted: number;
	ticks: number;
}
export interface DrillStore {
	last?: DrillResult;
	running?: DrillRun;
	/** "Run restore test now" waiting for the next tick. */
	requested?: { at: string; by?: string };
	manualAt?: string;
	/** Failed tests in a row (an alert goes out on the first failure, a recovery mail when one passes again). */
	failures?: number;
	history?: { at: string; ok: boolean; mode: DrillMode; rows: number; tables: number }[];
}

export interface DrillSettings {
	everyDays: number;
	mediaSample: number;
	tolerancePct: number;
	hour: number;
	binding: string;
}

/** The test's settings from the plugin options; undefined when it is off. */
export function drillSettings(o: BackupsOptions): DrillSettings | undefined {
	if (o.restoreDrill === false) return undefined;
	const r = o.restoreDrill ?? {};
	const int = (v: unknown, d: number, min: number, max: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : d);
	const nightly = nightlyHour(new URL(o.productionUrl).host, o.hourUtc);
	return {
		everyDays: int(r.everyDays, DRILL_DEFAULTS.everyDays, 1, 366),
		mediaSample: int(r.mediaSample, DRILL_DEFAULTS.mediaSample, 0, 100),
		tolerancePct: typeof r.tolerancePct === "number" && r.tolerancePct >= 0 ? Math.min(50, r.tolerancePct) : DRILL_DEFAULTS.tolerancePct,
		// After the nightly backup (its hour + 2, at most 23), so the test usually reads the backup of the same night.
		hour: r.hourUtc !== undefined && Number.isInteger(r.hourUtc) && r.hourUtc >= 0 && r.hourUtc <= 23 ? r.hourUtc : Math.min(23, nightly + 2),
		binding: r.binding && /^[A-Z][A-Z0-9_]*$/.test(r.binding) ? r.binding : DRILL_BINDING,
	};
}

/** The cron expression of the test's task: every 15 minutes at minutes fixed per site. */
export function drillCron(host: string): string {
	const m = hash32(`restore-drill:${host}`) % 15;
	return `${[m, m + 15, m + 30, m + 45].join(",")} * * * *`;
}

export const readDrill = async (kv: Kv): Promise<DrillStore> => (await kv.get<DrillStore>(KEYS.drill)) ?? {};

/** Whether a tick should work on the test now (pure). Scheduled tests never run on staging. */
export function drillDue(now: number, s: DrillStore, cfg: DrillSettings, staging: boolean): boolean {
	if (staging) return false;
	if (s.running || s.requested) return true;
	const last = s.last;
	if (last) {
		// A failed test is retried the next day (so a fix is confirmed soon); a passed one after `everyDays`.
		const every = last.ok ? cfg.everyDays * DAY : DAY;
		if (now - Date.parse(last.startedAt || last.at) < every - HOUR) return false;
	}
	return new Date(now).getUTCHours() >= cfg.hour;
}

/** Rows allowed to differ (pure): `pct` percent of the expected count, rounded down. */
export const withinTolerance = (expected: number, got: number, pct: number) => Math.abs(got - expected) <= Math.floor((expected * pct) / 100);

// ── The backup file ──────────────────────────────────────────────────────────────────────────────────────────────

export interface Inspected {
	doc?: BackupDoc;
	checks: DrillCheck[];
	bytes: number;
}

/** JSON with keys sorted at every level, so two count objects compare by content. */
const canon = (v: unknown): string => (v && typeof v === "object" && !Array.isArray(v) ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v ?? null));
const sameCounts = (a: unknown, b: unknown) => canon(a) === canon(b);
const isEmptyCounts = (c: BackupEntry["counts"]) => !Object.keys(c.entries ?? {}).length && !c.menus && !c.media && !c.settings && !c.mediaFiles;

/**
 * Reads the backup file with the restore path's rules and checks it: present, SHA-256 as recorded when stored (0.2.0+),
 * decompresses, parses, is a backup this version can read (the same format check as the plugin's loadDoc), and its
 * counts match its own rows and the list entry made when it was stored.
 */
export async function inspectBackup(bucket: R2Like, e: BackupEntry): Promise<Inspected> {
	const checks: DrillCheck[] = [];
	const fail = (id: string, label: string, detail: string): Inspected => ({ checks: [...checks, { id, label, ok: false, detail }], bytes: 0 });
	if (!isBackupKey(e.key)) return fail("file", "Backup file readable", "not a backup key");
	const obj = await bucket.get(e.key);
	if (!obj) return fail("file", "Backup file readable", "the file is missing from storage");
	const body = new Uint8Array(await obj.arrayBuffer());
	const recorded = obj.customMetadata?.sha256 ?? e.sha256;
	if (recorded) {
		const got = await sha256Hex(body);
		if (got !== recorded) return fail("checksum", "Checksum matches", "the file's SHA-256 differs from the one recorded when it was stored");
		checks.push({ id: "checksum", label: "Checksum matches", ok: true, detail: "SHA-256 as recorded when stored" });
	} else checks.push({ id: "checksum", label: "Checksum matches", ok: true, detail: "no checksum recorded (backup made before 0.2.0); decompression and counts checked instead" });
	let text: string;
	try {
		text = await gunzip(body);
	} catch {
		return fail("decompress", "File decompresses", "the gzip data is damaged");
	}
	let doc: BackupDoc;
	try {
		doc = JSON.parse(text) as BackupDoc;
	} catch {
		return fail("decompress", "File decompresses", "decompressed, but the JSON is damaged");
	}
	if (doc?.format !== FORMAT || doc.version !== FORMAT_VERSION || !doc.tables || typeof doc.tables !== "object") return fail("decompress", "File decompresses", "not a backup file this version can read");
	checks.push({ id: "decompress", label: "File decompresses", ok: true, detail: `${Math.round(body.byteLength / 1024)} KB compressed` });
	const recount = countsOf(doc.tables, doc.media?.objects?.length ?? 0);
	const own = sameCounts(recount, doc.counts);
	const listed = isEmptyCounts(e.counts) || sameCounts(e.counts, doc.counts);
	checks.push({ id: "manifest", label: "Counts match the backup's manifest", ok: own && listed, ...(own && listed ? { detail: "rows in the file = counts recorded with it" } : { detail: own ? "the file's counts differ from the list entry made when it was stored" : "the file's rows differ from the counts recorded in it" }) });
	return { doc, checks, bytes: body.byteLength };
}

// ── The plan (also the dry run) ──────────────────────────────────────────────────────────────────────────────────

export interface LiveColumn {
	name: string;
	type: string;
	notnull: number;
	dflt_value: string | null;
	pk: number;
}
export interface TablePlan {
	name: string;
	/** Columns inserted (from the file). */
	columns: string[];
	/** CREATE TABLE for the scratch database. */
	create: string;
	rows: number;
	/** Rows per INSERT (D1 binds at most 100 parameters per query). */
	perStatement: number;
}
export interface DrillPlan {
	tables: TablePlan[];
	rows: number;
	/** Problems a restore would hit (table name and what, never values). */
	problems: string[];
	/** Differences that do not stop a restore (schema moved on since the backup). */
	notes: string[];
}

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;
const SAFE_TYPE = /^[A-Za-z0-9 _(),]{0,40}$/;
const SAFE_DEFAULT = /^[^;]{0,200}$/;

/** The live schema of the tables a backup holds (read-only: sqlite_master and PRAGMA table_info) and its version. */
export async function liveSchema(db: D1Db): Promise<{ tables: Record<string, LiveColumn[]>; version?: string }> {
	const tables: Record<string, LiveColumn[]> = {};
	for (const name of await listTables(db)) {
		if (!classifyTable(name).include) continue;
		tables[name] = (await db.prepare(`PRAGMA table_info(${q(name)})`).all<LiveColumn>()).results;
	}
	let version: string | undefined;
	try {
		version = (await db.prepare("SELECT name FROM _emdash_migrations ORDER BY name DESC LIMIT 1").all<{ name: string }>()).results[0]?.name;
	} catch {}
	return { tables, ...(version ? { version } : {}) };
}

/** A value as bound to D1: BLOBs come back from JSON as number arrays, booleans as 1/0, objects as JSON text. */
export function bindable(v: unknown): unknown {
	if (v === undefined || v === null) return null;
	if (typeof v === "boolean") return v ? 1 : 0;
	if (Array.isArray(v) && v.every((x) => typeof x === "number")) return new Uint8Array(v);
	if (typeof v === "object") return JSON.stringify(v);
	return v;
}

/**
 * Plans the restore of a backup into an empty database shaped like the live one (pure). Each table is created with the
 * live schema's columns, types, NOT NULL / defaults and primary key (no foreign keys: users are never in a backup, and
 * D1 enforces foreign keys), plus any column the file has that the live table no longer has.
 */
export function planDrill(doc: Pick<BackupDoc, "tables" | "schema">, live: { tables: Record<string, LiveColumn[]>; version?: string }): DrillPlan {
	const problems: string[] = [];
	const notes: string[] = [];
	const drift = !!(doc.schema && live.version && doc.schema !== live.version);
	if (drift) notes.push(`The site's database schema changed since the backup (${doc.schema} → ${live.version}).`);
	for (const t of Object.keys(live.tables).sort()) if (!doc.tables[t]) (drift ? notes : problems).push(`${t}: in the live database but not in the backup`);
	const tables: TablePlan[] = [];
	let rows = 0;
	for (const name of Object.keys(doc.tables).sort()) {
		const t = doc.tables[name] as BackupDoc["tables"][string];
		if (!SAFE_TABLE.test(name) || !classifyTable(name).include) {
			problems.push(`${name}: a table a backup must not hold`);
			continue;
		}
		const fileCols = (t.columns?.length ? t.columns : Object.keys(t.rows[0] ?? {})).filter((c) => typeof c === "string" && c.length > 0 && c.length <= 128);
		const liveCols = live.tables[name];
		if (!liveCols) notes.push(`${name}: no longer in the live database (restored as it is in the file)`);
		const liveNames = new Set((liveCols ?? []).map((c) => c.name));
		const extra = fileCols.filter((c) => !liveNames.has(c));
		if (liveCols && extra.length) notes.push(`${name}: ${extra.length} column(s) not in the live table (${extra.slice(0, 5).join(", ")})`);
		const defs: string[] = [];
		for (const c of liveCols ?? []) {
			const type = SAFE_TYPE.test(c.type ?? "") ? ` ${c.type}` : "";
			const dflt = c.dflt_value != null && SAFE_DEFAULT.test(String(c.dflt_value)) ? ` DEFAULT (${c.dflt_value})` : "";
			defs.push(`${q(c.name)}${type}${c.notnull ? " NOT NULL" : ""}${dflt}`);
			if (c.notnull && c.dflt_value == null && !c.pk && !fileCols.includes(c.name)) problems.push(`${name}: required column "${c.name}" is missing from the backup`);
		}
		for (const c of extra) defs.push(q(c));
		const pk = (liveCols ?? []).filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name);
		if (pk.length && pk.every((c) => fileCols.includes(c))) {
			defs.push(`PRIMARY KEY (${pk.map(q).join(", ")})`);
			const seen = new Set<string>();
			let dup = 0;
			for (const r of t.rows) {
				const k = JSON.stringify(pk.map((c) => r[c] ?? null));
				if (seen.has(k)) dup++;
				else seen.add(k);
			}
			if (dup) problems.push(`${name}: ${dup} row(s) repeat a primary key`);
		}
		if (defs.length > D1_MAX_COLUMNS) problems.push(`${name}: ${defs.length} columns (D1 allows ${D1_MAX_COLUMNS})`);
		const big = t.rows.filter((r) => JSON.stringify(r).length > D1_MAX_ROW_BYTES).length;
		if (big) problems.push(`${name}: ${big} row(s) larger than D1's 2 MB row limit`);
		if (!defs.length) {
			problems.push(`${name}: no columns`);
			continue;
		}
		tables.push({ name, columns: fileCols, create: `CREATE TABLE ${q(name)} (${defs.join(", ")})`, rows: t.rows.length, perStatement: Math.max(1, Math.floor(D1_MAX_PARAMS / Math.max(1, fileCols.length))) });
		rows += t.rows.length;
	}
	return { tables, rows, problems, notes };
}

// ── The scratch database ─────────────────────────────────────────────────────────────────────────────────────────

const INTERNAL = /^(sqlite_|_cf_|d1_)/;

async function exec(db: ScratchDb, stmts: ScratchStmt[]): Promise<void> {
	if (!stmts.length) return;
	if (db.batch) await db.batch(stmts);
	else for (const s of stmts) await s.run();
}

/**
 * Makes sure the scratch database is the test's own and empties it: refuses (before any write) when it is the live
 * binding or holds tables without the test's marker.
 */
export async function prepareScratch(scratch: ScratchDb, live: unknown, backupId: string, at: string): Promise<number> {
	if ((scratch as unknown) === live) throw new Error(`the restore-test database is the live database binding: nothing written`);
	const tables = (await listTables(scratch)).filter((t) => !INTERNAL.test(t));
	if (tables.length && !tables.includes(DRILL_MARKER)) throw new Error(`the restore-test database is not empty (${tables.length} tables, no restore-test marker): nothing written`);
	const drop = tables.filter((t) => t !== DRILL_MARKER).map((t) => scratch.prepare(`DROP TABLE IF EXISTS ${q(t)}`));
	await exec(scratch, [...drop, scratch.prepare(`CREATE TABLE IF NOT EXISTS ${DRILL_MARKER} (id TEXT PRIMARY KEY, backup_id TEXT, started_at TEXT)`), scratch.prepare(`DELETE FROM ${DRILL_MARKER}`), scratch.prepare(`INSERT INTO ${DRILL_MARKER} (id, backup_id, started_at) VALUES ('run', ?, ?)`).bind(backupId, at)]);
	return drop.length + 4;
}

/** Empties the scratch database (only the test's own: same marker rule). Returns the statements used. */
export async function wipeScratch(scratch: ScratchDb): Promise<number> {
	const tables = (await listTables(scratch)).filter((t) => !INTERNAL.test(t));
	if (tables.length && !tables.includes(DRILL_MARKER)) throw new Error("the restore-test database is not the test's own: not emptied");
	const drop = tables.filter((t) => t !== DRILL_MARKER).map((t) => scratch.prepare(`DROP TABLE IF EXISTS ${q(t)}`));
	await exec(scratch, [...drop, ...(tables.includes(DRILL_MARKER) ? [scratch.prepare(`DELETE FROM ${DRILL_MARKER}`)] : [])]);
	return drop.length + 1;
}

/**
 * Inserts rows from `cursor` on, within `statements` statements (each INSERT carries up to 100 bound values). Returns
 * the new cursor, the rows inserted and the statements used; `done` when every table is in.
 */
export async function replaySlice(scratch: ScratchDb, doc: Pick<BackupDoc, "tables">, plan: DrillPlan, cursor: { table: number; row: number }, statements: number, deadline = Infinity, clock: () => number = Date.now): Promise<{ cursor: { table: number; row: number }; inserted: number; used: number; done: boolean }> {
	let { table, row } = cursor;
	let inserted = 0;
	let used = 0;
	let batch: ScratchStmt[] = [];
	let bytes = 0;
	let pendingRows = 0;
	const flush = async () => {
		await exec(scratch, batch);
		inserted += pendingRows;
		batch = [];
		bytes = 0;
		pendingRows = 0;
	};
	while (table < plan.tables.length && used < statements && clock() < deadline) {
		const t = plan.tables[table] as TablePlan;
		const rows = doc.tables[t.name]?.rows ?? [];
		if (row >= rows.length) {
			table++;
			row = 0;
			continue;
		}
		const chunk = rows.slice(row, row + t.perStatement);
		const values = chunk.flatMap((r) => t.columns.map((c) => bindable(r[c])));
		const sql = `INSERT INTO ${q(t.name)} (${t.columns.map(q).join(", ")}) VALUES ${chunk.map(() => `(${t.columns.map(() => "?").join(", ")})`).join(", ")}`;
		batch.push(scratch.prepare(sql).bind(...values));
		bytes += JSON.stringify(chunk).length;
		pendingRows += chunk.length;
		used++;
		row += chunk.length;
		if (batch.length >= BATCH_STATEMENTS || bytes >= BATCH_BYTES) await flush();
	}
	await flush();
	while (table < plan.tables.length && row >= (doc.tables[(plan.tables[table] as TablePlan).name]?.rows.length ?? 0)) {
		table++;
		row = 0;
	}
	return { cursor: { table, row }, inserted, used, done: table >= plan.tables.length };
}

const fmt = (n: number) => n.toLocaleString("en-US");

/** Counts every restored table back and checks it against the file (pure reads of the scratch database). */
export async function verifyScratch(scratch: ScratchDb, doc: Pick<BackupDoc, "tables" | "counts">, plan: DrillPlan, tolerancePct: number): Promise<{ checks: DrillCheck[]; used: number }> {
	const present = new Set(await listTables(scratch));
	const missing = plan.tables.filter((t) => !present.has(t.name)).map((t) => t.name);
	const count = async (t: string, where = "1 = 1") => Number((await scratch.prepare(`SELECT COUNT(*) AS n FROM ${q(t)} WHERE ${where}`).all<{ n: number }>()).results[0]?.n ?? 0);
	const counts: Record<string, number> = {};
	const off: string[] = [];
	for (const t of plan.tables) {
		if (!present.has(t.name)) continue;
		counts[t.name] = await count(t.name);
		if (!withinTolerance(t.rows, counts[t.name] as number, tolerancePct)) off.push(`${t.name} ${fmt(counts[t.name] as number)}/${fmt(t.rows)}`);
	}
	const checks: DrillCheck[] = [];
	checks.push({ id: "tables", label: "Every table restored", ok: !missing.length, detail: missing.length ? `missing: ${missing.slice(0, 8).join(", ")}` : `${plan.tables.length} tables` });
	const total = Object.values(counts).reduce((a, b) => a + b, 0);
	checks.push({ id: "rows", label: "Row counts match the backup", ok: !off.length, detail: off.length ? `differ: ${off.slice(0, 8).join(", ")}` : `${fmt(total)} rows${tolerancePct ? ` (tolerance ${tolerancePct} %)` : ""}` });
	const entries = Object.entries(doc.counts?.entries ?? {});
	const wrongEntries = entries.filter(([c, n]) => !withinTolerance(n, counts[`ec_${c}`] ?? 0, tolerancePct));
	checks.push({ id: "entries", label: "Pages and posts restored", ok: !wrongEntries.length, detail: entries.length ? entries.map(([c, n]) => `${c}: ${fmt(counts[`ec_${c}`] ?? 0)}/${fmt(n)}`).join(", ").slice(0, 300) : "no collections in the backup" });
	const media = doc.counts?.media ?? 0;
	checks.push({ id: "media-records", label: "Media library records restored", ok: withinTolerance(media, counts.media ?? 0, tolerancePct), detail: `${fmt(counts.media ?? 0)}/${fmt(media)}` });
	let used = plan.tables.length + 1;
	if (present.has("options")) {
		const settings = await count("options", "name LIKE 'site:%'");
		used++;
		const want = doc.counts?.settings ?? 0;
		checks.push({ id: "settings", label: "Site settings restored", ok: settings === want, detail: `${fmt(settings)}/${fmt(want)} settings` });
	} else checks.push({ id: "settings", label: "Site settings restored", ok: (doc.counts?.settings ?? 0) === 0, detail: "no options table in the backup" });
	return { checks, used };
}

/** What a backup must never hold, checked in the file (counts only; values are never read out). */
export function privacyCheck(doc: Pick<BackupDoc, "tables">): DrillCheck {
	const forbidden = Object.keys(doc.tables).filter((t) => !classifyTable(t).include);
	const badOptions = (doc.tables.options?.rows ?? []).filter((r) => !optionAllowed(String(r.name ?? ""), r.value)).length;
	const ok = !forbidden.length && !badOptions;
	return { id: "privacy", label: "No sign-in data, secrets, plugin settings or form messages", ok, detail: ok ? `${fmt(doc.tables.options?.rows.length ?? 0)} settings rows, all allowed` : `${forbidden.length} excluded table(s), ${badOptions} disallowed settings row(s)` };
}

/** Plugin data restored with the settings (counted by name prefix): change requests, the one allowed plugin's rows. */
export function pluginRows(doc: Pick<BackupDoc, "tables">): number {
	return (doc.tables.options?.rows ?? []).filter((r) => String(r.name ?? "").startsWith("plugin:")).length;
}

/** Checks a sample of the media files listed in the backup still exist in R2 (HEAD, same size). */
export async function sampleMedia(bucket: R2Like, doc: Pick<BackupDoc, "media" | "tables">, n: number, seed: string): Promise<{ check: DrillCheck; sampled: number; missing: number; used: number }> {
	const objects = doc.media?.objects ?? [];
	const pick = [...objects].sort((a, b) => hash32(`${seed}:${a.key}`) - hash32(`${seed}:${b.key}`)).slice(0, n);
	let missing = 0;
	for (const o of pick) {
		try {
			let size: number | undefined;
			if (bucket.head) size = (await bucket.head(o.key))?.size;
			else size = (await bucket.list({ prefix: o.key, limit: 1 })).objects.find((x) => x.key === o.key)?.size;
			if (size === undefined || size !== o.size) missing++;
		} catch {
			missing++;
		}
	}
	// Media records whose file is not in the manifest (only when the manifest is complete).
	const keys = new Set(objects.map((o) => o.key));
	const orphans = doc.media?.truncated ? 0 : (doc.tables.media?.rows ?? []).filter((r) => typeof r.storage_key === "string" && r.storage_key && !keys.has(r.storage_key)).length;
	const ok = missing === 0 && orphans === 0;
	const detail = !objects.length ? "no media files listed in the backup" : `${pick.length - missing}/${pick.length} sampled files found${orphans ? `; ${orphans} media record(s) point at a file not in the backup's list` : ""}`;
	return { check: { id: "media-files", label: "Media files exist in storage", ok, detail }, sampled: pick.length, missing, used: pick.length };
}

// ── The run (one cron tick, or the first slice of "Run restore test now") ────────────────────────────────────────

export interface DrillDeps extends RunDeps {
	/** The scratch database binding; undefined → dry run. */
	scratch?: ScratchDb;
	staging: boolean;
	/** Elapsed-time clock for the tick budget (default Date.now). */
	clock?: () => number;
}

export type DrillTick = { state: "skipped"; why: "off" | "staging" | "not-due" | "locked" | "no-backup" } | { state: "running"; mode: DrillMode; progress: { tables: number; of: number; rows: number } } | { state: "done"; result: DrillResult };

/** The newest full backup (not a one-entry pre-delete snapshot). */
export const latestFull = (list: BackupEntry[]) => [...list].filter((e) => e.trigger !== "pre-delete").sort((a, b) => (a.at < b.at ? 1 : -1))[0];

/**
 * Works on the restore test for one tick: starts it when due (or requested), continues a run in progress, finishes
 * it (checks, scratch emptied, result stored, alert on failure / recovery). Own lock; never throws.
 */
export async function drillTick(d: DrillDeps, o: { budget?: { ms: number; statements: number }; manual?: boolean } = {}): Promise<DrillTick> {
	const cfg = drillSettings(d.options);
	if (!cfg) return { state: "skipped", why: "off" };
	if (d.staging) return { state: "skipped", why: "staging" };
	const clock = d.clock ?? Date.now;
	const t0 = clock();
	const budget = o.budget ?? { ms: DRILL_TICK_MS, statements: DRILL_TICK_STATEMENTS };
	const deadline = t0 + budget.ms;
	const store0 = await readDrill(d.kv);
	if (!o.manual && !drillDue(d.now, store0, cfg, d.staging)) return { state: "skipped", why: "not-due" };
	if (!(await acquireLock(d.kv, d.now, DRILL_LOCK_MS, "restore-drill", KEYS.drillLock))) return { state: "skipped", why: "locked" };
	let store = await readDrill(d.kv);
	let run = store.running;
	let doc: BackupDoc | undefined;
	let checks: DrillCheck[] = [];
	try {
		if (run && d.now - Date.parse(run.startedAt) > DRILL_MAX_RUN_MS) {
			return { state: "done", result: await finish(d, store, run, [], false, "the restore test did not finish within a day", { tables: 0, rows: 0, media: { sampled: 0, missing: 0 } }) };
		}
		if (!run) {
			const entry = latestFull(await readIndex(d.kv));
			if (!entry) {
				if (store.requested) {
					const { requested: _q, ...rest } = store;
					await d.kv.set(KEYS.drill, rest);
				}
				return { state: "skipped", why: "no-backup" };
			}
			run = { startedAt: new Date(d.now).toISOString(), trigger: store.requested || o.manual ? "manual" : "schedule", ...(store.requested?.by ? { by: store.requested.by } : {}), mode: d.scratch ? "scratch" : "dry-run", backupId: entry.id, backupKey: entry.key, cursor: { table: 0, row: 0, prepared: false }, inserted: 0, ticks: 0 };
			const { requested: _r, ...rest } = store;
			store = { ...rest, running: run };
			await d.kv.set(KEYS.drill, store);
		}
		run = { ...run, ticks: run.ticks + 1 };
		const entry = (await readIndex(d.kv)).find((e) => e.id === run?.backupId) ?? ({ id: run.backupId, key: run.backupKey, at: "", trigger: "nightly", bytes: 0, counts: { entries: {}, menus: 0, menuItems: 0, redirects: 0, media: 0, mediaFiles: 0, settings: 0, sections: 0, taxonomies: 0, revisions: 0 } } as BackupEntry);
		const inspected = await inspectBackup(d.bucket, entry);
		checks = inspected.checks;
		doc = inspected.doc;
		const stats = (plan?: DrillPlan, media = { sampled: 0, missing: 0 }) => ({ tables: plan?.tables.length ?? 0, rows: plan?.rows ?? 0, media, backupAt: doc?.createdAt ?? entry.at });
		if (!doc || checks.some((c) => !c.ok)) return { state: "done", result: await finish(d, store, run, checks, false, checks.find((c) => !c.ok)?.detail ?? "the backup file cannot be read", stats()) };
		const live = await liveSchema(d.db);
		const plan = planDrill(doc, live);
		checks.push({ id: "schema", label: "Fits the live database schema", ok: !plan.problems.length, detail: plan.problems.length ? plan.problems.slice(0, 6).join("; ") : `${plan.tables.length} tables${plan.notes.length ? `; ${plan.notes.slice(0, 3).join("; ")}` : ""}` });
		checks.push(privacyCheck(doc));
		if (plan.problems.length || checks.some((c) => !c.ok)) {
			if (run.mode === "scratch" && run.cursor.prepared && d.scratch) await wipeScratch(d.scratch).catch(() => 0);
			return { state: "done", result: await finish(d, store, run, checks, false, checks.find((c) => !c.ok)?.detail ?? "the backup does not fit the site", stats(plan)) };
		}
		let used = 0;
		if (run.mode === "scratch") {
			const scratch = d.scratch;
			if (!scratch) {
				// The binding disappeared between ticks (redeploy without it): finish as a dry run.
				run = { ...run, mode: "dry-run" };
			} else {
				if (!run.cursor.prepared) {
					used += await prepareScratch(scratch, d.db, run.backupId, run.startedAt);
					const creates = plan.tables.map((t) => scratch.prepare(t.create));
					for (let i = 0; i < creates.length; i += BATCH_STATEMENTS) await exec(scratch, creates.slice(i, i + BATCH_STATEMENTS));
					used += creates.length;
					run = { ...run, cursor: { table: 0, row: 0, prepared: true } };
				}
				const slice = await replaySlice(scratch, doc, plan, run.cursor, Math.max(10, budget.statements - used - plan.tables.length - 10), deadline, clock);
				used += slice.used;
				run = { ...run, cursor: { ...slice.cursor, prepared: true }, inserted: run.inserted + slice.inserted };
				checks.push({ id: "replay", label: "Every row inserted into the scratch database", ok: true, detail: `${fmt(run.inserted)} rows in ${run.ticks} step(s)` });
				if (!slice.done) {
					await d.kv.set(KEYS.drill, { ...store, running: run });
					d.log?.info("restore test progress", { tables: slice.cursor.table, of: plan.tables.length, rows: run.inserted });
					return { state: "running", mode: "scratch", progress: { tables: slice.cursor.table, of: plan.tables.length, rows: run.inserted } };
				}
				const v = await verifyScratch(scratch, doc, plan, cfg.tolerancePct);
				checks.push(...v.checks);
			}
		}
		if (run.mode === "dry-run") checks.push({ id: "dry-run", label: "Every row checked against the live schema (dry run, nothing written)", ok: true, detail: `${fmt(plan.rows)} rows; no scratch database (${cfg.binding}) is bound to this site` });
		const plugin = pluginRows(doc);
		checks.push({ id: "plugin-data", label: "Allowed plugin data present", ok: true, detail: `${fmt(plugin)} plugin row(s) (change requests); plugin settings and form messages are never in a backup` });
		const media = await sampleMedia(d.bucket, doc, cfg.mediaSample, run.startedAt);
		checks.push(media.check);
		if (run.mode === "scratch" && d.scratch) {
			try {
				await wipeScratch(d.scratch);
				checks.push({ id: "wiped", label: "Scratch database emptied", ok: true });
			} catch (e) {
				checks.push({ id: "wiped", label: "Scratch database emptied", ok: false, detail: String((e as Error)?.message ?? e).slice(0, 160) });
			}
		}
		const ok = checks.every((c) => c.ok);
		return { state: "done", result: await finish(d, store, run, checks, ok, ok ? undefined : (checks.find((c) => !c.ok)?.detail ?? "a check failed"), stats(plan, { sampled: media.sampled, missing: media.missing })) };
	} catch (e) {
		const reason = `${(e as Error)?.name ?? "Error"}: ${String((e as Error)?.message ?? e).slice(0, 160)}`;
		if (run?.mode === "scratch" && run.cursor.prepared && d.scratch) await wipeScratch(d.scratch).catch(() => 0);
		if (!run) {
			d.log?.warn?.("restore test failed to start", { reason });
			return { state: "skipped", why: "no-backup" };
		}
		return { state: "done", result: await finish(d, store, run, [...checks, { id: "error", label: "Restore test ran to the end", ok: false, detail: reason }], false, reason, { tables: 0, rows: 0, media: { sampled: 0, missing: 0 } }) };
	} finally {
		await releaseLock(d.kv, KEYS.drillLock);
	}
}

async function finish(d: DrillDeps, store: DrillStore, run: DrillRun, checks: DrillCheck[], ok: boolean, reason: string | undefined, s: { tables: number; rows: number; media: { sampled: number; missing: number }; backupAt?: string }): Promise<DrillResult> {
	const result: DrillResult = {
		at: new Date(d.now).toISOString(),
		startedAt: run.startedAt,
		ok,
		mode: run.mode,
		trigger: run.trigger,
		...(run.by ? { by: run.by } : {}),
		backupId: run.backupId,
		...(s.backupAt ? { backupAt: s.backupAt } : {}),
		tables: s.tables,
		rows: s.rows,
		mediaSampled: s.media.sampled,
		mediaMissing: s.media.missing,
		ticks: run.ticks,
		checks,
		...(reason ? { reason: reason.slice(0, 200) } : {}),
	};
	const wasFailing = (store.failures ?? 0) > 0;
	const failures = ok ? 0 : (store.failures ?? 0) + 1;
	const history = [{ at: result.at, ok, mode: result.mode, rows: result.rows, tables: result.tables }, ...(store.history ?? [])].slice(0, HISTORY);
	const { running: _r, requested: _q, ...rest } = await readDrill(d.kv);
	await d.kv.set(KEYS.drill, { ...rest, last: result, failures, history });
	// Counts only.
	d.log?.info("restore test", { ok, mode: result.mode, tables: result.tables, rows: result.rows, mediaSampled: result.mediaSampled, mediaMissing: result.mediaMissing, ticks: result.ticks, ...(ok ? {} : { failed: checks.filter((c) => !c.ok).map((c) => c.id).join(",") }) });
	if (!ok && failures === 1) await drillAlert(d, result, false);
	if (ok && wasFailing) await drillAlert(d, result, true);
	return result;
}

/** One-line summary: "passed 2026-11-03, 1,234 rows across 38 tables, 12 media sampled". */
export function drillLine(r: DrillResult): string {
	return `${r.ok ? "passed" : "failed"} ${r.at.slice(0, 10)}, ${fmt(r.rows)} rows across ${fmt(r.tables)} tables, ${fmt(r.mediaSampled)} media sampled${r.mode === "dry-run" ? " (dry run)" : ""}`;
}

async function drillAlert(d: DrillDeps, r: DrillResult, recovery: boolean): Promise<void> {
	const settings = await settingsOf(d.kv);
	const blocked = alertBlocked(d.options, d.env, settings);
	if (blocked) return void d.log?.info("restore test alert not emailed", { why: blocked });
	const o = d.options;
	const subject = recovery ? `${o.siteName}: the restore test passes again` : `${o.siteName}: the backup restore test failed`;
	const failed = r.checks.filter((c) => !c.ok).map((c) => `${c.label}${c.detail ? ` (${c.detail})` : ""}`);
	const lines = recovery
		? [`The monthly restore test passed: the newest backup was restored ${r.mode === "scratch" ? "into the scratch database" : "as a dry run"} and checked (${drillLine(r)}).`, "Nothing else needs doing."]
		: [`The monthly restore test of the newest backup failed (${shortTime(r.at)}).`, ...failed.slice(0, 5).map((f) => `Failed: ${f}.`), "Backups are still being made, and the database can still be restored to any minute of the last 30 days (D1 Time Travel). The test is repeated tomorrow; please check the Backups page or ask your developer."];
	const sent = await sendMail(d.env, d.email, alertRecipients(settings, o), alertMail({ siteName: o.siteName, subject, lines, adminUrl: adminUrl(o), footer: o.footer ?? "Backups & Restore", recovery }));
	d.log?.info("restore test alert", { recovery, ok: sent.ok, ...(sent.ok ? {} : { why: sent.reason }) });
}

/** "Run restore test now": queues the test (rate-limited) and returns why not when it cannot. */
export async function requestDrill(kv: Kv, now: number, by?: string): Promise<{ ok: true } | { ok: false; why: "too-soon" | "running" }> {
	const s = await readDrill(kv);
	if (s.running) return { ok: false, why: "running" };
	if (s.manualAt && now - Date.parse(s.manualAt) < DRILL_MANUAL_EVERY) return { ok: false, why: "too-soon" };
	await kv.set(KEYS.drill, { ...s, requested: { at: new Date(now).toISOString(), ...(by ? { by: by.slice(0, 80) } : {}) }, manualAt: new Date(now).toISOString() });
	return { ok: true };
}
