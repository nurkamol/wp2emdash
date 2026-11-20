/**
 * Analytics tags: the home page as the domain serves it still carries the tracking codes that are switched on — the
 * JSON in <meta name="site-analytics"> that the site's loader starts each service from (@wp2emdash/seo). Server-side
 * only: whether the scripts then really run in a browser (and are not blocked by the security policy) stays the kit's
 * verify check (`analytics-runtime`). Expected codes: SEO & Analytics' stored settings (one D1 row, read the way the site
 * reads them), or what was carried over when that page is off.
 */
import { type D1Like, readStoredAnalytics } from "@wp2emdash/seo/analytics/store";
import { type LegacyAnalytics, type RuntimeConfig, runtimeConfig, seedTrackers } from "@wp2emdash/seo/analytics/trackers";
import type { CheckState } from "../store.js";

type Ids = Record<"google" | "gtm" | "meta" | "cloudflare" | "clarity" | "hotjar", string[]>;
const NAMES: Record<keyof Ids, string> = { google: "Google tag", gtm: "Tag Manager", meta: "Meta Pixel", cloudflare: "Cloudflare Web Analytics", clarity: "Microsoft Clarity", hotjar: "Hotjar" };

const idsOf = (rc: Partial<RuntimeConfig> | undefined): Ids => ({ google: rc?.google ?? [], gtm: rc?.gtm ?? [], meta: rc?.meta ?? [], cloudflare: rc?.cloudflare ? [rc.cloudflare] : [], clarity: rc?.clarity ? [rc.clarity] : [], hotjar: rc?.hotjar ? [rc.hotjar] : [] });

/** The switched-on codes. `null`: the stored settings could not be read (the site then loads nothing either). */
export async function expectedTrackers(o: { admin: boolean; seed?: LegacyAnalytics }, db: D1Like | undefined): Promise<RuntimeConfig | null> {
	const seed = seedTrackers(o.seed);
	if (!o.admin) return runtimeConfig(seed);
	const stored = await readStoredAnalytics(db);
	if (stored === undefined) return runtimeConfig(seed);
	if (stored === null) return null;
	return runtimeConfig(stored.trackers, { events: stored.events, consent: stored.consent });
}

/** The codes a page carries (its <meta name="site-analytics">); undefined when it has none. */
export function pageTrackers(html: string): RuntimeConfig | undefined {
	const tag = [...html.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]).find((m) => /name=["']site-analytics["']/i.test(m));
	const raw = tag ? (/content="([^"]*)"/i.exec(tag)?.[1] ?? /content='([^']*)'/i.exec(tag)?.[1]) : undefined;
	if (!raw) return undefined;
	const text = raw.replace(/&quot;|&#34;|&#x22;/gi, '"').replace(/&#39;|&#x27;/gi, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
	try {
		const a = JSON.parse(text) as Record<string, unknown>;
		const strs = (v: unknown) => (Array.isArray(v) ? v : typeof v === "string" ? [v] : []).filter((x): x is string => typeof x === "string");
		const one = (v: unknown) => strs(v)[0];
		const cf = one(a.cloudflare);
		const clarity = one(a.clarity);
		const hotjar = one(a.hotjar);
		return { google: strs(a.google), gtm: strs(a.gtm), meta: strs(a.meta), ...(cf ? { cloudflare: cf } : {}), ...(clarity ? { clarity } : {}), ...(hotjar ? { hotjar } : {}) };
	} catch {
		return undefined;
	}
}

export function analyticsCheck(expected: RuntimeConfig | null | undefined, html: string | undefined, at: string, o: { zoneBeacon?: boolean } = {}): CheckState {
	if (expected === undefined) return { status: "off", summary: "This site carries no analytics (owner's choice).", at };
	if (html === undefined) return { status: "unknown", summary: "Not checked: the home page did not answer.", at };
	if (expected === null) return { status: "warn", summary: "The analytics settings could not be read, so the site loads no tracking code right now.", at };
	const want = idsOf(expected);
	const have = idsOf(pageTrackers(html));
	const missing: string[] = [];
	const extra: string[] = [];
	for (const k of Object.keys(NAMES) as (keyof Ids)[]) {
		for (const id of want[k]) if (!have[k].includes(id)) missing.push(`${NAMES[k]} ${id}`);
		for (const id of have[k]) if (!want[k].includes(id)) extra.push(`${NAMES[k]} ${id}`);
	}
	const total = Object.values(want).reduce((n, v) => n + v.length, 0);
	const beacon = o.zoneBeacon ? ["Cloudflare adds its Web Analytics beacon on the domain itself; that one is not visible from here."] : [];
	if (missing.length) return { status: "fail", summary: `Switched on but missing from the pages: ${missing.join(", ")}.`, at, detail: beacon };
	if (extra.length) return { status: "warn", summary: `On the pages but not switched on: ${extra.join(", ")}.`, at, detail: beacon };
	if (!total) return { status: "ok", summary: "No tracking code is switched on, and the pages carry none.", at, detail: beacon };
	return { status: "ok", summary: `The pages carry the ${total === 1 ? "tracking code" : `${total} tracking codes`} switched on (${Object.entries(want).flatMap(([k, ids]) => ids.map((id) => `${NAMES[k as keyof Ids]} ${id}`)).join(", ")}).`, at, detail: [...beacon, "Whether they run in a browser is checked by the developer's verify run."] };
}
