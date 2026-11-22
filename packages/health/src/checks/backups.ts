/**
 * Backups: the last backup of @wp2emdash/backups, read from that plugin's public heartbeat through the Worker itself
 * (the time of the last good backup and whether the last attempt worked — nothing else). Hourly; no request leaves the
 * site. Plus the last restore test, read from the backups plugin's KV row in D1 (one SELECT; counts and dates only): a failed test turns a good check into a warning.
 */
import type { Fetcher } from "../probe.js";
import type { CheckState } from "../store.js";
import { HOUR, shortTime } from "../util.js";

export const BACKUPS_HEARTBEAT = "/_emdash/api/plugins/site-backups/heartbeat";
/** A nightly backup older than this is a problem (one missed night plus slack). */
export const BACKUP_STALE_MS = 36 * HOUR;

export interface BackupBeat {
	status: number;
	lastBackupAt?: string | null;
	ok?: boolean;
}

export async function readBackupBeat(self: Fetcher, origin: string): Promise<BackupBeat> {
	try {
		const res = await self(`${origin}${BACKUPS_HEARTBEAT}`, { signal: AbortSignal.timeout(8_000) });
		if (!res.ok) {
			await res.body?.cancel();
			return { status: res.status };
		}
		const j = (await res.json().catch(() => ({}))) as { data?: { lastBackupAt?: string | null; ok?: boolean } };
		return { status: res.status, lastBackupAt: j.data?.lastBackupAt ?? null, ok: j.data?.ok !== false };
	} catch {
		return { status: 0 };
	}
}

/** The backups plugin's KV row in D1 holding its restore test (`options`, plugin:site-backups:drill; @wp2emdash/backups ≥ 0.2). */
export const DRILL_OPTION = "plugin:site-backups:drill";
/** A monthly restore test older than this is mentioned (30 days + slack). */
export const DRILL_STALE_MS = 45 * 24 * HOUR;

/** The last restore test, as Site health needs it: when, passed or not, how much was checked. Counts only. */
export interface DrillSummary {
	at: string;
	ok: boolean;
	mode?: "scratch" | "dry-run";
	tables?: number;
	rows?: number;
	mediaSampled?: number;
	reason?: string;
}

/** One SELECT of the backups plugin's KV row (no request, no public route). undefined: unreadable; null: no test yet. */
export async function readDrillSummary(db: unknown): Promise<DrillSummary | null | undefined> {
	const prep = (db as { prepare?(q: string): { bind?(...v: unknown[]): { all?<T>(): Promise<{ results?: T[] }> } } } | undefined)?.prepare?.("SELECT value FROM options WHERE name = ? LIMIT 1");
	const stmt = prep?.bind?.(DRILL_OPTION);
	if (!stmt?.all) return undefined;
	try {
		const row = ((await stmt.all<{ value: string }>()).results ?? [])[0];
		if (!row) return null;
		const last = (JSON.parse(row.value) as { last?: DrillSummary })?.last;
		if (!last || typeof last.at !== "string" || typeof last.ok !== "boolean") return null;
		return { at: last.at, ok: last.ok, ...(last.mode ? { mode: last.mode } : {}), ...(typeof last.tables === "number" ? { tables: last.tables } : {}), ...(typeof last.rows === "number" ? { rows: last.rows } : {}), ...(typeof last.mediaSampled === "number" ? { mediaSampled: last.mediaSampled } : {}), ...(typeof last.reason === "string" ? { reason: last.reason.slice(0, 160) } : {}) };
	} catch {
		return undefined;
	}
}

const drillDetail = (t: DrillSummary, now: number): string[] => {
	const line = `Last restore test: ${t.ok ? "passed" : "failed"} ${t.at.slice(0, 10)}${t.rows !== undefined ? `, ${t.rows.toLocaleString("en-US")} rows across ${t.tables ?? 0} tables` : ""}${t.mediaSampled !== undefined ? `, ${t.mediaSampled} media sampled` : ""}${t.mode === "dry-run" ? " (dry run)" : ""}.`;
	return [line, ...(now - Date.parse(t.at) > DRILL_STALE_MS ? [`No restore test for ${Math.round((now - Date.parse(t.at)) / (24 * HOUR))} days.`] : [])];
};

/** The Backups check with the restore test folded in: a failed test turns an otherwise good check into a warning. */
export function backupsCheck(on: boolean, beat: BackupBeat | undefined, at: string, now = Date.now(), drill?: DrillSummary | null): CheckState {
	const c = beatCheck(on, beat, at, now);
	if (!drill || c.status === "off") return c;
	const detail = [...(c.detail ?? []), ...drillDetail(drill, now)];
	if (!drill.ok && c.status === "ok") return { status: "warn", summary: `Backups run, but the last restore test failed (${drill.at.slice(0, 10)}${drill.reason ? `: ${drill.reason}` : ""}). See Plugins → Backups.`, at, detail };
	return { ...c, detail };
}

function beatCheck(on: boolean, beat: BackupBeat | undefined, at: string, now: number): CheckState {
	if (!on) return { status: "off", summary: "Backups are off for this site (kit.config backups: false); the database can still be restored to any minute of the last 30 days.", at };
	if (!beat || beat.status === 0) return { status: "unknown", summary: "The backups plugin did not answer this time.", at };
	if (beat.status === 404) return { status: "fail", summary: "The backups plugin is not installed on this deployment: ask your developer to rerun the scaffold and deploy.", at };
	if (beat.status !== 200) return { status: "unknown", summary: `The backups plugin answered HTTP ${beat.status}.`, at };
	if (!beat.lastBackupAt) return beat.ok ? { status: "unknown", summary: "No backup yet: the first nightly backup runs between 01:00 and 04:00 UTC.", at } : { status: "fail", summary: "Backups are failing and none is stored yet. See Plugins → Backups.", at };
	const age = now - Date.parse(beat.lastBackupAt);
	if (age > BACKUP_STALE_MS) return { status: "fail", summary: `The last backup is from ${shortTime(beat.lastBackupAt)} (${Math.round(age / HOUR)} hours ago). See Plugins → Backups.`, at };
	if (!beat.ok) return { status: "warn", summary: `The last backup attempt failed; the last good backup is from ${shortTime(beat.lastBackupAt)}. It is retried every hour.`, at };
	return { status: "ok", summary: `Last backup ${shortTime(beat.lastBackupAt)}.`, at };
}
