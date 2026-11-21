/**
 * WooCommerce in the audit (public site only, no credentials): what the shop holds, read from WooCommerce's public
 * Store API (`/wp-json/wc/store/v1/products`, the API the cart and product blocks use; no key needed). It lists the
 * published, visible products with their type, prices, currency, stock and review counts, and the total in
 * `X-WP-Total`. The extract later reads every product (src/transform/shop.ts exporterFacts) and the transform gate
 * re-checks with those.
 */
import { emptyFacts, extensionsOf, type ShopFacts } from "../transform/shop.js";

/** One product as the Store API returns it (the fields read here). */
export interface StoreApiProduct {
	id: number;
	type?: string;
	on_sale?: boolean;
	is_in_stock?: boolean;
	is_on_backorder?: boolean;
	low_stock_remaining?: number | null;
	review_count?: number;
	variations?: unknown[];
	attributes?: { name?: string; taxonomy?: string | null }[];
	prices?: { currency_code?: string };
}

export function storeApiFacts(items: StoreApiProduct[], total: number | undefined, pluginSlugs: string[]): ShopFacts {
	const f = emptyFacts("store-api");
	const attributes = new Set<string>();
	f.products = Math.max(total ?? 0, items.length);
	f.published = f.products;
	for (const p of items) {
		const t = p.type || "simple";
		f.types[t] = (f.types[t] ?? 0) + 1;
		f.variations += Array.isArray(p.variations) ? p.variations.length : 0;
		if (p.on_sale) f.onSale++;
		if (p.is_in_stock === false || p.is_on_backorder) f.outOfStock++;
		// The Store API shows a stock figure only for products that track stock (and only when it runs low).
		if (typeof p.low_stock_remaining === "number") f.stockManaged++;
		f.reviews += Number(p.review_count) || 0;
		for (const a of p.attributes ?? []) attributes.add(a.taxonomy || a.name || "");
		f.currency ??= p.prices?.currency_code || undefined;
	}
	attributes.delete("");
	f.attributes = attributes.size;
	f.types = Object.fromEntries(Object.entries(f.types).sort());
	f.plugins = extensionsOf(pluginSlugs);
	if (!f.currency) delete f.currency;
	return f;
}

type Fetch = (url: string) => Promise<{ status: number; body: string; headers: Record<string, string> }>;

/** Read the Store API page by page (100 per page, at most `maxPages`); `none` when it does not answer. */
export async function readStoreApi(origin: string, fetchFn: Fetch, pluginSlugs: string[], maxPages = 30): Promise<ShopFacts> {
	const items: StoreApiProduct[] = [];
	let total: number | undefined;
	for (let page = 1; page <= maxPages; page++) {
		const r = await fetchFn(`${origin}/wp-json/wc/store/v1/products?per_page=100&page=${page}`).catch(() => undefined);
		if (!r || r.status !== 200) break;
		let rows: unknown;
		try {
			rows = JSON.parse(r.body);
		} catch {
			break;
		}
		if (!Array.isArray(rows)) break;
		total ??= Number(r.headers["x-wp-total"]) || undefined;
		items.push(...(rows as StoreApiProduct[]));
		const pages = Number(r.headers["x-wp-totalpages"]) || 0;
		if (rows.length < 100 || (pages && page >= pages)) break;
	}
	if (!items.length && total === undefined) return { ...emptyFacts("none"), plugins: extensionsOf(pluginSlugs) };
	return storeApiFacts(items, total, pluginSlugs);
}
