/**
 * Divi adapter (Divi 4 shortcodes; Divi 5 blocks best-effort). Divi 4 stores a page in post_content as
 * `[et_pb_section][et_pb_row][et_pb_column type="1_2"][et_pb_text]…[/et_pb_text][/et_pb_column][/et_pb_row][/et_pb_section]`
 * (meta `_et_pb_use_builder` = "on"), parsed with the WPBakery shortcode parser.
 *
 * Shortcodes → rows → the shared section recognisers, like the WPBakery, Bricks and Elementor adapters:
 * - a regular section's rows are rows; its columns (`type` = width) are the columns;
 * - a specialty section (`specialty="on"`) is one row whose columns hold inner rows (`et_pb_row_inner`) = sub-rows;
 * - a fullwidth section (`fullwidth="on"`) holds fullwidth modules: each is a full-width row; a fullwidth header or a
 *   single slide lends its background to the row, so the first one becomes the page hero.
 * Styling (background colour/gradient/image/video, parallax, custom padding, CSS id, full width, dark text layout)
 * maps onto the WPBakery-style row attributes the recognisers read; global colours (`gcid-…`) are resolved from the
 * theme options. Modules hidden on desktop are reported, never silently dropped; unknown modules are unmapped.
 * Divi 5 blocks (`<!-- wp:divi/… -->`) are converted to the same shortcode tree first (see divi5.ts).
 * Verified facts and open questions: docs/spikes/divi-findings.md.
 */
import type { Diagnostic, IrMenuItem, Section, SectionType } from "../../ir/schema.js";
import type { Keys } from "../../ir/portable-text.js";
import type { FormDefinitionOut } from "../../scaffold/forms.js";
import { type Col, type Fragment, HANDLERS as WPB_HANDLERS, type HandlerCtx, mediaFrom, richFromHtml } from "../wpbakery/elements.js";
import { carriesContent, mergeCollections, mergeRich, recognise, type Row, splitRow } from "../wpbakery/index.js";
import { type AstNode, parseShortcodes, serialise, type ShortcodeNode } from "../wpbakery/parser.js";
import { divi5ToShortcodes } from "./divi5.js";
import { DECORATIVE, DYNAMIC, type Env, HANDLERS, ITEMS, LISTINGS, resolveDynamic, stripTags } from "./elements.js";
import { colourOf, columnWidth, disabledOn, type DiviSite, emptyDiviSite, isDivi5, paddingOf } from "./site.js";

export { diviDesign, diviSite, type DiviSite, isDivi, isDivi5, themeBuilderParts } from "./site.js";
export { diviFormToDefinition } from "./forms.js";

export interface DiviOptions {
	kind: "page" | "post" | "partial" | "popup";
	/** Theme Builder part this content is (the header's menu module becomes the site menu instead of links). */
	role?: "header" | "footer";
	keys: Keys;
	popupFor: HandlerCtx["popupFor"];
	postCount: number;
	rowOverrides?: Record<string, SectionType | "drop">;
	/** Theme options and global colours. */
	site?: DiviSite;
	postId?: number;
	title?: string;
	siteTitle?: string;
	/** A WordPress menu by id (a menu module's `menu_id`) → its items. */
	menuItems?: (menu: string) => IrMenuItem[] | undefined;
}

export interface DiviResult {
	sections: Section[];
	diagnostics: Diagnostic[];
	/** Form definitions of the contact form modules on the page (written to ir/forms by transform). */
	forms: FormDefinitionOut[];
}

