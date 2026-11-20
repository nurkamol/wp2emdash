/**
 * Every address the old site answered must be accounted for on the new one (verify gate `urls-accounted`):
 * 200 (mapped content), one 301/308 to an address that answers 200, or 404/410 only where a decision says the content
 * is gone — overrides.ts `gone` patterns, the site's WordPress-URL rule set (ir/wp-urls.json, the same rules the
 * middleware applies), or a `skip` decision for the post type / taxonomy / authors behind the URL.
 *
 * The list: the audit's URLs (pages, redirects, files), every entry, term, author and attachment page REST discovery
 * found, the upload files the old pages used, and WordPress's own forms of them (feeds, search, ?p=, ?page_id=, ?cat=,
 * ?tag=, ?author=, ?attachment_id=, date archives). WordPress internals (/wp-admin, /wp-json…) are the wp-endpoints check.
 */
import type { Overrides } from "../config/overrides.js";
import { matchWpUrl, wpQueryKey, type WpUrlRules } from "../../starter/src/utils/wp-urls.js";

export interface AccountUrl {
	/** Path + query on the site. */
	path: string;
	/** What it is: page, post, <post type>, attachment, category, tag, <taxonomy>, author, date, feed, comments-feed, search, query, upload, file. */
	kind: string;
	/** Post type (entries, their ?p= form) or taxonomy (terms), for skip decisions. */
	type?: string;
	taxonomy?: string;
}

export interface Probe {
	status: number;
	location?: string;
	/** Status of the redirect target (one hop). */
	next?: number;
	error?: string;
}

export interface Judged extends AccountUrl {
	status: number;
	ok: boolean;
	/** How it is accounted for, or why not. */
	why: string;
}

const INTERNAL = /^\/(?:wp-admin|wp-login\.php|xmlrpc\.php|wp-json|wp-includes|wp-cron\.php|wp-content\/(?:plugins|themes|cache)|cdn-cgi)(?:[/?]|$)/;

export interface UniverseInput {
	/** snapshot/urls.json */
	urls: { url: string; path: string; status: number; kind: string; contentType?: string; wp?: { id: number; type: string } }[];
	/** snapshot/discovery.json */
	discovery?: {
		items?: { id: number; type: string; link: string }[];
		terms?: { id: number; taxonomy: string; slug: string; link: string; count: number }[];
		authors?: { id: number; slug: string; link: string }[];
		media?: { id: number; link: string; sourceUrl: string }[];
	};
	/** Images, og:images and links of the saved pages (upload files the old pages used). */
	pageAssets: string[];
	/** Published posts' dates (extract) for date archives. */
	postDates?: string[];
	siteHosts: Set<string>;
	/** Query forms checked per type / taxonomy (a sample keeps a large site fast). */
	sample?: number;
	/** The site's WordPress-URL rules: name the kind of audited URLs WordPress did not label (feeds, archives). */
	rules?: WpUrlRules;
}

const pathOf = (u: string, hosts?: Set<string>): string | undefined => {
	try {
		const x = new URL(u, "https://site.invalid");
		if (hosts && x.host !== "site.invalid" && !hosts.has(x.host.replace(/^www\./, ""))) return undefined;
		return `${x.pathname}${x.search}`;
	} catch {
		return undefined;
	}
};

