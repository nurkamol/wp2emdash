/**
 * One backup: export (read-only), gzip, store in the site's R2 bucket under `backups/<day>/`, copy off-site when set up,
 * record it in the list, apply retention. Plus the nightly decision, failure alerts and the pre-delete snapshot of a
 * single entry. Everything outside (KV, D1, R2, fetch, email, the clock) comes in through `RunDeps`.
 */
import type { BackupsOptions } from "./index.js";
import { type BackupDoc, type BackupEntry, backupKey, classifyTable, entryTitle, FORMAT, FORMAT_VERSION, idOfKey, isBackupKey, type Trigger } from "./format.js";
import { countsOf, type D1Db, exportSite, readRows, type R2Like } from "./export.js";
import { alertMail, type MailEnv, type PluginEmail, sendMail } from "./email.js";
import { putOffsite } from "./s3.js";
import { ALERT_AFTER, LOCK_MS, MANUAL_EVERY, nightlyDue, nightlyHour, planRetention, type RunStatus } from "./schedule.js";
import { acquireLock, type AlertSettings, KEYS, type Kv, readIndex, readStatus, releaseLock, updateIndex } from "./store.js";
import { dayOf, gzip, plural, randomHex } from "./util.js";

export interface BackupEnv extends MailEnv {
	BACKUP_S3_ACCESS_KEY_ID?: string;
	BACKUP_S3_SECRET_ACCESS_KEY?: string;
}

export interface RunDeps {
	kv: Kv;
	db: D1Db;
	bucket: R2Like;
	options: BackupsOptions;
	env: BackupEnv;
	fetch: (url: string, init: RequestInit) => Promise<Response>;
	email?: PluginEmail;
	log?: { info(m: string, d?: Record<string, unknown>): void; warn?(m: string, d?: Record<string, unknown>): void };
	now: number;
}

export type RunResult = { ok: true; entry: BackupEntry; pruned: number; offsite?: string } | { ok: false; skipped?: "locked" | "too-soon" | "not-due"; reason?: string };

export const adminUrl = (o: Pick<BackupsOptions, "productionUrl">) => `${o.productionUrl.replace(/\/$/, "")}/_emdash/admin/plugins/site-backups/backups`;
export const settingsOf = async (kv: Kv): Promise<AlertSettings> => (await kv.get<AlertSettings>(KEYS.settings)) ?? {};

/** Whether the off-site copy is configured: options from kit.config plus both secrets. */
export function offsiteReady(o: BackupsOptions, env: BackupEnv): boolean {
	return !!(o.offsite?.endpoint && o.offsite.bucket && env.BACKUP_S3_ACCESS_KEY_ID?.trim() && env.BACKUP_S3_SECRET_ACCESS_KEY?.trim());
}

/** Stores a backup document; returns its list entry. */
export async function storeDoc(d: RunDeps, doc: BackupDoc, key: string, by?: string): Promise<{ entry: BackupEntry; offsite?: string }> {
	const body = await gzip(JSON.stringify(doc));
	const entry: BackupEntry = { id: doc.id, key, at: doc.createdAt, trigger: doc.trigger, bytes: body.byteLength, counts: doc.counts, ...(by ? { by: by.slice(0, 80) } : {}) };
	// Custom metadata lets the list be rebuilt from the bucket alone if the plugin's KV is ever lost (R2 caps it at 2 KB).
	await d.bucket.put(key, body, { httpMetadata: { contentType: "application/gzip" }, customMetadata: { format: FORMAT, version: String(FORMAT_VERSION), id: doc.id, at: doc.createdAt, trigger: doc.trigger } });
	let offsite: string | undefined;
	if (offsiteReady(d.options, d.env) && doc.trigger !== "pre-delete") {
		const r = await putOffsite(d.options.offsite as NonNullable<BackupsOptions["offsite"]>, { accessKeyId: (d.env.BACKUP_S3_ACCESS_KEY_ID as string).trim(), secretAccessKey: (d.env.BACKUP_S3_SECRET_ACCESS_KEY as string).trim() }, key, body, d.fetch, new Date(d.now));
		entry.offsite = r.ok ? "ok" : "failed";
		if (!r.ok) offsite = r.reason;
	}
	await updateIndex(d.kv, (list) => [entry, ...list.filter((e) => e.id !== entry.id)]);
	return { entry, ...(offsite ? { offsite } : {}) };
}

/** Removes backups outside the retention window (R2 objects and list entries). */
export async function prune(d: RunDeps): Promise<number> {
	const { drop } = planRetention(await readIndex(d.kv), d.now, d.options.retention);
	if (!drop.length) return 0;
	const keys = drop.map((e) => e.key).filter(isBackupKey);
	for (let i = 0; i < keys.length; i += 500) await d.bucket.delete(keys.slice(i, i + 500));
	const gone = new Set(drop.map((e) => e.id));
	await updateIndex(d.kv, (list) => list.filter((e) => !gone.has(e.id)));
	return drop.length;
}

