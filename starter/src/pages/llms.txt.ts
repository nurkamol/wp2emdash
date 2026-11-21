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
import { homeOf, type I18nConfig } from "../utils/i18n";

export const prerender = false;

export const GET: APIRoute = async () => {
	const s = site as { name: string; productionUrl: string; trailingSlash?: "always" | "never" };
	const origin = new URL(s.productionUrl).origin;
	const [settings, pages, posts] = await Promise.all([
		getSiteSettingsWithCacheHint().catch(() => undefined),
		getEmDashCollection("pages", { status: "published", limit: 300 }).catch(() => ({ entries: [] })),
		blogConfig ? getEmDashCollection("posts", { status: "published", limit: 30, orderBy: { published_at: "desc" } }).catch(() => ({ entries: [] })) : Promise.resolve({ entries: [] }),
	]);
	const entry = (e: { data: Record<string, any> }, path: string): LlmsEntry | undefined => {
		const seo = getSeoMeta(e as never, { siteUrl: origin, path });
		if (!llmsListed(seo?.robots, e.data)) return undefined;
		return { title: String(e.data.title ?? path), url: `${origin}${path}`, ...(seo?.description ? { description: seo.description } : {}) };
	};
	// Multilingual sites: the default language's pages and posts, then a link to each other language's home page.
	const i18n = (site as { i18n?: I18nConfig }).i18n;
	const inDefault = (e: { data: Record<string, any> }) => !i18n || !e.data.lang || e.data.lang === i18n.defaultLang;
	const pageList = (pages.entries as { data: Record<string, any> }[]).filter(inDefault).flatMap((e) => entry(e, resultHref(e.data.slug ?? e.data.id, s.trailingSlash)) ?? []);
	pageList.sort((a, b) => (a.url === `${origin}/` ? -1 : b.url === `${origin}/` ? 1 : a.url.localeCompare(b.url)));
	const postList = (posts.entries as PostEntry[]).filter(inDefault).flatMap((e) => entry(e, postHref(e)) ?? []);
	const languages = (i18n?.languages ?? []).filter((l) => l.code !== i18n?.defaultLang && l.prefix).map((l) => ({ title: l.label, url: `${origin}${homeOf(l, s.trailingSlash)}` }));
	const data = (settings as { data?: { title?: string; tagline?: string } } | undefined)?.data;
	const body = llmsTxt({ name: data?.title?.trim() || s.name, ...(data?.tagline ? { tagline: data.tagline } : {}) }, pageList, postList, languages);
	return new Response(body, { headers: { "content-type": "text/markdown; charset=utf-8", "x-robots-tag": "noindex" } });
};
