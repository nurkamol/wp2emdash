import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { dnsDiff, golive, noindexIn } from "../src/commands/golive.js";
import { initSite } from "../src/commands/init.js";
import { sitePaths } from "../src/core/paths.js";
import { readState, writeState } from "../src/core/state.js";
import { runbook } from "../src/phases/cutover.js";

const GOLIVE = "golive-token-value-for-tests-only";
const vars = { site: { CLOUDFLARE_GOLIVE_TOKEN: GOLIVE }, merged: { CLOUDFLARE_GOLIVE_TOKEN: GOLIVE, CLOUDFLARE_API_TOKEN: "build-token-value", EMDASH_TOKEN_PRODUCTION: "ec_test" } };
const PAGES = ["/", "/about/", "/contact/"];
const MAIL = [{ id: "m1", type: "MX", name: "acme.example", content: "mail.example", ttl: 1, priority: 10 }, { id: "t1", type: "TXT", name: "acme.example", content: "v=spf1 -all", ttl: 1 }];
const WEB = [{ id: "a1", type: "A", name: "acme.example", content: "192.0.2.10", ttl: 1, proxied: true }, { id: "c1", type: "CNAME", name: "www.acme.example", content: "acme.example", ttl: 1, proxied: true }];
const ALIAS_DNS = [{ id: "a2", type: "A", name: "old.example", content: "192.0.2.20", ttl: 1, proxied: true }, { id: "m2", type: "MX", name: "old.example", content: "mx.old.example", ttl: 1, priority: 0 }];

interface World {
	routes: { id: string; pattern: string; script?: string }[];
	staging: boolean;
	/** Number of smoke passes that still see noindex (isolate caching). */
	noindexPasses: number;
	dns: typeof MAIL;
	aliasRuleset?: { id: string; rules: { id: string; ref?: string; expression: string }[] };
	/** The primary zone's redirect entry point (www ↔ apex rule). */
	hostRuleset?: { id: string; rules: { id: string; ref?: string; expression: string; action?: string; action_parameters?: unknown }[] };
	calls: string[];
	redirectLive: boolean;
}

