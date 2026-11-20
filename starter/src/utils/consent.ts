/**
 * The page's consent banner settings (Privacy & consent, @wp2emdash/consent): one D1 row read by primary key, or —
 * before an admin saved — what was carried over (site.config.json `consent.defaults`). Absent `consent` in
 * site.config.json (kit.config `consent: false`) = no banner, the site behaves as before.
 *
 * Cache safety: the result depends on the site's settings only, never on the visitor — every visitor gets the same
 * cached HTML. The visitor's choice lives in their browser (public/scripts/site-consent.js), and the visitor's region
 * (mode "auto") is asked by that script from /_consent/region (regionResponse below), which is never cached.
 *
 * Read at most once per request (Consent and Analytics share the promise on `locals`), and only on a route-cache miss;
 * saving the settings purges the cached pages.
 */
import { env } from "cloudflare:workers";
import { type ConsentDefaults, defaultSettings, needsConsent, REGION_PATH, type RuntimeConsent, runtimeConsent, servicesOf } from "@wp2emdash/consent/settings";
import { LOG_PATH, readStoredConsent } from "@wp2emdash/consent/store";
import { REGION_HEADERS, regionAnswer } from "@wp2emdash/consent/region";
import { type D1Like, readStoredAnalytics } from "@wp2emdash/seo/analytics/store";
import { type LegacyAnalytics, runtimeConfig, seedTrackers } from "@wp2emdash/seo/analytics/trackers";
import site from "../site.config.json";
import { PROVIDER_BY_ID } from "./providers";
import { siteWidgets } from "./widgets";

const KEY = Symbol.for("wp2emdash.consent");
const cfg = site as { consent?: { defaults?: ConsentDefaults }; analytics?: LegacyAnalytics; analyticsAdmin?: boolean };

export interface PageConsent {
	/** The JSON for <meta name="site-consent">; undefined = no banner (off, or nothing that needs consent). */
	runtime?: RuntimeConsent;
	/** Something on the site needs consent (else the banner stays hidden even when on). */
	needed: boolean;
}

async function load(): Promise<PageConsent> {
	if (!cfg.consent) return { needed: false };
	const db = (env as { DB?: D1Like }).DB;
	const defaults = cfg.consent.defaults ?? {};
	// undefined: never saved → the carried-over defaults; null: unreadable → the defaults too (a banner that asks is
	// the safe side while the trackers' own settings may still load).
	const settings = (await readStoredConsent(db, defaults)) ?? defaultSettings(defaults);
	// The services the site is set up with — not only the ones this host loads (analytics run on the production domain
	// only), so the banner can be previewed anywhere.
	const stored = cfg.analyticsAdmin ? await readStoredAnalytics(db) : undefined;
	const rc = stored ? runtimeConfig(stored.trackers) : stored === null ? undefined : runtimeConfig(seedTrackers(cfg.analytics));
	const widgets = siteWidgets().map((w) => ({ name: PROVIDER_BY_ID[w.provider]?.name ?? w.provider, category: PROVIDER_BY_ID[w.provider]?.category ?? "" }));
	const services = servicesOf(rc, widgets);
	const runtime = runtimeConsent(settings, services, { logUrl: LOG_PATH });
	const needed = needsConsent(services);
	// Nothing to ask about (no tracker or widget that stores data): no banner, no script.
	return { ...(runtime && needed ? { runtime } : {}), needed };
}

/** The banner for this request: never for signed-in editors (their pages are never cached, and they are never tracked). */
export function pageConsent(locals: object, editor: boolean): Promise<PageConsent> {
	if (editor) return Promise.resolve({ needed: false });
	const l = locals as Record<symbol, Promise<PageConsent> | undefined>;
	l[KEY] ??= load();
	return l[KEY];
}

/** /_consent/region: the opt-in rule for the visitor asking (Cloudflare geolocation), never cached. */
export function regionResponse(request: Request): Response {
	return new Response(JSON.stringify(regionAnswer(request as Request & { cf?: unknown })), { headers: REGION_HEADERS });
}

export { REGION_PATH };
