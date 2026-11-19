/**
 * SEO — EmDash native plugin (loaded in the Worker from `@wp2emdash/seo/plugin`): a Block Kit panel in the page editor.
 *
 * Opening the panel analyses the saved page (`content:read`: its sections and SEO fields, plus other pages for the
 * duplicate check; `media:read`: alt text kept in the media library). "Check unsaved changes" analyses the editor's
 * current title and sections (`admin.editor-draft:read`; EmDash sends the draft with button presses, not on load).
 * The SEO fields live outside the entry, so their unsaved edits are not visible here until saved. A focus keyword per
 * page is kept in the plugin's KV. Contributors and up can use it (EmDash also checks they may edit the entry).
 */
import { definePlugin } from "emdash";
import type { Analysis, Check } from "../analyze.js";
import { SEO_PLUGIN, type SeoPanelOptions } from "../index.js";
import { siteChecks } from "../site-checks.js";
import { allItems, analyseItem, keywordKey, mediaIds, mediaInfo, type SeoCtx, siteReport } from "./collect.js";
import { DASHBOARD_PAGE, dashboard, WIDGET, widget } from "./dashboard.js";

type Block = Record<string, unknown>;

const ICON: Record<Check["status"], string> = { good: "✓", warn: "!", bad: "✗", info: "i" };
const ORDER: Record<Check["status"], number> = { bad: 0, warn: 1, good: 2, info: 3 };

function view(a: Analysis, keyword: string, source: "saved" | "draft"): Block[] {
	const variant = a.score >= 80 ? "default" : a.score >= 50 ? "alert" : "error";
	const problems = a.checks.filter((c) => c.status === "bad" || c.status === "warn").length;
	const sorted = [...a.checks].sort((x, y) => ORDER[x.status] - ORDER[y.status]);
	return [
		{ type: "banner", title: `SEO score ${a.score}/100`, description: problems ? `${problems} thing${problems === 1 ? "" : "s"} to improve${source === "draft" ? " (your unsaved changes)" : ""}.` : `Looks good${source === "draft" ? " (your unsaved changes)" : ""}.`, variant },
		{ type: "header", text: "Google preview" },
		{ type: "context", text: a.serp.url },
		{ type: "section", text: a.serp.title },
		{ type: "context", text: a.serp.description || "No description: Google will pick text from the page." },
		...(a.serp.titleCut || a.serp.descriptionCut ? [{ type: "context", text: `Cut off on Google: ${[a.serp.titleCut ? "title" : "", a.serp.descriptionCut ? "description" : ""].filter(Boolean).join(" and ")} (…).` }] : []),
		{ type: "divider" },
		// One wrapping line per check: the editor sidebar is narrow, so no table.
		...(problems ? [{ type: "header", text: "To improve" }, ...sorted.filter((c) => c.status === "bad" || c.status === "warn").map((c) => ({ type: "section", text: `${ICON[c.status]} ${c.label}: ${c.detail}` }))] : []),
		{ type: "accordion", label: `Passed checks (${sorted.filter((c) => c.status === "good").length})`, default_open: !problems, blocks: sorted.filter((c) => c.status === "good" || c.status === "info").map((c) => ({ type: "section", text: `${ICON[c.status]} ${c.label}: ${c.detail}` })) },
		{ type: "divider" },
		{
			type: "form",
			block_id: "keyword",
			fields: [{ type: "text_input", action_id: "keyword", label: "Focus keyword (what people search for to find this page)", placeholder: "e.g. reformer pilates Example City", ...(keyword ? { initial_value: keyword } : {}) }],
			submit: { label: "Save keyword", action_id: "keyword" },
		},
		{ type: "actions", elements: [{ type: "button", action_id: "check-draft", label: "Check my unsaved changes", style: "secondary" }] },
		{ type: "context", text: `${a.words} words. SEO title, description and sharing image are edited in the page's SEO fields; save the page to check changes made there.` },
	];
}

