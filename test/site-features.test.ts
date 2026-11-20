/**
 * Site features: every menu (classes, title attribute, target, depth, mega panels), classic widget areas, the search
 * page, breadcrumbs, the old 404 page, 404 monitoring in Site health and coming-soon mode. Synthetic fixture:
 * test/fixtures/site-features/site.json layered on test/fixtures/blog. Goldens: test/golden/site-features/*.json
 * (regenerate after an intended change: UPDATE_GOLDEN=1 pnpm test).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isProbe, notFoundCheck, readNotFound, suggestRedirect, summarizeNotFound } from "../packages/health/src/checks/notfound.js";
import { createPlugin, parseUntil } from "../packages/health/src/plugin/index.js";
import { runChecks } from "../packages/health/src/run.js";
import { KEYS } from "../packages/health/src/store.js";
import { kitConfigSchema } from "../src/config/schema.js";
import { sitePaths } from "../src/core/paths.js";
import type { IrPage, IrSite } from "../src/ir/schema.js";
import { runTransform } from "../src/phases/transform.js";
import { buildSeed, emdashMenus, menuItemExtras, seedMediaResolver, seedWidgetAreas } from "../src/scaffold/seed.js";
import { emdashMenuNames, megaMenuIds, menuDepth, ownClasses } from "../src/transform/menus.js";
import { breadcrumbsOf, headerSearch, maintenancePlugin, notFoundContent } from "../src/transform/site-features.js";
import { placementOf, planWidgets, starterWidgetAreas, type WidgetPlan, widgetsFromOptions } from "../src/transform/widgets.js";
import { ancestorSlugs, breadcrumbListItems, pageTrail, postTrail } from "../starter/src/utils/breadcrumbs.js";
import { comingSoonHtml, maintenanceBypass, parseMaintenance, retryAfter } from "../starter/src/utils/maintenance.js";
import { excerptAround, highlight, matchesAll, mergeHits, resultExcerpt, resultHref, searchHref, searchParams } from "../starter/src/utils/search.js";
import { memoryKv } from "./health-fixtures.js";
import { cache as cfCache, env } from "./stubs/cloudflare-workers.js";

const blog = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "blog", "site.json"), "utf8"));
const fx = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "site-features", "site.json"), "utf8"));
const goldenDir = join(import.meta.dirname, "golden", "site-features");
const golden = (name: string, value: unknown) => {
	const file = join(goldenDir, name);
	const json = `${JSON.stringify(value, null, "\t")}\n`;
	if (process.env.UPDATE_GOLDEN === "1" || !existsSync(file)) {
		mkdirSync(goldenDir, { recursive: true });
		writeFileSync(file, json);
	}
	expect(json).toBe(readFileSync(file, "utf8"));
};

const dir = mkdtempSync(join(tmpdir(), "wp2e-features-"));
const put = (file: string, data: unknown) => {
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
};
const config = kitConfigSchema.parse({ slug: "features", name: "Example Journal", source: { url: "https://blog.example.test" }, target: { productionUrl: "https://blog.example.test" } });
const DECIDED = `export default { protectedPosts: { as: "draft", reason: "owner: members-only posts stay drafts" }, widgets: { "calendar-2": "html" } };\n`;

function workspace(name: string, overrides: string, opts: { notFound?: string } = {}) {
	const paths = sitePaths(name, dir);
	put(join(paths.raw, "extract.json"), {});
	put(join(paths.raw, "exporter", "options.json"), blog.options);
	put(join(paths.raw, "exporter", "content", "page.json"), blog.pages);
	put(join(paths.raw, "exporter", "content", "post.json"), blog.posts);
	put(join(paths.raw, "exporter", "taxonomies.json"), blog.taxonomies);
	put(join(paths.raw, "exporter", "analyze.json"), blog.analyze);
	put(join(paths.raw, "exporter", "menus.json"), fx.menus);
	put(join(paths.raw, "menu-items.json"), fx.menuItems);
	put(join(paths.raw, "widgets", "sidebars.json"), fx.sidebars);
	put(join(paths.raw, "widgets", "widgets.json"), fx.widgets);
	put(join(paths.raw, "media-manifest.json"), blog.media);
	put(join(paths.snapshot, "urls.json"), blog.urls);
	put(join(paths.snapshot, "discovery.json"), blog.discovery);
	put(join(paths.snapshot, "fingerprint.json"), fx.fingerprint);
	for (const [n, html] of Object.entries(fx.html as Record<string, string>)) put(join(paths.snapshot, "html", `${n}.html`), html);
	put(join(paths.snapshot, "not-found.html"), opts.notFound ?? fx.notFound);
	put(paths.overrides, overrides);
	return paths;
}
const run = (paths: ReturnType<typeof sitePaths>) => runTransform({ config, paths, reporter: { runId: "t", emit: () => {} } });
const read = <T>(file: string) => JSON.parse(readFileSync(file, "utf8")) as T;

describe("menus: every menu, classes, title attribute, target, depth, mega panels", () => {
	it("keeps the editor's own classes, drops WordPress's generated ones and Popup Maker triggers", () => {
		expect(ownClasses(["menu-item", "menu-item-type-custom", "current-menu-item", "megamenu", "popmake-628", "highlight", "highlight"])).toEqual(["megamenu", "highlight"]);
		expect(ownClasses("menu-item-has-children  cta")).toEqual(["cta"]);
		expect(ownClasses(null)).toEqual([]);
	});
	it("finds Max Mega Menu panels in the rendered header", () => {
		const html = `<ul><li class="mega-menu-item mega-menu-item-type-custom mega-menu-megamenu mega-menu-item-101" id="mega-menu-item-101"></li><li class="mega-menu-item mega-menu-flyout mega-menu-item-102"></li></ul>`;
		expect([...megaMenuIds(html)]).toEqual([101]);
		expect(megaMenuIds(undefined).size).toBe(0);
	});
	it("names every EmDash menu: the first of each header role by the role, the others by their own name", () => {
		const m = (name: string, role: IrSite["menus"][number]["role"]) => ({ name, role, wpLocations: [], items: [] });
		expect(emdashMenuNames([m("Main", "primary"), m("Off canvas", "primary"), m("Footer", "footer"), m("Social links", "other"), m("Primary", "other")])).toEqual(["primary", "off-canvas", "footer", "social-links", "primary-2"]);
	});
	it("menu items carry the kit's classes first, then the WordPress classes; the title attribute; mega", () => {
		expect(menuItemExtras({ label: "Book", href: "#", button: true, hoverLabel: "Now", classes: ["cta"], children: [] })).toEqual({ cssClasses: "button cta", titleAttr: "Now" });
		expect(menuItemExtras({ label: "About", href: "/about/", titleAttr: "About the studio", children: [] })).toEqual({ titleAttr: "About the studio" });
		expect(menuItemExtras({ label: "Services", href: "/s/", mega: true, classes: ["megamenu"], children: [] })).toEqual({ cssClasses: "mega megamenu" });
		expect(menuItemExtras({ label: "x", href: "/", children: [] })).toEqual({});
	});
	it("transform: three levels, the mega panel, REST extras, footer and social menus; seed writes every menu (golden)", async () => {
		const paths = workspace("menus", DECIDED);
		await run(paths);
		const site = read<IrSite>(join(paths.ir, "site.json"));
		golden("menus.json", site.menus);
		expect(site.menus.map((m) => [m.name, m.role])).toEqual([["Main", "primary"], ["Footer links", "footer"], ["Social", "other"]]);
		expect(menuDepth(site.menus[0]?.items ?? [])).toBe(3);
		expect(site.menus[0]?.items[0]).toMatchObject({ label: "About", titleAttr: "About the studio", description: "Who we are" });
		expect(site.menus[0]?.items[1]).toMatchObject({ label: "Services", mega: true, classes: ["megamenu", "columns-2"] });
		expect(site.menus[0]?.items[2]).toMatchObject({ label: "Shop", newTab: true, classes: ["external-link"] });
		expect(emdashMenus(site).map((m) => m.name)).toEqual(["primary", "secondary", "footer", "social"]);
		const md = readFileSync(join(paths.reports, "transform", "coverage.md"), "utf8");
		expect(md).toMatch(/## Menus[\s\S]*\| Main \| primary \| `primary` \| 7 \| 3 \| mega menu “Services”: partial[\s\S]*descriptions not carried[^|]*“About”: Who we are/);
		expect(md).toMatch(/\| Social \| social \| `social` \| 1 \| 1 \| — \|/);
		const seed = buildSeed({ name: "x", site, pages: [], partials: [], popups: [], media: seedMediaResolver(new Map(), (u) => u), titleSeparator: "-", forms: [], includeContent: false });
		const menus = seed.menus as { name: string; items: { label: string; target?: string; cssClasses?: string; titleAttr?: string; children?: { children?: unknown[] }[] }[] }[];
		expect(menus.map((m) => m.name)).toEqual(["primary", "secondary", "footer", "social"]);
		expect(menus[0]?.items[1]).toMatchObject({ label: "Services", cssClasses: "mega megamenu columns-2" });
		expect(menus[0]?.items[1]?.children?.[0]?.children).toHaveLength(1);
		expect(menus[0]?.items[2]).toMatchObject({ target: "_blank", cssClasses: "external-link" });
	});
});

describe("widgets: classic widget areas → EmDash widget areas", () => {
	it("places areas by id and name", () => {
		expect(placementOf({ id: "footer-2" })).toBe("footer");
		expect(placementOf({ id: "sidebar-1", name: "Blog Sidebar" })).toBe("sidebar");
		expect(placementOf({ id: "top", name: "Header Top Bar" })).toBe("header");
		expect(placementOf({ id: "slide-out-widget-area" })).toBe("other");
	});
	it("maps text, HTML, block, image, menu, search and blog widgets; the unknown one needs a decision (golden)", async () => {
		const undecided = workspace("widgets-undecided", `export default { protectedPosts: { as: "draft", reason: "owner: drafts" } };\n`);
		const failed = await run(undecided);
		expect(failed.find((c) => c.id === "widgets-handled")).toMatchObject({ ok: false });
		expect(failed.find((c) => c.id === "widgets-handled")?.detail).toMatch(/1 widget\(s\) without a mapping .*calendar-2 \(calendar\)/);

		const paths = workspace("widgets", DECIDED);
		const checks = await run(paths);
		expect(checks.find((c) => c.id === "widgets-handled")).toMatchObject({ ok: true });
		expect(checks.find((c) => c.id === "ir-valid")).toMatchObject({ ok: true });
		const plan = read<WidgetPlan>(join(paths.ir, "widgets.json"));
		golden("widgets.json", plan);
		const area = (n: string) => plan.areas.find((a) => a.name === n);
		expect(area("sidebar-1")?.widgets.map((w) => `${w.wpId}:${w.type}:${w.componentId ?? w.menuName ?? ""}`)).toEqual(["search-2:component:core:search", "recent-posts-2:component:core:recent-posts", "categories-2:component:core:categories", "block-5:component:core:search", "calendar-2:content:"]);
		expect(area("footer-1")?.widgets[1]).toMatchObject({ type: "menu", menuName: "footer", title: "Explore" });
		// The text widget's image points at the media library entry (size variant → original), for load to upload.
		expect(JSON.stringify(area("footer-1")?.widgets[0]?.content)).toContain('"wpId":31');
		expect(area("footer-2")?.widgets.find((w) => w.wpId === "media_image-2")?.content?.[0]).toMatchObject({ _type: "image", _media: { wpId: 32 } });
		expect(plan.notCarried).toEqual([{ wpId: "archives-2", area: "wp_inactive_widgets", why: "inactive (Appearance → Widgets → Inactive widgets)" }]);
		expect(plan.diagnostics.some((d) => d.widget === "media_image-2" && /image link not carried/.test(d.message))).toBe(true);
		expect(area("header-top")).toMatchObject({ widgets: [], shown: false });
		expect(starterWidgetAreas(plan)).toEqual({ footer: ["footer-1", "footer-2"], sidebar: ["sidebar-1"] });
		const md = readFileSync(join(paths.reports, "transform", "coverage.md"), "utf8");
		expect(md).toMatch(/## Widgets[\s\S]*\| Footer 2 \(`footer-2`\) \| `footer-2` \| footer \| yes \|[\s\S]*\*\*Not carried:\*\* `archives-2`/);
		// Seed: EmDash's seed shape (widgetAreas, `props` for component widgets), images at their WordPress file.
		const seedAreas = seedWidgetAreas(plan, seedMediaResolver(new Map([[31, { url: "https://blog.example.test/wp-content/uploads/2024/05/photo.jpg" }], [32, { url: "https://blog.example.test/wp-content/uploads/2024/06/team.jpg" }]]), (u) => u));
		golden("seed-widget-areas.json", seedAreas);
		expect(JSON.stringify(seedAreas)).not.toContain("_media");
	});
	it("blog widgets on a site without posts are listed as not carried, not lost silently", () => {
		const p = planWidgets({ sidebars: [{ id: "sidebar-1", widgets: ["recent-posts-2", "text-3"] }], widgets: [{ id: "recent-posts-2", id_base: "recent-posts" }, { id: "text-3", id_base: "text", instance: { raw: { text: "Hi" } } }], menuName: () => undefined, blog: false, pages: [], mediaIdForUrl: () => undefined, decisions: {} });
		expect(p.notCarried).toEqual([{ wpId: "recent-posts-2", area: "sidebar-1", why: "recent posts: the new site has no posts" }]);
		expect(p.areas[0]?.widgets.map((w) => w.wpId)).toEqual(["text-3"]);
		expect(p.unknown).toEqual([]);
	});
	it("reads a database dump's sidebars_widgets and widget_<type> options", () => {
		const r = widgetsFromOptions({ sidebars_widgets: { "sidebar-1": ["text-2"], wp_inactive_widgets: [], array_version: 3 }, widget_text: { 2: { title: "Hi", text: "<p>x</p>" }, _multiwidget: 1 } });
		expect(r).toEqual({ sidebars: [{ id: "sidebar-1", widgets: ["text-2"] }, { id: "wp_inactive_widgets", widgets: [] }], widgets: [{ id: "text-2", id_base: "text", sidebar: "sidebar-1", instance: { raw: { title: "Hi", text: "<p>x</p>" } } }] });
		expect(widgetsFromOptions({})).toBeUndefined();
	});
});

describe("site features from the audited HTML: header search, breadcrumbs, 404 page, maintenance plugin", () => {
	it("header search: Salient's switch, a search form in the header, none", () => {
		expect(headerSearch(`<body data-header-search="false"><header><form role="search"></form></header>`)).toBe(false);
		expect(headerSearch(`<body data-header-search="true"><div id="search-outer"></div>`)).toBe(true);
		expect(headerSearch(`<body><header class="site-header"><a class="search-toggle" href="#">S</a></header>`)).toBe(true);
		expect(headerSearch(`<body><header></header><aside><form role="search"></form></aside>`)).toBe(false);
	});
	it("breadcrumbs: Rank Math on pages and posts, with the first crumb's label", () => {
		expect(breadcrumbsOf(Object.values(fx.html as Record<string, string>).map((html) => ({ html })))).toEqual({ source: "rank-math", pages: true, posts: true, home: "Start" });
		expect(breadcrumbsOf([{ html: fx.html.home }])).toBeUndefined();
	});
	it("maintenance plugins are reported, by slug or markup", () => {
		expect(maintenancePlugin([{ slug: "wp-maintenance-mode" }], [])).toBe("LightStart (WP Maintenance Mode)");
		expect(maintenancePlugin([], [{ html: '<body class="elementor-maintenance-mode">' }])).toBe("maintenance page markup in the audited HTML");
		expect(maintenancePlugin([{ slug: "rankmath" }], [])).toBeUndefined();
	});
	it("the 404 page: customised wording kept without the chrome or the stock sentences; stock pages are not carried", () => {
		const c = notFoundContent(fx.notFound, ["blog.example.test"]);
		expect(c).toMatchObject({ heading: "Lost in the studio?", customised: true, links: [{ label: "Contact us", href: "/contact/" }, { label: "Back to home", href: "/" }] });
		expect(c.paragraphs).toHaveLength(1);
		expect(notFoundContent(fx.stockNotFound, ["blog.example.test"]).customised).toBe(false);
	});
	it("transform: the not-found site part and ir/site-features.json (golden); the maintenance plugin is reported", async () => {
		const paths = workspace("features", DECIDED);
		await run(paths);
		golden("site-features.json", read(join(paths.ir, "site-features.json")));
		const part = read<IrPage>(join(paths.ir, "partials", "not-found.json"));
		golden("not-found.json", part);
		expect(read<IrSite>(join(paths.ir, "site.json")).partials).toContainEqual({ role: "other", file: "partials/not-found.json" });
		const md = readFileSync(join(paths.reports, "transform", "coverage.md"), "utf8");
		expect(md).toMatch(/## Site features[\s\S]*header had a search icon[\s\S]*rank-math, pages, posts[\s\S]*rebuilt as the site part “not-found”[\s\S]*LightStart \(WP Maintenance Mode\)\. The new site's coming-soon mode/);
		const stock = workspace("stock-404", DECIDED, { notFound: fx.stockNotFound });
		await run(stock);
		expect(read<{ notFound: string }>(join(stock.ir, "site-features.json")).notFound).toBe("stock");
		expect(existsSync(join(stock.ir, "partials", "not-found.json"))).toBe(false);
	});
});

describe("starter search page helpers", () => {
	it("query and page from the address (WordPress ?s= too), bounded", () => {
		expect(searchParams(new URL("https://x.test/search/?q=%20yoga%20%20mat%20&page=3"))).toEqual({ q: "yoga mat", page: 3 });
		expect(searchParams(new URL("https://x.test/search/?s=pilates&page=999"))).toEqual({ q: "pilates", page: 20 });
		expect(searchParams(new URL("https://x.test/search/?page=-2"))).toEqual({ q: "", page: 1 });
		expect(searchHref("yoga mat", 2)).toBe("/search/?q=yoga+mat&page=2");
		expect(searchHref("a", 1, "never")).toBe("/search?q=a");
	});
	it("result addresses follow the WordPress path and the URL style; home is /", () => {
		expect(resultHref("home")).toBe("/");
		expect(resultHref("services/massage")).toBe("/services/massage/");
		expect(resultHref("about", "never")).toBe("/about");
	});
	it("marks the query's words and escapes everything else", () => {
		expect(highlight("Yoga & <b>Pilates</b> for yoga lovers", "yoga")).toBe("<mark>Yoga</mark> &amp; &lt;b&gt;Pilates&lt;/b&gt; for <mark>yoga</mark> lovers");
		expect(highlight("a (b)", "(b)")).toBe("a (b)");
		expect(highlight("x <script>", "")).toBe("x &lt;script&gt;");
	});
	it("excerpts around the first match; section text when there is no excerpt or SEO description", () => {
		const long = Array.from({ length: 80 }, (_, i) => (i === 50 ? "reformer" : `w${i}`)).join(" ");
		expect(excerptAround(long, "reformer", 10)).toBe("… w47 w48 w49 reformer w51 w52 w53 w54 w55 w56 …");
		const data = { title: "About", content: [{ _type: "section_rich_text", body: [{ _type: "block", children: [{ _type: "span", text: "We teach reformer classes." }] }] }] };
		expect(resultExcerpt(data, "reformer")).toBe("We teach reformer classes.");
		expect(resultExcerpt({ excerpt: "Short." }, "x")).toBe("Short.");
		expect(resultExcerpt(data, "x", "From SEO.")).toBe("From SEO.");
	});
	it("adds the pages whose sections contain every word after EmDash's ranked hits, without duplicates", () => {
		expect(matchesAll("Massage therapy for athletes", "massag athletes")).toBe(true);
		expect(matchesAll("Massage therapy", "massage yoga")).toBe(false);
		const merged = mergeHits([{ collection: "posts", slug: "2024/05/massage-tips", title: "Massage tips" }, { collection: "pages", slug: "massage", title: "Massage" }], [{ slug: "massage", title: "Massage", text: "" }, { slug: "about", title: "About", text: "We offer massage." }, { slug: "contact", title: "Contact", text: "Call us." }, { slug: "massage-prices", title: "Massage prices", text: "" }], "massage");
		expect(merged.map((h) => `${h.collection}:${h.slug}`)).toEqual(["posts:2024/05/massage-tips", "pages:massage", "pages:massage-prices", "pages:about"]);
	});
});

describe("starter breadcrumbs", () => {
	it("nested pages follow their path; posts go through the posts page; one trail for the page and the structured data", () => {
		expect(ancestorSlugs("services/body/massage")).toEqual(["services", "services/body"]);
		const trail = pageTrail("services/body/massage", "Massage", new Map([["services", "Our services"]]), { home: "Start" });
		expect(trail).toEqual([{ label: "Start", href: "/" }, { label: "Our services", href: "/services/" }, { label: "Body", href: "/services/body/" }, { label: "Massage" }]);
		expect(pageTrail("home", "Home", new Map(), {})).toEqual([]);
		expect(postTrail("Hello", { index: "/journal/", title: "Journal" }, {}, "never")).toEqual([{ label: "Home", href: "/" }, { label: "Journal", href: "/journal" }, { label: "Hello" }]);
		expect(postTrail("Hello", { index: "/" }, {})).toEqual([{ label: "Home", href: "/" }, { label: "Hello" }]);
		expect(breadcrumbListItems(trail, "https://x.test", "https://x.test/services/body/massage/")).toEqual([
			{ "@type": "ListItem", position: 1, name: "Start", item: "https://x.test/" },
			{ "@type": "ListItem", position: 2, name: "Our services", item: "https://x.test/services/" },
			{ "@type": "ListItem", position: 3, name: "Body", item: "https://x.test/services/body/" },
			{ "@type": "ListItem", position: 4, name: "Massage", item: "https://x.test/services/body/massage/" },
		]);
	});
});

describe("coming-soon mode (starter middleware + Site health)", () => {
	it("reads the stored switch; anything unreadable is off", () => {
		expect(parseMaintenance(JSON.stringify({ on: true, heading: " Soon ", until: "2026-12-01T09:00:00.000Z" }))).toEqual({ on: true, heading: "Soon", until: "2026-12-01T09:00:00.000Z" });
		expect(parseMaintenance('{"on":"yes"}')).toEqual({ on: false });
		expect(parseMaintenance("not json")).toEqual({ on: false });
		expect(parseMaintenance(null)).toEqual({ on: false });
	});
	it("never holds back the admin, EmDash's API, images, form posts or files", () => {
		for (const p of ["/_emdash/admin", "/_emdash/api/auth/login", "/_image", "/api/forms/contact", "/brand/logo.png", "/_astro/x.css", "/_consent/region"]) expect(maintenanceBypass(p), p).toBe(true);
		for (const p of ["/", "/about/", "/search/"]) expect(maintenanceBypass(p), p).toBe(false);
	});
	it("Retry-After from the announced time (5 minutes to a day), else an hour; the page escapes the owner's text", () => {
		const now = Date.parse("2026-11-21T10:00:00Z");
		expect(retryAfter({ on: true }, now)).toBe(3600);
		expect(retryAfter({ on: true, until: "2026-11-21T12:00:00Z" }, now)).toBe(7200);
		expect(retryAfter({ on: true, until: "2026-11-21T10:01:00Z" }, now)).toBe(300);
		expect(retryAfter({ on: true, until: "2026-12-30T10:00:00Z" }, now)).toBe(86_400);
		const html = comingSoonHtml({ on: true, message: "Back <soon> & better" }, { siteName: "Acme \"Studio\"", logo: "/brand/logo.png" });
		expect(html).toContain('<meta name="robots" content="noindex">');
		expect(html).toContain("Back &lt;soon&gt; &amp; better");
		expect(html).toContain('<img src="/brand/logo.png" alt="Acme &quot;Studio&quot;"');
		expect(html).not.toContain("<script");
		expect(comingSoonHtml({ on: true }, { siteName: "A", logo: "javascript:alert(1)" })).toContain('<p class="name">A</p>');
	});
	it("Site health: an admin switches it on in Settings (stored where the middleware reads it); checks that request the site pause", async () => {
		const kv = memoryKv();
		const plugin = createPlugin({ productionUrl: "https://acme.example", siteName: "Acme", live: true, alertsTo: [], reportTo: [], brand: { footer: "x" } }) as unknown as { routes: Record<string, { handler: (c: unknown) => Promise<unknown> }> };
		for (const k of Object.keys(env)) delete env[k];
		const self = vi.fn(async (_r: Request) => new Response("down for maintenance", { status: 503 }));
		Object.assign(env, { SELF: { fetch: self } });
		const call = (input: unknown) => plugin.routes.admin?.handler({ input, kv, cron: { schedule: async () => {}, list: async () => [] }, request: new Request("https://acme.example/_emdash/api/plugins/site-health/admin"), user: { role: 50 }, log: { info: () => {} } }) as Promise<{ blocks: Record<string, any>[]; toast?: { message: string } }>;
		const bad = await call({ type: "form_submit", action_id: "save-maintenance", values: { on: true, until: "next week" } });
		expect(bad.toast?.message).toMatch(/Not saved/);
		expect(await kv.get(KEYS.maintenance)).toBeNull();
		const purge = vi.fn(async (_o: { tags?: string[] }) => ({ success: true, errors: [] }));
		cfCache.purge = purge;
		const r = await call({ type: "form_submit", action_id: "save-maintenance", values: { on: true, heading: "Opening soon", message: "New site in December", until: "2026-12-01 09:00" } });
		// Cached pages never reach the middleware: saving purges them (every page carries these tags).
		expect(purge).toHaveBeenCalledTimes(1);
		expect(purge.mock.calls[0]?.[0].tags).toEqual(expect.arrayContaining(["emdash:settings"]));
		delete cfCache.purge;
		expect(r.toast?.message).toMatch(/Coming-soon mode is on/);
		expect(await kv.get(KEYS.maintenance)).toMatchObject({ on: true, heading: "Opening soon", message: "New site in December", until: "2026-12-01T09:00:00.000Z" });
		expect(parseMaintenance(JSON.stringify(await kv.get(KEYS.maintenance))).on).toBe(true);
		const overview = (r.blocks.find((b) => b.type === "tab")?.panels as { label: string; blocks: Record<string, any>[] }[])[0]?.blocks ?? [];
		expect(overview.some((b) => b.title === "Coming-soon mode is on")).toBe(true);
		// A run while it is on: no request to the site, uptime paused instead of "down", no incident.
		const res = await runChecks({ kv, options: { productionUrl: "https://acme.example", siteName: "Acme", live: true, alertsTo: [], reportTo: [], brand: { footer: "x" } }, env: {}, self: (u, i) => self(new Request(u, i)), fetch: async () => new Response("", { status: 404 }), now: Date.parse("2026-11-21T10:00:00Z") });
		expect(self).not.toHaveBeenCalled();
		expect(res.state.checks.uptime?.status).toBe("off");
		expect(res.state.checks.indexability?.summary).toMatch(/coming-soon mode is on/);
		expect(parseUntil("2026-12-01")).toEqual({ until: "2026-12-01T00:00:00.000Z" });
		expect(parseUntil("")).toEqual({});
	});
});

describe("404 monitoring (Site health → Missing pages)", () => {
	const SITE = ["/", "/about-us/", "/services/massage/", "/blog/hello-world/"];
	it("bot probes are counted, not listed", () => {
		for (const p of ["/wp-login.php", "/xmlrpc.php", "/.env", "/wp-admin/", "/backup.zip", "/.git/config", "/phpmyadmin/"]) expect(isProbe(p), p).toBe(true);
		for (const p of ["/old-page/", "/services/massage-therapy/", "/.well-known/security.txt"]) expect(isProbe(p), p).toBe(false);
	});
	it("suggests a redirect: same last segment, else most shared words", () => {
		expect(suggestRedirect("/old/hello-world/", SITE)).toBe("/blog/hello-world/");
		expect(suggestRedirect("/massage.html", SITE)).toBe("/services/massage/");
		expect(suggestRedirect("/about/", SITE)).toBe("/about-us/");
		expect(suggestRedirect("/about-us-team/", SITE)).toBe("/about-us/");
		expect(suggestRedirect("/zzz/", SITE)).toBeUndefined();
	});
	it("the week's list and the check: attention when an address keeps failing", () => {
		const s = summarizeNotFound([{ path: "/old/hello-world/", hits: 7, lastSeen: "2026-11-20T10:00:00Z", referrer: "https://google.com/" }, { path: "/wp-login.php", hits: 50, lastSeen: "2026-11-20T10:00:00Z" }, { path: "/typo/", hits: 1, lastSeen: "2026-11-19T10:00:00Z" }], SITE, "2026-11-21T00:00:00Z");
		expect(s).toEqual({ at: "2026-11-21T00:00:00Z", top: [{ path: "/old/hello-world/", hits: 7, lastSeen: "2026-11-20T10:00:00Z", referrer: "https://google.com/", suggest: "/blog/hello-world/" }, { path: "/typo/", hits: 1, lastSeen: "2026-11-19T10:00:00Z" }], probes: 1 });
		expect(notFoundCheck(s, "t")).toMatchObject({ status: "warn", detail: ["/old/hello-world/ (7× → /blog/hello-world/)", "1 bot probe left out (wp-login.php, .env and similar)."] });
		expect(notFoundCheck({ at: "t", top: [], probes: 0 }, "t").status).toBe("ok");
		expect(notFoundCheck(undefined, "t").status).toBe("unknown");
	});
	it("reads EmDash's 404 log with one query (last seen within the window, most hits first)", async () => {
		const seen: unknown[][] = [];
		const db = { prepare: (q: string) => ({ bind: (...v: unknown[]) => (seen.push([q, ...v]), { all: async () => ({ results: [{ path: "/x/", hits: 3, last_seen: "2026-11-20", referrer: null }] }) }) }) };
		expect(await readNotFound(db as never, "2026-11-14T00:00:00.000Z")).toEqual([{ path: "/x/", hits: 3, lastSeen: "2026-11-20", referrer: null }]);
		expect(String(seen[0]?.[0])).toMatch(/FROM _emdash_404_log WHERE COALESCE\(last_seen_at, created_at\) >= \? ORDER BY hits DESC LIMIT \?/);
		expect(await readNotFound(undefined, "x")).toBeUndefined();
	});
});

beforeEach(() => {});
afterEach(() => vi.unstubAllGlobals());
