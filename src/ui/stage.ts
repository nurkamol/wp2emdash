/**
 * Where a site really is, for the portfolio: recorded gates (state.json) are the source of truth for the pipeline,
 * but a site that has only had preview runs (`--preview`: gate shown, not recorded) or one that is already live shows
 * the wrong "next" step when only state.json is read. This module combines
 * - the recorded gate of every phase,
 * - the latest finished run of every phase (preview runs included) from runs/*.jsonl,
 * - cloudflare.json → production.live / liveSince, and the alias status (golive.json, cutover/aliases-check.json),
 * into one next step. Gates are never changed here.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SITES_DIR, sitePaths } from "../core/paths.js";
import { PHASE_IDS, type PhaseId } from "../core/phases.js";
import type { GateStatus } from "../core/state.js";
import { listRuns, parseRunLog, type RunSummary, summarizeRun } from "./data.js";

export type EffectiveStatus = GateStatus | "preview-passed" | "preview-failed" | "not-recorded";

export interface LatestRun {
	runId: string;
	ok: boolean;
	preview: boolean;
	at?: string;
}

export interface AliasStatus {
	domains: string[];
	status: "none" | "waiting" | "not-switched" | "switched" | "redirecting" | "failing";
	checkedAt?: string;
	detail?: string;
}

export interface NextStep {
	/** A pipeline phase, "golive", "aliases", "monitor", or null when nothing is left. */
	id: PhaseId | "golive" | "aliases" | "monitor" | null;
	label: string;
	command?: string;
	/** Where it was derived from. */
	source: "gates" | "runs" | "live";
	note?: string;
}

export interface SiteStage {
	live: boolean;
	liveSince?: string;
	monitorEndsOn?: string;
	aliases: AliasStatus;
	phases: { id: PhaseId; recorded: GateStatus; effective: EffectiveStatus; latestRun?: LatestRun }[];
	next: NextStep;
}

const DONE: EffectiveStatus[] = ["passed", "accepted", "preview-passed"];

export interface StageInput {
	slug: string;
	recorded: Partial<Record<PhaseId, GateStatus>>;
	latest: Partial<Record<PhaseId, LatestRun>>;
	live: boolean;
	liveSince?: string;
	monitorDays: number;
	aliasDomains: string[];
	/** Alias redirect rules recorded by golive, or rules found in cutover/ (a switch made by hand). */
	aliasRules: number;
	aliasCheck?: { ranAt?: string; ok: boolean; failures: number };
	now: Date;
}

const addDays = (iso: string, days: number) => {
	const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
	d.setUTCDate(d.getUTCDate() + days);
	return d.toISOString().slice(0, 10);
};

/** Pure derivation (tested directly). */
export function deriveStage(i: StageInput): SiteStage {
	const cmd = (s: string) => `pnpm wp2emdash ${s}`;
	const phases = PHASE_IDS.map((id): SiteStage["phases"][number] => {
		const recorded = i.recorded[id] ?? "pending";
		const latestRun = i.latest[id];
		let effective: EffectiveStatus = recorded;
		if (recorded !== "passed" && recorded !== "accepted" && latestRun) {
			// A newer preview (or unrecorded) run tells where the site really is; a recorded gate still wins when it passed.
			effective = latestRun.ok ? "preview-passed" : recorded === "failed" ? "failed" : "preview-failed";
		}
		return { id, recorded, effective, ...(latestRun ? { latestRun } : {}) };
	});
	// Phases before the furthest one that is done (recorded or by a passing run) but without evidence of their own:
	// the site has moved past them (e.g. state.json recreated, or the gate run with --preview only).
	// The furthest phase with any evidence (a run, or a recorded gate that is not pending) also moves the site on:
	// earlier phases with no evidence at all are "not recorded", not the next step.
	let furthest = -1;
	let evidence = -1;
	phases.forEach((p, k) => {
		if (DONE.includes(p.effective)) furthest = k;
		if (p.effective !== "pending") evidence = k;
	});
	for (let k = 0; k < Math.max(furthest, evidence); k++) {
		const p = phases[k] as (typeof phases)[number];
		if (k < furthest ? !DONE.includes(p.effective) : p.effective === "pending") p.effective = "not-recorded";
	}

	const aliases = aliasStatus(i);
	const monitorEndsOn = i.live && i.liveSince ? addDays(i.liveSince, i.monitorDays) : undefined;
	const base = { live: i.live, ...(i.liveSince ? { liveSince: i.liveSince } : {}), ...(monitorEndsOn ? { monitorEndsOn } : {}), aliases, phases };

	if (i.live) {
		if (aliases.domains.length && aliases.status !== "redirecting")
			return { ...base, next: { id: "aliases", label: aliases.status === "failing" ? "Fix the alias redirects" : "Alias redirects (owner approval)", command: aliases.status === "failing" ? cmd(`check-aliases ${i.slug}`) : cmd(`golive ${i.slug} --aliases`), source: "live" } };
		const today = i.now.toISOString().slice(0, 10);
		if (monitorEndsOn && monitorEndsOn > today) return { ...base, next: { id: "monitor", label: `Monitoring until ${monitorEndsOn}`, source: "live", note: "Then revoke the go-live token and decide on the WordPress hosting." } };
		return { ...base, next: { id: null, label: "Live — monitoring window over", source: "live", note: "Revoke the go-live token if it is still in .env." } };
	}

	const recordedNext = phases.find((p) => p.recorded !== "passed" && p.recorded !== "accepted")?.id;
	const next = phases.find((p, k) => k > furthest && !DONE.includes(p.effective) && p.effective !== "not-recorded");
	if (!next) {
		const unrecorded = phases.filter((p) => p.effective !== "passed" && p.effective !== "accepted").map((p) => p.id);
		return {
			...base,
			next: {
				id: "golive",
				label: "Go live (owner approval)",
				command: cmd(`golive ${i.slug}`),
				source: unrecorded.length ? "runs" : "gates",
				...(unrecorded.length ? { note: `Gates not recorded for ${unrecorded.join(", ")} (preview runs only): golive needs a recorded or accepted cutover gate.` } : {}),
			},
		};
	}
	const fromRuns = next.id !== recordedNext;
	return {
		...base,
		next: {
			id: next.id,
			label: `${next.id}${next.effective === "failed" || next.effective === "preview-failed" ? " (failing)" : ""}`,
			command: cmd(`run ${i.slug} ${next.id}`),
			source: fromRuns ? "runs" : "gates",
			...(fromRuns && recordedNext ? { note: `Recorded gates stop at ${recordedNext}: the later phases ran as previews (gate not recorded). Rerun them without --preview to record.` } : {}),
		},
	};
}

