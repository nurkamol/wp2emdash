/**
 * @wp2emdash/backups 0.2: the monthly restore test. The newest backup is restored into an empty scratch database (a
 * second node:sqlite database behind the D1 binding's shape), counted back and checked, media files sampled in R2, the
 * scratch database emptied; without that binding a dry run against the live schema. Schedule, its own lock, splitting
 * across ticks, the safety refusals, alerts, the admin button, Site health's view and the kit side (scaffold binding,
 * plugin options). No network: every request is mocked.
 */
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DRILL_MARKER, drillCron, drillDue, type DrillDeps, drillLine, drillSettings, type DrillStore, drillTick, inspectBackup, liveSchema, planDrill, prepareScratch, readDrill, replaySlice, requestDrill, type ScratchDb, verifyScratch, withinTolerance } from "../packages/backups/src/drill.js";
import type { BackupDoc, BackupEntry } from "../packages/backups/src/format.js";
import type { BackupsOptions } from "../packages/backups/src/index.js";
import { createPlugin, loadDoc } from "../packages/backups/src/plugin/index.js";
import { type RunDeps, runBackup } from "../packages/backups/src/run.js";
import { acquireLock, KEYS, readIndex } from "../packages/backups/src/store.js";
import { DAY, gzip } from "../packages/backups/src/util.js";
import { backupsCheck, readDrillSummary } from "../packages/health/src/checks/backups.js";
import { kitConfigSchema } from "../src/config/schema.js";
import { wranglerJsonc } from "../src/phases/scaffold.js";
import { backupsOptions } from "../src/scaffold/backups.js";
import { backupsDoc } from "../src/scaffold/client-repo.js";
import { d1, freshDb, memoryR2, SECRETS } from "./backups-fixtures.js";
import { memoryKv } from "./health-fixtures.js";
import { env } from "./stubs/cloudflare-workers.js";

type B = Record<string, any>;
const ORIGIN = "https://acme.example";
const OPTIONS: BackupsOptions = { productionUrl: ORIGIN, siteName: "Acme", live: true, alertsTo: ["team@agency.example"], database: "acme-db", footer: "Prepared by Example Agency" };
const T0 = Date.parse("2026-11-20T02:30:00Z");
const MEDIA_FILES = { "01abc.png": 1200, "02def.jpg": 800, "03ghi.webp": 640 };

let kv: ReturnType<typeof memoryKv>;
let bucket: ReturnType<typeof memoryR2>;
let sql: DatabaseSync;
let scratchSql: DatabaseSync;
const logs: unknown[] = [];
const log = { info: (m: string, d?: unknown) => void logs.push([m, d]), warn: (m: string, d?: unknown) => void logs.push([m, d]) };
const mails = () => (vi.mocked(fetch).mock.calls as unknown as [string, RequestInit][]).filter(([u]) => String(u).includes("brevo"));
const runDeps = (o: Partial<RunDeps> = {}): RunDeps => ({ kv, db: d1(sql), bucket, options: OPTIONS, env: { EMAIL_PROVIDER: "brevo", EMAIL_API_KEY: "xkeysib-test", FORM_FROM: "Acme <site@acme.example>" }, fetch: vi.fn(async () => new Response("", { status: 200 })), log, now: T0, ...o });
const drillDeps = (o: Partial<DrillDeps> = {}): DrillDeps => ({ ...runDeps(), scratch: d1(scratchSql), staging: false, now: T0 + HOURS(3), ...o });
const HOURS = (n: number) => n * 3_600_000;
const big = { budget: { ms: 60_000, statements: 10_000 } };
/** Every table and its row count: proof the live database was not written. */
const snapshot = (db: DatabaseSync) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(({ name }) => `${name}:${(db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number }).n}`);
const scratchTables = () => (scratchSql.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);

beforeEach(async () => {
	kv = memoryKv();
	bucket = memoryR2();
	sql = freshDb();
	scratchSql = new DatabaseSync(":memory:");
	logs.length = 0;
	for (const k of Object.keys(env)) delete env[k];
	vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ messageId: "x" }), { status: 201 })));
	for (const [key, size] of Object.entries(MEDIA_FILES)) await bucket.put(key, new Uint8Array(size));
});
afterEach(() => vi.unstubAllGlobals());

