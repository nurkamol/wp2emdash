/**
 * Publish panel: `wp2emdash publish` from the dashboard. The dry run (`publish --json`) lists the files that would be
 * committed and the secret scan (file names and labels only, never a match); "Publish" needs the same typed-domain
 * confirmation and the owner's written approval as go-live, then runs `publish --yes` and streams it. The
 * CLOUDFLARE_API_TOKEN repository secret is never set here: the page shows the `gh secret set` command to run by hand.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PublishResult } from "../commands/publish.js";
import { repoFromRemote } from "../commands/publish.js";
import type { ActionDeps, ActionRun, SiteLocks } from "./actions.js";
import { BusyError, startAction } from "./actions.js";
import { UserError } from "./data.js";
import { appendDecision, requireConfirmation, type SiteContext } from "./launch.js";

const REPO_RE = /^([A-Za-z0-9-]+\/)?[A-Za-z0-9._-]+$/;
const FILE_LIST_MAX = 5000;

export interface CiRun {
	status: string;
	conclusion?: string;
	title: string;
	workflow?: string;
	branch?: string;
	createdAt?: string;
	url?: string;
}

export interface PublishStatus {
	project: string;
	projectExists: boolean;
	repo?: string;
	repoUrl?: string;
	gh: { available: boolean; detail?: string };
	ci?: { runs: CiRun[]; error?: string };
	/** What to run by hand: the kit never sets the deploy token. */
	guidance: string[];
	command: string;
}

export function tokenGuidance(repo: string | undefined): string[] {
	const r = repo ?? "<owner/name>";
	return [
		`gh secret set CLOUDFLARE_API_TOKEN --repo ${r}   # paste the token when asked; the kit never sets it`,
		"Use a build-only token: Workers Scripts, D1, R2 (and KV) edit on this account, no Zone permissions — never the go-live token (docs/cloudflare-api-token.md, token A)",
		"GitHub → Settings → Environments: production limited to main, the owner as required reviewer",
	];
}

export async function publishStatus(ctx: SiteContext, deps: ActionDeps, o: { ci?: boolean } = {}): Promise<PublishStatus> {
	const project = ctx.paths.project;
	const projectExists = existsSync(join(project, "package.json"));
	let repo: string | undefined;
	if (projectExists && existsSync(join(project, ".git"))) {
		const r = await deps.exec("git", ["remote", "get-url", "origin"], { cwd: project, timeoutMs: 10_000 });
		if (r.code === 0) repo = repoFromRemote(r.stdout.trim());
	}
	const ghv = await deps.exec("gh", ["--version"], { cwd: projectExists ? project : ctx.paths.root, timeoutMs: 10_000 });
	const gh = ghv.code === 0 ? { available: true, detail: ghv.stdout.split("\n")[0]?.trim() } : { available: false, detail: "GitHub CLI (gh) not found: install it and run gh auth login" };
	let ci: PublishStatus["ci"];
	if (o.ci !== false && gh.available && repo) {
		const r = await deps.exec("gh", ["run", "list", "--repo", repo, "--limit", "8", "--json", "status,conclusion,displayTitle,workflowName,headBranch,createdAt,url"], { cwd: project, timeoutMs: 20_000 });
		if (r.code === 0) {
			try {
				const list = JSON.parse(r.stdout) as { status: string; conclusion?: string; displayTitle: string; workflowName?: string; headBranch?: string; createdAt?: string; url?: string }[];
				ci = { runs: list.map((x) => ({ status: x.status, ...(x.conclusion ? { conclusion: x.conclusion } : {}), title: x.displayTitle, ...(x.workflowName ? { workflow: x.workflowName } : {}), ...(x.headBranch ? { branch: x.headBranch } : {}), ...(x.createdAt ? { createdAt: x.createdAt } : {}), ...(x.url ? { url: x.url } : {}) })) };
			} catch {
				ci = { runs: [], error: "gh run list returned no JSON" };
			}
		} else ci = { runs: [], error: (r.stderr.trim().split("\n")[0] ?? "") || `gh exited ${r.code}` };
	}
	return {
		project: project.startsWith(ctx.paths.root) ? `sites/${ctx.slug}${project.slice(ctx.paths.root.length)}` : project,
		projectExists,
		...(repo ? { repo, repoUrl: `https://github.com/${repo}` } : {}),
		gh,
		...(ci ? { ci } : {}),
		guidance: tokenGuidance(repo),
		command: `pnpm wp2emdash publish ${ctx.slug}`,
	};
}

export interface PublishPlan {
	ok: boolean;
	repo?: string;
	plan: string[];
	blockers: string[];
	files: number;
	fileList: string[];
	truncated: boolean;
	scan: { forbidden: string[]; flagged: string[] };
	error?: string;
}

const repoArg = (repo: unknown): string[] => {
	if (repo === undefined || repo === null || repo === "") return [];
	if (typeof repo !== "string" || !REPO_RE.test(repo.trim())) throw new UserError("Repository must look like owner/name.");
	return [`--repo=${repo.trim()}`];
};

/** `wp2emdash publish <slug> --json` (no --yes): plan, blockers, the file list and the secret scan. */
export async function publishPlan(ctx: SiteContext, deps: ActionDeps, repo?: unknown): Promise<PublishPlan> {
	const r = await deps.runCli(["publish", ctx.slug, "--json", ...repoArg(repo)], { sitesDir: ctx.sitesDir, timeoutMs: 120_000 });
	try {
		const j = JSON.parse(r.stdout) as PublishResult;
		const list = j.fileList ?? [];
		return { ok: j.blockers.length === 0, repo: j.repo, plan: j.plan, blockers: j.blockers, files: j.files, fileList: list.slice(0, FILE_LIST_MAX), truncated: list.length > FILE_LIST_MAX, scan: j.scan ?? { forbidden: [], flagged: [] } };
	} catch {
		const msg = (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ") || `exit ${r.code}`;
		return { ok: false, plan: [], blockers: [msg], files: 0, fileList: [], truncated: false, scan: { forbidden: [], flagged: [] }, error: msg };
	}
}

/** Typed domain + the owner's written approval, then `publish --yes` as a single-flight action. */
export function startPublish(ctx: SiteContext, body: Record<string, unknown>, deps: ActionDeps, locks: SiteLocks): { runId: string; done: Promise<boolean> } {
	const ok = requireConfirmation(body, { domain: ctx.domain, approval: true });
	const extra = repoArg(body.repo);
	const held = locks.get(ctx.slug);
	if (held) throw new BusyError(held);
	return startAction(locks, ctx.slug, "publish", ctx.sitesDir, deps, async (run: ActionRun) => {
		appendDecision(ctx.paths, "publish", `Publish the project to a private GitHub repository approved (dashboard, run ${run.runId})`, ok.approval as string, ok.by, deps.now());
		run.log("info", `Publish ${ctx.slug} — owner approval recorded in decisions.md (by ${ok.by}).`);
		run.log("info", `$ wp2emdash publish ${ctx.slug}${extra.length ? ` ${extra[0]}` : ""} --yes`);
		const r = await deps.runCli(["publish", ctx.slug, ...extra, "--yes"], { sitesDir: ctx.sitesDir, onLine: (line, stream) => run.log(stream === "stderr" || line.startsWith("✖") ? "error" : "info", line) });
		run.step("Publish", r.code === 0, r.code === 0 ? "pushed; set the deploy token yourself (gh secret set …)" : "nothing published (refused or error)");
		return r.code === 0;
	});
}
