import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { consentPlugin } from "../packages/consent/src/index.js";
import { adminRoute, createPlugin, siteServices } from "../packages/consent/src/plugin/index.js";
import { page as adminPage } from "../packages/consent/src/plugin/views.js";
import { REGION_HEADERS, regionAnswer, STRICT_COUNTRIES, strictRegion } from "../packages/consent/src/region.js";
import { DEFAULT_TEXT, defaultSettings, needsConsent, parseSettings, plain, policyPath, runtimeConsent, servicesOf, settingsFromForm, TRACKER_CATEGORY } from "../packages/consent/src/settings.js";
import { countChoice, KV_KEY, LOG_PATH, OPTION_NAME, pruneStats, readStats, readStoredConsent } from "../packages/consent/src/store.js";
import { TRACKER_TYPES } from "../packages/seo/src/analytics/trackers.js";
import { consentScaffold } from "../src/scaffold/consent.js";
import { type ClientRepoInput, clientRepoFiles } from "../src/scaffold/client-repo.js";
import { consentReport, planConsent } from "../src/transform/consent.js";
import { type Browser, page, starterScript } from "./consent-dom.js";

const ROOT = new URL("..", import.meta.url).pathname;
const starter = (p: string) => readFileSync(join(ROOT, "starter", p), "utf8");
const CONSENT = starterScript("site-consent.js");
const ANALYTICS = starterScript("site-analytics.js");
const WIDGETS = starterScript("site-widgets.js");

const services = { analytics: ["Google Analytics", "Microsoft Clarity"], marketing: ["Meta Pixel"], preferences: ["Tawk.to chat"], cookieless: ["Cloudflare Web Analytics"] };
const rc = (mode: "notice" | "opt-in" | "auto", extra: Record<string, unknown> = {}) => ({ ...runtimeConsent({ ...defaultSettings(), mode, policy: "/privacy-policy" }, services, { logUrl: LOG_PATH }), ...extra });
const trackers = { google: ["G-ABC123DEF4", "AW-123456789"], gtm: [], meta: ["123456789012345"], clarity: "abcd1234ef", hotjar: "3456789", cloudflare: "0123456789abcdef0123456789abcdef", consent: true, banner: true };
const srcs = (b: Browser) => b.doc.added.map((e) => e.src).filter(Boolean);
const dl = (b: Browser) => (b.window.dataLayer ?? []).map((x: any) => (x && typeof x.length === "number" && typeof x !== "string" ? [...x] : x));
const load = (o: Parameters<typeof page>[0]) => {
	const b = page(o);
	b.run(CONSENT);
	if (o.widgets !== undefined) b.run(WIDGETS);
	if (o.analytics !== undefined) b.run(ANALYTICS);
	return b;
};

// ── State machine ────────────────────────────────────────────────────────────────────────────────────────────────
describe("banner state machine (site-consent.js decide)", () => {
	const decide = (() => {
		const b = load({ consent: rc("opt-in") });
		return b.window.siteConsent.decide as (m: string, r: string | undefined, s: unknown, g: boolean) => Record<string, unknown>;
	})();
	it("opt-in: nothing allowed, banner shown; notice: all on, banner shown; auto: pending until the region is known", () => {
		expect(decide("opt-in", undefined, undefined, false)).toEqual({ analytics: false, marketing: false, preferences: false, decided: false, style: "strict", show: true });
		expect(decide("notice", undefined, undefined, false)).toEqual({ analytics: true, marketing: true, preferences: true, decided: false, style: "notice", show: true });
		expect(decide("auto", undefined, undefined, false)).toMatchObject({ analytics: false, marketing: false, style: "pending", show: false });
		expect(decide("auto", "strict", undefined, false)).toMatchObject({ style: "strict", show: true, analytics: false });
		expect(decide("auto", "notice", undefined, false)).toMatchObject({ style: "notice", show: true, analytics: true });
	});
	it("a stored choice wins and hides the banner; Global Privacy Control keeps marketing off everywhere", () => {
		expect(decide("opt-in", undefined, { analytics: true, marketing: true, preferences: false }, false)).toEqual({ analytics: true, marketing: true, preferences: false, decided: true, style: "strict", show: false });
		expect(decide("opt-in", undefined, { analytics: true, marketing: true, preferences: true }, true).marketing).toBe(false);
		expect(decide("notice", undefined, undefined, true)).toMatchObject({ analytics: true, marketing: false, preferences: true });
	});
});

