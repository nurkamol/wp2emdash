import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALWAYS, CSP_HOSTS, cspSources } from "../packages/seo/src/analytics/csp.js";
import { carriedFromDetected, detectTrackers } from "../packages/seo/src/analytics/detect.js";
import { addTracker, editTracker, removeTracker, switchesFrom, toggleTracker } from "../packages/seo/src/analytics/edit.js";
import { BOOKING_HOSTS, classifyLink } from "../packages/seo/src/analytics/events.js";
import { CACHE_TAG, KV_KEY, OPTION_NAME, PURGE_TAGS, purgePages, readStoredAnalytics, type StoredAnalytics } from "../packages/seo/src/analytics/store.js";
import { DEFAULT_EVENTS, hasTrackers, listProblems, normalizeId, parseTrackers, runtimeConfig, SPECS, seedTrackers, TRACKER_TYPES, type Tracker, type TrackerType, typesOf } from "../packages/seo/src/analytics/trackers.js";
import { fetchVisits, GRAPHQL_URL, PAGE_LIMIT, parseVisits, viewsOfPath, type Visits, visitsQuery } from "../packages/seo/src/analytics/visits.js";
import { seoPlugin } from "../packages/seo/src/index.js";
import { loadAnalytics } from "../packages/seo/src/plugin/analytics.js";
import { createPlugin } from "../packages/seo/src/plugin/index.js";
import { analyticsOptions, carriedAnalytics, detectFromSnapshot, lookupRumSite } from "../src/scaffold/analytics.js";
import { type ClientRepoInput, clientRepoFiles } from "../src/scaffold/client-repo.js";
import { liveTrackers, runtimeAnalyticsProblem } from "../src/verify/runtime.js";
import { cache, env } from "../test/stubs/cloudflare-workers.js";

const ROOT = new URL("..", import.meta.url).pathname;
const starter = (p: string) => readFileSync(join(ROOT, "starter", p), "utf8");
const row = (id: string, type: TrackerType, value: string, enabled = true): Tracker => ({ id, type, value, enabled, addedAt: "" });

// ── IDs ──────────────────────────────────────────────────────────────────────────────────────────────────────────
describe("tracker IDs: strict per-type validation, no code", () => {
	const good: Record<TrackerType, [string, string][]> = {
		ga4: [["G-ABC123DEF4", "G-ABC123DEF4"], [" g-abc123def4 ", "G-ABC123DEF4"]],
		"google-tag": [["GT-ABCD1234", "GT-ABCD1234"]],
		"google-ads": [["AW-123456789", "AW-123456789"], ["aw-123456789", "AW-123456789"]],
		gtm: [["GTM-ABC1234", "GTM-ABC1234"]],
		cloudflare: [["0123456789ABCDEF0123456789abcdef", "0123456789abcdef0123456789abcdef"]],
		meta: [["123456789012345", "123456789012345"], ["1234 5678 9012 345", "123456789012345"]],
		clarity: [["AbCd1234Ef", "abcd1234ef"]],
		hotjar: [["1234567", "1234567"]],
		ua: [["ua-12345678-1", "UA-12345678-1"]],
	};
	const bad: Record<TrackerType, string[]> = {
		ga4: ["GT-ABCD1234", "G-12", "UA-1234-1", "G-ABC123DEF4X12345"],
		"google-tag": ["G-ABC123DEF4", "GT-"],
		"google-ads": ["AW-ABCDEFG", "AW-12"],
		gtm: ["GTM-", "G-ABC123DEF4", "GTM-ABCDEFGHIJKL"],
		cloudflare: ["0123", "zz23456789abcdef0123456789abcdef"],
		meta: ["abc123", "12345"],
		clarity: ["abc", "abcd-1234e"],
		hotjar: ["12a456", "123"],
		ua: ["UA-1", "G-ABC123DEF4"],
	};
	for (const t of TRACKER_TYPES) {
		it(`${SPECS[t].name}: accepts and normalises its own IDs, refuses others`, () => {
			for (const [raw, norm] of good[t]) expect(normalizeId(t, raw)).toEqual({ ok: true, value: norm });
			for (const raw of bad[t]) expect(normalizeId(t, raw).ok).toBe(false);
		});
	}
	it("refuses pasted snippets and markup outright", () => {
		for (const [type, raw] of [["ga4", '<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123DEF4"></script>'], ["meta", "fbq('init', '123456789012345')"], ["ga4", 'G-ABC123DEF4"><img src=x onerror=alert(1)>']] as const) {
			const r = normalizeId(type, raw);
			expect(r.ok).toBe(false);
			if (!r.ok) expect(r.error).toMatch(/not a code snippet/);
		}
		expect(normalizeId("ga4", "").ok).toBe(false);
		expect(normalizeId("ga4", 42).ok).toBe(false);
	});
	it("flags duplicates, a second single-only service on, and a retired one switched on", () => {
		expect(listProblems([row("a", "ga4", "G-ABC123DEF4"), row("b", "ga4", "G-ABC123DEF4")])).toHaveLength(1);
		expect(listProblems([row("a", "clarity", "abcd1234ef"), row("b", "clarity", "zzzz1234ef")])[0]).toMatch(/Only one Microsoft Clarity/);
		expect(listProblems([row("a", "clarity", "abcd1234ef"), row("b", "clarity", "zzzz1234ef", false)])).toEqual([]);
		expect(listProblems([row("a", "meta", "123456789012345"), row("b", "meta", "543210987654321")])).toEqual([]);
		expect(listProblems([row("a", "ua", "UA-12345678-1")])[0]).toMatch(/Universal Analytics cannot be switched on/);
	});
});

