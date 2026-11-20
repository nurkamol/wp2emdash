/**
 * Launch cockpit actions (docs/PLAN.md §7a, §10b feature 4): the go-live plan (golive's own dry run), and the
 * owner-approved steps `golive --yes`, `golive --aliases --yes`, `golive --rollback [--aliases] --yes`.
 *
 * Confirmation, enforced here on the server (the browser form is only a convenience):
 * - the operator types the production domain exactly (`confirmDomain`);
 * - ticks "The owner approved … in writing" (`approved: true`) and gives the approval as written (`approval`: who,
 *   when, where — at least 10 characters) and their own name (`by`).
 * The approval is appended to decisions.md before the command starts and passed to golive, which records it in
 * cutover/golive.json → approvals. The command itself is the CLI (`wp2emdash golive … --yes`) in a child process,
 * so the dashboard does exactly what the terminal does, and nothing more.
 */
import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GoliveApproval, GoliveRecord, GoliveResult } from "../commands/golive.js";
import { loadConfig } from "../config/load.js";
import type { KitConfig } from "../config/schema.js";
import { type CfFile, readCf, type SiteEnvironments, siteEnvironments } from "../core/environments.js";
import { SITES_DIR, type SitePaths, sitePaths } from "../core/paths.js";
import type { GateCheck } from "../core/state.js";
import { primaryHost } from "../cutover/aliases.js";
import { type ActionDeps, type ActionName, type ActionRun, BusyError, mergedEnv, type SiteLocks, startAction } from "./actions.js";
import { cell, runHistory, type RunSummary, UserError } from "./data.js";
import { oneLine } from "./queue.js";

// ── Site context ─────────────────────────────────────────────────────────────────────────────────────────────

export interface SiteContext {
	slug: string;
	sitesDir: string;
	paths: SitePaths;
	config: KitConfig;
	/** Production domain without www: what the operator types to confirm. */
	domain: string;
	canonical: string;
	cf: CfFile & { production?: CfFile["production"] & { liveSince?: string } };
	envs: SiteEnvironments;
}

export async function siteContext(slug: string, sitesDir = SITES_DIR): Promise<SiteContext> {
	const paths = sitePaths(slug, sitesDir);
	const config = await loadConfig(paths.config);
	const cf = readCf(paths.root) as SiteContext["cf"];
	return {
		slug,
		sitesDir,
		paths,
		config,
		domain: new URL(config.target.productionUrl).hostname.replace(/^www\./, "").toLowerCase(),
		canonical: primaryHost(config.target.productionUrl, config.target.canonicalHost),
		cf,
		envs: siteEnvironments(config, cf),
	};
}

// ── Confirmation ─────────────────────────────────────────────────────────────────────────────────────────────

export interface Confirmed {
	by: string;
	approval?: string;
}

/**
 * The typed-domain confirmation (and, with `approval: true`, the owner's written approval). Throws UserError with a
 * plain message when anything is missing; nothing runs without it.
 */
export function requireConfirmation(body: Record<string, unknown>, o: { domain: string; approval: boolean; typedDomain?: boolean }): Confirmed {
	if (o.typedDomain !== false) {
		const typed = typeof body.confirmDomain === "string" ? body.confirmDomain.trim().toLowerCase() : "";
		if (!typed) throw new UserError(`Type the production domain (${o.domain}) to confirm.`);
		if (typed !== o.domain.toLowerCase()) throw new UserError(`The domain you typed does not match ${o.domain}.`);
	}
	const by = oneLine(body.by, "Your name", 120, true) as string;
	if (!o.approval) return { by };
	if (body.approved !== true) throw new UserError("Tick “The owner approved this in writing” — only the owner can approve this step.");
	const approval = oneLine(body.approval, "The owner's approval (name, date, where)", 1000, true) as string;
	if (approval.length < 10) throw new UserError("Write down the owner's approval: who, when and where (at least 10 characters).");
	return { by, approval };
}

