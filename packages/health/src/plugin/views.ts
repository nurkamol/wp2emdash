/**
 * Site health: Block Kit views (plain JSON, shapes from @emdash-cms/blocks 1.5). Admins only. Plain words; dates in UTC.
 */
import { REWARM_INTERVALS, type RewarmLast, type RewarmSetting } from "../cache.js";
import { MAX_RECIPIENTS } from "@wp2emdash/forms/outbox";
import { missingText, RATING_LABEL, rate } from "../checks/speed.js";
import { type LabRequest, type LabRun, type LabStore, labMissingText, latestOf, scoreLabel, scoreTrend, STRATEGIES } from "../checks/lab.js";
import { headerRows, type SecurityFacts } from "../checks/headers.js";
import { blockedLabel, type CspStore, isScriptDirective, meaning } from "../csp.js";
import { cspLine } from "../report.js";
import type { NotFoundSummary } from "../checks/notfound.js";
import { maintenanceActive, type MaintenanceSetting, maintenanceUpcoming, scheduleText, utcText } from "../maintenance.js";
import type { ReportData } from "../report.js";
import { headline } from "../report.js";
import { CHECK_IDS, CHECK_LABELS, type CheckId, type Cwv, type DayRow, type HealthState, type Incident, type LinksResult, type Settings, type Status, type Today } from "../store.js";
import { duration, median, monthName, plural, shortTime } from "../util.js";

export type Block = Record<string, unknown>;

export const PAGE = "/health";
export const WIDGET = "site-health";
export const TABS = { overview: 0, incidents: 1, links: 2, missing: 3, speed: 4, security: 5, reports: 6, settings: 7 } as const;

/** Coming-soon mode as stored (KEYS.maintenance; the starter's middleware reads the same row). */
export type { MaintenanceSetting };

export type Overall = "healthy" | "attention" | "down" | "unknown";

export function overallOf(s: Pick<HealthState, "lastRunAt" | "checks" | "uptime">): Overall {
	if (!s.lastRunAt) return "unknown";
	if (s.uptime.open["/"]) return "down";
	return Object.values(s.checks).some((c) => c && (c.status === "fail" || c.status === "warn")) ? "attention" : "healthy";
}

const OVERALL: Record<Overall, { title: string; description: string; variant: "default" | "alert" | "error" }> = {
	healthy: { title: "Healthy", description: "Every check passed. The site is checked every 5 minutes.", variant: "default" },
	attention: { title: "Attention", description: "The site is up, but something needs a look — see the checks below.", variant: "alert" },
	down: { title: "Down", description: "The home page is not answering. You get an email when it is back.", variant: "error" },
	unknown: { title: "Starting", description: "The first checks run within 5 minutes of the site starting. Refresh this page in a moment.", variant: "default" },
};

const BADGE: Record<Status, string> = { ok: "OK", warn: "Attention", fail: "Problem", off: "Off", unknown: "Not yet" };
const TREND: Record<string, string> = { o: "✓", w: "!", f: "✗", x: "·", u: "·" };

/** The last 14 days of one check, oldest first: ✓ ok, ! attention, ✗ problem, · not checked. */
export function trend(history: DayRow[], id: CheckId, days = 14): string {
	const i = CHECK_IDS.indexOf(id);
	const rows = history.slice(-days);
	return rows.length ? rows.map((r) => TREND[r.s?.[i] ?? "u"] ?? "·").join("") : "—";
}

export interface PageData {
	state: HealthState;
	today: Today | null;
	history: DayRow[];
	incidents: Incident[];
	links: LinksResult | null;
	linkJob?: { pages: number; done: number };
	cwv: Cwv | null;
	reports: { month: string; at: string }[];
	settings: Settings;
	defaults: { alertsTo: string[]; reportTo: string[] };
	email: { ready: boolean; reason?: string; provider: string };
	live: boolean;
	staging: boolean;
	secrets: { crux: boolean; pagespeed?: boolean; zone: boolean; analytics: boolean };
	/** PageSpeed lab runs (checks/lab.ts) and the open "Run PageSpeed test now" request. */
	lab?: LabStore;
	labRequest?: LabRequest | null;
	selfBinding: boolean;
	productionUrl: string;
	download?: { url: string; month: string };
	errors?: string[];
	/** The week's missing addresses (checks/notfound.ts). */
	notFound?: NotFoundSummary | null;
	maintenance?: MaintenanceSetting | null;
	/** The address the admin is served from (the preview link points here). */
	siteOrigin?: string;
	/** Page cache refill (Speed tab); absent when the route cache or the refill is off in the kit config. */
	cache?: { available: boolean; defaultMinutes: number; setting: RewarmSetting; last: RewarmLast | null; requestedAt?: string };
	/** Page preloading on hover / focus / first touch (HealthOptions.prefetch; absent: on). */
	prefetch?: boolean;
	/** CSP violation reports and the reporting switch (csp.ts). */
	csp?: CspStore;
	/** The build put the report endpoint into the public CSP (HealthOptions.cspReports). */
	cspBuild?: boolean;
	/** The home page's security headers, last read (checks/headers.ts). */
	security?: SecurityFacts | null;
	/** EmDash lets this plugin write redirects (`ctx.redirects.create`): the Missing pages tab offers "Create redirect". */
	redirects?: boolean;
	/** "Create redirect" was asked for one address: the form for it (target prefilled with the suggestion). */
	redirectForm?: { source: string; target?: string };
	/** The time the page describes (tests); default now. */
	now?: number;
}

/** The coming-soon banner text for the Overview and the widget: on now, scheduled, or nothing. */
export function comingSoonStatus(m: MaintenanceSetting | null | undefined, now: number): { state: "on" | "scheduled"; text: string } | undefined {
	if (!m) return undefined;
	const when = scheduleText(m);
	if (maintenanceActive(m, now)) return { state: "on", text: m.on ? (m.endAt && Date.parse(m.endAt) > now ? `Switched on (the schedule ends ${utcText(m.endAt)}, but the switch keeps it on).` : "Switched on.") : `Scheduled ${when}.` };
	if (maintenanceUpcoming(m, now)) return { state: "scheduled", text: `Coming-soon scheduled ${when}.` };
	return undefined;
}

