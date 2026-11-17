/**
 * The pipeline. Order matters: a phase can only run when every earlier phase
 * has a passing (or explicitly accepted) gate.
 */
export const PHASES = [
	{ id: "init", title: "Initialise site workspace", milestone: "M1", summary: "Config, access checklist, backups confirmed" },
	{ id: "audit", title: "Audit live site", milestone: "M2", summary: "URL discovery, snapshots, screenshots, forms & integrations scan" },
	{ id: "extract", title: "Extract raw content", milestone: "M3", summary: "WXR, REST, theme options, media manifest, redirects" },
	{ id: "transform", title: "Transform to sections", milestone: "M4", summary: "Builder adapters → Section IR, coverage report" },
	{ id: "scaffold", title: "Scaffold EmDash project", milestone: "M5", summary: "Starter, tokens, section library, staging resources" },
	{ id: "load", title: "Load into staging", milestone: "M6", summary: "Official importer + overlay + fix-ups + id-map" },
	{ id: "verify", title: "Verify against baseline", milestone: "M7", summary: "Content, URLs, SEO, visual, forms, a11y, perf, security" },
	{ id: "cutover", title: "Cut over to production", milestone: "M8", summary: "Preflight, delta, deploy, smoke, monitor, rollback ready" },
] as const;

export type PhaseId = (typeof PHASES)[number]["id"];

export const PHASE_IDS = PHASES.map((p) => p.id) as PhaseId[];

export function isPhaseId(value: string): value is PhaseId {
	return (PHASE_IDS as string[]).includes(value);
}

export function phaseIndex(id: PhaseId): number {
	return PHASE_IDS.indexOf(id);
}

export type Phase = (typeof PHASES)[number];

export function getPhase(id: PhaseId): Phase {
	const phase = PHASES.find((p) => p.id === id);
	if (!phase) throw new Error(`Unknown phase "${id}"`);
	return phase;
}
