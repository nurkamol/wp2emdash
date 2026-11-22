/**
 * `wp2emdash fleet`: one view of every site, for an agency with many delivered sites.
 *
 * Per site, from files the kit already keeps (no network unless --live):
 *  - environments: production (live domain, or its workers.dev address), opt-in staging (src/core/environments.ts);
 *  - kit version the project was built with (the scaffold's `.wp2emdash.json`, src/core/build-marker.ts) against the
 *    current kit, and every @wp2emdash/* package version in the project's packages/ against the kit's;
 *  - last commit of the client project (git log);
 *  - the latest upgrade snapshot and its comparison results (reports/upgrade/<timestamp>/);
 *  - owner to-dos from structured sources only: failed gates not accepted, proposals waiting for approval, open
 *    ACCESS.md checklist items, an upgrade not verified yet, the monitoring window after go-live.
 * With --live (read-only): GET of the home page (status, response time) and `wrangler deployments list --json` for
 * the production Worker, with the site's credentials (credentialsFor, as provision does). Tokens are never printed.
 *
 * `wp2emdash fleet upgrade-prs`: src/commands/fleet-prs.ts.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import pc from "picocolors";
import { loadConfig } from "../config/load.js";
import { kitVersion, packageVersions, readBuildMarker, versionGap, type VersionGap } from "../core/build-marker.js";
import { readCf, siteEnvironments } from "../core/environments.js";
import { KIT_ROOT, SITES_DIR, sitePaths } from "../core/paths.js";
import { PHASES } from "../core/phases.js";
import { listProposals } from "../core/proposals.js";
import { nextPhase, phaseState, readState } from "../core/state.js";
import { loadSiteEnv, scrubSecrets } from "../extract/credentials.js";
import { parseAccess } from "../ui/cockpit.js";
import { credentialsFor } from "./provision.js";
import { listSites } from "./status.js";
import { latestUpgradeDir, upgradeAddresses } from "./upgrade.js";

export interface FleetTodo {
	/** gate | proposal | checklist | upgrade | monitoring */
	kind: "gate" | "proposal" | "checklist" | "upgrade" | "monitoring";
	text: string;
	/** Where it is recorded (relative to the site folder) or the command that settles it. */
	source: string;
	required?: boolean;
}

export interface FleetPackage {
	name: string;
	built?: string;
	current?: string;
	status: "current" | "behind" | "ahead" | "unknown" | "not-in-project" | "not-in-kit";
}

export interface FleetSite {
	slug: string;
	name: string;
	environments: {
		production: { url?: string; live: boolean; provisioned: boolean; domain: string };
		staging?: { url?: string };
	};
	project: { path: string; exists: boolean; git: boolean; branch?: string };
	kit: { built?: string; builtAt?: string; current?: string; gap: VersionGap; marker: boolean };
	packages: FleetPackage[];
	lastCommit?: { date: string; subject: string };
	lastDeploy?: { date?: string; source?: string; message?: string; error?: string };
	upgrade?: { dir: string; takenAt?: string; kitVersion?: string; pages: number; comparisons: { label: string; identical: boolean; pagesWithDifferences: number }[]; verified: boolean };
	live?: { url: string; status: number; ms: number; error?: string };
	todos: FleetTodo[];
	warnings: string[];
	error?: string;
}

export interface FleetOptions {
	sitesDir?: string;
	/** Only these slugs. */
	sites?: string[];
	/** Read-only network: home page GET, wrangler deployments list. */
	live?: boolean;
}

export interface FleetDeps {
	fetcher?: typeof fetch;
	/** Runs `wrangler deployments list --json` in the project (only with --live). */
	deployments?: (project: string, env: Record<string, string>, worker?: string) => Promise<{ code: number; out: string }>;
	git?: (args: string[], cwd: string) => { code: number; out: string };
	now?: () => Date;
	/** Kit root for the current version and packages (tests). */
	kitRoot?: string;
}