const uptimePct = (rows: { probes: number; fails: number }[]) => {
	const p = rows.reduce((n, r) => n + r.probes, 0);
	const f = rows.reduce((n, r) => n + r.fails, 0);
	return p ? `${(((p - f) / p) * 100).toFixed(f ? 2 : 0)}%` : "—";
};

function overview(d: PageData): Block[] {
	const o = overallOf(d.state);
	const last30 = [...d.history.slice(-29), ...(d.today ? [d.today] : [])];
	const open = d.incidents.filter((i) => !i.endedAt).length;
	const problems = Object.values(d.state.checks).filter((c) => c?.status === "fail" || c?.status === "warn").length;
	return [
		{ type: "banner", ...OVERALL[o] },
		...(() => {
			const cs = comingSoonStatus(d.maintenance, d.now ?? Date.now());
			if (cs?.state === "on") return [{ type: "banner", title: "Coming-soon mode is on", description: `${cs.text} Visitors see the holding page (503, not indexed); anyone signed in sees the site. Uptime, search-engine, analytics and link checks are paused. Switch it off or change the schedule in Settings.`, variant: "alert" }];
			if (cs) return [{ type: "banner", title: "Coming-soon mode is scheduled", description: `${cs.text} Until then visitors see the site. Change it in Settings.`, variant: "default" }];
			return [];
		})(),
		...(!d.selfBinding ? [{ type: "banner", title: "Checks cannot reach the site", description: "This Worker has no SELF service binding in wrangler.jsonc, so it cannot request its own pages. Ask your developer to rerun the kit's scaffold and deploy.", variant: "error" }] : []),
		...(!d.live && !d.staging ? [{ type: "context", text: "The domain does not show this site yet (before go-live): the checks run, but no alert or report is emailed until the site is live." }] : []),
		{
			type: "stats",
			items: [
				{ label: "Uptime today", value: d.today ? uptimePct([d.today]) : "—" },
				{ label: "Uptime, 30 days", value: uptimePct(last30) },
				{ label: "Open incidents", value: open, ...(open ? { trend: "down" } : {}) },
				{ label: "Checks needing attention", value: problems, ...(problems ? { trend: "down" } : {}) },
			],
		},
		{
			type: "table",
			block_id: "checks",
			page_action_id: "noop",
			columns: [
				{ key: "check", label: "Check" },
				{ key: "status", label: "Status", format: "badge" },
				{ key: "summary", label: "Result" },
				{ key: "at", label: "Last run", format: "relative_time" },
				{ key: "trend", label: "Last 14 days" },
			],
			rows: CHECK_IDS.map((id) => {
				const c = d.state.checks[id];
				return { check: CHECK_LABELS[id], status: BADGE[c?.status ?? "unknown"], summary: c ? [c.summary, ...(c.detail ?? [])].join(" ") : "Not checked yet.", at: c?.at ?? "", trend: trend(d.history, id) };
			}),
		},
		{ type: "context", text: "✓ fine · ! needs a look · ✗ problem · · not checked. Uptime every 5 minutes, search engines, analytics, security headers and backups hourly, forms every 15 minutes, links, email DNS, certificate and real-visitor speed once a day, the PageSpeed lab score weekly (UTC)." },
		{ type: "actions", elements: [{ type: "button", action_id: "run-now", label: "Run checks now", style: "primary" }] },
		...(d.state.lastRunAt ? [{ type: "context", text: `Last run ${shortTime(d.state.lastRunAt)}.${d.linkJob ? ` A link check is running (${d.linkJob.done} of ${plural(d.linkJob.pages, "page")} read).` : ""}` }] : []),
	];
}

function incidentsTab(d: PageData): Block[] {
	const rows = d.incidents.slice(0, 100);
	const days = d.history.slice(-30);
	return [
		{ type: "context", text: "An incident starts when the home page (Down) or another page (Page error) fails two checks in a row, and ends with the first good answer. Kept 90 days." },
		...(days.length
			? [
					{
						type: "chart",
						config: { chart_type: "timeseries", style: "bar", height: 220, x_axis_name: "Day", y_axis_name: "Uptime %", series: [{ name: "Uptime %", data: days.filter((r) => r.probes).map((r) => [Date.parse(`${r.d}T12:00:00Z`), Math.round(((r.probes - r.fails) / r.probes) * 10_000) / 100] as [number, number]) }] },
					},
				]
			: []),
		{
			type: "table",
			block_id: "incidents",
			page_action_id: "noop",
			empty_text: "No incidents in the last 90 days.",
			columns: [
				{ key: "started", label: "Started", format: "relative_time" },
				{ key: "what", label: "What" },
				{ key: "state", label: "Status", format: "badge" },
				{ key: "length", label: "Lasted" },
				{ key: "detail", label: "Details" },
			],
			rows: rows.map((i) => ({ started: i.startedAt, what: i.title, state: i.endedAt ? "Resolved" : "Open", length: i.endedAt ? duration(Date.parse(i.endedAt) - Date.parse(i.startedAt)) : `${duration(Date.now() - Date.parse(i.startedAt))} so far`, detail: i.detail ?? "" })),
		},
	];
}

function linksTab(d: PageData): Block[] {
	const r = d.links;
	if (!r) return [{ type: "empty", title: d.linkJob ? "First link check running" : "No link check yet", description: d.linkJob ? `${d.linkJob.done} of ${plural(d.linkJob.pages, "page")} read so far; results appear here when it finishes.` : "Links are checked once a day, early in the morning (UTC). Run checks now to start one.", size: "base" }];
	return [
		{
			type: "stats",
			items: [
				{ label: "Pages read", value: r.pages },
				{ label: "Addresses checked", value: r.checked },
				{ label: "Broken on the site", value: r.broken.filter((b) => !b.external).length },
				{ label: "Broken to other sites", value: r.broken.filter((b) => b.external).length },
			],
		},
		{
			type: "table",
			block_id: "broken",
			page_action_id: "noop",
			empty_text: "No broken links.",
			columns: [
				{ key: "url", label: "Link" },
				{ key: "status", label: "Answer", format: "badge" },
				{ key: "on", label: "Linked from" },
				{ key: "kind", label: "Where" },
			],
			rows: r.broken.map((b) => ({ url: b.url, status: b.status ? `HTTP ${b.status}` : "No answer", on: b.on.join(", ") || "the sitemap", kind: b.external ? "Other site" : "This site" })),
		},
		{ type: "context", text: `Checked ${shortTime(r.at)}. Every page in the sitemap is read and each link on it is tried once. Links to other sites: a different sample of 20 each week${r.external ? ` (last ${r.external.at.slice(0, 10)}: ${r.external.checked} checked${r.external.unchecked ? `, ${r.external.unchecked} refused automated checks` : ""})` : ""}. Fix a link in the page editor; it disappears from this list after the next check.` },
	];
}

