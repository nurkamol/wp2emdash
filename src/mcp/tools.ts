/**
 * The kit MCP server's tools (docs/PLAN.md §10b, "Claude Code — the reasoning loop"), as plain functions over the
 * engine so they can be tested without a transport. Every result is scrubbed of the site's env values; nothing here
 * returns .env contents, writes overrides.ts / decisions.md, deploys to production or touches DNS / routes.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { runPhase as engineRunPhase, type RunOptions, type RunResult } from "../commands/run.js";
import { listSites, statusJson } from "../commands/status.js";
import { KIT_ROOT, SITES_DIR, sitePaths } from "../core/paths.js";
import { isPhaseId, PHASE_IDS, PHASES, type PhaseId } from "../core/phases.js";
import { createProposal, type Proposal, type ProposalFile, type RerunPhase } from "../core/proposals.js";
import { blockingPhase, type GateCheck, phaseState, readState } from "../core/state.js";
import { loadSiteEnv, scrubSecrets } from "../extract/credentials.js";
import type { Diagnostic } from "../ir/schema.js";
import { isSiteSlug, runHistory } from "../ui/data.js";

export interface ToolEnv {
	sitesDir: string;
	/** Where the kit-level .env lives (scrubbed as well as the site's). */
	kitRoot: string;
	/** Injected in tests; defaults to the engine's runPhase. */
	runPhase?: (slug: string, phase: PhaseId, opts: RunOptions) => Promise<RunResult>;
}

export const defaultEnv = (): ToolEnv => ({ sitesDir: SITES_DIR, kitRoot: KIT_ROOT });

export class ToolError extends Error {}

function assertSite(slug: string, env: ToolEnv): void {
	if (!isSiteSlug(slug, env.sitesDir)) throw new ToolError(`No site "${slug}". Sites: ${listSites(env.sitesDir).join(", ") || "none"}`);
}

/** Every value from the kit .env and the site's .env, removed from `text`. */
export function scrubFor(slug: string | undefined, text: string, env: ToolEnv): string {
	const values = slug ? loadSiteEnv(sitePaths(slug, env.sitesDir).root, env.kitRoot) : loadSiteEnv(join(env.sitesDir, ".none"), env.kitRoot);
	return scrubSecrets(text, values);
}

// ── status ─────────────────────────────────────────────────────────────────────────────────────────────
export function statusTool(input: { slug?: string | undefined }, env: ToolEnv) {
	if (input.slug) assertSite(input.slug, env);
	const slugs = input.slug ? [input.slug] : listSites(env.sitesDir);
	return slugs.map((slug) => {
		try {
			const s = statusJson(slug, env.sitesDir);
			return {
				slug,
				next: s.next,
				project: s.project,
				phases: PHASES.map((p) => {
					const ps = phaseState(s, p.id);
					return { id: p.id, title: p.title, status: ps.status, failing: ps.checks.filter((c) => !c.ok).length, ...(ps.finishedAt ? { finishedAt: ps.finishedAt } : {}), ...(ps.acceptedReason ? { acceptedReason: ps.acceptedReason } : {}) };
				}),
			};
		} catch (e) {
			return { slug, error: `state.json unreadable: ${(e as Error).message.split("\n")[0]}` };
		}
	});
}

// ── run_phase ──────────────────────────────────────────────────────────────────────────────────────────
export type RunTarget = "local" | "staging" | "production";

/** Phases Claude may run (recording the gate) without the owner. load also needs a non-production target. */
export const AGENT_PHASES: PhaseId[] = ["init", "audit", "extract", "transform", "scaffold", "load", "verify"];

/**
 * Why the agent may not run this, or undefined when it may. Production is never a target (load writes to it;
 * verify there is the owner's post-deploy step) and cutover only runs as its read-only preflight (preview).
 */
export function runRefusal(phase: PhaseId, opts: { preview?: boolean | undefined; target?: RunTarget | undefined }): string | undefined {
	if (opts.target === "production") {
		return "Refused: the agent never runs phases against production. Production load, verify and deploys are owner steps — ask the owner to run them (wp2emdash-cutover skill).";
	}
	if (opts.target && phase !== "load" && phase !== "verify") return `target only applies to load and verify, not ${phase}`;
	if (phase === "cutover" && !opts.preview) {
		return "Refused: cutover runs only as its read-only preflight here (preview: true). The deploy, Worker routes and DNS switch need the owner's explicit approval at the time (cutover/runbook.md).";
	}
	if (!AGENT_PHASES.includes(phase) && phase !== "cutover") return `Unknown phase ${phase}`;
	return undefined;
}

