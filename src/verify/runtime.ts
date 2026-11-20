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

const TRACKERS = /googletagmanager\.com|google-analytics\.com|analytics\.google\.com|cloudflareinsights\.com/;

export async function pageRuntime(browser: Browser, url: string, waitMs = 5000): Promise<PageRuntime> {
	const page = await browser.newPage();
	const trackers = new Set<string>();
	const csp: string[] = [];
	page.on("request", (r) => {
		const u = r.url();
		if (TRACKERS.test(u)) trackers.add(u.replace(/\?.*$/, ""));
	});
	page.on("console", (m) => {
		const t = m.text();
		if (/Content Security Policy/i.test(t)) csp.push(t.slice(0, 200));
	});
	try {
		await page.goto(url, { waitUntil: "load", timeout: 45_000 });
		await page.waitForTimeout(waitMs);
	} finally {
		await page.close();
	}
	return { trackers: [...trackers], csp };
}

/** The analytics problems for a live site: every carried id must have its loader requested, and nothing CSP-blocked. */
export function runtimeAnalyticsProblem(rt: PageRuntime, ids: { google: string[]; gtm?: string }): string {
	const out: string[] = [];
	if (ids.google.length && !rt.trackers.some((u) => /googletagmanager\.com\/gtag\/js/.test(u))) out.push("Google tag (gtag.js) never requested");
	if (ids.gtm && !rt.trackers.some((u) => /googletagmanager\.com\/gtm\.js/.test(u))) out.push("Tag Manager (gtm.js) never requested");
	if (rt.csp.length) out.push(`CSP blocked: ${rt.csp.slice(0, 2).join(" · ")}`);
	return out.join("; ");
}