function missingTab(d: PageData): Block[] {
	const s = d.notFound;
	if (!s) return [{ type: "empty", title: "Not read yet", description: "EmDash logs every address that does not exist; the list is read every hour. Run checks now to read it.", size: "base" }];
	const host = (r: string | null | undefined) => {
		try {
			return r ? new URL(r).host : "";
		} catch {
			return "";
		}
	};
	const can = d.redirects === true;
	const action = (path: string, suggest?: string): Block =>
		suggest
			? { type: "menu", action_id: "redirect-menu", label: "Create redirect", style: "secondary", items: [{ label: `To ${suggest}`, value: `create:${path}` }, { label: "To another page…", value: `edit:${path}` }] }
			: { type: "button", action_id: "redirect-edit", label: "Create redirect…", style: "secondary", value: path };
	return [
		...(can && d.redirectForm ? redirectFormBlocks(d, d.redirectForm) : []),
		{ type: "context", text: can ? "Addresses visitors asked for that do not exist, seen in the last 7 days, most requested first (requests counted since the address first failed). Where a page of the site probably fits, it is suggested. Create redirect adds a permanent (301) redirect to Redirects — to the suggested page, or to another page of the site — and the address leaves this list. Or fix the link on the page that sent people there." : "Addresses visitors asked for that do not exist, seen in the last 7 days, most requested first (requests counted since the address first failed). Where a page of the site probably fits, it is suggested: add it in Redirects (source → suggested page), or fix the link on the page that sent people there." },
		{
			type: "table",
			block_id: "missing",
			page_action_id: "noop",
			empty_text: "No missing pages were requested in the last 7 days.",
			columns: [
				{ key: "path", label: "Address" },
				{ key: "hits", label: "Requests" },
				{ key: "last", label: "Last asked", format: "relative_time" },
				{ key: "from", label: "Came from" },
				{ key: "suggest", label: "Suggested redirect" },
				...(can ? [{ key: "action", label: "", format: "element" }] : []),
			],
			rows: s.top.map((r) => ({ path: r.path, hits: r.hits, last: r.lastSeen, from: host(r.referrer) || "—", suggest: r.suggest ?? "—", ...(can ? { action: action(r.path, r.suggest) } : {}) })),
		},
		{ type: "actions", elements: [{ type: "link", label: "Open Redirects", target: { kind: "external", url: "/_emdash/admin/redirects" }, appearance: "secondary" }] },
		{ type: "context", text: `Read ${shortTime(s.at)}.${s.probes ? ` ${plural(s.probes, "bot probe")} (wp-login.php, .env and similar) left out: those addresses never existed here.` : ""}` },
	];
}

/** Pages offered as redirect targets (the sitemap, at most this many; the text box takes any other page). */
const TARGET_OPTIONS = 200;

/** The "Create redirect" form for one missing address: the target from the site's pages, or typed. */
function redirectFormBlocks(d: PageData, f: { source: string; target?: string }): Block[] {
	const pages = [...new Set([...(f.target ? [f.target] : []), ...(d.state.sitemap?.paths ?? [])])].slice(0, TARGET_OPTIONS);
	return [
		{ type: "header", text: `Redirect ${f.source}` },
		...(d.errors?.length ? [{ type: "banner", title: "Not created", description: d.errors.slice(0, 5).join(" "), variant: "error" }] : []),
		{
			type: "form",
			block_id: "redirect",
			fields: [
				{ type: "text_input", action_id: "source", label: "Missing address (source)", initial_value: f.source },
				...(pages.length ? [{ type: "select", action_id: "target", label: "Send visitors to (a page of this site)", options: pages.map((p) => ({ label: p, value: p })), initial_value: f.target ?? pages[0] }] : []),
				{ type: "text_input", action_id: "targetOther", label: "Or another page of this site (a path like /about/, or its full https:// address; overrides the list)", placeholder: "/about/" },
			],
			submit: { label: "Create 301 redirect", action_id: "redirect-save" },
		},
		{ type: "actions", elements: [{ type: "button", action_id: "redirect-cancel", label: "Cancel", style: "secondary" }] },
		{ type: "context", text: "The redirect goes to Redirects (group \"site-health\"), where it can be changed or deleted. Only pages of this site can be targets: EmDash's redirects do not send visitors to other websites." },
	];
}

function speedTab(d: PageData): Block[] {
	const c = d.cwv;
	const items: Block[] = [];
	const ttfb = d.today?.ttfb.length ? median(d.today.ttfb) : undefined;
	if (c && !c.missing) {
		const stat = (label: string, metric: "lcp" | "inp" | "cls", v: number | undefined, text: (v: number) => string) => (v === undefined ? [] : [{ label, value: text(v), description: RATING_LABEL[rate(metric, v)], trend: rate(metric, v) === "good" ? "up" : rate(metric, v) === "poor" ? "down" : "neutral" }]);
		items.push({ type: "stats", items: [...stat("LCP (loading)", "lcp", c.lcp, (v) => `${(v / 1000).toFixed(1)} s`), ...stat("INP (responsiveness)", "inp", c.inp, (v) => `${v} ms`), ...stat("CLS (stability)", "cls", c.cls, (v) => v.toFixed(2))] });
		items.push({ type: "context", text: `Real Chrome visitors, 75th percentile over 28 days (Google's Chrome UX Report, ${c.at.slice(0, 10)}). Good: LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1. Before go-live these numbers describe the old site on the same domain.` });
	} else items.push({ type: "banner", title: "Real-visitor speed not available", description: missingText(c?.missing ?? (d.secrets.crux ? "not-enough-data" : "no-key")), variant: "default" });
	const rows = d.history.filter((r) => r.ttfb50 !== undefined).slice(-30);
	if (rows.length) items.push({ type: "chart", config: { chart_type: "timeseries", style: "line", height: 220, x_axis_name: "Day", y_axis_name: "ms", series: [{ name: "Page build time (median)", data: rows.map((r) => [Date.parse(`${r.d}T12:00:00Z`), r.ttfb50 as number] as [number, number]) }] } });
	items.push(...labSection(d));
	items.push(...cacheSection(d));
	items.push(...prefetchSection(d));
	items.push({ type: "context", text: `Page build time${ttfb !== undefined ? ` today: ${ttfb} ms (median)` : ""} — how long the site takes to build the home page, measured inside Cloudflare every 5 minutes. Most visitors get a ready-made copy from the cache, which is faster; the developer's verify run measures that from outside.` });
	return items;
}

