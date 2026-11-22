import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildEstimate, loadRules, runEstimate } from "../src/commands/estimate.js";
import { adaptersFor, findingsFor } from "../src/estimate/blockers.js";
import { computeEffort, contentVolume } from "../src/estimate/effort.js";
import { classifyUrl, pickSample } from "../src/estimate/gather.js";
import { renderClientHtml, renderClientMarkdown, renderInternal } from "../src/estimate/report.js";
import { robotsAllows, robotsCrawlDelay } from "../src/estimate/robots.js";
import { DEFAULT_RULES, mergeRules } from "../src/estimate/rules.js";
import { imageFormat, pageResources, summarizeSpeed } from "../src/estimate/speed.js";
import type { Detections, PageSpeed } from "../src/estimate/types.js";

// Synthetic prospect: no real site, names invented.
const base = (o: Partial<Detections> = {}): Detections => ({
	url: "https://example-studio.test/",
	origin: "https://example-studio.test",
	host: "example-studio.test",
	at: "2026-11-22T10:00:00.000Z",
	homeStatus: 200,
	isWordPress: true,
	wordpressVersion: "6.6",
	theme: "salient",
	robots: { present: true, blocked: 1 },
	sitemaps: 2,
	restAvailable: true,
	restNamespaces: ["wp/v2", "contact-form-7/v1"],
	types: [
		{ slug: "page", count: 12 },
		{ slug: "post", count: 40 },
		{ slug: "team", count: 6 },
	],
	media: 120,
	terms: 9,
	discovered: 70,
	discoveredCapped: false,
	urlGuess: { pages: 20, posts: 40, archives: 10 },
	sample: [
		{ url: "https://example-studio.test/", status: 200, builders: ["wpbakery", "salient"], forms: 1, words: 400, passwordField: false },
		{ url: "https://example-studio.test/about/", status: 200, builders: ["wpbakery", "salient", "gutenberg"], forms: 0, words: 600, passwordField: false },
		{ url: "https://example-studio.test/blog/hello/", status: 200, builders: ["gutenberg"], forms: 0, words: 900, passwordField: false },
		{ url: "https://example-studio.test/contact/", status: 200, builders: ["wpbakery"], forms: 1, words: 100, passwordField: false },
	],
	builders: { wpbakery: 3, salient: 2, gutenberg: 2 },
	plugins: [
		{ slug: "js_composer_salient", name: "WPBakery (Salient bundled)", evidence: ["assets"], action: "adapter", replacement: "WPBakery adapter → section blocks" },
		{ slug: "contact-form-7", name: "Contact Form 7", evidence: ["assets", "rest"], action: "rebuild", replacement: "form section → Worker → email provider" },
		{ slug: "acme-calculator", name: "acme-calculator", evidence: ["assets"], action: "review", replacement: "Unknown plugin — review what it does on the site" },
	],
	hiddenWpPaths: false,
	integrations: [
		{ id: "form:contact-form-7:5", kind: "form", name: "contact-form-7 form #5", pages: ["/contact/"], pageCount: 1, evidence: ["Name, Email"], proposed: "rebuild", form: { id: "contact-form-7:5", provider: "contact-form-7", fields: [{ name: "your-name", type: "text", required: true }], hasCaptcha: [], inPopup: false, sensitiveFields: [] } },
		{ id: "calendly", kind: "booking", name: "Calendly", pages: ["/"], pageCount: 2, evidence: ["calendly.com"], proposed: "keep" },
		{ id: "ga4", kind: "analytics", name: "Google Analytics 4", pages: ["/"], pageCount: 4, evidence: ["gtag"], proposed: "keep" },
	],
	multilingual: { languages: [], otherHosts: 0 },
	multisite: false,
	accounts: { loginForms: 0, accountLinks: [] },
	...o,
});

const speedPage = (o: Partial<PageSpeed> = {}): PageSpeed => ({ url: "https://example-studio.test/", status: 200, ttfbMs: 900, totalMs: 1100, htmlKb: 80, requests: 42, weightKb: 2400, unknownSizes: 0, imageFormats: { jpg: 6, png: 2, webp: 1 }, resources: [], ...o });

