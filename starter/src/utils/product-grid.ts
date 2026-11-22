/**
 * The product grid section (WooCommerce catalogue mode, kit.config `shop`; components/sections/ProductGrid.astro):
 * which products a block value asks for, how they are ordered and filtered, the button label and the ItemList structured
 * data. The section reads the products collection server-side when the page renders, so a cached page is the same for
 * every visitor; pages carry the products collection's cache tag (utils/cache.ts), so publishing a product refreshes
 * every page with a grid.
 *
 * No imports here: this file must load in Node (kit, tests) and in the Worker (starter).
 */

export type ProductGridSource = "latest" | "on_sale" | "category" | "handpicked";

export interface ProductGridPlan {
	source: ProductGridSource;
	count: number;
	columns?: number;
	showPrice: boolean;
	/** The editor's own label; empty = each product's Buy wording, else "View product". */
	buttonLabel?: string;
	/** Product category slugs (source "category"). */
	categories: string[];
	/** Entry slugs (their WordPress path, e.g. `product/blue-mug`) in the editor's order (source "handpicked"). */
	slugs: string[];
}

const SOURCES = new Set<ProductGridSource>(["latest", "on_sale", "category", "handpicked"]);
const list = (v: unknown) =>
	String(v ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);

/**
 * A product named by the editor → its entry slug: an address (`/product/blue-mug/`, or the full URL) is its path; a bare
 * slug (`blue-mug`) is looked up under the products' address prefix (`base`, e.g. `/product/`).
 */
export function productSlug(input: string, base = "/product/"): string | undefined {
	let s = input.trim();
	if (/^https?:\/\//i.test(s)) {
		try {
			s = new URL(s).pathname;
		} catch {
			return undefined;
		}
	}
	const path = s.replace(/[?#].*$/, "").replace(/^\/+|\/+$/g, "");
	if (!path || !/^[\w%.~-]+(?:\/[\w%.~-]+)*$/.test(path) || path.split("/").some((seg) => /^\.+$/.test(seg))) return undefined;
	if (path.includes("/") || s.startsWith("/")) return path;
	const prefix = base.replace(/^\/+|\/+$/g, "");
	return prefix ? `${prefix}/${path}` : path;
}

/** What a product grid block value asks for (invalid values fall back to the defaults: 4 newest products). */
export function productGridPlan(v: Record<string, unknown>, base = "/product/"): ProductGridPlan {
	const source = SOURCES.has(v.source as ProductGridSource) ? (v.source as ProductGridSource) : "latest";
	const count = Number.isInteger(v.count) && (v.count as number) >= 1 && (v.count as number) <= 12 ? (v.count as number) : 4;
	const columns = Number.isInteger(v.columns) && (v.columns as number) >= 1 && (v.columns as number) <= 6 ? (v.columns as number) : undefined;
	const label = typeof v.button_label === "string" && v.button_label.trim() ? v.button_label.trim() : undefined;
	return {
		source,
		count,
		...(columns ? { columns } : {}),
		showPrice: v.show_price !== false,
		...(label ? { buttonLabel: label } : {}),
		categories: list(v.categories),
		slugs: [...new Set(list(v.products).flatMap((p) => productSlug(p, base) ?? []))],
	};
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** On sale: a sale price below the regular price (a variable product: one of its options is). */
export function isOnSale(d: { price?: number | null; sale_price?: number | null; variations?: { price?: number | null; sale_price?: number | null }[] | null }): boolean {
	if (isNum(d.price) && isNum(d.sale_price) && d.sale_price < d.price) return true;
	return (d.variations ?? []).some((x) => isNum(x.price) && isNum(x.sale_price) && x.sale_price < x.price);
}

/** Hand-picked products in the editor's order (entries carry their slug in `data.slug`, else `id`). */
export function orderBySlugs<T extends { id: string; data: Record<string, unknown> }>(entries: T[], slugs: string[]): T[] {
	const at = new Map(slugs.map((s, i) => [s, i]));
	const key = (e: T) => String(e.data.slug ?? e.id).replace(/^\/+|\/+$/g, "");
	return entries.filter((e) => at.has(key(e))).sort((a, b) => (at.get(key(a)) ?? 0) - (at.get(key(b)) ?? 0));
}

/** The card's button: the editor's label, else the product's own Buy wording (`buy_label`), else "View product". */
export function gridButtonLabel(plan: Pick<ProductGridPlan, "buttonLabel">, d: { buy_label?: string | null }): string {
	return plan.buttonLabel ?? (typeof d.buy_label === "string" && d.buy_label.trim() ? d.buy_label.trim() : "View product");
}

/**
 * schema.org ItemList of the grid's product pages (URLs only: each product page has its own Product + Offer, which is
 * not repeated here). Undefined for an empty grid.
 */
export function productItemList(urls: string[]): Record<string, unknown> | undefined {
	if (!urls.length) return undefined;
	return { "@context": "https://schema.org", "@type": "ItemList", itemListElement: urls.map((url, i) => ({ "@type": "ListItem", position: i + 1, url })) };
}