/** Every URL the new site must account for, deduplicated (first classification wins: discovery is more specific). */
export function accountUniverse(input: UniverseInput): AccountUrl[] {
	const hosts = new Set([...input.siteHosts].map((h) => h.replace(/^www\./, "")));
	const out = new Map<string, AccountUrl>();
	const add = (u: AccountUrl) => {
		if (INTERNAL.test(u.path) || out.has(u.path)) return;
		out.set(u.path, u);
	};
	const n = input.sample ?? 10;
	const d = input.discovery ?? {};
	for (const i of d.items ?? []) {
		const p = pathOf(i.link, hosts);
		if (p) add({ path: p, kind: i.type, type: i.type });
	}
	const byType = new Map<string, typeof d.items>();
	for (const i of d.items ?? []) byType.set(i.type, [...(byType.get(i.type) ?? []), i]);
	for (const [type, list] of byType) for (const i of (list ?? []).slice(0, n)) add({ path: type === "page" ? `/?page_id=${i.id}` : `/?p=${i.id}`, kind: "query", type });
	const byTax = new Map<string, NonNullable<typeof d.terms>>();
	for (const t of (d.terms ?? []).filter((x) => x.count > 0)) {
		const p = pathOf(t.link, hosts);
		if (p) add({ path: p, kind: t.taxonomy === "post_tag" ? "tag" : t.taxonomy, taxonomy: t.taxonomy });
		byTax.set(t.taxonomy, [...(byTax.get(t.taxonomy) ?? []), t]);
	}
	// Blog sites: archive feeds are real feeds (a sample per taxonomy and author).
	if (input.rules?.blog) {
		for (const [tax, list] of byTax) for (const t of list.slice(0, n)) {
			const p = pathOf(t.link, hosts);
			if (p) add({ path: `${p.split("?")[0]?.replace(/\/?$/, "/")}feed/`, kind: "feed", taxonomy: tax });
		}
		for (const a of (d.authors ?? []).slice(0, n)) {
			const p = pathOf(a.link, hosts);
			if (p) add({ path: `${p.split("?")[0]?.replace(/\/?$/, "/")}feed/`, kind: "feed" });
		}
	}
	for (const t of (byTax.get("category") ?? []).slice(0, n)) add({ path: `/?cat=${t.id}`, kind: "query", taxonomy: "category" });
	for (const t of (byTax.get("post_tag") ?? []).slice(0, n)) add({ path: `/?tag=${t.slug}`, kind: "query", taxonomy: "post_tag" });
	for (const a of d.authors ?? []) {
		const p = pathOf(a.link, hosts);
		if (p) add({ path: p, kind: "author" });
		add({ path: `/?author=${a.id}`, kind: "query" });
	}
	for (const [i, m] of (d.media ?? []).entries()) {
		const p = pathOf(m.link, hosts);
		const file = pathOf(m.sourceUrl, hosts);
		if (p && p !== file && p !== "/") add({ path: p, kind: "attachment" });
		if (i < n) add({ path: `/?attachment_id=${m.id}`, kind: "query" });
	}
	for (const u of input.urls) {
		if (u.status === 0 || u.status >= 400) continue; // already broken on WordPress: nothing to keep
		const p = u.path;
		const [pathname, query = ""] = p.split("?") as [string, string?];
		const ruled = input.rules ? matchWpUrl(pathname, new URLSearchParams(query), input.rules)?.kind : undefined;
		const blogFeed = !ruled && !!input.rules?.blog && /\/feed\/?$/.test(pathname);
		const kind = u.wp?.type ?? (blogFeed ? "feed" : ruled && ruled !== "wp-id" ? ruled : u.kind === "non-html" ? (/\/wp-content\/uploads\//.test(p) ? "upload" : "file") : u.kind === "redirect" ? "redirect" : "page");
		add({ path: p, kind, ...(u.wp?.type ? { type: u.wp.type } : {}) });
	}
	for (const a of input.pageAssets) {
		const p = pathOf(a, hosts);
		if (p && /^\/(?:wp-content\/uploads|storage)\/\d{4}\/\d{2}\/[^/]+$/.test(p.split("?")[0] as string)) add({ path: p.split("?")[0] as string, kind: "upload" });
	}
	for (const [path, kind] of [["/feed/", "feed"], ["/?feed=rss2", "feed"], ["/comments/feed/", "comments-feed"], ["/?s=wp2emdash", "search"]] as const) add({ path, kind });
	const months = new Set((input.postDates ?? []).map((x) => /^(\d{4})-(\d{2})/.exec(x)).filter((m): m is RegExpExecArray => !!m).map((m) => `/${m[1]}/${m[2]}/`));
	for (const m of [...months].slice(0, n)) {
		add({ path: m, kind: "date" });
		add({ path: m.slice(0, 6), kind: "date" });
	}
	return [...out.values()];
}

const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*")}$`);

export interface JudgeContext {
	rules?: WpUrlRules;
	wpIds?: Record<string, string>;
	overrides: Pick<Overrides, "gone" | "contentTypes" | "taxonomies" | "authors">;
	/** Addresses of migrated custom post type entries and archives: real routes, only a 200 accounts for them. */
	realRoutes?: Set<string>;
}

/** Accounted for or not, and why. */
export function judgeUrl(u: AccountUrl, probe: Probe, ctx: JudgeContext): Judged {
	const res = (ok: boolean, why: string): Judged => ({ ...u, status: probe.status, ok, why });
	const [pathname, query = ""] = u.path.split("?") as [string, string?];
	const goneBy = Object.entries(ctx.overrides.gone).find(([pattern]) => glob(pattern).test(pattern.includes("?") ? u.path : pathname));
	const params = new URLSearchParams(query);
	const action = ctx.rules ? matchWpUrl(pathname, params, ctx.rules, ctx.wpIds) : undefined;
	if (probe.error) return res(false, `request failed: ${probe.error}`);
	// Blog sites: the posts page, archives and their feeds are real routes: only a 200 accounts for them.
	const blogRoute = !!ctx.rules?.blog && !action && !params.size && (["feed", "category", "tag", "author"].includes(u.kind) || !!u.taxonomy);
	if (blogRoute && probe.status !== 200) return res(false, `blog ${u.kind} answers ${probe.status}${probe.location ? ` → ${probe.location}` : ""} (a real route: 200 expected)`);
	const norm = (p: string) => (p === "/" ? "/" : `${p.replace(/\/+$/, "")}/`);
	if (ctx.realRoutes && !params.size && [...ctx.realRoutes].some((r) => norm(r) === norm(pathname)) && probe.status !== 200) return res(false, `migrated entry or archive answers ${probe.status}${probe.location ? ` → ${probe.location}` : ""} (a real route: 200 expected)`);
	if (probe.status === 200) {
		// The home page answering a WordPress query (?s=, ?cat=, ?p=…) has ignored it: that is not the content.
		if (pathname === "/" && wpQueryKey(params)) return goneBy ? res(true, `gone by decision (${goneBy[1]})`) : res(false, `answers the home page; ?${wpQueryKey(params)}= ignored`);
		return res(true, "200");
	}
	if (probe.status === 301 || probe.status === 308) {
		if (probe.next === 200) return res(true, `${probe.status} → ${probe.location} (200)`);
		return res(false, `${probe.status} → ${probe.location ?? "?"} answers ${probe.next ?? "nothing"}`);
	}
	if (probe.status === 302 || probe.status === 307) return res(false, `temporary redirect (${probe.status}) → ${probe.location ?? "?"}`);
	if (probe.status === 404 || probe.status === 410) {
		if (goneBy) return res(true, `gone by decision: ${goneBy[1]}`);
		if (action && "gone" in action) return res(true, `gone by rule (${action.kind})`);
		const skip = (u.type && ctx.overrides.contentTypes[u.type]?.as === "skip" ? `${u.type}: ${ctx.overrides.contentTypes[u.type]?.reason}` : undefined) ?? (u.taxonomy && ctx.overrides.taxonomies[u.taxonomy] ? `${u.taxonomy}: ${ctx.overrides.taxonomies[u.taxonomy]?.reason}` : undefined) ?? (u.kind === "author" && ctx.overrides.authors ? `authors: ${ctx.overrides.authors.reason}` : undefined);
		if (skip) return res(true, `not migrated by decision (${skip})`);
		return res(false, `${probe.status}, no decision`);
	}
	return res(false, `HTTP ${probe.status}`);
}

/** One request without following redirects; HEAD first, GET when HEAD is not answered as a page would be. */
export async function probeUrl(fetchFn: typeof fetch, base: string, path: string): Promise<Probe> {
	const once = async (url: string): Promise<{ status: number; location?: string }> => {
		let res = await fetchFn(url, { method: "HEAD", redirect: "manual" });
		await res.body?.cancel();
		if (![200, 301, 308, 410].includes(res.status)) {
			res = await fetchFn(url, { redirect: "manual" });
			await res.body?.cancel();
		}
		const location = res.headers.get("location") ?? undefined;
		return { status: res.status, ...(location ? { location } : {}) };
	};
	try {
		const first = await once(`${base}${path}`);
		if (first.status !== 301 && first.status !== 308) return first;
		const next = first.location ? await once(new URL(first.location, `${base}${path}`).href) : undefined;
		return { ...first, ...(next ? { next: next.status } : {}) };
	} catch (e) {
		return { status: 0, error: (e as Error).message.split("\n")[0] };
	}
}

/** Gate detail: unaccounted URLs grouped by kind with counts and examples; else the tally. */
export function accountDetail(judged: Judged[]): string {
	const bad = judged.filter((j) => !j.ok);
	const group = (list: Judged[]) => {
		const by = new Map<string, Judged[]>();
		for (const j of list) by.set(j.kind, [...(by.get(j.kind) ?? []), j]);
		return [...by].sort((a, b) => b[1].length - a[1].length);
	};
	if (bad.length) return `${bad.length} of ${judged.length} unaccounted — ${group(bad).map(([k, l]) => `${k} ${l.length}: ${l.slice(0, 3).map((j) => `${j.path} (${j.why})`).join(", ")}${l.length > 3 ? ", …" : ""}`).join("; ")}`;
	return `${judged.length} URLs: ${group(judged).map(([k, l]) => `${k} ${l.length}`).join(", ")}`;
}
