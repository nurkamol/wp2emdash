/**
 * Search engines may index the live site: no `noindex` in the home page's robots meta or X-Robots-Tag, the canonical
 * link names the production host, robots.txt does not block everything and the sitemap answers with addresses.
 * The robots/sitemap parsers are the SEO suite's (`@wp2emdash/seo/site-checks`). Pure functions.
 */
import { parseRobots, sitemapLocs } from "@wp2emdash/seo/site-checks";
import type { Probe } from "../probe.js";
import type { CheckState } from "../store.js";
import { plural } from "../util.js";

export { sitemapLocs };

export interface HomeIndexing {
	noindex: string[];
	canonical?: string;
	canonicalOk: boolean;
}

/** Reads the home page: robots meta, X-Robots-Tag and the canonical link. */
export function homeIndexing(home: Probe, productionUrl: string): HomeIndexing {
	const html = home.html ?? "";
	const metas = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
	const robots = metas.filter((m) => /name=["'](?:robots|googlebot)["']/i.test(m)).map((m) => /content=["']([^"']*)["']/i.exec(m)?.[1] ?? "");
	const noindex = [...robots.filter((c) => /noindex/i.test(c)).map((c) => `robots meta "${c.slice(0, 60)}"`), ...(/noindex/i.test(home.xRobotsTag ?? "") ? [`X-Robots-Tag "${(home.xRobotsTag ?? "").slice(0, 60)}"`] : [])];
	const links = [...html.matchAll(/<link\b[^>]*>/gi)].map((m) => m[0]);
	const canonical = links.filter((l) => /rel=["']canonical["']/i.test(l)).map((l) => /href=["']([^"']+)["']/i.exec(l)?.[1])[0];
	const want = new URL(productionUrl).host;
	let canonicalOk = false;
	try {
		canonicalOk = !!canonical && new URL(canonical, productionUrl).host === want;
	} catch {}
	return { noindex, ...(canonical ? { canonical } : {}), canonicalOk };
}

export interface SiteFiles {
	robots: { status: number; blocksAll: boolean; sitemaps: number };
	sitemap: { status: number; urls: number };
}

export function parseSiteFiles(robots: Probe, sitemapStatus: number, locs: string[]): SiteFiles {
	const r = robots.status === 200 ? parseRobots(robots.html ?? "") : { blocksAll: false, sitemaps: [] };
	return { robots: { status: robots.status, blocksAll: r.blocksAll, sitemaps: r.sitemaps.length }, sitemap: { status: sitemapStatus, urls: locs.length } };
}

/** Sitemap <loc>s as paths on the production host (other hosts dropped), unique, at most `max`. */
export function sitemapPaths(locs: string[], productionUrl: string, max = 500): string[] {
	const host = new URL(productionUrl).host.replace(/^www\./, "");
	const out = new Set<string>();
	for (const l of locs) {
		try {
			const u = new URL(l, productionUrl);
			if (u.host.replace(/^www\./, "") === host) out.add(u.pathname);
		} catch {}
		if (out.size >= max) break;
	}
	return [...out];
}

export function indexabilityCheck(home: HomeIndexing | undefined, files: SiteFiles | undefined, homeStatus: number, at: string): CheckState {
	const problems: string[] = [];
	const notes: string[] = [];
	if (home?.noindex.length) problems.push(`the home page tells search engines not to index it (${home.noindex.join("; ")})`);
	if (files?.robots.blocksAll) problems.push("robots.txt blocks every search engine (Disallow: /)");
	if (files && files.sitemap.status !== 200) problems.push(`/sitemap.xml does not answer (HTTP ${files.sitemap.status || "none"})`);
	else if (files && !files.sitemap.urls) problems.push("/sitemap.xml lists no pages");
	if (home && !home.canonicalOk) notes.push(home.canonical ? `the home page names ${home.canonical} as its address (not the live domain)` : "the home page has no canonical link");
	if (files && files.robots.status !== 200) notes.push(`robots.txt does not answer (HTTP ${files.robots.status || "none"})`);
	const detail = [...(files ? [`Sitemap: ${plural(files.sitemap.urls, "address", "addresses")}.`] : []), ...notes.map((n) => `Note: ${n}.`)];
	if (homeStatus !== 200 && !files) return { status: "unknown", summary: "Not checked: the home page did not answer.", at };
	if (problems.length) return { status: "fail", summary: `Search engines are kept out: ${problems.join("; ")}.`, at, detail };
	if (notes.length) return { status: "warn", summary: `Indexable, with a note: ${notes[0]}.`, at, detail };
	return { status: "ok", summary: "Search engines may index the site; the sitemap answers.", at, detail };
}
