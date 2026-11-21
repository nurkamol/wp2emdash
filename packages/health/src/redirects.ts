/**
 * One-click redirects from the Missing pages tab, written into EmDash's own redirects (Redirects in the admin) through
 * the plugin capability `redirects:write` → `ctx.redirects` (EmDash 1.5 `createRedirectAccess`: the same handler as
 * `POST /_emdash/api/redirects`, with its write lock, loop check, duplicate check and the published redirect artifacts
 * the redirect middleware reads; docs/spikes/health-findings.md). EmDash stores site-relative paths only, so a full
 * address is accepted only on this site's own host and stored as its path.
 *
 * `checkRedirect` is pure: it validates what the admin asked for against the sitemap and the redirects that exist.
 */
import type { NotFoundSummary } from "./checks/notfound.js";
import { DAY } from "./util.js";

/** The fields of an EmDash redirect this module reads (EmDash `RedirectInfo`). */
export interface RedirectLike {
	id?: string;
	source: string;
	destination: string;
	enabled?: boolean;
	isPattern?: boolean;
}

/** The part of EmDash's `ctx.redirects` used here (`RedirectAccessWithWrite`). */
export interface RedirectsAccess {
	list(o?: { limit?: number; cursor?: string; search?: string }): Promise<{ items: RedirectLike[]; cursor?: string; hasMore?: boolean }>;
	create?(input: { source: string; destination?: string; type?: 301 | 302 | 307 | 308; enabled?: boolean; groupName?: string | null }): Promise<{ redirect: RedirectLike }>;
}

/** Group name of the redirects made here (Redirects → filter by group). */
export const REDIRECT_GROUP = "site-health";
/** Redirected addresses kept out of the list for this long (the 404 log's window), at most this many. */
export const REDIRECTED_KEEP = 8 * DAY;
export const REDIRECTED_MAX = 200;

export type Redirected = Record<string, { to: string; at: string }>;

/** A path as EmDash's redirect middleware matches it: with or without the trailing slash. */
export const samePath = (a: string, b: string) => strip(a) === strip(b);
const strip = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") || "/" : p);

