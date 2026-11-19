/**
 * WPBakery + Salient adapter: shortcode AST → rows → sections (PLAN §6).
 * Layer 1: element handlers (elements.ts) turn each shortcode into typed fragments.
 * Layer 2: row recognisers (below) look at a whole row and pick the section type.
 * Unrecognised rows fall back to `columns`, never to raw HTML.
 */
import { createHash } from "node:crypto";
import type { Button, Diagnostic, MediaRef, PtBlock, RichText, Section, SectionType } from "../../ir/schema.js";
import type { Keys } from "../../ir/portable-text.js";
import { colourValue, columnFraction, isDarkColour, parseVcCss, spacingFromPadding } from "./decode.js";
import { type BoxHeight, type Col, CONTAINERS, DECORATIVE, type Fragment, GROUPS, HANDLERS, type HandlerCtx, LINE_LEADING, linkBlock, mediaFrom, richFromHtml } from "./elements.js";
import { type AstNode, parseShortcodes, serialise, type ShortcodeNode } from "./parser.js";

export interface AdaptOptions {
	kind: "page" | "post" | "partial" | "popup";
	keys: Keys;
	popupFor: HandlerCtx["popupFor"];
	postCount: number;
	/** overrides.ts → elements: `vc_row[3]` → forced section type or "drop". */
	rowOverrides?: Record<string, SectionType | "drop">;
}

export interface AdaptResult {
	sections: Section[];
	diagnostics: Diagnostic[];
}

export interface Row {
	/** WPBakery-style row attributes (other adapters map their styling onto these names). */
	attrs: Record<string, string>;
	columns: Col[];
	path: string;
	raw: string;
	adapter?: "wpbakery" | "gutenberg" | "classic" | "bricks";
}

/** Shortcodes that render inline text inside a paragraph; kept as a token the starter fills in. */
const INLINE_TOKENS: Record<string, string> = { nectar_current_year: "{year}", year: "{year}", current_year: "{year}" };

const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 10);

export function adaptWpbakery(content: string, opts: AdaptOptions): AdaptResult {
	const diagnostics: Diagnostic[] = [];
	const diag = (d: Diagnostic) => diagnostics.push(d);
	const ast = parseShortcodes(content);

	const makeCtx = (path: string): HandlerCtx => ({
		keys: opts.keys,
		path,
		diag,
		popupFor: opts.popupFor,
		postCount: opts.postCount,
		children: (n, p) => processChildren(n.children, p),
	});

	function dispatch(n: ShortcodeNode, path: string): Fragment[] {
		const ctx = makeCtx(path);
		if (DECORATIVE.has(n.tag)) {
			diag({ level: "info", code: "dropped-decorative", message: `${n.tag} dropped (decorative)`, path, tag: n.tag });
			return processChildren(n.children, path);
		}
		const h = HANDLERS[n.tag] ?? GROUPS[n.tag];
		if (h) return h(n, ctx);
		if (n.tag === "vc_row_inner") return subrowFragments(n, path);
		if (n.tag === "vc_text_separator") return n.attrs.title ? [{ kind: "rich", blocks: richFromHtml(`<h4>${n.attrs.title}</h4>`, ctx).flatMap((f) => (f.kind === "rich" ? f.blocks : [])) }] : [];
		const carries = carriesContent(n);
		diag({ level: carries ? "error" : "warn", code: "unmapped", message: `No handler for [${n.tag}]${carries ? " (carries content)" : ""}`, path, carriesContent: carries, tag: n.tag });
		return processChildren(n.children, path);
	}

	function processChildren(children: AstNode[], path: string): Fragment[] {
		const out: Fragment[] = [];
		let html = "";
		const flush = () => {
			if (html.replace(/<\/?p>|<br\s*\/?>|&nbsp;|\s/g, "")) out.push(...richFromHtml(html, makeCtx(path)));
			html = "";
		};
		children.forEach((c, i) => {
			if (c.type === "text") {
				html += c.text;
				return;
			}
			const inline = INLINE_TOKENS[c.tag];
			if (inline) {
				diag({ level: "info", code: "dynamic", message: `[${c.tag}] rendered dynamically as ${inline}`, path: `${path}/${c.tag}[${i}]`, tag: c.tag });
				html += inline;
				return;
			}
			flush();
			out.push(...dispatch(c, `${path}/${c.tag}[${i}]`));
		});
		flush();
		return mergeRich(out);
	}

	function columnOf(n: ShortcodeNode, path: string): Col {
		const fragments: Fragment[] = [];
		const bgImage = mediaFrom(n.attrs.background_image);
		if (bgImage) {
			const height = spacerHeight(n);
			const parallax = n.attrs.parallax_bg === "true" ? PARALLAX_SPEED[n.attrs.parallax_bg_speed ?? "medium"] : undefined;
			const radius = /^\d+(?:\.\d+)?px$/.test(n.attrs.column_border_radius ?? "") && Number.parseFloat(n.attrs.column_border_radius ?? "") > 0 ? n.attrs.column_border_radius : undefined;
			fragments.push({ kind: "media", media: bgImage, role: "background", ...(height ? { height } : {}), ...(parallax ? { parallax } : {}), ...(radius ? { radius } : {}) });
		}
		fragments.push(...processChildren(n.children, path));
		// Salient column_element_spacing is a bottom margin on every element but the last. Block elements' top margins
		// collapse into it; an inline-block button's (nectar_btn) adds to it.
		const spacing = /^(\d+)px$/.exec(n.attrs.column_element_spacing ?? "")?.[1];
		if (spacing && Number(spacing) > 0)
			fragments.forEach((f, i) => {
				if (i > 0 && f.kind === "button" && f.inline && f.button.spaceAbove) f.button = { ...f.button, spaceAbove: f.button.spaceAbove + Number(spacing) };
			});
		// A button right under a dotted list (Salient fancy-ul): the list's 30px bottom margin is the space above it
		// (it collapses with the element spacing).
		fragments.forEach((f, i) => {
			const prev = fragments[i - 1];
			if (f.kind === "button" && !f.button.spaceAbove && prev?.kind === "rich" && prev.list === "dots" && prev.blocks.at(-1)?.listItem) f.button = { ...f.button, spaceAbove: FANCY_LIST_GAP };
		});
		const color = colourValue(n.attrs.background_color);
		const spacer = columnSpacer(n);
		const overlay = columnOverlay(n.attrs);
		const pct = /^padding-(\d+)-percent$/.exec(n.attrs.column_padding ?? "")?.[1];
		const inset = pct && ["left", "all"].includes(n.attrs.column_padding_position ?? "all") && Number(pct) > 0 ? `${pct}vw` : undefined;
		const inner = n.children.flatMap((r) => (r.type === "shortcode" && r.tag === "vc_row_inner" ? r.children : [])).filter((c): c is ShortcodeNode => c.type === "shortcode" && c.tag === "vc_column_inner" && c.children.length > 0);
		const centered = n.attrs.centered_text === "true" || (inner.length > 0 && inner.length === n.children.filter((c) => c.type === "shortcode").length && inner.every((c) => c.attrs.centered_text === "true"));
		const rows = n.children.filter((c): c is ShortcodeNode => c.type === "shortcode");
		const intensity = Number.parseFloat(n.attrs.column_parallax_intensity ?? "");
		const motion = Number.isFinite(intensity) && intensity > 0 && intensity <= 10 ? Math.round(intensity * 100) / 1000 : undefined;
		const first = rows[0]?.tag === "vc_row_inner" ? rows[0].attrs : undefined;
		const leadTop = first && /^0*(?:px)?$/.test(first.top_padding_tablet ?? "x") ? cssLen(first.top_padding) : undefined;
		const right = rows.length > 0 && rows.every((r) => r.tag === "vc_row_inner" && r.attrs.text_align === "right");
		const gapPhone = Number.parseFloat(n.attrs.bottom_margin_phone ?? "");
		const textInset = rows.length === 1 && rows[0]?.tag === "vc_row_inner" ? innerTextInset(rows[0].attrs) : undefined;
		const headingGap = rows.length > 1 && rows[0]?.tag === "vc_row_inner" ? loneHeadingGap(rows[0]) : undefined;
		return { ...(headingGap ? { headingGap } : {}), ...(gapPhone > 0 && gapPhone <= 400 ? { gapPhone } : {}), ...(textInset ? { textInset } : {}), ...(inset ? { insetStart: inset } : {}), ...(centered ? { centered: true } : {}), ...(right && !centered ? { right: true } : {}), ...(motion ? { motion } : {}), ...(leadTop ? { leadTop } : {}), ...(n.attrs.tablet_text_alignment === "center" ? { tabletCenter: true } : {}), ...(n.attrs.width ? { width: n.attrs.width } : {}), fragments, ...(color ? { background: { color } } : {}), ...(n.attrs.phone_text_alignment === "center" ? { phoneCenter: true } : {}), ...(spacer ? { spacer } : {}), ...(overlay ? { overlay } : {}), ...(bgImage && n.attrs.parallax_bg === "true" ? { parallax: true } : {}) };
	}

	/** vc_row_inner: one column → its fragments inline; several → a subrow fragment. */
	function subrowFragments(n: ShortcodeNode, path: string): Fragment[] {
		const gap = /^\d+px$/.test(n.attrs.column_margin ?? "") ? n.attrs.column_margin : undefined;
		const cols = n.children
			.flatMap((c, i) => (c.type === "shortcode" && c.tag === "vc_column_inner" ? [columnOf(c, `${path}/vc_column_inner[${i}]`)] : []))
			.map((c) => (gap ? { ...c, fragments: c.fragments.map((f) => (f.kind === "team" ? { ...f, gap } : f)) } : c));
		const stray = n.children.filter((c) => c.type === "shortcode" && c.tag !== "vc_column_inner") as ShortcodeNode[];
		const strayFrags = stray.flatMap((s) => dispatch(s, `${path}/${s.tag}`));
		const nonEmpty = cols.filter((c) => c.fragments.length);
		if (nonEmpty.length <= 1) {
			// Equal side padding on a one-column inner row (Salient left/right_padding_desktop) insets a question list.
			const l = n.attrs.left_padding_desktop;
			const inset = l && l === n.attrs.right_padding_desktop && /^\d+(?:\.\d+)?(?:%|px)$/.test(l) && Number.parseFloat(l) > 0 ? l : undefined;
			const frags = (nonEmpty[0]?.fragments ?? []).map((f) => (inset && f.kind === "faq" ? { ...f, look: { ...f.look, inset } } : f));
			return [...frags, ...strayFrags];
		}
		return [{ kind: "subrow", columns: cols }, ...strayFrags];
	}

	// ── Rows ──────────────────────────────────────────────────────────────────
	const rows: Row[] = [];
	const loose: AstNode[] = [];
	ast.forEach((node, i) => {
		if (node.type === "shortcode" && (node.tag === "vc_row" || node.tag === "vc_section")) {
			if (loose.length) {
				rows.push(looseRow(loose.splice(0), `loose[${i}]`));
			}
			const path = `${node.tag}[${rows.length}]`;
			if (node.attrs.disable_element === "yes") {
				diag({ level: "info", code: "dropped-decorative", message: "Row is disabled in WPBakery (hidden on the live site) — not migrated", path });
				return;
			}
			if (node.tag === "vc_section") {
				// Sections wrap rows: adapt the inner rows in order.
				for (const [j, inner] of node.children.entries()) if (inner.type === "shortcode" && inner.tag === "vc_row") rows.push(rowOf(inner, `${path}/vc_row[${j}]`));
				return;
			}
			rows.push(rowOf(node, path));
		} else loose.push(node);
	});
	if (loose.length) rows.push(looseRow(loose, `loose[${ast.length}]`));

	function rowOf(n: ShortcodeNode, path: string): Row {
		const columns = n.children.flatMap((c, i) => (c.type === "shortcode" && c.tag === "vc_column" ? [columnOf(c, `${path}/vc_column[${i}]`)] : []));
		const other = n.children.filter((c) => !(c.type === "shortcode" && c.tag === "vc_column"));
		if (other.some((c) => (c.type === "text" ? c.text.replace(/<[^>]+>|\s|&nbsp;/g, "") : true))) {
			columns.push({ fragments: processChildren(other, `${path}/loose`) });
		}
		return { attrs: n.attrs, columns, path, raw: serialise(n) };
	}

	function looseRow(nodes: AstNode[], path: string): Row {
		// Content outside vc_row (classic text before the builder was used, or plain shortcodes).
		return { attrs: {}, columns: [{ fragments: processChildren(nodes, path) }], path, raw: nodes.map((n) => (n.type === "text" ? n.text : serialise(n))).join("") };
	}

	// ── Sections ──────────────────────────────────────────────────────────────
	const sections: Section[] = [];
	rows.forEach((row) => {
		const forced = opts.rowOverrides?.[row.path];
		if (forced === "drop") {
			diag({ level: "info", code: "dropped-decorative", message: "Row dropped by overrides.ts", path: row.path });
			return;
		}
		const rowSections: Section[] = [];
		for (const virtual of splitRow(row)) {
			rowSections.push(...recognise(virtual, { first: sections.length + rowSections.length === 0, kind: opts.kind, ...(forced ? { forced } : {}), keys: opts.keys, diag }));
		}
		sections.push(...mergeCollections(rowSections));
	});
	return { sections, diagnostics };
}

