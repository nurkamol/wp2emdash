// `wp2emdash fleet` and `fleet upgrade-prs`, on synthetic sites and temp git repos only (no network, no real remotes).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { latestDeployment, fleet, fleetTable } from "../src/commands/fleet.js";
import { assertSafeBranch, upgradePr, upgradePrs, upgradePrsReport } from "../src/commands/fleet-prs.js";
import { initSite } from "../src/commands/init.js";
import { BUILD_MARKER, buildMarker, readBuildMarker, versionGap, writeBuildMarker } from "../src/core/build-marker.js";
import { sitePaths } from "../src/core/paths.js";
import { newState, recordGate, writeState } from "../src/core/state.js";
import { PHASE_IDS } from "../src/core/phases.js";
import { analyzeWorkflow, ciSafety, evaluateCondition, globToRegExp } from "../src/upgrade/ci-safety.js";
import { type ClientRepoInput, clientRepoFiles } from "../src/scaffold/client-repo.js";

const NOW = new Date("2026-11-22T12:00:00Z");
let dir: string;
let sites: string;
let kit: string;

const write = (file: string, content: string) => {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
};
const json = (file: string, v: unknown) => write(file, `${JSON.stringify(v, null, 2)}\n`);
const git = (cwd: string, ...args: string[]) => {
	const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout.trim();
};
function initRepo(project: string) {
	mkdirSync(project, { recursive: true });
	git(project, "init", "-q", "-b", "main");
	git(project, "config", "user.name", "Test");
	git(project, "config", "user.email", "test@example.invalid");
	git(project, "config", "commit.gpgsign", "false");
}
function commitAll(project: string, msg: string) {
	git(project, "add", "-A");
	git(project, "commit", "-q", "-m", msg);
}

/** A fake kit: version + two packages. */
function makeKit(version = "1.6.0") {
	json(join(kit, "package.json"), { name: "wp2emdash", version });
	json(join(kit, "packages", "forms", "package.json"), { name: "@wp2emdash/forms", version: "1.10.0" });
	json(join(kit, "packages", "seo", "package.json"), { name: "@wp2emdash/seo", version: "2.0.0" });
}

function makeSite(slug: string, name: string) {
	initSite({ slug, name, sourceUrl: `https://${slug}.example`, productionUrl: `https://${slug}.example`, sensitiveData: false }, sites);
	return sitePaths(slug, sites);
}

/** A project as the scaffold leaves it: packages/, marker, generated CI, committed. */
function makeProject(slug: string, o: { kit?: string; forms?: string; ci?: Partial<ClientRepoInput>; commit?: string } = {}) {
	const p = sitePaths(slug, sites).project;
	initRepo(p);
	json(join(p, "package.json"), { name: `${slug}-site`, private: true });
	json(join(p, "packages", "forms", "package.json"), { name: "@wp2emdash/forms", version: o.forms ?? "1.10.0" });
	json(join(p, "packages", "seo", "package.json"), { name: "@wp2emdash/seo", version: "2.0.0" });
	if (o.kit) json(join(p, BUILD_MARKER), { kit: o.kit, builtAt: "2026-10-01T00:00:00.000Z", packages: { "@wp2emdash/forms": o.forms ?? "1.10.0" } });
	for (const [rel, content] of Object.entries(ciFiles(slug, o.ci))) if (rel.startsWith(".github/workflows/")) write(join(p, rel), content);
	commitAll(p, o.commit ?? "Initial site");
	return p;
}

const ciInput = (slug: string, o: Partial<ClientRepoInput> = {}): ClientRepoInput => ({
	name: "Example Studio",
	slug,
	sourceUrl: `https://${slug}.example`,
	productionUrl: `https://${slug}.example`,
	workerName: slug,
	productionReady: false,
	sections: [],
	forms: [],
	email: { provider: "brevo", to: ["owner@example.invalid"] },
	turnstileProduction: false,
	sensitiveData: false,
	stack: { node: ">=24", astro: "7", emdash: "1.5.0", wrangler: "4" },
	...o,
} as ClientRepoInput);
const ciFiles = (slug: string, o: Partial<ClientRepoInput> = {}) => clientRepoFiles(ciInput(slug, o));

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "wp2emdash-fleet-"));
	sites = join(dir, "sites");
	kit = join(dir, "kit");
	makeKit();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// ── Build marker ───────────────────────────────────────────────────────────────────────────────────────