async function backup(): Promise<BackupEntry> {
	const r = await runBackup(runDeps(), "nightly");
	if (!r.ok) throw new Error(r.reason);
	return r.entry;
}

describe("schedule and settings", () => {
	const cfg = drillSettings(OPTIONS)!;
	it("monthly by default, after the nightly backup's hour, at minutes fixed per site; configurable or off", () => {
		expect(cfg).toMatchObject({ everyDays: 30, mediaSample: 12, tolerancePct: 0, binding: "RESTORE_DRILL_DB" });
		expect(cfg.hour).toBeGreaterThanOrEqual(3);
		expect(drillSettings({ ...OPTIONS, restoreDrill: { everyDays: 7, mediaSample: 3, hourUtc: 5 } })).toMatchObject({ everyDays: 7, mediaSample: 3, hour: 5 });
		expect(drillSettings({ ...OPTIONS, restoreDrill: false })).toBeUndefined();
		expect(drillCron("acme.example")).toMatch(/^(\d+),(\d+),(\d+),(\d+) \* \* \* \*$/);
		expect(drillCron("acme.example")).not.toBe(drillCron("other.example"));
	});
	it("due once the interval has passed and the hour has come; a failed test retried the next day; never on staging", () => {
		const day = Date.UTC(2026, 10, 20);
		const at = (h: number, d = 0) => day + d * DAY + HOURS(h);
		expect(drillDue(at(cfg.hour), {}, cfg, false)).toBe(true);
		expect(drillDue(at(cfg.hour - 1), {}, cfg, false)).toBe(false);
		expect(drillDue(at(cfg.hour), {}, cfg, true)).toBe(false);
		const passed: DrillStore = { last: { at: new Date(at(cfg.hour)).toISOString(), startedAt: new Date(at(cfg.hour)).toISOString(), ok: true } as never };
		expect(drillDue(at(cfg.hour, 1), passed, cfg, false)).toBe(false);
		expect(drillDue(at(cfg.hour, 29), passed, cfg, false)).toBe(false);
		expect(drillDue(at(cfg.hour, 30), passed, cfg, false)).toBe(true);
		const failed: DrillStore = { last: { ...passed.last, ok: false } as never };
		expect(drillDue(at(cfg.hour, 1), failed, cfg, false)).toBe(true);
		expect(drillDue(at(0, 1), { ...passed, requested: { at: "x" } }, cfg, false)).toBe(true);
		expect(drillDue(at(0, 1), { ...passed, running: {} as never }, cfg, false)).toBe(true);
		expect(drillDue(at(0, 1), { requested: { at: "x" } }, cfg, true)).toBe(false);
	});
	it("tolerance: a percentage of the expected rows, rounded down (0 = exact)", () => {
		expect(withinTolerance(100, 100, 0)).toBe(true);
		expect(withinTolerance(100, 99, 0)).toBe(false);
		expect(withinTolerance(100, 99, 1)).toBe(true);
		expect(withinTolerance(50, 49, 1)).toBe(false);
	});
});

