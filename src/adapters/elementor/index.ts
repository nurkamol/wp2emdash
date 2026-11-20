/**
 * Elementor adapter (Elementor 3.x free + Pro widgets). Elementor stores a page as a JSON element tree in post meta
 * `_elementor_data` (`{ id, elType: section|column|container|widget, widgetType?, isInner?, settings, elements }`),
 * marked by `_elementor_edit_mode` = "builder"; post_content holds only a plain fallback copy.
 *
 * Tree → rows → the shared section recognisers, like the WPBakery and Bricks adapters:
 * - legacy layout: a top-level `section` is a row and its `column`s are the columns (`_column_size` / `_inline_size`
 *   = width %); an inner section (`isInner`) inside a column is a sub-row;
 * - Flexbox Containers: a top-level `container` is a row; a row-direction (`flex_direction: row`) or grid container's
 *   child containers are the columns (`width` %); nested row containers become sub-rows.
 * Styling (background colour/image/gradient/video/overlay, padding per device, height, full width, CSS id) maps onto
 * the WPBakery-style row attributes the recognisers read; colours linked to the Kit (`__globals__`) are resolved
 * through it. Library templates (`template` widget) and global widgets are inlined. Unknown widgets are reported as
 * unmapped, never dropped silently. Verified facts: docs/spikes/elementor-findings.md.
 */
import type { Diagnostic, IrMenuItem, Section, SectionType } from "../../ir/schema.js";
import type { Keys } from "../../ir/portable-text.js";
import type { FormDefinitionOut } from "../../scaffold/forms.js";
import { fluid } from "../../scaffold/generate.js";
import { type Col, type Fragment, type HandlerCtx, mediaFrom } from "../wpbakery/elements.js";
import { mergeRich, recognise, type Row, splitRow } from "../wpbakery/index.js";
import { DECORATIVE, DYNAMIC, dynamicListing, type Env, HANDLERS, LISTINGS, mediaOf, stripTags } from "./elements.js";
import { atDevice, colourOf, type Device, type ElementorElement, type ElementorKit, emptyKit, hiddenOn, obj, settingsOf, sizePx, str } from "./site.js";

export { activeKit, elementorDesign, elementorElements, elementorEntranceAnimations, elementorKit, type ElementorElement, type ElementorKit, isElementor, popupAutoOpen, siteTemplates, templateConditions, templateType } from "./site.js";
export { elementorFormToDefinition } from "./forms.js";

export interface ElementorOptions {
	kind: "page" | "post" | "partial" | "popup";
	/** Theme Builder part this tree is (the header's nav menu becomes the site menu instead of links). */
	role?: "header" | "footer";
	keys: Keys;
	popupFor: HandlerCtx["popupFor"];
	postCount: number;
	/** An `elementor_library` post's element tree by id (`template` widget, global widgets). */
	template?: (id: number) => ElementorElement[] | undefined;
	rowOverrides?: Record<string, SectionType | "drop">;
	/** The active Kit: global colours and fonts, breakpoints. */
	kit?: ElementorKit;
	postId?: number;
	title?: string;
	siteTitle?: string;
	/** A post id (dynamic internal URL) → the migrated path. */
	permalink?: (postId: number) => string | undefined;
	/** Elementor popup template id → the IR popup slug (buttons whose link opens a popup). */
	popupSlug?: (templateId: number) => string | undefined;
	/** A WordPress menu by slug, name or id (a nav-menu widget's `menu` setting) → its items. */
	menuItems?: (menu: string) => IrMenuItem[] | undefined;
}

export interface ElementorResult {
	sections: Section[];
	diagnostics: Diagnostic[];
	/** Form definitions of the Pro form widgets on the page (written to ir/forms by transform). */
	forms: FormDefinitionOut[];
}

