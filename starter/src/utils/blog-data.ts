/**
 * Blog queries for the starter's blog pages (pages/[...slug].astro): listings with numbered pages, archives by term and
 * byline, previous/next and related posts, feeds. EmDash query API (emdash 1.5, docs/spikes/blog-findings.md):
 * getEmDashCollection with `where` (taxonomy name or `byline`), `orderBy`, `limit` + `offset` (→ `hasMore`), getTerm,
 * getBylineBySlug. Every listing carries the `posts` cache tag (EmDash purges it on any post publish) and the taxonomy
 * tags (purged when terms change).
 */
import type { AstroGlobal } from "astro";
import { getBylineBySlug, getEmDashCollection, getTerm } from "emdash";
import site from "../site.config.json";
import { type BlogConfig, blogCacheTags } from "./blog";

export const blogConfig = (site as { blog?: BlogConfig }).blog;

export type PostEntry = { id: string; data: Record<string, any> };

const LIST = { status: "published" as const, orderBy: { published_at: "desc" as const } };
/**
 * Multilingual sites (site.config.json `i18n`): the blog's listings, archives and feeds list one language's posts — the
 * default language's at the default addresses, another language's under its directory (`/fr/category/actualites/`,
 * `/fr/feed/`), as WordPress does with Polylang / WPML.
 */
const i18n = (site as { i18n?: { defaultLang: string; languages: { code: string; prefix: string }[] } }).i18n;
const defaultLang = i18n?.defaultLang;
const inLang = (where: Record<string, unknown> = {}, lang = defaultLang) => (defaultLang ? { ...where, lang: lang ?? defaultLang } : where);
/** Language directories of a multilingual site (`fr`), for blogRoute. */
export const langDirs = (i18n?.languages ?? []).map((l) => l.prefix).filter(Boolean);
/** The language code of a directory (`fr` → `fr`), the default language for none. */
export const langOfDir = (dir: string | undefined) => (dir ? i18n?.languages.find((l) => l.prefix === dir)?.code : undefined) ?? defaultLang;
/** The directory in front of a language's archive addresses: "" for the default language, `/fr` for French. */
const dirOf = (lang: unknown) => {
	const p = typeof lang === "string" && lang !== defaultLang ? i18n?.languages.find((l) => l.code === lang)?.prefix : undefined;
	return p ? `/${p}` : "";
};

/** One page of published posts, newest first (`where`: a taxonomy name → term slug, or `byline` → byline group id). */
export async function listPosts(opts: { page: number; perPage: number; where?: Record<string, string | string[]>; lang?: string }) {
	const r = await getEmDashCollection("posts", { ...LIST, limit: opts.perPage, offset: (opts.page - 1) * opts.perPage, ...(opts.where || defaultLang ? { where: inLang(opts.where, opts.lang) as Record<string, string | string[]> } : {}) });
	return { entries: r.entries as PostEntry[], hasMore: !!r.hasMore, cacheHint: r.cacheHint };
}

/** Featured (sticky) posts, shown first on the posts page's first page, as WordPress does. */
export async function featuredPosts(limit = 10, lang?: string) {
	// Boolean fields are INTEGER columns; SQLite's affinity compares the text "1" as 1.
	const r = await getEmDashCollection("posts", { ...LIST, limit, where: inLang({ featured: "1" }, lang) as Record<string, string> });
	return r.entries as PostEntry[];
}

export async function termOf(taxonomy: string, slug: string) {
	return getTerm(taxonomy, slug, { includeCounts: false });
}

export async function bylineOf(slug: string) {
	return getBylineBySlug(slug);
}

/** The language filter for a post's neighbours and related posts: its own language on a multilingual site. */
const sameLang = (lang: unknown) => (defaultLang ? { lang: typeof lang === "string" && lang ? lang : defaultLang } : {});

/** Previous (older) and next (newer) published post, in the post's language on a multilingual site (as WordPress does). */
export async function neighbours(publishedAt: Date | string | undefined, lang?: unknown) {
	if (!publishedAt) return {};
	const at = new Date(publishedAt).toISOString();
	const [older, newer] = await Promise.all([
		getEmDashCollection("posts", { status: "published", where: { published_at: { lt: at }, ...sameLang(lang) }, orderBy: { published_at: "desc" }, limit: 1 }),
		getEmDashCollection("posts", { status: "published", where: { published_at: { gt: at }, ...sameLang(lang) }, orderBy: { published_at: "asc" }, limit: 1 }),
	]);
	return { older: older.entries[0] as PostEntry | undefined, newer: newer.entries[0] as PostEntry | undefined };
}

/** Up to `limit` other posts sharing a category (else a tag), in the post's language on a multilingual site. */
export async function relatedPosts(post: PostEntry, limit = 3) {
	const terms = (post.data.terms ?? {}) as Record<string, { slug: string }[]>;
	for (const tax of ["category", "tag"]) {
		const slugs = (terms[tax] ?? []).map((t) => t.slug).filter((s) => s !== "uncategorized");
		if (!slugs.length) continue;
		const r = await getEmDashCollection("posts", { ...LIST, limit: limit + 1, where: { [tax]: slugs, ...sameLang(post.data.lang) } });
		const list = (r.entries as PostEntry[]).filter((e) => e.id !== post.id).slice(0, limit);
		if (list.length) return list;
	}
	return [];
}

/** Route cache: a blog page's tags (posts, taxonomies, bylines) next to the chrome's. */
export function cacheBlog(cache: AstroGlobal["cache"] | undefined, hints: ({ tags?: string[] } | undefined)[] = []): void {
	if (!cache?.enabled || !blogConfig) return;
	cache.set({ tags: blogCacheTags(blogConfig) });
	for (const h of hints) if (h) cache.set(h);
}

/** The post's address on the site (its slug is its WordPress path). */
export function postHref(e: PostEntry): string {
	const slug = String(e.data.slug ?? e.id).replace(/^\/+|\/+$/g, "");
	const style = (site as { trailingSlash?: string }).trailingSlash;
	return style === "never" ? `/${slug}` : `/${slug}/`;
}

/** A term's archive address (the taxonomy's base + slug), under the post's language directory on a multilingual site. */
export function termHref(taxonomy: string, slug: string, lang?: unknown): string | undefined {
	const a = blogConfig?.archives.find((x) => x.taxonomy === taxonomy);
	if (!a) return undefined;
	const p = `${dirOf(lang)}/${a.base.replace(/^\/+|\/+$/g, "")}/${slug}/`;
	return (site as { trailingSlash?: string }).trailingSlash === "never" ? p.replace(/\/$/, "") : p;
}

export function authorHref(slug: string, lang?: unknown): string | undefined {
	if (!blogConfig?.authorBase) return undefined;
	const p = `${dirOf(lang)}/${blogConfig.authorBase.replace(/^\/+|\/+$/g, "")}/${slug}/`;
	return (site as { trailingSlash?: string }).trailingSlash === "never" ? p.replace(/\/$/, "") : p;
}
