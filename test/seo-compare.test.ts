import { describe, expect, it } from "vitest";
import { compareSeo } from "../src/verify/compare.js";

const seo = (o: Partial<{ title: string; robots: string; jsonLdTypes: string[]; og: Record<string, string>; twitter: Record<string, string> }>) => ({ og: {}, twitter: {}, jsonLd: [], hreflang: [], jsonLdTypes: [], ...o }) as never;

describe("SEO comparison", () => {
	it("ignores an SEO plugin's Article/Person boilerplate on plain pages, not on posts", () => {
		const src = seo({ jsonLdTypes: ["WebSite", "HealthClub+Organization", "Article", "Person"] });
		const tgt = seo({ jsonLdTypes: ["WebSite", "HealthClub+Organization"] });
		expect(compareSeo(src, tgt, "https://example.com/a/", false, "page").jsonLd).toMatchObject({ ok: true, missing: [] });
		expect(compareSeo(src, tgt, "https://example.com/a/", false, "post").jsonLd.missing).toEqual(["Article", "Person"]);
	});
	it("requires noindex before go-live and the source's indexability after", () => {
		const src = seo({ robots: "index, follow" });
		expect(compareSeo(src, seo({ robots: "noindex, nofollow" }), "https://example.com/", true).robots.ok).toBe(true);
		expect(compareSeo(src, seo({ robots: "noindex, nofollow" }), "https://example.com/", false).robots.ok).toBe(false);
	});
	it("requires the sharing image and the same card size", () => {
		const src = seo({ og: { "og:title": "A", "og:image": "https://example.com/a.webp", "og:locale": "en_US" }, twitter: { "twitter:card": "summary_large_image" } });
		const bare = compareSeo(src, seo({ og: { "og:title": "A" }, twitter: { "twitter:card": "summary" } }), "https://example.com/", true).og;
		expect(bare.missing).toEqual(["og:image", "og:locale", "twitter:card summary (source summary_large_image)"]);
		const full = compareSeo(src, seo({ og: { "og:title": "A", "og:image": "https://example.com/x", "og:locale": "en_US" }, twitter: { "twitter:card": "summary_large_image" } }), "https://example.com/", true).og;
		expect(full.ok).toBe(true);
	});
});
