/**
 * Analytics views (Block Kit) inside the SEO & Analytics dashboard: the Analytics tab (tracking codes, conversion
 * events, consent mode, verification tags), the add / edit forms, the Visits tab, the overview summary, the Visits
 * dashboard widget and the editor panel's visits line.
 */
import type { AnalyticsOptions } from "../index.js";
import type { StoredAnalytics } from "./store.js";
import { ADDABLE_TYPES, EVENT_INFO, EVENT_KINDS, SPECS, type Tracker } from "./trackers.js";
import type { Visits } from "./visits.js";

type Block = Record<string, unknown>;
export const VISITS_WIDGET = "visits";

const hostOf = (url: string) => (URL.canParse(url) ? new URL(url).host : url);
const n = (v: number) => v.toLocaleString("en-US");
const VERIFY_NAMES: Record<string, string> = { google: "Google Search Console", "google-site-verification": "Google Search Console", bing: "Bing Webmaster Tools", msvalidate: "Bing Webmaster Tools", "msvalidate.01": "Bing Webmaster Tools", yandex: "Yandex", "yandex-verification": "Yandex", pinterest: "Pinterest", "p:domain_verify": "Pinterest", facebook: "Meta (domain verification)", "facebook-domain-verification": "Meta (domain verification)" };

export type VisitsState = { kind: "setup"; missing: string[] } | { kind: "error"; message: string } | { kind: "data"; visits: Visits; cachedAt?: string };

export interface AnalyticsView {
	/** Analytics is part of the site (kit.config `analytics` is not false). */
	enabled: boolean;
	stored: StoredAnalytics;
	options: AnalyticsOptions;
	productionUrl: string;
	admin: boolean;
	errors?: string[];
}

function statusText(t: Tracker, zoneBeacon: boolean | undefined): string {
	if (SPECS[t.type].retired) return "Retired";
	if (!t.enabled) return "Off";
	if (t.type === "cloudflare" && zoneBeacon) return "On · also added by Cloudflare";
	return "On";
}

