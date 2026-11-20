/**
 * Site widgets: chat, reviews badge and consent tools that the WordPress site loaded on every page, carried over by
 * provider + ID only (kit.config `siteWidgets`, else what transform recognised in the live pages — ir/site-snippets.json).
 * Never free-form code: an entry whose provider is unknown or whose ID does not match the provider's format (the
 * provider registry, utils/providers.ts) is ignored. The middleware's CSP allows exactly these providers' hosts.
 */
import site from "../site.config.json";
import { type SiteWidget, validWidget } from "./providers";

const PRODUCTION_HOST = new URL((site as { productionUrl: string }).productionUrl).host;

/** The configured widgets that pass the registry's checks. */
export function siteWidgets(): SiteWidget[] {
	const list = (site as { siteWidgets?: unknown }).siteWidgets;
	return Array.isArray(list) ? list.filter((w): w is SiteWidget => !!w && typeof w === "object" && validWidget(w as SiteWidget)) : [];
}

/**
 * Widgets to load on this request: production domain only (chat, review and consent accounts are tied to the
 * domain), never for signed-in editors, never in `astro dev` — the same rule as analytics.
 */
export function pageWidgets(url: URL, editor: boolean): SiteWidget[] {
	if (import.meta.env.DEV || editor || url.host !== PRODUCTION_HOST) return [];
	return siteWidgets();
}