function fakeFetch(w: World) {
	let homeHits = 0;
	const json = (result: unknown, status = 200) => new Response(JSON.stringify({ success: status < 400, result, errors: status < 400 ? [] : [{ code: 1, message: `HTTP ${status}` }] }), { status, headers: { "content-type": "application/json" } });
	return (async (input: string, init?: RequestInit) => {
		const url = new URL(input);
		const method = init?.method ?? "GET";
		if (url.hostname === "api.cloudflare.com") {
			const p = url.pathname.replace("/client/v4", "");
			w.calls.push(`${method} ${p}`);
			if (p === "/zones") return json(url.searchParams.get("name") === "acme.example" ? [{ id: "z1", status: "active" }] : url.searchParams.get("name") === "old.example" ? [{ id: "z2", status: "active" }] : []);
			if (p === "/zones/z1/workers/routes" && method === "GET") return json(w.routes);
			if (p === "/zones/z1/workers/routes" && method === "POST") {
				const body = JSON.parse(String(init?.body));
				const r = { id: `r${w.routes.length + 1}`, pattern: body.pattern, script: body.script };
				w.routes.push(r);
				return json(r);
			}
			if (p.startsWith("/zones/z1/workers/routes/") && method === "DELETE") {
				const id = p.split("/").pop();
				const had = w.routes.some((r) => r.id === id);
				w.routes = w.routes.filter((r) => r.id !== id);
				return had ? json({ id }) : json(null, 404);
			}
			if (p === "/zones/z1/rulesets/phases/http_request_dynamic_redirect/entrypoint" && method === "GET") return w.hostRuleset ? json(w.hostRuleset) : json(null, 404);
			if (p === "/zones/z1/rulesets/phases/http_request_dynamic_redirect/entrypoint" && method === "PUT") {
				const body = JSON.parse(String(init?.body));
				w.hostRuleset = { id: "hrs-new", rules: body.rules.map((r: { ref: string; expression: string }, i: number) => ({ ...r, id: `hrule-${i}` })) };
				return json(w.hostRuleset);
			}
			if (p === `/zones/z1/rulesets/${w.hostRuleset?.id}/rules` && method === "POST") {
				const body = JSON.parse(String(init?.body));
				w.hostRuleset?.rules.push({ ...body, id: "hrule-ours" });
				return json(w.hostRuleset);
			}
			if (p.startsWith("/zones/z1/rulesets/") && method === "DELETE") {
				const id = p.split("/").pop();
				if (w.hostRuleset) w.hostRuleset.rules = w.hostRuleset.rules.filter((r) => r.id !== id);
				return json(w.hostRuleset);
			}
			if (p === "/zones/z1/dns_records") return json([...WEB, ...w.dns]);
			if (p === "/zones/z2/dns_records") return json(ALIAS_DNS);
			if (p === "/zones/z2/rulesets/phases/http_request_dynamic_redirect/entrypoint" && method === "GET") return w.aliasRuleset ? json(w.aliasRuleset) : json(null, 404);
			if (p === "/zones/z2/rulesets/phases/http_request_dynamic_redirect/entrypoint" && method === "PUT") {
				const body = JSON.parse(String(init?.body));
				w.aliasRuleset = { id: "rs-new", rules: body.rules.map((r: { ref: string; expression: string }, i: number) => ({ ...r, id: `rule-${i}` })) };
				w.redirectLive = true;
				return json(w.aliasRuleset);
			}
			if (p === `/zones/z2/rulesets/${w.aliasRuleset?.id}/rules` && method === "POST") {
				const body = JSON.parse(String(init?.body));
				w.aliasRuleset?.rules.push({ ...body, id: "rule-ours" });
				w.redirectLive = true;
				return json(w.aliasRuleset);
			}
			if (p.startsWith("/zones/z2/rulesets/") && method === "DELETE") {
				const id = p.split("/").pop();
				if (w.aliasRuleset) w.aliasRuleset.rules = w.aliasRuleset.rules.filter((r) => r.id !== id);
				return json(w.aliasRuleset);
			}
			return json(null, 404);
		}
		if (url.hostname === "acme.w.workers.dev" && url.pathname === "/_emdash/api/settings") return new Response(JSON.stringify({ data: { staging: w.staging } }), { headers: { "content-type": "application/json" } });
		if (url.hostname === "www.acme.example" || url.protocol === "http:") return new Response(null, { status: 301, headers: { location: `https://acme.example${url.pathname}` } });
		if (url.hostname === "acme.example") {
			if (url.pathname === "/") homeHits++;
			const noindex = homeHits <= w.noindexPasses;
			return new Response(`<html><head><link rel="canonical" href="https://acme.example${url.pathname}">${noindex ? '<meta name="robots" content="noindex, nofollow">' : ""}</head><body>ok</body></html>`, { status: 200, headers: { "content-type": "text/html" } });
		}
		if (url.hostname === "old.example" || url.hostname === "www.old.example")
			return w.redirectLive ? new Response(null, { status: 301, headers: { location: `https://acme.example${url.pathname}${url.search}` } }) : new Response("wordpress", { status: 200 });
		return new Response("not found", { status: 404 });
	}) as (input: string, init?: RequestInit) => Promise<Response>;
}

