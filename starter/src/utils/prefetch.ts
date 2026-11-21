/**
 * Page preloading (kit.config performance.prefetch, on by default): when a visitor points at a link (mouse hover,
 * keyboard focus, or the first touch on a phone), the page behind it starts loading, so the click feels instant and a
 * page that was not in Cloudflare's cache is rendered while the visitor is still deciding.
 *
 * Chrome and Edge: Speculation Rules (prefetch only, never prerender: that would run page scripts, booking widgets and
 * analytics), sent by the middleware as a Speculation-Rules header pointing at public/speculation-rules.json. The click
 * uses their prefetched copy although pages are `no-cache`; it revalidates a `<link rel=prefetch>` copy
 * (docs/spikes/performance-findings.md). Other browsers: site.ts with prefetchable() below.
 *
 * Only the site's own pages: never files (PDFs, images, downloads), EmDash's admin and API, the form endpoints, old
 * WordPress upload paths, links that open elsewhere, the current page, or anything on a data-saver / 2G connection.
 * Both paths share the lists below. No imports: this file loads in Node (kit tests) and in the browser.
 */
const SKIP_DIRS = ["_emdash", "_image", "_astro", "api", "wp-content", "wp-admin", "wp-login", "feed"];
/** Preview, edit and search links are never shared copies: nothing to gain. */
const SKIP_QUERY = ["_preview", "_edit", "q", "s"];
/** Links that open elsewhere, downloads, and links marked data-prefetch="false". */
export const SKIP_LINKS = '[target="_blank"], [download], [data-prefetch="false"]';
export const SPECULATION_RULES_PATH = "/speculation-rules.json";

const SKIP_PATH = new RegExp(`^/(?:${SKIP_DIRS.join("|")})(?:/|$)|/feed/?$`);
/** A last path segment with an extension other than .html is a file. */
const FILE = /\.(?!html?$)[a-z0-9]{1,5}$/i;
const QUERY = new RegExp(`(?:^|&)(?:${SKIP_QUERY.join("|")})=`);

export function prefetchable(href: string, here: { origin: string; pathname: string; search: string }): string | undefined {
	let u: URL;
	try {
		u = new URL(href, here.origin + here.pathname);
	} catch {
		return undefined;
	}
	if (u.origin !== here.origin || (u.protocol !== "https:" && u.protocol !== "http:")) return undefined;
	if (u.pathname === here.pathname && u.search === here.search) return undefined;
	if (SKIP_PATH.test(u.pathname) || FILE.test(u.pathname)) return undefined;
	if (QUERY.test(u.search.slice(1))) return undefined;
	u.hash = "";
	return u.toString();
}

/**
 * The content of public/speculation-rules.json (test/prefetch.test.ts keeps the file equal to this). Patterns are
 * objects that start at the pathname, so protocol, host and port come from the rules file's own URL: same-origin only.
 * A URLPattern regex group may not hold capturing groups, hence (?:…).
 */
export function speculationRules() {
	const not = (pathname: string, search?: string) => ({ not: { href_matches: search ? { pathname, search } : { pathname } } });
	return {
		prefetch: [
			{
				source: "document",
				eagerness: "moderate",
				where: {
					and: [
						{ href_matches: { pathname: "/*" } },
						...SKIP_DIRS.map((d) => not(`/${d}{/*}?`)),
						not("*/feed{/}?"),
						{ not: { and: [{ href_matches: { pathname: "*.([A-Za-z0-9]{1,5})" } }, { not: { href_matches: { pathname: "*.([hH][tT][mM][lL]?)" } } }] } },
						not("*", `((?:.*&)?(?:${SKIP_QUERY.join("|")}))=*`),
						{ not: { selector_matches: SKIP_LINKS } },
					],
				},
			},
		],
	};
}

export function slowConnection(conn: { saveData?: boolean; effectiveType?: string } | undefined): boolean {
	return !!conn && (conn.saveData === true || /(?:^|-)2g$/.test(conn.effectiveType ?? ""));
}
