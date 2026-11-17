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
import { type Col, CONTAINERS, DECORATIVE, type Fragment, GROUPS, HANDLERS, type HandlerCtx, linkBlock, mediaFrom, richFromHtml } from "./elements.js";
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
	adapter?: "wpbakery" | "gutenberg" | "classic";
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
		if (bgImage) fragments.push({ kind: "media", media: bgImage, role: "background" });
		fragments.push(...processChildren(n.children, path));
		const color = colourValue(n.attrs.background_color);
		return { ...(n.attrs.width ? { width: n.attrs.width } : {}), fragments, ...(color ? { background: { color } } : {}), ...(n.attrs.phone_text_alignment === "center" ? { phoneCenter: true } : {}) };
	}

	/** vc_row_inner: one column → its fragments inline; several → a subrow fragment. */
	function subrowFragments(n: ShortcodeNode, path: string): Fragment[] {
		const cols = n.children.flatMap((c, i) => (c.type === "shortcode" && c.tag === "vc_column_inner" ? [columnOf(c, `${path}/vc_column_inner[${i}]`)] : []));
		const stray = n.children.filter((c) => c.type === "shortcode" && c.tag !== "vc_column_inner") as ShortcodeNode[];
		const strayFrags = stray.flatMap((s) => dispatch(s, `${path}/${s.tag}`));
		const nonEmpty = cols.filter((c) => c.fragments.length);
		if (nonEmpty.length <= 1) return [...(nonEmpty[0]?.fragments ?? []), ...strayFrags];
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
	// Only the first virtual row keeps the anchor id.
	return out.map((r, i) => (i === 0 ? r : { ...r, attrs: { ...r.attrs, id: "", el_id: "" } }));
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
				out.push({ ...ic, ...(w ? { width: w } : {}), fragments: flattenSubrows(ic.fragments) });
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
	for (const f of frags) {
		const last = out.at(-1);
		if (f.kind === "rich" && last?.kind === "rich") last.blocks.push(...f.blocks);
		else out.push(f.kind === "rich" ? { kind: "rich", blocks: [...f.blocks] } : f);
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
	const background = color || image || video || gradient ? { ...(color ? { color } : {}), ...(image ? { image } : {}), ...(video ? { video } : {}), ...(overlay !== undefined ? { overlay } : {}), ...(gradient ? { gradient } : {}) } : undefined;
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
		...(row.columns.some((c) => c.fragments.length) && row.columns.filter((c) => c.fragments.length).every((c) => c.phoneCenter) ? { phoneAlign: "center" as const } : {}),
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
					push({ ...base("faq"), fields: { ...h, intro, items: items("faq").map((f) => ({ question: f.question, answer: f.answer })), schema: true } });
					break;
				case "tab":
					push({ ...base("tabs"), fields: { ...h, tabs: items("tab").map((f) => ({ label: f.label, body: f.body })) } });
					break;
				case "team":
					// One member per inner column → the source's columns per row (Salient: 3).
					push({ ...base("team"), fields: { ...h, intro, ...(cols.length > 1 ? { columns: Math.min(6, cols.length) } : {}), members: items("team").map((f) => f.member) } });
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
				case "price":
					push({ ...base("pricing", "list"), fields: { ...h, intro, plans: items("price").map((f) => f.plan), buttons: main ? buttons : [] } });
					break;
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
		build(mainCollection, heading, intro, true);
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
		push({
			...base("media_text", mediaCol.fragments.every((f) => f.kind === "media" && f.role === "background") ? "cover" : "inline"),
			fields: { media: [...mediaCol.fragments.map((f) => (f as Extract<Fragment, { kind: "media" }>).media), ...extra], body: textRich, buttons: textCol.fragments.flatMap((f) => (f.kind === "button" ? [f.button] : [])), mediaSide: cols[0] === mediaCol ? "left" : "right", ratio: mediaCol.width ?? "1/2" },
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
			return { ...(titleBlock ? { title: titleBlock.children.map((s) => s.text).join("") } : {}), body, ...(image ? { image: image.media } : {}), ...(icon ? { icon: icon.icon } : {}), ...(link ? { link: link.button } : {}) };
		});
		const variant = items.every((i) => i.image) ? "image-cards" : "icons";
		push({ ...base("feature_grid", variant), fields: { intro: [], items, columns: Math.min(6, cols.length) } });
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
		push({ ...base("rich_text"), theme, fields: { body: rich, width, align: row.attrs.text_align === "center" ? "center" : "left", buttons } });
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