export function runGit(args: string[], cwd: string): { code: number; out: string } {
	const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } });
	return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** The project folder is the root of its own git repository (not a folder inside the kit's or another repo). */
export function ownGitRepo(project: string, git = runGit): boolean {
	if (!existsSync(project)) return false;
	const r = git(["rev-parse", "--show-toplevel"], project);
	if (r.code !== 0) return false;
	try {
		return realpathSync(r.out.split("\n")[0] as string) === realpathSync(project);
	} catch {
		return false;
	}
}

export async function defaultDeployments(project: string, env: Record<string, string>, worker?: string): Promise<{ code: number; out: string }> {
	return new Promise((resolve) => {
		const p = spawn("pnpm", ["exec", "wrangler", "deployments", "list", "--json", ...(worker ? ["--name", worker] : [])], { cwd: project, env: { ...process.env, ...env, CI: "1", FORCE_COLOR: "0" } });
		let out = "";
		const timer = setTimeout(() => p.kill(), 60_000);
		p.stdout.on("data", (b: Buffer) => (out += b.toString()));
		p.stderr.on("data", (b: Buffer) => (out += b.toString()));
		p.on("error", (e) => (clearTimeout(timer), resolve({ code: 1, out: `${out}${e.message}` })));
		p.on("close", (code) => (clearTimeout(timer), resolve({ code: code ?? 1, out })));
	});
}

/**
 * The newest deployment from `wrangler deployments list --json` output (an array of deployments, newest last in
 * wrangler 3/4; sorted here by created_on to be sure). Author addresses are left out.
 */
export function latestDeployment(out: string): { date?: string; source?: string; message?: string } | undefined {
	const start = out.search(/[[{]/);
	if (start < 0) return undefined;
	let data: unknown;
	try {
		data = JSON.parse(out.slice(start));
	} catch {
		return undefined;
	}
	const list = (Array.isArray(data) ? data : ((data as { deployments?: unknown[] })?.deployments ?? [])) as { created_on?: string; createdOn?: string; source?: string; annotations?: Record<string, string> }[];
	const rows = list.map((d) => ({ date: d.created_on ?? d.createdOn, source: d.source, message: d.annotations?.["workers/message"] })).filter((d) => d.date);
	rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
	const last = rows.at(-1);
	if (!last) return undefined;
	return { ...(last.date ? { date: last.date } : {}), ...(last.source ? { source: last.source } : {}), ...(last.message ? { message: last.message } : {}) };
}

/** The production Worker name: the first (top-level) "name" in wrangler.jsonc. */
export function workerName(project: string): string | undefined {
	try {
		return /"name"\s*:\s*"([^"]+)"/.exec(readFileSync(join(project, "wrangler.jsonc"), "utf8"))?.[1];
	} catch {
		return undefined;
	}
}

const readJson = <T>(file: string): T | undefined => {
	try {
		return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined;
	} catch {
		return undefined;
	}
};

/** The latest reports/upgrade/<timestamp>/: before snapshot and every comparison written next to it. */
export function upgradeSummary(root: string, reports: string): FleetSite["upgrade"] | undefined {
	const dir = latestUpgradeDir(reports);
	if (!dir) return undefined;
	const before = readJson<{ takenAt?: string; kitVersion?: string; pages?: unknown[] }>(join(dir, "before.json"));
	const comparisons = readdirSync(dir)
		.filter((f) => /^compare-.+\.json$/.test(f))
		.sort()
		.flatMap((f) => {
			const c = readJson<{ identical?: boolean; pagesWithDifferences?: number }>(join(dir, f));
			return c ? [{ label: f.replace(/^compare-|\.json$/g, ""), identical: !!c.identical, pagesWithDifferences: c.pagesWithDifferences ?? 0 }] : [];
		});
	return {
		dir: relative(root, dir),
		...(before?.takenAt ? { takenAt: before.takenAt } : {}),
		...(before?.kitVersion ? { kitVersion: before.kitVersion } : {}),
		pages: before?.pages?.length ?? 0,
		comparisons,
		verified: comparisons.some((c) => c.label === "production" && c.identical),
	};
}

function packageRows(built: Record<string, string>, current: Record<string, string>): FleetPackage[] {
	const names = [...new Set([...Object.keys(built), ...Object.keys(current)])].sort();
	return names.flatMap((name): FleetPackage[] => {
		const b = built[name];
		const c = current[name];
		if (!b) return []; // optional packages the site does not use are not listed
		if (!c) return [{ name, built: b, status: "not-in-kit" }];
		const g = versionGap(b, c);
		return [{ name, built: b, current: c, status: g.status }];
	});
}

async function liveHome(fetcher: typeof fetch, url: string, now: () => number): Promise<NonNullable<FleetSite["live"]>> {
	const t = now();
	try {
		const res = await fetcher(url, { redirect: "follow", headers: { "user-agent": "wp2emdash-fleet" }, signal: AbortSignal.timeout(15_000) });
		await res.arrayBuffer().catch(() => undefined);
		return { url, status: res.status, ms: Math.round(now() - t) };
	} catch (e) {
		return { url, status: 0, ms: Math.round(now() - t), error: (e as Error).message };
	}
}

export async function fleetSite(slug: string, opts: FleetOptions = {}, deps: FleetDeps = {}): Promise<FleetSite> {
	const paths = sitePaths(slug, opts.sitesDir);
	const git = deps.git ?? runGit;
	const now = deps.now ?? (() => new Date());
	const kitRoot = deps.kitRoot ?? KIT_ROOT;
	const current = kitVersion(kitRoot);
	const warnings: string[] = [];
	const todos: FleetTodo[] = [];

	let name = slug;
	let productionUrl = "";
	let monitorDays = 14;
	let config: Awaited<ReturnType<typeof loadConfig>> | undefined;
	try {
		config = await loadConfig(paths.config);
		name = config.name;
		productionUrl = config.target.productionUrl;
		monitorDays = config.target.cutover.monitorDays;
	} catch (e) {
		warnings.push(`kit.config.ts could not be read: ${(e as Error).message.split("\n")[0]}`);
	}
	if (!existsSync(join(paths.root, "cloudflare.json"))) warnings.push("no cloudflare.json (not provisioned)");
	const cf = readCf(paths.root);
	const envs = config ? siteEnvironments(config, cf) : { staging: false, live: !!cf.production?.live, productionProvisioned: !!cf.production?.d1?.id && !!cf.production?.worker?.url };
	const addr: { production?: string; staging?: string } = config ? upgradeAddresses(config, cf) : {};
	const domain = productionUrl ? new URL(productionUrl).hostname : "";

	// Project and versions
	const projectExists = existsSync(paths.project);
	const isGit = projectExists && ownGitRepo(paths.project, git);
	const marker = projectExists ? readBuildMarker(paths.project) : undefined;
	const builtPackages = projectExists ? packageVersions(paths.project) : {};
	if (!projectExists) warnings.push("no project folder (scaffold has not run here, or projectDir points elsewhere)");
	else if (!marker) warnings.push(`no ${".wp2emdash.json"} in the project: built before the kit recorded its version (rebuild to record it)`);
	let branch: string | undefined;
	let lastCommit: FleetSite["lastCommit"];
	if (isGit) {
		const b = git(["symbolic-ref", "--short", "-q", "HEAD"], paths.project);
		if (b.code === 0 && b.out) branch = b.out;
		const l = git(["log", "-1", "--format=%cI%x09%s"], paths.project);
		if (l.code === 0 && l.out) {
			const [date, ...subject] = l.out.split("\t");
			lastCommit = { date: date as string, subject: subject.join("\t") };
		}
	} else if (projectExists) warnings.push("project folder is not its own git repository");

	// Owner to-dos (structured sources only)
	let error: string | undefined;
	try {
		const state = readState(paths.state);
		for (const p of PHASES) {
			const s = phaseState(state, p.id);
			if (s.status === "failed") todos.push({ kind: "gate", text: `${p.id} gate failed (${s.checks.filter((c) => !c.ok).length} check(s)): fix and rerun, or the owner accepts it with a reason`, source: `pnpm wp2emdash run ${slug} ${p.id}`, required: true });
		}
		const next = nextPhase(state);
		if (next && phaseState(state, next).status !== "failed") todos.push({ kind: "gate", text: `next gate: ${next}`, source: `pnpm wp2emdash run ${slug} ${next}` });
	} catch (e) {
		error = `state.json unreadable: ${(e as Error).message.split("\n")[0]}`;
	}
	try {
		const n = listProposals(slug, { ...(opts.sitesDir ? { sitesDir: opts.sitesDir } : {}), status: "pending" }).length;
		if (n) todos.push({ kind: "proposal", text: `${n} proposal(s) waiting for approval`, source: `pnpm wp2emdash proposals ${slug}` });
	} catch {
		// an unreadable queue is not a fleet error
	}
	if (existsSync(paths.access)) {
		const items = parseAccess(readFileSync(paths.access, "utf8").slice(0, 200_000)).flatMap((s) => s.items).filter((i) => !i.done);
		const req = items.filter((i) => i.required);
		if (req.length) todos.push({ kind: "checklist", text: `${req.length} required ACCESS.md item(s) open: ${req.slice(0, 3).map((i) => i.text).join("; ")}${req.length > 3 ? "; …" : ""}`, source: "ACCESS.md", required: true });
		if (items.length > req.length) todos.push({ kind: "checklist", text: `${items.length - req.length} optional ACCESS.md item(s) open`, source: "ACCESS.md" });
	}
	const upgrade = upgradeSummary(paths.root, paths.reports);
	if (upgrade && !upgrade.verified) {
		const prod = upgrade.comparisons.find((c) => c.label === "production");
		todos.push(prod ? { kind: "upgrade", text: `production differs from the upgrade snapshot on ${prod.pagesWithDifferences} page(s)`, source: `${upgrade.dir}/compare-production.md`, required: true } : { kind: "upgrade", text: "upgrade not verified on production yet", source: `pnpm wp2emdash upgrade ${slug} --verify` });
	}
	const liveSince = (cf.production as { liveSince?: string } | undefined)?.liveSince ?? readJson<{ liveSince?: string }>(join(paths.root, "cutover", "golive.json"))?.liveSince;
	if (envs.live && liveSince) {
		const ends = new Date(Date.parse(liveSince) + monitorDays * 86_400_000);
		if (!Number.isNaN(ends.getTime()) && ends > now()) todos.push({ kind: "monitoring", text: `monitoring window until ${ends.toISOString().slice(0, 10)}; afterwards remove the go-live token`, source: "cutover/golive.json" });
	}

	const site: FleetSite = {
		slug,
		name,
		environments: {
			production: { ...(addr.production ? { url: addr.production } : {}), live: envs.live, provisioned: envs.productionProvisioned, domain },
			...(envs.staging ? { staging: addr.staging ? { url: addr.staging } : {} } : {}),
		},
		project: { path: paths.project, exists: projectExists, git: isGit, ...(branch ? { branch } : {}) },
		kit: { ...(marker ? { built: marker.kit, builtAt: marker.builtAt } : {}), ...(current ? { current } : {}), gap: versionGap(marker?.kit, current), marker: !!marker },
		packages: packageRows(Object.keys(builtPackages).length ? builtPackages : (marker?.packages ?? {}), packageVersions(kitRoot)),
		...(lastCommit ? { lastCommit } : {}),
		...(upgrade ? { upgrade } : {}),
		todos,
		warnings,
		...(error ? { error } : {}),
	};

	if (opts.live) {
		const fetcher = deps.fetcher ?? fetch;
		if (addr.production) site.live = await liveHome(fetcher, `${addr.production}/`, () => Date.now());
		if (projectExists && envs.productionProvisioned) {
			const fileVars = loadSiteEnv(paths.root);
			const vars = { ...process.env, ...fileVars } as Record<string, string | undefined>;
			const creds = credentialsFor("production", vars, cf as never);
			if (!creds.token || !creds.accountId) site.lastDeploy = { error: "no Cloudflare token/account for production in .env" };
			else {
				const env = { CLOUDFLARE_API_TOKEN: creds.token, CLOUDFLARE_ACCOUNT_ID: creds.accountId };
				const r = await (deps.deployments ?? defaultDeployments)(paths.project, env, workerName(paths.project));
				const scrub = (s: string) => scrubSecrets(s, { ...Object.fromEntries(Object.entries(fileVars).filter(([, v]) => v)), CLOUDFLARE_API_TOKEN: creds.token as string });
				const d = r.code === 0 ? latestDeployment(r.out) : undefined;
				site.lastDeploy = d ?? { error: scrub(r.code === 0 ? "no deployments in wrangler's answer" : `wrangler exited ${r.code}: ${r.out.split("\n").filter(Boolean).slice(-2).join(" ")}`).slice(0, 300) };
			}
		}
	}
	return site;
}

export async function fleet(opts: FleetOptions = {}, deps: FleetDeps = {}): Promise<FleetSite[]> {
	const all = listSites(opts.sitesDir ?? SITES_DIR);
	if (opts.sites?.length) {
		const unknown = opts.sites.filter((s) => !all.includes(s));
		if (unknown.length) throw new Error(`Unknown site(s): ${unknown.join(", ")}`);
	}
	const slugs = opts.sites?.length ? all.filter((s) => opts.sites?.includes(s)) : all;
	const out: FleetSite[] = [];
	for (const s of slugs) out.push(await fleetSite(s, opts, deps)); // sequential: git and wrangler per project
	return out;
}

// ── Terminal table ──────────────────────────────────────────────────────────────────────────────────────
const day = (iso?: string) => (iso ? iso.slice(0, 10) : "—");
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
// biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colour codes for width
const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;
const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - visible(s)));

