/**
 * Elementor site data outside the page tree (docs/spikes/elementor-findings.md):
 * - the element tree format (`_elementor_data`: JSON text of `{ id, elType, widgetType?, isInner?, settings, elements }`);
 * - the active Kit (an `elementor_library` post of template type `kit`, id in option `elementor_active_kit`): its
 *   `_elementor_page_settings` hold the global colours (`system_colors`, `custom_colors`: `{ _id, title, color }`) and
 *   global fonts (`system_typography`, `custom_typography`: `{ _id, title, typography_* }`) that element settings name
 *   through `__globals__` (`globals/colors?id=primary`), plus custom breakpoints;
 * - Theme Builder templates (`elementor_library`, `_elementor_template_type` header/footer/popup/…, display conditions
 *   in `_elementor_conditions`: `include/general`, `include/singular/front_page`, `exclude/…`).
 */

type Obj = Record<string, unknown>;

export const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);
export const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
/** Settings: an object, or `[]` when empty (a PHP empty array encodes as a JSON array). */
export const settingsOf = (v: unknown): Obj => obj(v) ?? {};

export interface ElementorElement {
	id: string;
	elType: string;
	widgetType?: string;
	isInner?: boolean;
	settings?: Obj | unknown[];
	elements?: ElementorElement[];
	/** Global widget instance (`widgetType: "global"`): the `elementor_library` post of type `widget` it shows. */
	templateID?: number | string;
}

/** Parse `_elementor_data`: JSON text (as stored), or an already decoded array. Undefined when not an element list. */
export function elementorElements(meta: unknown): ElementorElement[] | undefined {
	let v = meta;
	if (typeof v === "string") {
		const t = v.trim();
		if (!t.startsWith("[")) return undefined;
		try {
			v = JSON.parse(t);
		} catch {
			// Stored with wp_slash: if the exporter returns the raw slashed value, unslash once and retry.
			try {
				v = JSON.parse(t.replace(/\\(.)/g, "$1"));
			} catch {
				return undefined;
			}
		}
	}
	if (!Array.isArray(v)) return undefined;
	const valid = (e: unknown): e is ElementorElement => !!obj(e) && typeof (e as ElementorElement).elType === "string";
	const walk = (list: unknown[]): ElementorElement[] =>
		list.filter(valid).map((e) => ({ ...e, id: String(e.id ?? ""), elements: Array.isArray(e.elements) ? walk(e.elements) : [] }));
	return walk(v);
}

/** True when the post is edited with Elementor (`_elementor_edit_mode` = "builder" and an element tree). */
export function isElementor(meta: Record<string, unknown> | undefined): boolean {
	if (!meta) return false;
	return str(meta._elementor_edit_mode) === "builder" && !!elementorElements(meta._elementor_data);
}

// ── Kit (global colours, fonts, breakpoints) ───────────────────────────────────

export interface ElementorKit {
	present: boolean;
	colors: Map<string, { title: string; color: string }>;
	typography: Map<string, { title: string; values: Obj }>;
	/** Breakpoint widths (px, max-width) of tablet and mobile (defaults 1024 / 767). */
	tablet: number;
	mobile: number;
	/** Content width of boxed sections/containers (px). */
	containerWidth?: number;
	settings: Obj;
}

export const emptyKit = (): ElementorKit => ({ present: false, colors: new Map(), typography: new Map(), tablet: 1024, mobile: 767, settings: {} });

const listOf = (v: unknown): Obj[] => (Array.isArray(v) ? v : obj(v) ? Object.values(v as Obj) : []).map(obj).filter((x): x is Obj => !!x);

/** The kit's page settings → global colours, fonts and breakpoints. */
export function elementorKit(pageSettings: unknown): ElementorKit {
	const s = obj(pageSettings);
	if (!s) return emptyKit();
	const colors = new Map<string, { title: string; color: string }>();
	for (const c of [...listOf(s.system_colors), ...listOf(s.custom_colors)]) {
		const id = str(c._id);
		const color = str(c.color);
		if (id && color) colors.set(id, { title: str(c.title) ?? id, color });
	}
	const typography = new Map<string, { title: string; values: Obj }>();
	for (const t of [...listOf(s.system_typography), ...listOf(s.custom_typography)]) {
		const id = str(t._id);
		if (id) typography.set(id, { title: str(t.title) ?? id, values: t });
	}
	const bp = (k: string, d: number) => {
		const n = Number(str(s[k]) ?? obj(s[k])?.size);
		return Number.isFinite(n) && n > 200 ? n : d;
	};
	const cw = Number(obj(s.container_width)?.size);
	return { present: true, colors, typography, tablet: bp("viewport_tablet", 1024), mobile: bp("viewport_mobile", 767), ...(cw > 0 ? { containerWidth: cw } : {}), settings: s };
}

/** A global reference (`globals/colors?id=primary`) → its id, if it is one of that type. */
export function globalId(ref: unknown, type: "colors" | "typography"): string | undefined {
	const m = /^globals\/(colors|typography)\?id=([\w-]+)$/.exec(str(ref) ?? "");
	return m && m[1] === type ? m[2] : undefined;
}

