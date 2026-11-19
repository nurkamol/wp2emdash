/** `wp2emdash proposals <slug> [approve|reject <id>]`: the approval queue from the terminal (docs/PLAN.md §10b). */
import pc from "picocolors";
import { siteExists } from "../core/paths.js";
import { applyProposal, listProposals, type Proposal, rejectProposal, rerunCommand } from "../core/proposals.js";

function line(p: Proposal): string {
	const color = p.status === "pending" ? pc.cyan : p.status === "approved" ? pc.green : p.status === "failed" ? pc.red : pc.dim;
	const decided = p.decidedBy ? pc.dim(` — ${p.status} by ${p.decidedBy} ${p.decidedAt?.slice(0, 10) ?? ""}${p.note ? `: ${p.note}` : ""}`) : "";
	return `${color(p.status.padEnd(8))} ${pc.bold(p.id)} ${p.file}${p.rerun ? pc.dim(` → rerun ${p.rerun}`) : ""}\n         ${p.summary}${decided}`;
}

export function proposalsCommand(slug: string, action: string | undefined, id: string | undefined, o: { by?: string; note?: string; json?: boolean; all?: boolean; sitesDir?: string }): number {
	if (!siteExists(slug, o.sitesDir)) throw new Error(`No site "${slug}"`);
	const opts = { ...(o.sitesDir ? { sitesDir: o.sitesDir } : {}), ...(o.note ? { note: o.note } : {}) };
	if (!action) {
		const all = listProposals(slug, opts);
		const shown = o.all ? all : all.filter((p) => p.status === "pending");
		if (o.json) {
			console.log(JSON.stringify(shown, null, 2));
			return 0;
		}
		if (!shown.length) console.log(o.all || !all.length ? "No proposals." : `No pending proposals (${all.length} decided; --all to show them).`);
		for (const p of shown) console.log(line(p));
		if (shown.some((p) => p.status === "pending")) console.log(pc.dim(`\nShow a diff: cat sites/${slug}/proposals/<id>.json · approve: wp2emdash proposals ${slug} approve <id> --by "…"`));
		return 0;
	}
	if (action !== "approve" && action !== "reject") throw new Error(`Unknown action "${action}" (approve or reject)`);
	if (!id) throw new Error(`Give the proposal id: wp2emdash proposals ${slug} ${action} <id> --by "…"`);
	if (!o.by?.trim()) throw new Error("--by is required (who decided)");
	const p = action === "approve" ? applyProposal(slug, id, o.by, opts) : rejectProposal(slug, id, o.by, opts);
	if (o.json) {
		console.log(JSON.stringify({ ...p, rerunCommand: rerunCommand(slug, p) ?? null }, null, 2));
		return p.status === "failed" ? 2 : 0;
	}
	console.log(line(p));
	if (p.status === "failed") {
		console.log(pc.red(`Not applied: ${p.file} has changed since the proposal was made. Ask for a fresh proposal.`));
		return 2;
	}
	const cmd = rerunCommand(slug, p);
	if (cmd) console.log(`Applied to ${p.file}. Next: ${pc.bold(cmd)}`);
	else if (p.status === "approved") console.log(`Applied to ${p.file}.`);
	return 0;
}
