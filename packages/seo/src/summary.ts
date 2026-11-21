/**
 * A small summary of the SEO suite's page analysis, cached in the plugin's KV (`summary`) so other plugins can read
 * it without redoing the analysis: Site health's "What to improve" list reads the D1 row `plugin:site-seo:summary`
 * (EmDash 1.5 plugin KV = one `options` row per key, JSON; see analytics/store.ts). Written when the SEO dashboard or
 * its dashboard widget is opened (the analysis has just run there, so the write costs one KV read and at most one
 * write) and only when something changed or the stored one is over 6 hours old. Page titles and counts only.
 */
import type { Analysis } from "./analyze.js";
import type { D1Like } from "./analytics/store.js";
import { SEO_PLUGIN } from "./meta.js";

export const SUMMARY_KEY = "summary";
/** The options-table row behind `ctx.kv` key SUMMARY_KEY. */
export const SUMMARY_OPTION = `plugin:${SEO_PLUGIN.id}:${SUMMARY_KEY}`;
/** Page titles kept per list. */
export const SUMMARY_LIST = 10;
const REWRITE_MS = 6 * 60 * 60 * 1000;

export interface SeoSummary {
	v: 1;
	at: string;
	/** Published pages analysed. */
	pages: number;
	average: number;
	/** Pages that need more text (Analysis.thin), fewest words first. */
	thin: { count: number; pages: { title: string; words: number }[] };
	/** Indexable pages without a meta description. */
	noDescription: { count: number; pages: string[] };
	/** Pages whose focus keyword is missing from most of the places Google looks (the keyword check is "bad"). */
	keyword: { count: number; pages: string[] };
	/** Pictures on published pages without a description (alt text), and the pages that use them. */
	missingAlt: { count: number; pages: string[] };
}

export interface SummaryPage {
	title: string;
	analysis: Analysis;
	/** The page's own SEO fields (meta description, hidden from search). */
	seo?: { description?: string | null; noIndex?: boolean } | null;
}

const title = (t: string) => t.trim().slice(0, 80) || "Untitled";

/** The summary of one analysis run. `missingAlt`: the pictures without alt text with the titles of the pages using them. */
export function seoSummaryOf(pages: SummaryPage[], missingAlt: { pages: string[] }[], now = Date.now()): SeoSummary {
	const indexable = pages.filter((p) => !p.seo?.noIndex);
	const thin = pages.filter((p) => p.analysis.thin).sort((a, b) => a.analysis.words - b.analysis.words);
	const noDesc = indexable.filter((p) => !p.seo?.description?.trim());
	const kw = indexable.filter((p) => p.analysis.checks.some((c) => c.id === "keyword" && c.status === "bad"));
	const altPages = [...new Set(missingAlt.flatMap((m) => m.pages.map(title)))];
	return {
		v: 1,
		at: new Date(now).toISOString(),
		pages: pages.length,
		average: pages.length ? Math.round(pages.reduce((n, p) => n + p.analysis.score, 0) / pages.length) : 0,
		thin: { count: thin.length, pages: thin.slice(0, SUMMARY_LIST).map((p) => ({ title: title(p.title), words: p.analysis.words })) },
		noDescription: { count: noDesc.length, pages: noDesc.slice(0, SUMMARY_LIST).map((p) => title(p.title)) },
		keyword: { count: kw.length, pages: kw.slice(0, SUMMARY_LIST).map((p) => title(p.title)) },
		missingAlt: { count: missingAlt.length, pages: altPages.slice(0, SUMMARY_LIST) },
	};
}

/** Pictures (images only, known to the media library) used on the given pages without alt text, with the pages using them. */
export function missingAltImages(pages: { title: string; ids: string[] }[], media: Map<string, { alt?: string; filename?: string; url?: string; mimeType?: string }>): { id: string; filename: string; url?: string; pages: string[] }[] {
	const usage = new Map<string, string[]>();
	for (const p of pages) for (const id of p.ids) usage.set(id, [...(usage.get(id) ?? []), p.title]);
	return [...usage.entries()]
		.filter(([id]) => media.get(id)?.mimeType?.startsWith("image/") && !media.get(id)?.alt?.trim())
		.map(([id, used]) => ({ id, filename: media.get(id)?.filename ?? id, ...(media.get(id)?.url ? { url: media.get(id)?.url } : {}), pages: [...new Set(used)] }));
}

/** A stored value read back; undefined when it is not a summary. */
export function parseSeoSummary(v: unknown): SeoSummary | undefined {
	if (!v || typeof v !== "object") return undefined;
	const s = v as Partial<SeoSummary>;
	const list = (x: unknown) => !!x && typeof x === "object" && typeof (x as { count?: unknown }).count === "number" && Array.isArray((x as { pages?: unknown }).pages);
	if (s.v !== 1 || typeof s.at !== "string" || typeof s.pages !== "number" || !list(s.thin) || !list(s.noDescription) || !list(s.keyword) || !list(s.missingAlt)) return undefined;
	return s as SeoSummary;
}

interface SummaryKv {
	get<T>(k: string): Promise<T | null>;
	set(k: string, v: unknown): Promise<void>;
}

/** Stores the summary when it changed or the stored one is old. Returns whether it wrote. Never throws. */
export async function storeSeoSummary(kv: SummaryKv, s: SeoSummary): Promise<boolean> {
	try {
		const cur = parseSeoSummary(await kv.get<unknown>(SUMMARY_KEY));
		const same = cur && JSON.stringify({ ...cur, at: "" }) === JSON.stringify({ ...s, at: "" });
		if (cur && same && Date.parse(s.at) - Date.parse(cur.at) < REWRITE_MS) return false;
		await kv.set(SUMMARY_KEY, s);
		return true;
	} catch {
		return false;
	}
}

/** The summary read straight from D1 (another plugin's view). null: never written; undefined: could not be read. */
export async function readSeoSummary(db: D1Like | undefined): Promise<SeoSummary | null | undefined> {
	if (!db) return undefined;
	try {
		const row = await db.prepare("SELECT value FROM options WHERE name = ? LIMIT 1").bind(SUMMARY_OPTION).first<{ value: string }>();
		if (!row) return null;
		return parseSeoSummary(JSON.parse(row.value)) ?? null;
	} catch {
		return undefined;
	}
}