const FRACTIONS: [number, string][] = [[1 / 6, "1/6"], [1 / 4, "1/4"], [1 / 3, "1/3"], [1 / 2, "1/2"], [2 / 3, "2/3"], [3 / 4, "3/4"]];
const fraction = (f: number) => FRACTIONS.find(([v]) => Math.abs(v - f) < 0.02)?.[1];
const COLOUR_RE = /^(?:#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i;
const STRUCTURE = new Set(["section", "column", "container"]);

export function adaptElementor(elements: ElementorElement[], opts: ElementorOptions): ElementorResult {
	const kit = opts.kit ?? emptyKit();
	const diagnostics: Diagnostic[] = [];
	const diag = (d: Diagnostic) => diagnostics.push(d);
	const forms = new Map<string, FormDefinitionOut>();
	const ctxFor = (path: string): HandlerCtx => ({ keys: opts.keys, path, diag, popupFor: opts.popupFor, postCount: opts.postCount, children: () => [] });
	const S = (e: ElementorElement) => settingsOf(e.settings);
	const nameOf = (e: ElementorElement) => (e.elType === "widget" ? (e.widgetType ?? "widget") : e.elType);
	const pathOf = (e: ElementorElement) => `${nameOf(e)}#${e.id}`;
	const kids = (e: ElementorElement) => (e.elements ?? []).filter((k) => !hidden(k, "", false));
	let currentSource: number | undefined;
	const open = new Set<number>();

	/** Hidden on desktop (Advanced → Responsive): not migrated (usually a phone-only copy), reported. */
	function hidden(e: ElementorElement, path: string, report = true): boolean {
		const s = S(e);
		if (!hiddenOn(s, "desktop")) return false;
		if (report) {
			const small = !hiddenOn(s, "tablet") || !hiddenOn(s, "mobile");
			diag({ level: "warn", code: "lossy", message: `[${nameOf(e)}] hidden on desktop${small ? " (shown on smaller screens: usually a phone-only copy)" : ""}; not migrated`, path, tag: nameOf(e) });
		}
		return true;
	}

	/** A library template's tree (template widget `template_id`, global widget `templateID`), guarded against loops. */
	function templateTree(id: number, e: ElementorElement, path: string): ElementorElement[] | undefined {
		const tree = Number.isInteger(id) && id > 0 && !open.has(id) ? opts.template?.(id) : undefined;
		if (!tree) diag({ level: "error", code: "unmapped", message: `[${nameOf(e)}] library template ${id || "?"} could not be loaded${open.has(id) ? " (it embeds itself)" : " (elementor_library missing from the extract?)"}`, path, carriesContent: true, tag: nameOf(e) });
		return tree;
	}
	function inTemplate<T>(id: number, run: () => T): T {
		open.add(id);
		const prev = currentSource;
		currentSource = id;
		try {
			return run();
		} finally {
			currentSource = prev;
			open.delete(id);
		}
	}

	const isRowBox = (e: ElementorElement) => {
		const s = S(e);
		if (e.elType !== "container") return false;
		if (str(s.container_type) === "grid") return (Number(obj(s.grid_columns_grid)?.size) || 0) >= 2;
		const dir = str(atDevice(s, "flex_direction", "desktop"));
		return dir === "row" || dir === "row-reverse";
	};

	/** Column width: a section column's `_inline_size` / `_column_size` (%), a child container's `width` (%). */
	function widthOf(e: ElementorElement): string | undefined {
		const s = S(e);
		if (e.elType === "column") {
			const n = Number(s._inline_size ?? s._column_size);
			return n > 0 && n < 100 ? fraction(n / 100) : undefined;
		}
		const w = obj(atDevice(s, "width", "desktop"));
		return w && (str(w.unit) ?? "%") === "%" && Number(w.size) > 0 && Number(w.size) < 100 ? fraction(Number(w.size) / 100) : undefined;
	}

	/** A column's text alignment from its widgets (`align`, `align_tablet`, `align_mobile`; old left/center/right, new start/center/end). */
	function alignOf(e: ElementorElement, device: Device): string | undefined {
		const vals = new Set<string>();
		const walk = (x: ElementorElement) => {
			for (const k of kids(x)) {
				if (k.elType === "widget") {
					if (["heading", "text-editor", "button", "icon-box", "image-box", "counter", "testimonial"].includes(k.widgetType ?? "")) vals.add(str(atDevice(S(k), k.widgetType === "testimonial" ? "testimonial_alignment" : "align", device)) ?? "");
				} else walk(k);
			}
		};
		walk(e);
		return vals.size === 1 ? [...vals][0] : undefined;
	}

	function column(e: ElementorElement, path: string): Col {
		const s = S(e);
		const frags = fragments(e, path);
		const bg = backgroundOf(s);
		const width = widthOf(e);
		const a = alignOf(e, "desktop");
		const t = alignOf(e, "tablet");
		const m = alignOf(e, "mobile");
		return {
			fragments: frags.length && bg.image ? [{ kind: "media", media: bg.image, role: "background" }, ...frags] : frags,
			...(width ? { width } : {}),
			...(bg.color && COLOUR_RE.test(bg.color) ? { background: { color: bg.color } } : {}),
			...(a === "center" ? { centered: true } : a === "right" || a === "end" ? { right: true } : {}),
			...(m === "center" && a !== "center" ? { phoneCenter: true } : {}),
			...(t === "center" && a !== "center" ? { tabletCenter: true } : {}),
		};
	}

	const env: Env = { kit, opts, diag, ctx: ctxFor, fragments: (e, path) => fragments(e, path), column, forms, sourceId: () => currentSource ?? opts.postId };

	/** An element's fragments; structural boxes with side-by-side children become sub-rows (`self`: the box is the column itself). */
	function fragments(e: ElementorElement, path: string, self = false): Fragment[] {
		if (hidden(e, path)) return [];
		if (e.elType === "widget") return widget(e, path);
		if (e.elType === "section" || (e.elType === "container" && !self && isRowBox(e) && kids(e).length >= 2 && kids(e).every((k) => k.elType === "container"))) {
			const cols = kids(e).map((c) => column(c, `${path}/${pathOf(c)}`));
			const filled = cols.filter((c) => c.fragments.length);
			if (filled.length >= 2) return [{ kind: "subrow", columns: cols }];
			return filled.flatMap((c) => c.fragments);
		}
		if (STRUCTURE.has(e.elType)) return mergeRich(kids(e).flatMap((k) => fragments(k, `${path}/${pathOf(k)}`)));
		diag({ level: "error", code: "unmapped", message: `Unknown Elementor element type "${e.elType}"`, path, carriesContent: true, tag: e.elType });
		return [];
	}

	function widget(e: ElementorElement, path: string): Fragment[] {
		const type = e.widgetType ?? "";
		const s = S(e);
		if (type === "global") {
			const id = Number(e.templateID ?? s.templateID);
			const tree = templateTree(id, e, path);
			if (!tree) return [];
			return inTemplate(id, () => mergeRich(tree.flatMap((x) => fragments(x, `${path}/global#${id}/${pathOf(x)}`))));
		}
		if (type === "template") {
			const id = Number(s.template_id);
			const tree = templateTree(id, e, path);
			if (!tree) return [];
			return inTemplate(id, () => mergeRich(tree.flatMap((x) => fragments(x, `${path}/template#${id}/${pathOf(x)}`))));
		}
		if (obj(s.e_display_conditions) || (Array.isArray(s.e_display_conditions) && s.e_display_conditions.length)) diag({ level: "info", code: "flagged", message: `[${type}] has display conditions in Elementor; migrated unconditionally`, path, tag: type });
		if (DECORATIVE.has(type)) {
			diag({ level: "info", code: "dropped-decorative", message: `[${type}] dropped (decorative)`, path, tag: type });
			return [];
		}
		if (LISTINGS.has(type)) return dynamicListing(e, s, path, env);
		if (DYNAMIC.has(type) || type.startsWith("wp-widget-") || type.startsWith("woocommerce-")) {
			if (type === "menu-anchor" && str(s.anchor)) diag({ level: "info", code: "dynamic", message: `[menu-anchor] anchor #${str(s.anchor)} not kept (link to the section's CSS id instead)`, path, tag: type });
			else diag({ level: "info", code: "dynamic", message: `[${type}] is rendered by the site (search, post data, sharing, widgets), not migrated as content`, path, tag: type });
			return [];
		}
		const handler = HANDLERS[type];
		if (handler) return handler(e, s, path, env);
		const carries = Object.entries(s).some(([k, v]) => !k.startsWith("_") && !/color|typography|size|align|padding|margin|border|background|width|height|gap|spacing|position|animation|icon$/.test(k) && (typeof v === "string" ? stripTags(v).length > 0 && !/^(yes|no|none|default|custom)$/.test(v) : Array.isArray(v) ? v.length > 0 : !!obj(v)?.url));
		diag({ level: carries ? "error" : "warn", code: "unmapped", message: `No handler for Elementor widget [${type}]${carries ? " (carries content)" : ""}`, path, carriesContent: carries, tag: type });
		return [];
	}

	// ── Styling ────────────────────────────────────────────────────────────────
	/** Background group (`background_background` classic/gradient/video/slideshow) with Kit colours resolved. */
	function backgroundOf(s: Record<string, unknown>, prefix = "background") {
		const kind = str(s[`${prefix}_background`]);
		const color = kind === "classic" || kind === "gradient" ? colourOf(s, `${prefix}_color`, kit) : undefined;
		// A video background shows its fallback picture where the video does not play (and in the migrated section).
		const image = kind === "classic" ? mediaOf(s[`${prefix}_image`]) : kind === "slideshow" ? mediaOf((s[`${prefix}_slideshow_gallery`] as unknown[] | undefined)?.[0]) : kind === "video" ? mediaOf(s[`${prefix}_video_fallback`]) : undefined;
		let gradient: string | undefined;
		if (kind === "gradient") {
			const b = colourOf(s, `${prefix}_color_b`, kit);
			const stopA = obj(s[`${prefix}_color_stop`])?.size;
			const stopB = obj(s[`${prefix}_color_b_stop`])?.size;
			if (color && b) {
				const type = str(s[`${prefix}_gradient_type`]) === "radial" ? "radial" : "linear";
				const angle = type === "linear" ? `${Number(obj(s[`${prefix}_gradient_angle`])?.size ?? 180)}deg, ` : "";
				const css = `${type}-gradient(${angle}${color} ${Number(stopA ?? 0)}%, ${b} ${Number(stopB ?? 100)}%)`;
				if (/^(?:linear|radial)-gradient\([^;{}<>]*\)$/.test(css)) gradient = css;
			}
		}
		const video = kind === "video" ? str(s[`${prefix}_video_link`])?.trim() : undefined;
		return { kind, color: kind === "gradient" ? undefined : color, image, gradient, video, fixed: str(s[`${prefix}_attachment`]) === "fixed" };
	}

	/** The row element and its single inner boxes (a boxed container around one container), outermost first. */
	function chain(e: ElementorElement): ElementorElement[] {
		const out = [e];
		let box = e;
		for (let i = 0; i < 2; i++) {
			const k = kids(box);
			if (k.length !== 1 || k[0]?.elType !== "container") break;
			box = k[0] as ElementorElement;
			out.push(box);
		}
		return out;
	}

	function styleOf(e: ElementorElement, path: string): { attrs: Record<string, string>; pad?: Section["pad"]; minHeight?: string; valign?: "middle" | "bottom" } {
		const boxes = chain(e);
		const s = S(e);
		const first = <T>(read: (x: Record<string, unknown>) => T | undefined) => boxes.map((b) => read(S(b))).find((v) => v !== undefined && v !== "");
		const a: Record<string, string> = {};
		const bgBox = boxes.find((b) => str(S(b).background_background)) ?? e;
		const bg = backgroundOf(S(bgBox));
		if (bg.color && COLOUR_RE.test(bg.color)) a.bg_color = bg.color;
		else if (obj(S(bgBox).__globals__)?.background_color && !colourOf(S(bgBox), "background_color", kit)) diag({ level: "info", code: "lossy", message: `[${nameOf(e)}] background colour ${String(obj(S(bgBox).__globals__)?.background_color)} not resolved (Kit missing from the extract?)`, path, tag: nameOf(e) });
		if (bg.image) a.bg_image = bg.image.wpId ? String(bg.image.wpId) : (bg.image.url as string);
		if (bg.kind === "slideshow") diag({ level: "info", code: "lossy", message: `[${nameOf(e)}] background slideshow shown as its first picture`, path, tag: nameOf(e) });
		if (bg.gradient) {
			a.gradient_type = "advanced";
			a.advanced_gradient = bg.gradient;
		}
		if (bg.video) {
			if (mediaFrom(bg.video, "video") && /\.(mp4|webm|mov)(\?|$)/i.test(bg.video)) {
				a.video_bg = "true";
				a.video_mp4 = bg.video;
			} else diag({ level: "info", code: "lossy", message: `[${nameOf(e)}] background video ${bg.video} (YouTube/Vimeo) not reproduced as a background; ${bg.image ? "its fallback picture is the background" : "the section has no background (no fallback picture set)"}`, path, tag: nameOf(e) });
		}
		if (bg.image && bg.fixed) a.parallax_bg = "true";
		// Background overlay (`background_overlay_*`): a dark colour → the section overlay at its opacity.
		const ovBox = boxes.find((b) => str(S(b).background_overlay_background));
		if (ovBox) {
			const ov = backgroundOf(S(ovBox), "background_overlay");
			const opacity = Number(obj(S(ovBox).background_overlay_opacity)?.size ?? 0.5);
			const hex = /^#([0-9a-f]{6})/i.exec(ov.color ?? "")?.[1];
			const dark = hex ? [0, 2, 4].every((i) => Number.parseInt(hex.slice(i, i + 2), 16) <= 40) : false;
			if (dark) a.color_overlay = `rgba(0, 0, 0, ${Math.max(0, Math.min(1, opacity))})`;
			else diag({ level: "info", code: "lossy", message: `[${nameOf(e)}] background overlay ${ov.color ?? ov.kind ?? "?"} not reproduced (the section overlay is black only)`, path, tag: nameOf(e) });
		}
		const padBox = boxes.find((b) => obj(S(b).padding)) ?? e;
		const ps = S(padBox);
		const side = (k: "top" | "bottom") => ({ d: sizePx(atDevice(ps, "padding", "desktop"), k), t: sizePx(atDevice(ps, "padding", "tablet"), k, 768), p: sizePx(atDevice(ps, "padding", "mobile"), k, 390) });
		const top = side("top");
		const bottom = side("bottom");
		if (top.d !== undefined) a.top_padding = `${top.d}px`;
		if (bottom.d !== undefined) a.bottom_padding = `${bottom.d}px`;
		const textColor = first((x) => colourOf(x, "color_text", kit) ?? colourOf(x, "heading_color", kit));
		if (textColor) a.text_color = isLight(textColor) ? "light" : "dark";
		if (str(s.text_align) === "center") a.text_align = "center";
		const id = str(s._element_id)?.trim();
		if (id) a.id = id;
		// Height: section `height` full / min-height + `custom_height`; container `min_height` (100vh = full screen).
		const minH = e.elType === "section" ? (str(s.height) === "full" ? { size: 100, unit: "vh" } : str(s.height) === "min-height" ? obj(s.custom_height) : undefined) : obj(atDevice(s, "min_height", "desktop"));
		const vh = minH && /^(vh|svh|dvh)$/.test(str(minH.unit) ?? "") ? Number(minH.size) : undefined;
		const pos = e.elType === "section" ? str(s.content_position) : first((x) => str(atDevice(x, "flex_justify_content", "desktop")));
		const place = pos === "middle" || pos === "center" ? ("middle" as const) : pos === "bottom" || pos === "flex-end" ? ("bottom" as const) : undefined;
		if (vh !== undefined && vh >= 100) {
			a.full_height = "yes";
			if (place) a.full_screen_row_position = place;
		}
		const minHeight = vh !== undefined && vh > 0 && vh < 100 ? `${vh}vh` : undefined;
		// Full width: section `layout: full_width` / `stretch_section`, container `content_width: full`.
		if (str(s.layout) === "full_width" || str(s.stretch_section) === "section-stretched" || boxes.some((b) => b.elType === "container" && str(S(b).content_width) === "full" && b !== e)) a.type = "full_width_content";
		if (str(s.gap) === "no" || first((x) => (obj(x.flex_gap) && Number(obj(x.flex_gap)?.column) === 0 && str(obj(x.flex_gap)?.column) !== "" ? "0" : undefined)) === "0") a.column_margin = "none";
		const line = (v: { d?: number; t?: number; p?: number }) => {
			if (v.d === undefined) return undefined;
			const p = v.p ?? v.t ?? v.d;
			const onLine = p + ((v.d - p) * (768 - 390)) / (1440 - 390);
			const t = v.t !== undefined && Math.abs(v.t - onLine) > 4 ? Math.round(v.t) : undefined;
			return { value: fluid(p, v.d), tablet: t };
		};
		const st = line(top);
		const sb = line(bottom);
		const pad = { ...(st ? { top: st.value } : {}), ...(sb ? { bottom: sb.value } : {}), ...(st?.tablet !== undefined && st.tablet <= 600 ? { topTablet: st.tablet } : {}), ...(sb?.tablet !== undefined && sb.tablet <= 600 ? { bottomTablet: sb.tablet } : {}) };
		return { attrs: a, ...(Object.keys(pad).length ? { pad } : {}), ...(minHeight ? { minHeight } : {}), ...(minHeight && place ? { valign: place } : {}) };
	}

	/** A row's columns: a section's columns, or the first row-direction container (outer boxed wrappers skipped). */
	function columnsOf(row: ElementorElement, path: string): Col[] {
		if (row.elType === "section") return kids(row).map((c) => column(c, `${path}/${pathOf(c)}`));
		let box: ElementorElement | undefined = row;
		for (let depth = 0; box && depth < 3; depth++) {
			const k = kids(box);
			if (k.length >= 2 && isRowBox(box) && k.every((x) => x.elType === "container")) return k.map((c) => column(c, `${path}/${depth ? `${pathOf(box as ElementorElement)}/` : ""}${pathOf(c)}`));
			box = k.length === 1 && k[0]?.elType === "container" ? k[0] : undefined;
		}
		return [{ fragments: fragments(row, path, true) }];
	}

	// ── Rows ─────────────────────────────────────────────────────────────────
	interface ElementorRow extends Row {
		pad?: Section["pad"];
		minHeight?: string;
		valign?: "middle" | "bottom";
		index: number;
	}
	/** Top-level elements, with top-level template widgets replaced by their template's rows. */
	function expand(list: ElementorElement[], depth = 0): { e: ElementorElement; path: string; source?: number }[] {
		return list.flatMap((r) => {
			const path = pathOf(r);
			if (depth < 4 && r.elType === "widget" && r.widgetType === "template") {
				const id = Number(S(r).template_id);
				const tree = templateTree(id, r, path);
				if (!tree) return [];
				open.add(id);
				const out = expand(tree, depth + 1).map((x) => ({ ...x, path: `${path}/template#${id}/${x.path}`, source: x.source ?? id }));
				open.delete(id);
				return out;
			}
			return [{ e: r, path }];
		});
	}
	const rows: ElementorRow[] = [];
	let loose: { e: ElementorElement; path: string; index: number }[] = [];
	const flushLoose = () => {
		if (!loose.length) return;
		rows.push({ attrs: {}, columns: [{ fragments: mergeRich(loose.flatMap((x) => fragments(x.e, x.path))) }], path: loose.map((x) => x.path).join("+"), raw: JSON.stringify(loose.map((x) => x.e)), adapter: "elementor", index: (loose[0] as { index: number }).index });
		loose = [];
	};
	elements.forEach((top, index) => {
		for (const { e: r, path, source } of expand([top])) {
			if (r.elType === "widget") {
				loose.push({ e: r, path, index });
				continue;
			}
			flushLoose();
			if (hidden(r, path)) continue;
			currentSource = source;
			const style = styleOf(r, path);
			const columns = columnsOf(r, path);
			rows.push({ attrs: style.attrs, columns, path, raw: JSON.stringify(r), adapter: "elementor", index, ...(style.pad ? { pad: style.pad } : {}), ...(style.minHeight ? { minHeight: style.minHeight } : {}), ...(style.valign ? { valign: style.valign } : {}) });
			currentSource = undefined;
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
		for (const s of out) {
			s.sourceRef.row = row.index;
			if (row.minHeight && out.length === 1) {
				s.minHeight = row.minHeight;
				if (row.valign && !s.valign) s.valign = row.valign;
			}
		}
		const head = out[0];
		const tail = out.at(-1);
		if (row.pad && head && head.type !== "hero" && !head.fullHeight && row.pad.top) head.pad = { ...head.pad, top: row.pad.top, ...(row.pad.topTablet !== undefined ? { topTablet: row.pad.topTablet } : {}) };
		if (row.pad && tail && tail.type !== "hero" && !tail.fullHeight && row.pad.bottom) tail.pad = { ...tail.pad, bottom: row.pad.bottom, ...(row.pad.bottomTablet !== undefined ? { bottomTablet: row.pad.bottomTablet } : {}) };
		sections.push(...out);
	}
	return { sections, diagnostics, forms: [...forms.values()] };
}

/** Light text colour (white-ish): the section is dark. */
function isLight(c: string): boolean {
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(c)?.[1];
	let rgb: number[] | undefined;
	if (hex) {
		const h = hex.length === 3 ? [...hex].map((x) => x + x).join("") : hex;
		rgb = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
	} else {
		const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(c);
		if (m) rgb = [Number(m[1]), Number(m[2]), Number(m[3])];
	}
	if (!rgb) return false;
	const [r, g, b] = rgb as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b >= 160;
}
