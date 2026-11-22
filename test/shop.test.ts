/**
 * WooCommerce catalogue mode (kit.config `shop`, docs/PLAN.md §8b): config, the audit's Store API facts and gate, the
 * owner decisions, the transform (products collection, product fields, WooCommerce pages, redirects, gates, report),
 * seed fields and the starter's price, Buy button, Product structured data, redirects and form prefill.
 * Synthetic shop: test/fixtures/shop/site.json. Goldens: test/golden/shop/*.json (UPDATE_GOLDEN=1 pnpm test).
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prefillPlan } from "../packages/forms/src/prefill.js";
import { readStoreApi, storeApiFacts } from "../src/audit/shop.js";
import { kitConfigSchema } from "../src/config/schema.js";
import { sitePaths } from "../src/core/paths.js";
import type { IrPage } from "../src/ir/schema.js";
import { runTransform } from "../src/phases/transform.js";
import { customContentGuide } from "../src/scaffold/client-repo.js";
import { buildSeed } from "../src/scaffold/seed.js";
import { type CptPlan, collectionFields, starterCollectionsConfig } from "../src/transform/cpt.js";
import { emptyFacts, exporterFacts, productMeta, type ProductPost, type ShopFacts, shopBlockers, shopDecisions, shopGate, wooPageRole } from "../src/transform/shop.js";
import { collectionRoute, entryCollections } from "../starter/src/utils/collections.js";
import { llmsTxt } from "../starter/src/utils/llms.js";
import { buyButton, formatPrice, priceView, productJsonLd } from "../starter/src/utils/shop.js";
import { matchWpUrl } from "../starter/src/utils/wp-urls.js";

const fx = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "shop", "site.json"), "utf8"));
const goldenDir = join(import.meta.dirname, "golden", "shop");
const golden = (name: string, value: unknown) => {
	const file = join(goldenDir, name);
	const json = `${JSON.stringify(value, null, "\t")}\n`;
	if (process.env.UPDATE_GOLDEN === "1" || !existsSync(file)) {
		mkdirSync(goldenDir, { recursive: true });
		writeFileSync(file, json);
	}
	expect(json).toBe(readFileSync(file, "utf8"));
};

const dir = mkdtempSync(join(tmpdir(), "wp2e-shop-"));
const put = (file: string, data: unknown) => {
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
};
const base = { slug: "shop", name: "Example Pottery", source: { url: "https://shop.example.test" }, target: { productionUrl: "https://shop.example.test" } };
const catalogue = (shop: Record<string, unknown> = {}) => kitConfigSchema.parse({ ...base, shop: { mode: "catalogue", ...shop } });
const noShop = kitConfigSchema.parse(base);

/** A site workspace with the fixture's extract and audit output. */
function workspace(name: string, opts: { options?: Record<string, unknown>; pages?: unknown[] } = {}) {
	const paths = sitePaths(name, dir);
	put(join(paths.raw, "extract.json"), {});
	put(join(paths.raw, "exporter", "options.json"), opts.options ?? fx.options);
	put(join(paths.raw, "exporter", "content", "page.json"), opts.pages ?? fx.pages);
	put(join(paths.raw, "exporter", "content", "product.json"), fx.product);
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
const run = (paths: ReturnType<typeof sitePaths>, config = catalogue()) => runTransform({ config, paths, reporter: { runId: "t", emit: () => {} } });
const readDir = (d: string) => (existsSync(d) ? Object.fromEntries(readdirSync(d).sort().map((f) => [f, JSON.parse(readFileSync(join(d, f), "utf8"))])) : {});
const check = (checks: { id: string }[], id: string) => checks.find((c) => c.id === id) as { id: string; ok: boolean; detail?: string } | undefined;

describe("config", () => {
	it("shop: catalogue mode with defaults; unset by default", () => {
		expect(noShop.shop).toBeUndefined();
		expect(catalogue().shop).toEqual({ mode: "catalogue", checkout: "external", maxProducts: 200 });
		expect(catalogue({ checkout: "contact", contactPath: "/get-in-touch/", currency: "GBP" }).shop).toMatchObject({ checkout: "contact", contactPath: "/get-in-touch/", currency: "GBP" });
		expect(kitConfigSchema.safeParse({ ...base, shop: { mode: "store" } }).success).toBe(false);
		expect(kitConfigSchema.safeParse({ ...base, shop: { mode: "catalogue", currency: "euro" } }).success).toBe(false);
		expect(kitConfigSchema.safeParse({ ...base, shop: { mode: "catalogue", checkout: "cart" } }).success).toBe(false);
	});
});

describe("audit: Store API facts, gate and decisions", () => {
	const facts = storeApiFacts(fx.storeApi, 5, ["woocommerce"]);

	it("counts what the public Store API shows", () => {
		expect(facts).toMatchObject({ source: "store-api", products: 5, types: { external: 1, simple: 3, variable: 1 }, variations: 2, onSale: 2, outOfStock: 1, stockManaged: 1, reviews: 2, attributes: 3, currency: "EUR", plugins: { subscriptions: false, memberships: false, bookings: false } });
	});

	it("reads the Store API page by page; none when it does not answer", async () => {
		const many = Array.from({ length: 130 }, (_, i) => ({ id: i + 1, type: "simple" }));
		const calls: string[] = [];
		const fetchFn = async (u: string) => {
			calls.push(u);
			const page = Number(new URL(u).searchParams.get("page"));
			return { status: 200, body: JSON.stringify(many.slice((page - 1) * 100, page * 100)), headers: { "x-wp-total": "130", "x-wp-totalpages": "2" } };
		};
		const f = await readStoreApi("https://shop.example.test", fetchFn, ["woocommerce", "woocommerce-subscriptions"]);
		expect(calls).toEqual(["https://shop.example.test/wp-json/wc/store/v1/products?per_page=100&page=1", "https://shop.example.test/wp-json/wc/store/v1/products?per_page=100&page=2"]);
		expect(f).toMatchObject({ products: 130, types: { simple: 130 }, plugins: { subscriptions: true } });
		const none = await readStoreApi("https://shop.example.test", async () => ({ status: 401, body: "{}", headers: {} }), ["woocommerce"]);
		expect(none.source).toBe("none");
		expect(shopGate(none, catalogue().shop).ok).toBe(true);
	});

	it("passes only with the owner's shop.mode; big shops, subscriptions and memberships keep stopping", () => {
		expect(shopGate(facts, undefined)).toMatchObject({ ok: false });
		expect(shopGate(facts, undefined).detail).toMatch(/5 products \(1 external, 3 simple, 1 variable\)\. A shop needs the owner's decision: .*shop: \{ mode: "catalogue"/);
		expect(shopGate(facts, catalogue().shop)).toEqual({ ok: true, detail: 'catalogue mode, checkout "external": 5 products (1 external, 3 simple, 1 variable); 12 decisions listed in the shop report' });
		const big: ShopFacts = { ...facts, products: 201 };
		expect(shopGate(big, catalogue().shop)).toMatchObject({ ok: false });
		expect(shopBlockers(big, 200)[0]).toMatch(/201 products: catalogue mode is for small shops/);
		expect(shopGate(big, catalogue({ maxProducts: 300 }).shop).ok).toBe(true);
		expect(shopBlockers({ ...facts, types: { ...facts.types, subscription: 2 } }, 200)).toEqual(["subscriptions (2 subscription products): recurring billing and renewals need a store"]);
		expect(shopBlockers({ ...facts, plugins: { subscriptions: false, memberships: true, bookings: false } }, 200)[0]).toMatch(/^memberships/);
		expect(shopBlockers({ ...facts, plugins: { subscriptions: false, memberships: false, bookings: true } }, 200)).toEqual([]);
	});

	it("lists everything catalogue mode cannot do as a decision (golden)", () => {
		const exp = exporterFacts({ products: fx.product, variations: fx.product_variation, currency: "EUR", plugins: { subscriptions: false, memberships: false, bookings: true } });
		golden("decisions.json", { storeApi: shopDecisions(facts, "external"), exporter: shopDecisions(exp, "contact") });
		const ids = shopDecisions(exp, "external").map((d) => d.id);
		for (const id of ["cart-checkout", "accounts", "orders", "coupons", "variable", "external", "downloads", "stock", "out-of-stock", "sales", "scheduled-sales", "reviews", "attributes", "bookings"]) expect(ids, id).toContain(id);
		expect(shopDecisions(emptyFacts(), undefined).map((d) => d.id)).toEqual(["cart-checkout", "accounts", "orders", "coupons", "payments-tax-shipping"]);
	});
});

describe("transform", () => {
	it("products collection, fields, entries, redirects and gates (golden)", async () => {
		const paths = workspace("catalogue");
		const checks = await run(paths);
		for (const id of ["shop", "shop-checkout", "content-types-handled", "cpt-fields", "ir-valid", "media-refs"]) expect(check(checks, id), `${id}: ${check(checks, id)?.detail}`).toMatchObject({ ok: true });
		expect(check(checks, "shop-checkout")?.detail).toBe("/shop/ lists 5 product(s) in EUR; Buy button: each product's buy_url; /cart/, /checkout/, /my-account/ → 301 /shop/");
		const plan = JSON.parse(readFileSync(join(paths.ir, "collections.json"), "utf8")) as CptPlan;
		golden("collections.json", plan);
		golden("entries.json", readDir(join(paths.ir, "entries", "products")));
		const wp = JSON.parse(readFileSync(join(paths.ir, "wp-urls.json"), "utf8"));
		expect(wp.rules.shop).toEqual({ paths: ["/cart/", "/checkout/", "/my-account/"], to: "/shop/" });
		// WooCommerce's own pages are not migrated as pages; the rest are.
		expect(Object.keys(readDir(join(paths.ir, "pages")))).toEqual(["contact.json", "home.json"]);
		const shop = JSON.parse(readFileSync(join(paths.ir, "shop.json"), "utf8"));
		expect(shop).toMatchObject({ mode: "catalogue", checkout: "external", listing: "/shop/", currency: "EUR", facts: { source: "exporter", products: 5, variations: 2, scheduledSales: 1 } });
		const md = readFileSync(join(paths.reports, "transform", "coverage.md"), "utf8");
		expect(md).toMatch(/## Shop \(WooCommerce\)/);
		expect(md).toMatch(/\| Coupons \| — \| not carried/);
		expect(md).toMatch(/### Products \(`product` → collection `products`\)/);
		expect(md).toMatch(/page cart: WooCommerce cart page, not rebuilt in catalogue mode \(\/cart\/ answers 301 → the shop listing\)/);
		expect(md).toMatch(/\| taxonomy \| pa_size \| 2 \| 2 \| migrated \| product attribute/);
	});

	it("keeps each product's data: prices, sale, gallery, attributes, variations, external link", async () => {
		const paths = workspace("data");
		await run(paths);
		const entry = (slug: string) => JSON.parse(readFileSync(join(paths.ir, "entries", "products", `${slug}.json`), "utf8")) as IrPage;
		const mug = entry("blue-mug");
		expect(mug).toMatchObject({ route: { path: "/product/blue-mug/" }, featuredImage: { wpId: 601 }, entry: { collection: "products", terms: { product_cat: ["mugs"], product_tag: ["blue"] } } });
		expect(mug.entry?.fields).toMatchObject({ product_type: "simple", price: 24, currency: "EUR", sku: "MUG-BLUE", stock_status: "instock", gallery: [{ image: { wpId: 602, kind: "image" } }, { image: { wpId: 603, kind: "image" } }], attributes: [{ name: "Color", value: "Blue" }, { name: "Material", value: "Stoneware, Clear glaze" }] });
		expect((mug.entry?.fields.short_description as { _type: string }[])[0]?._type).toBe("block");
		expect(mug.entry?.body.length).toBeGreaterThan(0);
		expect(mug.entry?.fields).not.toHaveProperty("sale_price");
		expect(entry("green-bowl").entry?.fields).toMatchObject({ price: 40, sale_price: 32, stock_status: "outofstock" });
		const plate = entry("red-plate");
		expect(plate.entry?.fields).toMatchObject({ price: 30 });
		expect(plate.entry?.fields).not.toHaveProperty("sale_price");
		expect(plate.diagnostics.find((d) => d.path === "shop")?.message).toMatch(/scheduled sale price 20 not carried/);
		expect(entry("tall-vase").entry?.fields).toMatchObject({ product_type: "variable", price: 50, variations: [{ name: "Size: Small", sku: "VASE-S", price: 50, stock_status: "instock" }, { name: "Size: Large", sku: "VASE-L", price: 80, sale_price: 70, stock_status: "onbackorder" }] });
		const course = entry("pottery-course");
		expect(course.entry?.fields).toMatchObject({ product_type: "external", price: 120, buy_url: "https://courses.example.org/pottery", buy_label: "Book the course" });
		expect(course.diagnostics.some((d) => /digital download/.test(d.message))).toBe(true);
		const plan = JSON.parse(readFileSync(join(paths.ir, "collections.json"), "utf8")) as CptPlan;
		const col = plan.collections[0] as CptPlan["collections"][number];
		expect(col).toMatchObject({ slug: "products", base: "/product/", archive: "/shop/", shop: { checkout: "external", currency: "EUR" } });
		expect(col.taxonomies.map((t) => [t.name, t.base])).toEqual([["product_cat", "/product-category/"], ["product_tag", "/product-tag/"]]);
		expect(plan.taxonomies.map((t) => t.name)).toEqual(["product_cat", "product_tag"]);
		// total_sales (store statistics) is WooCommerce's own meta, not unmapped content.
		expect(col.unknownMeta).toEqual([]);
	});

	it("without the owner's shop.mode the shop gate stays red", async () => {
		const checks = await run(workspace("undecided"), noShop);
		expect(check(checks, "shop")).toMatchObject({ ok: false });
		expect(check(checks, "shop")?.detail).toMatch(/A shop needs the owner's decision/);
		expect(check(checks, "shop-checkout")).toBeUndefined();
	});

	it("checkout contact: the contact page is found, else the gate asks for shop.contactPath; currency is required", async () => {
		const found = await run(workspace("contact"), catalogue({ checkout: "contact" }));
		expect(check(found, "shop-checkout")?.detail).toMatch(/Buy button: contact form at \/contact\//);
		const plan = JSON.parse(readFileSync(join(sitePaths("contact", dir).ir, "collections.json"), "utf8")) as CptPlan;
		expect(starterCollectionsConfig(plan)[0]?.shop).toEqual({ checkout: "contact", currency: "EUR", contactPath: "/contact/" });
		const noContact = await run(workspace("no-contact", { pages: fx.pages.filter((p: { slug: string }) => p.slug !== "contact"), options: { ...fx.options, woocommerce_currency: undefined } }), catalogue({ checkout: "contact" }));
		expect(check(noContact, "shop-checkout")).toMatchObject({ ok: false });
		expect(check(noContact, "shop-checkout")?.detail).toMatch(/the currency .*; the contact page/);
		const set = await run(workspace("contact-set", { options: { ...fx.options, woocommerce_currency: undefined } }), catalogue({ checkout: "contact", contactPath: "/enquiries/", currency: "GBP" }));
		expect(check(set, "shop-checkout")).toMatchObject({ ok: true });
	});

	it("WooCommerce pages by option or by their shortcode/block", () => {
		expect(wooPageRole({ id: 3, content: "" }, { woocommerce_shop_page_id: 3 })).toBe("shop");
		expect(wooPageRole({ id: 9, content: "[woocommerce_cart]" }, {})).toBe("cart");
		expect(wooPageRole({ id: 9, content: "<!-- wp:woocommerce/checkout {} /-->" }, {})).toBe("checkout");
		expect(wooPageRole({ id: 9, content: "[woocommerce_my_account]" }, {})).toBe("myaccount");
		expect(wooPageRole({ id: 9, content: "<p>About</p>" }, { woocommerce_shop_page_id: 3 })).toBeUndefined();
	});

	it("product meta: PHP-serialized attributes, custom variation attributes, missing prices", () => {
		const p: ProductPost = { id: 1, status: "publish", slug: "tee", title: "Tee", excerpt: "", parent: null, menu_order: 0, taxonomies: {}, meta: { _product_attributes: 'a:1:{s:4:"size";a:6:{s:4:"name";s:4:"Size";s:5:"value";s:5:"S | M";s:8:"position";i:0;s:10:"is_visible";i:1;s:12:"is_variation";i:1;s:11:"is_taxonomy";i:0;}}' } };
		const v = (id: number, size: string, price?: string): ProductPost => ({ id, status: "publish", slug: `tee-${id}`, title: "", excerpt: "", parent: 1, menu_order: id, taxonomies: {}, meta: { attribute_size: size, ...(price ? { _regular_price: price, _price: price } : {}) } });
		const r = productMeta(p, [v(2, "S", "10"), v(3, "", undefined)], { taxonomyLabel: () => undefined, termName: () => undefined });
		expect(r.meta).toMatchObject({ "woo:product_type": "variable", "woo:price": 10, "woo:attributes": [{ name: "Size", value: "S, M" }], "woo:variations": [{ name: "Size: S", price: 10 }, { name: "Size: any" }] });
		expect(r.meta).not.toHaveProperty("woo:currency");
	});
});

describe("seed and starter", async () => {
	const paths = workspace("generated");
	await run(paths);
	const plan = JSON.parse(readFileSync(join(paths.ir, "collections.json"), "utf8")) as CptPlan;
	const products = plan.collections[0] as CptPlan["collections"][number];
	const cfg = starterCollectionsConfig(plan);
	const shop = { checkout: "external" as const, currency: "EUR", contactPath: "/contact/" };

	it("seed: the products collection with its WooCommerce fields, taxonomies and entries", () => {
		expect(collectionFields(products, []).map((f) => `${f.slug}:${f.type}`)).toEqual(["title:string", "excerpt:text", "featured_image:image", "body:portableText", "product_type:select", "price:number", "sale_price:number", "currency:string", "sku:string", "stock_status:select", "short_description:portableText", "gallery:repeater", "attributes:repeater", "variations:repeater", "buy_url:url", "buy_label:string"]);
		const entries = Object.values(readDir(join(paths.ir, "entries", "products"))) as IrPage[];
		const seed = buildSeed({ name: "x", site: { version: 1, title: "Example Pottery", menus: [], partials: [], popups: [] }, pages: [], partials: [], popups: [], media: () => undefined, titleSeparator: "-", forms: [], includeContent: true, collections: { plan, entries } });
		const col = (seed.collections as { slug: string; urlPattern?: string; fields: { slug: string; validation?: Record<string, unknown> }[] }[]).find((c) => c.slug === "products");
		expect(col?.urlPattern).toBe("/{slug}");
		expect(col?.fields.find((f) => f.slug === "stock_status")?.validation).toEqual({ options: ["instock", "outofstock", "onbackorder"] });
		expect((seed.taxonomies as { name: string; collections: string[] }[]).filter((t) => t.collections.includes("products")).map((t) => t.name)).toEqual(["product_cat", "product_tag"]);
		expect(((seed.content as Record<string, unknown[]>).products ?? []).length).toBe(5);
	});

	it("routes: /shop/, /product-category/<slug>/, /product/<slug>/", () => {
		expect(cfg[0]).toMatchObject({ slug: "products", base: "/product/", archive: "/shop/", shop: { checkout: "external", currency: "EUR" } });
		expect(collectionRoute("/shop/", cfg)).toMatchObject({ kind: "archive", collection: { slug: "products" } });
		expect(collectionRoute("/shop/page/2/", cfg)).toMatchObject({ kind: "archive", page: 2 });
		expect(collectionRoute("/product-category/mugs/", cfg)).toMatchObject({ kind: "term", taxonomy: "product_cat", slug: "mugs" });
		expect(entryCollections("product/blue-mug", cfg).map((c) => c.slug)).toEqual(["products"]);
	});

	it("price: sale with the regular price, 'from' for variable products, the shop's currency", () => {
		expect(formatPrice(24, "EUR", "en")).toBe("€24.00");
		expect(priceView({ price: 40, sale_price: 32 }, shop)).toEqual({ current: "€32.00", regular: "€40.00", from: false, onSale: true });
		expect(priceView({ price: 24, currency: "USD" }, shop)).toEqual({ current: "$24.00", from: false, onSale: false });
		// A variable product shows its range, as WooCommerce's listing does ("€50.00 – €70.00"; WordPress e2e test).
		expect(priceView({ product_type: "variable", price: 50, variations: [{ price: 50 }, { price: 80, sale_price: 70 }] }, shop)).toMatchObject({ current: "€50.00", from: true, max: "€70.00" });
		expect(priceView({ product_type: "variable", price: 50, variations: [{ price: 50 }, { price: 50 }] }, shop)).toEqual({ current: "€50.00", from: false, onSale: false });
		expect(priceView({ title: "No price" }, shop)).toBeUndefined();
	});

	it("Buy button: buy_url, Stripe Payment Link, contact form with the product, out of stock", () => {
		expect(buyButton({ title: "Blue Mug", buy_url: "https://checkout.example.org/mug" }, shop)).toEqual({ label: "Buy", href: "https://checkout.example.org/mug", external: true });
		expect(buyButton({ title: "Course", buy_url: "https://buy.stripe.com/test_123", buy_label: "Book the course" }, { ...shop, checkout: "stripe-payment-links" })).toEqual({ label: "Book the course", href: "https://buy.stripe.com/test_123", external: true });
		expect(buyButton({ title: "Blue Mug & Saucer" }, { ...shop, checkout: "contact" })).toEqual({ label: "Enquire", href: "/contact/?product=Blue%20Mug%20%26%20Saucer", external: false });
		// An external/affiliate product keeps WordPress's product URL even when the shop sells through the contact form.
		expect(buyButton({ title: "Course", product_type: "external", buy_url: "https://courses.example.org/pottery", buy_label: "Book the course" }, { ...shop, checkout: "contact" })).toEqual({ label: "Book the course", href: "https://courses.example.org/pottery", external: true });
		// No link set yet: the contact form when the site has one, else no button.
		expect(buyButton({ title: "Blue Mug" }, shop)?.href).toBe("/contact/?product=Blue%20Mug");
		expect(buyButton({ title: "Blue Mug" }, { checkout: "external" })).toBeUndefined();
		expect(buyButton({ title: "Bad", buy_url: "javascript:alert(1)" }, { checkout: "external" })).toBeUndefined();
		expect(buyButton({ title: "Bowl", stock_status: "outofstock", buy_url: "https://x.example.org" }, shop)).toEqual({ label: "Out of stock", external: false });
	});

	it("Product structured data: Offer, AggregateOffer for variations, availability", () => {
		const page = { canonical: "https://shop.example.test/product/green-bowl/", title: "Green Bowl", description: "A wide serving bowl.", images: ["https://shop.example.test/_emdash/api/media/file/a.jpg"] };
		golden("product-jsonld.json", {
			simple: productJsonLd({ price: 40, sale_price: 32, sku: "BOWL-GRN", stock_status: "outofstock" }, shop, page),
			variable: productJsonLd({ product_type: "variable", price: 50, stock_status: "instock", variations: [{ price: 50 }, { price: 80, sale_price: 70 }] }, shop, { ...page, images: [] }),
		});
		expect(productJsonLd({ price: 10 }, { checkout: "external" }, page)).not.toHaveProperty("offers");
	});

	it("cart, checkout and my-account (and add-to-cart links) 301 to the shop listing; real pages win", () => {
		const rules = { ...(JSON.parse(readFileSync(join(paths.ir, "wp-urls.json"), "utf8")).rules as Parameters<typeof matchWpUrl>[2]) };
		expect(matchWpUrl("/cart/", new URLSearchParams(), rules)).toEqual({ kind: "shop", to: "/shop/" });
		expect(matchWpUrl("/my-account/orders/", new URLSearchParams(), rules)).toEqual({ kind: "shop", to: "/shop/" });
		expect(matchWpUrl("/checkout/order-received/12/", new URLSearchParams("key=wc_order_x"), rules)).toEqual({ kind: "shop", to: "/shop/" });
		expect(matchWpUrl("/", new URLSearchParams("add-to-cart=501"), rules)).toEqual({ kind: "shop", to: "/shop/" });
		expect(matchWpUrl("/product/blue-mug/", new URLSearchParams(), rules)).toBeUndefined();
		expect(matchWpUrl("/cart/", new URLSearchParams(), { ...rules, pages: [...(rules.pages ?? []), "/cart/"] })).toBeUndefined();
		expect(matchWpUrl("/cart/", new URLSearchParams(), { ...rules, shop: undefined })).toBeUndefined();
	});

	it("client docs: how the Buy button works for the chosen checkout", () => {
		const col = { label: "Products", labelSingular: "Product", slug: "products", archive: "/shop/", base: "/product/", fields: [{ label: "Buy link", type: "url" }], hierarchical: false, taxonomies: ["Product categories"] };
		expect(customContentGuide([{ ...col, shop: { checkout: "stripe-payment-links" } }])).toMatch(/\*\*Selling\.\*\* There is no cart .* paste the product's Stripe Payment Link there/);
		expect(customContentGuide([{ ...col, shop: { checkout: "contact", contactPath: "/contact/" } }])).toMatch(/opens the contact form \(`\/contact\/`\) with the product's name/);
		expect(customContentGuide([col])).not.toMatch(/Selling/);
	});

	it("llms.txt lists the products after pages and posts", () => {
		expect(llmsTxt({ name: "Example Pottery" }, [{ title: "Home", url: "https://shop.example.test/" }], [], [{ heading: "Products", items: [{ title: "Blue Mug", url: "https://shop.example.test/product/blue-mug/", description: "A mug." }] }])).toBe("# Example Pottery\n\n## Pages\n\n- [Home](https://shop.example.test/)\n\n## Products\n\n- [Blue Mug](https://shop.example.test/product/blue-mug/): A mug.\n");
	});
});

describe("forms: prefill from the address", () => {
	const fields = [
		{ name: "name", type: "text", value: "" },
		{ name: "email", type: "email", value: "" },
		{ name: "message", type: "textarea", value: "" },
		{ name: "consent", type: "checkbox", value: "yes" },
		{ name: "website_url", type: "hidden", value: "" },
		{ name: "topic", type: "select", value: "", options: ["", "Orders", "Other"] },
	];
	it("?product= starts the message; a product/subject field takes it when there is one", () => {
		expect(prefillPlan(new URLSearchParams("product=Blue Mug"), fields)).toEqual({ message: "I'm interested in: Blue Mug\n\n" });
		expect(prefillPlan(new URLSearchParams("product=Blue Mug"), [...fields, { name: "subject", type: "text", value: "" }])).toEqual({ subject: "Blue Mug" });
	});
	it("same-name text fields only: never hidden, checkbox, a filled field or a select value it does not offer", () => {
		expect(prefillPlan(new URLSearchParams("name=Ana&consent=no&website_url=x&topic=Orders&email=a%40b.example"), fields)).toEqual({ name: "Ana", topic: "Orders", email: "a@b.example" });
		expect(prefillPlan(new URLSearchParams("topic=Spam"), fields)).toEqual({});
		expect(prefillPlan(new URLSearchParams("name=Ana"), [{ name: "name", type: "text", value: "Bo" }])).toEqual({});
		expect(prefillPlan(new URLSearchParams(`name=${"x".repeat(300)}%07`), fields).name?.length).toBe(200);
	});
});