describe("robots.txt", () => {
	const txt = "User-agent: *\nDisallow: /private/\nAllow: /private/open$\nCrawl-delay: 2\n\nUser-agent: wp2emdash\nDisallow: /no-estimates/\n";
	it("uses our own group when it exists, else *; longest match wins, Allow wins ties", () => {
		expect(robotsAllows(txt, "https://x.test/no-estimates/a")).toBe(false);
		// Our group replaces *: /private/ is not disallowed for us.
		expect(robotsAllows(txt, "https://x.test/private/a")).toBe(true);
		expect(robotsAllows(txt, "https://x.test/private/a", "otherbot")).toBe(false);
		expect(robotsAllows(txt, "https://x.test/private/open", "otherbot")).toBe(true);
		expect(robotsAllows(txt, "https://x.test/private/open/more", "otherbot")).toBe(false);
		expect(robotsAllows(undefined, "https://x.test/anything")).toBe(true);
		expect(robotsAllows("User-agent: *\nDisallow:\n", "https://x.test/a")).toBe(true);
		expect(robotsAllows("User-agent: *\nDisallow: /*.pdf$\n", "https://x.test/a/b.pdf")).toBe(false);
		expect(robotsCrawlDelay(txt, "otherbot")).toBe(2);
		expect(robotsCrawlDelay(txt)).toBeUndefined();
	});
});

describe("sample selection", () => {
	it("classifies addresses and starts with home, scope-revealing pages, then one per section", () => {
		expect(classifyUrl("https://x.test/2024/05/hello/")).toBe("post");
		expect(classifyUrl("https://x.test/blog/hello/")).toBe("post");
		expect(classifyUrl("https://x.test/category/news/")).toBe("archive");
		expect(classifyUrl("https://x.test/about/")).toBe("page");
		const urls = ["https://x.test/blog/a/", "https://x.test/blog/b/", "https://x.test/blog/c/", "https://x.test/category/x/", "https://x.test/team/", "https://x.test/contact/", "https://x.test/", "https://x.test/services/yoga/"];
		const pick = pickSample(urls, new Set(), 5);
		expect(pick[0]).toBe("https://x.test/");
		expect(pick[1]).toBe("https://x.test/contact/");
		expect(pick).toContain("https://x.test/team/");
		expect(pick.filter((u) => u.includes("/blog/")).length).toBe(1);
		expect(pick).not.toContain("https://x.test/category/x/");
		expect(pickSample(urls, new Set(urls), 5)).toEqual([]);
	});
});

describe("detections → adapters and findings", () => {
	it("routes WPBakery pages (Gutenberg classes next to them are the theme's) and blog posts to Gutenberg", () => {
		const a = adaptersFor(base());
		expect(a.map((x) => [x.adapter, x.share, x.proven])).toEqual([
			["wpbakery", 0.75, true],
			["gutenberg", 0.25, true],
		]);
	});

	it("flags out-of-scope items as excluded blockers, shop and sensitive forms as owner decisions", () => {
		const d = base({
			plugins: [...base().plugins, { slug: "sfwd-lms", name: "LearnDash", evidence: ["assets"], action: "out-of-scope", replacement: "" }, { slug: "woocommerce", name: "WooCommerce", evidence: ["assets"], action: "out-of-scope", replacement: "" }],
			shop: { source: "store-api", products: 30, published: 30, types: { simple: 30 }, variations: 0, onSale: 0, scheduledSales: 0, downloadable: 0, virtual: 0, stockManaged: 0, outOfStock: 0, reviews: 0, attributes: 0, hidden: 0, currency: "USD", plugins: { subscriptions: false, memberships: false, bookings: false } },
			multisite: true,
			multilingual: { languages: ["en", "fr"], otherHosts: 3 },
			integrations: [...base().integrations, { id: "form:x", kind: "form", name: "html form", pages: ["/intake/"], pageCount: 1, evidence: [], proposed: "decide", form: { id: "x", provider: "html", fields: [{ name: "dob", type: "date", required: true }], hasCaptcha: [], inPopup: false, sensitiveFields: ["dob"] } }],
		});
		const f = findingsFor(d, adaptersFor(d));
		const byId = Object.fromEntries(f.map((x) => [x.id, x]));
		expect(byId.lms).toMatchObject({ level: "blocker", excluded: true });
		expect(byId.multisite).toMatchObject({ level: "blocker", excluded: true });
		expect(byId.shop).toMatchObject({ level: "decision" });
		expect(byId.shop?.what).toContain("30 products");
		expect(byId["sensitive-forms"]).toMatchObject({ level: "decision" });
		expect(byId["unknown-plugins"]?.what).toContain("acme-calculator");
		// Folder languages are migrated with the site; languages on other hosts are separate sites.
		expect(byId.multilingual).toMatchObject({ level: "complexity" });
		expect(byId["language-hosts"]).toMatchObject({ level: "decision", excluded: true });
		expect(computeEffort(d, adaptersFor(d), f, DEFAULT_RULES).lines.find((l) => l.id === "multilingual")?.basis).toContain("1 extra language");
		expect(f[0]?.level).toBe("blocker");
		// Subscriptions or too many products: the shop itself is out of scope.
		const big = { ...d, shop: { ...(d.shop as NonNullable<Detections["shop"]>), products: 500 } };
		expect(findingsFor(big, adaptersFor(big)).find((x) => x.id === "shop-out-of-scope")).toMatchObject({ excluded: true });
	});

	it("marks fixture-only adapters and the DOM fallback as unproven", () => {
		const d = base({
			sample: [{ url: "https://e.test/", status: 200, builders: ["elementor"], forms: 0, words: 1, passwordField: false }, { url: "https://e.test/a/", status: 200, builders: [], forms: 0, words: 1, passwordField: false }],
			plugins: [{ slug: "bb-plugin", name: "Beaver Builder", evidence: ["assets"], action: "adapter", replacement: "" }],
		});
		const a = adaptersFor(d);
		expect(a.map((x) => x.adapter).sort()).toEqual(["dom-fallback", "elementor"]);
		expect(a.every((x) => !x.proven)).toBe(true);
		expect(findingsFor(d, a).filter((x) => x.id.startsWith("adapter-")).length).toBe(2);
	});
});

