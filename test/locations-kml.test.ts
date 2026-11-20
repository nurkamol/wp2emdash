import { describe, expect, it } from "vitest";
// The starter route's pure builder (no Astro runtime needed).
import { locationsKml } from "../starter/src/utils/kml.js";

describe("/locations.kml (regenerated Rank Math Local SEO file)", () => {
	const b = { name: "Acme Studio", telephone: "+1 555 0100", address: { streetAddress: "1 Main St", addressLocality: "Springfield", addressRegion: "TX", postalCode: "77000", addressCountry: "US" }, geo: { latitude: "29.79", longitude: "-95.57" } };
	it("builds a KML placemark from the carried LocalBusiness data", () => {
		const k = locationsKml(b, "https://acme.example", "Acme") as string;
		expect(k).toContain("<coordinates>-95.57,29.79</coordinates>");
		expect(k).toContain("<![CDATA[1 Main St, Springfield, TX, 77000, US]]>");
		expect(k).toContain('<atom:link href="https://acme.example"');
		expect(k).toContain("<![CDATA[Locations for Acme Studio]]>");
	});
	it("has no file without coordinates (404)", () => {
		expect(locationsKml({ name: "No Geo" }, "https://acme.example", "x")).toBeUndefined();
	});
});
