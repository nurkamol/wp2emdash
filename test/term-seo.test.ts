/**
 * Sharing text per entry (#13, parity `og-twitter`) and SEO of term archives (#10, parity `term-meta`): Yoast / Rank Math
 * values → IR → load payload → the SEO plugin's stores → `page:metadata` head tags and the starter's archive title.
 * Synthetic fixtures: test/fixtures/blog/site.json (blog), test/fixtures/term-seo/database.sql (Yoast options and
 * Rank Math term meta in a dump), test/fixtures/term-seo/post-meta.json (social post meta).
 * Goldens: test/golden/term-seo/*.json (regenerate after an intended change: UPDATE_GOLDEN=1 pnpm test).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createPlugin } from "../packages/seo/src/plugin/index.js";
import { archiveTitle, importSocial, readTermSeo, socialKey, socialTags, termFromPath, termKey, termOptionName, termTags } from "../packages/seo/src/social.js";
import { importOptions } from "../src/commands/import-options.js";
import { kitConfigSchema } from "../src/config/schema.js";
import { sitePaths } from "../src/core/paths.js";
import type { IrPage } from "../src/ir/schema.js";
import { runTransform } from "../src/phases/transform.js";
import { loadSocial, socialImageUrls, socialPayload } from "../src/targets/emdash/social.js";
import { entrySocial, resolveSeoVars, seoSeparator } from "../src/transform/social-seo.js";
import { rankMathTermMeta, type TermSeoPlan, termSeoPlan, termSeoReport } from "../src/transform/term-meta.js";
import { cache } from "./stubs/cloudflare-workers.js";

const fxDir = join(import.meta.dirname, "fixtures");
const blog = JSON.parse(readFileSync(join(fxDir, "blog", "site.json"), "utf8"));
const postMeta = JSON.parse(readFileSync(join(fxDir, "term-seo", "post-meta.json"), "utf8")) as Record<string, Record<string, unknown>>;
const goldenDir = join(import.meta.dirname, "golden", "term-seo");
const golden = (name: string, value: unknown) => {
	const file = join(goldenDir, name);
	const json = `${JSON.stringify(value, null, "\t")}\n`;
	if (process.env.UPDATE_GOLDEN === "1" || !existsSync(file)) {
		mkdirSync(goldenDir, { recursive: true });
		writeFileSync(file, json);
	}
	expect(json).toBe(readFileSync(file, "utf8"));
};

const dir = mkdtempSync(join(tmpdir(), "wp2e-term-seo-"));
const put = (file: string, data: unknown) => {
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
};
const config = kitConfigSchema.parse({ slug: "ts", name: "Example Journal", source: { url: "https://blog.example.test" }, target: { productionUrl: "https://blog.example.test" } });
const DECIDED = `export default { protectedPosts: { as: "draft", reason: "owner: members-only posts stay drafts" }, seo: { "/tag/breathing/": { title: "Breathing exercises | Example Journal", reason: "owner: SEO audit" }, "/classic-notes/": { twitterDescription: "Classic notes, for X", reason: "owner: social copy" } } };\n`;

/** The blog fixture's extract and audit output, with SEO plugin post meta on two posts. */
function workspace(name: string) {
	const paths = sitePaths(name, dir);
	const posts = (blog.posts as { id: number; meta?: Record<string, unknown> }[]).map((p) => (postMeta[String(p.id)] ? { ...p, meta: { ...(p.meta ?? {}), ...postMeta[String(p.id)] } } : p));
	put(join(paths.raw, "extract.json"), {});
	put(join(paths.raw, "exporter", "options.json"), blog.options);
	put(join(paths.raw, "exporter", "content", "page.json"), blog.pages);
	put(join(paths.raw, "exporter", "content", "post.json"), posts);
	put(join(paths.raw, "exporter", "taxonomies.json"), blog.taxonomies);
	put(join(paths.raw, "exporter", "analyze.json"), blog.analyze);
	put(join(paths.raw, "media-manifest.json"), blog.media);
	put(join(paths.snapshot, "urls.json"), blog.urls);
	put(join(paths.snapshot, "discovery.json"), blog.discovery);
	put(paths.overrides, DECIDED);
	return paths;
}
const run = (paths: ReturnType<typeof sitePaths>) => runTransform({ config, paths, reporter: { runId: "t", emit: () => {} } });

