/**
 * Pure comparisons for the verify phase: old live page (audit snapshot) vs the migrated page.
 * Each returns data the gate and the report both use; no I/O here.
 */
import type { MotionRecipe } from "../audit/interactions.js";
import type { PageSnapshot } from "../audit/page.js";
import { tokens } from "../transform/coverage.js";

const norm = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const lower = (s: string | undefined) => norm(s).toLowerCase().replace(/[’‘]/g, "'");

export interface TextResult {
	recall: number;
	missing: string[];
	extra: string[];
}
/** Share of the old page's distinct words that appear on the new page (and what is new). */
export function compareText(source: string, target: string): TextResult {
	const s = new Set(tokens(source));
	const t = new Set(tokens(target));
	const missing = [...s].filter((w) => !t.has(w));
	const extra = [...t].filter((w) => !s.has(w));
	return { recall: s.size ? 1 - missing.length / s.size : 1, missing, extra };
}

export interface HeadingResult {
	ok: boolean;
	h1Source?: string;
	h1Target?: string;
	missing: string[];
}
/** The h1 must match; every source h1–h3 text must exist on the target (any level, any order). */
export function compareHeadings(source: PageSnapshot["headings"], target: PageSnapshot["headings"]): HeadingResult {
	const h1s = source.find((h) => h.level === 1)?.text;
	const h1t = target.find((h) => h.level === 1)?.text;
	const targetTexts = new Set(target.map((h) => lower(h.text)));
	const missing = [...new Set(source.filter((h) => h.level <= 3).map((h) => norm(h.text)))].filter((t) => t && !targetTexts.has(lower(t)));
	const h1ok = !h1s || lower(h1s) === lower(h1t);
	return { ok: h1ok && missing.length === 0, ...(h1s ? { h1Source: h1s } : {}), ...(h1t ? { h1Target: h1t } : {}), missing };
}

export interface SeoResult {
	title: { ok: boolean; source?: string; target?: string };
	description: { ok: boolean; source?: string; target?: string };
	canonical: { ok: boolean; expected?: string; target?: string };
	robots: { ok: boolean; target?: string; note: string };
	jsonLd: { ok: boolean; missing: string[]; target: string[] };
	og: { ok: boolean; missing: string[] };
}
/**
 * Titles and descriptions equal; canonical points at the production URL of the same path; staging
 * must be noindex while the source page was indexable; JSON-LD types and OpenGraph keys kept.
 */
/** On plain pages SEO plugins (Rank Math, Yoast) emit Article + author Person by default; the migration regenerates them for posts only. */
const PAGE_BOILERPLATE_LD = new Set(["Article", "Person"]);

export function compareSeo(source: PageSnapshot["seo"], target: PageSnapshot["seo"], expectedCanonical: string, isStaging: boolean, kind: "page" | "post" | string = "page"): SeoResult {
	const robotsT = lower([target.robots, target.xRobotsTag].filter(Boolean).join(", "));
	const missingLd = source.jsonLdTypes.filter((t) => !target.jsonLdTypes.includes(t) && !(kind === "page" && PAGE_BOILERPLATE_LD.has(t)));
	const ogKeys = ["og:title", "og:description", "og:type", "og:url"].filter((k) => source.og[k] && !target.og[k]);
	const canon = (u?: string) => (u ?? "").replace(/\/+$/, "");
	return {
		title: { ok: lower(source.title) === lower(target.title), ...(source.title ? { source: source.title } : {}), ...(target.title ? { target: target.title } : {}) },
		description: { ok: lower(source.description) === lower(target.description), ...(source.description ? { source: source.description } : {}), ...(target.description ? { target: target.description } : {}) },
		canonical: { ok: canon(target.canonical) === canon(expectedCanonical), expected: expectedCanonical, ...(target.canonical ? { target: target.canonical } : {}) },
		robots: isStaging ? { ok: robotsT.includes("noindex"), target: robotsT, note: "staging must not be indexed" } : { ok: !robotsT.includes("noindex") || lower(source.robots).includes("noindex"), target: robotsT, note: "production must keep the source's indexability" },
		jsonLd: { ok: missingLd.length === 0, missing: missingLd, target: target.jsonLdTypes },
		og: { ok: ogKeys.length === 0, missing: ogKeys },
	};
}

/** External destinations (booking, phone, email, social) the old page linked to and the new one doesn't. */
export function missingExternalLinks(source: PageSnapshot["links"], target: PageSnapshot["links"]): string[] {
	const key = (h: string) => h.replace(/\/+$/, "").replace(/^http:/, "https:").toLowerCase();
	const t = new Set(target.filter((l) => !l.internal).map((l) => key(l.href)));
	return [...new Set(source.filter((l) => !l.internal && /^(https?:|tel:|mailto:)/i.test(l.href) && !/\/(wp-content|storage)\//.test(l.href)).map((l) => l.href))].filter((h) => !t.has(key(h)));
}

export interface MotionResult {
	ok: boolean;
	diffs: string[];
}
/** Each recipe value within ±tolerance, same easing curve. */
export function compareMotion(source: MotionRecipe, target: MotionRecipe, tolerance = 0.15): MotionResult {
	const diffs: string[] = [];
	const near = (label: string, a?: number, b?: number) => {
		if (a === undefined) return;
		if (b === undefined) return diffs.push(`${label}: missing (source ${a})`);
		const allowed = Math.max(Math.abs(a) * tolerance, 20);
		if (Math.abs(a - b) > allowed) diffs.push(`${label}: ${b} vs source ${a}`);
	};
	const ease = (label: string, a?: string, b?: string) => {
		if (a && b && a.replace(/\s/g, "") !== b.replace(/\s/g, "")) diffs.push(`${label} easing: ${b} vs source ${a}`);
	};
	near("overlay duration", source.overlay?.durationMs, target.overlay?.durationMs);
	near("icon duration", source.icon?.durationMs, target.icon?.durationMs);
	ease("icon", source.icon?.easing, target.icon?.easing);
	near("item duration", source.items?.durationMs, target.items?.durationMs);
	near("item first delay", source.items?.startDelayMs, target.items?.startDelayMs);
	near("item stagger", source.items?.staggerMs, target.items?.staggerMs);
	ease("item", source.items?.easing, target.items?.easing);
	return { ok: diffs.length === 0, diffs };
}

/** Labels of the source menu that the migrated menu lacks (case/whitespace-insensitive). */
export function missingMenuItems(source: { text: string }[], target: { text: string }[]): string[] {
	const t = new Set(target.map((i) => lower(i.text)));
	return [...new Set(source.map((i) => norm(i.text)))].filter((x) => x && !t.has(lower(x)));
}
