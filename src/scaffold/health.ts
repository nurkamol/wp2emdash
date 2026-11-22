/**
 * Site health (@wp2emdash/health, on by default): the plugin options scaffold writes into astro.config — recipients
 * (kit.config health.alertsTo → email.stagingTo, health.reportTo → email.to), branding (the og card colours from the
 * design tokens, the copied raster logo, health.brand as the footer), the analytics the pages should carry, Cloudflare
 * Web Analytics ids for the report's visits, the mail-DNS baseline from the cutover preflight's snapshot
 * (cutover/dns-before.json) as hashes — never record values, never secrets — and the old WordPress addresses that did
 * not keep their path (`oldUrls`, for Missing pages' redirect suggestions). That list is the client's site structure:
 * it lives in the generated project's astro.config, never in the kit repo.
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

/** At most this many old addresses go into the plugin options (moved ones first). */
export const OLD_URLS_MAX = 2000;

const stripSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") || "/" : p);
const pathnameOf = (u: string): string | undefined => {
	try {
		return new URL(u).pathname;
	} catch {
		return undefined;
	}
};

/**
 * The old WordPress addresses of pages, posts and other entries that did not keep their path on the new site: old path
 * → the path it has now (`wpIds`, the migrated published routes), or "" when it was not carried over (a skipped type,
 * an excluded page). Addresses that kept their path are left out (they still answer). Sources: the audit's URL list
 * (snapshot/urls.json, answered 200, with a WordPress id) and REST discovery's items (snapshot/discovery.json).
 * Attachment pages, feeds and archives are the starter's WordPress-URL rules, not listed here. Pure.
 */
export function oldUrlMap(o: { urls?: { path: string; status?: number; wp?: { id: number; type?: string } }[]; items?: { id: number; type: string; link: string }[]; wpIds: Record<string, string>; max?: number }): Record<string, string> {
	const old = new Map<number, string>();
	for (const u of o.urls ?? []) if (u.wp?.id && (u.status === undefined || u.status === 200) && u.wp.type !== "attachment" && !old.has(u.wp.id)) old.set(u.wp.id, u.path);
	for (const i of o.items ?? []) {
		if (i.type === "attachment" || old.has(i.id)) continue;
		const p = pathnameOf(i.link);
		if (p) old.set(i.id, p);
	}
	const moved: [string, string][] = [];
	const removed: [string, string][] = [];
	for (const [id, path] of old) {
		if (!path.startsWith("/") || path.includes("?") || path === "/" || path.length > 300) continue;
		const now = o.wpIds[String(id)] ?? "";
		if (now && stripSlash(now) === stripSlash(path)) continue;
		(now ? moved : removed).push([path, now]);
	}
	const sort = (l: [string, string][]) => l.sort((a, b) => (a[0] < b[0] ? -1 : 1));
	return Object.fromEntries([...sort(moved), ...sort(removed)].slice(0, o.max ?? OLD_URLS_MAX));
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
	/** oldUrlMap(): old WordPress path → path now ("" = not carried over). */
	oldUrls?: Record<string, string>;
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
		...(h.cspReports === false ? { cspReports: false } : {}),
		...(h.visualPages !== undefined && h.visualPages !== 10 ? { visualPages: h.visualPages } : {}),
		...(h.accessibility === false ? { accessibility: false } : {}),
		...(h.freshness === false ? { freshness: false } : {}),
		...(h.staleMonths !== undefined && h.staleMonths !== 18 ? { staleMonths: h.staleMonths } : {}),
		collections: ["pages"],
		...(i.config.performance?.routeCache && i.config.performance.rewarmMinutes > 0 ? { rewarm: { everyMinutes: i.config.performance.rewarmMinutes, available: i.live } } : {}),
		...(i.config.performance?.prefetch === false ? { prefetch: false } : {}),
		...(i.config.forms.outbox ? { formsOutbox: true } : {}),
		...(i.config.analytics !== false ? { analytics: { admin: !!i.seo, ...(i.analyticsSeed ? { seed: i.analyticsSeed } : {}), ...(i.zoneBeacon ? { zoneBeacon: true } : {}) } } : {}),
		...(i.visits && (i.visits.accountId || i.visits.siteTag) ? { visits: i.visits } : {}),
		...(i.seo ? { seo: i.seo } : {}),
		...(i.mail ? { mail: i.mail } : {}),
		...(i.config.backups !== undefined && i.config.backups !== false ? { backups: true } : {}),
		...(i.config.media !== undefined && i.config.media !== false ? { media: true } : {}),
		...(i.oldUrls && Object.keys(i.oldUrls).length ? { oldUrls: i.oldUrls } : {}),
	};
}
