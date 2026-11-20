/**
 * WordPress addresses the new site has no page for — feeds, search, category/tag/author/date archives, attachment
 * pages and the query forms (`/?s=`, `?cat=`, `?tag=`, `?author=`, `?attachment_id=`, `?feed=`, `?m=`, unknown `?p=`).
 * The rule set is decided per site at transform time (src/transform/wp-urls.ts, from what the audit found and the
 * owner's overrides) and written into site.config.json `wpUrls` by scaffold; the middleware answers with one 301 or a
 * 410, and verify's `urls-accounted` check judges every audited URL with the same function.
 *
 * No imports here: this file must load in Node (kit, tests) and in the Worker (starter).
 */

/** A path on the new site to 301 to (e.g. "/", "/search/"), or "gone" (410). */
export type WpUrlTarget = string;

export type WpUrlKind = "feed" | "comments-feed" | "search" | "category" | "tag" | "author" | "date" | "attachment" | "paged" | "wp-id";

export interface WpAttachment {
	/** The attachment page's own path on WordPress (`/photo-name/`, `/parent/photo-name/`). */
	path?: string;
	/** The parent page's path on the new site, when the parent was migrated. */
	parent?: string;
	/** Original file name in the media library (the middleware looks it up like an old upload URL). */
	file?: string;
}

export interface WpUrlRules {
	feed: WpUrlTarget;
	commentsFeed: WpUrlTarget;
	search: WpUrlTarget;
	category: WpUrlTarget;
	tag: WpUrlTarget;
	author: WpUrlTarget;
	date: WpUrlTarget;
	/** Attachment pages without a migrated parent or a file in the media library. */
	attachment: WpUrlTarget;
	/** Archive bases from the live permalinks (`/category/`, `/tag/`, `/author/`). */
	bases?: { category?: string; tag?: string; author?: string };
	/** Paths of migrated pages: never matched by a rule (a real page always wins). */
	pages?: string[];
	/** Attachment id → page path, parent, file. */
	attachments?: Record<string, WpAttachment>;
	trailingSlash?: "always" | "never";
}

export type WpUrlAction =
	| { kind: WpUrlKind; to: string }
	| { kind: WpUrlKind; gone: true }
	/** Unknown `?p=` / `?page_id=`: not a page on the new site (WordPress answers 404 too). */
	| { kind: WpUrlKind; notFound: true }
	/** Attachment: look the file up in the media library; `fallback` when it is not there. */
	| { kind: "attachment"; file: string; fallback: { to: string } | { gone: true } };

const FEED_SUFFIX = /\/feed(?:\/(?:rss2?|atom|rdf))?\/?$/;
const QUERY_KEYS = ["s", "feed", "cat", "tag", "author", "attachment_id", "m", "year", "monthnum", "p", "page_id"];

/** WordPress query parameters the matcher answers (so verify knows a 200 for them means "ignored"). */
export function wpQueryKey(search: URLSearchParams): string | undefined {
	return QUERY_KEYS.find((k) => search.has(k));
}

function styled(path: string, style: WpUrlRules["trailingSlash"]): string {
	if (path === "/" || /\.[a-z0-9]{2,5}$/i.test(path)) return path;
	if (style === "never") return path.replace(/\/+$/, "");
	return path.endsWith("/") ? path : `${path}/`;
}

function act(kind: WpUrlKind, target: WpUrlTarget, style: WpUrlRules["trailingSlash"], query?: string): WpUrlAction {
	if (target === "gone") return { kind, gone: true };
	return { kind, to: `${styled(target, style)}${query ?? ""}` };
}

const norm = (p: string) => (p === "/" ? "/" : `${p.replace(/\/+$/, "")}/`);

/** Per rule set (built once per isolate): page paths and attachment pages by path. */
const indexes = new WeakMap<WpUrlRules, { pages: Set<string>; byPath: Map<string, WpAttachment> }>();
function indexOf(rules: WpUrlRules) {
	let i = indexes.get(rules);
	if (!i) {
		i = { pages: new Set((rules.pages ?? []).map(norm)), byPath: new Map(Object.values(rules.attachments ?? {}).flatMap((a) => (a.path ? [[norm(a.path), a] as const] : []))) };
		indexes.set(rules, i);
	}
	return i;
}

/**
 * What the new site does with a WordPress address it has no page for, or undefined (not a WordPress address: the
 * normal routes answer). `wpIds` = the migrated `?p=` / `?page_id=` map (checked by the middleware before this).
 */
