/**
 * Security headers on every response; staging (STAGING=1) is never indexed.
 * Redirects live in EmDash's redirects table (editable in the admin), not here.
 */
import { env } from "cloudflare:workers";
import { defineMiddleware } from "astro:middleware";
import site from "./site.config.json";
import { isEditor } from "./utils/editor";
import { embedCsp, providerCsp } from "./utils/providers";
import { siteWidgets } from "./utils/widgets";
import { matchWpUrl, type WpUrlRules } from "./utils/wp-urls";
import { type CspHosts, cspSources } from "@wp2emdash/seo/analytics/csp";
import { typesOf } from "@wp2emdash/seo/analytics/trackers";
import { pageAnalytics } from "./utils/analytics";
import announcementScript from "./scripts/inline/announcement.js?raw";

/**
 * Content-Security-Policy. Scripts and frames: this site, Cloudflare Turnstile and the embed providers the
 * starter allows (the provider registry, utils/providers.ts — so an embed an editor adds later is not blocked), and the
 * hosts of the site widgets switched on in site.config.json `siteWidgets` (chat, reviews badge, consent tool — the same
 * registry; components/SiteWidgets.astro). Styles allow inline: sections
 * carry their spacing/colours in style attributes and EmDash's responsive images use them. Signed-in editors also
 * get inline scripts: EmDash's visual-editing toolbar is an inline script. Everyone else gets exactly the starter's own
 * inline scripts, allowed by their SHA-256 hash (scripts/inline/*: the announcement bar's pre-paint script).
 */
const embeds = embedCsp();
const widgets = providerCsp(siteWidgets().map((w) => w.provider));
const join = (...lists: string[][]) => [...new Set(lists.flat())].join(" ");
/*
 * Analytics hosts: exactly the services this page loads (components/Analytics.astro, the same per-request list), from
 * the fixed host table in @wp2emdash/seo/analytics/csp. Cloudflare Web Analytics is always allowed: when it is switched on
 * for the zone, Cloudflare injects its beacon into every page by itself, and a CSP without it blocks the beacon.
 */
const INLINE_SCRIPTS = [announcementScript];
let inlineHashes: Promise<string> | undefined;
async function sha256(text: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
	return `'sha256-${btoa(String.fromCharCode(...digest))}'`;
}
/** The hash sources for INLINE_SCRIPTS, computed once per isolate. */
function inlineScriptHashes(): Promise<string> {
	inlineHashes ??= Promise.all(INLINE_SCRIPTS.map(sha256)).then((h) => h.join(" "));
	return inlineHashes;
}
function csp(editor: boolean, hashes: string, analytics: CspHosts): string {
	const turnstile = "https://challenges.cloudflare.com";
	return [
		"default-src 'self'",
		`script-src 'self' ${turnstile} ${join(embeds.script, widgets.script)} ${analytics.script.join(" ")}${editor ? " 'unsafe-inline'" : ` ${hashes}`}`,
		`style-src 'self' 'unsafe-inline' https://fonts.googleapis.com ${join(embeds.style, widgets.style)} ${(analytics.style ?? []).join(" ")}`,
		`font-src 'self' data: https://fonts.gstatic.com ${join(embeds.font, widgets.font)} ${(analytics.font ?? []).join(" ")}`,
		"img-src 'self' data: blob: https:",
		`media-src 'self' blob: ${join(embeds.media, widgets.media)}`,
		`connect-src 'self' ${turnstile} ${join(embeds.connect, widgets.connect)} ${analytics.connect.join(" ")}`,
		`frame-src 'self' ${turnstile} ${join(embeds.frame, widgets.frame)} ${analytics.frame.join(" ")}`,
		"worker-src 'self' blob:",
		"object-src 'none'",
		"base-uri 'self'",
		"form-action 'self'",
		"frame-ancestors 'self'",
		"upgrade-insecure-requests",
	].join("; ");
}