/** The list rebuilt from the bucket (when the plugin KV lost it): reads custom metadata, not the files. */
export async function rebuildIndex(bucket: R2Like): Promise<BackupEntry[]> {
	const out: BackupEntry[] = [];
	let cursor: string | undefined;
	for (;;) {
		const page = await bucket.list({ prefix: "backups/", limit: 1000, include: ["customMetadata"], ...(cursor ? { cursor } : {}) });
		for (const o of page.objects) {
			const id = idOfKey(o.key);
			const m = o.customMetadata ?? {};
			if (!id || m.format !== FORMAT) continue;
			out.push({ id, key: o.key, at: m.at ?? new Date(o.uploaded).toISOString(), trigger: (m.trigger as Trigger) ?? "nightly", bytes: o.size, counts: { entries: {}, menus: 0, menuItems: 0, redirects: 0, media: 0, mediaFiles: 0, settings: 0, sections: 0, taxonomies: 0, revisions: 0 } });
		}
		if (!page.truncated || !page.cursor) break;
		cursor = page.cursor;
	}
	return out.sort((a, b) => (a.at < b.at ? 1 : -1));
}

/**
 * Takes a full backup now. Single flight (KV lock) unless the caller holds it already (`locked`, e.g. a restore taking
 * its fresh backup first); "Back up now" at most every 2 minutes.
 */
export async function runBackup(d: RunDeps, trigger: Exclude<Trigger, "pre-delete">, o: { by?: string; locked?: boolean } = {}): Promise<RunResult> {
	const status = await readStatus(d.kv);
	if (trigger === "manual" && status.manualAt && d.now - Date.parse(status.manualAt) < MANUAL_EVERY) return { ok: false, skipped: "too-soon" };
	if (!o.locked && !(await acquireLock(d.kv, d.now, LOCK_MS, trigger))) return { ok: false, skipped: "locked" };
	try {
		const at = new Date(d.now);
		const key = backupKey(at, trigger, randomHex(4));
		const doc = await exportSite({ db: d.db, bucket: d.bucket, id: idOfKey(key) as string, trigger, now: d.now, site: { name: d.options.siteName, url: d.options.productionUrl }, ...(d.options.database ? { database: d.options.database } : {}) });
		const { entry, offsite } = await storeDoc(d, doc, key, o.by);
		const pruned = await prune(d);
		const after = await readStatus(d.kv);
		const recovered = after.failures >= ALERT_AFTER && !!after.alertedDay;
		const next: RunStatus = { ...after, lastSuccessAt: entry.at, lastAttemptAt: entry.at, failures: 0, ...(trigger === "nightly" ? { nightlyDay: dayOf(d.now) } : {}), ...(trigger === "manual" ? { manualAt: entry.at } : {}) };
		delete next.lastError;
		delete next.alertedDay;
		await d.kv.set(KEYS.status, next);
		// Counts and sizes only.
		d.log?.info("backup stored", { trigger, bytes: entry.bytes, entries: Object.values(entry.counts.entries).reduce((a, b) => a + b, 0), mediaFiles: entry.counts.mediaFiles, pruned, ...(entry.offsite ? { offsite: entry.offsite } : {}) });
		if (recovered) await alert(d, true);
		return { ok: true, entry, pruned, ...(offsite ? { offsite } : {}) };
	} catch (e) {
		const reason = `${(e as Error)?.name ?? "Error"}: ${String((e as Error)?.message ?? e).slice(0, 160)}`;
		const s = await readStatus(d.kv);
		const today = dayOf(d.now);
		const next: RunStatus = { ...s, lastAttemptAt: new Date(d.now).toISOString(), lastError: reason, failures: s.failures + 1, ...(trigger === "nightly" ? { attempts: { day: today, n: s.attempts?.day === today ? s.attempts.n + 1 : 1 } } : {}) };
		await d.kv.set(KEYS.status, next);
		d.log?.warn?.("backup failed", { trigger, failures: next.failures, reason });
		if (trigger === "nightly" && next.failures >= ALERT_AFTER && next.alertedDay !== today && (await alert(d, false, next))) await d.kv.set(KEYS.status, { ...next, alertedDay: today });
		return { ok: false, reason };
	} finally {
		if (!o.locked) await releaseLock(d.kv);
	}
}

/** The hourly task: runs the nightly backup when due (site's hour reached, not done today, under the attempt cap). */
export async function nightly(d: RunDeps): Promise<RunResult> {
	const host = new URL(d.options.productionUrl).host;
	if (!nightlyDue(d.now, await readStatus(d.kv), nightlyHour(host, d.options.hourUtc))) return { ok: false, skipped: "not-due" };
	return runBackup(d, "nightly");
}

