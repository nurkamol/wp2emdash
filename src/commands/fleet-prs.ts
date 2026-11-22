/**
 * `wp2emdash fleet upgrade-prs`: for every site behind the current kit, a branch `wp2emdash/v<version>` in its client
 * project with the scaffold rebuilt on it, committed, and a pull request command to review it.
 *
 * Modes:
 *   (default) dry run — checks every refusal condition and prints what would happen; changes nothing.
 *   --apply           — creates the branch, rebuilds (scaffold; preview-style when the earlier gates are not recorded),
 *                       commits on the branch, switches back to main and prints the push and `gh pr create` commands.
 *   --open            — --apply, then pushes the branch (never main) and opens the pull request with gh.
 *
 * In client repos a push to main deploys (production on some sites), so main is never committed to or pushed, and
 * before anything is created the repo's workflows are read (src/upgrade/ci-safety.ts): if a push of the branch, or a
 * pull request from it, could run a deploy job, the site is refused and the reason printed.
 *
 * Refusals (per site): no project folder / not its own git repo, not on main (or detached), uncommitted changes,
 * the branch already exists (locally or as a known remote branch), a workflow that could deploy, no `origin` remote
 * (--open only).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { kitVersion, packageVersions, readBuildMarker, versionGap } from "../core/build-marker.js";
import { KIT_ROOT, SITES_DIR, sitePaths } from "../core/paths.js";
import { blockingPhase, type GateCheck, readState } from "../core/state.js";
import { type CiSafety, ciSafety } from "../upgrade/ci-safety.js";
import { ownGitRepo, runGit } from "./fleet.js";
import { runPhase } from "./run.js";
import { listSites } from "./status.js";

/** Branch names never committed to or pushed by this command. */
export const PROTECTED_BRANCHES = ["main", "master", "production", "prod", "live", "release", "staging"];

export function assertSafeBranch(branch: string, base: string): void {
	if (!branch || branch === base || PROTECTED_BRANCHES.includes(branch) || !branch.startsWith("wp2emdash/")) throw new Error(`Refused: fleet upgrade-prs only commits to and pushes its own wp2emdash/v<version> branch, never "${branch}".`);
}

export const upgradeBranch = (version: string) => `wp2emdash/v${version}`;

export interface UpgradePrOptions {
	sitesDir?: string;
	sites?: string[];
	/** Create the branch, rebuild and commit locally (default: dry run). */
	apply?: boolean;
	/** --apply, then push the branch and open the pull request. */
	open?: boolean;
	/** Also sites already on the current kit version. */
	all?: boolean;
	log?: (line: string) => void;
}

export interface UpgradePrDeps {
	git?: (args: string[], cwd: string) => { code: number; out: string };
	/** Rebuild: the scaffold phase. Default: runPhase (preview when earlier gates are not recorded). */
	runScaffold?: (slug: string, o: { preview: boolean }) => Promise<{ ok: boolean; runId: string; checks: GateCheck[] }>;
	/** gh pr create (only with --open). */
	gh?: (args: string[], cwd: string) => { code: number; out: string };
	kitRoot?: string;
}

export interface UpgradePrResult {
	slug: string;
	project: string;
	status: "planned" | "committed" | "opened" | "skipped" | "refused" | "failed";
	reason?: string;
	built?: string;
	target?: string;
	branch?: string;
	base?: string;
	preview?: boolean;
	ci?: { push: CiSafety; pullRequest: CiSafety };
	steps: string[];
	commit?: string;
	prCommand?: string;
	prUrl?: string;
}

const q = (s: string) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);
const cmd = (bin: string, args: string[]) => [bin, ...args].map(q).join(" ");

