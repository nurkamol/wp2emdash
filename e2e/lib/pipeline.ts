/**
 * Runs the kit's phases in order against the e2e site and records every gate. A failed gate does not stop the run:
 * later phases still run as `--preview` (read-only phases may run out of order and are not recorded), so one CI run
 * shows every problem at once. Nothing is ever accepted — the site's state.json keeps the real result.
 *
 * The phase runner is injected (`runPhase` from src/commands/run.ts in the real run, a fake in tests).
 */
import type { PhaseId } from "../../src/core/phases.js";
import type { GateCheck } from "../../src/core/state.js";

export interface PhaseOutcome {
	phase: PhaseId;
	/** "recorded": ran in order, gate recorded; "preview": an earlier gate failed, ran as --preview; "skipped": not run. */
	mode: "recorded" | "preview" | "skipped";
	ok: boolean;
	checks: GateCheck[];
	ms: number;
	runId?: string;
	error?: string;
	notImplemented?: boolean;
}

export type PhaseRunner = (phase: PhaseId, opts: { preview: boolean }) => Promise<{ ok: boolean; checks: GateCheck[]; runId: string; notImplemented?: boolean }>;

export interface Expectations {
	/** Phases whose gate must pass for the run to pass. */
	requiredPhases: PhaseId[];
	/** Phases that run and are reported, but whose failure does not fail the run (yet). */
	optionalPhases: PhaseId[];
	/** "<phase>:<checkId>" → reason. A known failure keeps its phase from failing the run; it is listed in the report. */
	knownFailures: Record<string, string>;
	/** "<slug>:<code>[:<tag>]" Elementor diagnostics allowed on the seeded pages. */
	allowedElementorDiagnostics: string[];
	/** Assertion ids that must pass; others are reported only. */
	requiredAssertions: string[];
	/** Phases after which to stop running when they fail (e.g. a missing transform makes scaffold pointless). */
	stopAfterFailure?: PhaseId[];
}

export async function runPhases(phases: PhaseId[], run: PhaseRunner, opts: { stopAfterFailure?: PhaseId[]; log?: (m: string) => void; /** An earlier batch already failed: run as --preview from the start. */ startBroken?: boolean } = {}): Promise<PhaseOutcome[]> {
	const out: PhaseOutcome[] = [];
	let broken = !!opts.startBroken;
	let stopped: PhaseId | undefined;
	for (const phase of phases) {
		if (stopped) {
			out.push({ phase, mode: "skipped", ok: false, checks: [], ms: 0, error: `not run: ${stopped} failed and stops the run (expectations.stopAfterFailure)` });
			continue;
		}
		const preview = broken;
		const t0 = Date.now();
		opts.log?.(`── ${phase}${preview ? " (preview: an earlier gate failed)" : ""}`);
		try {
			const r = await run(phase, { preview });
			const outcome: PhaseOutcome = { phase, mode: preview ? "preview" : "recorded", ok: r.ok && !r.notImplemented, checks: r.checks, ms: Date.now() - t0, runId: r.runId, ...(r.notImplemented ? { notImplemented: true } : {}) };
			out.push(outcome);
			if (!outcome.ok) broken = true;
		} catch (e) {
			out.push({ phase, mode: preview ? "preview" : "recorded", ok: false, checks: [], ms: Date.now() - t0, error: e instanceof Error ? e.message : String(e) });
			broken = true;
		}
		const last = out.at(-1) as PhaseOutcome;
		opts.log?.(`   ${last.ok ? "passed" : "FAILED"} in ${(last.ms / 1000).toFixed(1)}s${last.ok ? "" : `: ${failedChecks(last).map((c) => c.id).join(", ") || last.error}`}`);
		if (!last.ok && opts.stopAfterFailure?.includes(phase)) stopped = phase;
	}
	return out;
}

export const failedChecks = (o: PhaseOutcome) => o.checks.filter((c) => !c.ok);

export interface Verdict {
	ok: boolean;
	/** Why the run failed (empty when ok). */
	reasons: string[];
	/** Known failures that were seen (and so excused). */
	excused: string[];
	/** Known failures that did not occur any more: remove them from expectations.json. */
	stale: string[];
}

export function verdict(phases: PhaseOutcome[], assertions: { id: string; ok: boolean; skipped?: boolean }[], exp: Expectations): Verdict {
	const reasons: string[] = [];
	const excused: string[] = [];
	const seen = new Set<string>();
	for (const p of phases) {
		const required = exp.requiredPhases.includes(p.phase);
		if (p.mode === "skipped") {
			if (required) reasons.push(`${p.phase}: ${p.error ?? "not run"}`);
			continue;
		}
		if (p.error && !p.checks.length) {
			if (required) reasons.push(`${p.phase}: ${p.error}`);
			continue;
		}
		if (p.notImplemented && required) reasons.push(`${p.phase}: not implemented`);
		for (const c of failedChecks(p)) {
			const key = `${p.phase}:${c.id}`;
			seen.add(key);
			if (exp.knownFailures[key]) excused.push(`${key} — ${exp.knownFailures[key]}`);
			else if (required) reasons.push(`${key}${p.mode === "preview" ? " (preview, after an earlier failure)" : ""}: ${c.label}${c.detail ? ` — ${c.detail}` : ""}`);
		}
	}
	for (const a of assertions) {
		if (!exp.requiredAssertions.includes(a.id)) continue;
		if (a.skipped) reasons.push(`assertion ${a.id}: skipped (its input is missing)`);
		else if (!a.ok) reasons.push(`assertion ${a.id} failed`);
	}
	const ran = new Set(phases.filter((p) => p.mode !== "skipped").map((p) => p.phase));
	const stale = Object.keys(exp.knownFailures).filter((k) => ran.has(k.split(":")[0] as PhaseId) && !seen.has(k));
	return { ok: reasons.length === 0, reasons, excused, stale };
}
