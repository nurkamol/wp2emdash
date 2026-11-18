/**
 * Generated project files: tokens.css (design capture), motion.css (menu motion recipe),
 * site.config.json (header variant, fonts, identity), forms, package/astro/wrangler config, seed.
 * Everything here is a pure function of the site workspace, so reruns reproduce the project.
 */
import type { MenuCapture, MotionRecipe } from "../audit/interactions.js";
import { motionRecipe } from "../audit/interactions.js";
import type { KitConfig } from "../config/schema.js";

// ── Colour helpers ───────────────────────────────────────────────────────────
export function toHex(c: string | undefined): string | undefined {
	if (!c) return undefined;
	if (/^#[0-9a-f]{3,8}$/i.test(c.trim())) return c.trim().toLowerCase();
	const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)/i.exec(c);
	if (!m) return undefined;
	if (m[4] !== undefined && Number(m[4]) < 1) return c.replace(/\s+/g, " ");
	return `#${[m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, "0")).join("")}`;
}
const luminance = (hex: string) => {
	const n = (i: number) => Number.parseInt(hex.slice(i, i + 2), 16) / 255;
	const lin = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
	return hex.length === 7 ? 0.2126 * lin(n(1)) + 0.7152 * lin(n(3)) + 0.0722 * lin(n(5)) : 0.5;
};

/** WCAG contrast ratio between two #rrggbb colours. */
export const contrastRatio = (a: string, b: string) => {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
	return (hi + 0.05) / (lo + 0.05);
};
/**
 * Text colour for a button fill: the source's own when it meets WCAG AA (4.5:1), otherwise the site's text colour
 * or white, whichever passes (best of the two). Returns the fix so it can be reported as an improvement.
 */
export function readableOn(fill: string, wanted: string, siteText: string): { color: string; fixed: boolean } {
	if (contrastRatio(fill, wanted) >= 4.5) return { color: wanted, fixed: false };
	const options = [siteText, "#ffffff", "#000000"].sort((x, y) => contrastRatio(fill, y) - contrastRatio(fill, x));
	return { color: options[0] as string, fixed: true };
}

// ── Design → tokens ──────────────────────────────────────────────────────────
interface TypographyEntry {
	/** Every element of the tag on that page had an element-level size. */
	custom?: boolean;
	fontFamily: string;
	fontSize: string;
	fontWeight: string;
	lineHeight: string;
	letterSpacing: string;
	color: string;
	textTransform?: string;
	/** Distinct texts on the page drawn at this size. */
	count?: number;
}
export interface DesignCapture {
	url?: string;
	viewport: string;
	fonts: { family: string; count: number }[];
	colors: { value: string; count: number; usage: "text" | "background" | "border" }[];
	typography: Record<string, TypographyEntry | undefined>;
	buttons: { text: string; styles: Record<string, string> }[];
	containerWidths: { width: number; count: number }[];
	/** Most common left edge of content text, px (page gutter). */
	gutter?: number;
	/** Most common corner radius of large photos, px. */
	mediaRadius?: number;
	/** Space between consecutive paragraphs, px. */
	paragraphGap?: number;
	listItemGap?: number;
	listIndent?: number;
	header: { height: number; background: string } | null;
	footer: { height: number; background: string; color: string } | null;
	logo?: { src: string; width: number; height: number };
	favicon?: string;
	cssVariables: Record<string, string>;
	pageBackground?: string;
	formField?: import("../audit/browser.js").FormFieldLook;
}

const px = (v: string | undefined) => (v ? Number.parseFloat(v) : Number.NaN);
/** Fluid size between the mobile (390px) and desktop (1440px) captures. */
export function fluid(min: number, max: number): string {
	if (!Number.isFinite(min) || !Number.isFinite(max)) return Number.isFinite(max) ? `${round(max)}px` : "1rem";
	if (Math.abs(max - min) < 0.5) return `${round(max)}px`;
	const lo = Math.min(min, max);
	const hi = Math.max(min, max);
	const slope = (max - min) / (1440 - 390);
	const base = min - slope * 390;
	return `clamp(${round(lo)}px, ${round(base)}px + ${round(slope * 100, 3)}vw, ${round(hi)}px)`;
}
const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