export interface RunPhaseOutput {
	slug: string;
	phase: PhaseId;
	preview: boolean;
	target?: RunTarget;
	status: "passed" | "failed" | "not-built" | "refused" | "error";
	/** Same as `wp2emdash run`: 0 pass · 2 gate failed · 3 not built yet · 1 error/refused. */
	exitCode: 0 | 1 | 2 | 3;
	runId?: string;
	checks: GateCheck[];
	message?: string;
}

// One phase at a time: the target is passed to the runners through process.env.
let queue: Promise<unknown> = Promise.resolve();
const TARGET_VARS = ["WP2EMDASH_LOAD_TARGET", "WP2EMDASH_TARGET"] as const;

async function withTarget<T>(target: RunTarget | undefined, fn: () => Promise<T>): Promise<T> {
	const run = queue.then(async () => {
		const saved = [...TARGET_VARS, "WP2EMDASH_NO_PRODUCTION"].map((k) => [k, process.env[k]] as const);
		// Never inherit a production target from the server's environment: set the chosen one, or clear to the
		// runners' own defaults (opt-in staging: load local, verify staging if known; single environment: local here,
		// because WP2EMDASH_NO_PRODUCTION keeps any default — and any explicit target — off production).
		for (const k of TARGET_VARS) {
			if (target) process.env[k] = target;
			else delete process.env[k];
		}
		process.env.WP2EMDASH_NO_PRODUCTION = "1";
		try {
			return await fn();
		} finally {
			for (const [k, v] of saved) {
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
		}
	});
	queue = run.catch(() => {});
	return run;
}

export async function runPhaseTool(input: { slug: string; phase: string; preview?: boolean | undefined; target?: RunTarget | undefined }, env: ToolEnv): Promise<RunPhaseOutput> {
	assertSite(input.slug, env);
	if (!isPhaseId(input.phase)) throw new ToolError(`Unknown phase "${input.phase}". Phases: ${PHASE_IDS.join(", ")}`);
	const phase = input.phase;
	const preview = !!input.preview;
	const base = { slug: input.slug, phase, preview, ...(input.target ? { target: input.target } : {}) };
	const refusal = runRefusal(phase, { preview, target: input.target });
	if (refusal) return { ...base, status: "refused", exitCode: 1, checks: [], message: refusal };
	const run = env.runPhase ?? engineRunPhase;
	try {
		const r = await withTarget(input.target, () => run(input.slug, phase, { sitesDir: env.sitesDir, preview, quiet: true }));
		const status = r.ok ? "passed" : r.notImplemented ? "not-built" : "failed";
		const notes = [
			...(status === "failed" ? [`${r.checks.filter((c) => !c.ok).length} check(s) failing. Use explain_gate; only the owner can accept a failed gate (wp2emdash accept).`] : []),
			...(status === "not-built" ? [`Phase "${phase}" is not built yet.`] : []),
			...(preview ? ["Preview run: gate shown, not recorded."] : []),
		];
		const out: RunPhaseOutput = { ...base, status, exitCode: r.ok ? 0 : r.notImplemented ? 3 : 2, runId: r.runId, checks: r.checks, ...(notes.length ? { message: notes.join(" ") } : {}) };
		return JSON.parse(scrubFor(input.slug, JSON.stringify(out), env)) as RunPhaseOutput;
	} catch (e) {
		return { ...base, status: "error", exitCode: 1, checks: [], message: scrubFor(input.slug, (e as Error).message, env) };
	}
}

// ── read_report ────────────────────────────────────────────────────────────────────────────────────────
export const REPORT_MAX_BYTES = 256 * 1024;
const TEXT_EXT = new Set([".json", ".jsonl", ".md", ".txt", ".csv", ".html", ".xml", ".log"]);

/**
 * Resolves `report` (relative to sites/<slug>/reports/) to a path inside that folder, following symlinks;
 * throws for absolute paths, `..` escapes, or links that leave reports/.
 */
export function resolveReport(slug: string, report: string, env: ToolEnv): string {
	const reports = sitePaths(slug, env.sitesDir).reports;
	const rel = normalize(report.replace(/\\/g, "/")).replace(/^(\.\/)+/, "");
	if (isAbsolute(report) || rel === ".." || rel.startsWith(`..${sep}`) || rel.split(sep).includes("..") || report.includes("\0")) {
		throw new ToolError(`"${report}" is not a path inside reports/`);
	}
	const target = join(reports, rel === "." ? "" : rel);
	if (!existsSync(reports)) throw new ToolError("No reports yet for this site");
	if (!existsSync(target)) throw new ToolError(`No report "${report}" (see read_report with report: "" for the list)`);
	const realRoot = realpathSync(reports);
	const real = realpathSync(target);
	const r = relative(realRoot, real);
	if (r.startsWith("..") || isAbsolute(r)) throw new ToolError(`"${report}" leaves reports/`);
	return real;
}

function listDir(dir: string, root: string, depth = 0, out: string[] = []): string[] {
	for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		const full = join(dir, e.name);
		if (e.isDirectory()) {
			if (depth < 2) listDir(full, root, depth + 1, out);
			else out.push(`${relative(root, full)}/`);
		} else if (e.isFile() && TEXT_EXT.has(extname(e.name).toLowerCase())) {
			out.push(relative(root, full));
		}
		if (out.length >= 300) break;
	}
	return out;
}

