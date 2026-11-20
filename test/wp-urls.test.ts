/**
 * "Nothing lost silently": the WordPress-URL rule set (starter middleware + verify), the content inventory gate
 * (transform `content-types-handled`), Customizer Additional CSS, and verify's `urls-accounted` judged against a
 * simulated new site that applies the same rules as the starter middleware.
 * Golden: test/golden/wp-urls/blog-site.json (regenerate after an intended change: UPDATE_GOLDEN=1 pnpm test).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { overridesSchema } from "../src/config/overrides.js";
import { kitConfigSchema } from "../src/config/schema.js";
import { sitePaths } from "../src/core/paths.js";
import { readCustomCss } from "../src/phases/extract.js";
import { runTransform } from "../src/phases/transform.js";
import { contentInventory, inventoryDetail } from "../src/transform/content-types.js";
import { customCssFromHtml, customStylesheet, describeCss } from "../src/transform/custom-css.js";
import { buildWpUrlPlan, matchWpUrl, type WpUrlRules } from "../src/transform/wp-urls.js";
import { accountDetail, accountUniverse, judgeUrl, probeUrl, type UniverseInput } from "../src/verify/urls-accounted.js";

const fx = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "wp-urls", "blog-site.json"), "utf8")) as {
	options: { page_for_posts: number };
	publishedPages: string[];
	pageIds: Record<string, string>;
	library: string[];
	urls: UniverseInput["urls"];
	discovery: NonNullable<UniverseInput["discovery"]> & { terms: { id: number; taxonomy: string; slug: string; link: string; count: number }[] };
	postDates: string[];
	pageAssets: string[];
	exporter: { types: { name: string; entries: { status: string; handled: boolean }[] }[]; taxonomies: { name: string; terms: { count: number }[] }[]; authors: { name: string; posts: number }[] };
};

const plan = (over: Record<string, unknown> = {}, extra: Partial<Parameters<typeof buildWpUrlPlan>[0]> = {}) =>
	buildWpUrlPlan({
		pages: fx.publishedPages,
		routeById: new Map(Object.entries(fx.pageIds).map(([k, v]) => [Number(k), v])),
		publishedPosts: 2,
		blogPageId: fx.options.page_for_posts,
		discovery: { ...fx.discovery, terms: fx.discovery.terms.filter((t) => t.count > 0) },
		overrides: overridesSchema.parse(over),
		trailingSlash: "always",
		...extra,
	});

/** The new site as the starter middleware answers it: pages 200, wpIds 301, the rule set, legacy uploads, else 404. */
function fakeSite(rules: WpUrlRules, wpIds: Record<string, string>, pages: string[], library: string[]): typeof fetch {
	const media = (name: string) => {
		const original = name.replace(/-(?:\d+x\d+|scaled)(?=\.[a-z0-9]+$)/i, "");
		return library.includes(original) ? `/_emdash/api/media/file/${original}` : undefined;
	};
	const answer = (url: string): Response => {
		const u = new URL(url);
		const redirect = (to: string) => new Response(null, { status: 301, headers: { location: to } });
		if (u.pathname.startsWith("/_emdash/api/media/file/")) return new Response("x", { status: 200 });
		const id = u.pathname === "/" ? (u.searchParams.get("page_id") ?? u.searchParams.get("p")) : null;
		if (id && wpIds[id]) return redirect(wpIds[id] as string);
		const wp = matchWpUrl(u.pathname, u.searchParams, rules, wpIds);
		if (wp && "file" in wp) {
			const to = media(wp.file);
			return to ? redirect(to) : "to" in wp.fallback ? redirect(wp.fallback.to) : new Response("gone", { status: 410 });
		}
		if (wp && "to" in wp) return redirect(wp.to);
		if (wp) return new Response("x", { status: "gone" in wp ? 410 : 404 });
		const upload = /^\/wp-content\/uploads\/\d{4}\/\d{2}\/([^/]+)$/.exec(u.pathname)?.[1];
		if (upload) return media(upload) ? redirect(media(upload) as string) : new Response("x", { status: 404 });
		if (pages.includes(u.pathname)) return new Response("<html>", { status: 200 });
		// The starter's search page (pages/search.astro) answers every query.
		if (u.pathname === "/search/") return new Response("<html>", { status: 200 });
		return new Response("x", { status: 404 });
	};
	return (async (input: string | URL) => answer(String(input))) as typeof fetch;
}

