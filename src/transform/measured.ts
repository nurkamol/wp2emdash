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

/** The tablet measurement when it is more than 4px off the straight phone→desktop line the fluid value draws. */
function offLine(phone: number, tablet: number | undefined, desktop: number): number | undefined {
	if (tablet === undefined) return undefined;
	const line = phone + ((desktop - phone) * (768 - 390)) / (1440 - 390);
	return Math.abs(tablet - line) > 4 ? Math.round(tablet) : undefined;
}

export function applyMeasuredPadding(sections: Section[], boxes: { desktop?: SectionBox[]; tablet?: SectionBox[]; mobile?: SectionBox[] }, footer: boolean): number {
	if (!boxes.desktop?.length) return 0;
	let applied = 0;
	let prev = -1;
	for (const g of groupSections(sections.map((s) => ({ type: s.type, path: s.sourceRef.path })), footer)) {
		const d = boxes.desktop.find((b) => b.footer === footer && b.index === g.sourceIndex);
		const m = boxes.mobile?.find((b) => b.footer === footer && b.index === g.sourceIndex) ?? d;
		const t = boxes.tablet?.find((b) => b.footer === footer && b.index === g.sourceIndex);
		// Source rows with nothing to migrate (a builder row that is only padding, a spacer) left no section;
		// their height is space above the next section.
		const skipped = (list: SectionBox[] | undefined) => (list ?? []).filter((b) => b.footer === footer && b.index > prev && b.index < g.sourceIndex).reduce((n, b) => n + b.height, 0);
		const gap = { d: skipped(boxes.desktop), m: boxes.mobile ? skipped(boxes.mobile) : skipped(boxes.desktop), t: skipped(boxes.tablet) };
		prev = Math.max(prev, g.sourceIndex);
		if (d?.padTop === undefined || d.padBottom === undefined || m?.padTop === undefined || m.padBottom === undefined) continue;
		const first = sections[g.targetIndexes[0] as number];
		const last = sections[g.targetIndexes.at(-1) as number];
		if (first && !SKIP.has(first.type) && !first.fullHeight) {
			const lead = first.spaceBefore ?? 0;
			const tab = offLine(m.padTop + gap.m, t?.padTop !== undefined ? t.padTop + gap.t : undefined, d.padTop + gap.d);
			first.pad = { ...first.pad, top: fluid(m.padTop + gap.m + lead, d.padTop + gap.d + lead), ...(tab !== undefined ? { topTablet: tab + lead } : {}) };
			applied++;
		}
		if (last && !SKIP.has(last.type) && !last.fullHeight) {
			const tab = offLine(m.padBottom, t?.padBottom, d.padBottom);
			last.pad = { ...last.pad, bottom: fluid(m.padBottom, d.padBottom), ...(tab !== undefined ? { bottomTablet: tab } : {}) };
			applied++;
		}
	}
	return applied;
}
