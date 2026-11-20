import { describe, expect, it } from "vitest";
import { kitConfigSchema } from "../src/config/schema.js";
import { footerCredit } from "../src/scaffold/credit.js";

const def = kitConfigSchema.parse({ slug: "acme", name: "Acme", source: { url: "https://acme.example" }, target: { productionUrl: "https://acme.example" } }).credit;

describe("footer credit", () => {
	it("defaults to Website by PixelKraft → pixelkraft.net", () => {
		expect(def).toEqual({ text: "Website by", name: "PixelKraft", url: "https://pixelkraft.net" });
		expect(footerCredit(def, "© 2026 Acme · Privacy policy")).toEqual(def);
	});
	it("is left out when the migrated footer already has a credit", () => {
		expect(footerCredit(def, "© 2026 Acme / Website by Someone Else")).toBeUndefined();
		expect(footerCredit(def, "Designed by Studio X")).toBeUndefined();
		expect(footerCredit(def, "© 2026 Acme · pixelkraft")).toBeUndefined();
	});
	it("credit: false turns it off", () => {
		expect(footerCredit(false, "© 2026 Acme")).toBeUndefined();
	});
});