export function analyticsTab(v: AnalyticsView): Block[] {
	const host = hostOf(v.productionUrl);
	if (!v.enabled) return [{ type: "empty", title: "Tracking is off for this site", description: "The site was set up to carry no tracking codes (migration kit: analytics: false). Ask the developer to turn it on.", size: "base" }];
	const s = v.stored;
	const on = s.trackers.filter((t) => t.enabled).length;
	const retired = s.trackers.filter((t) => SPECS[t.type].retired);
	const c = v.options.lastCheck;
	const verification = Object.entries(v.options.verification ?? {});
	return [
		...(v.errors?.length ? [{ type: "banner", title: "Not saved", description: v.errors.join(" "), variant: "error" }] : []),
		{ type: "stats", items: [{ label: "Tracking codes on", value: `${on} of ${s.trackers.length - retired.length}` }, { label: "Conversion events", value: EVENT_KINDS.filter((k) => s.events[k]).length }, { label: "Consent mode", value: s.consent ? "On" : "Off" }] },
		{ type: "header", text: "Tracking codes" },
		{ type: "context", text: `Loaded on ${host} for visitors only: never on staging, previews or your computer, and never while you are signed in, so your own visits are not counted.` },
		{
			type: "table",
			block_id: "trackers",
			page_action_id: "noop",
			empty_text: "No tracking codes: nothing is loaded for visitors.",
			columns: [
				{ key: "service", label: "Service" },
				{ key: "id", label: "ID", format: "code" },
				{ key: "status", label: "Status", format: "badge" },
				{ key: "added", label: "Added", format: "relative_time" },
				...(v.admin ? [{ key: "toggle", label: "", format: "element" }, { key: "edit", label: "", format: "element" }] : []),
			],
			rows: s.trackers.map((t) => ({
				service: `${SPECS[t.type].name}${t.origin === "wordpress" ? " · from the old site" : ""}`,
				id: t.value,
				status: statusText(t, v.options.zoneBeacon),
				added: t.addedAt,
				...(v.admin
					? SPECS[t.type].retired
						? { toggle: { type: "button", action_id: "an-remove", label: "Remove", style: "secondary", value: t.id }, edit: { type: "link", label: "Why?", target: { kind: "external", url: "https://support.google.com/analytics/answer/11583528" }, appearance: "inline" } }
						: { toggle: { type: "button", action_id: "an-toggle", label: t.enabled ? "Turn off" : "Turn on", style: "secondary", value: t.id }, edit: { type: "button", action_id: "an-edit", label: "Edit", style: "secondary", value: t.id } }
					: {}),
			})),
		},
		...(retired.length ? [{ type: "context", text: `${retired.map((t) => t.value).join(", ")}: ${SPECS.ua.retired}` }] : []),
		...(v.admin
			? [{ type: "actions", elements: [{ type: "button", action_id: "an-add", label: "Add a tracking code", style: "primary" }] }]
			: [{ type: "context", text: "Only administrators can change tracking codes." }]),
		{ type: "context", text: `Only known services can be added, each by its ID — no code snippets, so nothing else can run on the site. Changes reach the live site within a few seconds.${s.updatedBy ? ` Last change ${s.updatedAt.slice(0, 16).replace("T", " ")} UTC by ${s.updatedBy}.` : ""}` },
		{ type: "divider" },
		{ type: "header", text: "Conversion events" },
		{ type: "context", text: "Sent to every tracking code above that understands them. Nothing a visitor typed is sent: no names, emails, phone numbers or messages — only which kind of action happened." },
		v.admin
			? {
					type: "form",
					block_id: "an-switches",
					fields: [
						...EVENT_KINDS.map((k) => ({ type: "toggle", action_id: `event:${k}`, label: EVENT_INFO[k].label, description: EVENT_INFO[k].sends, initial_value: s.events[k] })),
						{ type: "toggle", action_id: "consent", label: "Consent mode", description: "Off by default. On: Google tags start with consent denied (cookieless) and Meta, Clarity and Hotjar wait until a third-party consent banner calls siteAnalytics.grantConsent(). Not needed with the built-in banner (Privacy & consent): the trackers follow the visitor's choice there by themselves.", initial_value: s.consent },
					],
					submit: { label: "Save switches", action_id: "an-switches" },
				}
			: { type: "fields", fields: EVENT_KINDS.map((k) => ({ label: EVENT_INFO[k].label, value: s.events[k] ? "On" : "Off" })) },
		{ type: "divider" },
		{ type: "header", text: "Is it working?" },
		{ type: "context", text: `“On” means the site asks visitors' browsers to load it on ${host}. Whether a browser really ran it cannot be seen from here: ad blockers and privacy settings stop many trackers, and each service shows its own data. To check, open ${v.productionUrl} in a private window (not signed in) and use the service's test view: Google Analytics → Realtime or Tag Assistant, Meta Events Manager → Test events, Clarity → Recordings, Hotjar → Recordings, Cloudflare → Web Analytics.` },
		c ? { type: "context", text: `Last browser check by the developer's kit (verify, ${c.at.slice(0, 10)}): ${c.ok ? "passed" : "failed"}${c.detail ? ` — ${c.detail.slice(0, 300)}` : ""}. It reflects the codes switched on at that time.` } : { type: "context", text: "The developer's kit checks this in a real browser after go-live (verify: analytics-runtime); no result was recorded for this build." },
		{ type: "header", text: "Ownership verification" },
		{ type: "context", text: "Google Search Console and Bing Webmaster Tools tags are edited in Settings → SEO (/_emdash/admin/settings/seo), prefilled from the old site; they are in every page's head. Tags of other services (Pinterest, Meta, Yandex) carried over from the old site are listed below, read-only: they change with the site's code." },
		...(verification.length
			? [{ type: "table", block_id: "verification", page_action_id: "noop", columns: [{ key: "service", label: "Service" }, { key: "tag", label: "Meta tag", format: "code" }, { key: "where", label: "Edit in" }], rows: verification.map(([k, val]) => ({ service: VERIFY_NAMES[k] ?? k, tag: `${k}: ${String(val).slice(0, 80)}`, where: /^(google-site-verification|google|msvalidate(\.01)?|bing)$/.test(k) ? "Settings → SEO (this value is the fallback when that field is empty)" : "— (site code)" })) }]
			: []),
	];
}

const typeOptions = ADDABLE_TYPES.map((t) => ({ label: SPECS[t].name, value: t }));

