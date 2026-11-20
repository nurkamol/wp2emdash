/**
 * Read models for the local dashboard (`wp2emdash ui`, docs/PLAN.md §10b). Everything here reads the same
 * files the CLI writes (state.json, runs/*.jsonl, reports/verify/verify.json, decisions.md); the only write
 * is appending a visual decision to decisions.md. Gates are never changed here: accepting a failed gate stays
 * `wp2emdash accept` with the owner's reason.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/load.js";
import { listSites } from "../commands/status.js";
import { SITES_DIR, sitePaths } from "../core/paths.js";
import { PHASE_IDS, PHASES, type PhaseId } from "../core/phases.js";
import { listProposals } from "../core/proposals.js";
import { type GateCheck, nextPhase, phaseState, readState, type SiteState } from "../core/state.js";
import type { VerifyResult } from "../phases/verify.js";
import { deriveStage, latestRunsByPhase, liveEvidence, type SiteStage } from "./stage.js";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const RUN_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;
const DEFAULT_VISUAL_LIMIT = 0.03;

export function isSiteSlug(slug: string, sitesDir = SITES_DIR): boolean {
	return SLUG_RE.test(slug) && listSites(sitesDir).includes(slug);
}

export function isRunId(id: string): boolean {
	return RUN_RE.test(id);
}

const readJson = <T>(file: string): T | undefined => {
	try {
		return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined;
	} catch {
		return undefined;
	}
};

// ── Site config (name, visual limit), loaded once per server ─────────────────────────────────────────────
export interface SiteMeta {
	name: string;
	visualLimit: number;
	sourceUrl?: string;
	monitorDays: number;
	aliasDomains: string[];
	domain?: string;
}
const metaCache = new Map<string, Promise<SiteMeta>>();

export function siteMeta(slug: string, sitesDir = SITES_DIR): Promise<SiteMeta> {
	const key = `${sitesDir}\0${slug}`;
	let p = metaCache.get(key);
	if (!p) {
		p = loadConfig(sitePaths(slug, sitesDir).config)
			.then((c) => ({ name: c.name, visualLimit: c.gates.visualDiff, sourceUrl: c.source.url, monitorDays: c.target.cutover.monitorDays, aliasDomains: c.target.aliasDomains, domain: new URL(c.target.productionUrl).hostname.replace(/^www\./, "") }))
			.catch(() => ({ name: slug, visualLimit: DEFAULT_VISUAL_LIMIT, monitorDays: 14, aliasDomains: [] }));
		metaCache.set(key, p);
	}
	return p;
}

// ── Runs ─────────────────────────────────────────────────────────────────────────────────────────────────
export interface RunEvent {
	at?: string;
	type: string;
	[k: string]: unknown;
}

export interface RunSummary {
	runId: string;
	phase?: string;
	startedAt?: string;
	lastEventAt?: string;
	/** true/false once phase:end was logged; undefined while running (or if the run was interrupted). */
	ok?: boolean;
	finished: boolean;
	preview: boolean;
	errors: string[];
}

export function parseRunLog(text: string): RunEvent[] {
	const out: RunEvent[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const e = JSON.parse(line) as RunEvent;
			if (e && typeof e.type === "string") out.push(e);
		} catch {
			// a half-written last line: skipped until it is complete
		}
	}
	return out;
}

export function summarizeRun(runId: string, events: RunEvent[]): RunSummary {
	const start = events.find((e) => e.type === "phase:start");
	const end = [...events].reverse().find((e) => e.type === "phase:end");
	return {
		runId,
		phase: typeof start?.phase === "string" ? start.phase : undefined,
		startedAt: start?.at,
		lastEventAt: events.at(-1)?.at,
		ok: end ? end.ok === true : undefined,
		finished: !!end,
		preview: events.some((e) => e.type === "log" && typeof e.message === "string" && e.message.startsWith("Preview run")),
		errors: events.filter((e) => e.type === "log" && e.level === "error" && typeof e.message === "string").map((e) => String(e.message)),
	};
}

export function listRuns(slug: string, sitesDir = SITES_DIR): string[] {
	const dir = sitePaths(slug, sitesDir).runs;
	try {
		return readdirSync(dir)
			.filter((f) => f.endsWith(".jsonl") && isRunId(f.slice(0, -6)))
			.map((f) => f.slice(0, -6))
			.sort()
			.reverse();
	} catch {
		return [];
	}
}

export function runFile(slug: string, runId: string, sitesDir = SITES_DIR): string | undefined {
	if (!isRunId(runId)) return undefined;
	const file = join(sitePaths(slug, sitesDir).runs, `${runId}.jsonl`);
	return existsSync(file) && statSync(file).isFile() ? file : undefined;
}

