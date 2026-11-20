/**
 * Region rule for mode "auto": which visitors get the opt-in banner. Answered by the starter's middleware at
 * /_consent/region (never cached, no cookies, no body beyond one boolean) from Cloudflare's own geolocation of the
 * request (`request.cf.country`, `request.cf.regionCode`; the `CF-IPCountry` header as a fallback). The pages stay one
 * cached HTML for everyone: the banner script asks this endpoint in the browser (docs/spikes/consent-findings.md).
 *
 * Opt-in: the EU (27), the rest of the EEA (Iceland, Liechtenstein, Norway), the United Kingdom, Switzerland, and
 * Québec (Law 25: consent before tracking technologies). Unknown, Tor ("T1") and unlisted codes ("XX") also get opt-in:
 * when in doubt the stricter rule applies.
 */
export const EU = ["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"] as const;
export const STRICT_COUNTRIES: readonly string[] = [...EU, "IS", "LI", "NO", "GB", "CH"];
/** Country → regions (ISO 3166-2 subdivision codes as Cloudflare reports them) with the opt-in rule. */
export const STRICT_REGIONS: Readonly<Record<string, readonly string[]>> = { CA: ["QC"] };

export function strictRegion(country: unknown, regionCode?: unknown): boolean {
	const c = typeof country === "string" ? country.trim().toUpperCase() : "";
	if (!/^[A-Z][A-Z0-9]$/.test(c) || c === "XX" || c === "T1") return true;
	if (STRICT_COUNTRIES.includes(c)) return true;
	const r = typeof regionCode === "string" ? regionCode.trim().toUpperCase() : "";
	return !!STRICT_REGIONS[c]?.includes(r);
}

/** The endpoint's answer for a request. Only the rule, never the country or anything else about the visitor. */
export function regionAnswer(request: { cf?: unknown; headers: { get(name: string): string | null } }): { strict: boolean } {
	const cf = (request.cf && typeof request.cf === "object" ? request.cf : {}) as { country?: unknown; regionCode?: unknown };
	return { strict: strictRegion(cf.country ?? request.headers.get("cf-ipcountry"), cf.regionCode) };
}

/** Headers of that answer: never stored by any cache, never indexed, not personalised beyond the request itself. */
export const REGION_HEADERS: Record<string, string> = {
	"content-type": "application/json; charset=utf-8",
	"cache-control": "no-store, private",
	"x-robots-tag": "noindex",
	"x-content-type-options": "nosniff",
};
