/** SEO dashboard views (Block Kit): overview, pages, images, site checks; and the dashboard widget. */
import type { Check } from "../analyze.js";
import type { PageReport } from "./collect.js";

type Block = Record<string, unknown>;
export const DASHBOARD_PAGE = "/seo";
export type TabKey = "overview" | "visits" | "analytics" | "pages" | "images" | "site" | "google" | "indexnow";
export const WIDGET = "seo-overview";
const ICON: Record<Check["status"], string> = { good: "✓", warn: "!", bad: "✗", info: "i" };
const avg = (pages: PageReport[]) => (pages.length ? Math.round(pages.reduce((s, p) => s + p.analysis.score, 0) / pages.length) : 0);
const issues = (p: PageReport) => p.analysis.checks.filter((c) => c.status === "bad" || c.status === "warn");

export interface DashboardData {
	pages: PageReport[];
	missingAlt: { id: string; filename: string; url?: string; pages: string[] }[];
	site: Check[];
	altSaved?: number;
	google: GoogleState;
	indexNow?: IndexNowState;
	productionUrl: string;
	/** Analytics in the suite (absent when the site carries no analytics): blocks for the tabs and the overview line. */
	analytics?: { overview: Block[]; visits: Block[]; tab: Block[] };
}

function overview(d: DashboardData): Block[] {
	const need = d.pages.filter((p) => p.analysis.score < 80);
	// Most common problems: label → pages affected.
	const byIssue = new Map<string, { status: Check["status"]; pages: string[] }>();
	for (const p of d.pages)
		for (const c of issues(p)) {
			const e = byIssue.get(c.label) ?? { status: c.status, pages: [] };
			if (c.status === "bad") e.status = "bad";
			e.pages.push(p.title);
			byIssue.set(c.label, e);
		}
	const top = [...byIssue.entries()].sort((a, b) => b[1].pages.length - a[1].pages.length);
	const siteProblems = d.site.filter((c) => c.status === "bad" || c.status === "warn").length;
	const sorted = [...d.pages].sort((a, b) => a.analysis.score - b.analysis.score);
	return [
		{
			type: "stats",
			items: [
				{ label: "Average SEO score", value: `${avg(d.pages)}/100` },
				{ label: "Pages checked", value: d.pages.length },
				{ label: "Pages under 80", value: need.length, ...(need.length ? { trend: "down" } : {}) },
				{ label: "Images without description", value: d.missingAlt.length, ...(d.missingAlt.length ? { trend: "down" } : {}) },
			],
		},
		...(siteProblems ? [{ type: "banner", title: `${siteProblems} site-wide problem${siteProblems === 1 ? "" : "s"}`, description: "See the Site checks tab.", variant: "error" }] : []),
		{
			type: "chart",
			config: {
				chart_type: "custom",
				height: Math.max(220, sorted.length * 28 + 60),
				options: {
					grid: { left: 150, right: 30, top: 10, bottom: 30 },
					xAxis: { type: "value", min: 0, max: 100 },
					yAxis: { type: "category", data: sorted.map((p) => p.title.slice(0, 24)), axisTick: { show: false } },
					series: [{ type: "bar", data: sorted.map((p) => ({ value: p.analysis.score, itemStyle: { color: p.analysis.score >= 80 ? "#1f9d6b" : p.analysis.score >= 50 ? "#d9a21b" : "#d64545" } })), label: { show: true, position: "right" } }],
					tooltip: { trigger: "axis" },
				},
			},
		},
		{ type: "header", text: "Most common issues" },
		{
			type: "table",
			block_id: "issues",
			page_action_id: "noop",
			empty_text: "No issues on any page.",
			columns: [
				{ key: "issue", label: "Issue" },
				{ key: "count", label: "Pages", format: "number" },
				{ key: "pages", label: "Where" },
			],
			rows: top.map(([label, e]) => ({ issue: `${ICON[e.status]} ${label}`, count: e.pages.length, pages: e.pages.slice(0, 4).join(", ") + (e.pages.length > 4 ? "…" : "") })),
		},
		{ type: "context", text: "Scores use the same checks as the SEO panel in the page editor. A good score helps, but rankings also depend on content quality, links from other sites and the Google Business Profile." },
	];
}