describe("banner in a page", () => {
	it("opt-in: shows an accessible, non-modal dialog first in the tab order, with equal Accept and Reject", () => {
		const b = load({ consent: rc("opt-in") });
		const box = b.doc.banner();
		expect(box?.hidden).toBe(false);
		expect(box?.attrs).toMatchObject({ role: "dialog", "aria-modal": "false", "aria-labelledby": "consent-title", "aria-describedby": "consent-desc" });
		// Right after "Skip to content".
		expect(b.doc.body.children.indexOf(box as never)).toBe(1);
		const accept = b.doc.find("data-consent-accept");
		const reject = b.doc.find("data-consent-reject");
		expect(accept?.attrs.class).toBe(reject?.attrs.class);
		expect(b.doc.find("data-consent-choose")?.attrs).toMatchObject({ "aria-expanded": "false", "aria-controls": "consent-panel" });
		// Policy link and category list (necessary always on, disabled).
		expect(box?.all().find((e) => e.tagName === "A")?.attrs.href).toBe("/privacy-policy");
		const necessary = b.doc.getElementById("consent-cat-necessary");
		expect([necessary?.checked, necessary?.disabled]).toEqual([true, true]);
		expect(b.doc.getElementById("consent-cat-analytics-desc")?.textContent).toContain("Google Analytics, Microsoft Clarity");
		// Page focus is not taken on load.
		expect(b.doc.activeElement).toBeNull();
	});
	it("footer gets a Cookie settings button; it reopens the choices with focus on the title, Escape returns focus", () => {
		const b = load({ consent: rc("opt-in") });
		b.doc.find("data-consent-reject")?.click();
		expect(b.doc.banner()?.hidden).toBe(true);
		const link = b.doc.body.querySelector("footer.site-footer")?.querySelector("[data-consent-open]");
		expect(link?.textContent).toBe(DEFAULT_TEXT.settings);
		link?.focus();
		link?.click();
		expect(b.doc.banner()?.hidden).toBe(false);
		expect(b.doc.activeElement).toBe(b.doc.getElementById("consent-title"));
		expect(b.doc.getElementById("consent-panel")?.hidden).toBe(false);
		b.doc.banner()?.keydown("Escape");
		expect(b.doc.banner()?.hidden).toBe(true);
		expect(b.doc.activeElement).toBe(link);
	});
	it("Escape on the first banner never decides: it only folds the choices away", () => {
		const b = load({ consent: rc("opt-in") });
		b.doc.find("data-consent-choose")?.click();
		expect(b.doc.getElementById("consent-panel")?.hidden).toBe(false);
		b.doc.banner()?.keydown("Escape");
		expect(b.doc.banner()?.hidden).toBe(false);
		expect(b.doc.getElementById("consent-panel")?.hidden).toBe(true);
		expect(b.storage.size).toBe(0);
	});
	it("stores version, revision, flags and time (localStorage + first-party cookie, no identifier); a new revision asks again", () => {
		const b = load({ consent: rc("opt-in") });
		b.doc.find("data-consent-choose")?.click();
		const analytics = b.doc.getElementById("consent-cat-analytics");
		if (analytics) analytics.checked = true;
		b.doc.find("data-consent-save")?.click();
		const rec = JSON.parse(b.storage.get("site-consent") ?? "{}");
		expect(rec).toMatchObject({ v: 1, rev: 1, a: true, m: false, p: false });
		expect(typeof rec.at).toBe("number");
		expect(b.doc.cookie).toMatch(/^site_consent=1\.1\.100\.[0-9a-z]+$/);
		// Next page: no banner, choice applied.
		const next = load({ consent: rc("opt-in"), storage: b.storage });
		expect(next.doc.banner()).toBeUndefined();
		expect(next.window.siteConsent.state()).toMatchObject({ analytics: true, marketing: false, decided: true });
		// Admin asked everyone again (revision 2).
		const again = load({ consent: rc("opt-in", { rev: 2 }), storage: b.storage });
		expect(again.doc.banner()?.hidden).toBe(false);
		// The cookie alone is enough (storage blocked or cleared).
		const cookieOnly = load({ consent: rc("opt-in"), cookie: b.doc.cookie });
		expect(cookieOnly.window.siteConsent.state()).toMatchObject({ analytics: true, decided: true });
	});
	it("a choice older than 180 days is asked again", () => {
		const storage = new Map([["site-consent", JSON.stringify({ v: 1, rev: 1, a: true, m: true, p: true, at: Date.now() - 181 * 86400000 })]]);
		expect(load({ consent: rc("opt-in"), storage }).doc.banner()?.hidden).toBe(false);
	});
	it("GPC: the marketing box is off and locked, and a note says why", () => {
		const b = load({ consent: rc("notice"), gpc: true });
		const m = b.doc.getElementById("consent-cat-marketing");
		expect([m?.checked, m?.disabled]).toEqual([false, true]);
		expect(b.doc.banner()?.text()).toContain("Global Privacy Control");
		b.doc.find("data-consent-accept")?.click();
		expect(JSON.parse(b.storage.get("site-consent") ?? "{}").m).toBe(false);
	});
	it("auto: asks /_consent/region without cookies, shows nothing while pending, caches the answer for the session; failure = opt-in", async () => {
		const eu = load({ consent: rc("auto"), region: { strict: true } });
		expect(eu.doc.banner()).toBeUndefined();
		expect(eu.fetches[0]).toMatchObject({ url: "/_consent/region", init: { credentials: "omit", cache: "no-store" } });
		await eu.flush();
		expect(eu.doc.banner()?.hidden).toBe(false);
		expect(eu.window.siteConsent.state()).toMatchObject({ style: "strict", analytics: false });
		expect(eu.session.get("site-consent-region")).toBe("strict");
		const us = load({ consent: rc("auto"), region: { strict: false } });
		await us.flush();
		expect(us.window.siteConsent.state()).toMatchObject({ style: "notice", analytics: true, marketing: true });
		const second = load({ consent: rc("auto"), session: us.session });
		expect(second.fetches).toEqual([]);
		expect(second.window.siteConsent.state().style).toBe("notice");
		const offline = load({ consent: rc("auto"), region: "fail" });
		await offline.flush();
		expect(offline.window.siteConsent.state().style).toBe("strict");
	});
	it("consent log: posts only the choice word when the log is on, never anything else", () => {
		const on = load({ consent: rc("opt-in", { log: LOG_PATH }) });
		on.doc.find("data-consent-accept")?.click();
		expect(on.fetches).toEqual([{ url: LOG_PATH, init: expect.objectContaining({ method: "POST", credentials: "omit", body: '{"choice":"accept"}' }) }]);
		const off = load({ consent: rc("opt-in") });
		off.doc.find("data-consent-reject")?.click();
		expect(off.fetches).toEqual([]);
		const evil = load({ consent: rc("opt-in", { log: "https://evil.example/collect" }) });
		evil.doc.find("data-consent-accept")?.click();
		expect(evil.fetches).toEqual([]);
	});
	it("an existing [data-consent-open] hook is used instead of adding a footer link; ?consent-preview=1 shows the banner anyway", () => {
		const b = page({ consent: rc("opt-in") });
		const own = b.doc.createElement("a");
		own.setAttribute("data-consent-open", "");
		b.doc.body.querySelector("footer.site-footer")?.appendChild(own);
		b.run(CONSENT);
		expect(b.doc.body.querySelectorAll("[data-consent-open]")).toHaveLength(1);
		const storage = new Map([["site-consent", JSON.stringify({ v: 1, rev: 1, a: false, m: false, p: false, at: Date.now() })]]);
		expect(load({ consent: rc("opt-in"), storage, search: "?consent-preview=1" }).doc.banner()?.hidden).toBe(false);
	});
	it("off, broken or missing settings: nothing happens", () => {
		for (const consent of [{ mode: "off" }, "{oops", { mode: "evil" }]) {
			const b = load({ consent });
			expect(b.window.siteConsent).toBeUndefined();
			expect(b.doc.added).toEqual([]);
		}
	});
	it("withdrawal clears tracker cookies; reloads only when a service without a consent API already runs", () => {
		const b = load({ consent: rc("notice"), cookie: "_ga=GA1.1.1; _fbp=fb.1; _clck=x; other=keep" });
		b.window.hj = () => {};
		b.doc.find("data-consent-reject")?.click();
		expect(b.doc.cookie).not.toMatch(/_ga=|_fbp=|_clck=/);
		expect(b.doc.cookie).toContain("other=keep");
		expect(b.reloads).toBe(1);
		const quiet = load({ consent: rc("notice") });
		quiet.doc.find("data-consent-reject")?.click();
		expect(quiet.reloads).toBe(0);
	});
	it("has no inline code path: textContent only, no innerHTML, eval or document.write", () => {
		expect(CONSENT).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function|document\.write/);
	});
});

