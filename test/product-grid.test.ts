/**
 * The product grid section (WooCommerce catalogue mode, PLAN §8b): section library and block mapping, the transform
 * (product ids → addresses, featured products → a hand-picked list, reported on a site without a shop), seed, client
 * docs and the starter's pure helpers. Adapter handlers have their own fixtures and goldens (test/fixtures/{gutenberg,
 * wpbakery,elementor}/woo-*). Synthetic shop: test/fixtures/shop/site.json; goldens: test/golden/product-grid/*.json
 * (UPDATE_GOLDEN=1 pnpm test). Sites without a shop: test/product-grid-noshop.test.ts.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adaptElementor, type ElementorElement, elementorKit } from "../src/adapters/elementor/index.js";
import { adaptGutenberg } from "../src/adapters/gutenberg/index.js";
import { shortcodeAction } from "../src/adapters/shortcodes.js";
import { adaptWpbakery } from "../src/adapters/wpbakery/index.js";
import { wooShortcode } from "../src/adapters/woocommerce.js";
import { kitConfigSchema } from "../src/config/schema.js";
import { sitePaths } from "../src/core/paths.js";
import { Keys } from "../src/ir/portable-text.js";
import type { Diagnostic, IrPage, Section } from "../src/ir/schema.js";
import { runTransform } from "../src/phases/transform.js";
import { type ClientRepoInput, clientRepoFiles } from "../src/scaffold/client-repo.js";
import { buildSeed } from "../src/scaffold/seed.js";
import { ALL_BLOCK_TYPES, BLOCK_TYPES, blockTypesFor, PRODUCT_GRID_BLOCK, SECTION_SLUGS, sectionSlugsFor } from "../src/starter/library.js";
import { conformToBlockType, sectionToBlock } from "../src/targets/emdash/blocks.js";
import type { BlogPlan } from "../src/transform/blog.js";
import type { CptPlan } from "../src/transform/cpt.js";
import { finishProductGrids } from "../src/transform/product-grid.js";
import { gridButtonLabel, isOnSale, orderBySlugs, productGridPlan, productItemList, productSlug } from "../starter/src/utils/product-grid.js";

const fx = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "shop", "site.json"), "utf8"));
const goldenDir = join(import.meta.dirname, "golden", "product-grid");
const golden = (name: string, value: unknown) => {
	const file = join(goldenDir, name);
	const json = `${JSON.stringify(value, null, "\t")}\n`;
	if (process.env.UPDATE_GOLDEN === "1" || !existsSync(file)) {
		mkdirSync(goldenDir, { recursive: true });
		writeFileSync(file, json);
	}
	expect(json).toBe(readFileSync(file, "utf8"));
};
const dir = mkdtempSync(join(tmpdir(), "wp2e-grid-"));
const put = (file: string, data: unknown) => {
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
};
const base = { slug: "grid", name: "Example Pottery", source: { url: "https://shop.example.test" }, target: { productionUrl: "https://shop.example.test" } };
const catalogue = kitConfigSchema.parse({ ...base, shop: { mode: "catalogue" } });
const noShop = kitConfigSchema.parse(base);
const popupFor = () => undefined;
const media = (m: { wpId?: number; url?: string } | undefined) => (m ? { $media: { url: m.url ?? `https://x.test/${m.wpId}.jpg`, filename: "f.jpg" } } : undefined);
const readDir = (d: string) => (existsSync(d) ? Object.fromEntries(readdirSync(d).sort().map((f) => [f, JSON.parse(readFileSync(join(d, f), "utf8"))])) : {});

/** Home page with WooCommerce grids (synthetic): hand-picked (one id unknown), a category, on sale, featured. */
const HOME = [
	'<!-- wp:heading --><h2 class="wp-block-heading">Picked for you</h2><!-- /wp:heading -->',
	'<!-- wp:woocommerce/handpicked-products {"columns":3,"products":[503,501,999]} /-->',
	'<!-- wp:woocommerce/product-category {"columns":4,"rows":1,"categories":[70]} /-->',
	'<!-- wp:woocommerce/product-on-sale {"columns":4,"rows":1} /-->',
	'<!-- wp:shortcode -->\n[featured_products per_page="2" columns="2"]\n<!-- /wp:shortcode -->',
].join("\n\n");
/** Featured on WordPress: the product_visibility term "featured" (502 newer than 504). */
const products = fx.product.map((p: { id: number; date_gmt: string; taxonomies: Record<string, unknown[]> }) =>
	p.id === 502 || p.id === 504 ? { ...p, date_gmt: p.id === 502 ? "2024-05-01 10:00:00" : "2024-04-01 10:00:00", taxonomies: { ...p.taxonomies, product_visibility: [{ id: 85, name: "featured", slug: "featured" }] } } : p,
);

