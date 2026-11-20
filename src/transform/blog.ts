/**
 * Blog: WordPress posts, their taxonomies and authors → the EmDash `posts` collection, taxonomy definitions with terms
 * (hierarchy kept), bylines, and the blog settings the starter reads (index address, archive bases, posts per page,
 * feed). Pure functions of the extract output + overrides: transform writes ir/posts/*.json and ir/blog.json.
 *
 * Gutenberg and classic posts become EmDash Portable Text through EmDash's own converter
 * (@emdash-cms/gutenberg-to-portable-text, the version the starter installs) after the kit's shortcode pass
 * ([caption], [gallery], [embed], [audio], [video], bare embed URLs, wpautop). Builder posts (WPBakery, Bricks) keep their
 * sections. Verified behaviour: docs/spikes/blog-findings.md.
 */
import { gutenbergToPortableText, htmlToPortableText } from "@emdash-cms/gutenberg-to-portable-text";
import { autop } from "../ir/portable-text.js";
import type { Diagnostic, MediaRef } from "../ir/schema.js";
import { shortcodeAction } from "../adapters/shortcodes.js";
import type { BlogConfig } from "../../starter/src/utils/blog.js";

export type PtNode = { _type: string; _key: string; [k: string]: unknown };

/** WordPress taxonomy → EmDash taxonomy name (EmDash names: lowercase letters, digits, underscores). */
export function emdashTaxonomyName(wp: string): string | undefined {
	if (wp === "post_tag") return "tag";
	const n = wp.toLowerCase().replace(/-/g, "_");
	return /^[a-z][a-z0-9_]{0,62}$/.test(n) ? n : undefined;
}

/** Byline slugs: lowercase letters, digits and hyphens, starting with a letter (EmDash bylineCreateBody). */
export function bylineSlug(s: string): string {
	const x = s
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!x) return "author";
	return /^[a-z]/.test(x) ? x : `a-${x}`;
}

