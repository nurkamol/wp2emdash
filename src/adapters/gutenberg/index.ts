/**
 * Gutenberg + classic adapter (PLAN §7). Block comments → block tree (same shape as WordPress's
 * parser) → rows → the shared section recognisers. Classic content (no blocks) becomes rich text.
 */
import type { Diagnostic, MediaRef, PtBlock, Section, SectionType } from "../../ir/schema.js";
import { autop, type Keys } from "../../ir/portable-text.js";
import { embedOrLegacy, type Fragment, type HandlerCtx, mediaFrom, richFromHtml } from "../wpbakery/elements.js";
import { adaptWpbakery, mergeRich, recognise, type Row, splitRow } from "../wpbakery/index.js";
import type { Col } from "../wpbakery/elements.js";
import type { FormDefinitionOut } from "../../scaffold/forms.js";
import { oembedMarkup } from "./oembed.js";
import { WOO_GRID_BLOCKS, wooBlock } from "../woocommerce.js";
import { isLibRow, LIB_CONTAINERS, LIB_LEAF, type LibEnv, libColumns, libraryOf, libStyle } from "./libraries.js";

export interface Block {
	name: string;
	attrs: Record<string, unknown>;
	innerBlocks: Block[];
	/** HTML of this block without its inner blocks. */
	innerHTML: string;
}

const TOKEN = /<!--\s+(\/)?wp:([a-z][a-z0-9_-]*\/)?([a-z][a-z0-9_-]*)\s+({(?:(?!}\s+\/?-->).)*?}\s+)?(\/)?-->/gs;

/** Parse post_content into blocks. Freeform HTML between blocks becomes `core/freeform`. */
export function parseBlocks(content: string): Block[] {
	const root: Block = { name: "#root", attrs: {}, innerBlocks: [], innerHTML: "" };
	const stack: Block[] = [root];
	let last = 0;
	const freeform = (html: string) => {
		const parent = stack.at(-1) as Block;
		if (parent === root) {
			if (html.trim()) root.innerBlocks.push({ name: "core/freeform", attrs: {}, innerBlocks: [], innerHTML: html });
		} else parent.innerHTML += html;
	};
	for (const m of content.matchAll(TOKEN)) {
		freeform(content.slice(last, m.index));
		last = (m.index ?? 0) + m[0].length;
		const [, closer, ns, name, json, selfClose] = m;
		const fullName = `${ns ?? "core/"}${name}`;
		if (closer) {
			while (stack.length > 1 && (stack.at(-1) as Block).name !== fullName) stack.pop();
			if (stack.length > 1) stack.pop();
			continue;
		}
		let attrs: Record<string, unknown> = {};
		if (json) {
			try {
				attrs = JSON.parse(json);
			} catch {
				attrs = { __unparsed: json };
			}
		}
		const block: Block = { name: fullName, attrs, innerBlocks: [], innerHTML: "" };
		(stack.at(-1) as Block).innerBlocks.push(block);
		if (!selfClose) stack.push(block);
	}
	freeform(content.slice(last));
	return root.innerBlocks;
}

export interface GutenbergOptions {
	kind: "page" | "post" | "partial" | "popup";
	keys: Keys;
	popupFor: HandlerCtx["popupFor"];
	postCount: number;
	/** Resolve a reusable block / synced pattern by id. */
	reusable?: (id: number) => string | undefined;
	rowOverrides?: Record<string, SectionType | "drop">;
	/** Return the content as fragments (no sections): post content shown inside another builder's layout. */
	asFragments?: boolean;
	/** The post's id (form ids of block-library forms: `<postId>-<n>`). */
	postId?: number;
	/** A term's slug by taxonomy and WordPress id (category filters of core/latest-posts and core/query). */
	termSlug?: (taxonomy: string, id: number) => string | undefined;
}

/** Top-level core blocks that make a section of their own. */
const OWN_SECTION = new Set(["core/audio", "core/latest-posts", "core/query"]);
/** Block attributes that only style the block (handled the same way for every block, not content). */
const STYLE_ATTRS = new Set(["className", "align", "style", "anchor", "fontSize", "fontFamily", "textColor", "backgroundColor", "gradient", "borderColor", "layout", "lock", "metadata", "textAlign"]);

const DECORATIVE = new Set(["core/spacer", "core/separator", "core/nextpage", "core/more"]);
const PROSE = new Set(["core/paragraph", "core/heading", "core/list", "core/list-item", "core/quote", "core/pullquote", "core/verse", "core/preformatted", "core/code", "core/freeform", "core/footnotes"]);
const CONTAINERS = new Set(["core/group", "core/columns", "core/cover", "core/media-text", "core/row", "core/stack"]);
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
/** Fragment kinds that make a top-level block-library block a section of its own. */
const LIB_COLLECTIONS = new Set<Fragment["kind"]>(["faq", "tab", "team", "testimonial", "gallery", "price", "stat", "form", "embed", "video", "map"]);

