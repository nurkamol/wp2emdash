/**
 * Missing pages: the addresses visitors asked for that do not exist, from EmDash's own 404 log (`_emdash_404_log`,
 * migration 035: one row per path with a running `hits` count, `last_seen_at` and the latest referrer — EmDash's
 * redirect middleware writes it on every 404, with the path only: never the query string). Hourly, one D1 read, no
 * request. The most requested paths seen in the last 7 days, the two trailing-slash forms of an address counted as one
 * (EmDash's redirects match both), each with a suggested redirect target:
 *
 *   wordpress  the address was a page of the old WordPress site and moved at the migration (HealthOptions `oldUrls`,
 *              written by the kit's scaffold into the plugin options of the generated project)
 *   spelling   the same address as a page apart from capitals, `.html` / `.php` or a `/page/2/` ending
 *   date       a WordPress date-based post address (`/2024/05/my-post/`) whose slug is a page now
 *   slug       a page with the same last segment
 *   words      the page sharing most words (half or more)
 *
 * Targets are pages of the sitemap (the site's published content). Bot probes (wp-login.php, .env, xmlrpc…) and junk
 * are counted, not listed. Only path, count, last time and the referrer's host are kept: never an IP address or a user
 * agent (EmDash keeps those in its own log; they are not read). Never alerts: it is a to-do list.
 */
import type { D1Like } from "@wp2emdash/seo/analytics/store";
import type { CheckState } from "../store.js";
import { DAY, hash32 } from "../util.js";

export interface NotFoundRow {
	path: string;
	hits: number;
	lastSeen: string;
	referrer?: string | null;
}

export type SuggestWhy = "wordpress" | "spelling" | "date" | "slug" | "words";

export interface NotFoundEntry {
	path: string;
	hits: number;
	lastSeen: string;
	/** Host of the latest referrer (never the full address). */
	from?: string;
	/** Summaries stored before 0.9 kept the full referrer; read for its host only. */
	referrer?: string | null;
	/** A page of the sitemap the address probably meant. */
	suggest?: string;
	/** Why that page (see the module comment). */
	why?: SuggestWhy;
	/** The address was a page of the old WordPress site that was not carried over (removed at the migration). */
	removed?: true;
}

export interface NotFoundSummary {
	at: string;
	/** Most requested missing addresses seen in the last 7 days (bot probes, redirected and dismissed ones left out), with suggestions. */
	top: NotFoundEntry[];
	/** Paths seen this week that are bot probes or junk (not listed). */
	probes: number;
	/** Addresses an admin dismissed (still within their period), left out. */
	dismissed?: number;
}

/** Old WordPress address → its path on the new site at launch ("" = not carried over). HealthOptions `oldUrls`. */
export type OldUrls = Record<string, string>;

/** A path seen at least this often in the week needs a look (a redirect, or a fixed link). */
export const NOTFOUND_WARN_HITS = 3;
export const NOTFOUND_WINDOW = 7 * DAY;
/** Rows listed (after grouping and filtering). */
export const NOTFOUND_MAX = 20;

/**
 * Requests that only scanners make: WordPress logins and internals (also under a sub-directory), PHP and other server
 * scripts, dot-files, archives and backups, other software's admin panels and the usual device / framework probes.
 */
const PROBE = /(?:(?:^|\/)(?:wp-(?:admin|login|includes|content\/(?:plugins|themes|upgrade|debug)|json|config|cron|signup|trackback|links-opml)|xmlrpc|cgi-bin|phpmyadmin|pma|myadmin|adminer|administrator|vendor\/phpunit|boaform|hnap1|actuator|telescope|_profiler|server-status|autodiscover|owa|ecp|remote\/login|solr|webdav|sftp-config|_ignition)(?:$|[/.?])|\.(?:php\d?|phtml|aspx?|ashx|asmx|jsp|cgi|pl|env|ini|sql|bak|old|orig|save|swp|zip|tar|gz|tgz|rar|7z|git|svn|hg|ds_store|log|yml|yaml|toml|conf|cfg|pem|key|sh|exe|dll)(?:$|\/)|\/\.(?!well-known\/))/i;
export const isProbe = (path: string) => PROBE.test(path);

