/**
 * @wp2emdash/motion — Motion for EmDash on Cloudflare Workers (experimental, 0.x).
 *
 * An admin page, Plugins → Motion (admins only), where the site owner switches on and tunes motion on the public site:
 * a first-visit logo preloader, page transitions (cross-document View Transitions), element entrances (the starter's
 * calm or standard reveal), hover lift, smooth anchor scrolling, image fade-in, the old site's parallax, and a scroll
 * progress bar. Everything new is off by default; prefers-reduced-motion is always respected. Saving purges the cached
 * pages.
 *
 * This entry is safe to import from astro.config (Node): it only builds the plugin descriptor. The Worker-side module
 * is `@wp2emdash/motion/plugin`. See README.md.
 */
import { MOTION_PLUGIN } from "./meta.js";
import type { SiteEntrance } from "./settings.js";

export { MOTION_PLUGIN };

export interface MotionOptions {
	productionUrl: string;
	siteName: string;
	/** The entrance animation the migration chose (kit.config `motion`): what "As the site was built" means. */
	siteEntrance: SiteEntrance;
}

/** The EmDash plugin descriptor for `emdash({ plugins: [motionPlugin({...})] })`: adds Plugins → Motion. */
export function motionPlugin(options: MotionOptions) {
	return { ...MOTION_PLUGIN, format: "native" as const, displayName: "Motion", description: "Preloader, page transitions, entrance animations and other motion on the public site", entrypoint: "@wp2emdash/motion/plugin", options };
}
