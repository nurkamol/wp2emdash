/**
 * "What to improve this month": at most six plain-language to-dos for the site owner, most important first, each
 * with how many pages (or addresses, or pictures) it concerns, up to three of them by name, and the admin page that
 * fixes it. Built from what the checks and the other kit plugins already keep — nothing is fetched or analysed here:
 *
 *   backups      the Backups check (@wp2emdash/backups heartbeat)                     sites with backups on
 *   media        the Media Assistant's scan counts (broken pictures, missing alt text,
 *                oversized originals; D1 row plugin:media-assistant:summary)           sites with the Media Assistant
 *   seo          the SEO suite's cached page analysis (thin pages, missing meta
 *                descriptions, focus keyword, pictures without description; D1 row
 *                plugin:site-seo:summary, or the one the monthly report calculated)    sites with the SEO suite
 *   notfound     the week's missing addresses without a redirect (EmDash's 404 log)    every site
 *   speed        Chrome UX Report p75 (poor or needs improvement)                     when Google has data
 *   forms        form message COUNTS of the month against the month before            sites with the form outbox
 *   visual       the weekly visual check's last run: main pages broken or changed      every site (when it ran)
 *   a11y-wide    accessibility issues on many of the checked pages (menu, footer…)    every site (review.ts)
 *   a11y         accessibility issues on one or a few pages                           every site (review.ts)
 *   stale        past event dates and ended year-bound phrases on pages               every site (review.ts)
 *   old          pages not saved for 18 months (never posts or legal pages)           every site (review.ts)
 *
 * Form messages: only the two monthly totals are compared; no message is read. Pure (`improvements`), so ranking, caps
 * and wording are unit-tested.
 */
import type { SeoSummary } from "@wp2emdash/seo/summary";
import type { MediaSummary } from "./checks/media.js";
import { NOTFOUND_WARN_HITS, type NotFoundSummary } from "./checks/notfound.js";
import { A11Y_RULES, isSiteWide } from "./checks/a11y.js";
import { rate, type Rating } from "./checks/speed.js";
import type { ReviewStore } from "./review.js";
import type { CheckState, Cwv } from "./store.js";
import { plural } from "./util.js";

export const MAX_IMPROVEMENTS = 6;
/** Pages or addresses named per item; the rest are counted ("and 4 more"). */
export const MAX_NAMED = 3;
/** Form messages "dropped": at most half of the month before, which had at least this many. */
export const FORMS_DROP_MIN = 5;

export type ImproveId = "visual" | "backups" | "broken-images" | "speed" | "notfound" | "forms" | "thin" | "description" | "alt" | "oversized" | "keyword" | "a11y-wide" | "a11y" | "stale" | "old";

/** Where an item is fixed: a plugin's admin page (`/_emdash/admin/plugins/<plugin><path>`), on Site health a tab. */
export interface ImproveLink {
	plugin: string;
	path: string;
	label: string;
	/** Site health's own tab (the admin switches to it instead of opening a new page). */
	tab?: "missing" | "speed" | "visual" | "accessibility" | "freshness";
	/** An EmDash admin screen instead of a plugin page (`/_emdash/admin<admin>`), e.g. a page's editor `/content/pages/<id>`. */
	admin?: string;
}

export interface Improvement {
	id: ImproveId;
	/** Rank: higher first (fixed per kind; the count breaks ties). */
	impact: number;
	/** One plain sentence. */
	text: string;
	count: number;
	/** Up to MAX_NAMED page titles or addresses, and how many more there are. */
	names?: { label: string; items: string[]; more: number };
	link: ImproveLink;
}

export interface ImproveInputs {
	/** The Backups check; undefined: backups are off for this site. */
	backups?: CheckState;
	/** The Media Assistant's counts; undefined / null: no Media Assistant or not scanned yet. */
	media?: MediaSummary | null;
	/** The SEO suite's summary; undefined / null: no SEO suite or not analysed yet. */
	seo?: SeoSummary | null;
	notFound?: NotFoundSummary | null;
	cwv?: Cwv | null;
	/** Form message counts: the month and the month before (counts only); undefined: no form outbox. */
	forms?: { total: number; previous?: number };
	/** The visual check's latest run: paths of pages with something broken, and of pages that changed (checks/visual.ts). */
	visual?: { problems: string[]; changes: string[] } | null;
	/** Accessibility and freshness (review.ts), without the items an admin dismissed. */
	review?: ReviewStore | null;
}

