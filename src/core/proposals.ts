/**
 * The approval queue (docs/PLAN.md §10b). Claude never edits overrides.ts / decisions.md from the reasoning loop:
 * it writes a pending proposal (a unified diff) to sites/<slug>/proposals/<id>.json; the owner approves or rejects
 * it in the dashboard or with `wp2emdash proposals`. Approving applies the patch (strict, no fuzz) and records the
 * decision; it never reruns a phase — the caller shows the rerun command (or runs it on the owner's click).
 *
 * File contract (shared with the dashboard; do not change):
 *   { id: "p-<yyyymmdd>-<6 hex>", createdAt, by: "claude", summary, file: "overrides.ts" | "decisions.md",
 *     patch: "<unified diff, paths relative to sites/<slug>/>", rerun: "transform"|"scaffold"|"load"|"verify"|null,
 *     status: "pending"|"approved"|"rejected"|"failed", decidedAt?, decidedBy?, note? }
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { applyHunks, parseUnifiedDiff, PatchError } from "./diff.js";
import { SITES_DIR, sitePaths } from "./paths.js";

export const PROPOSAL_FILES = ["overrides.ts", "decisions.md"] as const;
export type ProposalFile = (typeof PROPOSAL_FILES)[number];
export const RERUN_PHASES = ["transform", "scaffold", "load", "verify"] as const;
export type RerunPhase = (typeof RERUN_PHASES)[number];
export const PROPOSAL_STATUS = ["pending", "approved", "rejected", "failed"] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUS)[number];

export const PROPOSAL_ID_RE = /^p-\d{8}-[0-9a-f]{6}$/;

export const proposalSchema = z.object({
	id: z.string().regex(PROPOSAL_ID_RE),
	createdAt: z.string(),
	by: z.string(),
	summary: z.string(),
	file: z.enum(PROPOSAL_FILES),
	patch: z.string(),
	rerun: z.enum(RERUN_PHASES).nullable(),
	status: z.enum(PROPOSAL_STATUS),
	decidedAt: z.string().optional(),
	decidedBy: z.string().optional(),
	note: z.string().optional(),
});
export type Proposal = z.infer<typeof proposalSchema>;

export interface ProposalOpts {
	sitesDir?: string;
}

export function proposalsDir(slug: string, sitesDir = SITES_DIR): string {
	return join(sitePaths(slug, sitesDir).root, "proposals");
}

export function isProposalId(id: string): boolean {
	return PROPOSAL_ID_RE.test(id);
}

export function newProposalId(now = new Date()): string {
	return `p-${now.toISOString().slice(0, 10).replace(/-/g, "")}-${randomBytes(3).toString("hex")}`;
}

function proposalFile(slug: string, id: string, sitesDir?: string): string {
	if (!isProposalId(id)) throw new Error(`Not a proposal id: "${id}" (expected p-<yyyymmdd>-<6 hex>)`);
	return join(proposalsDir(slug, sitesDir), `${id}.json`);
}

function writeProposal(slug: string, p: Proposal, sitesDir?: string): void {
	const file = proposalFile(slug, p.id, sitesDir);
	mkdirSync(proposalsDir(slug, sitesDir), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(proposalSchema.parse(p), null, 2)}\n`);
	renameSync(tmp, file);
}

/**
 * The patched content of `file` if `patch` applies cleanly to the site's current copy; throws otherwise.
 * The patch must touch exactly that one file (paths relative to sites/<slug>/, `a/` `b/` prefixes allowed).
 */
export function patchedContent(slug: string, file: ProposalFile, patch: string, sitesDir?: string): string {
	const files = parseUnifiedDiff(patch);
	if (files.length !== 1) throw new PatchError(`the patch must change exactly one file (${file}); it changes ${files.length}`);
	const [fp] = files as [(typeof files)[number]];
	if (fp.newPath === "/dev/null") throw new PatchError("deleting the file is not allowed");
	if (fp.newPath !== file || (fp.oldPath !== "/dev/null" && fp.oldPath !== file)) {
		throw new PatchError(`the patch changes "${fp.newPath}"; it may only change ${file} (paths relative to sites/<slug>/)`);
	}
	const target = join(sitePaths(slug, sitesDir).root, file);
	const exists = existsSync(target);
	if (fp.oldPath === "/dev/null" && exists) throw new PatchError(`${file} already exists; the patch creates it`);
	if (fp.oldPath !== "/dev/null" && !exists) throw new PatchError(`${file} does not exist`);
	return applyHunks(exists ? readFileSync(target, "utf8") : "", fp.hunks);
}

export interface NewProposal {
	summary: string;
	file: ProposalFile;
	patch: string;
	rerun?: RerunPhase | null;
	by?: string;
}

