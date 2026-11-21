/**
 * WooCommerce catalogue mode (docs/PLAN.md §8b; kit.config `shop`). Small shops migrate their products as an EmDash
 * collection `products` — product pages at their WordPress addresses, `/shop/` and the category listings, Product
 * structured data — with no cart, checkout or customer accounts on the new site. Each product's Buy button goes to an
 * external checkout (`buy_url`), a Stripe Payment Link (same field) or the contact form with the product prefilled.
 *
 * Shared by the audit (facts from WooCommerce's public Store API: src/audit/shop.ts) and the transform (facts from the
 * Exporter's product posts). Everything catalogue mode cannot do is a listed decision, never dropped in silence;
 * shops above `maxProducts`, or with subscriptions or memberships, keep stopping.
 *
 * Pure functions. Product field values go through the CPT mapper (src/transform/cpt.ts) as `woo:<field>` meta keys
 * this module computes from WooCommerce's own meta (`_regular_price`, `_sale_price`, `_price`, `_sku`,
 * `_product_image_gallery`, `_product_attributes`, `_product_url`, `_button_text`, `_stock_status`) and the
 * `product_variation` children (`attribute_*` meta, prices). Verified shapes: docs/spikes/shop-findings.md.
 */
import { isPhpSerialized, phpUnserialize } from "../extract/php-unserialize.js";
import type { CptField } from "./cpt-fields.js";

export type ShopCheckout = "external" | "stripe-payment-links" | "contact";
export interface ShopConfig {
	mode: "catalogue";
	checkout: ShopCheckout;
	currency?: string;
	contactPath?: string;
	maxProducts: number;
}

/** What the shop holds, as far as the source tells (the audit's public Store API sees less than the Exporter). */
export interface ShopFacts {
	source: "store-api" | "exporter" | "none";
	/** Products the source lists (Store API: published and visible; Exporter: every status). */
	products: number;
	published: number;
	/** WooCommerce product types: simple, variable, external, grouped, subscription, variable-subscription, booking… */
	types: Record<string, number>;
	variations: number;
	onSale: number;
	/** Sales with dates that were not running when the shop was read. */
	scheduledSales: number;
	downloadable: number;
	virtual: number;
	/** Products with stock tracking (`_manage_stock`), and out of stock / on backorder. */
	stockManaged: number;
	outOfStock: number;
	reviews: number;
	/** Coupons (undefined: the source does not tell). */
	coupons?: number;
	/** Distinct product attributes (Color, Size…). */
	attributes: number;
	/** Hidden from the catalogue and search (WooCommerce catalogue visibility "hidden"). */
	hidden: number;
	currency?: string;
	/** WooCommerce extensions seen on the site (audit fingerprint: plugin folders in the page assets). */
	plugins: { subscriptions: boolean; memberships: boolean; bookings: boolean };
}

export const emptyFacts = (source: ShopFacts["source"] = "none"): ShopFacts => ({ source, products: 0, published: 0, types: {}, variations: 0, onSale: 0, scheduledSales: 0, downloadable: 0, virtual: 0, stockManaged: 0, outOfStock: 0, reviews: 0, attributes: 0, hidden: 0, plugins: { subscriptions: false, memberships: false, bookings: false } });

/** WooCommerce extensions by plugin folder (audit fingerprint slugs). */
export const WOO_EXTENSIONS: Record<keyof ShopFacts["plugins"], string[]> = {
	subscriptions: ["woocommerce-subscriptions", "woocommerce-subscriptions-core", "yith-woocommerce-subscription", "subscriptions-for-woocommerce"],
	memberships: ["woocommerce-memberships", "yith-woocommerce-membership", "memberships-for-woocommerce"],
	bookings: ["woocommerce-bookings", "woocommerce-appointments", "yith-woocommerce-booking"],
};