function aliasStatus(i: StageInput): AliasStatus {
	const domains = i.aliasDomains;
	if (!domains.length) return { domains, status: "none" };
	if (!i.live) return { domains, status: "waiting", detail: "after the primary is live" };
	if (i.aliasCheck) return { domains, status: i.aliasCheck.ok ? "redirecting" : "failing", ...(i.aliasCheck.ranAt ? { checkedAt: i.aliasCheck.ranAt } : {}), ...(i.aliasCheck.ok ? {} : { detail: `${i.aliasCheck.failures} failing` }) };
	if (i.aliasRules) return { domains, status: "switched", detail: "not checked yet: pnpm wp2emdash check-aliases" };
	return { domains, status: "not-switched" };
}

// ── Readers ──────────────────────────────────────────────────────────────────────────────────────────────────

const summaryCache = new Map<string, { size: number; mtimeMs: number; summary: RunSummary }>();

/** Latest finished run of every pipeline phase (preview runs included), newest first, cached by file size + mtime. */
export function latestRunsByPhase(slug: string, sitesDir = SITES_DIR): Partial<Record<PhaseId, LatestRun>> {
	const dir = sitePaths(slug, sitesDir).runs;
	const out: Partial<Record<PhaseId, LatestRun>> = {};
	for (const runId of listRuns(slug, sitesDir)) {
		if (PHASE_IDS.every((p) => out[p])) break;
		const file = join(dir, `${runId}.jsonl`);
		let st: ReturnType<typeof statSync>;
		try {
			st = statSync(file);
		} catch {
			continue;
		}
		let c = summaryCache.get(file);
		if (!c || c.size !== st.size || c.mtimeMs !== st.mtimeMs) {
			c = { size: st.size, mtimeMs: st.mtimeMs, summary: summarizeRun(runId, parseRunLog(readFileSync(file, "utf8"))) };
			summaryCache.set(file, c);
		}
		const s = c.summary;
		const phase = s.phase as PhaseId | undefined;
		if (!phase || !(PHASE_IDS as string[]).includes(phase) || !s.finished || out[phase]) continue;
		out[phase] = { runId, ok: s.ok === true, preview: s.preview, ...(s.lastEventAt ? { at: s.lastEventAt } : {}) };
	}
	return out;
}

const readJson = <T>(file: string): T | undefined => {
	try {
		return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined;
	} catch {
		return undefined;
	}
};

/** Live state and alias evidence from the site folder (cloudflare.json, cutover/golive.json, cutover/aliases-check.json). */
export function liveEvidence(root: string): { live: boolean; liveSince?: string; aliasRules: number; aliasCheck?: StageInput["aliasCheck"] } {
	const cf = readJson<{ production?: { live?: boolean; liveSince?: string } }>(join(root, "cloudflare.json"));
	const rec = readJson<{ aliasRules?: unknown[]; liveSince?: string }>(join(root, "cutover", "golive.json"));
	const ac = readJson<{ ranAt?: string; ok?: boolean; failures?: unknown[] }>(join(root, "cutover", "aliases-check.json"));
	let manualRules = 0;
	try {
		// A switch made by hand (runbook) leaves cutover/alias-rule.<alias>.json instead of golive.json entries.
		manualRules = readdirSync(join(root, "cutover")).filter((f) => /^alias-rule\..+\.json$/.test(f)).length;
	} catch {
		manualRules = 0;
	}
	const liveSince = cf?.production?.liveSince ?? rec?.liveSince;
	return {
		live: !!cf?.production?.live,
		...(liveSince ? { liveSince } : {}),
		aliasRules: (rec?.aliasRules?.length ?? 0) + manualRules,
		...(ac ? { aliasCheck: { ...(ac.ranAt ? { ranAt: ac.ranAt } : {}), ok: !!ac.ok, failures: Array.isArray(ac.failures) ? ac.failures.length : 0 } } : {}),
	};
}
