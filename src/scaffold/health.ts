/**
 * Site health (@wp2emdash/health, on by default): the plugin options scaffold writes into astro.config — recipients
 * (kit.config health.alertsTo → email.stagingTo, health.reportTo → email.to), branding (the og card colours from the
 * design tokens, the copied raster logo, health.brand as the footer), the analytics the pages should carry, Cloudflare
 * Web Analytics ids for the report's visits, and the mail-DNS baseline from the cutover preflight's snapshot
 * (cutover/dns-before.json) as hashes — never record values, never secrets.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type MailBaseline, mailBaseline } from "../../packages/health/src/checks/dns.js";
import type { HealthOptions } from "../../packages/health/src/index.js";
import type { LegacyAnalytics } from "../../packages/seo/src/analytics/trackers.js";
import type { KitConfig } from "../config/schema.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const valid = (list: string[]) => [...new Set(list.map((x) => x.trim()).filter((x) => EMAIL.test(x)))];

/** The mail-record baseline from cutover/dns-before.json, when the cutover preflight wrote one. */
export async function mailBaselineFrom(cutoverDir: string): Promise<MailBaseline | undefined> {
	const file = join(cutoverDir, "dns-before.json");
	if (!existsSync(file)) return undefined;
	try {
		const snap = JSON.parse(readFileSync(file, "utf8")) as { zone?: string; at?: string; keep?: { type: string; name: string; content: string; priority?: number }[] };
		if (!snap.zone || !Array.isArray(snap.keep)) return undefined;
		return await mailBaseline(snap.zone, snap.keep, snap.at ?? new Date().toISOString());
	} catch {
		return undefined;
	}
}

export interface HealthInputs {
	config: Pick<KitConfig, "name" | "email" | "health" | "analytics" | "forms"> & Partial<Pick<KitConfig, "backups" | "media" | "performance">>;
	productionUrl: string;
	live: boolean;
	/** Site path of the copied logo (public/brand/…). */
	logo?: string;
	colors?: { bg?: string; text?: string; accent?: string };
	/** SEO suite on: analytics are managed there, and the report includes its score. */
	seo?: { titleSeparator?: string; ogCards?: boolean };
	analyticsSeed?: LegacyAnalytics;
	zoneBeacon?: boolean;
	visits?: { accountId?: string; siteTag?: string };
	mail?: MailBaseline;
}

export function healthOptions(i: HealthInputs): HealthOptions | undefined {
	const h = i.config.health;
	if (h === false) return undefined;
	const origin = new URL(i.productionUrl).origin;
	// Mail apps show neither SVG nor relative addresses: an absolute raster logo, else the site name as text.
	const logo = i.logo && /\.(?:png|jpe?g|webp|gif)$/i.test(i.logo) && i.logo.startsWith("/") ? `${origin}${i.logo}` : undefined;
	const alertsTo = valid(h.alertsTo ?? i.config.email.stagingTo);
	const reportTo = valid(h.reportTo ?? i.config.email.to);
	return {
		productionUrl: i.productionUrl,
		siteName: i.config.name,
		live: i.live,
		alertsTo,
		reportTo,
		brand: { footer: h.brand, ...(logo ? { logo } : {}), ...(i.colors ? { colors: i.colors } : {}) },
		...(h.monthlyReport ? {} : { monthlyReport: false }),
		...(h.externalLinks ? {} : { externalLinks: false }),
		collections: ["pages"],
		...(i.config.performance?.routeCache && i.config.performance.rewarmMinutes > 0 ? { rewarm: { everyMinutes: i.config.performance.rewarmMinutes, available: i.live } } : {}),
		...(i.config.forms.outbox ? { formsOutbox: true } : {}),
		...(i.config.analytics !== false ? { analytics: { admin: !!i.seo, ...(i.analyticsSeed ? { seed: i.analyticsSeed } : {}), ...(i.zoneBeacon ? { zoneBeacon: true } : {}) } } : {}),
		...(i.visits && (i.visits.accountId || i.visits.siteTag) ? { visits: i.visits } : {}),
		...(i.seo ? { seo: i.seo } : {}),
		...(i.mail ? { mail: i.mail } : {}),
		...(i.config.backups !== undefined && i.config.backups !== false ? { backups: true } : {}),
		...(i.config.media !== undefined && i.config.media !== false ? { media: true } : {}),
	};
}