describe("database dump → raw (import-options)", () => {
	it("reads Yoast's term option and separator, and only Rank Math keys of term meta; nothing else", async () => {
		const paths = workspace("dump");
		await importOptions("dump", join(fxDir, "term-seo", "database.sql"), dir);
		const seo = JSON.parse(readFileSync(join(paths.raw, "seo-options.json"), "utf8"));
		expect(Object.keys(seo).sort()).toEqual(["wpseo_taxonomy_meta", "wpseo_titles"]);
		expect(seo.wpseo_taxonomy_meta.category["7"].wpseo_desc).toBe("Schedule changes, new classes and studio news");
		const tm = readFileSync(join(paths.raw, "seo-termmeta.json"), "utf8");
		expect(JSON.parse(tm).rankMath["20"]).toMatchObject({ rank_math_title: "%term% tips %sep% %sitename%", rank_math_robots: ["noindex"], rank_math_twitter_use_facebook: "off" });
		expect(tm).not.toMatch(/never read|focus_keyword|not-read/);
	});

	it("rankMathTermMeta keeps the allow-listed keys of numeric terms", () => {
		const rows = [{ term_id: "5", meta_key: "rank_math_description", meta_value: "D" }, { term_id: "5", meta_key: "secret_thing", meta_value: "x" }, { term_id: "x", meta_key: "rank_math_title", meta_value: "T" }, { term_id: "6", meta_key: "rank_math_title", meta_value: "" }];
		expect(rankMathTermMeta(rows)).toEqual({ "5": { rank_math_description: "D" } });
	});
});