const universe = () => accountUniverse({ urls: fx.urls, discovery: fx.discovery, pageAssets: fx.pageAssets, postDates: fx.postDates, siteHosts: new Set(["example.test"]), rules: plan().rules });

describe("WordPress-URL rules (starter middleware)", () => {
	const { rules } = plan();
	const m = (path: string, wpIds: Record<string, string> = {}) => {
		const u = new URL(path, "https://example.test");
		return matchWpUrl(u.pathname, u.searchParams, rules, wpIds);
	};
	it("sends feeds to the blog page and gives comment feeds a 410", () => {
		for (const p of ["/feed/", "/feed", "/feed/atom/", "/?feed=rss2", "/wp-rss2.php"]) expect(m(p), p).toEqual({ kind: "feed", to: "/blog/" });
		for (const p of ["/comments/feed/", "/?feed=comments-rss2", "/wp-commentsrss2.php"]) expect(m(p), p).toEqual({ kind: "comments-feed", gone: true });
		// A page's comment feed goes to the page; an archive's feed follows the archive's rule.
		expect(m("/about/feed/")).toEqual({ kind: "comments-feed", to: "/about/" });
		expect(m("/category/news/feed/")).toEqual({ kind: "category", to: "/blog/" });
		expect(m("/hello-world/feed/")).toEqual({ kind: "comments-feed", gone: true });
	});
	it("handles search, archives, query forms and pagination", () => {
		// The starter's search page (EmDash full-text search) gets the query.
		expect(m("/?s=pilates")).toEqual({ kind: "search", to: "/search/?q=pilates" });
		expect(m("/search/pilates/")).toEqual({ kind: "search", to: "/search/?q=pilates" });
		expect(m("/?s=")).toEqual({ kind: "search", to: "/search/" });
		expect(m("/search/")).toBeUndefined();
		for (const [p, kind] of [["/category/news/", "category"], ["/category/news/page/2/", "category"], ["/tag/tips/", "tag"], ["/author/admin/", "author"], ["/2024/05/", "date"], ["/2024/", "date"], ["/2024/05/10/", "date"], ["/?cat=7", "category"], ["/?tag=tips", "tag"], ["/?author=1", "author"], ["/?m=202405", "date"]] as const) expect(m(p), p).toEqual({ kind, to: "/blog/" });
		expect(m("/page/2/")).toEqual({ kind: "paged", to: "/" });
		expect(m("/services/page/3/")).toEqual({ kind: "paged", to: "/services/" });
		// Unknown ?p= / ?page_id= → 404 (WordPress does the same); known ids are the middleware's wpIds map.
		expect(m("/?p=999")).toEqual({ kind: "wp-id", notFound: true });
		expect(m("/?page_id=5", { "5": "/services/" })).toBeUndefined();
	});
	it("sends attachment pages to the parent page, else the file, else home", () => {
		expect(m("/about/team-photo/")).toEqual({ kind: "attachment", to: "/about/" });
		// Parent is a post (not migrated): the file, with home as the fallback when it is not in the media library.
		expect(m("/hello-world/photo/")).toEqual({ kind: "attachment", file: "photo.jpg", fallback: { to: "/" } });
		expect(m("/?attachment_id=31")).toEqual({ kind: "attachment", file: "logo.png", fallback: { to: "/" } });
		expect(m("/?p=31")).toEqual({ kind: "attachment", file: "logo.png", fallback: { to: "/" } });
	});
	it("never touches a real page or an ordinary address", () => {
		for (const p of ["/", "/about/", "/blog/", "/services/", "/contact", "/wp-content/uploads/2024/05/photo.jpg", "/?utm_source=x"]) expect(m(p), p).toBeUndefined();
		// A migrated page that happens to live under an archive base wins.
		const own = buildWpUrlPlan({ pages: ["/", "/category/special/"], routeById: new Map(), publishedPosts: 0, overrides: overridesSchema.parse({}), trailingSlash: "always" }).rules;
		expect(matchWpUrl("/category/special/", new URLSearchParams(), own)).toBeUndefined();
	});
	it("follows the live permalink bases and the URL style", () => {
		const r = buildWpUrlPlan({ pages: ["/", "/journal"], routeById: new Map([[4, "/journal"]]), blogPageId: 4, publishedPosts: 3, discovery: { terms: [{ taxonomy: "category", slug: "news", link: "https://example.test/topics/news/" }, { taxonomy: "category", slug: "kids", link: "https://example.test/topics/news/kids/" }] }, overrides: overridesSchema.parse({}), trailingSlash: "never" });
		expect(r.rules.bases).toEqual({ category: "/topics/" });
		expect(matchWpUrl("/topics/news/kids/", new URLSearchParams(), r.rules)).toEqual({ kind: "category", to: "/journal" });
		expect(matchWpUrl("/category/news/", new URLSearchParams(), r.rules)).toBeUndefined();
		expect(r.feedPending).toBe(true);
	});
});

