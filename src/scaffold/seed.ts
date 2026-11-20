/**
 * seed.json for the generated project: block types (section library), collections, menus,
 * settings and — for local preview — the migrated content from the IR. The load phase (M6)
 * writes the same content to staging through the EmDash CLI/API with uploaded media.
 */
import type { IrMenuItem, IrPage, IrSite, MediaRef } from "../ir/schema.js";
import { BLOCK_TYPES, SECTION_SLUGS } from "../starter/library.js";
import { blockKey, type MediaResolver, sectionToBlock } from "../targets/emdash/blocks.js";
import type { BlogPlan } from "../transform/blog.js";
import { type CptPlan, collectionFields } from "../transform/cpt.js";
import { emdashMenuLabel, emdashMenuNames } from "../transform/menus.js";
import { pageData, pageFields, parentsFirst } from "../transform/pages.js";
import type { WidgetPlan } from "../transform/widgets.js";
import type { IrReusableSection } from "../transform/sections.js";
import type { FormDefinitionOut } from "./forms.js";

export interface MediaInfo {
	id?: number;
	url: string;
	alt?: string;
}

/** Fields of `pages` in EmDash's full-text index (seeded; load marks them on sites set up before the search page). Blocks fields cannot be searchable in EmDash 1.5. */
export const PAGES_SEARCHABLE = ["title"];

/** Page route → EmDash slug: "/" → "home", "/a/b/" → "a/b". */
export const routeToSlug = (path: string) => path.replace(/^\/+|\/+$/g, "") || "home";

/** Seed media: `$media` with a public URL EmDash downloads during setup. */
export function seedMediaResolver(library: Map<number, MediaInfo>, rewriteUrl: (u: string) => string): MediaResolver {
	return (m: MediaRef | undefined) => {
		if (!m) return undefined;
		const info = m.wpId ? library.get(m.wpId) : undefined;
		const url = info?.url ?? m.url;
		if (!url) return undefined;
		const abs = rewriteUrl(url);
		const filename = decodeURIComponent(abs.split("/").pop()?.split("?")[0] ?? "file");
		const alt = m.alt ?? info?.alt;
		return { $media: { url: abs, filename, ...(alt ? { alt } : {}) } };
	};
}

let dropLog: (msg: string) => void = () => {};
const blocksOf = (doc: IrPage, media: MediaResolver) => doc.sections.map((s, i) => sectionToBlock(s, blockKey(doc.source.slug, i, s.type), media, (d) => dropLog(`${doc.source.slug} ${s.type}#${i}: ${d.join(", ")}`)));

/**
 * What the starter's header reads from a menu item besides label and address: classes (`popup-<slug>` opens a popup,
 * `button` draws a header button) and, for a button with a second label, the title attribute as its hover label.
 */
export function menuItemExtras(i: IrMenuItem): { cssClasses?: string; titleAttr?: string } {
	// The kit's own classes first (what the header reads), then the item's own WordPress classes (kept for the editor);
	// `mega`: a mega menu panel, its children shown as columns of links.
	const classes = [...new Set([i.opensPopup ? `popup-${i.opensPopup}` : "", i.button ? "button" : "", i.mega ? "mega" : "", ...(i.classes ?? [])].filter(Boolean))].join(" ");
	const title = i.button && i.hoverLabel ? i.hoverLabel : i.titleAttr;
	return { ...(classes ? { cssClasses: classes } : {}), ...(title ? { titleAttr: title } : {}) };
}

/** The EmDash menus to write: the three header roles (always, empty when the site has none) and every other WordPress menu by its own name. */
export function emdashMenus(site: IrSite): { name: string; label: string; items: IrMenuItem[] }[] {
	const names = emdashMenuNames(site.menus);
	const roles = (["primary", "secondary", "footer"] as const).map((role) => {
		const at = names.indexOf(role);
		return { name: role, label: emdashMenuLabel(role), items: at >= 0 ? (site.menus[at]?.items ?? []) : [] };
	});
	const others = site.menus.flatMap((m, at) => (["primary", "secondary", "footer"].includes(names[at] as string) ? [] : [{ name: names[at] as string, label: emdashMenuLabel(names[at] as string, m), items: m.items }]));
	return [...roles, ...others];
}

/**
 * A canonical URL the old site printed, on the production address: when the new site goes live on another domain
 * (the old domain then redirects), a canonical on a source host moves to the production host, same path. Canonicals
 * pointing elsewhere (another site) stay as they are.
 */