// ── Prefill ──────────────────────────────────────────────────────────────────────────────────────────────────
describe("prefill: everything found on the WordPress site", () => {
	const html = [
		`<script async src="https://www.googletagmanager.com/gtag/js?id=G-ABC123DEF4"></script><script>gtag('config','UA-12345678-1');gtag('config','AW-123456789')</script>`,
		`<script>!function(f,b,e,v,n,t,s){}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init', '123456789012345');</script><noscript><img src="https://www.facebook.com/tr?id=123456789012345&ev=PageView"></noscript>`,
		`<script>(function(c,l,a,r,i,t,y){})(window, document, "clarity", "script", "abcd1234ef");</script><script>(function(h,o,t,j,a,r){h._hjSettings={hjid:3456789,hjsv:6};})</script>`,
		`<iframe src="https://www.googletagmanager.com/ns.html?id=GTM-ABC1234"></iframe><script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "0123456789abcdef0123456789abcdef"}'></script>`,
	];
	it("detects every service, including the retired UA and the Cloudflare beacon", () => {
		expect(detectTrackers(html)).toEqual({ google: ["AW-123456789", "G-ABC123DEF4"], gtm: ["GTM-ABC1234"], ua: ["UA-12345678-1"], meta: ["123456789012345"], clarity: ["abcd1234ef"], hotjar: ["3456789"], cloudflare: ["0123456789abcdef0123456789abcdef"] });
	});
	it("carries a beacon only when the old site added it itself (a zone-injected one keeps being injected)", () => {
		const d = detectTrackers(html);
		expect(carriedFromDetected(d).cloudflareToken).toBeUndefined();
		expect(carriedFromDetected(d, { beacon: "zone" }).cloudflareToken).toBeUndefined();
		expect(carriedFromDetected(d, { beacon: "manual" }).cloudflareToken).toBe("0123456789abcdef0123456789abcdef");
		const rum = { siteTag: "f".repeat(32), siteToken: "0123456789abcdef0123456789abcdef", autoInstall: false };
		expect(carriedAnalytics(undefined, d, rum)?.cloudflareToken).toBe("0123456789abcdef0123456789abcdef");
		expect(carriedAnalytics(undefined, d, { ...rum, autoInstall: true })?.cloudflareToken).toBeUndefined();
		expect(carriedAnalytics(false, d, rum)).toBeUndefined();
		expect(carriedAnalytics({ google: ["G-XYZ1234567"] }, d, rum)).toEqual({ google: ["G-XYZ1234567"] });
	});
	it("seeds every carried tracker on, the retired UA off and marked from the old site", () => {
		const s = seedTrackers(carriedFromDetected(detectTrackers(html)), "2026-11-20T00:00:00.000Z");
		expect(s.map((t) => [t.type, t.value, t.enabled])).toEqual([
			["google-ads", "AW-123456789", true],
			["ga4", "G-ABC123DEF4", true],
			["gtm", "GTM-ABC1234", true],
			["meta", "123456789012345", true],
			["clarity", "abcd1234ef", true],
			["hotjar", "3456789", true],
			["ua", "UA-12345678-1", false],
		]);
		expect(s.every((t) => t.origin === "wordpress")).toBe(true);
		expect(runtimeConfig(s).google).toEqual(["AW-123456789", "G-ABC123DEF4"]); // UA never loaded
	});
	it("scaffold reads the audit's raw HTML snapshot and the audited IDs", () => {
		const dir = mkdtempSync(join(tmpdir(), "snap-"));
		mkdirSync(join(dir, "html"));
		writeFileSync(join(dir, "html", "home.html"), html[1] as string);
		expect(detectFromSnapshot(dir, ["GT-ABCD1234"])).toMatchObject({ google: ["GT-ABCD1234"], meta: ["123456789012345"] });
		expect(detectFromSnapshot(join(dir, "missing"), ["G-ABC123DEF4"]).google).toEqual(["G-ABC123DEF4"]);
	});
	it("looks up the Web Analytics site read-only with the build token (site tag, automatic setup)", async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		const f = (async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			return new Response(JSON.stringify({ result: [{ site_tag: "a".repeat(32), site_token: "t", auto_install: false, ruleset: { zone_name: "other.example" } }, { site_tag: "b".repeat(32), site_token: "0123", auto_install: true, ruleset: { zone_name: "acme.example" } }] }));
		}) as unknown as typeof fetch;
		expect(await lookupRumSite({ token: "tok", accountId: "c".repeat(32), host: "www.acme.example" }, f)).toEqual({ siteTag: "b".repeat(32), siteToken: "0123", autoInstall: true });
		expect(calls[0]?.url).toBe(`https://api.cloudflare.com/client/v4/accounts/${"c".repeat(32)}/rum/site_info/list?per_page=100`);
		expect(calls[0]?.init.method ?? "GET").toBe("GET");
		expect(await lookupRumSite({ host: "acme.example" }, f)).toBeUndefined();
		expect(await lookupRumSite({ token: "t", accountId: "c".repeat(32), host: "acme.example" }, (async () => new Response("", { status: 403 })) as unknown as typeof fetch)).toBeUndefined();
	});
});

