/**
 * WordPress page attributes (src/transform/pages.ts): manual order, parent page, excerpt and featured image become
 * `pages` fields only when the site uses them; load writes the parent in its second pass and uses the featured image as
 * the sharing (and sitemap) image when the page has none. Synthetic fixture: test/fixtures/pages/site.json. Golden:
 * test/golden/pages/attributes.json (regenerate after an intended change: UPDATE_GOLDEN=1 pnpm test).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { kitConfigSchema } from "../src/config/schema.js";
import { sitePaths } from "../src/core/paths.js";
import type { IrPage } from "../src/ir/schema.js";
import { docReferences, seoImageRef } from "../src/phases/load.js";
import { runTransform } from "../src/phases/transform.js";
import { buildSeed, seedMediaResolver } from "../src/scaffold/seed.js";
import { pageAttributes, pageData, pageFields, parentsFirst, showsFeaturedImage } from "../src/transform/pages.js";

const fx = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "pages", "site.json"), "utf8"));
const goldenDir = join(import.meta.dirname, "golden", "pages");
const golden = (name: string, value: unknown) => {
	const file = join(goldenDir, name);
	const json = `${JSON.stringify(value, null, "\t")}\n`;
	if (process.env.UPDATE_GOLDEN === "1" || !existsSync(file)) {
		mkdirSync(goldenDir, { recursive: true });
		writeFileSync(file, json);
	}
	expect(json).toBe(readFileSync(file, "utf8"));
};
const dir = mkdtempSync(join(tmpdir(), "wp2e-pages-"));
const put = (file: string, data: unknown) => {
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
};
const config = kitConfigSchema.parse({ slug: "pages", name: "Example Studio", source: { url: "https://pages.example.test" }, target: { productionUrl: "https://pages.example.test" } });

async function transformed(name: string, pages: unknown[]) {
	const paths = sitePaths(name, dir);
	put(join(paths.raw, "extract.json"), {});
	put(join(paths.raw, "exporter", "options.json"), fx.options);
	put(join(paths.raw, "exporter", "content", "page.json"), pages);
	put(join(paths.raw, "exporter", "analyze.json"), fx.analyze);
	put(join(paths.raw, "media-manifest.json"), fx.media);
	put(join(paths.snapshot, "urls.json"), fx.urls);
	put(join(paths.snapshot, "html", "about.html"), fx.liveAbout);
	const checks = await runTransform({ config, paths, reporter: { runId: "t", emit: () => {} } });
	const docs = readdirSync(join(paths.ir, "pages")).sort().map((f) => JSON.parse(readFileSync(join(paths.ir, "pages", f), "utf8")) as IrPage);
	return { paths, checks, docs };
}
const media = seedMediaResolver(new Map(fx.media.map((m: { id: number; url: string }) => [m.id, { url: m.url }])), (u) => u);
const seedOf = (pages: IrPage[]) => buildSeed({ name: "x", site: { version: 1, title: "Example Studio", menus: [], partials: [], popups: [] }, pages, partials: [], popups: [], media, titleSeparator: "-", forms: [], includeContent: true });

describe("page attributes: transform", async () => {
	const { paths, checks, docs } = await transformed("attrs", fx.pages);
	const bySlug = Object.fromEntries(docs.map((d) => [d.source.slug, d]));

	it("order, parent (page:<wpId>) and excerpt per page; only what the page has (golden)", () => {
		expect(checks.find((c) => c.id === "ir-valid")).toMatchObject({ ok: true });
		golden("attributes.json", Object.fromEntries(docs.map((d) => [d.source.slug, { route: d.route?.path, page: d.page ?? null, featuredImage: d.featuredImage ?? null }])));
		expect(bySlug.about?.page).toEqual({ menuOrder: 1, excerpt: "Who we are and how we teach." });
		expect(bySlug.coaches?.page).toEqual({ menuOrder: 2, parent: "page:2" });
		expect(bySlug.home?.page).toBeUndefined();
		// The parent is not migrated (deleted on WordPress): no link, the address is kept.
		expect(bySlug.contact?.page).toBeUndefined();
		expect(bySlug.contact?.route?.path).toBe("/contact/");
	});

	it("coverage report: counts per attribute, and where the old theme printed the featured image", () => {
		const md = readFileSync(join(paths.reports, "transform", "coverage.md"), "utf8");
		expect(md).toMatch(/## Page attributes/);
		expect(md).toMatch(/\| Manual order \(`menu_order`\) \| 3 \|/);
		expect(md).toMatch(/\| Parent page \| 2 \|/);
		expect(md).toMatch(/\| Excerpt \| 1 \|/);
		expect(md).toMatch(/\| Featured image \| 1 \|/);
		expect(md).toMatch(/printed the featured image on 1 live page/);
	});

	it("seed: the pages collection gets exactly the fields the site uses; parents come first with a $ref", () => {
		const seed = seedOf(docs);
		const pagesCol = (seed.collections as { slug: string; fields: { slug: string; type: string; validation?: unknown }[] }[]).find((c) => c.slug === "pages");
		expect(pagesCol?.fields.map((f) => `${f.slug}:${f.type}`)).toEqual(["title:string", "content:blocks", "menu_order:integer", "parent:reference", "excerpt:text", "featured_image:image"]);
		expect(pagesCol?.fields.find((f) => f.slug === "parent")?.validation).toEqual({ targetCollection: "pages", multiple: false });
		const content = (seed.content as { pages: { id: string; data: Record<string, unknown> }[] }).pages;
		const ids = content.map((p) => p.id);
		expect(ids.indexOf("about")).toBeLessThan(ids.indexOf("about/coaches"));
		expect(ids.indexOf("about")).toBeLessThan(ids.indexOf("about/history"));
		expect(content.find((p) => p.id === "about/coaches")?.data).toMatchObject({ menu_order: 2, parent: "$ref:about" });
		expect(content.find((p) => p.id === "about")?.data).toMatchObject({ menu_order: 1, excerpt: "Who we are and how we teach.", featured_image: { $media: { url: "https://pages.example.test/wp-content/uploads/2024/02/studio.jpg" } } });
		expect(content.find((p) => p.id === "home")?.data).toEqual(expect.objectContaining({ menu_order: 0 }));
		expect(content.find((p) => p.id === "home")?.data).not.toHaveProperty("parent");
	});
});

describe("page attributes: a site that never used them", async () => {
	const plain = fx.pages.map((p: Record<string, unknown>) => ({ ...p, parent: null, menu_order: 0, excerpt: "", featured_image: undefined }));
	const { docs } = await transformed("plain", plain);

	it("no page attributes in the IR, the pages collection keeps its two fields and its order", () => {
		expect(docs.every((d) => d.page === undefined && d.featuredImage === undefined)).toBe(true);
		expect(pageFields(docs)).toEqual([]);
		const seed = seedOf(docs);
		expect((seed.collections as { slug: string; fields: { slug: string }[] }[]).find((c) => c.slug === "pages")?.fields.map((f) => f.slug)).toEqual(["title", "content"]);
		expect((seed.content as { pages: { id: string; data: object }[] }).pages.map((p) => Object.keys(p.data))).toEqual(docs.map(() => ["title", "content"]));
	});
});

describe("page attributes: helpers and load", () => {
	const doc = (o: Partial<IrPage>): IrPage => ({ version: 1, kind: "page", source: { wpId: 7, type: "page", status: "publish", slug: "x", builder: "gutenberg" }, title: "X", seo: { jsonLdTypes: [] }, sections: [], diagnostics: [], ...o });

	it("pageAttributes: HTML stripped from excerpts; unmigrated parents and zero order left out", () => {
		expect(pageAttributes({ id: 1, parent: 2, menu_order: 3, excerpt: "<p>Hi <em>there</em></p>" }, () => true)).toEqual({ menuOrder: 3, parent: "page:2", excerpt: "Hi there" });
		expect(pageAttributes({ id: 1, parent: 2, menu_order: 0, excerpt: "" }, () => false)).toBeUndefined();
	});

	it("load: the parent goes in the reference pass; field values only for the fields the site has", () => {
		expect(docReferences(doc({ page: { parent: "page:2" } }))).toEqual({ parent: ["page:2"] });
		expect(docReferences(doc({}))).toEqual({});
		expect(docReferences(doc({ kind: "entry", entry: { collection: "team", fields: {}, references: { related: ["team:1"] }, body: [], terms: {}, bylines: [] } }))).toEqual({ related: ["team:1"] });
		const fields = pageFields([doc({ page: { menuOrder: 2 }, featuredImage: { wpId: 9, kind: "image" } })]);
		expect(fields.map((f) => f.slug)).toEqual(["menu_order", "featured_image"]);
		expect(pageData(doc({ page: { menuOrder: 2, excerpt: "not a field here" }, featuredImage: { wpId: 9, kind: "image" } }), fields, (m) => ({ id: `M${m.wpId}` }))).toEqual({ menu_order: 2, featured_image: { id: "M9" } });
		expect(pageData(doc({}), fields, () => undefined)).toEqual({ menu_order: 0 });
	});

	it("load: the sharing image is the live og:image file, else the featured image (EmDash lists it in the sitemap)", () => {
		const og = { kind: "image" as const, wpId: 5 };
		expect(seoImageRef(doc({ featuredImage: { wpId: 9, kind: "image" } }), () => og)).toBe(og);
		expect(seoImageRef(doc({ featuredImage: { wpId: 9, kind: "image" } }), () => undefined)).toEqual({ wpId: 9, kind: "image" });
		expect(seoImageRef(doc({}), () => undefined)).toBeUndefined();
	});

	it("parentsFirst keeps the order of pages without parents and survives cycles", () => {
		const a = doc({ source: { wpId: 1, type: "page", status: "publish", slug: "a", builder: "gutenberg" }, page: { parent: "page:2" } });
		const b = doc({ source: { wpId: 2, type: "page", status: "publish", slug: "b", builder: "gutenberg" }, page: { parent: "page:1" } });
		const c = doc({ source: { wpId: 3, type: "page", status: "publish", slug: "c", builder: "gutenberg" } });
		expect(parentsFirst([c, a, b]).map((p) => p.source.slug)).toEqual(["c", "b", "a"]);
		expect(showsFeaturedImage('<img class="attachment-large size-large wp-post-image" src="x">')).toBe(true);
		expect(showsFeaturedImage('<img class="wp-image-5" src="x">')).toBe(false);
	});
});
