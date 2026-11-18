import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { selfHostGoogleFonts } from "../src/scaffold/fonts.js";

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
