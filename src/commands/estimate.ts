/**
 * `wp2emdash estimate <url>`: a sales estimate for a prospect's public WordPress site — no login, no `init`, no
 * sites/<slug>/ state. Reads the site politely (src/estimate/gather.ts), maps what it finds to the kit's real scope
 * and gates (blockers.ts), applies the agency's effort rules (rules.ts → effort.ts) and writes
 * `estimates/<host>-<date>/` at the kit root (gitignored: prospect data never enters the repo): report.html,
 * report.md (client-facing), internal.md and estimate.json.
 *
 * Optional Google data: `--lab` runs PageSpeed Insights on the home page when PAGESPEED_API_KEY (or CRUX_API_KEY)
 * is in the kit .env or the environment; CrUX field data is read whenever CRUX_API_KEY is set. Keys go only to
 * Google and never into a file.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { KIT_ROOT } from "../core/paths.js";
import { newRunId, renderEvent, type Reporter } from "../core/progress.js";
import { loadEnv } from "../extract/credentials.js";
import { adaptersFor, findingsFor } from "../estimate/blockers.js";
import { computeEffort } from "../estimate/effort.js";
import { gather } from "../estimate/gather.js";
import { renderClientHtml, renderClientMarkdown, renderInternal } from "../estimate/report.js";
import { DEFAULT_RULES, type EstimateRules, mergeRules } from "../estimate/rules.js";
import { fieldData, labRuns, summarizeSpeed } from "../estimate/speed.js";
import type { Detections, Estimate, PageSpeed, SpeedSummary } from "../estimate/types.js";

export const ESTIMATES_DIR = process.env.WP2EMDASH_ESTIMATES_DIR ? resolve(process.env.WP2EMDASH_ESTIMATES_DIR) : join(KIT_ROOT, "estimates");

export interface EstimateOptions {
	rate?: number;
	currency?: string;
	lab?: boolean;
	agency?: string;
	agencyUrl?: string;
	contact?: string;
	/** JSON file deep-merged over DEFAULT_RULES. */
	rulesFile?: string;
	/** Parent folder of `<host>-<date>/` (default ESTIMATES_DIR). */
	outRoot?: string;
	/** Secrets and settings (default: kit .env overlaid by process.env). Tests pass {} so nothing calls Google. */
	env?: Record<string, string | undefined>;
	quiet?: boolean;
	now?: Date;
}

const kitVersion = () => {
	try {
		return (JSON.parse(readFileSync(join(KIT_ROOT, "package.json"), "utf8")) as { version?: string }).version ?? "?";
	} catch {
		return "?";
	}
};

export function loadRules(file?: string, base: EstimateRules = DEFAULT_RULES): EstimateRules {
	const copy = structuredClone(base);
	if (!file) return copy;
	return mergeRules(copy, JSON.parse(readFileSync(resolve(file), "utf8")));
}

/** Detections + speed → the estimate. Pure. */
export function buildEstimate(detections: Detections, speed: SpeedSummary, rules: EstimateRules, o: { rate?: number; currency?: string; now?: Date; kit?: string } = {}): Estimate {
	const adapters = adaptersFor(detections);
	const findings = findingsFor(detections, adapters);
	const effort = computeEffort(detections, adapters, findings, rules, o);
	return { kit: o.kit ?? kitVersion(), generatedAt: (o.now ?? new Date()).toISOString(), detections, adapters, findings, effort, speed, agency: { ...rules.agency } };
}

export async function runEstimate(url: string, o: EstimateOptions = {}): Promise<{ estimate: Estimate; dir: string; files: string[] }> {
	const env = o.env ?? { ...loadEnv(join(KIT_ROOT, ".env")), ...process.env };
	const rules = loadRules(o.rulesFile);
	const name = o.agency ?? env.WP2EMDASH_AGENCY_NAME;
	const agencyUrl = o.agencyUrl ?? env.WP2EMDASH_AGENCY_URL;
	const contact = o.contact ?? env.WP2EMDASH_AGENCY_CONTACT;
	if (name) rules.agency.name = name;
	if (agencyUrl) rules.agency.url = agencyUrl;
	if (contact) rules.agency.contact = contact;
	const now = o.now ?? new Date();
	const reporter: Reporter = { runId: newRunId(now), emit: (e) => void (o.quiet ? undefined : renderEvent(e)) };

	const { detections, speedPages } = await gather(url, rules, reporter, now);
	const lab = await googleLab(detections, speedPages, env, !!o.lab, reporter);
	const speed = summarizeSpeed(speedPages, lab);
	const estimate = buildEstimate(detections, speed, rules, { ...(o.rate !== undefined ? { rate: o.rate } : {}), ...(o.currency ? { currency: o.currency } : {}), now });

	const dir = join(o.outRoot ?? ESTIMATES_DIR, `${detections.host}-${now.toISOString().slice(0, 10)}`);
	mkdirSync(dir, { recursive: true });
	const files = {
		"report.html": renderClientHtml(estimate),
		"report.md": renderClientMarkdown(estimate),
		"internal.md": renderInternal(estimate),
		"estimate.json": `${JSON.stringify(estimate, null, 2)}\n`,
	};
	for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body);
	return { estimate, dir, files: Object.keys(files).map((f) => join(dir, f)) };
}

async function googleLab(d: Detections, pages: PageSpeed[], env: Record<string, string | undefined>, lab: boolean, reporter: Reporter): Promise<{ lab?: SpeedSummary["lab"]; field?: SpeedSummary["field"] }> {
	const psiKey = env.PAGESPEED_API_KEY?.trim() || env.CRUX_API_KEY?.trim();
	const cruxKey = env.CRUX_API_KEY?.trim();
	const out: { lab?: SpeedSummary["lab"]; field?: SpeedSummary["field"] } = {};
	if (lab) {
		reporter.emit({ type: "step:start", step: "PageSpeed Insights" });
		out.lab = psiKey ? await labRuns(pages[0]?.url ?? `${d.origin}/`, psiKey) : { missing: "no-key" };
		reporter.emit({ type: "step:end", step: "PageSpeed Insights", ok: !out.lab.missing, detail: out.lab.missing ? `no result (${out.lab.missing}${out.lab.missing === "no-key" ? ": set PAGESPEED_API_KEY in the kit .env" : ""})` : `mobile ${out.lab.mobile?.perf ?? "?"}, desktop ${out.lab.desktop?.perf ?? "?"}` });
	}
	if (cruxKey) {
		out.field = await fieldData(d.origin, cruxKey);
		reporter.emit({ type: "log", level: "info", message: out.field.missing ? `CrUX: no field data (${out.field.missing})` : `CrUX p75: LCP ${out.field.lcp ?? "?"} ms, INP ${out.field.inp ?? "?"} ms, CLS ${out.field.cls ?? "?"}` });
	}
	return out;
}
