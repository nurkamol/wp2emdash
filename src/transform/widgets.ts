/**
 * Classic-theme widget areas (sidebars) → EmDash widget areas (`_emdash_widget_areas`, `_emdash_widgets`, migration
 * 007; types content | menu | component, core components `core:recent-posts|categories|tags|search|archives` —
 * docs/spikes/site-features-findings.md). Input: WordPress's REST API `wp/v2/sidebars` + `wp/v2/widgets` (extract:
 * raw/widgets/*.json, WP ≥ 5.8, authenticated), or the `sidebars_widgets` / `widget_<type>` options of a database dump.
 *
 * Text, Custom HTML and block widgets become content widgets (Portable Text through the same converter as post bodies,
 * images marked for load), Navigation Menu → menu widgets (the EmDash menu its WordPress menu became), Search /
 * Recent Posts / Categories / Archives / Tag Cloud → EmDash's core components (the blog ones only on a site with a
 * blog). Everything else is listed and needs the owner's decision (overrides.ts widgets: html | skip; gate
 * `widgets-handled`). Where an area renders comes from the old theme: an area is placed only when one of its widgets
 * was on an audited page (`id="<widget id>"`), in the footer or as the blog sidebar by its id and name.
 */
import type { Diagnostic } from "../ir/schema.js";
import { convertPostBody, type PtNode } from "./blog.js";

export interface WpSidebar {
	id: string;
	name?: string;
	description?: string;
	status?: string;
	widgets?: (string | number)[];
}

export interface WpWidget {
	id: string;
	id_base: string;
	sidebar?: string;
	instance?: { raw?: Record<string, unknown> } | null;
	rendered?: string;
}

export type Placement = "footer" | "sidebar" | "header" | "other";

export interface IrWidget {
	/** The WordPress widget id (`text-3`, `block-7`). */
	wpId: string;
	idBase: string;
	type: "content" | "menu" | "component";
	title?: string;
	/** Portable Text (content widgets); images carry `_media` for load, like post bodies. */
	content?: PtNode[];
	menuName?: string;
	componentId?: string;
	props?: Record<string, unknown>;
	/** Carried by the owner's decision (`html`): the widget's rendered HTML kept as one HTML block. */
	decided?: "html";
}

export interface IrWidgetArea {
	/** EmDash widget area name (from the WordPress sidebar id). */
	name: string;
	label: string;
	description?: string;
	wpId: string;
	placement: Placement;
	/** One of its widgets was on an audited page: the starter renders the area at its placement. */
	shown: boolean;
	widgets: IrWidget[];
}

export interface WidgetPlan {
	areas: IrWidgetArea[];
	/** Widgets with no mapping and no decision (gate `widgets-handled`). */
	unknown: { wpId: string; idBase: string; area: string; title?: string }[];
	/** Not carried, with the reason (inactive widgets, skipped by decision, blog widgets on a site without posts). */
	notCarried: { wpId: string; area: string; why: string }[];
	diagnostics: (Diagnostic & { widget: string })[];
}