export function extensionsOf(pluginSlugs: string[]): ShopFacts["plugins"] {
	const has = (k: keyof ShopFacts["plugins"]) => pluginSlugs.some((s) => WOO_EXTENSIONS[k].includes(s));
	return { subscriptions: has("subscriptions"), memberships: has("memberships"), bookings: has("bookings") };
}

/** The product types catalogue mode shows as they are; anything else is listed as a decision. */
const CATALOGUE_TYPES = new Set(["simple", "variable", "external", "grouped"]);

/** Reasons the shop cannot run in catalogue mode at all (the gate stays red, whatever the owner sets). */
export function shopBlockers(f: ShopFacts, maxProducts: number): string[] {
	const out: string[] = [];
	if (f.products > maxProducts) out.push(`${f.products} products: catalogue mode is for small shops (shop.maxProducts ${maxProducts}); a shop this size needs a real store`);
	const subs = (f.types.subscription ?? 0) + (f.types["variable-subscription"] ?? 0);
	if (subs || f.plugins.subscriptions) out.push(`subscriptions${subs ? ` (${subs} subscription product${subs === 1 ? "" : "s"})` : " (WooCommerce Subscriptions is active)"}: recurring billing and renewals need a store`);
	if (f.plugins.memberships) out.push("memberships (a membership plugin is active): members-only content and accounts need a store");
	return out;
}

export interface ShopDecision {
	id: string;
	label: string;
	/** How many products (or items) it concerns; undefined = applies to the shop as a whole. */
	count?: number;
	/** What catalogue mode does with it. */
	outcome: string;
}

/**
 * Everything catalogue mode does differently from WooCommerce, for the owner to read before setting `shop.mode`.
 * The shop-wide items (cart, checkout, accounts, orders, coupons) are always listed; the rest when the shop has them.
 */
export function shopDecisions(f: ShopFacts, checkout: ShopCheckout | undefined): ShopDecision[] {
	const buy = checkout === "contact" ? "a link to the contact form with the product's name prefilled" : checkout === "stripe-payment-links" ? "the product's Stripe Payment Link (field `buy_url`, filled in per product)" : "the product's external checkout link (field `buy_url`, filled in per product)";
	const out: ShopDecision[] = [
		{ id: "cart-checkout", label: "Cart and checkout", outcome: `not rebuilt: each product's Buy button is ${buy}; /cart/ and /checkout/ answer 301 → the shop listing` },
		{ id: "accounts", label: "Customer accounts (my-account, login, registration)", outcome: "not rebuilt: /my-account/ and its sub-pages answer 301 → the shop listing; customers and their addresses are never migrated" },
		{ id: "orders", label: "Orders, refunds, customers, store statistics", outcome: "never migrated (customer data stays in WordPress; export it there before it is switched off)" },
		{ id: "coupons", label: "Coupons", ...(f.coupons !== undefined ? { count: f.coupons } : {}), outcome: "not carried: apply discounts in the external checkout (Stripe Payment Links can take promotion codes)" },
		{ id: "payments-tax-shipping", label: "Payment gateways, tax and shipping settings", outcome: "not carried: they belong to the checkout the Buy button goes to" },
	];
	const add = (id: string, label: string, count: number, outcome: string) => count > 0 && out.push({ id, label, count, outcome });
	add("variable", "Variable products", f.types.variable ?? 0, `shown with their price range ("from" the lowest price) and a table of their ${f.variations || ""} variation${f.variations === 1 ? "" : "s"} (options, SKU, price, stock); the buyer picks the option at the checkout`.replace("  ", " "));
	add("grouped", "Grouped products", f.types.grouped ?? 0, "shown as a product page of their own; the grouped children are separate product pages (no combined add-to-cart)");
	add("external", "External / affiliate products", f.types.external ?? 0, "kept as they are: the Buy button links to WordPress's product URL with its button text");
	const other = Object.entries(f.types).filter(([t, n]) => n > 0 && !CATALOGUE_TYPES.has(t) && t !== "subscription" && t !== "variable-subscription");
	for (const [t, n] of other) add(`type-${t}`, `"${t}" products`, n, t === "booking" ? "shown as product pages with their price; bookings (dates, availability, resources) are not rebuilt: link the Buy button to the booking system" : "shown as product pages with their price; the type's own behaviour (a plugin's) is not rebuilt");
	if (f.plugins.bookings && !f.types.booking) out.push({ id: "bookings", label: "Bookings extension", outcome: "bookings (dates, availability, resources) are not rebuilt: link the Buy button to the booking system" });
	add("downloads", "Digital downloads", f.downloadable, "the files are not delivered by the new site: the external checkout must deliver them (the download files are not published on the site)");
	add("virtual", "Virtual products (no shipping)", f.virtual, "shown like any product");
	add("stock", "Stock tracking", f.stockManaged, "stock levels are not shown or counted; each product keeps its availability (in stock / out of stock / on backorder) as an editable field, also in the structured data");
	add("out-of-stock", "Out-of-stock or backorder products", f.outOfStock, "migrated with their availability; the Buy button reads \"Out of stock\" and is not a link");
	add("sales", "Products on sale", f.onSale, "regular and sale price both shown (the sale price is an editable field: clear it to end the sale)");
	add("scheduled-sales", "Scheduled sales", f.scheduledSales, "sale dates are not carried (EmDash has no scheduled prices): a sale that was not running when the shop was read is left out, its price noted in the coverage report");
	add("reviews", "Product reviews and star ratings", f.reviews, "not migrated as reviews: no star ratings or review structured data on the new site (reviews the Exporter returned as comments follow the comments decision)");
	add("attributes", "Product attributes", f.attributes, "shown on the product page as a list (name: values); attribute archives (/pa_color/…) are not rebuilt");
	add("hidden", "Hidden products (catalogue visibility \"hidden\")", f.hidden, "migrated and listed like the others (EmDash has no catalogue visibility): unpublish them in the admin if they must stay hidden");
	return out;
}

