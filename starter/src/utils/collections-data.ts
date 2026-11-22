/**
 * Queries for collections migrated from WordPress custom post types (pages/[...slug].astro): archive pages with numbered
 * pages, term archives, and one entry with its references. EmDash query API (emdash 1.5, docs/spikes/cpt-findings.md):
 * getEmDashCollection (`where` by taxonomy, `orderBy`, `limit` + `offset` → `hasMore`), getEmDashEntry with
 * `references` (first page of each reference field), getTerm. Every page carries its collection's cache tag (EmDash purges
 * it on any write to an entry of the collection) and its taxonomies' tags.
 */
import type { AstroGlobal } from "astro";
import { getEmDashCollection, getEmDashEntry, getTerm } from "emdash";
import site from "../site.config.json";
import { type CollectionConfig, type CollectionsConfig, collectionCacheTags, entryCollections } from "./collections";
import { isOnSale, orderBySlugs, type ProductGridPlan } from "./product-grid";

export const collectionsConfig: CollectionsConfig = (site as { collections?: CollectionsConfig }).collections ?? [];

export type CollectionEntry = { id: string; data: Record<string, any>; references?: Record<string, { entries?: { id: string; data: Record<string, any> }[] }> };

/** One page of a collection's published entries: WordPress's order (menu order, else newest first). */
export async function listEntries(c: CollectionConfig, opts: { page: number; where?: Record<string, string | string[]> }) {
	const orderBy: Record<string, "asc" | "desc"> = c.order === "menu" ? { menu_order: "asc", published_at: "desc" } : { published_at: "desc" };
	const r = await getEmDashCollection(c.slug, { status: "published", orderBy, limit: c.perPage, offset: (opts.page - 1) * c.perPage, ...(opts.where ? { where: opts.where } : {}) });
	return { entries: r.entries as CollectionEntry[], hasMore: !!r.hasMore, cacheHint: r.cacheHint };
}

/**
 * The products of a product grid (utils/product-grid.ts), newest first: `where` by taxonomy for categories, by `slug`
 * (IN) for hand-picked products (then the editor's order), by a set sale price for "on sale" (then checked against the
 * regular price; a variable product counts when its own sale price is set). EmDash 1.5 query API: docs/spikes/
 * shop-findings.md.
 */
export async function listProducts(c: CollectionConfig, plan: ProductGridPlan): Promise<CollectionEntry[]> {
	const base = { status: "published" as const, orderBy: { published_at: "desc" as const } };
	if (plan.source === "handpicked") {
		if (!plan.slugs.length) return [];
		const r = await getEmDashCollection(c.slug, { ...base, limit: plan.slugs.length, where: { slug: plan.slugs } });
		return orderBySlugs(r.entries as CollectionEntry[], plan.slugs).slice(0, plan.count);
	}
	if (plan.source === "category") {
		const tax = c.taxonomies.find((t) => t.taxonomy === "product_cat")?.taxonomy ?? c.taxonomies[0]?.taxonomy;
		if (!tax || !plan.categories.length) return [];
		return (await getEmDashCollection(c.slug, { ...base, limit: plan.count, where: { [tax]: plan.categories } })).entries as CollectionEntry[];
	}
	if (plan.source === "on_sale") {
		const r = await getEmDashCollection(c.slug, { ...base, limit: Math.min(48, plan.count * 4), where: { sale_price: { gte: "0" } } });
		return (r.entries as CollectionEntry[]).filter((e) => isOnSale(e.data)).slice(0, plan.count);
	}
	return (await getEmDashCollection(c.slug, { ...base, limit: plan.count })).entries as CollectionEntry[];
}

/** The entry at this slug (its WordPress path) in the collection its address belongs to, with its references. */
export async function findEntry(slug: string) {
	for (const c of entryCollections(slug, collectionsConfig)) {
		const references = Object.fromEntries(c.references.map((f) => [f, true as const]));
		const r = await getEmDashEntry(c.slug, slug, c.references.length ? { references } : undefined);
		if (r.entry) return { collection: c, entry: r.entry as unknown as CollectionEntry & { edit?: Record<string, any> }, cacheHint: r.cacheHint };
	}
	return undefined;
}

export async function termOf(taxonomy: string, slug: string) {
	return getTerm(taxonomy, slug, { includeCounts: false });
}

/** Route cache: the collections' and their taxonomies' tags next to the page's own. */
export function cacheCollections(cache: AstroGlobal["cache"] | undefined, cols: CollectionConfig[], hints: ({ tags?: string[] } | undefined)[] = []): void {
	if (!cache?.enabled) return;
	cache.set({ tags: [...new Set(cols.flatMap(collectionCacheTags))] });
	for (const h of hints) if (h) cache.set(h as never);
}