/**
 * Post content as fragments, for a page builder that shows it inside its own layout (a Bricks post-content element or
 * `{post_content}` tag): blocks, classic text and shortcodes (forms…) through the same handlers as a whole page.
 */
export function gutenbergFragments(content: string, opts: Omit<GutenbergOptions, "asFragments" | "rowOverrides">): { fragments: Fragment[]; diagnostics: Diagnostic[] } {
	const r = adaptGutenberg(content, { ...opts, asFragments: true });
	return { fragments: r.fragments ?? [], diagnostics: r.diagnostics };
}

export function adaptGutenberg(content: string, opts: GutenbergOptions): { sections: Section[]; diagnostics: Diagnostic[]; fragments?: Fragment[]; /** Form definitions of block-library form blocks (only when there are some). */ forms?: FormDefinitionOut[] } {
	const diagnostics: Diagnostic[] = [];
	const diag = (d: Diagnostic) => diagnostics.push(d);
	const ctxFor = (path: string): HandlerCtx => ({ keys: opts.keys, path, diag, popupFor: opts.popupFor, postCount: opts.postCount, children: () => [] });
	const blocks = parseBlocks(content);
	const forms = new Map<string, FormDefinitionOut>();
	let formCount = 0;
	const libEnv: LibEnv = { keys: opts.keys, ctx: ctxFor, diag, popupFor: opts.popupFor, postCount: opts.postCount, ...(opts.postId !== undefined ? { postId: opts.postId } : {}), fragmentsOf: (b, path) => fragmentsOf(b, path), forms, nextForm: () => ++formCount };
	const withForms = <T extends object>(r: T) => (forms.size ? { ...r, forms: [...forms.values()] } : r);
	const isLibContainer = (b: Block) => LIB_CONTAINERS.has(b.name) || isLibRow(b);

	// Classic content: no blocks at all.
	if (blocks.length === 1 && blocks[0]?.name === "core/freeform") {
		// Classic content with shortcodes (forms, galleries…) goes through the shortcode adapter.
		if (opts.asFragments) {
			// the_content runs wpautop on classic content.
			const r = adaptWpbakery(autop(blocks[0].innerHTML), { kind: opts.kind, keys: opts.keys, popupFor: opts.popupFor, postCount: opts.postCount, asFragments: true });
			return { sections: [], diagnostics: [...diagnostics, ...r.diagnostics], fragments: r.fragments ?? [] };
		}
		if (/\[[a-z][\w-]*[\s\]]/i.test(blocks[0].innerHTML)) {
			const r = adaptWpbakery(blocks[0].innerHTML, { kind: opts.kind, keys: opts.keys, popupFor: opts.popupFor, postCount: opts.postCount });
			return { sections: r.sections.map((x) => ({ ...x, sourceRef: { ...x.sourceRef, adapter: "classic" as const } })), diagnostics: [...diagnostics, ...r.diagnostics] };
		}
		const frags = richFromHtml(blocks[0].innerHTML, ctxFor("classic"));
		const row: Row = { attrs: {}, columns: [{ fragments: frags }], path: "classic", raw: content, adapter: "classic" };
		return { sections: recognise(row, { first: true, kind: opts.kind, keys: opts.keys, diag }), diagnostics };
	}

	function leaf(b: Block, path: string): Fragment[] {
		const ctx = ctxFor(path);
		if (DECORATIVE.has(b.name)) {
			diag({ level: "info", code: "dropped-decorative", message: `${b.name} dropped (decorative)`, path, tag: b.name });
			return [];
		}
		if (b.name === "core/list") return richFromHtml(serialiseList(b), ctx);
		if (PROSE.has(b.name)) return richFromHtml(b.innerHTML, ctx);
		// Block libraries (Kadence, Spectra, GenerateBlocks, Stackable, CoBlocks): src/adapters/gutenberg/libraries.ts.
		const lib = LIB_LEAF[b.name];
		if (lib) return lib(b, path, libEnv);
		// WooCommerce product listing blocks → a product grid, or reported (src/adapters/woocommerce.ts).
		if (WOO_GRID_BLOCKS.has(b.name)) return wooBlock(b, diag, path, opts.termSlug);
		switch (b.name) {
			case "core/image": {
				const id = typeof b.attrs.id === "number" ? b.attrs.id : undefined;
				const src = /<img[^>]+src="([^"]+)"/.exec(b.innerHTML)?.[1];
				const alt = /<img[^>]+alt="([^"]*)"/.exec(b.innerHTML)?.[1];
				const media: MediaRef | undefined = id ? { wpId: id, kind: "image", ...(src ? { url: src } : {}), ...(alt ? { alt } : {}) } : src ? { url: src, kind: "image", ...(alt ? { alt } : {}) } : undefined;
				const caption = /<figcaption[^>]*>([\s\S]*?)<\/figcaption>/.exec(b.innerHTML)?.[1];
				const href = /<a[^>]+href="([^"]+)"/.exec(b.innerHTML)?.[1];
				return [...(media ? [{ kind: "media" as const, media, role: "content" as const, ...(href ? { link: href } : {}) }] : []), ...(caption ? richFromHtml(`<p>${caption}</p>`, ctx) : [])];
			}
			case "core/gallery": {
				const images = b.innerBlocks.flatMap((i) => leaf(i, path).flatMap((f) => (f.kind === "media" ? [f.media] : [])));
				const legacyIds = Array.isArray(b.attrs.ids) ? (b.attrs.ids as number[]).map((id) => ({ wpId: id, kind: "image" as const })) : [];
				return [{ kind: "gallery", images: images.length ? images : legacyIds, layout: "grid" }];
			}
			case "core/buttons":
				return b.innerBlocks.flatMap((i, k) => leaf(i, `${path}/${k}`));
			case "core/button": {
				const a = /<a([^>]*)>([\s\S]*?)<\/a>/.exec(b.innerHTML);
				const href = a ? /href="([^"]+)"/.exec(a[1] ?? "")?.[1] : undefined;
				const label = (a?.[2] ?? "").replace(/<[^>]+>/g, "").trim();
				const popup = opts.popupFor({ ...(href ? { href } : {}), ...(str(b.attrs.className) ? { classes: str(b.attrs.className) } : {}) });
				return label ? [{ kind: "button", button: { label, href: href ?? (popup ? `#${popup}` : "#"), style: /is-style-outline/.test(str(b.attrs.className) ?? "") ? "secondary" : "primary", ...(/target="_blank"/.test(a?.[1] ?? "") ? { newTab: true } : {}), ...(popup ? { opensPopup: popup } : {}) } }] : [];
			}
			case "core/details": {
				const q = /<summary[^>]*>([\s\S]*?)<\/summary>/.exec(b.innerHTML)?.[1]?.replace(/<[^>]+>/g, "").trim() ?? "";
				const answer = b.innerBlocks.flatMap((i, k) => leaf(i, `${path}/${k}`)).flatMap((f) => (f.kind === "rich" ? f.blocks : []));
				return [{ kind: "faq", question: q, answer }];
			}
			case "core/embed": {
				const url = str(b.attrs.url) ?? "";
				const provider = str(b.attrs.providerNameSlug) ?? "";
				if (/youtube|vimeo/.test(provider) || /youtu|vimeo/.test(url)) return [{ kind: "video", embedUrl: url }];
				// The provider's official embed markup when it follows from the URL (src/adapters/gutenberg/oembed.ts).
				return embedOrLegacy(oembedMarkup(url) ?? `<a href="${url}">${url}</a>`, ctx, `embed ${provider || url}`);
			}
			case "core/video": {
				const src = /<video[^>]+src="([^"]+)"/.exec(b.innerHTML)?.[1];
				const v = typeof b.attrs.id === "number" ? { wpId: b.attrs.id, kind: "video" as const } : src ? { url: src, kind: "video" as const } : undefined;
				return [{ kind: "video", ...(v ? { video: v } : {}) }];
			}
			case "core/audio":
				return audioBlock(b, path);
			case "core/file":
				return fileBlock(b, path, ctx);
			case "core/latest-posts":
				return latestPosts(b, path);
			case "core/query":
				return queryLoop(b, path);
			case "core/html":
				return embedOrLegacy(b.innerHTML, ctx, "core/html");
			case "core/shortcode":
				// Top-level shortcode blocks go through the WPBakery adapter; nested ones are kept and flagged.
				return embedOrLegacy(b.innerHTML, ctx, "shortcode block nested in a layout block");
			case "core/table":
				return embedOrLegacy(b.innerHTML, ctx, "core/table (no table section in v1)");
			case "core/block": {
				const ref = typeof b.attrs.ref === "number" ? b.attrs.ref : undefined;
				const inner = ref ? opts.reusable?.(ref) : undefined;
				if (!inner) {
					diag({ level: "error", code: "unmapped", message: `Reusable block #${ref ?? "?"} not found in the extract`, path, carriesContent: true, tag: b.name });
					return [];
				}
				diag({ level: "info", code: "lossy", message: `Reusable block #${ref} inlined`, path });
				return parseBlocks(inner).flatMap((i, k) => fragmentsOf(i, `${path}/ref${ref}/${k}`));
			}
			default: {
				const text = b.innerHTML.replace(/<[^>]+>/g, "").trim();
				const dynamic = !b.innerHTML.trim();
				// A block of a known library without a handler: its text and inner blocks are kept, and it is still reported.
				const library = libraryOf(b.name);
				const kept = library && (text || b.innerBlocks.length) ? `; ${library} block without a handler, its ${text ? "text" : "inner blocks"} kept` : library ? `; ${library} block without a handler` : "";
				diag({ level: text || dynamic ? "error" : "warn", code: dynamic ? "dynamic" : "unmapped", message: `${b.name}: ${dynamic ? "server-rendered block, content comes from the live render — needs a handler" : "no handler"}${kept}`, path, carriesContent: !!text || dynamic, tag: b.name });
				return [...(text ? richFromHtml(b.innerHTML, ctx) : []), ...b.innerBlocks.flatMap((i, k) => fragmentsOf(i, `${path}/${k}`))];
			}
		}
	}

	/** Attributes of a block that no handler carries (style attributes aside): reported, never silently dropped. */
	function reportUnmapped(b: Block, path: string, handled: string[], why: string) {
		const left = Object.keys(b.attrs).filter((k) => !handled.includes(k) && !STYLE_ATTRS.has(k));
		if (left.length) diag({ level: "info", code: "lossy", message: `${b.name}: ${left.map((k) => `${k}=${JSON.stringify(b.attrs[k]).slice(0, 40)}`).join(", ")} not carried (${why})`, path, tag: b.name });
	}

	/** core/audio: the file (through the media import, like a video), its caption and the source's autoplay/loop flags. */
	function audioBlock(b: Block, path: string): Fragment[] {
		const tag = /<audio\b([^>]*)>/.exec(b.innerHTML)?.[1] ?? "";
		const src = /\bsrc="([^"]+)"/.exec(tag)?.[1] ?? /<source[^>]+src="([^"]+)"/.exec(b.innerHTML)?.[1] ?? str(b.attrs.src);
		const id = typeof b.attrs.id === "number" ? b.attrs.id : undefined;
		const audio: MediaRef | undefined = id ? { wpId: id, kind: "file", ...(src ? { url: src } : {}) } : mediaFrom(src, "file");
		if (!audio) {
			diag({ level: "error", code: "unmapped", message: "core/audio without a file", path, carriesContent: true, tag: b.name });
			return [];
		}
		const caption = /<figcaption[^>]*>([\s\S]*?)<\/figcaption>/.exec(b.innerHTML)?.[1]?.replace(/<[^>]+>/g, "").trim();
		const autoplay = b.attrs.autoplay === true || /\bautoplay\b/.test(tag);
		const loop = b.attrs.loop === true || /\bloop\b/.test(tag);
		reportUnmapped(b, path, ["id", "src", "caption", "autoplay", "loop"], "the player always loads the file's metadata only");
		return [{ kind: "audio", audio, ...(caption ? { caption } : {}), ...(autoplay ? { autoplay: true } : {}), ...(loop ? { loop: true } : {}) }];
	}

	/**
	 * core/file: a link to the file and its download button. Both point at the file itself, so load uploads it to the
	 * media library and rewrites them like any other upload linked from content (src/targets/emdash/documents.ts).
	 */
	function fileBlock(b: Block, path: string, ctx: HandlerCtx): Fragment[] {
		const links = [...b.innerHTML.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({ attrs: m[1] ?? "", text: (m[2] ?? "").replace(/<[^>]+>/g, "").trim(), href: /\bhref="([^"]+)"/.exec(m[1] ?? "")?.[1] }));
		const isButton = (l: { attrs: string }) => /wp-block-file__button/.test(l.attrs);
		const main = links.find((l) => !isButton(l));
		const btn = links.find(isButton);
		const file = str(b.attrs.href) ?? btn?.href ?? main?.href;
		if (!file) {
			diag({ level: "error", code: "unmapped", message: "core/file without a file address", path, carriesContent: true, tag: b.name });
			return [];
		}
		const fileName = (() => {
			try {
				return decodeURIComponent(file.split(/[?#]/)[0]?.split("/").pop() ?? "");
			} catch {
				return file.split("/").pop() ?? "";
			}
		})();
		const label = main?.text || str(b.attrs.fileName)?.replace(/<[^>]+>/g, "").trim() || fileName || "Download";
		const blank = /target="_blank"/.test(main?.attrs ?? "") || b.attrs.textLinkTarget === "_blank";
		// The text may link to the attachment page (textLinkHref), which does not exist after the move: it links to the file.
		if (main?.href && main.href !== file) diag({ level: "info", code: "lossy", message: `core/file: the file name linked to ${main.href} (the attachment page); it links to the file itself now`, path, tag: b.name });
		if (b.attrs.displayPreview === true) diag({ level: "info", code: "lossy", message: "core/file: the inline PDF preview is not rebuilt (the link and download button are)", path, tag: b.name });
		reportUnmapped(b, path, ["id", "href", "fileId", "fileName", "textLinkHref", "textLinkTarget", "showDownloadButton", "downloadButtonText", "displayPreview", "previewHeight"], "the file is a link and a download button");
		const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");
		const out: Fragment[] = richFromHtml(`<p><a href="${esc(file)}"${blank ? ' target="_blank"' : ""}>${esc(label)}</a></p>`, ctx);
		const showButton = b.attrs.showDownloadButton !== false && (btn !== undefined || b.attrs.showDownloadButton === true);
		if (showButton) out.push({ kind: "button", button: { label: btn?.text || str(b.attrs.downloadButtonText)?.replace(/<[^>]+>/g, "").trim() || "Download", href: file, style: "primary" } });
		return out;
	}

	/** Category ids → slugs; ids the extract does not know are reported (the list would show every category). */
	function categorySlugs(ids: number[], b: Block, path: string): string[] {
		const slugs = ids.flatMap((id) => opts.termSlug?.("category", id) ?? []);
		const missing = ids.filter((id) => !opts.termSlug?.("category", id));
		if (missing.length) diag({ level: "warn", code: "lossy", message: `${b.name}: category ${missing.map((id) => `#${id}`).join(", ")} not found in the extract — ${slugs.length ? "left out of the filter" : "the list shows posts of every category"}`, path, tag: b.name });
		return slugs;
	}

	/** A post listing on a site without posts lists nothing: dropped and reported (as for builder post grids). */
	function noPosts(b: Block, path: string): boolean {
		if (opts.postCount > 0) return false;
		diag({ level: "info", code: "dynamic", message: `${b.name}: lists posts, but the site has none — dropped`, path, tag: b.name });
		return true;
	}

	const clampCount = (n: number, b: Block, path: string) => {
		if (n > 50) diag({ level: "warn", code: "lossy", message: `${b.name}: ${n} posts asked for, the list shows at most 50`, path, tag: b.name });
		return Math.min(50, Math.max(1, Math.round(n)));
	};

	/** core/latest-posts → posts_list (newest first, optional categories, which parts of each post show). */
	function latestPosts(b: Block, path: string): Fragment[] {
		if (noPosts(b, path)) return [];
		const a = b.attrs;
		const raw = Array.isArray(a.categories) ? a.categories : a.categories !== undefined && a.categories !== "" ? [a.categories] : [];
		const ids = raw.map((c) => (typeof c === "object" && c ? Number((c as { id?: unknown }).id) : Number(c))).filter((n) => Number.isInteger(n) && n > 0);
		const notes: string[] = [];
		if (a.order === "asc" || (a.orderBy !== undefined && a.orderBy !== "date")) notes.push(`order ${String(a.orderBy ?? "date")} ${String(a.order ?? "desc")} (the list is newest first)`);
		if (a.selectedAuthor !== undefined) notes.push(`only author #${String(a.selectedAuthor)} (the list shows every author)`);
		if (a.displayPostContent === true && a.displayPostContentRadio === "full_post") notes.push("full post text (the list shows the excerpt)");
		if (notes.length) diag({ level: "warn", code: "lossy", message: `${b.name}: ${notes.join("; ")}`, path, tag: b.name });
		const grid = a.postLayout === "grid";
		reportUnmapped(b, path, ["categories", "postsToShow", "displayPostContent", "displayPostContentRadio", "displayPostDate", "displayFeaturedImage", "displayAuthor", "postLayout", "columns", "order", "orderBy", "selectedAuthor"], "the list uses the site's post cards");
		return [
			{
				kind: "posts",
				count: clampCount(typeof a.postsToShow === "number" ? a.postsToShow : 5, b, path),
				categories: categorySlugs(ids, b, path),
				showExcerpt: a.displayPostContent === true,
				showDate: a.displayPostDate === true,
				showImage: a.displayFeaturedImage === true,
				showAuthor: a.displayAuthor === true,
				...(grid ? { columns: Math.min(6, Math.max(1, typeof a.columns === "number" ? a.columns : 3)) } : {}),
			},
		];
	}

	/** core/query (Query Loop) of posts → posts_list; what its post template shows decides the parts of each post. */
	function queryLoop(b: Block, path: string): Fragment[] {
		const q = (b.attrs.query ?? {}) as Record<string, unknown>;
		const postType = str(q.postType) ?? "post";
		// Text around the loop inside the block (a heading above it) is kept.
		const around = b.innerBlocks.filter((i) => !/^core\/(post-template|query-pagination|query-no-results|query-title|query-total)$/.test(i.name)).flatMap((i, k) => fragmentsOf(i, `${path}/${k}`));
		if (postType !== "post") {
			diag({ level: "error", code: "unmapped", message: `core/query: lists "${postType}" entries — only blog posts have a list section`, path, carriesContent: true, tag: b.name });
			return around;
		}
		if (noPosts(b, path)) return around;
		const descendants = (x: Block): Block[] => x.innerBlocks.flatMap((i) => [i, ...descendants(i)]);
		const all = descendants(b);
		const template = all.find((x) => x.name === "core/post-template");
		const shown = new Set(all.map((x) => x.name));
		const notes: string[] = [];
		if (q.inherit === true) diag({ level: "info", code: "lossy", message: "core/query: inherits the page's query — listed as the newest posts", path, tag: b.name });
		if (q.order === "asc" || (q.orderBy !== undefined && q.orderBy !== "date")) notes.push(`order ${String(q.orderBy ?? "date")} ${String(q.order ?? "desc")} (the list is newest first)`);
		if (typeof q.offset === "number" && q.offset > 0) notes.push(`skips the first ${q.offset} post(s) (the list starts at the newest)`);
		if (q.author !== undefined && q.author !== "") notes.push(`only author ${String(q.author)} (the list shows every author)`);
		if (typeof q.search === "string" && q.search) notes.push(`search "${q.search}" (the list is not filtered)`);
		if (Array.isArray(q.exclude) && q.exclude.length) notes.push(`excludes ${q.exclude.length} post(s) (not excluded)`);
		if (q.sticky === "only" || q.sticky === "exclude") notes.push(`sticky posts ${q.sticky === "only" ? "only" : "left out"} (the list shows every post)`);
		if (Array.isArray(q.parents) && q.parents.length) notes.push("only children of chosen posts (the list shows every post)");
		if (Array.isArray(q.format) && q.format.length) notes.push(`only post formats ${q.format.join(", ")} (the list shows every format)`);
		const tax = (q.taxQuery ?? {}) as Record<string, unknown>;
		const otherTax = Object.entries(tax).filter(([k, v]) => k !== "category" && Array.isArray(v) && v.length);
		if (otherTax.length) notes.push(`filtered by ${otherTax.map(([k]) => k).join(", ")} (only category filters are kept)`);
		if (notes.length) diag({ level: "warn", code: "lossy", message: `core/query: ${notes.join("; ")}`, path, tag: b.name });
		const parts = new Set(["core/post-template", "core/post-title", "core/post-excerpt", "core/post-date", "core/post-featured-image", "core/post-author", "core/post-author-name", "core/query-pagination", "core/query-pagination-previous", "core/query-pagination-next", "core/query-pagination-numbers", "core/query-no-results"]);
		const inTemplate = template ? descendants(template) : [];
		const extra = [...new Set(inTemplate.map((x) => x.name).filter((n) => !parts.has(n) && !CONTAINERS.has(n)))];
		if (extra.length) diag({ level: "info", code: "lossy", message: `core/query: the post template's ${extra.join(", ")} not shown (each post shows its picture, title, date, author and excerpt as chosen)`, path, tag: b.name });
		if (shown.has("core/query-pagination")) diag({ level: "info", code: "lossy", message: "core/query: page numbers not rebuilt — the list shows the newest posts; the posts page has numbered pages", path, tag: b.name });
		if (shown.has("core/query-no-results")) diag({ level: "info", code: "lossy", message: "core/query: its no-results text is replaced by the list's own", path, tag: b.name });
		reportUnmapped(b, path, ["query", "queryId", "namespace", "tagName", "displayLayout", "enhancedPagination"], "the list uses the site's post cards");
		const tl = (template?.attrs.layout ?? {}) as { type?: string; columnCount?: number };
		const dl = (b.attrs.displayLayout ?? {}) as { type?: string; columns?: number };
		const columns = tl.type === "grid" ? (tl.columnCount ?? 3) : dl.type === "flex" ? (dl.columns ?? 3) : undefined;
		const ids = (Array.isArray(tax.category) ? tax.category : []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
		return [
			...around,
			{
				kind: "posts",
				count: clampCount(typeof q.perPage === "number" ? q.perPage : Number(q.perPage) || 10, b, path),
				categories: categorySlugs(ids, b, path),
				showExcerpt: shown.has("core/post-excerpt"),
				showDate: shown.has("core/post-date"),
				showImage: shown.has("core/post-featured-image"),
				showAuthor: shown.has("core/post-author") || shown.has("core/post-author-name"),
				...(columns ? { columns: Math.min(6, Math.max(1, columns)) } : {}),
			},
		];
	}

	/** Fragments of any block; containers nested inside a column become subrows. */
	function fragmentsOf(b: Block, path: string): Fragment[] {
		if (b.name === "core/columns") return [{ kind: "subrow", columns: b.innerBlocks.map((c, k) => columnOf(c, `${path}/${k}`)) }];
		if (CONTAINERS.has(b.name)) return mergeRich(b.innerBlocks.flatMap((i, k) => fragmentsOf(i, `${path}/${k}`)));
		if (isLibRow(b)) {
			const cols = libColumns(b, path, libEnv);
			return cols.filter((c) => c.fragments.length).length >= 2 ? [{ kind: "subrow", columns: cols }] : cols.flatMap((c) => c.fragments);
		}
		if (LIB_CONTAINERS.has(b.name)) return mergeRich(b.innerBlocks.flatMap((i, k) => fragmentsOf(i, `${path}/${k}`)));
		return leaf(b, path);
	}

	function columnOf(b: Block, path: string): Col {
		const width = str(b.attrs.width);
		return { ...(width ? { width: percentToFraction(width) } : {}), fragments: mergeRich(b.innerBlocks.flatMap((i, k) => fragmentsOf(i, `${path}/${k}`))) };
	}

	// ── Top level: containers are rows; consecutive prose/leaf blocks are grouped into one row. ──
	const rows: Row[] = [];
	let run: Fragment[] = [];
	let runStart = 0;
	const flush = (i: number) => {
		if (run.length) rows.push({ attrs: {}, columns: [{ fragments: mergeRich(run) }], path: `blocks[${runStart}-${i - 1}]`, raw: "", adapter: "gutenberg" });
		run = [];
		runStart = i;
	};
	const extraSections: { at: number; sections: Section[] }[] = [];
	blocks.forEach((b, i) => {
		const path = `blocks[${i}]`;
		if (b.name === "core/shortcode" || (b.name === "core/freeform" && /\[[a-z_]+[\s\]]/.test(b.innerHTML))) {
			if (opts.asFragments) {
				const r = adaptWpbakery(b.innerHTML, { kind: opts.kind, keys: opts.keys, popupFor: opts.popupFor, postCount: opts.postCount, asFragments: true });
				diagnostics.push(...r.diagnostics);
				if (!run.length) runStart = i;
				run.push(...(r.fragments ?? []));
				return;
			}
			flush(i);
			const r = adaptWpbakery(b.innerHTML, { kind: opts.kind, keys: opts.keys, popupFor: opts.popupFor, postCount: opts.postCount });
			diagnostics.push(...r.diagnostics);
			extraSections.push({ at: rows.length, sections: r.sections });
			runStart = i + 1;
			return;
		}
		// An audio player or a posts list is a section of its own (text between two of them stays between them); the
		// heading that ends the text before it is its title.
		if (!opts.asFragments && (OWN_SECTION.has(b.name) || WOO_GRID_BLOCKS.has(b.name))) {
			const frags = fragmentsOf(b, path);
			if (!frags.some((f) => f.kind === "audio" || f.kind === "posts" || f.kind === "products")) {
				if (!run.length) runStart = i;
				run.push(...frags);
				return;
			}
			const last = run.at(-1);
			let title: Fragment[] = [];
			if (last?.kind === "rich") {
				let k = last.blocks.length;
				while (k > 0 && /^h[1-6]$/.test((last.blocks[k - 1] as PtBlock).style)) k--;
				if (k < last.blocks.length) {
					title = [{ ...last, blocks: last.blocks.slice(k) }];
					run = k ? [...run.slice(0, -1), { ...last, blocks: last.blocks.slice(0, k) }] : run.slice(0, -1);
				}
			}
			flush(i);
			run = [...title, ...frags];
			flush(i + 1);
			return;
		}
		// A block-library item collection (accordion, tabs, testimonials, form, map…) is a section of its own; a heading
		// right before it stays with it as its title.
		if (!opts.asFragments && libraryOf(b.name) && !isLibContainer(b)) {
			const frags = fragmentsOf(b, path);
			if (frags.some((f) => LIB_COLLECTIONS.has(f.kind))) {
				const headingOnly = run.length > 0 && run.every((f) => f.kind === "rich" && f.blocks.length <= 2 && f.blocks.some((x) => /^h[1-6]$/.test(x.style)));
				if (!headingOnly) flush(i);
				if (!run.length) runStart = i;
				run.push(...frags);
				flush(i + 1);
				return;
			}
			if (!run.length) runStart = i;
			run.push(...frags);
			return;
		}
		if (!CONTAINERS.has(b.name) && !isLibContainer(b)) {
			if (!run.length) runStart = i;
			run.push(...fragmentsOf(b, path));
			return;
		}
		flush(i);
		rows.push(containerRow(b, path));
		runStart = i + 1;
	});
	flush(blocks.length);

	function containerRow(b: Block, path: string): Row {
		const attrs = gutenbergStyle(b);
		const raw = JSON.stringify(b).slice(0, 2000);
		if (b.name === "core/columns") return { attrs, columns: b.innerBlocks.map((c, k) => columnOf(c, `${path}/${k}`)), path, raw, adapter: "gutenberg" };
		if (isLibContainer(b)) {
			const style = { ...attrs, ...libStyle(b) };
			return { attrs: style, columns: isLibRow(b) ? libColumns(b, path, libEnv) : [{ fragments: mergeRich(b.innerBlocks.flatMap((i, k) => fragmentsOf(i, `${path}/${k}`))) }], path, raw, adapter: "gutenberg" };
		}
		if (b.name === "core/media-text") {
			const id = typeof b.attrs.mediaId === "number" ? b.attrs.mediaId : undefined;
			const url = str(b.attrs.mediaUrl);
			const media: MediaRef | undefined = id ? { wpId: id, kind: str(b.attrs.mediaType) === "video" ? "video" : "image", ...(url ? { url } : {}) } : mediaFrom(url);
			const mediaCol: Col = { fragments: media ? [{ kind: "media", media, role: "content" }] : [] };
			const textCol: Col = { fragments: mergeRich(b.innerBlocks.flatMap((i, k) => fragmentsOf(i, `${path}/${k}`))) };
			return { attrs, columns: b.attrs.mediaPosition === "right" ? [textCol, mediaCol] : [mediaCol, textCol], path, raw, adapter: "gutenberg" };
		}
		if (b.name === "core/cover") {
			const id = typeof b.attrs.id === "number" ? b.attrs.id : undefined;
			const url = str(b.attrs.url);
			if (b.attrs.backgroundType === "video") attrs.video_bg = "yes";
			if (id || url) attrs[b.attrs.backgroundType === "video" ? "video_mp4" : "bg_image"] = id ? String(id) : (url as string);
			attrs.full_height = typeof b.attrs.minHeight === "number" && b.attrs.minHeight >= 70 && b.attrs.minHeightUnit === "vh" ? "yes" : "";
			if (typeof b.attrs.dimRatio === "number") attrs.color_overlay = `rgba(0,0,0,${b.attrs.dimRatio / 100})`;
			attrs.text_color = b.attrs.isDark === false ? "dark" : "light";
		}
		return { attrs, columns: [{ fragments: mergeRich(b.innerBlocks.flatMap((i, k) => fragmentsOf(i, `${path}/${k}`))) }], path, raw, adapter: "gutenberg" };
	}

	if (opts.asFragments) {
		const fragments = mergeRich(
			rows.flatMap((r): Fragment[] => {
				// A cover's picture stays as a picture above its text (no section background inside another layout).
				const bg = r.attrs.video_bg ? undefined : mediaFrom(r.attrs.bg_image);
				if (bg) diag({ level: "info", code: "lossy", message: "core/cover background shown as a picture above its text (post content inside a page-builder layout)", path: r.path });
				const body = r.columns.filter((c) => c.fragments.length).length > 1 ? [{ kind: "subrow" as const, columns: r.columns }] : r.columns.flatMap((c) => c.fragments);
				return [...(bg ? [{ kind: "media" as const, media: bg, role: "content" as const }] : []), ...body];
			}),
		);
		return withForms({ sections: [], diagnostics, fragments });
	}

	const sections: Section[] = [];
	rows.forEach((row, i) => {
		for (const x of extraSections.filter((e) => e.at === i)) sections.push(...x.sections);
		const forced = opts.rowOverrides?.[row.path];
		if (forced === "drop") return;
		for (const v of splitRow(row)) sections.push(...recognise(v, { first: sections.length === 0, kind: opts.kind, ...(forced ? { forced } : {}), keys: opts.keys, diag }));
	});
	for (const x of extraSections.filter((e) => e.at >= rows.length)) sections.push(...x.sections);
	return withForms({ sections, diagnostics });
}

/** Map block styling onto the WPBakery-style attrs the recognisers read. */
function gutenbergStyle(b: Block): Record<string, string> {
	const a: Record<string, string> = {};
	const style = (b.attrs.style ?? {}) as { color?: { background?: string; text?: string } };
	const bg = style.color?.background ?? (str(b.attrs.backgroundColor) ? `var(--wp--preset--color--${b.attrs.backgroundColor})` : undefined) ?? str(b.attrs.customOverlayColor);
	if (bg) a.bg_color = bg;
	const text = style.color?.text ?? str(b.attrs.textColor);
	if (text) a.text_color = /white|light|#fff/i.test(text) ? "light" : "dark";
	const anchor = str(b.attrs.anchor);
	if (anchor) a.id = anchor;
	if (str(b.attrs.align) === "full") a.type = "full_width_content";
	return a;
}

function percentToFraction(w: string): string {
	const n = Number.parseFloat(w);
	if (!Number.isFinite(n)) return w;
	const known: [number, string][] = [[25, "1/4"], [33.33, "1/3"], [50, "1/2"], [66.66, "2/3"], [75, "3/4"]];
	return known.find(([p]) => Math.abs(p - n) < 1)?.[1] ?? `${Math.round(n)}/100`;
}

function serialiseList(b: Block): string {
	const tag = b.attrs.ordered ? "ol" : "ul";
	if (!b.innerBlocks.length) return b.innerHTML;
	const items = b.innerBlocks.map((li) => {
		const nested = li.innerBlocks.map(serialiseList).join("");
		return li.innerHTML.replace(/<\/li>\s*$/, `${nested}</li>`);
	});
	return `<${tag}>${items.join("")}</${tag}>`;
}
