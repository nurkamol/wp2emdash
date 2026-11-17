import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { describe, expect, it } from "vitest";
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
