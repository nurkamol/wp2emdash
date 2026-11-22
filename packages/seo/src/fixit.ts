/**
 * SEO fix-it: AI drafts for the pages the SEO analysis flags (no meta description, no focus keyword, optionally an SEO
 * title that is too long or short), for an editor to review, edit and approve. Nothing is written without an approval.
 *
 * - Only published, indexable pages are drafted, from their saved (live) title and visible text — public text, never
 *   drafts or form submissions. The text is trimmed to TEXT_CHARS and sent to Workers AI; it is never stored.
 * - Model: Workers AI text generation (`AI` binding), JSON mode; default DEFAULT_FIXIT_MODEL (docs/spikes/seo-fixit-findings.md).
 * - Every output is validated and cleaned here (lengths, plain text, the keyword must appear in the page text, phone
 *   numbers / prices / emails / links not in the source are removed, unsupported claims flagged or removed).
 * - Pending suggestions live in plugin KV: at most MAX_PENDING, dropped after EXPIRE_DAYS; page titles and SEO values only.
 *
 * Pure apart from `draftOne` (calls the AI binding) and `approve` (writes through the given content API and KV).
 */
import { extract } from "./analyze.js";

/** Workers AI text model (JSON mode, multilingual, non-reasoning). Sites can override it (`fixit.model`). */
export const DEFAULT_FIXIT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
/** Pages drafted per admin action. */
export const FIXIT_BATCH = 10;
/** Drafts per UTC day, by default: ~55 neurons each ≈ 5,500 of the 10,000 free daily neurons (the rest for alt text). */
export const DEFAULT_DAILY_LIMIT = 100;
export const MAX_PENDING = 200;
export const MAX_DISCARDED = 200;
export const EXPIRE_DAYS = 30;
/** Visible text sent per page (characters, cut at a word). */
export const TEXT_CHARS = 3000;
/** Below this many words there is too little text to describe a page honestly. */
export const MIN_WORDS = 40;
export const DESC_MIN = 120;
export const DESC_MAX = 160;
/** Shorter than this a drafted description is dropped (the analysis calls under 70 "short"). */
export const DESC_FLOOR = 70;
export const TITLE_MAX = 60;
export const TITLE_MIN = 15;

const DAY = 86400_000;

export const KEYS = { pending: "fixit:pending", discarded: "fixit:discarded", usage: "fixit:usage", ai: "fixit:ai", prefs: "fixit:prefs" } as const;

export type Field = "description" | "keyword" | "title";

export interface Needs {
	description: boolean;
	keyword: boolean;
	title: boolean;
}

/** A page that can be drafted (built from the SEO report; `text` is transient, never stored). */
export interface Candidate {
	collection: string;
	id: string;
	title: string;
	slug: string | null;
	locale?: string | null;
	text: string;
	words: number;
	current: { title: string; description: string; keyword: string };
	needs: Needs;
}

export interface Suggestion {
	/** `<collection>:<id>` */
	sid: string;
	collection: string;
	id: string;
	/** Page title (≤ 80 characters) for the reviewer. */
	page: string;
	slug: string | null;
	at: string;
	model: string;
	/** The SEO values when drafted: approval refuses to overwrite a value someone changed since. */
	current: { title: string; description: string; keyword: string };
	suggested: { description?: string; keyword?: string; title?: string };
	notes: string[];
}

export interface Discarded {
	sid: string;
	at: string;
}

export const sidOf = (collection: string, id: string) => `${collection}:${id}`;

// ── Page text ────────────────────────────────────────────────────────────────────────────────────────────────────────

const words = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));