describe("build marker (.wp2emdash.json)", () => {
	it("records the kit version, build time and the project's package versions", () => {
		const p = join(dir, "proj");
		json(join(p, "packages", "forms", "package.json"), { name: "@wp2emdash/forms", version: "1.9.0" });
		const m = writeBuildMarker(p, { kitRoot: kit, now: NOW });
		expect(m).toEqual({ kit: "1.6.0", builtAt: NOW.toISOString(), packages: { "@wp2emdash/forms": "1.9.0" } });
		expect(readBuildMarker(p)).toEqual(m);
		expect(buildMarker(p, { kitRoot: kit, now: NOW })).toEqual(m);
		expect(readBuildMarker(join(dir, "nowhere"))).toBeUndefined();
	});

	it("is written by the scaffold next to package.json", () => {
		const src = readFileSync(new URL("../src/phases/scaffold.ts", import.meta.url), "utf8");
		expect(src).toMatch(/writeBuildMarker\(project\);\n\twritePerfFiles/);
		// The client repo keeps it: not gitignored by the starter.
		expect(readFileSync(new URL("../starter/.gitignore", import.meta.url), "utf8")).not.toMatch(/wp2emdash\.json/);
	});

	it("measures the gap in major / minor / patch versions", () => {
		expect(versionGap("1.6.0", "1.6.0").status).toBe("current");
		expect(versionGap("1.4.2", "1.6.0")).toMatchObject({ status: "behind", minor: 2, text: "behind by 2 minor versions" });
		expect(versionGap("1.6.0", "1.6.3")).toMatchObject({ status: "behind", patch: 3 });
		expect(versionGap("0.9.0", "1.6.0")).toMatchObject({ status: "behind", major: 1, text: "1 major version behind" });
		expect(versionGap("1.7.0", "1.6.0").status).toBe("ahead");
		expect(versionGap(undefined, "1.6.0").status).toBe("unknown");
	});
});

