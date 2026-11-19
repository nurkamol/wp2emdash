import { describe, expect, it } from "vitest";
import { svgSize } from "../src/targets/emdash/svg.js";

describe("SVG size", () => {
	it("reads width/height, falls back to the viewBox, then a default", () => {
		expect(svgSize('<svg width="120" height="40" viewBox="0 0 12 4">')).toEqual({ width: 120, height: 40 });
		expect(svgSize('<svg viewBox="0 0 300 100">')).toEqual({ width: 300, height: 100 });
		expect(svgSize('<svg width="100%" viewBox="0,0,50,20">')).toEqual({ width: 50, height: 20 });
		expect(svgSize("<svg>")).toEqual({ width: 300, height: 150 });
	});
});
