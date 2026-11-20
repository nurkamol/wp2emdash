/**
 * Verify: the Backups plugin (@wp2emdash/backups) is registered on the target and, on a live site, its nightly backup
 * ran recently. Reads the plugin's public `heartbeat` route (plugin id, version, time of the last good backup and
 * whether the last attempt worked — nothing else).
 */
export const BACKUPS_ID = "site-backups";
/** One missed night plus slack. */
export const BACKUP_STALE_MS = 36 * 3_600_000;

export interface BackupsProbe {
	ok: boolean;
	detail: string;
	lastBackupAt?: string;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export async function backupsHeartbeat(base: string, o: { fetch: Fetch; live: boolean; now?: number }): Promise<BackupsProbe> {
	const now = o.now ?? Date.now();
	let res: Response;
	try {
		res = await o.fetch(`${base.replace(/\/$/, "")}/_emdash/api/plugins/${BACKUPS_ID}/heartbeat`);
	} catch (e) {
		return { ok: false, detail: `heartbeat not reachable (${(e as Error).message})` };
	}
	if (res.status === 404) return { ok: false, detail: "plugin not registered on the target (404): deploy the scaffolded project" };
	if (!res.ok) return { ok: false, detail: `heartbeat answered HTTP ${res.status}` };
	const data = ((await res.json().catch(() => ({}))) as { data?: { lastBackupAt?: string | null; ok?: boolean; version?: string } }).data;
	const last = data?.lastBackupAt ?? undefined;
	const age = last ? now - Date.parse(last) : Number.POSITIVE_INFINITY;
	const what = `last backup ${Number.isFinite(age) ? `${Math.round(age / 3_600_000)} h ago` : "never"}${data?.ok === false ? ", last attempt failed" : ""}${data?.version ? ` (v${data.version})` : ""}`;
	const extra = last ? { lastBackupAt: last } : {};
	if (!o.live) return { ok: true, detail: `registered; ${what}. Not live yet: recency not gated.`, ...extra };
	if (age > BACKUP_STALE_MS) return { ok: false, detail: `registered, but ${what}: open Plugins → Backups (Back up now; the nightly task is rescheduled when the page opens) and check the Worker's cron trigger.`, ...extra };
	return { ok: data?.ok !== false, detail: `registered; ${what}`, ...extra };
}
