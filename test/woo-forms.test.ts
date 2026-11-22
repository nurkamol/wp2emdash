import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { extractForms, isContentForm } from "../src/audit/page.js";

const forms = (html: string) => extractForms(cheerio.load(html), html).map((f) => f.provider);

describe("WooCommerce's own forms are not content forms", () => {
	it("recognises add to cart, variations, sorting and cart forms", () => {
		const html = `
			<form class="cart" method="post"><input type="number" name="quantity"><button name="add-to-cart" value="63">Add</button></form>
			<form class="variations_form cart" data-product_id="64"><select name="attribute_size"><option>S</option></select><input type="hidden" name="add-to-cart" value="64"></form>
			<form class="woocommerce-ordering" method="get"><select name="orderby"><option>price</option></select></form>
			<form class="woocommerce-cart-form"><input name="cart[x][qty]"><input type="hidden" name="woocommerce-cart-nonce"></form>
			<form id="commentform" action="https://example.com/wp-comments-post.php" method="post"><textarea name="comment"></textarea><input name="author"></form>
			<form class="wpcf7-form"><input name="your-name"></form>`;
		expect(forms(html)).toEqual(["woocommerce", "woocommerce", "woocommerce", "woocommerce", "wp-comments", "contact-form-7"]);
		expect(isContentForm("woocommerce")).toBe(false);
		expect(isContentForm("wp-search")).toBe(false);
		expect(isContentForm("contact-form-7")).toBe(true);
	});
});

describe("text conservation reads animated counters at their end number", () => {
	it("uses Elementor's data-to-value instead of the start number in the HTML", async () => {
		const { sourceText } = await import("../src/transform/coverage.js");
		const t = sourceText('<main><span class="elementor-counter-number" data-to-value="1200" data-from-value="0">0</span> mugs</main>');
		expect(t).toContain("1200");
		expect(t).not.toMatch(/\b0\b/);
	});
});