describe("effort rules", () => {
	it("adds one line per rule with its basis, contingency on top, no price without a rate", () => {
		const d = base();
		const a = adaptersFor(d);
		const e = computeEffort(d, a, findingsFor(d, a), DEFAULT_RULES);
		const ids = e.lines.map((l) => l.id);
		expect(ids).toEqual(["base", "pages-wpbakery", "pages-gutenberg", "posts", "collection-team", "visual", "forms", "integrations", "tracking", "unknown-plugins"]);
		expect(contentVolume(d)).toEqual({ pages: 12, posts: 40, collections: [{ slug: "team", count: 6 }] });
		// 12 pages × 0.75 → 9 WPBakery pages at 0.25–0.5 h.
		expect(e.lines.find((l) => l.id === "pages-wpbakery")).toMatchObject({ hours: [2.3, 4.5] });
		expect(e.lines.find((l) => l.id === "posts")).toMatchObject({ hours: [0.8, 2] });
		const low = e.lines.reduce((s, l) => s + l.hours[0], 0);
		expect(e.subtotal[0]).toBeCloseTo(low, 5);
		expect(e.total[1]).toBe(Math.round(e.subtotal[1] * 1.15));
		expect(e.cost).toBeUndefined();
		expect(e.size).toBe("Medium");
		const priced = computeEffort(d, a, findingsFor(d, a), DEFAULT_RULES, { rate: 100, currency: "USD" });
		expect(priced.cost).toEqual([priced.total[0] * 100, priced.total[1] * 100]);
	});

	it("adds no hours for excluded scope and lets the agency override any rule", () => {
		const d = base({ plugins: [{ slug: "memberpress", name: "MemberPress", evidence: ["assets"], action: "out-of-scope", replacement: "" }] });
		const a = adaptersFor(d);
		const e = computeEffort(d, a, findingsFor(d, a), DEFAULT_RULES);
		expect(e.excluded).toEqual(["Memberships or paywalled content"]);
		const tuned = mergeRules(structuredClone(DEFAULT_RULES), { effort: { base: [20, 30], contingency: 0 }, crawl: { concurrency: 12 }, agency: { name: "Studio X" } });
		expect(tuned.effort.base).toEqual([20, 30]);
		expect(tuned.effort.perForm).toEqual(DEFAULT_RULES.effort.perForm);
		expect(tuned.crawl.concurrency).toBe(4);
		expect(tuned.agency).toEqual({ name: "Studio X", url: "https://pixelkraft.net" });
		const e2 = computeEffort(d, a, [], tuned);
		expect(e2.total).toEqual([Math.round(e2.subtotal[0]), Math.round(e2.subtotal[1])]);
		expect(DEFAULT_RULES.effort.base).toEqual([10, 16]);
	});
});

