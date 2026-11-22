/**
 * @wp2emdash/backups: the backup file (allowlist, no secrets), retention, single flight, one-time downloads, the restore
 * planner and its writes through EmDash's API, alerts, pre-delete snapshots and the off-site copy; and the kit side —
 * kit.config, scaffold options and binding, client docs, dashboard secrets, verify, backup markers and Site health's
 * Backups check. A real SQLite database (node:sqlite) stands in for D1; every request is mocked.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BackupDoc, type BackupEntry, classifyTable, EXCLUDED_TABLES, isBackupKey, optionAllowed } from "../packages/backups/src/format.js";
import { backupsPlugin, type BackupsOptions } from "../packages/backups/src/index.js";
import { createPlugin, loadDoc } from "../packages/backups/src/plugin/index.js";
import { applyEntry, applyMenus, emdashApi, entryOf, menusOf, planEntry, planMenus, planSettings } from "../packages/backups/src/restore.js";
import { nightly, prune, rebuildIndex, type RunDeps, runBackup, snapshotEntry } from "../packages/backups/src/run.js";
import { offsiteUrl, putOffsite, signV4 } from "../packages/backups/src/s3.js";
import { cronSchedule, nightlyDue, nightlyHour, planRetention } from "../packages/backups/src/schedule.js";
import { acquireLock, KEYS, readIndex, readStatus } from "../packages/backups/src/store.js";
import { drillCron } from "../packages/backups/src/drill.js";
import { gunzip } from "../packages/backups/src/util.js";
import { backupsCheck } from "../packages/health/src/checks/backups.js";
import { kitConfigSchema } from "../src/config/schema.js";
import { wranglerJsonc } from "../src/phases/scaffold.js";
import { backupsOptions } from "../src/scaffold/backups.js";
import { backupsDoc } from "../src/scaffold/client-repo.js";
import { markerKey, writeBackupMarker } from "../src/targets/backup-marker.js";
import { guardLiveProductionWrite, preChangeMarker } from "../src/targets/d1-backup.js";
import { SECRET_KEYS } from "../src/ui/secrets.js";
import { backupsHeartbeat } from "../src/verify/backups.js";
import { d1, freshDb, memoryR2, SECRETS } from "./backups-fixtures.js";
import { memoryKv } from "./health-fixtures.js";
import { env } from "./stubs/cloudflare-workers.js";

type B = Record<string, any>;
const ORIGIN = "https://acme.example";
const OPTIONS: BackupsOptions = { productionUrl: ORIGIN, siteName: "Acme", live: true, alertsTo: ["team@agency.example"], database: "acme-db", footer: "Prepared by Example Agency" };
const T0 = Date.parse("2026-11-20T02:30:00Z");

let kv: ReturnType<typeof memoryKv>;
let bucket: ReturnType<typeof memoryR2>;
let sql: ReturnType<typeof freshDb>;
const logs: unknown[] = [];
const log = { info: (m: string, d?: unknown) => void logs.push([m, d]), warn: (m: string, d?: unknown) => void logs.push([m, d]) };
const deps = (o: Partial<RunDeps> = {}): RunDeps => ({ kv, db: d1(sql), bucket, options: OPTIONS, env: { EMAIL_PROVIDER: "brevo", EMAIL_API_KEY: "xkeysib-test", FORM_FROM: "Acme <site@acme.example>" }, fetch: vi.fn(async () => new Response("", { status: 200 })), log, now: T0, ...o });
const docOf = async (e: BackupEntry) => loadDoc(bucket, e);

beforeEach(() => {
	kv = memoryKv();
	bucket = memoryR2();
	sql = freshDb();
	logs.length = 0;
	for (const k of Object.keys(env)) delete env[k];
	vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ messageId: "x" }), { status: 201 })));
});
afterEach(() => vi.unstubAllGlobals());

describe("the backup file", () => {
	it("classifies every table: content and site structure in, auth, secrets and personal data out, new tables listed", () => {
		expect(classifyTable("ec_pages").include).toBe(true);
		for (const t of ["_emdash_menus", "_emdash_menu_items", "_emdash_redirects", "_emdash_sections", "_emdash_seo", "taxonomies", "_emdash_bylines", "media", "revisions", "options"]) expect(classifyTable(t).include).toBe(true);
		for (const t of ["users", "credentials", "auth_tokens", "auth_challenges", "_emdash_api_tokens", "_emdash_oauth_tokens", "_emdash_device_codes", "_plugin_storage", "_emdash_comments", "audit_logs", "_emdash_transfer_operations", "_emdash_media_usage_work"]) expect(classifyTable(t).include).toBe(false);
		expect(classifyTable("_emdash_future_feature")).toEqual({ include: false, why: expect.stringContaining("not classified") });
		expect(optionAllowed("site:title", '"x"')).toBe(true);
		expect(optionAllowed("emdash:site_title", '"x"')).toBe(true);
		for (const k of ["plugin:forms:apiKey", "emdash:preview_secret", "emdash:passkey_pending:1", "emdash:setup_complete"]) expect(optionAllowed(k, '"x"')).toBe(false);
		expect(optionAllowed("site:sneaky", JSON.stringify({ $emdash: "plugin-setting", data: "x" }))).toBe(false);
	});

	it("holds content, menus, settings, redirects and a media manifest — and never auth data, tokens, secrets, plugin data, comments or form messages", async () => {
		await bucket.put("01abc.png", new Uint8Array([1, 2, 3]));
		await bucket.put("backups/emdash-backup-x.json", "{}");
		await bucket.put("transfers/staged/x", "x");
		const r = await runBackup(deps({ env: { BACKUP_S3_ACCESS_KEY_ID: SECRETS.s3KeyId, BACKUP_S3_SECRET_ACCESS_KEY: SECRETS.s3Secret } }), "nightly");
		expect(r.ok).toBe(true);
		const entry = (r as { entry: BackupEntry }).entry;
		expect(isBackupKey(entry.key)).toBe(true);
		expect(entry.key).toMatch(/^backups\/2026-11-20\/023000-nightly-[0-9a-f]{8}\.json\.gz$/);
		const raw = await gunzip((bucket.store.get(entry.key) as { body: Uint8Array<ArrayBuffer> }).body);
		const doc = JSON.parse(raw) as BackupDoc;
		expect(doc).toMatchObject({ format: "wp2emdash-backup", version: 1, trigger: "nightly", site: { name: "Acme", url: ORIGIN }, schema: "092_plugin_kv_options", timeTravel: { timestamp: "2026-11-20T02:30:00.000Z", command: "npx wrangler d1 time-travel restore acme-db --timestamp=2026-11-20T02:30:00.000Z" } });
		// Drafts and the trash are in.
		expect(doc.tables.ec_pages?.rows.map((x) => x.id)).toEqual(["p1", "p2", "p3"]);
		expect(doc.counts).toMatchObject({ entries: { pages: 3 }, menus: 1, menuItems: 3, redirects: 1, media: 1, mediaFiles: 1 });
		expect(doc.media.objects.map((o) => o.key)).toEqual(["01abc.png"]);
		expect(doc.media.objects[0]).toMatchObject({ size: 3, etag: expect.any(String) });
		expect(doc.tables.options?.rows.map((x) => x.name).sort()).toEqual(["emdash:site_title", "site:logo", "site:seo", "site:social", "site:staging", "site:tagline", "site:title", "site:url"]);
		// Nothing silently dropped: every table not in the file is listed with a reason.
		const skipped = Object.fromEntries(doc.skipped.map((s) => [s.table, s.why]));
		for (const t of ["users", "credentials", "auth_tokens", "_emdash_api_tokens", "_emdash_oauth_tokens", "_plugin_storage", "_emdash_comments", "audit_logs", "_emdash_cron_tasks", "_emdash_future_feature"]) expect(skipped[t]).toBeTruthy();
		for (const t of Object.keys(EXCLUDED_TABLES)) expect(doc.tables[t]).toBeUndefined();
		// The proof: no sentinel secret anywhere in the file, the stored list, the logs or the R2 metadata.
		const everywhere = [raw, JSON.stringify([...kv.store.entries()]), JSON.stringify(logs), JSON.stringify([...bucket.store.values()].map((v) => v.customMetadata))].join("\n");
		for (const [k, v] of Object.entries(SECRETS)) expect(everywhere, k).not.toContain(v);
	});

	it("can be rebuilt into the list from the bucket alone (custom metadata) when the plugin KV is lost", async () => {
		await runBackup(deps(), "nightly");
		const list = await rebuildIndex(bucket);
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({ trigger: "nightly", at: "2026-11-20T02:30:00.000Z" });
		expect(list[0]?.id).toMatch(/^2026-11-20-023000-[0-9a-f]{8}$/);
	});
});

describe("retention", () => {
	const mk = (at: string, trigger: BackupEntry["trigger"] = "nightly"): BackupEntry => ({ id: `${at}-${trigger}`, key: `backups/${at.slice(0, 10)}/000000-${trigger}-00000000.json.gz`, at, trigger, bytes: 10, counts: { entries: {}, menus: 0, menuItems: 0, redirects: 0, media: 0, mediaFiles: 0, settings: 0, sections: 0, taxonomies: 0, revisions: 0 } });
	const days = (n: number, from = Date.parse("2026-11-20T02:00:00Z")) => Array.from({ length: n }, (_, i) => mk(new Date(from - i * 86_400_000).toISOString()));

	it("keeps the last 30 days and the first backup of each of the last 12 months", () => {
		const all = days(500);
		const { keep, drop } = planRetention(all, Date.parse("2026-11-20T03:00:00Z"));
		const daily = keep.filter((e) => e.at >= "2026-10-22");
		expect(daily).toHaveLength(30);
		const older = keep.filter((e) => e.at < "2026-10-22").map((e) => e.at.slice(0, 10));
		expect(older).toEqual(["2026-10-01", "2026-09-01", "2026-08-01", "2026-07-01", "2026-06-01", "2026-05-01", "2026-04-01", "2026-03-01", "2026-02-01", "2026-01-01", "2025-12-01"]);
		expect(keep.length + drop.length).toBe(500);
		expect(keep).toHaveLength(41);
	});
	it("is configurable, keeps the newest full backup, and never keeps a pre-delete snapshot as a month", () => {
		const all = [mk("2026-08-01T01:00:00Z", "pre-delete"), mk("2026-08-02T02:00:00Z"), mk("2026-07-15T02:00:00Z")];
		const { keep } = planRetention(all, Date.parse("2026-11-20T03:00:00Z"), { daily: 7, monthly: 2 });
		expect(keep.map((e) => e.at.slice(0, 10))).toEqual(["2026-08-02", "2026-07-15"]);
		expect(planRetention(all, Date.parse("2026-11-20T03:00:00Z"), { daily: 7, monthly: 0 }).keep.map((e) => e.at.slice(0, 10))).toEqual(["2026-08-02"]);
	});
	it("deletes pruned files from R2 and the list", async () => {
		const d = deps();
		for (const e of days(40)) {
			await bucket.put(e.key, "x");
			await kv.set(KEYS.index, [...(await readIndex(kv)), e]);
		}
		// 40 nightly backups (Oct 12 – Nov 20): the last 30 days stay, plus Oct 12 as October's first.
		expect(await prune(d)).toBe(9);
		expect(await readIndex(kv)).toHaveLength(31);
		expect(bucket.store.size).toBe(31);
	});
});

describe("schedule, single flight, alerts", () => {
	it("runs once a night from the site's hour, staggered per site, retried hourly up to 4 times", () => {
		expect(cronSchedule("acme.example")).toMatch(/^\d{1,2} \* \* \* \*$/);
		expect(cronSchedule("acme.example")).not.toBe(cronSchedule("other.example"));
		const h = nightlyHour("acme.example");
		expect(h).toBeGreaterThanOrEqual(1);
		expect(h).toBeLessThanOrEqual(3);
		expect(nightlyHour("acme.example", 5)).toBe(5);
		const at = (hh: number) => Date.UTC(2026, 10, 20, hh, 10);
		expect(nightlyDue(at(h - 1), { failures: 0 }, h)).toBe(false);
		expect(nightlyDue(at(h), { failures: 0 }, h)).toBe(true);
		expect(nightlyDue(at(h + 1), { failures: 0, nightlyDay: "2026-11-20" }, h)).toBe(false);
		expect(nightlyDue(at(h + 1), { failures: 2, attempts: { day: "2026-11-20", n: 4 } }, h)).toBe(false);
	});
	it("is single flight: a held lock refuses a second run; Back up now at most every 2 minutes", async () => {
		expect(await acquireLock(kv, T0, 60_000, "test")).toBe(true);
		expect(await runBackup(deps(), "manual")).toEqual({ ok: false, skipped: "locked" });
		await kv.delete(KEYS.lock);
		const [a, b] = await Promise.all([runBackup(deps(), "nightly"), runBackup(deps(), "nightly")]);
		expect([a.ok, b.ok].sort()).toEqual([false, true]);
		expect((await runBackup(deps(), "manual")).ok).toBe(true);
		expect(await runBackup(deps({ now: T0 + 60_000 }), "manual")).toEqual({ ok: false, skipped: "too-soon" });
		expect((await kv.get(KEYS.lock))).toBeNull();
	});
	it("emails one alert after two failed nightly attempts in a row, and one when it works again", async () => {
		let broken = true;
		const failing = () => deps({ db: d1(sql, { fail: () => broken }) });
		const mail = vi.mocked(fetch);
		const r1 = await runBackup({ ...failing(), now: T0 }, "nightly");
		expect(r1).toMatchObject({ ok: false, reason: expect.stringContaining("database unavailable") });
		expect(mail).not.toHaveBeenCalled();
		await runBackup({ ...failing(), now: T0 + 3_600_000 }, "nightly");
		expect(mail).toHaveBeenCalledTimes(1);
		expect(String((mail.mock.calls[0]?.[1] as RequestInit).body)).toContain("the nightly backup failed");
		await runBackup({ ...failing(), now: T0 + 7_200_000 }, "nightly");
		expect(mail).toHaveBeenCalledTimes(1);
		expect(await readStatus(kv)).toMatchObject({ failures: 3, attempts: { day: "2026-11-20", n: 3 }, alertedDay: "2026-11-20" });
		broken = false;
		expect((await runBackup({ ...failing(), now: T0 + 10_800_000 }, "nightly")).ok).toBe(true);
		expect(mail).toHaveBeenCalledTimes(2);
		expect(String((mail.mock.calls[1]?.[1] as RequestInit).body)).toContain("backups work again");
		expect(await readStatus(kv)).toMatchObject({ failures: 0, nightlyDay: "2026-11-20" });
		expect(await nightly({ ...deps(), now: T0 + 14_400_000 })).toEqual({ ok: false, skipped: "not-due" });
	});
	it("never emails before go-live or from staging", async () => {
		const d = deps({ db: d1(sql, { fail: () => true }), options: { ...OPTIONS, live: false } });
		await runBackup(d, "nightly");
		await runBackup({ ...d, now: T0 + 1 }, "nightly");
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("pre-delete snapshot", () => {
	it("keeps one entry (with its SEO row and field list) before it goes to the trash, restorable like any backup", async () => {
		const e = await snapshotEntry(deps(), "pages", "p1");
		expect(e).toMatchObject({ trigger: "pre-delete", counts: { entries: { pages: 1 } } });
		const doc = await docOf(e as BackupEntry);
		expect(entryOf(doc, "pages", "p1").row?.title).toBe("About us");
		expect(entryOf(doc, "pages", "p1").seo?.seo_title).toBe("About Acme");
		expect(await snapshotEntry(deps(), "pages", "nope")).toBeUndefined();
		expect(await snapshotEntry(deps(), "../users", "x")).toBeUndefined();
	});
});

describe("restore planner", () => {
	it("settings: shows each change, never restores the site address or the staging switch", () => {
		const backup = { title: "Acme Studio", tagline: "Old tagline", url: "https://old.example", staging: true, logo: { mediaId: "med1" }, seo: { titleSeparator: "|" } };
		const now = { title: "Acme Studio", tagline: "New tagline", url: "https://acme.example", staging: false, favicon: { mediaId: "fav" }, seo: { titleSeparator: "-", googleVerification: "g" } };
		const p = planSettings(backup, now);
		expect(p.changes).toEqual([
			{ what: "favicon", now: '{"mediaId":"fav"}', backup: "—" },
			{ what: "logo", now: "—", backup: '{"mediaId":"med1"}' },
			{ what: "seo.titleSeparator", now: "-", backup: "|" },
			{ what: "tagline", now: "New tagline", backup: "Old tagline" },
		]);
		expect(p.payload).toEqual({ title: "Acme Studio", tagline: "Old tagline", logo: { mediaId: "med1" }, favicon: null, seo: { titleSeparator: "|" } });
		expect(p.payload).not.toHaveProperty("url");
		expect(p.payload).not.toHaveProperty("staging");
		expect(p.notes.join(" ")).toMatch(/url is not restored/);
		expect(p.notes.join(" ")).toMatch(/staging is not restored/);
		expect(p.notes.join(" ")).toMatch(/seo.googleVerification is kept/);
		expect(planSettings(backup, { ...backup }).changes).toEqual([]);
	});
	it("menus: lists items that come back and go, in tree order", async () => {
		const r = await runBackup(deps(), "manual");
		const doc = await docOf((r as { entry: BackupEntry }).entry);
		sql.exec("DELETE FROM _emdash_menu_items WHERE id = 'mi2'; INSERT INTO _emdash_menu_items (id, menu_id, sort_order, type, custom_url, label) VALUES ('mi9', 'mn1', 2, 'custom', '/shop', 'Shop'); INSERT INTO _emdash_menus (id, name, label) VALUES ('mn2', 'footer', 'Footer');");
		const now = { menus: sql.prepare("SELECT * FROM _emdash_menus").all() as B[], items: sql.prepare("SELECT * FROM _emdash_menu_items").all() as B[] };
		const p = planMenus(menusOf(doc), now);
		expect(p.changes).toHaveLength(1);
		expect(p.changes[0]?.backup).toContain("comes back: Contact → /contact");
		expect(p.changes[0]?.now).toContain("goes: Shop → /shop");
		expect(p.notes).toEqual(['Menu "Footer" is not in the backup: it is left as it is.']);
	});
	it("an entry: field changes, trash, fields that no longer exist, status", async () => {
		const r = await runBackup(deps(), "manual");
		const doc = await docOf((r as { entry: BackupEntry }).entry);
		const b = entryOf(doc, "pages", "p1");
		const now = { row: { ...b.row, title: "About", deleted_at: "2026-11-21T00:00:00Z", status: "draft" }, fields: ["title", "body"] };
		const p = planEntry(b, now);
		expect(p.changes.map((c) => c.what)).toEqual(["trash", "title", "SEO title", "SEO description", "status"]);
		expect(p.notes.join(" ")).toContain('Field "hero" no longer exists');
		expect(p.write).toMatchObject({ slug: "about", publish: true, fromTrash: true, create: false, data: { title: "About us", body: [{ _type: "block", children: [{ text: "We teach pottery." }] }] } });
		expect(p.write?.data).not.toHaveProperty("hero");
		expect(planEntry(b, { fields: ["title", "body", "hero"] }).write).toMatchObject({ create: true });
		expect(planEntry({}, { fields: [] }).changes).toEqual([]);
	});
});

describe("restore writes go through EmDash's API as the admin", () => {
	const calls: { method: string; path: string; body?: unknown; cookie: string | null; csrf: string | null }[] = [];
	const selfApi = (fail?: (method: string, path: string) => boolean) =>
		vi.fn(async (req: Request) => {
			const u = new URL(req.url);
			const path = `${u.pathname.replace("/_emdash/api", "")}${u.search}`;
			calls.push({ method: req.method, path, ...(req.method !== "GET" && req.method !== "DELETE" ? { body: await req.json().catch(() => undefined) } : {}), cookie: req.headers.get("cookie"), csrf: req.headers.get("x-emdash-request") });
			if (fail?.(req.method, path)) return Response.json({ success: false, error: { code: "BOOM", message: "nope" } }, { status: 500 });
			if (req.method === "GET") return Response.json({ success: true, data: { item: { id: "p1" }, _rev: "rev-7" } });
			if (path.includes("/items")) return Response.json({ success: true, data: { id: `new-${calls.length}` } }, { status: 201 });
			return Response.json({ success: true, data: {} });
		});
	beforeEach(() => void (calls.length = 0));

	it("an entry: out of the trash, saved with the current revision, published again; cookie and CSRF header forwarded", async () => {
		const api = emdashApi({ self: selfApi(), origin: ORIGIN, cookie: "astro-session=abc" });
		await applyEntry(api, "pages", "p1", { data: { title: "About us" }, slug: "about", seo: { title: "About Acme" }, publish: true, fromTrash: true, create: false });
		expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /content/pages/p1/restore", "GET /content/pages/p1", "PUT /content/pages/p1", "POST /content/pages/p1/publish"]);
		expect(calls[2]?.body).toEqual({ data: { title: "About us" }, slug: "about", seo: { title: "About Acme" }, _rev: "rev-7" });
		expect(calls.every((c) => c.cookie === "astro-session=abc" && c.csrf === "1")).toBe(true);
	});
	it("menus: adds the backup's items (parents first), then removes the old ones; a failure while adding takes the added items back out", async () => {
		const r = await runBackup(deps(), "manual");
		const doc = await docOf((r as { entry: BackupEntry }).entry);
		const now = { menus: [{ id: "mn1", name: "primary", label: "Main menu", locale: "en" }], items: [{ id: "old1", menu_id: "mn1", sort_order: 0, type: "custom", custom_url: "/x", label: "X" }] };
		const res = await applyMenus(emdashApi({ self: selfApi(), origin: ORIGIN }), menusOf(doc), now);
		expect(res).toEqual({ added: 3, removed: 1 });
		expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /menus/primary/items?locale=en", "POST /menus/primary/items?locale=en", "POST /menus/primary/items?locale=en", "DELETE /menus/primary/items/old1?locale=en"]);
		const team = calls.find((c) => (c.body as B)?.label === "Team");
		const about = calls.findIndex((c) => (c.body as B)?.label === "About");
		expect((team?.body as B).parentId).toBe(`new-${about + 1}`);
		calls.length = 0;
		let n = 0;
		await expect(applyMenus(emdashApi({ self: selfApi((m, p) => m === "POST" && p.includes("/items") && ++n === 3), origin: ORIGIN }), menusOf(doc), now)).rejects.toThrow(/BOOM/);
		expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual(["/menus/primary/items/new-2?locale=en", "/menus/primary/items/new-1?locale=en"]);
	});
});

describe("Backups plugin (routes)", () => {
	type Res = { blocks: B[]; toast?: { message: string; type: string } };
	const plugin = createPlugin(OPTIONS) as unknown as { id: string; capabilities: string[]; hooks: Record<string, any>; admin: { pages: { path: string; icon: string }[] }; routes: Record<string, { permission?: string; public?: boolean; methods?: string[]; response?: string; handler: (ctx: unknown) => Promise<any> }> };
	const cron = { tasks: [] as { name: string; schedule: string }[], schedule: vi.fn(async (name: string, o: { schedule: string }) => void cron.tasks.push({ name, schedule: o.schedule })), list: vi.fn(async () => cron.tasks) };
	const apiCalls: string[] = [];
	const ctx = (input: unknown, role = 50) => ({ input, kv, cron, request: new Request(`${ORIGIN}/_emdash/api/plugins/site-backups/admin`, { headers: { cookie: "astro-session=s1" } }), user: { id: "u1", name: "Admin", role }, log });
	const call = (input: unknown, role = 50) => plugin.routes.admin?.handler(ctx(input, role)) as Promise<Res>;
	const tab = (r: Res, name: string) => (r.blocks.find((b) => b.type === "tab")?.panels as { label: string; blocks: B[] }[]).find((p) => p.label === name)?.blocks ?? [];
	const btn = (blocks: B[], action: string) => blocks.flatMap((b) => [...(b.elements ?? []), ...(b.rows ?? []).flatMap((r: B) => Object.values(r))]).find((e: B) => e?.action_id === action) as B | undefined;

	beforeEach(() => {
		cron.tasks = [];
		apiCalls.length = 0;
		Object.assign(env, {
			DB: d1(sql),
			MEDIA: bucket,
			EMAIL_PROVIDER: "brevo",
			SELF: {
				fetch: vi.fn(async (req: Request) => {
					apiCalls.push(`${req.method} ${new URL(req.url).pathname}`);
					return req.method === "GET" ? Response.json({ success: true, data: { item: {}, _rev: "r1" } }) : Response.json({ success: true, data: {} });
				}),
			},
		});
	});

	it("is a native plugin: a page, an hourly task, a delete hook, admin-only routes and two public ones", async () => {
		expect(backupsPlugin(OPTIONS)).toMatchObject({ id: "site-backups", format: "native", entrypoint: "@wp2emdash/backups/plugin" });
		expect(plugin.capabilities).toEqual(["content:read", "email:send"]);
		expect(plugin.admin.pages[0]).toMatchObject({ path: "/backups", icon: "history" });
		expect(plugin.routes.admin?.permission).toBe("plugins:manage");
		expect(plugin.routes.download).toMatchObject({ public: true, methods: ["GET"], response: "raw" });
		expect(plugin.routes.heartbeat).toMatchObject({ public: true, methods: ["GET"] });
		expect(plugin.hooks["content:beforeDelete"].timeout).toBeLessThanOrEqual(5_000);
		await plugin.hooks["plugin:install"]({}, { cron });
		await plugin.hooks["plugin:activate"]({}, { cron });
		expect(cron.tasks).toEqual([{ name: "nightly", schedule: cronSchedule("acme.example") }, { name: "restore-drill", schedule: drillCron("acme.example") }]);
		expect((await call({}, 40)).blocks[0]).toMatchObject({ type: "banner", title: "Admins only" });
	});

	it("Back up now, then a one-time download link that works once", async () => {
		const first = await call({});
		expect(tab(first, "Backups")[0]).toMatchObject({ title: "No backup yet" });
		const made = await call({ type: "block_action", action_id: "backup-now" });
		expect(made.toast).toMatchObject({ type: "success" });
		const [entry] = await readIndex(kv);
		expect(entry).toMatchObject({ trigger: "manual", by: "Admin" });
		const dl = await call({ type: "block_action", action_id: "download", value: entry?.id });
		const link = tab(dl, "Backups").flatMap((b) => b.elements ?? []).find((e: B) => e.type === "link");
		const token = new URL(link.target.url).searchParams.get("token");
		expect(token).toMatch(/^[0-9a-f]{48}$/);
		const res = await plugin.routes.download?.handler({ input: { token }, kv });
		expect(res).toMatchObject({ status: 200, headers: expect.arrayContaining([["content-type", "application/gzip"]]) });
		const doc = JSON.parse(await gunzip(res.body.value)) as BackupDoc;
		expect(doc.format).toBe("wp2emdash-backup");
		expect((await plugin.routes.download?.handler({ input: { token }, kv })).status).toBe(410);
		expect((await plugin.routes.download?.handler({ input: { token: "nope" }, kv })).status).toBe(410);
		const late = await call({ type: "block_action", action_id: "download", value: entry?.id });
		const lateToken = new URL(tab(late, "Backups").flatMap((b) => b.elements ?? []).find((e: B) => e.type === "link").target.url).searchParams.get("token");
		vi.useFakeTimers({ now: Date.now() + 3 * 60_000 });
		try {
			expect((await plugin.routes.download?.handler({ input: { token: lateToken }, kv })).status).toBe(410);
		} finally {
			vi.useRealTimers();
		}
		const beat = await plugin.routes.heartbeat?.handler({ kv });
		expect(beat).toEqual({ plugin: "site-backups", version: "0.2.0", lastBackupAt: entry?.at, ok: true });
	});

	it("restores settings: preview, then confirm → a fresh backup first, then one settings write as the admin", async () => {
		await call({ type: "block_action", action_id: "backup-now" });
		const [entry] = await readIndex(kv);
		sql.prepare("UPDATE options SET value = ? WHERE name = 'site:tagline'").run(JSON.stringify("Changed by mistake"));
		const pick = await call({ type: "block_action", action_id: "restore-pick", value: entry?.id });
		expect(pick.blocks[0]?.text).toMatch(/^Restore from back up now backup/);
		const prev = await call({ type: "block_action", action_id: "preview-settings", value: entry?.id });
		const table = prev.blocks.find((b) => b.block_id === "changes");
		expect(table?.rows).toEqual([{ what: "tagline", now: "Changed by mistake", backup: "Pottery in Portland" }]);
		const confirm = btn(prev.blocks, "restore-confirm");
		expect(confirm?.confirm).toMatchObject({ confirm: "Restore" });
		vi.useFakeTimers({ now: Date.now() + 5 * 60_000 });
		try {
			const done = await call({ type: "block_action", action_id: "restore-confirm", value: confirm?.value });
			expect(done.toast).toMatchObject({ type: "success", message: expect.stringContaining("Settings restored") });
		} finally {
			vi.useRealTimers();
		}
		expect(apiCalls).toEqual(["POST /_emdash/api/settings"]);
		const list = await readIndex(kv);
		expect(list.map((e) => e.trigger)).toEqual(["pre-restore", "manual"]);
		// The preview is single use.
		const again = await call({ type: "block_action", action_id: "restore-confirm", value: confirm?.value });
		expect(again.toast?.message).toMatch(/expired|used/);
	});

	it("refuses to write when the site changed after the preview, and shows the new preview", async () => {
		await call({ type: "block_action", action_id: "backup-now" });
		const [entry] = await readIndex(kv);
		sql.prepare("UPDATE ec_pages SET title = 'Edited' WHERE id = 'p1'").run();
		const prev = await call({ type: "block_action", action_id: "preview-entry", value: `${entry?.id}|pages|p1` });
		expect(prev.blocks.find((b) => b.block_id === "changes")?.rows).toEqual([{ what: "title", now: "Edited", backup: "About us" }]);
		sql.prepare("UPDATE ec_pages SET title = 'Edited again' WHERE id = 'p1'").run();
		const r = await call({ type: "block_action", action_id: "restore-confirm", value: btn(prev.blocks, "restore-confirm")?.value });
		expect(r.toast?.message).toMatch(/changed since the preview/);
		expect(apiCalls).toEqual([]);
		expect((await readIndex(kv)).map((e) => e.trigger)).toEqual(["manual"]);
		expect(r.blocks.find((b) => b.block_id === "changes")?.rows[0]).toMatchObject({ now: "Edited again" });
	});

	it("restores nothing when the backup taken first fails", async () => {
		await call({ type: "block_action", action_id: "backup-now" });
		const [entry] = await readIndex(kv);
		sql.prepare("UPDATE ec_pages SET title = 'Edited' WHERE id = 'p1'").run();
		const prev = await call({ type: "block_action", action_id: "preview-entry", value: `${entry?.id}|pages|p1` });
		const realPut = bucket.put;
		bucket.put = async () => {
			throw new Error("R2 down");
		};
		const r = await call({ type: "block_action", action_id: "restore-confirm", value: btn(prev.blocks, "restore-confirm")?.value });
		bucket.put = realPut;
		expect(r.toast).toMatchObject({ type: "error", message: expect.stringContaining("Nothing restored") });
		expect(apiCalls).toEqual([]);
	});

	it("the nightly task runs through EmDash's cron hook; the delete hook snapshots and never blocks", async () => {
		vi.useFakeTimers({ now: Date.UTC(2026, 10, 20, 23, 0) });
		try {
			await plugin.hooks.cron.handler({ name: "nightly" }, { kv, log });
			expect((await readIndex(kv)).map((e) => e.trigger)).toEqual(["nightly"]);
			vi.setSystemTime(Date.UTC(2026, 10, 20, 23, 5));
			expect(await plugin.hooks["content:beforeDelete"].handler({ id: "p2", collection: "pages" }, { kv, log })).toBe(true);
			expect((await readIndex(kv)).map((e) => e.trigger)).toEqual(["pre-delete", "nightly"]);
			delete env.DB;
			expect(await plugin.hooks["content:beforeDelete"].handler({ id: "p2", collection: "pages" }, { kv, log })).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("off-site copy", () => {
	it("signs requests with SigV4 (AWS's published example)", async () => {
		const h = await signV4({ method: "GET", url: "https://examplebucket.s3.amazonaws.com/test.txt", region: "us-east-1", credentials: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" }, payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", headers: { range: "bytes=0-9" }, amzDate: "20130524T000000Z" });
		expect(h.authorization).toBe("AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41");
	});
	it("puts each backup to the second bucket; keys stay out of URLs, errors, logs and the backup", async () => {
		const target = { endpoint: "https://other.r2.cloudflarestorage.com", bucket: "acme-offsite", region: "auto", prefix: "acme" };
		expect(offsiteUrl(target, "backups/2026-11-20/x.json.gz")).toBe("https://other.r2.cloudflarestorage.com/acme-offsite/acme/backups/2026-11-20/x.json.gz");
		const put = vi.fn(async () => new Response("", { status: 200 }));
		const d = deps({ options: { ...OPTIONS, offsite: target }, env: { BACKUP_S3_ACCESS_KEY_ID: SECRETS.s3KeyId, BACKUP_S3_SECRET_ACCESS_KEY: SECRETS.s3Secret }, fetch: put });
		const r = await runBackup(d, "nightly");
		expect(r).toMatchObject({ ok: true, entry: { offsite: "ok" } });
		const [url, init] = put.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toMatch(/^https:\/\/other\.r2\.cloudflarestorage\.com\/acme-offsite\/acme\/backups\/2026-11-20\/023000-nightly-[0-9a-f]{8}\.json\.gz$/);
		expect((init.headers as Record<string, string>).authorization).toMatch(new RegExp(`^AWS4-HMAC-SHA256 Credential=${SECRETS.s3KeyId}/20261120/auto/s3/aws4_request`));
		expect(JSON.stringify(init.headers)).not.toContain(SECRETS.s3Secret);
		const failed = await putOffsite(target, { accessKeyId: SECRETS.s3KeyId, secretAccessKey: SECRETS.s3Secret }, "k", new Uint8Array([1]), async () => new Response("denied", { status: 403 }));
		expect(failed).toEqual({ ok: false, reason: "off-site storage answered HTTP 403" });
		expect(await putOffsite({ ...target, endpoint: "http://insecure" }, { accessKeyId: "a", secretAccessKey: "b" }, "k", new Uint8Array([1]), put)).toMatchObject({ ok: false });
		expect(JSON.stringify(logs)).not.toContain(SECRETS.s3Secret);
	});
});

describe("kit side", () => {
	it("kit.config: on by default (30 + 12), false turns it off, off-site validated", () => {
		const base = { slug: "acme", name: "Acme", source: { url: ORIGIN }, target: { productionUrl: ORIGIN }, email: { to: ["owner@acme.example"], stagingTo: ["dev@agency.example"] } };
		const c = kitConfigSchema.parse(base);
		expect(c.backups).toEqual({ retention: { daily: 30, monthly: 12 }, restoreDrill: { everyDays: 30, mediaSample: 12, tolerancePct: 0 } });
		expect(kitConfigSchema.parse({ ...base, backups: false }).backups).toBe(false);
		expect(() => kitConfigSchema.parse({ ...base, backups: { offsite: { endpoint: "http://x", bucket: "b" } } })).toThrow();
		const o = backupsOptions({ config: c, productionUrl: ORIGIN, live: true, database: "acme-db" });
		expect(o).toMatchObject({ siteName: "Acme", live: true, alertsTo: ["dev@agency.example"], retention: { daily: 30, monthly: 12 }, bindings: { bucket: "MEDIA", database: "DB" }, database: "acme-db" });
		expect(JSON.stringify(o)).not.toMatch(/SECRET|ACCESS_KEY/);
		expect(backupsOptions({ config: { ...c, backups: false }, productionUrl: ORIGIN, live: true })).toBeUndefined();
		const off = backupsOptions({ config: kitConfigSchema.parse({ ...base, backups: { offsite: { endpoint: "https://x.r2.cloudflarestorage.com", bucket: "acme-offsite" } } }), productionUrl: ORIGIN, live: false });
		expect(off?.offsite).toEqual({ endpoint: "https://x.r2.cloudflarestorage.com", bucket: "acme-offsite", region: "auto" });
	});
	it("scaffold binds SELF for backups alone (restore goes through the Worker), docs explain restoring a page", () => {
		const config = kitConfigSchema.parse({ slug: "acme", name: "Acme", source: { url: ORIGIN }, target: { productionUrl: ORIGIN }, email: { to: ["owner@acme.example"], stagingTo: ["team@agency.example"] } });
		const base = { config, workerName: "acme", compatibilityDate: "2026-11-12", cf: {}, staging: false, sandboxedEnvs: [], seoPanel: false, health: false, productionHost: "acme.example" };
		expect(wranglerJsonc({ ...base, backups: true })).toContain('"services": [{"binding":"SELF","service":"acme"}]');
		expect(wranglerJsonc({ ...base, backups: false })).not.toContain('"SELF"');
		const doc = backupsDoc({ alertsTo: ["dev@agency.example"], daily: 30, monthly: 12, offsite: true, database: "acme-db" }, { productionUrl: ORIGIN });
		expect(doc).toContain("## Restore a page");
		expect(doc).toContain("npx wrangler d1 time-travel restore acme-db --timestamp=");
		expect(doc).toContain("npx wrangler secret put BACKUP_S3_SECRET_ACCESS_KEY");
		expect(doc).toMatch(/Never in a backup:\*\* passwords/);
	});
	it("dashboard knows the off-site secrets; verify reads the heartbeat", async () => {
		expect(SECRET_KEYS.map((s) => s.key)).toEqual(expect.arrayContaining(["BACKUP_S3_ACCESS_KEY_ID", "BACKUP_S3_SECRET_ACCESS_KEY"]));
		const now = Date.parse("2026-11-20T12:00:00Z");
		const beat = (data: unknown, status = 200) => async () => new Response(JSON.stringify({ data }), { status });
		expect(await backupsHeartbeat(ORIGIN, { fetch: beat({ lastBackupAt: "2026-11-20T02:00:00Z", ok: true }), live: true, now })).toMatchObject({ ok: true });
		expect(await backupsHeartbeat(ORIGIN, { fetch: beat({ lastBackupAt: "2026-11-18T02:00:00Z", ok: true }), live: true, now })).toMatchObject({ ok: false });
		expect(await backupsHeartbeat(ORIGIN, { fetch: beat({ lastBackupAt: null, ok: true }), live: false, now })).toMatchObject({ ok: true });
		expect(await backupsHeartbeat(ORIGIN, { fetch: beat({}, 404), live: true, now })).toMatchObject({ ok: false, detail: expect.stringContaining("404") });
	});
	it("Site health shows the last backup as a check", () => {
		const at = "2026-11-20T12:00:00Z";
		const now = Date.parse(at);
		expect(backupsCheck(false, undefined, at, now).status).toBe("off");
		expect(backupsCheck(true, { status: 200, lastBackupAt: "2026-11-20T02:00:00Z", ok: true }, at, now)).toMatchObject({ status: "ok", summary: "Last backup 2026-11-20 02:00 UTC." });
		expect(backupsCheck(true, { status: 200, lastBackupAt: "2026-11-20T02:00:00Z", ok: false }, at, now).status).toBe("warn");
		expect(backupsCheck(true, { status: 200, lastBackupAt: "2026-11-18T02:00:00Z", ok: true }, at, now).status).toBe("fail");
		expect(backupsCheck(true, { status: 404 }, at, now).status).toBe("fail");
	});
	it("load --force and golive leave a backup marker in the site's bucket (Cloudflare R2 object API)", async () => {
		expect(markerKey(new Date("2026-11-20T08:15:00.123Z"), "Content reload by the agency (load --force)")).toBe("backups/markers/20261120T081500Z-content-reload-by-the-agency-load-force.json");
		const calls: { url: string; init?: RequestInit }[] = [];
		const f = vi.fn(async (url: string, init?: RequestInit) => {
			calls.push({ url, ...(init ? { init } : {}) });
			if (url.includes("/time_travel/bookmark")) return Response.json({ success: true, result: { bookmark: "00000085-0000024c-00004c6d-8e61117b" } });
			return Response.json({ success: true, result: {} });
		});
		expect(await writeBackupMarker({ token: "tok", accountId: "acc", bucket: "acme-media", marker: { at: "2026-11-20T08:15:00Z", reason: "Go-live", by: "wp2emdash" } }, f as never)).toEqual({ key: "backups/markers/20261120T081500Z-go-live.json" });
		expect(calls[0]?.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/r2/buckets/acme-media/objects/backups/markers/20261120T081500Z-go-live.json");
		expect(calls[0]?.init?.method).toBe("PUT");
		const dir = mkdtempSync(join(tmpdir(), "bk-"));
		try {
			const cf = { production: { accountId: "acc", d1: { name: "acme-db", id: "db1" }, r2: { bucket: "acme-media" } } };
			const vars = { CLOUDFLARE_API_TOKEN: "tok" };
			const g = await guardLiveProductionWrite({ live: true, force: true, slug: "acme", cf, vars, bookmarksFile: join(dir, "b.jsonl"), now: () => new Date("2026-11-20T09:00:00Z") }, f as never);
			expect(g).toMatchObject({ ok: true, bookmark: { marker: "backups/markers/20261120T090000Z-content-reload-by-the-agency-load-force.json" } });
			const put = calls.filter((c) => c.init?.method === "PUT").at(-1);
			expect(JSON.parse(String(put?.init?.body))).toMatchObject({ reason: "Content reload by the agency (load --force)", d1: { database: "acme-db", bookmark: "00000085-0000024c-00004c6d-8e61117b", restore: "npx wrangler d1 time-travel restore acme-db --bookmark=00000085-0000024c-00004c6d-8e61117b" } });
			const m = await preChangeMarker({ reason: "Go-live: acme.example switched to this site", cf, vars, bookmarksFile: join(dir, "b.jsonl"), now: new Date("2026-11-21T10:00:00Z") }, f);
			expect(m).toMatchObject({ ok: true, bookmark: "00000085-0000024c-00004c6d-8e61117b" });
			expect(readFileSync(join(dir, "b.jsonl"), "utf8").trim().split("\n")).toHaveLength(2);
			expect(await preChangeMarker({ reason: "x", cf, vars: {}, bookmarksFile: join(dir, "b.jsonl") }, f)).toMatchObject({ ok: false, detail: expect.stringContaining("not recorded") });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
