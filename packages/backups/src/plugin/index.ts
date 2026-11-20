/**
 * Backups — EmDash native plugin (Block Kit admin, no React bundle), loaded in the Worker from
 * `@wp2emdash/backups/plugin`; register it with `backupsPlugin()` from `@wp2emdash/backups` in astro.config.
 *
 * - `cron` hook, task `nightly` once an hour at a minute fixed per site (EmDash plugin cron, run by the Worker's
 *   `*\/5 * * * *` trigger): the nightly backup when due, retries, retention, failure alerts.
 * - `content:beforeDelete` hook (fires when an entry is moved to the trash): a snapshot of just that entry first.
 * - `admin` route (EmDash's default `plugins:manage`, admins only; role checked again): the Backups page — list,
 *   Back up now (single flight, at most every 2 minutes), downloads, restore with a preview, alert settings.
 * - `download` route (public GET, raw): a backup file, only for a random token an admin's "Download" created — once,
 *   within two minutes (a browser download cannot send EmDash's CSRF header).
 * - `heartbeat` route (public GET): the time of the last successful backup and whether the last attempt worked —
 *   nothing else — for Site health and the kit's verify.
 * - `status` route (private JSON): the same plus counts, for admins and API tokens with the admin scope.
 *
 * Logs carry counts, sizes and reasons — never content, addresses or keys.
 */
import { definePlugin, pluginResponse } from "emdash";
import { parseRecipients } from "@wp2emdash/forms/outbox";
import { type BackupDoc, type BackupEntry, FORMAT, ID_PATTERN, isBackupKey, type KitMarker, MARKER_PREFIX, settingsOf as backupSettings } from "../format.js";
import type { D1Db, R2Like } from "../export.js";
import { mailReady, type PluginEmail } from "../email.js";
import type { BackupsOptions } from "../index.js";
import { BACKUPS_PLUGIN } from "../meta.js";
import { applyEntry, applyMenus, applySettings, currentEntry, currentMenus, currentSettings, emdashApi, entriesOf, entryOf, fingerprint, menusOf, type Plan, planEntry, planMenus, planSettings, type RestoreKind } from "../restore.js";
import { type BackupEnv, nightly, offsiteReady, rebuildIndex, type RunDeps, runBackup, snapshotEntry } from "../run.js";
import { cronSchedule, DEFAULT_RETENTION, LOCK_MS, nightlyHour, TASK } from "../schedule.js";
import { acquireLock, type AlertSettings, grant, KEYS, type Kv, readIndex, readStatus, redeem, releaseLock } from "../store.js";
import { gunzip } from "../util.js";
import { adminsOnly, chooser, PAGE, type PageData, page, preview, TABS } from "./views.js";

const ADMIN_ROLE = 50;
const DOWNLOAD_MS = 2 * 60_000;
const PLAN_MS = 10 * 60_000;

interface WorkerEnv extends BackupEnv {
	SELF?: { fetch(r: Request): Promise<Response> };
	[binding: string]: unknown;
}
interface CronAccess {
	schedule(name: string, o: { schedule: string }): Promise<void>;
	list(): Promise<{ name: string; schedule: string }[]>;
}
interface Ctx {
	input?: unknown;
	request?: Request;
	user?: { role: number; name?: string | null; email?: string; id?: string };
	kv: Kv;
	cron?: CronAccess;
	email?: PluginEmail;
	log?: { info(m: string, d?: Record<string, unknown>): void; warn?(m: string, d?: Record<string, unknown>): void };
}
interface Interaction {
	type?: string;
	action_id?: string;
	value?: unknown;
	values?: Record<string, unknown>;
}
interface PlanGrant {
	kind: RestoreKind;
	backupId: string;
	fingerprint: string;
	target?: { collection: string; id: string };
	user?: string;
}

// Bindings exist only in the Worker: imported per call, not at module level (astro.config loads the descriptor in Node).
const workerEnv = async () => ((await import("cloudflare:workers")) as unknown as { env: WorkerEnv }).env;

export async function ensureCron(cron: CronAccess | undefined, o: BackupsOptions): Promise<void> {
	if (!cron) return;
	const want = cronSchedule(new URL(o.productionUrl).host);
	if (!(await cron.list()).some((t) => t.name === TASK && t.schedule === want)) await cron.schedule(TASK, { schedule: want });
}