describe("speed summary", () => {
	it("reads resources and image formats from HTML", () => {
		const html = `<link rel="stylesheet" href="/a.css"><script src="/b.js"></script><script>inline()</script><img src="/i/x.JPG?v=2"><img data-src="https://cdn.test/y.webp"><img src="data:image/png;base64,AA"><iframe src="https://www.youtube.com/embed/z"></iframe><link rel="preload" as="font" href="/f.woff2">`;
		const r = pageResources(html, "https://x.test/p/");
		expect(r.all).toEqual(["https://x.test/b.js", "https://x.test/a.css", "https://x.test/f.woff2", "https://www.youtube.com/embed/z", "https://x.test/i/x.JPG?v=2", "https://cdn.test/y.webp"]);
		expect(r.images.map(imageFormat)).toEqual(["jpg", "webp"]);
		expect(imageFormat("/a/b")).toBe("other");
	});

	it("takes medians and compares with the kit's measured numbers", () => {
		const s = summarizeSpeed([speedPage(), speedPage({ url: "https://example-studio.test/a/", ttfbMs: 300, weightKb: 500, requests: 12, imageFormats: { webp: 4 } }), speedPage({ url: "https://example-studio.test/b/", ttfbMs: 600, weightKb: 900, requests: 20, imageFormats: {} }), speedPage({ url: "https://example-studio.test/c/", status: 0, error: "x" })]);
		expect(s.ttfbMs).toBe(600);
		expect(s.weightKb).toBe(900);
		expect(s.requests).toBe(20);
		expect(s.imageFormats).toEqual({ jpg: 6, png: 2, webp: 5 });
		expect(s.modernImageShare).toBe(0.38);
		expect(s.comparisons.map((c) => c.verdict)).toEqual(["slower", "slower", "slower", "slower"]);
		expect(s.comparisons[0]?.emdash).toContain("600 ms");
		expect(s.notes.join(" ")).toContain("performance-findings.md");
		const fast = summarizeSpeed([speedPage({ ttfbMs: 200, weightKb: 300, requests: 9, imageFormats: { webp: 3 } })]);
		expect(fast.comparisons.map((c) => c.verdict)).toEqual(["similar", "similar", "similar", "similar"]);
		expect(summarizeSpeed([]).comparisons.every((c) => c.verdict === "unknown")).toBe(true);
	});
});

describe("reports", () => {
	const estimate = () => {
		const speed = summarizeSpeed([speedPage(), speedPage({ url: "https://example-studio.test/about/", ttfbMs: 700, weightKb: 1800, requests: 38 })]);
		return buildEstimate(base(), speed, loadRules(), { now: new Date("2026-11-22T10:00:00Z"), kit: "0.0.0-test", rate: 90, currency: "USD" });
	};

	it("render the client report (HTML, Markdown) and the internal sheet", async () => {
		const e = estimate();
		const html = renderClientHtml(e);
		expect(html).toContain("Prepared by <a href=\"https://pixelkraft.net\">PixelKraft</a>");
		expect(html).not.toMatch(/<script/i);
		expect(html).toContain("@media print");
		const md = renderClientMarkdown(e);
		expect(md).toContain("indicative budget **2,250–4,140 USD**");
		const internal = renderInternal(e);
		expect(internal).toContain("docs/PLAN.md §6");
		expect(internal).toContain("Basis");
		await expect(html).toMatchFileSnapshot("./golden/estimate/report.html");
		await expect(md).toMatchFileSnapshot("./golden/estimate/report.md");
		await expect(internal).toMatchFileSnapshot("./golden/estimate/internal.md");
	});

	it("escape whatever the prospect's site says", () => {
		const e = estimate();
		e.detections.integrations[1] = { ...(e.detections.integrations[1] as Detections["integrations"][number]), name: `<img src=x onerror=alert(1)>` };
		expect(renderClientHtml(e)).not.toContain("<img src=x");
	});
});

// --- End to end against a fake WordPress site on 127.0.0.1 (no real network).
let server: Server | undefined;
let out: string | undefined;
afterEach(() => {
	server?.close();
	if (out) rmSync(out, { recursive: true, force: true });
	server = out = undefined;
});

