import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ogFonts } from "../src/scaffold/og.js";

describe("sharing card fonts", () => {
	it("falls back to an available weight when the family lacks the asked one (single-weight script fonts)", async () => {
		const asked: string[] = [];
		const fetcher = (async (input: string | URL) => {
			const u = String(input);
			asked.push(u);
			if (u.endsWith(".ttf")) return new Response(new Uint8Array([0, 1, 0, 0]));
			// The script family only has 400; the body family has every weight.
			if (u.includes("Script+Face") && !u.includes("wght@400")) return new Response("/* no such weight */", { status: 400 });
			return new Response(`@font-face { src: url(https://fonts.gstatic.com/s/${u.includes("Script") ? "script" : "body"}.ttf) format('truetype'); }`);
		}) as typeof fetch;
		const dir = mkdtempSync(join(tmpdir(), "og-fonts-"));
		const out = await ogFonts(dir, { display: "Script Face", body: "Body Sans", displayWeight: 500 }, fetcher);
		expect(out).toEqual({ display: "/fonts/og-display.ttf", body: "/fonts/og-body.ttf" });
		expect(asked).toContain("https://fonts.googleapis.com/css2?family=Script+Face:wght@500");
		expect(asked).toContain("https://fonts.googleapis.com/css2?family=Script+Face:wght@400");
		expect(readFileSync(join(dir, "fonts", "og-display.ttf")).length).toBe(4);
	});

	it("still fails when the family has no TrueType file at all", async () => {
		const fetcher = (async () => new Response("", { status: 400 })) as unknown as typeof fetch;
		await expect(ogFonts(mkdtempSync(join(tmpdir(), "og-fonts-")), { display: "Nope", body: "Nope" }, fetcher)).rejects.toThrow(/no TrueType file for Nope/);
	});
});
