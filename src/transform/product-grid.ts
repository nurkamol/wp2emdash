/**
 * Product grid sections after the adapters (src/adapters/woocommerce.ts made them from WooCommerce blocks, shortcodes and
 * builder elements): on a catalogue-mode shop (kit.config `shop`) WordPress product ids become the products' addresses
 * and "featured products" the hand-picked list of the products featured on WordPress; on any other site the grid has no
 * products collection to list, so it is taken out and reported as unmapped content (the transform gate stops on it).
 */
import type { Diagnostic, IrPage, Section } from "../ir/schema.js";

type Grid = Extract<Section, { type: "product_grid" }>;

export interface ProductGridContext {
	/** kit.config `shop` is set (catalogue mode). */
	shop: boolean;
	/** A published product's address on the new site (its WordPress path), by WordPress id. */
	productPath(id: number): string | undefined;
	/** WordPress ids of the published products featured on WordPress (product_visibility "featured"), newest first. */
	featuredIds(): number[];
}

const slugOf = (path: string) => path.replace(/^\/+|\/+$/g, "");
const label = (g: Grid) => (g.fields.featured ? "featured products" : { latest: "newest products", on_sale: "products on sale", category: `products of ${g.fields.categories.join(", ") || "a category"}`, handpicked: "hand-picked products" }[g.fields.source]);

/** The document with its product grids resolved (shop) or taken out and reported (no shop). */
export function finishProductGrids(doc: IrPage, ctx: ProductGridContext): IrPage {
	if (!doc.sections.some((s) => s.type === "product_grid")) return doc;
	const diagnostics: Diagnostic[] = [];
	const sections: Section[] = [];
	for (const s of doc.sections) {
		if (s.type !== "product_grid") {
			sections.push(s);
			continue;
		}
		const path = s.sourceRef.path;
		if (!ctx.shop) {
			diagnostics.push({ level: "error", code: "unmapped", message: `WooCommerce product grid (${label(s)}), but the new site has no shop: product grids need WooCommerce catalogue mode (kit.config shop) — set it, or remove the grid on WordPress or decide in overrides.ts`, path, carriesContent: true, tag: "product_grid" });
			continue;
		}
		const ids = s.fields.featured ? ctx.featuredIds().slice(0, s.fields.count) : s.fields.productIds;
		const found = ids.flatMap((id) => {
			const p = ctx.productPath(id);
			return p ? [slugOf(p)] : [];
		});
		const missing = ids.filter((id) => !ctx.productPath(id));
		if (missing.length) diagnostics.push({ level: "warn", code: "lossy", message: `product grid: product ${missing.map((id) => `#${id}`).join(", ")} not found among the published products — left out of the grid`, path, tag: "product_grid" });
		const handpicked = s.fields.source === "handpicked";
		if (handpicked && !found.length && !s.fields.products.length) diagnostics.push({ level: "error", code: "unmapped", message: `product grid of ${label(s)}: none of its products is published on the new site — the grid would be empty (choose its products in the editor, or remove it)`, path, carriesContent: true, tag: "product_grid" });
		const { featured: _f, ...fields } = s.fields;
		sections.push({ ...s, fields: { ...fields, products: [...new Set([...s.fields.products, ...found])], productIds: [] } });
	}
	return { ...doc, sections, diagnostics: [...doc.diagnostics, ...diagnostics] };
}
