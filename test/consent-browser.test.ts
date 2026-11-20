/**
 * The consent banner in a real browser (Chromium via Playwright): the verify check (src/verify/consent.ts) against a
 * local page carrying the starter's real scripts and styles — no requests before consent, trackers after "Accept all"
 * — and the a11y pass (axe, src/verify/browser.ts) with the banner open. Third-party requests are answered locally.
 * Skipped when no Chromium is installed (`npx playwright install chromium`).
 */
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { type Browser, chromium } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultSettings, runtimeConsent } from "../packages/consent/src/settings.js";
import { LOG_PATH } from "../packages/consent/src/store.js";
import { accessibility } from "../src/verify/browser.js";
import { CONSENT_TRACKERS, consentProblem, consentRun } from "../src/verify/consent.js";

const ROOT = new URL("..", import.meta.url).pathname;
const style = /<style is:global>([\s\S]*?)<\/style>/.exec(readFileSync(join(ROOT, "starter/src/components/Consent.astro"), "utf8"))?.[1] ?? "";
const attr = (v: unknown) => JSON.stringify(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const services = { analytics: ["Google Analytics", "Microsoft Clarity"], marketing: ["Meta Pixel"], preferences: [], cookieless: [] };
const analytics = { google: ["G-ABC123DEF4"], gtm: [], meta: ["123456789012345"], clarity: "abcd1234ef", consent: true, banner: true };

function html(mode: "opt-in" | "notice"): string {
	const consent = runtimeConsent({ ...defaultSettings(), mode, policy: "/privacy-policy" }, services, { logUrl: LOG_PATH });
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fixture</title>
<meta name="site-consent" content="${attr(consent)}"><script src="/scripts/site-consent.js" defer></script>
<meta name="site-analytics" content="${attr(analytics)}"><script src="/scripts/site-analytics.js" defer></script>
<style>:root{--color-bg:#fbf8f3;--color-text:#2b2622;--color-line:rgb(43 38 34 / .14)}body{margin:0;background:var(--color-bg);color:var(--color-text);font-family:system-ui}.skip-link{position:absolute;top:-4rem}${style}</style></head>
<body><a href="#main" class="skip-link">Skip to content</a><header><nav aria-label="Main"><a href="/">Home</a></nav></header><main id="main" tabindex="-1"><h1>Fixture page</h1><p>Content.</p></main><footer class="site-footer"><p>© Acme</p></footer></body></html>`;
}

let server: Server;
let base = "";
let browser: Browser | undefined;

beforeAll(async () => {
	server = createServer((req, res) => {
		const u = new URL(req.url ?? "/", "http://x");
		if (u.pathname.startsWith("/scripts/")) {
			res.writeHead(200, { "content-type": "application/javascript" });
			res.end(readFileSync(join(ROOT, "starter/public", u.pathname)));
		} else if (u.pathname === "/_consent/region") {
			res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
			res.end('{"strict":true}');
		} else {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(html(u.searchParams.get("mode") === "notice" ? "notice" : "opt-in"));
		}
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	browser = await chromium.launch().catch(() => undefined);
}, 30_000);

afterAll(async () => {
	await browser?.close();
	await new Promise((r) => server.close(r));
});

const thirdParty = (u: URL) => CONSENT_TRACKERS.test(u.href);

describe("consent banner in Chromium", () => {
	it("opt-in: no analytics or marketing request before interaction; Accept all starts them", async (t) => {
		if (!browser) return t.skip();
		const r = await consentRun(browser, `${base}/`, { waitMs: 800, route: thirdParty });
		expect(r).toMatchObject({ banner: true, style: "strict", shown: true, before: [] });
		expect(r.after).toEqual(expect.arrayContaining(["https://www.googletagmanager.com/gtag/js", "https://connect.facebook.net/en_US/fbevents.js", "https://www.clarity.ms/tag/abcd1234ef"]));
		expect(consentProblem(r, true)).toMatchObject({ applies: true, problem: "" });
	}, 30_000);
	it("notice: trackers start at once — the opt-in gate reports it does not apply instead of passing", async (t) => {
		if (!browser) return t.skip();
		const r = await consentRun(browser, `${base}/?mode=notice`, { waitMs: 800, route: thirdParty });
		expect(r.before.length).toBeGreaterThan(0);
		expect(consentProblem(r, true).applies).toBe(false);
	}, 30_000);
	it("a gate failure names what was requested before consent", () => {
		expect(consentProblem({ banner: true, style: "strict", shown: true, before: ["https://connect.facebook.net/en_US/fbevents.js"], after: [] }, true).problem).toContain("requested before consent: https://connect.facebook.net");
	});
	it("axe (the verify a11y pass) finds no serious or critical issue with the banner open", async (t) => {
		if (!browser) return t.skip();
		const a = await accessibility(browser, `${base}/`);
		expect(a.error).toBeUndefined();
		expect(a.serious).toEqual([]);
	}, 60_000);
	it("keyboard: Tab from the skip link reaches the banner first; Enter on Reject closes it and the footer link reopens it", async (t) => {
		if (!browser) return t.skip();
		const page = await browser.newPage();
		await page.route(thirdParty, (r) => r.fulfill({ status: 200, body: "" }));
		await page.goto(`${base}/`);
		await page.waitForSelector("[data-consent-banner]:not([hidden])");
		await page.keyboard.press("Tab"); // skip link
		await page.keyboard.press("Tab"); // the banner's privacy policy link
		expect(await page.evaluate(() => [document.activeElement?.closest("[data-consent-banner]") !== null, document.activeElement?.getAttribute("href")])).toEqual([true, "/privacy-policy"]);
		await page.keyboard.press("Tab");
		expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-consent-accept"))).toBe(true);
		await page.keyboard.press("Tab");
		expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-consent-reject"))).toBe(true);
		await page.keyboard.press("Enter");
		expect(await page.locator("[data-consent-banner]").isHidden()).toBe(true);
		await page.locator("[data-consent-open]").click();
		expect(await page.evaluate(() => document.activeElement?.id)).toBe("consent-title");
		// The choices (checkboxes, descriptions, GPC note) pass axe too.
		await page.addScriptTag({ content: readFileSync(join(ROOT, "node_modules/axe-core/axe.min.js"), "utf8") });
		const v = (await page.evaluate(async () => (window as unknown as { axe: { run(c: unknown, o: unknown): Promise<{ violations: { id: string; impact: string }[] }> } }).axe.run("[data-consent-banner]", { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } }))).violations;
		expect(v.filter((x) => x.impact === "serious" || x.impact === "critical")).toEqual([]);
		await page.close();
	}, 30_000);
});