const attr = (s: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s\\]]+))`, "i").exec(s)?.slice(1).find((v) => v !== undefined);
const block = (name: string, attrs: Record<string, unknown>, html: string) => `\n<!-- wp:${name} ${JSON.stringify(attrs)} -->\n${html}\n<!-- /wp:${name} -->\n`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Embed providers WordPress turns a bare URL on its own line into (oEmbed); others stay a link. */
const OEMBED = /^https?:\/\/(?:www\.)?(?:youtube\.com\/watch|youtu\.be\/|vimeo\.com\/\d|twitter\.com\/|x\.com\/|soundcloud\.com\/|open\.spotify\.com\/|instagram\.com\/p\/|tiktok\.com\/)/i;

/**
 * The kit's shortcode pass: WordPress core shortcodes the EmDash converter keeps as text become the Gutenberg blocks it
 * converts. Unknown shortcodes stay (reported by `convertPostBody`). Used on classic posts and on Gutenberg's classic
 * (freeform) parts and shortcode blocks.
 */
export function shortcodePass(html: string): string {
	let out = html;
	// [caption id="attachment_9" ...]<a><img class="wp-image-9" ...></a> The caption[/caption]
	out = out.replace(/\[caption\b([^\]]*)\]([\s\S]*?)\[\/caption\]/gi, (_m, a: string, inner: string) => {
		const img = /<a\b[^>]*>\s*<img\b[^>]*>\s*<\/a>|<img\b[^>]*>/i.exec(inner)?.[0] ?? "";
		const caption = (attr(a, "caption") ?? inner.replace(img, "")).trim();
		const id = Number(/wp-image-(\d+)/.exec(img)?.[1] ?? /attachment_(\d+)/.exec(a)?.[1] ?? 0);
		return block("image", id ? { id } : {}, `<figure class="wp-block-image">${img}${caption ? `<figcaption>${caption}</figcaption>` : ""}</figure>`);
	});
	// [gallery ids="1,2,3"]
	out = out.replace(/\[gallery\b([^\]]*)\]/gi, (_m, a: string) => {
		const ids = (attr(a, "ids") ?? "").split(",").map((x) => Number(x.trim())).filter((x) => x > 0);
		if (!ids.length) return _m;
		const cols = Number(attr(a, "columns") ?? 0);
		return block("gallery", { ids, ...(cols ? { columns: cols } : {}) }, `<figure class="wp-block-gallery"><ul>${ids.map((id) => `<li><figure><img data-id="${id}" class="wp-image-${id}" alt=""/></figure></li>`).join("")}</ul></figure>`);
	});
	// [embed]https://…[/embed]
	out = out.replace(/\[embed\b[^\]]*\]\s*(https?:\/\/[^\s[]+)\s*\[\/embed\]/gi, (_m, url: string) => block("embed", { url }, `<figure class="wp-block-embed"><div class="wp-block-embed__wrapper">${esc(url)}</div></figure>`));
	// [audio src="…"] / [video src="…" or mp4="…"]
	out = out.replace(/\[(audio|video)\b([^\]]*)\](?:\s*\[\/\1\])?/gi, (m, kind: string, a: string) => {
		const src = attr(a, "src") ?? attr(a, "mp4") ?? attr(a, "mp3") ?? attr(a, "m4a") ?? attr(a, "webm") ?? attr(a, "ogg");
		if (!src) return m;
		return block(kind.toLowerCase(), {}, kind.toLowerCase() === "audio" ? `<figure class="wp-block-audio"><audio controls src="${esc(src)}"></audio></figure>` : `<figure class="wp-block-video"><video controls src="${esc(src)}"></video></figure>`);
	});
	// Registry (src/adapters/shortcodes.ts): layout/styling wrappers lose their tags (content kept; a title becomes a bold
	// line), the SEO plugins' breadcrumb trails go (flagged by the transform). Everything else stays for the report.
	out = out.replace(/\[(\/?)([a-zA-Z][\w-]*)((?:\s[^\]]*)?)\]/g, (m, close: string, tag: string, a: string) => {
		const action = shortcodeAction(tag)?.do;
		if (action === "breadcrumbs") return "";
		if (action !== "strip") return m;
		const title = close ? undefined : (attr(a, "title") ?? attr(a, "heading"));
		return title ? `<p><strong>${esc(title)}</strong></p>` : "";
	});
	// A bare oEmbed URL on its own line (WordPress auto-embeds it).
	out = out.replace(/(^|\n)[ \t]*(https?:\/\/[^\s<]+)[ \t]*(?=\n|$)/g, (m, lead: string, url: string) => (OEMBED.test(url) ? `${lead}${block("embed", { url }, `<figure class="wp-block-embed"><div class="wp-block-embed__wrapper">${esc(url)}</div></figure>`)}` : m));
	return out;
}

/** Classic post_content (or a freeform part): shortcode pass, then wpautop on the text between the generated blocks. */
export function classicToBlockMarkup(html: string): string {
	const passed = shortcodePass(html.replace(/\r\n/g, "\n"));
	// Split on the blocks the pass made; wrap the text between them as paragraphs (wpautop), as WordPress renders it.
	const parts = passed.split(/(\n<!-- wp:[a-z/-]+ \{[\s\S]*?<!-- \/wp:[a-z/-]+ -->\n)/);
	const para = (t: string) => {
		const a = autop(t);
		return /^\s*</.test(a) ? a : `<p>${a}</p>`;
	};
	return parts.map((p) => (p.startsWith("\n<!-- wp:") ? p : p.trim() ? para(p.trim()) : "")).join("\n");
}

/** Gutenberg content: reusable blocks inlined, classic parts and shortcode blocks through the shortcode pass. */
export function gutenbergMarkup(content: string, reusable: (id: number) => string | undefined): string {
	let out = content.replace(/<!--\s+wp:block\s+(\{[^}]*\})\s*\/-->/g, (m, json: string) => {
		try {
			const ref = Number((JSON.parse(json) as { ref?: number }).ref);
			return reusable(ref) ?? m;
		} catch {
			return m;
		}
	});
	out = out.replace(/<!--\s+wp:shortcode\s+-->([\s\S]*?)<!--\s+\/wp:shortcode\s+-->/g, (m, inner: string) => {
		const passed = shortcodePass(inner.trim());
		return passed === inner.trim() ? m : passed;
	});
	// Freeform (classic) text between top-level blocks: same treatment as a classic post.
	return topLevelParts(out).map((p) => (p.block || !p.text.trim() ? p.text : classicToBlockMarkup(p.text))).join("");
}

/** Split block markup into top-level blocks and the freeform text between them (nesting tracked). */
export function topLevelParts(markup: string): { block: boolean; text: string }[] {
	const token = /<!--\s+(\/)?wp:[a-z0-9/-]+(?:\s+(?:\{[\s\S]*?\}\s*)?)?(\/)?-->/g;
	const parts: { block: boolean; text: string }[] = [];
	let depth = 0;
	let start = 0;
	let blockStart = 0;
	for (const m of markup.matchAll(token)) {
		const at = m.index ?? 0;
		const closing = !!m[1];
		const selfClosing = !!m[2];
		if (depth === 0 && !closing) {
			if (at > start) parts.push({ block: false, text: markup.slice(start, at) });
			blockStart = at;
		}
		if (selfClosing) {
			if (depth === 0) {
				parts.push({ block: true, text: m[0] });
				start = at + m[0].length;
			}
			continue;
		}
		depth += closing ? -1 : 1;
		if (depth === 0 && closing) {
			parts.push({ block: true, text: markup.slice(blockStart, at + m[0].length) });
			start = at + m[0].length;
		}
		if (depth < 0) depth = 0;
	}
	if (start < markup.length) parts.push({ block: depth > 0, text: markup.slice(depth > 0 ? blockStart : start) });
	return parts;
}

export interface BodyOptions {
	/** Deterministic key prefix (stable reruns, golden tests). */
	keyPrefix: string;
	/** Media library id for an upload URL (size variants and -scaled ignored), when known. */
	mediaIdForUrl: (url: string) => number | undefined;
	reusable?: (id: number) => string | undefined;
}

/**
 * A Gutenberg or classic post body → EmDash Portable Text with media marked for load (`_media`), plus diagnostics for
 * what the converter could only keep as raw HTML (unknown blocks: warn) or literal text (shortcodes: error, approve
 * with overrides.ts approvedLegacy `<slug>:body#<n>`).
 */