/** A colour setting: the kit colour it is linked to (`__globals__[key]`), else its own value. */
export function colourOf(s: Obj, key: string, kit: ElementorKit): string | undefined {
	const gid = globalId(obj(s.__globals__)?.[key], "colors");
	if (gid) return kit.colors.get(gid)?.color;
	const v = str(s[key])?.trim();
	return v || undefined;
}

// ── Responsive values ─────────────────────────────────────────────────────────

export type Device = "desktop" | "tablet" | "mobile";
/** A responsive setting at a device: `key`, `key_tablet`, `key_mobile`; a smaller device inherits the larger one. */
export function atDevice(s: Obj, key: string, device: Device): unknown {
	const chain = device === "mobile" ? [`${key}_mobile`, `${key}_tablet`, key] : device === "tablet" ? [`${key}_tablet`, key] : [key];
	for (const k of chain) {
		const v = s[k];
		if (v === undefined || v === null || v === "") continue;
		// A dimensions/slider control left empty at this device (`{ unit, top: "" }`) inherits too.
		const o = obj(v);
		if (o && ["size", "top", "bottom", "left", "right", "column", "row"].every((p) => o[p] === undefined || o[p] === "")) continue;
		return v;
	}
	return undefined;
}

/** A slider/dimension value in px (`{ unit: px|em|rem|vh|%, size }`); undefined for units that are not lengths here. */
export function sizePx(v: unknown, side?: "top" | "right" | "bottom" | "left" | "column" | "row", viewport = 1440): number | undefined {
	const o = obj(v);
	if (!o) return undefined;
	const raw = side ? o[side] : o.size;
	if (raw === undefined || raw === "") return undefined;
	const n = Number(raw);
	if (!Number.isFinite(n)) return undefined;
	const unit = str(o.unit) ?? "px";
	if (unit === "px") return n;
	if (unit === "em" || unit === "rem") return n * 16;
	if (unit === "vw") return (n * viewport) / 100;
	return undefined;
}

/** Hidden on a device (Advanced → Responsive: `hide_desktop: "hidden-desktop"`, `hide_tablet`, `hide_mobile`). */
export const hiddenOn = (s: Obj, device: Device) => !!str(s[`hide_${device}`]);

// ── Theme Builder templates ──────────────────────────────────────────────────

export interface TemplatePost {
	id: number;
	slug: string;
	title: string;
	status: string;
	meta: Record<string, unknown>;
}

export const templateType = (meta: Record<string, unknown> | undefined) => str(meta?._elementor_template_type);

/** `_elementor_conditions`: `include/general`, `include/singular/front_page`, `exclude/singular/page/12`. */
export function templateConditions(meta: Record<string, unknown> | undefined): { exclude: boolean; path: string[] }[] {
	const v = meta?._elementor_conditions;
	const list = Array.isArray(v) ? v : obj(v) ? Object.values(v as Obj) : typeof v === "string" && v.trim().startsWith("[") ? (() => { try { return JSON.parse(v) as unknown[]; } catch { return []; } })() : [];
	return list.flatMap((c) => {
		const parts = (str(c) ?? "").split("/").filter(Boolean);
		return parts.length ? [{ exclude: parts[0] === "exclude", path: parts.slice(1) }] : [];
	});
}

const describe = (c: { exclude: boolean; path: string[] }[]) => (c.length ? c.map((x) => `${x.exclude ? "not " : ""}${x.path.join("/")}`).join(", ") : "no display conditions (not shown)");

/** The site-wide header and footer templates (condition "Entire Site", else the front page); the rest is reported. */
export function siteTemplates(templates: TemplatePost[]): { header?: TemplatePost; footer?: TemplatePost; others: { post: TemplatePost; type: string; conditions: string }[] } {
	const pick = (type: string) => {
		const score = (t: TemplatePost) => {
			const c = templateConditions(t.meta).filter((x) => !x.exclude);
			return c.some((x) => x.path[0] === "general") ? 2 : c.some((x) => x.path.join("/") === "singular/front_page") ? 1 : 0;
		};
		return templates.filter((t) => t.status === "publish" && templateType(t.meta) === type && score(t) > 0).sort((a, b) => score(b) - score(a) || a.id - b.id)[0];
	};
	const header = pick("header");
	const footer = pick("footer");
	const others = templates.filter((t) => ["header", "footer", "single", "single-page", "single-post", "archive", "search-results", "error-404", "loop-item"].includes(templateType(t.meta) ?? "") && t !== header && t !== footer).map((post) => ({ post, type: templateType(post.meta) as string, conditions: describe(templateConditions(post.meta)) }));
	return { ...(header ? { header } : {}), ...(footer ? { footer } : {}), others };
}