export const LINKS = {
	health: (tab: ImproveLink["tab"], label: string): ImproveLink => ({ plugin: "site-health", path: "/health", label, ...(tab ? { tab } : {}) }),
	seo: { plugin: "site-seo", path: "/seo", label: "Open SEO" } as ImproveLink,
	/** SEO fix-it (@wp2emdash/seo ≥ 0.6): drafts missing descriptions (and focus keywords) for review. */
	seoFixit: { plugin: "site-seo", path: "/seo-fixit", label: "Draft them with SEO fix-it" } as ImproveLink,
	media: { plugin: "media-assistant", path: "/media", label: "Open Media" } as ImproveLink,
	forms: { plugin: "site-forms", path: "/messages", label: "Open Form messages" } as ImproveLink,
	backups: { plugin: "site-backups", path: "/backups", label: "Open Backups" } as ImproveLink,
};

/** The admin address of a link, on the given origin (the production URL in emails, the admin's own origin in the admin). */
export const improveUrl = (origin: string, l: ImproveLink) => `${URL.canParse(origin) ? new URL(origin).origin : origin.replace(/\/$/, "")}/_emdash/admin${l.admin ?? `/plugins/${l.plugin}${l.path}`}`;

/** A page's editor in the EmDash admin (admin route `/content/$collection/$id`, @emdash-cms/admin 1.5). */
export const editLink = (entry: { collection: string; id: string }, label = "Edit the page"): ImproveLink => ({ plugin: "site-health", path: "/health", label, admin: `/content/${encodeURIComponent(entry.collection)}/${encodeURIComponent(entry.id)}` });

/** The one line shown when nothing needs doing. */
export const NOTHING_TO_IMPROVE = "Nothing needs fixing this month: the site is in good shape.";

const names = (label: string, all: string[], count = all.length) => (all.length ? { label, items: all.slice(0, MAX_NAMED), more: Math.max(0, count - Math.min(all.length, MAX_NAMED)) } : undefined);
const these = (n: number, one: string, many: string) => (n === 1 ? one : many);

function speedItem(cwv: Cwv | null | undefined): Improvement | undefined {
	if (!cwv || cwv.missing) return undefined;
	const parts: { r: Rating; text: string }[] = [];
	if (cwv.lcp !== undefined) parts.push({ r: rate("lcp", cwv.lcp), text: `pages take ${(cwv.lcp / 1000).toFixed(1)} seconds to show their main content` });
	if (cwv.inp !== undefined) parts.push({ r: rate("inp", cwv.inp), text: `buttons and menus take ${cwv.inp} ms to respond` });
	if (cwv.cls !== undefined) parts.push({ r: rate("cls", cwv.cls), text: "pages jump around while they load" });
	const bad = parts.filter((p) => p.r !== "good");
	if (!bad.length) return undefined;
	const poor = bad.some((p) => p.r === "poor");
	const list = bad.map((p) => p.text).join(", and ");
	return {
		id: "speed",
		impact: poor ? 85 : 50,
		text: poor ? `Real visitors find the site slow (Google's measurement): ${list}. Slow pages lose visitors and rank lower.` : `The site could be faster for real visitors (Google's measurement): ${list}.`,
		count: bad.length,
		link: LINKS.health("speed", "See Speed"),
	};
}

