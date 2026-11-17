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

export function matchesExclude(url: string, patterns: string[]): boolean {
	const path = new URL(url).pathname;
	return patterns.some((p) => path === p || path.startsWith(p.endsWith("/") ? p : `${p}/`) || path.startsWith(p));
}