describe("WordPress-URL defaults per site", () => {
	it("brochure site (no posts, no blog page): feed → home, archives 410, author → home, search → the search page", () => {
		const r = buildWpUrlPlan({ pages: ["/", "/about-us/"], routeById: new Map(), publishedPosts: 0, overrides: overridesSchema.parse({}), trailingSlash: "always" });
		expect(Object.fromEntries(r.explain.map((e) => [e.rule, e.target]))).toEqual({ feed: "/", commentsFeed: "gone", search: "/search/", category: "gone", tag: "gone", author: "/", date: "gone", attachment: "/" });
		// URL style "never": /search, the query along; the owner can still send search home (overrides.ts wpUrls.search).
		const never = buildWpUrlPlan({ pages: ["/", "/about-us"], routeById: new Map(), publishedPosts: 0, overrides: overridesSchema.parse({}), trailingSlash: "never" });
		expect(matchWpUrl("/", new URLSearchParams("s=yoga mat"), never.rules)).toEqual({ kind: "search", to: "/search?q=yoga%20mat" });
		const home = buildWpUrlPlan({ pages: ["/"], routeById: new Map(), publishedPosts: 0, overrides: overridesSchema.parse({ wpUrls: { search: "home" } }), trailingSlash: "always" });
		expect(matchWpUrl("/", new URLSearchParams("s=x"), home.rules)).toEqual({ kind: "search", to: "/" });
		expect(r.feedPending).toBe(false);
	});
	it("a /search/ page takes the query; overrides win and are reported", () => {
		const r = buildWpUrlPlan({ pages: ["/", "/search/"], routeById: new Map(), publishedPosts: 0, overrides: overridesSchema.parse({ wpUrls: { feed: "gone", category: "home", tag: "/nowhere/" } }), trailingSlash: "always" });
		expect(matchWpUrl("/", new URLSearchParams("s=a b"), r.rules)).toEqual({ kind: "search", to: "/search/?q=a%20b" });
		expect(matchWpUrl("/feed/", new URLSearchParams(), r.rules)).toEqual({ kind: "feed", gone: true });
		expect(matchWpUrl("/category/x/", new URLSearchParams(), r.rules)).toEqual({ kind: "category", to: "/" });
		expect(r.explain.find((e) => e.rule === "tag")?.why).toMatch(/not a migrated page/);
		expect(r.explain.find((e) => e.rule === "feed")?.source).toBe("override");
	});
	it("rejects bad overrides", () => {
		expect(overridesSchema.safeParse({ wpUrls: { feed: "elsewhere" } }).success).toBe(false);
		expect(overridesSchema.safeParse({ gone: { "/x/": "" } }).success).toBe(false);
		expect(overridesSchema.safeParse({ contentTypes: { portfolio: { as: "skip" } } }).success).toBe(false);
	});
});

