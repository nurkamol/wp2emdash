/**
 * Motion settings: which motion the public site uses — first-visit preloader, page transitions, element entrances and
 * a few extras — as validated plain data (enums, booleans, bounded numbers), never markup or code.
 *
 * Everything is off by default (speed first). Two settings default to "as the site was built" instead of off, because
 * existing sites already have them and must not change when the panel ships: element entrances (kit.config `motion`,
 * calm or the starter's standard reveal) and the old site's parallax / drifting columns.
 *
 * The page renders the settings as data attributes and classes on <html>, plus at most one external stylesheet
 * (public/styles/site-motion.css) and one external script (public/scripts/site-motion.js), each only when something
 * that needs it is on. With the defaults, `pageMotion` returns nothing to add: the page is byte-identical to a site
 * without the panel.
 *
 * Pure module (no EmDash, no Workers APIs): used by the plugin, the starter (Base layout), the kit's scaffold and tests.
 */

export const PRELOADERS = ["off", "logo"] as const;
export type Preloader = (typeof PRELOADERS)[number];
/** Preloader background, from the site's colour tokens (tokens.css). */
export const PRELOADER_BGS = ["bg", "surface", "text", "accent"] as const;
export type PreloaderBg = (typeof PRELOADER_BGS)[number];
export const PRELOADER_BG_LABEL: Record<PreloaderBg, string> = { bg: "Page background", surface: "Surface (cards)", text: "Text colour (dark)", accent: "Accent colour" };
/** The preloader never stays longer than this (CSS animation and script, both). */
export const PRELOADER_CAP_MS = 1200;
export const PRELOADER_MIN_MAX = 800;

export const TRANSITIONS = ["off", "fade", "slide-up"] as const;
export type Transition = (typeof TRANSITIONS)[number];
export const TRANSITION_LABEL: Record<Transition, string> = { off: "Off", fade: "Fade", "slide-up": "Fade and slide up" };
export const TRANSITION_MS = [150, 250, 400, 600] as const;
export type TransitionMs = (typeof TRANSITION_MS)[number];

/** "site": as the migration built it (kit.config `motion`: calm, else the starter's standard reveal). */
export const ENTRANCES = ["site", "off", "calm", "standard"] as const;
export type Entrance = (typeof ENTRANCES)[number];
export type SiteEntrance = "calm" | "standard";

export interface MotionSettings {
	version: 1;
	preloader: Preloader;
	preloaderBg: PreloaderBg;
	/** Shortest time the preloader shows (ms, 0–800, steps of 50). */
	preloaderMinMs: number;
	transition: Transition;
	transitionMs: TransitionMs;
	entrance: Entrance;
	/** Cards and buttons rise slightly on hover (mouse only). */
	hoverLift: boolean;
	/** Anchor links ("#contact") scroll smoothly. */
	smoothScroll: boolean;
	/** Lazy images fade in once loaded. */
	imageFade: boolean;
	/** Parallax pictures and drifting columns carried from the old site (data-parallax / data-drift). */
	parallax: boolean;
	/** Thin reading-progress bar along the top. */
	progress: boolean;
	updatedAt: string;
	updatedBy?: string;
}

export function defaultSettings(at = "1970-01-01T00:00:00.000Z"): MotionSettings {
	return { version: 1, preloader: "off", preloaderBg: "bg", preloaderMinMs: 0, transition: "off", transitionMs: 250, entrance: "site", hoverLift: false, smoothScroll: false, imageFade: false, parallax: true, progress: false, updatedAt: at };
}

const oneOf = <T extends string>(list: readonly T[], v: unknown, fallback: T): T => (typeof v === "string" && (list as readonly string[]).includes(v) ? (v as T) : fallback);
/** Whole milliseconds 0–800 in steps of 50 (anything else falls back). */
export function minMs(v: unknown, fallback = 0): number {
	const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
	return typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= PRELOADER_MIN_MAX ? Math.round(n / 50) * 50 : fallback;
}
const transitionMs = (v: unknown, fallback: TransitionMs): TransitionMs => {
	const n = typeof v === "string" ? Number(v) : v;
	return (TRANSITION_MS as readonly unknown[]).includes(n) ? (n as TransitionMs) : fallback;
};
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f\\u2028\\u2029]", "g");