// ── Consent Mode v2 and the trackers ─────────────────────────────────────────────────────────────────────────────
describe("analytics loader with the built-in banner", () => {
	it("opt-in, undecided: consent default denied first, and nothing is requested but the cookieless beacon", () => {
		const b = load({ consent: rc("opt-in"), analytics: trackers });
		expect(dl(b)[0]).toEqual(["consent", "default", { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "denied" }]);
		expect(srcs(b)).toEqual(["https://static.cloudflareinsights.com/beacon.min.js"]);
		expect(b.window.fbq).toBeUndefined();
		expect(b.window.clarity).toBeUndefined();
	});
	it("accept all: update granted before config, then gtag.js; Meta grant before init; Clarity consentv2; Hotjar", () => {
		const b = load({ consent: rc("opt-in"), analytics: trackers });
		b.doc.find("data-consent-accept")?.click();
		const q = dl(b);
		const iUpdate = q.findIndex((x: any) => x[0] === "consent" && x[1] === "update");
		const iConfig = q.findIndex((x: any) => x[0] === "config");
		expect(q[iUpdate]).toEqual(["consent", "update", { ad_storage: "granted", ad_user_data: "granted", ad_personalization: "granted", analytics_storage: "granted" }]);
		expect(iUpdate).toBeGreaterThan(0);
		expect(iConfig).toBeGreaterThan(iUpdate);
		expect(srcs(b)).toEqual(expect.arrayContaining(["https://www.googletagmanager.com/gtag/js?id=G-ABC123DEF4", "https://connect.facebook.net/en_US/fbevents.js", "https://www.clarity.ms/tag/abcd1234ef", "https://static.hotjar.com/c/hotjar-3456789.js?sv=6"]));
		expect(b.window.fbq.queue.map((x: any) => [...x])).toEqual([["consent", "grant"], ["init", "123456789012345"], ["track", "PageView"]]);
		expect(b.window.clarity.q.map((x: any) => [...x])).toContainEqual(["consentv2", { ad_Storage: "granted", analytics_Storage: "granted" }]);
	});
	it("analytics only: Google analytics_storage granted, ads denied; Meta never loads; Clarity told ads are denied", () => {
		const b = load({ consent: rc("opt-in"), analytics: trackers });
		b.doc.find("data-consent-choose")?.click();
		const a = b.doc.getElementById("consent-cat-analytics");
		if (a) a.checked = true;
		b.doc.find("data-consent-save")?.click();
		expect(dl(b).find((x: any) => x[0] === "consent" && x[1] === "update")[2]).toEqual({ ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "granted" });
		expect(srcs(b)).not.toContain("https://connect.facebook.net/en_US/fbevents.js");
		expect(b.window.clarity.q.map((x: any) => [...x])).toContainEqual(["consentv2", { ad_Storage: "denied", analytics_Storage: "granted" }]);
	});
	it("reject: nothing loads, no update granted", () => {
		const b = load({ consent: rc("opt-in"), analytics: trackers });
		b.doc.find("data-consent-reject")?.click();
		expect(srcs(b)).toEqual(["https://static.cloudflareinsights.com/beacon.min.js"]);
		expect(dl(b).filter((x: any) => x[0] === "consent" && x[1] === "update").every((x: any) => x[2].analytics_storage === "denied")).toBe(true);
	});
	it("notice: everything starts at once; opting out revokes Meta and Clarity and denies Google", () => {
		const b = load({ consent: rc("notice"), analytics: trackers });
		expect(srcs(b)).toContain("https://connect.facebook.net/en_US/fbevents.js");
		b.doc.find("data-consent-reject")?.click();
		expect(b.window.fbq.queue.map((x: any) => [...x]).at(-1)).toEqual(["consent", "revoke"]);
		expect(b.window.clarity.q.map((x: any) => [...x]).at(-1)).toEqual(["consent", false]);
		expect(dl(b).filter((x: any) => x[0] === "consent").at(-1)[2]).toEqual({ ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "denied" });
	});
	it("GPC in notice mode: analytics run, Meta does not, Google ads signals denied", () => {
		const b = load({ consent: rc("notice"), analytics: trackers, gpc: true });
		expect(srcs(b)).not.toContain("https://connect.facebook.net/en_US/fbevents.js");
		expect(srcs(b)).toContain("https://www.clarity.ms/tag/abcd1234ef");
		expect(dl(b).find((x: any) => x[1] === "update")[2]).toMatchObject({ ad_storage: "denied", analytics_storage: "granted" });
	});
	it("fails closed: banner flag set but the banner script missing → nothing that stores data", () => {
		const b = page({ analytics: trackers });
		b.run(ANALYTICS);
		expect(srcs(b)).toEqual(["https://static.cloudflareinsights.com/beacon.min.js"]);
		b.window.siteAnalytics.grantConsent();
		expect(srcs(b)).toEqual(["https://static.cloudflareinsights.com/beacon.min.js"]);
	});
	it("conversion events follow the choice", () => {
		const b = load({ consent: rc("opt-in"), analytics: { ...trackers, events: ["lead"] } });
		b.window.siteAnalytics.track("lead", "contact");
		expect(dl(b).some((x: any) => x[0] === "event")).toBe(false);
		b.doc.find("data-consent-accept")?.click();
		b.window.siteAnalytics.track("lead", "contact");
		expect(dl(b).filter((x: any) => x[0] === "event")).toHaveLength(1);
	});
});

