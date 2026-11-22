import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { MAX_SHOT_HEIGHT, trackBrokenAssets } from "../src/audit/browser.js";

function fakePage() {
	let handler: (r: unknown) => void = () => {};
	const page = { on: (_e: string, h: (r: unknown) => void) => (handler = h) } as unknown as Page;
	const respond = (url: string, status: number, type: string) => handler({ url: () => url, status: () => status, request: () => ({ resourceType: () => type }) });
	return { page, respond };
}

describe("broken own files", () => {
	it("records the site's own stylesheets and scripts with an error status, once, and resets per page", () => {
		const { page, respond } = fakePage();
		const take = trackBrokenAssets(page, "https://studio.example");
		respond("https://studio.example/wp-content/cache/min/style.css?ver=1&wpr_t=2", 404, "stylesheet");
		respond("https://studio.example/wp-content/cache/min/style.css?ver=1&wpr_t=2", 404, "stylesheet");
		respond("https://studio.example/app.js", 500, "script");
		respond("https://studio.example/ok.css", 200, "stylesheet");
		respond("https://studio.example/missing.png", 404, "image");
		respond("https://cdn.example.net/lib.js", 404, "script");
		expect(take()).toEqual(["404 /wp-content/cache/min/style.css", "500 /app.js"]);
		expect(take()).toEqual([]);
	});

	it("caps full-page captures well above any real page", () => {
		expect(MAX_SHOT_HEIGHT).toBeGreaterThanOrEqual(20_000);
	});
});
