/**
 * Section-by-section visual comparison. Migrated sections are paired with the WordPress row they came
 * from through the IR's sourceRef (`vc_row[3]`, or `vc_row[3]#1` when one row became several sections);
 * each pair is cropped from the two full-page screenshots and compared on its own, so one taller section
 * no longer shifts — and fails — everything below it.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import type { SectionBox } from "../audit/browser.js";

export interface SectionGroup {
	label: string;
	/** Index of the WordPress row (content or footer) this group compares. */
	sourceIndex: number;
	footer: boolean;
	/** Indexes of the migrated sections in the group (content or footer numbering). */
	targetIndexes: number[];
	types: string[];
}

export interface SectionDiff extends SectionGroup {
	ratio: number;
	sourceHeight: number;
	targetHeight: number;
	files?: { source: string; target: string; diff: string };
	note?: string;
	/** Compared on the still screenshots (moving photos greyed out on both sides). */
	still?: boolean;
}

/** `vc_row[3]#1` → 3; `blocks[4-9]` → undefined (Gutenberg ranges are compared as a whole page). */
export function sourceRowIndex(path: string): number | undefined {
	const m = /^(?:vc_row|vc_section)\[(\d+)\]/.exec(path);
	return m ? Number(m[1]) : undefined;
}

/**
 * Group migrated sections by the source row they came from, in order. Sections without a row index
 * (Gutenberg/classic) map to nothing and are compared as part of the whole page instead.
 */
export function groupSections(sections: { type: string; path: string }[], footer: boolean): SectionGroup[] {
	const groups: SectionGroup[] = [];
	sections.forEach((s, i) => {
		const src = sourceRowIndex(s.path);
		if (src === undefined) return;
		const last = groups.at(-1);
		if (last && last.sourceIndex === src && last.footer === footer) {
			last.targetIndexes.push(i);
			last.types.push(s.type);
		} else groups.push({ label: `${footer ? "footer " : ""}row ${src + 1}`, sourceIndex: src, footer, targetIndexes: [i], types: [s.type] });
	});
	return groups;
}

function crop(img: PNG, y: number, h: number, w: number): PNG {
	const out = new PNG({ width: w, height: h });
	for (let r = 0; r < h; r++) {
		const sy = y + r;
		if (sy < 0 || sy >= img.height) continue;
		img.data.copy(out.data, r * w * 4, sy * img.width * 4, sy * img.width * 4 + w * 4);
	}
	return out;
}

/**
 * Compare each group: source row box vs the union of its migrated sections' boxes. The difference is
 * measured over the taller of the two crops, so a missing or extra height counts as different pixels.
 */
export function diffSections(sourcePng: string, targetPng: string, sourceBoxes: SectionBox[], targetBoxes: SectionBox[], groups: SectionGroup[], out: (k: number, part: "source" | "target" | "diff") => string, still = false): SectionDiff[] {
	const a = PNG.sync.read(readFileSync(sourcePng));
	const b = PNG.sync.read(readFileSync(targetPng));
	const w = Math.min(a.width, b.width);
	return groups.map((g, k) => {
		const own = sourceBoxes.find((x) => x.footer === g.footer && x.index === g.sourceIndex);
		// Source rows that produced no section (padding-only rows, spacers) sit above this one: the migrated
		// section carries their height as top padding, so the source crop includes them too.
		const prevIndex = Math.max(-1, ...groups.filter((o) => o.footer === g.footer && o.sourceIndex < g.sourceIndex).map((o) => o.sourceIndex));
		const lead = sourceBoxes.filter((x) => x.footer === g.footer && x.index > prevIndex && x.index < g.sourceIndex);
		const src = own && lead.length ? { ...own, y: Math.min(own.y, ...lead.map((x) => x.y)), height: own.y + own.height - Math.min(own.y, ...lead.map((x) => x.y)) } : own;
		const tgts = g.targetIndexes.map((i) => targetBoxes.find((x) => x.footer === g.footer && x.index === i)).filter((x): x is SectionBox => !!x);
		if (!src || !tgts.length) return { ...g, ratio: 1, sourceHeight: src?.height ?? 0, targetHeight: tgts.reduce((n, t) => n + t.height, 0), note: !src ? "WordPress row not found on the page" : "migrated section not found on the page" };
		const ty = Math.min(...tgts.map((t) => t.y));
		const th = Math.max(...tgts.map((t) => t.y + t.height)) - ty;
		const h = Math.min(Math.max(src.height, th), 6000);
		const ca = crop(a, src.y, h, w);
		const cb = crop(b, ty, h, w);
		const diff = new PNG({ width: w, height: h });
		const n = pixelmatch(ca.data, cb.data, diff.data, w, h, { threshold: 0.15, includeAA: false, alpha: 0.25 });
		const files = { source: out(k, "source"), target: out(k, "target"), diff: out(k, "diff") };
		mkdirSync(dirname(files.source), { recursive: true });
		writeFileSync(files.source, PNG.sync.write(crop(a, src.y, src.height, w)));
		writeFileSync(files.target, PNG.sync.write(crop(b, ty, th, w)));
		writeFileSync(files.diff, PNG.sync.write(diff));
		return { ...g, ratio: n / (w * h), sourceHeight: src.height, targetHeight: th, files, ...(still ? { still: true } : {}) };
	});
}
