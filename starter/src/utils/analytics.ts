/**
 * The page's analytics: the tracking codes, conversion events and consent mode from SEO & Analytics → Analytics
 * (@wp2emdash/seo; one D1 row read by primary key), or — before anyone opened that page, or with the suite off
 * (kit.config `seo: { panel: false }`) — exactly what was carried over from WordPress (site.config.json `analytics`).
 *
 * Read at most once per request (the Analytics component and the middleware's CSP share the promise on `locals`), and
 * only on a route-cache miss: a cached page carries the tags and the CSP header it was rendered with, and saving the
 * settings purges those pages (CACHE_TAG, set in utils/chrome.ts).
 */
import { env } from "cloudflare:workers";
import { type D1Like, readStoredAnalytics } from "@wp2emdash/seo/analytics/store";
import { hasTrackers, type LegacyAnalytics, type RuntimeConfig, runtimeConfig, seedTrackers } from "@wp2emdash/seo/analytics/trackers";
import site from "../site.config.json";

const KEY = Symbol.for("wp2emdash.analytics");
const NONE: RuntimeConfig = { google: [], gtm: [], meta: [] };
const cfg = site as { analytics?: LegacyAnalytics; analyticsAdmin?: boolean; productionUrl: string };
const PRODUCTION_HOST = new URL(cfg.productionUrl).host;

async function load(): Promise<RuntimeConfig> {
	const seed = seedTrackers(cfg.analytics);
	if (!cfg.analyticsAdmin) return runtimeConfig(seed);
	const stored = await readStoredAnalytics((env as { DB?: D1Like }).DB);
	// undefined: never saved → the carried-over IDs; null: unreadable → nothing (never resurrect a removed tracker).
	if (stored === undefined) return runtimeConfig(seed);
	if (stored === null) return NONE;
	return runtimeConfig(stored.trackers, { events: stored.events, consent: stored.consent, defer: stored.defer });
}

/** Trackers to load on this request: production domain only, never for editors, never in `astro dev`. */
export function pageAnalytics(locals: object, url: URL, editor: boolean): Promise<RuntimeConfig> {
	if (import.meta.env.DEV || editor || url.host !== PRODUCTION_HOST) return Promise.resolve(NONE);
	const l = locals as Record<symbol, Promise<RuntimeConfig> | undefined>;
	l[KEY] ??= load();
	return l[KEY];
}

export { hasTrackers };
