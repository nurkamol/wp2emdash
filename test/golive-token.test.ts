import { describe, expect, it } from "vitest";
import { goliveTokenChecks, sameAsBuildToken } from "../src/cutover/token.js";
import { kvBindings } from "../src/phases/scaffold.js";

const zones = (names: string[], perPage = 50) =>
	(async (input: string) => {
		const page = Number(new URL(input).searchParams.get("page") ?? 1);
		return new Response(JSON.stringify({ success: true, result: names.slice((page - 1) * perPage, page * perPage).map((name) => ({ name })), result_info: { page, total_pages: Math.max(1, Math.ceil(names.length / perPage)), total_count: names.length } }));
	}) as (input: string) => Promise<Response>;

describe("go-live token hygiene", () => {
	it("flags a go-live token identical to a build token by name only", () => {
		expect(sameAsBuildToken("same-value", { CLOUDFLARE_API_TOKEN: "same-value" })).toEqual(["CLOUDFLARE_API_TOKEN"]);
		expect(sameAsBuildToken("same-value", { CLOUDFLARE_API_TOKEN_PRODUCTION: " same-value\n" })).toEqual(["CLOUDFLARE_API_TOKEN_PRODUCTION"]);
		expect(sameAsBuildToken("golive", { CLOUDFLARE_API_TOKEN: "build" })).toEqual([]);
	});

	it("passes a separate token that sees only the primary and alias zones", async () => {
		const checks = await goliveTokenChecks({ golive: "g", vars: { CLOUDFLARE_API_TOKEN: "b" }, allowedZones: ["acme.example", "old.example"], fetch: zones(["acme.example", "old.example"]) });
		expect(checks.map((c) => `${c.id}:${c.ok}`)).toEqual(["golive-token-separate:true", "golive-token-scope:true"]);
	});

	it("fails the build token reused, never printing it", async () => {
		const checks = await goliveTokenChecks({ golive: "secret-token-xyz", vars: { CLOUDFLARE_API_TOKEN: "secret-token-xyz" }, allowedZones: ["acme.example"], fetch: zones(["acme.example"]) });
		expect(checks[0]?.ok).toBe(false);
		expect(JSON.stringify(checks)).not.toContain("secret-token-xyz");
	});

	it("fails a token that reaches other zones (every page counted) and says to scope it to a specific zone", async () => {
		const many = ["acme.example", ...Array.from({ length: 120 }, (_, i) => `client${i}.example`)];
		const [, scope] = await goliveTokenChecks({ golive: "g", vars: {}, allowedZones: ["acme.example"], fetch: zones(many) });
		expect(scope?.ok).toBe(false);
		expect(scope?.detail).toMatch(/120 other zones/);
		expect(scope?.detail).toMatch(/Specific zone/);
		expect(scope?.detail).not.toMatch(/client\d/);
	});
});

describe("wrangler KV bindings", () => {
	it("binds SESSION explicitly once provision recorded it, next to the form outbox", () => {
		const cf = { staging: { outbox: { id: "o-stg" }, session: { id: "s-stg" } }, production: { session: { id: "s-prod" } } };
		expect(kvBindings(cf, "staging", true)).toEqual([{ binding: "FORM_OUTBOX", id: "o-stg" }, { binding: "SESSION", id: "s-stg" }]);
		expect(kvBindings(cf, "production", true)).toEqual([{ binding: "SESSION", id: "s-prod" }]);
		expect(kvBindings({ staging: { outbox: { id: "o" } } }, "staging", false)).toEqual([]);
	});
});