/** Appends a dated row to decisions.md in the table `wp2emdash accept` uses. */
export function appendDecision(paths: SitePaths, phase: string, what: string, reason: string, by: string, now: Date): void {
	const file = paths.decisions;
	if (!existsSync(file)) writeFileSync(file, "# Decisions\n\n| Date | Phase | Decision | Reason | Approved by |\n|---|---|---|---|---|\n");
	else {
		const text = readFileSync(file, "utf8");
		if (text.length && !text.endsWith("\n")) appendFileSync(file, "\n");
	}
	appendFileSync(file, `| ${now.toISOString().slice(0, 10)} | ${cell(phase)} | ${cell(what)} | ${cell(reason)} | ${cell(by)} |\n`);
}

// ── Go-live view (local files only; no network) ─────────────────────────────────────────────────────────────

export type GoliveMode = "primary" | "aliases" | "rollback" | "rollback-aliases";
export const GOLIVE_MODES: GoliveMode[] = ["primary", "aliases", "rollback", "rollback-aliases"];
export const isGoliveMode = (v: unknown): v is GoliveMode => typeof v === "string" && (GOLIVE_MODES as string[]).includes(v);

const MODE_ARGS: Record<GoliveMode, string[]> = { primary: [], aliases: ["--aliases"], rollback: ["--rollback"], "rollback-aliases": ["--rollback", "--aliases"] };
const MODE_ACTION: Record<GoliveMode, ActionName> = { primary: "golive", aliases: "golive-aliases", rollback: "golive-rollback", "rollback-aliases": "golive-rollback-aliases" };
const MODE_LABEL: Record<GoliveMode, string> = { primary: "Go live (routes for the domain)", aliases: "Alias redirects", rollback: "Roll back the switch", "rollback-aliases": "Roll back the alias redirects" };

export const goliveCommand = (slug: string, mode: GoliveMode, yes = false) => ["golive", slug, ...MODE_ARGS[mode], ...(yes ? ["--yes"] : [])];

export interface ActionAvailability {
	mode: GoliveMode;
	label: string;
	available: boolean;
	why?: string;
	command: string;
}

export interface LaunchView {
	domain: string;
	canonical: string;
	worker?: string;
	workersDev?: string;
	aliasDomains: string[];
	live: boolean;
	liveSince?: string;
	monitorDays: number;
	monitorEndsOn?: string;
	preflight: { status: string; ranAt?: string };
	record?: Pick<GoliveRecord, "zoneId" | "routes" | "aliasRules" | "switchedAt" | "liveSince" | "smoke"> & { history: GoliveRecord["history"]; approvals: GoliveApproval[]; lastChecks?: GoliveRecord["lastChecks"] };
	aliasCheck?: { ranAt?: string; ok: boolean; checked: number; failures: number; byHost: Record<string, { checked: number; ok: number }> };
	dnsSnapshots: { file: string; takenAt: string; records: number }[];
	/** The latest DNS comparison golive made (from golive.json → lastChecks). */
	dnsChecks: GateCheck[];
	actions: ActionAvailability[];
	runs: RunSummary[];
	note: string;
}

const readJson = <T>(file: string): T | undefined => {
	try {
		return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined;
	} catch {
		return undefined;
	}
};

const addDays = (iso: string, days: number) => {
	const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
};
export const monitorEnd = (liveSince: string | undefined, days: number) => (liveSince ? addDays(liveSince, days) : undefined);

