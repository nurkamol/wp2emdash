import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
import { applyMeasuredPadding } from "../src/transform/measured.js";
import { diffSections, groupSections, sourceRowIndex } from "../src/verify/sections.js";

describe("section pairing", () => {
	it("reads the source row from a sourceRef path", () => {
		expect(sourceRowIndex("vc_row[3]")).toBe(3);
		expect(sourceRowIndex("vc_row[3]#1")).toBe(3);
		expect(sourceRowIndex("vc_section[0]/vc_row[2]")).toBe(0);
		expect(sourceRowIndex("blocks[0-9]")).toBeUndefined();
	});

	it("groups consecutive sections that came from one row", () => {
		const g = groupSections(
			[
				{ type: "hero", path: "vc_row[0]" },
				{ type: "form", path: "vc_row[1]#0" },
				{ type: "feature_grid", path: "vc_row[1]#1" },
				{ type: "rich_text", path: "blocks[0-3]" },
				{ type: "faq", path: "vc_row[2]" },
			],
			false,
		);
		expect(g.map((x) => [x.sourceIndex, x.targetIndexes, x.types])).toEqual([
			[0, [0], ["hero"]],
			[1, [1, 2], ["form", "feature_grid"]],
			[2, [4], ["faq"]],
		]);
	});
});

describe("section diff", () => {
	it("compares each pair on its own, so a taller section does not shift the next one", () => {
		const dir = mkdtempSync(join(tmpdir(), "wp2e-sec-"));
		try {
			const page = (bands: [number, number, number][]) => {
				const h = bands.reduce((n, [height]) => n + height, 0);
				const png = new PNG({ width: 20, height: h });
				let y = 0;
				for (const [height, r, gb] of bands) {
					for (let row = y; row < y + height; row++) for (let x = 0; x < 20; x++) png.data.set([r, gb, gb, 255], (row * 20 + x) * 4);
					y += height;
				}
				return png;
			};
			// Source: red band 100px, blue band 100px. Target: red band 140px (taller), then the same blue band.
			writeFileSync(join(dir, "a.png"), PNG.sync.write(page([[100, 255, 0], [100, 0, 255]])));
			writeFileSync(join(dir, "b.png"), PNG.sync.write(page([[140, 255, 0], [100, 0, 255]])));
			const res = diffSections(
				join(dir, "a.png"),
				join(dir, "b.png"),
				[{ index: 0, y: 0, height: 100, footer: false, kind: "wpbakery" }, { index: 1, y: 100, height: 100, footer: false, kind: "wpbakery" }],
				[{ index: 0, y: 0, height: 140, footer: false, kind: "emdash" }, { index: 1, y: 140, height: 100, footer: false, kind: "emdash" }],
				groupSections([{ type: "hero", path: "vc_row[0]" }, { type: "rich_text", path: "vc_row[1]" }], false),
				(k, part) => join(dir, `${k}-${part}.png`),
			);
			expect(res[0]?.ratio).toBeGreaterThan(0.2); // the taller red band differs over its extra 40px
			expect(res[1]?.ratio).toBe(0); // the next section is identical once aligned
			expect([res[1]?.sourceHeight, res[1]?.targetHeight]).toEqual([100, 100]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("measured padding", () => {
	it("puts the source row's measured padding on the first and last section of its group, heroes excluded", () => {
		const sec = (type: string, path: string) => ({ type, sourceRef: { adapter: "wpbakery", path, rawHash: "x" }, spacing: "normal", fields: {} }) as never;
		const sections = [sec("hero", "vc_row[0]"), sec("form", "vc_row[1]#0"), sec("feature_grid", "vc_row[1]#1")];
		const box = (index: number, padTop: number, padBottom: number) => ({ index, y: 0, height: 100, footer: false, kind: "wpbakery", padTop, padBottom });
		const n = applyMeasuredPadding(sections, { desktop: [box(0, 200, 0), box(1, 50, 0)], mobile: [box(0, 50, 0), box(1, 50, 0)] }, false);
		const pads = (sections as { pad?: { top?: string; bottom?: string } }[]).map((s) => s.pad);
		expect(n).toBe(4);
		expect(pads[0]).toBeUndefined();
		// One source row split in two (form, then cards): one inner gap between them, not two section paddings.
		expect(pads[1]).toEqual({ top: "50px", bottom: "0px" });
		expect(pads[2]?.bottom).toBe("0px");
		expect(pads[2]?.top).toMatch(/^clamp\(56px, .* 92px\)$/);
	});

	it("adds the height of a source row that produced no section (a spacer row) to the next section's top", () => {
		const sec = (path: string) => ({ type: "cta_banner", sourceRef: { adapter: "wpbakery", path, rawHash: "x" }, spacing: "normal", fields: {} }) as never;
		const sections = [sec("vc_row[1]")];
		const box = (index: number, height: number, padTop: number) => ({ index, y: 0, height, footer: true, kind: "wpbakery", padTop, padBottom: 0 });
		applyMeasuredPadding(sections, { desktop: [box(0, 144, 144), box(1, 450, 0)], mobile: [box(0, 69, 69), box(1, 422, 0)] }, true);
		expect((sections as { pad?: { top?: string } }[])[0]?.pad?.top).toBe("clamp(69px, 41.14px + 7.143vw, 144px)");
	});

	it("adds a tablet value only where the tablet measurement leaves the phone→desktop line", () => {
		const sec = (path: string) => ({ type: "columns", sourceRef: { adapter: "wpbakery", path, rawHash: "x" }, spacing: "normal", fields: {} }) as never;
		const sections = [sec("vc_row[0]"), sec("vc_row[1]")];
		const box = (index: number, pad: number) => ({ index, y: 0, height: 100, footer: false, kind: "wpbakery", padTop: pad, padBottom: pad });
		// row 0: 21 → 41 → 28 (Salient tablet padding); row 1: 20 → 38 → 70, on the line
		applyMeasuredPadding(sections, { desktop: [box(0, 28), box(1, 70)], tablet: [box(0, 41), box(1, 38)], mobile: [box(0, 21), box(1, 20)] }, false);
		const pads = (sections as { pad?: Record<string, unknown> }[]).map((s) => s.pad);
		expect(pads[0]).toMatchObject({ topTablet: 41, bottomTablet: 41 });
		expect(pads[1]).not.toHaveProperty("topTablet");
	});
});