/** The list, most important first, at most MAX_IMPROVEMENTS. Empty: nothing to improve. */
export function improvements(i: ImproveInputs): Improvement[] {
	const out: Improvement[] = [];
	const b = i.backups;
	if (b && (b.status === "fail" || b.status === "warn")) out.push({ id: "backups", impact: 100, text: "Backups are not working: recent changes to the site are not safely copied. Check the Backups page, or ask your developer.", count: 1, link: LINKS.backups });
	const v = i.visual;
	if (v?.problems.length) out.push({ id: "visual", impact: 95, text: `${plural(v.problems.length, "main page")} ${these(v.problems.length, "looks", "look")} broken: an error, pictures or styles that do not load, a missing font or an empty page (the weekly visual check). Have ${these(v.problems.length, "it", "them")} fixed.`, count: v.problems.length, names: names("Pages", v.problems), link: LINKS.health("visual", "See Visual check") });
	else if (v?.changes.length) out.push({ id: "visual", impact: 55, text: `${plural(v.changes.length, "main page")} ${these(v.changes.length, "looks", "look")} different from before (sections, pictures, text or headings changed). Check ${these(v.changes.length, "it", "them")}; if the change was intended, accept the new look on the Visual check tab.`, count: v.changes.length, names: names("Pages", v.changes), link: LINKS.health("visual", "See Visual check") });
	const m = i.media;
	if (m?.broken) out.push({ id: "broken-images", impact: 90, text: `${plural(m.broken, "place")} on the site ${these(m.broken, "shows a picture", "show pictures")} that no longer ${these(m.broken, "exists", "exist")}. Replace or remove ${these(m.broken, "it", "them")}.`, count: m.broken, link: LINKS.media });
	const speed = speedItem(i.cwv);
	if (speed) out.push(speed);
	const busy = (i.notFound?.top ?? []).filter((r) => r.hits >= NOTFOUND_WARN_HITS);
	if (busy.length) out.push({ id: "notfound", impact: 70, text: `Visitors keep arriving at ${plural(busy.length, "address", "addresses")} that ${these(busy.length, "no longer exists", "no longer exist")}. Send ${these(busy.length, "it", "each one")} to the right page with a redirect.`, count: busy.length, names: names("Addresses", busy.map((r) => r.path)), link: LINKS.health("missing", "See Missing pages") });
	const f = i.forms;
	if (f && f.previous !== undefined && f.previous >= FORMS_DROP_MIN && f.total * 2 <= f.previous) out.push({ id: "forms", impact: 65, text: `Form messages fell from ${f.previous} to ${f.total} compared with the month before. Send yourself a test message to make sure the forms still work.`, count: f.total, link: LINKS.forms });
	const s = i.seo;
	if (s?.thin.count) out.push({ id: "thin", impact: 60, text: `${plural(s.thin.count, "page")} ${these(s.thin.count, "has", "have")} too little text for Google to show ${these(s.thin.count, "it", "them")} in search. Add a few paragraphs: what you offer, who it is for and common questions.`, count: s.thin.count, names: names("Pages", s.thin.pages.map((p) => p.title), s.thin.count), link: LINKS.seo });
	if (s?.noDescription.count) out.push({ id: "description", impact: 50, text: `${plural(s.noDescription.count, "page")} ${these(s.noDescription.count, "has", "have")} no search description, so Google picks a random snippet. Write one or two sentences for each.`, count: s.noDescription.count, names: names("Pages", s.noDescription.pages, s.noDescription.count), link: LINKS.seoFixit });
	// Pictures without a description: the Media Assistant's count when it runs (its page fixes them), else the SEO suite's.
	const altCount = m ? m.missingAltUsed : (s?.missingAlt.count ?? 0);
	if (altCount) out.push({ id: "alt", impact: 40, text: `${plural(altCount, "picture")} on your pages ${these(altCount, "has", "have")} no description for people who cannot see ${these(altCount, "it", "them")} (it also helps Google Images). Add a short sentence to each.`, count: altCount, ...(s?.missingAlt.pages.length ? { names: names("On", s.missingAlt.pages) } : {}), link: m ? LINKS.media : LINKS.seo });
	if (m?.oversized) out.push({ id: "oversized", impact: 35, text: `${plural(m.oversized, "picture")} ${these(m.oversized, "is", "are")} much bigger than ${these(m.oversized, "it needs", "they need")} to be and ${these(m.oversized, "slows", "slow")} pages down. Shrink ${these(m.oversized, "it", "them")} on the Media page.`, count: m.oversized, link: LINKS.media });
	if (s?.keyword.count) out.push({ id: "keyword", impact: 25, text: `${plural(s.keyword.count, "page")} ${these(s.keyword.count, "does", "do")} not use ${these(s.keyword.count, "its", "their")} focus keyword where Google looks first (title, description, main heading).`, count: s.keyword.count, names: names("Pages", s.keyword.pages, s.keyword.count), link: LINKS.seo });
	out.push(...reviewItems(i.review));
	return out.sort((a, b) => b.impact - a.impact || b.count - a.count).slice(0, MAX_IMPROVEMENTS);
}

