/**
 * Content-Security-Policy sources per tracker type — the one table the starter's middleware and the kit's tests use.
 * The public policy allows a service's addresses only while a tracker of that type is switched on. No `*` beyond what a
 * provider documents as needed (Google's regional collection hosts, Clarity's load-balanced a–z subdomains).
 *
 * Sources (checked 2026-11-20, docs/spikes/analytics-findings.md):
 * - Google: developers.google.com/tag-platform/security/guides/csp (Google tag / GA4, Ads-ready set, Google Ads, GTM).
 *   `img-src` is not listed: the starter's policy already allows any https image (`img-src 'self' data: blob: https:`).
 *   Google also lists `https://*.google.<TLD>` (country domains) for Ads; country domains cannot be enumerated, so
 *   only `www.google.com` is allowed for connect — a country-domain beacon is blocked (rare; reported by verify's CSP check).
 * - Microsoft Clarity: learn.microsoft.com/clarity/setup-and-installation/clarity-csp (`https://*.clarity.ms`,
 *   `https://c.bing.com`).
 * - Meta Pixel: the snippet's own hosts (connect.facebook.net for fbevents.js and its config, www.facebook.com/tr for
 *   events); Meta publishes no CSP page.
 * - Cloudflare Web Analytics: static.cloudflareinsights.com (beacon) and cloudflareinsights.com (/cdn-cgi/rum).
 * - Hotjar: help.hotjar.com "Content Security Policies" (minimum script-src static.hotjar.com and script.hotjar.com;
 *   its inline snippet is not used here; connect `https://*.hotjar.com`, `https://*.hotjar.io`,
 *   `wss://*.hotjar.com` for connect; fonts and styles from `*.hotjar.com` for its widgets).
 * - Universal Analytics: retired, never loaded — no sources.
 */
import type { TrackerType } from "./trackers.js";

export interface CspHosts {
	script: string[];
	connect: string[];
	frame: string[];
	style?: string[];
	font?: string[];
}

const GA = { script: ["https://www.googletagmanager.com"], connect: ["https://www.googletagmanager.com", "https://*.googletagmanager.com", "https://*.google-analytics.com", "https://*.analytics.google.com", "https://www.google.com"], frame: ["https://www.googletagmanager.com"] };
const ADS_READY = ["https://*.g.doubleclick.net", "https://pagead2.googlesyndication.com"];

export const CSP_HOSTS: Record<TrackerType, CspHosts> = {
	ga4: GA,
	// GT- tags can carry Google Ads features: Google's "Ads-ready" set for the Google tag.
	"google-tag": { ...GA, connect: [...GA.connect, ...ADS_READY] },
	"google-ads": {
		script: ["https://www.googletagmanager.com", "https://www.googleadservices.com", "https://www.google.com"],
		connect: ["https://www.googletagmanager.com", "https://www.googleadservices.com", "https://googleads.g.doubleclick.net", "https://pagead2.googlesyndication.com", "https://www.google.com", "https://ad.doubleclick.net"],
		frame: ["https://www.googletagmanager.com"],
	},
	// A container almost always fires GA4; tags in it that load other vendors are blocked (add them here instead).
	gtm: GA,
	cloudflare: { script: ["https://static.cloudflareinsights.com"], connect: ["https://cloudflareinsights.com"], frame: [] },
	meta: { script: ["https://connect.facebook.net"], connect: ["https://www.facebook.com", "https://connect.facebook.net"], frame: [] },
	clarity: { script: ["https://*.clarity.ms"], connect: ["https://*.clarity.ms", "https://c.bing.com"], frame: [] },
	hotjar: { script: ["https://static.hotjar.com", "https://script.hotjar.com"], connect: ["https://*.hotjar.com", "https://*.hotjar.io", "wss://*.hotjar.com"], frame: ["https://*.hotjar.com"], style: ["https://*.hotjar.com"], font: ["https://*.hotjar.com"] },
	ua: { script: [], connect: [], frame: [] },
};

/**
 * Always allowed, whatever the list: when Web Analytics is switched on for the zone, Cloudflare injects its beacon into
 * every page by itself (no site setting), and a policy without it blocks the beacon (seen on a launched site).
 */
export const ALWAYS: TrackerType[] = ["cloudflare"];

/** The union of sources for the given types (plus ALWAYS), de-duplicated, in a stable order. */
export function cspSources(types: Iterable<TrackerType>): Required<CspHosts> {
	const all = [...ALWAYS, ...types];
	const pick = (k: keyof CspHosts) => [...new Set(all.flatMap((t) => CSP_HOSTS[t][k] ?? []))];
	return { script: pick("script"), connect: pick("connect"), frame: pick("frame"), style: pick("style"), font: pick("font") };
}
