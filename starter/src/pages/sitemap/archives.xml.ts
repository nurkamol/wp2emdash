/**
 * Archives sitemap: the blog's posts page and every category, tag and author archive with published posts, and the
 * archives of collections migrated from custom post types (`collections[].archive`) with their term archives.
 * EmDash's own sitemaps list entries only (sitemap-posts.xml, sitemap-pages.xml); this one is /sitemap/archives.xml (a
 * name WordPress SEO plugins never used, so the legacy-sitemap redirect leaves it alone) and the middleware adds it to
 * the sitemap index. Tagged like the archives so publishing a post or editing terms purges it.
 */
import type { APIRoute } from "astro";
import { getEmDashCollection, getTaxonomyTerms, type TaxonomyTerm } from "emdash";
import site from "../../site.config.json";
import { escapeXml } from "../../utils/blog";
import { blogConfig, cacheBlog } from "../../utils/blog-data";
import { cacheCollections, collectionsConfig } from "../../utils/collections-data";

export const prerender = false;

export const GET: APIRoute = async ({ cache, request }) => {
	const blog = blogConfig;
	const archived = collectionsConfig.filter((c) => c.archive || c.taxonomies.length);
	if (!blog && !archived.length) return new Response("Not found", { status: 404 });
	// The address serving the request, as EmDash's own sitemaps do (workers.dev before go-live, the domain after it).
	const origin = new URL(request.url).origin;
	const never = (site as { trailingSlash?: string }).trailingSlash === "never";
	const at = (p: string) => `${origin}${never && p !== "/" ? p.replace(/\/$/, "") : p}`;
	const locs = new Set<string>(blog ? [at(blog.index)] : []);
	// Collections: the archive, and each term archive of its own taxonomies (the blog's are listed below).
	for (const c of archived) {
		if (c.archive) locs.add(at(c.archive));
		for (const t of c.taxonomies.filter((x) => !blog?.archives.some((a) => a.taxonomy === x.taxonomy))) {
			const walk = (terms: TaxonomyTerm[]) => {
				for (const term of terms) {
					if ((term.count ?? 0) > 0) locs.add(at(`/${t.base.replace(/^\/+|\/+$/g, "")}/${term.slug}/`));
					walk(term.children ?? []);
				}
			};
			walk(await getTaxonomyTerms(t.taxonomy));
		}
	}
	if (archived.length) cacheCollections(cache, archived);
	if (!blog) {
		const xml = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...[...locs].map((l) => `  <url><loc>${escapeXml(l)}</loc></url>`), "</urlset>"].join("\n");
		return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
	}
	for (const a of blog.archives) {
		const walk = (terms: TaxonomyTerm[], prefix: string) => {
			for (const t of terms) {
				const path = `${prefix}${t.slug}/`;
				if ((t.count ?? 0) > 0) locs.add(at(path));
				walk(t.children ?? [], path);
			}
		};
		walk(await getTaxonomyTerms(a.taxonomy), `/${a.base.replace(/^\/+|\/+$/g, "")}/`);
	}
	if (blog.authorBase) {
		const { entries } = await getEmDashCollection("posts", { status: "published", limit: 1000 });
		for (const e of entries) for (const c of ((e.data as { bylines?: { byline?: { slug?: string } }[] }).bylines ?? [])) if (c.byline?.slug) locs.add(at(`/${blog.authorBase.replace(/^\/+|\/+$/g, "")}/${c.byline.slug}/`));
	}
	cacheBlog(cache);
	const xml = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">', ...[...locs].map((l) => `  <url><loc>${escapeXml(l)}</loc></url>`), "</urlset>"].join("\n");
	return new Response(xml, { headers: { "Content-Type": "application/xml; charset=utf-8" } });
};
