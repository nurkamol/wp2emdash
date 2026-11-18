import { describe, expect, it } from "vitest";
import { businessFromJsonLd } from "../src/transform/business.js";

describe("business from the live site's structured data", () => {
	it("takes the LocalBusiness node, merges its Place, drops images and page nodes", () => {
		const graph = [
			{
				"@context": "https://schema.org",
				"@graph": [
					{ "@type": "Place", "@id": "https://example.com/#place", geo: { "@type": "GeoCoordinates", latitude: "34.7", longitude: "-76.7" }, hasMap: "https://maps.example/x" },
					{
						"@type": ["Dentist", "Organization"],
						"@id": "https://example.com/#organization",
						name: "Sample Dental",
						url: "https://example.com",
						telephone: "+1 555 0100",
						address: { "@type": "PostalAddress", streetAddress: "1 Main St", addressLocality: "Town", postalCode: "00000", addressCountry: "US" },
						logo: { "@type": "ImageObject", url: "https://example.com/wp-content/uploads/logo.png" },
						openingHours: ["Monday,Tuesday 09:00-17:00"],
						location: { "@id": "https://example.com/#place" },
					},
					{ "@type": "WebSite", "@id": "https://example.com/#website", name: "Sample" },
					{ "@type": "Article", headline: "Home" },
				],
			},
		];
		expect(businessFromJsonLd(graph)).toEqual({
			type: "Dentist",
			name: "Sample Dental",
			url: "https://example.com",
			telephone: "+1 555 0100",
			address: { streetAddress: "1 Main St", addressLocality: "Town", postalCode: "00000", addressCountry: "US" },
			geo: { latitude: "34.7", longitude: "-76.7" },
			hasMap: "https://maps.example/x",
			openingHours: ["Monday,Tuesday 09:00-17:00"],
		});
	});
	it("returns nothing when the site publishes no business", () => {
		expect(businessFromJsonLd([{ "@type": "WebSite", name: "Blog" }, { "@type": "Person", name: "Author" }])).toBeUndefined();
	});
});
