/**
 * Media sitemap: every picture and video shown in a page's sections (and a post's or collection entry's body and image
 * fields), with Google's image and video sitemap extensions (utils/media-sitemap.ts). EmDash's own sitemaps list one
 * image per entry (its SEO image) and no videos. /sitemap/media.xml (a name WordPress SEO plugins never used, so the
 * legacy-sitemap redirect leaves it alone); the middleware adds it to the sitemap index. Same entries as the other
 * sitemaps: published, indexable, not behind a password. Route-cached and purged with the pages (astro.config route rule).
 */
import type { APIRoute } from "astro";
import { getEmDashCollection, getSeoMeta } from "emdash";
import site from "../../site.config.json";
import { blogConfig, cacheBlog, postHref } from "../../utils/blog-data";
import { cachePage } from "../../utils/cache";
import { entryHref } from "../../utils/collections";
import { cacheCollections, collectionsConfig } from "../../utils/collections-data";
import { llmsListed } from "../../utils/llms";
import { entryMedia, type MediaSitemapEntry, mediaSitemapXml } from "../../utils/media-sitemap";
import { resultHref } from "../../utils/search";

export const prerender = false;

type Entry = { id: string; data: Record<string, any> };

export const GET: APIRoute = async ({ cache, request }) => {
	// The address serving the request, as EmDash's own sitemaps do (workers.dev before go-live, the domain after it).
	const origin = new URL(request.url).origin;
	const style = (site as { trailingSlash?: "always" | "never" }).trailingSlash;
	const list = (collection: string) => getEmDashCollection(collection, { status: "published", limit: 1000 }).then((r) => r.entries as Entry[]).catch(() => [] as Entry[]);
	const [pages, posts, ...collections] = await Promise.all([list("pages"), blogConfig ? list("posts") : Promise.resolve([] as Entry[]), ...collectionsConfig.map((c) => list(c.slug))]);
	const out: MediaSitemapEntry[] = [];
	const add = (e: Entry, path: string) => {
		const seo = getSeoMeta(e as never, { siteUrl: origin, path });
		if (!llmsListed(seo?.robots, e.data)) return;
		const media = entryMedia(e.data, origin, { title: String(e.data.title ?? ""), description: seo?.description });
		out.push({ loc: `${origin}${path}`, ...media });
	};
	for (const e of pages) add(e, resultHref(e.data.slug ?? e.id, style));
	for (const e of posts) add(e, postHref(e));
	for (const entries of collections) for (const e of entries) add(e, entryHref(String(e.data.slug ?? e.id), style));
	cachePage(cache);
	if (blogConfig) cacheBlog(cache);
	if (collectionsConfig.length) cacheCollections(cache, collectionsConfig);
	return new Response(mediaSitemapXml(out), { headers: { "Content-Type": "application/xml; charset=utf-8" } });
};