async function fakeSite() {
	const requests: { method: string; url: string }[] = [];
	let inFlight = 0;
	let maxInFlight = 0;
	server = createServer(async (req, res) => {
		inFlight++;
		maxInFlight = Math.max(maxInFlight, inFlight);
		await new Promise((r) => setTimeout(r, 5));
		const host = `http://${req.headers.host}`;
		const u = new URL(req.url ?? "/", host);
		requests.push({ method: req.method ?? "", url: `${u.pathname}${u.search}` });
		const done = (status: number, type: string, body: string, headers: Record<string, string> = {}) => {
			inFlight--;
			res.writeHead(status, { "content-type": type, "content-length": String(Buffer.byteLength(body)), ...headers }).end(req.method === "HEAD" ? undefined : body);
		};
		const page = (title: string, body: string) =>
			`<!doctype html><html lang="en"><head><title>${title}</title><meta name="generator" content="WordPress 6.6.2"><link rel="stylesheet" href="${host}/wp-content/plugins/js_composer/assets/css/js_composer.min.css"><link rel="stylesheet" href="${host}/wp-content/themes/salient/style.css"><script src="${host}/wp-content/plugins/contact-form-7/includes/js/index.js"></script><script src="https://www.googletagmanager.com/gtag/js?id=G-TEST123"></script></head><body class="page-template-default"><header><a href="${host}/">Home</a><a href="${host}/about/">About</a><a href="${host}/contact/">Contact</a><a href="${host}/private/x/">Hidden</a></header><div class="vc_row wpb_row"><div class="wpb_wrapper">${body}</div></div><img src="${host}/wp-content/uploads/2024/01/hero.jpg" width="10" height="10"><img src="${host}/wp-content/uploads/2024/01/b.webp"></body></html>`;
		const p = u.pathname;
		if (p === "/robots.txt") return done(200, "text/plain", `User-agent: *\nDisallow: /private/\nSitemap: ${host}/sitemap.xml\n`);
		if (p === "/sitemap.xml") return done(200, "application/xml", `<?xml version="1.0"?><urlset><url><loc>${host}/</loc></url><url><loc>${host}/about/</loc></url><url><loc>${host}/contact/</loc></url><url><loc>${host}/blog/first-post/</loc></url><url><loc>${host}/private/secret/</loc></url><url><loc>${host}/photo/</loc></url></urlset>`);
		// An attachment page that redirects to its file: fetched, not counted as a page.
		if (p === "/photo/") {
			inFlight--;
			return res.writeHead(301, { location: `${host}/wp-content/uploads/2024/01/hero.jpg` }).end();
		}
		if (p === "/") return done(200, "text/html; charset=utf-8", page("Home", `<h1>Studio</h1><a href="https://calendly.com/example-studio/intro">Book</a>`));
		if (p === "/about/") return done(200, "text/html", page("About", "<p>About us</p>"));
		if (p === "/contact/") return done(200, "text/html", page("Contact", `<div class="wpcf7" id="wpcf7-f5-p2-o1"><form class="wpcf7-form" method="post"><label>Your name <input name="your-name" type="text"></label><label>Email <input name="your-email" type="email"></label><textarea name="your-message"></textarea><input type="submit" value="Send"></form></div>`));
		if (p === "/blog/first-post/") return done(200, "text/html", page("Post", `<p class="wp-block-paragraph">Hello</p>`).replace('class="vc_row wpb_row"', 'class="entry"').replace('class="wpb_wrapper"', 'class="wp-block-group"'));
		if (p === "/wp-json/") return done(200, "application/json", JSON.stringify({ name: "Example Studio", namespaces: ["wp/v2", "contact-form-7/v1", "oembed/1.0"] }));
		if (p === "/wp-json/wp/v2/types") return done(200, "application/json", JSON.stringify({ page: { slug: "page", rest_base: "pages", rest_namespace: "wp/v2" }, post: { slug: "post", rest_base: "posts", rest_namespace: "wp/v2" }, attachment: { slug: "attachment", rest_base: "media", rest_namespace: "wp/v2" } }));
		if (p === "/wp-json/wp/v2/taxonomies") return done(200, "application/json", JSON.stringify({ category: { slug: "category", rest_base: "categories", rest_namespace: "wp/v2" } }));
		const totals: Record<string, number> = { "/wp-json/wp/v2/pages": 3, "/wp-json/wp/v2/posts": 1, "/wp-json/wp/v2/media": 2, "/wp-json/wp/v2/categories": 1 };
		if (p in totals) return done(200, "application/json", JSON.stringify([{ id: 1 }]), { "x-wp-total": String(totals[p]), "x-wp-totalpages": String(totals[p]) });
		if (p.endsWith(".jpg")) return done(200, "image/jpeg", "x".repeat(2048));
		if (p.endsWith(".webp")) return done(200, "image/webp", "x".repeat(1024));
		if (p.endsWith(".css") || p.endsWith(".js")) return done(200, p.endsWith(".css") ? "text/css" : "application/javascript", "/* x */");
		return done(404, "text/html", "<h1>Not found</h1>");
	});
	await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
	const origin = `http://127.0.0.1:${(server?.address() as AddressInfo).port}`;
	return { origin, requests, maxInFlight: () => maxInFlight };
}

