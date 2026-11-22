/**
 * @wp2emdash/health — Site health and the monthly report for EmDash on Cloudflare Workers (experimental, 0.x).
 *
 * Scheduled checks (EmDash plugin cron, driven by the Worker's `*\/5 * * * *` trigger): uptime of the home page and a
 * rotating sample of sitemap pages, indexability, the form outbox, broken links, mail DNS against the go-live baseline,
 * the edge certificate (optional token), speed (render time + Chrome UX Report field data, optional key) and the
 * analytics tags. A "Site health" admin page and dashboard widget (admins only), email alerts (one per issue per day),
 * and a branded monthly report emailed on the 1st and kept for 12 months.
 *
 * This entry is safe to import from astro.config (Node): it only builds the plugin descriptor. The Worker-side module
 * is `@wp2emdash/health/plugin`. See README.md.
 */
import type { LegacyAnalytics } from "@wp2emdash/seo/analytics/trackers";
import type { MailBaseline } from "./checks/dns.js";
import { HEALTH_PLUGIN } from "./meta.js";

export { HEALTH_PLUGIN };
export type { MailBaseline };

export interface HealthBrand {
	/** Absolute URL of a raster logo (PNG/JPEG/WebP) for emails; SVG logos are left out (mail apps do not show them). */
	logo?: string;
	colors?: { bg?: string; text?: string; accent?: string };
	/** Footer line of reports and alerts, e.g. "Prepared by <your agency>". */
	footer: string;
}

export interface HealthOptions {
	/** The production address, e.g. "https://example.com". Every check targets this host (through the Worker itself). */
	productionUrl: string;
	siteName: string;
	/**
	 * The production domain serves this site (after go-live). Before that the checks run (the page works) but no alert
	 * or report is emailed: the domain still shows the old site to visitors.
	 */
	live: boolean;
	/** Default alert recipients (kit.config health.alertsTo → email.stagingTo). Admins can change them on the page. */
	alertsTo: string[];
	/** Default monthly-report recipients (kit.config health.reportTo → email.to); the agency (alertsTo) gets a copy. */
	reportTo: string[];
	brand: HealthBrand;
	/** Monthly report on by default; admins can switch it off. */
	monthlyReport?: boolean;
	/** Weekly sampled check of links to other sites (HEAD only, links the site itself publishes). Default on. */
	externalLinks?: boolean;
	/** Collections whose content changes the report counts (default ["pages"]). */
	collections?: string[];
	/**
	 * Page cache refill (kit.config performance.rewarmMinutes; the Worker's cron does it, src/cache.ts): the default
	 * interval and whether it can run here (the route cache is on and the site is live on its own domain).
	 */
	rewarm?: { everyMinutes: number; available: boolean };
	/**
	 * Page preloading (kit.config performance.prefetch, default on; starter/src/utils/prefetch.ts): links a visitor
	 * points at start loading before the click. Shown as a status line on the Speed tab. false: the kit turned it off.
	 */
	prefetch?: boolean;
	/** The site keeps a form outbox (Workers KV FORM_OUTBOX, @wp2emdash/forms). */
	formsOutbox?: boolean;
	/**
	 * Analytics the pages should carry: managed in SEO & Analytics (`admin`: read from its stored settings) or exactly
	 * what was carried over (`seed`). Absent: the site carries no analytics (kit.config analytics: false).
	 */
	analytics?: { admin: boolean; seed?: LegacyAnalytics; zoneBeacon?: boolean };
	/** Cloudflare Web Analytics for the report's visits (same values as the SEO suite; env vars override). */
	visits?: { accountId?: string; siteTag?: string };
	/** SEO suite on: the report includes the average SEO score of published pages. */
	seo?: { titleSeparator?: string; ogCards?: boolean };
	/** The site runs @wp2emdash/backups: the Backups check reads its heartbeat (time of the last backup). */
	backups?: boolean;
	/** The site runs @wp2emdash/media: the Media check reads its scan counts (alt text, oversized, broken). */
	media?: boolean;
	/**
	 * The public CSP names the violation-report endpoint (kit.config health.cspReports, default on; baked into
	 * site.config.json `cspReport` at scaffold). The admin switch on the Security tab only stops storing and alerts.
	 */
	cspReports?: boolean;
	/**
	 * Weekly visual check (checks/visual.ts): how many main pages (the home page + the sitemap's shallowest pages) get a
	 * structural fingerprint compared with a baseline. Default 10, at most 25; 0 turns the visual check off.
	 */
	visualPages?: number;
	/**
	 * Weekly accessibility rules on the pages the visual check reads (checks/a11y.ts; Site health → Accessibility and
	 * "What to improve"). Default on; false turns them off. Needs the visual check (visualPages > 0).
	 */
	accessibility?: boolean;
	/**
	 * Weekly content freshness (checks/freshness.ts): past event dates and ended year-bound phrases on pages, and pages
	 * not saved for `staleMonths`. Default on; false turns it off. Needs the visual check (visualPages > 0).
	 */
	freshness?: boolean;
	/** A page not saved in the editor for this many months is "not updated" (default 18; 0 = never). Posts and legal pages never count. */
	staleMonths?: number;
	/** Mail DNS records at go-live (cutover/dns-before.json), as hashes: never the record values. */
	mail?: MailBaseline;
}

/** The EmDash plugin descriptor for `emdash({ plugins: [healthPlugin({...})] })`: adds Plugins → Site health and a dashboard widget. */
export function healthPlugin(options: HealthOptions) {
	return { ...HEALTH_PLUGIN, format: "native" as const, displayName: "Site health", description: "Uptime, indexability, forms, links, mail DNS, speed and analytics checks; alerts and the monthly report", entrypoint: "@wp2emdash/health/plugin", options };
}
