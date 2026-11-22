/** URL normalisation shared by discovery, snapshots and (later) redirects. */

const TRACKING_PARAMS = /^(utm_|fbclid$|gclid$|msclkid$|mc_cid$|mc_eid$|_ga$|ref$)/i;

export interface SiteHosts {
	origin: string;
	hosts: Set<string>;
}

export function siteHosts(sourceUrl: string, alternateHosts: string[] = []): SiteHosts {
	const u = new URL(sourceUrl);
	const bare = u.hostname.replace(/^www\./, "");
	return { origin: u.origin, hosts: new Set([u.hostname, bare, `www.${bare}`, ...alternateHosts]) };
}

export function isInternal(url: string, site: SiteHosts): boolean {
	try {
		const u = new URL(url);
		return /^https?:$/.test(u.protocol) && site.hosts.has(u.hostname);
	} catch {
		return false;
	}
}

/**
 * Canonical key for a URL on the source site: source origin, no hash, no tracking params,
 * sorted query. The path (including trailing slash) is preserved exactly — slash policy is a migration decision.
 */
export function normalizeUrl(url: string, site: SiteHosts): string {
	const u = new URL(url, site.origin);
	const target = new URL(site.origin);
	u.protocol = target.protocol;
	u.hostname = target.hostname;
	u.port = target.port;
	u.hash = "";
	const params = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k)).sort(([a], [b]) => a.localeCompare(b));
	u.search = params.length ? `?${new URLSearchParams(params).toString()}` : "";
	return u.href;
}

/** Path + query, used as the stable id of a URL inside a site. */
export function pathKey(url: string): string {
	const u = new URL(url);
	return `${u.pathname}${u.search}`;
}

const ASSET_EXT = /\.(jpe?g|png|gif|webp|avif|svg|ico|pdf|zip|docx?|xlsx?|pptx?|mp4|mov|webm|mp3|wav|css|js|json|xml|txt|woff2?|ttf|eot)$/i;

export function looksLikeAsset(url: string): boolean {
	try {
		return ASSET_EXT.test(new URL(url).pathname);
	} catch {
		return false;
	}
}

/**
 * Addresses that make WordPress DO something when requested: WooCommerce cart actions (`?add-to-cart=63` creates a cart
 * session row in the site's database), comment replies, logins/logouts, nonce'd actions, customizer previews. The kit
 * never writes to the live site, so these are never requested — not crawled, not link-checked, not sampled. Found by
 * the WordPress end-to-end test (2026-11-22): the crawler followed WooCommerce's add-to-cart buttons.
 */
const ACTION_PARAMS = /^(add-to-cart|add_to_wishlist|remove_item|undo_item|removed_item|order_again|cancel_order|replytocom|_wpnonce|_wp_http_referer|wc-ajax|wc-api|action|customize_changeset_uuid|customize_theme|preview_id|preview_nonce|unapproved|moderation-hash)$/i;
const ACTION_PATHS = /\/(wp-login\.php|wp-admin\/|wp-cron\.php|xmlrpc\.php|wp-comments-post\.php)/i;
export function isActionUrl(url: string): boolean {
	try {
		const u = new URL(url);
		if (ACTION_PATHS.test(u.pathname)) return true;
		for (const k of u.searchParams.keys()) if (ACTION_PARAMS.test(k)) return true;
		return false;
	} catch {
		return false;
	}
}

export function matchesExclude(url: string, patterns: string[]): boolean {
	const path = new URL(url).pathname;
	return patterns.some((p) => path === p || path.startsWith(p.endsWith("/") ? p : `${p}/`) || path.startsWith(p));
}
