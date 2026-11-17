import { readdirSync } from "node:fs";
import pc from "picocolors";
import { SITES_DIR, sitePaths, siteExists } from "../core/paths.js";
import { PHASES } from "../core/phases.js";
import { nextPhase, phaseState, readState, type SiteState } from "../core/state.js";

export function listSites(sitesDir = SITES_DIR): string[] {
	try {
		return readdirSync(sitesDir, { withFileTypes: true })
			.filter((d) => d.isDirectory() && siteExists(d.name, sitesDir))
			.map((d) => d.name)
			.sort();
	} catch {
		return [];
	}
}

const ICON: Record<string, string> = {
	pending: pc.dim("○"),
	running: pc.cyan("◐"),
	passed: pc.green("●"),
	failed: pc.red("✖"),
	accepted: pc.yellow("◉"),
};

export function formatTimeline(state: SiteState): string {
	const next = nextPhase(state);
	const lines = PHASES.map((p) => {
		const s = phaseState(state, p.id);
		const failed = s.checks.filter((c) => !c.ok).length;
		const extra =
			s.status === "failed"
				? pc.red(` ${failed} check(s) failing`)
				: s.status === "accepted"
					? pc.yellow(` accepted: ${s.acceptedReason}`)
					: s.status === "passed"
						? pc.dim(` ${s.checks.length} checks`)
						: "";
		const marker = p.id === next ? pc.cyan(" ← next") : "";
		return `  ${ICON[s.status]} ${p.id.padEnd(10)} ${pc.dim(p.title.padEnd(26))}${pc.dim(p.milestone)}${extra}${marker}`;
	});
	return [pc.bold(`Site: ${state.slug}`), ...lines].join("\n");
}

export function statusJson(slug: string, sitesDir?: string) {
	const state = readState(sitePaths(slug, sitesDir).state);
	return { ...state, next: nextPhase(state) ?? null };
}