const CONTENT_ATTR = /^(text|title|content|heading|subtitle|name|quote|label|caption|description|link_text|button_text|text_content|header|subject|url|link|link_url|href|image|images|image_url|img|video_url|video_mp4|src|id)$|_text$|_content$|_url$|_title$/i;

/** Does an unknown shortcode carry text, links, images or forms (vs. pure layout/decoration)? */
export function carriesContent(n: ShortcodeNode): boolean {
	const ownText = n.children.some((c) => c.type === "text" && c.text.replace(/<[^>]+>|&nbsp;|\s/g, "").length > 0);
	if (ownText) return true;
	if (Object.entries(n.attrs).some(([k, v]) => CONTENT_ATTR.test(k) && v.trim() !== "" && !/^(none|default|yes|no|true|false)$/i.test(v))) return true;
	return n.children.some((c) => c.type === "shortcode" && carriesContent(c));
}

/** Consecutive sections of the same collection type from one source row are one section (e.g. a team member per inner row). */
const MERGEABLE: Partial<Record<SectionType, string>> = { team: "members", testimonials: "items", faq: "items", stats: "items", gallery: "images" };
export function mergeCollections(sections: Section[]): Section[] {
	const out: Section[] = [];
	for (const s of sections) {
		const prev = out.at(-1);
		const key = MERGEABLE[s.type];
		const f = s.fields as Record<string, unknown>;
		if (prev && key && prev.type === s.type && !f.heading && !(Array.isArray(f.intro) && f.intro.length)) {
			const pf = prev.fields as Record<string, unknown[]>;
			(pf[key] as unknown[]).push(...(f[key] as unknown[]));
			continue;
		}
		out.push(s);
	}
	return out;
}