const secs = (ms: number | undefined) => (ms === undefined ? "—" : `${(ms / 1000).toFixed(1)} s`);
const msText = (ms: number | undefined) => (ms === undefined ? "—" : `${ms} ms`);
const pts = (v: number | undefined) => (v === undefined ? "—" : String(v));
/** "92 ▲ +4", "61 ▼ −12", "88 =" against the previous run of the same strategy. */
export function withChange(cur: number | undefined, prev: number | undefined): string {
	if (cur === undefined) return "—";
	if (prev === undefined) return String(cur);
	const diff = cur - prev;
	return diff > 0 ? `${cur} ▲ +${diff}` : diff < 0 ? `${cur} ▼ −${-diff}` : `${cur} =`;
}

export const LAB_SETUP =
	"Add a free Google Cloud API key as the Worker secret PAGESPEED_API_KEY: in Google Cloud console create (or pick) a project, open APIs & Services → Library and enable \"PageSpeed Insights API\", then APIs & Services → Credentials → Create credentials → API key (restrict it to that API). If the site already has CRUX_API_KEY, you can instead enable the PageSpeed Insights API on that same key's project: one key serves both, and PAGESPEED_API_KEY is then not needed. Without a key Google's shared quota is almost always used up.";

/** The weekly PageSpeed Insights lab test: latest scores, the trend, setup steps when no key is set. */
export function labSection(d: PageData): Block[] {
	const lab = d.lab ?? { v: 1 as const, runs: [] };
	const hasKey = !!(d.secrets.pagespeed || d.secrets.crux);
	const out: Block[] = [{ type: "header", text: "Lab score (PageSpeed)" }];
	out.push({ type: "context", text: "Lab score: Google loads the home page once from its own computers, on a simulated mid-range phone with a slow mobile connection and on a desktop, and scores it 0–100 (90+ good, 50–89 needs improvement, under 50 poor). It shows changes from week to week and what to fix. Real-visitor speed above is what actual visitors experienced over 28 days: that is what Google uses for search. The two often differ; a phone lab score in the 70s with good real-visitor numbers is normal." });
	if (!hasKey) {
		out.push({ type: "banner", title: "Lab score needs a Google API key", description: LAB_SETUP, variant: "default" });
		if (!lab.runs.length) return out;
	}
	const m = latestOf(lab.runs, "mobile");
	const dk = latestOf(lab.runs, "desktop");
	if (m || dk) {
		const latest = [m, dk].filter((r): r is LabRun => !!r).sort((a, b) => (a.at < b.at ? 1 : -1))[0] as LabRun;
		out.push({ type: "stats", items: [...(m ? [{ label: "Mobile performance", value: pts(m.perf), description: scoreLabel(m.perf), trend: scoreTrend(m.perf) }] : []), ...(dk ? [{ label: "Desktop performance", value: pts(dk.perf), description: scoreLabel(dk.perf), trend: scoreTrend(dk.perf) }] : []), { label: "Accessibility", value: pts((m ?? dk)?.a11y), trend: scoreTrend((m ?? dk)?.a11y) }, { label: "Best practices", value: pts((m ?? dk)?.bp), trend: scoreTrend((m ?? dk)?.bp) }, { label: "SEO", value: pts((m ?? dk)?.seo), trend: scoreTrend((m ?? dk)?.seo) }] });
		const row = (metric: string, f: (r: LabRun) => string) => ({ metric, mobile: m ? f(m) : "—", desktop: dk ? f(dk) : "—" });
		out.push({
			type: "table",
			block_id: "lab-latest",
			page_action_id: "noop",
			columns: [
				{ key: "metric", label: `Latest test (${latest.at.slice(0, 10)})` },
				{ key: "mobile", label: "Mobile" },
				{ key: "desktop", label: "Desktop" },
			],
			rows: [row("First Contentful Paint (first text or image)", (r) => secs(r.fcp)), row("Largest Contentful Paint (main content shown)", (r) => secs(r.lcp)), row("Total Blocking Time (page busy, cannot react)", (r) => msText(r.tbt)), row("Cumulative Layout Shift (things jumping)", (r) => (r.cls === undefined ? "—" : r.cls.toFixed(2))), row("Speed Index (how fast it fills in)", (r) => secs(r.si))],
		});
		const el = m?.lcpEl ?? dk?.lcpEl;
		if (el) out.push({ type: "context", text: `Largest element on the first screen (the one LCP waits for${m?.lcpEl ? ", on mobile" : ""}): ${el}` });
		if (latest.pre) out.push({ type: "context", text: "Tested before go-live: the domain still showed the old site, so these scores describe the old site — a useful baseline." });
	} else out.push({ type: "context", text: "No test has finished yet: the first one runs within about 5 minutes and takes up to a minute." });

	const mobile = lab.runs.filter((r) => r.strategy === "mobile" && r.perf !== undefined);
	const desktop = lab.runs.filter((r) => r.strategy === "desktop" && r.perf !== undefined);
	if (mobile.length + desktop.length > 2)
		out.push({ type: "chart", config: { chart_type: "timeseries", style: "line", height: 220, x_axis_name: "Test", y_axis_name: "Performance score", series: [{ name: "Mobile", data: mobile.map((r) => [Date.parse(r.at), r.perf as number] as [number, number]) }, { name: "Desktop", data: desktop.map((r) => [Date.parse(r.at), r.perf as number] as [number, number]) }] } });
	const times = [...new Set(lab.runs.map((r) => r.at))].sort().reverse().slice(0, 8);
	if (times.length > 1) {
		const prevOf = (s: string, at: string) => lab.runs.filter((r) => r.strategy === s && r.at < at && r.perf !== undefined).at(-1)?.perf;
		out.push({
			type: "table",
			block_id: "lab-history",
			page_action_id: "noop",
			columns: [
				{ key: "at", label: "Test" },
				{ key: "mobile", label: "Mobile performance" },
				{ key: "desktop", label: "Desktop performance" },
				{ key: "lcp", label: "Mobile LCP" },
			],
			rows: times.map((at) => {
				const get = (s: string) => lab.runs.find((r) => r.at === at && r.strategy === s);
				const mm = get("mobile");
				const dd = get("desktop");
				return { at: `${shortTime(at)}${mm?.pre || dd?.pre ? " (old site)" : ""}`, mobile: withChange(mm?.perf, mm ? prevOf("mobile", at) : undefined), desktop: withChange(dd?.perf, dd ? prevOf("desktop", at) : undefined), lcp: secs(mm?.lcp) };
			}),
		});
	}
	const missing = lab.last?.missing ?? {};
	const failed = STRATEGIES.filter((s) => missing[s]);
	if (hasKey && failed.length && lab.last) out.push({ type: "banner", title: "The last test did not finish", description: `${shortTime(lab.last.at)}, ${failed.join(" and ")}: ${[...new Set(failed.map((s) => labMissingText(missing[s] as string)))].join(" ")}`, variant: "alert" });
	if (d.labRequest && !d.labRequest.done) out.push({ type: "banner", title: "Test asked for", description: `Asked ${shortTime(d.labRequest.at)}: the next check run (within 5 minutes) tests the home page; Google needs up to a minute. Reopen this tab to see the result.`, variant: "default" });
	if (hasKey && !d.staging) {
		out.push({ type: "actions", elements: [{ type: "button", action_id: "lab-run", label: "Run PageSpeed test now", style: "secondary" }] });
		out.push({ type: "context", text: `Tested every 7 days (mobile and desktop)${lab.next ? `; next scheduled test from ${shortTime(lab.next)}` : ""}. Kept 26 weeks. An email goes out when the mobile performance score drops by 15 points or more. Uses ${d.secrets.pagespeed ? "PAGESPEED_API_KEY" : "CRUX_API_KEY (the PageSpeed Insights API must be enabled for it too)"}.` });
	} else if (d.staging) out.push({ type: "context", text: "PageSpeed tests run on the production site only." });
	return out;
}