describe("site widgets with the built-in banner", () => {
	const widgets = [{ provider: "tawkto", id: "0123456789abcdef01234567/1abcdefg" }, { provider: "cookieyes", id: "0123456789abcdef0123456789abcdef" }];
	it("the old consent tool is not loaded (one banner) and chat waits for preferences", () => {
		const b = load({ consent: rc("opt-in"), widgets });
		expect(srcs(b)).toEqual([]);
		b.doc.find("data-consent-accept")?.click();
		expect(srcs(b)).toEqual(["https://embed.tawk.to/0123456789abcdef01234567/1abcdefg"]);
	});
	it("without the banner: both load as before", () => {
		const b = page({ widgets });
		b.run(WIDGETS);
		expect(srcs(b)).toEqual(["https://embed.tawk.to/0123456789abcdef01234567/1abcdefg", "https://cdn-cookieyes.com/client_data/0123456789abcdef0123456789abcdef/script.js"]);
	});
});

// ── Region ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe("region rule (auto mode)", () => {
	it("opt-in for EU/EEA, UK, CH, Québec and unknown; notice elsewhere", () => {
		for (const c of ["DE", "FR", "IE", "NO", "IS", "LI", "GB", "CH", "de"]) expect(strictRegion(c)).toBe(true);
		for (const c of ["US", "CA", "AU", "BR", "JP"]) expect(strictRegion(c)).toBe(false);
		expect(strictRegion("CA", "QC")).toBe(true);
		for (const c of [undefined, "", "XX", "T1", "EUR", 42]) expect(strictRegion(c)).toBe(true);
		expect(STRICT_COUNTRIES).toHaveLength(32);
	});
	it("the endpoint answers one boolean from request.cf (CF-IPCountry as a fallback), never cached", () => {
		const h = (v?: string) => ({ get: (n: string) => (n === "cf-ipcountry" ? (v ?? null) : null) });
		expect(regionAnswer({ cf: { country: "US", regionCode: "TX", city: "Austin" }, headers: h() })).toEqual({ strict: false });
		expect(regionAnswer({ cf: { country: "CA", regionCode: "QC" }, headers: h() })).toEqual({ strict: true });
		expect(regionAnswer({ headers: h("US") })).toEqual({ strict: false });
		expect(regionAnswer({ headers: h() })).toEqual({ strict: true });
		expect(REGION_HEADERS["cache-control"]).toBe("no-store, private");
	});
	it("middleware answers /_consent/region before anything else and keeps it out of the route cache", () => {
		const mw = starter("src/middleware.ts");
		const i = mw.indexOf("context.url.pathname === REGION_PATH");
		expect(i).toBeGreaterThan(mw.indexOf("defineMiddleware(async"));
		expect(i).toBeLessThan(mw.indexOf("Production host policy"));
		expect(mw.slice(i, i + 300)).toContain("context.cache.set(false)");
	});
});