// ── Row splitting: single-column rows that stack inner multi-column rows become several virtual rows ──
export function splitRow(row: Row): Row[] {
	const nonEmpty = row.columns.filter((c) => c.fragments.length);
	if (!nonEmpty.length) return [];
	if (nonEmpty.length > 1) return [{ ...row, columns: expandColumns(nonEmpty) }];
	const col = nonEmpty[0] as Col;
	if (!col.fragments.some((f) => f.kind === "subrow")) return [row];
	const out: Row[] = [];
	let run: Fragment[] = [];
	const flushRun = () => {
		if (run.length) out.push({ ...row, columns: [{ ...col, fragments: run }], path: `${row.path}#${out.length}` });
		run = [];
	};
	for (const f of col.fragments) {
		if (f.kind === "subrow") {
			flushRun();
			out.push({ ...row, columns: f.columns.filter((c) => c.fragments.length).map((c) => ({ ...c, fragments: flattenSubrows(c.fragments) })), path: `${row.path}#${out.length}` });
		} else run.push(f);
	}
	flushRun();
	// A run that is only a heading (plus an eyebrow) right before an inner row of collection items
	// (team members, prices, questions…) is that collection's heading, not a section of its own.
	const merged: Row[] = [];
	for (let i = 0; i < out.length; i++) {
		const r = out[i] as Row;
		const next = out[i + 1];
		const frags = r.columns.length === 1 ? (r.columns[0] as Col).fragments : [];
		const blocks = frags.flatMap((f) => (f.kind === "rich" ? f.blocks : []));
		const headingOnly = frags.length > 0 && frags.every((f) => f.kind === "rich") && blocks.length <= 3 && blocks.some(isHeading) && words(blocks) <= 16;
		const nextCol = next?.columns[0];
		if (headingOnly && next && nextCol && next.columns.some((c) => c.fragments.some((f) => (COLLECTIONS as readonly string[]).includes(f.kind)))) {
			merged.push({ ...next, columns: [{ ...nextCol, fragments: [...frags, ...nextCol.fragments] }, ...next.columns.slice(1)] });
			i++;
		} else merged.push(r);
	}
	// Only the first virtual row keeps the anchor id.
	return merged.map((r, i) => ({ ...r, path: merged.length === out.length ? r.path : `${row.path}#${i}`, ...(i === 0 ? {} : { attrs: { ...r.attrs, id: "", el_id: "" } }) }));
}

/**
 * A column that is only an inner multi-column row (plus maybe text before it) becomes those inner
 * columns, with widths multiplied (½ × ½ → ¼): a footer "text | address | connect" stays three
 * side-by-side columns instead of collapsing two of them into one.
 */
function expandColumns(cols: Col[]): Col[] {
	const out: Col[] = [];
	const frac = (w?: string) => {
		const m = /^(\d+)\/(\d+)$/.exec(w ?? "");
		return m ? Number(m[1]) / Number(m[2]) : undefined;
	};
	const toWidth = (f: number) => [[1 / 4, "1/4"], [1 / 3, "1/3"], [1 / 2, "1/2"], [2 / 3, "2/3"], [3 / 4, "3/4"], [1 / 6, "1/6"]].find(([v]) => Math.abs((v as number) - f) < 0.01)?.[1] as string | undefined;
	for (const c of cols) {
		const subrows = c.fragments.filter((f) => f.kind === "subrow") as Extract<Fragment, { kind: "subrow" }>[];
		const others = c.fragments.filter((f) => f.kind !== "subrow");
		const sub = subrows[0];
		if (subrows.length === 1 && sub && others.every((f) => f.kind === "media" && f.role === "background")) {
			const outer = frac(c.width) ?? 1;
			for (const ic of sub.columns.filter((x) => x.fragments.length)) {
				const w = toWidth(outer * (frac(ic.width) ?? 1 / sub.columns.length));
				// Text alignment set on the outer column carries into its inner columns (CSS inheritance in the source).
				const inherit = { ...(c.phoneCenter ? { phoneCenter: true } : {}), ...(c.tabletCenter ? { tabletCenter: true } : {}), ...(c.centered ? { centered: true } : {}) };
				out.push({ ...inherit, ...ic, ...(w ? { width: w } : {}), fragments: flattenSubrows(ic.fragments) });
			}
		} else out.push({ ...c, fragments: flattenSubrows(c.fragments) });
	}
	return out;
}

function flattenSubrows(frags: Fragment[]): Fragment[] {
	return frags.flatMap((f) => (f.kind === "subrow" ? f.columns.flatMap((c) => flattenSubrows(c.fragments)) : [f]));
}

export function mergeRich(frags: Fragment[]): Fragment[] {
	const out: Fragment[] = [];
	// Salient stacks one-line elements with no paragraph space between them: consecutive lines become one
	// paragraph with line breaks (each line keeps its own link).
	let lineBlock: RichText[number] | undefined;
	for (const f of frags) {
		const last = out.at(-1);
		if (f.kind === "rich" && f.line && lineBlock && last?.kind === "rich" && last.blocks.at(-1) === lineBlock && f.blocks.length === 1) {
			const next = f.blocks[0] as RichText[number];
			lineBlock.children.push({ _type: "span", _key: `${next._key}-br`, text: "\n", marks: [] }, ...next.children);
			lineBlock.markDefs.push(...next.markDefs);
			continue;
		}
		if (f.kind === "rich" && last?.kind === "rich") {
			last.blocks.push(...f.blocks);
			if (f.list) last.list = f.list;
		} else out.push(f.kind === "rich" ? { kind: "rich", blocks: [...f.blocks], ...(f.list ? { list: f.list } : {}) } : f);
		lineBlock = f.kind === "rich" && f.line ? (out.at(-1) as { blocks: RichText }).blocks.at(-1) : undefined;
	}
	return out;
}

// ── Recognisers ─────────────────────────────────────────────────────────────
export interface RecogniseCtx {
	first: boolean;
	kind: AdaptOptions["kind"];
	forced?: SectionType | "drop";
	keys: Keys;
	diag: (d: Diagnostic) => void;
}

/** Collection sections that carry an intro (the text between their heading and their items). */
const INTRO_COLLECTIONS = new Set<string>(["faq", "team", "price", "form", "feature"]);
const COLLECTIONS = ["faq", "tab", "team", "testimonial", "gallery", "price", "stat", "form", "embed", "video", "map", "marquee", "legacy", "feature"] as const;
type CollectionKind = (typeof COLLECTIONS)[number];

const isHeading = (b: PtBlock) => /^h[1-6]$/.test(b.style);
const words = (blocks: RichText) => blocks.map((b) => b.children.map((c) => c.text).join("")).join(" ").split(/\s+/).filter(Boolean).length;

function rowTheme(row: Row): { theme: Section["theme"]; spacing: Section["spacing"]; fullHeight?: boolean; anchorId?: string; width?: "full"; gap?: "none"; valign?: "top" | "middle" | "bottom" } {
	const a = row.attrs;
	const color = colourValue(a.bg_color);
	const image = mediaFrom(a.bg_image);
	const video = a.video_bg ? mediaFrom(a.video_mp4 ?? a.video_webm, "video") : undefined;
	const overlay = a.color_overlay ? overlayStrength(a.color_overlay, a.overlay_strength) : undefined;
	let tone: "light" | "dark" = "light";
	if (a.text_color === "light") tone = "dark";
	else if (a.text_color === "dark") tone = "light";
	else if (isDarkColour(color)) tone = "dark";
	else if ((image || video) && a.text_color !== "dark") tone = "dark";
	const css = parseVcCss(a.css);
	const spacing = spacingFromPadding(a.top_padding ?? css["padding-top"], a.bottom_padding ?? css["padding-bottom"]) ?? "normal";
	const anchor = (a.el_id || a.id || "").trim();
	const gradient = a.gradient_type === "advanced" && /^(?:linear|radial)-gradient\([^;{}<>]*\)$/.test(a.advanced_gradient ?? "") ? a.advanced_gradient : undefined;
	const background = color || image || video || gradient ? { ...(color ? { color } : {}), ...(image ? { image } : {}), ...(video ? { video } : {}), ...(overlay !== undefined ? { overlay } : {}), ...(gradient ? { gradient } : {}), ...(image && (a.parallax_bg === "true" || a.bg_image_animation === "parallax") ? { motion: "parallax" as const } : {}) } : undefined;
	const valign = a.full_height === "yes" || a.content_placement ? ({ top: "top", middle: "middle", bottom: "bottom" } as const)[(a.full_screen_row_position ?? a.content_placement ?? "") as "top"] : undefined;
	return {
		theme: { tone, ...(background ? { background } : {}) },
		spacing,
		...(a.full_height === "yes" ? { fullHeight: true } : {}),
		...(anchor && /^[A-Za-z][\w-]*$/.test(anchor) ? { anchorId: anchor } : {}),
		...(a.type === "full_width_content" ? { width: "full" as const } : {}),
		...(a.column_margin === "none" ? { gap: "none" as const } : {}),
		...(valign ? { valign } : {}),
	};
}

