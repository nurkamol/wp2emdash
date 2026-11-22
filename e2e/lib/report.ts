/** The end-to-end report: report.md for people (the workflow's job summary), report.json for machines. */
import type { Assertion } from "./assertions.js";
import type { PhaseOutcome, Verdict } from "./pipeline.js";
import { IMAGES, ZIPS } from "./versions.js";

export interface ReportInput {
	verdict: Verdict;
	phases: PhaseOutcome[];
	assertions: Assertion[];
	startedAt: string;
	finishedAt: string;
	wpUrl: string;
	notes: string[];
	/** Relative paths inside the report folder worth opening first. */
	files: string[];
	env?: Record<string, string | undefined>;
}

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function reportMarkdown(r: ReportInput): string {
	const L: string[] = [];
	L.push(`# WordPress end-to-end: ${r.verdict.ok ? "PASSED" : "FAILED"}`, "");
	L.push(`Started ${r.startedAt}, finished ${r.finishedAt}. WordPress at ${r.wpUrl} (Docker, synthetic content: e2e/lib/plan.ts).`);
	if (r.env?.GITHUB_SHA) L.push(`Commit ${r.env.GITHUB_SHA}${r.env.GITHUB_RUN_ID ? `, run ${r.env.GITHUB_SERVER_URL ?? "https://github.com"}/${r.env.GITHUB_REPOSITORY}/actions/runs/${r.env.GITHUB_RUN_ID}` : ""}.`);
	L.push("");
	if (!r.verdict.ok) L.push("## Why it failed", "", ...r.verdict.reasons.map((x) => `- ${esc(x)}`), "");
	L.push("## Phases", "", "| Phase | Mode | Result | Time | Failed checks |", "|---|---|---|---|---|");
	for (const p of r.phases) {
		const failed = p.checks.filter((c) => !c.ok).map((c) => c.id);
		const result = p.mode === "skipped" ? "skipped" : p.ok ? "passed" : p.notImplemented ? "not implemented" : "**failed**";
		L.push(`| ${p.phase} | ${p.mode} | ${result} | ${secs(p.ms)} | ${esc(failed.join(", ") || p.error || "")} |`);
	}
	L.push("", "Mode `preview`: an earlier gate failed, so the phase ran with `--preview` (not recorded) to show its own result too.", "");
	L.push("## Assertions", "", "| Assertion | Result | Detail |", "|---|---|---|");
	for (const a of r.assertions) L.push(`| ${esc(a.label)} (\`${a.id}\`) | ${a.skipped ? "skipped" : a.ok ? "passed" : "**failed**"} | ${esc(a.detail ?? "")} |`);
	L.push("");
	if (r.verdict.excused.length) L.push("## Known failures (e2e/expectations.json)", "", ...r.verdict.excused.map((x) => `- ${esc(x)}`), "");
	if (r.verdict.stale.length) L.push("## Known failures that did not happen", "", "Remove them from e2e/expectations.json:", "", ...r.verdict.stale.map((x) => `- ${x}`), "");
	if (r.notes.length) L.push("## Notes", "", ...r.notes.map((n) => `- ${esc(n)}`), "");
	L.push("## Every gate check", "");
	for (const p of r.phases.filter((x) => x.mode !== "skipped")) {
		L.push(`### ${p.phase} (${p.mode}, ${p.ok ? "passed" : "failed"})`, "");
		if (p.error) L.push(`Error: ${esc(p.error)}`, "");
		for (const c of p.checks) L.push(`- ${c.ok ? "✓" : "✗"} \`${c.id}\` ${esc(c.label)}${c.detail ? ` — ${esc(c.detail)}` : ""}`);
		L.push("");
	}
	L.push("## Versions", "", "| Component | Version |", "|---|---|");
	for (const [k, v] of Object.entries(IMAGES)) L.push(`| image ${k} | \`${v}\` |`);
	for (const z of ZIPS) L.push(`| ${z.kind} ${z.slug} | ${z.version} |`);
	L.push("");
	if (r.files.length) L.push("## Files in this report", "", ...r.files.map((f) => `- \`${f}\``), "");
	return `${L.join("\n")}\n`;
}

export function reportJson(r: ReportInput): Record<string, unknown> {
	return {
		ok: r.verdict.ok,
		reasons: r.verdict.reasons,
		excused: r.verdict.excused,
		stale: r.verdict.stale,
		startedAt: r.startedAt,
		finishedAt: r.finishedAt,
		wpUrl: r.wpUrl,
		phases: r.phases,
		assertions: r.assertions,
		notes: r.notes,
		versions: { images: IMAGES, zips: ZIPS.map(({ slug, kind, version }) => ({ slug, kind, version })) },
	};
}