export function productionCanonical(canonical: string, sourceHosts: Set<string>, productionUrl: string): string {
	try {
		const u = new URL(canonical);
		const prod = new URL(productionUrl);
		if (!sourceHosts.has(u.host.replace(/^www\./, "")) && u.host.replace(/^www\./, "") !== prod.host.replace(/^www\./, "")) return canonical;
		return `${prod.origin}${u.pathname}${u.search}`;
	} catch {
		return canonical;
	}
}

function menuItems(items: IrMenuItem[]): unknown[] {
	return items.map((i) => ({
		type: "custom",
		label: i.label,
		url: i.opensPopup ? `#${i.opensPopup}` : i.href,
		...(i.newTab ? { target: "_blank" } : {}),
		...menuItemExtras(i),
		...(i.children.length ? { children: menuItems(i.children) } : {}),
	}));
}

export interface SeedInput {
	name: string;
	site: IrSite;
	pages: IrPage[];
	partials: IrPage[];
	popups: IrPage[];
	media: MediaResolver;
	titleSeparator: string;
	forms: FormDefinitionOut[];
	includeContent: boolean;
	/** Fields a block type does not define (reported, not silently lost). */
	onDrop?: (msg: string) => void;
	/** Blog sites only (ir/blog.json): the posts collection, taxonomies, bylines and the posts. */
	blog?: { plan: BlogPlan; posts: IrPage[] };
	/** Custom post types (ir/collections.json): their collections, taxonomies, bylines and entries. */
	collections?: { plan: CptPlan; entries: IrPage[] };
	/** WordPress comments (ir/comments.json): collections whose comment form is on get commentsEnabled and the "Comments closed" field. */
	comments?: { form: string[] };
	/** Classic-theme widget areas (ir/widgets.json). */
	widgets?: WidgetPlan;
	/** WordPress reusable blocks as EmDash sections (ir/sections.json). */
	sections?: IrReusableSection[];
}

/** Seed widget areas (EmDash seed `widgetAreas`: content widgets carry Portable Text, images at their WordPress file for the local preview). */
export function seedWidgetAreas(plan: WidgetPlan, media: MediaResolver): unknown[] {
	return plan.areas
		.filter((a) => a.widgets.length)
		.map((a) => ({
			name: a.name,
			label: a.label,
			...(a.description ? { description: a.description } : {}),
			widgets: a.widgets.map((w) => ({ type: w.type, ...(w.title ? { title: w.title } : {}), ...(w.type === "content" ? { content: seedPostBody(w.content ?? [], media) } : {}), ...(w.menuName ? { menuName: w.menuName } : {}), ...(w.componentId ? { componentId: w.componentId, props: w.props ?? {} } : {}) })),
		}));
}

/** Per-entry "closed to new comments" (WordPress comment_status "closed"): the starter hides the form, the middleware refuses new comments. */
export const COMMENTS_CLOSED_FIELD = { slug: "comments_closed", label: "Comments closed (no new comments; existing ones still show)", type: "boolean" } as const;

/**
 * The `posts` collection (EmDash field types verified in docs/spikes/blog-findings.md). `body` is Portable Text for
 * Gutenberg/classic posts; `content` keeps the sections of builder posts (WPBakery, Bricks) and is empty otherwise.
 */
export const POSTS_COLLECTION = {
	slug: "posts",
	label: "Posts",
	labelSingular: "Post",
	description: "Blog posts: shown on the posts page, in category, tag and author archives and in the RSS feed",
	urlPattern: "/{slug}",
	supports: ["drafts", "revisions", "preview", "seo", "search"],
	dateField: "publishedAt",
	fields: [
		{ slug: "title", label: "Title", type: "string", required: true, searchable: true },
		{ slug: "excerpt", label: "Excerpt", type: "text", searchable: true },
		{ slug: "featured_image", label: "Featured image", type: "image" },
		{ slug: "body", label: "Content", type: "portableText", searchable: true },
		{ slug: "content", label: "Sections (posts built with a page builder)", type: "blocks", validation: { allowedTypes: SECTION_SLUGS, maxItems: 80 } },
		{ slug: "featured", label: "Featured (shown first on the posts page)", type: "boolean" },
		{ slug: "format", label: "Post format (from WordPress)", type: "string" },
	],
} as const;

