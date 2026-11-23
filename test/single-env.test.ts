/**
 * Single environment by default (owner decision 2026-11-20): one Cloudflare environment per site — production, on its
 * workers.dev address until go-live — with staging opt-in. Covers the environment rules, the generated wrangler.jsonc,
 * package scripts and client CI, the pre-launch / preview form safety (test messages never reach the client, also
 * after launch) and the live-production reload guard (--force + D1 Time Travel bookmark). Synthetic data only.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFormEndpoint } from "../packages/forms/src/endpoint.js";
import type { FormDefinition } from "../packages/forms/src/index.js";
import { flushOutbox, isTestRequest, type KvLike, type Queued, sendQueued } from "../packages/forms/src/outbox.js";
import { kitConfigSchema } from "../src/config/schema.js";
import { defaultTarget, siteEnvironments } from "../src/core/environments.js";
import { sitePaths } from "../src/core/paths.js";
import { runLoad } from "../src/phases/load.js";
import { workerVars, wranglerJsonc } from "../src/phases/scaffold.js";
import { type ClientRepoInput, clientRepoFiles, deployScripts } from "../src/scaffold/client-repo.js";
import { guardLiveProductionWrite, restoreCommand } from "../src/targets/d1-backup.js";
import { remoteTarget } from "../src/targets/remote.js";
import { env } from "./stubs/cloudflare-workers.js";

const config = (target: Record<string, unknown> = {}, email: Record<string, unknown> = {}) =>
	kitConfigSchema.parse({ slug: "acme", name: "Acme", source: { url: "https://acme.example" }, target: { productionUrl: "https://acme.example", ...target }, email: { from: "Acme <noreply@acme.example>", to: ["owner@acme.example"], stagingTo: ["dev@agency.example"], ...email }, forms: { outbox: { days: 30 } } });
const PROD = { d1: { name: "acme-db", id: "d1-prod" }, r2: { bucket: "acme-media" }, worker: { url: "https://acme.agency.workers.dev" }, session: { id: "kv-sess" }, outbox: { id: "kv-out" } };
/** wrangler.jsonc without its comments, parsed. */
const parseJsonc = (s: string) => JSON.parse(s.replace(/^\s*\/\/.*$/gm, "")) as Record<string, any>;

describe("environments", () => {
	it("defaults to one environment; staging is opt-in, and existing staging sites keep it", () => {
		expect(siteEnvironments(config()).staging).toBe(false);
		expect(siteEnvironments(config({ staging: true }))).toMatchObject({ staging: true, why: "config" });
		expect(siteEnvironments(config({ staging: { enabled: true, protection: "noindex" } }))).toMatchObject({ staging: true, why: "config" });
		// A config written from the old template (an object without `enabled`) is not an opt-in by itself.
		expect(siteEnvironments(config({ staging: { protection: "access" } })).staging).toBe(false);
		// Legacy signals: stagingUrl, or staging resources recorded by provision.
		expect(siteEnvironments(config({ stagingUrl: "https://acme-staging.agency.workers.dev" }))).toMatchObject({ staging: true, why: "stagingUrl" });
		expect(siteEnvironments(config({ staging: { protection: "access" } }), { staging: { d1: { id: "x" } } })).toMatchObject({ staging: true, why: "cloudflare.json" });
		expect(siteEnvironments(config({ staging: false }), { staging: { d1: { id: "x" } } })).toMatchObject({ staging: false, why: "disabled" });
	});
	it("load and verify default to production once a single-environment site is provisioned (never under the MCP server)", () => {
		const single = siteEnvironments(config(), { production: PROD });
		expect(defaultTarget("load", single)).toBe("production");
		expect(defaultTarget("verify", single)).toBe("production");
		expect(defaultTarget("load", single, { noProduction: true })).toBe("local");
		expect(defaultTarget("load", siteEnvironments(config()))).toBe("local"); // not provisioned yet
		const staged = siteEnvironments(config({ staging: true }), { production: PROD });
		expect(defaultTarget("load", staged)).toBe("local"); // unchanged for sites with staging
		expect(defaultTarget("verify", staged, { stagingKnown: true })).toBe("staging");
	});
});

