/**
 * Site-wide layout of a Bricks site, for the starter's tokens (scaffold appends them to tokens.css of Bricks sites only):
 * - the content width: the theme style's container width (`container.width`, Bricks default 1100px), resolved through
 *   global and live design variables (Automatic.css `var(--content-width)` → 1366px);
 * - the page gutter: Bricks sections are full width with side padding, so the side padding measured on the live
 *   sections (audit element boxes, most common value per viewport) is the gutter (`min(container, 100% − 2 × padding)`);
 * - Automatic.css text rules (`automatic-bricks.css`: `p, li { line-height: var(--text-line-height) }`, `text-wrap`),
 *   its automatic image radius (`auto-radius-selectors` names `img`), and its button geometry (`btn--*` classes).
 * Verified on the first Bricks site: docs/spikes/bricks-findings.md ("Visual parity, second round").
 */
import type { BricksBox } from "../../audit/browser.js";
import { atBreakpoint, type BricksSite, cssPx, effectiveSettings, obj, resolveColour, str } from "./site.js";

export interface BricksLayout {
	/** Content width (px). */
	container?: number;
	/** Section side padding per viewport (px). */
	gutter?: { mobile?: number; tablet?: number; desktop?: number };
	/** Automatic.css paragraph and list-item line height, as written (`calc(6px + 2ex)`). */
	textLeading?: string;
	/** Automatic.css `text-wrap` for text and headings (`pretty`, `balance`). */
	textWrap?: string;
	headingWrap?: string;
	/** Automatic.css space between paragraphs of a text element (`--paragraph-spacing`, em). */
	paragraphSpacing?: number;
	/** Automatic.css automatic radius on images (px). */
	imageRadius?: number;
	/** Automatic.css button (`btn--*` classes): text size per viewport (px), line height, border width (px). */
	button?: { size?: { mobile: number; desktop: number }; leading?: number; border?: number };
}

const LEADING = /^calc\(\s*\d+(?:\.\d+)?px\s*\+\s*\d+(?:\.\d+)?ex\s*\)$/;
const WRAP = /^(?:pretty|balance|wrap|stable)$/;

/** Most common value (rounded to 0.1px). */
function mode(values: number[]): number | undefined {
	const votes = new Map<number, number>();
	for (const v of values) {
		const k = Math.round(v * 10) / 10;
		votes.set(k, (votes.get(k) ?? 0) + 1);
	}
	return [...votes.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0];
}

/** A live variable's value at a viewport width (the capture nearest that width). */
function live(site: BricksSite, name: string, width: number): string | undefined {
	const w = site.live?.widths;
	if (!w?.length) return undefined;
	return w.reduce((a, b) => (Math.abs(b.width - width) < Math.abs(a.width - width) ? b : a)).vars[name]?.trim();
}

