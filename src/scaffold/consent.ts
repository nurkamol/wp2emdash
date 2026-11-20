/**
 * Privacy & Consent (@wp2emdash/consent, on by default): what scaffold writes into astro.config (plugin options) and
 * site.config.json (`consent.defaults`, read by the starter until an admin saves). The starting point comes from
 * transform's ir/consent.json (the old site's consent plugin or service, src/transform/consent.ts) and kit.config
 * `consent` (its mode / position / policy win). Never anything about visitors: modes, wording, a page path.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConsentOptions } from "../../packages/consent/src/index.js";
import type { ConsentDefaults, Mode } from "../../packages/consent/src/settings.js";
import type { LegacyAnalytics } from "../../packages/seo/src/analytics/trackers.js";
import type { KitConfig } from "../config/schema.js";
import { PROVIDER_BY_ID, type SiteWidget } from "../providers/registry.js";
import type { ConsentPlan } from "../transform/consent.js";

export interface ConsentInputs {
	config: Pick<KitConfig, "name" | "consent" | "analytics">;
	productionUrl: string;
	irDir: string;
	/** Published pages (path, slug, title) — the privacy policy page is found among them. */
	pages: { path: string; slug: string; title?: string }[];
	siteWidgets: SiteWidget[];
	analytics?: { admin: boolean; seed?: LegacyAnalytics; zoneBeacon?: boolean };
	trailingSlash?: "always" | "never" | "ignore";
}

export interface ConsentScaffold {
	options: ConsentOptions;
	/** site.config.json `consent`. */
	site: { defaults: ConsentDefaults };
	mode: Mode;
	why: string;
}

const POLICY = /privacy|datenschutz|privacidad|confidentialit|cookie-?policy/i;

export function consentScaffold(i: ConsentInputs): ConsentScaffold | undefined {
	const c = i.config.consent;
	if (c === false) return undefined;
	let plan: ConsentPlan | undefined;
	try {
		const f = join(i.irDir, "consent.json");
		plan = existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as ConsentPlan) : undefined;
	} catch {}
	const mode: Mode = c.mode ?? plan?.mode ?? "auto";
	const policy = c.policy ?? i.pages.find((p) => POLICY.test(p.slug) || POLICY.test(p.title ?? ""))?.path;
	const keptTools = (plan?.keptWidgets ?? []).filter((p) => i.siteWidgets.some((w) => w.provider === p)).map((p) => PROVIDER_BY_ID[p]?.name ?? p);
	const defaults: ConsentDefaults = { mode, ...(c.position ? { position: c.position } : {}), ...(plan?.text && Object.keys(plan.text).length ? { text: plan.text } : {}), ...(policy ? { policy } : {}) };
	const why = c.mode ? `kit.config consent.mode "${c.mode}"` : (plan?.reason ?? "no transform result (ir/consent.json): \"auto\"");
	const widgets = i.siteWidgets.map((w) => ({ name: PROVIDER_BY_ID[w.provider]?.name ?? w.provider, category: PROVIDER_BY_ID[w.provider]?.category ?? "" })).filter((w) => w.category !== "consent");
	return {
		options: {
			productionUrl: i.productionUrl,
			siteName: i.config.name,
			defaults,
			...(keptTools.length ? { keptTools } : {}),
			...(plan ? { oldSite: plan.reason } : {}),
			...(widgets.length ? { widgets } : {}),
			...(i.analytics && i.config.analytics !== false ? { analytics: i.analytics } : {}),
			...(i.trailingSlash ? { trailingSlash: i.trailingSlash } : {}),
		},
		site: { defaults },
		mode,
		why,
	};
}