export function addView(errors: string[] = [], values: Record<string, unknown> = {}): Block[] {
	return [
		{ type: "header", text: "Add a tracking code" },
		...(errors.length ? [{ type: "banner", title: "Not added", description: errors.join(" "), variant: "error" }] : []),
		{
			type: "form",
			block_id: "an-add",
			fields: [
				{ type: "select", action_id: "type", label: "Service", options: typeOptions, initial_value: typeof values.type === "string" ? values.type : "ga4" },
				{ type: "text_input", action_id: "value", label: "ID", placeholder: "e.g. G-ABC123DEF4", ...(typeof values.value === "string" ? { initial_value: values.value.slice(0, 200) } : {}) },
				{ type: "toggle", action_id: "enabled", label: "On", description: "Load it for visitors right away.", initial_value: values.enabled !== false },
			],
			submit: { label: "Add", action_id: "an-add-save" },
		},
		{ type: "actions", elements: [{ type: "button", action_id: "an-cancel", label: "Cancel", style: "secondary" }] },
		{ type: "header", text: "Where to find the ID" },
		{ type: "table", block_id: "an-formats", page_action_id: "noop", columns: [{ key: "service", label: "Service" }, { key: "example", label: "Looks like", format: "code" }, { key: "where", label: "Where" }], rows: ADDABLE_TYPES.map((t) => ({ service: SPECS[t].name, example: SPECS[t].example, where: SPECS[t].where })) },
	];
}

export function editView(t: Tracker, errors: string[] = []): Block[] {
	const s = SPECS[t.type];
	return [
		{ type: "header", text: `Edit ${s.name}` },
		...(errors.length ? [{ type: "banner", title: "Not saved", description: errors.join(" "), variant: "error" }] : []),
		{
			type: "form",
			block_id: `an-edit:${t.id}`,
			fields: [
				{ type: "text_input", action_id: "value", label: s.idName, initial_value: t.value, placeholder: s.example },
				{ type: "toggle", action_id: "enabled", label: "On", initial_value: t.enabled },
			],
			submit: { label: "Save", action_id: "an-edit-save" },
		},
		{ type: "context", text: `${s.idName}, like ${s.example}. ${s.where} To switch to another service, remove this one and add the other.` },
		{
			type: "actions",
			elements: [
				{ type: "button", action_id: "an-cancel", label: "Back", style: "secondary" },
				{ type: "button", action_id: "an-remove", label: "Remove", style: "danger", value: t.id, confirm: { title: `Remove ${s.name} ${t.value}?`, text: "Visitors' browsers stop loading it within a few seconds. Its data stays in the service.", confirm: "Remove", deny: "Keep it", style: "danger" } },
			],
		},
	];
}

// ── Visits ───────────────────────────────────────────────────────────────────────────────────────────────────

const SETUP = "Setup (developer, once): 1) Cloudflare → My Profile → API Tokens → Create Token → Custom: Account → Account Analytics → Read, for this account only. 2) Save it as CF_ANALYTICS_TOKEN in the kit dashboard's Secrets view and press “Set on Worker” (or: npx wrangler secret put CF_ANALYTICS_TOKEN). 3) Web Analytics must be on for the domain (Cloudflare → Web Analytics). The token can only read analytics and is never shown here.";
const day = (d: string) => Date.parse(`${d}T12:00:00Z`);