export function bricksLayout(site: BricksSite, shots: { viewport: string; bricks?: Record<string, BricksBox> }[], acss?: Record<string, unknown>): BricksLayout {
	const out: BricksLayout = {};
	const width = cssPx(obj(site.themeStyle?.container)?.width, site, 1440);
	if (width && width >= 600 && width <= 2400) out.container = Math.round(width);
	// Top-level sections of the content area (`c:<n>`, a `section` element): their side padding.
	const gutter: NonNullable<BricksLayout["gutter"]> = {};
	for (const vp of ["mobile", "tablet", "desktop"] as const) {
		const pads = shots.filter((s) => s.viewport === vp).flatMap((s) => Object.entries(s.bricks ?? {}).filter(([k, b]) => /^c:\d+$/.test(k) && b.name === "section" && b.pad && Math.abs(b.pad[1] - b.pad[3]) < 0.5).map(([, b]) => (b.pad as [number, number, number, number])[1]));
		const m = mode(pads);
		if (m !== undefined && m >= 0 && m <= 200) gutter[vp] = m;
	}
	if (Object.keys(gutter).length) out.gutter = gutter;
	// Automatic.css (its variables are on the live page): text line height and wrapping, image radius, buttons.
	if (live(site, "text-line-height", 1440) !== undefined) {
		const lead = live(site, "text-line-height", 1440);
		if (lead && LEADING.test(lead)) out.textLeading = lead.replace(/\s+/g, " ");
		const wrap = live(site, "text-text-wrap", 1440);
		if (wrap && WRAP.test(wrap)) out.textWrap = wrap;
		const hwrap = live(site, "heading-text-wrap", 1440);
		if (hwrap && WRAP.test(hwrap)) out.headingWrap = hwrap;
		const ps = live(site, "paragraph-spacing", 1440);
		if (ps && /^\d*\.?\d+em$/.test(ps) && Number.parseFloat(ps) <= 4) out.paragraphSpacing = Number.parseFloat(ps);
		const selectors = str(acss?.["auto-radius-selectors"]);
		const radius = cssPx(live(site, "radius", 1440), site, 1440);
		if (selectors && /(?:^|[\s,("])(?::where\()?img\b/.test(selectors) && radius !== undefined && radius >= 0 && radius <= 60) out.imageRadius = radius;
		const size = (w: number) => cssPx(live(site, "btn-font-size", w) || live(site, "text-m", w), site, w);
		const sm = size(390);
		const lg = size(1440);
		const leading = Number(live(site, "btn-line-height", 1440));
		const border = cssPx(live(site, "btn-border-width", 1440), site, 1440);
		const button: NonNullable<BricksLayout["button"]> = {};
		if (sm && lg && sm >= 10 && lg <= 40) button.size = { mobile: sm, desktop: lg };
		if (Number.isFinite(leading) && leading >= 0.8 && leading <= 3) button.leading = leading;
		if (border !== undefined && border >= 0 && border <= 6) button.border = border;
		if (Object.keys(button).length) out.button = button;
	}
	return out;
}

/** A header button's look: label (pairs it with the migrated header button), colours, corners and padding (px). */
export interface BricksHeaderButton {
	label: string;
	bg?: string;
	color?: string;
	radius?: number;
	padY?: number;
	padX?: number;
}

/**
 * The header template's own look (Bricks header: a section with side padding around a container of the theme's
 * width; a toggle shown from a breakpoint down; call-to-action buttons; an offcanvas menu with its logo, close toggle,
 * menu and buttons pinned to the bottom). Read from the template's elements and their global classes.
 */
export interface BricksHeaderLook {
	/** Side padding of the header section per viewport (px); the bar sits in the content width inside it. */
	gutter?: { mobile: number; desktop: number };
	/** The menu toggle is hidden at desktop width (`_display: none`, shown from a smaller breakpoint). */
	toggleSmallOnly?: boolean;
	/** The bar's buttons are hidden on phones (`_display:mobile_landscape: none`): they show in the menu panel only. */
	buttonsHidePhone?: boolean;
	buttons?: BricksHeaderButton[];
	/** The offcanvas menu panel: padding, gap under the logo, gap between items, gap above the buttons, close icon size, logo height, width on wide screens (px or fluid), its buttons. */
	panel?: { pad?: string; logoGap?: string; itemGap?: string; buttonsGap?: string; closeInset?: string; closeSize?: number; logoHeight?: number; width?: number; buttons?: BricksHeaderButton[] };
}

const RIPPLE = /^(?:ripple_button(?:_v\d)?|next_ripple_button(?:_v\d)?)$/;

export function bricksHeaderLook(elements: { id: string; name: string; parent: string | number; children?: string[]; settings?: Record<string, unknown> }[], site: BricksSite): BricksHeaderLook {
	const out: BricksHeaderLook = {};
	if (!elements.length) return out;
	const byId = new Map(elements.map((e) => [e.id, e]));
	const eff = (e: (typeof elements)[number]) => effectiveSettings(e as never, site);
	const roots = elements.filter((e) => e.parent === 0 || e.parent === "0" || !byId.has(String(e.parent)));
	// Document order (each parent's children list), so buttons keep the order the visitor sees.
	const ordered: typeof elements = [];
	const visit = (e: (typeof elements)[number], depth = 0) => {
		if (ordered.includes(e) || depth > 30) return;
		ordered.push(e);
		for (const c of e.children ?? []) {
			const k = byId.get(String(c));
			if (k) visit(k, depth + 1);
		}
	};
	for (const r of roots) visit(r);
	for (const e of elements) if (!ordered.includes(e)) ordered.push(e);
	const insideOffcanvas = (e: (typeof elements)[number]): boolean => {
		for (let p = byId.get(String(e.parent)), i = 0; p && i < 20; p = byId.get(String(p.parent)), i++) if (p.name === "offcanvas") return true;
		return false;
	};
	const bp = site.breakpoints;
	const desktop = (bp.find((b) => b.base) ?? bp[0])?.key ?? "desktop";
	const phone = bp.at(-1)?.key ?? "mobile_portrait";
	const landscape = bp.find((b) => b.key === "mobile_landscape")?.key ?? phone;
	const at = (e: (typeof elements)[number], key: string, b: string) => atBreakpoint(eff(e), key, b, site);
	const px = (v: unknown, w: number) => cssPx(v, site, w);
	const fluidOf = (v: unknown) => {
		const m = px(v, 390);
		const d = px(v, 1440);
		if (m === undefined || d === undefined || m < 0 || d < 0 || m > 300 || d > 300) return undefined;
		return Math.abs(m - d) < 0.5 ? `${Math.round(d * 100) / 100}px` : fluidCss(m, d);
	};
	// Header section side padding.
	const root = roots.find((e) => ["section", "container", "block", "div"].includes(e.name));
	if (root) {
		const m = px(obj(at(root, "_padding", phone))?.left, 390);
		const d = px(obj(at(root, "_padding", desktop))?.left, 1440);
		if (m !== undefined && d !== undefined && m <= 200 && d <= 200) out.gutter = { mobile: m, desktop: d };
	}
	const bar = ordered.filter((e) => !insideOffcanvas(e) && e.name !== "offcanvas");
	if (bar.some((e) => e.name === "toggle" && str(at(e, "_display", desktop)) === "none")) out.toggleSmallOnly = true;
	const look = (e: (typeof elements)[number]): BricksHeaderButton | undefined => {
		const s = eff(e);
		if (RIPPLE.test(e.name)) {
			const label = str(s.topRippleInnerTitle)?.trim();
			if (!label) return undefined;
			const pad = obj(s.padding);
			return {
				label,
				...(resolveColour(obj(s.topRippleBackground)?.color, site) ? { bg: resolveColour(obj(s.topRippleBackground)?.color, site) } : {}),
				...(resolveColour(s.topRippleColor, site) ? { color: resolveColour(s.topRippleColor, site) } : {}),
				// NextBricks ripple button v3 CSS: --border-radius 100px, padding 15px 30px unless the element sets its own.
				radius: 100,
				padY: px(pad?.top, 1440) ?? 15,
				padX: px(pad?.left, 1440) ?? 30,
			};
		}
		return undefined;
	};
	const barButtons = bar.filter((e) => RIPPLE.test(e.name)).map(look).filter((b): b is BricksHeaderButton => !!b);
	if (barButtons.length) out.buttons = barButtons;
	if (bar.some((e) => RIPPLE.test(e.name)) && bar.filter((e) => RIPPLE.test(e.name)).every((e) => str(at(e, "_display", landscape)) === "none")) out.buttonsHidePhone = true;
	// Offcanvas panel.
	const oc = elements.find((e) => e.name === "offcanvas");
	if (oc) {
		const kids = ordered.filter((e) => insideOffcanvas(e));
		const content = kids.find((e) => str(obj(e.settings?._hidden)?._cssClasses)?.includes("brx-offcanvas-inner"));
		const panel: NonNullable<BricksHeaderLook["panel"]> = {};
		if (content) {
			const pad = fluidOf(obj(at(content, "_padding", desktop))?.left);
			if (pad) panel.pad = pad;
			const g = fluidOf(at(content, "_rowGap", desktop));
			if (g) panel.logoGap = g;
		}
		const menu = kids.find((e) => e.name === "nav-menu");
		if (menu) {
			const g = fluidOf(at(menu, "menuGap", desktop));
			if (g) panel.itemGap = g;
		}
		const close = kids.find((e) => e.name === "toggle");
		if (close) {
			const inset = fluidOf(at(close, "_top", desktop));
			if (inset) panel.closeInset = inset;
			const size = px(at(close, "iconSize", desktop), 1440);
			if (size && size >= 12 && size <= 80) panel.closeSize = size;
		}
		const logo = kids.find((e) => e.name === "logo");
		const lh = logo ? px(str(at(logo, "logoHeight", desktop))?.replace(/px$/, ""), 1440) : undefined;
		if (lh && lh >= 20 && lh <= 300) panel.logoHeight = lh;
		const w = px(at(oc, "width", desktop), 1440);
		if (w && w >= 200 && w <= 2000) panel.width = w;
		const pb = kids.filter((e) => RIPPLE.test(e.name)).map(look).filter((b): b is BricksHeaderButton => !!b);
		const holder = kids.find((e) => (e.children ?? []).length >= 2 && (e.children ?? []).every((c) => RIPPLE.test(byId.get(String(c))?.name ?? "")));
		const bg = holder ? fluidOf(at(holder, "_columnGap", desktop)) : undefined;
		if (bg) panel.buttonsGap = bg;
		if (pb.length) panel.buttons = pb;
		if (Object.keys(panel).length) out.panel = panel;
	}
	return out;
}

/** clamp() between a phone and a desktop value (the scaffold's fluid(), kept here to avoid an import cycle). */
function fluidCss(min: number, max: number): string {
	const r = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
	const slope = (max - min) / (1440 - 390);
	return `clamp(${r(Math.min(min, max))}px, ${r(min - slope * 390)}px + ${r(slope * 100, 3)}vw, ${r(Math.max(min, max))}px)`;
}