// ── Cache safety and CSP ───────────────────────────────────────────────────────────────────────────────────────
describe("cache safety: the HTML is identical for every visitor", () => {
	it("the page's consent JSON depends on settings only (same input → same output, nothing about a visitor)", () => {
		const a = JSON.stringify(rc("auto"));
		expect(JSON.stringify(rc("auto"))).toBe(a);
		expect(Object.keys(rc("auto")).sort()).toEqual(["cats", "footer", "mode", "policy", "position", "rev", "text"]);
	});
	it("the starter never reads the visitor's cookies, headers or country to render the banner", () => {
		const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/^import .*$/gm, "");
		const util = code(starter("src/utils/consent.ts"));
		const comp = code(starter("src/components/Consent.astro"));
		// The region is only read by the uncached endpoint (regionResponse), never while rendering a page.
		const render = util.slice(0, util.indexOf("export function regionResponse"));
		expect(render).not.toMatch(/request\.|headers|cookies|\.cf\b|cf-ipcountry/i);
		expect(comp).not.toMatch(/Astro\.request|Astro\.cookies\.get|Astro\.url\.search/);
		expect(comp).toContain("isEditor(Astro.cookies, Astro.url)");
	});
	it("no inline script: the banner is a file the CSP's 'self' allows, and the CSP's inline list is unchanged", () => {
		const comp = starter("src/components/Consent.astro");
		expect(comp).toContain('<script is:inline src="/scripts/site-consent.js" defer></script>');
		expect(comp.match(/<script/g)).toHaveLength(1);
		expect(starter("src/middleware.ts")).toContain("const INLINE_SCRIPTS = [announcementScript];");
		const base = starter("src/layouts/Base.astro");
		expect(base.indexOf("<Consent />")).toBeLessThan(base.indexOf("<SiteWidgets />"));
		expect(base.indexOf("<SiteWidgets />")).toBeLessThan(base.indexOf("<Analytics />"));
	});
});

