import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ARD_URN, ardManifest } from "../starter/src/utils/ard.js";

describe("ARD manifest (/.well-known/ard.json)", () => {
	const m = ardManifest({ name: "Acme  Studio", productionUrl: "https://www.acme.example/some/path" });

	it("lists llms.txt and the sitemap at the site's origin", () => {
		expect(m.entries.map((e) => e.url)).toEqual(["https://www.acme.example/llms.txt", "https://www.acme.example/sitemap.xml"]);
	});
	it("meets the conformance check: URN anchored at the host, name, type, url, 2–5 queries", () => {
		for (const e of m.entries) {
			const urn = ARD_URN.exec(e.identifier);
			expect(urn?.[1]).toBe("acme.example");
			expect(e.displayName).toContain("Acme Studio");
			expect(e.type).toMatch(/^[a-z]+\/[a-z0-9.+-]+$/);
			expect("data" in e).toBe(false);
			expect(e.representativeQueries.length).toBeGreaterThanOrEqual(2);
			expect(e.representativeQueries.length).toBeLessThanOrEqual(5);
		}
		expect(new Set(m.entries.map((e) => e.identifier)).size).toBe(m.entries.length);
	});
	it("scaffold writes it as a static file", () => {
		const src = readFileSync(join(import.meta.dirname, "..", "src", "phases", "scaffold.ts"), "utf8");
		expect(src).toContain('join(project, "public", ".well-known", "ard.json")');
	});
});
