/**
 * Content freshness: text on the site's pages that has gone out of date, and pages nobody has touched in a long time.
 * Conservative by design — a false "this is stale" costs the owner's trust more than a missed one:
 *
 *   date     a past date that reads like an event: a full date with its weekday ("Saturday, March 3, 2024"), or a
 *            full / numeric / month-year date next to an event word ("join us", "workshop", "register", "until", a
 *            time like 7 pm). Dates after "since", "founded", "posted", "updated", "award" and the like are history and
 *            are skipped. Numeric dates (03/04/2024, 03.04.2024; never with dashes, so phone numbers do not match)
 *            count only when both readings (US and European) are valid and past, or the only valid one is.
 *   phrase   a year-bound phrase whose period has ended: "Summer 2023", "Black Friday 2024", "2024 offer",
 *            "schedule for 2023", and a copyright line "© 2023" (or "© 2019–2023") older than this year.
 *   old      a page (never a post; never a legal page) not saved in the editor for `staleMonths` months (default 18).
 *
 * Text comes from the HTML the weekly visual check already fetched (its <main>, <time> elements, post cards and the
 * comments section left out; the copyright line from the whole body) and from the entries `ctx.content.list` returns
 * for the freshness collections (default pages; string fields of `data`). Legal pages (privacy, terms, cookies,
 * imprint, …, detected by slug) and thank-you pages change rarely by design and are skipped entirely. English
 * month and weekday names plus German, French, Spanish and Dutch month names; event words in English and a few
 * others. Only the matched words are kept (at most 80 characters), never surrounding text. Pure.
 */
import { decode } from "./visual.js";
import { itemId } from "./a11y.js";

export type StaleKind = "date" | "phrase" | "old";

/** One stale finding on one page. */
export interface StaleHit {
	k: StaleKind;
	/** The matched words ("Saturday, March 3, 2024", "© 2023"), or for `old` the last save (ISO day). */
	text: string;
	/** When the date or period ended (ISO day). */
	ended?: string;
}

/** The same finding grouped across pages (a footer copyright on every page is one item). */
export interface StaleItem {
	id: string;
	k: StaleKind;
	text: string;
	ended?: string;
	pages: string[];
	/** The page's entry when the item concerns one known page (for the "Edit" link: /_emdash/admin/content/<collection>/<id>). */
	entry?: { collection: string; id: string };
}

export const STALE_MONTHS = 18;
export const STALE_PER_PAGE = 10;
export const MAX_STALE_ITEMS = 60;
const MAX_TEXT = 200_000;
const DAY_MS = 86_400_000;

export const STALE_TEXT: Record<StaleKind, { label: string; why: string; fix: string }> = {
	date: { label: "Past date", why: "An event or offer with a date that has passed tells visitors the site is not looked after, and they may turn up for something that is over.", fix: "Edit the page: remove the date, replace it with the next one, or move it to a news post. If it is a historic fact, dismiss it." },
	phrase: { label: "Out-of-date wording", why: "A season, offer or copyright year that has passed makes the whole site look abandoned.", fix: "Edit the page (or the footer in Menus / Settings) and update or remove the year. If it is meant (a past award), dismiss it." },
	old: { label: "Not updated for a long time", why: "Opening hours, prices, team members and services change; a page untouched for a long time often says something no longer true.", fix: "Open the page, read it through and save it — even with no change — once it is correct. Dismiss it if it never changes." },
};

// ── Pages that change rarely by design ─────────────────────────────────────────────────────────────────────────

const LEGAL = /(?:^|[/_-])(privacy|privacy-policy|privacy-notice|data-protection|datenschutz|terms|tos|terms-of-service|terms-of-use|terms-and-conditions|conditions|legal|legal-notice|imprint|impressum|mentions-legales|aviso-legal|disclaimer|cookies?|cookie-policy|accessibility(?:-statement)?|gdpr|ccpa|refund(?:-policy)?|returns?(?:-policy)?|shipping(?:-policy)?|polic(?:y|ies)|waiver|copyright|dmca|agb|cgv)(?:$|[/_-])/i;
const THANKS = /(?:^|[/_-])(thank-?you|thanks|merci|danke|gracias|confirmation|success|submitted|unsubscribed?|404)(?:$|[/_-])/i;

