/**
 * /locations.kml — the business location file Rank Math's Local SEO module served on the WordPress site (owner
 * decision 2026-11-20: regenerate it rather than retire it). Built from the LocalBusiness data the kit carried over
 * (site.config.json → structuredData.business: name, address, phone, geo); 404 when the site has no coordinates.
 */
import type { APIRoute } from "astro";
import site from "../site.config.json";
import { type Business, locationsKml } from "../utils/kml";

export const prerender = false;

export const GET: APIRoute = () => {
	const s = site as { name?: string; productionUrl: string; structuredData?: { business?: Business } };
	const kml = s.structuredData?.business ? locationsKml(s.structuredData.business, new URL(s.productionUrl).origin, s.name ?? "") : undefined;
	if (!kml) return new Response("Not found", { status: 404 });
	return new Response(kml, { headers: { "content-type": "application/vnd.google-earth.kml+xml; charset=utf-8", "cache-control": "public, max-age=3600" } });
};