// ── Fleet view ─────────────────────────────────────────────────────────────────────────────────────────
describe("fleet", () => {
	beforeEach(() => {
		// alpha: live, built with 1.4.0, forms behind, an unverified upgrade, one required checklist item, a failed gate.
		const a = makeSite("alpha", "Alpha Studio");
		json(join(a.root, "cloudflare.json"), { production: { d1: { id: "d1" }, worker: { url: "https://alpha.acct.workers.dev" }, live: true, liveSince: "2026-11-20T10:00:00Z" } });
		makeProject("alpha", { kit: "1.4.0", forms: "1.8.0", commit: "Fix footer link" });
		write(a.access, "## Before launch\n- [ ] (required) DNS access confirmed\n- [x] (required) Hosting login\n- [ ] Analytics owner named\n");
		const st = recordGate(newState("alpha"), "audit", [{ id: "pages", label: "Pages", ok: false }], { runId: "r1", startedAt: "2026-11-01T00:00:00Z" });
		writeState(a.state, st);
		const up = join(a.reports, "upgrade", "2026-11-21T09-00-00Z");
		json(join(up, "before.json"), { takenAt: "2026-11-21T09:00:00Z", kitVersion: "1.6.0", pages: [{}, {}, {}] });
		json(join(up, "compare-staging.json"), { identical: true, pagesWithDifferences: 0 });
		// beta: nothing built, no cloudflare.json.
		makeSite("beta", "Beta Bakery");
		// gamma: current, workers.dev, verified upgrade.
		const g = makeSite("gamma", "Gamma Gym");
		json(join(g.root, "cloudflare.json"), { production: { d1: { id: "d2" }, worker: { url: "https://gamma.acct.workers.dev" } } });
		makeProject("gamma", { kit: "1.6.0" });
		let gs = newState("gamma");
		for (const id of PHASE_IDS) gs = recordGate(gs, id, [{ id: "x", label: "x", ok: true }], { runId: "r", startedAt: "2026-11-01T00:00:00Z" });
		writeState(g.state, gs);
		const gu = join(g.reports, "upgrade", "2026-11-01T00-00-00Z");
		json(join(gu, "before.json"), { takenAt: "2026-11-01T00:00:00Z", pages: [] });
		json(join(gu, "compare-production.json"), { identical: true, pagesWithDifferences: 0 });
		write(g.access, "- [x] (required) Done\n");
	});

	it("aggregates versions, environments, last commit, upgrade and owner to-dos per site", async () => {
		const r = await fleet({ sitesDir: sites }, { kitRoot: kit, now: () => NOW });
		expect(r.map((s) => s.slug)).toEqual(["alpha", "beta", "gamma"]);
		const [alpha, beta, gamma] = r as [(typeof r)[0], (typeof r)[0], (typeof r)[0]];

		expect(alpha.name).toBe("Alpha Studio");
		expect(alpha.environments.production).toMatchObject({ url: "https://alpha.example", live: true, provisioned: true, domain: "alpha.example" });
		expect(alpha.environments.staging).toBeUndefined();
		expect(alpha.kit).toMatchObject({ built: "1.4.0", current: "1.6.0", marker: true, gap: { status: "behind", minor: 2 } });
		expect(alpha.packages).toEqual([
			{ name: "@wp2emdash/forms", built: "1.8.0", current: "1.10.0", status: "behind" },
			{ name: "@wp2emdash/seo", built: "2.0.0", current: "2.0.0", status: "current" },
		]);
		expect(alpha.project).toMatchObject({ exists: true, git: true, branch: "main" });
		expect(alpha.lastCommit?.subject).toBe("Fix footer link");
		expect(alpha.upgrade).toMatchObject({ dir: "reports/upgrade/2026-11-21T09-00-00Z", kitVersion: "1.6.0", pages: 3, verified: false, comparisons: [{ label: "staging", identical: true }] });
		const kinds = alpha.todos.map((t) => t.kind);
		expect(kinds).toEqual(expect.arrayContaining(["gate", "checklist", "upgrade", "monitoring"]));
		expect(alpha.todos.find((t) => t.kind === "gate" && t.required)?.text).toMatch(/^audit gate failed \(1 check/);
		expect(alpha.todos.find((t) => t.kind === "checklist" && t.required)?.text).toBe("1 required ACCESS.md item(s) open: DNS access confirmed");
		expect(alpha.todos.find((t) => t.kind === "monitoring")?.text).toMatch(/until 2026-12-04/);
		expect(alpha.live).toBeUndefined();

		expect(beta.project.exists).toBe(false);
		expect(beta.kit.gap.status).toBe("unknown");
		expect(beta.packages).toEqual([]);
		expect(beta.environments.production).toMatchObject({ live: false, provisioned: false });
		expect(beta.environments.production.url).toBeUndefined();
		expect(beta.warnings).toEqual(expect.arrayContaining(["no cloudflare.json (not provisioned)", expect.stringMatching(/^no project folder/)]));

		expect(gamma.kit.gap.status).toBe("current");
		expect(gamma.environments.production).toMatchObject({ url: "https://gamma.acct.workers.dev", live: false });
		expect(gamma.upgrade?.verified).toBe(true);
		expect(gamma.todos).toEqual([]);
	});

	it("flags a project built before the marker, and filters by --sites", async () => {
		const d = makeSite("delta", "Delta Dental");
		json(join(d.root, "cloudflare.json"), { production: { d1: { id: "d3" }, worker: { url: "https://delta.acct.workers.dev" } } });
		makeProject("delta");
		const [delta] = await fleet({ sitesDir: sites, sites: ["delta"] }, { kitRoot: kit, now: () => NOW });
		expect(delta?.kit.marker).toBe(false);
		expect(delta?.kit.gap.status).toBe("unknown");
		expect(delta?.packages.map((p) => p.status)).toEqual(["current", "current"]);
		expect(delta?.warnings.join(" ")).toMatch(/built before the kit recorded its version/);
		await expect(fleet({ sitesDir: sites, sites: ["nope"] }, { kitRoot: kit })).rejects.toThrow(/Unknown site/);
	});

	it("JSON output round-trips and the table is compact", async () => {
		const r = await fleet({ sitesDir: sites }, { kitRoot: kit, now: () => NOW });
		expect(JSON.parse(JSON.stringify(r))).toEqual(r);
		const t = fleetTable(r).replace(/\x1b\[[0-9;]*m/g, "");
		const lines = t.split("\n");
		expect(lines[0]).toMatch(/^SITE\s+ENVIRONMENT\s+KIT \(now 1\.6\.0\)\s+PLUGINS/);
		expect(t).toMatch(/alpha\s+alpha\.example\s+1\.4\.0 \(-2 minor\)\s+1\/2 behind/);
		expect(t).toMatch(/beta\s+not provisioned\s+unknown/);
		expect(t).toContain("Required owner to-dos:");
		expect(fleetTable([])).toMatch(/No sites yet/);
	});

	it("--live: home page status, last deploy via wrangler with the site's token, never printed", async () => {
		const token = "cf-secret-token-0123456789";
		write(join(sitePaths("gamma", sites).root, ".env"), `CLOUDFLARE_API_TOKEN=${token}\nCLOUDFLARE_ACCOUNT_ID=acct123\n`);
		const seen: { url: string; env?: Record<string, string>; worker?: string }[] = [];
		const fetcher = (async (url: string) => (seen.push({ url }), new Response("<html></html>", { status: 200 }))) as unknown as typeof fetch;
		const deployments = async (_p: string, env: Record<string, string>, worker?: string) => {
			seen.push({ url: "wrangler", env, ...(worker ? { worker } : {}) });
			return { code: 0, out: JSON.stringify([{ id: "a", created_on: "2026-11-01T00:00:00Z", source: "wrangler", author_email: "dev@example.invalid" }, { id: "b", created_on: "2026-11-21T08:00:00Z", source: "wrangler", annotations: { "workers/message": "Upgrade" } }]) };
		};
		const [gamma] = await fleet({ sitesDir: sites, sites: ["gamma"], live: true }, { kitRoot: kit, fetcher, deployments });
		expect(gamma?.live).toMatchObject({ url: "https://gamma.acct.workers.dev/", status: 200 });
		expect(gamma?.lastDeploy).toEqual({ date: "2026-11-21T08:00:00Z", source: "wrangler", message: "Upgrade" });
		expect(seen.find((s) => s.url === "wrangler")?.env).toEqual({ CLOUDFLARE_API_TOKEN: token, CLOUDFLARE_ACCOUNT_ID: "acct123" });
		expect(JSON.stringify(gamma)).not.toContain(token);
		expect(JSON.stringify(gamma)).not.toContain("dev@example.invalid");

		// A failing wrangler run that echoes the token: scrubbed.
		const [again] = await fleet({ sitesDir: sites, sites: ["gamma"], live: true }, { kitRoot: kit, fetcher, deployments: async () => ({ code: 1, out: `Authentication error for ${token}` }) });
		expect(again?.lastDeploy?.error).toMatch(/wrangler exited 1/);
		expect(JSON.stringify(again)).not.toContain(token);
	});

	it("reads the newest deployment from wrangler's JSON", () => {
		expect(latestDeployment("garbage")).toBeUndefined();
		expect(latestDeployment(`warning line\n${JSON.stringify([{ created_on: "2026-01-02T00:00:00Z" }, { created_on: "2026-01-01T00:00:00Z" }])}`)).toEqual({ date: "2026-01-02T00:00:00Z" });
	});
});

// ── CI safety ──────────────────────────────────────────────────────────────────────────────────────────
describe("CI safety (does a branch push or PR deploy?)", () => {
	const push = { kind: "push" as const, branch: "wp2emdash/v1.6.0", base: "main" };
	const pr = { kind: "pull_request" as const, branch: "wp2emdash/v1.6.0", base: "main" };

	it("the workflows the scaffold generates never deploy from a branch push or a pull request", () => {
		const variants: Partial<ClientRepoInput>[] = [
			{},
			{ productionFingerprint: "fp", ciDeploy: "always" },
			{ productionFingerprint: "fp", ciDeploy: "prelaunch" },
			{ productionFingerprint: "fp", productionReady: true, ciDeploy: "manual" },
			{ staging: true, stagingUrl: "https://s.workers.dev", stagingFingerprint: "sfp", productionFingerprint: "fp" },
		];
		for (const v of variants) {
			const yml = ciFiles("acme", v)[".github/workflows/ci.yml"] as string;
			for (const ev of [push, pr]) {
				const f = analyzeWorkflow("ci.yml", yml, ev);
				expect(f.unreadable, JSON.stringify(v)).toBeUndefined();
				expect(f.deployJobs, `${JSON.stringify(v)} ${ev.kind}`).toEqual([]);
			}
			// …but a push to main does deploy where configured (the analysis sees it).
			if (v.ciDeploy === "always" || v.staging) expect(analyzeWorkflow("ci.yml", yml, { ...push, branch: "main" }).deployJobs.length).toBeGreaterThan(0);
		}
	});

	it("flags workflows that deploy on any branch push or on pull requests", () => {
		const anyBranch = "on:\n  push:\n    branches: ['**']\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npx wrangler deploy\n";
		expect(analyzeWorkflow("a.yml", anyBranch, push).deployJobs[0]).toMatch(/^deploy \(runs npx wrangler deploy|^deploy \(runs wrangler deploy/);
		const onPr = "on: [pull_request]\njobs:\n  preview:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: cloudflare/wrangler-action@v3\n";
		expect(analyzeWorkflow("b.yml", onPr, pr).deployJobs).toHaveLength(1);
		expect(analyzeWorkflow("b.yml", onPr, push).firedBy).toEqual([]);
		const guarded = "on:\n  push:\njobs:\n  deploy:\n    if: github.ref == 'refs/heads/main'\n    environment: production\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm deploy:production\n";
		expect(analyzeWorkflow("c.yml", guarded, push).deployJobs).toEqual([]);
		const unknownIf = guarded.replace("github.ref == 'refs/heads/main'", "vars.DEPLOY == 'yes'");
		expect(analyzeWorkflow("d.yml", unknownIf, push).deployJobs[0]).toMatch(/cannot be proven false/);
		const ignored = "on:\n  push:\n    branches-ignore:\n      - 'wp2emdash/**'\njobs:\n  d:\n    runs-on: x\n    steps:\n      - run: wrangler deploy\n";
		expect(analyzeWorkflow("e.yml", ignored, push).firedBy).toEqual([]);
		expect(analyzeWorkflow("f.yml", "on: {push: {}}\njobs: {}\n", push).unreadable).toMatch(/flow-style/);
		const reusable = "on: push\njobs:\n  call:\n    uses: ./.github/workflows/deploy.yml\n";
		expect(analyzeWorkflow("g.yml", reusable, push).deployJobs[0]).toMatch(/reusable workflow/);
		const tagsOnly = "on:\n  push:\n    tags: ['v*']\njobs:\n  d:\n    runs-on: x\n    steps:\n      - run: wrangler deploy\n";
		expect(analyzeWorkflow("h.yml", tagsOnly, push).firedBy).toEqual([]);
	});

	it("evaluates job conditions three-valued", () => {
		expect(evaluateCondition("github.event_name == 'push'", push)).toBe(true);
		expect(evaluateCondition("${{ github.event_name == 'workflow_dispatch' && inputs.target == 'production' }}", push)).toBe(false);
		expect(evaluateCondition("vars.X != '' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')", pr)).toBe(false);
		expect(evaluateCondition("vars.X != '' && github.event_name == 'push'", push)).toBeUndefined();
		expect(evaluateCondition("startsWith(github.ref, 'refs/heads/wp2emdash/')", push)).toBe(true);
		expect(evaluateCondition("!contains(github.head_ref, 'wp2emdash')", pr)).toBe(false);
		expect(evaluateCondition("success() || github.event_name == 'push'", push)).toBe(true);
		expect(evaluateCondition("weird ==", push)).toBeUndefined();
		expect(globToRegExp("wp2emdash/*").test("wp2emdash/v1.6.0")).toBe(true);
		expect(globToRegExp("*").test("wp2emdash/v1.6.0")).toBe(false);
	});

	it("a repo without workflows is safe; an unreadable one is not", () => {
		const repo = join(dir, "repo");
		mkdirSync(repo, { recursive: true });
		expect(ciSafety(repo, push).safe).toBe(true);
		write(join(repo, ".github", "workflows", "x.yml"), "name: nothing here\n");
		const r = ciSafety(repo, push);
		expect(r.safe).toBe(false);
		expect(r.reasons[0]).toMatch(/could not be read/);
	});
});

// ── upgrade-prs ────────────────────────────────────────────────────────────────────────────────────────
describe("fleet upgrade-prs", () => {
	let project: string;
	const branch = "wp2emdash/v1.6.0";
	const scaffoldRuns: { slug: string; preview: boolean }[] = [];
	const okScaffold = async (slug: string, o: { preview: boolean }) => {
		scaffoldRuns.push({ slug, preview: o.preview });
		const p = sitePaths(slug, sites).project;
		json(join(p, "packages", "forms", "package.json"), { name: "@wp2emdash/forms", version: "1.10.0" });
		writeBuildMarker(p, { kitRoot: kit, now: NOW });
		return { ok: true, runId: "r1", checks: [{ id: "build", label: "Build", ok: true }] };
	};
	const head = () => git(project, "symbolic-ref", "--short", "HEAD");
	const branches = () => git(project, "branch", "--format=%(refname:short)").split("\n").sort();

	beforeEach(() => {
		scaffoldRuns.length = 0;
		makeSite("acme", "Acme Works");
		project = makeProject("acme", { kit: "1.4.0", forms: "1.8.0", ci: { productionFingerprint: "fp", ciDeploy: "always" } });
	});

	it("dry run (default): plans the branch, rebuild, commit and PR command; changes nothing", async () => {
		const mainBefore = git(project, "rev-parse", "main");
		const r = await upgradePr("acme", { sitesDir: sites }, { kitRoot: kit, runScaffold: okScaffold });
		expect(r).toMatchObject({ status: "planned", built: "1.4.0", target: "1.6.0", branch, base: "main", preview: true });
		expect(r.ci?.push.safe).toBe(true);
		expect(r.ci?.pullRequest.safe).toBe(true);
		expect(r.steps[0]).toMatch(/git switch -c wp2emdash\/v1\.6\.0/);
		expect(r.steps[1]).toMatch(/--preview/);
		expect(r.prCommand).toMatch(/git push -u origin refs\/heads\/wp2emdash\/v1\.6\.0:refs\/heads\/wp2emdash\/v1\.6\.0 && gh pr create --base main --head wp2emdash\/v1\.6\.0/);
		expect(scaffoldRuns).toEqual([]);
		expect(branches()).toEqual(["main"]);
		expect(git(project, "rev-parse", "main")).toBe(mainBefore);
		expect(git(project, "status", "--porcelain")).toBe("");
		expect(upgradePrsReport([r], {})).toMatch(/^Mode: dry run/);
	});

	it("--apply: commits the rebuild on the branch only, main untouched, back on main", async () => {
		const mainBefore = git(project, "rev-parse", "main");
		const r = await upgradePr("acme", { sitesDir: sites, apply: true }, { kitRoot: kit, runScaffold: okScaffold });
		expect(r.status).toBe("committed");
		expect(scaffoldRuns).toEqual([{ slug: "acme", preview: true }]);
		expect(head()).toBe("main");
		expect(git(project, "rev-parse", "main")).toBe(mainBefore);
		expect(branches()).toEqual(["main", branch]);
		expect(git(project, "log", "-1", "--format=%s", branch)).toBe("Upgrade to wp2emdash v1.6.0");
		expect(git(project, "log", "-1", "--format=%b", branch)).toContain("@wp2emdash/forms: 1.8.0 → 1.10.0");
		expect(JSON.parse(git(project, "show", `${branch}:.wp2emdash.json`)).kit).toBe("1.6.0");
		expect(git(project, "status", "--porcelain")).toBe("");
		expect(r.prCommand).toContain("gh pr create");
	});

	it("records the gate (no --preview) when the earlier gates passed", async () => {
		let st = newState("acme");
		for (const id of PHASE_IDS.slice(0, PHASE_IDS.indexOf("scaffold"))) st = recordGate(st, id, [{ id: "x", label: "x", ok: true }], { runId: "r", startedAt: "2026-11-01T00:00:00Z" });
		writeState(sitePaths("acme", sites).state, st);
		const r = await upgradePr("acme", { sitesDir: sites }, { kitRoot: kit });
		expect(r.preview).toBe(false);
	});

	it("--open: pushes only the branch to origin and opens the PR with gh", async () => {
		const remote = join(dir, "remote.git");
		spawnSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
		git(project, "remote", "add", "origin", remote);
		git(project, "push", "-q", "origin", "main");
		const remoteMain = git(remote, "rev-parse", "main");
		const ghCalls: string[][] = [];
		const r = await upgradePr("acme", { sitesDir: sites, open: true }, { kitRoot: kit, runScaffold: okScaffold, gh: (args) => (ghCalls.push(args), { code: 0, out: "https://github.invalid/acme/site/pull/7" }) });
		expect(r.status).toBe("opened");
		expect(r.prUrl).toBe("https://github.invalid/acme/site/pull/7");
		expect(git(remote, "rev-parse", "main")).toBe(remoteMain);
		expect(git(remote, "branch", "--format=%(refname:short)").split("\n").sort()).toEqual(["main", branch]);
		expect(ghCalls[0]?.slice(0, 6)).toEqual(["pr", "create", "--base", "main", "--head", branch]);
	});

	it("refuses: not on main, uncommitted changes, branch exists, no origin for --open", async () => {
		git(project, "switch", "-q", "-c", "feature");
		expect(await upgradePr("acme", { sitesDir: sites }, { kitRoot: kit })).toMatchObject({ status: "refused", reason: expect.stringMatching(/on branch "feature", not main/) });
		git(project, "switch", "-q", "main");

		write(join(project, "notes.txt"), "work in progress");
		expect(await upgradePr("acme", { sitesDir: sites, apply: true }, { kitRoot: kit, runScaffold: okScaffold })).toMatchObject({ status: "refused", reason: expect.stringMatching(/uncommitted changes/) });
		rmSync(join(project, "notes.txt"));

		git(project, "branch", branch);
		expect(await upgradePr("acme", { sitesDir: sites, apply: true }, { kitRoot: kit, runScaffold: okScaffold })).toMatchObject({ status: "refused", reason: `branch ${branch} already exists locally` });
		git(project, "branch", "-D", branch);

		expect(await upgradePr("acme", { sitesDir: sites, open: true }, { kitRoot: kit, runScaffold: okScaffold })).toMatchObject({ status: "refused", reason: "no origin remote to push to" });
		expect(scaffoldRuns).toEqual([]);
	});

	it("refuses when the client repo's CI would deploy from the branch", async () => {
		write(join(project, ".github", "workflows", "preview.yml"), "on:\n  push:\n    branches: ['**']\njobs:\n  deploy:\n    runs-on: ubuntu-latest\n    steps:\n      - run: pnpm ci:deploy:production\n");
		commitAll(project, "Add preview workflow");
		const r = await upgradePr("acme", { sitesDir: sites, open: true }, { kitRoot: kit, runScaffold: okScaffold });
		expect(r.status).toBe("refused");
		expect(r.reason).toMatch(/CI could deploy from this branch: \.github\/workflows\/preview\.yml: a push of wp2emdash\/v1\.6\.0 \(push\) runs deploy job deploy/);
		expect(branches()).toEqual(["main"]);
	});

	it("a failed scaffold gate removes the branch and leaves main clean", async () => {
		const failing = async (slug: string) => {
			write(join(sitePaths(slug, sites).project, "half.txt"), "partial output");
			return { ok: false, runId: "r", checks: [{ id: "build", label: "Build", ok: false }] };
		};
		const r = await upgradePr("acme", { sitesDir: sites, apply: true }, { kitRoot: kit, runScaffold: failing });
		expect(r).toMatchObject({ status: "failed", reason: expect.stringMatching(/scaffold gate failed \(build\)/) });
		expect(head()).toBe("main");
		expect(branches()).toEqual(["main"]);
		expect(existsSync(join(project, "half.txt"))).toBe(false);
	});

	it("skips current sites, refuses missing projects, and never commits to main", async () => {
		makeSite("fresh", "Fresh Foods");
		makeProject("fresh", { kit: "1.6.0" });
		makeSite("empty", "Empty Lot");
		const r = await upgradePrs({ sitesDir: sites }, { kitRoot: kit, runScaffold: okScaffold });
		expect(Object.fromEntries(r.map((x) => [x.slug, x.status]))).toEqual({ acme: "planned", empty: "refused", fresh: "skipped" });
		expect(r.find((x) => x.slug === "empty")?.reason).toMatch(/no project folder/);
		expect(() => assertSafeBranch("main", "main")).toThrow(/never "main"/);
		expect(() => assertSafeBranch("production", "main")).toThrow(/Refused/);
		expect(() => assertSafeBranch("feature/x", "main")).toThrow(/Refused/);
		expect(() => assertSafeBranch(branch, "main")).not.toThrow();
	});

	it("refuses a project folder that is not its own repository (e.g. inside another repo)", async () => {
		makeSite("nested", "Nested Co");
		const p = sitePaths("nested", sites).project;
		initRepo(sites); // sites/ is a repo; the project folder inside it has no .git of its own
		json(join(p, "package.json"), {});
		const r = await upgradePr("nested", { sitesDir: sites }, { kitRoot: kit });
		expect(r).toMatchObject({ status: "refused", reason: expect.stringMatching(/not the root of its own git repository/) });
	});
});
