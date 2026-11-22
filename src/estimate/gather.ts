/**
 * Read a prospect's public site politely and turn it into Detections, reusing the audit's discovery, page parser,
 * fingerprint, integrations scan and Store API reader. GET/HEAD only, robots.txt respected (product token
 * "wp2emdash"), a generic user agent, ≤ 4 requests at a time, a capped URL list and a small fetched sample.
 */
import { isContentForm } from "../audit/page.js";
import type { Reporter } from "../core/progress.js";
import { discoverSitemaps, restCounts } from "../audit/discover.js";
import { fingerprint } from "../audit/fingerprint.js";
import { fetchUrl, mapLimit } from "../audit/http.js";
import { scanIntegrations } from "../audit/integrations.js";
import { type PageSnapshot, parsePage } from "../audit/page.js";
import { readStoreApi } from "../audit/shop.js";
import { isActionUrl, isInternal, looksLikeAsset, normalizeUrl, siteHosts } from "../audit/urls.js";
import { robotsAllows, robotsCrawlDelay } from "./robots.js";
import type { EstimateRules } from "./rules.js";
import { measurePage, sizeResources } from "./speed.js";
import type { Detections, PageSpeed } from "./types.js";

export const ESTIMATE_USER_AGENT = "Mozilla/5.0 (compatible; wp2emdash-estimate/1.0; read-only public site check)";

const PRIORITY = /\/(contact|book|booking|appointments?|schedule|shop|store|products?|cart|donate|members?|membership|login|account|my-account|courses?|events?|services?|pricing|about)(\/|$)/i;
const ARCHIVE = /\/(category|tag|author|page|feed|attachment)\//i;

const segments = (url: string) => new URL(url).pathname.split("/").filter(Boolean);

