/**
 * When each check runs. The Worker's cron trigger (`*\/5 * * * *`, shared with the form outbox and EmDash's own
 * scheduled work) runs EmDash's plugin cron; this plugin has one task, `tick`, every 5 minutes. Each tick runs the
 * light jobs that are due and at most ONE heavy job, so a single run stays far inside the Worker limits:
 *
 *   light  uptime     every tick         home page + one rotating sitemap page (+ a retry)   ≤ 3 requests to itself
 *          forms      every 15 min       form outbox counts (Workers KV list, no request)
 *          index      hourly             robots.txt + sitemap (index + ≤ 3 child sitemaps)   ≤ 5 requests to itself
 *          analytics  hourly             reads the tags in that tick's home page             0 requests (1 D1 read)
 *          backups    hourly             the backups plugin's heartbeat (@wp2emdash/backups)  1 request to itself
 *          media      hourly             the Media Assistant's scan counts (@wp2emdash/media) 0 requests (1 D1 read)
 *          notfound   hourly             EmDash's 404 log: the week's missing addresses        0 requests (1 D1 read)
 *   heavy  links      daily from 02–04 UTC (per-site offset), then continued tick by tick:     ≤ 12 requests a tick
 *          report     1st of the month from 08 UTC (catch-up until the 3rd)                     1 Cloudflare API call
 *          dns        daily from 05 UTC   mail records over DNS-over-HTTPS (cloudflare-dns.com) ≤ 8 requests
 *          ssl        daily from 06 UTC   certificate packs (Cloudflare API, optional token)    ≤ 2 requests
 *          speed      daily from 07 UTC   Chrome UX Report (optional key)                       1 request
 *
 * Worst case per tick ≈ 3 + 5 + 12 + 3 alert emails ≈ 23 subrequests (Workers: 50 on Free, 10,000 on Paid) and well
 * under a second of CPU (regular-expression parsing of ≤ 12 pages). A heavy job that is due waits for the next tick
 * when another one ran. All times UTC.
 */
import type { HealthState } from "./store.js";
import { dayOf, HOUR, hash32, MINUTE } from "./util.js";

export const TICK_SCHEDULE = "*/5 * * * *";
export const TICK_TASK = "tick";

export type LightJob = "uptime" | "forms" | "index" | "analytics" | "backups" | "media" | "notfound";
export type HeavyJob = "links" | "report" | "dns" | "ssl" | "speed";

export const INTERVALS: Record<LightJob, number> = { uptime: 0, forms: 15 * MINUTE, index: HOUR, analytics: HOUR, backups: HOUR, media: HOUR, notfound: HOUR };
/** Daily jobs: the UTC hour from which they run (links get a per-site offset of 0–2 hours). */
export const DAILY_HOUR: Record<"links" | "dns" | "ssl" | "speed", number> = { links: 2, dns: 5, ssl: 6, speed: 7 };
export const REPORT_HOUR = 8;
/** Requests per tick for the link check, and how many at a time. */
export const LINK_BUDGET = 12;
export const LINK_CONCURRENCY = 3;
/** Links to other sites: checked weekly, this many per week. */
export const EXTERNAL_SAMPLE = 20;
export const EXTERNAL_EVERY = 7 * 24 * HOUR;
/** "Run checks now": at most once per this interval. */
export const MANUAL_EVERY = 2 * MINUTE;
/** A run holds the lock this long at most (a crashed run frees it). */
export const LOCK_MS = 4 * MINUTE;

export interface Plan {
	light: LightJob[];
	heavy?: HeavyJob;
	/** Start a new link check (heavy job "links" then runs its first step). */
	startLinks?: boolean;
}

/** Hour (UTC) from which this site's daily link check runs: 02, 03 or 04, fixed per host. */
export const linksHour = (host: string) => DAILY_HOUR.links + (hash32(host) % 3);

const TOLERANCE = 2 * MINUTE;

export function planRun(now: number, s: Pick<HealthState, "jobs">, o: { host: string; linkJobActive: boolean; reportDue: boolean; manual?: boolean }): Plan {
	const last = (job: string) => (s.jobs[job] ? Date.parse(s.jobs[job] as string) : 0);
	const hour = new Date(now).getUTCHours();
	const today = dayOf(now);
	const ranToday = (job: string) => !!s.jobs[job] && dayOf(s.jobs[job] as string) === today;
	if (o.manual) return { light: ["uptime", "forms", "index", "analytics", "backups", "media", "notfound"], heavy: o.linkJobActive ? "links" : undefined, startLinks: !o.linkJobActive };
	const light = (Object.keys(INTERVALS) as LightJob[]).filter((j) => now - last(j) >= INTERVALS[j] - TOLERANCE);
	// One heavy job per tick, in this order: an unfinished link check first (it is resumable), then the monthly report,
	// then the daily jobs whose hour has come and which have not run today.
	if (o.linkJobActive) return { light, heavy: "links" };
	if (o.reportDue && hour >= REPORT_HOUR) return { light, heavy: "report" };
	if (!ranToday("links") && hour >= linksHour(o.host)) return { light, heavy: "links", startLinks: true };
	for (const job of ["dns", "ssl", "speed"] as const) if (!ranToday(job) && hour >= DAILY_HOUR[job]) return { light, heavy: job };
	return { light };
}

/** Whether the weekly check of links to other sites is due (it rides on the day's link check). */
export const externalDue = (s: Pick<HealthState, "jobs">, now: number) => !s.jobs.external || now - Date.parse(s.jobs.external) >= EXTERNAL_EVERY - HOUR;

/** The monthly report for last month is due from the 1st until the 3rd (catch-up), if it was not made yet. */
export function reportDue(now: number, made: string[], month: string): boolean {
	const d = new Date(now).getUTCDate();
	return d <= 3 && !made.includes(month);
}
