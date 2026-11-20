/**
 * Visible breadcrumbs (site.config.json `breadcrumbs`, set when the old site showed them: Rank Math, Yoast, Breadcrumb
 * NavXT or the theme). The same trail feeds the BreadcrumbList structured data (components/StructuredData.astro), so the
 * page never carries two different trails. Nested pages follow their path (`/services/massage/` → Home › Services ›
 * Massage); posts go Home › posts page › post.
 *
 * No imports here: this file must load in Node (kit tests) and in the Worker (starter).
 */
export interface Crumb {
	label: string;
	/** Site path; the last crumb (this page) has none. */
	href?: string;
}

export interface BreadcrumbsConfig {
	pages: boolean;
	posts: boolean;
	/** The first crumb's label on the old site ("Home"). */
	home?: string;
}

const styled = (p: string, style: "always" | "never" | undefined) => (p === "/" ? p : style === "never" ? p.replace(/\/+$/, "") : p.endsWith("/") ? p : `${p}/`);

/** Slugs of a nested page's ancestors: "a/b/c" → ["a", "a/b"]. */
export function ancestorSlugs(slug: string): string[] {
	const parts = slug.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
	return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** A path segment as a label when its page is not on the site ("our-team" → "Our team"). */
export const segmentLabel = (s: string) => {
	const t = decodeURIComponentSafe(s).replace(/[-_]+/g, " ").trim();
	return t ? `${t[0]?.toUpperCase()}${t.slice(1)}` : s;
};

/** Trail of a page at `slug` ("home" = the front page: no trail). `titles`: ancestor slug → its page title. */
export function pageTrail(slug: string, title: string, titles: Map<string, string>, cfg: Pick<BreadcrumbsConfig, "home">, style?: "always" | "never"): Crumb[] {
	if (!slug || slug === "home") return [];
	const crumbs: Crumb[] = [{ label: cfg.home || "Home", href: "/" }];
	for (const a of ancestorSlugs(slug)) crumbs.push({ label: titles.get(a) ?? segmentLabel(a.split("/").pop() as string), href: styled(`/${a}`, style) });
	crumbs.push({ label: title });
	return crumbs;
}

/** Trail of a post: Home › the posts page (when it is not the front page) › the post. */
export function postTrail(title: string, blog: { index: string; title?: string } | undefined, cfg: Pick<BreadcrumbsConfig, "home">, style?: "always" | "never"): Crumb[] {
	const crumbs: Crumb[] = [{ label: cfg.home || "Home", href: "/" }];
	if (blog && blog.index !== "/") crumbs.push({ label: blog.title || "Blog", href: styled(blog.index, style) });
	crumbs.push({ label: title });
	return crumbs;
}

/** BreadcrumbList items (schema.org) for a trail, absolute on the production origin; the last item is the canonical URL. */
export function breadcrumbListItems(trail: Crumb[], origin: string, canonical: string): { "@type": "ListItem"; position: number; name: string; item: string }[] {
	return trail.map((c, i) => ({ "@type": "ListItem", position: i + 1, name: c.label, item: c.href ? new URL(c.href, origin).href : canonical }));
}

function decodeURIComponentSafe(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}