// ── Runtime config, CSP ───────────────────────────────────────────────────────────────────────────────────────
describe("runtime config and CSP host table", () => {
	it("runtime config: enabled only, by service, with events and consent", () => {
		const list = parseTrackers([
			{ id: "a", type: "ga4", value: "G-ABC123DEF4", enabled: true },
			{ id: "b", type: "meta", value: "123456789012345", enabled: true },
			{ id: "c", type: "clarity", value: "abcd1234ef", enabled: false },
			{ id: "h", type: "hotjar", value: "3456789", enabled: true },
			{ id: "u", type: "ua", value: "UA-12345678-1", enabled: true },
			{ id: "d", type: "evil", value: "x" },
			{ id: "e", type: "gtm", value: "<script>" },
		]) as Tracker[];
		expect(list.map((t) => t.id)).toEqual(["a", "b", "c", "h", "u"]);
		expect(list.find((t) => t.id === "u")?.enabled).toBe(false); // a stored "on" UA is forced off
		const rc = runtimeConfig(list, { events: { lead: true, contact: false, booking: true, outbound: false }, consent: true });
		expect(rc).toEqual({ google: ["G-ABC123DEF4"], gtm: [], meta: ["123456789012345"], hotjar: "3456789", events: ["lead", "booking"], consent: true, defer: true });
		expect(typesOf(rc).sort()).toEqual(["ga4", "hotjar", "meta"]);
		expect(runtimeConfig([]).events).toEqual(["lead", "contact", "booking"]);
		expect(hasTrackers({ google: [], gtm: [], meta: [] })).toBe(false);
	});
	it("every source is https/wss, wildcards are single-label subdomains of the provider", () => {
		expect(Object.keys(CSP_HOSTS).sort()).toEqual([...TRACKER_TYPES].sort());
		const allowedWildcards = new Set(["https://*.googletagmanager.com", "https://*.google-analytics.com", "https://*.analytics.google.com", "https://*.g.doubleclick.net", "https://*.clarity.ms", "https://*.hotjar.com", "https://*.hotjar.io", "wss://*.hotjar.com"]);
		for (const h of Object.values(CSP_HOSTS).flatMap((x) => [...x.script, ...x.connect, ...x.frame, ...(x.style ?? []), ...(x.font ?? [])])) {
			expect(h).toMatch(/^(https|wss):\/\/(\*\.)?[a-z0-9.-]+\.[a-z]+$/);
			if (h.includes("*")) expect(allowedWildcards.has(h)).toBe(true);
		}
		expect(CSP_HOSTS.ua).toEqual({ script: [], connect: [], frame: [] });
	});
	it("allows only Cloudflare's beacon when nothing is on, and adds exactly each switched-on service", () => {
		expect(ALWAYS).toEqual(["cloudflare"]);
		expect(cspSources([])).toEqual({ script: ["https://static.cloudflareinsights.com"], connect: ["https://cloudflareinsights.com"], frame: [], style: [], font: [] });
		const meta = cspSources(["meta"]);
		expect(meta.script).toEqual(["https://static.cloudflareinsights.com", "https://connect.facebook.net"]);
		expect(meta.connect).toContain("https://www.facebook.com");
		expect(cspSources(["clarity"]).script).toContain("https://*.clarity.ms");
		const hj = cspSources(["hotjar"]);
		expect(hj.script).toEqual(["https://static.cloudflareinsights.com", "https://static.hotjar.com", "https://script.hotjar.com"]);
		expect(hj.connect).toContain("wss://*.hotjar.com");
		expect(hj.font).toEqual(["https://*.hotjar.com"]);
		const ads = cspSources(["google-ads"]);
		expect(ads.script).toEqual(expect.arrayContaining(["https://www.googletagmanager.com", "https://www.googleadservices.com", "https://www.google.com"]));
		expect(cspSources(["ga4"]).connect).not.toContain("https://googleads.g.doubleclick.net");
	});
	it("the starter's middleware builds its CSP from the table and the page's own list", () => {
		const mw = starter("src/middleware.ts");
		expect(mw).toContain('from "@wp2emdash/seo/analytics/csp"');
		expect(mw).toContain("cspSources(typesOf(await pageAnalytics(context.locals, context.url, editor)))");
		expect(mw).toContain("(analytics.font ?? []).join");
		expect(mw).not.toMatch(/googletagmanager\.com|facebook|clarity\.ms|hotjar/);
		const util = starter("src/utils/analytics.ts");
		expect(util).toContain("url.host !== PRODUCTION_HOST");
		expect(util).toContain("readStoredAnalytics");
		expect(starter("src/components/Analytics.astro")).toContain('src="/scripts/site-analytics.js"');
		expect(starter("src/utils/chrome.ts")).toContain("cache.set({ tags: [ANALYTICS_TAG] })");
	});
});

// ── Loader ────────────────────────────────────────────────────────────────────────────────────────────────────
function runLoader(config: unknown) {
	const added: { src: string; attrs: Record<string, string> }[] = [];
	const document = {
		head: { appendChild: (s: { src: string; attrs: Record<string, string> }) => added.push(s) },
		querySelector: (q: string) => (q === 'meta[name="site-analytics"]' ? { content: typeof config === "string" ? config : JSON.stringify(config) } : null),
		createElement: () => {
			const el = { src: "", async: false, attrs: {} as Record<string, string>, setAttribute: (k: string, v: string) => void (el.attrs[k] = v) };
			return el;
		},
	};
	const window: Record<string, any> = {};
	runInNewContext(starter("public/scripts/site-analytics.js"), { window, document, Date, JSON, encodeURIComponent, Array, Object, String, Number, Set });
	return { added, window, srcs: () => added.map((a) => a.src) };
}
const calls = (q: any[]) => q.map((x: any) => [...x]);

