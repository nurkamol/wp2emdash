import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initSite } from "../src/commands/init.js";
import { credentialsFor, provision } from "../src/commands/provision.js";
import { sitePaths } from "../src/core/paths.js";

describe("credentialsFor", () => {
	const shared = { CLOUDFLARE_API_TOKEN: "shared", CLOUDFLARE_ACCOUNT_ID: "agency" };
	it("uses the shared pair when no environment-specific one is set", () => {
		expect(credentialsFor("production", shared)).toEqual({ token: "shared", accountId: "agency", scoped: false });
	});
	it("prefers CLOUDFLARE_*_PRODUCTION for production only", () => {
		const vars = { ...shared, CLOUDFLARE_API_TOKEN_PRODUCTION: "client", CLOUDFLARE_ACCOUNT_ID_PRODUCTION: "client-acct" };
		expect(credentialsFor("production", vars)).toEqual({ token: "client", accountId: "client-acct", scoped: true });
		expect(credentialsFor("staging", vars)).toEqual({ token: "shared", accountId: "agency", scoped: false });
	});
	it("falls back to the account recorded for the environment", () => {
		expect(credentialsFor("production", { CLOUDFLARE_API_TOKEN: "t" }, { accountId: "legacy", production: { accountId: "client-acct" } }).accountId).toBe("client-acct");
		expect(credentialsFor("production", { CLOUDFLARE_API_TOKEN: "t" }, { accountId: "legacy" }).accountId).toBe("legacy");
	});
});

