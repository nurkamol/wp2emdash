/**
 * `wp2emdash publish <slug> [--repo owner/name] [--yes]`: put the site's generated project (projectDir) in a private
 * GitHub repository so its CI (.github/workflows/ci.yml) builds and deploys staging.
 *
 * Read-only without `--yes`: lists the files that would be committed, refuses when any of them is a local secret file
 * (.env, .dev.vars, *.db…) or contains something that looks like a credential (only file names are reported, never the
 * match), and prints the plan. With `--yes`: git init (if needed), commit, `gh repo create --private` (default name:
 * the production domain) or reuse the existing repository, push, and set the repository variable
 * CLOUDFLARE_ACCOUNT_ID from cloudflare.json. The CLOUDFLARE_API_TOKEN secret is never set by the kit: it prints the
 * `gh secret set` command and recommends a build-only token (no zone permissions, docs/cloudflare-api-token.md token A).
 * Idempotent: on an existing repository it only commits and pushes.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { loadConfig } from "../config/load.js";
import { sitePaths } from "../core/paths.js";
import { loadSiteEnv } from "../extract/credentials.js";

export interface PublishOptions {
	repo?: string;
	yes?: boolean;
	sitesDir?: string;
	log?: (line: string) => void;
	/** Values from the kit and site .env (any of them found in a file blocks the publish). Default: loaded. */
	vars?: Record<string, string | undefined>;
}

export interface PublishResult {
	applied: boolean;
	repo: string;
	plan: string[];
	blockers: string[];
	/** Files that would be committed. */
	files: number;
	next: string[];
}

const sh = (cmd: string, args: string[], cwd: string): string => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) as string;
const trySh = (cmd: string, args: string[], cwd: string): string | undefined => {
	try {
		return sh(cmd, args, cwd);
	} catch {
		return undefined;
	}
};

/** Local-only files that must never be committed, whatever .gitignore says. */
export function isForbiddenFile(path: string): boolean {
	const name = basename(path);
	if (name === ".env.example") return false;
	return name === ".env" || name.startsWith(".env.") || name.startsWith(".dev.vars") || /\.(db|sqlite|sqlite3)$/i.test(name) || /\.db-(wal|shm|journal)$/i.test(name) || /\.(pem|p12|pfx|key)$/i.test(name) || name === "id_rsa" || name === "id_ed25519";
}