function overlayStrength(color: string, strength?: string): number {
	const alpha = /rgba\([^)]*,\s*([\d.]+)\s*\)/.exec(color)?.[1];
	const n = Number.parseFloat(alpha ?? strength ?? "0.3");
	return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0.3));
}

export function recognise(row: Row, ctx: RecogniseCtx): Section[] {
	const look = rowTheme(row);
	const base = (type: SectionType, variant?: string) => ({
		type,
		...(variant ? { variant } : {}),
		theme: look.theme,
		spacing: look.spacing,
		...(look.fullHeight ? { fullHeight: true } : {}),
		...(look.anchorId ? { anchorId: look.anchorId } : {}),
		...(look.width ? { width: look.width } : {}),
		...(look.gap ? { gap: look.gap } : {}),
		...(look.valign ? { valign: look.valign } : {}),
		...(CENTRED_QUOTE.test(row.raw) ? { quoteStyle: "centered" as const } : {}),
		...headingLook(row.raw),
		...headLook(row.raw),
		...(!/#[1-9]\d*$/.test(row.path) ? leadSpacer(row.raw) : {}),
		...(row.columns.some((c) => c.fragments.length) && row.columns.filter((c) => c.fragments.length).every((c) => c.phoneCenter) ? { phoneAlign: "center" as const } : {}),
		...(row.columns.some((c) => c.fragments.length) && row.columns.filter((c) => c.fragments.length).every((c) => c.tabletCenter) ? { tabletAlign: "center" as const } : {}),
		...(type === "columns" ? { stackGap: /^\d+(?:px|%)$/.test(row.attrs.column_margin ?? "") ? 25 : 0 } : {}),
		// A hero's content sits over its background; the row padding does not move it.
		...(row.attrs.type === "full_width_content" && type !== "hero" ? rowPad(row.attrs) : {}),
		sourceRef: { adapter: row.adapter ?? ("wpbakery" as const), path: row.path, rawHash: hash(row.raw) },
	});
	const cols = row.columns.filter((c) => c.fragments.length);
	const all = cols.flatMap((c) => c.fragments);
	const kinds = new Set(all.map((f) => f.kind));
	const collections = COLLECTIONS.filter((k) => kinds.has(k));
	const rich = all.flatMap((f) => (f.kind === "rich" ? f.blocks : []));
	const buttons = all.flatMap((f) => (f.kind === "button" ? [f.button] : []));
	const media = all.flatMap((f) => (f.kind === "media" ? [f] : []));
	const icons = all.flatMap((f) => (f.kind === "icon" ? [f.icon] : []));

	const sections: Section[] = [];
	const push = (s: unknown) => sections.push(s as Section);

	if (ctx.forced && ctx.forced !== "drop") ctx.diag({ level: "info", code: "lossy", message: `Section type forced to ${ctx.forced} by overrides.ts`, path: row.path });

	// 1. Collections (one dominant collection kind; extra text becomes heading/intro/aside).
	const mainCollection = pickCollection(collections);
	if (mainCollection && (!ctx.forced || ctx.forced === collectionSection(mainCollection))) {
		// Text before the collection: everything up to the last heading run is its own rich_text section;
		// that heading (plus an eyebrow line) and what follows it introduce the collection.
		const before = richBefore(all, mainCollection);
		let lastHeading = -1;
		before.forEach((b, i) => {
			if (isHeading(b)) lastHeading = i;
		});
		let start = lastHeading;
		while (start > 0 && isHeading(before[start - 1] as PtBlock)) start--;
		if (start > 0 && words([before[start - 1] as PtBlock]) <= 4 && !isHeading(before[start - 1] as PtBlock)) start--; // eyebrow
		if (start > 0) push({ ...base("rich_text"), fields: { body: before.slice(0, start), width: "normal", align: "left", buttons: [] } });
		const { heading, intro } = splitHeading(start > 0 ? before.slice(start) : before);
		const after = richAfter(all, mainCollection);
		const extraCollections = collections.filter((k) => k !== mainCollection && !(mainCollection === "feature" && k === "feature"));
		if (extraCollections.length) ctx.diag({ level: "warn", code: "lossy", message: `Row mixes ${[mainCollection, ...extraCollections].join(" + ")}; secondary items emitted as separate sections`, path: row.path });

		const build = (kind: CollectionKind, heading: RichText | undefined, intro: RichText, main: boolean) => {
			const h = heading ? { heading } : {};
			const items = <K extends Fragment["kind"]>(k: K) => all.filter((f): f is Extract<Fragment, { kind: K }> => f.kind === k);
			switch (kind) {
				case "faq":
					{
						const look = items("faq")[0]?.look;
						push({ ...base("faq"), fields: { ...h, intro, ...(look ? { look } : {}), items: items("faq").map((f) => ({ question: f.question, answer: f.answer })), schema: true } });
					}
					break;
				case "tab":
					push({ ...base("tabs"), fields: { ...h, tabs: items("tab").map((f) => ({ label: f.label, body: f.body })) } });
					break;
				case "team":
					// One member per inner column → the source's columns per row (Salient: 3).
					{
						const first = items("team")[0];
						const look = { ...first?.look, ...(first?.gap ? { gap: first.gap } : {}) };
						push({ ...base("team"), fields: { ...h, intro, ...(cols.length > 1 ? { columns: Math.min(6, cols.length) } : {}), ...(Object.keys(look).length ? { look } : {}), members: items("team").map((f) => f.member) } });
					}
					break;
				case "testimonial":
					push({ ...base("testimonials"), fields: { ...h, items: items("testimonial").map((f) => f.item) } });
					break;
				case "gallery": {
					const g = items("gallery");
					const layout = g[0]?.layout ?? "grid";
					push({ ...base("gallery", layout), fields: { ...h, images: g.flatMap((f) => f.images), layout, lightbox: true } });
					break;
				}
				case "price": {
					const prices = items("price");
					const rows = prices.every((f) => f.rows);
					const radius = prices[0]?.rows?.radius;
					const inset = rowInset(row.attrs);
					const look = { ...(rows && radius ? { radius } : {}), ...inset };
					push({ ...base("pricing", rows ? "rows" : "list"), fields: { ...h, intro, ...(Object.keys(look).length ? { look } : {}), plans: prices.map((f) => f.plan), buttons: main ? buttons : [] } });
					break;
				}
				case "stat":
					push({ ...base("stats"), fields: { ...h, items: items("stat").map((f) => f.item) } });
					break;
				case "form":
					for (const [i, f] of items("form").entries()) push({ ...base("form"), fields: { ...(i === 0 ? h : {}), intro: i === 0 ? intro : [], formRef: { provider: f.provider, id: f.id }, aside: main && i === 0 ? [...richAfter(all, "form"), ...buttons.map((b) => linkBlock(b, { keys: ctx.keys } as HandlerCtx))] : [] } });
					break;
				case "embed":
					for (const [i, e] of items("embed").entries()) push({ ...base("embed", e.provider), fields: { ...(i === 0 ? h : {}), provider: e.provider, html: e.html } });
					break;
				case "video":
					for (const [i, v] of items("video").entries()) push({ ...base("video"), fields: { ...(i === 0 ? h : {}), ...(v.video ? { video: v.video } : {}), ...(v.embedUrl ? { embedUrl: v.embedUrl } : {}), ...(v.poster ? { poster: v.poster } : {}) } });
					break;
				case "map":
					for (const [i, m] of items("map").entries()) push({ ...base("map"), fields: { ...(i === 0 ? h : {}), ...(m.embedUrl ? { embedUrl: m.embedUrl } : {}), ...(m.address ? { address: m.address } : {}) } });
					break;
				case "marquee":
					for (const m of items("marquee")) {
						const label = m.blocks.filter(isHeading);
						push({ ...base("cta_banner", "marquee"), fields: { heading: label.length ? label : m.blocks, body: m.blocks.filter((b) => !isHeading(b)), buttons: m.link ? [m.link] : main ? buttons : [], ...(m.media ? { media: m.media } : {}) } });
					}
					break;
				case "legacy":
					for (const f of items("legacy")) push({ ...base("legacy_html"), fields: { html: f.html, reason: f.reason } });
					break;
				case "feature":
					push({ ...base("feature_grid", "list"), fields: { ...h, intro, items: items("feature").map((f) => f.item), columns: Math.min(4, Math.max(1, cols.length)) } });
					break;
			}
		};
		// Section types without an intro field (gallery, tabs, testimonials, …): the row's text goes into a text section
		// just before the collection rather than being lost.
		if (intro.length && !INTRO_COLLECTIONS.has(mainCollection)) {
			push({ ...base("rich_text"), fields: { body: [...(heading ?? []), ...intro], width: "normal", align: "left", buttons: [] } });
			build(mainCollection, undefined, [], true);
		} else build(mainCollection, heading, intro, true);
		if (after.length && mainCollection !== "marquee" && mainCollection !== "form") push({ ...base("rich_text"), fields: { body: after, width: "normal", align: "left", buttons: mainCollection === "price" ? [] : buttons } });
		for (const k of extraCollections) build(k, undefined, [], false);
		return sections;
	}

	const textCols = cols.filter((c) => c.fragments.some((f) => f.kind === "rich" || f.kind === "button"));
	const mediaOnly = (c: Col) => c.fragments.every((f) => f.kind === "media") && c.fragments.length > 0;

	// 2. Hero: first section of a page, with a background image/video or full height, and a heading.
	const bgMedia = look.theme.background?.video ?? look.theme.background?.image;
	if ((ctx.forced === "hero" || (!ctx.forced && ctx.first && ctx.kind === "page" && (bgMedia || look.fullHeight))) && rich.some(isHeading)) {
		const { heading, intro } = splitHeading(rich);
		const colMedia = media.find((m) => m.role === "content")?.media;
		push({ ...base("hero", look.theme.background?.video ? "video" : bgMedia ? "image" : "plain"), fields: { ...(heading ? { heading } : {}), body: intro, buttons, ...(colMedia ? { media: colMedia } : {}), align: "center" } });
		return sections;
	}

	// 3. Media + text: two columns, one media-only, the other text.
	if ((!ctx.forced || ctx.forced === "media_text") && cols.length === 2 && cols.some(mediaOnly) && cols.some((c) => !mediaOnly(c) && c.fragments.some((f) => f.kind === "rich"))) {
		const mediaCol = cols.find(mediaOnly) as Col;
		const textCol = cols.find((c) => c !== mediaCol) as Col;
		const extra = textCol.fragments.flatMap((f) => (f.kind === "media" ? [f.media] : []));
		if (extra.length) ctx.diag({ level: "info", code: "lossy", message: `${extra.length} image(s) from the text column moved into the section's media list`, path: row.path });
		const textRich = textCol.fragments.flatMap((f) => (f.kind === "rich" ? f.blocks : []));
		const mediaFrags = [...mediaCol.fragments, ...textCol.fragments].filter((f): f is Extract<Fragment, { kind: "media" }> => f.kind === "media");
		const heights = mediaFrags.slice(0, 2).map((f) => f.height);
		const lead = mediaCol.fragments[0] as Extract<Fragment, { kind: "media" }>;
		push({
			...base("media_text", mediaCol.fragments.every((f) => f.kind === "media" && f.role === "background") ? "cover" : "inline"),
			// Builder columns sit at the top unless the row centres them (content_placement).
			...(look.valign || (row.adapter && row.adapter !== "wpbakery") ? {} : { valign: "top" as const }),
			fields: {
				...(heights.some(Boolean) ? { mediaHeight: heights.map((h) => h ?? null) } : {}),
				...(textCol.insetStart ? { textInset: textCol.insetStart } : {}),
				...(textCol.leadTop ? { textTop: textCol.leadTop } : {}),
				...(textCol.motion ? { textParallax: textCol.motion } : {}),
				...(lead.parallax && lead.height ? { mediaParallax: lead.parallax } : {}),
				...(lead.radius ? { mediaRadius: lead.radius } : {}),
				...(textCol.headingGap ? { headingGap: textCol.headingGap } : {}),
				...mediaTextLook(row.raw, row.columns.indexOf(mediaCol)),
				media: [...mediaCol.fragments.map((f) => (f as Extract<Fragment, { kind: "media" }>).media), ...extra], body: textRich, buttons: textCol.fragments.flatMap((f) => (f.kind === "button" ? [f.button] : [])), mediaSide: cols[0] === mediaCol ? "left" : "right", ratio: mediaCol.width ?? "1/2" },
		});
		return sections;
	}

	// 4. Feature grid: ≥2 columns of the same shape, each with media or icon + text.
	if ((!ctx.forced || ctx.forced === "feature_grid") && cols.length >= 2 && cols.every((c) => c.fragments.some((f) => f.kind === "rich") && c.fragments.some((f) => f.kind === "media" || f.kind === "icon"))) {
		const items = cols.map((c) => {
			const blocks = c.fragments.flatMap((f) => (f.kind === "rich" ? f.blocks : []));
			const titleBlock = blocks.find(isHeading) ?? (blocks.length > 1 ? blocks[0] : undefined);
			const body = blocks.filter((b) => b !== titleBlock);
			const image = c.fragments.find((f) => f.kind === "media") as Extract<Fragment, { kind: "media" }> | undefined;
			const icon = c.fragments.find((f) => f.kind === "icon") as Extract<Fragment, { kind: "icon" }> | undefined;
			const link = c.fragments.find((f) => f.kind === "button") as Extract<Fragment, { kind: "button" }> | undefined;
			return { ...(titleBlock ? { title: titleBlock.children.map((s) => s.text).join("") } : {}), body, ...(image ? { image: image.media } : {}), ...(icon ? { icon: icon.icon } : {}), ...(link ? { link: link.button } : {}), ...(image && c.overlay ? { overlay: c.overlay } : {}), ...(image?.role === "background" && c.parallax ? { imageMotion: "parallax" as const } : {}) };
		});
		const variant = items.every((i) => i.image) ? "image-cards" : "icons";
		const sp = cols[0]?.spacer;
		const cardSpace = variant === "image-cards" && sp && cols.every((c) => c.spacer?.desktop === sp.desktop && c.spacer?.phone === sp.phone && c.spacer?.inset === sp.inset) ? sp : undefined;
		push({ ...base("feature_grid", variant), fields: { intro: [], items, columns: Math.min(6, cols.length), ...(cardSpace ? { cardSpace } : {}) } });
		return sections;
	}

	// 5. Single text column (or text spread over columns of one kind).
	if ((!ctx.forced || ["rich_text", "cta_banner", "media_text", "gallery"].includes(ctx.forced)) && cols.length === 1) {
		const contentMedia = media.filter((m) => m.role === "content");
		if (!rich.length && contentMedia.length) {
			push({ ...base("gallery", "stack"), fields: { images: contentMedia.map((m) => m.media), layout: "stack", lightbox: false } });
			return sections;
		}
		if (contentMedia.length && rich.length) {
			ctx.diag({ level: "info", code: "lossy", message: "Stacked image + text in one column converted to media_text", path: row.path });
			const firstIsMedia = all[0]?.kind === "media";
			push({ ...base("media_text", "stacked"), fields: { media: contentMedia.map((m) => m.media), body: rich, buttons, mediaSide: firstIsMedia ? "left" : "right", ratio: "1/2" } });
			return sections;
		}
		const bgImages = media.filter((m) => m.role === "background");
		const theme = bgImages.length && !look.theme.background?.image ? { ...look.theme, background: { ...look.theme.background, image: (bgImages[0] as { media: MediaRef }).media } } : look.theme;
		const short = words(rich) <= 50;
		if (ctx.forced === "cta_banner" || (!ctx.forced && short && buttons.length && (theme.background?.color || theme.background?.image))) {
			const { heading, intro } = splitHeading(rich);
			push({ ...base("cta_banner"), theme, fields: { ...(heading ? { heading } : {}), body: intro, buttons } });
			return sections;
		}
		if (!rich.length && buttons.length) {
			push({ ...base("rich_text", "buttons"), theme, fields: { body: [], width: "normal", align: "left", buttons } });
			return sections;
		}
		const width = columnFraction(cols[0]?.width) <= 0.5 ? "narrow" : "normal";
		const centred = row.attrs.text_align === "center" || (textCols.length > 0 && textCols.every((c) => c.centered));
		push({ ...base("rich_text"), theme, fields: { body: rich, width, align: centred ? "center" : "left", buttons } });
		return sections;
	}

	// 6. Fallback: generic columns.
	if (!textCols.length && !media.length && !icons.length) return sections;
	push({
		...base("columns"),
		fields: {
			columns: cols.slice(0, 6).map((c) => {
				const bg = c.fragments.find((f) => f.kind === "media" && f.role === "background") as Extract<Fragment, { kind: "media" }> | undefined;
				return {
					...(c.width ? { width: c.width } : {}),
					body: c.fragments.flatMap((f) => (f.kind === "rich" ? f.blocks : [])),
					media: c.fragments.flatMap((f) => (f.kind === "media" && f.role === "content" ? [f.media] : [])),
					buttons: c.fragments.flatMap((f) => (f.kind === "button" ? [f.button] : [])),
					...(() => {
						const circle = c.fragments.find((f): f is Extract<Fragment, { kind: "media" }> => f.kind === "media" && f.role === "content" && !!f.circle)?.circle;
						return circle ? { imageCircle: circle } : {};
					})(),
					...(c.centered ? { align: "center" as const } : c.right ? { align: "right" as const } : {}),
					...(() => {
						// Every paragraph in the column sets the same line height: the column keeps it.
						const paras = c.fragments.flatMap((f) => (f.kind === "rich" ? f.blocks : [])).filter((b) => !isHeading(b));
						const l = new Set(paras.map((b) => LINE_LEADING.get(b)));
						const leading = paras.length && l.size === 1 ? [...l][0] : undefined;
						return leading ? { leading } : {};
					})(),
					...(c.gapPhone ? { gapPhone: c.gapPhone } : {}),
					...(c.headingGap ? { headingGap: c.headingGap } : {}),
					...(c.fragments.some((f) => f.kind === "rich" && f.list === "dots") ? { list: "dots" as const } : {}),
					...(c.textInset?.end ? { insetEnd: c.textInset.end } : {}),
					...(c.textInset?.phone ? { insetPhone: c.textInset.phone } : {}),
					...(c.textInset?.below ? { gapStacked: c.textInset.below } : {}),
					...(c.textInset?.above ? { gapAboveStacked: c.textInset.above } : {}),
					...(c.background || bg ? { background: { ...c.background, ...(bg ? { image: bg.media } : {}) } } : {}),
				};
			}),
		},
	});
	if (cols.length > 6) ctx.diag({ level: "warn", code: "lossy", message: `${cols.length} columns; only 6 kept`, path: row.path });
	if (icons.length) ctx.diag({ level: "info", code: "lossy", message: `${icons.length} icon(s) in a generic columns layout not shown`, path: row.path });
	return sections;
}

const COLLECTION_PRIORITY: CollectionKind[] = ["form", "faq", "tab", "team", "testimonial", "price", "gallery", "stat", "embed", "map", "video", "marquee", "legacy", "feature"];
function pickCollection(present: readonly CollectionKind[]): CollectionKind | undefined {
	return COLLECTION_PRIORITY.find((k) => present.includes(k));
}
function collectionSection(k: CollectionKind): SectionType {
	return ({ faq: "faq", tab: "tabs", team: "team", testimonial: "testimonials", gallery: "gallery", price: "pricing", stat: "stats", form: "form", embed: "embed", video: "video", map: "map", marquee: "cta_banner", legacy: "legacy_html", feature: "feature_grid" } as const)[k];
}

function richBefore(all: Fragment[], k: CollectionKind): RichText {
	const idx = all.findIndex((f) => f.kind === k);
	return all.slice(0, idx < 0 ? all.length : idx).flatMap((f) => (f.kind === "rich" ? f.blocks : []));
}
function richAfter(all: Fragment[], k: CollectionKind): RichText {
	let last = -1;
	all.forEach((f, i) => {
		if (f.kind === k) last = i;
	});
	return last < 0 ? [] : all.slice(last + 1).flatMap((f) => (f.kind === "rich" ? f.blocks : []));
}

/** Leading heading blocks → heading; the rest → intro/body. */
function splitHeading(blocks: RichText): { heading?: RichText; intro: RichText } {
	let i = 0;
	while (i < blocks.length && isHeading(blocks[i] as PtBlock)) i++;
	// Salient often puts a short eyebrow paragraph before the heading ("Excellence").
	if (i === 0 && blocks.length > 1 && isHeading(blocks[1] as PtBlock) && words([blocks[0] as PtBlock]) <= 4) {
		return { heading: blocks.slice(0, 2), intro: blocks.slice(2) };
	}
	return i ? { heading: blocks.slice(0, i), intro: blocks.slice(i) } : { intro: blocks };
}

export type { Button };
export { CONTAINERS };

/** The row's first heading set with its own size in the builder (Salient split heading font_size): desktop size and leading. */
export function headingLook(raw: string): { headingSize?: string; headingLeading?: number; headingWidth?: string } {
	const tag = /\[split_line_heading(?=[^\]]*\bfont_style="h[1-6]")[^\]]*\]/.exec(raw)?.[0];
	if (!tag) return {};
	// max_width caps the heading's measure (a share of its column) at every width.
	const mw = /\bmax_width="\s*(\d+(?:\.\d+)?)\s*%\s*"/.exec(tag)?.[1];
	const width = mw && Number(mw) >= 20 && Number(mw) < 100 ? { headingWidth: `${mw}%` } : {};
	const size = /\bfont_size="\s*(\d+(?:\.\d+)?)\s*(px|vw|rem|em)?\s*"/.exec(tag);
	if (!size || Number(size[1]) <= 0) return width;
	const lh = Number(/\bfont_line_height="\s*([\d.]+)\s*"/.exec(tag)?.[1]);
	return { headingSize: `${size[1]}${size[2] ?? "px"}`, ...(lh > 0.5 && lh < 3 ? { headingLeading: lh } : {}), ...width };
}

