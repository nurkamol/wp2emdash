/**
 * When backups run, and which ones are kept.
 *
 * EmDash plugin cron (run by the Worker's existing `*\/5 * * * *` trigger through EmDash's scheduled handler) runs the
 * task `nightly` once an hour at a minute fixed per site (0–59, from the host), so sites sharing an account do not all
 * back up at once. A run is due when today's (UTC) nightly backup has not succeeded yet and the site's hour has come
 * (01, 02 or 03 UTC, fixed per site, or `hourUtc`). A failed attempt is retried the next hour, at most MAX_ATTEMPTS a
 * day; two failed attempts in a row send one alert email that day.
 *
 * Retention (pure, `planRetention`): every backup of the last `daily` days (manual and pre-restore ones included) plus
 * the first full backup of each of the last `monthly` calendar months. The newest full backup is never removed.
 * Pre-delete snapshots (one entry each, taken when an entry is moved to the trash) follow the daily window only.
 */
import type { BackupEntry } from "./format.js";
import { DAY, dayOf, hash32, MINUTE, monthOf } from "./util.js";

export const TASK = "nightly";
export const MAX_ATTEMPTS = 4;
/** "Back up now": at most once per this interval. */
export const MANUAL_EVERY = 2 * MINUTE;
/** A run holds the lock this long at most (a crashed run frees it). */
export const LOCK_MS = 5 * MINUTE;
/** Failed attempts in a row before the alert email. */
export const ALERT_AFTER = 2;

export const DEFAULT_RETENTION = { daily: 30, monthly: 12 } as const;

/** The cron expression of the hourly task: a minute fixed per site. */
export const cronSchedule = (host: string) => `${hash32(`backups:${host}`) % 60} * * * *`;
/** The UTC hour from which the nightly backup runs: 01–03 per site, or the configured hour. */
export const nightlyHour = (host: string, override?: number) => (override !== undefined && Number.isInteger(override) && override >= 0 && override <= 23 ? override : 1 + (hash32(`backups-hour:${host}`) % 3));

export interface RunStatus {
	/** Last nightly backup that succeeded (day, YYYY-MM-DD). */
	nightlyDay?: string;
	lastSuccessAt?: string;
	lastAttemptAt?: string;
	/** Short reason of the last failure (never content, never secrets). */
	lastError?: string;
	/** Failed attempts in a row (any trigger). */
	failures: number;
	/** Attempts of the nightly backup today: { day, n }. */
	attempts?: { day: string; n: number };
	/** Day the failure alert went out (one a day). */
	alertedDay?: string;
	/** Last "Back up now". */
	manualAt?: string;
}

export function nightlyDue(now: number, s: RunStatus, hour: number): boolean {
	const today = dayOf(now);
	if (s.nightlyDay === today) return false;
	if (new Date(now).getUTCHours() < hour) return false;
	return !(s.attempts?.day === today && s.attempts.n >= MAX_ATTEMPTS);
}

/** Which backups to keep and which to delete (pure). */
export function planRetention(entries: BackupEntry[], now: number, r: { daily?: number; monthly?: number } = {}): { keep: BackupEntry[]; drop: BackupEntry[] } {
	const daily = Math.max(1, Math.min(366, Math.trunc(r.daily ?? DEFAULT_RETENTION.daily)));
	const monthly = Math.max(0, Math.min(120, Math.trunc(r.monthly ?? DEFAULT_RETENTION.monthly)));
	const sorted = [...entries].sort((a, b) => (a.at < b.at ? 1 : -1));
	const cutoff = dayOf(now - (daily - 1) * DAY);
	const keepIds = new Set<string>();
	const newestFull = sorted.find((e) => e.trigger !== "pre-delete");
	if (newestFull) keepIds.add(newestFull.id);
	for (const e of sorted) if (dayOf(e.at) >= cutoff) keepIds.add(e.id);
	const firstOfMonth = new Map<string, BackupEntry>();
	// Monthly copies are full backups: a snapshot of one deleted entry never stands in for a month.
	for (const e of sorted) {
		if (e.trigger === "pre-delete") continue;
		const m = monthOf(e.at);
		const cur = firstOfMonth.get(m);
		if (!cur || e.at < cur.at) firstOfMonth.set(m, e);
	}
	const months = [...firstOfMonth.keys()].sort().reverse().slice(0, monthly);
	for (const m of months) keepIds.add((firstOfMonth.get(m) as BackupEntry).id);
	return { keep: sorted.filter((e) => keepIds.has(e.id)), drop: sorted.filter((e) => !keepIds.has(e.id)) };
}
