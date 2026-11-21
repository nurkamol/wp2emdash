/**
 * Site health: Block Kit views (plain JSON, shapes from @emdash-cms/blocks 1.5). Admins only. Plain words; dates in UTC.
 */
import { REWARM_INTERVALS, type RewarmLast, type RewarmSetting } from "../cache.js";
import { MAX_RECIPIENTS } from "@wp2emdash/forms/outbox";
import { missingText, RATING_LABEL, rate } from "../checks/speed.js";
import type { NotFoundSummary } from "../checks/notfound.js";
import type { ReportData } from "../report.js";
import { headline } from "../report.js";
import { CHECK_IDS, CHECK_LABELS, type CheckId, type Cwv, type DayRow, type HealthState, type Incident, type LinksResult, type Settings, type Status, type Today } from "../store.js";
import { duration, median, monthName, plural, shortTime } from "../util.js";

export type Block = Record<string, unknown>;

export const PAGE = "/health";
export const WIDGET = "site-health";
export const TABS = { overview: 0, incidents: 1, links: 2, missing: 3, speed: 4, reports: 5, settings: 6 } as const;

/** Coming-soon mode as stored (KEYS.maintenance; the starter's middleware reads the same row). */
export interface MaintenanceSetting {
	on: boolean;
	heading?: string;
	message?: string;
	until?: string;
	at?: string;
	/** Key of the preview link (`?preview=<key>`): people without an admin account see the site while the mode is on. */
	previewKey?: string;
}

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
	/** The week's missing addresses (checks/notfound.ts). */
	notFound?: NotFoundSummary | null;
	maintenance?: MaintenanceSetting | null;
	/** The address the admin is served from (the preview link points here). */
	siteOrigin?: string;
	/** Page cache refill (Speed tab); absent when the route cache or the refill is off in the kit config. */
	cache?: { available: boolean; defaultMinutes: number; setting: RewarmSetting; last: RewarmLast | null; requestedAt?: string };
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
		...(d.maintenance?.on ? [{ type: "banner", title: "Coming-soon mode is on", description: "Visitors see the holding page (503, not indexed); anyone signed in sees the site. Uptime, search-engine, analytics and link checks are paused. Switch it off in Settings.", variant: "alert" }] : []),
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
		{ type: "context", text: "✓ fine · ! needs a look · ✗ problem · · not checked. Uptime every 5 minutes, search engines, analytics and backups hourly, forms every 15 minutes, links, email DNS, certificate and real-visitor speed once a day (UTC)." },
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
	return [
		{ type: "context", text: "Addresses visitors asked for that do not exist, seen in the last 7 days, most requested first (requests counted since the address first failed). Where a page of the site probably fits, it is suggested: add it in Redirects (source → suggested page), or fix the link on the page that sent people there." },
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
			],
			rows: s.top.map((r) => ({ path: r.path, hits: r.hits, last: r.lastSeen, from: host(r.referrer) || "—", suggest: r.suggest ?? "—" })),
		},
		{ type: "actions", elements: [{ type: "link", label: "Open Redirects", target: { kind: "external", url: "/_emdash/admin/redirects" }, appearance: "secondary" }] },
		{ type: "context", text: `Read ${shortTime(s.at)}.${s.probes ? ` ${plural(s.probes, "bot probe")} (wp-login.php, .env and similar) left out: those addresses never existed here.` : ""}` },
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
	items.push(...cacheSection(d));
	items.push({ type: "context", text: `Page build time${ttfb !== undefined ? ` today: ${ttfb} ms (median)` : ""} — how long the site takes to build the home page, measured inside Cloudflare every 5 minutes. Most visitors get a ready-made copy from the cache, which is faster; the developer's verify run measures that from outside.` });
	return items;
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
		{
			type: "form",
			block_id: "maintenance",
			fields: [
				{ type: "toggle", action_id: "on", label: "Show the coming-soon page to visitors", initial_value: d.maintenance?.on === true },
				{ type: "text_input", action_id: "heading", label: "Heading", placeholder: "We'll be back soon", ...(d.maintenance?.heading ? { initial_value: d.maintenance.heading } : {}) },
				{ type: "text_input", action_id: "message", label: "Message", placeholder: "The site is getting ready. Please check back shortly.", multiline: true, ...(d.maintenance?.message ? { initial_value: d.maintenance.message } : {}) },
				{ type: "text_input", action_id: "until", label: "Expected back (optional, e.g. 2026-12-01 09:00 UTC)", placeholder: "YYYY-MM-DD HH:MM", ...(d.maintenance?.until ? { initial_value: d.maintenance.until.slice(0, 16).replace("T", " ") } : {}) },
			],
			submit: { label: "Save coming-soon mode", action_id: "save-maintenance" },
		},
		...previewBlocks(d),
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
	const missing = d.notFound?.top.length ?? 0;
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

export function widget(d: Pick<PageData, "state" | "today" | "incidents"> & Partial<Pick<PageData, "notFound" | "maintenance">>): Block[] {
	const o = overallOf(d.state);
	const open = d.incidents.filter((i) => !i.endedAt).length;
	const attention = CHECK_IDS.filter((id) => ["fail", "warn"].includes(d.state.checks[id]?.status ?? "")).map((id) => CHECK_LABELS[id]);
	const missing = d.state.checks.notfound?.status === "warn" ? (d.notFound?.top.filter((r) => r.hits >= 3).length ?? 0) : 0;
	return [
		{ type: "banner", title: OVERALL[o].title, description: o === "attention" ? `Needs a look: ${attention.join(", ")}.` : OVERALL[o].description, variant: OVERALL[o].variant },
		...(d.maintenance?.on ? [{ type: "context", text: "Coming-soon mode is on: visitors see the holding page." }] : []),
		...(missing ? [{ type: "context", text: `${plural(missing, "missing address", "missing addresses")} visitors keep asking for: see Site health → Missing pages for suggested redirects.` }] : []),
		{ type: "stats", items: [{ label: "Uptime today", value: d.today ? uptimePct([d.today]) : "—" }, { label: "Open incidents", value: open }] },
		{ type: "actions", elements: [{ type: "link", label: "Open Site health", target: { kind: "plugin-page", path: PAGE }, appearance: "secondary" }] },
	];
}

export const adminsOnly: Block[] = [{ type: "banner", title: "Admins only", description: "Ask a site admin for access to Site health.", variant: "error" }];