/** Validates the patch against the current file (dry run) and writes a pending proposal. Never touches the file itself. */
export function createProposal(slug: string, input: NewProposal, opts: ProposalOpts & { now?: Date } = {}): Proposal {
	if (!existsSync(sitePaths(slug, opts.sitesDir).config)) throw new Error(`No site "${slug}"`);
	if (!PROPOSAL_FILES.includes(input.file)) throw new Error(`file must be one of ${PROPOSAL_FILES.join(", ")}`);
	if (!input.summary.trim()) throw new Error("summary is required");
	patchedContent(slug, input.file, input.patch, opts.sitesDir); // throws if it does not apply
	const now = opts.now ?? new Date();
	let id = newProposalId(now);
	while (existsSync(proposalFile(slug, id, opts.sitesDir))) id = newProposalId(now);
	const p: Proposal = { id, createdAt: now.toISOString(), by: input.by ?? "claude", summary: input.summary.trim(), file: input.file, patch: input.patch, rerun: input.rerun ?? null, status: "pending" };
	writeProposal(slug, p, opts.sitesDir);
	return p;
}

export function readProposal(slug: string, id: string, opts: ProposalOpts = {}): Proposal | undefined {
	const file = proposalFile(slug, id, opts.sitesDir);
	if (!existsSync(file)) return undefined;
	return proposalSchema.parse(JSON.parse(readFileSync(file, "utf8")));
}

/** All proposals of a site, oldest first; unreadable files are skipped. */
export function listProposals(slug: string, opts: ProposalOpts & { status?: ProposalStatus } = {}): Proposal[] {
	const dir = proposalsDir(slug, opts.sitesDir);
	if (!existsSync(dir)) return [];
	const out: Proposal[] = [];
	for (const f of readdirSync(dir)) {
		const id = f.replace(/\.json$/, "");
		if (!f.endsWith(".json") || !isProposalId(id)) continue;
		try {
			const p = readProposal(slug, id, opts);
			if (p && (!opts.status || p.status === opts.status)) out.push(p);
		} catch {
			// a damaged proposal file is not a reason to hide the others
		}
	}
	return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

function pending(slug: string, id: string, sitesDir?: string): Proposal {
	const p = readProposal(slug, id, { sitesDir });
	if (!p) throw new Error(`No proposal ${id} for ${slug}`);
	if (p.status !== "pending") throw new Error(`Proposal ${id} is already ${p.status}`);
	return p;
}

function decider(decidedBy: string): string {
	const by = decidedBy.trim();
	if (!by) throw new Error("decidedBy is required (who approved or rejected it)");
	return by;
}

/**
 * Approves a pending proposal: applies its patch to sites/<slug>/<file> (atomic write) and sets status "approved".
 * If the patch no longer applies the file is left untouched and the proposal is set to "failed" with the reason in
 * `note`. Returns the updated proposal either way; throws only when it does not exist or is not pending.
 * Never reruns a phase: use `rerunCommand(slug, proposal)`.
 */
export function applyProposal(slug: string, id: string, decidedBy: string, opts: ProposalOpts & { note?: string } = {}): Proposal {
	const by = decider(decidedBy);
	const p = pending(slug, id, opts.sitesDir);
	const decidedAt = new Date().toISOString();
	let next: string;
	try {
		next = patchedContent(slug, p.file, p.patch, opts.sitesDir);
	} catch (e) {
		const failed: Proposal = { ...p, status: "failed", decidedAt, decidedBy: by, note: `patch did not apply: ${(e as Error).message}${opts.note ? ` — ${opts.note}` : ""}` };
		writeProposal(slug, failed, opts.sitesDir);
		return failed;
	}
	const target = join(sitePaths(slug, opts.sitesDir).root, p.file);
	const tmp = `${target}.${process.pid}.tmp`;
	writeFileSync(tmp, next);
	renameSync(tmp, target);
	const approved: Proposal = { ...p, status: "approved", decidedAt, decidedBy: by, ...(opts.note ? { note: opts.note } : {}) };
	writeProposal(slug, approved, opts.sitesDir);
	return approved;
}

/** Rejects a pending proposal; the file is never touched. */
export function rejectProposal(slug: string, id: string, decidedBy: string, opts: ProposalOpts & { note?: string } = {}): Proposal {
	const by = decider(decidedBy);
	const p = pending(slug, id, opts.sitesDir);
	const rejected: Proposal = { ...p, status: "rejected", decidedAt: new Date().toISOString(), decidedBy: by, ...(opts.note ? { note: opts.note } : {}) };
	writeProposal(slug, rejected, opts.sitesDir);
	return rejected;
}

/** The command that reruns the affected phase after an approved proposal, or undefined when none is needed. */
export function rerunCommand(slug: string, p: Pick<Proposal, "rerun" | "status">): string | undefined {
	if (p.status !== "approved" || !p.rerun) return undefined;
	return `pnpm wp2emdash run ${slug} ${p.rerun}`;
}