export interface Tokens {
	css: string;
	fonts: { body: string; display: string; displayWeight?: number; googleHref?: string; selfHosted?: boolean; preload?: string[] };
	colors: { bg: string; text: string; accent: string; accentContrast: string; surface: string };
}

/**
 * Type styles voted across every captured page of a viewport: the size most texts use wins; in a tie the inner pages win
 * (a home hero is usually a one-off). Pages where every element of a tag has its own size only vote when no page shows the plain style.
 */
function mergedTypography(designs: DesignCapture[], viewport: string, first: Record<string, TypographyEntry | undefined>): Record<string, TypographyEntry | undefined> {
	const out: Record<string, TypographyEntry | undefined> = { ...first };
	for (const tag of Object.keys(first)) {
		const votes = new Map<string, { n: number; e: TypographyEntry }>();
		// Pages where the tag only appears with element-level sizes do not vote when another page shows the theme's own style.
		const anyPlain = designs.some((d) => d.viewport === viewport && d.typography[tag] && !d.typography[tag]?.custom);
		for (const d of designs) {
			const e = d.viewport === viewport ? d.typography[tag] : undefined;
			if (!e || (anyPlain && e.custom)) continue;
			const v = votes.get(e.fontSize) ?? { n: 0, e };
			const home = /^https?:\/\/[^/]+\/?$/.test(d.url ?? "");
			v.n += (e.count ?? 1) * (home ? 0.9 : 1);
			votes.set(e.fontSize, v);
		}
		const best = [...votes.values()].sort((a, b) => b.n - a.n)[0];
		if (best) out[tag] = best.e;
	}
	return out;
}