describe("remote targets: tokens", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "wp2emdash-single-"));
		writeFileSync(join(dir, "cloudflare.json"), JSON.stringify({ production: PROD }));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));
	it("single environment: EMDASH_TOKEN works as an alias for EMDASH_TOKEN_PRODUCTION; with staging it does not", () => {
		expect(remoteTarget(dir, config(), { EMDASH_TOKEN: "t1" }, "production")).toMatchObject({ url: "https://acme.agency.workers.dev", token: "t1", tokenName: "EMDASH_TOKEN", live: false });
		expect(remoteTarget(dir, config(), { EMDASH_TOKEN: "t1", EMDASH_TOKEN_PRODUCTION: "t2" }, "production")).toMatchObject({ token: "t2" });
		const staged = remoteTarget(dir, config({ staging: true }), { EMDASH_TOKEN: "t1" }, "production");
		expect(staged).not.toHaveProperty("token");
		expect(staged).toMatchObject({ tokenName: "EMDASH_TOKEN_PRODUCTION" });
	});
});

describe("scaffold output without staging", () => {
	const base = { workerName: "acme", compatibilityDate: "2026-11-01", cf: { production: PROD }, sandboxedEnvs: [], seoPanel: false, productionHost: "www.acme.example" };
	it("wrangler.jsonc has production only, workers.dev and preview URLs on, and the test-message vars", () => {
		const w = parseJsonc(wranglerJsonc({ ...base, config: config(), staging: false }));
		expect(w.env).toBeUndefined();
		expect(w).toMatchObject({ name: "acme", workers_dev: true, preview_urls: true, d1_databases: [{ binding: "DB", database_name: "acme-db", database_id: "d1-prod" }] });
		expect(w.vars).toMatchObject({ FORM_TO: "owner@acme.example", FORM_TEST_TO: "dev@agency.example", FORM_LIVE_HOST: "acme.example" });
		expect(w.vars).not.toHaveProperty("STAGING");
		expect(w.kv_namespaces).toEqual([{ binding: "FORM_OUTBOX", id: "kv-out" }, { binding: "SESSION", id: "kv-sess" }]);
	});
	it("after go-live the workers.dev copy is off (preview URLs stay); keepWorkersDev keeps it", () => {
		expect(parseJsonc(wranglerJsonc({ ...base, config: config(), staging: false, live: true }))).toMatchObject({ workers_dev: false, preview_urls: true });
		expect(parseJsonc(wranglerJsonc({ ...base, config: config(), staging: false, live: true, keepWorkersDev: true }))).toMatchObject({ workers_dev: true, preview_urls: true });
	});
	it("with opt-in staging: env.staging as before, no test-message vars on production", () => {
		const w = parseJsonc(wranglerJsonc({ ...base, config: config({ staging: true }), staging: true }));
		expect(w.env.staging).toMatchObject({ name: "acme-staging", vars: { STAGING: "1", FORM_TO: "dev@agency.example" } });
		expect(w.vars).not.toHaveProperty("FORM_LIVE_HOST");
		expect(w).not.toHaveProperty("preview_urls");
	});
	it("without a test inbox the production vars carry no FORM_TEST_TO (test messages are kept, never sent)", () => {
		expect(workerVars(config({}, { stagingTo: [] }), { staging: false, productionHost: "acme.example" }).production).not.toHaveProperty("FORM_TEST_TO");
	});
	it("package scripts: production deploy (pinned once the fingerprint is recorded) and the preview-URL review step", () => {
		const s = deployScripts({ staging: false, productionFingerprint: "fp1" });
		expect(Object.keys(s).filter((k) => k.includes("staging"))).toEqual([]);
		expect(s["ci:deploy:production"]).toContain("--expected-target-fingerprint=fp1");
		expect(s["versions:upload"]).toBe("astro build && wrangler versions upload");
		expect(s["versions:deploy"]).toBe("emdash migrate --wrangler-config wrangler.jsonc --expected-target-fingerprint=fp1 && wrangler versions deploy");
		expect(deployScripts({ staging: false })["versions:deploy"]).toBe("emdash migrate --wrangler-config wrangler.jsonc && wrangler versions deploy");
		expect(deployScripts({ staging: false })["ci:deploy:production"]).toBeUndefined();
	});
});

