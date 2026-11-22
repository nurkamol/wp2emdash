/**
 * `wp2emdash mcp`: the kit's stdio MCP server for Claude Code (docs/PLAN.md §10b). Thin typed wrappers over the
 * engine (src/mcp/tools.ts). stdout is the protocol channel: console output is moved to stderr and phase runs are
 * quiet (progress goes to sites/<slug>/runs/<runId>.jsonl only).
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { PHASE_IDS } from "../core/phases.js";
import { PROPOSAL_FILES, RERUN_PHASES } from "../core/proposals.js";
import { defaultEnv, explainGateTool, listDiagnosticsTool, proposeOverrideTool, readReportTool, runPhaseTool, statusTool, type ToolEnv, upgradeVerifyTool } from "./tools.js";

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/).describe("Site slug (folder under sites/)");
const phase = z.enum(PHASE_IDS as [string, ...string[]]).describe(`Pipeline phase: ${PHASE_IDS.join(" → ")}`);

function result(fn: () => unknown | Promise<unknown>) {
	return async () => {
		try {
			const value = await fn();
			return { content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
		} catch (e) {
			return { content: [{ type: "text" as const, text: (e as Error).message }], isError: true };
		}
	};
}

export function createMcpServer(env: ToolEnv = defaultEnv()): McpServer {
	const server = new McpServer({ name: "wp2emdash", version: "0.1.0" }, { instructions: "wp2emdash kit: migrate WordPress sites to EmDash with automated gates. Run phases in order, stop at a red gate and explain it (explain_gate). Never accept a gate (only the owner, via `wp2emdash accept`), never edit overrides.ts/decisions.md directly (propose_override → the owner approves), never deploy to production or change DNS/routes." });

	server.registerTool(
		"status",
		{
			title: "Site status",
			description: "Phase timeline for every site (or one slug): each phase's gate status and failing-check count, the next phase to run, and the project path.",
			inputSchema: { slug: slug.optional() },
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		(a) => result(() => statusTool(a, env))(),
	);

	server.registerTool(
		"run_phase",
		{
			title: "Run a pipeline phase",
			description: [
				"Runs one phase with the same engine as `wp2emdash run` and returns its gate checks (id, label, ok, detail) and exit status (0 pass · 2 gate failed · 3 not built yet · 1 error/refused). Phases run only when every earlier gate passed or was accepted, unless preview: true (read-only phases: run out of order, gate not recorded).",
				"Allowed: init, audit, extract, transform, scaffold, verify, and any preview run. load only against target local (default) or staging. cutover only with preview: true (the read-only preflight).",
				"This tool REFUSES anything that would deploy to production, load into or verify against production, or change DNS / Worker routes: those are the owner's steps, with explicit approval at the time. It never accepts a failed gate.",
			].join("\n"),
			inputSchema: {
				slug,
				phase,
				preview: z.boolean().optional().describe("Run out of order without recording the gate (read-only phases; cutover requires it)"),
				target: z.enum(["local", "staging", "production"]).optional().describe("load / verify only: local dev server or staging. production is always refused."),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
		},
		(a) => result(() => runPhaseTool(a, env))(),
	);

	server.registerTool(
		"read_report",
		{
			title: "Read a report",
			description: `Returns a text report under sites/<slug>/reports/ (e.g. "transform/coverage.md", "verify/verify.json"); pass report: "" or a folder to list the text reports. Only files inside reports/ (no .. or links out), text only, capped at 256 KB, secrets scrubbed.`,
			inputSchema: { slug, report: z.string().max(400).optional().describe("Path relative to reports/") },
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		(a) => result(() => readReportTool(a, env))(),
	);

	server.registerTool(
		"list_diagnostics",
		{
			title: "Transform diagnostics",
			description: "The coverage/diagnostic items from the latest transform (reports/transform/coverage.json): level, code, message, IR file, row path and the `<slug>:<path>` key to use in overrides.elements / approvedLegacy. Blocking items (content-carrying errors in published pages) first. Also lists what was not transformed.",
			inputSchema: {
				slug,
				level: z.enum(["info", "warn", "error"]).optional().describe("Minimum level (default: all)"),
				publishedOnly: z.boolean().optional().describe("Only published documents"),
			},
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		(a) => result(() => listDiagnosticsTool(a, env))(),
	);

	server.registerTool(
		"explain_gate",
		{
			title: "Explain a gate",
			description: "Plain-language explanation of a phase's gate: status, what blocks it, each failing check with its detail and the documented fix (from state.json, or the latest run log for preview runs such as the cutover preflight). Accepting a failed gate stays with the owner.",
			inputSchema: { slug, phase },
			annotations: { readOnlyHint: true, openWorldHint: false },
		},
		(a) =>
			result(() => {
				const r = explainGateTool(a, env);
				return `${r.explanation}\n\n${JSON.stringify({ status: r.status, source: r.source, failing: r.failing }, null, 2)}`;
			})(),
	);

	server.registerTool(
		"propose_override",
		{
			title: "Propose an override",
			description: "Queues a change to sites/<slug>/overrides.ts or decisions.md for the owner's approval; it NEVER edits the file. Give a unified diff with paths relative to sites/<slug>/ (--- a/overrides.ts / +++ b/overrides.ts) against the current file; it must apply cleanly (checked now, and again on approval). Returns the proposal id. The owner approves in the dashboard or with `wp2emdash proposals <slug> approve <id> --by …`, then the rerun phase runs. No secrets in the patch.",
			inputSchema: {
				slug,
				summary: z.string().min(1).max(500).describe("One line: what changes and why"),
				file: z.enum(PROPOSAL_FILES),
				patch: z.string().min(1).max(64 * 1024).describe("Unified diff touching only `file`"),
				rerun: z.enum(RERUN_PHASES).optional().describe("Phase to rerun after approval"),
			},
			annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
		},
		(a) => result(() => proposeOverrideTool(a, env))(),
	);

	server.registerTool(
		"upgrade_verify",
		{
			title: "Compare a site with its pre-upgrade snapshot",
			description: "Read-only part of `wp2emdash upgrade`: snapshots production (default) or staging now — GET requests only — and compares every page with the latest reports/upgrade/<timestamp>/before.json (status, title, description, h1, lang, hreflang count, visible text, link/image/form counts, fonts; asset hashes, cache-busting strings, copyright year and kit version ignored). Writes compare-<target>.json/.md there (read them with read_report). exitCode 0 identical · 2 differences · 1 error. It never rebuilds or deploys: the before snapshot, rebuild and staging deploy are the operator's `wp2emdash upgrade <slug>`, the production deploy the owner's.",
			inputSchema: { slug, against: z.enum(["production", "staging"]).optional().describe("Address to compare (default production)") },
			annotations: { readOnlyHint: true, openWorldHint: true },
		},
		(a) => result(() => upgradeVerifyTool(a, env))(),
	);

	return server;
}

/** Runs the server on stdio until the client disconnects. */
export async function serveMcp(env: ToolEnv = defaultEnv()): Promise<void> {
	// Anything printed by the engine must not corrupt the JSON-RPC stream on stdout.
	const toErr = (...args: unknown[]) => console.error(...args);
	console.log = toErr;
	console.info = toErr;
	console.debug = toErr;
	console.warn = toErr;
	const server = createMcpServer(env);
	await server.connect(new StdioServerTransport());
}
