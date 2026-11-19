/** SEO dashboard views (Block Kit): overview, pages, images, site checks; and the dashboard widget. */
import type { Check } from "../analyze.js";
import type { PageReport } from "./collect.js";

type Block = Record<string, unknown>;
export const DASHBOARD_PAGE = "/seo";
export const WIDGET = "seo-overview";
const ICON: Record<Check["status"], string> = { good: "✓", warn: "!", bad: "✗", info: "i" };
const avg = (pages: PageReport[]) => (pages.length ? Math.round(pages.reduce((s, p) => s + p.analysis.score, 0) / pages.length) : 0);
const issues = (p: PageReport) => p.analysis.checks.filter((c) => c.status === "bad" || c.status === "warn");

export interface DashboardData {
	pages: PageReport[];
	missingAlt: { id: string; filename: string; url?: string; pages: string[] }[];
	site: Check[];
	altSaved?: number;
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

export function dashboard(d: DashboardData, tab = 0): Block[] {
	return [
		{ type: "header", text: "SEO" },
		{
			type: "tab",
			default_tab: tab,
			panels: [
				{ label: "Overview", blocks: overview(d) },
				{ label: `Pages (${d.pages.length})`, blocks: pagesTab(d) },
				{ label: `Images${d.missingAlt.length ? ` (${d.missingAlt.length})` : ""}`, blocks: imagesTab(d) },
				{ label: "Site checks", blocks: siteTab(d) },
			],
		},
	];
}

export function widget(pages: PageReport[], missingAlt: number): Block[] {
	return [
		{ type: "stats", items: [{ label: "Average score", value: `${avg(pages)}/100` }, { label: "Pages under 80", value: pages.filter((p) => p.analysis.score < 80).length }, { label: "Images to describe", value: missingAlt }] },
		{ type: "actions", elements: [{ type: "link", label: "Open SEO", target: { kind: "plugin-page", path: DASHBOARD_PAGE }, appearance: "secondary" }] },
	];
}