function bindings(env: WorkerEnv, o: BackupsOptions): { db?: D1Db; bucket?: R2Like } {
	const db = env[o.bindings?.database ?? "DB"] as D1Db | undefined;
	const bucket = env[o.bindings?.bucket ?? "MEDIA"] as R2Like | undefined;
	return { ...(db?.prepare ? { db } : {}), ...(bucket?.put ? { bucket } : {}) };
}

function deps(ctx: Ctx, env: WorkerEnv, o: BackupsOptions): RunDeps | undefined {
	const { db, bucket } = bindings(env, o);
	if (!db || !bucket) return undefined;
	return {
		kv: ctx.kv,
		db,
		bucket,
		options: o,
		env,
		// workerd: a global fetch kept as a property and called as a method throws "Illegal invocation" — wrap it.
		fetch: (url, init) => fetch(url, init),
		...(ctx.email ? { email: ctx.email } : {}),
		...(ctx.log ? { log: ctx.log } : {}),
		now: Date.now(),
	};
}

/** The backup list, rebuilt from the bucket if the plugin KV lost it. */
async function entriesFor(d: RunDeps): Promise<BackupEntry[]> {
	const list = await readIndex(d.kv);
	if (list.length) return list;
	const rebuilt = await rebuildIndex(d.bucket).catch(() => []);
	if (rebuilt.length) await d.kv.set(KEYS.index, rebuilt);
	return rebuilt;
}

export async function loadDoc(bucket: R2Like, e: BackupEntry): Promise<BackupDoc> {
	if (!isBackupKey(e.key)) throw new Error("not a backup key");
	const obj = await bucket.get(e.key);
	if (!obj) throw new Error("the backup file is missing from storage");
	const doc = JSON.parse(await gunzip(await obj.arrayBuffer())) as BackupDoc;
	if (doc.format !== FORMAT || doc.version !== 1) throw new Error("not a backup file this version can read");
	return doc;
}

async function readMarkers(bucket: R2Like): Promise<(KitMarker & { key: string })[]> {
	try {
		const page = await bucket.list({ prefix: MARKER_PREFIX, limit: 100 });
		const out: (KitMarker & { key: string })[] = [];
		for (const o of page.objects.sort((a, b) => (a.key < b.key ? 1 : -1)).slice(0, 50)) {
			const obj = await bucket.get(o.key);
			if (!obj) continue;
			try {
				const m = JSON.parse(new TextDecoder().decode(await obj.arrayBuffer())) as KitMarker;
				if (typeof m.at === "string" && typeof m.reason === "string") out.push({ at: m.at, reason: m.reason.slice(0, 200), by: "wp2emdash", ...(m.d1 ? { d1: m.d1 } : {}), key: o.key });
			} catch {}
		}
		return out;
	} catch {
		return [];
	}
}