export function launchView(ctx: SiteContext, preflightStatus: { status: string; ranAt?: string }): LaunchView {
	const out = join(ctx.paths.root, "cutover");
	const rec = readJson<GoliveRecord>(join(out, "golive.json"));
	const prod = ctx.cf.production as { live?: boolean; liveSince?: string; worker?: { name?: string; url?: string } } | undefined;
	const live = !!prod?.live;
	const liveSince = prod?.liveSince ?? rec?.liveSince;
	const monitorDays = ctx.config.target.cutover.monitorDays;
	const aliasDomains = ctx.config.target.aliasDomains;
	const ac = readJson<{ ranAt?: string; ok: boolean; checked: number; failures: unknown[]; byHost?: Record<string, { checked: number; ok: number }> }>(join(out, "aliases-check.json"));
	const dnsSnapshots: LaunchView["dnsSnapshots"] = [];
	for (const name of ["dns-before.json", ...aliasDomains.map((a) => `dns-before.${a}.json`)]) {
		const f = join(out, name);
		if (!existsSync(f)) continue;
		const j = readJson<{ web?: unknown[]; keep?: unknown[]; records?: unknown[] }>(f);
		dnsSnapshots.push({ file: `cutover/${name}`, takenAt: statSync(f).mtime.toISOString(), records: (j?.web?.length ?? 0) + (j?.keep?.length ?? 0) + (j?.records?.length ?? 0) });
	}
	const preflightOk = preflightStatus.status === "passed" || preflightStatus.status === "accepted";
	const recorded = !!rec && (rec.routes.length > 0 || rec.aliasRules.length > 0);
	const cmd = (m: GoliveMode) => `pnpm wp2emdash ${goliveCommand(ctx.slug, m).join(" ")}`;
	const actions: ActionAvailability[] = [
		{ mode: "primary", label: MODE_LABEL.primary, available: preflightOk, ...(preflightOk ? (live ? { why: "Already live: rerunning keeps the recorded routes and repeats the smoke test." } : {}) : { why: `The cutover preflight must pass (or be accepted by the owner) first — it is ${preflightStatus.status}.` }), command: cmd("primary") },
		{ mode: "aliases", label: MODE_LABEL.aliases, available: preflightOk && live && aliasDomains.length > 0, ...(!aliasDomains.length ? { why: "No target.aliasDomains in kit.config.ts." } : !live ? { why: "The primary domain must be live first." } : !preflightOk ? { why: "The cutover preflight must pass first." } : {}), command: cmd("aliases") },
		{ mode: "rollback", label: MODE_LABEL.rollback, available: recorded, ...(recorded ? {} : { why: "Nothing recorded in cutover/golive.json (a switch made by hand is rolled back with the runbook)." }), command: cmd("rollback") },
		{ mode: "rollback-aliases", label: MODE_LABEL["rollback-aliases"], available: !!rec?.aliasRules.length, ...(rec?.aliasRules.length ? {} : { why: "No alias rules recorded in cutover/golive.json." }), command: cmd("rollback-aliases") },
	];
	return {
		domain: ctx.domain,
		canonical: ctx.canonical,
		...(prod?.worker?.name ? { worker: prod.worker.name } : {}),
		...(prod?.worker?.url ? { workersDev: prod.worker.url } : {}),
		aliasDomains,
		live,
		...(liveSince ? { liveSince } : {}),
		monitorDays,
		...(liveSince ? { monitorEndsOn: monitorEnd(liveSince, monitorDays) } : {}),
		preflight: preflightStatus,
		...(rec
			? {
					record: {
						...(rec.zoneId ? { zoneId: rec.zoneId } : {}),
						routes: rec.routes ?? [],
						aliasRules: rec.aliasRules ?? [],
						...(rec.switchedAt ? { switchedAt: rec.switchedAt } : {}),
						...(rec.liveSince ? { liveSince: rec.liveSince } : {}),
						...(rec.smoke ? { smoke: rec.smoke } : {}),
						history: [...(rec.history ?? [])].reverse().slice(0, 100),
						approvals: [...(rec.approvals ?? [])].reverse(),
						...(rec.lastChecks ? { lastChecks: rec.lastChecks } : {}),
					},
				}
			: {}),
		...(ac ? { aliasCheck: { ...(ac.ranAt ? { ranAt: ac.ranAt } : {}), ok: !!ac.ok, checked: ac.checked ?? 0, failures: Array.isArray(ac.failures) ? ac.failures.length : 0, byHost: ac.byHost ?? {} } } : {}),
		dnsSnapshots,
		dnsChecks: (rec?.lastChecks?.checks ?? []).filter((c) => c.id.startsWith("dns-unchanged")),
		actions,
		runs: runHistory(ctx.slug, ctx.sitesDir, 200).filter((r) => r.phase?.startsWith("golive") || r.phase === "publish").slice(0, 20),
		note: "Every step here runs the same command as the terminal (wp2emdash golive … --yes) and only after you type the domain and record the owner's written approval. DNS is never changed.",
	};
}

// ── Plan (golive's dry run) ──────────────────────────────────────────────────────────────────────────────────

export interface GolivePlan {
	mode: GoliveMode;
	ok: boolean;
	plan: string[];
	blockers: string[];
	checks: GateCheck[];
	/** What the step changes, in plain words (always shown, also when the dry run could not reach Cloudflare). */
	changes: string[];
	error?: string;
	command: string;
}