/**
 * A section heading set centred in the builder, and the inner row's bottom padding under it
 * (Salient: % of the content width, which CSS margin % reproduces exactly).
 */
export function headLook(raw: string): { headAlign?: "center"; headGap?: string; eyebrowGap?: number } {
	const centred = /\[split_line_heading(?=[^\]]*\bfont_style="h[1-6]")(?=[^\]]*\bcontent_alignment="center")[^\]]*\]/.test(raw);
	// An inner row holding just the heading: its bottom padding is the gap to what follows; without one, the next
	// inner row's top padding is.
	const rows = innerRows(raw);
	let gap: string | undefined;
	let eyebrowGap: number | undefined;
	for (const [i, r] of rows.entries()) {
		const shortcodes = [...r.body.matchAll(/\[(\w+)/g)].map((x) => x[1]);
		if (!shortcodes.some((t) => t === "split_line_heading") || shortcodes.some((t) => !["vc_column_inner", "split_line_heading", "divider", "vc_empty_space"].includes(t as string))) continue;
		gap = padLen(r.attrs, "bottom_padding") ?? (rows[i + 1]?.col === r.col ? padLen(rows[i + 1]?.attrs ?? "", "top_padding", "%") : undefined);
		// An eyebrow (a lone small heading) in the inner row just above: that row's bottom padding sits under it.
		const prev = rows[i - 1];
		if (prev && prev.col === r.col && /^\s*(?:\[vc_column_inner\b[^\]]*\]\s*)?\[vc_column_text\b[^\]]*\](?:\s|<\/?p>)*<h[4-6][^>]*>[^<]{1,40}<\/h[4-6]>(?:\s|<\/?p>)*\[\/vc_column_text\]\s*(?:\[\/vc_column_inner\]\s*)?$/.test(prev.body)) {
			const px = padLen(prev.attrs, "bottom_padding", "px");
			if (px && Number.parseFloat(px) <= 100) eyebrowGap = Number.parseFloat(px);
		}
		break;
	}
	return { ...(centred ? { headAlign: "center" as const } : {}), ...(gap ? { headGap: gap } : {}), ...(eyebrowGap ? { eyebrowGap } : {}) };
}