/** Page preloading: a status line only (the kit config switches it; nothing for the owner to tune). */
function prefetchSection(d: PageData): Block[] {
	const on = d.prefetch !== false;
	return [
		{ type: "header", text: "Page preloading" },
		{
			type: "context",
			text: on
				? "On — when a visitor points at a link (mouse over it, keyboard focus, or the first touch on a phone), the page behind it starts loading, so the click feels instant. Only this site's own pages, at most 20 per visit, and never on data-saver or very slow connections. Pages ready in the cache cost nothing to preload; it does not count as a visit in analytics."
				: "Off — links load when they are clicked. Your developer turned page preloading off for this site (kit setting performance.prefetch).",
		},
	];
}

const STATE_LABEL = { cached: "Ready (from the cache)", rendered: "Built now", failed: "Failed" } as const;

/** Page cache refill: what the last run found, the switch and interval, and "Refresh all pages now". */
function cacheSection(d: PageData): Block[] {
	const c = d.cache;
	if (!c) return [];
	const out: Block[] = [{ type: "header", text: "Page cache" }];
	if (!c.available) {
		out.push({ type: "context", text: "Pages are kept ready in Cloudflare's cache. Refilling them after edits starts once the site is live on its own domain." });
		return out;
	}
	out.push({
		type: "context",
		text: `Visitors get ready-made pages from Cloudflare's cache (about 0.25 s). Every edit clears them, and the next visitor would wait for the page to be built again (about 2 s). ${c.setting.on ? `Every ${c.setting.everyMinutes} minutes the site refills them itself, so visitors never wait.` : "Refilling is off: after an edit, the first visitor of each page waits for it to be built."} Pages still in the cache cost nothing to check.`,
	});
	const l = c.last;
	if (l) {
		out.push({ type: "stats", items: [{ label: "Last refill", value: shortTime(l.at), description: l.trigger === "manual" ? "asked for here" : "scheduled" }, { label: "Pages checked", value: l.pages }, { label: "Built again", value: l.rendered, description: "cleared by an edit" }, { label: "Failed", value: l.failed, trend: l.failed ? "down" : "neutral" }] });
		if (l.list.length)
			out.push({
				type: "table",
				block_id: "cache-pages",
				page_action_id: "noop",
				empty_text: "No pages.",
				columns: [
					{ key: "path", label: "Page" },
					{ key: "state", label: "At the last refill" },
				],
				rows: [...l.list].sort((a, b) => (a.state === b.state ? a.path.localeCompare(b.path) : a.state === "failed" ? -1 : b.state === "failed" ? 1 : a.state === "rendered" ? -1 : 1)).map((p) => ({ path: p.path, state: p.state === "failed" ? `${STATE_LABEL.failed} (${p.status || "no answer"})` : STATE_LABEL[p.state] })),
			});
	} else out.push({ type: "context", text: "No refill has run yet: the first one runs within the next interval." });
	if (c.requestedAt) out.push({ type: "banner", title: "Refresh asked for", description: `All pages were cleared ${shortTime(c.requestedAt)}; they are built again within 5 minutes.`, variant: "default" });
	out.push({
		type: "form",
		block_id: "cache-settings",
		fields: [
			{ type: "toggle", action_id: "on", label: "Refill pages after edits", initial_value: c.setting.on },
			{ type: "select", action_id: "everyMinutes", label: "How often", options: REWARM_INTERVALS.map((m) => ({ label: m === 60 ? "Every hour" : `Every ${m} minutes`, value: String(m) })), initial_value: String((REWARM_INTERVALS as readonly number[]).includes(c.setting.everyMinutes) ? c.setting.everyMinutes : c.defaultMinutes) },
		],
		submit: { label: "Save", action_id: "save-cache" },
	});
	out.push({ type: "actions", elements: [{ type: "button", action_id: "cache-refresh", label: "Refresh all pages now", style: "secondary", confirm: { title: "Refresh all pages?", text: "Clears every cached page and builds them again within 5 minutes. Visitors in between may wait a moment longer for a page.", confirm: "Refresh", deny: "Cancel" } }] });
	return out;
}