/** Legal pages (privacy, terms, cookies, imprint, refund, …) and thank-you / confirmation pages, by slug or path. */
export const isRarelyChanged = (pathOrSlug: string) => {
	const p = pathOrSlug.replace(/\/+$/, "").toLowerCase();
	return LEGAL.test(p) || THANKS.test(p);
};

// ── Dates ───────────────────────────────────────────────────────────────────────────────────────────────────────

const MONTHS: Record<string, number> = {};
const addMonths = (names: string[][]) => names.forEach((list, i) => list.forEach((n) => (MONTHS[n] = i + 1)));
addMonths([
	["january", "jan", "januar", "janvier", "enero", "januari", "jänner"],
	["february", "feb", "februar", "février", "fevrier", "febrero", "februari"],
	["march", "mar", "märz", "maerz", "mars", "marzo", "maart"],
	["april", "apr", "avril", "abril"],
	["may", "mai", "mayo", "mei"],
	["june", "jun", "juni", "juin", "junio"],
	["july", "jul", "juli", "juillet", "julio"],
	["august", "aug", "août", "aout", "agosto", "augustus"],
	["september", "sep", "sept", "septembre", "septiembre", "setiembre"],
	["october", "oct", "oktober", "octobre", "octubre"],
	["november", "nov", "novembre", "noviembre"],
	["december", "dec", "dezember", "décembre", "decembre", "diciembre"],
]);
const MONTH_RE = Object.keys(MONTHS)
	.sort((a, b) => b.length - a.length)
	.join("|");
const WEEKDAYS = "monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo";

/** Event words near a date make it an event (English plus a few common ones in German, French, Spanish, Dutch). */
const EVENT = /\b(events?|join us|join our|workshops?|class(?:es)?|sessions?|seminars?|webinars?|retreats?|open house|grand opening|opening|register|registration|rsvp|tickets?|book now|book your|sign up|signup|deadline|until|through|thru|starts?|starting|begins?|kicks? off|happening|festival|party|celebrat\w*|sale|offer|special|promo\w*|discount|launch\w*|concert|meetup|meet-up|conference|camp|tour|reserve|enrol+\w*|limited|spots?|doors open|expires?|valid|veranstaltung|anmeldung|kurs|termin|événement|evenement|atelier|inscription|evento|inscripción|inscripcion|taller|aanmelden|cursus)\b|\b\d{1,2}(?::\d{2})?\s?(?:am|pm|a\.m\.|p\.m\.)(?![a-z])/i;
/** History: a date after these is a fact, not an announcement. */
const HISTORY = /\b(since|founded|established|est\.?|opened|born|built|awarded|award|winner|won|voted|launched in|started in|in business|posted|published|updated|last updated|revised|effective|as of|copyright|seit|gegründet|depuis|fondée?|desde|fundad[oa])\b[^.!?]{0,30}$/i;

const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const validDay = (y: number, m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
const endOfDay = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) + DAY_MS - 1;
const endOfMonth = (y: number, m: number) => Date.UTC(y, m, 1) - 1;
const yearOk = (y: number) => y >= 1990 && y <= 2099;

interface Found {
	text: string;
	at: number;
	ended: number;
	k: StaleKind;
}

/**
 * Past event dates and ended year-bound phrases in plain text. `now` decides what is past. Pure.
 */