export function readReportTool(input: { slug: string; report?: string | undefined }, env: ToolEnv): { path: string; kind: "list" | "file"; text: string; truncated?: boolean; bytes?: number } {
	assertSite(input.slug, env);
	const reports = sitePaths(input.slug, env.sitesDir).reports;
	const real = resolveReport(input.slug, input.report ?? "", env);
	const rel = relative(realpathSync(reports), real) || ".";
	const st = statSync(real);
	if (st.isDirectory()) return { path: rel, kind: "list", text: listDir(real, realpathSync(reports)).join("\n") || "(no text reports)" };
	if (!st.isFile()) throw new ToolError(`"${input.report}" is not a file`);
	if (!TEXT_EXT.has(extname(real).toLowerCase())) throw new ToolError(`Only text reports can be read (${[...TEXT_EXT].join(", ")}); screenshots are in the dashboard (wp2emdash ui).`);
	const buf = readFileSync(real);
	const truncated = buf.length > REPORT_MAX_BYTES;
	const text = buf.subarray(0, REPORT_MAX_BYTES).toString("utf8");
	return { path: rel, kind: "file", text: scrubFor(input.slug, text, env) + (truncated ? `\n…[truncated at ${REPORT_MAX_BYTES} of ${buf.length} bytes]` : ""), ...(truncated ? { truncated } : {}), bytes: buf.length };
}

// ── list_diagnostics ───────────────────────────────────────────────────────────────────────────────────
interface CoverageJson {
	documents?: { file: string; published: boolean; builder?: string; diagnostics?: Diagnostic[] }[];
	notTransformed?: string[];
}

export interface DiagnosticItem extends Diagnostic {
	/** IR document file under sites/<slug>/ir/ (e.g. pages/about.json). */
	file: string;
	/** WordPress slug of the document: the prefix of overrides.elements / approvedLegacy keys (`<slug>:<path>`). */
	docSlug?: string;
	published: boolean;
	builder?: string;
	/** `<docSlug>:<path>` — the key to use in overrides.elements / approvedLegacy. */
	overrideKey?: string;
}

const LEVELS = ["info", "warn", "error"] as const;
export const DIAGNOSTICS_MAX = 400;

export function listDiagnosticsTool(input: { slug: string; level?: (typeof LEVELS)[number] | undefined; publishedOnly?: boolean | undefined }, env: ToolEnv) {
	assertSite(input.slug, env);
	const paths = sitePaths(input.slug, env.sitesDir);
	const file = join(paths.reports, "transform", "coverage.json");
	if (!existsSync(file)) throw new ToolError("No transform coverage yet: run_phase transform first");
	const cov = JSON.parse(readFileSync(file, "utf8")) as CoverageJson;
	const min = input.level ? LEVELS.indexOf(input.level) : 0;
	const items: DiagnosticItem[] = [];
	for (const d of cov.documents ?? []) {
		if (input.publishedOnly && !d.published) continue;
		let docSlug: string | undefined;
		try {
			const irFile = join(paths.ir, d.file);
			if (!relative(paths.ir, irFile).startsWith("..") && existsSync(irFile)) docSlug = (JSON.parse(readFileSync(irFile, "utf8")) as { source?: { slug?: string } }).source?.slug;
		} catch {
			// slug stays unknown
		}
		for (const diag of d.diagnostics ?? []) {
			if (LEVELS.indexOf(diag.level) < min) continue;
			items.push({ ...diag, file: d.file, published: d.published, ...(d.builder ? { builder: d.builder } : {}), ...(docSlug ? { docSlug } : {}), ...(docSlug && diag.path ? { overrideKey: `${docSlug}:${diag.path}` } : {}) });
		}
	}
	// Content-carrying errors in published documents first: those block the transform gate.
	const rank = (i: DiagnosticItem) => (i.published ? 0 : 4) + (i.carriesContent ? 0 : 2) + (2 - LEVELS.indexOf(i.level)) / 3;
	items.sort((a, b) => rank(a) - rank(b));
	const out = {
		total: items.length,
		blocking: items.filter((i) => i.published && i.carriesContent && i.level === "error").length,
		items: items.slice(0, DIAGNOSTICS_MAX),
		...(items.length > DIAGNOSTICS_MAX ? { truncated: true } : {}),
		notTransformed: cov.notTransformed ?? [],
		report: "reports/transform/coverage.md",
	};
	return JSON.parse(scrubFor(input.slug, JSON.stringify(out), env)) as typeof out;
}