/** Security: what visitors' browsers reported as blocked by the CSP, the reporting switch, the security headers. */
function securityTab(d: PageData): Block[] {
	const c = d.csp ?? { v: 1 as const, items: [], months: {} };
	const on = !c.off;
	const scripts = c.items.filter((e) => isScriptDirective(e.directive)).length;
	const month = new Date().toISOString().slice(0, 7);
	const thisMonth = c.months[month] ?? 0;
	const out: Block[] = [
		{ type: "header", text: "Blocked by the security policy" },
		{ type: "context", text: "The site tells browsers exactly which scripts, styles and embeds may load (its Content Security Policy), so code injected into a page cannot run. When a visitor's browser blocks something, it reports what was blocked and on which page — nothing about the visitor. A blocked script usually means something on that page does not work: send the list to your developer." },
	];
	if (d.cspBuild === false) out.push({ type: "banner", title: "Reports are not collected", description: "The site's configuration leaves the report address out of the security policy (kit.config health.cspReports: false). Your developer can switch it on and redeploy.", variant: "default" });
	else if (!on) out.push({ type: "banner", title: "Reporting is off", description: "Browsers may still send reports, but they are not kept and nothing is emailed. Switch it on below.", variant: "alert" });
	else if (scripts) out.push({ type: "banner", title: `${scripts === 1 ? "A script was" : `${scripts} scripts were`} blocked`, description: "Something on the pages listed below may not work for visitors. Ask your developer to allow the source or move the code into the site's own files.", variant: "error" });
	out.push({
		type: "table",
		block_id: "csp",
		page_action_id: "noop",
		empty_text: on && d.cspBuild !== false ? "Nothing blocked: no visitor's browser reported a problem." : "No reports.",
		columns: [
			{ key: "what", label: "What happened" },
			{ key: "kind", label: "Severity", format: "badge" },
			{ key: "blocked", label: "Blocked source" },
			{ key: "directive", label: "Rule" },
			{ key: "pages", label: "Pages" },
			{ key: "count", label: "Times" },
			{ key: "last", label: "Last seen", format: "relative_time" },
		],
		rows: c.items.map((e) => ({ what: meaning(e), kind: isScriptDirective(e.directive) ? "Script" : "Other", blocked: blockedLabel(e.blocked), directive: e.directive, pages: e.pages.join(", "), count: e.count, last: e.last })),
	});
	out.push({ type: "context", text: `${thisMonth ? `${plural(thisMonth, "report")} this month.` : "No reports this month."} Up to 50 different sources are kept, newest first; each is emailed once, when it first appears (blocked scripts as a problem, anything else as a note). Browser extensions and signed-in editors are left out.` });
	if (c.items.length) out.push({ type: "actions", elements: [{ type: "button", action_id: "csp-clear", label: "Clear the list", style: "secondary", confirm: { title: "Clear the list?", text: "Sources that are blocked again appear as new and are emailed once more.", confirm: "Clear", deny: "Cancel" } }] });
	if (d.cspBuild !== false) out.push({ type: "form", block_id: "csp-settings", fields: [{ type: "toggle", action_id: "on", label: "Keep reports of blocked content and email new blocked scripts", initial_value: on }], submit: { label: "Save", action_id: "save-csp" } });
	out.push({ type: "header", text: "Security headers" });
	const f = d.security;
	if (!f) out.push({ type: "context", text: "Read from the home page every hour; the first reading appears after the next check." });
	else if (f.status !== 200) out.push({ type: "context", text: `Not read: the home page answered HTTP ${f.status || "—"} at the last check (${shortTime(f.at)}).` });
	else
		out.push(
			{
				type: "table",
				block_id: "headers",
				page_action_id: "noop",
				columns: [
					{ key: "label", label: "Protection" },
					{ key: "status", label: "Status", format: "badge" },
					{ key: "value", label: "Sent" },
					{ key: "about", label: "What it does" },
				],
				rows: headerRows(f.headers, { reports: d.cspBuild !== false }).map((r) => ({ label: r.label, status: r.ok ? "OK" : "Attention", value: r.value, about: r.about })),
			},
			{ type: "context", text: `Read from the home page ${shortTime(f.at)}, as the site sends it (rules added in Cloudflare outside the site are not seen here).` },
		);
	const ssl = d.state.checks.ssl;
	if (ssl) out.push({ type: "fields", fields: [{ label: "Security certificate", value: [ssl.summary, ...(ssl.detail ?? [])].join(" ") }] });
	return out;
}

function reportsTab(d: PageData): Block[] {
	return [
		{ type: "context", text: `On the 1st of each month a report for the month before is emailed to ${d.settings.report === false ? "nobody (switched off in Settings)" : "the report recipients in Settings"} and kept here for 12 months. Download one to print it or save it as PDF (in the browser: Print → Save as PDF).` },
		...(d.download ? [{ type: "banner", title: `Report for ${monthName(d.download.month)} ready`, description: "The link below works once, for two minutes.", variant: "default" }, { type: "actions", elements: [{ type: "link", label: "Download the report (HTML)", target: { kind: "external", url: d.download.url }, appearance: "primary" }] }] : []),
		{
			type: "table",
			block_id: "reports",
			page_action_id: "noop",
			empty_text: "No report yet. The first one arrives on the 1st of next month.",
			columns: [
				{ key: "month", label: "Month" },
				{ key: "at", label: "Prepared", format: "relative_time" },
				{ key: "view", label: "", format: "element" },
				{ key: "download", label: "", format: "element" },
			],
			rows: d.reports.map((r) => ({ month: monthName(r.month), at: r.at, view: { type: "button", action_id: "report-view", label: "View", value: r.month }, download: { type: "button", action_id: "report-download", label: "Download", value: r.month } })),
		},
		{ type: "actions", elements: [{ type: "button", action_id: "report-prepare", label: "Prepare last month's report now", style: "secondary" }] },
		{ type: "context", text: "Preparing a report does not email it. Reports contain numbers, page addresses and page titles only — never what anyone wrote in a form." },
	];
}

/** An ISO time as the form shows it: "2026-12-01 09:00". */
const inputTime = (iso: string) => iso.slice(0, 16).replace("T", " ");

