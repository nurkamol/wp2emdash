import type { Page } from "playwright";
import { describe, expect, it } from "vitest";
import { MAX_SHOT_HEIGHT, trackBrokenAssets } from "../src/audit/browser.js";

function fakePage() {
	const handlers: Record<string, (r: unknown) => void> = {};
	const page = { on: (e: string, h: (r: unknown) => void) => (handlers[e] = h) } as unknown as Page;
	const respond = (url: string, status: number, type: string) => handlers.response?.({ url: () => url, status: () => status, request: () => ({ resourceType: () => type }) });
	const fail = (url: string, type: string) => handlers.requestfailed?.({ url: () => url, resourceType: () => type });
	return { page, respond, fail };
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

	it("also records own stylesheets the browser aborted (an HTML error page served as CSS)", () => {
		const { page, fail } = fakePage();
		const take = trackBrokenAssets(page, "https://studio.example");
		fail("https://studio.example/wp-content/cache/background-css/style.css?wpr_t=1", "stylesheet");
		fail("https://stats.example.net/beacon.js", "script");
		expect(take()).toEqual(["failed /wp-content/cache/background-css/style.css"]);
		expect(take()).toEqual([]);
	});

	it("caps full-page captures well above any real page", () => {
		expect(MAX_SHOT_HEIGHT).toBeGreaterThanOrEqual(20_000);
	});
});