export function convertPostBody(content: string, builder: "gutenberg" | "classic", opts: BodyOptions): { body: PtNode[]; diagnostics: Diagnostic[] } {
	let n = 0;
	const keyGenerator = () => `${opts.keyPrefix}${(n++).toString(36)}`;
	const markup = builder === "gutenberg" ? gutenbergMarkup(content, opts.reusable ?? (() => undefined)) : classicToBlockMarkup(content);
	// Blocks through the converter's block transformers; classic (freeform) HTML between them through its HTML
	// converter, which makes paragraphs, headings and lists (the block path would keep freeform HTML as one HTML block).
	const raw: PtNode[] = [];
	for (const part of topLevelParts(markup)) {
		if (!part.text.trim()) continue;
		const html = part.block ? part.text : /^\s*</.test(part.text) ? part.text : `<p>${part.text.trim()}</p>`;
		raw.push(...((part.block ? gutenbergToPortableText(html, { keyGenerator }) : htmlToPortableText(html, { keyGenerator })) as unknown as PtNode[]));
	}
	const diagnostics: Diagnostic[] = [];
	const media = (wpId: number | undefined, url: string | undefined, kind: MediaRef["kind"], alt?: string): MediaRef | undefined => {
		const id = wpId ?? (url ? opts.mediaIdForUrl(url) : undefined);
		if (!id && !url) return undefined;
		return { ...(id ? { wpId: id } : { url: url as string }), kind, ...(alt ? { alt } : {}) };
	};
	const markImage = (img: PtNode) => {
		const asset = (img.asset ?? {}) as { _ref?: string; url?: string };
		const ref = /^\d+$/.test(asset._ref ?? "") ? Number(asset._ref) : undefined;
		const m = media(ref, asset.url, "image", typeof img.alt === "string" ? img.alt : undefined);
		if (m) img._media = m;
	};
	const shortcode = /\[\/?[a-z][a-z0-9_-]*(?:\s[^\]]*)?\]/i;
	const visit = (nodes: PtNode[], path: string) => {
		for (const [i, b] of nodes.entries()) {
			const at = `${path}#${i}`;
			switch (b._type) {
				case "image":
					markImage(b);
					break;
				case "gallery":
					for (const img of (b.images as PtNode[] | undefined) ?? []) markImage(img);
					break;
				case "cover": {
					const m = typeof b.backgroundImage === "string" ? media(undefined, b.backgroundImage, "image") : undefined;
					if (m) b._media = { ...m, field: "backgroundImage" };
					if (Array.isArray(b.content)) visit(b.content as PtNode[], `${at}.content`);
					break;
				}
				case "file": {
					const m = typeof b.url === "string" ? media(undefined, b.url, "file") : undefined;
					if (m) b._media = { ...m, field: "url" };
					break;
				}
				case "embed": {
					// Self-hosted audio/video (core/audio, core/video): the file goes to the media library.
					const url = typeof b.url === "string" ? b.url : undefined;
					if (url && /\/wp-content\/uploads\//.test(url)) b._media = { ...(media(undefined, url, "video") as MediaRef), field: "url" };
					break;
				}
				case "columns":
					for (const [c, col] of ((b.columns as { content?: PtNode[] }[] | undefined) ?? []).entries()) visit(col.content ?? [], `${at}.columns#${c}`);
					break;
				case "htmlBlock": {
					const html = String(b.html ?? "");
					const name = typeof b.originalBlockName === "string" ? b.originalBlockName : "html";
					if (name === "core/shortcode" || shortcode.test(html.replace(/<[^>]+>/g, ""))) diagnostics.push({ level: "error", code: "flagged", message: `shortcode kept as text: ${html.replace(/\s+/g, " ").slice(0, 80)}`, path: at, carriesContent: true, tag: "shortcode" });
					else if (name !== "core/html") diagnostics.push({ level: "warn", code: "flagged", message: `${name} kept as HTML (no Portable Text equivalent)`, path: at, tag: name });
					break;
				}
				case "block": {
					const text = ((b.children as { text?: string }[] | undefined) ?? []).map((c) => c.text ?? "").join("");
					const sc = shortcode.exec(text);
					const name = sc ? (/^\[\/?([a-zA-Z][\w-]*)/.exec(sc[0])?.[1] ?? "") : "";
					const action = name ? shortcodeAction(name) : undefined;
					if (action?.do === "widget" && !action.content) diagnostics.push({ level: "warn", code: "flagged", message: `shortcode [${name}]: ${action.what} kept as text (not rebuilt; a site widget can bring it back)`, path: at, tag: "shortcode" });
					else if (sc && (action || /^\[\/?(?:[a-z_]+_[a-z_]+|vc_|et_pb|fusion|contact-form|wpforms|fluentform|gravityform|ninja_form|caption|gallery|embed|audio|video|playlist|shortcode)/i.test(sc[0]))) diagnostics.push({ level: "error", code: "flagged", message: `shortcode kept as text: ${sc[0].slice(0, 80)}${action?.do === "form" ? " (a form in a post: put the form on a page, or decide)" : ""}`, path: at, carriesContent: true, tag: "shortcode" });
					break;
				}
			}
		}
	};
	visit(raw, "body");
	return { body: raw, diagnostics };
}

/** Plain text of a Portable Text body (excerpts, feeds, conservation). */
export function bodyText(body: PtNode[]): string {
	const out: string[] = [];
	const walk = (v: unknown) => {
		if (Array.isArray(v)) return v.forEach(walk);
		if (!v || typeof v !== "object") return;
		const o = v as Record<string, unknown>;
		if (o._type === "span" && typeof o.text === "string") out.push(o.text);
		if (typeof o.caption === "string") out.push(o.caption);
		if (o._type === "pullquote" && typeof o.text === "string") out.push(o.text);
		for (const [k, x] of Object.entries(o)) if (k !== "markDefs" && k !== "_media") walk(x);
	};
	walk(body);
	return out.join(" ").replace(/\s+/g, " ").trim();
}

/** WordPress `date_gmt` ("2024-05-10 09:00:00") → ISO 8601 UTC; undefined for WordPress's zero date. */
export function wpGmtToIso(d: string | undefined): string | undefined {
	if (!d || /^0000-00-00/.test(d)) return undefined;
	const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(d) ? `${d.replace(" ", "T")}Z` : d;
	const t = Date.parse(iso);
	return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/**
 * A post's address from the permalink structure (when the audit did not see its live link): /%postname%/,
 * /%year%/%monthnum%/%postname%/, /blog/%postname%/, /%category%/%postname%/, /%post_id%/…; plain (`?p=`) → /<slug>/.
 */
export function permalinkPath(structure: string | undefined, p: { id: number; slug: string; dateGmt?: string; category?: string; author?: string }, trailing: boolean): string {
	const s = (structure ?? "").trim();
	if (!s) return `/${p.slug}/`;
	const d = p.dateGmt ? new Date(p.dateGmt) : undefined;
	const two = (x: number) => String(x).padStart(2, "0");
	const path = s
		.replace(/%year%/g, d ? String(d.getUTCFullYear()) : "")
		.replace(/%monthnum%/g, d ? two(d.getUTCMonth() + 1) : "")
		.replace(/%day%/g, d ? two(d.getUTCDate()) : "")
		.replace(/%hour%/g, d ? two(d.getUTCHours()) : "")
		.replace(/%minute%/g, d ? two(d.getUTCMinutes()) : "")
		.replace(/%second%/g, d ? two(d.getUTCSeconds()) : "")
		.replace(/%post_id%/g, String(p.id))
		.replace(/%postname%/g, p.slug)
		.replace(/%category%/g, p.category ?? "uncategorized")
		.replace(/%author%/g, p.author ?? "")
		.replace(/\/{2,}/g, "/");
	const withLead = path.startsWith("/") ? path : `/${path}`;
	return trailing ? (withLead.endsWith("/") ? withLead : `${withLead}/`) : withLead.replace(/\/+$/, "") || "/";
}

// ── Taxonomies and bylines ─────────────────────────────────────────────────────

export interface WpTaxonomy {
	name: string;
	label?: string;
	label_singular?: string;
	hierarchical?: boolean;
	post_types?: string[];
	terms?: { id: number; name?: string; slug: string; description?: string; parent?: number | null; count?: number }[];
}

export interface BlogTerm {
	wpId: number;
	slug: string;
	label: string;
	description?: string;
	/** Parent term's slug (hierarchical taxonomies). */
	parent?: string;
	count: number;
}

export interface BlogTaxonomy {
	/** EmDash name (category, tag, <custom>). */
	name: string;
	/** WordPress name (category, post_tag, <custom>). */
	wpName: string;
	label: string;
	labelSingular: string;
	hierarchical: boolean;
	/** Archive base on the live site (/category/, /topics/…); custom taxonomies: /<name>/. */
	base: string;
	terms: BlogTerm[];
}

export interface BlogByline {
	slug: string;
	displayName: string;
	bio?: string;
	/** Avatar from the site's own uploads (a local-avatar plugin); Gravatar images are not copied. */
	avatar?: MediaRef;
	/** WordPress user id and author archive path (to keep /author/<nicename>/ when the byline slug differs). */
	wpId: number;
	path?: string;
	posts: number;
}

/** Taxonomies the blog migrates: registered for posts (exporter `post_types`), else those its posts use. */
export function blogTaxonomies(input: { taxonomies: WpTaxonomy[]; usedByPosts: Set<string>; internal: Set<string>; bases: Record<string, string | undefined> }): { taxonomies: BlogTaxonomy[]; notMigrated: string[] } {
	const out: BlogTaxonomy[] = [];
	const notMigrated: string[] = [];
	for (const t of input.taxonomies) {
		const forPosts = t.post_types ? t.post_types.includes("post") : input.usedByPosts.has(t.name);
		if (!forPosts || input.internal.has(t.name)) continue;
		const name = emdashTaxonomyName(t.name);
		if (!name) {
			notMigrated.push(`${t.name}: name not usable in EmDash`);
			continue;
		}
		const terms = t.terms ?? [];
		const byId = new Map(terms.map((x) => [x.id, x]));
		const label = t.label ?? (t.name === "category" ? "Categories" : t.name === "post_tag" ? "Tags" : t.name);
		out.push({
			name,
			wpName: t.name,
			label,
			labelSingular: t.label_singular ?? (t.name === "category" ? "Category" : t.name === "post_tag" ? "Tag" : label),
			hierarchical: t.hierarchical ?? t.name === "category",
			base: input.bases[t.name] ?? (t.name === "category" ? "/category/" : t.name === "post_tag" ? "/tag/" : `/${t.name}/`),
			// Parents before children (load creates them in this order).
			terms: orderParentsFirst(terms).map((x) => ({ wpId: x.id, slug: x.slug, label: x.name ?? x.slug, ...(x.description ? { description: x.description } : {}), ...(x.parent && byId.get(x.parent) ? { parent: byId.get(x.parent)?.slug as string } : {}), count: Number(x.count ?? 0) })),
		});
	}
	return { taxonomies: out, notMigrated };
}

function orderParentsFirst<T extends { id: number; parent?: number | null }>(terms: T[]): T[] {
	const ids = new Set(terms.map((t) => t.id));
	const done = new Set<number>();
	const out: T[] = [];
	let guard = 0;
	while (out.length < terms.length && guard++ < terms.length + 2) {
		for (const t of terms) {
			if (done.has(t.id)) continue;
			if (!t.parent || !ids.has(t.parent) || done.has(t.parent)) {
				out.push(t);
				done.add(t.id);
			}
		}
	}
	for (const t of terms) if (!done.has(t.id)) out.push(t); // a cycle: keep, unparented by load
	return out;
}

export interface BlogPlan {
	/** The posts page: "/" (front page shows posts), the page_for_posts address, else /blog/. */
	index: string;
	/** The WordPress page the index replaces (page_for_posts), when there is one. */
	indexPageId?: number;
	perPage: number;
	/** RSS: full text or excerpt (WordPress "For each post in a feed, include"), items per feed. */
	feed: { full: boolean; items: number; source: string };
	permalink: string;
	taxonomies: BlogTaxonomy[];
	bylines: BlogByline[];
	authorBase: string;
}

export function blogIndexPath(options: Record<string, unknown>, routeById: Map<number, string>): { index: string; indexPageId?: number } {
	if (options.show_on_front === "posts" || (!Number(options.page_on_front) && options.show_on_front === undefined && !Number(options.page_for_posts))) return { index: "/" };
	const id = Number(options.page_for_posts);
	if (id > 0 && routeById.get(id)) return { index: routeById.get(id) as string, indexPageId: id };
	return { index: "/blog/" };
}

export function feedSettings(options: Record<string, unknown>): BlogPlan["feed"] {
	const items = Number(options.posts_per_rss);
	const hasExcerptOption = options.rss_use_excerpt !== undefined;
	return {
		full: hasExcerptOption ? !(options.rss_use_excerpt === true || String(options.rss_use_excerpt) === "1") : false,
		items: Number.isInteger(items) && items > 0 ? Math.min(items, 50) : 10,
		source: hasExcerptOption ? "option rss_use_excerpt" : "not in the export: excerpt (WordPress default is full text; set it in the starter's site.config blog.feed.full)",
	};
}

/** What the starter reads (site.config.json `blog`): routes, archive bases, page size, feed. */
export function starterBlogConfig(plan: BlogPlan): BlogConfig {
	return {
		index: plan.index,
		perPage: plan.perPage,
		feed: { full: plan.feed.full, items: plan.feed.items },
		archives: plan.taxonomies.map((t) => ({ taxonomy: t.name, base: t.base, label: t.label, labelSingular: t.labelSingular })),
		...(plan.bylines.length ? { authorBase: plan.authorBase } : {}),
	};
}

/** Coverage report section: what the blog migrates and how. */
export function blogReport(plan: BlogPlan, posts: { source: { status: string; slug: string; builder: string }; post?: { visibility: string; sticky?: boolean; format?: string } }[], protectedDecision?: { as: string; reason: string }): string[] {
	const by = (f: (p: (typeof posts)[number]) => boolean) => posts.filter(f).length;
	const hidden = by((p) => p.post?.visibility !== undefined && p.post.visibility !== "public");
	const L = ["", "## Blog", "", `Posts page: \`${plan.index}\` · ${plan.perPage} per page · permalinks \`${plan.permalink || "plain (?p=)"}\` · feed: ${plan.feed.full ? "full text" : "excerpt"}, ${plan.feed.items} items (${plan.feed.source}).`, ""];
	L.push(
		`| Posts | ${posts.length} |`,
		"|---|---|",
		`| Published | ${by((p) => p.source.status === "publish" && p.post?.visibility === "public")} |`,
		`| Scheduled (load schedules them at their WordPress date) | ${by((p) => p.source.status === "future")} |`,
		`| Drafts / pending | ${by((p) => p.source.status === "draft" || p.source.status === "pending")} |`,
		`| Private / password-protected | ${hidden}${protectedDecision ? ` (${protectedDecision.as}: ${protectedDecision.reason})` : hidden ? " ❌ undecided (overrides.ts protectedPosts)" : ""} |`,
		`| Sticky → featured | ${by((p) => !!p.post?.sticky)} |`,
		`| Builder posts (sections kept) | ${by((p) => p.source.builder === "wpbakery" || p.source.builder === "bricks" || p.source.builder === "divi")} |`,
	);
	const formats = [...new Set(posts.map((p) => p.post?.format).filter(Boolean))];
	if (formats.length) L.push("", `Post formats kept as a field (the starter renders every format alike): ${formats.join(", ")}.`);
	L.push("", "| Taxonomy | EmDash name | Terms | Hierarchical | Archive base |", "|---|---|---|---|---|");
	for (const t of plan.taxonomies) L.push(`| ${t.wpName} | ${t.name} | ${t.terms.length} | ${t.hierarchical ? "yes" : "no"} | \`${t.base}\` |`);
	if (plan.bylines.length) {
		L.push("", "| Byline | Slug | Posts | Bio | Avatar |", "|---|---|---|---|---|");
		for (const b of plan.bylines) L.push(`| ${b.displayName.replace(/\|/g, "\\|")} | ${b.slug} | ${b.posts} | ${b.bio ? "yes" : "—"} | ${b.avatar ? "site upload" : "— (Gravatar not copied)"} |`);
	}
	return L;
}