/** Page / post / archive guess from an address (used when the REST API is closed). Pure. */
export function classifyUrl(url: string): "page" | "post" | "archive" {
	const path = new URL(url).pathname;
	if (ARCHIVE.test(path) || /^\/\d{4}\/(\d{2}\/)?$/.test(path)) return "archive";
	if (/^\/\d{4}\/\d{2}\//.test(path)) return "post";
	const seg = segments(url);
	if (seg.length >= 2 && /^(blog|news|articles?|posts?|insights|journal|stories)$/i.test(seg[0] as string)) return "post";
	return "page";
}

/**
 * Next pages to fetch: the home page, then pages that reveal scope (contact, booking, shop, account …), then one per
 * top-level section, shortest addresses first, round-robin. Archives last. Pure.
 */
export function pickSample(candidates: string[], visited: Set<string>, n: number): string[] {
	const open = [...new Set(candidates)].filter((u) => !visited.has(u));
	const out: string[] = [];
	const take = (u: string) => {
		if (out.length < n && !out.includes(u)) out.push(u);
	};
	const byLength = (a: string, b: string) => a.length - b.length || a.localeCompare(b);
	for (const u of open) if (new URL(u).pathname === "/") take(u);
	for (const u of open.filter((x) => PRIORITY.test(new URL(x).pathname) && classifyUrl(x) !== "archive").sort(byLength).slice(0, Math.ceil(n / 2))) take(u);
	const groups = new Map<string, string[]>();
	for (const u of open.filter((x) => classifyUrl(x) !== "archive").sort(byLength)) {
		const key = segments(u)[0] ?? "";
		groups.set(key, [...(groups.get(key) ?? []), u]);
	}
	const lists = [...groups.values()];
	for (let i = 0; out.length < n && lists.some((l) => l.length > i); i++) for (const l of lists) if (l[i]) take(l[i] as string);
	for (const u of open.sort(byLength)) take(u);
	return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface GatherResult {
	detections: Detections;
	speedPages: PageSpeed[];
}

export async function gather(input: string, rules: EstimateRules, reporter: Reporter, now = new Date()): Promise<GatherResult> {
	const start = new URL(/^https?:\/\//i.test(input) ? input : `https://${input}`);
	// Follow the home page's redirect (http → https, apex → www) so every address is on the host the site serves.
	const http = { userAgent: ESTIMATE_USER_AGENT, retries: 1, timeoutMs: 20_000 };
	const first = await fetchUrl(`${start.origin}/`, http);
	const origin = first.status ? new URL(first.finalUrl).origin : start.origin;
	const site = siteHosts(origin);
	const c = rules.crawl;

	reporter.emit({ type: "step:start", step: "robots.txt" });
	const robotsRes = await fetchUrl(`${origin}/robots.txt`, http);
	const robotsTxt = robotsRes.status === 200 && !/text\/html/.test(robotsRes.contentType) ? robotsRes.body : undefined;
	const allow = (u: string) => robotsAllows(robotsTxt, u);
	const delay = robotsCrawlDelay(robotsTxt);
	const honoured = delay !== undefined ? Math.min(delay, c.maxCrawlDelaySeconds) : 0;
	const concurrency = honoured > 0 ? 1 : c.concurrency;
	const maxSample = delay !== undefined && delay > c.maxCrawlDelaySeconds ? Math.min(c.maxSample, 5) : c.maxSample;
	let blocked = 0;
	const polite = async <T>(fn: () => Promise<T>) => {
		const r = await fn();
		if (honoured) await sleep(honoured * 1000);
		return r;
	};
	reporter.emit({ type: "step:end", step: "robots.txt", ok: true, detail: robotsTxt ? `found${delay !== undefined ? `, Crawl-delay ${delay}s` : ""}` : "none" });

	// Discovery: sitemaps (capped) and REST counts (a few requests, nothing paged).
	const sm = await discoverSitemaps(site, reporter, { robotsTxt: robotsTxt ?? null, maxSitemaps: c.maxSitemaps, maxUrls: c.maxDiscovered * 4, allow, http });
	reporter.emit({ type: "step:start", step: "REST counts" });
	const rest = await restCounts(site, http, allow);
	reporter.emit({ type: "step:end", step: "REST counts", ok: true, detail: rest.restAvailable ? rest.types.map((t) => `${t.slug} ${t.count}`).join(", ") || "no public types" : "REST API not public" });

	const discovered = new Set<string>();
	let capped = false;
	const seed = (u: string) => {
		if (!isInternal(u, site) || looksLikeAsset(u) || isActionUrl(u) || /\/wp-(content|admin|json)\//.test(u)) return;
		const key = normalizeUrl(u, site);
		if (discovered.has(key)) return;
		if (!allow(key)) {
			blocked++;
			return;
		}
		if (discovered.size >= c.maxDiscovered) {
			capped = true;
			return;
		}
		discovered.add(key);
	};
	seed(`${origin}/`);
	for (const u of sm.sitemapUrls.keys()) seed(u);
	const sitemapKeys = new Set(sm.sitemapUrls.keys());
	const homeKeyEarly = normalizeUrl(`${origin}/`, site);
	if (sm.sitemapUrls.size > c.maxDiscovered) capped = true;

	// Sample: fetch in small rounds, re-ranking as links reveal more of the site.
	reporter.emit({ type: "step:start", step: "Sample pages", total: maxSample });
	const visited = new Set<string>();
	const snapshots: PageSnapshot[] = [];
	const statuses = new Map<string, number>();
	const htmlSamples: string[] = [];
	// Until maxSample pages are read; addresses that turn out to be redirects or files do not count, but at most
	// twice that many requests are made.
	while (snapshots.length < maxSample && visited.size < maxSample * 2) {
		// Sitemap addresses first (the pages the site itself lists); link-only ones (short links, odd paths) fill up.
		const n = Math.min(concurrency * 2, maxSample - snapshots.length, maxSample * 2 - visited.size);
		const listed = pickSample([...discovered].filter((u) => sitemapKeys.has(u) || u === homeKeyEarly), visited, n);
		const batch = listed.length >= n ? listed : [...listed, ...pickSample([...discovered], new Set([...visited, ...listed]), n - listed.length)];
		if (!batch.length) break;
		for (const u of batch) visited.add(u);
		await mapLimit(batch, concurrency, (url) =>
			polite(async () => {
				const r = await fetchUrl(url, http);
				// A redirect off the site (short links, old domains) is not a page of this site.
				const offSite = r.redirects.length > 0 && !isInternal(r.finalUrl, site);
				// Redirected addresses (attachment pages → files, short links) are recorded with their redirect status.
				statuses.set(url, r.redirects.length ? (r.redirects[0]?.status ?? 301) : r.status);
				if (!offSite && r.status === 200 && /text\/html|application\/xhtml/.test(r.contentType)) {
					const page = parsePage(r.body, { url, finalUrl: r.finalUrl, status: r.status, redirects: r.redirects, contentType: r.contentType, ms: r.ms }, site);
					snapshots.push(page);
					if (htmlSamples.length < 5) htmlSamples.push(r.body);
					for (const l of page.links) if (l.internal) seed(l.href);
				}
				reporter.emit({ type: "step:progress", step: "Sample pages", done: snapshots.length, total: maxSample, item: new URL(url).pathname });
			}),
		);
	}
	reporter.emit({ type: "step:end", step: "Sample pages", ok: snapshots.length > 0, detail: `${snapshots.length} page(s) read of ${discovered.size}${capped ? "+" : ""} found` });

	// Fingerprint, integrations, shop.
	const fp = fingerprint(snapshots, rest.restNamespaces, htmlSamples);
	const integrations = scanIntegrations(snapshots);
	const woo = fp.plugins.some((p) => p.slug === "woocommerce" || p.slug === "wc");
	const storeUrl = `${origin}/wp-json/wc/store/v1/products`;
	const shop = woo && allow(storeUrl) ? await readStoreApi(origin, (u) => fetchUrl(u, { ...http, headers: { Accept: "application/json" } }), fp.plugins.map((p) => p.slug), 1) : undefined;

	// Languages on this host (directory or content mode) are migrated with the site; alternates on other hosts
	// (subdomains, other domains) are separate sites and only counted.
	const langs = new Set<string>();
	const otherHostLangs = new Set<string>();
	const ownHost = new URL(origin).hostname;
	for (const p of snapshots)
		for (const h of p.seo.hreflang) {
			if (!h.lang || h.lang.toLowerCase() === "x-default") continue;
			let host = "";
			try {
				host = new URL(h.href, origin).hostname;
			} catch {
				continue;
			}
			(host === ownHost ? langs : otherHostLangs).add(h.lang);
		}
	const mlPlugin = fp.plugins.find((p) => /^(sitepress-multilingual-cms|polylang|translatepress-multilingual|weglot)$/.test(p.slug))?.name;
	const allImages = snapshots.flatMap((p) => [...p.images.map((i) => i.src), ...p.backgroundImages]);
	const accountLinks = [...new Set(snapshots.flatMap((p) => p.links.filter((l) => l.internal && /\/(my-account|account|login|log-in|sign-in|register|members?-area|wp-login\.php)(\/|$|\?)/i.test(new URL(l.href).pathname)).map((l) => new URL(l.href).pathname)))];
	const homeKey = normalizeUrl(`${origin}/`, site);
	const allHtml = htmlSamples.join("\n");
	const urlKinds = [...discovered].map(classifyUrl);

	const detections: Detections = {
		url: start.href,
		origin,
		host: new URL(origin).hostname,
		at: now.toISOString(),
		homeStatus: first.status,
		isWordPress: !!fp.generator?.match(/wordpress/i) || /\/wp-(content|includes)\//.test(allHtml) || rest.restNamespaces.includes("wp/v2") || fp.hiddenWpPaths,
		...(fp.wordpressVersion ? { wordpressVersion: fp.wordpressVersion } : {}),
		...(rest.siteName ? { siteName: rest.siteName } : {}),
		...((fp.childTheme ?? fp.parentTheme) ? { theme: fp.childTheme ?? fp.parentTheme } : {}),
		robots: { present: !!robotsTxt, ...(delay !== undefined ? { crawlDelay: delay } : {}), blocked },
		sitemaps: sm.sitemaps.length,
		restAvailable: rest.restAvailable,
		restNamespaces: rest.restNamespaces,
		types: rest.types.map((t) => ({ slug: t.slug, count: t.count })),
		...(rest.media !== undefined ? { media: rest.media } : {}),
		terms: rest.terms.reduce((a, t) => a + t.count, 0),
		discovered: discovered.size,
		discoveredCapped: capped,
		urlGuess: { pages: urlKinds.filter((k) => k === "page").length, posts: urlKinds.filter((k) => k === "post").length, archives: urlKinds.filter((k) => k === "archive").length },
		sample: [...visited].map((url) => {
			const s = snapshots.find((p) => p.url === url);
			return { url, status: statuses.get(url) ?? 0, builders: s?.builders ?? [], forms: s?.forms.filter((f) => isContentForm(f.provider)).length ?? 0, words: s?.wordCount ?? 0, passwordField: !!s?.forms.some((f) => f.fields.some((x) => x.type === "password")) };
		}),
		builders: fp.builders,
		plugins: fp.plugins,
		hiddenWpPaths: fp.hiddenWpPaths,
		// Page lists trimmed (counts, not a site map); mailto/tel links left out (they can name people).
		integrations: integrations.filter((i) => i.kind !== "contact-link").map((i) => ({ ...i, pages: i.pages.slice(0, 5) })),
		...(shop ? { shop } : {}),
		multilingual: { ...(mlPlugin ? { plugin: mlPlugin } : {}), languages: [...langs].sort(), otherHosts: [...otherHostLangs].filter((l) => !langs.has(l)).length },
		multisite: allImages.some((u) => /\/wp-content\/uploads\/sites\/\d+\//.test(u)),
		accounts: { loginForms: snapshots.filter((p) => p.forms.some((f) => f.fields.some((x) => x.type === "password"))).length, accountLinks },
	};

	// Speed: the home page and two more pages from different sections, measured on their own.
	reporter.emit({ type: "step:start", step: "Speed" });
	const okPages = snapshots.filter((p) => p.status === 200 && p.url !== homeKey);
	const others: string[] = [];
	for (const p of okPages.sort((a, b) => a.url.length - b.url.length)) {
		if (others.length >= 2) break;
		if (!others.some((o) => segments(o)[0] === segments(p.url)[0])) others.push(p.url);
	}
	for (const p of okPages) if (others.length < 2 && !others.includes(p.url)) others.push(p.url);
	const targets = [homeKey, ...others].filter(allow);
	const speedPages: PageSpeed[] = [];
	for (const u of targets) speedPages.push((await polite(() => measurePage(u, { userAgent: ESTIMATE_USER_AGENT }))).speed);
	await sizeResources(speedPages, { userAgent: ESTIMATE_USER_AGENT, max: c.maxResourceChecks, concurrency, allow: (u) => !isInternal(u, site) || allow(u) });
	reporter.emit({ type: "step:end", step: "Speed", ok: speedPages.some((p) => !p.error), detail: speedPages.map((p) => `${new URL(p.url).pathname} ${p.ttfbMs ?? "?"} ms`).join(", ") });

	return { detections, speedPages };
}
