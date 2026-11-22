/**
 * The starter's layouts never widen the page on a phone (verify's no-sideways-scroll check). WordPress e2e test,
 * 2026-11-22: a form page's long heading word ("commissions" at display size) and a variable product's options table
 * made their grid column wider than the screen (+39px, +24px at 390px).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (f: string) => readFileSync(join(import.meta.dirname, "..", "starter", "src", f), "utf8");

describe("starter layouts on phones", () => {
	it("grid columns shrink below their content (minmax(0, 1fr)) and headings wrap long words", () => {
		const css = read("styles/base.css");
		expect(css).toContain(".form-layout { display: grid; grid-template-columns: minmax(0, 1fr);");
		expect(css).toContain(".form-layout { grid-template-columns: repeat(2, minmax(0, 1fr));");
		expect(css).toMatch(/^h1, h2, h3, h4, h5, h6, \.heading \{[^}]*overflow-wrap: break-word;/m);
		expect(read("components/collections/ProductDetail.astro")).toContain(".product-details .container { display: grid; grid-template-columns: minmax(0, 1fr);");
	});

	it("separates a testimonial's name and role with a space (screen readers, text copies)", () => {
		expect(read("components/sections/Testimonials.astro")).toContain('{q.name && q.role && " "}');
	});
});