export function matchWpUrl(pathname: string, search: URLSearchParams, rules: WpUrlRules, wpIds: Record<string, string> = {}): WpUrlAction | undefined {
	const style = rules.trailingSlash;
	const { pages, byPath } = indexOf(rules);
	const path = decodeURIComponentSafe(pathname);
	const attachments = rules.attachments ?? {};
	const attachment = (a: WpAttachment | undefined): WpUrlAction => {
		if (a?.parent) return { kind: "attachment", to: styled(a.parent, style) };
		const fallback = rules.attachment === "gone" ? ({ gone: true } as const) : { to: styled(rules.attachment, style) };
		if (a?.file) return { kind: "attachment", file: a.file, fallback };
		return { kind: "attachment", ...fallback };
	};

	if (path === "/" || path === "/index.php") {
		const feed = search.get("feed");
		if (feed !== null) return /comments/.test(feed) ? act("comments-feed", rules.commentsFeed, style) : act("feed", rules.feed, style);
		const s = search.get("s");
		if (s !== null) return act("search", rules.search, style, rules.search !== "/" && rules.search !== "gone" && s ? `?q=${encodeURIComponent(s)}` : undefined);
		const id = search.get("attachment_id");
		if (id !== null) return attachment(attachments[id]);
		if (search.has("cat")) return act("category", rules.category, style);
		if (search.has("tag")) return act("tag", rules.tag, style);
		if (search.has("author")) return act("author", rules.author, style);
		if (search.has("m") || search.has("year") || search.has("monthnum")) return act("date", rules.date, style);
		const wp = search.get("page_id") ?? search.get("p");
		if (wp !== null && /^\d+$/.test(wp) && !wpIds[wp]) return attachments[wp] ? attachment(attachments[wp]) : { kind: "wp-id", notFound: true };
		return undefined;
	}
	if (pages.has(norm(path))) return undefined;

	// Legacy feed files.
	if (/^\/wp-(?:rss2?|atom|rdf)\.php$/.test(path)) return act("feed", rules.feed, style);
	if (/^\/wp-commentsrss2\.php$/.test(path)) return act("comments-feed", rules.commentsFeed, style);
	if (/^\/feed(?:\/(?:rss2?|atom|rdf))?\/?$/.test(path)) return act("feed", rules.feed, style);
	if (/^\/comments\/feed(?:\/(?:rss2?|atom|rdf))?\/?$/.test(path)) return act("comments-feed", rules.commentsFeed, style);
	// A feed under another address (a post's comments, an archive's posts): the address itself, else its rule.
	if (FEED_SUFFIX.test(path)) {
		const parent = path.replace(FEED_SUFFIX, "/");
		if (pages.has(norm(parent))) return { kind: "comments-feed", to: styled(parent, style) };
		const inner = matchWpUrl(parent, new URLSearchParams(), rules, wpIds);
		if (inner && "to" in inner) return { kind: inner.kind === "attachment" ? "comments-feed" : inner.kind, to: inner.to };
		if (inner && "gone" in inner) return inner;
		return act("comments-feed", rules.commentsFeed, style);
	}
	// Paged lists: /page/2/, /services/page/2/.
	const paged = /^(.*?\/)page\/\d+\/?$/.exec(path);
	if (paged) {
		const parent = paged[1] as string;
		if (parent === "/" || pages.has(norm(parent))) return { kind: "paged", to: styled(parent, style) };
		const inner = matchWpUrl(parent, new URLSearchParams(), rules, wpIds);
		if (inner) return inner;
		return undefined;
	}
	if (/^\/search\/.+/.test(path)) {
		const q = path.replace(/^\/search\//, "").replace(/\/$/, "");
		return act("search", rules.search, style, rules.search !== "/" && rules.search !== "gone" && q ? `?q=${encodeURIComponent(q)}` : undefined);
	}
	const base = (b: string | undefined, d: string) => norm(b ?? d);
	if (path.startsWith(base(rules.bases?.category, "/category/"))) return act("category", rules.category, style);
	if (path.startsWith(base(rules.bases?.tag, "/tag/"))) return act("tag", rules.tag, style);
	if (path.startsWith(base(rules.bases?.author, "/author/"))) return act("author", rules.author, style);
	if (/^\/\d{4}\/(?:\d{2}\/(?:\d{2}\/)?)?$/.test(norm(path))) return act("date", rules.date, style);
	if (/(?:^|\/)attachment\/[^/]+\/?$/.test(path)) {
		return attachment(byPath.get(norm(path)));
	}
	const page = byPath.get(norm(path));
	if (page) return attachment(page);
	return undefined;
}

function decodeURIComponentSafe(p: string): string {
	try {
		return decodeURIComponent(p);
	} catch {
		return p;
	}
}
