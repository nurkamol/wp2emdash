/**
 * What the plugin keeps (EmDash plugin KV: one D1 `options` row per key, JSON). Compact by design: the current state of
 * each check, today's probe samples, one row per day for 90 days, the last 100 incidents (90 days), the last link
 * check, a ledger of broken links (400 days), the alert log (7 days) and 12 monthly reports. No personal data: URLs of
 * the site's own pages, numbers and dates only.
 */
import { DAY, dayOf } from "./util.js";

export interface Kv {
	get<T>(key: string): Promise<T | null>;
	set(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<boolean>;
	list?(prefix?: string): Promise<Array<{ key: string; value: unknown }>>;
	getVersioned?<T>(key: string): Promise<{ value: T; revision: string } | null>;
	compareAndSet?(key: string, expectedRevision: string | null, value: unknown): Promise<{ applied: true; revision: string } | { applied: false }>;
}

// New checks go at the end: each history row stores the day's statuses by position.
export const CHECK_IDS = ["uptime", "indexability", "forms", "links", "dns", "ssl", "speed", "analytics", "backups", "media", "notfound", "security"] as const;
export type CheckId = (typeof CHECK_IDS)[number];
export type Status = "ok" | "warn" | "fail" | "off" | "unknown";

export const CHECK_LABELS: Record<CheckId, string> = {
	uptime: "Uptime",
	indexability: "Search engines",
	forms: "Form messages",
	links: "Broken links",
	dns: "Email DNS records",
	ssl: "Security certificate",
	speed: "Speed",
	analytics: "Analytics tags",
	backups: "Backups",
	media: "Media",
	notfound: "Missing pages (404)",
	security: "Security headers",
};

export interface CheckState {
	status: Status;
	/** One plain sentence. */
	summary: string;
	at: string;
	/** Short facts (paths, counts), never personal data. */
	detail?: string[];
}

export interface OpenIncident {
	id: string;
	path: string;
	startedAt: string;
	status: number;
}

export interface HealthState {
	v: 1;
	lastRunAt?: string;
	/** When each scheduled job last ran (ISO). */
	jobs: Record<string, string>;
	checks: Partial<Record<CheckId, CheckState>>;
	uptime: {
		/** Consecutive failures per path. */
		fails: Record<string, number>;
		/** Open incidents per path. */
		open: Record<string, OpenIncident>;
		/** Next sitemap page to sample. */
		cursor: number;
		/** Paths that failed once: probed again on the next run before the rotation moves on. */
		retry: string[];
	};
	/** Sitemap paths (refreshed hourly). */
	sitemap?: { at: string; paths: string[] };
	forms?: { waiting: number; failed: number; lastEmailedDay?: string };
	/** Last day an email went out for a monthly report (YYYY-MM). */
	reportSent?: string;
}

export const emptyState = (): HealthState => ({ v: 1, jobs: {}, checks: {}, uptime: { fails: {}, open: {}, cursor: 0, retry: [] } });

/** Today's home-page probes (uptime % and the render-time median come from these). */
export interface Today {
	d: string;
	probes: number;
	fails: number;
	/** Render times of successful home-page probes, ms (at most 300). */
	ttfb: number[];
}

/** One row per day, newest last, 90 days. */
export interface DayRow {
	d: string;
	probes: number;
	fails: number;
	ttfb50?: number;
	/** CrUX p75 (origin, all devices) as fetched that day. */
	lcp?: number;
	inp?: number;
	cls?: number;
	/** Broken internal links found by that day's check. */
	broken?: number;
	/** Status of each check at the end of the day (first letter: o/w/f/x/u). */
	s?: string;
}

export type IncidentKind = "down" | "page" | "indexability" | "forms" | "links" | "dns" | "ssl" | "analytics";
export interface Incident {
	id: string;
	kind: IncidentKind;
	title: string;
	startedAt: string;
	endedAt?: string;
	/** Paths, statuses or counts. */
	detail?: string;
}

export interface BrokenLink {
	url: string;
	status: number;
	/** Pages linking to it (paths, at most 3). */
	on: string[];
	external?: boolean;
	note?: string;
}

export interface LinksResult {
	at: string;
	pages: number;
	checked: number;
	broken: BrokenLink[];
	/** Last weekly check of links to other sites. */
	external?: { at: string; checked: number; broken: number; unchecked: number };
}

/** Broken links by URL: when first found and when fixed (for the report's "fixed / still open"). */
export type LinkLedger = Record<string, { first: string; fixed?: string; external?: boolean }>;

export interface Cwv {
	at: string;
	/** p75 values: LCP and INP in ms, CLS unitless. */
	lcp?: number;
	inp?: number;
	cls?: number;
	/** Why there is no data (no key, not enough Chrome visitors, an error). */
	missing?: string;
}

export interface Settings {
	alertsTo?: string[];
	reportTo?: string[];
	alerts?: boolean;
	report?: boolean;
}

export const KEYS = {
	state: "state",
	today: "today",
	history: "history",
	incidents: "incidents",
	links: "links",
	linkJob: "links:job",
	ledger: "links:ledger",
	cwv: "cwv",
	alerts: "alerts",
	settings: "settings",
	lock: "lock",
	reports: "reports",
	/** The week's most requested missing addresses with suggested redirects (checks/notfound.ts). */
	notFound: "notfound",
	/** Coming-soon mode (the starter's middleware reads this row: `plugin:site-health:maintenance`). */
	maintenance: "maintenance",
	/** CSP violation reports from visitors' browsers and the reporting switch (csp.ts). */
	csp: "csp",
	/** The home page's security headers, read hourly (checks/headers.ts). */
	security: "security",
	/** The coming-soon state the cron last purged the page cache for (scheduled start / end, maintenance.ts). */
	maintenanceApplied: "maintenance:applied",
	/** Missing addresses redirected from the Missing pages tab: path → target and when (left out of the list). */
	redirected: "notfound:redirected",
	/** The SEO summary the last monthly report calculated (@wp2emdash/seo/summary), for "What to improve" (improve.ts). */
	seoSummary: "improve:seo",
	report: (month: string) => `report:${month}`,
	download: (token: string) => `dl:${token}`,
} as const;

export const HISTORY_DAYS = 90;
export const MAX_INCIDENTS = 100;
export const MAX_REPORTS = 12;

/** Adds today's samples to the history when the day changed; keeps 90 days. Pure. */
export function rollDay(history: DayRow[], today: Today | null, now: number, extra: Partial<DayRow> = {}): { history: DayRow[]; today: Today } {
	const d = dayOf(now);
	let out = history;
	if (today && today.d !== d) out = upsertDay(out, today.d, { probes: today.probes, fails: today.fails, ...(today.ttfb.length ? { ttfb50: medianOf(today.ttfb) } : {}), ...extra });
	return { history: out, today: today && today.d === d ? today : { d, probes: 0, fails: 0, ttfb: [] } };
}

const medianOf = (v: number[]) => {
	const s = [...v].sort((a, b) => a - b);
	const m = Math.floor(s.length / 2);
	return s.length % 2 ? (s[m] as number) : Math.round(((s[m - 1] as number) + (s[m] as number)) / 2);
};

/** Sets fields of one day's row (created when missing), sorted, trimmed to HISTORY_DAYS. Pure. */
export function upsertDay(history: DayRow[], d: string, patch: Partial<DayRow>): DayRow[] {
	const rows = history.filter((r) => r.d !== d);
	const old = history.find((r) => r.d === d) ?? { d, probes: 0, fails: 0 };
	rows.push({ ...old, ...patch, d });
	rows.sort((a, b) => (a.d < b.d ? -1 : 1));
	return rows.slice(-HISTORY_DAYS);
}

/** Keeps incidents of the last 90 days (open ones always), newest first, at most 100. Pure. */
export function pruneIncidents(list: Incident[], now: number): Incident[] {
	const cutoff = now - HISTORY_DAYS * DAY;
	return list
		.filter((i) => !i.endedAt || Date.parse(i.endedAt) >= cutoff)
		.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
		.slice(0, MAX_INCIDENTS);
}

export async function readState(kv: Kv): Promise<HealthState> {
	const s = await kv.get<HealthState>(KEYS.state);
	if (!s || s.v !== 1) return emptyState();
	return { ...emptyState(), ...s, uptime: { ...emptyState().uptime, ...(s.uptime ?? {}) }, jobs: s.jobs ?? {}, checks: s.checks ?? {} };
}
