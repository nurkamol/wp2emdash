/**
 * @wp2emdash/seo — the SEO & Analytics suite for EmDash (experimental, 0.x): an SEO panel in the page editor (Google
 * result and social previews, an on-page checklist with a score, focus keyword, the page's visits), the SEO & Analytics
 * dashboard (scores, images, site checks, Search Console, IndexNow), and Analytics: tracking codes managed by ID
 * (Google, Meta, Clarity, Hotjar, Cloudflare), conversion events and consent mode as switches, and Cloudflare Web
 * Analytics visits; sharing text per page and SEO of category/tag archives (carried from Yoast and Rank Math). Safe to import from astro.config: it only builds the plugin descriptor. Worker-side modules:
 * `/plugin` (EmDash loads it) and `/analytics/*` (the starter reads trackers, CSP hosts and events from them).
 */
import type { LegacyAnalytics } from "./analytics/trackers.js";
import { SEO_PLUGIN } from "./meta.js";
import type { ArchiveBase } from "./social.js";

export { SEO_PLUGIN };

export interface AnalyticsOptions {
	/** What was carried over from WordPress (site.config.json `analytics`): the list the admin page starts from. */
	seed?: LegacyAnalytics;
	/** Cloudflare account that holds the site's Web Analytics (Visits). CF_ANALYTICS_ACCOUNT_ID overrides it. */
	accountId?: string;
	/** Web Analytics site tag (found by scaffold with the build token); CF_ANALYTICS_SITE_TAG overrides it. */
	siteTag?: string;
	/** Cloudflare adds the beacon to the domain by itself (Web Analytics "automatic setup"). */
	zoneBeacon?: boolean;
	/** The kit's last browser check of the live site (verify `analytics-runtime`), dated. */
	lastCheck?: { at: string; ok: boolean; detail?: string };
	/** Ownership verification tags carried over (site.config.json `verification`): listed read-only; Google/Bing are edited in Settings → SEO. */
	verification?: Record<string, string>;
}

export interface SeoPanelOptions {
	/** The production address, e.g. "https://example.com" (the Google preview shows it, not staging). */
	productionUrl: string;
	/** Separator between page title and site name in <title>, as the layout builds it. */
	titleSeparator?: string;
	/** Collections that get the panel. */
	collections?: string[];
	/** Sharing cards (@wp2emdash/og) are on: a page without its own image still gets one. */
	ogCards?: boolean;
	/** IndexNow: the key whose file is at the domain root; `live` once the domain serves this site (after cutover). */
	indexNow?: { key: string; live: boolean };
	/** Analytics in the suite; absent when the site carries no analytics at all (kit.config `analytics: false`). */
	analytics?: AnalyticsOptions;
	/**
	 * Term archives the site serves (blog categories/tags, collection taxonomies): EmDash taxonomy name and archive base.
	 * The `page:metadata` hook finds an archive's term from its address; the Archives tab lists their terms.
	 */
	archives?: ArchiveBase[];
	/** Site language (BCP 47, e.g. "en-US"): the reading-level check runs only for English. Unset: guessed from each page's text. */
	lang?: string;
}

export function seoPlugin(options: SeoPanelOptions) {
	return { ...SEO_PLUGIN, format: "native" as const, displayName: "SEO & Analytics", description: "SEO panel, SEO & Analytics dashboard, tracking codes and visits", entrypoint: "@wp2emdash/seo/plugin", options };
}