export function findStale(text: string, now: number): StaleHit[] {
	const t = (text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text).replace(/\s+/g, " ");
	const found: Found[] = [];
	const thisYear = new Date(now).getUTCFullYear();
	const before = (at: number) => t.slice(Math.max(0, at - 60), at);
	// Event words count within the same sentence only (up to 80 characters either side).
	const near = (at: number, len: number) => {
		const pre = t.slice(Math.max(0, at - 80), at);
		const post = t.slice(at + len, at + len + 80);
		const cut = pre.search(/[.!?]\s(?!.*[.!?]\s)/);
		const end = post.search(/[.!?](?:\s|$)/);
		return `${cut >= 0 ? pre.slice(cut + 2) : pre} ${end >= 0 ? post.slice(0, end) : post}`;
	};
	const history = (at: number) => HISTORY.test(before(at));
	const push = (f: Found) => {
		if (found.some((x) => x.at < f.at + f.text.length && f.at < x.at + x.text.length)) return;
		found.push(f);
	};

	// "Saturday, March 3, 2024", "March 3rd 2024", "Sat 3 March 2024", "3. März 2024", "3 de marzo de 2024"
	const wd = `(?:(${WEEKDAYS})\\.?,?\\s+(?:the\\s+)?)?`;
	const mdY = new RegExp(`\\b${wd}(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "giu");
	const dmY = new RegExp(`\\b${wd}(\\d{1,2})(?:st|nd|rd|th|\\.)?\\s+(?:of\\s+|de\\s+)?(${MONTH_RE})\\.?,?\\s+(?:de\\s+)?(\\d{4})\\b`, "giu");
	for (const [re, order] of [
		[mdY, "md"],
		[dmY, "dm"],
	] as const) {
		for (const m of t.matchAll(re)) {
			const weekday = m[1];
			const month = MONTHS[(order === "md" ? m[2] : m[3])?.toLowerCase() ?? ""] ?? 0;
			const day = Number(order === "md" ? m[3] : m[2]);
			const year = Number(m[4]);
			if (!month || !yearOk(year) || !validDay(year, month, day)) continue;
			const ended = endOfDay(year, month, day);
			const at = m.index ?? 0;
			if (ended >= now || history(at)) continue;
			// "May" is also a word: only with a weekday or an event word.
			if (!weekday && !EVENT.test(near(at, m[0].length))) continue;
			push({ text: m[0], at, ended, k: "date" });
		}
	}

	// Numeric 03/04/2024 or 03.04.2024 (never with dashes: phone numbers). Not inside longer numbers, prices or versions.
	for (const m of t.matchAll(/(?<![\w.,/$€£+-])(\d{1,2})([/.])(\d{1,2})\2(\d{4})(?![\d.,/]\d)/g)) {
		const a = Number(m[1]);
		const b = Number(m[3]);
		const year = Number(m[4]);
		if (!yearOk(year)) continue;
		const readings = [validDay(year, a, b) ? endOfDay(year, a, b) : undefined, validDay(year, b, a) ? endOfDay(year, b, a) : undefined].filter((x): x is number => x !== undefined);
		if (!readings.length) continue;
		const ended = Math.max(...readings);
		const at = m.index ?? 0;
		if (ended >= now || history(at) || !EVENT.test(near(at, m[0].length))) continue;
		push({ text: m[0], at, ended, k: "date" });
	}

	// "March 2024" (no day): only next to an event word.
	for (const m of t.matchAll(new RegExp(`\\b(${MONTH_RE})\\.?,?\\s+(\\d{4})\\b`, "giu"))) {
		const month = MONTHS[(m[1] ?? "").toLowerCase()] ?? 0;
		const year = Number(m[2]);
		if (!month || !yearOk(year) || (m[1] ?? "").length < 3) continue;
		const ended = endOfMonth(year, month);
		const at = m.index ?? 0;
		if (ended >= now || history(at) || !EVENT.test(near(at, m[0].length))) continue;
		push({ text: m[0], at, ended, k: "date" });
	}

	// Seasons and holidays with a year: "Summer 2023", "Black Friday 2024".
	const SEASON_END: Record<string, [number, number, number]> = { spring: [0, 5, 31], summer: [0, 8, 31], fall: [0, 11, 30], autumn: [0, 11, 30], winter: [1, 2, 28], holiday: [0, 12, 31], holidays: [0, 12, 31], christmas: [0, 12, 31], xmas: [0, 12, 31], easter: [0, 4, 30], thanksgiving: [0, 11, 30], "black friday": [0, 11, 30], "cyber monday": [0, 12, 5], valentine: [0, 2, 14], "valentine's": [0, 2, 14], "valentines": [0, 2, 14], "valentine's day": [0, 2, 14], "new year": [0, 1, 31], "new year's": [0, 1, 31], "back to school": [0, 9, 30] };
	for (const m of t.matchAll(/\b(spring|summer|fall|autumn|winter|holidays?|christmas|xmas|easter|thanksgiving|black friday|cyber monday|valentine(?:'s|s)?(?: day)?|new year(?:'s)?|back to school)\s+(20\d{2})\b/gi)) {
		const key = (m[1] ?? "").toLowerCase().replace(/’/g, "'");
		const end = SEASON_END[key] ?? SEASON_END[key.replace(/ day$/, "")];
		const year = Number(m[2]);
		if (!end) continue;
		const ended = endOfDay(year + end[0], end[1], end[2]);
		const at = m.index ?? 0;
		if (ended >= now || history(at)) continue;
		push({ text: m[0], at, ended, k: "phrase" });
	}

	// "2024 offer", "2023 class schedule", "schedule for 2023", "Pricing 2024": a year that has ended.
	const NOUNS = "offers?|specials?|deals?|sales?|promos?|promotions?|discounts?|season|schedule|timetable|programs?|programmes?|class schedule|classes|pricing|prices|price list|rates|menu|catalog(?:ue)?|events?|calendar|edition|registration|camps?|retreats?|workshops?|tours?|festival|line-?up|collection|newsletter";
	for (const re of [new RegExp(`\\b(20\\d{2})\\s+(?:${NOUNS})\\b`, "gi"), new RegExp(`\\b(?:${NOUNS})\\s+(?:for\\s+)?(20\\d{2})\\b`, "gi")]) {
		for (const m of t.matchAll(re)) {
			const year = Number(m[1]);
			const at = m.index ?? 0;
			if (year >= thisYear || history(at)) continue;
			push({ text: m[0], at, ended: Date.UTC(year, 11, 31), k: "phrase" });
		}
	}

	// "© 2023", "Copyright 2019–2023", "(c) 2022": the last year shown is before this year.
	for (const m of t.matchAll(/(?:©|\(c\)|copyright)\s*(?:©\s*)?(?:(\d{4})\s*[-–—]\s*)?(\d{4})\b/gi)) {
		const year = Number(m[2]);
		if (!yearOk(year) || year >= thisYear) continue;
		push({ text: m[0], at: m.index ?? 0, ended: Date.UTC(year, 11, 31), k: "phrase" });
	}

	return found
		.sort((a, b) => a.at - b.at)
		.slice(0, STALE_PER_PAGE)
		.map((f) => ({ k: f.k, text: f.text.length > 80 ? `${f.text.slice(0, 79)}…` : f.text, ended: iso(f.ended) }));
}

/** Plain text of a page for freshness: its <main> (else the body without header, nav and footer), without <time>, post cards and comments. */
export function freshnessText(html: string): { main: string; body: string } {
	const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
	const strip = (s: string) =>
		decode(
			s
				.replace(/<!--[\s\S]*?-->/g, " ")
				.replace(/<(script|style|noscript|template|svg|time)\b[\s\S]*?<\/\1>/gi, " ")
				.replace(/<section\b[^>]*\bid=["']?comments\b[\s\S]*?<\/section>/gi, " ")
				.replace(/<article\b[^>]*\bclass=["'][^"']*\bpost-card\b[\s\S]*?<\/article>/gi, " ")
				// The end of a paragraph, heading, list item or block ends a sentence (history and event words stay in theirs).
				.replace(/<\/(p|h[1-6]|li|div|section|article|header|footer|td|th|dd|dt|blockquote|figcaption)\s*>|<br\s*\/?>/gi, " . ")
				.replace(/<[^>]+>/g, " "),
		)
			.replace(/\s+/g, " ")
			.trim();
	const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(body)?.[1];
	return { main: strip(main ?? body.replace(/<(header|nav|footer)\b[\s\S]*?<\/\1>/gi, " ")), body: strip(body) };
}

/** Freshness findings of one page's HTML: dates and phrases in the main content, the copyright line anywhere. Pure. */
export function inspectFreshness(html: string, now: number): StaleHit[] {
	if (!html) return [];
	const { main, body } = freshnessText(html);
	const hits = findStale(main, now);
	for (const h of findStale(body, now)) if (/^(?:©|\(c\)|copyright)/i.test(h.text) && !hits.some((x) => x.text === h.text)) hits.push(h);
	return hits.slice(0, STALE_PER_PAGE);
}

/** String fields of an entry's data (portable text spans included); addresses, ids, styles and colours left out. Pure. */
export function entryText(data: unknown, max = 50_000): string {
	const out: string[] = [];
	let size = 0;
	const SKIP = /^(_key|_type|_id|id|slug|href|url|src|link|anchor|style|class|classname|color|colour|background|icon|variant|layout|align|tone|space|width|height|mime|alt|locale|lang|translation_group|status|created_at|updated_at|published_at|date|datetime|start|end|ref|asset)$/i;
	const visit = (v: unknown, key: string, depth: number) => {
		if (size >= max || depth > 12) return;
		if (typeof v === "string") {
			if (SKIP.test(key) || /^(https?:|\/|#|mailto:|tel:|data:)/i.test(v) || v.length < 3) return;
			const s = v.includes("<") ? v.replace(/<[^>]+>/g, " ") : v;
			out.push(s);
			size += s.length;
		} else if (Array.isArray(v)) for (const x of v) visit(x, key, depth + 1);
		else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) visit(x, k, depth + 1);
	};
	visit(data, "", 0);
	return decode(out.join(" . ")).slice(0, max);
}

/** The months-ago cut-off: a page last saved before this is "not updated". Pure. */
export function staleCutoff(now: number, months: number): number {
	const d = new Date(now);
	return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, d.getUTCDate());
}

/** Groups per-page findings by kind + words across pages; the entry is attached when one known page has it. Pure. */
export function groupStale(pages: Record<string, StaleHit[] | undefined>, order: string[], entries: Map<string, { collection: string; id: string }> = new Map()): StaleItem[] {
	const byKey = new Map<string, StaleItem>();
	for (const path of order) {
		for (const h of pages[path] ?? []) {
			const words = h.text.replace(/\s+/g, " ").trim();
			const key = h.k === "old" ? `old\u0000${path}` : `${h.k}\u0000${words.toLowerCase()}`;
			const it = byKey.get(key) ?? { id: itemId("stale", key), k: h.k, text: words, ...(h.ended ? { ended: h.ended } : {}), pages: [] };
			if (!it.pages.includes(path)) it.pages.push(path);
			byKey.set(key, it);
		}
	}
	const rank: Record<StaleKind, number> = { date: 0, phrase: 1, old: 2 };
	return [...byKey.values()]
		.map((it) => {
			const e = it.pages.length === 1 ? entries.get(it.pages[0] as string) : undefined;
			return e ? { ...it, entry: e } : it;
		})
		.sort((a, b) => rank[a.k] - rank[b.k] || b.pages.length - a.pages.length || (a.ended ?? "").localeCompare(b.ended ?? ""))
		.slice(0, MAX_STALE_ITEMS);
}