/** The coming-soon preview link: for people without an admin account (the client, a reviewer). */
function previewBlocks(d: PageData): Block[] {
	const key = d.maintenance?.previewKey;
	const url = key ? `${(d.siteOrigin ?? d.productionUrl).replace(/\/$/, "")}/?preview=${key}` : undefined;
	return [
		{ type: "context", text: "Preview link: send it to people without an admin account (the client, a reviewer) so they can see the site while coming-soon mode is on. Opening it keeps the site open in that browser for 7 days. \"New link\" stops every link sent before." },
		...(url ? [{ type: "fields", fields: [{ label: "Preview link", value: url }] }] : []),
		{ type: "actions", elements: [{ type: "button", action_id: "preview-new", label: url ? "New link (the old one stops working)" : "Create a preview link", style: "secondary", ...(url ? { confirm: { title: "Replace the preview link?", text: "Everyone using the current link sees the coming-soon page again.", confirm: "New link", deny: "Cancel" } } : {}) }] },
	];
}

function settingsTab(d: PageData): Block[] {
	const s = d.settings;
	const alertsTo = s.alertsTo?.length ? s.alertsTo : d.defaults.alertsTo;
	const reportTo = s.reportTo?.length ? s.reportTo : d.defaults.reportTo;
	return [
		...(d.errors?.length ? [{ type: "banner", title: "Not saved", description: d.errors.slice(0, 10).join(" "), variant: "error" }] : []),
		{ type: "header", text: "Who gets emails" },
		{ type: "context", text: `Up to ${MAX_RECIPIENTS} addresses each, one per line. Leave a box empty to use the default.` },
		{
			type: "form",
			block_id: "settings",
			fields: [
				{ type: "text_input", action_id: "alertsTo", label: "Alerts (site down, broken links, search engines, form email…)", placeholder: d.defaults.alertsTo.join("\n") || "team@example.com", multiline: true, ...(s.alertsTo?.length ? { initial_value: s.alertsTo.join("\n") } : {}) },
				{ type: "text_input", action_id: "reportTo", label: "Monthly report (the alert recipients get a copy)", placeholder: d.defaults.reportTo.join("\n") || "owner@example.com", multiline: true, ...(s.reportTo?.length ? { initial_value: s.reportTo.join("\n") } : {}) },
				{ type: "toggle", action_id: "alerts", label: "Email alerts", initial_value: s.alerts !== false },
				{ type: "toggle", action_id: "report", label: "Email the monthly report", initial_value: s.report !== false },
			],
			submit: { label: "Save", action_id: "save-settings" },
		},
		{
			type: "fields",
			fields: [
				{ label: "Alerts go to", value: alertsTo.join(", ") || "Nobody" },
				{ label: "The report goes to", value: [...new Set([...reportTo, ...alertsTo])].join(", ") || "Nobody" },
				{ label: "Email", value: d.email.ready ? `Working (${d.email.provider})` : `Not available: ${d.email.reason ?? "not set up"}` },
				{ label: "Emails sent", value: d.staging ? "Never (staging site)" : d.live ? "Yes" : "Not before go-live" },
			],
		},
		{ type: "actions", elements: [{ type: "button", action_id: "test-email", label: "Send a test email to the alert recipients", style: "secondary" }] },
		{ type: "context", text: "At most one email per issue per day (for example one \"site down\" and one \"back up\"), and at most six alerts a day in total. Emails go through the same email service as the website's forms." },
		{ type: "header", text: "Coming-soon mode" },
		{ type: "context", text: "Shows visitors a holding page with your logo and message instead of the site (HTTP 503 with Retry-After, so search engines keep the site's listing and come back later). Anyone signed in to the admin still sees the site. Takes up to a minute to switch everywhere. The migration never switches it on." },
		{ type: "context", text: "Schedule (optional, UTC): the holding page shows from \"Start at\" until \"End at\", even with the switch off; leave Start empty to begin now, or End empty to keep it on until you switch it off. The switch always forces it on. A scheduled start or end takes up to 5 minutes to reach every page. \"End at\" is also shown on the holding page as \"Back at …\"." },
		...(() => {
			const cs = comingSoonStatus(d.maintenance, d.now ?? Date.now());
			const when = scheduleText(d.maintenance);
			return [{ type: "fields", fields: [{ label: "Now", value: cs?.state === "on" ? "On: visitors see the holding page" : "Off: visitors see the site" }, { label: "Schedule", value: when ? `${when[0]?.toUpperCase()}${when.slice(1)}${cs?.state === "scheduled" ? " (not started yet)" : ""}` : "None" }] }];
		})(),
		{
			type: "form",
			block_id: "maintenance",
			fields: [
				{ type: "toggle", action_id: "on", label: "Show the coming-soon page to visitors now", initial_value: d.maintenance?.on === true },
				{ type: "text_input", action_id: "heading", label: "Heading", placeholder: "We'll be back soon", ...(d.maintenance?.heading ? { initial_value: d.maintenance.heading } : {}) },
				{ type: "text_input", action_id: "message", label: "Message", placeholder: "The site is getting ready. Please check back shortly.", multiline: true, ...(d.maintenance?.message ? { initial_value: d.maintenance.message } : {}) },
				{ type: "text_input", action_id: "startAt", label: "Start at (optional, UTC, e.g. 2026-12-01 09:00)", placeholder: "YYYY-MM-DD HH:MM", ...(d.maintenance?.startAt ? { initial_value: inputTime(d.maintenance.startAt) } : {}) },
				{ type: "text_input", action_id: "endAt", label: "End at (optional, UTC)", placeholder: "YYYY-MM-DD HH:MM", ...(d.maintenance?.endAt ? { initial_value: inputTime(d.maintenance.endAt) } : {}) },
				{ type: "text_input", action_id: "until", label: "Expected back (optional, without an end time; e.g. 2026-12-01 09:00 UTC)", placeholder: "YYYY-MM-DD HH:MM", ...(d.maintenance?.until ? { initial_value: inputTime(d.maintenance.until) } : {}) },
			],
			submit: { label: "Save coming-soon mode", action_id: "save-maintenance" },
		},
		...previewBlocks(d),
		{ type: "header", text: "Optional extras (set by your developer)" },
		{
			type: "fields",
			fields: [
				{ label: "Real-visitor speed (CRUX_API_KEY)", value: d.secrets.crux ? "Set" : "Not set — a free Google API key with the Chrome UX Report API" },
				{ label: "Weekly lab score (PAGESPEED_API_KEY)", value: d.secrets.pagespeed ? "Set" : d.secrets.crux ? "Not set — CRUX_API_KEY is used (enable the PageSpeed Insights API for it)" : "Not set — a free Google API key with the PageSpeed Insights API" },
				{ label: "Certificate expiry (CF_ZONE_READ_TOKEN)", value: d.secrets.zone ? "Set" : "Not set — Cloudflare renews the certificate on its own" },
				{ label: "Visits in the report (CF_ANALYTICS_TOKEN)", value: d.secrets.analytics ? "Set" : "Not set — the report leaves visits out" },
			],
		},
	];
}