describe("content inventory (transform content-types-handled)", () => {
	const samples = { types: { post: ["/hello-world/", "/second-post/"], portfolio: ["/portfolio/project-a/"] }, taxonomies: { category: ["/category/news/"] }, authors: ["/author/admin/"] };
	it("lists every non-empty type, taxonomy in use and author with posts; undecided ones fail", () => {
		const rows = contentInventory({ ...fx.exporter, samples, attachments: 3, overrides: overridesSchema.parse({}) });
		const by = Object.fromEntries(rows.map((r) => [`${r.group}:${r.name}`, r.status]));
		expect(by).toEqual({ "type:page": "migrated", "type:post": "undecided", "type:portfolio": "undecided", "type:acf-field-group": "internal", "type:attachment": "migrated", "taxonomy:category": "undecided", "taxonomy:post_tag": "undecided", "taxonomy:post_format": "internal", "authors:Admin": "undecided" });
		expect(rows.find((r) => r.name === "post")?.note).toMatch(/1 Gutenberg\/classic post.*1 builder post/);
		expect(rows.find((r) => r.name === "portfolio")?.samples).toEqual(["/portfolio/project-a/"]);
		expect(inventoryDetail(rows)).toMatch(/^5 need a decision.*post \(2\), portfolio \(1\), taxonomy category \(1\), taxonomy post_tag \(1\), authors Admin \(1\)$/);
	});
	it("passes once every one is decided, with the reason", () => {
		const overrides = overridesSchema.parse({ contentTypes: { post: { as: "pages", reason: "two news items, kept as pages" }, portfolio: { as: "skip", reason: "owner: old projects" } }, taxonomies: { category: { as: "skip", reason: "no archives" }, post_tag: { as: "skip", reason: "no archives" } }, authors: { as: "skip", reason: "brochure site" } });
		const rows = contentInventory({ ...fx.exporter, samples, overrides });
		expect(rows.some((r) => r.status === "undecided")).toBe(false);
		expect(rows.find((r) => r.name === "portfolio")?.decision?.reason).toBe("owner: old projects");
		expect(inventoryDetail(rows)).toMatch(/^migrated: page; decided: post, portfolio, category, post_tag, Admin; internal: acf-field-group, post_format$/);
	});
	it("a site whose posts are all builder posts needs no decision", () => {
		const rows = contentInventory({ types: [{ name: "post", entries: [{ status: "publish", handled: true }] }], taxonomies: [], authors: [], samples: { types: {}, taxonomies: {}, authors: [] }, overrides: overridesSchema.parse({}) });
		expect(rows[0]?.status).toBe("migrated");
	});
});

