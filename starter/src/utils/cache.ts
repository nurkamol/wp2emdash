/**
 * Route cache defaults (kit.config performance.routeCache). astro.config.mjs holds one route rule per page the
 * migration knew; a page an editor adds later gets the same lifetime and tags here, so EmDash's purge on publish
 * reaches it too. Without a cache provider (performance.routeCache: false, or `astro dev`) this does nothing.
 *
 * Pages live `pageMaxAge` (default 7 days): every edit that shows on a page purges it (publish, menus, settings,
 * widgets, the kit plugins' settings). Posts, archives and collection entries keep `maxAge` (1 hour): EmDash does not
 * purge when a byline is edited.
 */
import type { AstroGlobal } from "astro";
import site from "../site.config.json";

const rc = (site as { routeCache?: { maxAge: number; swr: number; pageMaxAge?: number } }).routeCache;
/** Posts and collection entries can show on any page (footer widgets): pages carry their tags too. */
const contentTags = [...((site as { blog?: unknown }).blog ? ["posts"] : []), ...(((site as { collections?: { slug: string }[] }).collections ?? []).map((c) => c.slug))];

export function cachePage(cache: AstroGlobal["cache"] | undefined, kind: "page" | "other" = "other"): void {
	if (!cache?.enabled || !rc) return;
	if (cache.options.maxAge !== undefined) return;
	if (kind === "page") cache.set({ maxAge: rc.pageMaxAge ?? rc.maxAge, swr: rc.swr, tags: ["pages", "site_parts", "popups", ...contentTags] });
	else cache.set({ maxAge: rc.maxAge, swr: rc.swr, tags: ["pages", "site_parts", "popups"] });
}

/** Responses that must never be shared (not-found rewrites, redirects): out of the route cache. */
export function noCache(cache: AstroGlobal["cache"] | undefined): void {
	if (cache?.enabled) cache.set(false);
}