describe("client repo, single environment", () => {
	const input = (o: Partial<ClientRepoInput> = {}): ClientRepoInput => ({
		name: "Acme",
		slug: "acme",
		sourceUrl: "https://acme.example",
		productionUrl: "https://acme.example",
		workerName: "acme",
		staging: false,
		workersDevUrl: "https://acme.agency.workers.dev",
		testTo: ["dev@agency.example"],
		productionFingerprint: "fp1",
		productionReady: false,
		sections: [],
		forms: [{ id: "contact", title: "Contact", fields: ["Email"], withheld: [] }],
		email: { provider: "brevo", to: ["owner@acme.example"] },
		turnstileProduction: false,
		sensitiveData: false,
		stack: { node: ">=24", astro: "7", emdash: "1.5.0", wrangler: "4" },
		...o,
	});
	const job = (yml: string) => /deploy-production:[\s\S]*?\n {4}if: ([^\n]+)/.exec(yml)?.[1];
	it("CI deploys production on push to main before go-live, by hand only after it", () => {
		const pre = clientRepoFiles(input())[".github/workflows/ci.yml"] as string;
		expect(pre).not.toContain("deploy-staging");
		expect(job(pre)).toBe("vars.CLOUDFLARE_ACCOUNT_ID != '' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')");
		expect(pre).toContain("pnpm ci:deploy:production");
		const live = clientRepoFiles(input({ productionReady: true }))[".github/workflows/ci.yml"] as string;
		expect(job(live)).toBe("vars.CLOUDFLARE_ACCOUNT_ID != '' && github.event_name == 'workflow_dispatch'");
		expect(job(clientRepoFiles(input({ productionReady: true, ciDeploy: "always" }))[".github/workflows/ci.yml"] as string)).toContain("'push'");
		expect(job(clientRepoFiles(input({ ciDeploy: "manual" }))[".github/workflows/ci.yml"] as string)).not.toContain("'push'");
		// Without a pinned fingerprint a push never deploys (the migration would prompt).
		expect(job(clientRepoFiles(input({ productionFingerprint: undefined } as never))[".github/workflows/ci.yml"] as string)).not.toContain("'push'");
	});
	it("docs describe one environment, preview links and test messages", () => {
		const f = clientRepoFiles(input({ productionReady: true }));
		expect(f["README.md"]).toContain("One Cloudflare environment: **production**");
		expect(f["README.md"]).not.toMatch(/deploy:staging|\| Staging \|/);
		expect(f["docs/deployment.md"]).toContain("pnpm versions:upload");
		expect(f["docs/deployment.md"]).toContain("the live database, files and settings");
		expect(f["docs/deployment.md"]).not.toContain("--env staging");
		expect(f["docs/forms-and-integrations.md"]).toContain("**Test messages never reach owner@acme.example.**");
		expect(f["docs/forms-and-integrations.md"]).not.toContain("--env staging");
		expect(f[".github/pull_request_template.md"]).toContain("preview link");
	});
	it("an input with only stagingUrl (older callers) still gets the staging docs", () => {
		const f = clientRepoFiles(input({ staging: undefined, stagingUrl: "https://acme-staging.agency.workers.dev" } as never));
		expect(f[".github/workflows/ci.yml"]).toContain("deploy-staging");
	});
});

// ── Forms: test messages ────────────────────────────────────────────────────────────────────────────────────────────