function workspace(name: string) {
	const paths = sitePaths(name, dir);
	put(join(paths.raw, "extract.json"), {});
	put(join(paths.raw, "exporter", "options.json"), fx.options);
	put(join(paths.raw, "exporter", "content", "page.json"), fx.pages.map((p: { slug: string }) => (p.slug === "home" ? { ...p, content: HOME } : p)));
	put(join(paths.raw, "exporter", "content", "product.json"), products);
	put(join(paths.raw, "exporter", "content", "product_variation.json"), fx.product_variation);
	put(join(paths.raw, "exporter", "taxonomies.json"), fx.taxonomies);
	put(join(paths.raw, "exporter", "analyze.json"), fx.analyze);
	put(join(paths.raw, "exporter", "types.json"), fx.types);
	put(join(paths.raw, "media-manifest.json"), fx.media);
	put(join(paths.snapshot, "urls.json"), fx.urls);
	put(join(paths.snapshot, "discovery.json"), fx.discovery);
	put(join(paths.snapshot, "fingerprint.json"), fx.fingerprint);
	return paths;
}
const run = (paths: ReturnType<typeof sitePaths>, config = catalogue) => runTransform({ config, paths, reporter: { runId: "t", emit: () => {} } });
const grids = (doc: IrPage) => doc.sections.filter((s): s is Extract<Section, { type: "product_grid" }> => s.type === "product_grid");
const brief = (s: Extract<Section, { type: "product_grid" }>) => ({ source: s.fields.source, count: s.fields.count, columns: s.fields.columns, categories: s.fields.categories, products: s.fields.products, productIds: s.fields.productIds, featured: s.fields.featured, showPrice: s.fields.showPrice });

describe("section library", () => {
	it("the product grid is a shop-only block type, after Latest posts; other sites keep the shared library", () => {
		expect(blockTypesFor()).toBe(BLOCK_TYPES);
		expect(blockTypesFor({ shop: false })).toBe(BLOCK_TYPES);
		expect(sectionSlugsFor()).toBe(SECTION_SLUGS);
		expect(SECTION_SLUGS).not.toContain(PRODUCT_GRID_BLOCK);
		const shop = blockTypesFor({ shop: true }).map((b) => b.slug);
		expect(shop).toHaveLength(BLOCK_TYPES.length + 1);
		expect(shop.slice(shop.indexOf("section_posts_list"), shop.indexOf("section_posts_list") + 2)).toEqual(["section_posts_list", PRODUCT_GRID_BLOCK]);
		expect(ALL_BLOCK_TYPES.map((b) => b.slug)).toEqual(shop);
		const fields = ALL_BLOCK_TYPES.find((b) => b.slug === PRODUCT_GRID_BLOCK)?.versions[0]?.fields ?? [];
		expect(fields.slice(0, 9).map((f) => `${f.slug}:${f.type}`)).toEqual(["eyebrow:string", "heading:string", "heading_level:select", "intro:portableText", "source:select", "categories:string", "products:string", "count:integer", "columns:integer"]);
		expect(fields.find((f) => f.slug === "count")).toMatchObject({ defaultValue: 4, validation: { min: 1, max: 12 } });
		expect(fields.find((f) => f.slug === "source")?.validation?.options).toEqual(["latest", "on_sale", "category", "handpicked"]);
		const pattern = (slug: string) => new RegExp(fields.find((f) => f.slug === slug)?.validation?.pattern as string);
		expect(pattern("products").test("/product/blue-mug/, green-bowl,/product/red-plate")).toBe(true);
		expect(pattern("products").test("javascript:alert(1)")).toBe(false);
		expect(pattern("categories").test("mugs, bowls")).toBe(true);
	});

	it("every WooCommerce grid fixture maps to block values that conform to the block type", () => {
		const root = join(import.meta.dirname, "fixtures");
		const terms: Record<string, string> = { "product_cat:21": "mugs", "product_cat:22": "bowls" };
		const gb = readFileSync(join(root, "gutenberg", "woo-product-blocks.html"), "utf8").replace(/^<!-- fixture \{.*?\} -->\n?/, "");
		const el = JSON.parse(readFileSync(join(root, "elementor", "woo-products.json"), "utf8")) as { elements: ElementorElement[] };
		const sections = [
			...adaptGutenberg(gb, { kind: "page", keys: new Keys("t"), popupFor, postCount: 0, termSlug: (t, id) => terms[`${t}:${id}`] }).sections,
			...adaptWpbakery(readFileSync(join(root, "wpbakery", "woo-shortcodes.txt"), "utf8"), { kind: "page", keys: new Keys("t"), popupFor, postCount: 0 }).sections,
			...adaptElementor(el.elements, { kind: "page", keys: new Keys("t"), popupFor, postCount: 0, template: () => undefined, kit: elementorKit(undefined), postId: 10, title: "x", siteTitle: "x", permalink: () => undefined, popupSlug: () => undefined, menuItems: () => undefined }).sections,
		].filter((s) => s.type === "product_grid");
		expect(sections.length).toBeGreaterThan(20);
		const ctx = { shop: true, productPath: (id: number) => (id === 999 ? undefined : `/product/p-${id}/`), featuredIds: () => [502] };
		for (const s of sections) {
			const [resolved] = finishProductGrids({ version: 1, kind: "page", source: { wpId: 1, type: "page", status: "publish", slug: "x", builder: "gutenberg" }, title: "x", seo: { jsonLdTypes: [] }, sections: [s], diagnostics: [] } as never, ctx).sections as Section[];
			const drops: string[] = [];
			const v = sectionToBlock(resolved as Section, "k", media, (d) => drops.push(...d));
			expect(v._type).toBe(PRODUCT_GRID_BLOCK);
			expect(conformToBlockType(v).dropped).toEqual([]);
			expect(drops).toEqual([]);
			if (s.fields.source === "handpicked") expect(String(v.products)).toMatch(/^product\/p-\d+(, product\/p-\d+)*$/);
		}
	});
});

