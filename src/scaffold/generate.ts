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

// ── Design → tokens ──────────────────────────────────────────────────────────
interface TypographyEntry {
	fontFamily: string;
	fontSize: string;
	fontWeight: string;
	lineHeight: string;
	letterSpacing: string;
	color: string;
}
export interface DesignCapture {
	viewport: string;
	fonts: { family: string; count: number }[];
	colors: { value: string; count: number; usage: "text" | "background" | "border" }[];
	typography: Record<string, TypographyEntry | undefined>;
	buttons: { text: string; styles: Record<string, string> }[];
	containerWidths: { width: number; count: number }[];
	header: { height: number; background: string } | null;
	footer: { height: number; background: string; color: string } | null;
	logo?: { src: string; width: number; height: number };
	favicon?: string;
	cssVariables: Record<string, string>;
	pageBackground?: string;
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
	fonts: { body: string; display: string; googleHref?: string };
	colors: { bg: string; text: string; accent: string; accentContrast: string; surface: string };
}

export function buildTokens(designs: DesignCapture[]): Tokens {
	const desktop = designs.find((d) => d.viewport === "desktop") ?? designs.at(-1);
	const mobile = designs.find((d) => d.viewport === "mobile") ?? designs[0];
	if (!desktop || !mobile) throw new Error("No design capture: run the audit first");
	const t = desktop.typography;
	const tm = mobile.typography;
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
	const radius = btn?.styles.borderRadius ?? "6px";
	const weights = [...new Set([400, 500, 600, 700, Number(t.h1?.fontWeight) || 400])].sort();
	const isGeneric = (f: string) => /^(system-ui|sans-serif|serif|monospace|-apple-system|arial|helvetica|georgia|times)/i.test(f);
	const families = [...new Set([bodyFont, displayFont])].filter((f) => !isGeneric(f));
	const googleHref = families.length ? `https://fonts.googleapis.com/css2?${families.map((f) => `family=${encodeURIComponent(f).replace(/%20/g, "+")}:ital,wght@${[0, 1].flatMap((i) => weights.map((w) => `${i},${w}`)).join(";")}`).join("&")}&display=swap` : undefined;
	const fontStack = (f: string, kind: "sans" | "serif") => `"${f}", ${kind === "serif" ? "Georgia, serif" : "system-ui, sans-serif"}`;
	const displayKind = /cormorant|playfair|serif|garamond|lora|merriweather|libre|dm serif|instrument/i.test(displayFont) ? "serif" : "sans";

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

	--container: ${container}px;
	--container-text: 46rem;
	--gutter: clamp(20px, 5vw, 64px);
	--space-compact: clamp(32px, 4vw, 56px);
	--space-normal: clamp(56px, 8vw, 120px);
	--space-spacious: clamp(80px, 12vw, 180px);

	--radius-button: ${radius};
	--radius-card: 12px;
	--radius-media: 8px;
	--radius-input: 8px;
	--btn-padding: 0.95em 2em;
	--btn-weight: ${btn?.styles.fontWeight ?? 500};

	--ease-out: cubic-bezier(0.2, 0.75, 0.5, 1);
	--header-bg: ${toHex(desktop.header?.background) && !/rgba/.test(toHex(desktop.header?.background) ?? "") ? toHex(desktop.header?.background) : bg};
	--footer-bg: ${toHex(desktop.footer?.background) ?? surface};
}
`;
	return { css, fonts: { body: bodyFont, display: displayFont, ...(googleHref ? { googleHref } : {}) }, colors: { bg, text, accent, accentContrast, surface } };
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
	fonts: { body: string; display: string; googleHref?: string };
	header: { panel: string; breakpoint: number; transparentOnTop: boolean; hideOnScroll: boolean; logo?: string; logoOnTop?: string; logoHeight: number };
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
			breakpoint: Number(m?.themeSettings?.headerBreakpoint) || 1050,
			transparentOnTop,
			hideOnScroll,
			...(brand.logo ? { logo: brand.logo } : {}),
			...(brand.logoOnTop ? { logoOnTop: brand.logoOnTop } : {}),
			logoHeight: Math.min(desktopHeader?.top.logoHeight ?? 56, 96),
		},
	};
}

/** Header height token from the captured header (desktop) — appended to tokens.css. */
export function headerTokens(headers: HeaderCapture[]): string {
	const d = headers.find((h) => h.viewport === "desktop") ?? headers[0];
	const m = headers.find((h) => h.viewport === "mobile");
	if (!d) return "";
	const color = toHex(d.top.color);
	return `:root {\n\t--header-h: ${m ? fluid(m.top.height, d.top.height) : `${d.top.height}px`};\n\t--logo-h: ${m?.top.logoHeight && d.top.logoHeight ? fluid(Math.min(m.top.logoHeight, 72), Math.min(d.top.logoHeight, 96)) : "56px"};${color ? `\n\t--header-color-top: ${color};` : ""}\n}\n`;
}