describe("planning (the dry run's checks)", () => {
	it("creates each table with the live schema's columns, NOT NULL, defaults and primary key; no foreign keys; inserts within D1's 100 bound values", async () => {
		const doc = await loadDoc(bucket, await backup());
		const live = await liveSchema(d1(sql));
		const plan = planDrill(doc, live);
		expect(plan.problems).toEqual([]);
		expect(plan.tables.map((t) => t.name)).toEqual(Object.keys(doc.tables).sort());
		expect(plan.tables.find((t) => t.name === "ec_pages")).toMatchObject({ rows: 3, perStatement: 6, create: expect.stringContaining('PRIMARY KEY ("id")') });
		expect(plan.tables.every((t) => t.perStatement * t.columns.length <= 100)).toBe(true);
		expect(plan.tables.map((t) => t.create).join("\n")).not.toMatch(/REFERENCES/);
		expect(plan.rows).toBe(Object.values(doc.tables).reduce((n, t) => n + t.rows.length, 0));
	});
	it("finds what a restore would trip on: a required column missing, a repeated primary key, a live table missing, a table a backup must not hold", async () => {
		const doc = await loadDoc(bucket, await backup());
		const live = await liveSchema(d1(sql));
		const broken = structuredClone(doc) as BackupDoc;
		(broken.tables.ec_pages as B).rows.push({ ...(broken.tables.ec_pages as B).rows[0] });
		delete broken.tables._emdash_redirects;
		broken.tables.users = { columns: ["id", "email"], rows: [{ id: "u1", email: "x" }] };
		const withRequired = { ...live, tables: { ...live.tables, media: [...(live.tables.media ?? []), { name: "mime_type", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 }] } };
		const p = planDrill(broken, withRequired);
		expect(p.problems).toEqual(expect.arrayContaining(["ec_pages: 1 row(s) repeat a primary key", "_emdash_redirects: in the live database but not in the backup", "users: a table a backup must not hold", 'media: required column "mime_type" is missing from the backup']));
		// The schema moved on since the backup: a missing table is a note, not a failure.
		const drift = planDrill({ ...broken, tables: { ...doc.tables } }, { ...live, tables: { ...live.tables, _emdash_new: [] }, version: "093_next" });
		expect(drift.problems).toEqual([]);
		expect(drift.notes.join(" ")).toMatch(/schema changed since the backup \(092_plugin_kv_options → 093_next\)/);
	});
});

describe("restore into the scratch database", () => {
	it("restores every row of the newest backup, checks it against the backup's own counts, samples media, empties the scratch database — the live database is only read", async () => {
		const entry = await backup();
		const before = snapshot(sql);
		const r = await drillTick(drillDeps(), big);
		expect(r.state).toBe("done");
		const res = (r as { result: B }).result;
		expect(res).toMatchObject({ ok: true, mode: "scratch", trigger: "schedule", backupId: entry.id, mediaSampled: 3, mediaMissing: 0, ticks: 1 });
		expect(res.tables).toBe(Object.keys((await loadDoc(bucket, entry)).tables).length);
		expect(res.checks.map((c: B) => c.id)).toEqual(["checksum", "decompress", "manifest", "schema", "privacy", "replay", "tables", "rows", "entries", "media-records", "settings", "plugin-data", "media-files", "wiped"]);
		expect(res.checks.every((c: B) => c.ok)).toBe(true);
		expect(res.checks.find((c: B) => c.id === "entries").detail).toBe("pages: 3/3");
		expect(res.checks.find((c: B) => c.id === "checksum").detail).toBe("SHA-256 as recorded when stored");
		expect(drillLine(res as never)).toMatch(/^passed 2026-11-20, \d+ rows across \d+ tables, 3 media sampled$/);
		expect(snapshot(sql)).toEqual(before);
		expect(scratchTables()).toEqual([DRILL_MARKER]);
		expect((await readDrill(kv)).last).toMatchObject({ ok: true });
		expect((await readDrill(kv)).running).toBeUndefined();
		// Logs and the stored result: counts only — no content, no secrets.
		const out = JSON.stringify([logs, await readDrill(kv)]);
		for (const s of [...Object.values(SECRETS), "About us", "We teach Pilates", "Pilates in Houston"]) expect(out).not.toContain(s);
		expect(mails()).toHaveLength(0);
	});
	it("splits a run across ticks within the statement budget, under its own lock", async () => {
		const ins = sql.prepare("INSERT INTO _emdash_redirects (id, source, destination, type) VALUES (?, ?, ?, 301)");
		for (let i = 0; i < 600; i++) ins.run(`r-${i}`, `/old-${i}`, "/about");
		await backup();
		const states: string[] = [];
		for (let i = 0; i < 40; i++) {
			const r = await drillTick(drillDeps({ now: T0 + HOURS(3) + i * 900_000 }), { budget: { ms: 60_000, statements: 22 } });
			states.push(r.state);
			if (r.state === "done") {
				expect(r.result).toMatchObject({ ok: true, ticks: i + 1 });
				break;
			}
			expect(r).toMatchObject({ state: "running", mode: "scratch" });
		}
		expect(states.at(-1)).toBe("done");
		expect(states.length).toBeGreaterThan(2);
		expect(scratchTables()).toEqual([DRILL_MARKER]);
		// Held lock: the tick skips.
		await requestDrill(kv, T0 + DAY);
		await acquireLock(kv, T0 + DAY, 60_000, "other", KEYS.drillLock);
		expect(await drillTick(drillDeps({ now: T0 + DAY }), big)).toEqual({ state: "skipped", why: "locked" });
	});
	it("verifies row counts within the tolerance", async () => {
		const entry = await backup();
		const doc = await loadDoc(bucket, entry);
		const plan = planDrill(doc, await liveSchema(d1(sql)));
		const scratch: ScratchDb = d1(scratchSql);
		await prepareScratch(scratch, d1(sql), entry.id, "2026-11-20T00:00:00Z");
		for (const t of plan.tables) await scratch.prepare(t.create).run();
		expect((await replaySlice(scratch, doc, plan, { table: 0, row: 0 }, 10_000)).done).toBe(true);
		scratchSql.exec("DELETE FROM ec_pages WHERE id = 'p3'");
		const exact = await verifyScratch(scratch, doc, plan, 0);
		expect(exact.checks.find((c) => c.id === "rows")).toMatchObject({ ok: false, detail: "differ: ec_pages 2/3" });
		expect(exact.checks.find((c) => c.id === "entries")).toMatchObject({ ok: false, detail: "pages: 2/3" });
		expect((await verifyScratch(scratch, doc, plan, 50)).checks.find((c) => c.id === "rows")?.ok).toBe(true);
	});
	it("refuses to write into a database that is not its own: the live binding, or one holding tables without the test's marker", async () => {
		await backup();
		const before = snapshot(sql);
		const live = d1(sql);
		const r1 = await drillTick(drillDeps({ db: live, scratch: live as never }), big);
		expect(r1).toMatchObject({ state: "done", result: { ok: false, reason: expect.stringContaining("live database binding: nothing written") } });
		expect(snapshot(sql)).toEqual(before);
		scratchSql.exec("CREATE TABLE customers (id TEXT); INSERT INTO customers VALUES ('c1')");
		const r2 = await drillTick(drillDeps({ now: T0 + DAY + HOURS(3) }), big);
		expect(r2).toMatchObject({ state: "done", result: { ok: false, reason: expect.stringContaining("not empty (1 tables, no restore-test marker): nothing written") } });
		expect(scratchTables()).toEqual(["customers"]);
		expect(scratchSql.prepare("SELECT COUNT(*) AS n FROM customers").get()).toEqual({ n: 1 });
	});
});