describe("wp2emdash estimate (fake WordPress site)", () => {
	it("reads the public site politely and writes the four files", async () => {
		const site = await fakeSite();
		out = mkdtempSync(join(tmpdir(), "wp2emdash-estimate-"));
		const r = await runEstimate(site.origin, { outRoot: out, env: {}, quiet: true, now: new Date("2026-11-22T10:00:00Z"), rate: 100 });
		expect(r.dir).toBe(join(out, "127.0.0.1-2026-11-22"));
		for (const f of ["report.html", "report.md", "internal.md", "estimate.json"]) expect(existsSync(join(r.dir, f))).toBe(true);

		// Polite: GET/HEAD only, robots.txt honoured, ≤ 4 at a time.
		expect(new Set(site.requests.map((q) => q.method))).toEqual(new Set(["GET", "HEAD"]));
		expect(site.requests.some((q) => q.url.startsWith("/private/"))).toBe(false);
		expect(site.maxInFlight()).toBeLessThanOrEqual(4);
		// Counts only from REST: never a full listing.
		expect(site.requests.filter((q) => q.url.startsWith("/wp-json/wp/v2/pages")).every((q) => q.url.includes("per_page=1"))).toBe(true);

		const e = r.estimate;
		const d = e.detections;
		expect(d.isWordPress).toBe(true);
		expect(d.wordpressVersion).toBe("6.6.2");
		expect(d.siteName).toBe("Example Studio");
		expect(d.types).toEqual([
			{ slug: "page", count: 3 },
			{ slug: "post", count: 1 },
		]);
		expect(d.robots.blocked).toBeGreaterThanOrEqual(1);
		expect(d.sample.map((s) => new URL(s.url).pathname).sort()).toEqual(["/", "/about/", "/blog/first-post/", "/contact/", "/photo/"]);
		expect(d.sample.find((s) => s.url.endsWith("/photo/"))?.status).toBe(301);
		expect(d.plugins.map((p) => p.slug)).toEqual(expect.arrayContaining(["contact-form-7", "js_composer"]));
		expect(d.integrations.map((i) => i.id)).toEqual(expect.arrayContaining(["calendly", "form:contact-form-7:5"]));
		expect(e.adapters[0]).toMatchObject({ adapter: "wpbakery", proven: true });
		expect(e.effort.lines.map((l) => l.id)).toEqual(expect.arrayContaining(["base", "pages-wpbakery", "forms"]));
		expect(e.effort.cost?.[0]).toBe(e.effort.total[0] * 100);

		expect(e.speed.pages).toHaveLength(3);
		expect(e.speed.pages[0]?.url).toBe(`${site.origin}/`);
		expect(e.speed.pages[0]?.weightKb).toBeGreaterThan(2);
		expect(e.speed.imageFormats).toMatchObject({ jpg: 3, webp: 3 });
		expect(e.speed.lab).toBeUndefined();
		expect(e.speed.field).toBeUndefined();

		const json = JSON.parse(readFileSync(join(r.dir, "estimate.json"), "utf8"));
		expect(json.effort.total).toEqual(e.effort.total);
		expect(readFileSync(join(r.dir, "report.html"), "utf8")).toContain("PixelKraft");
	});

	it("names the agency from the options and merges a rules file", async () => {
		const site = await fakeSite();
		out = mkdtempSync(join(tmpdir(), "wp2emdash-estimate-"));
		const rules = join(out, "rules.json");
		writeFileSync(rules, JSON.stringify({ effort: { base: [100, 100], contingency: 0 }, crawl: { maxSample: 2 } }));
		const r = await runEstimate(site.origin, { outRoot: out, env: {}, quiet: true, agency: "Studio X", agencyUrl: "https://studio-x.test", rulesFile: rules, lab: true });
		expect(r.estimate.agency).toEqual({ name: "Studio X", url: "https://studio-x.test" });
		expect(r.estimate.detections.sample).toHaveLength(2);
		expect(r.estimate.effort.lines[0]?.hours).toEqual([100, 100]);
		// --lab without a key: no call, a stated reason.
		expect(r.estimate.speed.lab).toEqual({ missing: "no-key" });
		expect(readFileSync(join(r.dir, "report.html"), "utf8")).toContain("Studio X");
	});
});