function defaultGh(args: string[], cwd: string): { code: number; out: string } {
	const r = spawnSync("gh", args, { cwd, encoding: "utf8" });
	return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

export async function upgradePr(slug: string, opts: UpgradePrOptions = {}, deps: UpgradePrDeps = {}): Promise<UpgradePrResult> {
	const paths = sitePaths(slug, opts.sitesDir);
	const git = deps.git ?? runGit;
	const kitRoot = deps.kitRoot ?? KIT_ROOT;
	const log = opts.log ?? (() => {});
	const target = kitVersion(kitRoot) ?? "0.0.0";
	const project = paths.project;
	const out: UpgradePrResult = { slug, project, status: "planned", target, steps: [] };
	const refuse = (reason: string): UpgradePrResult => ({ ...out, status: "refused", reason });

	if (!existsSync(project)) return refuse(`no project folder at ${project}`);
	if (!ownGitRepo(project, git)) return refuse("the project folder is not the root of its own git repository");
	const marker = readBuildMarker(project);
	if (marker) out.built = marker.kit;
	const gap = versionGap(marker?.kit, target);
	if (!opts.all && (gap.status === "current" || gap.status === "ahead")) return { ...out, status: "skipped", reason: `already built with ${marker?.kit} (kit ${target})` };

	// Base: main (the branch CI deploys from). Never anything else, never detached.
	const head = git(["symbolic-ref", "--short", "-q", "HEAD"], project);
	const base = head.code === 0 ? head.out : "";
	if (!base) return refuse("HEAD is detached: check out main first");
	const hasMain = git(["rev-parse", "--verify", "--quiet", "refs/heads/main"], project).code === 0;
	const mainName = hasMain ? "main" : git(["rev-parse", "--verify", "--quiet", "refs/heads/master"], project).code === 0 ? "master" : "main";
	if (base !== mainName) return refuse(`the project is on branch "${base}", not ${mainName}: the upgrade branch starts from ${mainName} (switch to it first)`);
	out.base = base;
	const branch = upgradeBranch(target);
	out.branch = branch;
	assertSafeBranch(branch, base);

	const dirty = git(["status", "--porcelain"], project);
	if (dirty.code !== 0) return refuse(`git status failed: ${dirty.out.split("\n")[0]}`);
	if (dirty.out) return refuse(`uncommitted changes in the project (${dirty.out.split("\n").length} path(s)): commit or stash them first`);
	if (git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], project).code === 0) return refuse(`branch ${branch} already exists locally`);
	const remotes = git(["remote"], project).out.split("\n").filter(Boolean);
	if (git(["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`], project).code === 0) return refuse(`branch ${branch} already exists on origin`);

	// CI: a push of the branch and a pull request from it must not deploy.
	const ci = { push: ciSafety(project, { kind: "push", branch, base }), pullRequest: ciSafety(project, { kind: "pull_request", branch, base }) };
	out.ci = ci;
	if (!ci.push.safe || !ci.pullRequest.safe) return refuse(`the client repo's CI could deploy from this branch: ${[...ci.push.reasons, ...ci.pullRequest.reasons].join(" | ")}`);
	if (opts.open && !remotes.includes("origin")) return refuse("no origin remote to push to");

	let preview = true;
	try {
		preview = !!blockingPhase(readState(paths.state), "scaffold");
	} catch {
		preview = true;
	}
	out.preview = preview;
	const before = packageVersions(project);
	const title = `Upgrade to wp2emdash v${target}`;
	const pushArgs = ["push", "-u", "origin", `refs/heads/${branch}:refs/heads/${branch}`];
	const prArgs = ["pr", "create", "--base", base, "--head", branch, "--title", title, "--body", `Rebuilt with wp2emdash v${target} (was ${marker?.kit ?? "unknown"}). Review the change on a preview before merging: merging into ${base} runs the repository's deploy workflow.`];
	out.prCommand = `cd ${q(project)} && ${cmd("git", pushArgs)} && ${cmd("gh", prArgs)}`;
	out.steps = [
		`git switch -c ${branch}   (from ${base})`,
		`rebuild: wp2emdash run ${slug} scaffold${preview ? " --preview (earlier gates not recorded; state.json untouched)" : " (gate recorded)"}`,
		`git add -A && git commit -m "${title}"   (on ${branch} only)`,
		`git switch ${base}`,
		opts.open ? `${cmd("git", pushArgs)} && gh pr create …` : `print: ${cmd("git", pushArgs)} && gh pr create …`,
	];
	if (!opts.apply && !opts.open) return out;

	// ── Apply ──
	const run = (args: string[]) => {
		const r = git(args, project);
		if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.out.split("\n").slice(-2).join(" ")}`);
		return r.out;
	};
	/** Back to base with the branch removed: the tree was clean before, so this restores it exactly. */
	const abandon = () => {
		git(["reset", "--hard", "-q"], project);
		git(["clean", "-fdq"], project);
		git(["switch", "-q", base], project);
		git(["branch", "-D", "-q", branch], project);
	};
	run(["switch", "-q", "-c", branch]);
	log(`${slug}: on ${branch}, rebuilding (scaffold${preview ? " --preview" : ""})`);
	let sc: { ok: boolean; runId: string; checks: GateCheck[] };
	try {
		sc = await (deps.runScaffold ?? ((s, o) => runPhase(s, "scaffold", { ...(opts.sitesDir ? { sitesDir: opts.sitesDir } : {}), ...(o.preview ? { preview: true } : {}), quiet: true })))(slug, { preview });
	} catch (e) {
		abandon();
		return { ...out, status: "failed", reason: `scaffold could not run: ${(e as Error).message.split("\n")[0]} (branch removed, ${base} untouched)` };
	}
	if (!sc.ok) {
		abandon();
		return { ...out, status: "failed", reason: `scaffold gate failed (${sc.checks.filter((c) => !c.ok).map((c) => c.id).join(", ")}); branch removed, ${base} untouched` };
	}
	// The rebuild may rewrite the workflows: check them again on the branch before committing.
	const after = { push: ciSafety(project, { kind: "push", branch, base }), pullRequest: ciSafety(project, { kind: "pull_request", branch, base }) };
	if (!after.push.safe || !after.pullRequest.safe) {
		abandon();
		return { ...out, ci: after, status: "refused", reason: `after the rebuild the CI could deploy from this branch: ${[...after.push.reasons, ...after.pullRequest.reasons].join(" | ")} (branch removed)` };
	}
	run(["add", "-A"]);
	if (!git(["status", "--porcelain"], project).out) {
		abandon();
		return { ...out, status: "skipped", reason: "the rebuild changed nothing (branch removed)" };
	}
	const current = git(["symbolic-ref", "--short", "-q", "HEAD"], project).out;
	if (current !== branch) {
		abandon();
		throw new Error(`Refused: expected to be on ${branch}, found "${current}"`);
	}
	assertSafeBranch(current, base);
	const now = packageVersions(project);
	const changed = Object.keys({ ...before, ...now }).sort().filter((n) => before[n] !== now[n]).map((n) => `- ${n}: ${before[n] ?? "—"} → ${now[n] ?? "removed"}`);
	run(["commit", "-q", "-m", title, "-m", [`Rebuilt with wp2emdash v${target} (was ${marker?.kit ?? "unknown"}) by \`wp2emdash fleet upgrade-prs\`.`, ...(changed.length ? ["", "Packages:", ...changed] : [])].join("\n")]);
	out.commit = run(["rev-parse", "--short", "HEAD"]);
	run(["switch", "-q", base]);
	out.status = "committed";
	if (!opts.open) return out;

	assertSafeBranch(branch, base);
	const push = git(pushArgs, project);
	if (push.code !== 0) return { ...out, status: "failed", reason: `push failed: ${push.out.split("\n").slice(-2).join(" ")} (the commit stays on ${branch} locally)` };
	const pr = (deps.gh ?? defaultGh)(prArgs, project);
	if (pr.code !== 0) return { ...out, status: "failed", reason: `branch pushed, gh pr create failed: ${pr.out.split("\n").slice(-2).join(" ")}` };
	return { ...out, status: "opened", prUrl: pr.out.split("\n").filter(Boolean).at(-1) ?? "" };
}