const PATH = /^\/(?!\/)[^\s?#\\]*$/;
/** Browsers drop tabs and line breaks inside a URL: refuse every control character. */
const CONTROL = /[\u0000-\u001f\u007f]/;

function pathError(p: string, what: string): string | undefined {
	if (!p) return `${what}: write an address that starts with /.`;
	if (p.length > 500) return `${what}: too long.`;
	if (CONTROL.test(p) || !PATH.test(p)) return `${what}: write a path on this site that starts with / (no spaces, ? or #).`;
	let decoded = p;
	try {
		decoded = decodeURIComponent(p);
	} catch {
		return `${what}: the address is not valid.`;
	}
	if (decoded.split("/").includes("..")) return `${what}: the address is not valid.`;
	if (p.startsWith("/_emdash") || p.startsWith("/_astro/") || p === "/_image") return `${what}: EmDash's own addresses cannot be redirected.`;
	return undefined;
}

export interface RedirectRequest {
	source: unknown;
	target: unknown;
	/** The sitemap's paths (Site health reads it hourly). */
	sitePaths: string[];
	/** Hosts a full address may use: the production host and the address the admin is on. */
	siteHosts: string[];
	/** Redirects that exist with this source or target (from `findRelated`). */
	existing: RedirectLike[];
}

export type RedirectCheck = { ok: true; source: string; destination: string } | { ok: false; error: string };

/**
 * The source must be a path that is not a page of the site; the target a page in the sitemap (a path, or a full https
 * address on this site); not the same address; no redirect from the source yet; the target not redirected itself (a
 * chain or a loop). EmDash checks loops and duplicates again when it stores the redirect.
 */
export function checkRedirect(r: RedirectRequest): RedirectCheck {
	const source = typeof r.source === "string" ? r.source.trim() : "";
	const raw = typeof r.target === "string" ? r.target.trim() : "";
	const sErr = pathError(source, "Missing address");
	if (sErr) return { ok: false, error: sErr };
	let target = raw;
	if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) {
		if (!URL.canParse(raw)) return { ok: false, error: "Redirect to: the address is not valid." };
		const u = new URL(raw);
		const hosts = r.siteHosts.map((h) => h.toLowerCase().replace(/^www\./, ""));
		if (u.protocol !== "https:") return { ok: false, error: "Redirect to: use an https:// address, or a path on this site such as /about/." };
		if (!hosts.includes(u.hostname.toLowerCase().replace(/^www\./, ""))) return { ok: false, error: "Redirect to: EmDash's Redirects only send visitors to pages of this site. Pick a page of this site (a link to another website belongs on a page)." };
		if (u.search || u.hash) return { ok: false, error: "Redirect to: leave out ? and # parts." };
		target = u.pathname;
	}
	const tErr = pathError(target, "Redirect to");
	if (tErr) return { ok: false, error: tErr };
	if (!r.sitePaths.length) return { ok: false, error: "The site's page list (sitemap) has not been read yet. Run checks now, then try again." };
	const page = r.sitePaths.find((p) => samePath(p, target));
	if (!page) return { ok: false, error: `Redirect to: ${target} is not a page of this site (not in the sitemap). Pick one from the list.` };
	if (samePath(source, page)) return { ok: false, error: "The missing address and the page it redirects to must differ." };
	if (r.sitePaths.some((p) => samePath(p, source))) return { ok: false, error: `${source} is a page of this site: redirecting it would hide that page.` };
	if (r.existing.some((e) => samePath(e.source, source))) return { ok: false, error: `A redirect from ${source} exists already (see Redirects).` };
	if (r.existing.some((e) => e.enabled !== false && !e.isPattern && samePath(e.source, page))) return { ok: false, error: `${page} is itself redirected elsewhere: pick the page it leads to instead.` };
	return { ok: true, source, destination: page };
}

/** Redirects whose source or destination mentions one of the paths (EmDash's list search, a LIKE on both; ≤ 3 pages each). */
export async function findRelated(access: RedirectsAccess, paths: string[]): Promise<RedirectLike[]> {
	const out = new Map<string, RedirectLike>();
	for (const p of new Set(paths.map(strip))) {
		let cursor: string | undefined;
		for (let page = 0; page < 3; page++) {
			const r = await access.list({ limit: 100, search: p, ...(cursor ? { cursor } : {}) });
			for (const x of r.items) out.set(x.id ?? `${x.source}\u0000${x.destination}`, x);
			if (!r.hasMore || !r.cursor) break;
			cursor = r.cursor;
		}
	}
	return [...out.values()];
}

/** Every redirect source (for leaving redirected addresses out of the weekly list); at most 1,000. */
export async function redirectSources(access: RedirectsAccess): Promise<string[]> {
	const out: string[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < 10; page++) {
		const r = await access.list({ limit: 100, ...(cursor ? { cursor } : {}) });
		out.push(...r.items.filter((x) => !x.isPattern).map((x) => x.source));
		if (!r.hasMore || !r.cursor) break;
		cursor = r.cursor;
	}
	return out;
}

/** Records a redirect made here; keeps REDIRECTED_KEEP and at most REDIRECTED_MAX. Pure. */
export function addRedirected(map: Redirected | null, source: string, to: string, now: number): Redirected {
	const entries = Object.entries(map ?? {}).filter(([, v]) => now - Date.parse(v.at) < REDIRECTED_KEEP);
	entries.push([source, { to, at: new Date(now).toISOString() }]);
	return Object.fromEntries(entries.slice(-REDIRECTED_MAX));
}

/** The list without addresses that now redirect (made here, or any EmDash redirect source). Pure. */
export function withoutRedirected(s: NotFoundSummary, sources: Iterable<string>): NotFoundSummary {
	const list = [...sources];
	return { ...s, top: s.top.filter((r) => !list.some((x) => samePath(x, r.path))) };
}
