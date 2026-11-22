/**
 * Accessibility and content freshness ("page review"): built once a week when the visual check finishes, from what it
 * already fetched (checks/visual.ts keeps each page's findings in the job) plus one `ctx.content.list` pass over the
 * freshness collections (default pages; posts are left out on purpose — old posts are fine). No extra page request.
 *
 * Stored in plugin KV `review` (bounded: ≤ 60 accessibility items, ≤ 60 freshness items, ≤ 25 pages each, short
 * strings) and shown on Site health → Accessibility and → Content freshness; both feed "What to improve" (improve.ts)
 * and so the monthly report. No email alert (weekly noise). Admins can dismiss an item for a period (KV
 * `review:dismissed`, ≤ 200 entries, expired ones dropped on every write).
 */
import { type A11yHit, type A11yItem, groupA11y } from "./checks/a11y.js";
import { entryText, findStale, groupStale, isRarelyChanged, STALE_MONTHS, type StaleHit, type StaleItem, staleCutoff } from "./checks/freshness.js";
import type { ContentLister } from "./run.js";

/** Collections freshness reads: pages only (old posts are fine by design). */
export const FRESHNESS_COLLECTIONS = ["pages"];

export interface ReviewStore {
	v: 1;
	at: string;
	/** Pages whose HTML was read (the visual check's pages that answered 200). */
	pages: number;
	a11y: A11yItem[];
	stale: StaleItem[];
	/** Freshness: the "not updated" threshold used (0 = off), whether the content could be read, legal pages skipped. */
	staleMonths: number;
	content: boolean;
	skipped: number;
	/** The accessibility rules ran (HealthOptions.accessibility, default on). */
	accessibility: boolean;
	/** The editor entry of each listed page that is a known entry (path → collection and id), for "Edit" links. */
	edit?: Record<string, { collection: string; id: string }>;
}

export const readReview = (v: unknown): ReviewStore | null => {
	const s = v as ReviewStore | null;
	return s && typeof s === "object" && s.v === 1 && Array.isArray(s.a11y) && Array.isArray(s.stale) ? s : null;
};

/** Per page as the visual job keeps them (KV `visual:job`, between ticks). */
export interface PageNotes {
	a11y?: A11yHit[];
	stale?: StaleHit[];
}

export interface Entry {
	collection: string;
	id: string;
	path: string;
	updatedAt?: string;
	/** Past dates and ended phrases found in the entry's text fields. */
	stale: StaleHit[];
}

const norm = (p: string) => p.replace(/\/+$/, "") || "/";
const COPYRIGHT = /^(?:©|\(c\)|copyright)/i;
/** An entry's address: the kit keeps the WordPress path as the slug; the front page is "home" (starter entryHref). */
export const slugPath = (slug: string | null | undefined) => {
	const s = String(slug ?? "").replace(/^\/+|\/+$/g, "");
	return !s || s === "home" ? "/" : `/${s}`;
};

/** Published entries of the freshness collections (≤ 3 × 100 each), with their stale text findings. Never throws. */
export async function listEntries(content: ContentLister | undefined, collections: string[], now: number): Promise<{ entries: Entry[]; read: boolean }> {
	const entries: Entry[] = [];
	let read = false;
	if (!content) return { entries, read };
	for (const collection of collections) {
		try {
			let cursor: string | undefined;
			for (let page = 0; page < 3; page++) {
				const r = await content.list(collection, { limit: 100, ...(cursor ? { cursor } : {}) });
				read = true;
				for (const item of r.items) {
					if (item.status && item.status !== "published") continue;
					const path = slugPath(item.slug);
					entries.push({ collection, id: item.id, path, ...(item.updatedAt ? { updatedAt: item.updatedAt } : {}), stale: isRarelyChanged(path) ? [] : findStale(entryText(item.data), now) });
				}
				if (!r.hasMore || !r.cursor) break;
				cursor = r.cursor;
			}
		} catch {
			// A collection this site does not have: skip.
		}
	}
	return { entries, read };
}

/**
 * The review from the visual job's per-page notes and the entries. HTML findings of pages that are not entries of
 * the freshness collections (posts, archives) are dropped when the content could be read; legal and thank-you pages
 * never count. Pure.
 */
