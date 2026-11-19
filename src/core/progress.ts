import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import type { PhaseId } from "./phases.js";

/**
 * Progress events: phase → step → items. Every event goes to the run log
 * (sites/<slug>/runs/<runId>.jsonl), which the dashboard and agents read,
 * and to the terminal renderer unless --json is set.
 */
export type ProgressEvent =
	| { type: "phase:start"; phase: PhaseId }
	| { type: "step:start"; step: string; total?: number }
	| { type: "step:progress"; step: string; done: number; total?: number; item?: string }
	| { type: "step:end"; step: string; ok: boolean; detail?: string }
	| { type: "log"; level: "info" | "warn" | "error"; message: string }
	| { type: "phase:end"; phase: PhaseId; ok: boolean };

export interface Reporter {
	runId: string;
	emit(event: ProgressEvent): void;
}

export function newRunId(now = new Date()): string {
	return now.toISOString().replace(/[:.]/g, "-");
}

/** quiet: write the run log only (the MCP server, whose stdout is the protocol channel). */
export function createReporter(opts: { runsDir: string; runId: string; json: boolean; quiet?: boolean }): Reporter {
	mkdirSync(opts.runsDir, { recursive: true });
	const logFile = join(opts.runsDir, `${opts.runId}.jsonl`);
	return {
		runId: opts.runId,
		emit(event) {
			appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
			if (opts.quiet) return;
			if (opts.json) {
				process.stdout.write(`${JSON.stringify(event)}\n`);
			} else {
				render(event);
			}
		},
	};
}

function render(e: ProgressEvent): void {
	switch (e.type) {
		case "phase:start":
			console.log(pc.bold(pc.cyan(`\n▶ ${e.phase}`)));
			break;
		case "step:start":
			console.log(pc.dim(`  • ${e.step}${e.total ? ` (${e.total})` : ""}`));
			break;
		case "step:progress":
			if (process.stdout.isTTY) {
				const of = e.total ? `/${e.total}` : "";
				process.stdout.write(`\r    ${e.done}${of} ${pc.dim(e.item ?? "")}`.padEnd(80).slice(0, 100));
			}
			break;
		case "step:end":
			if (process.stdout.isTTY) process.stdout.write("\r".padEnd(100) + "\r");
			console.log(`  ${e.ok ? pc.green("✔") : pc.red("✖")} ${e.step}${e.detail ? pc.dim(` — ${e.detail}`) : ""}`);
			break;
		case "log": {
			const color = e.level === "error" ? pc.red : e.level === "warn" ? pc.yellow : pc.dim;
			console.log(color(`    ${e.message}`));
			break;
		}
		case "phase:end":
			console.log(e.ok ? pc.green(pc.bold(`✔ ${e.phase} gate passed`)) : pc.red(pc.bold(`✖ ${e.phase} gate failed`)));
			break;
	}
}