/** The row's inner rows in order, with the index of the builder column each sits in. */
function innerRows(raw: string): { col: number; attrs: string; body: string }[] {
	const inner = /\[vc_row_inner\b([^\]]*)\]((?:(?!\[\/?vc_row_inner\b)[\s\S])*?)\[\/vc_row_inner\]/g;
	return raw.split(/\[vc_column(?=[\s\]])/).flatMap((c, col) => [...c.matchAll(inner)].map((m) => ({ col, attrs: m[1] ?? "", body: m[2] ?? "" })));
}

/** A padding attribute (Salient: bare numbers are px) → a CSS length, if positive and in an allowed unit. */
function padLen(attrs: string, name: string, only?: "%" | "px"): string | undefined {
	const m = new RegExp(`\\b${name}="\\s*(\\d+(?:\\.\\d+)?)\\s*(%|px)?\\s*"`).exec(attrs);
	if (!m || Number(m[1]) <= 0) return undefined;
	const unit = m[2] ?? "px";
	return !only || only === unit ? `${m[1]}${unit}` : undefined;
}

/**
 * Spacing and type inside a Salient image + text row (measured at 390/768/1440, docs/spikes/M7-findings.md):
 * the picture column's inner-row bottom padding once columns stack, the top padding of the inner rows holding the
 * centred quote and the second picture, and the size and leading of split-heading paragraphs and quotes.
 * Percentages are of the column's content width, which CSS margins reproduce.
 */
