/** Whole-site checks a search engine sees first: robots.txt, the sitemap, the home page. Parsers are pure. */
import type { Check } from "./analyze.js";

export function parseRobots(text: string): { blocksAll: boolean; sitemaps: string[] } {
	const lines = text.split(/\r?\n/).map((l) => l.replace(/#.*/, "").trim()).filter(Boolean);
	let star = false;
	let blocksAll = false;
	const sitemaps: string[] = [];
	for (const l of lines) {
		const [k, ...rest] = l.split(":");
		const key = (k ?? "").trim().toLowerCase();
		const v = rest.join(":").trim();
		if (key === "user-agent") star = v === "*";
		else if (key === "disallow" && star && v === "/") blocksAll = true;
		else if (key === "sitemap") sitemaps.push(v);
	}
	return { blocksAll, sitemaps };
}

/** <loc> entries of a sitemap or sitemap index. */
export const sitemapLocs = (xml: string) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => m[1] as string);

export async function siteChecks(origin: string, productionUrl: string, publishedPaths: string[], fetcher: typeof fetch = fetch): Promise<Check[]> {
	const checks: Check[] = [];
	const add = (id: string, label: string, status: Check["status"], detail: string) => checks.push({ id, label, status, detail });
	const prodOrigin = URL.canParse(productionUrl) ? new URL(productionUrl).origin : productionUrl;
	const isProduction = origin === prodOrigin;
	if (!isProduction) add("environment", "This address", "info", `${new URL(origin).host} is not the live address (${new URL(prodOrigin).host}): search engines are kept out of it on purpose. These checks describe this copy of the site.`);
	const get = async (path: string) => {
		try {
			const r = await fetcher(new URL(path, origin).toString(), { redirect: "manual" });
			return { status: r.status, text: r.status === 200 ? await r.text() : "", headers: r.headers };
		} catch (e) {
			return { status: 0, text: "", headers: new Headers(), error: (e as Error).message };
		}
	};
	const [robots, sitemap, home] = await Promise.all([get("/robots.txt"), get("/sitemap.xml"), get("/")]);
	// robots.txt
	if (robots.status !== 200) add("robots", "robots.txt", "bad", `Not found (HTTP ${robots.status}).`);
	else {
		const r = parseRobots(robots.text);
		if (r.blocksAll) add("robots", "robots.txt", isProduction ? "bad" : "info", isProduction ? "Blocks every search engine (Disallow: /)." : "Blocks search engines here, as intended for a non-live address.");
		else add("robots", "robots.txt", r.sitemaps.length ? "good" : "warn", r.sitemaps.length ? `Allows crawling and points to ${r.sitemaps.length} sitemap${r.sitemaps.length === 1 ? "" : "s"}.` : "Allows crawling but does not name the sitemap.");
	}
	// Sitemap: every published page listed
	if (sitemap.status !== 200) add("sitemap", "Sitemap", "bad", `/sitemap.xml not found (HTTP ${sitemap.status}).`);
	else {
		let locs = sitemapLocs(sitemap.text);
		if (/<sitemapindex/i.test(sitemap.text)) {
			const children = await Promise.all(locs.slice(0, 20).map((u) => get(new URL(u).pathname)));
			// The media sitemap lists pages again (with their pictures and videos): each address once.
			locs = [...new Set(children.flatMap((c) => sitemapLocs(c.text)))];
		}
		const paths = new Set(locs.map((u) => (URL.canParse(u) ? new URL(u).pathname : u)));
		const missing = publishedPaths.filter((p) => !paths.has(p));
		add("sitemap", "Sitemap", missing.length ? "warn" : "good", missing.length ? `${locs.length} addresses; not listed: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}.` : `${locs.length} addresses, every published page included.`);
	}
	// Home page indexability
	if (home.status !== 200) add("home", "Home page", "bad", `HTTP ${home.status}.`);
	else {
		const robotsMeta = /<meta[^>]+name=["']robots["'][^>]*content=["']([^"']*)["']/i.exec(home.text)?.[1] ?? "";
		const header = home.headers.get("x-robots-tag") ?? "";
		const noindex = /noindex/i.test(`${robotsMeta} ${header}`);
		if (noindex) add("home", "Home page in Google", isProduction ? "bad" : "info", isProduction ? "Marked noindex: the site will drop out of Google." : "Marked noindex here, as intended for a non-live address.");
		else add("home", "Home page in Google", "good", "Indexable.");
		const canonical = /<link[^>]+rel=["']canonical["'][^>]*href=["']([^"']+)["']/i.exec(home.text)?.[1];
		add("canonical-host", "Canonical address", canonical?.startsWith(prodOrigin) ? "good" : "warn", canonical ? `Pages name ${new URL(canonical).host} as their address.` : "The home page has no canonical link.");
		const ld = (home.text.match(/<script[^>]+application\/ld\+json/gi) ?? []).length;
		add("structured-data", "Structured data", ld ? "good" : "warn", ld ? `${ld} JSON-LD block${ld === 1 ? "" : "s"} on the home page (business details for Google).` : "None on the home page.");
	}
	return checks;
}
