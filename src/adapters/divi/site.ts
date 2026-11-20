/**
 * Divi site data outside a page's shortcodes (docs/spikes/divi-findings.md):
 * - detection: Divi 4 stores the page as `[et_pb_section]…` shortcodes in post_content (meta `_et_pb_use_builder` =
 *   "on"); Divi 5 stores it as block comments in the `divi/` namespace (`<!-- wp:divi/section -->`);
 * - attribute encodings: JSON in attributes (`%22` = `"`, `%91` = `[`, `%93` = `]`, `%92` = `\`), code module content
 *   with `<!-- [et_pb_line_break_holder] -->` for line breaks and `&#91;` / `&#93;` for brackets, dynamic content as
 *   `@ET-DC@<base64 JSON>@`, global colours as `gcid-<id>`;
 * - theme options (`et_divi`: accent, text, heading and link colours, body/heading fonts, content width) and global
 *   colours (`et_global_data.global_colors`);
 * - Theme Builder: `et_template` posts (meta `_et_default`, `_et_enabled`, `_et_use_on`, `_et_exclude_from`,
 *   `_et_header_layout_id` / `_et_body_layout_id` / `_et_footer_layout_id` and their `_enabled` flags) pointing at
 *   `et_header_layout` / `et_body_layout` / `et_footer_layout` posts whose content is ordinary Divi shortcodes.
 */

type Obj = Record<string, unknown>;
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);
export const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);