export async function upgradePrs(opts: UpgradePrOptions = {}, deps: UpgradePrDeps = {}): Promise<UpgradePrResult[]> {
	const all = listSites(opts.sitesDir ?? SITES_DIR);
	if (opts.sites?.length) {
		const unknown = opts.sites.filter((s) => !all.includes(s));
		if (unknown.length) throw new Error(`Unknown site(s): ${unknown.join(", ")}`);
	}
	const slugs = opts.sites?.length ? all.filter((s) => opts.sites?.includes(s)) : all;
	const out: UpgradePrResult[] = [];
	for (const s of slugs) {
		try {
			out.push(await upgradePr(s, opts, deps));
		} catch (e) {
			out.push({ slug: s, project: sitePaths(s, opts.sitesDir).project, status: "failed", reason: (e as Error).message, steps: [] });
		}
	}
	return out;
}

export function upgradePrsReport(results: UpgradePrResult[], o: { apply?: boolean; open?: boolean }): string {
	const mode = o.open ? "open" : o.apply ? "apply" : "dry run (nothing changed; --apply commits on the branch, --open also pushes it and opens the PR)";
	const lines = [`Mode: ${mode}`];
	for (const r of results) {
		lines.push("", `${r.slug}: ${r.status}${r.built || r.target ? ` (${r.built ?? "unknown"} → ${r.target})` : ""}${r.reason ? ` — ${r.reason}` : ""}`);
		if (r.status === "planned") lines.push(...r.steps.map((s) => `  - ${s}`));
		if (r.commit) lines.push(`  commit ${r.commit} on ${r.branch} (${r.base} untouched)`);
		if (r.prUrl) lines.push(`  PR: ${r.prUrl}`);
		else if (r.prCommand && (r.status === "planned" || r.status === "committed")) lines.push(`  PR: ${r.prCommand}`);
	}
	return lines.join("\n");
}
