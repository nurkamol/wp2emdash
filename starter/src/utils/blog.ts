/**
 * Blog routing, feeds and text helpers. The blog's settings come from site.config.json `blog` (written by scaffold from
 * the WordPress options: src/transform/blog.ts): the posts page, archive bases (/category/, /tag/, /author/…), posts per
 * page and the feed. pages/[...slug].astro dispatches with `blogRoute`; feeds are RSS 2.0 from `rssXml`.
 *
 * No imports here: this file must load in Node (kit, tests) and in the Worker (starter).
 */

export interface BlogConfig {
	/** The posts page ("/" when the front page shows the latest posts). */
	index: string;
	perPage: number;
	/** WordPress "For each post in a feed, include": full text or excerpt; items per feed. */
	feed: { full: boolean; items: number };
	/** Taxonomy archives: EmDash taxonomy name, the WordPress base (`/category/`), labels. */
	archives: { taxonomy: string; base: string; label: string; labelSingular: string }[];
	/** Author archives (bylines), when the blog has bylines. */
	authorBase?: string;
}

export type BlogRoute =
	| { kind: "index"; page: number; feed: boolean }
	| { kind: "term"; taxonomy: string; slug: string; base: string; page: number; feed: boolean }
	| { kind: "author"; slug: string; base: string; page: number; feed: boolean };

const trim = (p: string) => (p === "/" ? "/" : `/${p.replace(/^\/+|\/+$/g, "")}/`);

/**
 * Which blog page an address is: the posts page (and /page/N/), a term or author archive (and its pages), or one of
 * their feeds (`/feed/`). Undefined: not a blog listing (a page or a post, resolved by slug).
 */
export function blogRoute(pathname: string, cfg: BlogConfig): BlogRoute | undefined {
	let path = trim(pathname);
	let feed = false;
	let page = 1;
	const f = /^(.*\/)feed\/(?:rss2?\/)?$/.exec(path);
	if (f) {
		feed = true;
		path = f[1] as string;
	}
	const pg = /^(.*\/)page\/(\d+)\/$/.exec(path);
	if (pg && !feed) {
		page = Number(pg[2]);
		path = pg[1] as string;
		if (page < 1) return undefined;
	}
	const index = trim(cfg.index);
	// The site feed is /feed/ wherever the posts page is (WordPress's main feed).
	if (path === index || (feed && path === "/")) return page === 1 || !feed ? { kind: "index", page, feed } : undefined;
	for (const a of cfg.archives) {
		const base = trim(a.base);
		if (path.startsWith(base) && path !== base) {
			// Hierarchical terms live at /category/parent/child/: the last segment is the term.
			const slug = path.slice(base.length).replace(/\/$/, "").split("/").pop() as string;
			return { kind: "term", taxonomy: a.taxonomy, slug: decodeSegment(slug), base, page, feed };
		}
	}
	if (cfg.authorBase) {
		const base = trim(cfg.authorBase);
		if (path.startsWith(base) && path !== base && path.slice(base.length).replace(/\/$/, "").split("/").length === 1) return { kind: "author", slug: decodeSegment(path.slice(base.length).replace(/\/$/, "")), base, page, feed };
	}
	return undefined;
}

