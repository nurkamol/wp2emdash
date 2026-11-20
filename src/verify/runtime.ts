/**
 * What a page actually does in a browser, beyond its HTML: which tracker scripts and hits go out, and which scripts the
 * page's own Content-Security-Policy blocks. Added after a launched site carried its analytics IDs in the HTML (the
 * old check only looked for them there) while the CSP blocked the inline loader, so no analytics ran at all.
 */
import type { Browser } from "playwright";

export interface PageRuntime {
	/** Tracker script and hit URLs requested (query strings dropped). */
	trackers: string[];
	/** Console messages about CSP violations (first 200 chars each). */
	csp: string[];
}

const TRACKERS = /googletagmanager\.com|google-analytics\.com|analytics\.google\.com|cloudflareinsights\.com|connect\.facebook\.net|facebook\.com\/tr|clarity\.ms|hotjar\.com/;

export async function pageRuntime(browser: Browser, url: string, waitMs = 5000): Promise<PageRuntime> {
	const page = await browser.newPage();
	const trackers = new Set<string>();
	const csp: string[] = [];
	page.on("request", (r) => {
		const u = r.url();
		if (TRACKERS.test(u)) trackers.add(u.replace(/\?.*$/, ""));
	});
	const host = new URL(url).host;
	page.on("console", (m) => {
		const t = m.text();
		// Only the page's own policy: third-party iframes (Turnstile, booking embeds) log violations of their own CSP.
		const from = m.location().url;
		let sameHost = true;
		try {
			sameHost = !from || new URL(from).host === host;
		} catch {}
		if (sameHost && /Content Security Policy/i.test(t)) csp.push(t.slice(0, 200));
	});
	try {
		await page.goto(url, { waitUntil: "load", timeout: 45_000 });
		// The site's own consent banner (Privacy & consent) in opt-in: accept, as a visitor who agrees would — the
		// trackers must then load (src/verify/consent.ts checks that nothing loads before).
		const accept = page.locator("[data-consent-banner]:not([hidden]) [data-consent-accept]").first();
		await page.waitForTimeout(Math.min(waitMs, 1500));
		if (await accept.isVisible().catch(() => false)) await accept.click({ timeout: 3000 }).catch(() => {});
		await page.waitForTimeout(waitMs);
	} finally {
		await page.close();
	}
	return { trackers: [...trackers], csp };
}

/** The trackers a live page asks for (the JSON in its <meta name="site-analytics">, @wp2emdash/seo). */
export interface ExpectedTrackers {
	google: string[];
	gtm?: string | string[];
	cloudflare?: string;
	meta?: string[];
	clarity?: string;
	hotjar?: string;
}

/** Reads the loader's configuration from a page's HTML; undefined when the page loads no analytics. */
export function liveTrackers(html: string): ExpectedTrackers | undefined {
	const m = /<meta\s+name="site-analytics"\s+content="([^"]*)"/.exec(html) ?? /<meta\s+content="([^"]*)"\s+name="site-analytics"/.exec(html);
	if (!m?.[1]) return undefined;
	const text = m[1].replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
	try {
		const a = JSON.parse(text) as Record<string, unknown>;
		const strs = (v: unknown) => (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).filter((x): x is string => typeof x === "string");
		const cloudflare = strs(a.cloudflare ?? a.cloudflareToken)[0];
		const clarity = strs(a.clarity)[0];
		const hotjar = strs(a.hotjar)[0];
		return { google: strs(a.google), gtm: strs(a.gtm), meta: strs(a.meta), ...(cloudflare ? { cloudflare } : {}), ...(clarity ? { clarity } : {}), ...(hotjar ? { hotjar } : {}) };
	} catch {
		return undefined;
	}
}

const asList = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []);

/** What a check expects per service: the request that proves its loader ran. */
export const RUNTIME_EXPECTATIONS = [
	{ key: "google", label: "Google tag (gtag.js)", url: /googletagmanager\.com\/gtag\/js/ },
	{ key: "gtm", label: "Tag Manager (gtm.js)", url: /googletagmanager\.com\/gtm\.js/ },
	{ key: "meta", label: "Meta Pixel (fbevents.js)", url: /connect\.facebook\.net\/[^/]+\/fbevents\.js/ },
	{ key: "clarity", label: "Microsoft Clarity (clarity.ms tag)", url: /clarity\.ms\/tag\// },
	{ key: "hotjar", label: "Hotjar (hotjar script)", url: /static\.hotjar\.com\/c\/hotjar-/ },
	{ key: "cloudflare", label: "Cloudflare Web Analytics beacon", url: /static\.cloudflareinsights\.com\/beacon/ },
] as const;

/** The analytics problems for a live site: every switched-on service must have its loader requested, and nothing CSP-blocked. */
export function runtimeAnalyticsProblem(rt: PageRuntime, ids: ExpectedTrackers): string {
	const out: string[] = [];
	const want: Record<(typeof RUNTIME_EXPECTATIONS)[number]["key"], boolean> = { google: ids.google.length > 0, gtm: asList(ids.gtm).length > 0, meta: (ids.meta ?? []).length > 0, clarity: !!ids.clarity, hotjar: !!ids.hotjar, cloudflare: !!ids.cloudflare };
	for (const e of RUNTIME_EXPECTATIONS) if (want[e.key] && !rt.trackers.some((u) => e.url.test(u))) out.push(`${e.label} never requested`);
	if (rt.csp.length) out.push(`CSP blocked: ${rt.csp.slice(0, 2).join(" · ")}`);
	return out.join("; ");
}
