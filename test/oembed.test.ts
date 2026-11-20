/**
 * WordPress oEmbed URLs (core/embed) → the provider's official embed markup (src/adapters/gutenberg/oembed.ts). Every
 * markup must be recognised as its provider and survive the starter's embed allowlist unchanged (its scripts and iframes
 * load from the provider's registry hosts). Adapter output: golden test/golden/gutenberg/oembed.json.
 */
import { describe, expect, it } from "vitest";
import { oembedMarkup } from "../src/adapters/gutenberg/oembed.js";
import { embedProvider } from "../src/adapters/wpbakery/elements.js";
// The starter's allowlist (extensionless relative import: loaded at runtime, outside the kit's typecheck).
const { sanitizeEmbed } = (await import(`../starter/src/utils/${"embed"}.ts`)) as { sanitizeEmbed: (html: string, provider: string) => string };

const CASES: [string, string][] = [
	["https://x.com/studio/status/1234567890", "x-twitter"],
	["https://twitter.com/studio/status/1234567890", "x-twitter"],
	["https://www.tiktok.com/@studio/video/7000000000000000001", "tiktok"],
	["https://www.instagram.com/p/Cabc123/", "instagram"],
	["https://www.instagram.com/reel/Cabc123/", "instagram"],
	["https://www.dailymotion.com/video/x8abc12", "dailymotion"],
	["https://dai.ly/x8abc12", "dailymotion"],
	["https://www.ted.com/talks/speaker_a_talk", "ted"],
	["https://open.spotify.com/episode/4rOoJ6Egrf8K2IrywzwOMk", "spotify"],
	["https://open.spotify.com/intl-de/track/4rOoJ6Egrf8K2IrywzwOMk", "spotify"],
	["https://www.loom.com/share/0123456789abcdef0123456789abcdef", "loom"],
	["https://www.mixcloud.com/studio/morning-mix/", "mixcloud"],
	["https://www.reddit.com/r/pilates/comments/abc123/a_thread/", "reddit"],
	["https://www.pinterest.com/pin/123456789/", "pinterest"],
];

describe("oEmbed URLs → official embed markup", () => {
	for (const [url, provider] of CASES) {
		it(`${url} → ${provider}, kept whole by the embed allowlist`, () => {
			const html = oembedMarkup(url) as string;
			expect(html).toBeTruthy();
			expect(embedProvider(html)).toBe(provider);
			expect(sanitizeEmbed(html, provider)).toBe(html);
		});
	}

	it("URLs whose markup does not follow from the URL alone stay links (undefined)", () => {
		for (const u of ["https://www.example-unknown.test/watch/1", "https://x.com/studio", "https://open.spotify.com/", "javascript:alert(1)", "not a url", "https://www.tiktok.com/@studio"]) expect(oembedMarkup(u), u).toBeUndefined();
	});

	it("escapes the URL in attributes", () => {
		expect(oembedMarkup('https://x.com/a/status/1?q="><script>')).not.toContain('"><script>');
	});
});