describe("provision", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "wp2emdash-prov-"));
		initSite({ slug: "acme", name: "Acme", sourceUrl: "https://acme.example", productionUrl: "https://acme.example", sensitiveData: false }, dir);
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	/** A fake Cloudflare API: records calls, knows which resources already exist. */
	function fakeApi(existing: { d1?: string[]; r2?: string[]; kv?: string[]; lifecycle?: Record<string, unknown[]>; publicDev?: string[]; customDomains?: Record<string, string[]> } = {}) {
		const calls: string[] = [];
		const bodies: Record<string, unknown> = {};
		const json = (result: unknown, status = 200) => new Response(JSON.stringify({ success: status < 400, result, errors: status < 400 ? [] : [{ code: 1, message: "nope" }] }), { status });
		const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			const method = init?.method ?? "GET";
			calls.push(`${method} ${url.pathname}`);
			if (init?.body) bodies[`${method} ${url.pathname}`] = JSON.parse(String(init.body));
			const p = url.pathname.replace("/client/v4", "");
			const bucketOf = () => decodeURIComponent(p.split("/r2/buckets/")[1]?.split("/")[0] ?? "");
			// New buckets come with R2's default multipart-abort rule.
			if (p.endsWith("/lifecycle") && method === "GET") return json({ rules: existing.lifecycle?.[bucketOf()] ?? [{ id: "Default Multipart Abort Rule", enabled: true, conditions: {}, abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 604800 } } }] });
			if (p.endsWith("/lifecycle")) return json({});
			if (p.endsWith("/domains/managed") && method === "GET") return json({ enabled: (existing.publicDev ?? []).includes(bucketOf()), domain: "pub-x.r2.dev" });
			if (p.endsWith("/domains/managed")) return json({ enabled: false });
			if (p.endsWith("/domains/custom")) return json({ domains: (existing.customDomains?.[bucketOf()] ?? []).map((domain) => ({ domain })) });
			if (p === "/accounts/client-acct") return json({ name: "Client" });
			if (p === "/accounts/agency") return json({ name: "Agency" });
			if (p.endsWith("/d1/database") && method === "GET") return json((existing.d1 ?? []).filter((n) => n === url.searchParams.get("name")).map((name) => ({ name, uuid: `uuid-${name}` })));
			if (p.endsWith("/d1/database")) return json({ uuid: "new-d1" });
			if (p.includes("/r2/buckets/")) return (existing.r2 ?? []).includes(decodeURIComponent(p.split("/").pop() ?? "")) ? json({}) : json(null, 404);
			if (p.endsWith("/r2/buckets")) return json({});
			if (p.endsWith("/storage/kv/namespaces") && method === "GET") {
				const page = Number(url.searchParams.get("page") ?? 1);
				// Many namespaces in the account: the one looked for may be on a later page.
				const all = [...Array.from({ length: 130 }, (_, i) => `other-${i}`), ...(existing.kv ?? [])].map((title) => ({ title, id: `kv-${title}` }));
				return new Response(JSON.stringify({ success: true, result: all.slice((page - 1) * 100, page * 100), result_info: { page, total_pages: Math.ceil(all.length / 100) } }));
			}
			if (p.endsWith("/storage/kv/namespaces")) return json({ id: `new-kv-${JSON.parse(String(init?.body)).title}` });
			if (p.endsWith("/workers/subdomain")) return json({ subdomain: "client" });
			return json(null, 404);
		}) as typeof fetch;
		return { calls, bodies, fetcher };
	}
	const setConfig = (from: string, to: string) => {
		const config = join(dir, "acme", "kit.config.ts");
		writeFileSync(config, readFileSync(config, "utf8").replace(from, to));
	};
	const vars = { CLOUDFLARE_API_TOKEN: "shared", CLOUDFLARE_ACCOUNT_ID: "agency", CLOUDFLARE_API_TOKEN_PRODUCTION: "client", CLOUDFLARE_ACCOUNT_ID_PRODUCTION: "client-acct" };
	const cfFile = () => join(sitePaths("acme", dir).root, "cloudflare.json");

	it("creates production in the client's account and keeps the old account's resources under previous", async () => {
		writeFileSync(cfFile(), JSON.stringify({ accountId: "agency", accountName: "Agency", production: { d1: { name: "acme-db", id: "old-d1", location: "weur" }, r2: { bucket: "acme-media", location: "weur" }, worker: { name: "acme" } } }));
		const api = fakeApi();
		const r = await provision("acme", "production", { sitesDir: dir, vars }, api.fetcher);
		expect(r).toMatchObject({ accountId: "client-acct", accountName: "Client", movedFrom: "agency", created: ["D1 acme-db", "R2 acme-media", "R2 acme-sessions", "KV acme-form-outbox", "D1 acme-restore-drill-db"] });
		const cf = JSON.parse(readFileSync(cfFile(), "utf8"));
		expect(cf.accountId).toBe("agency");
		expect(cf.production).toMatchObject({ accountId: "client-acct", d1: { id: "new-d1", location: "weur" }, r2: { bucket: "acme-media" }, worker: { url: "https://acme.client.workers.dev" } });
		expect(cf.production.previous[0]).toMatchObject({ accountId: "agency", accountName: "Agency", d1: { id: "old-d1" } });
		expect(api.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
	});

	it("is idempotent: existing resources are reused, nothing created twice", async () => {
		const rule = { id: "wp2emdash-sessions-expire", enabled: true, conditions: {}, deleteObjectsTransition: { condition: { type: "Age", maxAge: 30 * 86400 } } };
		const api = fakeApi({ d1: ["acme-db", "acme-restore-drill-db"], r2: ["acme-media", "acme-sessions"], kv: ["acme-form-outbox"], lifecycle: { "acme-sessions": [rule] } });
		const r = await provision("acme", "production", { sitesDir: dir, vars }, api.fetcher);
		expect(r.created).toEqual([]);
		expect(r.reused).toEqual(["D1 acme-db", "R2 acme-media", "R2 acme-sessions", "KV acme-form-outbox", "D1 acme-restore-drill-db"]);
		expect(JSON.parse(readFileSync(cfFile(), "utf8")).production.d1.id).toBe("uuid-acme-db");
		expect(api.calls.filter((c) => !c.startsWith("GET"))).toEqual([]);
	});

	it("sessions on R2 (default): creates a private <worker>-sessions bucket next to the media bucket, with an expiry rule, and no SESSION KV", async () => {
		const api = fakeApi();
		const r = await provision("acme", "production", { sitesDir: dir, vars, location: "weur" }, api.fetcher);
		expect(r.created).toEqual(["D1 acme-db", "R2 acme-media", "R2 acme-sessions", "KV acme-form-outbox", "D1 acme-restore-drill-db"]);
		expect(api.bodies["POST /client/v4/accounts/client-acct/r2/buckets"]).toEqual({ name: "acme-sessions", locationHint: "weur" });
		// Lifecycle: read first, the default multipart rule kept, the kit's rule added (30 days by default).
		expect(api.bodies["PUT /client/v4/accounts/client-acct/r2/buckets/acme-sessions/lifecycle"]).toEqual({
			rules: [
				{ id: "Default Multipart Abort Rule", enabled: true, conditions: {}, abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 604800 } } },
				{ id: "wp2emdash-sessions-expire", enabled: true, conditions: {}, deleteObjectsTransition: { condition: { type: "Age", maxAge: 2592000 } } },
			],
		});
		// Never made public: no write to its domains, no lifecycle rule on the media bucket, no KV session namespace.
		expect(api.calls.filter((c) => c.includes("/domains/") && !c.startsWith("GET"))).toEqual([]);
		expect(api.calls.some((c) => c.includes("acme-media/lifecycle"))).toBe(false);
		expect(r.created.filter((x) => x.startsWith("KV ") && /session/.test(x))).toEqual([]);
		const cf = JSON.parse(readFileSync(cfFile(), "utf8"));
		expect(cf.production.sessions).toEqual({ bucket: "acme-sessions", location: "weur", days: 30 });
		expect(cf.production.session).toBeUndefined();
	});

	it("sessions.days changes the rule (replaced by id, others kept); an existing KV session record stays for a switch back", async () => {
		setConfig("target: {", "sessions: { days: 14 },\n\ttarget: {");
		writeFileSync(cfFile(), JSON.stringify({ production: { accountId: "client-acct", session: { name: "acme-session", id: "kv-1" } } }));
		const old = { id: "wp2emdash-sessions-expire", enabled: true, conditions: {}, deleteObjectsTransition: { condition: { type: "Age", maxAge: 30 * 86400 } } };
		const other = { id: "keep-me", enabled: true, conditions: { prefix: "x/" }, deleteObjectsTransition: { condition: { type: "Age", maxAge: 86400 } } };
		const api = fakeApi({ r2: ["acme-sessions"], lifecycle: { "acme-sessions": [other, old] } });
		await provision("acme", "production", { sitesDir: dir, vars }, api.fetcher);
		expect(api.bodies["PUT /client/v4/accounts/client-acct/r2/buckets/acme-sessions/lifecycle"]).toEqual({ rules: [other, { ...old, deleteObjectsTransition: { condition: { type: "Age", maxAge: 14 * 86400 } } }] });
		const cf = JSON.parse(readFileSync(cfFile(), "utf8"));
		expect(cf.production).toMatchObject({ sessions: { bucket: "acme-sessions", days: 14 }, session: { name: "acme-session", id: "kv-1" } });
	});

	it("keeps the sessions bucket private: switches public r2.dev access off, refuses a custom domain", async () => {
		const pub = fakeApi({ r2: ["acme-sessions"], publicDev: ["acme-sessions"] });
		const r = await provision("acme", "production", { sitesDir: dir, vars }, pub.fetcher);
		expect(pub.bodies["PUT /client/v4/accounts/client-acct/r2/buckets/acme-sessions/domains/managed"]).toEqual({ enabled: false });
		expect(r.notes.join(" ")).toMatch(/r2\.dev access was on; switched off/);
		const custom = fakeApi({ r2: ["acme-sessions"], customDomains: { "acme-sessions": ["sessions.acme.example"] } });
		await expect(provision("acme", "production", { sitesDir: dir, vars }, custom.fetcher)).rejects.toThrow(/served on sessions\.acme\.example/);
	});

	it("backups' restore test: an empty scratch D1 database for production only, recorded in cloudflare.json; never for staging or with the test off", async () => {
		setConfig("target: {", "target: {\n\t\tstaging: true,");
		const api = fakeApi();
		const prod = await provision("acme", "production", { sitesDir: dir, vars, location: "weur" }, api.fetcher);
		expect(prod.created).toContain("D1 acme-restore-drill-db");
		expect(api.bodies["POST /client/v4/accounts/client-acct/d1/database"]).toEqual({ name: "acme-restore-drill-db", primary_location_hint: "weur" });
		expect(JSON.parse(readFileSync(cfFile(), "utf8")).production.restoreDrill).toEqual({ name: "acme-restore-drill-db", id: "new-d1" });
		const staging = await provision("acme", "staging", { sitesDir: dir, vars }, api.fetcher);
		expect([...staging.created, ...staging.reused].filter((x) => x.includes("restore-drill"))).toEqual([]);
		expect(JSON.parse(readFileSync(cfFile(), "utf8")).staging.restoreDrill).toBeUndefined();
		expect(api.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
	});

	it("backups' restore test off (or backups off): no scratch database", async () => {
		setConfig("target: {", "backups: { restoreDrill: false },\n\ttarget: {");
		const api = fakeApi();
		const r = await provision("acme", "production", { sitesDir: dir, vars }, api.fetcher);
		expect([...r.created, ...r.reused].filter((x) => x.includes("restore-drill"))).toEqual([]);
		expect(JSON.parse(readFileSync(cfFile(), "utf8")).production.restoreDrill).toBeUndefined();
	});

	it("refuses staging on a single-environment site (the default) and creates production only", async () => {
		const api = fakeApi();
		await expect(provision("acme", "staging", { sitesDir: dir, vars }, api.fetcher)).rejects.toThrow(/staging is opt-in/);
		expect(api.calls).toEqual([]);
		await provision("acme", "production", { sitesDir: dir, vars }, api.fetcher);
		expect(Object.keys(JSON.parse(readFileSync(cfFile(), "utf8")))).toEqual(["production"]);
	});

	it("sessions: \"kv\" binds SESSION explicitly: creates <worker>-session per environment, or reuses the one Wrangler auto-provisioned (found by title)", async () => {
		// Opt into staging (target.staging: true) and keep sessions on KV.
		setConfig("target: {", 'sessions: "kv",\n\ttarget: {\n\t\tstaging: true,');
		const api = fakeApi({ kv: ["acme-staging-session"] });
		const staging = await provision("acme", "staging", { sitesDir: dir, vars }, api.fetcher);
		expect(staging.reused).toContain("KV acme-staging-session");
		const prod = await provision("acme", "production", { sitesDir: dir, vars }, api.fetcher);
		expect(prod.created).toContain("KV acme-session");
		const cf = JSON.parse(readFileSync(cfFile(), "utf8"));
		expect(cf.staging.session).toEqual({ name: "acme-staging-session", id: "kv-acme-staging-session" });
		expect(cf.production.session).toEqual({ name: "acme-session", id: "new-kv-acme-session" });
		// Rerun: the recorded namespace is found again, nothing new.
		const again = await provision("acme", "staging", { sitesDir: dir, vars }, api.fetcher);
		expect(again.created).toEqual(expect.not.arrayContaining(["KV acme-staging-session"]));
	});

	it("refuses without a token for the environment", async () => {
		await expect(provision("acme", "production", { sitesDir: dir, vars: {} }, fakeApi().fetcher)).rejects.toThrow(/CLOUDFLARE_API_TOKEN_PRODUCTION/);
	});
});