function pagesTab(d: DashboardData): Block[] {
	return [
		{
			type: "table",
			block_id: "pages",
			page_action_id: "noop",
			columns: [
				{ key: "page", label: "Page" },
				{ key: "score", label: "Score", format: "number", sortable: true },
				{ key: "status", label: "", format: "badge" },
				{ key: "issues", label: "To improve" },
				{ key: "keyword", label: "Focus keyword" },
				{ key: "open", label: "", format: "element" },
			],
			rows: [...d.pages]
				.sort((a, b) => a.analysis.score - b.analysis.score)
				.map((p) => ({
					page: p.title,
					score: p.analysis.score,
					status: p.analysis.score >= 80 ? "Good" : p.analysis.score >= 50 ? "Improve" : "Fix",
					issues: issues(p).map((c) => c.label).join(", ") || "—",
					keyword: p.keyword ?? "—",
					open: { type: "link", label: "Open", target: { kind: "content", collection: p.collection, id: p.item.id } },
				})),
		},
		{ type: "context", text: "Open a page and unfold SEO in its sidebar for the details and the Google preview." },
	];
}

function imagesTab(d: DashboardData): Block[] {
	if (!d.missingAlt.length) return [{ type: "empty", title: "Every image has a description", description: "Alt text helps image search and people using screen readers.", size: "base" }];
	const shown = d.missingAlt.slice(0, 40);
	return [
		{ type: "context", text: "Describe what each picture shows in a short sentence (it is read aloud to people who cannot see it, and helps Google Images). Saved to the media library, so every page using the image gets it." },
		...(d.altSaved !== undefined ? [{ type: "banner", title: `${d.altSaved} description${d.altSaved === 1 ? "" : "s"} saved`, variant: "default" }] : []),
		{
			type: "form",
			block_id: "alt",
			fields: shown.map((m) => ({ type: "text_input", action_id: `alt:${m.id}`, label: `${m.filename} — on ${m.pages.slice(0, 3).join(", ")}${m.pages.length > 3 ? "…" : ""}`, placeholder: "e.g. Reformer machines in the bright main studio" })),
			submit: { label: "Save descriptions", action_id: "save-alt" },
		},
		...(d.missingAlt.length > shown.length ? [{ type: "context", text: `${d.missingAlt.length - shown.length} more after these are done.` }] : []),
	];
}

function siteTab(d: DashboardData): Block[] {
	return [
		...d.site.map((c) => ({ type: "section", text: `${ICON[c.status]} ${c.label}: ${c.detail}` })),
		{ type: "actions", elements: [{ type: "button", action_id: "refresh", label: "Check again", style: "secondary" }] },
	];
}

export function dashboard(d: DashboardData, tab: TabKey = "overview"): Block[] {
	const a = d.analytics;
	const g = d.google.data;
	const panels: { key: TabKey; label: string; blocks: Block[] }[] = [
		{ key: "overview", label: "Overview", blocks: [...(a ? [...a.overview, ...(g ? [{ type: "stats", items: [{ label: "Google clicks, 28 days", value: g.totals.clicks }, { label: "Impressions", value: g.totals.impressions }, { label: "Average position", value: g.totals.position.toFixed(1) }] }] : [])] : []), ...overview(d)] },
		...(a ? [{ key: "visits" as const, label: "Visits", blocks: a.visits }, { key: "analytics" as const, label: "Analytics", blocks: a.tab }] : []),
		{ key: "pages", label: `Pages (${d.pages.length})`, blocks: pagesTab(d) },
		{ key: "images", label: `Images${d.missingAlt.length ? ` (${d.missingAlt.length})` : ""}`, blocks: imagesTab(d) },
		{ key: "site", label: "Site checks", blocks: siteTab(d) },
		{ key: "google", label: d.google.connected ? "Google" : "Google (connect)", blocks: googleTab(d.google, d.productionUrl) },
		...(d.indexNow ? [{ key: "indexnow" as const, label: "IndexNow", blocks: indexNowTab(d.indexNow) }] : []),
	];
	// The SEO stats lead the overview; with analytics they follow the visits line.
	if (a) {
		const first = panels[0] as { blocks: Block[] };
		const seoStats = first.blocks.findIndex((b) => b.type === "stats" && Array.isArray(b.items) && (b.items as { label: string }[])[0]?.label === "Average SEO score");
		if (seoStats > 0) first.blocks.unshift(...first.blocks.splice(seoStats, 1));
	}
	return [
		{ type: "header", text: a ? "SEO & Analytics" : "SEO" },
		{ type: "tab", default_tab: Math.max(0, panels.findIndex((p) => p.key === tab)), panels: panels.map(({ label, blocks }) => ({ label, blocks })) },
	];
}

export function widget(pages: PageReport[], missingAlt: number): Block[] {
	return [
		{ type: "stats", items: [{ label: "Average score", value: `${avg(pages)}/100` }, { label: "Pages under 80", value: pages.filter((p) => p.analysis.score < 80).length }, { label: "Images to describe", value: missingAlt }] },
		{ type: "actions", elements: [{ type: "link", label: "Open SEO & Analytics", target: { kind: "plugin-page", path: DASHBOARD_PAGE }, appearance: "secondary" }] },
	];
}

