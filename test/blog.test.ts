/**
 * Blog milestone: posts (Gutenberg + classic → EmDash Portable Text), categories with hierarchy, tags, bylines, the
 * posts page, archives and feeds. Synthetic WordPress fixture: test/fixtures/blog/site.json.
 * Goldens: test/golden/blog/*.json (regenerate after an intended change: UPDATE_GOLDEN=1 pnpm test).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { overridesSchema } from "../src/config/overrides.js";
import { kitConfigSchema } from "../src/config/schema.js";
import { sitePaths } from "../src/core/paths.js";
import { runTransform } from "../src/phases/transform.js";
import { bylineSlug, classicToBlockMarkup, convertPostBody, emdashTaxonomyName, permalinkPath, shortcodePass, topLevelParts, wpGmtToIso } from "../src/transform/blog.js";
import { matchWpUrl, type WpUrlRules } from "../src/transform/wp-urls.js";

const fx = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "blog", "site.json"), "utf8"));
const goldenDir = join(import.meta.dirname, "golden", "blog");
const golden = (name: string, value: unknown) => {
	const file = join(goldenDir, name);
	const json = `${JSON.stringify(value, null, "\t")}\n`;
	if (process.env.UPDATE_GOLDEN === "1" || !existsSync(file)) {
		mkdirSync(goldenDir, { recursive: true });
		writeFileSync(file, json);
	}
	expect(json).toBe(readFileSync(file, "utf8"));
};

const dir = mkdtempSync(join(tmpdir(), "wp2e-blog-"));
const put = (file: string, data: unknown) => {
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
};
const config = (over: Record<string, unknown> = {}) => kitConfigSchema.parse({ slug: "blog", name: "Example Journal", source: { url: "https://blog.example.test" }, target: { productionUrl: "https://blog.example.test" }, ...over });

/** A site workspace with the fixture's extract and audit output. */
export function blogWorkspace(name: string, overrides?: string) {
	const paths = sitePaths(name, dir);
	put(join(paths.raw, "extract.json"), {});
	put(join(paths.raw, "exporter", "options.json"), fx.options);
	put(join(paths.raw, "exporter", "content", "page.json"), fx.pages);
	put(join(paths.raw, "exporter", "content", "post.json"), fx.posts);
	put(join(paths.raw, "exporter", "taxonomies.json"), fx.taxonomies);
	put(join(paths.raw, "exporter", "analyze.json"), fx.analyze);
	put(join(paths.raw, "media-manifest.json"), fx.media);
	put(join(paths.snapshot, "urls.json"), fx.urls);
	put(join(paths.snapshot, "discovery.json"), fx.discovery);
	if (overrides) put(paths.overrides, overrides);
	return paths;
}
const run = (paths: ReturnType<typeof sitePaths>, cfg = config()) => runTransform({ config: cfg, paths, reporter: { runId: "t", emit: () => {} } });
const DECIDED = `export default { protectedPosts: { as: "draft", reason: "owner: members-only posts stay drafts" } };\n`;

