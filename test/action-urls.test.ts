import { describe, expect, it } from "vitest";
import { isActionUrl } from "../src/audit/urls.js";

describe("isActionUrl: addresses that make WordPress do something are never requested", () => {
	it("flags WooCommerce cart actions, comment replies, logins and nonce'd actions", () => {
		for (const u of ["https://example.com/product/mug/?add-to-cart=63", "https://example.com/cart/?remove_item=abc&_wpnonce=1", "https://example.com/post/?replytocom=12", "https://example.com/wp-login.php?action=logout", "https://example.com/wp-admin/post.php", "https://example.com/?wc-ajax=get_refreshed_fragments", "https://example.com/xmlrpc.php"]) expect(isActionUrl(u), u).toBe(true);
	});
	it("leaves pages, filters and pagination alone", () => {
		for (const u of ["https://example.com/product/mug/", "https://example.com/shop/?orderby=price", "https://example.com/blog/page/2/", "https://example.com/?s=clay", "https://example.com/fr/a-propos/", "https://example.com/?p=12"]) expect(isActionUrl(u), u).toBe(false);
	});
});
