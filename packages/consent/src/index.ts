/**
 * @wp2emdash/consent — Privacy & Consent for EmDash on Cloudflare Workers (experimental, 0.x).
 *
 * A built-in cookie banner (starter: components/Consent.astro + public/scripts/site-consent.js) that the SEO &
 * Analytics loader and the site widgets obey, and a "Privacy & consent" admin page (admins only): mode (off / notice /
 * opt-in / by visitor region), wording, privacy policy link, category descriptions, which services fall in which
 * category, an optional consent log (counts per day only) and a preview. Saving purges the cached pages.
 *
 * This entry is safe to import from astro.config (Node): it only builds the plugin descriptor. The Worker-side module
 * is `@wp2emdash/consent/plugin`. See README.md.
 */
import type { LegacyAnalytics } from "@wp2emdash/seo/analytics/trackers";
import { CONSENT_PLUGIN } from "./meta.js";
import type { ConsentDefaults } from "./settings.js";

export { CONSENT_PLUGIN };
export type { ConsentDefaults };

export interface ConsentOptions {
	productionUrl: string;
	siteName: string;
	/** What the banner starts with before an admin saves (carried from the old site, kit.config `consent`). */
	defaults: ConsentDefaults;
	/** Consent services from the old site kept as site widgets (names): the built-in banner starts off. */
	keptTools?: string[];
	/** What the migration found on the old site (shown on the page). */
	oldSite?: string;
	/** Site widgets the pages load (name + registry category), for the category table. */
	widgets?: { name: string; category: string }[];
	/** Analytics the pages carry: managed in SEO & Analytics (`admin`: its stored settings) or exactly the seed. */
	analytics?: { admin: boolean; seed?: LegacyAnalytics; zoneBeacon?: boolean };
	/** The site's URL style, for policy links built from page slugs. */
	trailingSlash?: "always" | "never" | "ignore";
}

/** The EmDash plugin descriptor for `emdash({ plugins: [consentPlugin({...})] })`: adds Plugins → Privacy & consent. */
export function consentPlugin(options: ConsentOptions) {
	return { ...CONSENT_PLUGIN, format: "native" as const, displayName: "Privacy & consent", description: "Cookie banner, consent mode for analytics and ads, Global Privacy Control, consent log", entrypoint: "@wp2emdash/consent/plugin", options };
}
