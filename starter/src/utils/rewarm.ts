/**
 * Page cache refill ("re-warm") from the Worker's own cron. Every edit purges the cached pages (EmDash purges by tag
 * on publish, menus, settings), and the next visitor of each page then waits for a full render (1.5–2.5 s instead of
 * ~0.25 s). On each window the cron requests the sitemap's pages from the live address: a page still cached is a cache
 * hit (the Worker does not run for it), a purged one renders once, here, instead of for a visitor. Warming reaches
 * Cloudflare's upper tier, so other locations get a fast hit too. Confirmed on a live Custom Domain
 * (docs/spikes/performance-findings.md). Never throws: the cron's other work goes on.
 *
 * Admins switch it on/off, pick the interval and ask for a full refresh on Site health → Speed; the rows below are that
 * plugin's KV (packages/health/src/cache.ts has the plugin's copy — Site health can be switched off, so this file
 * keeps its own; test/cache-refill.test.ts keeps them in step). No setting stored: on, at the kit's interval.
 * No imports: this file loads in the Worker and in the kit's tests.
 */

export const REWARM_OPTIONS = {
	setting: "plugin:site-health:rewarm",
	request: "plugin:site-health:rewarm:request",
	last: "plugin:site-health:rewarm:last",
	maintenance: "plugin:site-health:maintenance",
} as const;

/** Pages requested per run at most (well under the Workers subrequest limit), and how many at once. */
export const REWARM_MAX = 120;
const AT_ONCE = 4;
/** Pages kept in the stored result (the Speed tab's table). */
const LIST_MAX = 120;

export interface RewarmSetting {
	on: boolean;
	everyMinutes: number;
}

/** The stored setting (JSON from D1), else the default (on at the kit's interval; off when that is 0). */
export function parseRewarmSetting(raw: unknown, defaultMinutes: number): RewarmSetting {
	const fallback: RewarmSetting = { on: defaultMinutes > 0, everyMinutes: defaultMinutes > 0 ? defaultMinutes : 15 };
	let v: unknown = raw;
	if (typeof raw === "string") {
		try {
			v = JSON.parse(raw);
		} catch {
			return fallback;
		}
	}
	if (!v || typeof v !== "object") return fallback;
	const o = v as Record<string, unknown>;
	const minutes = Number(o.everyMinutes);
	return { on: o.on === true, everyMinutes: Number.isInteger(minutes) && minutes >= 5 ? minutes : fallback.everyMinutes };
}

/**
 * Coming-soon mode is showing at `now`: the switch is on, or `now` is inside its schedule [startAt, endAt) (either end
 * open). A copy of `maintenanceActive` in utils/maintenance.ts (no imports here); test/coming-soon-schedule.test.ts
 * keeps them in step.
 */
export function maintenanceOn(raw: unknown, now: number): boolean {
	try {
		const v = typeof raw === "string" ? JSON.parse(raw) : raw;
		if (!v || typeof v !== "object") return false;
		const o = v as { on?: unknown; startAt?: unknown; endAt?: unknown };
		if (o.on === true) return true;
		const t = (x: unknown) => (typeof x === "string" && x ? Date.parse(x) : Number.NaN);
		const start = t(o.startAt);
		const end = t(o.endAt);
		if (Number.isNaN(start) && Number.isNaN(end)) return false;
		return (Number.isNaN(start) || now >= start) && (Number.isNaN(end) || now < end);
	} catch {
		return false;
	}
}

/** True on the cron tick that starts each `everyMinutes` window (the cron runs every 5 minutes). */
export function rewarmDue(scheduledTime: number, everyMinutes: number): boolean {
	if (!(everyMinutes > 0)) return false;
	return Math.floor(scheduledTime / 60_000) % everyMinutes < 5;
}

export type RewarmPlan = { run: false; reason: "off" | "not-due" | "coming-soon" } | { run: true; trigger: "schedule" | "manual" };

/** What this cron tick does, from the stored rows (D1 values: JSON strings, or null when absent). */
export function planRewarm(rows: { setting?: unknown; request?: unknown; maintenance?: unknown }, scheduledTime: number, defaultMinutes: number): RewarmPlan {
	if (maintenanceOn(rows.maintenance, scheduledTime)) return { run: false, reason: "coming-soon" };
	if (rows.request !== undefined && rows.request !== null) return { run: true, trigger: "manual" };
	const s = parseRewarmSetting(rows.setting ?? null, defaultMinutes);
	if (!s.on) return { run: false, reason: "off" };
	return rewarmDue(scheduledTime, s.everyMinutes) ? { run: true, trigger: "schedule" } : { run: false, reason: "not-due" };
}