/** The audit/transform gate: a WooCommerce site passes only with the owner's `shop.mode` and nothing catalogue mode cannot carry. */
export function shopGate(f: ShopFacts, shop: ShopConfig | undefined): { ok: boolean; detail: string } {
	const counts = f.source === "none" ? "product count unknown (the shop's public Store API did not answer; extract counts them)" : `${f.products} product${f.products === 1 ? "" : "s"}${Object.keys(f.types).length ? ` (${Object.entries(f.types).map(([t, n]) => `${n} ${t}`).join(", ")})` : ""}`;
	const blockers = shopBlockers(f, shop?.maxProducts ?? 200);
	if (blockers.length) return { ok: false, detail: `WooCommerce: ${counts}. Out of scope even in catalogue mode: ${blockers.join("; ")}` };
	if (!shop) return { ok: false, detail: `WooCommerce: ${counts}. A shop needs the owner's decision: read the shop report, then set kit.config shop: { mode: "catalogue", checkout: "external" | "stripe-payment-links" | "contact" } (or keep the site out of scope)` };
	const listed = shopDecisions(f, shop.checkout).length;
	return { ok: true, detail: `catalogue mode, checkout "${shop.checkout}": ${counts}; ${listed} decision${listed === 1 ? "" : "s"} listed in the shop report` };
}

