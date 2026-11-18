/**
 * Apply padding measured on the source page (audit section boxes) to the IR sections paired with
 * each source row. The first section of a row gets its top padding, the last its bottom padding,
 * as a fluid value between the phone and desktop measurements.
 */
import type { SectionBox } from "../audit/browser.js";
import type { Section } from "../ir/schema.js";
import { fluid } from "../scaffold/generate.js";
import { groupSections } from "../verify/sections.js";

/** Sections whose padding includes the header or a full-screen layout: leave to the starter. */
const SKIP = new Set(["hero"]);

export function applyMeasuredPadding(sections: Section[], boxes: { desktop?: SectionBox[]; mobile?: SectionBox[] }, footer: boolean): number {
	if (!boxes.desktop?.length) return 0;
	let applied = 0;
	for (const g of groupSections(sections.map((s) => ({ type: s.type, path: s.sourceRef.path })), footer)) {
		const d = boxes.desktop.find((b) => b.footer === footer && b.index === g.sourceIndex);
		const m = boxes.mobile?.find((b) => b.footer === footer && b.index === g.sourceIndex) ?? d;
		if (d?.padTop === undefined || d.padBottom === undefined || m?.padTop === undefined || m.padBottom === undefined) continue;
		const first = sections[g.targetIndexes[0] as number];
		const last = sections[g.targetIndexes.at(-1) as number];
		if (first && !SKIP.has(first.type) && !first.fullHeight) {
			const lead = first.spaceBefore ?? 0;
			first.pad = { ...first.pad, top: fluid(m.padTop + lead, d.padTop + lead) };
			applied++;
		}
		if (last && !SKIP.has(last.type) && !last.fullHeight) {
			last.pad = { ...last.pad, bottom: fluid(m.padBottom, d.padBottom) };
			applied++;
		}
	}
	return applied;
}
