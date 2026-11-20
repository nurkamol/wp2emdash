import { appendFileSync } from "node:fs";
import { loadConfig } from "../config/load.js";
import { sitePaths } from "../core/paths.js";
import type { PhaseId } from "../core/phases.js";
import { createReporter, newRunId } from "../core/progress.js";
import { acceptGate, blockingPhase, type GateCheck, readState, recordGate, writeState } from "../core/state.js";
import { NotImplementedError, RUNNERS } from "../phases/index.js";

export interface RunOptions {
	json?: boolean;
	sitesDir?: string;
	/** Read-only phases only: run out of order and do not record the gate. */
	preview?: boolean;
	/** Progress goes to the run log only, nothing to stdout (the MCP server). */
	quiet?: boolean;
	/** load: allow writing to a live production (a D1 Time Travel bookmark is recorded first). */
	force?: boolean;
}

/** Phases that only read from WordPress (GET) or local files, write only inside the site workspace, and never touch Cloudflare. */
// cutover: its runner is the read-only preflight; the traffic switch is a separate owner-approved step (cutover/runbook.md).
export const PREVIEWABLE: PhaseId[] = ["audit", "extract", "transform", "scaffold", "load", "verify", "cutover"];

export interface RunResult {
	phase: PhaseId;
	ok: boolean;
	checks: GateCheck[];
	runId: string;
	notImplemented?: boolean;
}

/** Runs one phase: enforces order, streams progress, records the gate in state.json. */
export async function runPhase(slug: string, phase: PhaseId, opts: RunOptions = {}): Promise<RunResult> {
	const paths = sitePaths(slug, opts.sitesDir);
	let state = readState(paths.state);

	if (opts.preview && !PREVIEWABLE.includes(phase)) {
		throw new Error(`--preview is only allowed for read-only phases (${PREVIEWABLE.join(", ")}).`);
	}
	const blocker = opts.preview ? undefined : blockingPhase(state, phase);
	if (blocker) {
		throw new Error(`Cannot run "${phase}": gate "${blocker}" has not passed. Run it first, or accept it with a reason.`);
	}

	const config = await loadConfig(paths.config);
	const runId = newRunId();
	const reporter = createReporter({ runsDir: paths.runs, runId, json: !!opts.json, quiet: !!opts.quiet });
	const startedAt = new Date().toISOString();

	reporter.emit({ type: "phase:start", phase });
	let checks: GateCheck[];
	let notImplemented = false;
	try {
		checks = await RUNNERS[phase]({ config, paths, reporter, ...(opts.force ? { force: true } : {}) });
	} catch (err) {
		notImplemented = err instanceof NotImplementedError;
		const message = err instanceof Error ? err.message : String(err);
		reporter.emit({ type: "log", level: notImplemented ? "warn" : "error", message });
		if (notImplemented) {
			// Not a gate failure: state stays "pending" so the phase runs once it exists.
			return { phase, ok: false, checks: [], runId, notImplemented };
		}
		checks = [{ id: "crash", label: `${phase} crashed`, ok: false, detail: message }];
	}

	if (!opts.preview) {
		state = recordGate(state, phase, checks, { runId, startedAt });
		writeState(paths.state, state);
	} else {
		reporter.emit({ type: "log", level: "warn", message: "Preview run: gate result shown but not recorded." });
	}
	const ok = checks.every((c) => c.ok);
	for (const c of checks.filter((c) => !c.ok)) {
		reporter.emit({ type: "log", level: "error", message: `✖ ${c.label}${c.detail ? ` — ${c.detail}` : ""}` });
	}
	reporter.emit({ type: "phase:end", phase, ok });
	return { phase, ok, checks, runId };
}

/** Accepts a failed gate with a reason and logs it to decisions.md. */
export function acceptPhase(slug: string, phase: PhaseId, reason: string, by: string, sitesDir?: string): void {
	const paths = sitePaths(slug, sitesDir);
	const state = acceptGate(readState(paths.state), phase, reason);
	writeState(paths.state, state);
	const date = new Date().toISOString().slice(0, 10);
	const clean = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
	appendFileSync(paths.decisions, `| ${date} | ${phase} | Accepted failed gate | ${clean(reason)} | ${clean(by)} |\n`);
}
