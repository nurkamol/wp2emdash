/**
 * Missing pages: the addresses visitors asked for that do not exist, from EmDash's own 404 log (`_emdash_404_log`,
 * migration 035: one row per path with a running `hits` count, `last_seen_at` and the latest referrer — EmDash's
 * redirect middleware writes it on every 404). Hourly, one D1 read, no request. The most requested paths seen in the last
 * 7 days, each with a suggested redirect target from the sitemap (same last segment, else the closest by words), so an
 * editor can add the redirect in Redirects. Bot probes (wp-login.php, .env, xmlrpc…) are counted, not listed. Never
 * alerts: it is a to-do list.
 */
import type { D1Like } from "@wp2emdash/seo/analytics/store";
import type { CheckState } from "../store.js";
import { DAY } from "../util.js";

export interface NotFoundRow {
	path: string;
	hits: number;
	lastSeen: string;
	referrer?: string | null;
}

export interface NotFoundEntry extends NotFoundRow {
	/** A page of the sitemap the address probably meant. */
	suggest?: string;
}

export interface NotFoundSummary {
	at: string;
	/** Most requested missing addresses seen in the last 7 days (bot probes left out), with suggestions. */
	top: NotFoundEntry[];
	/** Paths seen this week that are bot probes (not listed). */
	probes: number;
}

/** A path seen at least this often in the week needs a look (a redirect, or a fixed link). */
export const NOTFOUND_WARN_HITS = 3;
export const NOTFOUND_WINDOW = 7 * DAY;

/** Requests that only scanners make: WordPress logins, PHP files, dot-files, archives, admin panels of other software. */
const PROBE = /(?:^\/(?:wp-(?:admin|login|includes|content\/plugins|json)|xmlrpc|cgi-bin|phpmyadmin|pma|admin(?:istrator)?\/|vendor\/)|\.(?:php\d?|aspx?|jsp|cgi|env|ini|sql|bak|old|zip|tar|gz|rar|7z|git|svn|ds_store|log|yml|yaml)(?:$|\/)|\/\.(?!well-known\/))/i;
export const isProbe = (path: string) => PROBE.test(path);

export async function readNotFound(db: D1Like | undefined, since: string, limit = 60): Promise<NotFoundRow[] | undefined> {
	const prep = db?.prepare("SELECT path, hits, COALESCE(last_seen_at, created_at) AS last_seen, referrer FROM _emdash_404_log WHERE COALESCE(last_seen_at, created_at) >= ? ORDER BY hits DESC LIMIT ?") as unknown as { bind?(...v: unknown[]): { all?<T>(): Promise<{ results?: T[] }> } } | undefined;
	const stmt = prep?.bind?.(since, limit);
	if (!stmt?.all) return undefined;
	try {
		return ((await stmt.all<{ path: string; hits: number; last_seen: string; referrer: string | null }>()).results ?? []).map((r) => ({ path: r.path, hits: Number(r.hits) || 1, lastSeen: r.last_seen, referrer: r.referrer }));
	} catch {
		return undefined;
	}
}

const norm = (p: string) => {
	let s = p;
	try {
		s = decodeURIComponent(p);
	} catch {}
	return s.toLowerCase().split("?")[0]?.replace(/\/page\/\d+\/?$/, "/").replace(/\.(?:html?|php)$/, "").replace(/\/+$/, "") || "/";
};
const words = (p: string) => new Set(norm(p).split(/[/\-_.]+/).filter((w) => w.length > 1 && !/^\d+$/.test(w)));

/** The sitemap page a missing address probably meant: the same last segment, else the most shared words (half or more). */
export function suggestRedirect(path: string, sitePaths: string[]): string | undefined {
	const target = norm(path);
	if (target === "/") return undefined;
	const last = target.split("/").pop() as string;
	const pages = sitePaths.filter((p) => norm(p) !== target);
	const sameLast = pages.find((p) => norm(p).split("/").pop() === last && last !== "");
	if (sameLast) return sameLast;
	const w = words(path);
	if (!w.size) return undefined;
	let best: { path: string; score: number } | undefined;
	for (const p of pages) {
		const o = words(p);
		if (!o.size) continue;
		const shared = [...w].filter((x) => o.has(x)).length;
		const score = shared / new Set([...w, ...o]).size;
		if (shared && score >= 0.5 && (!best || score > best.score)) best = { path: p, score };
	}
	return best?.path;
}

export function summarizeNotFound(rows: NotFoundRow[], sitePaths: string[], at: string, max = 20): NotFoundSummary {
	const real = rows.filter((r) => !isProbe(r.path));
	return { at, top: real.slice(0, max).map((r) => ({ ...r, ...(suggestRedirect(r.path, sitePaths) ? { suggest: suggestRedirect(r.path, sitePaths) } : {}) })), probes: rows.length - real.length };
}

const n = (x: number, one: string, many = `${one}s`) => `${x} ${x === 1 ? one : many}`;

export function notFoundCheck(s: NotFoundSummary | undefined, at: string): CheckState {
	if (!s) return { status: "unknown", summary: "EmDash's 404 log could not be read.", at };
	const busy = s.top.filter((r) => r.hits >= NOTFOUND_WARN_HITS);
	const detail = s.probes ? [`${n(s.probes, "bot probe")} left out (wp-login.php, .env and similar).`] : [];
	if (!s.top.length) return { status: "ok", summary: "No missing pages were requested in the last 7 days.", at, ...(detail.length ? { detail } : {}) };
	if (!busy.length) return { status: "ok", summary: `${n(s.top.length, "missing address", "missing addresses")} requested this week, none often. See the Missing pages tab.`, at, ...(detail.length ? { detail } : {}) };
	const suggested = busy.filter((r) => r.suggest).length;
	return { status: "warn", summary: `${n(busy.length, "missing address", "missing addresses")} requested ${NOTFOUND_WARN_HITS}+ times and still asked for this week${suggested ? ` (${suggested} with a suggested redirect)` : ""}. See the Missing pages tab and add redirects in Redirects.`, at, detail: [...busy.slice(0, 3).map((r) => `${r.path} (${r.hits}×${r.suggest ? ` → ${r.suggest}` : ""})`), ...detail] };
}
