/**
 * Approval queue for the dashboard (docs/PLAN.md §10b). Proposals are read, created and decided through
 * src/core/proposals.ts; this module adds what the browser needs (the exact rerun command, input checks) and the
 * unified-diff writer the section inspector uses. Approving applies the patch; it never accepts a gate.
 */
import { SITES_DIR } from "../core/paths.js";
import { applyProposal, listProposals, type Proposal, readProposal, rejectProposal } from "../core/proposals.js";
import { UserError } from "./data.js";

/** Phases the dashboard may start itself after an approval, always as preview runs (gate not recorded). */
export const DASHBOARD_RERUNS = ["transform", "scaffold", "verify"] as const;
export type DashboardRerun = (typeof DASHBOARD_RERUNS)[number];
export const canStartFromDashboard = (phase: string | null | undefined): phase is DashboardRerun => !!phase && (DASHBOARD_RERUNS as readonly string[]).includes(phase);

export interface ProposalView extends Proposal {
	/** The command that reruns the affected phase and records its gate. */
	command?: string;
	/** True when the dashboard can start the rerun itself (preview). */
	previewable: boolean;
}

const view = (slug: string, p: Proposal): ProposalView => ({
	...p,
	...(p.rerun ? { command: `pnpm wp2emdash run ${slug} ${p.rerun}` } : {}),
	previewable: canStartFromDashboard(p.rerun),
});

/** Pending first (oldest first, the order they were proposed), then decided ones, newest first. */
export function proposalsView(slug: string, sitesDir = SITES_DIR): ProposalView[] {
	const all = listProposals(slug, { sitesDir });
	const pending = all.filter((p) => p.status === "pending");
	const decided = all.filter((p) => p.status !== "pending").reverse();
	return [...pending, ...decided].map((p) => view(slug, p));
}

/** One line of free text from the browser: no control characters, bounded. */
export function oneLine(v: unknown, what: string, max: number, required: boolean): string | undefined {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
	const s = typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim() : "";
	if (!s) {
		if (required) throw new UserError(`${what} is required.`);
		return undefined;
	}
	if (s.length > max) throw new UserError(`${what} is too long (max ${max} characters).`);
	return s;
}

export function decideProposal(slug: string, id: string, decision: "approve" | "reject", body: { by?: unknown; note?: unknown }, sitesDir = SITES_DIR): ProposalView {
	const by = oneLine(body.by, "Name", 120, true) as string;
	const note = oneLine(body.note, "Note", 1000, false);
	let p: Proposal | undefined;
	try {
		p = readProposal(slug, id, { sitesDir });
	} catch {
		p = undefined;
	}
	if (!p) throw new UserError("Unknown proposal.");
	if (p.status !== "pending") throw new UserError(`This proposal is already ${p.status}.`);
	try {
		const opts = { sitesDir, ...(note ? { note } : {}) };
		return view(slug, decision === "approve" ? applyProposal(slug, id, by, opts) : rejectProposal(slug, id, by, opts));
	} catch (e) {
		throw new UserError((e as Error).message);
	}
}

// ── Unified diff (small files: overrides.ts) ──────────────────────────────────────────────────────────────────

/** Line diff of two texts as a unified diff with 3 lines of context, paths relative to sites/<slug>/. */
export function unifiedDiff(before: string, after: string, file: string): string {
	const split = (t: string) => (t === "" ? [] : t.replace(/\n$/, "").split("\n"));
	const a = split(before);
	const b = split(after);
	// LCS table (files here are a few hundred lines at most).
	const n = a.length;
	const m = b.length;
	const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
	const at = (i: number, j: number) => (lcs[i] as number[])[j] as number;
	for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) (lcs[i] as number[])[j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
	type Op = { t: " " | "-" | "+"; s: string };
	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	while (i < n || j < m) {
		if (i < n && j < m && a[i] === b[j]) {
			ops.push({ t: " ", s: a[i] as string });
			i++;
			j++;
		} else if (j < m && (i >= n || at(i, j + 1) >= at(i + 1, j))) ops.push({ t: "+", s: b[j++] as string });
		else ops.push({ t: "-", s: a[i++] as string });
	}
	const ctx = 3;
	const out = [`--- ${before === "" ? "/dev/null" : `a/${file}`}`, `+++ b/${file}`];
	const count = (upto: number, side: "-" | "+") => ops.slice(0, upto).filter((o) => o.t === " " || o.t === side).length;
	let k = 0;
	while (k < ops.length) {
		while (k < ops.length && (ops[k] as Op).t === " ") k++;
		if (k >= ops.length) break;
		const start = Math.max(0, k - ctx);
		let end = k;
		for (;;) {
			while (end < ops.length && (ops[end] as Op).t !== " ") end++;
			let run = end;
			while (run < ops.length && (ops[run] as Op).t === " ") run++;
			if (run < ops.length && run - end <= ctx * 2) end = run;
			else {
				end = Math.min(ops.length, end + ctx);
				break;
			}
		}
		const hunk = ops.slice(start, end);
		const aLines = hunk.filter((o) => o.t !== "+").length;
		const bLines = hunk.filter((o) => o.t !== "-").length;
		const aStart = count(start, "-") + (aLines ? 1 : 0);
		const bStart = count(start, "+") + (bLines ? 1 : 0);
		out.push(`@@ -${aStart},${aLines} +${bStart},${bLines} @@`);
		for (const o of hunk) out.push(`${o.t}${o.s}`);
		k = end;
	}
	return `${out.join("\n")}\n`;
}
