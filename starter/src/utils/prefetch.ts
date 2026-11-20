/**
 * Page preloading (kit.config performance.prefetch, on by default): when a visitor points at a link (mouse hover,
 * keyboard focus, or the first touch on a phone), the page behind it starts loading, so the click feels instant and a
 * page that was not in Cloudflare's cache is rendered while the visitor is still deciding.
 *
 * Only the site's own pages: never files (PDFs, images, downloads), EmDash's admin and API, the form endpoints, old
 * WordPress upload paths, links that open elsewhere, the current page, or anything on a data-saver / 2G connection.
 * No imports: this file loads in Node (kit tests) and in the browser.
 */
const SKIP_PATH = /^\/(?:_emdash|_image|_astro|api|wp-content|wp-admin|wp-login|feed)(?:\/|$)|\/feed\/?$/;
/** A last path segment with an extension other than .html is a file. */
const FILE = /\.(?!html?$)[a-z0-9]{1,5}$/i;

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
	// Preview, edit and search links are never shared copies: nothing to gain.
	if (/(?:^|&)(?:_preview|_edit|q|s)=/.test(u.search.slice(1))) return undefined;
	u.hash = "";
	return u.toString();
}

export function slowConnection(conn: { saveData?: boolean; effectiveType?: string } | undefined): boolean {
	return !!conn && (conn.saveData === true || /(?:^|-)2g$/.test(conn.effectiveType ?? ""));
}
