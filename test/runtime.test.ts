import { describe, expect, it } from "vitest";
import { runtimeAnalyticsProblem } from "../src/verify/runtime.js";

describe("analytics in a real browser", () => {
	const ids = { google: ["G-TEST123"], gtm: "GTM-TEST12" };
	it("passes when gtag.js and gtm.js were requested and nothing was CSP-blocked", () => {
		expect(runtimeAnalyticsProblem({ trackers: ["https://www.googletagmanager.com/gtag/js", "https://www.googletagmanager.com/gtm.js", "https://www.google-analytics.com/g/collect"], csp: [] }, ids)).toBe("");
	});
	it("fails when the IDs are in the HTML but the loader never ran (inline loader blocked by the CSP)", () => {
		const p = runtimeAnalyticsProblem({ trackers: [], csp: ["Executing inline script violates the following Content Security Policy directive 'script-src'"] }, ids);
		expect(p).toMatch(/gtag\.js\) never requested/);
		expect(p).toMatch(/gtm\.js\) never requested/);
		expect(p).toMatch(/CSP blocked/);
	});
	it("flags a CSP-blocked beacon even when Google loads", () => {
		expect(runtimeAnalyticsProblem({ trackers: ["https://www.googletagmanager.com/gtag/js"], csp: ["Loading the script 'https://static.cloudflareinsights.com/beacon.min.js' violates the following Content Security Policy"] }, { google: ["G-TEST123"] })).toMatch(/CSP blocked/);
	});
});