describe("blog transform", () => {
	it("migrates posts, taxonomies and bylines; content-types gate passes for posts (golden)", async () => {
		const paths = blogWorkspace("decided", DECIDED);
		const checks = await run(paths);
		expect(checks.find((c) => c.id === "content-types-handled")).toMatchObject({ ok: true });
		expect(checks.find((c) => c.id === "content-types-handled")?.detail).toMatch(/migrated: .*post/);
		expect(checks.find((c) => c.id === "protected-posts")).toMatchObject({ ok: true });
		expect(checks.find((c) => c.id === "ir-valid")).toMatchObject({ ok: true });
		expect(checks.find((c) => c.id === "unmapped")).toMatchObject({ ok: true });
		expect(checks.find((c) => c.id === "media-refs")).toMatchObject({ ok: true });
		expect(checks.find((c) => c.id === "links")).toMatchObject({ ok: true });
		const posts = Object.fromEntries(readdirSync(join(paths.ir, "posts")).sort().map((f) => [f, JSON.parse(readFileSync(join(paths.ir, "posts", f), "utf8"))]));
		golden("posts.json", posts);
		golden("blog.json", JSON.parse(readFileSync(join(paths.ir, "blog.json"), "utf8")));
		golden("wp-urls.json", JSON.parse(readFileSync(join(paths.ir, "wp-urls.json"), "utf8")).rules);
		const md = readFileSync(join(paths.reports, "transform", "coverage.md"), "utf8");
		expect(md).toMatch(/## Blog[\s\S]*Posts page: `\/journal\/`/);
		expect(md).toMatch(/\| category \| category \| 4 \| yes \| `\/category\/` \|/);
	});

	it("keeps post data: dates, excerpt, featured image, sticky → featured, format, terms, bylines, statuses", async () => {
		const paths = blogWorkspace("data", DECIDED);
		await run(paths);
		const read = (f: string) => JSON.parse(readFileSync(join(paths.ir, "posts", f), "utf8"));
		const g = read("hello-gutenberg.json");
		expect(g).toMatchObject({ kind: "post", route: { path: "/hello-gutenberg/" }, featuredImage: { wpId: 31 }, post: { publishedAt: "2024-05-10T09:00:00.000Z", modifiedAt: "2024-05-12T08:30:00.000Z", terms: { category: ["news"], tag: ["tips"] }, bylines: ["jane"], visibility: "public" } });
		expect(g.post.body.map((b: { _type: string }) => b._type)).toEqual(["block", "block", "image", "block", "block", "block"]);
		expect(g.post.body[2]).toMatchObject({ _type: "image", alt: "Studio photo", caption: "The studio at dawn", _media: { wpId: 31, kind: "image" } });
		const c = read("classic-notes.json");
		expect(c.post).toMatchObject({ excerpt: "A short hand-written excerpt.", sticky: true, format: "gallery", terms: { category: ["workshops"], tag: ["tips", "breathing"] }, bylines: ["sam"] });
		const types = c.post.body.map((b: { _type: string }) => b._type);
		expect(types).toContain("gallery");
		expect(types).toContain("embed");
		expect(c.post.body.find((b: { _type: string }) => b._type === "image")).toMatchObject({ caption: "Our team", _media: { wpId: 32 } });
		expect(JSON.stringify(c.post.body)).not.toMatch(/\[caption|\[gallery/);
		expect(read("coming-soon.json")).toMatchObject({ source: { status: "future" }, post: { publishedAt: "2099-01-01T08:00:00.000Z" } });
		expect(read("post-13.json")).toMatchObject({ source: { status: "draft", slug: "post-13" }, route: { path: "/post-13/" } });
		expect(read("members-only.json")).toMatchObject({ post: { visibility: "private" } });
		const blog = JSON.parse(readFileSync(join(paths.ir, "blog.json"), "utf8"));
		expect(blog).toMatchObject({ index: "/journal/", indexPageId: 4, perPage: 2, feed: { full: true, items: 5 }, authorBase: "/author/" });
		expect(blog.taxonomies.map((t: { name: string }) => t.name)).toEqual(["category", "tag"]);
		const cat = blog.taxonomies[0];
		expect(cat.terms.map((t: { slug: string }) => t.slug)).toEqual(["news", "workshops", "uncategorized", "studio-news"]);
		expect(cat.terms.find((t: { slug: string }) => t.slug === "studio-news")).toMatchObject({ parent: "news" });
		expect(blog.bylines).toEqual([
			{ slug: "jane", displayName: "Jane Writer", bio: "Jane teaches movement and writes the journal.", wpId: 1, path: "/author/jane/", posts: 3 },
			{ slug: "sam", displayName: "Sam Coach", avatar: { wpId: 32, kind: "image", alt: "Sam Coach" }, wpId: 2, path: "/author/sam/", posts: 2 },
		]);
	});

	it("private posts need a decision; skip leaves them out (reported)", async () => {
		const open = await run(blogWorkspace("open"));
		expect(open.find((c) => c.id === "protected-posts")).toMatchObject({ ok: false });
		expect(open.find((c) => c.id === "protected-posts")?.detail).toMatch(/members-only \(private\)/);
		const paths = blogWorkspace("skip", `export default { protectedPosts: { as: "skip", reason: "owner: not needed" } };\n`);
		await run(paths);
		expect(existsSync(join(paths.ir, "posts", "members-only.json"))).toBe(false);
	});

	it("blog: false keeps the previous behaviour: Gutenberg posts undecided", async () => {
		const checks = await run(blogWorkspace("off"), config({ blog: false }));
		expect(checks.find((c) => c.id === "content-types-handled")).toMatchObject({ ok: false });
		expect(checks.find((c) => c.id === "content-types-handled")?.detail).toMatch(/post \(5\)/);
	});

	it("the WordPress-URL rules treat the blog's archives and feeds as real routes", async () => {
		const paths = blogWorkspace("urls", DECIDED);
		await run(paths);
		const plan = JSON.parse(readFileSync(join(paths.ir, "wp-urls.json"), "utf8")) as { rules: WpUrlRules; feedPending: boolean };
		expect(plan.feedPending).toBe(false);
		const m = (p: string, q = "") => matchWpUrl(p, new URLSearchParams(q), plan.rules);
		for (const real of ["/feed/", "/journal/", "/journal/page/2/", "/category/news/", "/category/news/studio-news/", "/category/news/feed/", "/category/news/page/2/", "/tag/tips/", "/tag/tips/feed/", "/author/jane/", "/author/jane/feed/", "/hello-gutenberg/"]) expect(m(real), real).toBeUndefined();
		expect(m("/", "feed=rss2")).toEqual({ kind: "feed", to: "/feed/" });
		expect(m("/wp-rss2.php")).toEqual({ kind: "feed", to: "/feed/" });
		expect(m("/comments/feed/")).toEqual({ kind: "comments-feed", gone: true });
		expect(m("/hello-gutenberg/feed/")).toEqual({ kind: "comments-feed", to: "/hello-gutenberg/" });
		expect(m("/", "cat=7")).toEqual({ kind: "category", to: "/category/news/" });
		expect(m("/", "tag=tips")).toEqual({ kind: "tag", to: "/tag/tips/" });
		expect(m("/", "author=2")).toEqual({ kind: "author", to: "/author/sam/" });
		expect(m("/2024/05/")).toEqual({ kind: "date", to: "/journal/" });
	});
});

describe("post body conversion", () => {
	const opts = { keyPrefix: "t_", mediaIdForUrl: (u: string) => (/photo/.test(u) ? 31 : undefined) };
	it("shortcode pass: caption, gallery, embed, audio, video, bare oEmbed URL", () => {
		const out = shortcodePass(`[caption id="attachment_5" width="300"]<img class="wp-image-5" src="/a.jpg" alt="A"> Cap[/caption]\n[gallery ids="1, 2" columns="2"]\n[embed]https://vimeo.com/1[/embed]\n[audio mp3="https://x.test/a.mp3"][/audio]\n[video src="https://x.test/v.mp4"]\nhttps://youtu.be/xyz\nhttps://example.test/not-an-embed`);
		expect(out).toMatch(/<!-- wp:image \{"id":5\} -->[\s\S]*<figcaption>Cap<\/figcaption>/);
		expect(out).toMatch(/<!-- wp:gallery \{"ids":\[1,2\],"columns":2\} -->/);
		expect(out).toMatch(/<!-- wp:embed \{"url":"https:\/\/vimeo.com\/1"\} -->/);
		expect(out).toMatch(/<!-- wp:audio \{\} -->/);
		expect(out).toMatch(/<!-- wp:video \{\} -->/);
		expect(out).toMatch(/<!-- wp:embed \{"url":"https:\/\/youtu.be\/xyz"\} -->/);
		expect(out).toContain("https://example.test/not-an-embed");
	});
	it("classic text gets paragraphs and line breaks (wpautop)", () => {
		const r = convertPostBody("One\ntwo\n\nThree", "classic", opts);
		expect(r.body.map((b) => b._type)).toEqual(["block", "block"]);
		expect(r.diagnostics).toEqual([]);
		expect(classicToBlockMarkup("a\n\nb")).toBe("<p>a</p>\n<p>b</p>");
	});
	it("unknown shortcodes and blocks are reported, never dropped", () => {
		const r = convertPostBody(`<!-- wp:shortcode -->[contact-form-7 id="5"]<!-- /wp:shortcode -->\n<!-- wp:acme/widget {"x":1} --><div>Widget text</div><!-- /wp:acme/widget -->`, "gutenberg", opts);
		expect(r.body.map((b) => b._type)).toEqual(["htmlBlock", "htmlBlock"]);
		expect(r.diagnostics).toEqual([
			{ level: "error", code: "flagged", message: 'shortcode kept as text: [contact-form-7 id="5"]', path: "body#0", carriesContent: true, tag: "shortcode" },
			{ level: "warn", code: "flagged", message: "acme/widget kept as HTML (no Portable Text equivalent)", path: "body#1", tag: "acme/widget" },
		]);
	});
	it("Gutenberg freeform parts and reusable blocks", () => {
		const r = convertPostBody(`Intro text\n\n<!-- wp:block {"ref":9} /-->\n<!-- wp:columns --><div><!-- wp:column --><div><!-- wp:paragraph --><p>In a column</p><!-- /wp:paragraph --></div><!-- /wp:column --></div><!-- /wp:columns -->`, "gutenberg", { ...opts, reusable: (id) => (id === 9 ? "<!-- wp:paragraph --><p>Reused</p><!-- /wp:paragraph -->" : undefined) });
		expect(JSON.stringify(r.body)).toContain("Intro text");
		expect(JSON.stringify(r.body)).toContain("Reused");
		expect(JSON.stringify(r.body)).toContain("In a column");
		expect(topLevelParts("a<!-- wp:x --><!-- wp:y /--><!-- /wp:x -->b").map((p) => p.block)).toEqual([false, true, false]);
	});
	it("keys are deterministic", () => {
		expect(convertPostBody("<p>x</p>", "classic", opts).body[0]?._key).toBe("t_1");
	});
});

describe("blog helpers", () => {
	it("permalinks: postname, date-based, category, plain", () => {
		const p = { id: 7, slug: "hi", dateGmt: "2024-05-03T10:00:00.000Z", category: "news" };
		expect(permalinkPath("/%postname%/", p, true)).toBe("/hi/");
		expect(permalinkPath("/%year%/%monthnum%/%day%/%postname%/", p, true)).toBe("/2024/05/03/hi/");
		expect(permalinkPath("/blog/%postname%", p, false)).toBe("/blog/hi");
		expect(permalinkPath("/%category%/%postname%/", p, true)).toBe("/news/hi/");
		expect(permalinkPath("/archives/%post_id%", p, true)).toBe("/archives/7/");
		expect(permalinkPath("", p, true)).toBe("/hi/");
	});
	it("names and dates", () => {
		expect(emdashTaxonomyName("post_tag")).toBe("tag");
		expect(emdashTaxonomyName("event-type")).toBe("event_type");
		expect(emdashTaxonomyName("9x")).toBeUndefined();
		expect(bylineSlug("Jürgen O'Neil")).toBe("jurgen-o-neil");
		expect(bylineSlug("42")).toBe("a-42");
		expect(wpGmtToIso("2024-05-10 09:00:00")).toBe("2024-05-10T09:00:00.000Z");
		expect(wpGmtToIso("0000-00-00 00:00:00")).toBeUndefined();
	});
	it("overrides accept protectedPosts", () => {
		expect(overridesSchema.parse({ protectedPosts: { as: "draft", reason: "owner said so" } }).protectedPosts?.as).toBe("draft");
	});
});