const COLOUR_RE = /^(?:#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i;
const shortcodes = (n: ShortcodeNode, tag?: string) => n.children.filter((c): c is ShortcodeNode => c.type === "shortcode" && (!tag || c.tag === tag));
/** Modules whose text is drawn light (Divi 4 `background_layout="dark"` = for a dark background). */
const TEXT_MODULES = new Set(["et_pb_text", "et_pb_blurb", "et_pb_cta", "et_pb_fullwidth_header", "et_pb_slide", "et_pb_testimonial", "et_pb_team_member", "et_pb_number_counter", "et_pb_heading", "et_pb_accordion", "et_pb_toggle", "et_pb_tabs", "et_pb_contact_form", "et_pb_pricing_tables"]);

export function adaptDivi(content: string, opts: DiviOptions): DiviResult {
	const diagnostics: Diagnostic[] = [];
	const diag = (d: Diagnostic) => diagnostics.push(d);
	const site = opts.site ?? emptyDiviSite();
	const forms = new Map<string, FormDefinitionOut>();
	let formCount = 0;
	let ast: AstNode[];
	if (isDivi5(content)) {
		const r = divi5ToShortcodes(content);
		ast = r.nodes;
		diag({ level: "warn", code: "lossy", message: `Divi 5 block format: read by the best-effort Divi 5 reader (block attributes mapped onto Divi 4 module fields; not yet run on a real Divi 5 site)${r.unknown.length ? `; blocks without a mapping: ${[...new Set(r.unknown)].join(", ")}` : ""}`, path: "divi5", tag: "divi5" });
	} else ast = parseShortcodes(content);

	const ctxFor = (path: string): HandlerCtx => ({ keys: opts.keys, path, diag, popupFor: opts.popupFor, postCount: opts.postCount, children: (n, p) => children(n.children, p) });
	const env: Env = { opts, site, diag, ctx: ctxFor, children: (n, p) => children(n.children, p), forms, nextForm: () => ++formCount };

	/** Hidden on desktop (`disabled_on` …|on) or disabled (`disabled="on"`): not migrated, reported. */
	function hidden(n: ShortcodeNode, path: string): boolean {
		if (n.attrs.disabled === "on") {
			diag({ level: "info", code: "dropped-decorative", message: `[${n.tag}] is disabled in Divi (not shown on the live site); not migrated`, path, tag: n.tag });
			return true;
		}
		if (!disabledOn(n.attrs, "desktop")) return false;
		const small = !disabledOn(n.attrs, "tablet") || !disabledOn(n.attrs, "phone");
		diag({ level: "warn", code: "lossy", message: `[${n.tag}] hidden on desktop${small ? " (shown on smaller screens: usually a phone-only copy)" : ""}; not migrated`, path, tag: n.tag });
		return true;
	}

	function dispatch(n: ShortcodeNode, path: string): Fragment[] {
		if (hidden(n, path)) return [];
		if (n.attrs.global_module) diag({ level: "info", code: "lossy", message: `[${n.tag}] global module #${n.attrs.global_module}: the copy saved in this page is used`, path, tag: n.tag });
		if (DECORATIVE.has(n.tag)) {
			diag({ level: "info", code: "dropped-decorative", message: `[${n.tag}] dropped (decorative)`, path, tag: n.tag });
			return [];
		}
		if (LISTINGS.has(n.tag)) {
			if (ctxFor(path).postCount === 0 && n.tag !== "et_pb_portfolio" && n.tag !== "et_pb_filterable_portfolio" && n.tag !== "et_pb_fullwidth_portfolio") {
				diag({ level: "info", code: "dynamic", message: `[${n.tag}] lists posts, but the site has none — dropped`, path, tag: n.tag });
				return [];
			}
			diag({ level: "error", code: "unmapped", message: `[${n.tag}] dynamic listing needs a posts-listing section (not in the v1 library)`, path, carriesContent: true, tag: n.tag });
			return [];
		}
		if (DYNAMIC.has(n.tag) || n.tag.startsWith("et_pb_wc_")) {
			diag({ level: "info", code: "dynamic", message: `[${n.tag}] is rendered by the site (search, post data, comments, shop), not migrated as content`, path, tag: n.tag });
			return [];
		}
		if (n.tag === "et_pb_row_inner" || n.tag === "et_pb_row") return subrow(n, path);
		const h = HANDLERS[n.tag];
		if (h) return h(n, path, env);
		// Other plugins' shortcodes inside Divi content (forms…) go through the shared handlers.
		const w = !n.tag.startsWith("et_pb_") ? WPB_HANDLERS[n.tag] : undefined;
		if (w) return w(n, ctxFor(path));
		const carries = carriesContent(n);
		diag({ level: carries ? "error" : "warn", code: "unmapped", message: `No handler for Divi module [${n.tag}]${ITEMS.has(n.tag) ? " outside its parent module" : ""}${carries ? " (carries content)" : ""}`, path, carriesContent: carries, tag: n.tag });
		return children(n.children, path);
	}

	function children(list: AstNode[], path: string): Fragment[] {
		const out: Fragment[] = [];
		let html = "";
		const flush = () => {
			const text = resolveDynamic(html, path.split("/").at(-1)?.replace(/\[\d+\]$/, "") ?? "content", "content", path, env);
			if (text.replace(/<\/?p>|<br\s*\/?>|&nbsp;|\s/g, "")) out.push(...richFromHtml(text, ctxFor(path)));
			html = "";
		};
		list.forEach((c, i) => {
			if (c.type === "text") {
				html += c.text;
				return;
			}
			flush();
			out.push(...dispatch(c, `${path}/${c.tag}[${i}]`));
		});
		flush();
		return mergeRich(out);
	}

	/** A column: its width (`type`), background colour/image and centred text (every module `text_orientation="center"`). */
	function column(n: ShortcodeNode, path: string): Col {
		const frags = children(n.children, path);
		const bg = mediaFrom(n.attrs.background_image);
		const color = colourOf(n.attrs.background_color, site);
		const width = columnWidth(n.attrs.type);
		const mods = shortcodes(n).filter((m) => m.tag !== "et_pb_row_inner" && !DECORATIVE.has(m.tag) && m.attrs.disabled !== "on" && !disabledOn(m.attrs, "desktop"));
		const align = new Set(mods.map((m) => m.attrs.text_orientation ?? "left"));
		const centred = mods.length > 0 && align.size === 1 && align.has("center");
		const right = mods.length > 0 && align.size === 1 && align.has("right");
		return {
			fragments: frags.length && bg ? [{ kind: "media", media: bg, role: "background" }, ...frags] : frags,
			...(width ? { width } : {}),
			...(color && COLOUR_RE.test(color) ? { background: { color } } : {}),
			...(centred ? { centered: true } : right ? { right: true } : {}),
		};
	}

	/** An inner row (specialty columns) or a row nested in a module area: several columns → a sub-row. */
	function subrow(n: ShortcodeNode, path: string): Fragment[] {
		const cols = shortcodes(n).filter((c) => /^et_pb_column(_inner)?$/.test(c.tag)).map((c, i) => column(c, `${path}/${c.tag}[${i}]`));
		const filled = cols.filter((c) => c.fragments.length);
		if (filled.length >= 2) return [{ kind: "subrow", columns: cols }];
		return filled.flatMap((c) => c.fragments);
	}

	// ── Styling ────────────────────────────────────────────────────────────────
	/** Background gradient: `background_color_gradient_stops` ("#a 0%|#b 100%"), else start/end colours. */
	function gradientOf(a: Record<string, string>): string | undefined {
		if (a.use_background_color_gradient !== "on") return undefined;
		const type = a.background_color_gradient_type === "radial" ? "radial" : "linear";
		const angle = type === "linear" ? `${a.background_color_gradient_direction || "180deg"}, ` : "";
		const stops = a.background_color_gradient_stops
			? a.background_color_gradient_stops.split("|").map((s) => s.trim().replace(/^(gcid-[\w-]+)/, (g) => colourOf(g, site) ?? g))
			: [colourOf(a.background_color_gradient_start || "#2b87da", site), colourOf(a.background_color_gradient_end || "#29c4a9", site)].map((c, i) => `${c} ${i ? (a.background_color_gradient_end_position ?? "100%") : (a.background_color_gradient_start_position ?? "0%")}`);
		const css = `${type}-gradient(${angle}${stops.join(", ")})`;
		return /^(?:linear|radial)-gradient\([^;{}<>]*\)$/.test(css) && !/gcid-|undefined/.test(css) ? css : undefined;
	}

	/** Section + row (+ a lone fullwidth module) attributes → the WPBakery-style row attributes the recognisers read. */
	function styleOf(layers: Record<string, string>[], mods: ShortcodeNode[], path: string): Record<string, string> {
		const a: Record<string, string> = {};
		const last = <T>(read: (x: Record<string, string>) => T | undefined) => [...layers].reverse().map(read).find((v) => v !== undefined && v !== "");
		const rawColor = last((x) => (x.use_background_color === "off" ? undefined : x.background_color?.trim()));
		const color = colourOf(rawColor, site);
		if (color && COLOUR_RE.test(color)) a.bg_color = color;
		else if (rawColor && /gcid-/.test(rawColor)) diag({ level: "info", code: "lossy", message: `background global colour ${rawColor} not resolved (et_global_data missing from the extract?)`, path });
		const image = last((x) => x.background_image ?? x.background_url);
		if (image) a.bg_image = image;
		const gradient = last((x) => gradientOf(x));
		if (gradient) {
			a.gradient_type = "advanced";
			a.advanced_gradient = gradient;
		}
		const video = last((x) => x.background_video_mp4);
		if (video) {
			a.video_bg = "true";
			a.video_mp4 = video;
		} else if (last((x) => x.background_video_webm)) diag({ level: "info", code: "lossy", message: "background video (WebM only) not reproduced", path });
		if (image && last((x) => (x.parallax === "on" ? "on" : undefined))) a.parallax_bg = "true";
		const pad = last((x) => (x.custom_padding ? paddingOf(x.custom_padding) : undefined));
		if (pad?.top) a.top_padding = pad.top;
		if (pad?.bottom) a.bottom_padding = pad.bottom;
		const id = last((x) => x.module_id?.trim());
		if (id) a.id = id;
		if (layers.some((x) => x.fullwidth === "on" || x.make_fullwidth === "on" || x.max_width === "100%" || x.width === "100%")) a.type = "full_width_content";
		if (layers.some((x) => x.header_fullscreen === "on")) a.full_height = "yes";
		// Text colour: Divi 4 modules say "dark" background layout for light text.
		const layouts = mods.filter((m) => TEXT_MODULES.has(m.tag)).map((m) => m.attrs.background_layout ?? "light");
		if (layouts.length && layouts.every((l) => l === "dark")) a.text_color = "light";
		if (layers.some((x) => x.use_custom_gutter === "on" && x.gutter_width === "1")) a.column_margin = "none";
		return a;
	}

	/** Modules anywhere under a node (for the text colour of a row). */
	const modulesOf = (n: ShortcodeNode): ShortcodeNode[] => shortcodes(n).flatMap((c) => (/^et_pb_(row|row_inner|column|column_inner)$/.test(c.tag) ? modulesOf(c) : [c]));

	/** A lone fullwidth header or one-slide slider: its background is the row's (the hero picture). */
	function heroLayer(m: ShortcodeNode): Record<string, string> | undefined {
		if (m.tag === "et_pb_fullwidth_header") return m.attrs;
		if (m.tag === "et_pb_slider" || m.tag === "et_pb_fullwidth_slider") {
			const slides = shortcodes(m, "et_pb_slide");
			if (slides.length === 1) return { ...m.attrs, ...Object.fromEntries(Object.entries((slides[0] as ShortcodeNode).attrs).filter(([k]) => k.startsWith("background_") || k === "parallax")) };
		}
		return undefined;
	}

	// ── Rows ─────────────────────────────────────────────────────────────────
	const rows: (Row & { index: number })[] = [];
	let loose: { n: AstNode; i: number }[] = [];
	const flushLoose = () => {
		if (!loose.length) return;
		const nodes = loose.map((x) => x.n);
		const frags = children(nodes, `loose[${(loose[0] as { i: number }).i}]`);
		if (frags.length) rows.push({ attrs: {}, columns: [{ fragments: frags }], path: `loose[${(loose[0] as { i: number }).i}]`, raw: nodes.map((n) => (n.type === "text" ? n.text : serialise(n))).join(""), adapter: "divi", index: (loose[0] as { i: number }).i });
		loose = [];
	};
	// Position of each top-level box on the rendered page (a section, or a run of content outside sections).
	let pos = 0;
	ast.forEach((node) => {
		if (node.type !== "shortcode" || node.tag !== "et_pb_section") {
			if (node.type === "text" && !node.text.replace(/<\/?p>|<br\s*\/?>|&nbsp;|\s/g, "")) return;
			if (!loose.length) loose.push({ n: node, i: pos++ });
			else loose.push({ n: node, i: (loose[0] as { i: number }).i });
			return;
		}
		flushLoose();
		const index = pos++;
		const path = `et_pb_section[${index}]`;
		if (hidden(node, path)) return;
		if (node.attrs.global_module) diag({ level: "info", code: "lossy", message: `[et_pb_section] global section #${node.attrs.global_module}: the copy saved in this page is used`, path, tag: "et_pb_section" });
		const sa = node.attrs;
		if (sa.fullwidth === "on") {
			shortcodes(node).forEach((m, j) => {
				const p = `${path}/${m.tag}[${j}]`;
				if (hidden(m, p)) return;
				const hero = heroLayer(m);
				const frags = dispatch(m, p);
				rows.push({ attrs: styleOf([sa, ...(hero ? [hero] : [])], [m], p), columns: [{ fragments: frags }], path: p, raw: serialise(m), adapter: "divi", index });
			});
			return;
		}
		if (sa.specialty === "on") {
			const cols = shortcodes(node, "et_pb_column").map((c, j) => column(c, `${path}/et_pb_column[${j}]`));
			rows.push({ attrs: styleOf([sa], modulesOf(node), path), columns: cols, path, raw: serialise(node), adapter: "divi", index });
			return;
		}
		const sectionRows = shortcodes(node).filter((r) => r.tag === "et_pb_row");
		const strays = shortcodes(node).filter((r) => r.tag !== "et_pb_row");
		sectionRows.forEach((r) => {
			const j = node.children.indexOf(r);
			const p = `${path}/et_pb_row[${j}]`;
			if (hidden(r, p)) return;
			const mods = modulesOf(r);
			const lone = mods.length === 1 ? heroLayer(mods[0] as ShortcodeNode) : undefined;
			const cols = shortcodes(r, "et_pb_column").map((c, k) => column(c, `${p}/et_pb_column[${k}]`));
			// The first row keeps the section's CSS id; the section's padding frames its first and last rows.
			const own = { ...sa, ...(sectionRows.indexOf(r) > 0 ? { module_id: "" } : {}) };
			rows.push({ attrs: styleOf([own, r.attrs, ...(lone ? [lone] : [])], mods, p), columns: cols, path: p, raw: serialise(r), adapter: "divi", index });
		});
		for (const s of strays) {
			const p = `${path}/${s.tag}[${node.children.indexOf(s)}]`;
			const frags = dispatch(s, p);
			if (frags.length) rows.push({ attrs: styleOf([sa], [s], p), columns: [{ fragments: frags }], path: p, raw: serialise(s), adapter: "divi", index });
		}
	});
	flushLoose();

	const sections: Section[] = [];
	for (const row of rows) {
		const forced = opts.rowOverrides?.[row.path];
		if (forced === "drop") {
			diag({ level: "info", code: "dropped-decorative", message: "Row dropped by overrides.ts", path: row.path });
			continue;
		}
		const out: Section[] = [];
		for (const v of splitRow(row)) out.push(...recognise(v, { first: sections.length + out.length === 0, kind: opts.kind, ...(forced ? { forced } : {}), keys: opts.keys, diag }));
		for (const s of mergeCollections(out)) {
			s.sourceRef.row = row.index;
			sections.push(s);
		}
	}
	return { sections, diagnostics, forms: [...forms.values()] };
}

/** Plain text of a Divi content string (for tests and reports). */
export const diviText = (content: string) => stripTags(content.replace(/\[\/?et_pb_[^\]]*\]/g, " "));
