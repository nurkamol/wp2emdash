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

export const collectionsConfig: CollectionsConfig = (site as { collections?: CollectionsConfig }).collections ?? [];

export type CollectionEntry = { id: string; data: Record<string, any>; references?: Record<string, { entries?: { id: string; data: Record<string, any> }[] }> };

/** One page of a collection's published entries: WordPress's order (menu order, else newest first). */
export async function listEntries(c: CollectionConfig, opts: { page: number; where?: Record<string, string | string[]> }) {
	const orderBy: Record<string, "asc" | "desc"> = c.order === "menu" ? { menu_order: "asc", published_at: "desc" } : { published_at: "desc" };
	const r = await getEmDashCollection(c.slug, { status: "published", orderBy, limit: c.perPage, offset: (opts.page - 1) * c.perPage, ...(opts.where ? { where: opts.where } : {}) });
	return { entries: r.entries as CollectionEntry[], hasMore: !!r.hasMore, cacheHint: r.cacheHint };
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