export const DIVI4_RE = /\[et_pb_section\b/;
export const DIVI5_RE = /<!--\s+wp:divi\//;

/** True when the content is Divi builder content (Divi 4 shortcodes or Divi 5 blocks). */
export function isDivi(content: string | undefined, meta?: Record<string, unknown>): boolean {
	const c = content ?? "";
	if (DIVI4_RE.test(c) || DIVI5_RE.test(c)) return true;
	// The builder flag alone (content emptied or only modules without a section) still means Divi when et_pb_ tags are there.
	return str(meta?._et_pb_use_builder) === "on" && /\[et_pb_[a-z_]+/.test(c);
}

export const isDivi5 = (content: string) => DIVI5_RE.test(content) && !DIVI4_RE.test(content);

/** JSON kept in a shortcode attribute (contact field options, presets): Divi's percent codes back to characters. */
export function decodeAttrJson(v: string | undefined): string {
	return (v ?? "").replace(/%22/g, '"').replace(/%91/g, "[").replace(/%93/g, "]").replace(/%92/g, "\\");
}

/** Code module content: line-break placeholders and escaped brackets back to the HTML the module prints. */
export function decodeCode(v: string): string {
	return v
		.replace(/<!--\s*\[et_pb_line_break_holder\]\s*-->/g, "\n")
		.replace(/<!--\s*\[et_pb_br_holder\]\s*-->/g, "<br />")
		.replace(/&#91;/g, "[")
		.replace(/&#93;/g, "]")
		.replace(/^\s*<\/p>/, "")
		.replace(/<p>\s*$/, "");
}

/** Dynamic content (`@ET-DC@<base64 {"dynamic":true,"content":"post_title","settings":{…}}>@`) → its name and settings. */
export function dynamicContent(v: string | undefined): { content: string; settings: Obj } | undefined {
	const m = /@ET-DC@([A-Za-z0-9+/=]+)@/.exec(v ?? "");
	if (!m) return undefined;
	try {
		const j = obj(JSON.parse(Buffer.from(m[1] as string, "base64").toString("utf8")));
		if (!j || typeof j.content !== "string") return undefined;
		return { content: j.content, settings: obj(j.settings) ?? {} };
	} catch {
		return undefined;
	}
}

/** Column `type` (`1_2`, `1_3,1_3,1_3` structure parts) → the shared fraction names. */
export function columnWidth(type: string | undefined): string | undefined {
	const m = /^(\d)_(\d)$/.exec((type ?? "").trim());
	if (!m) return undefined;
	const f = Number(m[1]) / Number(m[2]);
	if (f >= 0.999) return undefined;
	return ([[1 / 6, "1/6"], [1 / 4, "1/4"], [1 / 3, "1/3"], [1 / 2, "1/2"], [2 / 3, "2/3"], [3 / 4, "3/4"]] as const).find(([x]) => Math.abs(x - f) < 0.02)?.[1] ?? `${Math.round(f * 100)}/100`;
}

/** `custom_padding="80px|0px|60px|0px|false|false"` (top|right|bottom|left|linked…) → top and bottom. */
export function paddingOf(v: string | undefined): { top?: string; bottom?: string } {
	const [top, , bottom] = (v ?? "").split("|");
	const len = (x: string | undefined) => (x && /^\d+(?:\.\d+)?(?:px|em|rem|vh|%)$/.test(x.trim()) ? x.trim() : undefined);
	const t = len(top);
	const b = len(bottom);
	return { ...(t ? { top: t } : {}), ...(b ? { bottom: b } : {}) };
}

/** `disabled_on="on|off|off"` (phone|tablet|desktop): hidden on that device. */
export function disabledOn(a: Record<string, string>, device: "phone" | "tablet" | "desktop"): boolean {
	const parts = (a.disabled_on ?? "").split("|");
	return parts[{ phone: 0, tablet: 1, desktop: 2 }[device]] === "on";
}

// ── Theme options and global colours ─────────────────────────────────────────

export interface DiviSite {
	present: boolean;
	/** Global colours by id (`gcid-…`). */
	colors: Map<string, string>;
	options: Obj;
}

export const emptyDiviSite = (): DiviSite => ({ present: false, colors: new Map(), options: {} });

/** `et_divi` (theme options) and `et_global_data` (global colours) as the exporter / WP-CLI returns them. */
export function diviSite(options: Record<string, unknown>): DiviSite {
	const theme = obj(options.et_divi);
	const global = obj(options.et_global_data);
	const colors = new Map<string, string>();
	const list = obj(global?.global_colors) ?? obj(theme?.et_global_colors);
	for (const [id, v] of Object.entries(list ?? {})) {
		const c = str(obj(v)?.color) ?? str(v);
		if (c && (str(obj(v)?.active) ?? "yes") !== "no") colors.set(id, c);
	}
	return { present: !!theme || colors.size > 0, colors, options: theme ?? {} };
}

/** A colour attribute: a global colour id (`gcid-…`) resolved, else the value itself. */
export function colourOf(v: string | undefined, site: DiviSite): string | undefined {
	const t = (v ?? "").trim();
	if (!t) return undefined;
	if (/^gcid-/.test(t)) return site.colors.get(t);
	// Divi 4.x also writes global colours as a CSS variable reference.
	const m = /var\(--(gcid-[\w-]+)\)/.exec(t);
	if (m) return site.colors.get(m[1] as string);
	return t;
}

/** Design values for the transform report (compared with the design capture, like Elementor's Kit). */
export function diviDesign(site: DiviSite): { colors: Record<string, string>; theme: Record<string, string> } {
	const keys = ["accent_color", "font_color", "header_color", "link_color", "body_font", "heading_font", "body_font_size", "body_header_size", "body_font_height", "content_width", "gutter_width", "primary_nav_bg", "footer_bg", "all_buttons_bg_color", "all_buttons_text_color"];
	const theme: Record<string, string> = {};
	for (const k of keys) {
		const v = str(site.options[k]);
		if (v?.trim()) theme[k] = v.trim();
	}
	return { colors: Object.fromEntries(site.colors), theme };
}

// ── Theme Builder ────────────────────────────────────────────────────────────

export interface TemplatePost {
	id: number;
	slug: string;
	title: string;
	status: string;
	meta: Record<string, unknown>;
}

const flag = (v: unknown) => {
	const s = str(Array.isArray(v) ? v[0] : v);
	return s === "1" || s === "on" || s === "true" || v === true;
};
const list = (v: unknown): string[] => {
	if (Array.isArray(v)) return v.map((x) => str(x) ?? "").filter(Boolean);
	const s = str(v);
	if (!s) return [];
	if (s.trim().startsWith("[")) {
		try {
			return (JSON.parse(s) as unknown[]).map((x) => str(x) ?? "").filter(Boolean);
		} catch {}
	}
	return [s];
};
const num = (v: unknown) => Number(str(Array.isArray(v) ? v[0] : v));

/**
 * The site-wide Theme Builder parts: the default website template's header and footer (else a template used on the
 * home page). Templates for other conditions, and body layouts, are reported (never silently dropped).
 */
export function themeBuilderParts(templates: TemplatePost[]): { template?: TemplatePost; header?: number; footer?: number; body?: number; others: { post: TemplatePost; conditions: string }[] } {
	const live = templates.filter((t) => t.status === "publish" && (t.meta._et_enabled === undefined || flag(t.meta._et_enabled)));
	const isDefault = (t: TemplatePost) => flag(t.meta._et_default) || flag(t.meta._et_template_default);
	const usedOn = (t: TemplatePost) => list(t.meta._et_use_on);
	const template = live.find(isDefault) ?? live.find((t) => usedOn(t).some((c) => c === "homepage" || c === "singular:post_type:page:all"));
	const layout = (t: TemplatePost | undefined, part: "header" | "footer" | "body") => {
		if (!t) return undefined;
		const id = num(t.meta[`_et_${part}_layout_id`]);
		const enabled = t.meta[`_et_${part}_layout_enabled`] === undefined || flag(t.meta[`_et_${part}_layout_enabled`]);
		return Number.isInteger(id) && id > 0 && enabled ? id : undefined;
	};
	const header = layout(template, "header");
	const footer = layout(template, "footer");
	const body = layout(template, "body");
	const others = templates
		.filter((t) => t !== template)
		.map((post) => ({ post, conditions: isDefault(post) ? "the whole site (default template)" : usedOn(post).join(", ") || "no conditions (not used)" }));
	return { ...(template ? { template } : {}), ...(header ? { header } : {}), ...(footer ? { footer } : {}), ...(body ? { body } : {}), others };
}
