/**
 * Route cache defaults (kit.config performance.routeCache). astro.config.mjs holds one route rule per page the
 * migration knew; a page an editor adds later gets the same lifetime and the "pages" tag here, so EmDash's purge on
 * publish reaches it too. Without a cache provider (performance.routeCache: false, or `astro dev`) this does nothing.
 */
import type { AstroGlobal } from "astro";
import site from "../site.config.json";

const rc = (site as { routeCache?: { maxAge: number; swr: number } }).routeCache;

export function cachePage(cache: AstroGlobal["cache"] | undefined): void {
	if (!cache?.enabled || !rc) return;
	if (cache.options.maxAge === undefined) cache.set({ maxAge: rc.maxAge, swr: rc.swr, tags: ["pages", "site_parts", "popups"] });
}

/** Responses that must never be shared (not-found rewrites, redirects): out of the route cache. */
export function noCache(cache: AstroGlobal["cache"] | undefined): void {
	if (cache?.enabled) cache.set(false);
}