export function shopReport(f: ShopFacts, shop: ShopConfig | undefined, title: string): string[] {
	const esc = (s: string) => s.replace(/\|/g, "\\|");
	const L = [title, "", `Source: ${f.source === "store-api" ? "WooCommerce's public Store API (published, visible products only; the extract reads every product)" : f.source === "exporter" ? "the Exporter's product posts and their variations" : "none (the Store API did not answer)"}. Mode: ${shop ? `catalogue, checkout "${shop.checkout}"` : "**not set** (kit.config `shop`)"}.`, ""];
	L.push("| | Count |", "|---|---|");
	L.push(`| Products | ${f.products}${f.source === "exporter" ? ` (${f.published} published)` : ""} |`);
	for (const [t, n] of Object.entries(f.types).sort()) L.push(`| ${esc(t)} | ${n} |`);
	L.push(`| Variations | ${f.variations} |`, `| On sale | ${f.onSale} |`, `| Digital downloads | ${f.downloadable} |`, `| Stock tracking | ${f.stockManaged} |`, `| Out of stock / backorder | ${f.outOfStock} |`, `| Reviews | ${f.reviews} |`, `| Coupons | ${f.coupons ?? "unknown"} |`, `| Currency | ${f.currency ?? "unknown"} |`);
	const ext = Object.entries(f.plugins).filter(([, v]) => v).map(([k]) => k);
	if (ext.length) L.push(`| Extensions | ${ext.join(", ")} |`);
	const blockers = shopBlockers(f, shop?.maxProducts ?? 200);
	if (blockers.length) L.push("", "**Out of scope even in catalogue mode** (the gate stays red):", "", ...blockers.map((b) => `- ${b}`));
	L.push("", "What catalogue mode does with each part of the shop (the owner reads this before setting `shop.mode`):", "", "| Part | Count | In catalogue mode |", "|---|---|---|");
	for (const d of shopDecisions(f, shop?.checkout)) L.push(`| ${esc(d.label)} | ${d.count ?? "—"} | ${esc(d.outcome)} |`);
	return L;
}

// ── Exporter facts ────────────────────────────────────────────────────────────────────────────────────────────

/** A product or variation post as the Exporter returns it (the fields this module reads). */
export interface ProductPost {
	id: number;
	status: string;
	slug: string;
	title: string;
	excerpt: string;
	parent: number | null;
	menu_order: number;
	taxonomies: Record<string, { id: number; name: string; slug: string }[]>;
	meta: Record<string, unknown>;
}

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : Array.isArray(v) && v.length ? str(v[0]) : "");
const num = (v: unknown): number | undefined => {
	const s = str(v).trim();
	if (!s) return undefined;
	const n = Number(s);
	return Number.isFinite(n) ? n : undefined;
};
const yes = (v: unknown) => str(v) === "yes";
const unser = (v: unknown): unknown => {
	if (isPhpSerialized(v)) {
		try {
			return phpUnserialize(v);
		} catch {
			return undefined;
		}
	}
	return v;
};

/** The WooCommerce product type (product_type term), else what the meta says. */
export function productType(p: ProductPost, variations: number): string {
	const t = p.taxonomies?.product_type?.[0]?.slug;
	if (t) return t;
	if (variations) return "variable";
	return str(p.meta?._product_url) ? "external" : "simple";
}

export function hiddenProduct(p: ProductPost): boolean {
	const v = new Set((p.taxonomies?.product_visibility ?? []).map((t) => t.slug));
	return v.has("exclude-from-catalog") && v.has("exclude-from-search");
}

/** A sale that runs now (no dates, or WooCommerce's active `_price` is the sale price) vs one scheduled for later/earlier. */
function saleOf(meta: Record<string, unknown>): { sale?: number; scheduled?: number } {
	const regular = num(meta._regular_price);
	const sale = num(meta._sale_price);
	if (sale === undefined || (regular !== undefined && sale >= regular)) return {};
	const dated = !!(str(meta._sale_price_dates_from) || str(meta._sale_price_dates_to));
	const active = num(meta._price);
	if (dated && active !== sale) return { scheduled: sale };
	return { sale };
}