export function readRun(slug: string, runId: string, sitesDir = SITES_DIR): RunSummary | undefined {
	const file = runFile(slug, runId, sitesDir);
	return file ? summarizeRun(runId, parseRunLog(readFileSync(file, "utf8"))) : undefined;
}

export function runHistory(slug: string, sitesDir = SITES_DIR, limit = 30): RunSummary[] {
	return listRuns(slug, sitesDir)
		.slice(0, limit)
		.map((id) => readRun(slug, id, sitesDir))
		.filter((r): r is RunSummary => !!r);
}

// ── Launch readiness ─────────────────────────────────────────────────────────────────────────────────────
export interface ReadinessItem {
	id: string;
	group: "gate" | "verify" | "preflight";
	label: string;
	ok: boolean;
	/** Counted as passing because the owner accepted the gate with a recorded reason. */
	accepted?: boolean;
	detail?: string;
	/** What to do about it: a command to run, or a dashboard link (starts with #). */
	fix?: string;
}

export interface Readiness {
	score: number;
	passed: number;
	total: number;
	items: ReadinessItem[];
	blockers: ReadinessItem[];
	sources: { verifyRanAt?: string; verifyTarget?: string; preflight: "state" | "run-log" | "none"; preflightRunId?: string };
}

/** Phases whose gates must be green before launch; the cutover gate is the launch itself. */
const PRE_LAUNCH: PhaseId[] = PHASE_IDS.filter((p) => p !== "cutover");

/**
 * One score per site: the share of launch checks that pass, 0–100. The checks are
 *  1. every gate before cutover (init → verify) passed or accepted;
 *  2. every check in the latest verify report (reports/verify/verify.json);
 *  3. every cutover preflight check (from state.json, or the failures logged by the latest preview run).
 * Accepted gates count as passing: the owner decided with a reason. Every failing item is a blocker.
 */
export function readiness(slug: string, sitesDir = SITES_DIR): Readiness {
	const paths = sitePaths(slug, sitesDir);
	const state = readState(paths.state);
	const items: ReadinessItem[] = [];
	const cmd = (s: string) => `pnpm wp2emdash ${s}`;

	for (const id of PRE_LAUNCH) {
		const s = phaseState(state, id);
		const title = PHASES.find((p) => p.id === id)?.title ?? id;
		const ok = s.status === "passed" || s.status === "accepted";
		const failing = s.checks.filter((c) => !c.ok).length;
		items.push({
			id: `gate:${id}`,
			group: "gate",
			label: `${id} gate — ${title}`,
			ok,
			...(s.status === "accepted" ? { accepted: true, detail: `accepted: ${s.acceptedReason ?? ""}` } : {}),
			...(!ok ? { detail: s.status === "failed" ? `${failing} check(s) failing` : s.status, fix: cmd(`run ${slug} ${id}`) } : {}),
		});
	}

	const verify = readJson<VerifyResult & { checks?: GateCheck[] }>(join(paths.reports, "verify", "verify.json"));
	const verifyAccepted = phaseState(state, "verify").status === "accepted";
	const verifyChecks = verify?.checks ?? phaseState(state, "verify").checks;
	if (!verifyChecks.length) {
		items.push({ id: "verify:missing", group: "verify", label: "Verify report", ok: false, detail: "no verify report yet", fix: cmd(`run ${slug} verify`) });
	}
	for (const c of verifyChecks) {
		const accepted = !c.ok && verifyAccepted;
		items.push({
			id: `verify:${c.id}`,
			group: "verify",
			label: c.label,
			ok: c.ok || accepted,
			...(accepted ? { accepted: true } : {}),
			...(c.detail ? { detail: c.detail } : {}),
			...(!c.ok && !accepted ? { fix: c.id === "visual" ? `#/site/${slug}/visual` : cmd(`run ${slug} verify`) } : {}),
		});
	}

	// Cutover preflight: recorded checks if the gate ran for real, otherwise the latest (preview) run's failures.
	let preflight: Readiness["sources"]["preflight"] = "none";
	let preflightRunId: string | undefined;
	const cut = phaseState(state, "cutover");
	if (cut.checks.length) {
		preflight = "state";
		preflightRunId = cut.runId;
		for (const c of cut.checks) {
			items.push({ id: `preflight:${c.id}`, group: "preflight", label: c.label, ok: c.ok, ...(c.detail ? { detail: c.detail } : {}), ...(!c.ok ? { fix: cmd(`run ${slug} cutover --preview`) } : {}) });
		}
	} else {
		const last = runHistory(slug, sitesDir, 200).find((r) => r.phase === "cutover" && r.finished);
		if (last) {
			preflight = "run-log";
			preflightRunId = last.runId;
			const fails = last.errors.filter((m) => m.startsWith("✖ "));
			fails.forEach((m, i) => {
				const [label, ...rest] = m.slice(2).split(" — ");
				items.push({ id: `preflight:${i}`, group: "preflight", label: label ?? m, ok: false, ...(rest.length ? { detail: rest.join(" — ") } : {}), fix: cmd(`run ${slug} cutover --preview`) });
			});
			if (!fails.length) items.push({ id: "preflight:run", group: "preflight", label: "Cutover preflight", ok: last.ok === true, detail: last.ok ? "latest preflight passed" : "latest preflight failed (see run log)" });
		} else {
			items.push({ id: "preflight:missing", group: "preflight", label: "Cutover preflight", ok: false, detail: "not run yet", fix: cmd(`run ${slug} cutover --preview`) });
		}
	}

	const passed = items.filter((i) => i.ok).length;
	const total = items.length;
	return {
		score: total ? Math.round((100 * passed) / total) : 0,
		passed,
		total,
		items,
		blockers: items.filter((i) => !i.ok),
		sources: { ...(verify ? { verifyRanAt: verify.ranAt, verifyTarget: verify.target } : {}), preflight, ...(preflightRunId ? { preflightRunId } : {}) },
	};
}