export function buildTokens(designs: DesignCapture[]): Tokens {
	const desktop = designs.find((d) => d.viewport === "desktop") ?? designs.at(-1);
	const mobile = designs.find((d) => d.viewport === "mobile") ?? designs[0];
	if (!desktop || !mobile) throw new Error("No design capture: run the audit first");
	const t = mergedTypography(designs, desktop.viewport, desktop.typography);
	const tm = mergedTypography(designs, mobile.viewport, mobile.typography);
	const body = t.body;
	const bgCandidates = desktop.colors.filter((c) => c.usage === "background").map((c) => toHex(c.value)).filter((c): c is string => !!c && c.startsWith("#"));
	const bg = toHex(desktop.pageBackground) ?? bgCandidates[0] ?? "#ffffff";
	const text = toHex(body?.color) ?? "#111111";
	const btn = desktop.buttons.find((b) => b.styles.background && !/rgba\(0, 0, 0, 0\)|transparent/.test(b.styles.background));
	const accent = toHex(btn?.styles.background) ?? toHex(desktop.colors.find((c) => c.usage === "text" && !["#000000", "#ffffff", text].includes(toHex(c.value) ?? ""))?.value) ?? text;
	const accentContrast = toHex(btn?.styles.color) ?? (luminance(accent) > 0.45 ? "#000000" : "#ffffff");
	const surface = toHex(desktop.footer?.background) && toHex(desktop.footer?.background) !== bg ? (toHex(desktop.footer?.background) as string) : (bgCandidates.find((c) => c !== bg) ?? bg);
	const bodyFont = body?.fontFamily ?? desktop.fonts[0]?.family ?? "system-ui";
	const displayFont = t.h1?.fontFamily ?? t.h2?.fontFamily ?? bodyFont;
	const size = (k: string, fallback: number) => fluid(px(tm[k]?.fontSize) || fallback, px(t[k]?.fontSize) || fallback);
	const lh = (k: string) => {
		const e = t[k];
		const r = e ? px(e.lineHeight) / px(e.fontSize) : Number.NaN;
		return Number.isFinite(r) ? round(r, 3) : undefined;
	};
	const tracking = (k: string) => {
		const e = t[k];
		const r = e ? px(e.letterSpacing) / px(e.fontSize) : Number.NaN;
		return Number.isFinite(r) ? `${round(r, 3)}em` : "0";
	};
	const container = Math.min(Math.max(...desktop.containerWidths.map((c) => c.width), 1140), 1680);
	// Page gutter measured on the source (phone → desktop); the starter default when not captured.
	const gutterOf = (vp: string) => designs.find((d) => d.viewport === vp && d.gutter)?.gutter;
	const gd = gutterOf("desktop");
	const gm = gutterOf("mobile");
	// Tablet gutter as a share of the width (themes use a percentage there), when it is off the phone→desktop line.
	const tabletDesign = designs.find((d) => d.viewport === "tablet" && d.gutter);
	const tabletWidth = (tabletDesign as { width?: number } | undefined)?.width ?? 768;
	const gt = tabletDesign?.gutter;
	const onLine = gd && gm ? gm + ((gd - gm) * (tabletWidth - 390)) / (1440 - 390) : undefined;
	const gutterTablet = gt && onLine !== undefined && Math.abs(gt - onLine) > 2 ? `${round((gt / tabletWidth) * 100, 3)}vw` : undefined;
	// Photo corners measured on the source; 8px when not captured.
	const radiusVotes = new Map<number, number>();
	for (const d of designs) if (d.mediaRadius !== undefined) radiusVotes.set(d.mediaRadius, (radiusVotes.get(d.mediaRadius) ?? 0) + 1);
	const mediaRadius = [...radiusVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 8;
	// Paragraph rhythm, voted across captured pages, in em of 16px body copy so it scales with the text.
	const gapVotes = new Map<number, number>();
	for (const d of designs) if (d.paragraphGap !== undefined) gapVotes.set(d.paragraphGap, (gapVotes.get(d.paragraphGap) ?? 0) + 1);
	const paragraphGap = [...gapVotes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
	const vote = (k: "listItemGap" | "listIndent") => {
		const v = new Map<number, number>();
		for (const d of designs) if (d[k] !== undefined) v.set(d[k] as number, (v.get(d[k] as number) ?? 0) + 1);
		return [...v.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
	};
	const listItemGap = vote("listItemGap");
	// Form fields as the source draws them (first content form found; desktop capture first).
	const field = [desktop, mobile, ...designs].find((d) => d.formField)?.formField;
	const fieldBg = field ? toHex(field.background) : undefined;
	const fieldVars = field
		? [
				fieldBg && !/rgba/.test(fieldBg) ? `\n\t--color-input-bg: ${fieldBg};` : "",
				`\n\t--input-border: ${field.border === "none" ? "0" : field.border};`,
				field.borderTop !== field.border ? `\n\t--input-border-top: ${field.borderTop === "none" ? "0" : field.borderTop};` : "",
				field.height >= 30 && field.height <= 90 ? `\n\t--input-height: ${field.height}px;\n\t--input-pad-y: 0;` : "",
				field.fontSize >= 10 && field.fontSize <= 24 ? `\n\t--input-size: ${field.fontSize}px;` : "",
				field.paddingInline > 0 && field.paddingInline <= 40 ? `\n\t--input-pad-x: ${field.paddingInline}px;` : "",
			].join("")
		: "";
	const fieldRules = field?.labelsHidden
		? `/* The source shows placeholders only: labels stay for screen readers. */
.field__label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
`
		: "";
	const gutter = gd && gm ? fluid(gm, gd) : "clamp(20px, 5vw, 64px)";
	const radius = btn?.styles.borderRadius ?? "6px";
	// Buttons in the page content (not the header pill): their type and text colour, voted across pages.
	const contentBtns = new Map<string, { n: number; s: Record<string, string> }>();
	for (const d of designs) {
		if (d.viewport !== desktop.viewport) continue;
		for (const b of d.buttons) {
			if (b.styles.inHeader !== "no" || !b.styles.background || /rgba\(0, 0, 0, 0\)|transparent/.test(b.styles.background)) continue;
			// Same fill as the site's main button: a call to action, not a widget control (date pickers, tabs).
			if (btn && b.styles.background !== btn.styles.background) continue;
			const k = [b.styles.fontSize, b.styles.textTransform, b.styles.letterSpacing, b.styles.color].join("|");
			const v = contentBtns.get(k) ?? { n: 0, s: b.styles };
			v.n++;
			contentBtns.set(k, v);
		}
	}
	const cb = [...contentBtns.values()].sort((a, b) => b.n - a.n)[0]?.s;
	const cbTrack = cb && px(cb.letterSpacing) && px(cb.fontSize) ? `${round(px(cb.letterSpacing) / px(cb.fontSize), 3)}em` : undefined;
	// Padding in em of the button's own text, so it scales with --btn-size (Salient: 12px 18px on 12px type).
	const cbPadPx = cb?.padding?.split(/\s+/).map((x) => px(x));
	const cbPad = cb && cbPadPx && cbPadPx.length === 4 && cbPadPx.every((x) => Number.isFinite(x)) && (cbPadPx[0] as number) > 0 && px(cb.fontSize) > 0 ? `${round((cbPadPx[0] as number) / (px(cb.fontSize) as number), 3)}em ${round((cbPadPx[1] as number) / (px(cb.fontSize) as number), 3)}em` : undefined;
	// Content buttons keep the source's text colour unless it fails WCAG AA on the accent (an improvement, reported).
	const cbColor = toHex(cb?.color) ? readableOn(accent, toHex(cb?.color) as string, text) : undefined;
	const contentBtnVars = cb
		? [`	--btn-size: ${cb.fontSize};`, `	--btn-transform: ${cb.textTransform || "none"};`, cbTrack ? `	--btn-tracking: ${cbTrack};` : "", cbColor ? `	--btn-color: ${cbColor.color};${cbColor.fixed ? ` /* source ${toHex(cb.color)} is ${contrastRatio(accent, toHex(cb.color) as string).toFixed(2)}:1 on the accent; raised to meet WCAG AA */` : ""}` : "", cb.fontWeight ? `	--btn-weight-content: ${cb.fontWeight};` : "", cbPad ? `	--btn-padding: ${cbPad};` : ""].filter(Boolean).join("\n")
		: "";
	// Every weight the captured text uses (a light 300 heading must not fall back to 400), plus the common ones.
	const usedWeights = Object.values(t).map((e) => Number((e as { fontWeight?: string } | undefined)?.fontWeight)).filter((w) => Number.isFinite(w) && w >= 100 && w <= 900);
	const weights = [...new Set([400, 500, 600, 700, ...usedWeights])].sort((a, b) => a - b);
	const displayWeight = Number(t.h2?.fontWeight ?? t.h1?.fontWeight) || 400;
	const isGeneric = (f: string) => /^(system-ui|sans-serif|serif|monospace|-apple-system|arial|helvetica|georgia|times)/i.test(f);
	const families = [...new Set([bodyFont, displayFont])].filter((f) => !isGeneric(f));
	const googleHref = families.length ? `https://fonts.googleapis.com/css2?${families.map((f) => `family=${encodeURIComponent(f).replace(/%20/g, "+")}:ital,wght@${[0, 1].flatMap((i) => weights.map((w) => `${i},${w}`)).join(";")}`).join("&")}&display=swap` : undefined;
	const fontStack = (f: string, kind: "sans" | "serif") => `"${f}", ${kind === "serif" ? "Georgia, serif" : "system-ui, sans-serif"}`;
	const displayKind = /cormorant|playfair|serif|garamond|lora|merriweather|libre|dm serif|instrument/i.test(displayFont) ? "serif" : "sans";

	// Per-level heading style: themes often mix fonts (Salient: serif h1–h3, sans uppercase h5 eyebrows).
	const levelVars = ["h1", "h2", "h3", "h4", "h5", "h6"]
		.map((k) => {
			const e = t[k];
			if (!e) return "";
			const font = e.fontFamily === bodyFont && bodyFont !== displayFont ? "var(--font-body)" : "var(--font-display)";
			return `\t--${k}-font: ${font};\n\t--${k}-weight: ${e.fontWeight};\n\t--${k}-tracking: ${tracking(k)};\n\t--${k}-transform: ${e.textTransform === "uppercase" ? "uppercase" : "none"};\n\t--${k}-leading: ${lh(k) ?? 1.2};`;
		})
		.filter(Boolean)
		.join("\n");
	const eyebrowSource = ["h5", "h6", "h4"].find((k) => t[k]?.textTransform === "uppercase");
	const eyebrowVars = eyebrowSource
		? `\t--eyebrow-font: var(--${eyebrowSource}-font);\n\t--eyebrow-size: var(--font-size-${eyebrowSource});\n\t--eyebrow-weight: var(--${eyebrowSource}-weight);\n\t--eyebrow-tracking: var(--${eyebrowSource}-tracking);`
		: "";

	const css = `/* Generated by wp2emdash scaffold from the audit's design capture. Edit values here, not in base.css. */
:root {
	--color-bg: ${bg};
	--color-text: ${text};
	--color-accent: ${accent};
	--color-accent-contrast: ${accentContrast};
	--color-accent-hover: color-mix(in srgb, ${accent} 88%, #000);
	--color-surface: ${surface};
	--color-line: color-mix(in srgb, ${text} 14%, transparent);
	--color-line-strong: color-mix(in srgb, ${text} 28%, transparent);
	--color-on-dark: #ffffff;
	--color-input-bg: color-mix(in srgb, ${bg} 60%, #fff);

	--font-body: ${fontStack(bodyFont, "sans")};
	--font-display: ${fontStack(displayFont, displayKind)};
	--font-size-body: ${size("body", 16)};
	--font-size-lead: ${fluid((px(tm.body?.fontSize) || 16) * 1.12, (px(t.body?.fontSize) || 16) * 1.25)};
	--font-size-small: 0.8125rem;
	--font-size-h1: ${size("h1", 40)};
	--font-size-h2: ${size("h2", 32)};
	--font-size-h3: ${size("h3", 26)};
	--font-size-h4: ${size("h4", 22)};
	--font-size-h5: ${size("h5", 18)};
	--font-size-h6: ${size("h6", 16)};
	--leading-body: ${lh("body") ?? 1.6};
	--leading-heading: ${lh("h2") ?? 1.2};
	--heading-weight: ${t.h2?.fontWeight ?? t.h1?.fontWeight ?? 500};
	--heading-tracking: ${tracking("h2")};
${levelVars}
${eyebrowVars}

	--container: ${container}px;
	--container-text: 46rem;
	--gutter: ${gutter};
	--space-compact: clamp(32px, 4vw, 56px);
	--space-normal: clamp(56px, 8vw, 120px);
	--space-spacious: clamp(80px, 12vw, 180px);

	--radius-button: ${radius};
	--radius-card: 12px;
	--radius-media: ${mediaRadius}px;${paragraphGap !== undefined ? `\n\t--para-gap: ${round(paragraphGap / 16, 3)}em;` : ""}${listItemGap !== undefined ? `\n\t--li-gap: ${listItemGap}px;` : ""}
	--radius-input: ${field ? `${field.radius}px` : "8px"};${fieldVars}
	--btn-padding: 0.95em 2em;
${contentBtnVars}
	--btn-weight: ${btn?.styles.fontWeight ?? 500};

	--ease-out: cubic-bezier(0.2, 0.75, 0.5, 1);
	--header-bg: ${toHex(desktop.header?.background) && !/rgba/.test(toHex(desktop.header?.background) ?? "") ? toHex(desktop.header?.background) : bg};
	--footer-bg: ${toHex(desktop.footer?.background) ?? surface};
}
${gutterTablet ? `/* Tablet gutter measured on the source (a share of the width there, not on the phone→desktop line). */
@media (min-width: 691px) and (max-width: 999.98px) { :root { --gutter: ${gutterTablet}; } }
` : ""}${fieldRules}`;
	return { css, fonts: { body: bodyFont, display: displayFont, displayWeight, ...(googleHref ? { googleHref } : {}) }, colors: { bg, text, accent, accentContrast, surface } };
}

// ── Menu motion → motion.css + header config ─────────────────────────────────
export interface HeaderCapture {
	viewport: string;
	top: { height: number; background: string; logoSrc?: string; logoHeight?: number; color?: string };
	scrolled: { height: number; background: string; logoSrc?: string; transform?: string };
	changes: string[];
}

export function buildMotion(menus: MenuCapture[]): { css: string; recipe?: MotionRecipe; panel: string } {
	const m = menus.find((x) => x.found && x.viewport === "mobile") ?? menus.find((x) => x.found);
	const r = m ? motionRecipe(m) : undefined;
	const style = m?.themeSettings?.slideOutWidgetAreaStyle;
	const panel = style === "fullscreen-split" ? "fullscreen-split" : style?.startsWith("fullscreen") ? "fullscreen" : style === "slide-out-from-right" || r?.panelType === "off-canvas-right" ? "off-canvas-right" : r?.panelType === "off-canvas-left" ? "off-canvas-left" : r?.panelType === "fullscreen" ? "fullscreen" : "off-canvas-right";
	const ms = (n: number | undefined, d: number) => `${Math.round(n ?? d)}ms`;
	const overlayBg = toHex(r?.overlay?.background) ?? "#0a0202";
	const css = `/* Generated by wp2emdash scaffold from the audit's menu motion recipe${m ? ` (${m.viewport}, ${m.url})` : " (defaults: no menu captured)"}. */
:root {
	--menu-overlay-bg: ${overlayBg.startsWith("rgba") ? overlayBg.replace(/,\s*[\d.]+\)$/, ", 1)") : overlayBg};
	--menu-overlay-opacity: ${r?.overlay?.opacity ?? 0.95};
	--menu-overlay-ms: ${ms(r?.overlay?.durationMs, 300)};
	--menu-overlay-ease: ${r?.overlay?.easing ?? "ease"};
	--menu-icon-ms: ${ms(r?.icon?.durationMs, 650)};
	--menu-icon-ease: ${r?.icon?.easing ?? "cubic-bezier(0.3, 1, 0.3, 1)"};
	--menu-icon-stagger: ${ms(r?.icon?.staggerMs, 40)};
	--menu-item-ms: ${ms(r?.items?.durationMs, 850)};
	--menu-item-ease: ${r?.items?.easing ?? "cubic-bezier(0.2, 0.75, 0.5, 1)"};
	--menu-item-delay: ${ms(r?.items?.startDelayMs, 160)};
	--menu-item-stagger: ${ms(r?.items?.staggerMs, 20)};
	--menu-close-ms: ${ms(Math.max(r?.overlay?.durationMs ?? 300, r?.items?.durationMs ?? 400), 400)};
}
`;
	return { css, ...(r ? { recipe: r } : {}), panel };
}

export interface SiteConfig {
	name: string;
	lang: string;
	productionUrl: string;
	favicon?: string;
	fonts: { body: string; display: string; displayWeight?: number; googleHref?: string; selfHosted?: boolean; preload?: string[] };
	header: {
		panel: string;
		/** centered: toggle | logo | actions (Salient "centered-logo…", many agency themes); logo-left: logo | nav | actions. */
		layout: "centered" | "logo-left";
		/** Inline menu links on wide screens; false when the source shows only the toggle at every width. */
		inlineNav: boolean;
		togglePosition: "left" | "right";
		/** Text next to the burger icon on the source ("MENU"), if any. */
		toggleLabel?: string;
		breakpoint: number;
		transparentOnTop: boolean;
		hideOnScroll: boolean;
		logo?: string;
		logoOnTop?: string;
		logoHeight: number;
		/** What the source's open menu shows around the main menu (from the audit's panel capture). */
		panelExtras?: PanelExtras;
		/** Main menu item text size in the panel, from the capture. */
		panelItemSize?: string;
	};
}

export function buildSiteConfig(config: KitConfig, tokens: Tokens, motion: { panel: string }, menus: MenuCapture[], headers: HeaderCapture[], brand: { logo?: string; logoOnTop?: string; favicon?: string }, lang: string): SiteConfig {
	const m = menus.find((x) => x.found);
	const desktopHeader = headers.find((h) => h.viewport === "desktop") ?? headers[0];
	const transparentOnTop = !!desktopHeader && /rgba\(0, 0, 0, 0\)|transparent/.test(desktopHeader.top.background) && desktopHeader.top.background !== desktopHeader.scrolled.background;
	const hideOnScroll = m?.themeSettings?.hhun === "1" || /translate|matrix\(1, 0, 0, 1, 0, -/.test(desktopHeader?.scrolled.transform ?? "");
	return {
		name: config.name,
		lang,
		productionUrl: config.target.productionUrl.replace(/\/$/, ""),
		...(brand.favicon ? { favicon: brand.favicon } : {}),
		fonts: tokens.fonts,
		header: {
			panel: motion.panel,
			...headerLayout(menus),
			breakpoint: Number(m?.themeSettings?.headerBreakpoint) || 1050,
			transparentOnTop,
			hideOnScroll,
			...(brand.logo ? { logo: brand.logo } : {}),
			...(brand.logoOnTop ? { logoOnTop: brand.logoOnTop } : {}),
			logoHeight: desktopHeader?.top.logoHeight ?? 56,
		},
	};
}

export interface PanelExtras {
	/** Items shown above the main menu, e.g. a large phone number. */
	/** smallOnly: shown on phones and tablets only (the source's desktop panel leaves it out). */
	lead: { label: string; href: string; smallOnly?: boolean }[];
	/** Icon links below the menu (phone, email, social). */
	contacts: { icon: "phone" | "email" | "instagram" | "facebook" | "linkedin" | "x" | "youtube" | "tiktok" | "link"; href: string; label: string }[];
	/** A "© year Site" line at the bottom. */
	credit: boolean;
}

/**
 * Splits the captured panel items around the main menu: leading extras, contact icon links after it,
 * and a trailing home link (Salient prints "© year Site" there). Items that are the main menu stay out.
 */
export function panelExtras(menus: MenuCapture[], primaryLabels: string[]): PanelExtras {
	const m = menus.find((x) => x.found && x.viewport === "mobile") ?? menus.find((x) => x.found);
	const out: PanelExtras = { lead: [], contacts: [], credit: false };
	if (!m) return out;
	const norm = (t: string) => t.trim().toLowerCase();
	const primary = new Set(primaryLabels.map(norm));
	const top = m.items.filter((i) => i.depth === 0);
	const firstMenu = top.findIndex((i) => primary.has(norm(i.text)));
	let lastMenu = -1;
	top.forEach((i, k) => {
		if (primary.has(norm(i.text))) lastMenu = k;
	});
	if (firstMenu < 0) return out;
	// A leading item the desktop panel does not show (e.g. a phone number for phones only) stays off desktop.
	const desk = menus.find((x) => x.found && x.viewport === "desktop");
	const deskTop = desk ? desk.items.filter((i) => i.depth === 0) : undefined;
	const deskFirst = deskTop?.findIndex((i) => primary.has(norm(i.text))) ?? -1;
	const deskLead = deskTop && deskFirst >= 0 ? deskTop.slice(0, deskFirst).map((i) => i.href) : undefined;
	out.lead = top.slice(0, firstMenu).map((i) => ({ label: i.text, href: i.href, ...(deskLead && !deskLead.includes(i.href) ? { smallOnly: true } : {}) }));
	const iconOf = (i: { text: string; href: string }): PanelExtras["contacts"][number]["icon"] | undefined => {
		const h = i.href.toLowerCase();
		if (h.startsWith("tel:")) return "phone";
		if (h.startsWith("mailto:")) return "email";
		for (const s of ["instagram", "facebook", "linkedin", "youtube", "tiktok"] as const) if (h.includes(s)) return s;
		if (/twitter\.com|x\.com/.test(h)) return "x";
		return undefined;
	};
	for (const i of top.slice(lastMenu + 1)) {
		const icon = iconOf(i);
		if (icon) out.contacts.push({ icon, href: i.href, label: i.text.trim() || `${icon[0]?.toUpperCase()}${icon.slice(1)}` });
		else if (i.href === "/" || /^https?:\/\/[^/]+\/?$/.test(i.href)) out.credit = true;
	}
	return out;
}

/**
 * Header arrangement from the audit: a toggle visible on desktop means the source has no inline menu;
 * a theme "centered" header format (or a toggle left of the middle) means toggle | logo | actions.
 */
export function headerLayout(menus: MenuCapture[]): Pick<SiteConfig["header"], "layout" | "inlineNav" | "togglePosition" | "toggleLabel"> {
	const desktop = menus.find((x) => x.viewport === "desktop");
	const any = menus.find((x) => x.found && x.toggle);
	const format = String(any?.themeSettings?.headerFormat ?? "");
	const vpWidth = any?.viewport === "mobile" ? 390 : any?.viewport === "tablet" ? 768 : 1440;
	const toggleLeft = !!any?.toggle && any.toggle.rect.x + any.toggle.rect.width / 2 < vpWidth / 2;
	const label = any?.toggle?.label?.trim();
	return {
		layout: /centered/i.test(format) || toggleLeft ? "centered" : "logo-left",
		inlineNav: !desktop?.found,
		togglePosition: toggleLeft ? "left" : "right",
		...(label && label.length <= 12 && !/^(menu toggle|toggle|open menu|navigation)$/i.test(label) ? { toggleLabel: label } : {}),
	};
}

/**
 * Header height and logo size from the captured header. When the tablet capture equals the mobile one,
 * the source switches at its header breakpoint (Salient and most themes do), so the tokens step there
 * instead of scaling fluidly. Appended to tokens.css.
 */
export function headerTokens(headers: HeaderCapture[], breakpoint = 1050): string {
	const d = headers.find((h) => h.viewport === "desktop") ?? headers[0];
	const m = headers.find((h) => h.viewport === "mobile");
	const t = headers.find((h) => h.viewport === "tablet");
	if (!d) return "";
	// The header element's computed colour is not the colour of its links (Salient sets it per link), so a
	// header that swaps to a light logo over the hero gets white text; otherwise the captured colour.
	const color = d.top.logoSrc && d.scrolled.logoSrc && d.top.logoSrc !== d.scrolled.logoSrc ? "#ffffff" : toHex(d.top.color);
	const colorLine = color ? `\n\t--header-color-top: ${color};` : "";
	const stepped = m && t && t.top.height === m.top.height && (t.top.logoHeight ?? 0) === (m.top.logoHeight ?? 0);
	if (m && stepped) {
		return `:root {\n\t--header-h: ${m.top.height}px;\n\t--logo-h: ${m.top.logoHeight ?? 56}px;${colorLine}\n}\n@media (min-width: ${breakpoint + 1}px) {\n\t:root { --header-h: ${d.top.height}px; --logo-h: ${d.top.logoHeight ?? 56}px; }\n}\n`;
	}
	return `:root {\n\t--header-h: ${m ? fluid(m.top.height, d.top.height) : `${d.top.height}px`};\n\t--logo-h: ${m?.top.logoHeight && d.top.logoHeight ? fluid(m.top.logoHeight, d.top.logoHeight) : "56px"};${colorLine}\n}\n`;
}

/**
 * Where multi-column layouts stack, from the source theme's own CSS breakpoints (design capture):
 * Salient/WPBakery stack below 1000px, many themes at 1024 or 768. Fallback 900.
 */
export function stackBreakpoint(designs: DesignCapture[]): number {
	const bps = new Set(designs.flatMap((d) => (d as DesignCapture & { breakpoints?: number[] }).breakpoints ?? []));
	if (bps.has(999) || bps.has(1000)) return 1000;
	if (bps.has(1023) || bps.has(1024)) return 1024;
	if (bps.has(767) || bps.has(768)) return 768;
	return 900;
}

/** Rewrite the starter's marked layout queries to the site's stacking breakpoint. */
export function applyStackBreakpoint(css: string, bp: number): string {
	return css.replaceAll("(min-width: 900px) /* stack */", `(min-width: ${bp}px)`).replaceAll("(max-width: 899.98px) /* stack-below */", `(max-width: ${bp - 0.02}px)`);
}