export function mediaTextLook(raw: string, mediaCol: number): { stackSpace?: string; quoteGap?: string; media2Gap?: string; bodySize?: string; bodySizeSmall?: string; bodyLeading?: number; quoteSize?: string; quoteSizeSmall?: string; quoteWidth?: string } {
	const rows = innerRows(raw);
	const mine = rows.filter((r) => r.col === mediaCol + 1);
	const text = rows.filter((r) => r.col !== mediaCol + 1);
	const last = mine.at(-1);
	const stackSpace = last ? (padLen(last.attrs, "bottom_padding_tablet") ?? padLen(last.attrs, "bottom_padding")) : undefined;
	const quoteRow = text.find((r) => CENTRED_QUOTE.test(r.body));
	const quoteGap = quoteRow ? padLen(quoteRow.attrs, "top_padding") : undefined;
	const media2Row = text.find((r) => /\[vc_column_inner\b[^\]]*\bbackground_image="\d+"/.test(r.body));
	const media2Gap = media2Row ? padLen(media2Row.attrs, "top_padding") : undefined;
	const size = (tag: string | undefined, name: string) => {
		const m = new RegExp(`\\b${name}="\\s*(\\d+(?:\\.\\d+)?)\\s*(px|vw)?\\s*"`).exec(tag ?? "");
		return m && Number(m[1]) > 0 && (m[2] === "vw" ? Number(m[1]) <= 5 : Number(m[1]) >= 10 && Number(m[1]) <= 40) ? `${m[1]}${m[2] ?? "px"}` : undefined;
	};
	const para = /\[split_line_heading(?=[^\]]*\bfont_style="p")[^\]]*\]/.exec(raw)?.[0];
	const lh = Number(/\bfont_line_height="\s*([\d.]+)\s*"/.exec(para ?? "")?.[1]);
	const quote = CENTRED_QUOTE.exec(raw)?.[0];
	const qw = /\bmax_width="\s*(\d+(?:\.\d+)?)\s*%\s*"/.exec(quote ?? "")?.[1];
	const look = {
		stackSpace,
		quoteGap,
		media2Gap,
		bodySize: size(para, "font_size"),
		bodySizeSmall: size(para, "font_size_tablet"),
		bodyLeading: lh >= 1 && lh <= 3 ? lh : undefined,
		quoteSize: size(quote, "font_size"),
		quoteSizeSmall: size(quote, "font_size_tablet"),
		quoteWidth: qw && Number(qw) >= 20 && Number(qw) <= 100 ? `${qw}%` : undefined,
	};
	return Object.fromEntries(Object.entries(look).filter(([, v]) => v !== undefined));
}

/**
 * Equal left/right padding on the row (Salient left/right_padding_desktop, _tablet): side space
 * around the content, desktop and small screens (tablet values apply to phones too).
 */
export function rowInset(a: Record<string, string | undefined>): { inset?: string; insetSmall?: string } {
	const len = (v?: string) => (v !== undefined && /^\d+(?:\.\d+)?(?:%|px)?$/.test(v.trim()) ? (/^0+(?:\.0+)?$/.test(v.trim()) ? "0px" : /\d$/.test(v.trim()) ? `${v.trim()}px` : v.trim()) : undefined);
	const d = a.left_padding_desktop === a.right_padding_desktop ? len(a.left_padding_desktop) : undefined;
	const t = a.left_padding_tablet === a.right_padding_tablet ? len(a.left_padding_tablet) : undefined;
	if (!d || d === "0px") return {};
	return { inset: d, ...(t ? { insetSmall: t } : {}) };
}

/**
 * Side padding of an edge-to-edge row (Salient full_width_content). The desktop value is the base for every
 * width; tablet and phone values override it (a probe of the live theme: 8% stays 8% at 768px and 390px).
 */
export function rowPad(a: Record<string, string | undefined>): { inset?: { desktop: string; tablet?: string; phone?: string } } {
	const len = (l?: string, r?: string) => {
		const v = l?.trim();
		if (v === undefined || v !== r?.trim()) return undefined;
		const m = /^(\d+(?:\.\d+)?)(%|px|vw)?$/.exec(v);
		return m ? (Number(m[1]) === 0 ? "0px" : `${m[1]}${m[2] ?? "px"}`) : undefined;
	};
	const desktop = len(a.left_padding_desktop, a.right_padding_desktop);
	if (!desktop || desktop === "0px") return {};
	const tablet = len(a.left_padding_tablet, a.right_padding_tablet);
	const phone = len(a.left_padding_phone, a.right_padding_phone);
	return { inset: { desktop, ...(tablet ? { tablet } : {}), ...(phone ? { phone } : {}) } };
}

/**
 * A column's only inner row, padded on one side on desktop (Salient right_padding_desktop, e.g. 40% to keep a
 * paragraph short) and/or evenly on phones: the column's text keeps that measure. Equal desktop sides are rowPad's.
 */