function memoryKv(): KvLike & { store: Map<string, { v: string; meta?: unknown }> } {
	const store = new Map<string, { v: string; meta?: unknown }>();
	return {
		store,
		async put(k, v, o) {
			store.set(k, { v, ...(o?.metadata ? { meta: o.metadata } : {}) });
		},
		async get(k) {
			return store.get(k)?.v ?? null;
		},
		async delete(k) {
			store.delete(k);
		},
		async list(o) {
			return { keys: [...store.entries()].filter(([k]) => k.startsWith(o?.prefix ?? "")).map(([name, e]) => ({ name, ...(e.meta ? { metadata: e.meta } : {}) })), list_complete: true };
		},
	};
}
const form: FormDefinition = { id: "contact", title: "Contact", submitLabel: "Send", successMessage: "Thanks", fields: [{ name: "email", label: "Email", type: "email", required: true }, { name: "message", label: "Message", type: "textarea" }] };
const POST = createFormEndpoint({ getForm: (id) => (id === "contact" ? form : undefined) }) as unknown as (ctx: unknown) => Promise<Response>;
const submit = (host: string) => {
	const body = new FormData();
	for (const [k, v] of Object.entries({ "cf-turnstile-response": "t", email: "visitor@example.com", message: "Hello" })) body.set(k, v);
	return POST({ params: { id: "contact" }, request: new Request(`https://${host}/api/forms/contact`, { method: "POST", body, headers: { accept: "application/json" } }), locals: {} });
};
/** Turnstile passes; Brevo accepts and the recipients of every email are recorded. */
function provider(status = 201) {
	const sent: { to: string[]; subject: string }[] = [];
	const fetch = vi.fn(async (url: string, init?: RequestInit) => {
		if (String(url).includes("turnstile")) return new Response(JSON.stringify({ success: true }));
		const b = JSON.parse(String(init?.body)) as { to: { email: string }[]; subject: string };
		sent.push({ to: b.to.map((t) => t.email), subject: b.subject });
		return new Response(JSON.stringify({ messageId: "<m@relay.example>" }), { status });
	});
	return { fetch, sent };
}
const SINGLE = { EMAIL_API_KEY: "k", FORM_FROM: "Acme <noreply@acme.example>", FORM_TO: "owner@acme.example", FORM_LIVE_HOST: "acme.example", FORM_TEST_TO: "dev@agency.example" };

describe("forms on a single-environment site: test messages", () => {
	let kv: ReturnType<typeof memoryKv>;
	let log: ReturnType<typeof vi.spyOn>;
	const reset = (vars: Record<string, unknown>) => {
		for (const k of Object.keys(env)) delete env[k];
		Object.assign(env, { TURNSTILE_SECRET_KEY: "s", FORM_OUTBOX: kv, ...vars });
	};
	const records = () => [...kv.store.entries()].filter(([k]) => k.startsWith("msg:")).map(([key, e]) => ({ key, q: JSON.parse(e.v) as Queued, meta: e.meta as Record<string, unknown> }));
	beforeEach(() => {
		kv = memoryKv();
		log = vi.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		log.mockRestore();
	});

	it("a request is a test unless it comes from the production host (www. ignored); without FORM_LIVE_HOST nothing is", () => {
		expect(isTestRequest(SINGLE, "https://acme.agency.workers.dev/api/forms/contact")).toBe(true);
		expect(isTestRequest(SINGLE, "https://1a2b3c4d-acme.agency.workers.dev/api/forms/contact")).toBe(true);
		expect(isTestRequest(SINGLE, "https://acme.example/api/forms/contact")).toBe(false);
		expect(isTestRequest(SINGLE, "https://www.acme.example/api/forms/contact")).toBe(false);
		expect(isTestRequest({}, "https://acme.agency.workers.dev/x")).toBe(false);
	});
	it("pre-launch (workers.dev): emailed only to the test inbox, marked [Test]; the domain reaches the client", async () => {
		reset(SINGLE);
		const p = provider();
		vi.stubGlobal("fetch", p.fetch);
		expect((await submit("acme.agency.workers.dev")).status).toBe(200);
		expect((await submit("acme.example")).status).toBe(200);
		expect(p.sent).toEqual([
			{ to: ["dev@agency.example"], subject: "[Test] New website message" },
			{ to: ["owner@acme.example"], subject: "New website message" },
		]);
	});
	it("an admin's recipients setting never receives test messages", async () => {
		reset(SINGLE);
		await kv.put("cfg:recipients", JSON.stringify(["office@acme.example"]));
		const p = provider();
		vi.stubGlobal("fetch", p.fetch);
		await submit("acme.agency.workers.dev");
		expect(p.sent.map((s) => s.to)).toEqual([["dev@agency.example"]]);
	});
	it("a pre-launch message queued without a test inbox is never delivered to the client after launch", async () => {
		reset({ ...SINGLE, FORM_TEST_TO: undefined });
		const p = provider();
		vi.stubGlobal("fetch", p.fetch);
		expect((await submit("acme.agency.workers.dev")).status).toBe(200); // kept in the outbox
		const [r] = records();
		expect(r?.q.test).toBe(true);
		expect(r?.meta.test).toBe(true);
		// After go-live (the same vars: the switch changes nothing in the Worker): the cron and "Email it now" leave it.
		expect(await flushOutbox({ ...SINGLE, FORM_TEST_TO: undefined, FORM_OUTBOX: kv })).toEqual({ sent: 0, left: 1 });
		expect(await sendQueued({ ...SINGLE, FORM_TEST_TO: undefined, FORM_OUTBOX: kv }, r?.key as string)).toBe("no-email");
		// Once a test inbox is set, it goes there — still never to FORM_TO.
		expect(await flushOutbox({ ...SINGLE, FORM_OUTBOX: kv })).toEqual({ sent: 1, left: 0 });
		expect(p.sent.map((s) => s.to)).toEqual([["dev@agency.example"]]);
	});
	it("a test message the provider refused is retried to the test inbox only; real ones to FORM_TO", async () => {
		reset(SINGLE);
		const refuse = provider(401);
		vi.stubGlobal("fetch", refuse.fetch);
		await submit("acme.agency.workers.dev");
		await submit("acme.example");
		const ok = provider();
		vi.stubGlobal("fetch", ok.fetch);
		expect(await flushOutbox({ ...SINGLE, FORM_OUTBOX: kv })).toEqual({ sent: 2, left: 0 });
		expect(ok.sent.map((s) => s.to).sort()).toEqual([["dev@agency.example"], ["owner@acme.example"]]);
	});
});