describe("golive", () => {
	let dir: string;
	let w: World;
	const paths = () => sitePaths("acme", dir);
	const cf = () => JSON.parse(readFileSync(join(paths().root, "cloudflare.json"), "utf8"));
	const record = () => JSON.parse(readFileSync(join(paths().root, "cutover", "golive.json"), "utf8"));
	const run = (o: Parameters<typeof golive>[1] = {}) => golive("acme", { sitesDir: dir, vars, fetch: fakeFetch(w), sleep: async () => {}, attempts: 3, retryMs: 0, ...o });

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "wp2emdash-golive-"));
		initSite({ slug: "acme", name: "Acme", sourceUrl: "https://acme.example", productionUrl: "https://acme.example", sensitiveData: false }, dir);
		const p = paths();
		const config = readFileSync(p.config, "utf8").replace(/\/\/ aliasDomains: \[[^\]]*\],[^\n]*/, 'aliasDomains: ["old.example"],');
		writeFileSync(p.config, config);
		const state = readState(p.state);
		state.phases.cutover = { status: "passed", checks: [] };
		writeState(p.state, state);
		writeFileSync(join(p.root, "cloudflare.json"), `${JSON.stringify({ production: { accountId: "acct", worker: { name: "acme", url: "https://acme.w.workers.dev" } } }, null, "\t")}\n`);
		mkdirSync(p.snapshot, { recursive: true });
		writeFileSync(join(p.snapshot, "urls.json"), JSON.stringify(PAGES.map((path) => ({ url: `https://acme.example${path}`, path, status: 200, kind: "page" }))));
		mkdirSync(join(p.root, "cutover"), { recursive: true });
		writeFileSync(join(p.root, "cutover", "dns-before.json"), JSON.stringify({ zone: "acme.example", web: WEB.map(({ type, name, content, proxied }) => ({ type, name, content, proxied })), keep: MAIL.map(({ id: _id, ...r }) => r) }));
		writeFileSync(join(p.root, "cutover", "dns-before.old.example.json"), JSON.stringify({ zone: "old.example", records: ALIAS_DNS.map(({ id: _id, ...r }) => ({ ...r, ...(r.type === "MX" ? { mail: true } : {}) })) }));
		w = { routes: [], staging: false, noindexPasses: 0, dns: [...MAIL], calls: [], redirectLive: false };
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("without --yes prints the plan and changes nothing", async () => {
		const lines: string[] = [];
		const r = await run({ log: (l) => lines.push(l) });
		expect(r.applied).toBe(false);
		expect(r.plan.join("\n")).toContain("Create Worker route acme.example/* → acme");
		expect(r.plan.join("\n")).toContain("Create Worker route www.acme.example/* → acme");
		expect(lines.join("\n")).toMatch(/Nothing changed.*owner's explicit go-ahead.*--yes/s);
		expect(w.calls.filter((c) => !c.startsWith("GET"))).toEqual([]);
		expect(cf().production.live).toBeUndefined();
	});

	it("refuses when the last cutover preflight did not pass", async () => {
		const state = readState(paths().state);
		state.phases.cutover = { status: "failed", checks: [] };
		writeState(paths().state, state);
		await expect(run({ yes: true })).rejects.toThrow(/cutover preflight did not pass/);
		expect(w.calls).toEqual([]);
	});

	it("refuses a go-live token identical to the build token, without printing it", async () => {
		const p = run({ yes: true, vars: { site: vars.site, merged: { ...vars.merged, CLOUDFLARE_API_TOKEN: GOLIVE } } });
		await expect(p).rejects.toThrow(/identical to CLOUDFLARE_API_TOKEN/);
		await expect(run({ yes: true, vars: { site: vars.site, merged: { ...vars.merged, CLOUDFLARE_API_TOKEN: GOLIVE } } })).rejects.not.toThrow(new RegExp(GOLIVE));
	});

	it("refuses while production is still marked staging (noindex)", async () => {
		w.staging = true;
		const r = await run({ yes: true });
		expect(r.applied).toBe(false);
		expect(r.blockers.join(" ")).toMatch(/not marked staging/);
		expect(w.routes).toEqual([]);
	});

	it("stops before any change when a route on the domain points at another Worker", async () => {
		w.routes = [{ id: "x", pattern: "www.acme.example/*", script: "someone-else" }];
		const r = await run({ yes: true });
		expect(r.applied).toBe(false);
		expect(r.blockers.join(" ")).toMatch(/points at "someone-else"/);
		expect(w.calls.filter((c) => c.startsWith("POST"))).toEqual([]);
	});

	it("creates both routes, smoke-tests, compares DNS, sets live and records route ids", async () => {
		const r = await run({ yes: true, now: () => new Date("2026-11-21T10:00:00Z") });
		expect(r.ok).toBe(true);
		expect(w.routes.map((x) => `${x.pattern}→${x.script}`)).toEqual(["acme.example/*→acme", "www.acme.example/*→acme"]);
		expect(r.checks.map((c) => `${c.id}:${c.ok}`)).toEqual(["indexable:true", "smoke:true", "no-noindex:true", "dns-unchanged:true", "site-url:true"]);
		expect(cf().production).toMatchObject({ live: true, liveSince: "2026-11-21" });
		expect(readFileSync(join(paths().root, "cloudflare.json"), "utf8")).toContain('\n\t"production"'); // tabs kept
		expect(record().routes.map((x: { id: string; adopted: boolean }) => `${x.id}:${x.adopted}`)).toEqual(["r1:false", "r2:false"]);
		expect(r.next.join(" ")).toContain("golive acme --aliases");
	});

	it("records the owner's approval and the step's checks in golive.json (only when applied)", async () => {
		const approval = { by: "Op Erator", text: "Jane Owner, email 2026-11-21 09:00: go", via: "dashboard" };
		await run({ approval }); // plan only: nothing recorded
		expect(existsSync(join(paths().root, "cutover", "golive.json"))).toBe(false);
		await run({ yes: true, approval, now: () => new Date("2026-11-21T10:00:00Z") });
		expect(record().approvals).toEqual([{ at: "2026-11-21T10:00:00.000Z", step: "primary", by: "Op Erator", approval: "Jane Owner, email 2026-11-21 09:00: go", via: "dashboard" }]);
		expect(record().history[0].action).toBe("primary approved by Op Erator (dashboard)");
		expect(record().lastChecks.checks.map((c: { id: string }) => c.id)).toContain("dns-unchanged");
		await run({ rollback: true, yes: true, approval: { ...approval, text: "Jane Owner, phone 2026-11-22: roll back" } });
		expect(record().approvals.map((a: { step: string }) => a.step)).toEqual(["primary", "rollback"]);
	});

	it("is idempotent: a route already pointing at the Worker is kept and recorded, not created again", async () => {
		w.routes = [{ id: "hand", pattern: "acme.example/*", script: "acme" }];
		const r = await run({ yes: true });
		expect(r.ok).toBe(true);
		expect(w.calls.filter((c) => c.startsWith("POST"))).toEqual(["POST /zones/z1/workers/routes"]);
		expect(record().routes.map((x: { id: string; adopted: boolean }) => `${x.id}:${x.adopted}`)).toEqual(["hand:true", "r2:false"]);
	});

	it("rides out isolates that still serve noindex, then passes", async () => {
		w.noindexPasses = 2;
		const r = await run({ yes: true });
		expect(r.ok).toBe(true);
		expect(cf().production.live).toBe(true);
	});

	it("keeps live off and says to redeploy when noindex persists", async () => {
		w.noindexPasses = 99;
		const r = await run({ yes: true });
		expect(r.applied).toBe(true);
		expect(r.ok).toBe(false);
		expect(r.checks.find((c) => c.id === "no-noindex")?.detail).toMatch(/redeploy production/);
		expect(cf().production.live).toBeUndefined();
		expect(record().routes).toHaveLength(2); // rollback still knows them
	});

	it("reports a DNS record that changed since the preflight", async () => {
		w.dns = [MAIL[0] as (typeof MAIL)[number], { id: "t1", type: "TXT", name: "acme.example", content: "v=spf1 include:other -all", ttl: 1 }];
		const r = await run({ yes: true });
		const dns = r.checks.find((c) => c.id === "dns-unchanged");
		expect(dns?.ok).toBe(false);
		expect(dns?.detail).toMatch(/added: TXT acme\.example; removed: TXT acme\.example/);
	});

	it("adds the www → apex redirect rule before the routes (the cache shares pages between hosts) and records it", async () => {
		const r = await run({ yes: true });
		expect(r.ok).toBe(true);
		const put = w.calls.indexOf("PUT /zones/z1/rulesets/phases/http_request_dynamic_redirect/entrypoint");
		expect(put).toBeGreaterThan(-1);
		expect(put).toBeLessThan(w.calls.indexOf("POST /zones/z1/workers/routes"));
		expect(w.hostRuleset?.rules).toMatchObject([{ ref: "wp2emdash_host_www_acme_example", expression: '(http.host eq "www.acme.example")' }]);
		expect(record().hostRule).toMatchObject({ alias: "www.acme.example", ruleId: "hrule-0", adopted: false, createdEntrypoint: true });
	});

	it("adopts an equivalent rule made by hand instead of adding a second one; other rules stay", async () => {
		w.hostRuleset = { id: "hrs1", rules: [{ id: "keep", expression: '(http.host eq "promo.acme.example")', action: "redirect" }, { id: "byhand", expression: '(http.host eq "www.acme.example")', action: "redirect", action_parameters: { from_value: { target_url: { expression: 'concat("https://acme.example", http.request.uri.path)' } } } }] };
		const r = await run({ yes: true });
		expect(r.ok).toBe(true);
		expect(w.calls.some((c) => c.includes("/rulesets/") && !c.startsWith("GET"))).toBe(false);
		expect(record().hostRule).toMatchObject({ ruleId: "byhand", adopted: true });
		await run({ rollback: true, yes: true });
		expect(w.hostRuleset.rules.map((x) => x.id)).toEqual(["keep"]);
	});

	it("rollback deletes exactly the recorded routes and sets live = false", async () => {
		await run({ yes: true });
		w.routes.push({ id: "other", pattern: "acme.example/api/*", script: "acme" }); // not ours to delete
		const dry = await run({ rollback: true });
		expect(dry.applied).toBe(false);
		expect(w.routes).toHaveLength(3);
		const r = await run({ rollback: true, yes: true });
		expect(r.ok).toBe(true);
		expect(w.routes.map((x) => x.id)).toEqual(["other"]);
		expect(w.calls.filter((c) => c.startsWith("DELETE"))).toEqual(["DELETE /zones/z1/workers/routes/r1", "DELETE /zones/z1/workers/routes/r2", "DELETE /zones/z1/rulesets/hrs-new/rules/hrule-0"]);
		expect(w.hostRuleset?.rules).toEqual([]);
		expect(cf().production.live).toBe(false);
		expect(cf().production.liveSince).toBeUndefined();
	});

	describe("aliases", () => {
		it("refuses until the primary is live", async () => {
			const r = await run({ aliases: true, yes: true });
			expect(r.applied).toBe(false);
			expect(r.blockers.join(" ")).toMatch(/primary is not live/);
		});

		it("appends the rule to an existing entry point (other rules stay), checks redirects and DNS", async () => {
			await run({ yes: true });
			w.aliasRuleset = { id: "rs1", rules: [{ id: "keep-me", ref: "theirs", expression: 'http.host eq "shop.old.example"' }] };
			const dry = await run({ aliases: true });
			expect(dry.plan[0]).toMatch(/append one Single Redirect rule .* to ruleset rs1; its 1 other rule\(s\) stay/);
			const r = await run({ aliases: true, yes: true });
			expect(r.ok).toBe(true);
			expect(w.calls).toContain("POST /zones/z2/rulesets/rs1/rules");
			expect(w.calls.some((c) => c.startsWith("PUT /zones/z2"))).toBe(false);
			expect(w.aliasRuleset?.rules.map((x) => x.id)).toEqual(["keep-me", "rule-ours"]);
			expect(r.checks.map((c) => `${c.id}:${c.ok}`)).toEqual(["alias-redirects:true", "dns-unchanged:old.example:true"]);
			expect(record().aliasRules[0]).toMatchObject({ alias: "old.example", rulesetId: "rs1", ruleId: "rule-ours", createdEntrypoint: false });
		});

		it("creates the entry point only when the zone has none", async () => {
			await run({ yes: true });
			const r = await run({ aliases: true, yes: true });
			expect(r.ok).toBe(true);
			expect(w.calls).toContain("PUT /zones/z2/rulesets/phases/http_request_dynamic_redirect/entrypoint");
			expect(record().aliasRules[0]).toMatchObject({ rulesetId: "rs-new", createdEntrypoint: true });
		});

		it("rollback --aliases deletes only the alias rule and leaves the primary live", async () => {
			await run({ yes: true });
			w.aliasRuleset = { id: "rs1", rules: [{ id: "keep-me", ref: "theirs", expression: "x" }] };
			await run({ aliases: true, yes: true });
			const r = await run({ rollback: true, aliases: true, yes: true });
			expect(r.ok).toBe(true);
			expect(w.aliasRuleset?.rules.map((x) => x.id)).toEqual(["keep-me"]);
			expect(w.routes).toHaveLength(2);
			expect(cf().production.live).toBe(true);
		});
	});
});

describe("golive helpers", () => {
	it("finds noindex in the robots meta (either attribute order) and in X-Robots-Tag", () => {
		expect(noindexIn('<meta content="noindex,follow" name="robots">', null)).toHaveLength(1);
		expect(noindexIn('<meta name="robots" content="index, follow">', "noindex")).toEqual(["X-Robots-Tag: noindex"]);
		expect(noindexIn('<meta name="description" content="noindex in text">', null)).toEqual([]);
	});
	it("diffs DNS as a multiset", () => {
		expect(dnsDiff(["a", "b", "b"], ["b", "a", "c"])).toEqual({ added: ["c"], removed: ["b"] });
	});
	it("the runbook points at golive and its rollback", () => {
		const md = runbook({ domain: "example.com", worker: "example", zoneId: "z", apexFirst: true });
		expect(md).toContain("pnpm wp2emdash golive <slug> --yes");
		expect(md).toContain("--rollback --yes");
	});
});
