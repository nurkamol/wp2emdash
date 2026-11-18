/**
 * Security headers on every response; staging (STAGING=1) is never indexed.
 * Redirects live in EmDash's redirects table (editable in the admin), not here.
 */
import { env } from "cloudflare:workers";
import { defineMiddleware } from "astro:middleware";
import site from "./site.config.json";

const HEADERS: Record<string, string> = {
	"Strict-Transport-Security": "max-age=31536000; includeSubDomains",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "strict-origin-when-cross-origin",
	"Permissions-Policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
	"X-Frame-Options": "SAMEORIGIN",
};

/** Page paths keep the WordPress URL style (trailing slash or not) with one 301; files, /_emdash and /api are untouched. */
function canonicalPath(path: string): string | undefined {
	if (path === "/" || path.startsWith("/_") || path.startsWith("/api/") || /^\/(404|500)\/?$/.test(path) || /\.[a-z0-9]{2,5}$/i.test(path)) return undefined;
	const style = (site as { trailingSlash?: string }).trailingSlash;
	if (style === "always" && !path.endsWith("/")) return `${path}/`;
	if (style === "never" && path.endsWith("/")) return path.replace(/\/+$/, "");
	return undefined;
}

/**
 * EmDash's sitemap lists pages by slug (`/about-us`, the front page as `/home`, nested slugs encoded). Rewrite each
 * <loc> to the page's real address: the front page as "/", nested slugs decoded, the site's URL style applied —
 * so no sitemap entry is a redirect.
 */
function fixSitemapLoc(loc: string): string {
	try {
		const u = new URL(loc);
		let path = decodeURIComponent(u.pathname);
		if (path === "/home" || path === "/home/") path = "/";
		u.pathname = canonicalPath(path) ?? path;
		return u.href;
	} catch {
		return loc;
	}
}

export const onRequest = defineMiddleware(async (context, next) => {
	if (context.request.method === "GET" || context.request.method === "HEAD") {
		const to = canonicalPath(context.url.pathname);
		if (to) return context.redirect(`${to}${context.url.search}`, 301);
	}
	const response = await next();
	if (context.url.pathname.startsWith("/_emdash")) return response;
	if (/^\/sitemap(?:-[\w-]+)?\.xml$/.test(context.url.pathname) && response.ok) {
		const xml = (await response.text()).replace(/<loc>([^<]+)<\/loc>/g, (_m, loc: string) => `<loc>${fixSitemapLoc(loc.trim())}</loc>`);
		const headers = new Headers(response.headers);
		headers.delete("content-length");
		for (const [k, v] of Object.entries(HEADERS)) if (!headers.has(k)) headers.set(k, v);
		return new Response(xml, { status: response.status, headers });
	}
	const headers = new Headers(response.headers);
	for (const [k, v] of Object.entries(HEADERS)) if (!headers.has(k)) headers.set(k, v);
	if ((env as { STAGING?: string }).STAGING === "1") headers.set("X-Robots-Tag", "noindex, nofollow");
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
});
