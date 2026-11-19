/**
 * Approval queue for the dashboard (docs/PLAN.md §10b). Proposals are read and decided through src/core/proposals.ts;
 * this module adds what the browser needs (the exact rerun command, input checks) and writes new proposals that the
 * section inspector creates. Approving applies the patch; it never accepts a gate.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SITES_DIR, sitePaths } from "../core/paths.js";
import { applyProposal, listProposals, readProposal, rejectProposal } from "../core/proposals.js";
import { UserError } from "./data.js";

type Proposal = NonNullable<ReturnType<typeof readProposal>>;

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

export function proposalsView(slug: string, sitesDir = SITES_DIR): ProposalView[] {
	const list = listProposals(slug, sitesDir) as Proposal[];
	return [...list].sort((a, b) => Number(b.status === "pending") - Number(a.status === "pending") || String(b.createdAt).localeCompare(String(a.createdAt))).map((p) => view(slug, p));
}

/** One line of free text from the browser: no control characters, bounded. */
export function oneLine(v: unknown, what: string, max: number, required: boolean): string | undefined {
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
	const p = readProposal(slug, id, sitesDir);
	if (!p) throw new UserError("Unknown proposal.");
	if (p.status !== "pending") throw new UserError(`This proposal is already ${p.status}.`);
	let next: Proposal;
	try {
		next = (decision === "approve" ? applyProposal(slug, id, by, note, sitesDir) : rejectProposal(slug, id, by, note, sitesDir)) as Proposal;
	} catch (e) {
		throw new UserError((e as Error).message);
	}
	return view(slug, next);
}

/** Writes a new pending proposal (used by the section inspector). */
export function createProposal(slug: string, p: Pick<Proposal, "by" | "summary" | "file" | "patch" | "rerun">, sitesDir = SITES_DIR, now = new Date()): Proposal {
	const dir = join(sitePaths(slug, sitesDir).root, "proposals");
	mkdirSync(dir, { recursive: true });
	const id = `${now.toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
	const file = join(dir, `${id}.json`);
	if (existsSync(file)) throw new Error("proposal id clash");
	const proposal = { id, createdAt: now.toISOString(), by: p.by, summary: p.summary, file: p.file, patch: p.patch, rerun: p.rerun, status: "pending" } as Proposal;
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(proposal, null, 2)}\n`);
	renameSync(tmp, file);
	return proposal;
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
	for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) (lcs[i] as number[])[j] = a[i] === b[j] ? ((lcs[i + 1] as number[])[j + 1] as number) + 1 : Math.max((lcs[i + 1] as number[])[j] as number, (lcs[i] as number[])[j + 1] as number);
	type Op = { t: " " | "-" | "+"; s: string };
	const ops: Op[] = [];
	let i = 0;
	let j = 0;
	while (i < n || j < m) {
		if (i < n && j < m && a[i] === b[j]) {
			ops.push({ t: " ", s: a[i] as string });
			i++;
			j++;
		} else if (j < m && (i >= n || ((lcs[i] as number[])[j + 1] as number) >= ((lcs[i + 1] as number[])[j] as number))) ops.push({ t: "+", s: b[j++] as string });
		else ops.push({ t: "-", s: a[i++] as string });
	}
	const ctx = 3;
	const out = [`--- ${before === "" ? "/dev/null" : `a/${file}`}`, `+++ b/${file}`];
	let k = 0;
	while (k < ops.length) {
		while (k < ops.length && (ops[k] as Op).t === " ") k++;
		if (k >= ops.length) break;
		let start = Math.max(0, k - ctx);
		while (start > 0 && (ops[start - 1] as Op).t !== " ") start--;
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
		// 1-based start lines: the line number in each file of the hunk's first line.
		const aLines = hunk.filter((o) => o.t !== "+").length;
		const bLines = hunk.filter((o) => o.t !== "-").length;
		const aStart = a.length === 0 ? 0 : countBefore(ops, start, "a") + 1;
		const bStart = countBefore(ops, start, "b") + 1;
		out.push(`@@ -${aLines === 0 ? aStart - 1 : aStart},${aLines} +${bLines === 0 ? bStart - 1 : bStart},${bLines} @@`);
		for (const o of hunk) out.push(`${o.t}${o.s}`);
		k = end;
	}
	return `${out.join("\n")}\n`;
}

function countBefore(ops: { t: string }[], idx: number, side: "a" | "b"): number {
	let c = 0;
	for (let x = 0; x < idx; x++) if ((ops[x] as { t: string }).t === " " || (ops[x] as { t: string }).t === (side === "a" ? "-" : "+")) c++;
	return c;
}