export function innerTextInset(a: Record<string, string | undefined>): { end?: string; phone?: string; below?: string; above?: string } | undefined {
	const pct = (v?: string) => {
		const m = /^\s*(\d+(?:\.\d+)?)\s*(%|px)?\s*$/.exec(v ?? "");
		return m && Number(m[1]) > 0 && Number(m[1]) < 80 ? `${m[1]}${m[2] ?? "px"}` : undefined;
	};
	const end = !pct(a.left_padding_desktop) ? pct(a.right_padding_desktop) : undefined;
	const phone = a.left_padding_phone === a.right_padding_phone ? pct(a.left_padding_phone) : undefined;
	// Its bottom padding on tablets (Salient carries tablet values down to phones) spaces it from the next column once stacked.
	const below = pct(a.bottom_padding_tablet);
	// …and its top padding on tablets sets it apart from the column above (e.g. links under a footer copyright line).
	const above = pct(a.top_padding_tablet);
	return end || phone || below || above ? { ...(end ? { end } : {}), ...(phone ? { phone } : {}), ...(below ? { below } : {}), ...(above ? { above } : {}) } : undefined;
}

/** A spacer that is the first thing in the row's first column: its height sits above the content. */
export function leadSpacer(raw: string): { spaceBefore?: number } {
	const m = /^\s*\[vc_row\b[^\]]*\]\s*(?:<\/?p>\s*)*\[vc_column\b[^\]]*\]\s*(?:<\/?p>\s*)*\[(?:divider|vc_empty_space)\b([^\]]*)\]/.exec(raw);
	const h = m ? /\b(?:custom_height|height)="\s*(\d+)\s*(?:px)?\s*"/.exec(m[1] ?? "")?.[1] : undefined;
	return h && Number(h) > 0 && Number(h) <= 400 ? { spaceBefore: Number(h) } : {};
}

/** A Salient italic line (pull quote) set centred in the builder. */
const CENTRED_QUOTE = /\[split_line_heading(?=[^\]]*\bfont_style="i")(?=[^\]]*\bcontent_alignment="center")[^\]]*\]/;

const SPACERS = new Set(["divider", "vc_empty_space"]);
/** Salient parallax_bg speed → layer offset per scrolled pixel. Measured on a live Salient site (docs/spikes/M7-findings.md); unmeasured speeds stay static. */
const PARALLAX_SPEED: Record<string, number> = { fast: 0.2 };
const cssLen = (v: string | undefined): string | undefined => {
	const m = /^\s*(\d+(?:\.\d+)?)\s*(px|vh|svh|vw|rem|em|%)?\s*$/.exec(v ?? "");
	return m && Number(m[1]) > 0 ? `${m[1]}${m[2] ?? "px"}` : undefined;
};

/** Space under a Salient fancy-ul list (measured: ul margin-bottom 30px at every width). */
const FANCY_LIST_GAP = 30;

/** Gap between inner rows in a Salient column (measured: every inner row but the last has a 10px bottom margin). */
const INNER_ROW_GAP = 10;

/** An inner row holding only a heading in a text block with a custom bottom margin → the space under that heading, px. */
export function loneHeadingGap(row: ShortcodeNode): number | undefined {
	const cols = row.children.filter((c): c is ShortcodeNode => c.type === "shortcode");
	const items = cols.length === 1 ? (cols[0] as ShortcodeNode).children.filter((c) => c.type === "shortcode" || (c.type === "text" && c.text.trim())) : [];
	const text = items.length === 1 && items[0]?.type === "shortcode" && items[0].tag === "vc_column_text" ? items[0] : undefined;
	if (!text) return undefined;
	const html = text.children.map((c) => (c.type === "text" ? c.text : "")).join("").replace(/<\/?p>|<br\s*\/?>|&nbsp;/g, "").trim();
	if (!/^<h[1-6][^>]*>[\s\S]*<\/h[1-6]>$/.test(html) || (html.match(/<h[1-6]/g) ?? []).length !== 1) return undefined;
	const mb = /^(\d+(?:\.\d+)?)px$/.exec(parseVcCss(text.attrs.css)["margin-bottom"] ?? "")?.[1];
	return mb ? Number(mb) + INNER_ROW_GAP : undefined;
}

/** A column that is only a background image and spacers: the spacer sets the picture's height. */
export function spacerHeight(col: ShortcodeNode): BoxHeight | undefined {
	const kids = col.children.filter((c): c is ShortcodeNode => c.type === "shortcode");
	if (!kids.length || !kids.every((k) => SPACERS.has(k.tag))) return undefined;
	const first = kids[0] as ShortcodeNode;
	const desktop = cssLen(first.attrs.custom_height ?? first.attrs.height);
	if (!desktop) return undefined;
	const tablet = cssLen(first.attrs.custom_height_tablet);
	const phone = cssLen(first.attrs.custom_height_phone);
	const small = tablet ?? phone;
	return { desktop, ...(small ? { small } : {}), ...(tablet && phone && phone !== tablet ? { phone } : {}) };
}

/** Spacers at both ends of a column (Salient image cards: divider 35vh · title · link · divider 35vh). */
export function columnSpacer(col: ShortcodeNode): { desktop: string; phone?: string } | undefined {
	const kids = col.children.filter((c): c is ShortcodeNode => c.type === "shortcode");
	const first = kids[0];
	const last = kids.at(-1);
	if (!first || !last || first === last || !SPACERS.has(first.tag) || !SPACERS.has(last.tag)) return undefined;
	const desktop = cssLen(first.attrs.custom_height ?? first.attrs.height);
	if (!desktop) return undefined;
	const phone = cssLen(first.attrs.custom_height_phone);
	const inset = /^padding-(\d+)-percent$/.exec(col.attrs.column_padding ?? "")?.[1];
	return { desktop, ...(phone ? { phone } : {}), ...(inset ? { inset: Number(inset) } : {}) };
}

/** Scale the alpha of every colour in a CSS value (Salient's overlay strength = layer opacity). */
function scaleAlpha(css: string, k: number): string {
	const r2 = (n: number) => Math.round(n * 1000) / 1000;
	return css
		.replace(/rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/g, (_, r, g, b, a) => `rgba(${r}, ${g}, ${b}, ${r2(Number(a) * k)})`)
		.replace(/#([0-9a-f]{6})\b/gi, (_, h) => `rgba(${Number.parseInt(h.slice(0, 2), 16)}, ${Number.parseInt(h.slice(2, 4), 16)}, ${Number.parseInt(h.slice(4, 6), 16)}, ${r2(k)})`);
}

/** Salient column overlay → one CSS background (radial / linear gradient or a flat tint). */
export function columnOverlay(a: Record<string, string>): string | undefined {
	const c1 = a.color_overlay?.trim();
	if (!c1 || !/^(?:#[0-9a-f]{6}|rgba?\([\d\s.,]+\))$/i.test(c1)) return undefined;
	const c2 = /^(?:#[0-9a-f]{6}|rgba?\([\d\s.,]+\))$/i.test(a.color_overlay_2 ?? "") ? (a.color_overlay_2 as string) : "rgba(255,255,255,0)";
	const strength = Math.min(1, Math.max(0, Number(a.overlay_strength ?? 0.3) || 0.3));
	const dirs: Record<string, string> = { left_to_right: "90deg", left_t_to_right_b: "135deg", left_b_to_right_t: "45deg", top_to_bottom: "180deg" };
	const css = a.enable_gradient === "true" ? (a.gradient_direction === "radial" ? `radial-gradient(50% 50%, ${c1} 0%, ${c2} 100%)` : `linear-gradient(${dirs[a.gradient_direction ?? ""] ?? "90deg"}, ${c1} 0%, ${c2} 100%)`) : `linear-gradient(${c1}, ${c1})`;
	return scaleAlpha(css.replace(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/g, "rgba($1, $2, $3, 1)").replace(/rgba\((\d+),(\d+),(\d+),([\d.]+)\)/g, "rgba($1, $2, $3, $4)"), strength);
}