export function fleetTable(sites: FleetSite[]): string {
	if (!sites.length) return "No sites yet. Run `wp2emdash` or `wp2emdash init`.";
	const current = sites.find((s) => s.kit.current)?.kit.current ?? "?";
	const rows = sites.map((s) => {
		const p = s.environments.production;
		const env = `${p.live ? pc.green(p.domain || "live") : p.url ? pc.dim(cut(p.url.replace(/^https?:\/\//, ""), 30)) : pc.dim("not provisioned")}${s.environments.staging ? pc.dim(" +staging") : ""}`;
		const g = s.kit.gap;
		const kit = g.status === "current" ? pc.green(s.kit.built ?? "") : g.status === "behind" ? pc.yellow(`${s.kit.built} (${g.text.replace(/^behind by /, "-").replace(/ versions?/, "")})`) : pc.dim(s.kit.built ?? "unknown");
		const outdated = s.packages.filter((x) => x.status === "behind").length;
		const plugins = s.packages.length ? (outdated ? pc.yellow(`${outdated}/${s.packages.length} behind`) : pc.green(`${s.packages.length} current`)) : pc.dim("—");
		const commit = s.lastDeploy?.date ? `${day(s.lastDeploy.date)} deploy` : s.lastCommit ? `${day(s.lastCommit.date)} ${cut(s.lastCommit.subject, 24)}` : pc.dim("—");
		const up = s.upgrade ? (s.upgrade.verified ? pc.green(`${day(s.upgrade.takenAt)} ok`) : s.upgrade.comparisons.some((c) => !c.identical) ? pc.red(`${day(s.upgrade.takenAt)} diff`) : pc.yellow(`${day(s.upgrade.takenAt)} unverified`)) : pc.dim("—");
		const live = s.live ? (s.live.status >= 200 && s.live.status < 400 ? pc.green(`${s.live.status} ${s.live.ms}ms`) : pc.red(`${s.live.status || s.live.error || "down"}`)) : pc.dim("—");
		const req = s.todos.filter((t) => t.required).length;
		const todo = s.error ? pc.red("state error") : s.todos.length ? (req ? pc.red(`${s.todos.length} (${req} req)`) : `${s.todos.length}`) : pc.green("0");
		return [s.slug, env, kit, plugins, commit, up, live, todo];
	});
	const head = ["SITE", "ENVIRONMENT", `KIT (now ${current})`, "PLUGINS", "LAST CHANGE", "UPGRADE", "LIVE", "TO-DO"];
	const widths = head.map((h, i) => Math.max(visible(h), ...rows.map((r) => visible(r[i] as string))));
	const line = (r: string[]) => r.map((c, i) => pad(c, widths[i] as number)).join("  ").trimEnd();
	const body = [pc.bold(line(head)), ...rows.map(line)];
	const notes = sites.flatMap((s) => [...s.todos.filter((t) => t.required).map((t) => `${s.slug}: ${t.text}`), ...(s.error ? [`${s.slug}: ${s.error}`] : [])]);
	return [...body, ...(notes.length ? ["", pc.bold("Required owner to-dos:"), ...notes.map((n) => `  - ${n}`)] : [])].join("\n");
}