describe("fallback: dry run without the scratch binding", () => {
	it("validates the backup against the live schema and samples media, writing nothing", async () => {
		await backup();
		const before = snapshot(sql);
		const r = await drillTick(drillDeps({ scratch: undefined }), big);
		expect(r).toMatchObject({ state: "done", result: { ok: true, mode: "dry-run", mediaSampled: 3 } });
		const res = (r as { result: B }).result;
		expect(res.checks.map((c: B) => c.id)).toEqual(["checksum", "decompress", "manifest", "schema", "privacy", "dry-run", "plugin-data", "media-files"]);
		expect(drillLine(res as never)).toMatch(/\(dry run\)$/);
		expect(snapshot(sql)).toEqual(before);
		expect(scratchTables()).toEqual([]);
	});
	it("skips with no backup yet, when off, and on staging", async () => {
		expect(await drillTick(drillDeps(), big)).toEqual({ state: "skipped", why: "no-backup" });
		expect(await drillTick(drillDeps({ options: { ...OPTIONS, restoreDrill: false } }), big)).toEqual({ state: "skipped", why: "off" });
		expect(await drillTick(drillDeps({ staging: true }), big)).toEqual({ state: "skipped", why: "staging" });
	});
});

describe("file checks, alerts", () => {
	it("a damaged file fails the checksum; one alert email, none on the next failure, one when it passes again", async () => {
		const entry = await backup();
		const stored = bucket.store.get(entry.key)!;
		const realBody = stored.body;
		stored.body = await gzip(JSON.stringify({ format: "wp2emdash-backup", version: 1, tables: {} }));
		const r1 = await drillTick(drillDeps(), big);
		expect(r1).toMatchObject({ state: "done", result: { ok: false, checks: [{ id: "checksum", ok: false }] } });
		expect(mails()).toHaveLength(1);
		const body = JSON.parse(String(mails()[0]?.[1].body));
		expect(body.subject).toBe("Acme: the backup restore test failed");
		expect(JSON.stringify(body)).toContain("Checksum matches");
		await drillTick(drillDeps({ now: T0 + DAY + HOURS(3) }), big);
		expect(mails()).toHaveLength(1);
		expect((await readDrill(kv)).failures).toBe(2);
		stored.body = realBody;
		const r3 = await drillTick(drillDeps({ now: T0 + 2 * DAY + HOURS(3) }), big);
		expect(r3).toMatchObject({ state: "done", result: { ok: true } });
		expect(mails()).toHaveLength(2);
		expect(JSON.parse(String(mails()[1]?.[1].body)).subject).toBe("Acme: the restore test passes again");
		expect((await readDrill(kv)).history?.map((h) => h.ok)).toEqual([true, false, false]);
	});
	it("a backup made before 0.2.0 (no checksum) is still read; damaged gzip and a missing file fail", async () => {
		const entry = await backup();
		const stored = bucket.store.get(entry.key)!;
		const { sha256: _s, ...meta } = stored.customMetadata!;
		stored.customMetadata = meta;
		const old = await inspectBackup(bucket, { ...entry, sha256: undefined } as BackupEntry);
		expect(old.checks.map((c) => [c.id, c.ok])).toEqual([["checksum", true], ["decompress", true], ["manifest", true]]);
		expect(old.checks[0]?.detail).toMatch(/before 0\.2\.0/);
		stored.body = new Uint8Array([1, 2, 3]);
		expect((await inspectBackup(bucket, { ...entry, sha256: undefined } as BackupEntry)).checks.at(-1)).toMatchObject({ id: "decompress", ok: false, detail: "the gzip data is damaged" });
		bucket.store.delete(entry.key);
		expect((await inspectBackup(bucket, entry)).checks.at(-1)).toMatchObject({ id: "file", ok: false });
	});
	it("a media file gone from storage fails the sample", async () => {
		await backup();
		bucket.store.delete("02def.jpg");
		const r = await drillTick(drillDeps(), big);
		expect(r).toMatchObject({ state: "done", result: { ok: false, mediaMissing: 1 } });
		expect((r as { result: B }).result.checks.find((c: B) => c.id === "media-files")).toMatchObject({ ok: false, detail: "2/3 sampled files found" });
		expect(scratchTables()).toEqual([DRILL_MARKER]);
	});
	it("never emails from staging or before go-live", async () => {
		const entry = await backup();
		bucket.store.get(entry.key)!.body = new Uint8Array([0]);
		await drillTick(drillDeps({ options: { ...OPTIONS, live: false } }), big);
		expect(mails()).toHaveLength(0);
	});
});

