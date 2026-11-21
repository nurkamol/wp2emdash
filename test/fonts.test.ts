import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolveGoogleHref, selfHostGoogleFonts, typekitKit } from "../src/scaffold/fonts.js";
import { fontCsp, TYPEKIT_CSP } from "../starter/src/utils/fonts.js";

const face = (family: string, style: string, weight: number, file: string) => `@font-face {\n  font-family: '${family}';\n  font-style: ${style};\n  font-weight: ${weight};\n  font-display: swap;\n  src: url(https://fonts.gstatic.com/s/x/${file}.woff2) format('woff2');\n  unicode-range: U+0000-00FF;\n}`;
const css = [`/* cyrillic */\n${face("Body Sans", "normal", 400, "cyr")}`, `/* latin */\n${face("Body Sans", "normal", 400, "b400")}`, `/* latin */\n${face("Body Sans", "italic", 400, "b400i")}`, `/* latin-ext */\n${face("Show Serif", "normal", 300, "s300x")}`, `/* latin */\n${face("Show Serif", "normal", 300, "s300")}`].join("\n");
const fetcher = (async (url: string) => (url.includes("css2") ? new Response(css) : new Response(new Uint8Array(Buffer.from(`wOF2${url}`))))) as unknown as typeof fetch;

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

describe("Google Fonts check never drops a font on a failed request", () => {
	const href = "https://fonts.googleapis.com/css2?family=Outfit:wght@300;400&family=Pinyon+Script&display=swap";
	it("drops only a family Google answers 400 for", async () => {
		const f = (async (u: string) => new Response("", { status: u.includes("Nope") || (u.includes("Outfit") && u.includes("Pinyon")) ? 400 : 200 })) as unknown as typeof fetch;
		const r = await resolveGoogleHref("https://fonts.googleapis.com/css2?family=Outfit&family=Nope&display=swap", f);
		expect(r.dropped).toEqual(["Nope"]);
		expect(r.href).toContain("family=Outfit");
	});
	it("retries a network error or 5xx and keeps the family when the retry answers", async () => {
		let n = 0;
		const f = (async (u: string) => {
			if (u === href) return new Response("", { status: 400 });
			if (u.includes("Outfit") && n++ === 0) throw new Error("socket hang up");
			return new Response("", { status: 200 });
		}) as unknown as typeof fetch;
		const r = await resolveGoogleHref(href, f);
		expect(r.dropped).toEqual([]);
		expect(r.href).toContain("Outfit");
	});
	it("throws (caller keeps the whole href) when Google keeps failing", async () => {
		const f = (async () => new Response("", { status: 503 })) as unknown as typeof fetch;
		await expect(resolveGoogleHref(href, f)).rejects.toThrow(/did not answer \(HTTP 503\)/);
	});
	it("a font file that cannot be downloaded fails self-hosting instead of leaving the font out", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fonts-"));
		try {
			const css = "/* latin */\n@font-face { font-family: 'Outfit'; font-weight: 400; src: url(https://fonts.gstatic.com/a.woff2) format('woff2'); }";
			const f = (async (u: string) => (u.includes("css2") ? new Response(css) : new Response("", { status: 500 }))) as unknown as typeof fetch;
			await expect(selfHostGoogleFonts("https://fonts.googleapis.com/css2?family=Outfit", dir, { body: "Outfit", display: "Outfit", displayWeight: 400 }, f)).rejects.toThrow(/HTTP 500/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("self-hosting must cover every family the site uses", () => {
	it("names the families missing from the download", async () => {
		const { missingFamilies } = await import("../src/scaffold/fonts.js");
		const href = "https://fonts.googleapis.com/css2?family=Outfit:ital,wght@0,400;1,400&family=Pinyon+Script:ital,wght@0,400&display=swap";
		expect(missingFamilies(href, ["Pinyon Script"])).toEqual(["Outfit"]);
		expect(missingFamilies(href, ["Outfit", "Pinyon Script"])).toEqual([]);
	});
	it("scaffold keeps the Google link and warns when a family is missing", () => {
		const s = readFileSync(join(import.meta.dirname, "..", "src/phases/scaffold.ts"), "utf8");
		expect(s).toContain("const missing = hosted ? missingFamilies(siteConfig.fonts.googleHref, hostedFamilies) : [];");
		expect(s).toContain("fonts not self-hosted (Google Fonts kept): ${missing.join");
	});
});

describe("Google's dynamic font addresses (/l/font?kit=…, no .woff2 extension)", () => {
	it("are self-hosted like the usual ones, and a file that is not woff2 fails the step", async () => {
		const dir = mkdtempSync(join(tmpdir(), "fonts-"));
		try {
			const css = "/* latin */\n@font-face { font-family: 'Outfit'; font-weight: 400; src: url(https://fonts.gstatic.com/l/font?kit=abc&amp;skey=def&amp;v=v15) format('woff2'); }";
			const seen: string[] = [];
			const ok = (async (u: string) => (u.includes("css2") ? new Response(css) : (seen.push(u), new Response(new Uint8Array(Buffer.from("wOF2data")))))) as unknown as typeof fetch;
			const r = await selfHostGoogleFonts("https://fonts.googleapis.com/css2?family=Outfit", dir, { body: "Outfit", display: "Outfit", displayWeight: 400 }, ok);
			expect(r?.files).toBe(1);
			expect(r?.css).toContain("font-family: 'Outfit'");
			expect(seen).toEqual(["https://fonts.gstatic.com/l/font?kit=abc&skey=def&v=v15"]);
			const html = (async (u: string) => (u.includes("css2") ? new Response(css) : new Response("<html>"))) as unknown as typeof fetch;
			await expect(selfHostGoogleFonts("https://fonts.googleapis.com/css2?family=Outfit", dir, { body: "Outfit", display: "Outfit", displayWeight: 400 }, html)).rejects.toThrow(/not a woff2 font/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
