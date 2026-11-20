/**
 * Launch cockpit (docs/PLAN.md §10b feature 4) and the guided owner checklist (feature 10), both read-only.
 *
 * The cockpit shows the last cutover preflight, the generated runbook (as text), the go-live prerequisites and the
 * exact commands. The owner-approved actions (go-live, alias redirects, rollback) are in src/ui/launch.ts; this view
 * stays read-only.
 * The checklist renders ACCESS.md as sections with items; ticking stays in the file.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SITES_DIR, sitePaths } from "../core/paths.js";
import { type GateCheck, phaseState, readState } from "../core/state.js";
import { loadEnv } from "../extract/credentials.js";
import { parseRunLog, runFile, runHistory } from "./data.js";

const RUNBOOK_MAX = 200_000;

export interface CockpitCheck {
	id: string;
	label: string;
	ok: boolean;
	detail?: string;
}

export interface CockpitView {
	preflight: { source: "state" | "run-log" | "none"; runId?: string; ranAt?: string; ok?: boolean; preview?: boolean; checks: CockpitCheck[]; note?: string };
	runbook?: { path: string; text: string; modifiedAt: string; truncated: boolean };
	prerequisites: CockpitCheck[];
	commands: { label: string; command: string }[];
	note: string;
}

const readJson = <T>(file: string): T | undefined => {
	try {
		return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined;
	} catch {
		return undefined;
	}
};

export function cockpitView(slug: string, sitesDir = SITES_DIR): CockpitView {
	const paths = sitePaths(slug, sitesDir);
	let state: ReturnType<typeof readState> | undefined;
	try {
		state = readState(paths.state);
	} catch {
		state = undefined;
	}

	// ── Last preflight ──
	let preflight: CockpitView["preflight"] = { source: "none", checks: [], note: "No cutover preflight has run yet." };
	const cut = state ? phaseState(state, "cutover") : undefined;
	if (cut?.checks.length) {
		preflight = { source: "state", ...(cut.runId ? { runId: cut.runId } : {}), ...(cut.finishedAt ? { ranAt: cut.finishedAt } : {}), ok: cut.checks.every((c) => c.ok), checks: cut.checks.map((c: GateCheck) => ({ id: c.id, label: c.label, ok: c.ok, ...(c.detail ? { detail: c.detail } : {}) })) };
	} else {
		const last = runHistory(slug, sitesDir, 200).find((r) => r.phase === "cutover" && r.finished);
		if (last) {
			const fails = last.errors.filter((m) => m.startsWith("✖ "));
			const file = runFile(slug, last.runId, sitesDir);
			const steps = file ? parseRunLog(readFileSync(file, "utf8")).filter((e) => e.type === "step:end") : [];
			preflight = {
				source: "run-log",
				runId: last.runId,
				...(last.startedAt ? { ranAt: last.startedAt } : {}),
				...(last.ok !== undefined ? { ok: last.ok } : {}),
				preview: last.preview,
				checks: fails.map((m, i) => {
					const [label, ...rest] = m.slice(2).split(" — ");
					return { id: `fail-${i}`, label: label ?? m, ok: false, ...(rest.length ? { detail: rest.join(" — ") } : {}) };
				}),
				note: `From the run log${last.preview ? " of a preview run (gate not recorded)" : ""}: only failing checks are logged.${steps.length ? ` Steps: ${steps.map((s) => `${String(s.step)} ${s.ok ? "ok" : "failed"}`).join(", ")}.` : ""}`,
			};
		}
	}

	// ── Runbook ──
	const rb = join(paths.root, "cutover", "runbook.md");
	let runbook: CockpitView["runbook"];
	if (existsSync(rb) && statSync(rb).isFile()) {
		const text = readFileSync(rb, "utf8");
		runbook = { path: `sites/${slug}/cutover/runbook.md`, text: text.slice(0, RUNBOOK_MAX), modifiedAt: statSync(rb).mtime.toISOString(), truncated: text.length > RUNBOOK_MAX };
	}

	// ── Prerequisites (presence only; never values) ──
	const env = loadEnv(join(paths.root, ".env"));
	const verify = state ? phaseState(state, "verify").status : "pending";
	const cf = readJson<{ production?: { d1?: { id?: string }; r2?: { bucket?: string }; worker?: { name?: string; url?: string } } }>(join(paths.root, "cloudflare.json"));
	const access = existsSync(paths.access) ? parseAccess(readFileSync(paths.access, "utf8")) : [];
	const beforeCutover = access.find((s) => /before cutover/i.test(s.heading));
	const open = beforeCutover?.items.filter((i) => !i.done) ?? [];
	const prerequisites: CockpitCheck[] = [
		{ id: "verify", label: "Verify gate passed or accepted by the owner", ok: verify === "passed" || verify === "accepted", detail: `verify: ${verify}` },
		{ id: "preflight", label: "Latest cutover preflight passed", ok: preflight.ok === true, detail: preflight.source === "none" ? "not run yet" : `from ${preflight.source === "state" ? "state.json" : `run ${preflight.runId}`}` },
		{ id: "production", label: "Production D1, R2 and Worker recorded in cloudflare.json", ok: !!(cf?.production?.d1?.id && cf.production.r2?.bucket), detail: cf?.production?.worker?.url ?? (cf ? "production resources missing" : "no cloudflare.json") },
		{ id: "golive-token", label: "Go-live token set in the site .env (CLOUDFLARE_GOLIVE_TOKEN)", ok: !!env.CLOUDFLARE_GOLIVE_TOKEN, detail: env.CLOUDFLARE_GOLIVE_TOKEN ? "set (value never shown)" : "not set — Secrets tab" },
		{ id: "runbook", label: "Runbook generated (cutover/runbook.md)", ok: !!runbook, ...(runbook ? { detail: runbook.modifiedAt } : { detail: "run the cutover preflight" }) },
		{ id: "access", label: "ACCESS.md “Before cutover” items ticked", ok: !!beforeCutover && open.length === 0, detail: !beforeCutover ? "section not found in ACCESS.md" : open.length ? `${open.length} open: ${open.map((i) => i.text).slice(0, 3).join("; ")}` : "all ticked" },
	];

	const commands = [
		{ label: "Run the preflight (read-only, gate not recorded)", command: `pnpm wp2emdash run ${slug} cutover --preview` },
		{ label: "Run the preflight and record the cutover gate", command: `pnpm wp2emdash run ${slug} cutover` },
		{ label: "Go-live plan (changes nothing)", command: `pnpm wp2emdash golive ${slug}` },
		{ label: "Go live, after the owner's written approval", command: `pnpm wp2emdash golive ${slug} --yes --approved-by="<you>" --approval="<owner, date, where>"` },
		{ label: "Roll back the switch (deletes exactly the recorded routes)", command: `pnpm wp2emdash golive ${slug} --rollback --yes` },
		{ label: "Deploy production to workers.dev (in the site project)", command: "pnpm deploy:production" },
		{ label: "Verify production after the switch (preview)", command: `WP2EMDASH_TARGET=production pnpm wp2emdash run ${slug} verify --preview` },
		{ label: "Open the runbook (switch and rollback commands)", command: `cat sites/${slug}/cutover/runbook.md` },
	];

	return {
		preflight,
		...(runbook ? { runbook } : {}),
		prerequisites,
		commands,
		note: "Go-live, alias redirects and rollback run below only after you type the production domain and record the owner's written approval (or in the terminal: wp2emdash golive). They run the same command as the terminal, with the go-live token. DNS is never changed.",
	};
}

// ── ACCESS.md checklist ─────────────────────────────────────────────────────────────────────────────────────

export interface AccessItem {
	text: string;
	done: boolean;
	required: boolean;
}
export interface AccessSection {
	heading: string;
	notes: string[];
	items: AccessItem[];
	/** The generated "Plugin data" section (rewritten by audit; ticks kept). */
	pluginData: boolean;
}

