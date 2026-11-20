/**
 * Blog milestone, generated side: seed (posts collection, taxonomies, bylines only for blog sites), the starter's blog
 * routing and RSS (starter/src/utils/blog.ts), the feed validator verify uses, and load's post helpers.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { postAction, resolvePostBody } from "../src/phases/load.js";
import { buildSeed, POSTS_COLLECTION, seedMediaResolver, seedPostBody } from "../src/scaffold/seed.js";
import { type BlogPlan, starterBlogConfig } from "../src/transform/blog.js";
import { validateRss } from "../src/verify/feeds.js";
import type { IrPage, IrSite } from "../src/ir/schema.js";
import { autoExcerpt, blogRoute, feedHref, pageHref, ptText, ptToHtml, rssXml } from "../starter/src/utils/blog.js";

const golden = (f: string) => JSON.parse(readFileSync(join(import.meta.dirname, "golden", "blog", f), "utf8"));
const plan = golden("blog.json") as BlogPlan;
const posts = Object.values(golden("posts.json")) as IrPage[];
const site: IrSite = { version: 1, title: "Example Journal", menus: [], partials: [], popups: [] };
const media = seedMediaResolver(new Map([[31, { url: "https://blog.example.test/wp-content/uploads/2024/05/photo.jpg" }], [32, { url: "https://blog.example.test/wp-content/uploads/2024/06/team.jpg" }]]), (u) => u);
const seedOf = (blog?: { plan: BlogPlan; posts: IrPage[] }) => buildSeed({ name: "x", site, pages: [], partials: [], popups: [], media, titleSeparator: "-", forms: [], includeContent: true, ...(blog ? { blog } : {}) });

describe("seed", () => {
	it("a brochure site's seed has no posts collection, taxonomies or bylines (unchanged)", () => {
		const s = seedOf();
		expect((s.collections as { slug: string; sortOrder: number }[]).map((c) => [c.slug, c.sortOrder])).toEqual([["pages", 1], ["site_parts", 2], ["popups", 3]]);
		expect(s).not.toHaveProperty("taxonomies");
		expect(s).not.toHaveProperty("bylines");
		expect(Object.keys(s.content as object)).toEqual(["pages", "site_parts", "popups"]);
	});
	it("a blog site's seed adds posts, taxonomies with hierarchy, guest bylines and the posts with terms and credits", () => {
		const s = seedOf({ plan, posts });
		expect((s.collections as { slug: string; sortOrder: number }[]).map((c) => [c.slug, c.sortOrder])).toEqual([["pages", 1], ["posts", 2], ["site_parts", 3], ["popups", 4]]);
		expect((s.collections as { slug: string; fields: { slug: string; type: string }[] }[])[1]?.fields.map((f) => `${f.slug}:${f.type}`)).toEqual(["title:string", "excerpt:text", "featured_image:image", "body:portableText", "content:blocks", "featured:boolean", "format:string"]);
		const tax = s.taxonomies as { name: string; hierarchical: boolean; collections: string[]; terms: { slug: string; parent?: string }[] }[];
		expect(tax.map((t) => [t.name, t.hierarchical, t.collections])).toEqual([["category", true, ["posts"]], ["tag", false, ["posts"]]]);
		expect(tax[0]?.terms.find((t) => t.slug === "studio-news")?.parent).toBe("news");
		expect(s.bylines).toEqual([{ id: "byline:jane", slug: "jane", displayName: "Jane Writer", bio: "Jane teaches movement and writes the journal.", isGuest: true }, { id: "byline:sam", slug: "sam", displayName: "Sam Coach", isGuest: true }]);
		const p = (s.content as { posts: { slug: string; status: string; taxonomies?: object; bylines?: object; data: { body: unknown[] } }[] }).posts;
		expect(p.find((x) => x.slug === "hello-gutenberg")).toMatchObject({ status: "published", taxonomies: { category: ["news"], tag: ["tips"] }, bylines: [{ byline: "byline:jane" }] });
		expect(p.find((x) => x.slug === "members-only")?.status).toBe("draft");
		expect(JSON.stringify(p)).not.toContain("_media");
	});
	it("seed post bodies point images at the WordPress file (local preview)", () => {
		const body = seedPostBody([{ _type: "image", _key: "a", asset: { _type: "reference", _ref: "31" }, _media: { wpId: 31, kind: "image" } }], media);
		expect(body).toEqual([{ _type: "image", _key: "a", asset: { _type: "reference", _ref: "31", url: "https://blog.example.test/wp-content/uploads/2024/05/photo.jpg" } }]);
		expect(POSTS_COLLECTION.urlPattern).toBe("/{slug}");
	});
});

describe("load post helpers", () => {
	it("resolves body media to EmDash media; unresolved keep their WordPress URL", () => {
		const body = [{ _type: "image", _key: "a", asset: { _type: "reference", _ref: "31", url: "https://wp/x.jpg" }, _media: { wpId: 31, kind: "image" } }, { _type: "file", _key: "b", url: "https://wp/a.pdf", _media: { url: "https://wp/a.pdf", kind: "file", field: "url" } }, { _type: "image", _key: "c", asset: { _ref: "9", url: "https://wp/y.jpg" }, _media: { wpId: 9, kind: "image" } }];
		const out = resolvePostBody(body, (m) => (m.wpId === 31 ? { id: "M31", url: "/_emdash/api/media/file/k31.jpg" } : m.url ? { id: "F1", url: "/_emdash/api/media/file/f1.pdf" } : undefined));
		expect(out).toEqual([{ _type: "image", _key: "a", asset: { _type: "reference", _ref: "M31", url: "/_emdash/api/media/file/k31.jpg" } }, { _type: "file", _key: "b", url: "/_emdash/api/media/file/f1.pdf" }, { _type: "image", _key: "c", asset: { _ref: "9", url: "https://wp/y.jpg" } }]);
	});
	it("statuses: publish, schedule (future), draft; private/password by decision", () => {
		const doc = (status: string, visibility = "public", publishedAt = "2099-01-01T00:00:00.000Z") => ({ source: { status }, post: { visibility, publishedAt } }) as unknown as IrPage;
		const now = Date.parse("2026-01-01");
		expect(postAction(doc("publish"), undefined, now)).toBe("publish");
		expect(postAction(doc("future"), undefined, now)).toBe("schedule");
		expect(postAction(doc("future", "public", "2020-01-01T00:00:00.000Z"), undefined, now)).toBe("publish");
		expect(postAction(doc("draft"), undefined, now)).toBe("draft");
		expect(postAction(doc("private", "private"), "draft", now)).toBe("draft");
		expect(postAction(doc("private", "private"), "publish", now)).toBe("publish");
		expect(postAction(doc("publish", "password"), undefined, now)).toBe("draft");
	});
});

describe("starter blog routing", () => {
	const cfg = starterBlogConfig(plan);
	it("site.config blog from the plan", () => {
		expect(cfg).toEqual({ index: "/journal/", perPage: 2, feed: { full: true, items: 5 }, archives: [{ taxonomy: "category", base: "/category/", label: "Categories", labelSingular: "Category" }, { taxonomy: "tag", base: "/tag/", label: "Tags", labelSingular: "Tag" }], authorBase: "/author/" });
	});
	it("posts page, archives, pages, feeds", () => {
		expect(blogRoute("/journal/", cfg)).toEqual({ kind: "index", page: 1, feed: false });
		expect(blogRoute("/journal/page/3/", cfg)).toEqual({ kind: "index", page: 3, feed: false });
		expect(blogRoute("/feed/", cfg)).toEqual({ kind: "index", page: 1, feed: true });
		expect(blogRoute("/category/news/studio-news/", cfg)).toEqual({ kind: "term", taxonomy: "category", slug: "studio-news", base: "/category/", page: 1, feed: false });
		expect(blogRoute("/category/news/page/2", cfg)).toMatchObject({ kind: "term", slug: "news", page: 2 });
		expect(blogRoute("/tag/tips/feed/", cfg)).toMatchObject({ kind: "term", taxonomy: "tag", slug: "tips", feed: true });
		expect(blogRoute("/author/jane/feed/", cfg)).toMatchObject({ kind: "author", slug: "jane", feed: true });
		for (const p of ["/", "/hello-gutenberg/", "/category/", "/author/jane/extra/", "/about/"]) expect(blogRoute(p, cfg), p).toBeUndefined();
		expect(blogRoute("/", { ...cfg, index: "/" })).toEqual({ kind: "index", page: 1, feed: false });
		expect(blogRoute("/page/2/", { ...cfg, index: "/" })).toEqual({ kind: "index", page: 2, feed: false });
	});
	it("links in the site's URL style", () => {
		expect(pageHref("/journal/", 1)).toBe("/journal/");
		expect(pageHref("/journal/", 2)).toBe("/journal/page/2/");
		expect(pageHref("/journal", 2, "never")).toBe("/journal/page/2");
		expect(feedHref("/category/news/")).toBe("/category/news/feed/");
		expect(feedHref("/")).toBe("/feed/");
	});
});

describe("RSS", () => {
	const body = (golden("posts.json") as Record<string, IrPage>)["classic-notes.json"]?.post?.body ?? [];
	it("text, excerpt, HTML from Portable Text", () => {
		expect(ptText(body)).toContain("A classic post written in the old editor.");
		expect(autoExcerpt("one two three", 2)).toBe("one two […]");
		const html = ptToHtml([{ _type: "block", _key: "a", style: "h2", children: [{ _type: "span", _key: "b", text: "Hi & bye", marks: ["l"] }], markDefs: [{ _type: "link", _key: "l", href: "/about/" }] }, { _type: "block", _key: "c", listItem: "bullet", children: [{ _type: "span", _key: "d", text: "One" }] }, { _type: "image", _key: "e", asset: { url: "/_emdash/api/media/file/x.jpg" }, alt: "X" }], "https://site.test");
		expect(html).toBe('<h2><a href="https://site.test/about/">Hi &amp; bye</a></h2>\n<ul><li>One</li></ul>\n<figure><img src="https://site.test/_emdash/api/media/file/x.jpg" alt="X"></figure>');
	});
	it("valid RSS 2.0 (verify's validator), newest first, CDATA-safe", () => {
		const xml = rssXml({ title: "Journal & Co", link: "https://site.test/journal/", self: "https://site.test/feed/", description: "Notes", language: "en", updated: "2024-06-01T12:00:00.000Z" }, [
			{ title: "Classic notes", link: "https://site.test/classic-notes/", published: "2024-06-01T12:00:00.000Z", description: "Short ]]> text", content: "<p>Full</p>", categories: ["Tips"], author: "Sam" },
			{ title: "Hello <Gutenberg>", link: "https://site.test/hello-gutenberg/", published: "2024-05-10T09:00:00.000Z", description: "First" },
		]);
		expect(validateRss(xml, { items: 2, titles: ["Classic notes", "Hello <Gutenberg>"] })).toEqual({ ok: true, items: 2, problems: [], links: ["https://site.test/classic-notes/", "https://site.test/hello-gutenberg/"] });
		expect(xml).toContain("<pubDate>Sat, 01 Jun 2024 12:00:00 GMT</pubDate>");
		expect(xml).toContain('<atom:link href="https://site.test/feed/" rel="self" type="application/rss+xml" />');
	});
	it("the validator reports what feed readers reject", () => {
		expect(validateRss("<html></html>").problems).toEqual(["no <rss> element"]);
		const bad = '<rss version="0.91"><channel><title>x</title><item><title>a</title><pubDate>Mon, 01 Jan 2024 00:00:00 GMT</pubDate></item><item><title>b</title><link>/b</link><guid>/b</guid><pubDate>Tue, 02 Jan 2024 00:00:00 GMT</pubDate></item></channel></rss>';
		expect(validateRss(bad, { items: 3 }).problems).toEqual(["rss version 0.91", "channel link missing", "channel description missing", "item 1: link missing", "item 1: guid missing", "item 2: not newest first", "2 items, expected 3"]);
	});
});