/** The page's visible text (headings and text blocks, de-duplicated), cut at a word to `max` characters. Pure. */
export function pageText(content: unknown, max = TEXT_CHARS): { text: string; words: number } {
	const x = extract(content);
	const seen = new Set<string>();
	const parts: string[] = [];
	for (const s of [...x.headings.map((h) => h.text), ...x.paragraphs]) {
		const t = s.replace(/\s+/g, " ").trim();
		if (!t || seen.has(t)) continue;
		seen.add(t);
		parts.push(t);
	}
	const all = parts.join("\n");
	const text = all.length > max ? all.slice(0, max).replace(/\s+\S*$/, "") : all;
	return { text, words: words(all).length };
}

// ── Prompt ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** "German (de-DE)" for a BCP 47 tag; undefined without one. */
export function languageName(lang: string | null | undefined): string | undefined {
	const tag = lang?.trim();
	if (!tag) return undefined;
	try {
		const name = new Intl.DisplayNames(["en"], { type: "language" }).of(tag);
		return name && name !== tag ? `${name} (${tag})` : tag;
	} catch {
		return tag;
	}
}

export const RESPONSE_SCHEMA = {
	type: "object",
	properties: { description: { type: "string" }, keyword: { type: "string" }, title: { type: "string" } },
	required: ["description", "keyword"],
} as const;

export interface PromptInput {
	site: string;
	lang?: string | null;
	title: string;
	path: string;
	text: string;
	wantTitle: boolean;
}

/** System and user messages for one page. Contains only the public page text, its title and address. Pure. */
export function buildPrompt(p: PromptInput): { role: "system" | "user"; content: string }[] {
	const lang = languageName(p.lang);
	const rules = [
		`You write search-engine metadata for one page of the website "${p.site}".`,
		`Write in ${lang ?? "the same language as the page text"}.`,
		`Reply with JSON only: {"description": "...", "keyword": "..."${p.wantTitle ? ', "title": "..."' : ""}}.`,
		`description: ${DESC_MIN}-${DESC_MAX} characters, one or two plain sentences that tell a searcher what the page offers and invite the click. No quotation marks, emoji, hashtags or markdown.`,
		"keyword: the focus keyword, 2-4 words copied exactly from the page text, that a person would search for to find this page.",
		...(p.wantTitle ? [`title: an SEO title of at most ${TITLE_MAX} characters, specific to this page, plain text.`] : []),
		"Use only facts stated in the page text. Never invent phone numbers, prices, addresses, awards, ratings, years or claims such as best, #1 or guaranteed.",
	];
	return [
		{ role: "system", content: rules.join("\n") },
		{ role: "user", content: `Page title: ${p.title}\nAddress: ${p.path}\n\nPage text:\n${p.text}` },
	];
}

// ── Output parsing and cleanup ───────────────────────────────────────────────────────────────────────────────────────

function jsonIn(s: string): Record<string, unknown> | undefined {
	const t = s.replace(/^\s*```(?:json)?/i, "").replace(/```\s*$/, "");
	const a = t.indexOf("{");
	const b = t.lastIndexOf("}");
	if (a < 0 || b <= a) return undefined;
	try {
		const v = JSON.parse(t.slice(a, b + 1));
		return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** The model's answer as an object: `{response: {...}}`, `{response: "json"}`, OpenAI-style `choices`, or a string. Pure. */
export function parseAi(raw: unknown): Record<string, unknown> | undefined {
	if (typeof raw === "string") return jsonIn(raw);
	if (!raw || typeof raw !== "object") return undefined;
	const r = raw as { response?: unknown; choices?: { message?: { content?: unknown } }[] };
	if (r.response && typeof r.response === "object" && !Array.isArray(r.response)) return r.response as Record<string, unknown>;
	if (typeof r.response === "string") return jsonIn(r.response);
	const c = r.choices?.[0]?.message?.content;
	if (typeof c === "string") return jsonIn(c);
	if ("description" in r || "keyword" in r) return r as Record<string, unknown>;
	return undefined;
}

const EMOJI = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u200D\uFE0F]/gu;
const digitsOf = (s: string) => s.replace(/\D/g, "");
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[’‘]/g, "'");
const flat = (s: string) => ` ${norm(s).replace(/[^\p{L}\p{N}'-]+/gu, " ").replace(/\s+/g, " ").trim()} `;