describe("Backups page and cron hook", () => {
	type Res = { blocks: B[]; toast?: { message: string; type: string } };
	const plugin = createPlugin(OPTIONS) as unknown as { hooks: Record<string, any>; routes: Record<string, { handler: (ctx: unknown) => Promise<any> }> };
	const cron = { tasks: [] as { name: string; schedule: string }[], schedule: vi.fn(async (name: string, o: { schedule: string }) => void cron.tasks.push({ name, schedule: o.schedule })), list: vi.fn(async () => cron.tasks) };
	const ctx = (input: unknown, role = 50) => ({ input, kv, cron, request: new Request(`${ORIGIN}/_emdash/api/plugins/site-backups/admin`), user: { id: "u1", name: "Admin", role }, log });
	const call = (input: unknown, role = 50) => plugin.routes.admin?.handler(ctx(input, role)) as Promise<Res>;
	const backupsTab = (r: Res) => (r.blocks.find((b) => b.type === "tab")?.panels as { label: string; blocks: B[] }[])[0]?.blocks ?? [];
	beforeEach(() => {
		cron.tasks = [];
		Object.assign(env, { DB: d1(sql), MEDIA: bucket, RESTORE_DRILL_DB: d1(scratchSql), EMAIL_PROVIDER: "brevo" });
	});

	it("Run restore test now (admins only, at most every 10 minutes) shows the result on the page", async () => {
		await backup();
		const first = await call({});
		expect(backupsTab(first).find((b) => b.type === "context" && /No restore test yet/.test(b.text))).toBeTruthy();
		expect(JSON.stringify(backupsTab(first))).toContain('"action_id":"drill-now"');
		const r = await call({ type: "block_action", action_id: "drill-now" });
		expect(r.toast).toMatchObject({ type: "success", message: expect.stringMatching(/^Restore test passed 20\d\d-\d\d-\d\d, \d+ rows across \d+ tables, 3 media sampled\.$/) });
		expect(backupsTab(r).find((b) => b.type === "banner" && /^Last restore test: passed/.test(b.title))).toBeTruthy();
		expect((await readDrill(kv)).last).toMatchObject({ trigger: "manual", by: "Admin", mode: "scratch" });
		const again = await call({ type: "block_action", action_id: "drill-now" });
		expect(again.toast).toMatchObject({ type: "info", message: expect.stringContaining("less than 10 minutes ago") });
		expect((await call({ type: "block_action", action_id: "drill-now" }, 40)).blocks[0]).toMatchObject({ title: "Admins only" });
		env.STAGING = "1";
		expect((await call({ type: "block_action", action_id: "drill-now" })).toast?.message).toContain("staging");
	});
	it("without the scratch binding the button runs the dry run; a failed test lists its checks", async () => {
		delete env.RESTORE_DRILL_DB;
		const entry = await backup();
		bucket.store.delete("03ghi.webp");
		const r = await call({ type: "block_action", action_id: "drill-now" });
		expect(r.toast).toMatchObject({ type: "error", message: expect.stringContaining("(dry run)") });
		expect(backupsTab(r).find((b) => b.block_id === "drill-checks")?.rows).toEqual(expect.arrayContaining([{ check: "Media files exist in storage", result: "Failed", detail: "2/3 sampled files found" }]));
		expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
	});
	it("the restore-drill task runs through EmDash's cron hook; the nightly task is unaffected", async () => {
		await plugin.hooks["plugin:install"]({}, { cron });
		expect(cron.tasks.map((t) => t.name)).toEqual(["nightly", "restore-drill"]);
		await backup();
		const hour = drillSettings(OPTIONS)!.hour;
		vi.useFakeTimers({ now: Date.UTC(2026, 10, 21, hour, 10) });
		try {
			await plugin.hooks.cron.handler({ name: "restore-drill" }, { kv, log });
			expect((await readDrill(kv)).last).toMatchObject({ ok: true, mode: "scratch", trigger: "schedule" });
			expect((await readIndex(kv)).length).toBe(1);
			// Staging: the task does nothing.
			await kv.delete(KEYS.drill);
			env.STAGING = "1";
			await plugin.hooks.cron.handler({ name: "restore-drill" }, { kv, log });
			expect((await readDrill(kv)).last).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});
	it("the private status route carries the last restore test (counts only)", async () => {
		await backup();
		await drillTick(drillDeps(), big);
		const s = await (plugin.routes.status as unknown as { handler: (c: unknown) => Promise<B> }).handler(ctx({}));
		expect(s.restoreTest).toMatchObject({ ok: true, mode: "scratch", mediaSampled: 3 });
	});
});

describe("Site health and the kit side", () => {
	it("Site health folds the last restore test into the Backups check (one SELECT of the plugin's KV row)", async () => {
		const at = "2026-11-20T12:00:00Z";
		const now = Date.parse(at);
		const beat = { status: 200, lastBackupAt: "2026-11-20T02:00:00Z", ok: true };
		const passed = { at: "2026-11-03T05:00:00Z", ok: true, mode: "scratch" as const, tables: 38, rows: 1234, mediaSampled: 12 };
		expect(backupsCheck(true, beat, at, now, passed)).toMatchObject({ status: "ok", detail: ["Last restore test: passed 2026-11-03, 1,234 rows across 38 tables, 12 media sampled."] });
		expect(backupsCheck(true, beat, at, now, { ...passed, ok: false, reason: "2/3 sampled files found" })).toMatchObject({ status: "warn", summary: "Backups run, but the last restore test failed (2026-11-03: 2/3 sampled files found). See Plugins → Backups." });
		expect(backupsCheck(true, beat, at, now, { ...passed, at: "2026-09-01T05:00:00Z" }).detail?.[1]).toMatch(/^No restore test for 80 days\.$/);
		expect(backupsCheck(true, beat, at, now, null)).toEqual(backupsCheck(true, beat, at, now));
		expect(backupsCheck(false, undefined, at, now, passed).status).toBe("off");
		// Read from D1: the row EmDash's plugin KV writes (`plugin:site-backups:drill`).
		expect(await readDrillSummary(d1(sql))).toBeNull();
		sql.prepare("INSERT INTO options (name, value) VALUES (?, ?)").run("plugin:site-backups:drill", JSON.stringify({ last: { ...passed, checks: [{ id: "x", label: "y", ok: true }] }, history: [] }));
		expect(await readDrillSummary(d1(sql))).toEqual(passed);
		expect(await readDrillSummary(undefined)).toBeUndefined();
	});
	it("scaffold binds RESTORE_DRILL_DB in production only once provision recorded it (else the plugin runs the dry run)", () => {
		const config = kitConfigSchema.parse({ slug: "acme", name: "Acme", source: { url: ORIGIN }, target: { productionUrl: ORIGIN }, email: { to: ["owner@acme.example"], stagingTo: ["team@agency.example"] } });
		const base = { config, workerName: "acme", compatibilityDate: "2026-11-12", staging: false, sandboxedEnvs: [], seoPanel: false, health: false, backups: true, restoreDrill: true, productionHost: "acme.example" };
		const recorded = { production: { d1: { name: "acme-db", id: "d1-prod" }, restoreDrill: { name: "acme-restore-drill-db", id: "d1-drill" } }, staging: { d1: { name: "acme-staging-db", id: "d1-stg" } } };
		expect(wranglerJsonc({ ...base, cf: recorded })).toContain('"d1_databases": [{"binding":"DB","database_name":"acme-db","database_id":"d1-prod"}, {"binding":"RESTORE_DRILL_DB","database_name":"acme-restore-drill-db","database_id":"d1-drill"}]');
		// No id recorded: no binding (Wrangler would auto-provision a database for a binding without an id).
		expect(wranglerJsonc({ ...base, cf: { production: { d1: { name: "acme-db", id: "d1-prod" } } } })).not.toContain("RESTORE_DRILL_DB");
		expect(wranglerJsonc({ ...base, restoreDrill: false, cf: recorded })).not.toContain("RESTORE_DRILL_DB");
		expect(wranglerJsonc({ ...base, backups: false, cf: recorded })).not.toContain("RESTORE_DRILL_DB");
		// Staging never gets it.
		const staged = wranglerJsonc({ ...base, staging: true, cf: recorded });
		expect(staged.match(/RESTORE_DRILL_DB/g)).toHaveLength(1);
		expect(staged.split('"env"')[1]).not.toContain("RESTORE_DRILL_DB");
		expect(backupsOptions({ config, productionUrl: ORIGIN, live: true })?.restoreDrill).toEqual({ everyDays: 30, mediaSample: 12, tolerancePct: 0, binding: "RESTORE_DRILL_DB" });
		expect(backupsOptions({ config: kitConfigSchema.parse({ ...config, backups: { restoreDrill: false } }), productionUrl: ORIGIN, live: true })?.restoreDrill).toBe(false);
		// The client repo's backups doc explains the test only when it is on.
		const docOn = backupsDoc({ alertsTo: [], daily: 30, monthly: 12, offsite: false, restoreTestDays: 30 }, { productionUrl: ORIGIN });
		expect(docOn).toContain("## Restore test");
		expect(docOn).toContain("Every 30 days the site proves its newest backup can really be restored");
		expect(backupsDoc({ alertsTo: [], daily: 30, monthly: 12, offsite: false }, { productionUrl: ORIGIN })).not.toContain("## Restore test");
	});
});