/** A stored value read back: every field checked, anything damaged falls back to its default (never trusted as is). */
export function parseSettings(v: unknown): MotionSettings | undefined {
	if (!v || typeof v !== "object") return undefined;
	const o = v as Record<string, unknown>;
	if (o.version !== 1) return undefined;
	const d = defaultSettings();
	return {
		version: 1,
		preloader: oneOf(PRELOADERS, o.preloader, d.preloader),
		preloaderBg: oneOf(PRELOADER_BGS, o.preloaderBg, d.preloaderBg),
		preloaderMinMs: minMs(o.preloaderMinMs, d.preloaderMinMs),
		transition: oneOf(TRANSITIONS, o.transition, d.transition),
		transitionMs: transitionMs(o.transitionMs, d.transitionMs),
		entrance: oneOf(ENTRANCES, o.entrance, d.entrance),
		hoverLift: o.hoverLift === true,
		smoothScroll: o.smoothScroll === true,
		imageFade: o.imageFade === true,
		parallax: o.parallax !== false,
		progress: o.progress === true,
		updatedAt: typeof o.updatedAt === "string" ? o.updatedAt.slice(0, 40) : "",
		...(typeof o.updatedBy === "string" ? { updatedBy: o.updatedBy.replace(CONTROL, " ").trim().slice(0, 80) } : {}),
	};
}

export type FormResult = { ok: true; settings: MotionSettings } | { ok: false; errors: string[] };

/**
 * The admin form → new settings. Strict: an unknown choice or a duration out of range is an error (nothing is changed
 * silently). Fields the form did not send keep their current value (EmDash's form sends only fields with a value).
 */
export function settingsFromForm(current: MotionSettings, values: Record<string, unknown>): FormResult {
	const errors: string[] = [];
	const pick = <T extends string>(key: string, list: readonly T[], cur: T, label: string): T => {
		const v = values[key];
		if (v === undefined) return cur;
		if (typeof v !== "string" || !(list as readonly string[]).includes(v)) {
			errors.push(`Choose a ${label}.`);
			return cur;
		}
		return v as T;
	};
	const flag = (key: string, cur: boolean) => (values[key] === undefined ? cur : values[key] === true);
	const preloader = pick("preloader", PRELOADERS, current.preloader, "preloader");
	const preloaderBg = pick("preloaderBg", PRELOADER_BGS, current.preloaderBg, "preloader background");
	let preloaderMinMs = current.preloaderMinMs;
	if (values.preloaderMinMs !== undefined && values.preloaderMinMs !== null && values.preloaderMinMs !== "") {
		const n = typeof values.preloaderMinMs === "string" ? Number(values.preloaderMinMs) : values.preloaderMinMs;
		if (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > PRELOADER_MIN_MAX) errors.push(`Preloader minimum: 0 to ${PRELOADER_MIN_MAX} ms.`);
		else preloaderMinMs = Math.round(n / 50) * 50;
	}
	const transition = pick("transition", TRANSITIONS, current.transition, "page transition");
	let ms = current.transitionMs;
	if (values.transitionMs !== undefined) {
		const t = transitionMs(values.transitionMs, 0 as TransitionMs);
		if (!t) errors.push("Choose a transition duration.");
		else ms = t;
	}
	const entrance = pick("entrance", ENTRANCES, current.entrance, "entrance animation");
	if (errors.length) return { ok: false, errors };
	return {
		ok: true,
		settings: { ...current, preloader, preloaderBg, preloaderMinMs, transition, transitionMs: ms, entrance, hoverLift: flag("hoverLift", current.hoverLift), smoothScroll: flag("smoothScroll", current.smoothScroll), imageFade: flag("imageFade", current.imageFade), parallax: flag("parallax", current.parallax), progress: flag("progress", current.progress) },
	};
}

