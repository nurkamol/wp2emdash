import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { PHASE_IDS, type PhaseId, phaseIndex } from "./phases.js";

export const GATE_STATUS = ["pending", "running", "passed", "failed", "accepted"] as const;
export type GateStatus = (typeof GATE_STATUS)[number];

const checkSchema = z.object({
	id: z.string(),
	label: z.string(),
	ok: z.boolean(),
	detail: z.string().optional(),
});
export type GateCheck = z.infer<typeof checkSchema>;

const phaseStateSchema = z.object({
	status: z.enum(GATE_STATUS).default("pending"),
	startedAt: z.string().optional(),
	finishedAt: z.string().optional(),
	runId: z.string().optional(),
	checks: z.array(checkSchema).default([]),
	/** Set when a failed gate was accepted with --accept. */
	acceptedReason: z.string().optional(),
});
export type PhaseState = z.infer<typeof phaseStateSchema>;

const siteStateSchema = z.object({
	version: z.literal(1),
	slug: z.string(),
	createdAt: z.string(),
	updatedAt: z.string(),
	phases: z.record(z.string(), phaseStateSchema),
});
export type SiteState = z.infer<typeof siteStateSchema>;

export function newState(slug: string, now = new Date()): SiteState {
	const ts = now.toISOString();
	return {
		version: 1,
		slug,
		createdAt: ts,
		updatedAt: ts,
		phases: Object.fromEntries(PHASE_IDS.map((id) => [id, { status: "pending", checks: [] }])),
	};
}

export function readState(file: string): SiteState {
	return siteStateSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

/** Atomic write: temp file + rename, so a crash never leaves half a state file. */
export function writeState(file: string, state: SiteState): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2)}\n`);
	renameSync(tmp, file);
}

export function phaseState(state: SiteState, id: PhaseId): PhaseState {
	return state.phases[id] ?? { status: "pending", checks: [] };
}

const DONE: GateStatus[] = ["passed", "accepted"];

/** First earlier phase whose gate is not passed/accepted, or undefined if `id` may run. */
export function blockingPhase(state: SiteState, id: PhaseId): PhaseId | undefined {
	for (const prev of PHASE_IDS.slice(0, phaseIndex(id))) {
		if (!DONE.includes(phaseState(state, prev).status)) return prev;
	}
	return undefined;
}

/** The next phase to run: first one not passed/accepted. */
export function nextPhase(state: SiteState): PhaseId | undefined {
	return PHASE_IDS.find((id) => !DONE.includes(phaseState(state, id).status));
}

export function recordGate(
	state: SiteState,
	id: PhaseId,
	checks: GateCheck[],
	meta: { runId: string; startedAt: string },
): SiteState {
	const ok = checks.every((c) => c.ok);
	return {
		...state,
		phases: {
			...state.phases,
			[id]: {
				status: ok ? "passed" : "failed",
				startedAt: meta.startedAt,
				finishedAt: new Date().toISOString(),
				runId: meta.runId,
				checks,
			},
		},
	};
}

export function acceptGate(state: SiteState, id: PhaseId, reason: string): SiteState {
	const current = phaseState(state, id);
	if (current.status !== "failed") {
		throw new Error(`Only a failed gate can be accepted (phase "${id}" is ${current.status}).`);
	}
	if (reason.trim().length < 10) {
		throw new Error("Give a real reason (at least 10 characters); it is recorded in decisions.md.");
	}
	return {
		...state,
		phases: { ...state.phases, [id]: { ...current, status: "accepted", acceptedReason: reason.trim() } },
	};
}