// ── Google Search Console and IndexNow tabs ─────────────────────────────────────────────────────────────────────────

export interface GoogleData {
	at: string;
	property: string;
	range: { startDate: string; endDate: string };
	totals: { clicks: number; impressions: number; ctr: number; position: number };
	byDate: { date: string; clicks: number; impressions: number }[];
	queries: { query: string; clicks: number; impressions: number; ctr: number; position: number }[];
	pages: { page: string; clicks: number; impressions: number; ctr: number; position: number }[];
	sitemaps: { path: string; lastSubmitted?: string; lastDownloaded?: string; isPending?: boolean; errors?: string; warnings?: string; indexed?: string; submitted?: string }[];
	inspections?: { at: string; rows: { url: string; verdict?: string; coverageState?: string; lastCrawlTime?: string }[] };
}
export interface GoogleState {
	connected: boolean;
	account?: string;
	data?: GoogleData;
	error?: string;
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const pos = (n: number) => n.toFixed(1);

export function googleTab(g: GoogleState, productionUrl: string): Block[] {
	if (!g.connected)
		return [
			...(g.error ? [{ type: "banner", title: "Could not connect", description: g.error, variant: "error" }] : []),
			{ type: "header", text: "Connect Google Search Console" },
			{ type: "context", text: "See how people find the site in Google — searches, clicks, positions — and whether pages are indexed, right here. One-time setup by the site owner, about 5 minutes:" },
			{ type: "section", text: "1. In Google Cloud (console.cloud.google.com) create a project, enable the “Google Search Console API”, and create a service account under IAM → Service accounts." },
			{ type: "section", text: "2. On the service account open Keys → Add key → JSON. A file downloads." },
			{ type: "section", text: `3. In Search Console (search.google.com/search-console), open the property for ${new URL(productionUrl).host} → Settings → Users and permissions → Add user: the service account's email, permission “Full” (needed to submit the sitemap).` },
			{ type: "section", text: "4. Open the downloaded file in a text editor, copy everything and paste it below. It is stored encrypted and never shown again." },
			{
				type: "form",
				block_id: "gsc",
				fields: [
					{ type: "secret_input", action_id: "key", label: "Service account key (JSON)", placeholder: '{ "type": "service_account", … }' },
					{ type: "text_input", action_id: "property", label: "Search Console property (optional — found automatically)", placeholder: `sc-domain:${new URL(productionUrl).host.replace(/^www\./, "")}` },
				],
				submit: { label: "Connect", action_id: "gsc-connect" },
			},
		];
	const d = g.data;
	return [
		...(g.error ? [{ type: "banner", title: "Google answered with an error", description: g.error, variant: "error" }] : []),
		...(d
			? [
					{ type: "context", text: `${d.property} · ${d.range.startDate} – ${d.range.endDate} (Google's data lags about two days) · updated ${d.at.slice(0, 16).replace("T", " ")} UTC` },
					{ type: "stats", items: [{ label: "Clicks", value: d.totals.clicks }, { label: "Impressions", value: d.totals.impressions }, { label: "Click rate", value: pct(d.totals.ctr) }, { label: "Average position", value: pos(d.totals.position) }] },
					...(d.byDate.length
						? [{ type: "chart", config: { chart_type: "timeseries", style: "line", height: 260, y_axis_name: "Per day", series: [{ name: "Clicks", data: d.byDate.map((r) => [Date.parse(`${r.date}T12:00:00Z`), r.clicks]) }, { name: "Impressions", data: d.byDate.map((r) => [Date.parse(`${r.date}T12:00:00Z`), r.impressions]) }] } }]
						: [{ type: "empty", title: "No search data yet", description: "Google has not recorded searches for this property in the last 28 days.", size: "sm" }]),
					{ type: "header", text: "Top searches" },
					{ type: "table", block_id: "queries", page_action_id: "noop", empty_text: "None yet.", columns: [{ key: "query", label: "Search" }, { key: "clicks", label: "Clicks", format: "number" }, { key: "impressions", label: "Impressions", format: "number" }, { key: "ctr", label: "Click rate" }, { key: "position", label: "Position" }], rows: d.queries.map((q) => ({ ...q, ctr: pct(q.ctr), position: pos(q.position) })) },
					{ type: "header", text: "Top pages" },
					{ type: "table", block_id: "gpages", page_action_id: "noop", empty_text: "None yet.", columns: [{ key: "page", label: "Page" }, { key: "clicks", label: "Clicks", format: "number" }, { key: "impressions", label: "Impressions", format: "number" }, { key: "ctr", label: "Click rate" }, { key: "position", label: "Position" }], rows: d.pages.map((p) => ({ ...p, page: p.page.replace(/^https?:\/\/[^/]+/, "") || "/", ctr: pct(p.ctr), position: pos(p.position) })) },
					{ type: "header", text: "Sitemaps" },
					{ type: "table", block_id: "sitemaps", page_action_id: "noop", empty_text: "No sitemap submitted yet.", columns: [{ key: "path", label: "Sitemap" }, { key: "submitted", label: "Submitted" }, { key: "read", label: "Last read by Google" }, { key: "status", label: "Status", format: "badge" }], rows: d.sitemaps.map((s) => ({ path: s.path.replace(/^https?:\/\/[^/]+/, ""), submitted: s.lastSubmitted?.slice(0, 10) ?? "—", read: s.lastDownloaded?.slice(0, 10) ?? "—", status: Number(s.errors) ? "Errors" : s.isPending ? "Pending" : Number(s.warnings) ? "Warnings" : "OK" })) },
					...(d.inspections
						? [{ type: "header", text: "Index status" }, { type: "context", text: `Checked ${d.inspections.at.slice(0, 16).replace("T", " ")} UTC` }, { type: "table", block_id: "inspect", page_action_id: "noop", columns: [{ key: "url", label: "Page" }, { key: "verdict", label: "", format: "badge" }, { key: "coverage", label: "Google says" }, { key: "crawl", label: "Last crawl" }], rows: d.inspections.rows.map((r) => ({ url: r.url.replace(/^https?:\/\/[^/]+/, "") || "/", verdict: r.verdict === "PASS" ? "Indexed" : r.verdict === "NEUTRAL" ? "Not indexed" : r.verdict ?? "—", coverage: r.coverageState ?? "—", crawl: r.lastCrawlTime?.slice(0, 10) ?? "—" })) }]
						: []),
				]
			: []),
		{
			type: "actions",
			elements: [
				{ type: "button", action_id: "gsc-refresh", label: "Refresh", style: "secondary" },
				{ type: "button", action_id: "gsc-submit-sitemap", label: "Submit sitemap", style: "primary", confirm: { title: "Submit the sitemap to Google?", text: `${productionUrl.replace(/\/$/, "")}/sitemap.xml will be (re)submitted. Google reads it within days.`, confirm: "Submit", deny: "Cancel" } },
				{ type: "button", action_id: "gsc-inspect", label: "Check index status", style: "secondary" },
				{ type: "button", action_id: "gsc-disconnect", label: "Disconnect", style: "danger", confirm: { title: "Disconnect Search Console?", text: "The stored key is deleted. Remove the service account from Search Console too if it is no longer needed.", confirm: "Disconnect", deny: "Keep" } },
			],
		},
		{ type: "context", text: `Connected as ${g.account ?? "a service account"}. The key is stored encrypted.` },
	];
}

export interface IndexNowState {
	live: boolean;
	keyFile: "ok" | "missing" | "not-checked";
	host: string;
	log: { at: string; urls: number; status: number; ok: boolean; note?: string; trigger: string }[];
}

export function indexNowTab(s: IndexNowState): Block[] {
	return [
		{ type: "context", text: "IndexNow tells Bing, Yandex, Seznam, Naver and other engines the moment a page is published, instead of waiting for them to crawl. (Google does not take part: it reads the sitemap.)" },
		s.live
			? { type: "banner", title: "Active", description: `Publishing a page notifies the search engines. Key file on ${s.host}: ${s.keyFile === "ok" ? "found" : s.keyFile === "missing" ? "NOT FOUND — submissions will be refused" : "not checked"}.`, variant: s.keyFile === "missing" ? "error" : "default" }
			: { type: "banner", title: "Starts after go-live", description: `${s.host} still serves the old site, so search engines cannot verify the key yet. After the switch, publishing a page notifies them automatically.`, variant: "default" },
		{ type: "table", block_id: "indexnow-log", page_action_id: "noop", empty_text: "No notifications sent yet.", columns: [{ key: "at", label: "When", format: "relative_time" }, { key: "trigger", label: "What" }, { key: "urls", label: "Pages", format: "number" }, { key: "result", label: "Result", format: "badge" }], rows: s.log.map((l) => ({ at: l.at, trigger: l.trigger, urls: l.urls, result: l.ok ? "Accepted" : `Refused${l.status ? ` (${l.status})` : ""}${l.note ? `: ${l.note}` : ""}` })) },
		...(s.live ? [{ type: "actions", elements: [{ type: "button", action_id: "indexnow-all", label: "Notify search engines about every page", style: "secondary", confirm: { title: "Notify about every page?", text: "Sends every published page's address to IndexNow. Use after big changes; publishing a page already notifies them.", confirm: "Notify", deny: "Cancel" } }] }] : []),
	];
}
