/**
 * Backups: the last backup of @wp2emdash/backups, read from that plugin's public heartbeat through the Worker itself
 * (the time of the last good backup and whether the last attempt worked — nothing else). Hourly; no request leaves the
 * site.
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

export function backupsCheck(on: boolean, beat: BackupBeat | undefined, at: string, now = Date.now()): CheckState {
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