const HEADERS: Record<string, string> = {
	"Strict-Transport-Security": "max-age=31536000; includeSubDomains",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "strict-origin-when-cross-origin",
	"Permissions-Policy": "camera=(), microphone=(), geolocation=()",
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

/** WordPress sitemap addresses search engines may still have (Yoast/Rank Math index and parts, core wp-sitemap). */
const LEGACY_SITEMAP = /^\/(?:sitemap_index|wp-sitemap(?:-[\w-]+)?|[a-z0-9_]+-sitemap\d*)\.xml$/i;
/** WordPress upload URLs (also the hidden /storage/ alias), incl. resized copies: -300x200, -scaled. */
const LEGACY_UPLOAD = /^\/(?:wp-content\/uploads|storage)\/\d{4}\/\d{2}\/([^/]+)$/i;

/**
 * Old image and file addresses (Google Images, social previews, other sites' links) → the same file in the media
 * library, found by its original filename. Reads EmDash's media table (filename, storage_key — migration 001);
 * any failure just falls through to a 404.
 */
async function legacyUpload(name: string): Promise<string | undefined> {
	const db = (env as { DB?: { prepare(q: string): { bind(...v: unknown[]): { first<T>(): Promise<T | null> } } } }).DB;
	if (!db) return undefined;
	const file = decodeURIComponent(name);
	const original = file.replace(/-(?:\d+x\d+|scaled)(?=\.[a-z0-9]+$)/i, "");
	// The media library takes no SVG: the migration drew each one to a PNG of the same name (logo.svg → logo.png).
	const drawn = /\.svg$/i.test(original) ? [original.replace(/\.svg$/i, ".png")] : [];
	try {
		for (const f of [...new Set([file, original, ...drawn])]) {
			const row = await db.prepare("SELECT storage_key FROM media WHERE filename = ? ORDER BY created_at LIMIT 1").bind(f).first<{ storage_key: string }>();
			if (row?.storage_key) return `/_emdash/api/media/file/${encodeURIComponent(row.storage_key)}`;
		}
	} catch {}
	return undefined;
}

const PRODUCTION = new URL(site.productionUrl);
const bare = (h: string) => h.replace(/^www\./, "");

/** Original file behind an /_image transform URL (EmDash media only), for the fallback when a transform fails. */
function imageOriginal(url: URL): string | undefined {
	try {
		const href = new URL(url.searchParams.get("href") ?? "", url.origin);
		return /^\/_emdash\/api\/media\/file\/[\w.-]+$/.test(href.pathname) ? href.pathname : undefined;
	} catch {
		return undefined;
	}
}

export const onRequest = defineMiddleware(async (context, next) => {
	// Redirects answered here are never kept in the route cache (Astro's route rules match by path).
	const redirect = (to: string, status: 301 | 302) => {
		if (context.cache?.enabled) context.cache.set(false);
		return context.redirect(to, status);
	};
	// Production host policy, which WordPress (or a zone rule) handled before: the other host (www ↔ apex) and plain
	// http go to the canonical https address with one 301. Staging, workers.dev and localhost are left alone.
	const u = context.url;
	if (bare(u.hostname) === bare(PRODUCTION.hostname) && (u.hostname !== PRODUCTION.hostname || u.protocol === "http:")) {
		return redirect(`${PRODUCTION.origin}${u.pathname}${u.search}`, 301);
	}
	// A WordPress address the owner's rule set says is gone (410), or an unknown ?p= id (404): the 404 page, that status.
	let goneStatus: 404 | 410 | undefined;
	if (context.request.method === "GET" || context.request.method === "HEAD") {
		const path = context.url.pathname;
		if (LEGACY_SITEMAP.test(path)) return redirect("/sitemap.xml", 301);
		// WordPress numeric links: /?p=40, /?page_id=40 (and ?preview leftovers) → the page's address.
		const wpIds = (site as { wpIds?: Record<string, string> }).wpIds ?? {};
		const wpId = path === "/" ? (u.searchParams.get("page_id") ?? u.searchParams.get("p")) : null;
		const wpPath = wpId && /^\d+$/.test(wpId) ? wpIds[wpId] : undefined;
		if (wpPath) return redirect(wpPath, 301);
		// WordPress addresses with no page here — feeds, search, category/tag/author/date archives, attachment pages and
		// their query forms (?s=, ?cat=, ?feed=…): one 301 or a 410, by the site's rule set (site.config.json wpUrls,
		// decided in transform; utils/wp-urls.ts). Verify's urls-accounted check judges the same rules.
		const rules = (site as { wpUrls?: WpUrlRules }).wpUrls;
		const wp = rules && !path.startsWith("/_") && !path.startsWith("/api/") ? matchWpUrl(path, u.searchParams, rules, wpIds) : undefined;
		if (wp && "file" in wp) {
			const to = await legacyUpload(wp.file);
			if (to) return redirect(to, 301);
			if ("to" in wp.fallback) return redirect(wp.fallback.to, 301);
			goneStatus = 410;
		} else if (wp && "to" in wp) return redirect(wp.to, 301);
		else if (wp) goneStatus = "gone" in wp ? 410 : 404;
		// Brand files (logo, favicon) moved into /brand at scaffold time; both WordPress upload aliases map to them.
		const files = (site as { legacyFiles?: Record<string, string> }).legacyFiles ?? {};
		const alias = (p: string) => p.replace(/^\/storage\//, "/wp-content/uploads/");
		const brand = Object.entries(files).find(([from]) => alias(from) === alias(path))?.[1];
		if (brand) return redirect(brand, 301);
		const upload = LEGACY_UPLOAD.exec(path)?.[1];
		if (upload) {
			const to = await legacyUpload(upload);
			if (to) return redirect(to, 301);
		}
		const to = canonicalPath(path);
		if (to && !goneStatus) return redirect(`${to}${context.url.search}`, 301);
	}
	const response = goneStatus ? await next("/404") : await next();
	// A signed-in editor (or an edit/preview link) gets its own page: never stored for everyone else.
	if (isEditor(context.cookies, context.url) && context.cache?.enabled) context.cache.set(false);
	// Responsive images (EmDash's /_image endpoint, Cloudflare Images binding): when a transform fails (e.g. the
	// account's free transformations are used up, error 9422) the visitor gets the original file, not a broken image.
	if (context.url.pathname === "/_image" && response.status >= 500) {
		const original = imageOriginal(context.url);
		if (original) return redirect(original, 302);
	}
	if (context.url.pathname.startsWith("/_emdash") || context.url.pathname === "/_image") return response;
	if (/^\/sitemap(?:-[\w-]+)?\.xml$/.test(context.url.pathname) && response.ok) {
		let xml = (await response.text()).replace(/<loc>([^<]+)<\/loc>/g, (_m, loc: string) => `<loc>${fixSitemapLoc(loc.trim())}</loc>`);
		// Blog sites: the archives sitemap (posts page, category/tag/author archives; pages/sitemap/archives.xml.ts) joins the index.
		if ((site as { blog?: unknown }).blog && context.url.pathname === "/sitemap.xml" && xml.includes("</sitemapindex>")) {
			const origin = /<loc>(https?:\/\/[^/<]+)/.exec(xml)?.[1] ?? context.url.origin;
			xml = xml.replace("</sitemapindex>", `  <sitemap>\n    <loc>${origin}/sitemap/archives.xml</loc>\n  </sitemap>\n</sitemapindex>`);
		}
		const headers = new Headers(response.headers);
		headers.delete("content-length");
		for (const [k, v] of Object.entries(HEADERS)) if (!headers.has(k)) headers.set(k, v);
		return new Response(xml, { status: response.status, headers });
	}
	const headers = new Headers(response.headers);
	for (const [k, v] of Object.entries(HEADERS)) if (!headers.has(k)) headers.set(k, v);
	// Not in `astro dev`: Vite injects inline scripts for live reload.
	const html = (headers.get("content-type") ?? "").includes("text/html");
	if (!import.meta.env.DEV && html && !headers.has("content-security-policy")) {
		const editor = isEditor(context.cookies, context.url);
		const trackers = cspSources(typesOf(await pageAnalytics(context.locals, context.url, editor)));
		headers.set("Content-Security-Policy", csp(editor, await inlineScriptHashes(), trackers).replace(/ {2,}/g, " ").replace(/ ;/g, ";"));
	}
	// Browsers always revalidate a page; the shared route cache keeps that fast, and EmDash purges only that cache.
	if (html && !headers.has("cache-control")) headers.set("Cache-Control", "no-cache");
	// Never indexed: staging, and production on any address but its own domain (workers.dev before the switch).
	if ((env as { STAGING?: string }).STAGING === "1" || bare(context.url.hostname) !== bare(PRODUCTION.hostname)) headers.set("X-Robots-Tag", "noindex, nofollow");
	if (goneStatus) return new Response(response.body, { status: goneStatus, headers });
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
});