describe("transform: entry sharing text and term SEO", () => {
	let paths: ReturnType<typeof sitePaths>;
	beforeEach(async () => {
		paths = workspace(`t${Math.random().toString(36).slice(2, 8)}`);
		await importOptions(paths.root.split("/").pop() as string, join(fxDir, "term-seo", "database.sql"), dir);
	});

	it("writes ir/term-seo.json (Yoast, Rank Math, owner override; variables resolved) and seo.social on posts (golden)", async () => {
		const checks = await run(paths);
		expect(checks.find((c) => c.id === "ir-valid")).toMatchObject({ ok: true });
		const plan = JSON.parse(readFileSync(join(paths.ir, "term-seo.json"), "utf8")) as TermSeoPlan;
		golden("term-seo.json", plan);
		const news = plan.terms.find((t) => t.slug === "news");
		expect(news).toMatchObject({ taxonomy: "category", path: "/category/news/", title: "News from the studio | Example Journal", description: "Schedule changes, new classes and studio news", ogTitle: "Studio news", source: "yoast" });
		expect(plan.terms.find((t) => t.slug === "workshops")).toMatchObject({ noindex: true, source: "yoast" });
		expect(plan.terms.find((t) => t.slug === "tips")).toMatchObject({ taxonomy: "tag", path: "/tag/tips/", title: "Tips tips | Example Journal", noindex: true, ogTitle: "Tips worth sharing", twitterTitle: "Tips on X", source: "rank-math" });
		expect(plan.terms.find((t) => t.slug === "breathing")).toMatchObject({ title: "Breathing exercises | Example Journal", source: "override", overridden: true });
		expect(plan.terms.some((t) => t.slug === "uncategorized")).toBe(false);
		expect(plan.notCarried).toEqual([{ wpTaxonomy: "post_format", terms: 1, why: "taxonomy not migrated (no archive on the new site)" }, { wpTaxonomy: "(Rank Math term meta)", terms: 1, why: "term not in a migrated taxonomy (no archive on the new site)" }]);
		const read = (f: string) => JSON.parse(readFileSync(join(paths.ir, "posts", f), "utf8")) as IrPage;
		const social = { hello: read("hello-gutenberg.json").seo.social, classic: read("classic-notes.json").seo.social };
		golden("social.json", social);
		expect(social.hello).toEqual({ ogTitle: "Hello from the journal", ogDescription: "Hello Gutenberg | our first post", twitterTitle: "Hello, X", twitterImage: "https://blog.example.test/wp-content/uploads/2024/06/team.jpg", source: "yoast" });
		expect(social.classic).toEqual({ ogTitle: "Classic notes", ogDescription: "Notes for every class", twitterDescription: "Classic notes, for X", source: "override" });
		const md = readFileSync(join(paths.reports, "transform", "coverage.md"), "utf8");
		expect(md).toMatch(/## Term SEO[\s\S]*\*\*Carried\*\*/);
		expect(md).toMatch(/\| `category` \| 2 \| 1 \| 1 \| 1 \| 1 \| 0 \|/);
		expect(md).toMatch(/- `post_format`: 1 term\(s\) — taxonomy not migrated/);
		expect(md).not.toMatch(/Schedule changes/);
	});

	it("without a dump: the report says term SEO of the old site's SEO plugin is not carried", async () => {
		const p = workspace("nodump");
		put(join(p.snapshot, "fingerprint.json"), { plugins: [{ slug: "rankmath" }] });
		put(p.overrides, `export default { protectedPosts: { as: "draft", reason: "owner: members-only posts stay drafts" } };\n`);
		await run(p);
		expect(existsSync(join(p.ir, "term-seo.json"))).toBe(false);
		expect(readFileSync(join(p.reports, "transform", "coverage.md"), "utf8")).toMatch(/uses Rank Math, but no database dump[\s\S]*\*\*not carried\*\*/);
	});
});

describe("title variables and entry social mapping", () => {
	const c = { siteName: "Acme", sep: "|", title: "About", termTitle: "News", termDescription: "What is new" };
	it("resolves Yoast %%var%% and Rank Math %var%, drops unknown Yoast variables and dangling separators", () => {
		expect(resolveSeoVars("%%title%% %%page%% %%sep%% %%sitename%%", c)).toBe("About | Acme");
		expect(resolveSeoVars("%%term_title%% Archives %%sep%% %%primary_category%% %%sep%% %%sitename%%", c)).toBe("News Archives | Acme");
		expect(resolveSeoVars("%term% %sep% %term_description%", c)).toBe("News | What is new");
		expect(resolveSeoVars("50% off %sep% 20% more", c)).toBe("50% off | 20% more");
		expect(resolveSeoVars("%%sep%% %%page%%", c)).toBeUndefined();
		expect(resolveSeoVars(undefined, c)).toBeUndefined();
	});
	it("separator from Rank Math, else Yoast, else -", () => {
		expect(seoSeparator({ rankMathTitles: { title_separator: "–" } })).toBe("–");
		expect(seoSeparator({ yoastTitles: { separator: "sc-pipe" } })).toBe("|");
		expect(seoSeparator({})).toBe("-");
	});
	it("Rank Math first; its Twitter fields only when it does not reuse the Facebook ones; images must be http(s)", () => {
		const v = (s?: string) => s;
		expect(entrySocial({ meta: { rank_math_facebook_title: "FB", rank_math_twitter_title: "TW" } }, v)).toEqual({ ogTitle: "FB", source: "rank-math" });
		expect(entrySocial({ meta: { rank_math_facebook_title: "FB", rank_math_twitter_use_facebook: "off", rank_math_twitter_title: "TW", rank_math_twitter_image: "javascript:alert(1)" } }, v)).toEqual({ ogTitle: "FB", twitterTitle: "TW", source: "rank-math" });
		expect(entrySocial({ meta: { "_yoast_wpseo_opengraph-image": "https://x.test/a.jpg" } }, v)).toEqual({ ogImage: "https://x.test/a.jpg", source: "yoast" });
		expect(entrySocial({ meta: {}, yoast: { "twitter-title": "From the exporter object" } }, v)).toEqual({ twitterTitle: "From the exporter object", source: "yoast" });
		expect(entrySocial({ meta: { _yoast_wpseo_focuskw: "only a keyword" } }, v)).toBeUndefined();
	});
	it("term plan: hierarchical paths, override by either path, report counts only", () => {
		const taxonomies = [{ name: "category", wpName: "category", base: "/category/", terms: [{ wpId: 7, slug: "news", label: "News" }, { wpId: 9, slug: "studio", label: "Studio", parent: "news" }] }];
		const plan = termSeoPlan({ yoast: { category: { 9: { wpseo_desc: "Child %%term_title%%" } } }, taxonomies, siteName: "Acme", overrides: { "/category/studio/": { ogTitle: "Owner text" } } });
		expect(plan.terms).toEqual([{ taxonomy: "category", wpTaxonomy: "category", wpId: 9, slug: "studio", label: "Studio", path: "/category/news/studio/", description: "Child Studio", source: "yoast", ogTitle: "Owner text", overridden: true }]);
		expect(termSeoReport(plan).join("\n")).toMatch(/\| `category` \| 1 \| 0 \| 1 \| 0 \| 1 \| 1 \|/);
		expect(termSeoReport(undefined)).toEqual([]);
	});
});

describe("load: payload for the SEO plugin", () => {
	const doc = (social?: IrPage["seo"]["social"], ogImage?: string) => ({ source: { type: "post", wpId: 10 }, seo: { jsonLdTypes: [], ...(ogImage ? { ogImage } : {}), ...(social ? { social } : {}) } }) as unknown as IrPage;
	const plan = { version: 1, terms: [{ taxonomy: "category", wpTaxonomy: "category", wpId: 7, slug: "news", label: "News", path: "/category/news/", title: "News | Acme", noindex: true, ogImage: "https://old.test/wp-content/uploads/a.jpg", twitterImage: "https://old.test/missing.jpg", source: "yoast" }], notCarried: [], sources: { yoast: true, rankMath: false } } as TermSeoPlan;
	const media = (u: string) => (u.endsWith("a.jpg") || u.endsWith("tw.jpg") ? `/_emdash/api/media/file/${u.split("/").pop()}` : undefined);

	it("entries on the target with text; the Twitter image only when it differs from the Open Graph one; uploaded images only", () => {
		const docs = [doc({ ogTitle: "OG", twitterImage: "https://old.test/tw.jpg", source: "yoast" }, "https://old.test/og.jpg"), doc({ twitterImage: "https://old.test/og.jpg", source: "yoast" }, "https://old.test/og.jpg"), doc()];
		expect(socialImageUrls(docs, plan)).toEqual(["https://old.test/tw.jpg", "https://old.test/wp-content/uploads/a.jpg", "https://old.test/missing.jpg"]);
		const p = socialPayload(docs, plan, () => ({ collection: "posts", id: "E1" }), media);
		expect(p.entries).toEqual([{ collection: "posts", id: "E1", social: { ogTitle: "OG", twitterImage: "/_emdash/api/media/file/tw.jpg" } }]);
		expect(p.terms).toEqual([{ taxonomy: "category", slug: "news", label: "News", title: "News | Acme", noindex: true, ogImage: "/_emdash/api/media/file/a.jpg" }]);
		expect(socialPayload(docs, plan, () => undefined, media).entries).toEqual([]);
	});

	it("sends batches; reports written / kept; a missing route says how to fix it", async () => {
		const kv = new Map<string, unknown>([[termKey("category", "news"), { taxonomy: "category", slug: "news", title: "Edited", source: "editor", updatedAt: "x" }]]);
		const api = { seoImport: async (b: unknown) => importSocial({ get: async (k: string) => (kv.get(k) as never) ?? null, set: async (k: string, v: unknown) => void kv.set(k, v) }, b) };
		const r = await loadSocial(api, socialPayload([doc({ ogTitle: "OG", source: "yoast" })], plan, () => ({ collection: "posts", id: "E1" }), media));
		expect(r).toEqual({ ok: true, detail: "pages: 1 written; archives: 0 written, 1 kept (edited in the admin)" });
		expect(kv.get(termKey("category", "news"))).toMatchObject({ title: "Edited", source: "editor" });
		const missing = await loadSocial({ seoImport: async () => Promise.reject(Object.assign(new Error("nf"), { code: "NOT_FOUND" })) }, { entries: [], terms: [{ taxonomy: "category", slug: "x", label: "X", title: "T" }] });
		expect(missing).toMatchObject({ ok: false, detail: expect.stringMatching(/rerun scaffold/) });
	});
});

describe("SEO plugin: stores and head tags", () => {
	it("entry tags: only what is set; Twitter falls back to Open Graph; site-path images made absolute", () => {
		expect(socialTags({ ogTitle: "OG", twitterImage: "/_emdash/api/media/file/k.jpg" }, { origin: "https://acme.example" })).toEqual([
			{ kind: "property", property: "og:title", content: "OG" },
			{ kind: "meta", name: "twitter:title", content: "OG" },
			{ kind: "meta", name: "twitter:card", content: "summary_large_image" },
			{ kind: "meta", name: "twitter:image", content: "https://acme.example/_emdash/api/media/file/k.jpg" },
		]);
		expect(socialTags({})).toEqual([]);
		const og = socialTags({ ogImage: "https://cdn.test/a.png", twitterTitle: "TW" }, { ogImageMeta: { width: 800, height: 400, type: "image/png" } });
		expect(og.map((c) => ("property" in c ? c.property : c.name))).toEqual(["og:image", "og:image:width", "og:image:height", "og:image:type", "twitter:title", "twitter:card", "twitter:image"]);
	});

	it("term tags: robots, description, and sharing text falling back to the SEO title and description", () => {
		const tags = termTags({ title: "News | Acme", description: "What is new", noindex: true, twitterTitle: "On X" });
		expect(tags).toEqual([
			{ kind: "meta", name: "robots", content: "noindex, follow" },
			{ kind: "meta", name: "description", content: "What is new" },
			{ kind: "property", property: "og:title", content: "News | Acme" },
			{ kind: "property", property: "og:description", content: "What is new" },
			{ kind: "meta", name: "twitter:title", content: "On X" },
			{ kind: "meta", name: "twitter:description", content: "What is new" },
		]);
	});

	it("archive paths → term (hierarchy, pages, feeds); archive titles; the starter's D1 read", async () => {
		const archives = [{ taxonomy: "category", base: "/category/" }, { taxonomy: "tag", base: "/tag/" }];
		expect(termFromPath("/category/news/studio/page/2/", archives)).toEqual({ taxonomy: "category", slug: "studio" });
		expect(termFromPath("/tag/caf%C3%A9/feed/", archives)).toEqual({ taxonomy: "tag", slug: "café" });
		expect(termFromPath("/category/", archives)).toBeUndefined();
		expect(termFromPath("/about/", archives)).toBeUndefined();
		expect(archiveTitle("News | Acme", 1)).toBe("News | Acme");
		expect(archiveTitle("News | Acme", 3)).toBe("News | Acme – Page 3");
		const rows: Record<string, string> = { [termOptionName("category", "news")]: JSON.stringify({ taxonomy: "category", slug: "news", title: "News | Acme", source: "migration", updatedAt: "x" }) };
		const db = { prepare: (_q: string) => ({ bind: (name: unknown) => ({ first: async <T>() => (rows[String(name)] ? ({ value: rows[String(name)] } as T) : null) }) }) };
		expect(termOptionName("category", "news")).toBe("plugin:site-seo:term:category:news");
		// WordPress keeps non-ASCII slugs encoded, the starter's route decodes them: one key for both.
		expect(termKey("tag", "café")).toBe(termKey("tag", "caf%C3%A9"));
		expect(termKey("tag", "café")).toBe("term:tag:caf%c3%a9");
		expect(await readTermSeo(db, "category", "news")).toMatchObject({ title: "News | Acme" });
		expect(await readTermSeo(db, "category", "none")).toBeUndefined();
		expect(await readTermSeo(undefined, "category", "news")).toBeUndefined();
	});

	type Hook = { priority: number; handler: (e: unknown, c: unknown) => Promise<Record<string, string>[] | null> };
	type R = { handler: (c: unknown) => Promise<{ blocks?: Record<string, any>[]; toast?: { message: string; type: string }; error?: string; entries?: { written: number } }> };
	const plugin = createPlugin({ productionUrl: "https://acme.example", archives: [{ taxonomy: "category", base: "/category/" }] }) as unknown as { capabilities: string[]; hooks: { "page:metadata": Hook }; routes: Record<string, R> };
	const kvMap = new Map<string, unknown>();
	const kv = { get: async (k: string) => (kvMap.get(k) as never) ?? null, set: async (k: string, v: unknown) => void kvMap.set(k, v), delete: async (k: string) => kvMap.delete(k), list: async (prefix = "") => [...kvMap].filter(([k]) => k.startsWith(prefix)).map(([key, value]) => ({ key, value })) };
	let purges = 0;
	beforeEach(() => {
		kvMap.clear();
		purges = 0;
		cache.purge = async () => {
			purges++;
			return { success: true, errors: [] };
		};
	});

	it("page:metadata runs before the sharing-card plugin and renders entry and term values, nothing when empty", async () => {
		const hook = plugin.hooks["page:metadata"];
		expect(hook.priority).toBeLessThan(100);
		expect(plugin.capabilities).toContain("taxonomies:read");
		const page = (over: Record<string, unknown>) => ({ page: { url: "https://acme.example/x/", path: "/x/", siteUrl: "https://acme-site.workers.dev", title: "X", ...over } });
		expect(await hook.handler(page({ content: { collection: "posts", id: "E1" } }), { kv })).toBeNull();
		kvMap.set(socialKey("posts", "E1"), { ogTitle: "Custom", twitterImage: "/_emdash/api/media/file/t.jpg", source: "migration", updatedAt: "x" });
		const tags = await hook.handler(page({ content: { collection: "posts", id: "E1" } }), { kv });
		expect(tags).toContainEqual({ kind: "property", property: "og:title", content: "Custom" });
		expect(tags).toContainEqual({ kind: "meta", name: "twitter:image", content: "https://acme-site.workers.dev/_emdash/api/media/file/t.jpg" });
		kvMap.set(termKey("category", "news"), { taxonomy: "category", slug: "news", title: "News | Acme", source: "migration", updatedAt: "x" });
		expect(await hook.handler(page({ path: "/category/news/page/2/" }), { kv })).toContainEqual({ kind: "property", property: "og:title", content: "News | Acme" });
		expect(await hook.handler(page({ path: "/category/other/" }), { kv })).toBeNull();
	});

	it("seo-import: admins only; keeps editor values; purges once", async () => {
		const route = plugin.routes["seo-import"] as R;
		expect(await route.handler({ input: {}, kv, user: { role: 40 } })).toEqual({ error: "admins only" });
		kvMap.set(socialKey("pages", "P2"), { ogTitle: "Editor", source: "editor", updatedAt: "x" });
		const r = await route.handler({ input: { entries: [{ collection: "pages", id: "P1", social: { ogTitle: "From WP" } }, { collection: "pages", id: "P2", social: { ogTitle: "From WP" } }, { collection: "Bad Name", id: "x", social: { ogTitle: "x" } }], terms: [] }, kv, user: { role: 50 }, log: { info: () => {} } });
		expect(r).toMatchObject({ entries: { written: 1, kept: 1, rejected: 1 }, terms: { written: 0 } });
		expect(kvMap.get(socialKey("pages", "P2"))).toMatchObject({ ogTitle: "Editor" });
		expect(purges).toBe(1);
	});

	it("panel: Social sharing form saves as the editor's, rejects a bad image address, clears; each save purges", async () => {
		const items = [{ id: "P1", slug: "about", status: "published", data: { title: "About", content: [] }, seo: { title: "About us", description: "Who we are" } }];
		const ctx = (input: unknown) => ({ input, ui: { entry: { collection: "pages", id: "P1" } }, kv, user: { role: 30, name: "Ed Itor" }, content: { get: async () => items[0], list: async () => ({ items }) }, media: { get: async () => null }, site: { name: "Acme" } });
		const load = await plugin.routes.panel?.handler(ctx({ type: "panel_load" }));
		const acc = load?.blocks?.find((b) => b.type === "accordion" && String(b.label).startsWith("Social sharing"));
		expect(acc?.blocks.find((b: { type: string }) => b.type === "form").fields[0]).toMatchObject({ action_id: "ogTitle", placeholder: "About us" });
		const bad = await plugin.routes.panel?.handler(ctx({ type: "form_submit", action_id: "social", values: { ogTitle: "X", ogImage: "javascript:alert(1)" } }));
		expect(bad?.toast?.type).toBe("error");
		expect(kvMap.has(socialKey("pages", "P1"))).toBe(false);
		const ok = await plugin.routes.panel?.handler(ctx({ type: "form_submit", action_id: "social", values: { ogTitle: " Share me ", twitterDescription: "On X", ogImage: "" } }));
		expect(ok?.toast?.message).toMatch(/Sharing text saved/);
		expect(kvMap.get(socialKey("pages", "P1"))).toMatchObject({ ogTitle: "Share me", twitterDescription: "On X", source: "editor", updatedBy: "Ed Itor" });
		await plugin.routes.panel?.handler(ctx({ type: "form_submit", action_id: "social", values: { ogTitle: "" } }));
		expect(kvMap.has(socialKey("pages", "P1"))).toBe(false);
		expect(purges).toBe(2);
	});

	it("dashboard Archives tab: pick a term, save its SEO as the editor's, remove it", async () => {
		const terms = [{ slug: "news", label: "News" }];
		const ctx = (input: unknown) => ({ input, kv, user: { role: 40, name: "Ed" }, ui: { surface: "admin-page" }, taxonomies: { getTerms: async () => terms }, content: { get: async () => null, list: async () => ({ items: [] }) }, media: { get: async () => null }, site: { name: "Acme" }, request: new Request("http://localhost/_emdash/api/plugins/site-seo/admin") });
		const pick = await plugin.routes.admin?.handler(ctx({ type: "form_submit", action_id: "term-pick", values: { term: "category:news" } }));
		expect(pick?.blocks?.[0]).toMatchObject({ type: "header", text: "Archive SEO: News" });
		expect(pick?.blocks?.find((b) => b.type === "form")?.block_id).toBe("term-edit:category:news");
		await plugin.routes.admin?.handler(ctx({ type: "form_submit", action_id: "term-save", block_id: "term-edit:category:news", values: { title: "News | Acme", description: "What is new", noindex: true, ogTitle: "" } }));
		expect(kvMap.get(termKey("category", "news"))).toMatchObject({ taxonomy: "category", slug: "news", label: "News", title: "News | Acme", noindex: true, source: "editor", updatedBy: "Ed" });
		const tab = (await plugin.routes.admin?.handler(ctx({ type: "page_load" })))?.blocks?.find((b) => b.type === "tab");
		const archives = tab?.panels.find((p: { label: string }) => p.label === "Archives");
		expect(archives.blocks.find((b: { type: string }) => b.type === "table").rows).toEqual([{ path: "/category/news/", title: "News | Acme", description: "What is new", index: "Hidden", from: "Ed" }]);
		await plugin.routes.admin?.handler(ctx({ type: "block_action", action_id: "term-clear", value: "category:news" }));
		expect(kvMap.has(termKey("category", "news"))).toBe(false);
		expect(purges).toBe(2);
	});
});