// ── Load: live production guard ─────────────────────────────────────────────────────────────────────────────────────

describe("load into a live production", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "wp2emdash-guard-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));
	const cf = { production: { accountId: "acct", d1: { name: "acme-db", id: "d1-prod" } } };
	const vars = { CLOUDFLARE_API_TOKEN: "tok" };
	const bookmarks = () => join(dir, "load", "d1-bookmarks.jsonl");

	it("before go-live: no guard, no Cloudflare call", async () => {
		const f = vi.fn();
		expect(await guardLiveProductionWrite({ live: false, force: false, slug: "acme", cf, vars, bookmarksFile: bookmarks() }, f as never)).toEqual({ ok: true });
		expect(f).not.toHaveBeenCalled();
	});
	it("after go-live: refused without --force, nothing called", async () => {
		const f = vi.fn();
		const r = await guardLiveProductionWrite({ live: true, force: false, slug: "acme", cf, vars, bookmarksFile: bookmarks() }, f as never);
		expect(r).toMatchObject({ ok: false });
		expect(!r.ok && r.detail).toContain("--force");
		expect(f).not.toHaveBeenCalled();
	});
	it("with --force: records a Time Travel bookmark first and returns the restore command", async () => {
		const f = vi.fn(async (url: string, init: RequestInit) => {
			expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/d1/database/d1-prod/time_travel/bookmark");
			expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok");
			return new Response(JSON.stringify({ success: true, result: { bookmark: "00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683" } }));
		});
		const r = await guardLiveProductionWrite({ live: true, force: true, slug: "acme", cf, vars, bookmarksFile: bookmarks(), now: () => new Date("2026-12-01T10:00:00Z") }, f as never);
		expect(r).toMatchObject({ ok: true, restore: "npx wrangler d1 time-travel restore acme-db --bookmark=00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683" });
		expect(JSON.parse(readFileSync(bookmarks(), "utf8").trim())).toMatchObject({ at: "2026-12-01T10:00:00.000Z", database: "acme-db", databaseId: "d1-prod", bookmark: "00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683" });
		expect(restoreCommand("x", "b")).toBe("npx wrangler d1 time-travel restore x --bookmark=b");
	});
	it("the load phase defaults to production on a provisioned single-environment site and stops at the guard once live", async () => {
		const root = join(dir, "acme");
		mkdirSync(join(root, "ir"), { recursive: true });
		mkdirSync(join(root, "project"), { recursive: true });
		writeFileSync(join(root, "ir", "site.json"), JSON.stringify({ partials: [], popups: [] }));
		writeFileSync(join(root, "project", "package.json"), "{}");
		writeFileSync(join(root, ".env"), "EMDASH_TOKEN=t\n");
		writeFileSync(join(root, "cloudflare.json"), JSON.stringify({ production: { ...PROD, live: true } }));
		const f = vi.fn();
		vi.stubGlobal("fetch", f);
		const saved = process.env.WP2EMDASH_LOAD_TARGET;
		delete process.env.WP2EMDASH_LOAD_TARGET;
		try {
			const ctx = { config: config(), paths: sitePaths("acme", dir), reporter: { runId: "r", emit: () => {} } };
			const checks = await runLoad(ctx);
			expect(checks).toEqual([expect.objectContaining({ id: "live-guard", ok: false })]);
			expect(f).not.toHaveBeenCalled();
			// The MCP server's runs never reach production: a default falls back to local, an explicit production is refused.
			process.env.WP2EMDASH_NO_PRODUCTION = "1";
			process.env.WP2EMDASH_LOAD_TARGET = "production";
			expect(await runLoad(ctx)).toEqual([expect.objectContaining({ id: "target", ok: false })]);
			process.env.WP2EMDASH_LOAD_TARGET = "staging";
			expect((await runLoad(ctx))[0]?.detail).toContain("staging is opt-in");
		} finally {
			delete process.env.WP2EMDASH_NO_PRODUCTION;
			if (saved === undefined) delete process.env.WP2EMDASH_LOAD_TARGET;
			else process.env.WP2EMDASH_LOAD_TARGET = saved;
			vi.unstubAllGlobals();
		}
	});
	it("with --force but no bookmark (API error or no token): refused, nothing written", async () => {
		const failing = vi.fn(async () => new Response(JSON.stringify({ success: false, errors: [{ code: 7403, message: "not authorized" }] }), { status: 403 }));
		const r = await guardLiveProductionWrite({ live: true, force: true, slug: "acme", cf, vars, bookmarksFile: bookmarks() }, failing as never);
		expect(r).toMatchObject({ ok: false });
		expect(!r.ok && r.detail).toContain("not authorized");
		expect(await guardLiveProductionWrite({ live: true, force: true, slug: "acme", cf, vars: {}, bookmarksFile: bookmarks() }, failing as never)).toMatchObject({ ok: false });
		expect(() => readFileSync(bookmarks())).toThrow();
	});
});