// ── explain_gate ───────────────────────────────────────────────────────────────────────────────────────
/** The documented fix per check, in plain language. Keys: `<phase>:<check id>`, or `<phase>:*` for the phase. */
export const FIX_HINTS: Record<string, string> = {
	"init:*": "Tick the (required) items in sites/<slug>/ACCESS.md once they are really done (backup downloaded and opened, exporter key in .env, …), then rerun init.",
	"audit:*": "Read reports/audit/ (URL list, integrations.md). Network or bot-protection failures: rerun audit; scope decisions go in decisions.md.",
	"extract:credentials": "The owner puts the exporter migration key (EMDASH_WP_MIGRATION_KEY) or WP_APP_USER/WP_APP_PASSWORD in sites/<slug>/.env — never in a prompt.",
	"extract:auth": "The exporter key or application password is wrong or revoked: the owner creates a new one in WordPress and updates sites/<slug>/.env.",
	"extract:*": "Read reports/extract/. Missing files or counts: rerun extract; anything that cannot be fetched is a decision for decisions.md.",
	"transform:unmapped": "Content the adapters could not map. Use list_diagnostics: a generic element → new adapter handler + fixture + golden test; a one-off → propose_override (overrides.elements[\"<slug>:<path>\"] = section type) with rerun transform.",
	"transform:legacy-html": "legacy_html sections ship raw HTML. Map them (handler or overrides.elements) or, if the owner agrees they can ship as-is, propose adding \"<slug>:<path>\" to overrides.approvedLegacy.",
	"transform:links": "Internal links to pages that were not migrated. Fix the route (overrides.routes) or the source link; the owner decides about deleted pages.",
	"transform:media-refs": "A media reference is missing from the extract: rerun extract (media), or decide copy/hotlink in overrides.media.external.",
	"transform:images-kept": "An image WordPress uses was lost in the IR: usually an adapter handler drops it — fix the handler (fixture + golden test).",
	"transform:text-conservation": "Live page text missing from the IR: see the page's missing words in reports/transform/coverage.md and map the element that carries them.",
	"transform:*": "Read reports/transform/coverage.md; fix via adapter handlers (with fixture + golden test) or overrides.ts, then rerun transform.",
	"scaffold:*": "Read the scaffold run log (install/build/typecheck output). Fix the starter or generator in the kit, not the generated project, then rerun scaffold.",
	"load:*": "Read reports/load/. Check the target is up (local dev server, or opt-in staging + EMDASH_TOKEN) and rerun load against local or staging. Production (the default for a single-environment site on the command line) is the operator's step.",
	"verify:visual": "A section differs visually beyond the limit: wp2emdash-visual-fix skill (measure source vs target, fix adapter/starter CSS with a fixture, or propose an override); the owner can approve a difference in the dashboard.",
	"verify:target": "No verify target: run against the local dev server (target local). Single-environment sites verify production on its workers.dev address from the command line (operator); opt-in staging sites need target.stagingUrl.",
	"verify:*": "Read reports/verify/verify.json and index.html; fix the cause upstream (transform/scaffold/load) and rerun verify.",
	"cutover:*": "Preflight only reports. Production resources, secrets, Turnstile and DNS are owner steps (cutover/runbook.md); never change DNS or routes without the owner's explicit approval.",
};

export function fixHint(phase: PhaseId, checkId: string): string | undefined {
	return FIX_HINTS[`${phase}:${checkId}`] ?? FIX_HINTS[`${phase}:*`];
}