// ── Preview link (?motion-preview=…): the settings in a short, strictly parsed code ─────────────────────────────

export const PREVIEW_PARAM = "motion-preview";

/** "pl-logo.bg-accent.min-300.tr-fade.ms-250.en-calm.hv-1.sm-0.im-1.px-1.pg-0" */
export function encodePreview(s: MotionSettings): string {
	return [`pl-${s.preloader}`, `bg-${s.preloaderBg}`, `min-${s.preloaderMinMs}`, `tr-${s.transition}`, `ms-${s.transitionMs}`, `en-${s.entrance}`, `hv-${+s.hoverLift}`, `sm-${+s.smoothScroll}`, `im-${+s.imageFade}`, `px-${+s.parallax}`, `pg-${+s.progress}`].join(".");
}

/** The preview code back to settings; anything unknown or malformed → undefined (the saved settings show instead). */
export function decodePreview(code: string | null | undefined): MotionSettings | undefined {
	if (!code || code.length > 200 || !/^[a-z0-9.-]+$/.test(code)) return undefined;
	const m = new Map<string, string>();
	for (const part of code.split(".")) {
		const i = part.indexOf("-");
		if (i < 1) return undefined;
		m.set(part.slice(0, i), part.slice(i + 1));
	}
	const bit = (k: string) => (m.get(k) === "1" ? true : m.get(k) === "0" ? false : undefined);
	const raw = { version: 1, preloader: m.get("pl"), preloaderBg: m.get("bg"), preloaderMinMs: Number(m.get("min")), transition: m.get("tr"), transitionMs: Number(m.get("ms")), entrance: m.get("en"), hoverLift: bit("hv"), smoothScroll: bit("sm"), imageFade: bit("im"), parallax: bit("px"), progress: bit("pg") };
	if (!(PRELOADERS as readonly unknown[]).includes(raw.preloader) || !(TRANSITIONS as readonly unknown[]).includes(raw.transition) || !(ENTRANCES as readonly unknown[]).includes(raw.entrance) || !(PRELOADER_BGS as readonly unknown[]).includes(raw.preloaderBg)) return undefined;
	if ([raw.hoverLift, raw.smoothScroll, raw.imageFade, raw.parallax, raw.progress].some((b) => b === undefined)) return undefined;
	if (minMs(raw.preloaderMinMs, -1) !== raw.preloaderMinMs || !(TRANSITION_MS as readonly number[]).includes(raw.transitionMs)) return undefined;
	return parseSettings(raw);
}

// ── What the page renders ─────────────────────────────────────────────────────────────────────────────────────

/** Public files (starter public/): one stylesheet, one script. */
export const MOTION_CSS = "/styles/site-motion.css";
export const MOTION_JS = "/scripts/site-motion.js";
/**
 * The cross-document View Transitions opt-in. It must be conditional (a navigation from or to a page without it runs
 * no transition) and the shared stylesheet also serves the other options, so the at-rule is the one thing written into
 * the page, as a <style> element — allowed by the public CSP (`style-src 'unsafe-inline'`; scripts stay files only).
 */
export const VIEW_TRANSITION_CSS = "@media (prefers-reduced-motion: no-preference){@view-transition{navigation:auto}}";
/** Sizes of the two files in bytes (before compression), checked against the files by the tests. */
export const MOTION_CSS_BYTES = 4807;
export const MOTION_JS_BYTES = 2571;

export interface PageMotion {
	/** Attributes for <html> (empty with the defaults). */
	attrs: Record<string, string>;
	/** html.motion-calm (the starter's calm entrance). */
	calm: boolean;
	/** Link the stylesheet. */
	css: boolean;
	/** Load the script: "sync" in <head> (the preloader decides before the first paint), "defer", or not at all. */
	js: false | "sync" | "defer";
	/** Write the View Transitions opt-in. */
	viewTransition: boolean;
	/** Render the preloader overlay with this logo variant ("onTop" = the light logo, on dark backgrounds). */
	preloader?: { logo: "default" | "onTop" };
}