export function buildReview(o: { notes: Record<string, PageNotes>; order: string[]; entries: Entry[]; contentRead: boolean; now: number; staleMonths?: number; accessibility?: boolean }): ReviewStore {
	const months = o.staleMonths ?? STALE_MONTHS;
	const byPath = new Map(o.entries.map((e) => [norm(e.path), e]));
	const a11y: Record<string, A11yHit[]> = {};
	const stale: Record<string, StaleHit[]> = {};
	const order: string[] = [];
	let skipped = 0;
	const addOrder = (p: string) => {
		if (!order.includes(p)) order.push(p);
	};
	for (const path of o.order) {
		const n = o.notes[path];
		if (!n) continue;
		addOrder(path);
		if (o.accessibility !== false && n.a11y?.length) a11y[path] = n.a11y;
		const rare = isRarelyChanged(path);
		if (rare) skipped++;
		const known = byPath.has(norm(path));
		// The copyright line is site-wide (footer): kept on any page; other findings only on pages of the collections.
		const keep = (n.stale ?? []).filter((h) => !rare && (known || !o.contentRead || COPYRIGHT.test(h.text)));
		if (keep.length) stale[path] = keep;
	}
	const cutoff = months > 0 ? staleCutoff(o.now, months) : undefined;
	// Entries use the visual check's spelling of the path when it read the page ("/about/" rather than "/about").
	const noteKey = new Map(Object.keys(o.notes).map((p) => [norm(p), p]));
	const keyOf = (e: Entry) => noteKey.get(norm(e.path)) ?? e.path;
	for (const e of o.entries) {
		const key = keyOf(e);
		if (isRarelyChanged(e.path)) {
			if (!o.notes[key]) skipped++;
			continue;
		}
		const list = stale[key] ?? [];
		for (const h of e.stale) if (!list.some((x) => x.k === h.k && x.text.toLowerCase() === h.text.toLowerCase())) list.push(h);
		if (cutoff !== undefined && e.updatedAt && Date.parse(e.updatedAt) < cutoff) list.push({ k: "old", text: e.updatedAt.slice(0, 10) });
		if (list.length) {
			stale[key] = list;
			addOrder(key);
		}
	}
	const entryOf = new Map(o.entries.map((e) => [keyOf(e), { collection: e.collection, id: e.id }]));
	const a11yItems = groupA11y(a11y, order);
	const staleItems = groupStale(stale, order, entryOf);
	const listed = new Set([...a11yItems.flatMap((x) => x.pages), ...staleItems.flatMap((x) => x.pages)]);
	const edit = Object.fromEntries([...listed].flatMap((p) => (entryOf.has(p) ? [[p, entryOf.get(p) as { collection: string; id: string }]] : [])));
	return {
		v: 1,
		at: new Date(o.now).toISOString(),
		pages: Object.keys(o.notes).length,
		a11y: a11yItems,
		stale: staleItems,
		staleMonths: months,
		content: o.contentRead,
		skipped,
		accessibility: o.accessibility !== false,
		...(Object.keys(edit).length ? { edit } : {}),
	};
}

// ── Dismissals ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface Dismissal {
	until: string;
	at: string;
	/** What was dismissed, as shown then (for the "Dismissed" list; ≤ 120 characters). */
	label: string;
}
export interface Dismissed {
	v: 1;
	items: Record<string, Dismissal>;
}

/** Dismiss periods offered (days): 3 months, a year, "for good" (5 years). */
export const DISMISS_DAYS = [90, 365, 1825] as const;
export const MAX_DISMISSED = 200;
const ID = /^[0-9a-z]{4,16}$/;

export const readDismissed = (v: unknown): Dismissed => {
	const d = v as Dismissed | null;
	return d && typeof d === "object" && d.v === 1 && d.items && typeof d.items === "object" ? d : { v: 1, items: {} };
};

/** "abc1234:90" from the Dismiss menu → id and days; anything else undefined. */
export function parseDismissValue(v: unknown): { id: string; days: number } | undefined {
	if (typeof v !== "string" || v.length > 40) return undefined;
	const m = /^([0-9a-z]{4,16}):(\d{1,4})$/.exec(v);
	const days = Number(m?.[2]);
	return m && (DISMISS_DAYS as readonly number[]).includes(days) ? { id: m[1] as string, days } : undefined;
}

/** Adds a dismissal; expired ones dropped, then the oldest beyond MAX_DISMISSED. Pure. */
export function dismiss(d: Dismissed, id: string, days: number, label: string, now: number): Dismissed {
	if (!ID.test(id)) return d;
	const live = Object.entries(d.items).filter(([k, x]) => k !== id && Date.parse(x.until) > now);
	live.push([id, { until: new Date(now + days * 86_400_000).toISOString(), at: new Date(now).toISOString(), label: label.slice(0, 120) }]);
	live.sort(([, a], [, b]) => (a.at < b.at ? 1 : -1));
	return { v: 1, items: Object.fromEntries(live.slice(0, MAX_DISMISSED)) };
}

/** Restores one dismissed item, or all. Pure. */
export function restore(d: Dismissed, id: string | "all", now: number): Dismissed {
	return { v: 1, items: id === "all" ? {} : Object.fromEntries(Object.entries(d.items).filter(([k, x]) => k !== id && Date.parse(x.until) > now)) };
}

export const isDismissed = (d: Dismissed | null | undefined, id: string, now: number) => {
	const x = d?.items[id];
	return !!x && Date.parse(x.until) > now;
};

/** The review without the items an admin dismissed (still within their period). Pure. */
export function activeReview(r: ReviewStore | null, d: Dismissed | null | undefined, now: number): ReviewStore | null {
	if (!r) return null;
	return { ...r, a11y: r.a11y.filter((x) => !isDismissed(d, x.id, now)), stale: r.stale.filter((x) => !isDismissed(d, x.id, now)) };
}