export function exporterFacts(input: { products: ProductPost[]; variations: ProductPost[]; coupons?: number; currency?: string; plugins: ShopFacts["plugins"] }): ShopFacts {
	const f = emptyFacts("exporter");
	const live = new Set(["publish", "future", "draft", "pending", "private"]);
	const products = input.products.filter((p) => live.has(p.status));
	const kids = new Map<number, ProductPost[]>();
	for (const v of input.variations.filter((x) => live.has(x.status))) kids.set(Number(v.parent), [...(kids.get(Number(v.parent)) ?? []), v]);
	const attributes = new Set<string>();
	f.products = products.length;
	f.published = products.filter((p) => p.status === "publish").length;
	for (const p of products) {
		const vs = kids.get(p.id) ?? [];
		const type = productType(p, vs.length);
		f.types[type] = (f.types[type] ?? 0) + 1;
		f.variations += vs.length;
		const sales = [p, ...vs].map((x) => saleOf(x.meta ?? {}));
		if (sales.some((s) => s.sale !== undefined)) f.onSale++;
		if (sales.some((s) => s.scheduled !== undefined)) f.scheduledSales++;
		if ([p, ...vs].some((x) => yes(x.meta?._downloadable))) f.downloadable++;
		if ([p, ...vs].some((x) => yes(x.meta?._virtual))) f.virtual++;
		if ([p, ...vs].some((x) => yes(x.meta?._manage_stock))) f.stockManaged++;
		if (["outofstock", "onbackorder"].includes(str(p.meta?._stock_status))) f.outOfStock++;
		f.reviews += num(p.meta?._wc_review_count) ?? 0;
		if (hiddenProduct(p)) f.hidden++;
		for (const a of attributeList(p)) attributes.add(a.key);
	}
	f.attributes = attributes.size;
	f.types = Object.fromEntries(Object.entries(f.types).sort());
	if (input.coupons !== undefined) f.coupons = input.coupons;
	if (input.currency) f.currency = input.currency;
	f.plugins = input.plugins;
	return f;
}

// ── Product fields ────────────────────────────────────────────────────────────────────────────────────────────

/** The `products` collection's WooCommerce fields, in the order the admin shows them. Values: `woo:<slug>` meta (productMeta). */
export function productFields(): CptField[] {
	const f = (slug: string, label: string, type: CptField["type"], kind: CptField["kind"], from: string, extra: Partial<CptField> = {}): CptField => ({ slug, label, type, kind, wp: { source: "woocommerce", name: `woo:${slug}`, type: from }, ...extra });
	return [
		f("product_type", "Product type", "select", "select", "product_type", { options: ["simple", "variable", "external", "grouped"], note: "WooCommerce product type (variable: the price is the lowest variation price, shown as \"from\")" }),
		f("price", "Price", "number", "number", "_regular_price", { note: "regular price; variable products: the lowest variation price" }),
		f("sale_price", "Sale price", "number", "number", "_sale_price", { note: "only a sale running when the shop was read (scheduled sales are noted, not carried)" }),
		f("currency", "Currency", "string", "string", "woocommerce_currency", { note: "ISO 4217 code from kit.config shop.currency or WooCommerce's currency option" }),
		f("sku", "SKU", "string", "string", "_sku"),
		f("stock_status", "Availability", "select", "select", "_stock_status", { options: ["instock", "outofstock", "onbackorder"], note: "availability only: stock levels are not tracked" }),
		f("short_description", "Short description", "portableText", "html", "post_excerpt"),
		f("gallery", "Gallery", "repeater", "gallery", "_product_image_gallery", { subFields: [{ slug: "image", label: "Image", type: "image", kind: "image", wpName: "image" }], note: "gallery → repeater of images" }),
		f("attributes", "Attributes", "repeater", "repeater", "_product_attributes", { subFields: [{ slug: "name", label: "Attribute", type: "string", kind: "string", wpName: "name" }, { slug: "value", label: "Values", type: "string", kind: "string", wpName: "value" }] }),
		f("variations", "Variations", "repeater", "repeater", "product_variation", { subFields: [{ slug: "name", label: "Option", type: "string", kind: "string", wpName: "name" }, { slug: "sku", label: "SKU", type: "string", kind: "string", wpName: "sku" }, { slug: "price", label: "Price", type: "number", kind: "number", wpName: "price" }, { slug: "sale_price", label: "Sale price", type: "number", kind: "number", wpName: "sale_price" }, { slug: "stock_status", label: "Availability", type: "string", kind: "string", wpName: "stock_status" }], note: "variations summary: one row per variation (options, SKU, prices, availability)" }),
		f("buy_url", "Buy link", "url", "url", "_product_url", { note: "where the Buy button goes (external checkout or Stripe Payment Link); external products keep WordPress's product URL" }),
		f("buy_label", "Buy button text", "string", "string", "_button_text", { note: "empty = \"Buy\"" }),
	];
}

