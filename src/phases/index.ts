import type { KitConfig } from "../config/schema.js";
import type { SitePaths } from "../core/paths.js";
import { getPhase, type PhaseId } from "../core/phases.js";
import type { Reporter } from "../core/progress.js";
import type { GateCheck } from "../core/state.js";
import { runAudit } from "./audit.js";
import { runExtract } from "./extract.js";
import { runInitGate } from "./init.js";
import { runLoad } from "./load.js";
import { runScaffold } from "./scaffold.js";
import { runTransform } from "./transform.js";

export interface PhaseContext {
	config: KitConfig;
	paths: SitePaths;
	reporter: Reporter;
}

/** A phase does its work, then returns the gate checks. Thrown errors count as a failed gate. */
export type PhaseRunner = (ctx: PhaseContext) => Promise<GateCheck[]>;

export class NotImplementedError extends Error {
	constructor(phase: PhaseId) {
		const p = getPhase(phase);
		super(`Phase "${phase}" is planned for ${p.milestone} and not implemented yet.`);
	}
}

const notYet =
	(phase: PhaseId): PhaseRunner =>
	async () => {
		throw new NotImplementedError(phase);
	};

export const RUNNERS: Record<PhaseId, PhaseRunner> = {
	init: runInitGate,
	audit: runAudit,
	extract: runExtract,
	transform: runTransform,
	scaffold: (ctx) => runScaffold(ctx),
	load: runLoad,
	verify: notYet("verify"),
	cutover: notYet("cutover"),
};