function decodeSegment(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

/** Address of page `n` of a listing (`/journal/`, `/journal/page/2/`), in the site's URL style. */
export function pageHref(listing: string, n: number, style: "always" | "never" | undefined = "always"): string {
	const base = trim(listing);
	const p = n <= 1 ? base : `${base}page/${n}/`;
	return style === "never" && p !== "/" ? p.replace(/\/$/, "") : p;
}

/** Feed address of a listing: /feed/ for the posts page, /category/news/feed/ for an archive. */
export function feedHref(listing: string | undefined, style: "always" | "never" | undefined = "always"): string {
	const p = listing && trim(listing) !== "/" ? `${trim(listing)}feed/` : "/feed/";
	return style === "never" ? p.replace(/\/$/, "") : p;
}

// ── Text ─────────────────────────────────────────────────────────────────────

type Node = { _type?: string; [k: string]: unknown };

/** Plain text of Portable Text (listing excerpts, feed descriptions, reading time). */
export function ptText(value: unknown): string {
	const out: string[] = [];
	const walk = (v: unknown) => {
		if (Array.isArray(v)) return v.forEach(walk);
		if (!v || typeof v !== "object") return;
		const o = v as Node;
		if (o._type === "span" && typeof o.text === "string") {
			out.push(o.text);
			return;
		}
		if (o._type === "block") {
			walk(o.children);
			out.push("\n");
			return;
		}
		if (o._type === "htmlBlock" && typeof o.html === "string") {
			out.push(o.html.replace(/<[^>]+>/g, " "), "\n");
			return;
		}
		for (const [k, x] of Object.entries(o)) if (k !== "markDefs" && k !== "asset" && k !== "_media") walk(x);
	};
	walk(value);
	return out.join("").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

/** WordPress's automatic excerpt: the first 55 words, then " […]". */
export function autoExcerpt(text: string, words = 55): string {
	const w = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
	return w.length <= words ? w.join(" ") : `${w.slice(0, words).join(" ")} […]`;
}

export function escapeXml(s: string): string {
	return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Portable Text → HTML for full-text feeds (feed readers render HTML; the site itself uses EmDash's PortableText
 * component). Covers the block set the WordPress converter produces; media URLs made absolute with `origin`.
 */
export function ptToHtml(value: unknown, origin: string): string {
	const abs = (u: unknown) => (typeof u === "string" && u ? (/^https?:\/\//.test(u) ? u : `${origin}${u.startsWith("/") ? "" : "/"}${u}`) : "");
	const spans = (b: Node) => {
		const defs = new Map(((b.markDefs as Node[] | undefined) ?? []).map((d) => [d._key as string, d]));
		return ((b.children as Node[] | undefined) ?? [])
			.map((s) => {
				let t = escHtml(String(s.text ?? "")).replace(/\n/g, "<br>");
				for (const m of (s.marks as string[] | undefined) ?? []) {
					const d = defs.get(m);
					if (d && d._type === "link") t = `<a href="${escHtml(abs(String(d.href ?? "")) || String(d.href ?? ""))}">${t}</a>`;
					else if (m === "strong") t = `<strong>${t}</strong>`;
					else if (m === "em") t = `<em>${t}</em>`;
					else if (m === "code") t = `<code>${t}</code>`;
					else if (m === "underline") t = `<u>${t}</u>`;
					else if (m === "strike-through") t = `<s>${t}</s>`;
				}
				return t;
			})
			.join("");
	};
	const img = (n: Node) => {
		const src = abs((n.asset as Node | undefined)?.url);
		return src ? `<figure><img src="${escHtml(src)}" alt="${escHtml(String(n.alt ?? ""))}">${n.caption ? `<figcaption>${escHtml(String(n.caption))}</figcaption>` : ""}</figure>` : "";
	};
	const out: string[] = [];
	let list: { tag: string; items: string[] } | undefined;
	const flush = () => {
		if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${i}</li>`).join("")}</${list.tag}>`);
		list = undefined;
	};
	for (const n of (Array.isArray(value) ? value : []) as Node[]) {
		if (n._type === "block" && n.listItem) {
			const tag = n.listItem === "number" ? "ol" : "ul";
			if (list?.tag !== tag) flush();
			list ??= { tag, items: [] };
			list.items.push(spans(n));
			continue;
		}
		flush();
		switch (n._type) {
			case "block": {
				const style = String(n.style ?? "normal");
				const tag = /^h[1-6]$/.test(style) ? style : style === "blockquote" ? "blockquote" : "p";
				out.push(`<${tag}>${spans(n)}</${tag}>`);
				break;
			}
			case "image":
				out.push(img(n));
				break;
			case "gallery":
				out.push(((n.images as Node[] | undefined) ?? []).map(img).join(""));
				break;
			case "embed":
				if (typeof n.url === "string") out.push(`<p><a href="${escHtml(abs(n.url))}">${escHtml(abs(n.url))}</a></p>`);
				break;
			case "code":
				out.push(`<pre><code>${escHtml(String(n.code ?? ""))}</code></pre>`);
				break;
			case "pullquote":
				out.push(`<blockquote>${escHtml(String(n.text ?? ""))}</blockquote>`);
				break;
			case "htmlBlock":
				if (typeof n.html === "string") out.push(n.html);
				break;
			case "columns":
				for (const c of (n.columns as { content?: unknown }[] | undefined) ?? []) out.push(ptToHtml(c.content, origin));
				break;
			case "table":
				out.push(`<table>${((n.rows as { cells?: Node[] }[] | undefined) ?? []).map((r) => `<tr>${(r.cells ?? []).map((c) => `<td>${spans(c)}</td>`).join("")}</tr>`).join("")}</table>`);
				break;
		}
	}
	flush();
	return out.join("\n");
}

// ── RSS 2.0 ──────────────────────────────────────────────────────────────────

export interface FeedItem {
	title: string;
	link: string;
	/** ISO date. */
	published: string;
	description: string;
	/** Full HTML (content:encoded), for full-text feeds. */
	content?: string;
	categories?: string[];
	author?: string;
}

export interface FeedChannel {
	title: string;
	/** The listing the feed belongs to (absolute). */
	link: string;
	/** The feed's own address (absolute): atom:link rel="self". */
	self: string;
	description: string;
	language?: string;
	/** ISO date of the newest item. */
	updated?: string;
}

/** RSS 2.0 with atom:link self and content:encoded (what WordPress's /feed/ serves). */
export function rssXml(channel: FeedChannel, items: FeedItem[]): string {
	const rfc822 = (iso: string) => new Date(iso).toUTCString();
	const cdata = (s: string) => `<![CDATA[${s.replace(/]]>/g, "]]]]><![CDATA[>")}]]>`;
	const L = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:dc="http://purl.org/dc/elements/1.1/">',
		"<channel>",
		`<title>${escapeXml(channel.title)}</title>`,
		`<atom:link href="${escapeXml(channel.self)}" rel="self" type="application/rss+xml" />`,
		`<link>${escapeXml(channel.link)}</link>`,
		`<description>${escapeXml(channel.description)}</description>`,
		...(channel.updated ? [`<lastBuildDate>${rfc822(channel.updated)}</lastBuildDate>`] : []),
		...(channel.language ? [`<language>${escapeXml(channel.language)}</language>`] : []),
	];
	for (const i of items) {
		L.push(
			"<item>",
			`<title>${escapeXml(i.title)}</title>`,
			`<link>${escapeXml(i.link)}</link>`,
			`<guid isPermaLink="true">${escapeXml(i.link)}</guid>`,
			`<pubDate>${rfc822(i.published)}</pubDate>`,
			...(i.author ? [`<dc:creator>${cdata(i.author)}</dc:creator>`] : []),
			...(i.categories ?? []).map((c) => `<category>${cdata(c)}</category>`),
			`<description>${cdata(i.description)}</description>`,
			...(i.content ? [`<content:encoded>${cdata(i.content)}</content:encoded>`] : []),
			"</item>",
		);
	}
	L.push("</channel>", "</rss>");
	return `${L.join("\n")}\n`;
}

/** Cache tags of a blog page: posts (any publish purges them), the taxonomies shown, and the chrome's own tags. */
export function blogCacheTags(cfg: BlogConfig): string[] {
	return ["posts", "bylines", ...cfg.archives.map((a) => `emdash:taxonomy:${a.taxonomy}`)];
}