// ── Portfolio ────────────────────────────────────────────────────────────────────────────────────────────
export interface SiteSummary {
	slug: string;
	name: string;
	phases: { id: PhaseId; title: string; status: string; failing: number; acceptedReason?: string; finishedAt?: string }[];
	next: PhaseId | null;
	current?: { id: PhaseId; status: string };
	readiness: Pick<Readiness, "score" | "passed" | "total"> & { blockers: ReadinessItem[] };
	lastRun?: RunSummary;
	/** Proposals waiting in the approval queue. */
	pendingProposals: number;
	/** Where the site really is: recorded gates + latest runs (previews included) + live state (src/ui/stage.ts). */
	stage?: SiteStage;
	domain?: string;
	error?: string;
}

function phaseList(state: SiteState): SiteSummary["phases"] {
	return PHASES.map((p) => {
		const s = phaseState(state, p.id);
		return {
			id: p.id,
			title: p.title,
			status: s.status,
			failing: s.checks.filter((c) => !c.ok).length,
			...(s.acceptedReason ? { acceptedReason: s.acceptedReason } : {}),
			...(s.finishedAt ? { finishedAt: s.finishedAt } : {}),
		};
	});
}

export async function siteSummary(slug: string, sitesDir = SITES_DIR): Promise<SiteSummary> {
	const meta = await siteMeta(slug, sitesDir);
	const lastId = listRuns(slug, sitesDir)[0];
	const lastRun = lastId ? readRun(slug, lastId, sitesDir) : undefined;
	let pendingProposals = 0;
	try {
		pendingProposals = listProposals(slug, { sitesDir, status: "pending" }).length;
	} catch {
		// an unreadable queue shows as empty
	}
	try {
		const state = readState(sitePaths(slug, sitesDir).state);
		const next = nextPhase(state) ?? null;
		const r = readiness(slug, sitesDir);
		const curId = next ?? "cutover";
		const ev = liveEvidence(sitePaths(slug, sitesDir).root);
		const stage = deriveStage({
			slug,
			recorded: Object.fromEntries(PHASE_IDS.map((id) => [id, phaseState(state, id).status])),
			latest: latestRunsByPhase(slug, sitesDir),
			live: ev.live,
			...(ev.liveSince ? { liveSince: ev.liveSince } : {}),
			monitorDays: meta.monitorDays,
			aliasDomains: meta.aliasDomains,
			aliasRules: ev.aliasRules,
			...(ev.aliasCheck ? { aliasCheck: ev.aliasCheck } : {}),
			now: new Date(),
		});
		return {
			slug,
			name: meta.name,
			stage,
			...(meta.domain ? { domain: meta.domain } : {}),
			phases: phaseList(state),
			next,
			current: { id: curId, status: phaseState(state, curId).status },
			readiness: { score: r.score, passed: r.passed, total: r.total, blockers: r.blockers },
			...(lastRun ? { lastRun } : {}),
			pendingProposals,
		};
	} catch (e) {
		return {
			slug,
			name: meta.name,
			phases: [],
			next: null,
			readiness: { score: 0, passed: 0, total: 0, blockers: [] },
			...(lastRun ? { lastRun } : {}),
			pendingProposals,
			error: `state.json unreadable: ${(e as Error).message.split("\n")[0]}`,
		};
	}
}