// ── Settings and admin ─────────────────────────────────────────────────────────────────────────────────────────
describe("settings and admin validation", () => {
	it("defaults: auto, bar, default wording; the old site's wording and policy carried when valid", () => {
		const d = defaultSettings();
		expect([d.mode, d.position, d.text.accept, d.stats, d.footerLink, d.revision]).toEqual(["auto", "bar", "Accept all", false, true, 1]);
		const c = defaultSettings({ mode: "opt-in", text: { title: "  Cookies\u0007 here ", accept: "x".repeat(200) }, policy: "//evil.example" });
		expect([c.mode, c.text.title, c.text.accept.length, c.policy]).toEqual(["opt-in", "Cookies here", 40, ""]);
	});
	it("policy path: a site path only", () => {
		expect(policyPath("/privacy-policy/")).toBe("/privacy-policy/");
		for (const bad of ["https://x.example/p", "//x", "javascript:alert(1)", "/a/../b", "/p?x=<script>"]) expect(policyPath(bad)).toBeUndefined();
		expect(plain("a b\n c")).toBe("a b c");
	});
	it("form: over-long text and an unknown policy page are errors; empty text falls back to the default", () => {
		const cur = defaultSettings();
		const bad = settingsFromForm(cur, { mode: "opt-in", "text:title": "x".repeat(81), "desc:analytics": "y".repeat(301), policy: "/not-a-page" }, ["/privacy"]);
		expect(bad.ok).toBe(false);
		expect(!bad.ok && bad.errors.join(" ")).toMatch(/Title: at most 80.*Analytics description: at most 300.*privacy policy/);
		expect(settingsFromForm(cur, { mode: "sometimes" }, []).ok).toBe(false);
		const ok = settingsFromForm(cur, { mode: "notice", position: "card", "text:title": "", "text:body": "<b>Hi</b>", policy: "/privacy", stats: true }, ["/privacy"]);
		expect(ok.ok && [ok.settings.mode, ok.settings.position, ok.settings.text.title, ok.settings.text.body, ok.settings.policy, ok.settings.stats, ok.settings.footerLink]).toEqual(["notice", "card", "Your privacy", "<b>Hi</b>", "/privacy", true, true]);
	});
	it("stored values are re-checked on read; a damaged row never passes as is", () => {
		expect(parseSettings({ version: 2, mode: "auto" })).toBeUndefined();
		expect(parseSettings({ version: 1, mode: "auto", text: { title: 5 }, policy: "javascript:x", revision: -3, stats: "yes" })).toMatchObject({ text: { title: "Your privacy" }, policy: "", revision: 1, stats: false });
	});
	it("every tracker type has a category; services by category; nothing to ask = no banner", () => {
		for (const t of TRACKER_TYPES) expect(t === "ua" || TRACKER_CATEGORY[t] !== undefined).toBe(true);
		const s = servicesOf({ google: ["G-ABC123DEF4", "AW-123456789"], gtm: ["GTM-ABC1234"], meta: ["123456789012345"], clarity: "abcd1234ef", hotjar: undefined, cloudflare: "x" }, [{ name: "Tawk.to chat", category: "chat" }, { name: "CookieYes", category: "consent" }]);
		expect(s).toEqual({ analytics: ["Google Analytics", "Google Tag Manager", "Microsoft Clarity"], marketing: ["Google Ads", "Meta Pixel"], preferences: ["Tawk.to chat"], cookieless: ["Cloudflare Web Analytics"] });
		expect(needsConsent(servicesOf({ google: [], gtm: [], meta: [], cloudflare: "x" }))).toBe(false);
		expect(runtimeConsent({ ...defaultSettings(), mode: "off" }, s)).toBeUndefined();
	});
	it("storage: the options-table row name, read back validated", async () => {
		expect(OPTION_NAME).toBe("plugin:privacy-consent:settings");
		const db = (value?: string) => ({ prepare: () => ({ bind: () => ({ first: async <T>() => (value === undefined ? null : ({ value } as T)) }) }) });
		expect(await readStoredConsent(db())).toBeUndefined();
		expect(await readStoredConsent(db("{bad"))).toBeNull();
		expect(await readStoredConsent(undefined)).toBeNull();
		expect((await readStoredConsent(db(JSON.stringify(defaultSettings({ mode: "notice" })))))?.mode).toBe("notice");
	});
});

class MemKv {
	m = new Map<string, unknown>();
	async get<T>(k: string) {
		return (this.m.get(k) as T) ?? null;
	}
	async set(k: string, v: unknown) {
		this.m.set(k, JSON.parse(JSON.stringify(v)));
	}
	async delete(k: string) {
		return this.m.delete(k);
	}
	async list(prefix = "") {
		return [...this.m].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value }));
	}
}