interface Attr {
	/** `pa_color` (taxonomy attribute) or the sanitized name of a custom one. */
	key: string;
	name: string;
	taxonomy: boolean;
	visible: boolean;
	variation: boolean;
	/** Custom attributes: the values as typed (`A | B`). */
	value: string;
	position: number;
}

/** `_product_attributes` (unserialized by the Exporter, or still PHP-serialized) as a list. */
export function attributeList(p: ProductPost): Attr[] {
	const raw = unser(p.meta?._product_attributes);
	if (!raw || typeof raw !== "object") return [];
	return Object.entries(raw as Record<string, Record<string, unknown>>)
		.map(([key, a]) => ({ key, name: str(a?.name) || key, taxonomy: a?.is_taxonomy === 1 || a?.is_taxonomy === "1" || a?.is_taxonomy === true, visible: !(a?.is_visible === 0 || a?.is_visible === "0" || a?.is_visible === false), variation: a?.is_variation === 1 || a?.is_variation === "1" || a?.is_variation === true, value: str(a?.value), position: num(a?.position) ?? 0 }))
		.sort((x, y) => x.position - y.position || x.key.localeCompare(y.key));
}

export interface ProductContext {
	currency?: string;
	/** Label of an attribute taxonomy (`pa_color` → "Color"). */
	taxonomyLabel: (taxonomy: string) => string | undefined;
	/** Name of a term of an attribute taxonomy by slug (variations store the slug). */
	termName: (taxonomy: string, slug: string) => string | undefined;
}