export interface PageContext {
	/** What the migration built (site.config.json `motion: "calm"` → calm, else standard). */
	siteEntrance: SiteEntrance;
	/** The page has a logo (Settings → General, else the migrated one); without one there is no preloader. */
	hasLogo: boolean;
	/** The page has a light logo variant (used on the dark text/accent backgrounds). */
	hasLightLogo?: boolean;
	/** Rendering a preview (?motion-preview=… for a signed-in editor): the preloader ignores "once per session". */
	preview?: boolean;
}

/** Which parts need the stylesheet / the script (the speed note and the page use the same rule). */
export function needs(s: MotionSettings, hasLogo = true): { css: boolean; js: boolean; preloader: boolean } {
	const preloader = s.preloader === "logo" && hasLogo;
	return { preloader, css: preloader || s.transition !== "off" || s.hoverLift || s.smoothScroll || s.imageFade || s.progress, js: preloader || s.imageFade };
}

/** What the page adds for these settings; undefined settings (panel off, never saved, unreadable) = as built. */
export function pageMotion(stored: MotionSettings | undefined, ctx: PageContext): PageMotion {
	const s = stored ?? defaultSettings();
	const n = needs(s, ctx.hasLogo);
	const attrs: Record<string, string> = {};
	if (n.preloader) {
		attrs["data-motion-preloader"] = "logo";
		if (s.preloaderBg !== "bg") attrs["data-motion-preloader-bg"] = s.preloaderBg;
		if (s.preloaderMinMs) attrs["data-motion-preloader-min"] = String(s.preloaderMinMs);
	}
	if (s.transition !== "off") {
		attrs["data-motion-transition"] = s.transition;
		attrs["data-motion-transition-ms"] = String(s.transitionMs);
	}
	if (s.entrance === "off") attrs["data-motion-entrance"] = "off";
	if (s.hoverLift) attrs["data-motion-hover"] = "on";
	if (s.smoothScroll) attrs["data-motion-smooth"] = "on";
	if (s.imageFade) attrs["data-motion-images"] = "on";
	if (!s.parallax) attrs["data-motion-parallax"] = "off";
	if (s.progress) attrs["data-motion-progress"] = "on";
	if (ctx.preview && stored) attrs["data-motion-preview"] = "on";
	const entrance = s.entrance === "site" ? ctx.siteEntrance : s.entrance;
	return {
		attrs,
		calm: entrance === "calm",
		css: n.css,
		js: n.preloader ? "sync" : n.js ? "defer" : false,
		viewTransition: s.transition !== "off",
		...(n.preloader ? { preloader: { logo: (s.preloaderBg === "text" || s.preloaderBg === "accent") && ctx.hasLightLogo ? "onTop" : "default" } } : {}),
	};
}

/** Bytes of motion files a visitor downloads with these settings (before compression; cached after the first page). */
export function motionBytes(s: MotionSettings): { css: number; js: number; total: number } {
	const n = needs(s);
	const css = n.css ? MOTION_CSS_BYTES : 0;
	const js = n.js ? MOTION_JS_BYTES : 0;
	return { css, js, total: css + js };
}

export const kb = (bytes: number) => `${(Math.round((bytes / 1024) * 10) / 10).toFixed(1)} KB`;

/** "Speed: 0 KB of motion files — nothing extra loads." / "Speed: 5.5 KB of motion files (stylesheet 3.7 KB + script 1.8 KB)…" */
export function speedNote(s: MotionSettings): string {
	const b = motionBytes(s);
	if (!b.total) return "Speed: 0 KB of motion files. Nothing extra loads with these settings.";
	const parts = [b.css ? `stylesheet ${kb(b.css)}` : "", b.js ? `script ${kb(b.js)}` : ""].filter(Boolean).join(" + ");
	return `Speed: ${kb(b.total)} of motion files (${parts}, before compression), downloaded once and then cached by the browser.${s.preloader === "logo" ? " The preloader's script loads before the page shows (that is how it decides in time); it is small and never holds the page longer than 1.2 seconds." : ""}`;
}