describe("Privacy & consent plugin", () => {
	const o = { productionUrl: "https://acme.example", siteName: "Acme", defaults: { mode: "auto" as const }, analytics: { admin: false, seed: { google: ["G-ABC123DEF4"], meta: ["123456789012345"] } }, widgets: [{ name: "Tawk.to chat", category: "chat" }] };
	const pagesApi = { list: async () => ({ items: [{ id: "1", slug: "privacy-policy", status: "published", data: { title: "Privacy Policy" } }, { id: "2", slug: "about", status: "published", data: { title: "About" } }], hasMore: false }) };
	let kv: MemKv;
	let purged: string[][];
	const bits = () => ({ env: {}, cache: { purge: async (x: { tags: string[] }) => void purged.push(x.tags) } });
	const admin = (input: unknown, role = 50) => adminRoute({ kv, input, user: { role, name: "Owner" }, content: pagesApi, request: new Request("https://acme-site.workers.dev/_emdash/api/plugins/privacy-consent/admin") }, o, bits());
	beforeEach(() => {
		kv = new MemKv();
		purged = [];
	});
	it("descriptor: native plugin, Worker entrypoint, admin page", () => {
		expect(consentPlugin(o)).toMatchObject({ id: "privacy-consent", format: "native", entrypoint: "@wp2emdash/consent/plugin" });
		const p = createPlugin(o) as unknown as { admin: { pages: { label: string }[] }; routes: Record<string, { public?: boolean; methods?: string[]; request?: { maxBytes?: number } }> };
		expect(p.admin.pages[0]?.label).toBe("Privacy & consent");
		expect(p.routes.log).toMatchObject({ public: true, methods: ["POST"], request: { maxBytes: 64 } });
		expect(p.routes.admin?.public).toBeUndefined();
	});
	it("admins only; first load stores the carried defaults; services from the seed and widgets; preview on this host", async () => {
		expect(JSON.stringify((await admin({ type: "page_load" }, 40)).blocks)).toContain("Administrators only");
		expect(kv.m.size).toBe(0);
		const r = JSON.stringify((await admin({ type: "page_load" })).blocks);
		expect((kv.m.get(KV_KEY) as { mode: string }).mode).toBe("auto");
		expect(r).toContain("Google Analytics");
		expect(r).toContain("Meta Pixel");
		expect(r).toContain("Tawk.to chat");
		expect(r).toContain("https://acme-site.workers.dev/?consent-preview=1");
		expect(r).toContain("Privacy Policy (/privacy-policy)");
	});
	it("save: validated, stored with who saved, pages purged; errors keep what was typed", async () => {
		const bad = await admin({ type: "form_submit", action_id: "save", values: { mode: "opt-in", "text:title": "t".repeat(90) } });
		expect(bad.toast?.type).toBe("error");
		expect(JSON.stringify(bad.blocks)).toContain("t".repeat(90));
		expect(purged).toEqual([]);
		const ok = await admin({ type: "form_submit", action_id: "save", values: { mode: "opt-in", policy: "/privacy-policy", stats: true } });
		expect(ok.toast?.type).toBe("success");
		expect(kv.m.get(KV_KEY)).toMatchObject({ mode: "opt-in", policy: "/privacy-policy", stats: true, updatedBy: "Owner" });
		expect(purged).toEqual([["wp2emdash:analytics", "emdash:settings"]]);
	});
	it("ask every visitor again bumps the revision; the consent log counts only when on, only known words", async () => {
		await admin({ type: "page_load" });
		await admin({ type: "block_action", action_id: "ask-again" });
		expect((kv.m.get(KV_KEY) as { revision: number }).revision).toBe(2);
		const log = (createPlugin(o) as unknown as { routes: { log: { handler: (c: unknown) => Promise<{ counted: boolean }> } } }).routes.log.handler;
		expect(await log({ kv, input: { choice: "accept" } })).toEqual({ counted: false });
		await admin({ type: "form_submit", action_id: "save", values: { mode: "auto", stats: true } });
		expect(await log({ kv, input: { choice: "accept" } })).toEqual({ counted: true });
		expect(await log({ kv, input: { choice: "reject", ip: "1.2.3.4" } })).toEqual({ counted: true });
		expect(await log({ kv, input: { choice: "<script>" } })).toEqual({ counted: false });
		const today = (await readStats(kv, 1))[0];
		expect(today?.counts).toEqual({ accept: 1, reject: 1, custom: 0 });
		expect(JSON.stringify([...kv.m.values()])).not.toContain("1.2.3.4");
		const page = JSON.stringify((await admin({ type: "page_load" })).blocks);
		expect(page).toContain("Accepted all, 30 days");
		await admin({ type: "block_action", action_id: "stats-clear" });
		expect([...kv.m.keys()].filter((k) => k.startsWith("stats:"))).toEqual([]);
	});
	it("counts: approximate per day, pruned after 90 days", async () => {
		const k = new MemKv();
		await countChoice(k, "custom", new Date("2026-01-01T10:00:00Z"));
		await countChoice(k, "custom", new Date("2026-11-20T10:00:00Z"));
		expect(await pruneStats(k, new Date("2026-11-20T12:00:00Z"))).toBe(1);
		expect([...k.m.keys()]).toEqual(["stats:2026-11-20"]);
	});
	it("kept third-party tool: the page says so; services read from SEO & Analytics when it manages them", async () => {
		const page = JSON.stringify(adminPage({ settings: { ...defaultSettings(), mode: "off" }, services: servicesOf(undefined), pages: [], keptTools: ["CookieYes"], previewUrl: "/", stats: [] }));
		expect(page).toContain("CookieYes handles consent");
		const db = { prepare: () => ({ bind: () => ({ first: async <T>() => ({ value: JSON.stringify({ trackers: [{ id: "a", type: "hotjar", value: "3456789", enabled: true }] }) }) as T }) }) };
		expect((await siteServices({ ...o, analytics: { admin: true } }, db)).analytics).toEqual(["Hotjar"]);
	});
});