/** Seed form of a post body: media point at the WordPress file (local preview); load stores EmDash media instead. */
export function seedPostBody(body: unknown[], media: MediaResolver): unknown[] {
	const fix = (v: unknown): unknown => {
		if (Array.isArray(v)) return v.map(fix);
		if (!v || typeof v !== "object") return v;
		const { _media, ...o } = v as Record<string, unknown> & { _media?: MediaRef & { field?: string } };
		const out = Object.fromEntries(Object.entries(o).map(([k, x]) => [k, fix(x)]));
		if (_media) {
			const url = (media(_media) as { $media?: { url?: string } } | undefined)?.$media?.url;
			if (url && o.asset && typeof o.asset === "object") out.asset = { ...(o.asset as object), url };
			else if (url && _media.field) out[_media.field] = url;
		}
		return out;
	};
	return body.map(fix);
}

/** Seed entry id of a byline / post. */
const bylineId = (slug: string) => `byline:${slug}`;

export function buildSeed(i: SeedInput): Record<string, unknown> {
	dropLog = i.onDrop ?? (() => {});
	const content = { slug: "content", label: "Sections", type: "blocks", validation: { allowedTypes: SECTION_SLUGS, maxItems: 80 } };
	const menus = emdashMenus(i.site).map((m) => ({ ...m, items: menuItems(m.items) }));
	// Page attributes the site uses (order, parent, excerpt, featured image): extra pages fields, none otherwise.
	const extraPageFields = pageFields(i.pages);
	const seed: Record<string, unknown> = {
		$schema: "https://emdashcms.com/seed.schema.json",
		version: "1",
		meta: { name: i.name, description: "Generated by wp2emdash from the WordPress site", author: "wp2emdash" },
		settings: { title: i.site.title, ...(i.site.tagline ? { tagline: i.site.tagline } : {}), staging: true, seo: { titleSeparator: i.titleSeparator } },
		blockTypes: BLOCK_TYPES,
		collections: [
			// Title searchable: EmDash's full-text index (EmDash 1.5 refuses searchable blocks fields; the search page reads the sections itself).
			{ slug: "pages", label: "Pages", labelSingular: "Page", urlPattern: "/{slug}", supports: ["drafts", "revisions", "preview", "seo", "search"], sortOrder: 1, fields: [{ slug: "title", label: "Title", type: "string", required: true, searchable: true }, content, ...extraPageFields.map((f) => ({ ...f }))] },
			{ slug: "site_parts", label: "Header & footer", labelSingular: "Site part", description: "Shown on every page: the announcement bar above the header (entry “announcement”) and the footer", routable: false, supports: ["drafts", "revisions"], sortOrder: 2, fields: [{ slug: "title", label: "Title", type: "string", required: true }, content] },
			{
				slug: "popups",
				label: "Popups",
				labelSingular: "Popup",
				description: "Dialogs opened by buttons whose “Opens popup” field names them",
				routable: false,
				supports: ["drafts", "revisions"],
				sortOrder: 3,
				fields: [
					{ slug: "title", label: "Title", type: "string", required: true },
					content,
					{ slug: "selectors", label: "Also open from CSS selectors", type: "string" },
					{ slug: "auto_open_delay", label: "Open automatically after (ms)", type: "integer" },
				],
			},
		],
		menus,
	};
	// Classic-theme widget areas (ir/widgets.json): only sites that had widgets get the seed key.
	if (i.widgets?.areas.some((a) => a.widgets.length)) seed.widgetAreas = seedWidgetAreas(i.widgets, i.media);
	// Blog sites only: a brochure site's seed (and admin) stays exactly as before.
	if (i.blog) {
		const cols = seed.collections as { slug: string; sortOrder?: number }[];
		for (const c of cols) if ((c.sortOrder ?? 0) >= 2) c.sortOrder = (c.sortOrder ?? 0) + 1;
		cols.splice(1, 0, { ...POSTS_COLLECTION, sortOrder: 2 } as never);
		seed.taxonomies = i.blog.plan.taxonomies.map((t) => ({ name: t.name, label: t.label, labelSingular: t.labelSingular, hierarchical: t.hierarchical, collections: ["posts"], terms: t.terms.map((x) => ({ slug: x.slug, label: x.label, ...(x.description ? { description: x.description } : {}), ...(x.parent ? { parent: x.parent } : {}) })) }));
		if (i.blog.plan.bylines.length) seed.bylines = i.blog.plan.bylines.map((b) => ({ id: bylineId(b.slug), slug: b.slug, displayName: b.displayName, ...(b.bio ? { bio: b.bio } : {}), isGuest: true }));
	}
	// Custom post types: their collections after pages (and posts), before the site parts; their taxonomies and bylines.
	if (i.collections?.plan.collections.length) {
		const cols = seed.collections as Record<string, unknown>[];
		const at = cols.findIndex((c) => c.slug === "site_parts");
		cols.splice(at, 0, ...cptSeedCollections(i.collections.plan));
		for (const [n, c] of cols.entries()) c.sortOrder = n + 1;
		const taxes = (seed.taxonomies ?? []) as { name: string; collections: string[] }[];
		for (const c of i.collections.plan.collections) for (const t of c.taxonomies.filter((x) => x.shared)) taxes.find((x) => x.name === t.name)?.collections.push(c.slug);
		taxes.push(...i.collections.plan.taxonomies.map((t) => ({ name: t.name, label: t.label, labelSingular: t.labelSingular, hierarchical: t.hierarchical, collections: t.collections, terms: t.terms.map((x) => ({ slug: x.slug, label: x.label, ...(x.description ? { description: x.description } : {}), ...(x.parent ? { parent: x.parent } : {}) })) })));
		if (taxes.length) seed.taxonomies = taxes;
		const bylines = (seed.bylines ?? []) as unknown[];
		bylines.push(...i.collections.plan.bylines.map((b) => ({ id: bylineId(b.slug), slug: b.slug, displayName: b.displayName, ...(b.bio ? { bio: b.bio } : {}), isGuest: true })));
		if (bylines.length) seed.bylines = bylines;
	}
	// Comments: EmDash's seed sets commentsEnabled only (moderation and closing are load's collection update).
	for (const c of seed.collections as { slug: string; commentsEnabled?: boolean; fields: unknown[] }[]) {
		if (!i.comments?.form.includes(c.slug)) continue;
		c.commentsEnabled = true;
		c.fields = [...c.fields, { ...COMMENTS_CLOSED_FIELD }]; // a copy: POSTS_COLLECTION's fields are shared
	}
	// Reusable blocks → EmDash sections (seed `sections`, source "import"; images at their WordPress file for the local preview).
	if (i.includeContent && i.sections?.length) seed.sections = i.sections.map((s) => ({ slug: s.slug, title: s.title, description: `From the WordPress reusable block "${s.title}" (#${s.wpId})`, content: seedPostBody(s.content, i.media), source: "import" }));
	if (i.includeContent) {
		seed.content = {
			// Password-protected pages stay drafts in the seed (local preview has no password page data).
			// Parents first: a seed `$ref` resolves only to an entry earlier in the file (pages without a parent keep their order).
			pages: (extraPageFields.length ? parentsFirst(i.pages) : i.pages).map((p) => {
				const parent = p.page?.parent ? i.pages.find((x) => `page:${x.source.wpId}` === p.page?.parent) : undefined;
				return { id: routeToSlug(p.route?.path ?? p.source.slug), slug: routeToSlug(p.route?.path ?? p.source.slug), status: p.source.status === "publish" && !p.access ? "published" : "draft", data: { title: p.title, content: blocksOf(p, i.media), ...pageData(p, extraPageFields, i.media), ...(parent && extraPageFields.some((f) => f.slug === "parent") ? { parent: `$ref:${routeToSlug(parent.route?.path ?? parent.source.slug)}` } : {}) } };
			}),
			site_parts: i.partials.map((p) => ({ id: p.source.slug, slug: p.source.slug, status: "published", data: { title: p.title, content: blocksOf(p, i.media) } })),
			popups: i.popups.map((p) => ({ id: p.source.slug, slug: p.source.slug, status: "published", data: { title: p.title, content: blocksOf(p, i.media), selectors: p.popup?.selectors.filter((s) => !s.includes("popmake")).join(", ") || undefined, auto_open_delay: p.popup?.autoOpen?.delayMs } })),
			...(i.blog
				? {
						posts: i.blog.posts.map((p) => {
							const slug = routeToSlug(p.route?.path ?? p.source.slug);
							const featured = i.media(p.featuredImage);
							return {
								id: `post:${p.source.wpId}`,
								slug,
								status: p.source.status === "publish" && p.post?.visibility === "public" ? "published" : "draft",
								data: { title: p.title, ...(p.post?.excerpt ? { excerpt: p.post.excerpt } : {}), ...(featured ? { featured_image: featured } : {}), body: seedPostBody(p.post?.body ?? [], i.media), content: blocksOf(p, i.media), ...(p.post?.sticky ? { featured: true } : {}), ...(p.post?.format ? { format: p.post.format } : {}) },
								...(Object.keys(p.post?.terms ?? {}).length ? { taxonomies: p.post?.terms } : {}),
								...(p.post?.bylines.length ? { bylines: p.post.bylines.map((b) => ({ byline: bylineId(b) })) } : {}),
							};
						}),
					}
				: {}),
			...(i.collections ? cptSeedContent(i.collections, i.media, new Map(i.pages.map((p) => [`page:${p.source.wpId}`, routeToSlug(p.route?.path ?? p.source.slug)])), (p) => blocksOf(p, i.media)) : {}),
		};
	}
	return seed;
}

