/**
 * /llms.txt — the site map for AI assistants (utils/llms.ts). Route-cached like the pages (astro.config route rule,
 * purged with them when anything is published).
 */
import type { APIRoute } from "astro";
import { getEmDashCollection, getSeoMeta, getSiteSettingsWithCacheHint } from "emdash";
import site from "../site.config.json";
import { blogConfig, postHref, type PostEntry } from "../utils/blog-data";
import { type LlmsEntry, llmsListed, llmsTxt } from "../utils/llms";
import { resultHref } from "../utils/search";
import { collectionsConfig } from "../utils/collections-data";
import { entryHref } from "../utils/collections";

export const prerender = false;

export const GET: APIRoute = async () => {
	const s = site as { name: string; productionUrl: string; trailingSlash?: "always" | "never" };
	const origin = new URL(s.productionUrl).origin;
	// A catalogue shop's products (kit.config shop): listed after the pages and posts.
	const shopCollections = collectionsConfig.filter((c) => c.shop);
	const [settings, pages, posts, ...shopLists] = await Promise.all([
		getSiteSettingsWithCacheHint().catch(() => undefined),
		getEmDashCollection("pages", { status: "published", limit: 300 }).catch(() => ({ entries: [] })),
		blogConfig ? getEmDashCollection("posts", { status: "published", limit: 30, orderBy: { published_at: "desc" } }).catch(() => ({ entries: [] })) : Promise.resolve({ entries: [] }),
		...shopCollections.map((c) => getEmDashCollection(c.slug, { status: "published", limit: 300 }).catch(() => ({ entries: [] }))),
	]);
	const entry = (e: { data: Record<string, any> }, path: string): LlmsEntry | undefined => {
		const seo = getSeoMeta(e as never, { siteUrl: origin, path });
		if (!llmsListed(seo?.robots, e.data)) return undefined;
		return { title: String(e.data.title ?? path), url: `${origin}${path}`, ...(seo?.description ? { description: seo.description } : {}) };
	};
	const pageList = (pages.entries as { data: Record<string, any> }[]).flatMap((e) => entry(e, resultHref(e.data.slug ?? e.data.id, s.trailingSlash)) ?? []);
	pageList.sort((a, b) => (a.url === `${origin}/` ? -1 : b.url === `${origin}/` ? 1 : a.url.localeCompare(b.url)));
	const postList = (posts.entries as PostEntry[]).flatMap((e) => entry(e, postHref(e)) ?? []);
	const data = (settings as { data?: { title?: string; tagline?: string } } | undefined)?.data;
	const more = shopCollections.map((c, i) => ({ heading: c.label, items: ((shopLists[i]?.entries ?? []) as { id: string; data: Record<string, any> }[]).flatMap((e) => entry(e, entryHref(String(e.data.slug ?? e.id), s.trailingSlash)) ?? []).sort((a, b) => a.url.localeCompare(b.url)) }));
	const body = llmsTxt({ name: data?.title?.trim() || s.name, ...(data?.tagline ? { tagline: data.tagline } : {}) }, pageList, postList, more);
	return new Response(body, { headers: { "content-type": "text/markdown; charset=utf-8", "x-robots-tag": "noindex" } });
};
