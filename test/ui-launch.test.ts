/**
 * Dashboard v3: launch cockpit actions (golive), publish, environment, Worker secrets, portfolio stage.
 * Every external effect is a mock (ActionDeps): no Cloudflare, GitHub or wrangler call is ever made.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ActionDeps, ExecOptions, ExecResult } from "../src/ui/actions.js";
import { requireConfirmation } from "../src/ui/launch.js";
import { csrfFor, startUiServer, type UiServer } from "../src/ui/server.js";
import { deriveStage, type StageInput } from "../src/ui/stage.js";

const FIXTURE = new URL("./fixtures/ui/sites", import.meta.url).pathname;
const TOKEN = "test-token-0123456789";

// Fake secret values (synthetic). None of them may ever appear in an API response or a run log.
const SECRETS = {
	CLOUDFLARE_API_TOKEN: "cfbuild_FAKE_9f8e7d6c5b4a3210aaaa",
	CLOUDFLARE_GOLIVE_TOKEN: "cfgolive_FAKE_0123456789abcdef0123",
	EMDASH_ENCRYPTION_KEY_PRODUCTION: `emdash_enc_v1_${"Q".repeat(43)}`,
	EMAIL_API_KEY: "xkeysib-FAKE-email-key-55555555",
	EMDASH_TOKEN_PRODUCTION: "ec_live_FAKE_token_77777777",
	WP_APP_PASSWORD: "abcd EFGH ijkl MNOP qrst UVWX",
	TURNSTILE_SECRET_KEY_PRODUCTION: "0x4AAAAAAA_FAKE_turnstile_secret",
};
const ACCOUNT = "0123456789abcdef0123456789abcdef";

let dir: string;
let ui: UiServer;
let cookie: string;
const base = () => `http://127.0.0.1:${ui.port}`;
const get = (path: string) => fetch(`${base()}${path}`, { headers: { Cookie: cookie } });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
	fetch(`${base()}${path}`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", Origin: base(), "X-WP2EMDASH-CSRF": csrfFor(TOKEN), ...headers }, body: JSON.stringify(body) });

// ── Mocks ────────────────────────────────────────────────────────────────────────────────────────────────────
interface Call {
	args: string[];
	input?: string;
	cmd?: string;
	env?: Record<string, string | undefined>;
}
const cli: Call[] = [];
const execs: Call[] = [];
const fetches: string[] = [];
let gate: Promise<void> | undefined;
let release: (() => void) | undefined;
const hold = () => {
	gate = new Promise<void>((r) => {
		release = () => {
			gate = undefined;
			r();
		};
	});
};

const goliveJson = (slug: string) =>
	JSON.stringify({
		applied: false,
		ok: false,
		// adversarial: a command that echoes a token must still come back scrubbed
		plan: [`Create Worker route ${slug}.example/* → ${slug}`, `debug ${SECRETS.CLOUDFLARE_GOLIVE_TOKEN}`],
		blockers: [],
		checks: [{ id: "indexable", label: "Production is not marked staging", ok: true }],
		next: [],
	});

const deps: Partial<ActionDeps> = {
	env: (root: string) => {
		const file = join(root, ".env");
		const site: Record<string, string> = {};
		if (existsSync(file))
			for (const l of readFileSync(file, "utf8").split("\n")) {
				const i = l.indexOf("=");
				if (i > 0) site[l.slice(0, i)] = l.slice(i + 1).replace(/^'|'$/g, "");
			}
		return { kit: {}, site };
	},
	runCli: async (args: string[], o: { onLine?: ExecOptions["onLine"] }): Promise<ExecResult> => {
		cli.push({ args });
		if (gate) await gate;
		if (args[0] === "golive" && args.includes("--json")) return { code: 1, stdout: goliveJson(args[1] as string), stderr: "" };
		if (args[0] === "golive") {
			o.onLine?.(`✔ Route gamma.example/* → gamma (r1) token ${SECRETS.CLOUDFLARE_GOLIVE_TOKEN}`, "stdout");
			return { code: 0, stdout: "", stderr: "" };
		}
		if (args[0] === "publish" && args.includes("--json"))
			return {
				code: 1,
				stdout: JSON.stringify({ applied: false, repo: "gamma.example", plan: ["git init", "gh repo create gamma.example --private"], blockers: [], files: 3, fileList: ["package.json", "src/pages/index.astro", "wrangler.jsonc"], scan: { forbidden: [], flagged: [] }, next: [] }),
				stderr: "",
			};
		if (args[0] === "publish") {
			o.onLine?.("✔ Pushed main to acme/gamma", "stdout");
			return { code: 0, stdout: "", stderr: "" };
		}
		return { code: 1, stdout: "", stderr: "unexpected" };
	},
	exec: async (cmd: string, args: string[], o: ExecOptions): Promise<ExecResult> => {
		execs.push({ cmd, args, ...(o.input !== undefined ? { input: o.input } : {}), ...(o.env ? { env: o.env } : {}) });
		if (gate) await gate;
		if (cmd === "npx") {
			// adversarial: wrangler echoing the value it read must not reach the log
			o.onLine?.(`Success! Uploaded secret ${args[4]} ${o.input ?? ""}`, "stdout");
			return { code: 0, stdout: "", stderr: "" };
		}
		if (cmd === "gh" && args[0] === "--version") return { code: 0, stdout: "gh version 2.99.0\n", stderr: "" };
		if (cmd === "gh" && args[0] === "run") return { code: 0, stdout: JSON.stringify([{ status: "completed", conclusion: "success", displayTitle: "Deploy", workflowName: "CI", headBranch: "main", createdAt: "2026-11-19T10:00:00Z", url: "https://github.com/acme/gamma/actions/runs/1" }]), stderr: "" };
		if (cmd === "git") return { code: 0, stdout: "https://github.com/acme/gamma.git\n", stderr: "" };
		return { code: 1, stdout: "", stderr: "no" };
	},
	fetch: async (input: string) => {
		fetches.push(input);
		const json = (result: unknown, ok = true) => new Response(JSON.stringify({ success: ok, result }), { status: ok ? 200 : 404, headers: { "content-type": "application/json" } });
		if (input.endsWith("/workers/scripts/gamma/secrets")) return json([{ name: "EMDASH_ENCRYPTION_KEY", type: "secret_text" }, { name: "LEGACY_THING", type: "secret_text" }]);
		if (input.endsWith("/user/tokens/verify")) return json({ id: "x", status: "active", expires_on: "2026-12-31T00:00:00Z" });
		return json(null, false);
	},
};

// ── Sites ────────────────────────────────────────────────────────────────────────────────────────────────────
function writeSite(slug: string, o: { live: boolean; aliases?: string[]; golive?: boolean }) {
	const root = join(dir, slug);
	mkdirSync(join(root, "cutover"), { recursive: true });
	mkdirSync(join(root, "project", "src", "forms"), { recursive: true });
	mkdirSync(join(root, "project", ".git"), { recursive: true });
	writeFileSync(join(root, "project", "package.json"), "{}\n");
	writeFileSync(
		join(root, "kit.config.ts"),
		`// synthetic\nexport default { slug: "${slug}", name: "${slug} Studio", source: { url: "https://old-${slug}.example" }, target: { productionUrl: "https://${slug}.example", aliasDomains: ${JSON.stringify(o.aliases ?? [])} } };\n`,
	);
	const phases = Object.fromEntries(["init", "audit", "extract", "transform", "scaffold", "load", "verify", "cutover"].map((p) => [p, { status: "passed", checks: [], finishedAt: "2026-11-01T00:00:00.000Z" }]));
	writeFileSync(join(root, "state.json"), JSON.stringify({ version: 1, slug, createdAt: "2026-11-01T00:00:00.000Z", updatedAt: "2026-11-01T00:00:00.000Z", phases }));
	writeFileSync(
		join(root, "cloudflare.json"),
		JSON.stringify({ accountId: ACCOUNT, production: { d1: { name: `${slug}-db`, id: "d1-id" }, r2: { bucket: `${slug}-media` }, worker: { name: slug, url: `https://${slug}.acme.workers.dev` }, session: { name: `${slug}-session`, id: "kv" }, ...(o.live ? { live: true, liveSince: "2026-11-15" } : {}) } }),
	);
	writeFileSync(join(root, ".env"), `${Object.entries(SECRETS).map(([k, v]) => `${k}=${v.includes(" ") ? `'${v}'` : v}`).join("\n")}\nCLOUDFLARE_ACCOUNT_ID=${ACCOUNT}\n`);
	writeFileSync(join(root, "decisions.md"), "# Decisions\n\n| Date | Phase | Decision | Reason | Approved by |\n|---|---|---|---|---|\n");
	if (o.golive)
		writeFileSync(
			join(root, "cutover", "golive.json"),
			JSON.stringify({
				domain: `${slug}.example`,
				worker: slug,
				zoneId: "z1",
				routes: [{ id: "r1", pattern: `${slug}.example/*`, adopted: false, at: "2026-11-15T10:00:00.000Z" }],
				aliasRules: [],
				switchedAt: "2026-11-15T10:00:00.000Z",
				liveSince: "2026-11-15",
				smoke: { at: "2026-11-15T10:01:00.000Z", ok: true, checked: 12, failures: [] },
				history: [{ at: "2026-11-15T10:00:00.000Z", action: "route created" }],
				approvals: [{ at: "2026-11-15T09:59:00.000Z", step: "primary", by: "Op", approval: "Owner Jane, email 2026-11-15", via: "cli" }],
				lastChecks: { at: "2026-11-15T10:02:00.000Z", step: "primary", checks: [{ id: "dns-unchanged", label: "DNS unchanged", ok: true, detail: "12 records identical" }] },
			}),
		);
}

const runLog = (slug: string, runId: string) => readFileSync(join(dir, slug, "runs", `${runId}.jsonl`), "utf8");
async function waitIdle(slug: string) {
	for (let i = 0; i < 200; i++) {
		const l = (await (await get(`/api/sites/${slug}/launch`)).json()) as { busy?: unknown };
		if (!l.busy) return;
		await new Promise((r) => setTimeout(r, 10));
	}
	throw new Error("action did not finish");
}
const assertNoSecret = (text: string) => {
	for (const v of Object.values(SECRETS)) expect(text, `leaked ${v.slice(0, 8)}…`).not.toContain(v);
	expect(text).not.toContain("abcdEFGHijklMNOPqrstUVWX");
};

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "wp2emdash-ui3-"));
	cpSync(FIXTURE, dir, { recursive: true });
	writeSite("gamma", { live: true, aliases: ["old-gamma.example"], golive: true });
	writeSite("delta", { live: false });
	ui = await startUiServer({ sitesDir: dir, token: TOKEN, pollMs: 20, actions: deps });
	const res = await fetch(`${base()}/?t=${TOKEN}`, { redirect: "manual" });
	cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] as string;
});

afterAll(async () => {
	release?.();
	await ui?.close();
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	cli.length = 0;
	execs.length = 0;
});

// ── Stage derivation ─────────────────────────────────────────────────────────────────────────────────────────
describe("portfolio stage", () => {
	const input = (o: Partial<StageInput>): StageInput => ({ slug: "s", recorded: {}, latest: {}, live: false, monitorDays: 14, aliasDomains: [], aliasRules: 0, now: new Date("2026-11-20T00:00:00Z"), ...o });
	const run = (ok: boolean) => ({ runId: "r", ok, preview: true });

	it("a new site starts at init", () => {
		expect(deriveStage(input({})).next).toMatchObject({ id: "init", source: "gates" });
	});
	it("preview-only runs move the next step past unrecorded gates", () => {
		const s = deriveStage(input({ latest: { audit: run(true), extract: run(true), transform: run(true), scaffold: run(true), load: run(true), verify: run(false) } }));
		expect(s.next).toMatchObject({ id: "verify", source: "runs", command: "pnpm wp2emdash run s verify" });
		expect(s.next.note).toMatch(/Recorded gates stop at init/);
		expect(s.phases.map((p) => p.effective)).toEqual(["not-recorded", "preview-passed", "preview-passed", "preview-passed", "preview-passed", "preview-passed", "preview-failed", "pending"]);
	});
	it("a failed preview of a later phase is the next step, not an earlier phase without runs", () => {
		expect(deriveStage(input({ latest: { audit: run(false) } })).next).toMatchObject({ id: "audit", label: "audit (failing)" });
	});
	it("all gates done but not live → go live", () => {
		const all = Object.fromEntries(["init", "audit", "extract", "transform", "scaffold", "load", "verify", "cutover"].map((p) => [p, "passed"]));
		expect(deriveStage(input({ recorded: all })).next).toMatchObject({ id: "golive", command: "pnpm wp2emdash golive s", source: "gates" });
	});
	it("a live site shows live, the launch date and the alias / monitoring step", () => {
		const live = deriveStage(input({ live: true, liveSince: "2026-11-15", aliasDomains: ["old.example"] }));
		expect(live).toMatchObject({ live: true, liveSince: "2026-11-15", monitorEndsOn: "2026-11-29", aliases: { status: "not-switched" }, next: { id: "aliases", command: "pnpm wp2emdash golive s --aliases" } });
		const redirecting = deriveStage(input({ live: true, liveSince: "2026-11-15", aliasDomains: ["old.example"], aliasCheck: { ok: true, failures: 0, ranAt: "2026-11-16T00:00:00Z" } }));
		expect(redirecting.aliases.status).toBe("redirecting");
		expect(redirecting.next).toMatchObject({ id: "monitor", label: "Monitoring until 2026-11-29" });
		expect(deriveStage(input({ live: true, liveSince: "2026-10-01" })).next.id).toBeNull();
		expect(deriveStage(input({ live: true, aliasDomains: ["old.example"], aliasCheck: { ok: false, failures: 3 } })).aliases).toMatchObject({ status: "failing", detail: "3 failing" });
	});

	it("the portfolio API carries the stage (live badge data) for every site", async () => {
		const list = (await (await get("/api/portfolio")).json()) as { slug: string; domain?: string; stage?: { live: boolean; liveSince?: string; next: { id: string | null } } }[];
		const gamma = list.find((s) => s.slug === "gamma");
		expect(gamma).toMatchObject({ domain: "gamma.example", stage: { live: true, liveSince: "2026-11-15", next: { id: "aliases" } } });
		expect(list.find((s) => s.slug === "delta")?.stage).toMatchObject({ live: false, next: { id: "golive" } });
	});
});

// ── Security ─────────────────────────────────────────────────────────────────────────────────────────────────
describe("mutating endpoints", () => {
	const valid = { mode: "primary", confirmDomain: "gamma.example", approved: true, approval: "Jane Owner, email 2026-11-20 14:05", by: "Op Erator" };

	it("need POST + session cookie + same Origin + the CSRF header", async () => {
		const noCookie = await fetch(`${base()}/api/sites/gamma/golive`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base(), "X-WP2EMDASH-CSRF": csrfFor(TOKEN) }, body: JSON.stringify(valid) });
		expect(noCookie.status).toBe(401);
		const noOrigin = await fetch(`${base()}/api/sites/gamma/golive`, { method: "POST", headers: { Cookie: cookie, "Content-Type": "application/json", "X-WP2EMDASH-CSRF": csrfFor(TOKEN) }, body: JSON.stringify(valid) });
		expect(noOrigin.status).toBe(403);
		expect((await post("/api/sites/gamma/golive", valid, { Origin: "http://evil.example" })).status).toBe(403);
		expect((await post("/api/sites/gamma/golive", valid, { "X-WP2EMDASH-CSRF": "wrong" })).status).toBe(403);
		expect((await post("/api/sites/gamma/golive", valid, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
		expect((await get("/api/sites/gamma/golive")).status).toBe(404);
		expect(cli.filter((c) => c.args.includes("--yes"))).toEqual([]);
	});

	it("the page carries the CSRF value, never the session token", async () => {
		const html = await (await get("/")).text();
		expect(html).toContain(`<meta name="wp2emdash-csrf" content="${csrfFor(TOKEN)}">`);
		expect(html).not.toContain(TOKEN);
	});
});

// ── Confirmation enforcement ─────────────────────────────────────────────────────────────────────────────────
describe("confirmations", () => {
	it("requireConfirmation checks the typed domain, the approval tick and text, and the name", () => {
		const ok = { confirmDomain: " Gamma.Example ", approved: true, approval: "Jane, email 2026-11-20", by: "Op" };
		expect(requireConfirmation(ok, { domain: "gamma.example", approval: true })).toEqual({ by: "Op", approval: "Jane, email 2026-11-20" });
		expect(() => requireConfirmation({ ...ok, confirmDomain: "" }, { domain: "gamma.example", approval: true })).toThrow(/Type the production domain/);
		expect(() => requireConfirmation({ ...ok, confirmDomain: "www.gamma.example" }, { domain: "gamma.example", approval: true })).toThrow(/does not match/);
		expect(() => requireConfirmation({ ...ok, approved: "yes" }, { domain: "gamma.example", approval: true })).toThrow(/owner approved/);
		expect(() => requireConfirmation({ ...ok, approval: "ok" }, { domain: "gamma.example", approval: true })).toThrow(/at least 10/);
		expect(() => requireConfirmation({ ...ok, by: " " }, { domain: "gamma.example", approval: true })).toThrow(/required/);
		expect(requireConfirmation({ by: "Op" }, { domain: "gamma.example", approval: false, typedDomain: false })).toEqual({ by: "Op" });
	});

	const valid = { confirmDomain: "gamma.example", approved: true, approval: "Jane Owner, email 2026-11-20 14:05", by: "Op Erator" };
	const broken: [string, Record<string, unknown>][] = [
		["no typed domain", { ...valid, confirmDomain: undefined }],
		["wrong domain", { ...valid, confirmDomain: "evil.example" }],
		["approval not ticked", { ...valid, approved: false }],
		["no approval text", { ...valid, approval: "" }],
		["approval too short", { ...valid, approval: "yes" }],
		["no operator name", { ...valid, by: "" }],
	];

	for (const mode of ["primary", "aliases", "rollback", "rollback-aliases"]) {
		it(`golive ${mode} never runs without the typed domain and the owner's approval`, async () => {
			for (const [why, body] of broken) {
				const r = await post("/api/sites/gamma/golive", { ...body, mode });
				expect(r.status, why).toBe(400);
			}
			expect((await post("/api/sites/gamma/golive", { ...valid, mode: "everything" })).status).toBe(400);
			expect(cli).toEqual([]);
		});
	}

	it("publish never runs without the typed domain and the owner's approval", async () => {
		for (const [why, body] of broken) expect((await post("/api/sites/gamma/publish", body)).status, why).toBe(400);
		expect((await post("/api/sites/gamma/publish", { ...valid, repo: "bad repo name" })).status).toBe(400);
		expect(cli).toEqual([]);
	});

	it("Set on Worker needs the typed domain on a live production, and never takes a value from the browser", async () => {
		const base = { env: "production", name: "EMAIL_API_KEY", confirm: true, by: "Op" };
		expect((await post("/api/sites/gamma/worker-secrets", base)).status).toBe(400); // live: typed domain required
		expect((await post("/api/sites/gamma/worker-secrets", { ...base, confirmDomain: "wrong.example" })).status).toBe(400);
		expect((await post("/api/sites/gamma/worker-secrets", { ...base, confirmDomain: "gamma.example", confirm: false })).status).toBe(400);
		expect((await post("/api/sites/gamma/worker-secrets", { ...base, confirmDomain: "gamma.example", by: "" })).status).toBe(400);
		expect((await post("/api/sites/gamma/worker-secrets", { ...base, confirmDomain: "gamma.example", value: "x" })).status).toBe(400);
		// operator credentials are local-only
		const op = await post("/api/sites/gamma/worker-secrets", { ...base, name: "CLOUDFLARE_GOLIVE_TOKEN", confirmDomain: "gamma.example" });
		expect(op.status).toBe(400);
		expect(((await op.json()) as { error: string }).error).toMatch(/never set on a Worker/);
		expect((await post("/api/sites/gamma/worker-secrets", { ...base, env: "staging", confirmDomain: "gamma.example" })).status).toBe(400);
		expect(execs.filter((e) => e.cmd === "npx")).toEqual([]);
	});
});

// ── Actions ──────────────────────────────────────────────────────────────────────────────────────────────────
describe("launch actions", () => {
	it("launch view: domain, recorded routes, approvals, DNS check and what each step needs", async () => {
		const L = (await (await get("/api/sites/gamma/launch")).json()) as Record<string, unknown> & { actions: { mode: string; available: boolean }[]; record: { routes: unknown[]; approvals: unknown[] }; dnsChecks: unknown[] };
		expect(L).toMatchObject({ domain: "gamma.example", canonical: "gamma.example", live: true, liveSince: "2026-11-15", monitorEndsOn: "2026-11-29", worker: "gamma" });
		expect(L.record.routes).toHaveLength(1);
		expect(L.record.approvals).toHaveLength(1);
		expect(L.dnsChecks).toEqual([{ id: "dns-unchanged", label: "DNS unchanged", ok: true, detail: "12 records identical" }]);
		expect(Object.fromEntries(L.actions.map((a) => [a.mode, a.available]))).toEqual({ primary: true, aliases: true, rollback: true, "rollback-aliases": false });
	});

	it("the plan is golive's own dry run (no --yes) and comes back scrubbed", async () => {
		const res = await get("/api/sites/gamma/golive/plan?mode=aliases");
		const text = await res.text();
		assertNoSecret(text);
		const p = JSON.parse(text) as { plan: string[]; changes: string[]; ok: boolean };
		expect(cli.map((c) => c.args)).toEqual([["golive", "gamma", "--aliases", "--json"]]);
		expect(p.ok).toBe(true);
		expect(p.plan[1]).toContain("[redacted]");
		expect(p.changes.join("\n")).toMatch(/old-gamma\.example: one Single Redirect rule/);
	});

	it("go live runs golive --yes with the approval, records it in decisions.md and streams a scrubbed run log", async () => {
		const res = await post("/api/sites/gamma/golive", { mode: "primary", confirmDomain: "gamma.example", approved: true, approval: "Jane Owner, email 2026-11-20 14:05: go", by: "Op Erator" });
		expect(res.status).toBe(202);
		const { runId } = (await res.json()) as { runId: string };
		await waitIdle("gamma");
		const call = cli.find((c) => c.args.includes("--yes"));
		expect(call?.args).toEqual(["golive", "gamma", "--yes", "--approved-by=Op Erator", "--approval=Jane Owner, email 2026-11-20 14:05: go", "--via=dashboard"]);
		const decisions = readFileSync(join(dir, "gamma", "decisions.md"), "utf8");
		expect(decisions).toMatch(/\| cutover \| Go live \(routes for the domain\) approved: gamma\.example \(dashboard, run .+\) \| Jane Owner, email 2026-11-20 14:05: go \| Op Erator \|/);
		const log = runLog("gamma", runId);
		expect(log).toContain('"phase":"golive"');
		expect(log).toContain('"type":"phase:end","phase":"golive","ok":true');
		assertNoSecret(log);
		// The run shows up in Runs and in the launch view, never as the cutover gate.
		const runs = (await (await get("/api/sites/gamma/runs")).json()) as { runId: string; phase: string }[];
		expect(runs.find((r) => r.runId === runId)?.phase).toBe("golive");
		const state = JSON.parse(readFileSync(join(dir, "gamma", "state.json"), "utf8")) as { phases: { cutover: { status: string } } };
		expect(state.phases.cutover.status).toBe("passed");
	});

	it("rollback passes --rollback --yes", async () => {
		const res = await post("/api/sites/gamma/golive", { mode: "rollback", confirmDomain: "gamma.example", approved: true, approval: "Jane Owner, phone 2026-11-21: roll back", by: "Op" });
		expect(res.status).toBe(202);
		await waitIdle("gamma");
		expect(cli.find((c) => c.args.includes("--yes"))?.args.slice(0, 4)).toEqual(["golive", "gamma", "--rollback", "--yes"]);
	});

	it("one action at a time per site (single-flight), other sites unaffected", async () => {
		hold();
		const first = await post("/api/sites/gamma/golive", { mode: "aliases", confirmDomain: "gamma.example", approved: true, approval: "Jane Owner, email 2026-11-21: aliases", by: "Op" });
		expect(first.status).toBe(202);
		const second = await post("/api/sites/gamma/golive", { mode: "primary", confirmDomain: "gamma.example", approved: true, approval: "Jane Owner, email 2026-11-21: again", by: "Op" });
		expect(second.status).toBe(409);
		expect((await post("/api/sites/gamma/publish", { confirmDomain: "gamma.example", approved: true, approval: "Jane Owner, email 2026-11-21", by: "Op" })).status).toBe(409);
		expect((await post("/api/sites/gamma/worker-secrets", { env: "production", name: "EMAIL_API_KEY", confirm: true, by: "Op", confirmDomain: "gamma.example" })).status).toBe(409);
		const busy = (await (await get("/api/sites/gamma/launch")).json()) as { busy?: { action: string } };
		expect(busy.busy?.action).toBe("golive-aliases");
		// Another site is not blocked.
		const other = await post("/api/sites/delta/worker-secrets", { env: "production", name: "EMDASH_ENCRYPTION_KEY", confirm: true, by: "Op" });
		expect(other.status).toBe(202);
		release?.();
		await waitIdle("gamma");
		await waitIdle("delta");
		expect(cli.filter((c) => c.args.includes("--yes"))).toHaveLength(1);
	});

	it("publish: dry run lists files and the scan; publish --yes after confirmation; the token secret is never set", async () => {
		const st = (await (await get("/api/sites/gamma/publish")).json()) as { repo: string; repoUrl: string; ci: { runs: { conclusion: string }[] }; guidance: string[] };
		expect(st).toMatchObject({ repo: "acme/gamma", repoUrl: "https://github.com/acme/gamma" });
		expect(st.ci.runs[0]?.conclusion).toBe("success");
		expect(st.guidance[0]).toMatch(/^gh secret set CLOUDFLARE_API_TOKEN --repo acme\/gamma/);
		const plan = (await (await get("/api/sites/gamma/publish/plan")).json()) as { fileList: string[]; scan: { flagged: string[] }; ok: boolean };
		expect(plan).toMatchObject({ ok: true, fileList: ["package.json", "src/pages/index.astro", "wrangler.jsonc"], scan: { forbidden: [], flagged: [] } });
		expect(cli.map((c) => c.args)).toEqual([["publish", "gamma", "--json"]]);
		const res = await post("/api/sites/gamma/publish", { confirmDomain: "gamma.example", approved: true, approval: "Jane Owner, email 2026-11-21: publish it", by: "Op" });
		expect(res.status).toBe(202);
		await waitIdle("gamma");
		expect(cli.at(-1)?.args).toEqual(["publish", "gamma", "--yes"]);
		// Nothing ever runs `gh secret set`.
		expect(execs.some((e) => e.cmd === "gh" && e.args[0] === "secret")).toBe(false);
		expect(readFileSync(join(dir, "gamma", "decisions.md"), "utf8")).toMatch(/\| publish \| Publish the project to a private GitHub repository approved/);
	});

	it("Set on Worker pipes the local value into wrangler secret put on stdin; it never appears in the log", async () => {
		const res = await post("/api/sites/gamma/worker-secrets", { env: "production", name: "EMAIL_API_KEY", confirm: true, by: "Op", confirmDomain: "gamma.example" });
		expect(res.status).toBe(202);
		const { runId } = (await res.json()) as { runId: string };
		await waitIdle("gamma");
		const call = execs.find((e) => e.cmd === "npx");
		expect(call?.args).toEqual(["--no-install", "wrangler", "secret", "put", "EMAIL_API_KEY"]);
		expect(call?.input).toBe(SECRETS.EMAIL_API_KEY);
		expect(call?.args.join(" ")).not.toContain(SECRETS.EMAIL_API_KEY);
		expect(call?.env?.CLOUDFLARE_API_TOKEN).toBe(SECRETS.CLOUDFLARE_API_TOKEN);
		const log = runLog("gamma", runId);
		expect(log).toContain('"phase":"secret-put"');
		assertNoSecret(log);
		// Not live yet: no typed domain needed (but the name and the explicit confirm are).
		const d = await post("/api/sites/delta/worker-secrets", { env: "production", name: "TURNSTILE_SECRET_KEY", confirm: true, by: "Op" });
		expect(d.status).toBe(202);
		await waitIdle("delta");
		expect(execs.filter((e) => e.cmd === "npx").at(-1)?.input).toBe(SECRETS.TURNSTILE_SECRET_KEY_PRODUCTION);
	});
});

// ── Views ────────────────────────────────────────────────────────────────────────────────────────────────────
describe("environment and secrets views", () => {
	it("environment: single environment, workers.dev, live domain, the load --force rule", async () => {
		const v = (await (await get("/api/sites/gamma/environment")).json()) as { mode: string; environments: { name: string; live: boolean; workersDev: string; publicUrl: string; liveSince: string }[]; rules: { title: string; command?: string }[] };
		expect(v.mode).toBe("single");
		expect(v.environments).toHaveLength(1);
		expect(v.environments[0]).toMatchObject({ name: "production", live: true, workersDev: "https://gamma.acme.workers.dev", publicUrl: "https://gamma.example", liveSince: "2026-11-15" });
		expect(v.rules[0]).toMatchObject({ title: expect.stringMatching(/--force/), command: "pnpm wp2emdash run gamma load --force" });
		expect(v.rules.some((r) => r.command?.includes("versions:upload"))).toBe(true);
		const d = (await (await get("/api/sites/delta/environment")).json()) as { rules: { title: string }[] };
		expect(d.rules[0]?.title).toMatch(/until go-live/);
	});

	it("worker secrets: saved locally / set on Worker by name; operator tokens verified without values", async () => {
		const res = await get("/api/sites/gamma/worker-secrets?verify=1");
		const text = await res.text();
		assertNoSecret(text);
		const w = JSON.parse(text) as { environments: { name: string; needsTypedDomain: boolean; secrets: { name: string; required: boolean; local: { saved: boolean; key?: string }; onWorker?: boolean }[]; others: string[] }[]; operator: { key: string; present: boolean; verify?: { status: string; expiresOn?: string }; reminder?: string }[] };
		const prod = w.environments[0];
		expect(prod?.needsTypedDomain).toBe(true);
		const by = Object.fromEntries((prod?.secrets ?? []).map((s) => [s.name, s]));
		expect(by.EMDASH_ENCRYPTION_KEY).toMatchObject({ required: true, local: { saved: true, key: "EMDASH_ENCRYPTION_KEY_PRODUCTION" }, onWorker: true });
		expect(by.EMAIL_API_KEY).toMatchObject({ required: true, local: { saved: true, key: "EMAIL_API_KEY" }, onWorker: false });
		expect(by.TURNSTILE_SECRET_KEY).toMatchObject({ local: { saved: true, key: "TURNSTILE_SECRET_KEY_PRODUCTION" }, onWorker: false });
		expect(prod?.others).toEqual(["LEGACY_THING"]);
		const op = Object.fromEntries(w.operator.map((o) => [o.key, o]));
		expect(op.CLOUDFLARE_GOLIVE_TOKEN).toMatchObject({ present: true, verify: { status: "active", expiresOn: "2026-12-31" } });
		expect(op.CLOUDFLARE_GOLIVE_TOKEN?.reminder).toMatch(/revoke it after the monitoring window ends on 2026-11-29/);
		expect(op.EMDASH_TOKEN?.present).toBe(false);
		expect(fetches.some((u) => u.includes("/user/tokens/verify"))).toBe(true);
	});

	it("no secret value appears in any API response", async () => {
		const paths = [
			"/api/portfolio",
			"/api/sites/gamma",
			"/api/sites/gamma/launch",
			"/api/sites/gamma/golive/plan?mode=primary",
			"/api/sites/gamma/golive/plan?mode=rollback",
			"/api/sites/gamma/publish",
			"/api/sites/gamma/publish/plan",
			"/api/sites/gamma/environment",
			"/api/sites/gamma/worker-secrets?verify=1",
			"/api/sites/gamma/secrets",
			"/api/sites/gamma/cockpit",
			"/api/sites/gamma/checklist",
			"/api/sites/gamma/runs",
			"/api/sites/delta/worker-secrets",
		];
		for (const p of paths) {
			const res = await get(p);
			expect(res.status, p).toBeLessThan(500);
			assertNoSecret(await res.text());
		}
		// Every run log the actions wrote, and their SSE streams.
		const runs = readdirSync(join(dir, "gamma", "runs")).filter((f) => f.endsWith("-ui.jsonl"));
		expect(runs.length).toBeGreaterThan(2);
		for (const f of runs) {
			assertNoSecret(readFileSync(join(dir, "gamma", "runs", f), "utf8"));
			const ctrl = new AbortController();
			const res = await fetch(`${base()}/api/sites/gamma/runs/${f.slice(0, -6)}/stream`, { headers: { Cookie: cookie }, signal: ctrl.signal });
			const reader = (res.body as ReadableStream<Uint8Array>).getReader();
			let text = "";
			while (!text.includes("phase:end")) {
				const { value, done } = await reader.read();
				if (done) break;
				text += new TextDecoder().decode(value);
			}
			ctrl.abort();
			assertNoSecret(text);
		}
	});
});