/** Seed collections of the custom post types, in an order where a reference's target comes before it. */
export function cptSeedCollections(plan: CptPlan): Record<string, unknown>[] {
	return orderByReferences(plan).map((c) => ({
		slug: c.slug,
		label: c.label,
		labelSingular: c.labelSingular,
		description: c.description,
		...(c.routable ? { urlPattern: "/{slug}" } : { routable: false }),
		supports: ["drafts", "revisions", "preview", ...(c.routable ? ["seo", "search"] : [])],
		...(c.core.menuOrder ? {} : { dateField: "publishedAt" }),
		fields: collectionFields(c, SECTION_SLUGS),
	}));
}

function orderByReferences(plan: CptPlan): CptPlan["collections"] {
	const out: CptPlan["collections"] = [];
	const visit = (c: CptPlan["collections"][number], seen: Set<string>) => {
		if (out.includes(c) || seen.has(c.slug)) return;
		seen.add(c.slug);
		for (const f of c.fields) {
			const t = plan.collections.find((x) => x.slug === f.targetCollection && x.slug !== c.slug);
			if (t) visit(t, seen);
		}
		out.push(c);
	};
	for (const c of plan.collections) visit(c, new Set());
	return out;
}

/**
 * Seed content of the custom post types (local preview): fields with `$media` files from the WordPress site, rich text
 * with file URLs, references as `$ref:<type>:<wpId>` (EmDash resolves them in file order: a reference to an entry later in
 * the same collection stays unset in the preview; load writes every reference).
 */
