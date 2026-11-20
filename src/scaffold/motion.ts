/**
 * Motion (@wp2emdash/motion, the panel on by default; the motion itself off until an admin turns it on): the plugin
 * options scaffold writes into astro.config, and the editor guide's Motion section.
 */
import type { MotionOptions } from "../../packages/motion/src/index.js";
import type { KitConfig } from "../config/schema.js";

export interface MotionInputs {
	config: Pick<KitConfig, "name"> & Partial<Pick<KitConfig, "motionPanel">>;
	productionUrl: string;
	/** The entrance the migration chose (site.config.json `motion`). */
	siteEntrance: "calm" | "standard";
}

export function motionOptions(i: MotionInputs): MotionOptions | undefined {
	if (i.config.motionPanel === false) return undefined;
	return { productionUrl: i.productionUrl, siteName: i.config.name, siteEntrance: i.siteEntrance };
}

/** The editor guide's Motion section (client docs). */
export const motionGuide = (m: { siteEntrance: "calm" | "standard" } | undefined) =>
	m
		? `
## Motion

**Plugins → Motion** (administrators only) switches motion on the public site on and off. Everything new is **off**
until you turn it on, because the fastest page is one with nothing extra to load:

- **First-visit preloader**: the site's logo on a plain background while the first page of a visit loads. At most
  once per visit, never longer than 1.2 seconds, never shown to search engines. Choose the background colour and a
  minimum time (0–800 ms).
- **Page transitions**: a short fade (or fade and slide up) between pages, in Chrome, Edge and Safari 18.2+; other
  browsers change pages as before. Choose the duration.
- **Element entrance animations**: sections rising into view as visitors scroll — *as the site was built*
  (${m.siteEntrance === "calm" ? "calm" : "standard"} on this site), *off*, *calm* or *standard*.
- **Extras**: hover lift on cards and buttons, smooth scrolling for links to a part of the page, images fading in as
  they load, the old site's parallax pictures and drifting columns (on as built; switch off to keep them still), and a
  thin scroll progress bar at the top.

The page shows how many kilobytes the switched-on options add. **Preview only** gives you a link that shows the site
with your unsaved choices (only you see it); **Save** publishes them, and visitors see the change within seconds on
their next page. Visitors whose device asks for reduced motion never see any of it.

For developers: settings in the site's database (\`plugin:motion:settings\`, read by \`src/utils/motion.ts\` with the
page chrome); the files \`public/styles/site-motion.css\` and \`public/scripts/site-motion.js\` load only when an option
needs them; with everything off the pages are unchanged. Saving purges the cached pages.
`
		: "";