export function createPlugin(options: BackupsOptions) {
	const o = options;
	const host = new URL(o.productionUrl).host;
	const retention = { daily: o.retention?.daily ?? DEFAULT_RETENTION.daily, monthly: o.retention?.monthly ?? DEFAULT_RETENTION.monthly };

	async function pageData(ctx: Ctx, env: WorkerEnv, d: RunDeps | undefined, extra: Partial<PageData> = {}): Promise<PageData> {
		const [entries, status, settings, markers] = await Promise.all([d ? entriesFor(d) : readIndex(ctx.kv), readStatus(ctx.kv), ctx.kv.get<AlertSettings>(KEYS.settings), d ? readMarkers(d.bucket) : Promise.resolve([])]);
		const ready = mailReady(env, ctx.email);
		return {
			entries,
			status,
			settings: settings ?? {},
			defaults: { alertsTo: o.alertsTo },
			hourUtc: nightlyHour(host, o.hourUtc),
			retention,
			offsite: offsiteReady(o, env) ? "on" : o.offsite ? "missing-secrets" : "off",
			email: { ready: ready.ok, ...(ready.ok ? {} : { reason: ready.reason }) },
			live: o.live,
			staging: env.STAGING === "1",
			storage: !!d,
			selfBinding: !!env.SELF,
			...(o.database ? { database: o.database } : {}),
			markers,
			...extra,
		};
	}

	/** A restore plan from a backup and the current state (read-only). */
	async function makePlan(d: RunDeps, entry: BackupEntry, kind: RestoreKind, target?: { collection: string; id: string }): Promise<{ plan: Plan; write: unknown }> {
		const doc = await loadDoc(d.bucket, entry);
		if (kind === "settings") {
			const now = await currentSettings(d.db);
			const p = planSettings(backupSettings(doc), now);
			return { plan: { kind, backupId: entry.id, title: "Settings", changes: p.changes, notes: p.notes, fingerprint: await fingerprint(now) }, write: p.payload };
		}
		if (kind === "menus") {
			const now = await currentMenus(d.db);
			const b = menusOf(doc);
			const p = planMenus(b, now);
			return { plan: { kind, backupId: entry.id, title: "Menus", changes: p.changes, notes: p.notes, fingerprint: await fingerprint(now) }, write: { backup: b, now } };
		}
		const t = target as { collection: string; id: string };
		const now = await currentEntry(d.db, t.collection, t.id);
		const b = entryOf(doc, t.collection, t.id);
		const p = planEntry(b, now);
		const title = entriesOf({ tables: { [`ec_${t.collection}`]: { columns: [], rows: b.row ? [b.row] : [] } } })[0]?.title ?? t.id;
		return { plan: { kind, backupId: entry.id, title, changes: p.changes, notes: p.notes, fingerprint: await fingerprint(now), target: t }, write: { ...p.write, locale: b.row?.locale } };
	}

	return definePlugin({
		...BACKUPS_PLUGIN,
		capabilities: ["content:read", "email:send"],
		hooks: {
			"plugin:install": async (_event: unknown, ctx: unknown) => ensureCron((ctx as Ctx).cron, o),
			"plugin:activate": async (_event: unknown, ctx: unknown) => ensureCron((ctx as Ctx).cron, o),
			// A backup of a marketing site reads a few thousand rows and lists the bucket: seconds, not minutes.
			cron: {
				timeout: 120_000,
				handler: async (event: { name: string }, raw: unknown) => {
					if (event.name !== TASK) return;
					const ctx = raw as Ctx;
					const d = deps(ctx, await workerEnv(), o);
					if (!d) return void ctx.log?.warn?.("backups: no D1 or R2 binding; nothing backed up");
					const r = await nightly(d);
					if (!r.ok && r.skipped !== "not-due") ctx.log?.info("backups nightly", r.skipped ? { skipped: r.skipped } : { failed: true });
				},
			},
			// Moving an entry to the trash: keep a copy of it first. Never blocks the delete (errors are swallowed).
			"content:beforeDelete": {
				timeout: 4_000,
				handler: async (event: { id: string; collection: string }, raw: unknown) => {
					try {
						const d = deps(raw as Ctx, await workerEnv(), o);
						if (d) await snapshotEntry(d, event.collection, event.id);
					} catch {}
					return true;
				},
			},
		},
		admin: { pages: [{ path: PAGE, label: "Backups", icon: "history" }] },
		routes: {
			admin: {
				permission: "plugins:manage",
				handler: async (raw: unknown) => {
					const ctx = raw as Ctx;
					if ((ctx.user?.role ?? 0) < ADMIN_ROLE) return { blocks: adminsOnly };
					const env = await workerEnv();
					const d = deps(ctx, env, o);
					await ensureCron(ctx.cron, o).catch(() => {});
					const i = (ctx.input ?? {}) as Interaction;
					const act = i.action_id ?? "";
					const show = async (tab: number = TABS.backups, extra: Partial<PageData> = {}) => page(await pageData(ctx, env, d, extra), tab);
					const v = typeof i.value === "string" ? i.value : "";
					const findEntry = async (id: string) => (ID_PATTERN.test(id) && d ? (await entriesFor(d)).find((e) => e.id === id) : undefined);
					const gone = async () => ({ blocks: await show(), toast: { message: "That backup is no longer kept.", type: "info" } });
					const who = ctx.user?.name || "an admin";

					if (i.type === "block_action" && act === "backup-now") {
						if (!d) return { blocks: await show(), toast: { message: "Backups cannot run: the Worker has no D1 or R2 binding.", type: "error" } };
						const r = await runBackup(d, "manual", { by: who });
						const message = r.ok ? `Backup stored (${r.entry.id})${r.offsite ? `; ${r.offsite}` : ""}.` : r.skipped === "locked" ? "A backup or restore is running already; refresh in a minute." : r.skipped === "too-soon" ? "A backup was made less than 2 minutes ago." : `Backup failed: ${r.reason}.`;
						return { blocks: await show(), toast: { message, type: r.ok ? "success" : r.skipped ? "info" : "error" } };
					}
					if (i.type === "block_action" && act === "download") {
						const e = await findEntry(v);
						if (!e) return gone();
						const token = await grant(ctx.kv, "dl", { id: e.id }, DOWNLOAD_MS);
						const url = new URL(`/_emdash/api/plugins/${BACKUPS_PLUGIN.id}/download?token=${token}`, ctx.request?.url ?? o.productionUrl).toString();
						ctx.log?.info("backup download link", { id: e.id });
						return { blocks: await show(TABS.backups, { download: { url, id: e.id } }) };
					}
					if (i.type === "block_action" && act === "restore-pick") {
						const e = await findEntry(v);
						if (!e || !d) return gone();
						try {
							return { blocks: chooser(e, entriesOf(await loadDoc(d.bucket, e))) };
						} catch (err) {
							return { blocks: await show(), toast: { message: `That backup cannot be read: ${(err as Error).message}.`, type: "error" } };
						}
					}
					if (i.type === "block_action" && (act === "preview-settings" || act === "preview-menus" || act === "preview-entry")) {
						const [id = "", collection, entryId] = v.split("|");
						const e = await findEntry(id);
						if (!e || !d) return gone();
						const kind: RestoreKind = act === "preview-settings" ? "settings" : act === "preview-menus" ? "menus" : "entry";
						if (kind === "entry" && !(collection && /^[a-z][a-z0-9_]*$/.test(collection) && entryId && entryId.length <= 100)) return gone();
						try {
							const { plan } = await makePlan(d, e, kind, kind === "entry" ? { collection: collection as string, id: entryId as string } : undefined);
							const token = plan.changes.length ? await grant<PlanGrant>(ctx.kv, "plan", { kind, backupId: e.id, fingerprint: plan.fingerprint, ...(plan.target ? { target: plan.target } : {}), ...(ctx.user?.id ? { user: ctx.user.id } : {}) }, PLAN_MS) : undefined;
							return { blocks: preview(plan, token, e) };
						} catch (err) {
							return { blocks: await show(), toast: { message: `Cannot prepare the restore: ${(err as Error).message}.`, type: "error" } };
						}
					}
					if (i.type === "block_action" && act === "restore-confirm") {
						const g = await redeem<PlanGrant>(ctx.kv, "plan", v);
						if (!g || (g.user && ctx.user?.id && g.user !== ctx.user.id)) return { blocks: await show(TABS.restore), toast: { message: "This preview expired (10 minutes) or was used already. Preview the restore again.", type: "info" } };
						const e = await findEntry(g.backupId);
						if (!e || !d) return gone();
						if (!env.SELF || !ctx.request) return { blocks: await show(TABS.restore), toast: { message: "Restoring is not available: the Worker has no SELF binding.", type: "error" } };
						if (!(await acquireLock(ctx.kv, d.now, LOCK_MS, "restore"))) return { blocks: await show(TABS.restore), toast: { message: "A backup or restore is running already; try again in a minute.", type: "info" } };
						try {
							const { plan, write } = await makePlan(d, e, g.kind, g.target);
							if (plan.fingerprint !== g.fingerprint) return { blocks: preview(plan, await grant<PlanGrant>(ctx.kv, "plan", { ...g, fingerprint: plan.fingerprint }, PLAN_MS), e), toast: { message: "Something changed since the preview. Here is the new preview; confirm again.", type: "info" } };
							// Every restore starts with a fresh backup: if that fails, nothing is restored.
							const before = await runBackup(d, "pre-restore", { by: who, locked: true });
							if (!before.ok) return { blocks: await show(TABS.restore), toast: { message: `Nothing restored: the backup taken first failed (${before.reason ?? before.skipped}).`, type: "error" } };
							const self = env.SELF;
							const api = emdashApi({ self: (r) => self.fetch(r), origin: new URL(ctx.request.url).origin, cookie: ctx.request.headers.get("cookie"), authorization: ctx.request.headers.get("authorization") });
							let done = "";
							if (g.kind === "settings") {
								await applySettings(api, write as Record<string, unknown>);
								done = "Settings restored";
							} else if (g.kind === "menus") {
								const w = write as { backup: Parameters<typeof applyMenus>[1]; now: Parameters<typeof applyMenus>[2] };
								const r = await applyMenus(api, w.backup, w.now);
								done = `Menus restored (${r.added} items added, ${r.removed} removed)`;
							} else {
								const w = write as NonNullable<ReturnType<typeof planEntry>["write"]> & { locale?: string };
								const t = g.target as { collection: string; id: string };
								const r = await applyEntry(api, t.collection, t.id, w, typeof w.locale === "string" ? w.locale : undefined);
								done = `"${plan.title}" restored${w.create ? ` as a new entry (${r.id})` : ""}${w.publish ? " and published" : " (saved as a draft)"}`;
							}
							ctx.log?.info("backup restored", { kind: g.kind, backup: e.id, changes: plan.changes.length });
							return { blocks: await show(), toast: { message: `${done}. The state just before is kept as backup ${before.entry.id}.`, type: "success" } };
						} catch (err) {
							ctx.log?.warn?.("backup restore failed", { kind: g.kind, reason: (err as Error)?.name ?? "Error" });
							return { blocks: await show(TABS.restore), toast: { message: `Restore stopped: ${(err as Error).message}. The state before it is in the newest backup ("Before a restore").`, type: "error" } };
						} finally {
							await releaseLock(ctx.kv);
						}
					}
					if (i.type === "form_submit" && act === "save-settings") {
						const vals = i.values ?? {};
						const a = parseRecipients(typeof vals.alertsTo === "string" ? vals.alertsTo.slice(0, 4000) : "");
						if (a.errors.length) return { blocks: await show(TABS.settings, { errors: a.errors }), toast: { message: "Not saved. See the errors.", type: "error" } };
						const next: AlertSettings = { ...(a.list.length ? { alertsTo: a.list } : {}), alerts: vals.alerts !== false };
						await ctx.kv.set(KEYS.settings, next);
						ctx.log?.info("backup settings saved", { alerts: next.alerts, recipients: a.list.length });
						return { blocks: await show(TABS.settings), toast: { message: "Settings saved.", type: "success" } };
					}
					return { blocks: await show() };
				},
			},
			download: {
				public: true,
				methods: ["GET"],
				request: { body: "none" },
				response: "raw",
				handler: async (raw: unknown) => {
					const ctx = raw as Ctx;
					const q = (ctx.input ?? {}) as Record<string, unknown>;
					const g = await redeem<{ id: string }>(ctx.kv, "dl", Array.isArray(q.token) ? q.token[0] : q.token);
					const expired = () => pluginResponse({ status: 410, headers: { "content-type": "text/plain; charset=utf-8" }, body: { kind: "text", value: "This download link has expired or was already used. Create a new one in the admin: Plugins → Backups." } });
					if (!g) return expired();
					const e = (await readIndex(ctx.kv)).find((x) => x.id === g.id);
					const { bucket } = bindings(await workerEnv(), o);
					const obj = e && bucket && isBackupKey(e.key) ? await bucket.get(e.key) : null;
					if (!e || !obj) return expired();
					const slug = o.siteName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "site";
					return pluginResponse({ status: 200, headers: { "content-type": "application/gzip", "content-disposition": `attachment; filename="${slug}-backup-${e.id}.json.gz"`, "cache-control": "private, no-store", "x-content-type-options": "nosniff" }, body: { kind: "bytes", value: new Uint8Array(await obj.arrayBuffer()) } });
				},
			},
			heartbeat: {
				public: true,
				methods: ["GET"],
				request: { body: "none" },
				handler: async (raw: unknown) => {
					const s = await readStatus((raw as Ctx).kv);
					return { plugin: BACKUPS_PLUGIN.id, version: BACKUPS_PLUGIN.version, lastBackupAt: s.lastSuccessAt ?? null, ok: s.failures === 0 };
				},
			},
			status: {
				permission: "plugins:manage",
				handler: async (raw: unknown) => {
					const ctx = raw as Ctx;
					if ((ctx.user?.role ?? ADMIN_ROLE) < ADMIN_ROLE) return { error: "admins only" };
					const [s, list] = await Promise.all([readStatus(ctx.kv), readIndex(ctx.kv)]);
					return { plugin: BACKUPS_PLUGIN.id, version: BACKUPS_PLUGIN.version, lastBackupAt: s.lastSuccessAt ?? null, ok: s.failures === 0, failures: s.failures, kept: list.filter((e) => e.trigger !== "pre-delete").length, bytes: list.reduce((n, e) => n + e.bytes, 0) };
				},
			},
		},
	});
}

export default createPlugin;