/** Not a real visitor's address: a probe, too long, control characters or markup (injection attempts). */
export function isJunk(path: string): boolean {
	if (!path.startsWith("/") || path.length > 300 || isProbe(path)) return true;
	let s = path;
	try {
		s = decodeURIComponent(path);
	} catch {
		return true;
	}
	return /[\u0000-\u001f\u007f<>"'`{}\\]/.test(s) || /\b(?:select|union|script|onerror|alert)\b.*[(=]/i.test(s) || isProbe(s);
}

export async function readNotFound(db: D1Like | undefined, since: string, limit = 60): Promise<NotFoundRow[] | undefined> {
	// Path, count, time and the latest referrer only: EmDash's user_agent and ip columns are never read.
	const prep = db?.prepare("SELECT path, hits, COALESCE(last_seen_at, created_at) AS last_seen, referrer FROM _emdash_404_log WHERE COALESCE(last_seen_at, created_at) >= ? ORDER BY hits DESC LIMIT ?") as unknown as { bind?(...v: unknown[]): { all?<T>(): Promise<{ results?: T[] }> } } | undefined;
	const stmt = prep?.bind?.(since, limit);
	if (!stmt?.all) return undefined;
	try {
		return ((await stmt.all<{ path: string; hits: number; last_seen: string; referrer: string | null }>()).results ?? []).map((r) => ({ path: r.path, hits: Number(r.hits) || 1, lastSeen: r.last_seen, referrer: r.referrer }));
	} catch {
		return undefined;
	}
}

/** The path as EmDash's redirect middleware matches it: with or without the trailing slash. */
const strip = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") || "/" : p);

/** The host of a referrer ("" for none or an unreadable one). */
export function referrerHost(r: string | null | undefined): string {
	if (!r) return "";
	try {
		return new URL(r).host.toLowerCase();
	} catch {
		return "";
	}
}

/**
 * The two trailing-slash forms of an address as one row (EmDash's redirects match both): hits added, the latest time,
 * the spelling asked for most, the latest referrer's host. Most hits first. Pure.
 */
export function groupNotFound(rows: NotFoundRow[]): NotFoundEntry[] {
	const by = new Map<string, { e: NotFoundEntry; best: number; latest: string }>();
	for (const r of rows) {
		const k = strip(r.path);
		const g = by.get(k);
		const host = referrerHost(r.referrer);
		if (!g) {
			by.set(k, { e: { path: r.path, hits: r.hits, lastSeen: r.lastSeen, ...(host ? { from: host } : {}) }, best: r.hits, latest: r.lastSeen });
			continue;
		}
		g.e.hits += r.hits;
		if (r.hits > g.best) {
			g.best = r.hits;
			g.e.path = r.path;
		}
		if (r.lastSeen > g.latest) {
			g.latest = r.lastSeen;
			g.e.lastSeen = r.lastSeen;
			if (host) g.e.from = host;
		}
	}
	return [...by.values()].map((g) => g.e).sort((a, b) => b.hits - a.hits || (a.lastSeen < b.lastSeen ? 1 : -1));
}

/** Decoded, lower case, no query, no `/page/N`, `.html` / `.php` or trailing slash. */
export const normPath = (p: string) => {
	let s = p;
	try {
		s = decodeURIComponent(p);
	} catch {}
	return s.toLowerCase().split("?")[0]?.replace(/\/(?:page\/\d+|amp|feed)\/?$/, "/").replace(/\.(?:html?|php)$/, "").replace(/\/+$/, "") || "/";
};
const lastOf = (p: string) => normPath(p).split("/").pop() as string;
const depth = (p: string) => normPath(p).split("/").length;
const words = (p: string) => new Set(normPath(p).split(/[/\-_.]+/).filter((w) => w.length > 1 && !/^\d+$/.test(w)));
/** `/2024/05/slug`, `/2024/05/12/slug` (WordPress date permalinks; also under a base such as /blog/). */
const DATED = /(?:^|\/)\d{4}\/\d{2}(?:\/\d{2})?\/([^/]+)$/;

/** Old WordPress addresses, normalized, for exact lookups. */
export function oldUrlIndex(old: OldUrls | undefined): Map<string, string> {
	const m = new Map<string, string>();
	for (const [from, to] of Object.entries(old ?? {})) if (typeof to === "string" && from.startsWith("/")) m.set(normPath(from), to);
	return m;
}

export interface Suggestion {
	to?: string;
	why?: SuggestWhy;
	/** A page of the old WordPress site that was not carried over. */
	removed?: true;
}

/** The shallowest page with this last segment. */
const bySegment = (seg: string, pages: string[]) => (seg ? pages.filter((p) => lastOf(p) === seg).sort((a, b) => depth(a) - depth(b))[0] : undefined);

/**
 * The page a missing address probably meant, and why: the old WordPress address list first (exact, normalized), then
 * the same address in other spelling, a date-based post address by its slug, the same last segment, the most shared
 * words (half or more). Never the address itself. Pure.
 */
export function suggestTarget(path: string, sitePaths: string[], old?: Map<string, string>): Suggestion {
	const key = normPath(path);
	if (key === "/") return {};
	const pages = sitePaths.filter((p) => strip(p) !== strip(path));
	const out: Suggestion = {};
	const was = old?.get(key);
	if (was !== undefined) {
		if (!was) out.removed = true;
		else {
			// Moved at the migration: its new page, or (renamed since) the page with that page's last segment.
			const exact = pages.find((p) => strip(p) === strip(was)) ?? pages.find((p) => normPath(p) === normPath(was)) ?? bySegment(lastOf(was), pages);
			if (exact) return { to: exact, why: "wordpress" };
		}
	}
	const spelled = pages.find((p) => normPath(p) === key);
	if (spelled) return { ...out, to: spelled, why: "spelling" };
	const dated = DATED.exec(key)?.[1];
	const post = dated ? bySegment(dated, pages) : undefined;
	if (post) return { ...out, to: post, why: "date" };
	const same = bySegment(lastOf(path), pages.filter((p) => normPath(p) !== key));
	if (same) return { ...out, to: same, why: "slug" };
	const w = words(path);
	let best: { path: string; score: number } | undefined;
	if (w.size)
		for (const p of pages) {
			const o = words(p);
			if (!o.size) continue;
			const shared = [...w].filter((x) => o.has(x)).length;
			const score = shared / new Set([...w, ...o]).size;
			if (shared && score >= 0.5 && (!best || score > best.score)) best = { path: p, score };
		}
	return best ? { ...out, to: best.path, why: "words" } : out;
}

/** The sitemap page a missing address probably meant (see suggestTarget). */
export const suggestRedirect = (path: string, sitePaths: string[], old?: OldUrls) => suggestTarget(path, sitePaths, oldUrlIndex(old)).to;

/** Stable short id of a missing address (both trailing-slash forms), for Dismiss. */
export const notFoundId = (path: string) => `n${hash32(strip(path)).toString(36).padStart(7, "0")}`;

export interface SummarizeOptions {
	max?: number;
	oldUrls?: OldUrls;
	/** Addresses to leave out (dismissed by an admin); they are counted in `dismissed`. */
	skip?: (path: string) => boolean;
}

export function summarizeNotFound(rows: NotFoundRow[], sitePaths: string[], at: string, o: SummarizeOptions = {}): NotFoundSummary {
	const real = rows.filter((r) => !isJunk(r.path));
	const grouped = groupNotFound(real);
	const shown = o.skip ? grouped.filter((r) => !o.skip?.(r.path)) : grouped;
	const old = oldUrlIndex(o.oldUrls);
	const top = shown.slice(0, o.max ?? NOTFOUND_MAX).map((r) => {
		const s = suggestTarget(r.path, sitePaths, old);
		return { ...r, ...(s.to ? { suggest: s.to, why: s.why } : {}), ...(s.removed ? { removed: true as const } : {}) };
	});
	const dismissed = grouped.length - shown.length;
	return { at, top, probes: rows.length - real.length, ...(dismissed ? { dismissed } : {}) };
}

/** Plain words for a suggestion's reason (admin table). */
export const WHY_TEXT: Record<SuggestWhy, string> = {
	wordpress: "Old WordPress address",
	spelling: "Same address, other spelling",
	date: "Old dated post address",
	slug: "Same last part",
	words: "Similar words",
};

const n = (x: number, one: string, many = `${one}s`) => `${x} ${x === 1 ? one : many}`;

export function notFoundCheck(s: NotFoundSummary | undefined, at: string): CheckState {
	if (!s) return { status: "unknown", summary: "EmDash's 404 log could not be read.", at };
	const busy = s.top.filter((r) => r.hits >= NOTFOUND_WARN_HITS);
	const detail = [...(s.probes ? [`${n(s.probes, "bot probe")} left out (wp-login.php, .env and similar).`] : []), ...(s.dismissed ? [`${n(s.dismissed, "dismissed address", "dismissed addresses")} left out.`] : [])];
	if (!s.top.length) return { status: "ok", summary: "No missing pages were requested in the last 7 days.", at, ...(detail.length ? { detail } : {}) };
	if (!busy.length) return { status: "ok", summary: `${n(s.top.length, "missing address", "missing addresses")} requested this week, none often. See the Missing pages tab.`, at, ...(detail.length ? { detail } : {}) };
	const suggested = busy.filter((r) => r.suggest).length;
	return { status: "warn", summary: `${n(busy.length, "missing address", "missing addresses")} requested ${NOTFOUND_WARN_HITS}+ times and still asked for this week${suggested ? ` (${suggested} with a suggested redirect)` : ""}. See the Missing pages tab: create the redirect there in one click.`, at, detail: [...busy.slice(0, 3).map((r) => `${r.path} (${r.hits}×${r.suggest ? ` → ${r.suggest}` : ""})`), ...detail] };
}