export function createPlugin(options: SeoPanelOptions) {
	const o = options;
	const collections = o.collections?.length ? o.collections : ["pages"];
	return definePlugin({
		...SEO_PLUGIN,
		capabilities: ["content:read", "media:read", "media:metadata:write", "admin.editor-draft:read"],
		admin: {
			pages: [{ path: DASHBOARD_PAGE, label: "SEO", icon: "chart-line" }],
			widgets: [{ id: WIDGET, title: "SEO", size: "third" }],
			editorPanels: [{ id: "seo", title: "SEO", route: "panel", collections, order: 10, draft: { read: { fields: ["title", "content"] } } }],
		},
		routes: {
			// SEO dashboard page and dashboard widget (editors and admins).
			admin: {
				permission: "content:edit_any",
				handler: async (raw) => {
					const ctx = raw as unknown as SeoCtx;
					const i = (ctx.input ?? {}) as { type?: string; action_id?: string; values?: Record<string, unknown> };
					let altSaved: number | undefined;
					if (i.type === "form_submit" && i.action_id === "save-alt" && ctx.media?.updateMetadata) {
						altSaved = 0;
						for (const [k, v] of Object.entries(i.values ?? {})) {
							const id = /^alt:([0-9A-HJKMNP-TV-Z]{26})$/.exec(k)?.[1];
							const alt = typeof v === "string" ? v.trim().slice(0, 300) : "";
							if (!id || !alt) continue;
							await ctx.media.updateMetadata(id, { alt });
							altSaved++;
						}
					}
					const report = await siteReport(ctx, o, collections);
					const missingAlt = [...report.usage.entries()]
						// Pictures only (videos and files have no alt text), and only those the library knows.
						.filter(([id]) => report.media.get(id)?.mimeType?.startsWith("image/") && !report.media.get(id)?.alt?.trim())
						.map(([id, used]) => ({ id, filename: report.media.get(id)?.filename ?? id, ...(report.media.get(id)?.url ? { url: report.media.get(id)?.url } : {}), pages: [...new Set(used.map((p) => p.title))] }));
					if (ctx.ui?.surface === "dashboard-widget") return { blocks: widget(report.pages, missingAlt.length) };
					const origin = ctx.request && URL.canParse(ctx.request.url) ? new URL(ctx.request.url).origin : o.productionUrl;
					const paths = report.pages.map((p) => (p.item.slug && p.item.slug !== "home" && p.item.slug !== "index" ? `/${p.item.slug}/` : "/"));
					// Through the Worker's binding to itself: a fetch to its own address skips the Worker (workers.dev: nothing
					// answers; the domain: the old origin would). Local dev has no such routing, so plain fetch works there.
					const { env } = (await import("cloudflare:workers")) as unknown as { env: { SELF?: { fetch(r: Request): Promise<Response> } } };
					const self = env.SELF;
					const fetcher = (self ? (input: RequestInfo | URL, init?: RequestInit) => self.fetch(new Request(String(input), init)) : fetch) as typeof fetch;
					const site = await siteChecks(origin, o.productionUrl, paths, fetcher).catch((e: Error) => [{ id: "site", label: "Site checks", status: "warn" as const, detail: `Could not run: ${e.message}` }]);
					return {
						blocks: dashboard({ pages: report.pages, missingAlt, site, ...(altSaved !== undefined ? { altSaved } : {}) }, i.action_id === "save-alt" ? 2 : i.action_id === "refresh" ? 3 : 0),
						...(altSaved ? { toast: { message: `${altSaved} image description${altSaved === 1 ? "" : "s"} saved.`, type: "success" } } : {}),
					};
				},
			},
			panel: {
				permission: "content:read_drafts",
				handler: async (raw) => {
					const ctx = raw as unknown as SeoCtx;
					const entry = ctx.ui?.entry;
					if (!entry || !ctx.content) return { blocks: [{ type: "context", text: "Save the page once to see its SEO checks." }] };
					const i = (ctx.input ?? {}) as { type?: string; action_id?: string; values?: Record<string, unknown>; draft?: { fields?: Record<string, unknown> } };
					const kvKey = keywordKey(entry.collection, entry.id);
					let keyword = (await ctx.kv.get<string>(kvKey)) ?? "";
					let toast: { message: string; type: "success" } | undefined;
					if (i.type === "form_submit" && i.action_id === "keyword") {
						keyword = typeof i.values?.keyword === "string" ? i.values.keyword.trim().slice(0, 80) : "";
						await ctx.kv.set(kvKey, keyword);
						toast = { message: keyword ? "Focus keyword saved." : "Focus keyword removed.", type: "success" };
					}
					const saved = await ctx.content.get(entry.collection, entry.id);
					if (!saved) return { blocks: [{ type: "context", text: "This page could not be read." }] };
					const draft = i.draft?.fields;
					const source = draft ? "draft" : "saved";
					const all = await allItems(ctx, entry.collection, 300);
					const media = await mediaInfo(ctx, mediaIds(draft?.content ?? saved.data.content).slice(0, 60));
					const a = analyseItem(o, ctx.site.name, saved, all, media, keyword || undefined, draft);
					return { blocks: view(a, keyword, source), ...(toast ? { toast } : {}) };
				},
			},
		},
	});
}

export default createPlugin;