export function cptSeedContent(input: { plan: CptPlan; entries: IrPage[] }, media: MediaResolver, pageIds: Map<string, string>, blocks: (p: IrPage) => unknown[]): Record<string, unknown[]> {
	const ref = (k: string) => `$ref:${pageIds.get(k) ?? k}`;
	const isRef = (v: unknown): v is MediaRef => !!v && typeof v === "object" && !Array.isArray(v) && ("wpId" in v || "url" in v) && ["image", "file", "video"].includes((v as { kind?: string }).kind ?? "");
	const deep = (v: unknown): unknown => (isRef(v) ? (media(v) ?? null) : Array.isArray(v) ? v.map(deep) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)])) : v);
	const out: Record<string, unknown[]> = {};
	for (const c of orderByReferences(input.plan)) {
		out[c.slug] = input.entries
			.filter((p) => p.entry?.collection === c.slug)
			.map((p) => {
				const e = p.entry as NonNullable<IrPage["entry"]>;
				const data: Record<string, unknown> = { title: p.title };
				if (c.core.excerpt && e.excerpt) data.excerpt = e.excerpt;
				const featured = c.core.featuredImage ? media(p.featuredImage) : undefined;
				if (featured) data.featured_image = featured;
				if (c.core.body) data.body = seedPostBody(e.body, media);
				if (c.core.sections) data.content = blocks(p);
				if (c.core.menuOrder && e.menuOrder !== undefined) data.menu_order = e.menuOrder;
				for (const f of c.fields) {
					const v = e.fields[f.slug];
					if (f.type === "reference") {
						const keys = e.references[f.slug] ?? [];
						if (keys.length) data[f.slug] = f.multiple ? keys.map(ref) : ref(keys[0] as string);
					} else if (v !== undefined) data[f.slug] = f.type === "portableText" ? seedPostBody(v as unknown[], media) : deep(v);
				}
				if (e.references.parent?.[0]) data.parent = ref(e.references.parent[0]);
				return {
					id: `${p.source.type}:${p.source.wpId}`,
					slug: routeToSlug(p.route?.path ?? p.source.slug),
					status: p.source.status === "publish" ? "published" : "draft",
					data,
					...(Object.keys(e.terms).length ? { taxonomies: e.terms } : {}),
					...(e.bylines.length ? { bylines: e.bylines.map((b) => ({ byline: bylineId(b) })) } : {}),
				};
			});
	}
	return out;
}
