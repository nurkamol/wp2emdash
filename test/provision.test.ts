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
	function fakeApi(existing: { d1?: string[]; r2?: string[]; kv?: string[] } = {}) {
		const calls: string[] = [];
		const json = (result: unknown, status = 200) => new Response(JSON.stringify({ success: status < 400, result, errors: status < 400 ? [] : [{ code: 1, message: "nope" }] }), { status });
		const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
			const url = new URL(String(input));
			const method = init?.method ?? "GET";
			calls.push(`${method} ${url.pathname}`);
			const p = url.pathname.replace("/client/v4", "");
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
		return { calls, fetcher };
	}
	const vars = { CLOUDFLARE_API_TOKEN: "shared", CLOUDFLARE_ACCOUNT_ID: "agency", CLOUDFLARE_API_TOKEN_PRODUCTION: "client", CLOUDFLARE_ACCOUNT_ID_PRODUCTION: "client-acct" };
	const cfFile = () => join(sitePaths("acme", dir).root, "cloudflare.json");

	it("creates production in the client's account and keeps the old account's resources under previous", async () => {
		writeFileSync(cfFile(), JSON.stringify({ accountId: "agency", accountName: "Agency", production: { d1: { name: "acme-db", id: "old-d1", location: "weur" }, r2: { bucket: "acme-media", location: "weur" }, worker: { name: "acme" } } }));
		const api = fakeApi();
		const r = await provision("acme", "production", { sitesDir: dir, vars }, api.fetcher);
		expect(r).toMatchObject({ accountId: "client-acct", accountName: "Client", movedFrom: "agency", created: ["D1 acme-db", "R2 acme-media", "KV acme-session"] });
		const cf = JSON.parse(readFileSync(cfFile(), "utf8"));
		expect(cf.accountId).toBe("agency");
		expect(cf.production).toMatchObject({ accountId: "client-acct", d1: { id: "new-d1", location: "weur" }, r2: { bucket: "acme-media" }, worker: { url: "https://acme.client.workers.dev" } });
		expect(cf.production.previous[0]).toMatchObject({ accountId: "agency", accountName: "Agency", d1: { id: "old-d1" } });
		expect(api.calls.some((c) => c.startsWith("DELETE"))).toBe(false);
	});

	it("is idempotent: existing resources are reused, nothing created twice", async () => {
		const api = fakeApi({ d1: ["acme-db"], r2: ["acme-media"], kv: ["acme-session"] });
		const r = await provision("acme", "production", { sitesDir: dir, vars }, api.fetcher);
		expect(r.created).toEqual([]);
		expect(r.reused).toEqual(["D1 acme-db", "R2 acme-media", "KV acme-session"]);
		expect(JSON.parse(readFileSync(cfFile(), "utf8")).production.d1.id).toBe("uuid-acme-db");
		expect(api.calls.filter((c) => c.startsWith("POST"))).toEqual([]);
	});

	it("binds SESSION explicitly: creates <worker>-session per environment, or reuses the one Wrangler auto-provisioned (found by title)", async () => {
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
