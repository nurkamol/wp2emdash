/**
 * Scaffold wiring for Analytics in the SEO & Analytics suite (@wp2emdash/seo): what was carried over from WordPress
 * (prefill), the Cloudflare Web Analytics site of the domain (read-only lookup with the build token), and the plugin's
 * analytics options. Kept out of phases/scaffold.ts so that file only calls these.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { carriedFromDetected, type Detected, detectTrackers } from "../../packages/seo/src/analytics/detect.js";
import type { LegacyAnalytics } from "../../packages/seo/src/analytics/trackers.js";
import type { AnalyticsOptions } from "../../packages/seo/src/index.js";
import type { KitConfig } from "../config/schema.js";
import { readState } from "../core/state.js";

/** Trackers in the audit's raw HTML (snapshot/html/*.html), plus the Google IDs the audit listed per page. */
export function detectFromSnapshot(snapshotDir: string, auditedIds: string[] = []): Detected {
	const dir = join(snapshotDir, "html");
	const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".html")) : [];
	const d = detectTrackers((function* () {
		for (const f of files) yield readFileSync(join(dir, f), "utf8");
		yield auditedIds.join(" ");
	})());
	return d;
}

export interface RumSite {
	siteTag: string;
	siteToken: string;
	/** Cloudflare injects the beacon into the zone's pages by itself. */
	autoInstall: boolean;
}

/**
 * The Web Analytics site for a host: GET /accounts/{id}/rum/site_info/list (read-only; permission "Account Settings:
 * Read", which the kit's build token has). Matched by the ruleset's zone name or a rule's host. Never throws.
 */
export async function lookupRumSite(o: { token?: string; accountId?: string; host: string }, fetchFn: typeof fetch = fetch): Promise<RumSite | undefined> {
	if (!o.token || !o.accountId || !/^[0-9a-f]{32}$/.test(o.accountId)) return undefined;
	const bare = o.host.toLowerCase().replace(/^www\./, "");
	try {
		const res = await fetchFn(`https://api.cloudflare.com/client/v4/accounts/${o.accountId}/rum/site_info/list?per_page=100`, { headers: { authorization: `Bearer ${o.token}` }, signal: AbortSignal.timeout(8000) });
		if (!res.ok) return undefined;
		const body = (await res.json()) as { result?: { site_tag?: string; site_token?: string; auto_install?: boolean; host?: string; ruleset?: { zone_name?: string }; rules?: { host?: string }[] }[] };
		const hit = (body.result ?? []).find((s) => [s.host, s.ruleset?.zone_name, ...(s.rules ?? []).map((r) => r.host)].some((h) => typeof h === "string" && h.toLowerCase().replace(/^www\./, "") === bare));
		if (!hit?.site_tag || !/^[0-9a-f]{32}$/.test(hit.site_tag)) return undefined;
		return { siteTag: hit.site_tag, siteToken: typeof hit.site_token === "string" ? hit.site_token : "", autoInstall: hit.auto_install === true };
	} catch {
		return undefined;
	}
}

/**
 * What the site carries over: kit.config's explicit list, nothing (`analytics: false`), or everything detected.
 * A detected Cloudflare beacon is carried only when Cloudflare's site list says the old site added it itself.
 */
export function carriedAnalytics(config: KitConfig["analytics"], detected: Detected, rum: RumSite | undefined): LegacyAnalytics | undefined {
	if (config === false) return undefined;
	if (config) return config;
	const token = detected.cloudflare[0];
	const beacon = token && rum && rum.siteToken === token ? (rum.autoInstall ? "zone" : "manual") : "unknown";
	return carriedFromDetected(detected, { beacon });
}

export const hasCarried = (a: LegacyAnalytics | undefined): boolean => !!a && ((a.google?.length ?? 0) > 0 || !!a.gtm || !!a.cloudflareToken || (a.meta?.length ?? 0) > 0 || !!a.clarity || !!a.hotjar || (a.ua?.length ?? 0) > 0);

/** One log line: what was carried, by service. */
export function describeCarried(a: LegacyAnalytics): string {
	return [...(a.google ?? []), a.gtm, ...(a.meta ?? []).map((m) => `Meta ${m}`), a.clarity && `Clarity ${a.clarity}`, a.hotjar && `Hotjar ${a.hotjar}`, a.cloudflareToken && "Cloudflare beacon", ...(a.ua ?? []).map((u) => `${u} (retired, not loaded)`)].filter(Boolean).join(", ");
}

/** The last verify `analytics-runtime` result, if verify ran before this build (shown in the admin page, dated). */
export function lastRuntimeCheck(stateFile: string): AnalyticsOptions["lastCheck"] {
	try {
		const v = readState(stateFile).phases.verify;
		const c = v?.checks.find((x) => x.id === "analytics-runtime");
		if (!c || !v?.finishedAt) return undefined;
		return { at: v.finishedAt, ok: c.ok, ...(c.detail ? { detail: c.detail.slice(0, 300) } : {}) };
	} catch {
		return undefined;
	}
}

export function analyticsOptions(o: { seed: LegacyAnalytics | undefined; accountId?: string; rum?: RumSite; stateFile: string; verification?: Record<string, string> }): AnalyticsOptions {
	const lastCheck = lastRuntimeCheck(o.stateFile);
	return {
		...(o.seed && hasCarried(o.seed) ? { seed: o.seed } : {}),
		...(o.accountId && /^[0-9a-f]{32}$/.test(o.accountId) ? { accountId: o.accountId } : {}),
		...(o.rum ? { siteTag: o.rum.siteTag, zoneBeacon: o.rum.autoInstall } : {}),
		...(lastCheck ? { lastCheck } : {}),
		...(o.verification && Object.keys(o.verification).length ? { verification: o.verification } : {}),
	};
}