/** Why no alert email goes out right now (undefined: it does). */
export function alertBlocked(o: BackupsOptions, env: BackupEnv, s: AlertSettings): string | undefined {
	if (env.STAGING === "1") return "this is the staging site";
	if (!o.live) return "the site is not live yet";
	if (s.alerts === false) return "alerts are switched off";
	return undefined;
}
export const alertRecipients = (s: AlertSettings, o: BackupsOptions) => (s.alertsTo?.length ? s.alertsTo : o.alertsTo);

async function alert(d: RunDeps, recovery: boolean, s?: RunStatus): Promise<boolean> {
	const settings = await settingsOf(d.kv);
	const blocked = alertBlocked(d.options, d.env, settings);
	if (blocked) {
		d.log?.info("backup alert not emailed", { why: blocked });
		return false;
	}
	const o = d.options;
	const subject = recovery ? `${o.siteName}: backups work again` : `${o.siteName}: the nightly backup failed`;
	const lines = recovery
		? ["The nightly backup works again; a new backup was stored just now.", "Nothing else needs doing."]
		: [`The nightly backup failed ${plural(s?.failures ?? ALERT_AFTER, "time")} in a row (last try ${new Date(d.now).toISOString().slice(0, 16).replace("T", " ")} UTC).`, `Reason: ${s?.lastError ?? "unknown"}.`, "Earlier backups are still there, and the database can still be restored to any minute of the last 30 days (D1 Time Travel). It is retried every hour; please check the Backups page."];
	const r = await sendMail(d.env, d.email, alertRecipients(settings, o), alertMail({ siteName: o.siteName, subject, lines, adminUrl: adminUrl(o), footer: o.footer ?? "Backups & Restore", recovery }));
	d.log?.info("backup alert", { recovery, ok: r.ok, ...(r.ok ? {} : { why: r.reason }) });
	return r.ok;
}

/** At most this many pre-delete snapshots a day (a bulk delete beyond it relies on the nightly backup and the trash). */
export const MAX_PREDELETE_PER_DAY = 200;

/**
 * Before an entry goes to the trash (content:beforeDelete): a small backup holding just that entry, its SEO row and its
 * collection's definition, restorable from the Backups page like any other. Never throws, never blocks the delete.
 */
export async function snapshotEntry(d: RunDeps, collection: string, id: string): Promise<BackupEntry | undefined> {
	try {
		const table = `ec_${collection}`;
		if (!classifyTable(table).include) return undefined;
		const today = dayOf(d.now);
		if ((await readIndex(d.kv)).filter((e) => e.trigger === "pre-delete" && dayOf(e.at) === today).length >= MAX_PREDELETE_PER_DAY) return undefined;
		const rows = await readRows(d.db, table, "id = ?", [id]);
		if (!rows.length) return undefined;
		const seo = await readRows(d.db, "_emdash_seo", "collection = ? AND content_id = ?", [collection, id]).catch(() => []);
		const coll = await readRows(d.db, "_emdash_collections", "slug = ?", [collection]).catch(() => []);
		const fields = coll[0] ? await readRows(d.db, "_emdash_fields", "collection_id = ?", [coll[0].id]).catch(() => []) : [];
		const tables: BackupDoc["tables"] = { [table]: { columns: Object.keys(rows[0] as object), rows }, ...(seo.length ? { _emdash_seo: { columns: Object.keys(seo[0] as object), rows: seo } } : {}), ...(coll.length ? { _emdash_collections: { columns: Object.keys(coll[0] as object), rows: coll } } : {}), ...(fields.length ? { _emdash_fields: { columns: Object.keys(fields[0] as object), rows: fields } } : {}) };
		const key = backupKey(new Date(d.now), "pre-delete", randomHex(4));
		const createdAt = new Date(d.now).toISOString();
		const doc: BackupDoc = { format: FORMAT, version: FORMAT_VERSION, id: idOfKey(key) as string, createdAt, trigger: "pre-delete", site: { name: d.options.siteName, url: d.options.productionUrl }, timeTravel: { timestamp: createdAt }, tables, skipped: [{ table: "*", why: `snapshot of one entry before it was moved to the trash: "${entryTitle(rows[0] as Record<string, unknown>)}"` }], media: { objects: [], truncated: false }, counts: countsOf(tables, 0) };
		const { entry } = await storeDoc(d, doc, key);
		d.log?.info("pre-delete snapshot", { collection, bytes: entry.bytes });
		return entry;
	} catch (e) {
		d.log?.warn?.("pre-delete snapshot failed", { collection, reason: (e as Error)?.name ?? "Error" });
		return undefined;
	}
}
