/**
 * Motion on the public site (Plugins → Motion, @wp2emdash/motion): the saved settings — one D1 row read by primary key,
 * loaded with the chrome in the page frontmatter (utils/chrome.ts) — turned into what the layout adds: attributes and a
 * class on <html>, the motion stylesheet and script, the View Transitions opt-in and the preloader overlay.
 *
 * Absent `motionPanel` in site.config.json (kit.config `motionPanel: false`), never saved, or unreadable: nothing is
 * added and the page is exactly what the site rendered before the panel existed (kit.config `motion` still decides calm).
 *
 * Cache safety: the result depends on the site's settings only — every visitor gets the same cached HTML; saving purges
 * the cached pages. The one exception, `?motion-preview=…`, is honoured for signed-in editors only (whose pages are
 * never cached), and the middleware never caches a response to such a URL.
 */
import { env } from "cloudflare:workers";
import { decodePreview, type MotionSettings, type PageMotion, pageMotion, PREVIEW_PARAM } from "@wp2emdash/motion/settings";
import { type D1Like, readStoredMotion } from "@wp2emdash/motion/store";
import site from "../site.config.json";

export const motionPanelOn = (site as { motionPanel?: boolean }).motionPanel === true;

/** The saved settings for the chrome (undefined: panel off, never saved or unreadable — the site as built). */
export async function loadMotion(): Promise<{ settings?: MotionSettings }> {
	if (!motionPanelOn) return {};
	const settings = await readStoredMotion((env as { DB?: D1Like }).DB);
	return settings ? { settings } : {};
}

/** What the layout adds for this page. */
export function motionFor(saved: MotionSettings | undefined, o: { url: URL; editor: boolean; hasLogo: boolean; hasLightLogo: boolean }): PageMotion {
	const preview = motionPanelOn && o.editor ? decodePreview(o.url.searchParams.get(PREVIEW_PARAM)) : undefined;
	return pageMotion(preview ?? saved, { siteEntrance: (site as { motion?: string }).motion === "calm" ? "calm" : "standard", hasLogo: o.hasLogo, hasLightLogo: o.hasLightLogo, preview: !!preview });
}

export { PREVIEW_PARAM };