// ── Migration and scaffold ─────────────────────────────────────────────────────────────────────────────────────
describe("migration: the old site's consent banner", () => {
	const complianz = `<html><head><script>var complianz = {"consenttype":"optin","version":"7"};</script></head><body><div class="cmplz-cookiebanner"><div class="cmplz-title">Manage consent</div><div class="cmplz-message"><p>We use cookies to improve your visit.</p></div><button class="cmplz-accept">Accept</button><button class="cmplz-deny">Deny</button></div></body></html>`;
	it("Complianz opt-in: built-in banner opt-in with its wording", () => {
		const p = planConsent([{ html: complianz }], []);
		expect(p.found).toEqual([{ id: "complianz", name: "Complianz", kind: "wp-plugin", mode: "opt-in" }]);
		expect(p.mode).toBe("opt-in");
		expect(p.text).toEqual({ title: "Manage consent", body: "We use cookies to improve your visit.", accept: "Accept", reject: "Deny" });
		const r = consentReport(p).join("\n");
		expect(r).toContain("## Consent banner");
		expect(r).toContain("Complianz (WordPress plugin, opt-in)");
	});
	it("CookieYes carried as a site widget: kept, built-in banner off", () => {
		const p = planConsent([{ html: '<script id="cookieyes" src="https://cdn-cookieyes.com/client_data/abc/script.js"></script>' }], [{ provider: "cookieyes", id: "0123456789abcdef0123456789abcdef" }]);
		expect([p.mode, p.keptWidgets]).toEqual(["off", ["cookieyes"]]);
		expect(p.reason).toContain("CookieYes carried as a site widget");
	});
	it("Borlabs / Real Cookie Banner: opt-in; Cookie Notice without a reject button: notice; nothing: auto", () => {
		expect(planConsent([{ html: '<div id="BorlabsCookieBox"></div>' }], []).mode).toBe("opt-in");
		expect(planConsent([{ html: '<link href="/wp-content/plugins/real-cookie-banner/x.css">' }], []).mode).toBe("opt-in");
		expect(planConsent([{ html: '<div id="cookie-notice" class="cookie-notice-container"><span id="cn-notice-text">We use cookies.</span><a id="cn-accept-cookie">Ok</a></div>' }], [])).toMatchObject({ mode: "notice", text: { body: "We use cookies.", accept: "Ok" } });
		expect(planConsent([{ html: "<p>hello</p>" }], [])).toMatchObject({ found: [], mode: "auto" });
		expect(planConsent([{ html: '<script src="https://cdn.cookielaw.org/x.js"></script>' }], [])).toMatchObject({ mode: "auto", found: [{ id: "onetrust" }] });
	});
	it("scaffold: plan + kit.config → plugin options and site.config defaults; consent: false → none", () => {
		const ir = mkdtempSync(join(tmpdir(), "consent-"));
		writeFileSync(join(ir, "consent.json"), JSON.stringify(planConsent([{ html: complianz }], [])));
		const base = { config: { name: "Acme", consent: {}, analytics: undefined } as never, productionUrl: "https://acme.example", irDir: ir, pages: [{ path: "/datenschutz/", slug: "datenschutz", title: "Datenschutz" }], siteWidgets: [{ provider: "tawkto", id: "0123456789abcdef01234567/1abcdefg" }], analytics: { admin: true } };
		const s = consentScaffold(base);
		expect(s?.mode).toBe("opt-in");
		expect(s?.site.defaults).toMatchObject({ mode: "opt-in", policy: "/datenschutz/", text: { title: "Manage consent" } });
		expect(s?.options.widgets).toEqual([{ name: "Tawk.to chat", category: "chat" }]);
		expect(consentScaffold({ ...base, config: { name: "Acme", consent: { mode: "notice", policy: "/legal" } } as never })?.site.defaults).toMatchObject({ mode: "notice", policy: "/legal" });
		expect(consentScaffold({ ...base, config: { name: "Acme", consent: false } as never })).toBeUndefined();
	});
	it("scaffold registers the plugin, always ships the package, and the client docs explain it", () => {
		const s = readFileSync(join(ROOT, "src/phases/scaffold.ts"), "utf8");
		expect(s).toContain('"@wp2emdash/consent": "link:./packages/consent"');
		expect(s).toContain('cpSync(join(KIT_ROOT, "packages", "consent")');
		expect(s).toContain("consentPlugin(${JSON.stringify(consent.options)})");
		const input = { name: "Acme", slug: "acme", sourceUrl: "https://acme.example", productionUrl: "https://acme.example", workerName: "acme", productionReady: false, sections: [], forms: [], email: { provider: "brevo", to: [] }, turnstileProduction: false, sensitiveData: false, stack: {} } as unknown as ClientRepoInput;
		const docs = Object.values(clientRepoFiles({ ...input, consent: { mode: "off", keptTools: ["CookieYes"] } })).join("\n");
		for (const t of ["Privacy & consent", "Cookie settings", "Global Privacy Control", "CookieYes was kept", "/_consent/region"]) expect(docs).toContain(t);
		expect(Object.values(clientRepoFiles(input)).join("\n")).not.toContain("## Privacy and the cookie banner");
	});
});
