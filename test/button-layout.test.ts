import { describe, expect, it } from "vitest";
import { BLOCK_TYPES } from "../src/starter/library.js";

const LAYOUT = ["buttons_direction", "buttons_align", "buttons_width", "buttons_stack_phone", "buttons_gap"];
const slugs = (b: (typeof BLOCK_TYPES)[number]) => (b.versions[0]?.fields ?? []).map((f) => f.slug);

describe("button group layout fields", () => {
	it("every block with buttons gets all five settings, optional with neutral defaults", () => {
		const withButtons = BLOCK_TYPES.filter((b) => slugs(b).some((s) => s === "buttons" || /^col_\d_buttons$/.test(s)));
		expect(withButtons.map((b) => b.slug).sort()).toEqual(["section_columns", "section_cta_banner", "section_hero", "section_media_text", "section_pricing", "section_rich_text"]);
		for (const b of withButtons) {
			expect(slugs(b)).toEqual(expect.arrayContaining(LAYOUT));
			const fields = b.versions[0]?.fields ?? [];
			for (const f of fields.filter((x) => LAYOUT.includes(x.slug))) expect(f.required).toBeFalsy();
		}
		const f = (slug: string) => withButtons[0]?.versions[0]?.fields.find((x) => x.slug === slug);
		expect(f("buttons_direction")?.defaultValue).toBe("default");
		expect(f("buttons_align")?.defaultValue).toBe("default");
		expect(f("buttons_width")?.defaultValue).toBe("default");
		expect(f("buttons_stack_phone")?.defaultValue).toBe(false);
		const gap = new RegExp((f("buttons_gap")?.validation as { pattern: string }).pattern);
		expect(["", "12px", "1.5rem"].every((v) => gap.test(v))).toBe(true);
		expect(["12", "calc(1px)", "12px;color:red"].some((v) => gap.test(v))).toBe(false);
	});
	it("blocks without buttons do not get them", () => {
		for (const b of BLOCK_TYPES.filter((x) => !slugs(x).some((s) => s === "buttons" || /^col_\d_buttons$/.test(s)))) expect(slugs(b)).not.toContain("buttons_direction");
	});
});
