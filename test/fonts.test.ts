import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { selfHostGoogleFonts, typekitKit } from "../src/scaffold/fonts.js";
import { fontCsp, TYPEKIT_CSP } from "../starter/src/utils/fonts.js";

const face = (family: string, style: string, weight: number, file: string) => `@font-face {\n  font-family: '${family}';\n  font-style: ${style};\n  font-weight: ${weight};\n  font-display: swap;\n  src: url(https://fonts.gstatic.com/s/x/${file}.woff2) format('woff2');\n  unicode-range: U+0000-00FF;\n}`;
const css = [`/* cyrillic */\n${face("Body Sans", "normal", 400, "cyr")}`, `/* latin */\n${face("Body Sans", "normal", 400, "b400")}`, `/* latin */\n${face("Body Sans", "italic", 400, "b400i")}`, `/* latin-ext */\n${face("Show Serif", "normal", 300, "s300x")}`, `/* latin */\n${face("Show Serif", "normal", 300, "s300")}`].join("\n");
const fetcher = (async (url: string) => (url.includes("css2") ? new Response(css) : new Response(new Uint8Array(Buffer.from(url))))) as unknown as typeof fetch;

describe("self-hosted Google Fonts", () => {
	it("keeps latin subsets, rewrites URLs to /fonts and preloads body regular + display heading weight", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fonts-"));
		try {
			const r = await selfHostGoogleFonts("https://fonts.googleapis.com/css2?family=x", dir, { body: "Body Sans", display: "Show Serif", displayWeight: 300 }, fetcher);
			expect(r?.files).toBe(4);
			expect(readdirSync(join(dir, "fonts"))).toHaveLength(4);
			expect(r?.css).not.toMatch(/gstatic|cyrillic/);
			expect(r?.css.match(/url\(\/fonts\/[0-9a-f]{12}\.woff2\)/g)).toHaveLength(4);
			expect(r?.preload).toHaveLength(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("Adobe Fonts (Typekit) kept from the live site", () => {
	it("finds the project's CSS embed (link or @import); the JavaScript embed is reported, not converted", () => {
		expect(typekitKit(['<link rel="stylesheet" href="https://use.typekit.net/abc1def.css">'])).toEqual({ href: "https://use.typekit.net/abc1def.css" });
		expect(typekitKit(["<style>@import url(\"https://use.typekit.net/XYZ9876.css\");</style>"])).toEqual({ href: "https://use.typekit.net/xyz9876.css" });
		expect(typekitKit(['<script src="https://use.typekit.net/abc1def.js"></script><script>try{Typekit.load()}catch(e){}</script>'])).toEqual({ jsKit: "abc1def" });
		expect(typekitKit(["<p>no fonts</p>", '<link href="https://fonts.googleapis.com/css2?family=Inter">'])).toEqual({});
	});

	it("the CSP allows Typekit only when the site keeps a project; the starter links it", () => {
		expect(fontCsp({ typekitHref: "https://use.typekit.net/abc1def.css" })).toEqual({ style: ["https://use.typekit.net", "https://p.typekit.net"], font: ["https://use.typekit.net"] });
		expect(fontCsp({})).toEqual({ style: [], font: [] });
		expect(fontCsp(undefined)).toEqual({ style: [], font: [] });
		expect(TYPEKIT_CSP.font).toContain("https://use.typekit.net");
		const mw = readFileSync(join(import.meta.dirname, "..", "starter", "src", "middleware.ts"), "utf8");
		expect(mw).toMatch(/style-src[^`]*fontHosts\.style/);
		expect(mw).toMatch(/font-src[^`]*fontHosts\.font/);
		expect(readFileSync(join(import.meta.dirname, "..", "starter", "src", "layouts", "Base.astro"), "utf8")).toContain("{typekitHref && <link rel=\"stylesheet\" href={typekitHref} />}");
	});
});
