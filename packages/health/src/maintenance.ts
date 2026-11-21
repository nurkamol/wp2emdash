/**
 * Coming-soon mode, the plugin's side: the stored row (KEYS.maintenance = EmDash `options` row
 * `plugin:site-health:maintenance`, which the starter's middleware reads on every rendered request), whether it is
 * active at a time (the manual switch, or now inside the optional schedule), and the cron's boundary step.
 *
 * The starter keeps its own copy of `maintenanceActive` (starter/src/utils/maintenance.ts, and `maintenanceOn` in
 * starter/src/utils/rewarm.ts): Site health can be switched off and the starter must not import it.
 * test/coming-soon-schedule.test.ts keeps the three in step.
 */
import { KEYS, type Kv } from "./store.js";

/** Coming-soon mode as stored. */
export interface MaintenanceSetting {
	/** The manual switch: on forces the holding page, whatever the schedule says. */
	on: boolean;
	heading?: string;
	message?: string;
	/** "Expected back" (ISO): Retry-After when no end time is scheduled. */
	until?: string;
	/** Scheduled start (ISO, UTC). Empty with an end time: from now. */
	startAt?: string;
	/** Scheduled end (ISO, UTC): the holding page stops; also Retry-After and "Back at" on the holding page. */
	endAt?: string;
	at?: string;
	/** Key of the preview link (`?preview=<key>`): people without an admin account see the site while the mode is on. */
	previewKey?: string;
}

const time = (v: unknown) => (typeof v === "string" && v ? Date.parse(v) : Number.NaN);

/** A start or an end time is set. */
export const maintenanceScheduled = (s: Partial<MaintenanceSetting> | null | undefined) => !!s && (!Number.isNaN(time(s.startAt)) || !Number.isNaN(time(s.endAt)));

/** The holding page shows: the manual switch is on, or `now` is inside [startAt, endAt) (either end may be open). */
export function maintenanceActive(s: Partial<MaintenanceSetting> | null | undefined, now: number): boolean {
	if (!s || typeof s !== "object") return false;
	if (s.on === true) return true;
	const start = time(s.startAt);
	const end = time(s.endAt);
	if (Number.isNaN(start) && Number.isNaN(end)) return false;
	return (Number.isNaN(start) || now >= start) && (Number.isNaN(end) || now < end);
}

/** The schedule is still ahead (start in the future): "scheduled for …". */
export function maintenanceUpcoming(s: Partial<MaintenanceSetting> | null | undefined, now: number): boolean {
	return !!s && !maintenanceActive(s, now) && time(s.startAt) > now;
}

/** "2026-12-01 09:00 UTC" for an ISO time. */
export const utcText = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** The schedule in words, e.g. "from 2026-12-01 09:00 UTC until 2026-12-02 09:00 UTC"; empty without one. */
export function scheduleText(s: Partial<MaintenanceSetting> | null | undefined): string {
	if (!s) return "";
	const start = s.startAt && !Number.isNaN(time(s.startAt)) ? s.startAt : undefined;
	const end = s.endAt && !Number.isNaN(time(s.endAt)) ? s.endAt : undefined;
	if (start && end) return `from ${utcText(start)} until ${utcText(end)}`;
	if (start) return `from ${utcText(start)} (no end time: switch it off in Settings)`;
	if (end) return `until ${utcText(end)}`;
	return "";
}

/** What the cron last applied (cached pages purged for that state). */
export interface MaintenanceApplied {
	active: boolean;
	at: string;
}

export type PurgeFn = () => Promise<string>;

/**
 * One cron tick (every 5 minutes): when the active state changed since it was last applied — a scheduled start or end
 * passed — purge the cached pages once (a cached page never reaches the middleware) and remember the state. Saving the
 * form purges and records the state itself, so a change made there is not purged twice.
 */
export async function applyMaintenanceSchedule(kv: Kv, now: number, purge: PurgeFn): Promise<{ changed: boolean; active: boolean; purge?: string }> {
	const active = maintenanceActive(await kv.get<MaintenanceSetting>(KEYS.maintenance), now);
	const last = await kv.get<MaintenanceApplied>(KEYS.maintenanceApplied);
	if ((last?.active ?? false) === active) {
		if (!last) await kv.set(KEYS.maintenanceApplied, { active, at: new Date(now).toISOString() });
		return { changed: false, active };
	}
	const purged = await purge();
	await kv.set(KEYS.maintenanceApplied, { active, at: new Date(now).toISOString() });
	return { changed: true, active, purge: purged };
}