/** Plain one-line text: no markdown, quotes around it, emoji, hashtags or label prefix. Pure. */
export function plain(s: string): string {
	return (s.replace(/\r?\n+/g, " ") ?? "")
		.replace(EMOJI, "")
		.replace(/^\s*(?:meta\s*)?(?:description|keyword|focus keyword|seo title|title)\s*[:\-–]\s*/i, "")
		.replace(/[*_`#]+/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^["'“”‘’«»]+(.*?)["'“”‘’«»]+$/su, "$1")
		.trim();
}

const PHONE = /\+?\(?\d[\d\s().\-/]{5,}\d/g;
const PRICE = /(?:[$€£¥₹]\s?\d[\d.,]*(?:\s?(?:k|m))?|\d[\d.,]*\s?(?:[$€£¥₹]|usd|eur|gbp|dollars?|euros?|pounds?)\b)/gi;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
/** Claims removed when the page does not make them (adjective-like, safe to drop). */
const DROP_CLAIMS = ["award-winning", "award winning", "top-rated", "top rated", "world-class", "world class", "best-in-class", "industry-leading", "number one", "no. 1", "#1"];
/** Claims flagged for the reviewer when the page does not make them. */
const FLAG_CLAIMS = ["best", "leading", "cheapest", "guaranteed", "guarantee", "certified", "accredited", "official", "voted"];

function tidy(s: string): string {
	return s
		.replace(/\(\s*\)/g, "")
		.replace(/\s+([,.;:!?])/g, "$1")
		.replace(/([,;:])(?=[.!?])/g, "")
		.replace(/(?:\b(?:at|for|from|on|call|only|just|or|and)\s*)+([.!?]|$)/gi, "$1")
		.replace(/[,;:]\s*([.!?]|$)/g, "$1")
		.replace(/^[,;:.\s]+/, "")
		.replace(/\s{2,}/g, " ")
		.trim();
}

/** Removes phone numbers, prices, emails, links and big claims the source text does not contain. Pure. */
export function stripUnsupported(s: string, source: string): { text: string; removed: string[]; flagged: string[] } {
	const removed: string[] = [];
	const srcDigits = digitsOf(source);
	const srcNorm = norm(source);
	let t = s;
	t = t.replace(PHONE, (m) => (digitsOf(m).length >= 7 && !srcDigits.includes(digitsOf(m)) ? (removed.push(m.trim()), "") : m));
	t = t.replace(PRICE, (m) => (!srcDigits.includes(digitsOf(m)) || !digitsOf(m) ? (removed.push(m.trim()), "") : m));
	t = t.replace(EMAIL, (m) => (!srcNorm.includes(norm(m)) ? (removed.push(m), "") : m));
	t = t.replace(URL_RE, (m) => (!srcNorm.includes(norm(m).replace(/[.,]$/, "")) ? (removed.push(m), "") : m));
	const fs = flat(source);
	for (const c of DROP_CLAIMS) {
		if (fs.includes(flat(c)) || srcNorm.includes(c)) continue;
		const re = new RegExp(`(?:^|(?<=\\s))${c.replace(/[.*+?^${}()|[\]\\#]/g, "\\$&")}(?=\\s|[,.;:!?]|$)\\s*`, "gi");
		t = t.replace(re, (m) => (removed.push(m.trim()), ""));
	}
	const ft = flat(t);
	const flagged = FLAG_CLAIMS.filter((c) => ft.includes(` ${c} `) && !fs.includes(` ${c} `));
	return { text: tidy(t), removed, flagged };
}

export interface Cleaned {
	value?: string;
	notes: string[];
}

/** A drafted meta description: plain, unsupported details removed, 120–160 characters (cut at a word when longer). Pure. */
export function cleanDescription(raw: unknown, source: string): Cleaned {
	if (typeof raw !== "string") return { notes: ["No description was drafted."] };
	const notes: string[] = [];
	const s = stripUnsupported(plain(raw), source);
	if (s.removed.length) notes.push(`Removed from the description (not on the page): ${s.removed.slice(0, 3).join(", ")}.`);
	if (s.flagged.length) notes.push(`Check the description: it says “${s.flagged.join("”, “")}”, which the page does not.`);
	let t = s.text;
	if (t.length > DESC_MAX) {
		const sentence = t.slice(0, DESC_MAX).match(/^.*[.!?](?=\s|$)/)?.[0];
		t = sentence && sentence.length >= DESC_MIN ? sentence : `${t.slice(0, DESC_MAX - 1).replace(/\s+\S*$/, "").replace(/[\s,;:–-]+$/, "")}.`;
	}
	if (t && !/[.!?…]$/.test(t) && t.length < DESC_MAX) t = `${t}.`;
	if (t.length < DESC_FLOOR) return { notes: [...notes, `The drafted description was too short (${t.length} characters) and was dropped.`] };
	if (t.length < DESC_MIN) notes.push(`Short description (${t.length} characters): aim for ${DESC_MIN}–${DESC_MAX}.`);
	return { value: t, notes };
}

/** True when `phrase` occurs in `text` as whole words (case, accents and punctuation ignored). Pure. */
export function inText(phrase: string, text: string): boolean {
	const p = flat(phrase);
	return p.trim().length > 0 && flat(text).includes(p);
}

/** A drafted focus keyword: lowercase, 2–4 words, found in the page text (else shortened until it is, else dropped). Pure. */
export function cleanKeyword(raw: unknown, source: string): Cleaned {
	if (typeof raw !== "string") return { notes: ["No focus keyword was drafted."] };
	const ws = plain(raw)
		.toLowerCase()
		.replace(/[^\p{L}\p{N}'\- ]+/gu, " ")
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 4);
	for (let n = ws.length; n >= 2; n--) {
		for (let start = 0; start + n <= ws.length; start++) {
			const k = ws.slice(start, start + n).join(" ");
			if (inText(k, source)) return { value: k, notes: n < ws.length ? [`Focus keyword shortened to words that appear on the page.`] : [] };
		}
	}
	return { notes: [`No focus keyword: the drafted one (“${plain(raw).slice(0, 60)}”) does not appear in the page text${ws.length < 2 ? " or is a single word" : ""}.`] };
}

/** A drafted SEO title: plain, unsupported details removed, at most 60 characters (cut at a separator). Pure. */
export function cleanTitle(raw: unknown, source: string): Cleaned {
	if (typeof raw !== "string") return { notes: [] };
	const notes: string[] = [];
	const s = stripUnsupported(plain(raw), source);
	if (s.removed.length) notes.push(`Removed from the title (not on the page): ${s.removed.slice(0, 3).join(", ")}.`);
	if (s.flagged.length) notes.push(`Check the title: it says “${s.flagged.join("”, “")}”, which the page does not.`);
	let t = s.text.replace(/[.]+$/, "");
	if (t.length > TITLE_MAX) {
		const parts = t.split(/\s[|–—:-]\s/);
		let out = "";
		for (const p of parts) {
			const next = out ? `${out} - ${p}` : p;
			if (next.length > TITLE_MAX) break;
			out = next;
		}
		if (out.length < 20) return { notes: [...notes, `The drafted title was too long (${t.length} characters) and was dropped.`] };
		t = out;
	}
	if (t.length < TITLE_MIN) return { notes: [...notes, "The drafted title was too short and was dropped."] };
	return { value: t, notes };
}

/** Validated suggestion values for the fields a page needs. Pure. */
export function validate(out: Record<string, unknown> | undefined, c: Pick<Candidate, "needs" | "text" | "title">): { suggested: Suggestion["suggested"]; notes: string[] } {
	const source = `${c.title}\n${c.text}`;
	const suggested: Suggestion["suggested"] = {};
	const notes: string[] = [];
	if (!out) return { suggested, notes: ["The AI answer could not be read."] };
	if (c.needs.description) {
		const d = cleanDescription(out.description, source);
		if (d.value) suggested.description = d.value;
		notes.push(...d.notes);
	}
	if (c.needs.keyword) {
		const k = cleanKeyword(out.keyword, source);
		if (k.value) suggested.keyword = k.value;
		notes.push(...k.notes);
	}
	if (c.needs.title) {
		const t = cleanTitle(out.title, source);
		if (t.value) suggested.title = t.value;
		notes.push(...(out.title === undefined ? ["No SEO title was drafted."] : t.notes));
	}
	return { suggested, notes };
}

// ── AI call ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface AiBinding {
	run(model: string, input: Record<string, unknown>): Promise<unknown>;
}
export class AiLicenseError extends Error {}

/** One page through the model (JSON mode; one retry without it when the schema could not be met). */
export async function draftOne(ai: AiBinding, model: string, messages: ReturnType<typeof buildPrompt>): Promise<Record<string, unknown> | undefined> {
	const base = { messages, max_tokens: 320, temperature: 0.3 };
	const run = async (input: Record<string, unknown>) => {
		try {
			return await ai.run(model, input);
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e);
			if (/agree|licen[cs]e|acceptable use/i.test(msg)) throw new AiLicenseError(msg);
			throw e;
		}
	};
	try {
		return parseAi(await run({ ...base, response_format: { type: "json_schema", json_schema: RESPONSE_SCHEMA } }));
	} catch (e) {
		if (e instanceof AiLicenseError || !/json mode|json_schema|response_format|schema/i.test(e instanceof Error ? e.message : String(e))) throw e;
		return parseAi(await run(base));
	}
}

// ── Candidates, batching and limits ──────────────────────────────────────────────────────────────────────────────────

export interface ReportPage {
	collection: string;
	item: { id: string; slug: string | null; status?: string; locale?: string | null; data: Record<string, unknown>; seo?: { title?: string | null; description?: string | null; noIndex?: boolean } | null };
	title: string;
	keyword?: string;
	analysis: { checks: { id: string; status: string }[] };
}

/** Legal and policy pages (privacy, terms, cookies, waivers…): nobody searches to land on them, so no focus keyword is
 * drafted for them (a description still is: it shows when they do appear in results). Found on the live site's first
 * run, 2026-11-22: "privacy policy" / "terms and conditions" were suggested as focus keywords. */
export const LEGAL_SLUG = /(^|\/)(privacy|terms|cookies?|disclaimer|waiver|imprint|impressum|legal|gdpr|accessibility-statement)([-_]|\/|$)/i;

/** What a page lacks; titles only when asked. Pure. */
export function needsOf(p: ReportPage, titles: boolean): Needs {
	return {
		description: !p.item.seo?.description?.trim(),
		keyword: !p.keyword?.trim() && !LEGAL_SLUG.test(p.item.slug ?? ""),
		title: titles && p.analysis.checks.some((c) => c.id === "title" && (c.status === "warn" || c.status === "bad")),
	};
}
const anyNeed = (n: Needs) => n.description || n.keyword || n.title;

/** Published, indexable pages that need something, with their trimmed text. Pages with too little text are counted apart. Pure. */
export function candidates(pages: ReportPage[], titles: boolean): { ready: Candidate[]; tooShort: { title: string; words: number }[] } {
	const ready: Candidate[] = [];
	const tooShort: { title: string; words: number }[] = [];
	for (const p of pages) {
		if (p.item.status !== "published" || p.item.seo?.noIndex) continue;
		const needs = needsOf(p, titles);
		if (!anyNeed(needs)) continue;
		const t = pageText(p.item.data.content);
		if (t.words < MIN_WORDS) {
			tooShort.push({ title: p.title, words: t.words });
			continue;
		}
		ready.push({ collection: p.collection, id: p.item.id, title: p.title, slug: p.item.slug, ...(p.item.locale ? { locale: p.item.locale } : {}), text: t.text, words: t.words, current: { title: p.item.seo?.title?.trim() ?? "", description: p.item.seo?.description?.trim() ?? "", keyword: p.keyword?.trim() ?? "" }, needs });
	}
	return { ready, tooShort };
}

/** The next batch: candidates without a pending or recently discarded suggestion, at most `max` and what today allows. Pure. */
export function nextBatch(ready: Candidate[], pending: Suggestion[], discarded: Discarded[], max: number, leftToday: number): Candidate[] {
	const skip = new Set([...pending.map((s) => s.sid), ...discarded.map((d) => d.sid)]);
	return ready.filter((c) => !skip.has(sidOf(c.collection, c.id))).slice(0, Math.max(0, Math.min(max, leftToday)));
}

export interface Usage {
	day: string;
	drafts: number;
}
export const today = (now: number) => new Date(now).toISOString().slice(0, 10);
/** Drafts left today (UTC, like the Workers AI free allocation). Pure. */
export function leftToday(u: Usage | null | undefined, limit: number, now: number): number {
	return Math.max(0, limit - (u?.day === today(now) ? u.drafts : 0));
}
export const addUsage = (u: Usage | null | undefined, n: number, now: number): Usage => ({ day: today(now), drafts: (u?.day === today(now) ? u.drafts : 0) + n });

/** Pending suggestions within bounds: valid, not expired, newest kept, at most MAX_PENDING. Pure. */
export function prunePending(list: unknown, now: number): Suggestion[] {
	if (!Array.isArray(list)) return [];
	const ok = list.filter((s): s is Suggestion => !!s && typeof s === "object" && typeof (s as Suggestion).sid === "string" && typeof (s as Suggestion).at === "string" && !!(s as Suggestion).suggested && now - Date.parse((s as Suggestion).at) < EXPIRE_DAYS * DAY);
	const seen = new Set<string>();
	return ok
		.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
		.filter((s) => (seen.has(s.sid) ? false : (seen.add(s.sid), true)))
		.slice(0, MAX_PENDING);
}

export function pruneDiscarded(list: unknown, now: number): Discarded[] {
	if (!Array.isArray(list)) return [];
	return list
		.filter((d): d is Discarded => !!d && typeof d === "object" && typeof (d as Discarded).sid === "string" && typeof (d as Discarded).at === "string" && now - Date.parse((d as Discarded).at) < EXPIRE_DAYS * DAY)
		.sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
		.slice(0, MAX_DISCARDED);
}

/** A suggestion for a page that is gone, unpublished, or whose suggested fields were all filled in meanwhile: drop it. Pure. */
export function stillUseful(s: Suggestion, pages: ReportPage[]): boolean {
	const p = pages.find((x) => x.collection === s.collection && x.item.id === s.id);
	if (!p || p.item.status !== "published") return false;
	const n = needsOf(p, true);
	return (!!s.suggested.description && n.description) || (!!s.suggested.keyword && n.keyword) || (!!s.suggested.title && (n.title || p.item.seo?.title?.trim() === s.current.title));
}

/** Builds the stored suggestion for one drafted page (no page text kept). Pure. */
export function toSuggestion(c: Candidate, v: ReturnType<typeof validate>, model: string, now: number): Suggestion | undefined {
	if (!v.suggested.description && !v.suggested.keyword && !v.suggested.title) return undefined;
	return { sid: sidOf(c.collection, c.id), collection: c.collection, id: c.id, page: c.title.trim().slice(0, 80) || "Untitled", slug: c.slug, at: new Date(now).toISOString(), model, current: c.current, suggested: v.suggested, notes: v.notes.slice(0, 6) };
}

// ── Review and approval ──────────────────────────────────────────────────────────────────────────────────────────────

/** The values an editor approves: the form's edits over the draft; an emptied box drops that field. Pure. */
export function edited(s: Suggestion, values: Record<string, unknown> | undefined): Suggestion["suggested"] {
	const pick = (f: Field, max: number) => {
		if (!(f in s.suggested)) return undefined;
		const raw = values && f in values ? values[f] : s.suggested[f];
		// The editor's own words: one line, nothing else changed.
		const t = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, max) : "";
		return t || undefined;
	};
	const description = pick("description", 300);
	const keyword = pick("keyword", 80)?.toLowerCase();
	const title = pick("title", 120);
	return { ...(description ? { description } : {}), ...(keyword ? { keyword } : {}), ...(title ? { title } : {}) };
}

export interface ContentApi {
	get(c: string, id: string): Promise<{ id: string; status?: string; seo?: { title?: string | null; description?: string | null } | null } | null>;
	update?(c: string, id: string, data: { seo: { title?: string; description?: string } }): Promise<unknown>;
}
export interface FixitKv {
	get<T>(k: string): Promise<T | null>;
	set(k: string, v: unknown): Promise<void>;
}

export interface ApproveResult {
	written: { sid: string; page: string; fields: Field[] }[];
	skipped: { sid: string; page: string; reason: string }[];
}

/**
 * Writes approved suggestions: SEO title / description through the content API (`content.update(c, id, { seo })`, the
 * same `_emdash_seo` row the editor's SEO panel saves — not versioned, live at once on a published page) and the focus
 * keyword to the panel's KV key. Re-reads each page first; refuses when it is no longer published or a value changed
 * since the draft. The caller removes written rows from the pending list and purges the cache.
 */
export async function approve(content: ContentApi, kv: FixitKv, rows: { s: Suggestion; values: Suggestion["suggested"] }[], keywordKey: (c: string, id: string) => string): Promise<ApproveResult> {
	const out: ApproveResult = { written: [], skipped: [] };
	for (const { s, values } of rows) {
		const skip = (reason: string) => out.skipped.push({ sid: s.sid, page: s.page, reason });
		if (!values.description && !values.keyword && !values.title) {
			skip("nothing left to save (all boxes empty).");
			continue;
		}
		const live = await content.get(s.collection, s.id).catch(() => null);
		if (!live) {
			skip("the page no longer exists.");
			continue;
		}
		if (live.status !== "published") {
			skip("the page is no longer published.");
			continue;
		}
		const kwKey = keywordKey(s.collection, s.id);
		const kwNow = ((await kv.get<string>(kwKey)) ?? "").trim();
		const changed = [
			values.description && (live.seo?.description?.trim() ?? "") !== s.current.description ? "description" : "",
			values.title && (live.seo?.title?.trim() ?? "") !== s.current.title ? "SEO title" : "",
			values.keyword && kwNow !== s.current.keyword ? "focus keyword" : "",
		].filter(Boolean);
		if (changed.length) {
			skip(`someone changed the ${changed.join(" and ")} since this was drafted. Discard it and draft again.`);
			continue;
		}
		const seo = { ...(values.description ? { description: values.description } : {}), ...(values.title ? { title: values.title } : {}) };
		if (Object.keys(seo).length) {
			if (!content.update) {
				skip("this site cannot write SEO fields from plugins (content:write).");
				continue;
			}
			try {
				await content.update(s.collection, s.id, { seo });
			} catch (e) {
				skip(`saving failed: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}`);
				continue;
			}
		}
		if (values.keyword) await kv.set(kwKey, values.keyword);
		out.written.push({ sid: s.sid, page: s.page, fields: (["description", "keyword", "title"] as Field[]).filter((f) => values[f]) });
	}
	return out;
}