export function plannedChanges(ctx: SiteContext, mode: GoliveMode): string[] {
	const worker = (ctx.cf.production as { worker?: { name?: string } } | undefined)?.worker?.name ?? ctx.slug;
	if (mode === "primary")
		return [
			`Worker routes ${ctx.domain}/* and www.${ctx.domain}/* → Worker "${worker}" (zone ${ctx.domain})`,
			`EmDash Site URL → https://${ctx.canonical}`,
			"cloudflare.json → production.live = true, liveSince = today",
			"cutover/golive.json: route ids, smoke result, the owner's approval",
			"No DNS change",
		];
	if (mode === "aliases") return [...ctx.config.target.aliasDomains.map((a) => `${a}: one Single Redirect rule (apex + www → https://${ctx.canonical}, same path, 301), appended to the zone's redirect rules`), "No DNS change (mail records untouched)"];
	if (mode === "rollback") return ["Delete exactly the route ids and alias rule ids in cutover/golive.json", "cloudflare.json → production.live = false", "Traffic returns to WordPress (DNS unchanged)"];
	return ["Delete exactly the alias rule ids in cutover/golive.json (primary routes stay)"];
}

/** golive without --yes (`--json`): re-checks the preconditions with the go-live token and returns the plan. */
export async function golivePlan(ctx: SiteContext, mode: GoliveMode, deps: ActionDeps): Promise<GolivePlan> {
	const base = { mode, changes: plannedChanges(ctx, mode), command: `pnpm wp2emdash ${goliveCommand(ctx.slug, mode).join(" ")}` };
	const r = await deps.runCli([...goliveCommand(ctx.slug, mode), "--json"], { sitesDir: ctx.sitesDir, timeoutMs: 120_000 });
	try {
		const j = JSON.parse(r.stdout) as GoliveResult;
		return { ...base, ok: j.blockers.length === 0, plan: j.plan ?? [], blockers: j.blockers ?? [], checks: j.checks ?? [] };
	} catch {
		const msg = (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ") || `exit ${r.code}`;
		return { ...base, ok: false, plan: [], blockers: [msg], checks: [], error: msg };
	}
}

// ── Apply ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Validates the confirmation, writes the approval to decisions.md and starts `wp2emdash golive … --yes` as a
 * single-flight action. Returns the run id (progress streams from runs/<runId>.jsonl).
 */
export function startGolive(ctx: SiteContext, mode: GoliveMode, body: Record<string, unknown>, deps: ActionDeps, locks: SiteLocks): { runId: string; done: Promise<boolean> } {
	const ok = requireConfirmation(body, { domain: ctx.domain, approval: true });
	const held = locks.get(ctx.slug);
	if (held) throw new BusyError(held);
	const approval = ok.approval as string;
	return startAction(locks, ctx.slug, MODE_ACTION[mode], ctx.sitesDir, deps, async (run: ActionRun) => {
		appendDecision(ctx.paths, "cutover", `${MODE_LABEL[mode]} approved: ${ctx.domain} (dashboard, run ${run.runId})`, approval, ok.by, deps.now());
		run.log("info", `${MODE_LABEL[mode]} for ${ctx.domain} — owner approval recorded in decisions.md (by ${ok.by}).`);
		run.log("info", `$ wp2emdash ${goliveCommand(ctx.slug, mode, true).join(" ")}`);
		const r = await deps.runCli([...goliveCommand(ctx.slug, mode, true), `--approved-by=${ok.by}`, `--approval=${approval}`, "--via=dashboard"], {
			sitesDir: ctx.sitesDir,
			onLine: (line, stream) => run.log(stream === "stderr" || line.startsWith("✖") ? "error" : "info", line),
		});
		// golive exit codes: 0 applied and green · 2 applied, a check failed · 1 refused / error.
		run.step(MODE_LABEL[mode], r.code === 0, r.code === 0 ? "applied, every check green" : r.code === 2 ? "applied, a check failed (see the log)" : "nothing applied (refused or error)");
		return r.code === 0;
	});
}

/** The env the scrubber uses (exported for the server). */
export const envFor = (deps: ActionDeps, ctx: SiteContext) => mergedEnv(deps, ctx.paths.root);
