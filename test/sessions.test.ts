/**
 * Sign-in sessions on R2 (kit.config sessions, default "r2"): the store the generated project picks, its astro.config
 * lines and the wrangler.jsonc bindings in both modes (docs/spikes/sessions-findings.md). Synthetic data only.
 */
import { describe, expect, it } from "vitest";
import { kitConfigSchema } from "../src/config/schema.js";
import { kvBindings, wranglerJsonc } from "../src/phases/scaffold.js";
import { astroSessions, sessionStore } from "../src/scaffold/sessions.js";

const config = (extra: Record<string, unknown> = {}) =>
	kitConfigSchema.parse({ slug: "acme", name: "Acme", source: { url: "https://acme.example" }, target: { productionUrl: "https://acme.example" }, email: { to: ["owner@acme.example"] }, forms: { outbox: { days: 30 } }, ...extra });
const parseJsonc = (s: string) => JSON.parse(s.replace(/^\s*\/\/.*$/gm, "")) as Record<string, any>;
const PROD = { d1: { name: "acme-db", id: "d1-prod" }, r2: { bucket: "acme-media" }, session: { id: "kv-sess" }, outbox: { id: "kv-out" }, sessions: { bucket: "acme-sessions" } };
const STG = { d1: { name: "acme-staging-db", id: "d1-stg" }, r2: { bucket: "acme-stg-media" }, session: { id: "kv-sess-stg" }, outbox: { id: "kv-out-stg" }, sessions: { bucket: "acme-staging-sessions" } };
const base = { workerName: "acme", compatibilityDate: "2026-11-01", sandboxedEnvs: [], seoPanel: false, productionHost: "acme.example" };

describe("kit.config sessions", () => {
	it("defaults to R2 for 30 days; \"kv\" and { days } are accepted", () => {
		expect(config().sessions).toEqual({ store: "r2", days: 30 });
		expect(config({ sessions: "kv" }).sessions).toEqual({ store: "kv", days: 30 });
		expect(config({ sessions: { days: 7 } }).sessions).toEqual({ store: "r2", days: 7 });
		expect(() => config({ sessions: "redis" })).toThrow();
	});
});

describe("sessionStore", () => {
	it("R2 only when every built environment has its bucket recorded; otherwise KV for all, with the missing ones", () => {
		expect(sessionStore({ store: "r2", days: 30 }, { production: PROD }, ["production"])).toEqual({ store: "r2", missing: [] });
		expect(sessionStore({ store: "r2", days: 30 }, { production: { ...PROD, sessions: undefined } }, ["production"])).toEqual({ store: "kv", missing: ["production"] });
		// One astro.config serves every environment: a staging build without the bucket could not sign anyone in.
		expect(sessionStore({ store: "r2", days: 30 }, { production: PROD, staging: { ...STG, sessions: undefined } }, ["staging", "production"])).toEqual({ store: "kv", missing: ["staging"] });
		expect(sessionStore({ store: "kv", days: 30 }, { production: PROD }, ["production"])).toEqual({ store: "kv", missing: [] });
	});
});

describe("astro.config session lines", () => {
	it("R2: the R2 binding driver on SESSIONS, the adapter told to inject that binding, ttl = lifecycle days", () => {
		const s = astroSessions("r2", 30);
		expect(s.adapter).toBe('cloudflare({ sessionKVBindingName: "SESSIONS" })');
		expect(s.options).toContain('session: { driver: sessionDrivers.cloudflareR2Binding({ binding: "SESSIONS" }), ttl: 2592000 },');
		expect(astroSessions("r2", 14).options).toContain("ttl: 1209600");
	});
	it("KV: the adapter default, unchanged (no session option)", () => {
		expect(astroSessions("kv", 30)).toEqual({ adapter: "cloudflare()", options: "" });
	});
});

describe("wrangler.jsonc session bindings", () => {
	it("R2: SESSIONS bucket next to MEDIA, no SESSION KV (top level and env.staging)", () => {
		const w = parseJsonc(wranglerJsonc({ ...base, config: config({ target: { productionUrl: "https://acme.example", staging: true } }), cf: { production: PROD, staging: STG }, staging: true, sessions: "r2" }));
		expect(w.r2_buckets).toEqual([{ binding: "MEDIA", bucket_name: "acme-media" }, { binding: "SESSIONS", bucket_name: "acme-sessions" }]);
		expect(w.kv_namespaces).toEqual([{ binding: "FORM_OUTBOX", id: "kv-out" }]);
		expect(w.env.staging.r2_buckets).toEqual([{ binding: "MEDIA", bucket_name: "acme-stg-media" }, { binding: "SESSIONS", bucket_name: "acme-staging-sessions" }]);
		expect(w.env.staging.kv_namespaces).toEqual([{ binding: "FORM_OUTBOX", id: "kv-out-stg" }]);
	});
	it("KV (opt-out or fallback): SESSION KV bound explicitly as before, no SESSIONS bucket", () => {
		const w = parseJsonc(wranglerJsonc({ ...base, config: config(), cf: { production: PROD }, staging: false, sessions: "kv" }));
		expect(w.r2_buckets).toEqual([{ binding: "MEDIA", bucket_name: "acme-media" }]);
		expect(w.kv_namespaces).toEqual([{ binding: "FORM_OUTBOX", id: "kv-out" }, { binding: "SESSION", id: "kv-sess" }]);
		// Callers that do not say (older code paths) keep the KV behaviour.
		expect(parseJsonc(wranglerJsonc({ ...base, config: config(), cf: { production: PROD }, staging: false })).kv_namespaces).toContainEqual({ binding: "SESSION", id: "kv-sess" });
		expect(kvBindings({ production: PROD }, "production", false, false)).toEqual([]);
	});
});
