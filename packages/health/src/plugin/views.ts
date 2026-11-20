/**
 * Site health: Block Kit views (plain JSON, shapes from @emdash-cms/blocks 1.5). Admins only. Plain words; dates in UTC.
 */
import { MAX_RECIPIENTS } from "@wp2emdash/forms/outbox";
import { missingText, RATING_LABEL, rate } from "../checks/speed.js";
import type { ReportData } from "../report.js";
import { headline } from "../report.js";
import { CHECK_IDS, CHECK_LABELS, type CheckId, type Cwv, type DayRow, type HealthState, type Incident, type LinksResult, type Settings, type Status, type Today } from "../store.js";
import { duration, median, monthName, plural, shortTime } from "../util.js";

export type Block = Record<string, unknown>;

export const PAGE = "/health";
export const WIDGET = "site-health";
export const TABS = { overview: 0, incidents: 1, links: 2, speed: 3, reports: 4, settings: 5 } as const;

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
	secrets: { crux: boolean; zone: boolean; analytics: boolean };
	selfBinding: boolean;
	productionUrl: string;
	download?: { url: string; month: string };
	errors?: string[];
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
		{ type: "context", text: "✓ fine · ! needs a look · ✗ problem · · not checked. Uptime every 5 minutes, search engines and analytics hourly, forms every 15 minutes, links, email DNS, certificate and real-visitor speed once a day (UTC)." },
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
	items.push({ type: "context", text: `Page build time${ttfb !== undefined ? ` today: ${ttfb} ms (median)` : ""} — how long the site takes to build the home page, measured inside Cloudflare every 5 minutes. Most visitors get a ready-made copy from the cache, which is faster; the developer's verify run measures that from outside.` });
	return items;
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
		{ type: "header", text: "Optional extras (set by your developer)" },
		{
			type: "fields",
			fields: [
				{ label: "Real-visitor speed (CRUX_API_KEY)", value: d.secrets.crux ? "Set" : "Not set — a free Google API key with the Chrome UX Report API" },
				{ label: "Certificate expiry (CF_ZONE_READ_TOKEN)", value: d.secrets.zone ? "Set" : "Not set — Cloudflare renews the certificate on its own" },
				{ label: "Visits in the report (CF_ANALYTICS_TOKEN)", value: d.secrets.analytics ? "Set" : "Not set — the report leaves visits out" },
			],
		},
	];
}

export function page(d: PageData, tab: number = TABS.overview): Block[] {
	const open = d.incidents.filter((i) => !i.endedAt).length;
	const broken = d.links?.broken.length ?? 0;
	return [
		{ type: "header", text: "Site health" },
		{
			type: "tab",
			default_tab: tab,
			panels: [
				{ label: "Overview", blocks: overview(d) },
				{ label: `Incidents${open ? ` (${open})` : ""}`, blocks: incidentsTab(d) },
				{ label: `Broken links${broken ? ` (${broken})` : ""}`, blocks: linksTab(d) },
				{ label: "Speed", blocks: speedTab(d) },
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

export function widget(d: Pick<PageData, "state" | "today" | "incidents">): Block[] {
	const o = overallOf(d.state);
	const open = d.incidents.filter((i) => !i.endedAt).length;
	const attention = CHECK_IDS.filter((id) => ["fail", "warn"].includes(d.state.checks[id]?.status ?? "")).map((id) => CHECK_LABELS[id]);
	return [
		{ type: "banner", title: OVERALL[o].title, description: o === "attention" ? `Needs a look: ${attention.join(", ")}.` : OVERALL[o].description, variant: OVERALL[o].variant },
		{ type: "stats", items: [{ label: "Uptime today", value: d.today ? uptimePct([d.today]) : "—" }, { label: "Open incidents", value: open }] },
		{ type: "actions", elements: [{ type: "link", label: "Open Site health", target: { kind: "plugin-page", path: PAGE }, appearance: "secondary" }] },
	];
}

export const adminsOnly: Block[] = [{ type: "banner", title: "Admins only", description: "Ask a site admin for access to Site health.", variant: "error" }];