export function visitsTab(s: VisitsState, host: string): Block[] {
	if (s.kind === "setup") return [{ type: "empty", title: "Connect Cloudflare Web Analytics", description: `Visits to ${host}, the busiest pages and where visitors come from appear here once the site can read them. Missing: ${s.missing.join(", ")}.`, size: "base" }, { type: "context", text: SETUP }];
	if (s.kind === "error") return [{ type: "banner", title: "Visits could not be loaded", description: s.message, variant: "error" }, { type: "actions", elements: [{ type: "button", action_id: "visits-refresh", label: "Try again", style: "secondary" }] }];
	const v = s.visits;
	return [
		{ type: "stats", items: [{ label: "Visits", value: n(v.visits), description: "last 7 days" }, { label: "Page views", value: n(v.pageViews) }, { label: "Pages per visit", value: v.visits ? (v.pageViews / v.visits).toFixed(1) : "—" }] },
		...(v.days.length ? [{ type: "chart", config: { chart_type: "timeseries", style: "bar", height: 220, y_axis_name: "Per day", series: [{ name: "Visits", data: v.days.map((d) => [day(d.date), d.visits]) }, { name: "Page views", data: v.days.map((d) => [day(d.date), d.views]) }] } }] : []),
		{ type: "header", text: "Top pages" },
		{ type: "table", block_id: "visit-pages", page_action_id: "noop", empty_text: "No page views recorded yet.", columns: [{ key: "path", label: "Page", format: "code" }, { key: "views", label: "Views", format: "number" }, { key: "visits", label: "Visits", format: "number" }], rows: v.pages.slice(0, 15).map((p) => ({ path: p.path, views: p.views, visits: p.visits })) },
		{ type: "header", text: "Top referrers" },
		{ type: "table", block_id: "visit-referrers", page_action_id: "noop", empty_text: "No visits from other sites yet (direct visits and searches without a referrer are not listed).", columns: [{ key: "host", label: "Site" }, { key: "views", label: "Views", format: "number" }], rows: v.topReferrers },
		{ type: "context", text: `Cloudflare Web Analytics for ${host}, ${v.since.slice(0, 10)} to ${v.until.slice(0, 10)}: sampled, cookieless, counts browsers that ran the beacon (ad blockers hide some).${s.cachedAt ? ` Updated ${s.cachedAt.slice(11, 16)} UTC.` : ""}` },
		{ type: "actions", elements: [{ type: "button", action_id: "visits-refresh", label: "Refresh", style: "secondary" }] },
	];
}

export function visitsWidget(s: VisitsState, host: string, page: string): Block[] {
	if (s.kind === "setup") return [{ type: "context", text: `Visits to ${host} from Cloudflare Web Analytics appear here once the site can read them. Missing: ${s.missing.join(", ")}.` }, { type: "context", text: SETUP }];
	if (s.kind === "error") return [{ type: "context", text: `Visits could not be loaded: ${s.message}` }];
	const v = s.visits;
	return [
		{ type: "stats", items: [{ label: "Visits, 7 days", value: n(v.visits) }, { label: "Page views", value: n(v.pageViews) }] },
		...(v.days.length ? [{ type: "chart", config: { chart_type: "timeseries", style: "line", height: 140, series: [{ name: "Visits", data: v.days.map((d) => [day(d.date), d.visits]) }] } }] : []),
		...(v.pages.length ? [{ type: "table", block_id: "top-pages", page_action_id: "noop", columns: [{ key: "path", label: "Top pages", format: "code" }, { key: "views", label: "Views", format: "number" }], rows: v.pages.slice(0, 5).map((p) => ({ path: p.path, views: p.views })) }] : []),
		...(v.topReferrers.length ? [{ type: "table", block_id: "top-referrers", page_action_id: "noop", columns: [{ key: "host", label: "Top referrers" }, { key: "views", label: "Views", format: "number" }], rows: v.topReferrers }] : []),
		{ type: "actions", elements: [{ type: "link", label: "SEO & Analytics", target: { kind: "plugin-page", path: page }, appearance: "secondary" }] },
	];
}

/** One line of overview stats: visits and tracking, next to the SEO and Search Console numbers. */
export function overviewAnalytics(s: VisitsState | undefined, a: StoredAnalytics | undefined): Block[] {
	const items: Record<string, unknown>[] = [];
	if (s?.kind === "data") items.push({ label: "Visits, 7 days", value: n(s.visits.visits) }, { label: "Page views, 7 days", value: n(s.visits.pageViews) });
	if (a) items.push({ label: "Tracking codes on", value: a.trackers.filter((t) => t.enabled).length }, { label: "Conversion events", value: EVENT_KINDS.filter((k) => a.events[k]).length });
	return items.length ? [{ type: "stats", items }] : [];
}

/** The editor panel's line: this page's views in the 7-day data. */
export function panelVisits(r: { views: number; visits: number } | undefined | "none"): Block[] {
	if (r === "none") return [];
	if (!r) return [{ type: "context", text: "Visits, 7 days: not among the 100 most viewed pages." }];
	return [{ type: "stats", items: [{ label: "Page views, 7 days", value: n(r.views) }, { label: "Visits", value: n(r.visits) }] }];
}