const SECRET_PATTERNS: [string, RegExp][] = [
	["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
	["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
	["GitHub token", /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/],
	["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
	["Stripe live key", /\b[sr]k_live_[A-Za-z0-9]{20,}/],
	["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
	["Brevo key", /\bx(keysib|smtpsib)-[a-f0-9]{64}-[A-Za-z0-9]{16}\b/],
	["Resend key", /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{16,}\b/],
	["SendGrid key", /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/],
	["Mailgun key", /\bkey-[0-9a-f]{32}\b/],
	["EmDash encryption key", /\bemdash_enc_v1_[A-Za-z0-9_-]{40,}/],
	["WordPress migration key", /\bem1\.[A-Za-z0-9_-]{40,}/],
];
/** NAME=value / "NAME": "value" for credential-like names, with a literal value (not a reference or placeholder). */
const ASSIGNMENT = /\b([A-Z0-9_]*(?:SECRET|API_KEY|API_TOKEN|ACCESS_TOKEN|AUTH_TOKEN|PASSWORD|PRIVATE_KEY)[A-Z0-9_]*)["']?[ \t]*[:=][ \t]*["']?([^"'\s,;]{16,})/g;
/** Cloudflare's public Turnstile test keys (always pass / always fail): not secrets. */
const PUBLIC_TEST_VALUE = /^[123]x0+A{2}$/;
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|br|mp4|webm|mov|mp3|wav|wasm)$/i;

/** Values from .env files that would be a leak if found in a file (tokens, keys, passwords; not ids or URLs). */
export function secretValues(vars: Record<string, string | undefined>): string[] {
	return [...new Set(Object.entries(vars).filter(([k, v]) => !!v && v.length >= 16 && !/ACCOUNT_ID|_URL$|^URL|SITE_KEY|_ID$|EMAIL|_FROM$|_TO$|^PATH$|^HOME$/.test(k) && !/^https?:\/\//.test(v as string) && !PUBLIC_TEST_VALUE.test(v as string)).map(([, v]) => v as string))];
}

/** Why a file's text looks like it holds a credential (labels only — never the value). */
export function secretFindings(text: string, values: string[] = []): string[] {
	const found = new Set<string>();
	for (const [label, re] of SECRET_PATTERNS) if (re.test(text)) found.add(label);
	for (const m of text.matchAll(ASSIGNMENT)) {
		const v = m[2] as string;
		if (PUBLIC_TEST_VALUE.test(v) || /^(\$|<|\{|process\.env|import\.meta|env\.|secrets\.|vars\.)|^x{6,}|^your[-_]|^changeme/i.test(v)) continue;
		found.add(`${m[1]} with a literal value`);
	}
	for (const v of values) if (text.includes(v)) found.add("a value from .env");
	return [...found];
}

/** "owner/name" from a GitHub remote URL (https or ssh). */
export function repoFromRemote(url: string): string | undefined {
	return /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1];
}

/** Files git would commit: tracked + untracked, honouring .gitignore. Works before `git init` through a temporary git dir. */
function candidateFiles(project: string, hasGit: boolean): string[] {
	if (hasGit) return sh("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], project).split("\0").filter(Boolean);
	const tmp = mkdtempSync(join(tmpdir(), "wp2emdash-publish-"));
	try {
		sh("git", ["init", "-q", tmp], project);
		return sh("git", [`--git-dir=${join(tmp, ".git")}`, `--work-tree=${project}`, "ls-files", "-z", "--others", "--exclude-standard"], project).split("\0").filter(Boolean);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

export async function publish(slug: string, opts: PublishOptions = {}): Promise<PublishResult> {
	const log = opts.log ?? (() => {});
	const paths = opts.sitesDir ? sitePaths(slug, opts.sitesDir) : sitePaths(slug);
	if (!existsSync(paths.config)) throw new Error(`No site "${slug}"`);
	const config = await loadConfig(paths.config);
	const project = paths.project;
	if (!existsSync(join(project, "package.json"))) throw new Error(`No project at ${project}: run \`wp2emdash run ${slug} scaffold\` first`);
	const cf = (existsSync(join(paths.root, "cloudflare.json")) ? JSON.parse(readFileSync(join(paths.root, "cloudflare.json"), "utf8")) : {}) as { accountId?: string; staging?: { accountId?: string }; production?: { accountId?: string } };
	const stagingAccount = cf.staging?.accountId ?? cf.accountId;
	const productionAccount = cf.production?.accountId;
	const domain = new URL(config.target.productionUrl).hostname.replace(/^www\./, "");

	if (trySh("gh", ["auth", "status"], project) === undefined) throw new Error("GitHub CLI not available or not signed in: install gh and run `gh auth login`");
	const hasGit = existsSync(join(project, ".git"));
	const origin = hasGit ? trySh("git", ["remote", "get-url", "origin"], project)?.trim() : undefined;
	const originRepo = origin ? repoFromRemote(origin) : undefined;
	if (opts.repo && originRepo && opts.repo.toLowerCase() !== originRepo.toLowerCase() && !originRepo.toLowerCase().endsWith(`/${opts.repo.toLowerCase()}`))
		throw new Error(`The project already pushes to ${originRepo} (origin), not ${opts.repo}. Change the remote by hand if that is intended.`);
	const repo = originRepo ?? opts.repo ?? domain;
	if (!/^([A-Za-z0-9-]+\/)?[A-Za-z0-9._-]+$/.test(repo)) throw new Error(`Invalid repository name "${repo}" (owner/name)`);

	// What would be committed, and is any of it secret?
	const files = candidateFiles(project, hasGit);
	const blockers: string[] = [];
	const forbidden = files.filter(isForbiddenFile);
	if (forbidden.length) blockers.push(`Local secret files would be committed: ${forbidden.join(", ")} — add them to .gitignore (and \`git rm --cached\` if tracked)`);
	const values = secretValues(opts.vars ?? { ...process.env, ...loadSiteEnv(paths.root) });
	const flagged: string[] = [];
	for (const f of files) {
		if (forbidden.includes(f) || BINARY.test(f)) continue;
		const full = join(project, f);
		let text: string;
		try {
			if (!statSync(full).isFile() || statSync(full).size > 2_000_000) continue;
			text = readFileSync(full, "utf8");
		} catch {
			continue;
		}
		if (text.includes("\0")) continue;
		const why = secretFindings(text, values);
		if (why.length) flagged.push(`${f} (${why.join(", ")})`);
	}
	if (flagged.length) blockers.push(`Files that look like they contain credentials: ${flagged.join("; ")} — move the value to .env / Wrangler secrets`);

	const existing = trySh("gh", ["repo", "view", repo, "--json", "nameWithOwner,visibility,url", "-q", '.nameWithOwner + " " + .visibility + " " + .url'], project)?.trim();
	const [fullName, visibility] = existing?.split(" ") ?? [];
	const plan: string[] = [];
	if (!hasGit) plan.push(`git init (branch main) in ${project}`);
	plan.push(`git add -A and commit any changes (${files.length} files under version control, .gitignore respected; ${blockers.length ? "BLOCKED, see below" : "no secret files or credential-like values found"})`);
	if (existing) plan.push(`Repository ${fullName} exists (${visibility?.toLowerCase()}): ${originRepo ? "push to origin" : "add it as origin and push"}`);
	else plan.push(`gh repo create ${repo} --private, add it as origin, push`);
	if (stagingAccount) plan.push(`gh variable set CLOUDFLARE_ACCOUNT_ID (${stagingAccount}, from cloudflare.json; an account id is not secret)`);
	else plan.push("CLOUDFLARE_ACCOUNT_ID not in cloudflare.json: the variable is not set (CI deploys stay skipped)");
	if (existing && visibility && visibility.toUpperCase() !== "PRIVATE") blockers.push(`${fullName} is ${visibility.toLowerCase()}: client projects go in private repositories`);
	log(`Publish ${slug} → ${existing ? fullName : repo}${opts.yes ? "" : " (plan only)"}:`);
	for (const p of plan) log(`  - ${p}`);
	if (blockers.length) {
		for (const b of blockers) log(`✖ ${b}`);
		log("Nothing changed.");
		return { applied: false, repo, plan, blockers, files: files.length, next: [] };
	}
	if (!opts.yes) {
		log(`\nNothing changed. Rerun with --yes to publish: wp2emdash publish ${slug}${opts.repo ? ` --repo ${opts.repo}` : ""} --yes`);
		return { applied: false, repo, plan, blockers, files: files.length, next: [] };
	}

	if (!hasGit) sh("git", ["init", "-q", "-b", "main"], project);
	sh("git", ["add", "-A"], project);
	const staged = trySh("git", ["diff", "--cached", "--quiet"], project) === undefined; // exit 1 = changes staged
	const hasHead = trySh("git", ["rev-parse", "--verify", "-q", "HEAD"], project) !== undefined;
	if (staged || !hasHead) {
		sh("git", ["commit", "-q", "-m", hasHead ? `Update from wp2emdash (${new Date().toISOString().slice(0, 10)})` : `${config.name}: EmDash site generated by wp2emdash`], project);
		log("✔ Committed");
	} else log("= Nothing new to commit");
	let target = fullName ?? repo;
	if (!existing) {
		const url = sh("gh", ["repo", "create", repo, "--private", "--description", `${config.name} — EmDash site (${domain})`], project).trim();
		target = repoFromRemote(url) ?? repo;
		log(`✔ Created private repository ${target}`);
	}
	if (!originRepo) sh("git", ["remote", "add", "origin", `https://github.com/${target}.git`], project);
	const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], project).trim() || "main";
	sh("git", ["push", "-u", "origin", branch], project);
	log(`✔ Pushed ${branch} to ${target}`);
	if (stagingAccount) {
		sh("gh", ["variable", "set", "CLOUDFLARE_ACCOUNT_ID", "--repo", target, "--body", stagingAccount], project);
		log("✔ Repository variable CLOUDFLARE_ACCOUNT_ID set");
	}
	const next = [
		`Set the deploy token yourself (never done by the kit): gh secret set CLOUDFLARE_API_TOKEN --repo ${target}   # paste when asked`,
		"Use a build-only token: Workers Scripts, D1, R2 (and KV) edit on this account, no Zone permissions — not the go-live token (docs/cloudflare-api-token.md, token A)",
		...(productionAccount && productionAccount !== stagingAccount ? [`Production runs in another account: set it on the production environment: gh variable set CLOUDFLARE_ACCOUNT_ID --env production --repo ${target} --body ${productionAccount} (and its token with gh secret set … --env production)`] : []),
		"GitHub → Settings → Environments: production limited to main, the owner as required reviewer (docs/deployment.md in the project)",
	];
	for (const n of next) log(`  → ${n}`);
	return { applied: true, repo: target, plan, blockers, files: files.length, next };
}
