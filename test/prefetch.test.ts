import { describe, expect, it } from "vitest";
import { prefetchable, slowConnection } from "../starter/src/utils/prefetch.js";

const here = { origin: "https://acme.example", pathname: "/about-us/", search: "" };

describe("page preloading (hover / focus / touch)", () => {
	it("preloads the site's own pages, without the hash", () => {
		expect(prefetchable("/classes/", here)).toBe("https://acme.example/classes/");
		expect(prefetchable("https://acme.example/blog/page/2/#top", here)).toBe("https://acme.example/blog/page/2/");
		expect(prefetchable("contact/", here)).toBe("https://acme.example/about-us/contact/");
		expect(prefetchable("/old-page.html", here)).toBe("https://acme.example/old-page.html");
	});
	it("never preloads files, other sites, admin/API/form endpoints, feeds, previews, searches or the current page", () => {
		for (const h of ["/wp-content/uploads/2024/menu.pdf", "/files/price-list.pdf", "/_emdash/api/media/file/abc", "/_emdash/admin", "/api/forms/contact", "/_image?url=x", "/feed/", "/category/news/feed/", "https://other.example/x/", "mailto:a@acme.example", "tel:+15550100", "/about-us/", "/about-us/#team", "/?s=yoga", "/search/?q=yoga", "/x/?_preview=1", "/logo.svg"]) expect(prefetchable(h, here), h).toBeUndefined();
	});
	it("stays off on data saver and 2G", () => {
		expect(slowConnection({ saveData: true })).toBe(true);
		expect(slowConnection({ effectiveType: "slow-2g" })).toBe(true);
		expect(slowConnection({ effectiveType: "2g" })).toBe(true);
		expect(slowConnection({ effectiveType: "4g" })).toBe(false);
		expect(slowConnection(undefined)).toBe(false);
	});
});