/** `<loc>` values of a sitemap or sitemap index, kept to the site's own origin (path and query only). */
export function sitemapLocs(xml: string, origin: string): string[] {
	const out: string[] = [];
	for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
		const raw = (m[1] as string).replace(/&amp;/g, "&");
		if (!URL.canParse(raw, origin)) continue;
		const u = new URL(raw, origin);
		out.push(`${origin}${u.pathname}${u.search}`);
	}
	return out;
}

export interface RewarmPage {
	path: string;
	state: "cached" | "rendered" | "failed";
	status: number;
}

export interface RewarmResult {
	pages: number;
	rendered: number;
	failed: number;
	ms: number;
	list: RewarmPage[];
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Requests every page in the sitemap (and its child sitemaps) once. */
export async function rewarm(origin: string, fetchFn: Fetch = fetch, max = REWARM_MAX, now: () => number = Date.now): Promise<RewarmResult> {
	const started = now();
	const base = new URL(origin).origin;
	const init: RequestInit = { redirect: "manual", headers: { "user-agent": "site-rewarm (+cron)" } };
	const text = async (url: string) => {
		try {
			const r = await fetchFn(url, init);
			return r.status === 200 ? await r.text() : "";
		} catch {
			return "";
		}
	};
	const urls = new Set<string>();
	for (const loc of sitemapLocs(await text(`${base}/sitemap.xml`), base)) {
		if (urls.size >= max) break;
		if (/\.xml$/.test(new URL(loc).pathname)) for (const u of sitemapLocs(await text(loc), base)) urls.add(u);
		else urls.add(loc);
	}
	const targets = [...urls].slice(0, max);
	const list: RewarmPage[] = [];
	for (let i = 0; i < targets.length; i += AT_ONCE) {
		list.push(
			...(await Promise.all(
				targets.slice(i, i + AT_ONCE).map(async (u): Promise<RewarmPage> => {
					const path = new URL(u).pathname + new URL(u).search;
					try {
						const r = await fetchFn(u, init);
						await r.body?.cancel();
						return { path, status: r.status, state: r.status >= 400 ? "failed" : r.headers.get("cf-cache-status") === "HIT" ? "cached" : "rendered" };
					} catch {
						return { path, status: 0, state: "failed" };
					}
				}),
			)),
		);
	}
	return { pages: list.length, rendered: list.filter((p) => p.state === "rendered").length, failed: list.filter((p) => p.state === "failed").length, ms: now() - started, list: list.slice(0, LIST_MAX) };
}

interface D1Like {
	prepare(q: string): { bind(...v: unknown[]): { all<T>(): Promise<{ results: T[] }>; run(): Promise<unknown> } };
}

/**
 * One cron tick: reads the admin's rows, refills when due (or asked), stores the result and clears the request.
 * Returns what it did, for the log.
 */
export async function rewarmTick(db: D1Like | undefined, cfg: { origin: string; everyMinutes: number }, scheduledTime: number, fetchFn: Fetch = fetch, id: () => string = () => crypto.randomUUID()): Promise<string | undefined> {
	let rows: Record<string, unknown> = {};
	if (db) {
		try {
			const r = await db.prepare("SELECT name, value FROM options WHERE name IN (?, ?, ?)").bind(REWARM_OPTIONS.setting, REWARM_OPTIONS.request, REWARM_OPTIONS.maintenance).all<{ name: string; value: string }>();
			for (const x of r.results) rows[x.name] = x.value;
		} catch {
			rows = {};
		}
	}
	const plan = planRewarm({ setting: rows[REWARM_OPTIONS.setting], request: rows[REWARM_OPTIONS.request], maintenance: rows[REWARM_OPTIONS.maintenance] }, scheduledTime, cfg.everyMinutes);
	if (!plan.run) return plan.reason === "not-due" ? undefined : `rewarm skipped: ${plan.reason}`;
	const r = await rewarm(cfg.origin, fetchFn);
	if (db) {
		const last = { at: new Date(scheduledTime).toISOString(), trigger: plan.trigger, ...r };
		try {
			await db.prepare("INSERT INTO options (name, value, revision) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, revision = excluded.revision").bind(REWARM_OPTIONS.last, JSON.stringify(last), id()).run();
			if (plan.trigger === "manual") await db.prepare("DELETE FROM options WHERE name = ?").bind(REWARM_OPTIONS.request).run();
		} catch {}
	}
	return `rewarm (${plan.trigger}): ${r.pages} pages, ${r.rendered} rendered, ${r.failed} failed`;
}