describe("pnpm versions:deploy <version-id> (no prompt)", async () => {
	const { versionsDeployScript } = await import("../src/scaffold/client-repo.js");
	const { spawnSync } = await import("node:child_process");
	const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	it("moves the chain into scripts/versions-deploy.mjs, which deploys the given version and runs the rest in order", () => {
		// Echo stands in for each command, so the test sees exactly what would run.
		const chain = "echo emdash migrate && echo wrangler versions deploy && echo node scripts/warm.mjs https://x.example && echo node scripts/deploy-check.mjs https://x.example";
		const r = versionsDeployScript({ "versions:upload": "astro build && wrangler versions upload", "versions:deploy": chain });
		expect(r.scripts["versions:deploy"]).toBe("node scripts/versions-deploy.mjs");
		expect(r.scripts["versions:upload"]).toBe("astro build && wrangler versions upload");
		const dir = mkdtempSync(join(tmpdir(), "wp2emdash-vd-"));
		try {
			const file = join(dir, "versions-deploy.mjs");
			writeFileSync(file, r.file as string);
			const id = "aa70c567-ea03-4285-b6e2-c46c640a094e";
			const ok = spawnSync(process.execPath, [file, id], { encoding: "utf8" });
			expect(ok.status).toBe(0);
			const ran = ok.stdout.split("\n").filter((l) => l && !l.startsWith(">"));
			expect(ran).toEqual(["emdash migrate", `wrangler versions deploy ${id}@100% --yes`, "node scripts/warm.mjs https://x.example", "node scripts/deploy-check.mjs https://x.example"]);
			expect(spawnSync(process.execPath, [file, `${id}@100%`], { encoding: "utf8" }).stdout).toContain(`deploy ${id}@100% --yes`);
			const bad = spawnSync(process.execPath, [file], { encoding: "utf8" });
			expect(bad.status).toBe(1);
			expect(bad.stderr).toMatch(/Usage: pnpm versions:deploy <version-id>/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("leaves projects without a versions:deploy script alone", () => {
		expect(versionsDeployScript({ "deploy:staging": "x" }).file).toBeUndefined();
	});
});
