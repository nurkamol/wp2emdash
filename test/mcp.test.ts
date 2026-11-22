import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initSite } from "../src/commands/init.js";
import type { RunOptions, RunResult } from "../src/commands/run.js";
import { sitePaths } from "../src/core/paths.js";
import type { PhaseId } from "../src/core/phases.js";
import { readState, recordGate, writeState } from "../src/core/state.js";
import { scrubSecrets } from "../src/extract/credentials.js";
import { createMcpServer } from "../src/mcp/server.js";
import { explainGateTool, listDiagnosticsTool, proposeOverrideTool, readReportTool, runPhaseTool, runRefusal, statusTool, type ToolEnv } from "../src/mcp/tools.js";

const SECRET = "sk-test-0123456789abcdef";
const KIT_SECRET = "cf-kit-token-abcdefghij";

describe("kit MCP tools", () => {
	let dir: string;
	let env: ToolEnv;
	const slug = "acme";
	const calls: { slug: string; phase: PhaseId; opts: RunOptions; loadTarget: string | undefined; verifyTarget: string | undefined }[] = [];

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "wp2emdash-mcp-"));
		const sites = join(dir, "sites");
		const kit = join(dir, "kit");
		mkdirSync(kit, { recursive: true });
		writeFileSync(join(kit, ".env"), `CLOUDFLARE_API_TOKEN=${KIT_SECRET}\n`);
		initSite({ slug, name: "Acme", sourceUrl: "https://acme.example", productionUrl: "https://acme.example", sensitiveData: false }, sites);
		writeFileSync(join(sitePaths(slug, sites).root, ".env"), `EMDASH_TOKEN=${SECRET}\nFLAG=1\n`);
		calls.length = 0;
		env = {
			sitesDir: sites,
			kitRoot: kit,
			runPhase: async (s, phase, opts): Promise<RunResult> => {
				calls.push({ slug: s, phase, opts, loadTarget: process.env.WP2EMDASH_LOAD_TARGET, verifyTarget: process.env.WP2EMDASH_TARGET });
				return { phase, ok: false, runId: "r1", checks: [{ id: "x", label: "Check", ok: false, detail: `token ${SECRET} leaked` }] };
			},
		};
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("status lists phases, next phase and project path", () => {
		const [s] = statusTool({}, env) as { slug: string; next: string; project: string; phases: unknown[] }[];
		expect(s?.slug).toBe(slug);
		expect(s?.next).toBe("init");
		expect(s?.project).toBe(join(env.sitesDir, slug, "project"));
		expect(s?.phases).toHaveLength(8);
		expect(() => statusTool({ slug: "nope" }, env)).toThrow(/No site/);
	});

	it("run_phase refuses production load/verify and non-preview cutover", async () => {
		expect(runRefusal("load", { target: "production" })).toMatch(/production/);
		expect(runRefusal("verify", { target: "production", preview: true })).toMatch(/production/);
		expect(runRefusal("cutover", {})).toMatch(/preflight/);
		expect(runRefusal("cutover", { preview: true })).toBeUndefined();
		expect(runRefusal("transform", {})).toBeUndefined();
		expect(runRefusal("transform", { target: "staging" })).toMatch(/only applies/);
		for (const input of [{ phase: "load", target: "production" as const }, { phase: "cutover" }, { phase: "verify", target: "production" as const, preview: true }]) {
			const r = await runPhaseTool({ slug, ...input }, env);
			expect(r.status).toBe("refused");
			expect(r.exitCode).toBe(1);
		}
		expect(calls).toHaveLength(0);
	});

	it("run_phase never inherits a production target, runs quietly and scrubs secrets", async () => {
		process.env.WP2EMDASH_LOAD_TARGET = "production";
		process.env.WP2EMDASH_TARGET = "production";
		try {
			const r = await runPhaseTool({ slug, phase: "load" }, env);
			expect(r).toMatchObject({ status: "failed", exitCode: 2, runId: "r1" });
			expect(JSON.stringify(r)).not.toContain(SECRET);
			expect(r.checks[0]?.detail).toContain("[redacted]");
			await runPhaseTool({ slug, phase: "load", target: "staging" }, env);
			expect(calls.map((c) => [c.loadTarget, c.verifyTarget])).toEqual([
				[undefined, undefined],
				["staging", "staging"],
			]);
			expect(calls.every((c) => c.opts.quiet && c.opts.sitesDir === env.sitesDir)).toBe(true);
			expect(process.env.WP2EMDASH_LOAD_TARGET).toBe("production"); // restored
		} finally {
			delete process.env.WP2EMDASH_LOAD_TARGET;
			delete process.env.WP2EMDASH_TARGET;
		}
		const pre = await runPhaseTool({ slug, phase: "cutover", preview: true }, env);
		expect(pre.status).toBe("failed");
		expect(calls.at(-1)?.opts.preview).toBe(true);
	});

	it("read_report stays inside reports/, refuses binaries and scrubs secrets", () => {
		const reports = sitePaths(slug, env.sitesDir).reports;
		mkdirSync(join(reports, "transform"), { recursive: true });
		writeFileSync(join(reports, "transform", "coverage.md"), `# Coverage\nkey ${SECRET} and kit ${KIT_SECRET}\n`);
		writeFileSync(join(reports, "shot.png"), "png");
		writeFileSync(join(sitePaths(slug, env.sitesDir).root, "outside.md"), "secret stuff");
		symlinkSync(join(sitePaths(slug, env.sitesDir).root, ".env"), join(reports, "link.md"));

		const r = readReportTool({ slug, report: "transform/coverage.md" }, env);
		expect(r.text).toContain("# Coverage");
		expect(r.text).not.toContain(SECRET);
		expect(r.text).not.toContain(KIT_SECRET);
		expect(readReportTool({ slug, report: "" }, env).text).toContain("transform/coverage.md");
		for (const bad of ["../outside.md", "../.env", "/etc/passwd", "transform/../../outside.md", "link.md"]) {
			expect(() => readReportTool({ slug, report: bad }, env), bad).toThrow();
		}
		expect(() => readReportTool({ slug, report: "shot.png" }, env)).toThrow(/text reports/);
	});

	it("list_diagnostics flattens coverage.json with override keys, blocking first", () => {
		const p = sitePaths(slug, env.sitesDir);
		mkdirSync(join(p.reports, "transform"), { recursive: true });
		mkdirSync(join(p.ir, "pages"), { recursive: true });
		writeFileSync(join(p.ir, "pages", "home.json"), JSON.stringify({ source: { slug: "home" } }));
		writeFileSync(
			join(p.reports, "transform", "coverage.json"),
			JSON.stringify({
				documents: [
					{ file: "pages/home.json", published: true, builder: "wpbakery", diagnostics: [{ level: "info", code: "dropped-decorative", message: "spacer", path: "row-1" }, { level: "error", code: "unmapped", message: "vc_custom_widget", path: "row-3", carriesContent: true }] },
				],
				notTransformed: ["post hello: classic"],
			}),
		);
		const all = listDiagnosticsTool({ slug }, env);
		expect(all.total).toBe(2);
		expect(all.blocking).toBe(1);
		expect(all.items[0]).toMatchObject({ code: "unmapped", overrideKey: "home:row-3", docSlug: "home" });
		expect(all.notTransformed).toEqual(["post hello: classic"]);
		expect(listDiagnosticsTool({ slug, level: "error" }, env).total).toBe(1);
	});

	it("explain_gate lists failing checks with the documented fix and never offers to accept", () => {
		const p = sitePaths(slug, env.sitesDir);
		writeState(p.state, recordGate(readState(p.state), "init", [{ id: "access", label: "ACCESS.md done", ok: false, detail: "2 items open" }], { runId: "r", startedAt: new Date().toISOString() }));
		const e = explainGateTool({ slug, phase: "init" }, env);
		expect(e.status).toBe("failed");
		expect(e.failing[0]).toMatchObject({ id: "access", detail: "2 items open" });
		expect(e.failing[0]?.fix).toMatch(/ACCESS\.md/);
		expect(e.explanation).toMatch(/Only the owner can accept/);
		expect(explainGateTool({ slug, phase: "transform" }, env).blockedBy).toBe("init");
	});

	it("propose_override writes a pending proposal and refuses secrets", () => {
		const overrides = sitePaths(slug, env.sitesDir).overrides;
		const before = readFileSync(overrides, "utf8");
		const patch = ["--- a/overrides.ts", "+++ b/overrides.ts", "@@ -9,1 +9,1 @@", "-\telements: {},", '+\telements: { "home:row-3": "drop" },', ""].join("\n");
		const p = proposeOverrideTool({ slug, summary: "Drop row 3", file: "overrides.ts", patch, rerun: "transform" }, env);
		expect(p.status).toBe("pending");
		expect(readFileSync(overrides, "utf8")).toBe(before);
		expect(() => proposeOverrideTool({ slug, summary: `token ${SECRET}`, file: "overrides.ts", patch }, env)).toThrow(/secret/);
	});

	it("scrubSecrets removes env values and migration-key passwords, keeps short flags", () => {
		const key = `em1.${Buffer.from(JSON.stringify({ v: 1, url: "https://a.b", user: "u", pass: "abcd efgh ijkl mnop" })).toString("base64url")}`;
		const out = scrubSecrets(`a ${SECRET} b abcdefghijklmnop c ${key} staging 1`, { EMDASH_TOKEN: SECRET, EMDASH_WP_MIGRATION_KEY: key, MODE: "staging", FLAG: "1" });
		expect(out).not.toContain(SECRET);
		expect(out).not.toContain("abcdefghijklmnop");
		expect(out).not.toContain(key);
		expect(out).toContain("staging 1");
	});

	it("the server registers the seven tools over MCP", async () => {
		const server = createMcpServer(env);
		const [a, b] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: "test", version: "0" });
		await Promise.all([server.connect(a), client.connect(b)]);
		const { tools } = await client.listTools();
		expect(tools.map((t) => t.name).sort()).toEqual(["explain_gate", "list_diagnostics", "propose_override", "read_report", "run_phase", "status", "upgrade_verify"]);
		const r = await client.callTool({ name: "run_phase", arguments: { slug, phase: "load", target: "production" } });
		expect(JSON.stringify(r.content)).toMatch(/Refused/);
		const bad = await client.callTool({ name: "read_report", arguments: { slug, report: "../.env" } });
		expect(bad.isError).toBe(true);
		await client.close();
	});
});