/** The `woo:<field>` meta of one product (read by the CPT mapper), and what could not be carried. */
export function productMeta(p: ProductPost, variations: ProductPost[], ctx: ProductContext): { meta: Record<string, unknown>; notes: string[] } {
	const m = p.meta ?? {};
	const notes: string[] = [];
	const vs = variations.filter((v) => ["publish", "private"].includes(v.status)).sort((a, b) => a.menu_order - b.menu_order || a.id - b.id);
	const type = productType(p, vs.length);
	const out: Record<string, unknown> = { "woo:product_type": type };
	const attrs = attributeList(p);
	const labelOf = (a: Attr) => (a.taxonomy ? (ctx.taxonomyLabel(a.key) ?? a.name.replace(/^pa_/, "")) : a.name);
	if (type === "variable" || vs.length) {
		const rows = vs.map((v) => {
			const vm = v.meta ?? {};
			const opts = Object.entries(vm)
				.filter(([k]) => k.startsWith("attribute_"))
				.map(([k, val]) => {
					const key = k.slice("attribute_".length);
					const a = attrs.find((x) => x.key === key || x.key === key.replace(/^pa_/, ""));
					const label = a ? labelOf(a) : (ctx.taxonomyLabel(key) ?? key.replace(/^pa_/, ""));
					const value = str(val) ? (key.startsWith("pa_") ? (ctx.termName(key, str(val)) ?? str(val)) : str(val)) : "any";
					return `${label}: ${value}`;
				});
			const s = saleOf(vm);
			if (s.scheduled !== undefined) notes.push(`variation #${v.id}: scheduled sale price ${s.scheduled} not carried`);
			const regular = num(vm._regular_price) ?? num(vm._price);
			return { name: opts.join(", ") || v.title, ...(str(vm._sku) ? { sku: str(vm._sku) } : {}), ...(regular !== undefined ? { price: regular } : {}), ...(s.sale !== undefined ? { sale_price: s.sale } : {}), stock_status: str(vm._stock_status) || "instock" };
		});
		if (rows.length) out["woo:variations"] = rows;
		const prices = vs.map((v) => num(v.meta?._price) ?? num(v.meta?._regular_price)).filter((x): x is number => x !== undefined);
		const low = prices.length ? Math.min(...prices) : num(m._price);
		if (low !== undefined) out["woo:price"] = low;
	} else {
		const regular = num(m._regular_price) ?? num(m._price);
		if (regular !== undefined) out["woo:price"] = regular;
		const s = saleOf(m);
		if (s.sale !== undefined) out["woo:sale_price"] = s.sale;
		if (s.scheduled !== undefined) notes.push(`scheduled sale price ${s.scheduled} not carried (sale dates: EmDash has no scheduled prices)`);
	}
	if (ctx.currency) out["woo:currency"] = ctx.currency;
	if (str(m._sku)) out["woo:sku"] = str(m._sku);
	out["woo:stock_status"] = str(m._stock_status) || "instock";
	if ((p.excerpt ?? "").trim()) out["woo:short_description"] = p.excerpt;
	const gallery = str(m._product_image_gallery)
		.split(",")
		.map((x) => Number(x.trim()))
		.filter((x) => Number.isInteger(x) && x > 0);
	if (gallery.length) out["woo:gallery"] = gallery;
	const attrRows = attrs
		.filter((a) => a.visible)
		.map((a) => {
			const values = a.taxonomy ? (p.taxonomies?.[a.key] ?? []).map((t) => t.name) : a.value.split("|").map((x) => x.trim()).filter(Boolean);
			return { name: labelOf(a), value: values.join(", ") };
		})
		.filter((r) => r.value);
	if (attrRows.length) out["woo:attributes"] = attrRows;
	if (str(m._product_url)) out["woo:buy_url"] = str(m._product_url).trim();
	if (str(m._button_text)) out["woo:buy_label"] = str(m._button_text).trim();
	if (yes(m._downloadable) || vs.some((v) => yes(v.meta?._downloadable))) notes.push("digital download: the files are not delivered by the new site (the external checkout must deliver them)");
	return { meta: out, notes };
}

// ── WooCommerce pages ─────────────────────────────────────────────────────────────────────────────────────────

export type WooPageRole = "shop" | "cart" | "checkout" | "myaccount";

/** WooCommerce's own pages: by the `woocommerce_<role>_page_id` options, else by the shortcode or block they hold. */
export function wooPageRole(p: { id: number; content?: string }, options: Record<string, unknown>): WooPageRole | undefined {
	for (const role of ["shop", "cart", "checkout", "myaccount"] as const) if (Number(options[`woocommerce_${role}_page_id`] ?? 0) === p.id && p.id > 0) return role;
	const c = p.content ?? "";
	if (/\[woocommerce_cart\b|<!--\s*wp:woocommerce\/cart\b/.test(c)) return "cart";
	if (/\[woocommerce_checkout\b|<!--\s*wp:woocommerce\/checkout\b/.test(c)) return "checkout";
	if (/\[woocommerce_my_account\b|<!--\s*wp:woocommerce\/(?:customer-account|my-account)\b/.test(c)) return "myaccount";
	return undefined;
}

/** The kit's products collection: the WordPress `product` type, named `products`. */
export const PRODUCT_TYPE = "product";
export const PRODUCTS_COLLECTION = "products";
/** Taxonomies of products that become EmDash taxonomies with listings (attributes `pa_*` are a field instead). */
export const PRODUCT_TAXONOMIES = new Set(["product_cat", "product_tag", "product_brand"]);
