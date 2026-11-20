/**
 * seed.json for the generated project: block types (section library), collections, menus,
 * settings and — for local preview — the migrated content from the IR. The load phase (M6)
 * writes the same content to staging through the EmDash CLI/API with uploaded media.
 */
import type { IrMenuItem, IrPage, IrSite, MediaRef } from "../ir/schema.js";
import { BLOCK_TYPES, SECTION_SLUGS } from "../starter/library.js";
import { blockKey, type MediaResolver, sectionToBlock } from "../targets/emdash/blocks.js";
import type { BlogPlan } from "../transform/blog.js";
import type { FormDefinitionOut } from "./forms.js";

export interface MediaInfo {
	id?: number;
	url: string;
	alt?: string;
}

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
	const classes = [i.opensPopup ? `popup-${i.opensPopup}` : "", i.button ? "button" : ""].filter(Boolean).join(" ");
	return { ...(classes ? { cssClasses: classes } : {}), ...(i.button && i.hoverLabel ? { titleAttr: i.hoverLabel } : {}) };
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
}

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
	const menus = (["primary", "secondary", "footer"] as const).map((role) => {
		const m = i.site.menus.find((x) => x.role === role);
		return { name: role, label: `${role[0]?.toUpperCase()}${role.slice(1)} navigation`, items: m ? menuItems(m.items) : [] };
	});
	const seed: Record<string, unknown> = {
		$schema: "https://emdashcms.com/seed.schema.json",
		version: "1",
		meta: { name: i.name, description: "Generated by wp2emdash from the WordPress site", author: "wp2emdash" },
		settings: { title: i.site.title, ...(i.site.tagline ? { tagline: i.site.tagline } : {}), staging: true, seo: { titleSeparator: i.titleSeparator } },
		blockTypes: BLOCK_TYPES,
		collections: [
			{ slug: "pages", label: "Pages", labelSingular: "Page", urlPattern: "/{slug}", supports: ["drafts", "revisions", "preview", "seo", "search"], sortOrder: 1, fields: [{ slug: "title", label: "Title", type: "string", required: true }, content] },
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
	// Blog sites only: a brochure site's seed (and admin) stays exactly as before.
	if (i.blog) {
		const cols = seed.collections as { slug: string; sortOrder?: number }[];
		for (const c of cols) if ((c.sortOrder ?? 0) >= 2) c.sortOrder = (c.sortOrder ?? 0) + 1;
		cols.splice(1, 0, { ...POSTS_COLLECTION, sortOrder: 2 } as never);
		seed.taxonomies = i.blog.plan.taxonomies.map((t) => ({ name: t.name, label: t.label, labelSingular: t.labelSingular, hierarchical: t.hierarchical, collections: ["posts"], terms: t.terms.map((x) => ({ slug: x.slug, label: x.label, ...(x.description ? { description: x.description } : {}), ...(x.parent ? { parent: x.parent } : {}) })) }));
		if (i.blog.plan.bylines.length) seed.bylines = i.blog.plan.bylines.map((b) => ({ id: bylineId(b.slug), slug: b.slug, displayName: b.displayName, ...(b.bio ? { bio: b.bio } : {}), isGuest: true }));
	}
	if (i.includeContent) {
		seed.content = {
			pages: i.pages.map((p) => ({ id: routeToSlug(p.route?.path ?? p.source.slug), slug: routeToSlug(p.route?.path ?? p.source.slug), status: p.source.status === "publish" ? "published" : "draft", data: { title: p.title, content: blocksOf(p, i.media) } })),
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
		};
	}
	return seed;
}