/** "Links without a name (12 pages)". */
const ruleLine = (r: keyof typeof A11Y_RULES, pages: number) => `${A11Y_RULES[r].label} (${plural(pages, "page")})`;

/**
 * Accessibility and freshness items: an issue on many checked pages (usually the menu or footer) ranks above issues
 * on single pages; past dates sit in the middle, "not updated" pages low. Pure.
 */
function reviewItems(r: ReviewStore | null | undefined): Improvement[] {
	if (!r) return [];
	const out: Improvement[] = [];
	const wide = r.a11y.filter((x) => isSiteWide(x, r.pages));
	const few = r.a11y.filter((x) => !isSiteWide(x, r.pages));
	if (wide.length) {
		const rules = [...new Set(wide.map((x) => x.r))];
		out.push({ id: "a11y-wide", impact: 62, text: `${plural(wide.length, "accessibility issue")} ${these(wide.length, "appears", "appear")} on many pages (usually the menu, the footer or a repeated section), so every visitor using a screen reader or keyboard meets ${these(wide.length, "it", "them")}. Fixing ${these(wide.length, "it", "them")} once fixes every page.`, count: wide.length, names: names("Issues", rules.map((rule) => ruleLine(rule, Math.max(...wide.filter((x) => x.r === rule).map((x) => x.pages.length))))), link: LINKS.health("accessibility", "See Accessibility") });
	}
	if (few.length) {
		const pages = [...new Set(few.flatMap((x) => x.pages))];
		const one = pages.length === 1 ? r.edit?.[pages[0] as string] : undefined;
		out.push({ id: "a11y", impact: 44, text: `${plural(few.length, "accessibility issue")} on ${plural(pages.length, "page")}: ${[...new Set(few.map((x) => A11Y_RULES[x.r].label.toLowerCase()))].slice(0, 3).join(", ")}. Some visitors cannot use ${these(pages.length, "this page", "these pages")} fully.`, count: few.length, names: names("Pages", pages), link: one ? editLink(one) : LINKS.health("accessibility", "See Accessibility") });
	}
	const dated = r.stale.filter((x) => x.k !== "old");
	if (dated.length) {
		const pages = [...new Set(dated.flatMap((x) => x.pages))];
		const entry = pages.length === 1 ? dated.find((x) => x.entry)?.entry : undefined;
		out.push({ id: "stale", impact: 42, text: `${plural(pages.length, "page")} still ${these(pages.length, "mentions", "mention")} dates or offers that have passed (for example “${dated[0]?.text}”). Update or remove them so visitors do not think the site is abandoned.`, count: dated.length, names: names("Pages", pages), link: entry ? editLink(entry) : LINKS.health("freshness", "See Content freshness") });
	}
	const old = r.stale.filter((x) => x.k === "old");
	if (old.length) {
		const pages = old.flatMap((x) => x.pages);
		const entry = old.length === 1 ? old[0]?.entry : undefined;
		out.push({ id: "old", impact: 20, text: `${plural(old.length, "page")} ${these(old.length, "has", "have")} not been updated for ${r.staleMonths} months or more. Read ${these(old.length, "it", "them")} through: opening hours, prices and team members change.`, count: old.length, names: names("Pages", pages), link: entry ? editLink(entry, "Open the page") : LINKS.health("freshness", "See Content freshness") });
	}
	return out;
}

/** "Pages: Home, About, Classes and 2 more" (plain text). */
export function namesLine(x: Improvement): string {
	if (!x.names) return "";
	return `${x.names.label}: ${x.names.items.join(", ")}${x.names.more ? ` and ${x.names.more} more` : ""}`;
}