export function page(d: PageData, tab: number = TABS.overview): Block[] {
	const open = d.incidents.filter((i) => !i.endedAt).length;
	const broken = d.links?.broken.length ?? 0;
	const missing = d.notFound?.top.length ?? 0;
	const blocked = d.csp && !d.csp.off ? d.csp.items.filter((e) => isScriptDirective(e.directive)).length : 0;
	return [
		{ type: "header", text: "Site health" },
		{
			type: "tab",
			default_tab: tab,
			panels: [
				{ label: "Overview", blocks: overview(d) },
				{ label: `Incidents${open ? ` (${open})` : ""}`, blocks: incidentsTab(d) },
				{ label: `Broken links${broken ? ` (${broken})` : ""}`, blocks: linksTab(d) },
				{ label: `Missing pages${missing ? ` (${missing})` : ""}`, blocks: missingTab(d) },
				{ label: "Speed", blocks: speedTab(d) },
				{ label: `Security${blocked ? ` (${blocked})` : ""}`, blocks: securityTab(d) },
				{ label: "Reports", blocks: reportsTab(d) },
				{ label: "Settings", blocks: settingsTab(d) },
			],
		},
	];
}

/** One report in the admin. */
export function reportView(r: ReportData, stored: boolean): Block[] {
	const up = r.uptime;
	return [
		{ type: "header", text: `Report — ${monthName(r.month)}` },
		{ type: "context", text: `${headline(r)} Prepared ${shortTime(r.generatedAt)}${stored ? "" : " (preview)"}.` },
		{ type: "stats", items: [{ label: "Uptime", value: up.pct !== undefined ? `${up.pct}%` : "—" }, { label: "Visits", value: r.visits ? r.visits.visits : "—" }, { label: "Form messages", value: r.forms ? r.forms.total : "—" }, { label: "Pages published / updated", value: `${r.content.published} / ${r.content.updated}` }] },
		{
			type: "fields",
			fields: [
				{ label: "Outages", value: up.incidents.length ? up.incidents.map((i) => `${i.title} (${i.startedAt.slice(0, 10)}, ${i.minutes !== undefined ? duration(i.minutes * 60_000) : "open"})`).join("; ") : "None" },
				{ label: "Speed (real visitors)", value: r.speed.cwv ? [r.speed.cwv.lcp !== undefined ? `LCP ${(r.speed.cwv.lcp / 1000).toFixed(1)} s` : "", r.speed.cwv.inp !== undefined ? `INP ${r.speed.cwv.inp} ms` : "", r.speed.cwv.cls !== undefined ? `CLS ${r.speed.cwv.cls.toFixed(2)}` : ""].filter(Boolean).join(", ") : (r.speed.cwvNote ?? "—") },
				{ label: "Page build time", value: r.speed.ttfbMedian !== undefined ? `${r.speed.ttfbMedian} ms` : "—" },
				{ label: "Top pages", value: r.visits?.pages.slice(0, 5).map((p) => `${p.path} (${p.views})`).join(", ") || (r.visitsNote ?? "—") },
				{ label: "Referrers", value: r.visits?.referrers.map((x) => `${x.host} (${x.views})`).join(", ") || "—" },
				{ label: "Broken links", value: `${r.links.found} found, ${r.links.fixed} fixed, ${r.links.open} open` },
				{ label: "Average SEO score", value: r.seo ? `${r.seo.average}/100 (${plural(r.seo.pages, "page")})` : (r.seoNote ?? "—") },
				...(r.csp ? [{ label: "Security", value: cspLine(r.csp) }] : []),
			],
		},
		{
			type: "actions",
			elements: [
				{ type: "button", action_id: "back", label: "← Back", style: "secondary" },
				...(stored
					? [
							{ type: "button", action_id: "report-download", label: "Download (HTML, print to PDF)", style: "secondary", value: r.month },
							{ type: "button", action_id: "report-send", label: "Email it now", style: "secondary", value: r.month, confirm: { title: "Email this report?", text: "It is sent to the report recipients and the alert recipients in Settings.", confirm: "Email it", deny: "Cancel" } },
						]
					: []),
			],
		},
	];
}

export function widget(d: Pick<PageData, "state" | "today" | "incidents"> & Partial<Pick<PageData, "notFound" | "maintenance" | "now">>): Block[] {
	const o = overallOf(d.state);
	const open = d.incidents.filter((i) => !i.endedAt).length;
	const attention = CHECK_IDS.filter((id) => ["fail", "warn"].includes(d.state.checks[id]?.status ?? "")).map((id) => CHECK_LABELS[id]);
	const missing = d.state.checks.notfound?.status === "warn" ? (d.notFound?.top.filter((r) => r.hits >= 3).length ?? 0) : 0;
	return [
		{ type: "banner", title: OVERALL[o].title, description: o === "attention" ? `Needs a look: ${attention.join(", ")}.` : OVERALL[o].description, variant: OVERALL[o].variant },
		...(() => {
			const cs = comingSoonStatus(d.maintenance, d.now ?? Date.now());
			return cs ? [{ type: "context", text: cs.state === "on" ? `Coming-soon mode is on: visitors see the holding page. ${cs.text}` : cs.text }] : [];
		})(),
		...(missing ? [{ type: "context", text: `${plural(missing, "missing address", "missing addresses")} visitors keep asking for: see Site health → Missing pages for suggested redirects.` }] : []),
		{ type: "stats", items: [{ label: "Uptime today", value: d.today ? uptimePct([d.today]) : "—" }, { label: "Open incidents", value: open }] },
		{ type: "actions", elements: [{ type: "link", label: "Open Site health", target: { kind: "plugin-page", path: PAGE }, appearance: "secondary" }] },
	];
}

export const adminsOnly: Block[] = [{ type: "banner", title: "Admins only", description: "Ask a site admin for access to Site health.", variant: "error" }];
