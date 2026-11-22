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
			<form class="wpcf7-form"><input name="your-name"></form>`;
		expect(forms(html)).toEqual(["woocommerce", "woocommerce", "woocommerce", "woocommerce", "contact-form-7"]);
		expect(isContentForm("woocommerce")).toBe(false);
		expect(isContentForm("wp-search")).toBe(false);
		expect(isContentForm("contact-form-7")).toBe(true);
	});
});
