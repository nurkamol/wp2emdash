/**
 * WooCommerce product grids on ordinary pages → the product grid section (PLAN §8b, catalogue mode): Gutenberg
 * WooCommerce blocks, the WooCommerce shortcodes (also as WPBakery elements and in Elementor's shortcode widget),
 * Salient's WooCommerce products element and Elementor Pro's Products widget. What the section cannot do (best sellers,
 * top rated, attribute or tag filters, pagination, the shop's sorting) is reported: a grid it cannot rebuild becomes an
 * unmapped error (it shows the shop's content), a detail it leaves out a lossy note. Nothing is dropped silently.
 *
 * The fragments carry WordPress product and term ids where the source has them; the transform resolves product ids to
 * the products' addresses and featured products to a hand-picked list, and reports the grid on a site without catalogue
 * mode (src/transform/product-grid.ts).
 */
import type { Diagnostic } from "../ir/schema.js";
import type { Fragment } from "./wpbakery/elements.js";

type Products = Extract<Fragment, { kind: "products" }>;
type Note = (level: Diagnostic["level"], message: string, unmapped?: boolean) => void;

/** At most this many products in a grid (the section's limit). */
export const GRID_MAX = 12;

const ids = (v: unknown): number[] => {
	const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : typeof v === "number" ? [v] : [];
	return [...new Set(list.map((x) => (typeof x === "object" && x ? Number((x as { id?: unknown }).id) : Number(String(x).trim()))).filter((n) => Number.isInteger(n) && n > 0))];
};
const slugs = (v: string | undefined) => [...new Set((v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter((s) => /^[a-z0-9_%-]+$/.test(s)))];
const int = (v: unknown): number | undefined => {
	const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : Number.NaN;
	return Number.isFinite(n) ? Math.round(n) : undefined;
};
const yes = (v: string | undefined) => /^(?:1|true|yes)$/i.test((v ?? "").trim());

/** How many products: WooCommerce's number (or "all") within the section's 1–12. */
function countOf(given: number | undefined, fallback: number, note: Note, what: string): number {
	const n = given === undefined || given === 0 ? fallback : given;
	if (n < 0) {
		note("warn", `${what}: every product (${given === undefined ? "WooCommerce's default" : "limit -1"}) — the grid shows at most ${GRID_MAX}`);
		return GRID_MAX;
	}
	if (n > GRID_MAX) note("warn", `${what}: ${n} products asked for — the grid shows at most ${GRID_MAX}`);
	return Math.max(1, Math.min(GRID_MAX, n));
}
const columnsOf = (n: number | undefined) => (n && n >= 1 ? { columns: Math.min(6, n) } : {});

// ── Shortcodes ───────────────────────────────────────────────────────────────

/** WooCommerce shortcodes that list products: mapped to a grid. */
export const WOO_GRID_SHORTCODES = new Set(["products", "featured_products", "sale_products", "recent_products", "product_category"]);
/** WooCommerce listing shortcodes the grid cannot rebuild: reported (they show the shop's content). */
const WOO_REPORTED_SHORTCODES: Record<string, string> = {
	best_selling_products: "best sellers (sales figures are not migrated)",
	top_rated_products: "top rated products (reviews are not migrated)",
	product_attribute: "products by attribute (attributes are product fields, not filters)",
	product_categories: "a list of product categories (the category pages are migrated: link to them)",
	product: "a single product (link to its page instead)",
	product_page: "a whole product page inside this page (link to the product page instead)",
	add_to_cart: "an add-to-cart button (catalogue mode has no cart: the product page's Buy button replaces it)",
	add_to_cart_url: "an add-to-cart link (catalogue mode has no cart)",
};

/**
 * A WooCommerce shortcode → product grid fragments; undefined when the tag is not a WooCommerce listing shortcode.
 * Defaults are WooCommerce's (WC_Shortcodes): [products] every product (limit -1) in 4 columns ordered by title;
 * [recent_products], [sale_products], [featured_products], [product_category] 12 products in 4 columns.
 */
export function wooShortcode(tag: string, attrs: Record<string, string>, diag: (d: Diagnostic) => void, path: string): Fragment[] | undefined {
	const note: Note = (level, message, unmapped = false) => diag({ level, code: unmapped ? "unmapped" : "lossy", message: `shortcode [${tag}]: ${message}`, path, ...(unmapped ? { carriesContent: true } : {}), tag });
	const reported = WOO_REPORTED_SHORTCODES[tag];
	if (reported) {
		note("error", `${reported} — not rebuilt; add a product grid section by hand or decide in overrides.ts`, true);
		return [];
	}
	if (!WOO_GRID_SHORTCODES.has(tag)) return undefined;
	const out = gridShortcode(tag, attrs, note);
	// Named in the coverage report's shortcode table (src/transform/shortcodes.ts) like every other plugin shortcode.
	for (const f of out) if (f.kind === "products") note("info", `product grid (${f.featured ? "featured" : f.source}, ${f.count} products)`);
	return out;
}

function gridShortcode(tag: string, attrs: Record<string, string>, note: Note): Fragment[] {
	const a = attrs;
	const limit = int(a.limit ?? a.per_page);
	const columns = columnsOf(int(a.columns) ?? 4);
	const cats = slugs(a.category);
	const base = { kind: "products" as const, categories: [] as string[], productIds: [] as number[], ...columns };
	const notes: string[] = [];
	if (a.paginate && yes(a.paginate)) notes.push("page numbers (the grid shows one page)");
	if (a.class) notes.push(`CSS class "${a.class}"`);
	const notCarried = (more: string[] = []) => {
		const all = [...notes, ...more];
		if (all.length) note("info", `not carried: ${all.join("; ")}`);
	};
	switch (tag) {
		case "recent_products":
			notCarried(cats.length ? [`the category filter ${cats.join(", ")} (newest products of every category)`] : []);
			return [{ ...base, source: "latest", count: countOf(limit, 12, note, "recent products") }];
		case "sale_products":
			notCarried(orderNote(a, "title"));
			return [{ ...base, source: "on_sale", count: countOf(limit, 12, note, "sale products") }];
		case "featured_products":
			notCarried(orderNote(a, "date"));
			note("info", "featured products become a hand-picked list (the products featured on WordPress today, in WordPress order)");
			return [{ ...base, source: "handpicked", featured: true, count: countOf(limit, 12, note, "featured products") }];
		case "product_category": {
			if (!cats.length) {
				note("error", "no category given — not rebuilt", true);
				return [];
			}
			notCarried([...orderNote(a, "menu_order title"), ...(a.operator && a.operator.toUpperCase() !== "IN" ? [`operator ${a.operator} (products in any of the categories)`] : [])]);
			return [{ ...base, source: "category", categories: cats, count: countOf(limit, 12, note, "product category") }];
		}
		default: {
			// [products]: the filters it combines; the grid has one source.
			if (yes(a.best_selling) || yes(a.top_rated)) {
				note("error", `${yes(a.best_selling) ? "best sellers" : "top rated products"} (sales and reviews are not migrated) — not rebuilt; add a product grid section by hand`, true);
				return [];
			}
			const unsupported = [a.skus ? `skus ${a.skus}` : "", a.tag ? `tag ${a.tag}` : "", a.attribute ? `attribute ${a.attribute}` : ""].filter(Boolean);
			if (unsupported.length && !a.ids) {
				note("error", `filtered by ${unsupported.join(", ")} — the grid lists by newest, sale, category or a hand-picked list: not rebuilt`, true);
				return [];
			}
			const productIds = ids(a.ids);
			const featured = (a.visibility ?? "").toLowerCase() === "featured";
			const extra = [...(unsupported.length ? [`filters ${unsupported.join(", ")}`] : []), ...(a.cat_operator && a.cat_operator.toUpperCase() !== "IN" ? [`cat_operator ${a.cat_operator}`] : [])];
			if (productIds.length) {
				notCarried([...extra, ...(cats.length ? [`the category filter ${cats.join(", ")}`] : []), ...(yes(a.on_sale) ? ["the on-sale filter"] : []), ...((a.orderby ?? "title") !== "post__in" ? [`order ${a.orderby ?? "title"} (the grid keeps the listed order)`] : [])]);
				return [{ ...base, source: "handpicked", productIds, count: countOf(limit, productIds.length, note, "products") }];
			}
			if (featured) {
				notCarried([...extra, ...(cats.length ? [`the category filter ${cats.join(", ")}`] : [])]);
				note("info", "featured products become a hand-picked list (the products featured on WordPress today)");
				return [{ ...base, source: "handpicked", featured: true, count: countOf(limit, -1, note, "products") }];
			}
			if (yes(a.on_sale)) {
				notCarried([...extra, ...(cats.length ? [`the category filter ${cats.join(", ")}`] : []), ...orderNote(a, "title")]);
				return [{ ...base, source: "on_sale", count: countOf(limit, -1, note, "products") }];
			}
			if (cats.length) {
				notCarried([...extra, ...orderNote(a, "title")]);
				return [{ ...base, source: "category", categories: cats, count: countOf(limit, -1, note, "products") }];
			}
			notCarried([...extra, ...orderNote(a, "title")]);
			return [{ ...base, source: "latest", count: countOf(limit, -1, note, "products") }];
		}
	}
}

/** The grid lists newest first (hand-picked: in the editor's order): another WooCommerce order is a lossy note. */
function orderNote(a: Record<string, string>, wooDefault: string): string[] {
	const by = (a.orderby ?? wooDefault).trim().toLowerCase();
	const order = (a.order ?? "").trim().toLowerCase();
	return by === "date" && order !== "asc" ? [] : [`order ${by}${order ? ` ${order}` : ""} (the grid is newest first)`];
}

/** WooCommerce shortcodes this module knows (the coverage report's shortcode registry). */
export const WOO_SHORTCODES = [...WOO_GRID_SHORTCODES, ...Object.keys(WOO_REPORTED_SHORTCODES)];

// ── Gutenberg blocks ─────────────────────────────────────────────────────────

/** WooCommerce product listing blocks: a product grid when they map, else reported. */
export const WOO_GRID_BLOCKS = new Set([
	"woocommerce/handpicked-products",
	"woocommerce/product-category",
	"woocommerce/product-on-sale",
	"woocommerce/product-new",
	"woocommerce/products-by-attribute",
	"woocommerce/product-best-sellers",
	"woocommerce/product-top-rated",
	"woocommerce/product-tag",
	"woocommerce/product-collection",
	"woocommerce/all-products",
]);

interface WooBlock {
	name: string;
	attrs: Record<string, unknown>;
	innerBlocks: WooBlock[];
}

/**
 * A WooCommerce listing block → product grid fragments (block attributes as WooCommerce Blocks saves them: `products`,
 * `categories` (term ids), `columns`, `rows`, `contentVisibility`, `orderby`; the Product Collection block's `query`).
 */
export function wooBlock(b: WooBlock, diag: (d: Diagnostic) => void, path: string, termSlug?: (taxonomy: string, id: number) => string | undefined): Fragment[] {
	const a = b.attrs;
	const note: Note = (level, message, unmapped = false) => diag({ level, code: unmapped ? "unmapped" : "lossy", message: `${b.name}: ${message}`, path, ...(unmapped ? { carriesContent: true } : {}), tag: b.name });
	const report = (why: string) => {
		note("error", `${why} — not rebuilt; add a product grid section by hand or decide in overrides.ts`, true);
		return [];
	};
	const vis = (a.contentVisibility ?? {}) as Record<string, unknown>;
	const showPrice = vis.price !== false;
	const hidden = ["image", "title", "rating", "button"].filter((k) => vis[k] === false);
	const columns = columnsOf(int(a.columns) ?? 3);
	const count = (fallback: number) => countOf(int(a.columns) && int(a.rows) ? (int(a.columns) as number) * (int(a.rows) as number) : undefined, fallback, note, "grid");
	const categories = (raw: unknown): string[] => {
		const list = ids(raw);
		const found = list.flatMap((id) => termSlug?.("product_cat", id) ?? []);
		const missing = list.filter((id) => !termSlug?.("product_cat", id));
		if (missing.length) note("warn", `product category ${missing.map((id) => `#${id}`).join(", ")} not found in the extract — left out of the grid`);
		return found;
	};
	const common = (more: string[] = []) => {
		const all = [...(hidden.length ? [`card parts hidden on WordPress (${hidden.join(", ")}; the grid's cards show picture, name${showPrice ? ", price" : ""} and a button)`] : []), ...more];
		if (all.length) note("info", `not carried: ${all.join("; ")}`);
	};
	const base = { kind: "products" as const, categories: [] as string[], productIds: [] as number[], ...columns, ...(showPrice ? {} : { showPrice: false }) };
	const order = (wooDefault: string) => {
		const by = String(a.orderby ?? wooDefault);
		return by === "date" ? [] : [`order ${by} (the grid is newest first)`];
	};
	switch (b.name) {
		case "woocommerce/handpicked-products": {
			const productIds = ids(a.products);
			if (!productIds.length) return report("no products chosen");
			common(String(a.orderby ?? "date") !== "date" ? [`order ${String(a.orderby)} (the grid keeps the chosen order)`] : []);
			return [{ ...base, source: "handpicked", productIds, count: Math.min(GRID_MAX, productIds.length) } satisfies Products];
		}
		case "woocommerce/product-category": {
			const cats = categories(a.categories);
			if (!cats.length) return report("no product category found");
			common([...order("date"), ...(a.catOperator === "all" ? ["products in all categories (the grid lists products in any of them)"] : [])]);
			return [{ ...base, source: "category", categories: cats, count: count(9) }];
		}
		case "woocommerce/product-new": {
			// Newest products, optionally of some categories: the grid's category source is newest first too.
			const cats = categories(a.categories);
			common(a.catOperator === "all" && cats.length > 1 ? ["products in all categories (the grid lists products in any of them)"] : []);
			return [{ ...base, source: cats.length ? "category" : "latest", categories: cats, count: count(9) }];
		}
		case "woocommerce/product-on-sale": {
			const cats = ids(a.categories);
			common([...order("date"), ...(cats.length ? ["the category filter (the grid shows products on sale in every category)"] : [])]);
			return [{ ...base, source: "on_sale", count: count(9) }];
		}
		case "woocommerce/products-by-attribute":
			return report("products filtered by attribute (attributes are product fields, not filters)");
		case "woocommerce/product-tag":
			return report("products filtered by tag (the grid lists by category)");
		case "woocommerce/product-best-sellers":
			return report("best sellers (sales figures are not migrated)");
		case "woocommerce/product-top-rated":
			return report("top rated products (reviews are not migrated)");
		case "woocommerce/all-products":
			return report("the whole catalogue with sorting and pages (the shop listing has it: link to it)");
		case "woocommerce/product-collection":
			return productCollection(b, base, note, report, categories);
	}
	return report("unknown WooCommerce listing block");
}

/** The Product Collection block (WooCommerce 8.8+): its collection or query decides the grid's source. */
function productCollection(b: WooBlock, base: Omit<Products, "source" | "count">, note: Note, report: (why: string) => never[], categories: (raw: unknown) => string[]): Fragment[] {
	const q = (b.attrs.query ?? {}) as Record<string, unknown>;
	const collection = String(b.attrs.collection ?? "").replace(/^woocommerce\/product-collection\//, "");
	if (q.inherit === true) return report("lists the products of the archive it is placed on (a shop template, not page content)");
	if (["best-sellers", "top-rated", "related", "upsells", "cross-sells", "by-attribute", "by-tag"].includes(collection)) return report(`the "${collection}" collection`);
	const descendants = (x: WooBlock): WooBlock[] => x.innerBlocks.flatMap((i) => [i, ...descendants(i)]);
	const inner = new Set(descendants(b).map((x) => x.name));
	const showPrice = inner.size ? inner.has("woocommerce/product-price") : true;
	const layout = (b.attrs.displayLayout ?? {}) as { columns?: unknown };
	const cols = int(layout.columns);
	const tax = (q.taxQuery ?? {}) as Record<string, unknown>;
	const attrsFilter = Array.isArray(q.woocommerceAttributes) && q.woocommerceAttributes.length;
	const tagFilter = ids(tax.product_tag).length;
	if (attrsFilter || tagFilter) return report(`products filtered by ${attrsFilter ? "attribute" : "tag"} (the grid lists by newest, sale, category or a hand-picked list)`);
	const notes: string[] = [];
	if (inner.has("core/query-pagination")) notes.push("page numbers (the grid shows one page)");
	const by = String(q.orderBy ?? "date");
	if (by !== "date" || String(q.order ?? "desc") === "asc") notes.push(`order ${by} ${String(q.order ?? "desc")} (the grid is newest first)`);
	if (typeof q.offset === "number" && q.offset > 0) notes.push(`skips the first ${q.offset} product(s)`);
	if (Array.isArray(q.woocommerceStockStatus) && q.woocommerceStockStatus.length && q.woocommerceStockStatus.length < 3) notes.push(`only stock status ${q.woocommerceStockStatus.join(", ")} (the grid shows every product)`);
	const per = int(q.perPage);
	const count = countOf(per, 9, note, "collection");
	const out = { ...base, ...(cols ? { columns: Math.min(6, Math.max(1, cols)) } : {}), ...(showPrice ? {} : { showPrice: false }) };
	const picked = ids(q.woocommerceHandPickedProducts);
	const cats = categories(tax.product_cat);
	const done = (f: Products, more: string[] = []): Fragment[] => {
		if (notes.length || more.length) note("info", `not carried: ${[...notes, ...more].join("; ")}`);
		return [f];
	};
	if (collection === "hand-picked" || picked.length) {
		if (!picked.length) return report("no products chosen");
		return done({ ...out, source: "handpicked", productIds: picked, count: Math.min(GRID_MAX, picked.length) }, cats.length ? ["the category filter"] : []);
	}
	if (collection === "featured" || q.featured === true) {
		note("info", "featured products become a hand-picked list (the products featured on WordPress today)");
		return done({ ...out, source: "handpicked", featured: true, count }, cats.length ? ["the category filter"] : []);
	}
	if (collection === "on-sale" || q.woocommerceOnSale === true) return done({ ...out, source: "on_sale", count }, cats.length ? ["the category filter (the grid shows products on sale in every category)"] : []);
	if (cats.length) return done({ ...out, source: "category", categories: cats, count });
	return done({ ...out, source: "latest", count });
}

// ── Builder elements ─────────────────────────────────────────────────────────

/**
 * Salient's WooCommerce products element (nectar_woo_products): `product_type` all / sale / featured / best_selling,
 * `category` (slugs, "all" = every category), `per_page`, `columns`.
 */
export function salientWooProducts(attrs: Record<string, string>, diag: (d: Diagnostic) => void, path: string): Fragment[] {
	const tag = "nectar_woo_products";
	const note: Note = (level, message, unmapped = false) => diag({ level, code: unmapped ? "unmapped" : "lossy", message: `${tag}: ${message}`, path, ...(unmapped ? { carriesContent: true } : {}), tag });
	const type = (attrs.product_type ?? "all").toLowerCase();
	const cats = slugs(attrs.category).filter((c) => c !== "all");
	const count = countOf(int(attrs.per_page), 12, note, "products");
	const base = { kind: "products" as const, categories: [] as string[], productIds: [] as number[], ...columnsOf(int(attrs.columns) ?? 4) };
	if (attrs.carousel && yes(attrs.carousel)) note("info", "carousel shown as a grid");
	if (type === "best_selling") {
		note("error", "best sellers (sales figures are not migrated) — not rebuilt; add a product grid section by hand", true);
		return [];
	}
	if (type === "featured") {
		note("info", "featured products become a hand-picked list (the products featured on WordPress today)");
		return [{ ...base, source: "handpicked", featured: true, count }];
	}
	if (type === "sale") {
		if (cats.length) note("info", "not carried: the category filter (the grid shows products on sale in every category)");
		return [{ ...base, source: "on_sale", count }];
	}
	return [{ ...base, source: cats.length ? "category" : "latest", categories: cats, count }];
}

/**
 * Elementor Pro's Products widget (woocommerce-products): `query_post_type` product / sale / featured / by_id
 * (`query_posts_ids`), `columns` × `rows`. Category and tag includes use Elementor's term query (term_taxonomy ids):
 * reported, not guessed.
 */
export function elementorWooProducts(s: Record<string, unknown>, diag: (d: Diagnostic) => void, path: string): Fragment[] {
	const tag = "woocommerce-products";
	const note: Note = (level, message, unmapped = false) => diag({ level, code: unmapped ? "unmapped" : "lossy", message: `[${tag}]: ${message}`, path, ...(unmapped ? { carriesContent: true } : {}), tag });
	const type = String(s.query_post_type ?? "product");
	const columns = int(s.columns) ?? 4;
	const rows = int(s.rows) ?? 4;
	const count = countOf(columns * rows, 12, note, "products");
	const base = { kind: "products" as const, categories: [] as string[], productIds: [] as number[], ...columnsOf(columns) };
	const include = Array.isArray(s.query_include) ? (s.query_include as unknown[]).map(String) : [];
	if (type === "current_query") {
		note("error", "lists the products of the archive it is placed on (a shop template, not page content) — not rebuilt", true);
		return [];
	}
	const notes = [...(s.paginate === "yes" ? ["page numbers"] : []), ...(s.orderby && s.orderby !== "date" ? [`order ${String(s.orderby)} (the grid is newest first)`] : [])];
	if (type === "by_id") {
		const productIds = ids(s.query_posts_ids);
		if (!productIds.length) {
			note("error", "no products chosen — not rebuilt", true);
			return [];
		}
		if (notes.length) note("info", `not carried: ${notes.join("; ")}`);
		return [{ ...base, source: "handpicked", productIds, count: Math.min(GRID_MAX, productIds.length) }];
	}
	if (include.includes("terms")) {
		note("error", "products of chosen categories or tags (Elementor's term query) — not rebuilt; add a product grid with the category slugs by hand", true);
		return [];
	}
	if (notes.length) note("info", `not carried: ${notes.join("; ")}`);
	if (type === "featured") {
		note("info", "featured products become a hand-picked list (the products featured on WordPress today)");
		return [{ ...base, source: "handpicked", featured: true, count }];
	}
	return [{ ...base, source: type === "sale" ? "on_sale" : "latest", count }];
}