describe("transform", async () => {
	const shopPaths = workspace("shop");
	const shopChecks = await run(shopPaths);
	const home = JSON.parse(readFileSync(join(shopPaths.ir, "pages", "home.json"), "utf8")) as IrPage;

	it("catalogue mode: product ids become the products' addresses, featured products a hand-picked list (golden)", () => {
		expect(shopChecks.find((c) => c.id === "ir-valid")).toMatchObject({ ok: true });
		const g = grids(home);
		golden("transform-shop.json", { sections: g.map(brief), diagnostics: home.diagnostics.filter((d) => d.tag === "product_grid" || /woocommerce|products\]/.test(d.message)) });
		expect(g.map((s) => s.fields.source)).toEqual(["handpicked", "category", "on_sale", "handpicked"]);
		expect(g[0]?.fields.products).toEqual(["product/red-plate", "product/blue-mug"]);
		expect(g[1]?.fields.categories).toEqual(["mugs"]);
		// Featured on WordPress, newest first, at most the shortcode's per_page.
		expect(g[3]?.fields.products).toEqual(["product/green-bowl", "product/tall-vase"]);
		expect(g.every((s) => !s.fields.productIds.length && s.fields.featured === undefined)).toBe(true);
		expect(home.diagnostics.find((d) => /#999 not found/.test(d.message))).toMatchObject({ level: "warn", code: "lossy" });
		const entries = Object.keys(readDir(join(shopPaths.ir, "entries", "products")));
		for (const slug of g.flatMap((s) => s.fields.products)) expect(entries).toContain(`${slug.split("/").pop()}.json`);
	});

	it("no catalogue mode: the grids are taken out and reported as unmapped content (never silently dropped)", async () => {
		const paths = workspace("noshop");
		const checks = await run(paths, noShop);
		const doc = JSON.parse(readFileSync(join(paths.ir, "pages", "home.json"), "utf8")) as IrPage;
		expect(grids(doc)).toEqual([]);
		const reported = doc.diagnostics.filter((d) => d.tag === "product_grid");
		expect(reported).toHaveLength(4);
		expect(reported.every((d: Diagnostic) => d.level === "error" && d.code === "unmapped" && d.carriesContent)).toBe(true);
		expect(reported[0]?.message).toMatch(/WooCommerce product grid \(hand-picked products\), but the new site has no shop/);
		expect(checks.find((c) => c.id === "shop")).toMatchObject({ ok: false });
		const md = readFileSync(join(paths.reports, "transform", "coverage.md"), "utf8");
		expect(md).toMatch(/product grid/);
		expect(md).toMatch(/`\[featured_products\]` \| product grid section/);
	});

	it("a grid none of whose products exist is reported; one whose products partly exist keeps the rest", () => {
		const doc = (s: Section) => ({ version: 1, kind: "page", source: { wpId: 1, type: "page", status: "publish", slug: "x", builder: "gutenberg" }, title: "x", seo: { jsonLdTypes: [] }, sections: [s], diagnostics: [] }) as unknown as IrPage;
		const grid = (productIds: number[]): Section => ({ type: "product_grid", theme: { tone: "light" }, spacing: "normal", sourceRef: { adapter: "gutenberg", path: "blocks[0]", rawHash: "x" }, fields: { intro: [], source: "handpicked", categories: [], products: [], productIds, count: 2, showPrice: true } }) as Section;
		const ctx = { shop: true, productPath: (id: number) => (id === 1 ? "/product/one/" : undefined), featuredIds: () => [] };
		expect(finishProductGrids(doc(grid([7, 8])), ctx).diagnostics.map((d) => d.level)).toEqual(["warn", "error"]);
		const kept = finishProductGrids(doc(grid([7, 1])), ctx);
		expect(kept.diagnostics.map((d) => d.level)).toEqual(["warn"]);
		expect((kept.sections[0] as Extract<Section, { type: "product_grid" }>).fields.products).toEqual(["product/one"]);
	});
});

describe("seed and client docs", () => {
	const site = { version: 1 as const, title: "Example Pottery", menus: [], partials: [], popups: [] };
	const blog: BlogPlan = { index: "/blog/", perPage: 10, feed: { full: false, items: 10 }, permalink: "", taxonomies: [], bylines: [], authorBase: "/author/" } as unknown as BlogPlan;

	it("shop sites: the product grid block type, allowed in pages, header & footer, popups, posts and collections", () => {
		const plan = { collections: [{ slug: "products", label: "Products", labelSingular: "Product", description: "", type: "product", routable: true, hierarchical: false, core: { title: true, excerpt: true, featuredImage: true, body: true, sections: true, menuOrder: false, bylines: false }, fields: [], taxonomies: [], unknownMeta: [] }], taxonomies: [], bylines: [] } as unknown as CptPlan;
		const seed = buildSeed({ name: "x", site, pages: [], partials: [], popups: [], media: () => undefined, titleSeparator: "-", forms: [], includeContent: false, blog: { plan: blog, posts: [] }, collections: { plan, entries: [] }, shop: true });
		expect((seed.blockTypes as { slug: string }[]).map((b) => b.slug)).toContain(PRODUCT_GRID_BLOCK);
		for (const c of seed.collections as { slug: string; fields: { type: string; validation?: { allowedTypes?: string[] } }[] }[]) {
			const blocks = c.fields.find((f) => f.type === "blocks");
			expect(blocks?.validation?.allowedTypes, c.slug).toContain(PRODUCT_GRID_BLOCK);
		}
		// The shared posts collection definition is not changed for the next (non-shop) site.
		const plain = buildSeed({ name: "x", site, pages: [], partials: [], popups: [], media: () => undefined, titleSeparator: "-", forms: [], includeContent: false, blog: { plan: blog, posts: [] } });
		expect(JSON.stringify(plain)).not.toContain(PRODUCT_GRID_BLOCK);
	});

	it("editor guide: the product grid is explained on shop sites only", () => {
		const input = (sections: ClientRepoInput["sections"]): ClientRepoInput => ({ name: "Example Pottery", slug: "grid", sourceUrl: "https://shop.example.test", productionUrl: "https://shop.example.test", workerName: "grid", productionReady: false, sections, forms: [], email: { provider: "brevo", to: ["owner@example.test"] }, turnstileProduction: false, sensitiveData: false, stack: { node: ">=24", astro: "7", emdash: "1.5.0", wrangler: "4" } });
		const grid = ALL_BLOCK_TYPES.find((b) => b.slug === PRODUCT_GRID_BLOCK) as (typeof ALL_BLOCK_TYPES)[number];
		const shop = clientRepoFiles(input([{ slug: grid.slug, label: grid.label, description: grid.description }]))["docs/editor-guide.md"] ?? "";
		expect(shop).toMatch(/\| Product grid \| Products from the shop/);
		expect(shop).toMatch(/\*\*Product grid\*\* \(shop sites\): add it to any page/);
		expect(shop).toMatch(/updates on its own when a product is published, changed or put on sale\.\n\n## Good to know/);
		const plain = clientRepoFiles(input([{ slug: "section_hero", label: "Hero", description: "Intro" }]))["docs/editor-guide.md"] ?? "";
		expect(plain).not.toMatch(/Product grid/);
		expect(plain).toMatch(/open a popup \(enter the popup's name\)\.\n\n## Good to know/);
	});
});

describe("shortcode registry", () => {
	it("product listings are product grids; listings the grid cannot rebuild are blocking WooCommerce widgets", () => {
		for (const t of ["products", "featured_products", "sale_products", "recent_products", "product_category"]) expect(shortcodeAction(t)).toEqual({ do: "products" });
		expect(shortcodeAction("best_selling_products")).toEqual({ do: "widget", what: "WooCommerce best sellers", content: true });
		expect(shortcodeAction("add_to_cart")).toMatchObject({ do: "widget", content: true });
		expect(wooShortcode("vc_row", {}, () => {}, "p")).toBeUndefined();
	});
});

describe("starter helpers", () => {
	it("plan: sources, count 1–12 (default 4), columns, price, button label, categories and products", () => {
		expect(productGridPlan({})).toEqual({ source: "latest", count: 4, showPrice: true, categories: [], slugs: [] });
		expect(productGridPlan({ source: "category", categories: "mugs, bowls ,", count: 6, columns: 3, show_price: false, button_label: " Shop now " })).toEqual({ source: "category", count: 6, columns: 3, showPrice: false, buttonLabel: "Shop now", categories: ["mugs", "bowls"], slugs: [] });
		expect(productGridPlan({ source: "nope", count: 40, columns: 9 })).toMatchObject({ source: "latest", count: 4 });
		expect(productGridPlan({ source: "handpicked", products: "/product/blue-mug/, green-bowl, https://shop.example.test/product/red-plate/, blue-mug, ../x" }, "/product/").slugs).toEqual(["product/blue-mug", "product/green-bowl", "product/red-plate"]);
	});

	it("product slugs: addresses, bare slugs under the products' base, full URLs", () => {
		expect(productSlug("/product/blue-mug/")).toBe("product/blue-mug");
		expect(productSlug("blue-mug", "/shop/item/")).toBe("shop/item/blue-mug");
		expect(productSlug("blue-mug", "")).toBe("blue-mug");
		expect(productSlug("https://shop.example.test/product/blue-mug/?x=1")).toBe("product/blue-mug");
		expect(productSlug("javascript:alert(1)")).toBeUndefined();
		expect(productSlug("")).toBeUndefined();
	});

	it("on sale, hand-picked order, button label and the ItemList of product pages", () => {
		expect(isOnSale({ price: 40, sale_price: 32 })).toBe(true);
		expect(isOnSale({ price: 40, sale_price: 40 })).toBe(false);
		expect(isOnSale({ price: 50, variations: [{ price: 80, sale_price: 70 }] })).toBe(true);
		expect(isOnSale({ price: 24 })).toBe(false);
		const e = (slug: string) => ({ id: slug, data: { slug } });
		expect(orderBySlugs([e("product/a"), e("product/b"), e("product/c")], ["product/c", "product/a"]).map((x) => x.id)).toEqual(["product/c", "product/a"]);
		expect(gridButtonLabel({}, { buy_label: "Book the course" })).toBe("Book the course");
		expect(gridButtonLabel({}, { buy_label: " " })).toBe("View product");
		expect(gridButtonLabel({ buttonLabel: "Shop now" }, { buy_label: "Book" })).toBe("Shop now");
		expect(productItemList([])).toBeUndefined();
		expect(productItemList(["https://shop.example.test/product/a/"])).toEqual({ "@context": "https://schema.org", "@type": "ItemList", itemListElement: [{ "@type": "ListItem", position: 1, url: "https://shop.example.test/product/a/" }] });
	});
});