/** The active kit post: option `elementor_active_kit`, else the only/oldest published `kit` template. */
export function activeKit(templates: TemplatePost[], activeId?: unknown): TemplatePost | undefined {
	const id = Number(activeId);
	const kits = templates.filter((t) => templateType(t.meta) === "kit");
	return (Number.isInteger(id) && id > 0 ? kits.find((k) => k.id === id) : undefined) ?? kits.filter((k) => k.status === "publish").sort((a, b) => a.id - b.id)[0];
}

/** Popup display settings (`_elementor_popup_display_settings.triggers`): opened on page load after a delay (s). */
export function popupAutoOpen(meta: Record<string, unknown> | undefined): { delayMs: number } | undefined {
	const t = obj(obj(meta?._elementor_popup_display_settings)?.triggers);
	if (!t || str(t.page_load) !== "yes") return undefined;
	const delay = Number(str(t.page_load_delay) ?? obj(t.page_load_delay)?.size ?? 0);
	return { delayMs: Number.isFinite(delay) && delay > 0 ? Math.round(delay * 1000) : 0 };
}

// ── Design report and motion ─────────────────────────────────────────────────

const TYPO_KEYS: Record<string, string> = { typography_font_family: "font-family", typography_font_weight: "font-weight", typography_font_size: "font-size", typography_line_height: "line-height", typography_letter_spacing: "letter-spacing", typography_text_transform: "text-transform" };

/** A typography group's values as CSS-like properties (`{ unit, size }` sliders → `16px`). */
export function typographyCss(t: Obj, prefix = "typography"): Obj {
	const out: Obj = {};
	for (const [k, css] of Object.entries(TYPO_KEYS)) {
		const v = t[k.replace(/^typography/, prefix)];
		const o = obj(v);
		if (o) {
			if (o.size !== undefined && o.size !== "") out[css] = `${o.size}${css === "line-height" && (!o.unit || o.unit === "em") ? "" : (str(o.unit) ?? "px")}`;
		} else if (str(v)) out[css] = str(v);
	}
	return out;
}

/**
 * The kit's design values for the design capture to compare with (written to the transform report, like Bricks):
 * global colours by id and title, global fonts, body and heading typography, container width, breakpoints.
 */
export function elementorDesign(kit: ElementorKit): { colors: Record<string, { title: string; color: string }>; typography: Record<string, Obj>; body?: Obj; headings: Record<string, Obj>; containerWidth?: number; breakpoints: { tablet: number; mobile: number } } {
	const colors = Object.fromEntries(kit.colors);
	const typography: Record<string, Obj> = {};
	for (const [id, t] of kit.typography) {
		const css = typographyCss(t.values);
		if (Object.keys(css).length) typography[id] = { title: t.title, ...css };
	}
	const s = kit.settings;
	const body = typographyCss(s, "body_typography");
	const bodyColor = colourOf(s, "body_color", kit);
	const headings: Record<string, Obj> = {};
	for (const h of ["h1", "h2", "h3", "h4", "h5", "h6"]) {
		const css = typographyCss(s, `${h}_typography`);
		const color = colourOf(s, `${h}_color`, kit);
		if (Object.keys(css).length || color) headings[h] = { ...css, ...(color ? { color } : {}) };
	}
	return { colors, typography, ...(Object.keys(body).length || bodyColor ? { body: { ...body, ...(bodyColor ? { color: bodyColor } : {}) } } : {}), headings, ...(kit.containerWidth ? { containerWidth: kit.containerWidth } : {}), breakpoints: { tablet: kit.tablet, mobile: kit.mobile } };
}

/** Elements with an entrance animation (`animation` on sections/columns/containers, `_animation` on widgets). */
export function elementorEntranceAnimations(trees: (ElementorElement[] | undefined)[]): number {
	let n = 0;
	const visit = (list: ElementorElement[]) => {
		for (const e of list) {
			const s = settingsOf(e.settings);
			const a = str(s.animation) ?? str(s._animation);
			if (a && a !== "none") n++;
			visit(e.elements ?? []);
		}
	};
	for (const t of trees) visit(t ?? []);
	return n;
}

/** Image and media ids/urls in an element tree (for raw/refs.json): every `{ id, url }` value in the settings. */
export function elementorMediaRefs(meta: unknown): { kind: "id" | "url"; value: string; via: string }[] {
	const out = new Map<string, { kind: "id" | "url"; value: string; via: string }>();
	const visit = (v: unknown, via: string) => {
		if (Array.isArray(v)) return v.forEach((x) => visit(x, via));
		const o = obj(v);
		if (!o) return;
		const id = Number(o.id);
		if (typeof o.url === "string" && Number.isInteger(id) && id > 0) out.set(`id:${id}`, { kind: "id", value: String(id), via });
		if (typeof o.url === "string" && /\/wp-content\/uploads\//.test(o.url)) out.set(`url:${o.url}`, { kind: "url", value: o.url, via });
		for (const x of Object.values(o)) visit(x, via);
	};
	const walk = (list: ElementorElement[]) => {
		for (const e of list) {
			visit(e.settings, `content:elementor ${e.widgetType ?? e.elType}`);
			walk(e.elements ?? []);
		}
	};
	walk(elementorElements(meta) ?? []);
	return [...out.values()];
}