describe("Customizer Additional CSS", () => {
	const css = "/* hi */\n.site-header .logo img { max-height: 60px; }\n@media (max-width: 600px) { .hero h1, .hero h2 { font-size: 2rem; } }\n.bg { background: url('https://example.test/wp-content/uploads/2024/05/bg.jpg'); }\n@import url('https://fonts.example.net/x.css');";
	it("reads it from the live page and describes it", () => {
		expect(customCssFromHtml(`<head><style id="wp-custom-css">\n${css}\n</style></head>`)).toBe(css);
		expect(customCssFromHtml("<style id='other'>a{}</style>")).toBeUndefined();
		const d = describeCss(css);
		expect(d.selectors).toEqual([".site-header .logo img", ".hero h1", ".hero h2", ".bg"]);
		expect(d.media).toEqual(["(max-width: 600px)"]);
		expect(d.uploads).toEqual(["https://example.test/wp-content/uploads/2024/05/bg.jpg"]);
		expect(d.external).toEqual(["https://fonts.example.net/x.css"]);
	});
	it("prefers the live pages; other themes' posts are listed as inactive", async () => {
		const dir = mkdtempSync(join(tmpdir(), "wp2e-css-"));
		mkdirSync(join(dir, "html"));
		writeFileSync(join(dir, "html", "home.html"), `<style id="wp-custom-css">${css}</style>`);
		const posts = [{ slug: "salient", content: css }, { slug: "twentytwenty", content: "body{color:red}" }] as never;
		expect(await readCustomCss(dir, async () => posts)).toEqual({ source: "live-html", css, inactive: [{ slug: "twentytwenty", bytes: 15 }] });
		expect(await readCustomCss(join(dir, "none"), async () => [{ slug: "salient", content: "a{}" }] as never)).toEqual({ source: "exporter", css: "a{}" });
		expect(await readCustomCss(join(dir, "none"), async () => [])).toBeUndefined();
	});
	it("carried CSS is its own content-hashed file, never inline", () => {
		const a = customStylesheet(css);
		expect(a.file).toMatch(/^custom-[0-9a-f]{10}\.css$/);
		expect(a.content).toContain(css);
		expect(customStylesheet(`${css} `).file).not.toBe(a.file);
		const base = readFileSync(join(import.meta.dirname, "..", "starter", "src", "layouts", "Base.astro"), "utf8");
		expect(base).toMatch(/<body[^>]*>\s*\{\/\*[\s\S]*?\*\/\}\s*\{\(site as \{ customCss\?: string \}\)\.customCss && <link rel="stylesheet"/);
		expect(base).not.toMatch(/<style[^>]*>\s*\{.*customCss/);
	});
});

describe("transform phase: content types, Additional CSS, WordPress-URL rules", () => {
	const dir = mkdtempSync(join(tmpdir(), "wp2e-nothing-lost-"));
	const put = (file: string, data: unknown) => {
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
	};
	const entry = (id: number, type: string, slug: string, title: string, content: string) => ({ id, post_type: type, status: "publish", slug, title, content, excerpt: "", date_gmt: "2024-05-10 09:00:00", modified_gmt: "2024-05-10 09:00:00", parent: null, menu_order: 0, taxonomies: {}, meta: {} });
	const config = kitConfigSchema.parse({ slug: "s", name: "Fixture", source: { url: "https://example.test" }, target: { productionUrl: "https://example.test" } });
	const html = (h1: string, p: string) => `<!doctype html><html><head><style id="wp-custom-css">.site-header .logo img { max-height: 60px; }</style></head><body><main><h1>${h1}</h1><p>${p}</p></main></body></html>`;
	const setup = (name: string, overrides?: string) => {
		const paths = sitePaths(name, dir);
		put(join(paths.raw, "extract.json"), {});
		put(join(paths.raw, "exporter", "options.json"), { blogname: "Fixture", page_on_front: 1 });
		put(join(paths.raw, "exporter", "content", "page.json"), [entry(1, "page", "home", "Home", "<p>Welcome.</p>")]);
		put(join(paths.raw, "exporter", "content", "post.json"), [entry(10, "post", "hello-world", "Hello world", "<!-- wp:paragraph --><p>First post.</p><!-- /wp:paragraph -->")]);
		put(join(paths.raw, "exporter", "content", "portfolio.json"), [entry(20, "portfolio", "project-a", "Project A", "<p>A project.</p>")]);
		put(join(paths.raw, "exporter", "taxonomies.json"), [{ name: "category", terms: [{ id: 7, slug: "news", count: 1 }] }]);
		put(join(paths.raw, "exporter", "analyze.json"), { authors: [{ display_name: "Admin", post_count: "1" }], attachments: { count: 0 } });
		put(join(paths.snapshot, "urls.json"), [{ path: "/", wp: { id: 1 } }, { path: "/hello-world/", wp: { id: 10 } }, { path: "/portfolio/project-a/", wp: { id: 20 } }]);
		put(join(paths.snapshot, "discovery.json"), { items: [{ id: 20, type: "portfolio", link: "https://example.test/portfolio/project-a/" }], terms: [{ id: 7, taxonomy: "category", slug: "news", link: "https://example.test/category/news/", count: 1 }], authors: [], media: [] });
		put(join(paths.snapshot, "pages", "home.json"), { wpId: 1, url: "https://example.test/", seo: {} });
		put(join(paths.snapshot, "html", "home.html"), html("Home", "Welcome."));
		if (overrides) put(paths.overrides, overrides);
		return paths;
	};
	const run = async (paths: ReturnType<typeof sitePaths>) => runTransform({ config, paths, reporter: { runId: "t", emit: () => {} } });

	it("fails until every type, taxonomy, author and the Additional CSS is decided, and reports each", async () => {
		const paths = setup("open");
		const checks = await run(paths);
		// The Gutenberg post is migrated by the blog; its category (no post_types, unused by the post) and its author (no
		// author on the post entry, so no byline) still need decisions.
		expect(checks.find((c) => c.id === "content-types-handled")).toMatchObject({ ok: false, detail: "3 need a decision (coverage report → Content types; overrides.ts contentTypes / taxonomies / authors): portfolio (1), taxonomy category (1), authors Admin (1)" });
		expect(checks.find((c) => c.id === "custom-css")).toMatchObject({ ok: false });
		const md = readFileSync(join(paths.reports, "transform", "coverage.md"), "utf8");
		expect(md).toMatch(/## Content types[\s\S]*\| type \| portfolio \| 1 \| 1 \| ❌ undecided \| no collection for this type; proposed: \{ as: "collection" \} \(the Exporter does not list it as a public type\), "pages" or "skip" \| `\/portfolio\/project-a\/` \|/);
		expect(md).toMatch(/## Additional CSS \(Customizer\)[\s\S]*`\.site-header \.logo img`/);
		expect(md).toMatch(/## WordPress URLs[\s\S]*\| feed \| 301 → \/feed\/ \| default \|/);
		const plan = JSON.parse(readFileSync(join(paths.ir, "wp-urls.json"), "utf8"));
		// The site has a post: the blog serves a real feed (no more feedPending redirect) and the post is a real address.
		expect(plan.rules).toMatchObject({ feed: "/feed/", commentsFeed: "gone", pages: ["/", "/hello-world/"], trailingSlash: "always", blog: { index: "/blog/" } });
		expect(plan.feedPending).toBe(false);
	});

	it("passes with decisions; a type decided \"pages\" is migrated at its WordPress address", async () => {
		const paths = setup("decided", `export default { contentTypes: { portfolio: { as: "pages", reason: "owner: keep the projects" }, post: { as: "skip", reason: "owner: old news" } }, taxonomies: { category: { as: "skip", reason: "no archives" } }, authors: { as: "skip", reason: "brochure site" }, customCss: "carry" };\n`);
		const checks = await run(paths);
		expect(checks.find((c) => c.id === "content-types-handled")?.ok).toBe(true);
		expect(checks.find((c) => c.id === "custom-css")).toMatchObject({ ok: true, detail: "carry: 0.0 KB, 1 selectors" });
		const page = JSON.parse(readFileSync(join(paths.ir, "pages", "portfolio-project-a.json"), "utf8"));
		expect(page).toMatchObject({ kind: "page", route: { path: "/portfolio/project-a/" }, source: { type: "portfolio", wpId: 20 } });
		expect(existsSync(join(paths.ir, "posts", "hello-world.json"))).toBe(false);
		expect(JSON.parse(readFileSync(join(paths.ir, "custom-css.json"), "utf8"))).toEqual({ decision: "carry", css: ".site-header .logo img { max-height: 60px; }" });
		// The migrated CPT page is a real page: never matched by a rule.
		expect(JSON.parse(readFileSync(join(paths.ir, "wp-urls.json"), "utf8")).rules.pages).toEqual(["/", "/portfolio/project-a/"]);
	});
});

describe("verify urls-accounted", () => {
	it("builds the URL list: audit, discovery, query forms, feeds, search, dates, uploads; no WP internals, no broken URLs", () => {
		const list = universe();
		const paths = list.map((u) => u.path);
		for (const p of ["/hello-world/", "/portfolio/project-a/", "/category/news/", "/tag/tips/", "/author/admin/", "/hello-world/photo/", "/about/team-photo/", "/?p=10", "/?page_id=3", "/?cat=7", "/?tag=tips", "/?author=1", "/?attachment_id=31", "/feed/", "/?feed=rss2", "/comments/feed/", "/?s=wp2emdash", "/2024/05/", "/2024/06/", "/2024/", "/wp-content/uploads/2024/05/photo-300x200.jpg", "/locations.kml"]) expect(paths, p).toContain(p);
		for (const p of ["/wp-login.php", "/old-broken/", "/category/empty/", "/?attachment_id=31&x"]) expect(paths).not.toContain(p);
		expect(list.find((u) => u.path === "/hello-world/")).toMatchObject({ kind: "post", type: "post" });
		expect(list.find((u) => u.path === "/locations.kml")?.kind).toBe("file");
	});

	it("matches the golden judgement on the simulated new site (decisions recorded)", async () => {
		const p = plan();
		const wpIds = Object.fromEntries(Object.entries(fx.pageIds));
		const site = fakeSite(p.rules, wpIds, fx.publishedPages, fx.library);
		const overrides = overridesSchema.parse({ contentTypes: { post: { as: "skip", reason: "test: posts dropped" }, portfolio: { as: "skip", reason: "test: old projects" } }, gone: { "/locations.kml": "Rank Math Local SEO file, not needed" } });
		const judged = [];
		for (const u of universe()) judged.push(judgeUrl(u, await probeUrl(site, "https://new.test", u.path), { rules: p.rules, wpIds, overrides }));
		const goldenFile = join(import.meta.dirname, "golden", "wp-urls", "blog-site.json");
		const json = `${JSON.stringify(judged.map(({ path, kind, status, ok, why }) => ({ path, kind, status, ok, why })), null, "\t")}\n`;
		if (process.env.UPDATE_GOLDEN === "1" || !existsSync(goldenFile)) writeFileSync(goldenFile, json);
		expect(json).toBe(readFileSync(goldenFile, "utf8"));
		expect(judged.filter((j) => !j.ok)).toEqual([]);
		expect(accountDetail(judged)).toMatch(/^\d+ URLs: /);
	});

	it("without decisions the gate lists what is unaccounted, grouped by kind", async () => {
		const p = plan();
		const wpIds = Object.fromEntries(Object.entries(fx.pageIds));
		const site = fakeSite(p.rules, wpIds, fx.publishedPages, fx.library);
		const judged = [];
		for (const u of universe()) judged.push(judgeUrl(u, await probeUrl(site, "https://new.test", u.path), { rules: p.rules, wpIds, overrides: overridesSchema.parse({}) }));
		const bad = judged.filter((j) => !j.ok);
		expect(new Set(bad.map((j) => j.kind))).toEqual(new Set(["post", "portfolio", "query", "file"]));
		expect(accountDetail(judged)).toMatch(/^7 of \d+ unaccounted — query 3: \/\?p=10 \(404, no decision\), .*; post 2: \/hello-world\/ \(404, no decision\)/);
	});

	it("a 200 home page for a WordPress query, a temporary redirect or a chain is not accounted for", () => {
		const ctx = { overrides: overridesSchema.parse({}) };
		expect(judgeUrl({ path: "/?s=x", kind: "search" }, { status: 200 }, ctx)).toMatchObject({ ok: false, why: "answers the home page; ?s= ignored" });
		expect(judgeUrl({ path: "/feed/", kind: "feed" }, { status: 302, location: "/" }, ctx).ok).toBe(false);
		expect(judgeUrl({ path: "/feed/", kind: "feed" }, { status: 301, location: "/x", next: 301 }, ctx).ok).toBe(false);
		expect(judgeUrl({ path: "/feed/", kind: "feed" }, { status: 301, location: "/", next: 200 }, ctx).ok).toBe(true);
		expect(judgeUrl({ path: "/x/", kind: "page" }, { status: 0, error: "ECONNREFUSED" }, ctx).ok).toBe(false);
		const gone = { overrides: overridesSchema.parse({ gone: { "/category/*": "owner: no archives", "/?cat=*": "owner: no archives" } }) };
		expect(judgeUrl({ path: "/category/a/b/", kind: "category" }, { status: 410 }, gone)).toMatchObject({ ok: true, why: "gone by decision: owner: no archives" });
		expect(judgeUrl({ path: "/?cat=3", kind: "query" }, { status: 404 }, gone).ok).toBe(true);
		expect(judgeUrl({ path: "/categoryx/", kind: "page" }, { status: 404 }, gone).ok).toBe(false);
	});

	it("probes with HEAD and falls back to GET when HEAD is not answered like a page", async () => {
		const seen: string[] = [];
		const site = (async (url: string | URL, init?: RequestInit) => {
			seen.push(`${init?.method ?? "GET"} ${new URL(String(url)).pathname}`);
			if (new URL(String(url)).pathname === "/a") return new Response(null, { status: init?.method === "HEAD" ? 405 : 301, headers: { location: "/b" } });
			return new Response(null, { status: 200 });
		}) as typeof fetch;
		expect(await probeUrl(site, "https://new.test", "/a")).toEqual({ status: 301, location: "/b", next: 200 });
		expect(seen).toEqual(["HEAD /a", "GET /a", "HEAD /b"]);
	});

	it("the starter middleware applies the rule set (redirect, file lookup, 410 with the 404 page)", () => {
		const mw = readFileSync(join(import.meta.dirname, "..", "starter", "src", "middleware.ts"), "utf8");
		expect(mw).toContain('import { matchWpUrl, type WpUrlRules } from "./utils/wp-urls"');
		expect(mw).toMatch(/matchWpUrl\(path, u\.searchParams, rules, wpIds\)/);
		expect(mw).toMatch(/await legacyUpload\(wp\.file\)/);
		expect(mw).toMatch(/goneStatus \? await next\("\/404"\) : await next\(\)/);
		expect(mw).toMatch(/status: goneStatus/);
	});
});