export async function portfolio(sitesDir = SITES_DIR): Promise<SiteSummary[]> {
	return Promise.all(listSites(sitesDir).map((s) => siteSummary(s, sitesDir)));
}

// ── Visual diff viewer ───────────────────────────────────────────────────────────────────────────────────
/** Files the dashboard may serve, relative to the site root. Everything else is refused. */
export const SERVABLE_ROOTS = ["reports", join("snapshot", "screens")];

export const fileUrl = (slug: string, rel: string) => `/files/${encodeURIComponent(slug)}/${rel.split(/[\\/]/).map(encodeURIComponent).join("/")}`;

/** URL of a file under the site root, or undefined when it does not exist. */
export const siteFileUrl = (slug: string, root: string, rel: string): string | undefined => (existsSync(join(root, rel)) ? fileUrl(slug, rel) : undefined);

/** verify.json stores absolute paths from the machine that ran it; keep the part from reports/verify/ on. */
export function verifyFileUrl(slug: string, root: string, abs: string | undefined): string | undefined {
	if (!abs) return undefined;
	const norm = abs.replace(/\\/g, "/");
	const i = norm.lastIndexOf("/reports/verify/");
	return i < 0 ? undefined : siteFileUrl(slug, root, norm.slice(i + 1));
}

export interface VisualDecision {
	date: string;
	decision: "approved" | "rejected";
	path: string;
	viewport: string;
	reason: string;
	by: string;
}

export interface VisualViewport {
	viewport: string;
	ratio: number;
	over: boolean;
	comparedHeight: number;
	sourceHeight: number;
	targetHeight: number;
	error?: string;
	images: { source?: string; target?: string; diff?: string };
	sections: { label: string; types: string[]; ratio: number; over: boolean; note?: string; still?: boolean; sourceHeight: number; targetHeight: number; images?: { source?: string; target?: string; diff?: string } }[];
	decision?: VisualDecision;
}

export interface VisualPage {
	path: string;
	name: string;
	sourceUrl: string;
	targetUrl: string;
	viewports: VisualViewport[];
}

export interface VisualReport {
	available: boolean;
	target?: string;
	targetUrl?: string;
	ranAt?: string;
	visualLimit: number;
	checks: GateCheck[];
	pages: VisualPage[];
	interactions: string[];
	verifyGate: { status: string; acceptCommand?: string };
}

export async function visualReport(slug: string, sitesDir = SITES_DIR): Promise<VisualReport> {
	const paths = sitePaths(slug, sitesDir);
	const meta = await siteMeta(slug, sitesDir);
	const limit = meta.visualLimit;
	const gate = phaseState(readState(paths.state), "verify").status;
	const verifyGate = {
		status: gate,
		...(gate === "failed" ? { acceptCommand: `pnpm wp2emdash accept ${slug} verify --reason "<the owner's reason>" --by "<owner name>"` } : {}),
	};
	const v = readJson<VerifyResult & { checks?: GateCheck[] }>(join(paths.reports, "verify", "verify.json"));
	if (!v) return { available: false, visualLimit: limit, checks: [], pages: [], interactions: [], verifyGate };

	const decisions = visualDecisions(slug, sitesDir);
	const latest = (path: string, vp: string) => [...decisions].reverse().find((d) => d.path === path && d.viewport === vp);
	const url = (rel: string) => siteFileUrl(slug, paths.root, rel);
	const fromAbs = (abs: string | undefined) => verifyFileUrl(slug, paths.root, abs);

	const pages: VisualPage[] = (v.pages ?? []).map((p) => ({
		path: p.path,
		name: p.name,
		sourceUrl: p.sourceUrl,
		targetUrl: p.targetUrl,
		viewports: Object.entries(p.visual ?? {}).map(([vp, r]) => {
			const d = latest(p.path, vp);
			return {
				viewport: vp,
				ratio: r.ratio,
				over: r.ratio > limit,
				comparedHeight: r.comparedHeight,
				sourceHeight: r.sourceHeight,
				targetHeight: r.targetHeight,
				...(r.error ? { error: r.error } : {}),
				images: {
					source: url(join("snapshot", "screens", vp, `${p.name}.png`)),
					target: url(join("reports", "verify", "screens", vp, `${p.name}.png`)),
					diff: url(join("reports", "verify", "diff", vp, `${p.name}.png`)),
				},
				sections: (p.sections?.[vp] ?? []).map((s) => ({
					label: s.label,
					types: s.types,
					ratio: s.ratio,
					over: s.ratio > limit,
					sourceHeight: s.sourceHeight,
					targetHeight: s.targetHeight,
					...(s.note ? { note: s.note } : {}),
					...(s.still ? { still: true } : {}),
					...(s.files ? { images: { source: fromAbs(s.files.source), target: fromAbs(s.files.target), diff: fromAbs(s.files.diff) } } : {}),
				})),
				...(d ? { decision: d } : {}),
			};
		}),
	}));

	const interactions: string[] = [];
	const iDir = join(paths.reports, "verify", "interactions");
	if (existsSync(iDir)) {
		for (const vp of readdirSync(iDir)) {
			const dir = join(iDir, vp);
			if (!statSync(dir).isDirectory()) continue;
			for (const f of readdirSync(dir).sort()) {
				if (/\.(png|webm)$/i.test(f)) interactions.push(fileUrl(slug, join("reports", "verify", "interactions", vp, f)));
			}
		}
	}

	return { available: true, target: v.target, targetUrl: v.targetUrl, ranAt: v.ranAt, visualLimit: limit, checks: v.checks ?? [], pages, interactions, verifyGate };
}