export function explainGateTool(input: { slug: string; phase: string }, env: ToolEnv) {
	assertSite(input.slug, env);
	if (!isPhaseId(input.phase)) throw new ToolError(`Unknown phase "${input.phase}"`);
	const phase = input.phase;
	const state = readState(sitePaths(input.slug, env.sitesDir).state);
	const ps = phaseState(state, phase);
	const blocker = blockingPhase(state, phase);
	let source: "state" | "run-log" | "none" = ps.checks.length ? "state" : "none";
	let failing: { id: string; label: string; detail?: string; fix?: string }[] = ps.checks
		.filter((c) => !c.ok)
		.map((c) => {
			const fix = fixHint(phase, c.id);
			return { id: c.id, label: c.label, ...(c.detail ? { detail: c.detail } : {}), ...(fix ? { fix } : {}) };
		});
	let lastRunId = ps.runId;
	if (!ps.checks.length) {
		// Preview runs (e.g. cutover preflight) are not recorded in state: fall back to the latest run log.
		const last = runHistory(input.slug, env.sitesDir, 200).find((r) => r.phase === phase && r.finished);
		if (last) {
			source = "run-log";
			lastRunId = last.runId;
			failing = last.errors
				.filter((m) => m.startsWith("✖ "))
				.map((m, i) => {
					const [label, ...rest] = m.slice(2).split(" — ");
					const fix = fixHint(phase, "*");
					return { id: `run:${i}`, label: label ?? m, ...(rest.length ? { detail: rest.join(" — ") } : {}), ...(fix ? { fix } : {}) };
				});
		}
	}
	const lines: string[] = [];
	if (ps.status === "passed") lines.push(`${phase} passed (${ps.checks.length} checks).`);
	else if (ps.status === "accepted") lines.push(`${phase} failed but the owner accepted it: ${ps.acceptedReason ?? ""}`);
	else if (ps.status === "pending" && !failing.length) lines.push(`${phase} has not run yet.${blocker ? ` It is blocked by "${blocker}", which has not passed.` : " It can run now."}`);
	else lines.push(`${phase} ${ps.status === "failed" ? "failed" : `(${ps.status}, from the latest preview run)`}: ${failing.length} check(s) failing.`);
	for (const f of failing) lines.push(`- ${f.label} [${f.id}]${f.detail ? `: ${f.detail}` : ""}${f.fix ? `\n  Fix: ${f.fix}` : ""}`);
	if (failing.length) lines.push(`Only the owner can accept a failed gate: pnpm wp2emdash accept ${input.slug} ${phase} --reason "…" --by "…". Do not run it for them.`);
	const out = { slug: input.slug, phase, status: ps.status, source, ...(lastRunId ? { runId: lastRunId } : {}), ...(blocker ? { blockedBy: blocker } : {}), failing, explanation: lines.join("\n") };
	return JSON.parse(scrubFor(input.slug, JSON.stringify(out), env)) as typeof out;
}

// ── propose_override ───────────────────────────────────────────────────────────────────────────────────
export function proposeOverrideTool(input: { slug: string; summary: string; file: ProposalFile; patch: string; rerun?: RerunPhase | null | undefined }, env: ToolEnv): Proposal {
	assertSite(input.slug, env);
	// The patch lands in a file and in the browser: no secrets in it.
	if (scrubFor(input.slug, `${input.summary}\n${input.patch}`, env) !== `${input.summary}\n${input.patch}`) {
		throw new ToolError("The proposal contains a secret value from .env (or a credential); remove it. Secrets never go in overrides.ts or decisions.md.");
	}
	try {
		return createProposal(input.slug, { summary: input.summary, file: input.file, patch: input.patch, rerun: input.rerun ?? null, by: "claude" }, { sitesDir: env.sitesDir });
	} catch (e) {
		throw new ToolError(`Proposal not written: ${(e as Error).message}`);
	}
}

// ── upgrade_verify ─────────────────────────────────────────────────────────────────────────────────────
/**
 * Read-only part of `wp2emdash upgrade`: snapshot production (or staging) now and compare it with the latest
 * before.json. Only GET requests to the public site; writes the comparison under reports/upgrade/. It never rebuilds,
 * deploys or takes the before snapshot (the operator's `wp2emdash upgrade <slug>`).
 */
export async function upgradeVerifyTool(input: { slug: string; against?: "production" | "staging" | undefined }, env: ToolEnv & { fetcher?: typeof fetch }) {
	assertSite(input.slug, env);
	const { upgrade } = await import("../commands/upgrade.js");
	try {
		const r = await upgrade(input.slug, { sitesDir: env.sitesDir, verify: input.against ?? "production" }, env.fetcher ? { fetcher: env.fetcher } : {});
		return JSON.parse(scrubFor(input.slug, JSON.stringify(r), env)) as typeof r;
	} catch (e) {
		throw new ToolError(scrubFor(input.slug, (e as Error).message, env));
	}
}