/** ACCESS.md as sections: headings (##), free-text notes and - [ ] / - [x] items with the (required) marker. */
export function parseAccess(markdown: string): AccessSection[] {
	const out: AccessSection[] = [];
	let cur: AccessSection = { heading: "", notes: [], items: [], pluginData: false };
	const push = () => {
		if (cur.heading || cur.notes.length || cur.items.length) out.push(cur);
	};
	for (const raw of markdown.split("\n")) {
		const line = raw.replace(/<!--[\s\S]*?-->/g, "").trimEnd();
		const h = /^#{1,3}\s+(.+?)\s*$/.exec(line);
		if (h?.[1]) {
			push();
			cur = { heading: h[1], notes: [], items: [], pluginData: /plugin data/i.test(h[1]) };
			continue;
		}
		const m = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
		if (m) {
			const text = m[2] as string;
			const required = /^\(required\)\s*/i.test(text);
			cur.items.push({ text: text.replace(/^\(required\)\s*/i, "").replace(/\*\*/g, "").trim(), done: m[1] !== " ", required });
			continue;
		}
		if (line.trim()) cur.notes.push(line.trim().replace(/\*\*/g, ""));
	}
	push();
	return out;
}

export function checklistView(slug: string, sitesDir = SITES_DIR) {
	const file = sitePaths(slug, sitesDir).access;
	if (!existsSync(file)) return { available: false, file: `sites/${slug}/ACCESS.md`, sections: [] as AccessSection[], counts: { done: 0, total: 0, requiredOpen: 0 } };
	const sections = parseAccess(readFileSync(file, "utf8").slice(0, 200_000));
	const items = sections.flatMap((s) => s.items);
	return {
		available: true,
		file: `sites/${slug}/ACCESS.md`,
		sections,
		counts: { done: items.filter((i) => i.done).length, total: items.length, requiredOpen: items.filter((i) => i.required && !i.done).length },
	};
}