export interface WidgetInput {
	sidebars: WpSidebar[];
	widgets: WpWidget[];
	/** WordPress menu term id → EmDash menu name (src/transform/menus.ts emdashMenuNames). */
	menuName: (wpMenuId: number) => string | undefined;
	/** The site has a blog (posts collection): post widgets are carried. */
	blog: boolean;
	/** Raw HTML of the audited pages (where each widget was shown). */
	pages: string[];
	mediaIdForUrl: (url: string) => number | undefined;
	decisions: Record<string, "html" | "skip">;
	/** Blog widget link pattern: posts live at their WordPress address (`/{slug}`). */
	postUrlTemplate?: string;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Where a sidebar sits, by its id and name. */
export function placementOf(s: Pick<WpSidebar, "id" | "name">): Placement {
	const t = `${s.id} ${s.name ?? ""}`;
	if (/footer/i.test(t)) return "footer";
	if (/header|top[-_ ]?bar/i.test(t)) return "header";
	if (/off[-_ ]?canvas|slide[-_ ]?out|mobile|popup|modal/i.test(t)) return "other";
	return "sidebar";
}

/** EmDash widget area name for a WordPress sidebar id. */
export const areaName = (id: string) => id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "sidebar";

/** A dynamic block alone in a block widget → the EmDash core component it matches. */
function blockComponent(markup: string): { block: string; attrs: Record<string, unknown> } | undefined {
	const blocks = [...markup.matchAll(/<!--\s+wp:([a-z0-9/-]+)(\s+(\{[\s\S]*?\}))?\s+\/?-->/g)].map((m) => ({ name: m[1] as string, attrs: (() => { try { return m[3] ? (JSON.parse(m[3]) as Record<string, unknown>) : {}; } catch { return {}; } })() }));
	const top = blocks.filter((b) => !b.name.startsWith("/"));
	if (top.length !== 1) return undefined;
	const name = (top[0] as { name: string }).name.replace(/^core\//, "");
	return { block: name, attrs: (top[0] as { attrs: Record<string, unknown> }).attrs };
}

const BLOG_COMPONENTS: Record<string, string> = { "recent-posts": "core:recent-posts", "latest-posts": "core:recent-posts", categories: "core:categories", archives: "core:archives", tag_cloud: "core:tags", "tag-cloud": "core:tags" };

export function planWidgets(input: WidgetInput): WidgetPlan {
	const byId = new Map(input.widgets.map((w) => [w.id, w]));
	const areas: IrWidgetArea[] = [];
	const unknown: WidgetPlan["unknown"] = [];
	const notCarried: WidgetPlan["notCarried"] = [];
	const diagnostics: WidgetPlan["diagnostics"] = [];
	const shownIds = (id: string) => input.pages.some((h) => h.includes(`id="${id}"`) || h.includes(`id='${id}'`));
	const usedNames = new Set<string>();
	for (const s of input.sidebars) {
		const ids = (s.widgets ?? input.widgets.filter((w) => w.sidebar === s.id).map((w) => w.id)).map(String);
		if (s.id === "wp_inactive_widgets" || s.status === "inactive" && !ids.length) {
			for (const id of ids) notCarried.push({ wpId: id, area: s.id, why: s.id === "wp_inactive_widgets" ? "inactive (Appearance → Widgets → Inactive widgets)" : "the area is not in the active theme" });
			continue;
		}
		let name = areaName(s.id);
		for (let n = 2; usedNames.has(name); n++) name = `${areaName(s.id)}-${n}`;
		usedNames.add(name);
		const out: IrWidget[] = [];
		const blogOnly = (id: string, why: string) => notCarried.push({ wpId: id, area: s.id, why });
		for (const id of ids) {
			const w = byId.get(id) ?? { id, id_base: id.replace(/-\d+$/, "") };
			const raw = (w.instance?.raw ?? {}) as Record<string, unknown>;
			const title = str(raw.title) || undefined;
			const decision = input.decisions[id];
			if (decision === "skip") {
				notCarried.push({ wpId: id, area: s.id, why: "skipped by decision (overrides.ts widgets)" });
				continue;
			}
			const convert = (html: string, kind: "classic" | "gutenberg") => {
				const r = convertPostBody(html, kind, { keyPrefix: `w${id.replace(/[^a-z0-9]/gi, "")}_`, mediaIdForUrl: input.mediaIdForUrl });
				for (const d of r.diagnostics) diagnostics.push({ ...d, widget: id });
				return r.body;
			};
			const base = { wpId: id, idBase: w.id_base, ...(title ? { title } : {}) };
			let mapped: IrWidget | undefined;
			switch (w.id_base) {
				case "text":
					if (str(raw.text)) mapped = { ...base, type: "content", content: convert(String(raw.text), "classic") };
					else if (raw.text !== undefined) mapped = { ...base, type: "content", content: [] };
					break;
				case "custom_html":
					if (raw.content !== undefined) mapped = { ...base, type: "content", content: convert(String(raw.content ?? ""), "classic") };
					break;
				case "media_image": {
					const url = str(raw.url);
					const att = Number(raw.attachment_id) || undefined;
					if (url || att) {
						const esc = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
						const img = `<img src="${esc(url)}" alt="${esc(str(raw.alt))}"${att ? ` class="wp-image-${att}"` : ""} />`;
						const caption = str(raw.caption) ? `<figcaption class="wp-element-caption">${str(raw.caption)}</figcaption>` : "";
						mapped = { ...base, type: "content", content: convert(`<!-- wp:image ${att ? JSON.stringify({ id: att }) : "{}"} --><figure class="wp-block-image">${img}${caption}</figure><!-- /wp:image -->`, "gutenberg") };
						if (str(raw.link_url) && raw.link_type !== "none") diagnostics.push({ level: "warn", code: "lossy", message: `image link not carried (EmDash image blocks have no link): ${str(raw.link_url)}`, path: "media_image", widget: id });
					}
					break;
				}
				case "nav_menu": {
					const menu = input.menuName(Number(raw.nav_menu));
					if (menu) mapped = { ...base, type: "menu", menuName: menu };
					break;
				}
				case "search":
					mapped = { ...base, type: "component", componentId: "core:search", props: { placeholder: "Search…" } };
					break;
				case "recent-posts":
					if (!input.blog) {
						blogOnly(id, "recent posts: the new site has no posts");
						continue;
					}
					mapped = { ...base, type: "component", componentId: "core:recent-posts", props: { count: Number(raw.number) || 5, showDate: raw.show_date === true || raw.show_date === 1 || raw.show_date === "1", ...(input.postUrlTemplate ? { urlTemplate: input.postUrlTemplate } : {}) } };
					break;
				case "categories":
				case "archives":
				case "tag_cloud":
					if (!input.blog) {
						blogOnly(id, `${w.id_base.replace("_", " ")}: the new site has no posts`);
						continue;
					}
					if (w.id_base === "tag_cloud" && str(raw.taxonomy) && raw.taxonomy !== "post_tag") break;
					mapped = { ...base, type: "component", componentId: BLOG_COMPONENTS[w.id_base] as string, props: w.id_base === "categories" ? { showCount: !!raw.count, hierarchical: !!raw.hierarchical } : w.id_base === "archives" ? { type: "monthly", limit: 12 } : { showCount: !!raw.count } };
					break;
				case "block": {
					const markup = String(raw.content ?? "");
					const c = blockComponent(markup);
					if (c?.block === "search") mapped = { ...base, type: "component", componentId: "core:search", props: { placeholder: str(c.attrs.placeholder) || "Search…" }, ...(str(c.attrs.label) ? { title: str(c.attrs.label) } : {}) };
					else if (c && BLOG_COMPONENTS[c.block]) {
						if (!input.blog) {
							blogOnly(id, `${c.block} block: the new site has no posts`);
							continue;
						}
						const componentId = BLOG_COMPONENTS[c.block] as string;
						mapped = { ...base, type: "component", componentId, props: componentId === "core:recent-posts" ? { count: Number(c.attrs.postsToShow) || 5, showDate: c.attrs.displayPostDate === true, ...(input.postUrlTemplate ? { urlTemplate: input.postUrlTemplate } : {}) } : componentId === "core:categories" ? { showCount: c.attrs.showPostCounts === true, hierarchical: c.attrs.showHierarchy === true } : componentId === "core:archives" ? { type: "monthly", limit: 12 } : {} };
					} else if (c && /^(?:latest-comments|navigation|page-list|legacy-widget|calendar|rss|social-links|loginout)$/.test(c.block)) mapped = undefined;
					else if (markup.trim()) mapped = { ...base, type: "content", content: convert(markup, "gutenberg") };
					else mapped = { ...base, type: "content", content: [] };
					break;
				}
			}
			if (!mapped && decision === "html" && w.rendered?.trim()) mapped = { ...base, type: "content", content: [{ _type: "htmlBlock", _key: `w${id.replace(/[^a-z0-9]/gi, "")}_h`, html: w.rendered.trim() }], decided: "html" };
			if (mapped) out.push(mapped);
			else unknown.push({ wpId: id, idBase: w.id_base, area: s.id, ...(title ? { title } : {}) });
		}
		areas.push({ name, label: s.name?.trim() || s.id, ...(s.description?.trim() ? { description: s.description.trim() } : {}), wpId: s.id, placement: placementOf(s), shown: ids.some(shownIds), widgets: out });
	}
	return { areas, unknown, notCarried, diagnostics };
}

/**
 * The same model from a database dump's options: `sidebars_widgets` ({ "sidebar-1": ["text-2"], wp_inactive_widgets: [] })
 * and one `widget_<id_base>` option per widget type ({ 2: { title, text }, _multiwidget: 1 }).
 */
export function widgetsFromOptions(options: Record<string, unknown>): { sidebars: WpSidebar[]; widgets: WpWidget[] } | undefined {
	const sw = options.sidebars_widgets;
	if (!sw || typeof sw !== "object") return undefined;
	const sidebars: WpSidebar[] = [];
	const widgets: WpWidget[] = [];
	for (const [id, list] of Object.entries(sw as Record<string, unknown>)) {
		if (id === "array_version" || !Array.isArray(list)) continue;
		sidebars.push({ id, widgets: list.map(String) });
		for (const wid of list.map(String)) {
			const m = /^(.+)-(\d+)$/.exec(wid);
			if (!m) continue;
			const all = options[`widget_${m[1]}`] as Record<string, unknown> | undefined;
			const raw = all && typeof all === "object" ? (all[m[2] as string] as Record<string, unknown> | undefined) : undefined;
			widgets.push({ id: wid, id_base: m[1] as string, sidebar: id, ...(raw ? { instance: { raw } } : {}) });
		}
	}
	return sidebars.length ? { sidebars, widgets } : undefined;
}

/** site.config.json `widgetAreas`: the areas the starter renders, by placement (only areas the old theme showed). */
export function starterWidgetAreas(plan: WidgetPlan): { footer?: string[]; sidebar?: string[] } | undefined {
	const shown = plan.areas.filter((a) => a.shown && a.widgets.length);
	const footer = shown.filter((a) => a.placement === "footer").map((a) => a.name);
	const sidebar = shown.filter((a) => a.placement === "sidebar").map((a) => a.name);
	if (!footer.length && !sidebar.length) return undefined;
	return { ...(footer.length ? { footer } : {}), ...(sidebar.length ? { sidebar } : {}) };
}

/** Coverage report section. */
export function widgetsReport(plan: WidgetPlan | undefined): string[] {
	if (!plan || (!plan.areas.length && !plan.notCarried.length)) return [];
	const L = ["", "## Widgets", "", "Classic-theme widget areas become EmDash widget areas (Widgets in the admin). The starter shows an area where the old theme showed one of its widgets: footer areas as footer columns, a sidebar next to blog posts and listings. Unknown widgets need a decision in `overrides.ts → widgets` (`html` keeps the rendered HTML, `skip` leaves it out).", "", "| Area | EmDash area | Placement | Shown on the old site | Widgets |", "|---|---|---|---|---|"];
	for (const a of plan.areas) L.push(`| ${a.label} (\`${a.wpId}\`) | \`${a.name}\` | ${a.placement} | ${a.shown ? "yes" : "no (kept in the admin, not rendered)"} | ${a.widgets.map((w) => `${w.wpId} → ${w.type}${w.componentId ? ` ${w.componentId}` : w.menuName ? ` \`${w.menuName}\`` : ""}${w.decided ? " (decision: html)" : ""}`).join(", ") || "—"} |`);
	if (plan.unknown.length) L.push("", `**Needs a decision (${plan.unknown.length}):** ${plan.unknown.map((u) => `\`${u.wpId}\` (${u.idBase}${u.title ? `, “${u.title}”` : ""}, in ${u.area})`).join(", ")}.`);
	if (plan.notCarried.length) L.push("", `**Not carried:** ${plan.notCarried.map((n) => `\`${n.wpId}\` (${n.area}): ${n.why}`).join("; ")}.`);
	const warn = plan.diagnostics.filter((d) => d.level !== "info");
	if (warn.length) L.push("", `**Notes:** ${warn.map((d) => `${d.widget}: ${d.message}`).join("; ")}.`);
	return L;
}
