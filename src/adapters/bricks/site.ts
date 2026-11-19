/**
 * Site-wide Bricks data the element settings refer to: colour palette, global CSS variables, global classes,
 * theme styles, components and breakpoints (WordPress options), and Bricks templates (header, footer, section,
 * popup: `bricks_template` posts). Facts and source paths: docs/spikes/bricks-findings.md.
 */
import type { BricksElement } from "./index.js";

type Obj = Record<string, unknown>;
export const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);
export const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
const list = (v: unknown): Obj[] => {
	let x = v;
	if (typeof x === "string" && /^\s*[[{]/.test(x)) {
		try {
			x = JSON.parse(x);
		} catch {
			return [];
		}
	}
	return (Array.isArray(x) ? x : obj(x) ? Object.values(x as Obj) : []).filter((e): e is Obj => !!obj(e));
};

/** Option names (wp_options) the adapter reads. Bricks: functions.php `BRICKS_DB_*` constants. */
export const BRICKS_OPTIONS = ["bricks_color_palette", "bricks_global_variables", "bricks_global_classes", "bricks_theme_styles", "bricks_components", "bricks_breakpoints", "bricks_global_settings"] as const;

export interface Breakpoint {
	key: string;
	width: number;
	base?: boolean;
}
/** Bricks' default breakpoints (includes/breakpoints.php): desktop is the base, max-width rules below it. */
export const DEFAULT_BREAKPOINTS: Breakpoint[] = [
	{ key: "desktop", width: 1279, base: true },
	{ key: "tablet_portrait", width: 991 },
	{ key: "mobile_landscape", width: 767 },
	{ key: "mobile_portrait", width: 478 },
];

export interface GlobalClass {
	id: string;
	name: string;
	settings: Obj;
}
export interface Component {
	id: string;
	elements: BricksElement[];
	properties: { id: string; default?: unknown; connections: Record<string, string[]> }[];
}

export interface BricksSite {
	/** Palette colour id → CSS value (`--bricks-color-<id>`). */
	palette: Map<string, string>;
	/** Global variable name (without `--`) → value. */
	variables: Map<string, string>;
	classes: Map<string, GlobalClass>;
	components: Map<string, Component>;
	breakpoints: Breakpoint[];
	/** Settings of the theme style that applies to the whole site (condition "any"), if any. */
	themeStyle?: Obj;
	/** Which options were present (the rest are reported). */
	present: string[];
}

/** Build the site data from option values (arrays, index-keyed objects or JSON text). */
export function bricksSite(options: Record<string, unknown> = {}): BricksSite {
	const present = BRICKS_OPTIONS.filter((k) => options[k] !== undefined && options[k] !== null && options[k] !== "");
	const variables = new Map<string, string>();
	for (const v of list(options.bricks_global_variables)) {
		const name = str(v.name)?.replace(/^--/, "");
		const value = str(v.value);
		if (name && value) variables.set(name, value);
	}
	const palette = new Map<string, string>();
	for (const p of list(options.bricks_color_palette)) {
		for (const c of list(p.colors)) {
			const id = str(c.id);
			// Same order as Bricks: light value, then rgb/hex, then raw (includes/assets.php generate_inline_css_color_vars).
			const value = str(c.rgb) || str(c.hex) || str(c.raw) || str(c.light);
			if (id && value) palette.set(id, value);
		}
	}
	const classes = new Map<string, GlobalClass>();
	for (const c of list(options.bricks_global_classes)) {
		const id = str(c.id);
		if (id) classes.set(id, { id, name: str(c.name) ?? id, settings: obj(c.settings) ?? {} });
	}
	const components = new Map<string, Component>();
	for (const c of list(options.bricks_components)) {
		const id = str(c.id);
		if (!id) continue;
		const elements = list(c.elements) as unknown as BricksElement[];
		const properties = list(c.properties).map((p) => ({ id: str(p.id) ?? "", default: p.default, connections: Object.fromEntries(Object.entries(obj(p.connections) ?? {}).map(([k, v]) => [k, Array.isArray(v) ? v.map(String) : []])) }));
		components.set(id, { id, elements, properties });
	}
	const bps = list(options.bricks_breakpoints).flatMap((b) => (str(b.key) && Number(b.width) > 0 ? [{ key: str(b.key) as string, width: Number(b.width), ...(b.base ? { base: true } : {}) }] : []));
	const breakpoints = bps.length ? bps.sort((a, b) => b.width - a.width) : DEFAULT_BREAKPOINTS;
	// A theme style applies site-wide when one of its conditions is "any" (includes/theme-styles.php set_active_style).
	let themeStyle: Obj | undefined;
	const styles = obj(options.bricks_theme_styles) ?? Object.fromEntries(list(options.bricks_theme_styles).map((s, i) => [String(i), s]));
	for (const s of Object.values(styles)) {
		const settings = obj(obj(s)?.settings);
		const conditions = list(obj(settings?.conditions)?.conditions);
		if (settings && conditions.some((c) => c.main === "any" && !c.exclude)) themeStyle = settings;
	}
	return { palette, variables, classes, components, breakpoints, ...(themeStyle ? { themeStyle } : {}), present };
}

export const emptySite = (): BricksSite => bricksSite({});

/**
 * A colour setting (`{ hex, rgb, raw, id }`) → a CSS colour the IR can use, resolving palette ids and
 * `var(--bricks-color-<id>)` / `var(--<global variable>)` references. Undefined when it stays a variable.
 */
export function resolveColour(v: unknown, site: BricksSite, depth = 0): string | undefined {
	if (depth > 4) return undefined;
	const c = obj(v);
	let value: string | undefined;
	if (c) {
		const id = str(c.id);
		if (id && site.palette.has(id)) value = site.palette.get(id);
		else value = str(c.rgb) || str(c.hex) || str(c.raw);
	} else value = str(v);
	if (!value) return undefined;
	const t = value.trim();
	const ref = /^var\(\s*--([\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(t);
	if (ref) {
		const name = ref[1] as string;
		const pal = /^bricks-color-(.+)$/.exec(name)?.[1];
		const next = pal ? site.palette.get(pal) : site.variables.get(name);
		if (next) return resolveColour(next, site, depth + 1);
		return ref[2] ? resolveColour(ref[2].trim(), site, depth + 1) : undefined;
	}
	return /^#[0-9a-f]{3,8}$/i.test(t) || /^(?:rgb|hsl)a?\([^)]*\)$/i.test(t) || /^[a-z]+$/i.test(t) ? t : undefined;
}

/** A length that may be a global variable (`var(--space-l)`) → its value. */
export function resolveLength(v: unknown, site: BricksSite): string | undefined {
	let s = str(v)?.trim();
	for (let i = 0; s && i < 4; i++) {
		const ref = /^var\(\s*--([\w-]+)\s*(?:,\s*([^)]+))?\)$/.exec(s);
		if (!ref) break;
		s = site.variables.get(ref[1] as string) ?? ref[2]?.trim();
	}
	if (!s) return undefined;
	return /^-?\d+(?:\.\d+)?$/.test(s) ? `${s}px` : s;
}

/** Pixels of a CSS length (px, rem/em at 16px; clamp/min/max: the largest px/rem term). */
export function pxOf(v: string | undefined): number | undefined {
	if (!v) return undefined;
	const m = /^(-?\d+(?:\.\d+)?)(px|rem|em)?$/.exec(v.trim());
	if (m) return Number(m[1]) * (m[2] === "rem" || m[2] === "em" ? 16 : 1);
	if (/^(?:clamp|min|max)\(/.test(v)) {
		const terms = [...v.matchAll(/(-?\d+(?:\.\d+)?)(px|rem)\b/g)].map((x) => Number(x[1]) * (x[2] === "rem" ? 16 : 1));
		return terms.length ? Math.max(...terms) : undefined;
	}
	return undefined;
}

/**
 * Element settings with its global classes merged in: class settings first (in the order the element lists
 * them), then the element's own settings, which win (Bricks: element ID selector over class selector).
 */
export function effectiveSettings(e: BricksElement, site: BricksSite): Obj {
	const s = e.settings ?? {};
	const ids = Array.isArray(s._cssGlobalClasses) ? (s._cssGlobalClasses as unknown[]).map(String) : [];
	if (!ids.length) return s;
	const merged: Obj = {};
	for (const id of ids) {
		const c = site.classes.get(id);
		if (!c) continue;
		for (const [k, v] of Object.entries(c.settings)) merged[k] = obj(v) && obj(merged[k]) ? { ...(merged[k] as Obj), ...(v as Obj) } : v;
	}
	for (const [k, v] of Object.entries(s)) merged[k] = obj(v) && obj(merged[k]) ? { ...(merged[k] as Obj), ...(v as Obj) } : v;
	return merged;
}

/** Global class names on an element (for popup triggers and the coverage report). */
export function classNames(e: BricksElement, site: BricksSite): string[] {
	const s = e.settings ?? {};
	const own = [str(s._cssClasses), str(obj(s._hidden)?._cssClasses)].filter(Boolean).join(" ").split(/\s+/).filter(Boolean);
	const global = (Array.isArray(s._cssGlobalClasses) ? (s._cssGlobalClasses as unknown[]) : []).flatMap((id) => site.classes.get(String(id))?.name ?? []);
	return [...own, ...global];
}

/**
 * A setting's value at a breakpoint. Keys carry the breakpoint as a suffix (`_padding:mobile_portrait`); the base
 * breakpoint has none. Desktop-first (default): a breakpoint inherits from the nearest wider one that sets it.
 * Mobile-first (a small base): it inherits from the nearest narrower one.
 */
export function atBreakpoint(s: Obj, key: string, bp: string, site: BricksSite): unknown {
	const bps = site.breakpoints;
	const base = bps.find((b) => b.base) ?? bps[0];
	if (!base || bp === base.key) return s[key];
	const idx = bps.findIndex((b) => b.key === bp);
	const baseIdx = bps.indexOf(base);
	if (idx < 0) return s[key];
	// Walk from bp back towards the base.
	const step = idx > baseIdx ? -1 : 1;
	for (let i = idx; i !== baseIdx; i += step) {
		const b = bps[i] as Breakpoint;
		if (s[`${key}:${b.key}`] !== undefined) return s[`${key}:${b.key}`];
	}
	return s[key];
}

/** The widest and narrowest breakpoints' keys, and the one closest to a 768px tablet. */
export function screens(site: BricksSite): { desktop: string; tablet: string; phone: string } {
	const bps = site.breakpoints;
	const desktop = bps[0]?.key ?? "desktop";
	const phone = bps.at(-1)?.key ?? "mobile_portrait";
	const tablet = [...bps].sort((a, b) => Math.abs(a.width - 900) - Math.abs(b.width - 900))[0]?.key ?? "tablet_portrait";
	return { desktop, tablet, phone };
}

// ── Templates ────────────────────────────────────────────────────────────────

export type TemplateType = "header" | "footer" | "content" | "section" | "popup" | "archive" | "search" | "error" | "password_protection" | string;

export interface TemplatePost {
	id: number;
	slug: string;
	title: string;
	status: string;
	meta: Record<string, unknown>;
}

/** `_bricks_template_type` (header, footer, content, section, popup, archive, search, error, …). */
export function templateType(meta: Record<string, unknown> | undefined): TemplateType | undefined {
	return str(meta?._bricks_template_type);
}

/**
 * A template's elements. Header templates keep them in `_bricks_page_header_2`, footer templates in
 * `_bricks_page_footer_2`, every other type in `_bricks_page_content_2` (includes/database.php get_bricks_data_key).
 */
export function templateElements(meta: Record<string, unknown> | undefined, read: (v: unknown) => BricksElement[] | undefined): BricksElement[] | undefined {
	const type = templateType(meta);
	const key = type === "header" ? "_bricks_page_header_2" : type === "footer" ? "_bricks_page_footer_2" : "_bricks_page_content_2";
	return read(meta?.[key]) ?? read(meta?._bricks_page_content_2) ?? read(meta?._bricks_page_header_2) ?? read(meta?._bricks_page_footer_2);
}

/** `_bricks_template_settings.templateConditions`: `[{ main: any|frontpage|postType|ids|terms|archiveType|search|error, exclude?, … }]`. */
export function templateConditions(meta: Record<string, unknown> | undefined): Obj[] {
	let s: unknown = meta?._bricks_template_settings;
	if (typeof s === "string") {
		try {
			s = JSON.parse(s);
		} catch {
			s = undefined;
		}
	}
	return list(obj(s)?.templateConditions);
}

/** Short text for a condition list (coverage report). */
export function describeConditions(conds: Obj[]): string {
	if (!conds.length) return "no conditions (not applied)";
	return conds.map((c) => `${c.exclude ? "not " : ""}${str(c.main) ?? "?"}${Array.isArray(c.postType) ? `:${(c.postType as unknown[]).join("/")}` : ""}${Array.isArray(c.ids) ? `:${(c.ids as unknown[]).join("/")}` : ""}`).join(", ");
}

/**
 * The header and footer the whole site uses: a published template of that type with an "entire website" (any)
 * condition; failing that, one that applies to the front page. Others (page-specific) are reported, not migrated.
 */
export function siteTemplates(templates: TemplatePost[]): { header?: TemplatePost; footer?: TemplatePost; others: { post: TemplatePost; type: string; conditions: string }[] } {
	const pick = (type: string) => {
		const of = templates.filter((t) => t.status === "publish" && templateType(t.meta) === type);
		const score = (t: TemplatePost) => {
			const c = templateConditions(t.meta).filter((x) => !x.exclude);
			return c.some((x) => x.main === "any") ? 2 : c.some((x) => x.main === "frontpage") ? 1 : 0;
		};
		return of.filter((t) => score(t) > 0).sort((a, b) => score(b) - score(a) || a.id - b.id)[0];
	};
	const header = pick("header");
	const footer = pick("footer");
	const others = templates.filter((t) => (templateType(t.meta) === "header" || templateType(t.meta) === "footer") && t !== header && t !== footer).map((post) => ({ post, type: templateType(post.meta) as string, conditions: describeConditions(templateConditions(post.meta)) }));
	return { ...(header ? { header } : {}), ...(footer ? { footer } : {}), others };
}

/**
 * Design values Bricks stores outside the pages, for the design capture to compare with: the palette (resolved),
 * the site-wide theme style's colours and typography. The IR has no field for them; written to the transform report.
 */
export function bricksDesign(site: BricksSite): { palette: Record<string, string>; colors: Record<string, string>; typography: Record<string, Obj>; sectionPadding?: Obj } {
	const palette: Record<string, string> = {};
	for (const [id, v] of site.palette) {
		const c = resolveColour(v, site);
		if (c) palette[id] = c;
	}
	const colors: Record<string, string> = {};
	for (const [k, v] of Object.entries(obj(site.themeStyle?.colors) ?? {})) {
		const c = resolveColour(v, site);
		if (c) colors[k] = c;
	}
	const typography: Record<string, Obj> = {};
	for (const [k, v] of Object.entries(obj(site.themeStyle?.typography) ?? {})) {
		const t = obj(v);
		if (!t || !/^typography/.test(k)) continue;
		const out: Obj = {};
		for (const p of ["font-family", "font-size", "font-weight", "line-height", "letter-spacing", "text-transform"]) if (t[p] !== undefined) out[p] = t[p];
		const color = resolveColour(t.color, site);
		if (color) out.color = color;
		if (Object.keys(out).length) typography[k] = out;
	}
	const sectionPadding = obj(obj(site.themeStyle?.section)?.padding);
	return { palette, colors, typography, ...(sectionPadding ? { sectionPadding } : {}) };
}
