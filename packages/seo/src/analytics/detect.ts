/**
 * Trackers found in a page's raw HTML (the audit's snapshot of the WordPress site): Google IDs (G-, GT-, AW-, GTM-,
 * retired UA-), Meta Pixel (`fbq('init', …)`, the <noscript> pixel), Microsoft Clarity (tag URL or snippet), Hotjar
 * (`hjid`), and a Cloudflare Web Analytics beacon token (`data-cf-beacon`). Used by scaffold to prefill the admin list.
 */
import type { LegacyAnalytics } from "./trackers.js";

export interface Detected {
	google: string[];
	gtm: string[];
	ua: string[];
	meta: string[];
	clarity: string[];
	hotjar: string[];
	cloudflare: string[];
}

const all = (html: string, re: RegExp) => [...html.matchAll(re)].map((m) => m[1] as string);
const uniq = (a: string[]) => [...new Set(a)].sort();

export function detectTrackers(htmls: Iterable<string>): Detected {
	const d: Detected = { google: [], gtm: [], ua: [], meta: [], clarity: [], hotjar: [], cloudflare: [] };
	for (const raw of htmls) {
		const html = raw.replace(/&quot;|&#34;/g, '"').replace(/&#39;/g, "'");
		d.google.push(...all(html, /\b((?:GT|AW)-[A-Z0-9]{6,12}|G-[A-Z0-9]{8,12})\b/g).filter((id) => !id.startsWith("AW-") || /^AW-\d+$/.test(id)));
		d.gtm.push(...all(html, /\b(GTM-[A-Z0-9]{5,9})\b/g));
		d.ua.push(...all(html, /\b(UA-\d{4,10}-\d{1,4})\b/g));
		d.meta.push(...all(html, /fbq\(\s*['"]init['"]\s*,\s*['"](\d{12,20})['"]/g), ...all(html, /facebook\.com\/tr\/?\?id=(\d{12,20})\b/g));
		d.clarity.push(...all(html, /clarity\.ms\/tag\/([a-z0-9]{8,12})\b/g), ...all(html, /["']clarity["']\s*,\s*["']script["']\s*,\s*["']([a-z0-9]{8,12})["']/g));
		d.hotjar.push(...all(html, /\bhjid\s*:\s*(\d{5,10})\b/g));
		d.cloudflare.push(...all(html, /data-cf-beacon=['"]\{[^}]*"token"\s*:\s*"([a-f0-9]{32})"/g));
	}
	return { google: uniq(d.google), gtm: uniq(d.gtm), ua: uniq(d.ua), meta: uniq(d.meta), clarity: uniq(d.clarity), hotjar: uniq(d.hotjar), cloudflare: uniq(d.cloudflare) };
}

/**
 * The carried-over list from what was detected. A detected Cloudflare beacon is carried only when `beacon` says the
 * old site added it in its own code (Cloudflare's site list: auto_install false); a zone-injected beacon keeps being
 * injected by Cloudflare after the move, so loading it again would count every visit twice.
 */
export function carriedFromDetected(d: Detected, o: { beacon?: "manual" | "zone" | "unknown" } = {}): LegacyAnalytics {
	return {
		google: d.google,
		...(d.gtm[0] ? { gtm: d.gtm[0] } : {}),
		...(d.cloudflare[0] && o.beacon === "manual" ? { cloudflareToken: d.cloudflare[0] } : {}),
		...(d.meta.length ? { meta: d.meta } : {}),
		...(d.clarity[0] ? { clarity: d.clarity[0] } : {}),
		...(d.hotjar[0] ? { hotjar: d.hotjar[0] } : {}),
		...(d.ua.length ? { ua: d.ua } : {}),
	};
}
