/**
 * WordPress page attributes the site actually uses: manual order (`menu_order`), parent page, hand-written excerpt and
 * featured image. Each becomes a field on EmDash's `pages` collection only when some page has a value (a brochure site
 * that never set them keeps the two-field pages collection it always had). Field types verified against EmDash 1.5.0
 * (docs/spikes/p2-batch-findings.md): `integer`, `text`, `image`, and a self-referencing `reference` (relation edges,
 * written by load in a second pass like the custom post types' parents).
 */
import type { IrPage } from "../ir/schema.js";

export interface WpPageAttrs {
	id: number;
	parent: number | null;
	menu_order: number;
	excerpt?: string;
}

/** The page's own attributes as IR: order when set, parent as `page:<wpId>` when that page is migrated, excerpt text. */
export function pageAttributes(p: WpPageAttrs, migrated: (id: number) => boolean): IrPage["page"] | undefined {
	// Block tags become spaces, inline tags (strong, em, a) disappear without splitting the words around them.
	const excerpt = (p.excerpt ?? "").replace(/<\/?(?:p|br|div|li|ul|ol|h[1-6]|blockquote)\b[^>]*>/gi, " ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
	const order = Number(p.menu_order) || 0;
	const out = { ...(order ? { menuOrder: order } : {}), ...(p.parent && migrated(p.parent) ? { parent: `page:${p.parent}` } : {}), ...(excerpt ? { excerpt } : {}) };
	return Object.keys(out).length ? out : undefined;
}

export const PAGE_ORDER_FIELD = { slug: "menu_order", label: "Order (lower first, as in WordPress)", type: "integer" } as const;
export const PAGE_PARENT_FIELD = { slug: "parent", label: "Parent page", type: "reference", validation: { targetCollection: "pages", multiple: false } } as const;
export const PAGE_EXCERPT_FIELD = { slug: "excerpt", label: "Excerpt", type: "text" } as const;
export const PAGE_FEATURED_FIELD = { slug: "featured_image", label: "Featured image", type: "image" } as const;

type PageField = typeof PAGE_ORDER_FIELD | typeof PAGE_PARENT_FIELD | typeof PAGE_EXCERPT_FIELD | typeof PAGE_FEATURED_FIELD;

/** The extra `pages` fields this site needs, in a fixed order (none for a site that never used them). */
export function pageFields(pages: IrPage[]): PageField[] {
	const has = (f: (p: IrPage) => unknown) => pages.some((p) => p.kind === "page" && !!f(p));
	return [has((p) => p.page?.menuOrder) ? PAGE_ORDER_FIELD : undefined, has((p) => p.page?.parent) ? PAGE_PARENT_FIELD : undefined, has((p) => p.page?.excerpt) ? PAGE_EXCERPT_FIELD : undefined, has((p) => p.featuredImage) ? PAGE_FEATURED_FIELD : undefined].filter((f): f is PageField => !!f);
}

/** Field values of one page for the fields the site has (featured image through the target's media resolver). */
export function pageData(doc: IrPage, fields: PageField[], media: (m: NonNullable<IrPage["featuredImage"]>) => unknown): Record<string, unknown> {
	const slugs = new Set(fields.map((f) => f.slug));
	const out: Record<string, unknown> = {};
	if (slugs.has("menu_order")) out.menu_order = doc.page?.menuOrder ?? 0;
	if (slugs.has("excerpt") && doc.page?.excerpt) out.excerpt = doc.page.excerpt;
	if (slugs.has("featured_image") && doc.featuredImage) {
		const v = media(doc.featuredImage);
		if (v) out.featured_image = v;
	}
	return out;
}

/** Parents before their children (seed references resolve in file order); otherwise the order is kept. */
export function parentsFirst(pages: IrPage[]): IrPage[] {
	const key = (p: IrPage) => `page:${p.source.wpId}`;
	const byKey = new Map(pages.map((p) => [key(p), p]));
	const out: IrPage[] = [];
	const seen = new Set<string>();
	const visit = (p: IrPage, depth: number) => {
		if (seen.has(key(p))) return;
		seen.add(key(p));
		const parent = p.page?.parent ? byKey.get(p.page.parent) : undefined;
		if (parent && depth < 20) visit(parent, depth + 1);
		out.push(p);
	};
	for (const p of pages) visit(p, 0);
	return out;
}

/** WordPress's featured-image markup (`the_post_thumbnail()` prints class "wp-post-image") in a live page. */
export const showsFeaturedImage = (html: string) => /<img\b[^>]*\bclass=["'][^"']*\bwp-post-image\b/i.test(html);

/** Coverage report lines: which page attributes are carried (counts only). */
export function pageAttributesReport(pages: IrPage[], featuredShownOnLive: number): string[] {
	const ps = pages.filter((p) => p.kind === "page");
	const n = (f: (p: IrPage) => unknown) => ps.filter((p) => !!f(p)).length;
	const order = n((p) => p.page?.menuOrder);
	const parent = n((p) => p.page?.parent);
	const excerpt = n((p) => p.page?.excerpt);
	const featured = n((p) => p.featuredImage);
	if (!order && !parent && !excerpt && !featured) return [];
	const L = ["", "## Page attributes", "", "WordPress page settings carried into fields of EmDash's `pages` collection (added only for the ones this site uses).", "", "| Attribute | Pages | EmDash field |", "|---|---|---|"];
	if (order) L.push(`| Manual order (\`menu_order\`) | ${order} | \`menu_order\` (integer) |`);
	if (parent) L.push(`| Parent page | ${parent} | \`parent\` (reference to a page; addresses stay as they were) |`);
	if (excerpt) L.push(`| Excerpt | ${excerpt} | \`excerpt\` (text) |`);
	if (featured) L.push(`| Featured image | ${featured} | \`featured_image\` (image) |`);
	if (featured) L.push("", featuredShownOnLive ? `The old theme printed the featured image on ${featuredShownOnLive} live page(s) (\`wp-post-image\`). The starter does not render the field on pages: the image is carried as data (and as the social/sitemap image when the page has none of its own); check those pages in the visual comparison.` : "The old theme did not print the featured image on the audited pages: carried as data only.");
	return L;
}
