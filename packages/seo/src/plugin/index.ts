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
import { type Analysis, analyze, type Check, type PageSeo } from "../analyze.js";
import { SEO_PLUGIN, type SeoPanelOptions } from "../index.js";

type Block = Record<string, unknown>;
interface Item {
	id: string;
	slug: string | null;
	status?: string;
	data: Record<string, unknown>;
	seo?: PageSeo;
}
interface Ctx {
	input: unknown;
	ui?: { entry?: { collection: string; id: string } };
	kv: { get<T>(k: string): Promise<T | null>; set(k: string, v: unknown): Promise<void> };
	content?: { get(c: string, id: string): Promise<Item | null>; list(c: string, o?: { limit?: number; cursor?: string }): Promise<{ items: Item[]; cursor?: string; nextCursor?: string }> };
	media?: { get(id: string): Promise<{ alt?: string | null } | null> };
	site: { name: string };
}

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
		capabilities: ["content:read", "media:read", "admin.editor-draft:read"],
		admin: { editorPanels: [{ id: "seo", title: "SEO", route: "panel", collections, order: 10, draft: { read: { fields: ["title", "content"] } } }] },
		routes: {
			panel: {
				permission: "content:read_drafts",
				handler: async (raw) => {
					const ctx = raw as unknown as Ctx;
					const entry = ctx.ui?.entry;
					if (!entry || !ctx.content) return { blocks: [{ type: "context", text: "Save the page once to see its SEO checks." }] };
					const i = (ctx.input ?? {}) as { type?: string; action_id?: string; values?: Record<string, unknown>; draft?: { fields?: Record<string, unknown> } };
					const kvKey = `kw:${entry.collection}:${entry.id}`;
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
					// Other pages of the same collection, for the duplicate check (first 200).
					const others: { title: string; description?: string | null }[] = [];
					let cursor: string | undefined;
					do {
						const page = await ctx.content.list(entry.collection, { limit: 100, ...(cursor ? { cursor } : {}) });
						for (const it of page.items) if (it.id !== entry.id && it.status !== "trash") others.push({ title: (it.seo?.title || String(it.data.title ?? "")).trim(), description: it.seo?.description ?? null });
						cursor = others.length < 200 ? (page.nextCursor ?? page.cursor) : undefined;
					} while (cursor);
					// Alt text from the media library for the images the sections use.
					const content = draft?.content ?? saved.data.content;
					const ids = [...new Set(JSON.stringify(content ?? []).match(/"id":"[0-9A-Z]{26}"/g)?.map((m) => m.slice(6, -1)) ?? [])].slice(0, 60);
					const alts = new Map<string, string>();
					await Promise.all(ids.map(async (id) => {
						const m = await ctx.media?.get(id).catch(() => null);
						if (m?.alt) alts.set(id, m.alt);
					}));
					const a = analyze({
						title: String(draft?.title ?? saved.data.title ?? ""),
						slug: saved.slug,
						seo: saved.seo ?? null,
						content,
						siteName: ctx.site.name,
						separator: o.titleSeparator ?? "-",
						productionUrl: o.productionUrl,
						others,
						...(keyword ? { focusKeyword: keyword } : {}),
						altOf: (id) => alts.get(id),
						...(o.ogCards ? { ogCards: true } : {}),
					});
					return { blocks: view(a, keyword, source), ...(toast ? { toast } : {}) };
				},
			},
		},
	});
}

export default createPlugin;