describe("loader (public/scripts/site-analytics.js) per service", () => {
	it("Google tag: one gtag.js, one config per ID", () => {
		const { srcs, window } = runLoader({ google: ["G-ABC123DEF4", "AW-123456789"], gtm: [], meta: [] });
		expect(srcs()).toEqual(["https://www.googletagmanager.com/gtag/js?id=G-ABC123DEF4"]);
		expect(window.dataLayer.filter((x: any) => x[0] === "config").map((x: any) => x[1])).toEqual(["G-ABC123DEF4", "AW-123456789"]);
	});
	it("Tag Manager: gtm.js per container (array or the old single string)", () => {
		expect(runLoader({ gtm: ["GTM-ABC1234", "GTM-XYZ9876"] }).srcs()).toEqual(["https://www.googletagmanager.com/gtm.js?id=GTM-ABC1234", "https://www.googletagmanager.com/gtm.js?id=GTM-XYZ9876"]);
		expect(runLoader({ gtm: "GTM-ABC1234" }).window.dataLayer[0].event).toBe("gtm.js");
	});
	it("Cloudflare beacon with its token (also under the old cloudflareToken name)", () => {
		for (const cfg of [{ cloudflare: "0123456789abcdef0123456789abcdef" }, { cloudflareToken: "0123456789abcdef0123456789abcdef" }]) {
			const { added } = runLoader(cfg);
			expect(added[0]?.src).toBe("https://static.cloudflareinsights.com/beacon.min.js");
			expect(JSON.parse(added[0]?.attrs["data-cf-beacon"] ?? "{}")).toEqual({ token: "0123456789abcdef0123456789abcdef" });
		}
	});
	it("Meta Pixel: Meta's queue stub, fbevents.js once, init per pixel and one PageView", () => {
		const { srcs, window } = runLoader({ meta: ["123456789012345", "543210987654321"] });
		expect(srcs()).toEqual(["https://connect.facebook.net/en_US/fbevents.js"]);
		expect(calls(window.fbq.queue)).toEqual([["init", "123456789012345"], ["init", "543210987654321"], ["track", "PageView"]]);
		expect(window._fbq).toBe(window.fbq);
	});
	it("Microsoft Clarity and Hotjar: queue stubs and their scripts", () => {
		const { srcs, window } = runLoader({ clarity: "abcd1234ef", hotjar: "3456789" });
		expect(srcs()).toEqual(["https://www.clarity.ms/tag/abcd1234ef", "https://static.hotjar.com/c/hotjar-3456789.js?sv=6"]);
		expect(window._hjSettings).toEqual({ hjid: 3456789, hjsv: 6 });
		window.clarity("set", "x", "y");
		expect(calls(window.clarity.q)).toEqual([["set", "x", "y"]]);
	});
	it("ignores anything that is not a valid ID, and broken JSON", () => {
		expect(runLoader({ google: ["javascript:alert(1)"], gtm: ["GTM-<x>"], meta: ["1e9"], clarity: "../../evil", cloudflare: "x", hotjar: "1;alert(1)" }).added).toEqual([]);
		expect(runLoader("{not json").added).toEqual([]);
	});
	it("conversion events: only switched-on kinds, to every tracker that understands them, labels reduced", () => {
		const { window } = runLoader({ google: ["G-ABC123DEF4"], gtm: ["GTM-ABC1234"], meta: ["123456789012345"], clarity: "abcd1234ef", hotjar: "3456789", events: ["lead", "contact", "booking"] });
		window.siteAnalytics.track("lead", "contact-form <script>");
		window.siteAnalytics.track("contact", "phone");
		window.siteAnalytics.track("booking", "Calendly.com");
		window.siteAnalytics.track("outbound", "example.org"); // switched off
		const ga = window.dataLayer.filter((x: any) => x[0] === "event").map((x: any) => [...x]);
		expect(ga).toEqual([["event", "generate_lead", { form_name: "contact-formscript" }], ["event", "contact", { method: "phone" }], ["event", "schedule", { booking_service: "calendly.com" }]]);
		expect(window.dataLayer.filter((x: any) => x.event && x.event !== "gtm.js").map((x: any) => x.event)).toEqual(["generate_lead", "contact", "schedule"]);
		expect(calls(window.fbq.queue).slice(2)).toEqual([["track", "Lead"], ["track", "Contact"], ["track", "Schedule"]]);
		expect(calls(window.clarity.q)).toEqual([["event", "generate_lead"], ["event", "contact"], ["event", "schedule"]]);
		expect(calls(window.hj.q)).toEqual([["event", "generate_lead"], ["event", "contact"], ["event", "schedule"]]);
	});
	it("consent mode: Google starts denied; Meta, Clarity and Hotjar wait for grantConsent()", () => {
		const { srcs, window } = runLoader({ google: ["G-ABC123DEF4"], meta: ["123456789012345"], clarity: "abcd1234ef", cloudflare: "0123456789abcdef0123456789abcdef", consent: true, events: ["lead"] });
		expect([...window.dataLayer[0]]).toEqual(["consent", "default", { ad_storage: "denied", ad_user_data: "denied", ad_personalization: "denied", analytics_storage: "denied" }]);
		expect(srcs()).toEqual(["https://www.googletagmanager.com/gtag/js?id=G-ABC123DEF4", "https://static.cloudflareinsights.com/beacon.min.js"]);
		window.siteAnalytics.track("lead", "f");
		expect(window.fbq).toBeUndefined();
		window.siteAnalytics.grantConsent();
		expect(srcs()).toContain("https://connect.facebook.net/en_US/fbevents.js");
		expect(srcs()).toContain("https://www.clarity.ms/tag/abcd1234ef");
		expect(window.dataLayer.some((x: any) => x[0] === "consent" && x[1] === "update")).toBe(true);
	});
	it("has no inline code path", () => {
		expect(starter("public/scripts/site-analytics.js")).not.toMatch(/innerHTML|textContent|eval\(|new Function|document\.write/);
	});
});

describe("conversion events: link classification (site.ts)", () => {
	it("phone, email, booking services, outbound; own site and junk ignored; no PII in labels", () => {
		expect(classifyLink("tel:+1 555 0100", "acme.example")).toEqual({ kind: "contact", label: "phone" });
		expect(classifyLink("mailto:owner@acme.example?subject=Hi", "acme.example")).toEqual({ kind: "contact", label: "email" });
		expect(classifyLink("https://app.acuityscheduling.com/schedule.php?owner=1", "acme.example")).toEqual({ kind: "booking", label: "app.acuityscheduling.com" });
		expect(classifyLink("https://www.calendly.com/acme/intro", "acme.example")).toEqual({ kind: "booking", label: "calendly.com" });
		expect(classifyLink("https://squareup.com/appointments/book/x", "acme.example")?.kind).toBe("booking");
		expect(classifyLink("https://squareup.com/shop", "acme.example")?.kind).toBe("outbound");
		expect(classifyLink("https://instagram.com/acme", "acme.example")).toEqual({ kind: "outbound", label: "instagram.com" });
		expect(classifyLink("/about/", "acme.example")).toBeUndefined();
		expect(classifyLink("https://www.acme.example/contact", "acme.example")).toBeUndefined();
		expect(classifyLink("javascript:void(0)", "acme.example")).toBeUndefined();
		expect(BOOKING_HOSTS).toContain("marianatek.com");
	});
	it("site.ts sends a lead on a successful form and classifies clicks", () => {
		const site = starter("src/scripts/site.ts");
		expect(site).toContain('import { classifyLink } from "@wp2emdash/seo/analytics/events"');
		expect(site).toContain('track("lead", form.dataset.form ?? "form")');
		expect(site).not.toMatch(/track\([^)]*FormData|track\([^)]*\.value/);
	});
});

// ── Storage the site reads ────────────────────────────────────────────────────────────────────────────────────
describe("storage: the SEO plugin's KV row, read by the site", () => {
	const d1 = (r: { value: string } | null | "throw") => {
		const seen: { q: string; v: unknown[] }[] = [];
		return {
			seen,
			prepare: (q: string) => ({
				bind: (...v: unknown[]) => ({
					first: async <T>() => {
						seen.push({ q, v });
						if (r === "throw") throw new Error("D1 down");
						return r as T;
					},
				}),
			}),
		};
	};
	it("reads plugin:site-seo:analytics (EmDash: plugin:<id>:<key>) with events and consent", async () => {
		expect(OPTION_NAME).toBe("plugin:site-seo:analytics");
		const db = d1({ value: JSON.stringify({ version: 1, trackers: [{ id: "a", type: "meta", value: "123456789012345", enabled: true }], events: { outbound: true }, consent: true, updatedAt: "" }) });
		const s = await readStoredAnalytics(db);
		expect(s?.trackers.map((t) => t.value)).toEqual(["123456789012345"]);
		expect(s?.events).toEqual({ ...DEFAULT_EVENTS, outbound: true });
		expect(s?.consent).toBe(true);
		expect(db.seen[0]).toEqual({ q: "SELECT value FROM options WHERE name = ? LIMIT 1", v: ["plugin:site-seo:analytics"] });
	});
	it("never saved → undefined (carried-over IDs); unreadable → null (load nothing)", async () => {
		expect(await readStoredAnalytics(d1(null))).toBeUndefined();
		expect(await readStoredAnalytics(d1("throw"))).toBeNull();
		expect(await readStoredAnalytics(d1({ value: "{broken" }))).toBeNull();
		expect(await readStoredAnalytics(undefined)).toBeNull();
	});
	it("purges the analytics tag and the settings tag every page carries; never throws", async () => {
		expect(PURGE_TAGS).toEqual([CACHE_TAG, "emdash:settings"]);
		const got: unknown[] = [];
		expect(await purgePages({ purge: async (o) => void got.push(o) })).toBe("purged");
		expect(got).toEqual([{ tags: ["wp2emdash:analytics", "emdash:settings"] }]);
		expect(await purgePages({ purge: async () => ({ success: false, errors: [{ code: 429, message: "rate limited" }] }) })).toBe("failed");
		expect(await purgePages({ purge: async () => Promise.reject(new Error("x")) })).toBe("failed");
		expect(await purgePages(undefined)).toBe("no-cache");
	});
});

// ── SEO & Analytics plugin ───────────────────────────────────────────────────────────────────────────────────
type B = Record<string, any>;
type Res = { blocks: B[]; toast?: { message: string; type: string } };
function memKv() {
	const m = new Map<string, unknown>();
	return { m, get: async <T>(k: string) => (m.get(k) as T) ?? null, set: async (k: string, v: unknown) => void m.set(k, structuredClone(v)), delete: async (k: string) => m.delete(k) };
}
const opts = { productionUrl: "https://acme.example", analytics: { seed: { google: ["G-ABC123DEF4"], gtm: "GTM-ABC1234", ua: ["UA-12345678-1"] }, accountId: "0123456789abcdef0123456789abcdef", verification: { "google-site-verification": "abc" } } };
const page = (id: string, slug: string, title: string) => ({ id, slug, status: "published", data: { title, content: [] } });
const TOKEN = "tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdef";
const visitsData = { data: { viewer: { accounts: [{ total: [{ count: 1200, sum: { visits: 800 } }], days: [{ count: 100, sum: { visits: 70 }, dimensions: { date: "2026-11-19" } }], pages: [{ count: 500, sum: { visits: 400 }, dimensions: { requestPath: "/" } }, { count: 40, sum: { visits: 30 }, dimensions: { requestPath: "/about" } }], referrers: [{ count: 40, dimensions: { refererHost: "www.google.com" } }] }] } } };

describe("SEO & Analytics plugin", () => {
	let kv: ReturnType<typeof memKv>;
	const purges: unknown[] = [];
	const fetched: string[] = [];
	const fetchFn = (async (url: string, init: RequestInit) => {
		if (String(url) === GRAPHQL_URL) {
			fetched.push(String(init.body));
			return new Response(JSON.stringify(visitsData));
		}
		return new Response("", { status: 404 });
	}) as unknown as typeof fetch;
	const plugin = createPlugin(opts, { fetch: fetchFn }) as unknown as { admin: { pages: { label: string }[]; widgets: { id: string; title: string }[] }; routes: Record<string, { permission?: string; handler: (ctx: unknown) => Promise<unknown> }> };
	const ctx = (input: unknown, role = 50, extra: Record<string, unknown> = {}) => ({ input, kv, request: new Request("https://acme.example/_emdash/api/plugins/site-seo/admin"), user: { id: "u1", email: "owner@acme.example", name: "Owner", role }, site: { name: "Acme" }, content: { get: async () => page("p2", "about", "About"), list: async () => ({ items: [page("p1", "home", "Home"), page("p2", "about", "About")] }) }, log: { info() {} }, ...extra });
	const call = (input: unknown, role = 50, extra: Record<string, unknown> = {}) => plugin.routes.admin?.handler(ctx(input, role, extra)) as Promise<Res>;
	const tabNamed = (r: Res, label: string) => (r.blocks.find((b) => b.type === "tab")?.panels.find((p: B) => p.label === label)?.blocks ?? []) as B[];
	const stored = () => kv.m.get(KV_KEY) as StoredAnalytics;
	beforeEach(() => {
		kv = memKv();
		purges.length = 0;
		fetched.length = 0;
		cache.purge = async (o) => {
			purges.push(o);
			return { success: true, errors: [] };
		};
	});
	afterEach(() => {
		delete cache.purge;
		for (const k of Object.keys(env)) delete env[k];
	});

	it("one SEO & Analytics page with Visits and Analytics tabs; Visits widget; without analytics it stays SEO", async () => {
		expect(plugin.admin.pages[0]?.label).toBe("SEO & Analytics");
		expect(plugin.admin.widgets.map((w) => w.id)).toEqual(["seo-overview", "visits"]);
		const r = await call({ type: "page_load" });
		expect(r.blocks[0]).toEqual({ type: "header", text: "SEO & Analytics" });
		expect(r.blocks.find((b) => b.type === "tab")?.panels.map((p: B) => p.label).slice(0, 3)).toEqual(["Overview", "Visits", "Analytics"]);
		const plain = createPlugin({ productionUrl: "https://acme.example" }) as unknown as typeof plugin;
		expect(plain.admin.pages[0]?.label).toBe("SEO");
		expect(plain.admin.widgets.map((w) => w.id)).toEqual(["seo-overview"]);
		expect(seoPlugin(opts)).toMatchObject({ id: "site-seo", version: "0.5.0", displayName: "SEO & Analytics" });
	});
	it("first load stores what was carried over (UA retired, verification shown read-only); no purge", async () => {
		const r = await call({ type: "page_load" });
		const t = tabNamed(r, "Analytics");
		expect(t.find((b) => b.block_id === "trackers")?.rows.map((x: B) => [x.service, x.id, x.status])).toEqual([
			["Google Analytics 4 · from the old site", "G-ABC123DEF4", "On"],
			["Google Tag Manager · from the old site", "GTM-ABC1234", "On"],
			["Universal Analytics · from the old site", "UA-12345678-1", "Retired"],
		]);
		// Google and Bing are edited in EmDash's Settings → SEO (load prefills them); the carried tag is the fallback.
		expect(t.find((b) => b.block_id === "verification")?.rows).toEqual([{ service: "Google Search Console", tag: "google-site-verification: abc", where: "Settings → SEO (this value is the fallback when that field is empty)" }]);
		expect(t.some((b) => b.type === "context" && String(b.text).includes("Settings → SEO (/_emdash/admin/settings/seo)"))).toBe(true);
		expect(stored().events).toEqual(DEFAULT_EVENTS);
		expect(purges).toEqual([]);
		await kv.set(KV_KEY, { ...stored(), trackers: [] });
		expect((await loadAnalytics({ kv }, opts)).trackers).toEqual([]);
	});
	it("admins add a Meta Pixel by ID: saved, cached pages purged, back on the Analytics tab", async () => {
		await call({ type: "page_load" });
		const form = await call({ type: "block_action", action_id: "an-add" });
		expect(form.blocks.find((b) => b.type === "form")?.fields.map((f: B) => f.action_id)).toEqual(["type", "value", "enabled"]);
		expect(form.blocks.find((b) => b.type === "form")?.fields[0].options.map((o: B) => o.value)).not.toContain("ua");
		const r = await call({ type: "form_submit", action_id: "an-add-save", block_id: "an-add", values: { type: "meta", value: "123456789012345", enabled: true } });
		expect(r.toast?.message).toBe("Meta Pixel 123456789012345 added. Live pages update within a few seconds.");
		const tab = r.blocks.find((b) => b.type === "tab") as B;
		expect(tab.panels[tab.default_tab].label).toBe("Analytics");
		expect(stored().trackers.at(-1)).toMatchObject({ type: "meta", value: "123456789012345", enabled: true, origin: "admin" });
		expect(stored().updatedBy).toBe("Owner");
		expect(purges).toEqual([{ tags: PURGE_TAGS }]);
	});
	it("refuses an invalid ID (form kept, nothing saved or purged) and editors cannot change anything", async () => {
		await call({ type: "page_load" });
		const before = JSON.stringify(stored());
		const r = await call({ type: "form_submit", action_id: "an-add-save", values: { type: "ga4", value: "<script>alert(1)</script>" } });
		expect(r.toast?.type).toBe("error");
		expect(r.blocks.find((b) => b.type === "banner")?.description).toMatch(/not a code snippet/);
		expect(r.blocks.find((b) => b.type === "form")?.fields[0].initial_value).toBe("ga4");
		const ed = await call({ type: "block_action", action_id: "an-toggle", value: stored().trackers[0]?.id }, 40);
		expect(ed.toast?.message).toMatch(/Only administrators/);
		const tab = tabNamed(ed, "Analytics");
		expect(tab.find((b) => b.block_id === "trackers")?.columns.map((c: B) => c.key)).not.toContain("toggle");
		expect(tab.some((b) => b.type === "form")).toBe(false);
		expect(JSON.stringify(stored())).toBe(before);
		expect(purges).toEqual([]);
	});
	it("turns a tracker off, edits it through the form's block id, removes it", async () => {
		await call({ type: "page_load" });
		const id = stored().trackers[0]?.id as string;
		const off = await call({ type: "block_action", action_id: "an-toggle", value: id });
		expect(off.toast?.message).toMatch(/turned off/);
		const edit = await call({ type: "block_action", action_id: "an-edit", value: id });
		expect(edit.blocks.find((b) => b.type === "form")?.block_id).toBe(`an-edit:${id}`);
		expect(edit.blocks.find((b) => b.type === "actions")?.elements.find((e: B) => e.action_id === "an-remove").confirm.style).toBe("danger");
		await call({ type: "form_submit", action_id: "an-edit-save", block_id: `an-edit:${id}`, values: { value: "G-NEW123456", enabled: true } });
		expect(stored().trackers[0]).toMatchObject({ value: "G-NEW123456", enabled: true });
		await call({ type: "block_action", action_id: "an-remove", value: id });
		expect(stored().trackers.map((t) => t.id)).not.toContain(id);
		expect(purges).toHaveLength(3);
	});
	it("conversion events and consent mode are switches; saving purges", async () => {
		await call({ type: "page_load" });
		const r = await call({ type: "form_submit", action_id: "an-switches", block_id: "an-switches", values: { "event:lead": true, "event:contact": false, "event:booking": true, "event:outbound": true, consent: true } });
		expect(stored().events).toEqual({ lead: true, contact: false, booking: true, outbound: true });
		expect(stored().consent).toBe(true);
		expect(r.toast?.message).toMatch(/consent mode on/);
		expect(purges).toHaveLength(1);
		expect(switchesFrom({})).toEqual({ events: { lead: false, contact: false, booking: false, outbound: false }, consent: false, defer: false });
	});
	it("a failed purge still saves, and says so honestly", async () => {
		cache.purge = async () => ({ success: false, errors: [{ code: 429, message: "rate limited" }] });
		await call({ type: "page_load" });
		const r = await call({ type: "form_submit", action_id: "an-add-save", values: { type: "clarity", value: "abcd1234ef" } });
		expect(stored().trackers.at(-1)?.type).toBe("clarity");
		expect(r.toast).toMatchObject({ type: "info" });
		expect(r.toast?.message).toMatch(/could not be refreshed/);
	});
	it("status is honest: guidance and the dated last browser check, never a claim that it works", async () => {
		const p = createPlugin({ ...opts, analytics: { ...opts.analytics, lastCheck: { at: "2026-11-18T10:00:00.000Z", ok: true, detail: "/gtag/js" } } }, { fetch: fetchFn }) as unknown as typeof plugin;
		const r = (await p.routes.admin?.handler(ctx({ type: "page_load" }))) as Res;
		const text = JSON.stringify(tabNamed(r, "Analytics"));
		expect(text).toContain("cannot be seen from here");
		expect(text).toContain("Last browser check by the developer's kit (verify, 2026-11-18): passed");
	});
	it("Visits: setup guidance without the secret; with it the tab, overview, widget and editor panel show numbers", async () => {
		const setup = await call({ type: "page_load" });
		expect(JSON.stringify(tabNamed(setup, "Visits"))).toContain("CF_ANALYTICS_TOKEN");
		expect(fetched).toEqual([]);
		env.CF_ANALYTICS_TOKEN = TOKEN;
		const r = await call({ type: "page_load" });
		const visits = tabNamed(r, "Visits");
		expect(visits[0]?.items.slice(0, 2)).toEqual([{ label: "Visits", value: "800", description: "last 7 days" }, { label: "Page views", value: "1,200" }]);
		expect(visits.find((b) => b.type === "chart")?.config.chart_type).toBe("timeseries");
		expect(visits.find((b) => b.block_id === "visit-referrers")?.rows).toEqual([{ host: "www.google.com", views: 40 }]);
		const overview = tabNamed(r, "Overview");
		expect(overview[0]?.items[0].label).toBe("Average SEO score"); // SEO leads, visits follow
		expect(overview[1]?.items[0]).toEqual({ label: "Visits, 7 days", value: "800" });
		const widget = await call({ type: "page_load", page: "widget:visits" }, 50, { ui: { surface: "dashboard-widget" } });
		expect(widget.blocks[0]?.items[0]).toEqual({ label: "Visits, 7 days", value: "800" });
		expect((await call({ type: "page_load", page: "widget:visits" }, 40, { ui: { surface: "dashboard-widget" } })).blocks).toEqual([]);
		const panel = (await plugin.routes.panel?.handler(ctx({ type: "panel_load" }, 30, { ui: { surface: "content-editor-panel", entry: { collection: "pages", id: "p2" } } }))) as Res;
		expect(panel.blocks[0]).toEqual({ type: "stats", items: [{ label: "Page views, 7 days", value: "40" }, { label: "Visits", value: "30" }] });
		expect(fetched).toHaveLength(1); // one query, cached for everything
		expect(JSON.parse(fetched[0] as string).variables.accountTag).toBe(opts.analytics.accountId);
		for (const res of [r, widget, panel]) expect(JSON.stringify(res)).not.toContain(TOKEN);
		expect(JSON.stringify([...kv.m.values()])).not.toContain(TOKEN);
	});
});

describe("tracker list edits (pure)", () => {
	it("add / edit / toggle / remove, retired UA cannot be added", () => {
		const base = seedTrackers({ google: ["G-ABC123DEF4"] });
		const a = addTracker(base, { type: "cloudflare", value: "0123456789ABCDEF0123456789ABCDEF", enabled: false }, { id: "t1", now: "2026-11-20T00:00:00Z" });
		expect(a.ok && a.trackers.at(-1)).toMatchObject({ id: "t1", value: "0123456789abcdef0123456789abcdef", enabled: false });
		expect(addTracker(base, { type: "ua", value: "UA-12345678-1" }, { id: "t", now: "" })).toMatchObject({ ok: false, errors: [expect.stringMatching(/stopped Universal Analytics/)] });
		const two = addTracker(a.ok ? a.trackers : [], { type: "cloudflare", value: "ffffffffffffffffffffffffffffffff" }, { id: "t2", now: "" });
		expect(two.ok).toBe(true);
		if (!two.ok) return;
		expect(toggleTracker(two.trackers, "t1").ok).toBe(false); // two beacons on
		expect(editTracker(two.trackers, "missing", { value: "x" }).ok).toBe(false);
		expect(removeTracker(two.trackers, "t2").ok).toBe(true);
	});
});

// ── Visits query ──────────────────────────────────────────────────────────────────────────────────────────────
describe("Visits query (Cloudflare GraphQL)", () => {
	it("builds the rumPageloadEventsAdaptiveGroups query for 7 days, by host or by site tag", () => {
		const now = Date.parse("2026-11-20T12:00:00Z");
		const q = visitsQuery({ accountId: "acc", host: "acme.example" }, now);
		expect(q.variables).toEqual({ accountTag: "acc", since: "2026-11-13T12:00:00.000Z", until: "2026-11-20T12:00:00.000Z", key: "acme.example" });
		expect(q.query.match(/rumPageloadEventsAdaptiveGroups/g)).toHaveLength(4);
		expect(q.query).toContain("{ datetime_geq: $since, datetime_lt: $until, requestHost: $key }");
		expect(q.query).toContain(`limit: ${PAGE_LIMIT}, orderBy: [count_DESC]`);
		expect(q.query).toContain("dimensions { date }");
		expect(q.query).toContain("dimensions { refererHost }");
		expect(visitsQuery({ accountId: "acc", host: "acme.example", siteTag: "abc" }, now).query).toContain("siteTag: $key");
	});
	it("parses totals, days, pages and outside referrers; per-page lookup", () => {
		const v = parseVisits(visitsData.data, "acme.example", "s", "u");
		expect(v.days).toEqual([{ date: "2026-11-19", views: 100, visits: 70 }]);
		expect(viewsOfPath(v, "/about/")).toEqual({ views: 40, visits: 30 });
		expect(viewsOfPath(v, "/never")).toEqual({ views: 0, visits: 0 });
		const full: Visits = { ...v, pages: Array.from({ length: PAGE_LIMIT }, (_, i) => ({ path: `/p${i}`, views: 1, visits: 1 })) };
		expect(viewsOfPath(full, "/never")).toBeUndefined();
	});
	it("sends the token only in the Authorization header; errors never contain it", async () => {
		const seen: RequestInit[] = [];
		const ok = (async (_u: string, init: RequestInit) => {
			seen.push(init);
			return new Response(JSON.stringify(visitsData));
		}) as unknown as typeof fetch;
		await fetchVisits({ token: TOKEN, accountId: "acc", host: "acme.example" }, ok);
		expect((seen[0]?.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
		expect(String(seen[0]?.body)).not.toContain(TOKEN);
		await expect(fetchVisits({ token: TOKEN, accountId: "acc", host: "h" }, (async () => new Response(JSON.stringify({ errors: [{ message: `bad ${TOKEN}` }] }))) as unknown as typeof fetch)).rejects.toThrow(/\[token\]/);
		await expect(fetchVisits({ token: TOKEN, accountId: "acc", host: "h" }, (async () => new Response("", { status: 403 })) as unknown as typeof fetch)).rejects.toThrow(/Account Analytics → Read/);
		await expect(fetchVisits({ token: TOKEN, accountId: "acc", host: "h" }, (async () => Promise.reject(new Error(`connect ${TOKEN}`))) as unknown as typeof fetch)).rejects.not.toThrow(TOKEN);
	});
});

// ── Scaffold, docs, verify ────────────────────────────────────────────────────────────────────────────────────
describe("scaffold wiring, client docs and verify", () => {
	it("analytics options: seed, account, site tag, verification and the dated last verify check", () => {
		const dir = mkdtempSync(join(tmpdir(), "analytics-"));
		const state = join(dir, "state.json");
		expect(analyticsOptions({ seed: { google: [] }, accountId: "nope", stateFile: state })).toEqual({});
		writeFileSync(state, JSON.stringify({ version: 1, slug: "acme", createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-18T10:00:00Z", phases: { verify: { status: "failed", finishedAt: "2026-11-18T10:00:00.000Z", checks: [{ id: "analytics-runtime", label: "x", ok: false, detail: "Meta Pixel (fbevents.js) never requested" }] } } }));
		expect(analyticsOptions({ seed: { google: ["G-ABC123DEF4"] }, accountId: "0123456789abcdef0123456789abcdef", rum: { siteTag: "a".repeat(32), siteToken: "x", autoInstall: true }, stateFile: state, verification: { google: "x" } })).toEqual({ seed: { google: ["G-ABC123DEF4"] }, accountId: "0123456789abcdef0123456789abcdef", siteTag: "a".repeat(32), zoneBeacon: true, lastCheck: { at: "2026-11-18T10:00:00.000Z", ok: false, detail: "Meta Pixel (fbevents.js) never requested" }, verification: { google: "x" } });
	});
	it("scaffold always ships the SEO package and passes analytics to the SEO plugin", () => {
		const s = readFileSync(join(ROOT, "src/phases/scaffold.ts"), "utf8");
		expect(s).toContain('"@wp2emdash/seo": "link:./packages/seo"');
		expect(s).toContain('cpSync(join(KIT_ROOT, "packages", "seo")');
		expect(s).not.toContain("@wp2emdash/analytics");
		expect(s).toContain("config.seo.panel && config.analytics !== false ? { analyticsAdmin: true }");
		expect(s).toContain("analytics: analyticsOptions(");
	});
	it("client docs tell editors how to use SEO & Analytics", () => {
		const input = { name: "Acme", slug: "acme", sourceUrl: "https://acme.example", productionUrl: "https://acme.example", workerName: "acme", productionReady: false, sections: [], forms: [], email: { provider: "brevo", to: [] }, turnstileProduction: false, sensitiveData: false, stack: {} } as unknown as ClientRepoInput;
		const docs = Object.values(clientRepoFiles({ ...input, analyticsAdmin: true, analytics: { google: ["G-ABC123DEF4"] } })).join("\n");
		for (const s of ["SEO & Analytics", "Add a tracking code", "Conversion events", "Consent mode", "CF_ANALYTICS_TOKEN", "There is no place to paste code", "retired"]) expect(docs).toContain(s);
		const plain = Object.values(clientRepoFiles({ ...input, analytics: { google: ["G-ABC123DEF4"], meta: ["123456789012345"] } })).join("\n");
		expect(plain).not.toContain("Add a tracking code");
		expect(plain).toContain("- Meta Pixel `123456789012345`");
	});
	it("verify reads the live page's list and expects each service's loader request", () => {
		const html = `<head><meta name="site-analytics" content="{&quot;google&quot;:[&quot;G-ABC123DEF4&quot;],&quot;gtm&quot;:[],&quot;meta&quot;:[&quot;123456789012345&quot;],&quot;clarity&quot;:&quot;abcd1234ef&quot;,&quot;hotjar&quot;:&quot;3456789&quot;}"></head>`;
		const ids = liveTrackers(html);
		expect(ids).toEqual({ google: ["G-ABC123DEF4"], gtm: [], meta: ["123456789012345"], clarity: "abcd1234ef", hotjar: "3456789" });
		expect(liveTrackers("<head></head>")).toBeUndefined();
		const p = runtimeAnalyticsProblem({ trackers: ["https://www.googletagmanager.com/gtag/js"], csp: [] }, ids as NonNullable<typeof ids>);
		expect(p).toContain("Meta Pixel (fbevents.js) never requested");
		expect(p).toContain("Microsoft Clarity (clarity.ms tag) never requested");
		expect(p).toContain("Hotjar (hotjar script) never requested");
		expect(runtimeAnalyticsProblem({ trackers: ["https://www.googletagmanager.com/gtag/js", "https://connect.facebook.net/en_US/fbevents.js", "https://www.clarity.ms/tag/abcd1234ef", "https://static.hotjar.com/c/hotjar-3456789.js"], csp: [] }, ids as NonNullable<typeof ids>)).toBe("");
	});
});

describe("tracking loads after the page has drawn (Analytics switch, on by default)", () => {
	it("is on unless an admin turned it off, and reaches the page config", async () => {
		const { parseStored } = await import("../packages/seo/src/analytics/store.js");
		const { runtimeConfig } = await import("../packages/seo/src/analytics/trackers.js");
		const base = { trackers: [], events: {}, consent: false };
		expect(parseStored(base)?.defer).toBe(true);
		expect(parseStored({ ...base, defer: false })?.defer).toBe(false);
		expect(runtimeConfig([]).defer).toBe(true);
		expect(runtimeConfig([], { defer: false }).defer).toBeUndefined();
		expect(readFileSync(join(import.meta.dirname, "..", "starter/src/utils/analytics.ts"), "utf8")).toContain("defer: stored.defer");
	});
	it("the admin form has the switch, and the loader holds scripts until load + idle or the first input", () => {
		expect(readFileSync(join(import.meta.dirname, "..", "packages/seo/src/analytics/views.ts"), "utf8")).toContain('action_id: "defer", label: "Load tracking after the page has drawn"');
		const js = readFileSync(join(import.meta.dirname, "..", "starter/public/scripts/site-analytics.js"), "utf8");
		expect(js).toContain("const deferred = a.defer === true;");
		expect(js).toContain('const add = (src, attrs = {}) => (released ? insert(src, attrs) : waiting.push([src, attrs]));');
		expect(js).toContain('requestIdleCallback(release, { timeout: 2000 })');
		expect(js).toContain('["pointerdown", "keydown", "scroll", "touchstart"]');
	});
});
