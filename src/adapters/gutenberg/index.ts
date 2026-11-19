/**
 * Gutenberg + classic adapter (PLAN §7). Block comments → block tree (same shape as WordPress's
 * parser) → rows → the shared section recognisers. Classic content (no blocks) becomes rich text.
 */
import type { Diagnostic, MediaRef, Section, SectionType } from "../../ir/schema.js";
import { autop, type Keys } from "../../ir/portable-text.js";
import { embedOrLegacy, type Fragment, type HandlerCtx, mediaFrom, richFromHtml } from "../wpbakery/elements.js";
import { adaptWpbakery, mergeRich, recognise, type Row, splitRow } from "../wpbakery/index.js";
import type { Col } from "../wpbakery/elements.js";

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
}

const DECORATIVE = new Set(["core/spacer", "core/separator", "core/nextpage", "core/more"]);
const PROSE = new Set(["core/paragraph", "core/heading", "core/list", "core/list-item", "core/quote", "core/pullquote", "core/verse", "core/preformatted", "core/code", "core/freeform", "core/footnotes"]);
const CONTAINERS = new Set(["core/group", "core/columns", "core/cover", "core/media-text", "core/row", "core/stack"]);
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);

/**
 * Post content as fragments, for a page builder that shows it inside its own layout (a Bricks post-content element or
 * `{post_content}` tag): blocks, classic text and shortcodes (forms…) through the same handlers as a whole page.
 */
export function gutenbergFragments(content: string, opts: Omit<GutenbergOptions, "asFragments" | "rowOverrides">): { fragments: Fragment[]; diagnostics: Diagnostic[] } {
	const r = adaptGutenberg(content, { ...opts, asFragments: true });
	return { fragments: r.fragments ?? [], diagnostics: r.diagnostics };
}

export function adaptGutenberg(content: string, opts: GutenbergOptions): { sections: Section[]; diagnostics: Diagnostic[]; fragments?: Fragment[] } {
	const diagnostics: Diagnostic[] = [];
	const diag = (d: Diagnostic) => diagnostics.push(d);
	const ctxFor = (path: string): HandlerCtx => ({ keys: opts.keys, path, diag, popupFor: opts.popupFor, postCount: opts.postCount, children: () => [] });
	const blocks = parseBlocks(content);

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
				return embedOrLegacy(`<a href="${url}">${url}</a>`, ctx, `embed ${provider || url}`);
			}
			case "core/video": {
				const src = /<video[^>]+src="([^"]+)"/.exec(b.innerHTML)?.[1];
				const v = typeof b.attrs.id === "number" ? { wpId: b.attrs.id, kind: "video" as const } : src ? { url: src, kind: "video" as const } : undefined;
				return [{ kind: "video", ...(v ? { video: v } : {}) }];
			}
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
				diag({ level: text || dynamic ? "error" : "warn", code: dynamic ? "dynamic" : "unmapped", message: `${b.name}: ${dynamic ? "server-rendered block, content comes from the live render — needs a handler" : "no handler"}`, path, carriesContent: !!text || dynamic, tag: b.name });
				return [...(text ? richFromHtml(b.innerHTML, ctx) : []), ...b.innerBlocks.flatMap((i, k) => fragmentsOf(i, `${path}/${k}`))];
			}
		}
	}

	/** Fragments of any block; containers nested inside a column become subrows. */
	function fragmentsOf(b: Block, path: string): Fragment[] {
		if (b.name === "core/columns") return [{ kind: "subrow", columns: b.innerBlocks.map((c, k) => columnOf(c, `${path}/${k}`)) }];
		if (CONTAINERS.has(b.name)) return mergeRich(b.innerBlocks.flatMap((i, k) => fragmentsOf(i, `${path}/${k}`)));
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
		if (!CONTAINERS.has(b.name)) {
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
		return { sections: [], diagnostics, fragments };
	}

	const sections: Section[] = [];
	rows.forEach((row, i) => {
		for (const x of extraSections.filter((e) => e.at === i)) sections.push(...x.sections);
		const forced = opts.rowOverrides?.[row.path];
		if (forced === "drop") return;
		for (const v of splitRow(row)) sections.push(...recognise(v, { first: sections.length === 0, kind: opts.kind, ...(forced ? { forced } : {}), keys: opts.keys, diag }));
	});
	for (const x of extraSections.filter((e) => e.at >= rows.length)) sections.push(...x.sections);
	return { sections, diagnostics };
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
