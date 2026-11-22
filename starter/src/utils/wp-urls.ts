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

export type WpUrlKind = "feed" | "comments-feed" | "search" | "category" | "tag" | "author" | "date" | "attachment" | "paged" | "wp-id" | "shop" | "language-home";

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
	/**
	 * The site has a blog (posts collection, archives, feeds): the posts page (`index`) and its pages, the archive
	 * pages under the `archives` bases (`/category/`, `/tag/`, `/author/`…) with their pages and feeds are real routes
	 * (pages/[...slug].astro), `/feed/` is the RSS feed. `ids`: WordPress query forms → archive address
	 * (`cat:7` → /category/news/, `author:1` → /author/jane/, `tag:tips` → /tag/tips/).
	 */
	blog?: { index: string; archives: string[]; ids?: Record<string, string> };
	/**
	 * WooCommerce catalogue mode (kit.config `shop`): the cart, checkout and my-account addresses (and everything under
	 * them: `/my-account/orders/`, `/checkout/order-received/…`) and any `?add-to-cart=` link 301 to the products listing
	 * `to` — there is no cart on the new site.
	 */
	shop?: { paths: string[]; to: string };
	/**
	 * Multilingual sites in directory mode (Polylang / WPML): each prefixed language's directory (`fr`) and its home page
	 * when that is not the bare directory (`/fr/accueil/`). Under a directory the blog's archives and feeds are real
	 * routes (the language's posts), date archives go to the language's home, and the bare directory redirects there.
	 */
	languages?: { dir: string; home?: string }[];
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

	const blog = rules.blog;
	const blogFeed = blog ? styled("/feed/", style) : undefined;
	const blogId = (key: string, kind: WpUrlKind, fallback: WpUrlTarget): WpUrlAction => {
		const to = blog?.ids?.[key];
		return to ? { kind, to: styled(to, style) } : act(kind, fallback, style);
	};
	if (rules.shop && search.has("add-to-cart")) return { kind: "shop", to: styled(rules.shop.to, style) };
	if (path === "/" || path === "/index.php") {
		const feed = search.get("feed");
		if (feed !== null) return /comments/.test(feed) ? act("comments-feed", rules.commentsFeed, style) : blogFeed ? { kind: "feed", to: blogFeed } : act("feed", rules.feed, style);
		const s = search.get("s");
		if (s !== null) return act("search", rules.search, style, rules.search !== "/" && rules.search !== "gone" && s ? `?q=${encodeURIComponent(s)}` : undefined);
		const id = search.get("attachment_id");
		if (id !== null) return attachment(attachments[id]);
		if (search.has("cat")) return blogId(`cat:${search.get("cat")}`, "category", rules.category);
		if (search.has("tag")) return blogId(`tag:${search.get("tag")}`, "tag", rules.tag);
		if (search.has("author")) return blogId(`author:${search.get("author")}`, "author", rules.author);
		if (search.has("m") || search.has("year") || search.has("monthnum")) return act("date", rules.date, style);
		const wp = search.get("page_id") ?? search.get("p");
		if (wp !== null && /^\d+$/.test(wp) && !wpIds[wp]) return attachments[wp] ? attachment(attachments[wp]) : { kind: "wp-id", notFound: true };
		return undefined;
	}
	if (pages.has(norm(path))) return undefined;
	if (rules.shop?.paths.some((p) => norm(path).startsWith(norm(p)))) return { kind: "shop", to: styled(rules.shop.to, style) };

	// A language directory: the same WordPress forms under `/fr/`.
	const lang = rules.languages?.find((l) => l.dir && (path === `/${l.dir}` || path.startsWith(`/${l.dir}/`)));
	if (lang) {
		const rest = path.slice(lang.dir.length + 1) || "/";
		const home = lang.home ?? `/${lang.dir}/`;
		// The bare directory, when the language's home page has an address of its own (WordPress redirects there too).
		if (norm(rest) === "/") return norm(home) !== norm(path) ? { kind: "language-home", to: styled(home, style) } : undefined;
		if (blog) {
			// The language's feed and its archives (with their pages and feeds) are real routes.
			if (norm(rest) === "/feed/") return undefined;
			const inner = rest.replace(FEED_SUFFIX, "/").replace(/page\/\d+\/?$/, "");
			if (blog.archives.some((b) => norm(inner).startsWith(norm(b)) && norm(inner) !== norm(b))) return undefined;
		}
		// Date archives: the language's home page (its posts page, if any, is a translated page of its own).
		if (/^\/\d{4}\/(?:\d{2}\/(?:\d{2}\/)?)?$/.test(norm(rest))) return rules.date === "gone" ? { kind: "date", gone: true } : { kind: "date", to: styled(home, style) };
	}

	// Blog: the posts page and archives with their pages and feeds are real routes; feed variants → /feed/.
	if (blog && blogFeed) {
		if (norm(path) === "/feed/") return undefined;
		if (/^\/wp-(?:rss2?|atom|rdf)\.php$/.test(path) || /^\/feed\/(?:rss2?|atom|rdf)\/?$/.test(path)) return { kind: "feed", to: blogFeed };
		const inner = path.replace(FEED_SUFFIX, "/").replace(/page\/\d+\/?$/, "");
		if (norm(inner) === norm(blog.index) && (inner !== path || norm(path) === norm(blog.index))) return undefined;
		if (blog.archives.some((b) => norm(inner).startsWith(norm(b)) && norm(inner) !== norm(b))) return undefined;
	}

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
