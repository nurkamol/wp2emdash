/**
 * The consent banner in a real browser (Privacy & consent, @wp2emdash/consent): with the banner asking for opt-in,
 * no analytics or marketing request may leave the page before the visitor interacts, and "Accept all" must start
 * them. Cloudflare Web Analytics (cookieless) is allowed throughout. A fresh browser context per run: no stored choice.
 *
 * In mode "auto" the rule depends on where the request comes from (Cloudflare geolocation of the machine running
 * verify): from a notice region the opt-in check does not apply and is reported as such, never as passed.
 */
import type { Browser } from "playwright";

/** Requests that store or send data about the visitor (Cloudflare's cookieless beacon is not one of them). */
export const CONSENT_TRACKERS = /googletagmanager\.com|google-analytics\.com|analytics\.google\.com|googleadservices\.com|doubleclick\.net|connect\.facebook\.net|facebook\.com\/tr|clarity\.ms|hotjar\.(?:com|io)|embed\.tawk\.to|client\.crisp\.chat|widget\.intercom\.io|js\.hs-scripts\.com|elfsightcdn\.com|cdn\.trustindex\.io/;

export interface ConsentRun {
	/** The page carries the built-in banner (<meta name="site-consent">). */
	banner: boolean;
	/** The banner's style once settled: "strict" (opt-in), "notice", "pending" (auto, no region answer). */
	style?: string;
	/** Tracker requests before any interaction / after "Accept all" (query strings dropped). */
	before: string[];
	after: string[];
	/** The banner was visible and reachable (its Accept button could be clicked). */
	shown: boolean;
	error?: string;
}

export async function consentRun(browser: Browser, url: string, o: { waitMs?: number; route?: (url: URL) => boolean } = {}): Promise<ConsentRun> {
	const waitMs = o.waitMs ?? 4000;
	const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
	const page = await ctx.newPage();
	const before = new Set<string>();
	const after = new Set<string>();
	let clicked = false;
	page.on("request", (r) => {
		const u = r.url();
		if (CONSENT_TRACKERS.test(u)) (clicked ? after : before).add(u.replace(/\?.*$/, ""));
	});
	// Tests: answer third-party requests locally (no network) — the request itself is what is measured.
	if (o.route) await ctx.route(o.route, (r) => r.fulfill({ status: 200, contentType: "application/javascript", body: "" }));
	try {
		await page.goto(url, { waitUntil: "load", timeout: 45_000 });
		await page.waitForTimeout(waitMs);
		const banner = (await page.locator('meta[name="site-consent"]').count()) > 0;
		const style = await page.evaluate(() => (window as unknown as { siteConsent?: { state(): { style: string } } }).siteConsent?.state().style).catch(() => undefined);
		const accept = page.locator("[data-consent-banner]:not([hidden]) [data-consent-accept]").first();
		const shown = await accept.isVisible().catch(() => false);
		if (shown) {
			clicked = true;
			await accept.click({ timeout: 3000 });
			await page.waitForTimeout(waitMs);
		}
		return { banner, ...(style ? { style } : {}), before: [...before], after: [...after], shown };
	} catch (e) {
		return { banner: false, before: [...before], after: [...after], shown: false, error: (e as Error).message.split("\n")[0] };
	} finally {
		await ctx.close();
	}
}

/**
 * The gate's verdict. `expectTrackers`: the page loads at least one service that needs consent (else accepting has
 * nothing to start). Returns { applies: false } when the banner does not ask for opt-in from this machine.
 */
export function consentProblem(r: ConsentRun, expectTrackers: boolean): { applies: boolean; problem: string; detail: string } {
	if (r.error) return { applies: true, problem: `page could not be checked: ${r.error}`, detail: "" };
	if (!r.banner) return { applies: false, problem: "", detail: "no built-in banner on the page" };
	if (r.style !== "strict") return { applies: false, problem: "", detail: `banner in ${r.style ?? "unknown"} style from this machine's region (opt-in not checked)` };
	const out: string[] = [];
	if (r.before.length) out.push(`requested before consent: ${r.before.slice(0, 4).join(", ")}`);
	if (!r.shown) out.push("banner not visible (Accept all not reachable)");
	else if (expectTrackers && !r.after.length) out.push("nothing started after Accept all");
	return { applies: true, problem: out.join("; "), detail: `none before consent; after Accept all: ${r.after.map((u) => new URL(u).host).filter((h, i, a) => a.indexOf(h) === i).join(", ") || "—"}` };
}