// ── decisions.md ─────────────────────────────────────────────────────────────────────────────────────────
const DECISION_RE = /^\| (\d{4}-\d{2}-\d{2}) \| verify \| Visual difference (approved|rejected): (.+?) @ ([A-Za-z0-9_-]+)(?: \([^|]*\))? \| (.*?) \| (.*?) \|\s*$/;

export function visualDecisions(slug: string, sitesDir = SITES_DIR): VisualDecision[] {
	const file = sitePaths(slug, sitesDir).decisions;
	if (!existsSync(file)) return [];
	const out: VisualDecision[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		const m = DECISION_RE.exec(line);
		if (m) out.push({ date: m[1] as string, decision: m[2] as VisualDecision["decision"], path: m[3] as string, viewport: m[4] as string, reason: (m[5] as string).replace(/\\\|/g, "|"), by: (m[6] as string).replace(/\\\|/g, "|") });
	}
	return out;
}

export interface DecisionInput {
	path: string;
	viewport: string;
	decision: "approve" | "reject";
	reason: string;
	by: string;
}

/** One table cell: no pipes, no newlines, no control characters. */
export const cell = (s: string) =>
	s
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
		.replace(/[\u0000-\u001f\u007f]+/g, " ")
		.replace(/\|/g, "\\|")
		.trim();

/**
 * Appends a dated visual decision (approve/reject one page × viewport) to decisions.md, in the table format
 * `wp2emdash accept` uses. It does NOT change any gate: the verify gate stays failed until the owner runs
 * `wp2emdash accept <slug> verify --reason … --by …` (CLAUDE.md: never accept a gate on the owner's behalf).
 */
export async function appendVisualDecision(slug: string, input: DecisionInput, sitesDir = SITES_DIR, now = new Date()): Promise<VisualDecision> {
	if (input.decision !== "approve" && input.decision !== "reject") throw new UserError("decision must be approve or reject");
	const reason = cell(String(input.reason ?? ""));
	const by = cell(String(input.by ?? ""));
	if (reason.length < 10) throw new UserError("Give a real reason (at least 10 characters).");
	if (reason.length > 1000) throw new UserError("Reason is too long (max 1000 characters).");
	if (!by) throw new UserError("Say who decided (approved by).");
	if (by.length > 120) throw new UserError("Name is too long.");

	const report = await visualReport(slug, sitesDir);
	const page = report.pages.find((p) => p.path === input.path);
	const vp = page?.viewports.find((x) => x.viewport === input.viewport);
	if (!page || !vp) throw new UserError("Unknown page or viewport in the latest verify report.");

	const date = now.toISOString().slice(0, 10);
	const decided = input.decision === "approve" ? "approved" : "rejected";
	const file = sitePaths(slug, sitesDir).decisions;
	if (!existsSync(file)) {
		writeFileSync(file, "# Decisions\n\n| Date | Phase | Decision | Reason | Approved by |\n|---|---|---|---|---|\n");
	} else {
		const text = readFileSync(file, "utf8");
		if (text.length && !text.endsWith("\n")) appendFileSync(file, "\n");
	}
	const what = `Visual difference ${decided}: ${cell(page.path)} @ ${vp.viewport} (${(vp.ratio * 100).toFixed(1)}%, verify ${report.ranAt ? cell(report.ranAt) : "?"})`;
	appendFileSync(file, `| ${date} | verify | ${what} | ${reason} | ${by} |\n`);
	return { date, decision: decided, path: page.path, viewport: vp.viewport, reason, by };
}

export class UserError extends Error {}
