/**
 * WooCommerce catalogue mode (kit.config `shop`; src/transform/shop.ts): how a product's price, Buy button and Product
 * structured data come out of its entry in the `products` collection. No cart, no checkout on this site: the Buy button
 * goes to the entry's `buy_url` (an external checkout or a Stripe Payment Link) or to the contact form with the
 * product's name prefilled (`?product=`; @wp2emdash/forms/prefill fills it in).
 *
 * No imports here: this file must load in Node (kit, tests) and in the Worker (starter).
 */

export interface ShopSettings {
	checkout: "external" | "stripe-payment-links" | "contact";
	currency?: string;
	contactPath?: string;
}

/** The product fields this file reads (entry.data of the products collection). */
export interface ProductData {
	title?: string;
	product_type?: string;
	price?: number | null;
	sale_price?: number | null;
	currency?: string | null;
	sku?: string | null;
	stock_status?: string | null;
	variations?: { name?: string; sku?: string; price?: number | null; sale_price?: number | null; stock_status?: string }[] | null;
	buy_url?: string | null;
	buy_label?: string | null;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** A price in the shop's currency, the visitor's way of writing it (`$19.99`, `19,99 €`). */
export function formatPrice(value: number, currency: string | undefined, lang = "en"): string {
	try {
		return currency ? new Intl.NumberFormat(lang, { style: "currency", currency }).format(value) : new Intl.NumberFormat(lang, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
	} catch {
		return `${value.toFixed(2)}${currency ? ` ${currency}` : ""}`;
	}
}

export interface PriceView {
	/** What the product costs now (the sale price while there is one). */
	current: string;
	/** The regular price, struck through, while on sale. */
	regular?: string;
	/** Variable products: "from" the lowest variation price. */
	from: boolean;
	/** Variable products whose variations cost different amounts: the highest, shown as a range (`$30.00 – $45.00`) as WooCommerce does. */
	max?: string;
	onSale: boolean;
}

/** The price line of a product card or page; undefined when the product has no price (an editor never set one). */
export function priceView(d: ProductData, shop: ShopSettings, lang = "en"): PriceView | undefined {
	const currency = d.currency || shop.currency;
	const variable = d.product_type === "variable";
	if (!isNum(d.price)) return undefined;
	const onSale = !variable && isNum(d.sale_price) && d.sale_price < d.price;
	const prices = variable ? (d.variations ?? []).map((v) => (isNum(v.sale_price) ? v.sale_price : v.price)).filter(isNum) : [];
	const from = variable && new Set(prices).size > 1;
	const top = from ? Math.max(...prices) : undefined;
	return { current: formatPrice(onSale ? (d.sale_price as number) : d.price, currency, lang), ...(onSale ? { regular: formatPrice(d.price, currency, lang) } : {}), from, ...(top !== undefined && top > d.price ? { max: formatPrice(top, currency, lang) } : {}), onSale };
}

const safeHref = (s: string | null | undefined): string | undefined => {
	const v = (s ?? "").trim();
	return /^(https?:\/\/|\/(?!\/)|mailto:|tel:)/i.test(v) ? v : undefined;
};

export interface BuyButton {
	label: string;
	/** Where it goes; undefined = shown as a disabled button (out of stock). */
	href?: string;
	/** Leaves the site (external checkout, Stripe Payment Link). */
	external: boolean;
}

/**
 * The Buy button: out of stock → a disabled "Out of stock"; checkout "contact" (or a product without a `buy_url` when
 * the site has a contact page) → the contact form with `?product=<title>`; else the product's `buy_url` (an external/
 * affiliate product always keeps its own link). Undefined =
 * no button (no link set yet and no contact page).
 */
export function buyButton(d: ProductData, shop: ShopSettings, title = d.title ?? ""): BuyButton | undefined {
	if (d.stock_status === "outofstock") return { label: "Out of stock", external: false };
	const own = safeHref(d.buy_url);
	const contact = shop.contactPath ? `${shop.contactPath}${shop.contactPath.includes("?") ? "&" : "?"}product=${encodeURIComponent(title)}` : undefined;
	if (own && (shop.checkout !== "contact" || d.product_type === "external")) return { label: d.buy_label?.trim() || "Buy", href: own, external: /^https?:\/\//i.test(own) };
	if (contact) return { label: (shop.checkout === "contact" ? d.buy_label?.trim() : undefined) || "Enquire", href: contact, external: false };
	return undefined;
}

const AVAILABILITY: Record<string, string> = { instock: "https://schema.org/InStock", outofstock: "https://schema.org/OutOfStock", onbackorder: "https://schema.org/BackOrder" };

/**
 * schema.org Product with its Offer (simple products) or AggregateOffer (variable products: lowest and highest
 * variation price), joined to the page's WebPage node. No price → no offer (Google needs one to show a price).
 */
export function productJsonLd(d: ProductData, shop: ShopSettings, page: { canonical: string; title: string; description?: string | null; images: string[] }): Record<string, unknown> {
	const currency = d.currency || shop.currency;
	const availability = AVAILABILITY[d.stock_status ?? "instock"] ?? AVAILABILITY.instock;
	const vprices = (d.variations ?? []).map((v) => (isNum(v.sale_price) ? v.sale_price : v.price)).filter(isNum);
	const onSale = isNum(d.price) && isNum(d.sale_price) && d.sale_price < d.price;
	const price = onSale ? d.sale_price : d.price;
	const offers = !currency
		? undefined
		: d.product_type === "variable" && vprices.length
			? { "@type": "AggregateOffer", lowPrice: Math.min(...vprices), highPrice: Math.max(...vprices), offerCount: vprices.length, priceCurrency: currency, availability, url: page.canonical }
			: isNum(price)
				? { "@type": "Offer", price, priceCurrency: currency, availability, url: page.canonical }
				: undefined;
	return {
		"@type": "Product",
		"@id": `${page.canonical}#product`,
		name: page.title,
		url: page.canonical,
		...(page.description ? { description: page.description } : {}),
		...(d.sku ? { sku: d.sku } : {}),
		...(page.images.length ? { image: page.images } : {}),
		mainEntityOfPage: { "@id": `${page.canonical}#webpage` },
		...(offers ? { offers } : {}),
	};
}

/** Field slugs the product template shows itself (the generic entry template leaves them out). */
export const PRODUCT_FIELDS = new Set(["product_type", "price", "sale_price", "currency", "sku", "stock_status", "short_description", "gallery", "attributes", "variations", "buy_url", "buy_label"]);

export const availabilityLabel = (s: string | null | undefined): string => (s === "outofstock" ? "Out of stock" : s === "onbackorder" ? "On backorder" : "In stock");
