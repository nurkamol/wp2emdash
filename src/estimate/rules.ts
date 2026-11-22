/**
 * `wp2emdash estimate` — every number the estimate uses, in one object the agency tunes.
 *
 * Hours are ranges [low, high] for one person who knows the kit. They are starting points, not measurements: change
 * them here (or pass `--rules <file.json>`, deep-merged over these) after each delivery, so estimates follow what
 * migrations really took. Nothing here is a price: `--rate <n>` multiplies the hours when asked.
 *
 * The speed targets are NOT tunable claims: they are the kit's own measurements and gates, quoted from
 * docs/spikes/performance-findings.md (and the verify gate defaults in src/config/schema.ts). Change them only when
 * that document changes.
 */

export type Range = [number, number];

export interface EstimateRules {
	agency: {
		/** Shown on the client report ("Prepared by …"). PixelKraft by default, as the kit's other branded output. */
		name: string;
		url: string;
		/** Optional contact line under the agency name (email, phone). */
		contact?: string;
	};
	crawl: {
		/** URLs collected from sitemaps / links before stopping (counts from the REST API are not capped). */
		maxDiscovered: number;
		/** Pages fetched and analysed in detail. */
		maxSample: number;
		/** Parallel requests to the prospect's site (polite: ≤ 4). */
		concurrency: number;
		/** Sitemap files read at most. */
		maxSitemaps: number;
		/** Referenced files (images, scripts, styles) sized with a HEAD request for the speed check, all pages together. */
		maxResourceChecks: number;
		/** Longest robots.txt Crawl-delay honoured (seconds); a longer one shrinks the sample instead. */
		maxCrawlDelaySeconds: number;
	};
	effort: {
		/** Fixed per project: workspace, audit, extract, scaffold, provisioning, load, verify, launch and handover. */
		base: Range;
		/** Per page, by the adapter that converts it (pages = WordPress pages and other page-like entries). */
		perPage: Record<AdapterId, Range>;
		/** Per blog post (Portable Text, bulk import; spot checks only). */
		perPost: Range;
		/** Per entry of other public content types (portfolio, team, events …): one collection each, plus entries. */
		perCollection: Range;
		perCollectionEntry: Range;
		/** Visual parity rounds against the live site (screenshots, spacing), by adapter. */
		visualParity: Record<AdapterId, Range>;
		/** Per distinct form rebuilt as a form section → Worker → email provider (+ Turnstile). */
		perForm: Range;
		/** Extra per form with possibly sensitive fields (health, finance): provider choice, field review. */
		perSensitiveForm: Range;
		/** Per third-party integration kept or replaced (booking, chat, maps, video, reviews, newsletter …). */
		perIntegration: Range;
		/** Analytics / tag manager / pixels / consent: re-wired in the kit's SEO & Analytics settings. */
		tracking: Range;
		/** Per popup kept as a dialog section. */
		perPopup: Range;
		/** Per plugin the kit does not know: find out what it does on the site. */
		perUnknownPlugin: Range;
		/** First real site on an adapter that has only run on fixtures so far (docs/PLAN.md status). */
		unprovenAdapter: Range;
		/** WooCommerce catalogue mode (docs/PLAN.md §8b): products collection, Buy buttons, shop redirects. */
		shopBase: Range;
		/** Per 50 products (checks, Buy links filled in with the owner). */
		shopPer50Products: Range;
		/** Multilingual (docs/PLAN.md §8c): languages, menus, hreflang, switcher. */
		multilingualBase: Range;
		perExtraLanguage: Range;
		/** Many redirects / URL clean-up when the site is large. Per 100 URLs beyond the first 100. */
		per100Urls: Range;
		/** Added on top of the sum, as a fraction (0.15 = 15 %). */
		contingency: number;
	};
	/** Size labels on the client report, by the high end of the range (hours). */
	sizes: { small: number; medium: number };
}

export type AdapterId = "wpbakery" | "gutenberg" | "bricks" | "elementor" | "divi" | "dom-fallback";

export const DEFAULT_RULES: EstimateRules = {
	agency: { name: "PixelKraft", url: "https://pixelkraft.net" },
	crawl: { maxDiscovered: 300, maxSample: 25, concurrency: 4, maxSitemaps: 20, maxResourceChecks: 60, maxCrawlDelaySeconds: 5 },
	effort: {
		base: [10, 16],
		perPage: { gutenberg: [0.15, 0.3], wpbakery: [0.25, 0.5], bricks: [0.3, 0.6], elementor: [0.5, 1], divi: [0.5, 1], "dom-fallback": [0.75, 1.5] },
		perPost: [0.02, 0.05],
		perCollection: [1, 2],
		perCollectionEntry: [0.05, 0.1],
		visualParity: { gutenberg: [2, 4], wpbakery: [4, 8], bricks: [4, 8], elementor: [5, 10], divi: [5, 10], "dom-fallback": [6, 12] },
		perForm: [1, 2],
		perSensitiveForm: [2, 4],
		perIntegration: [0.5, 1],
		tracking: [0.5, 1],
		perPopup: [1, 2],
		perUnknownPlugin: [0.5, 2],
		unprovenAdapter: [4, 10],
		shopBase: [8, 16],
		shopPer50Products: [1, 2],
		multilingualBase: [6, 12],
		perExtraLanguage: [2, 4],
		per100Urls: [0.5, 1],
		contingency: 0.15,
	},
	sizes: { small: 40, medium: 100 },
};

/**
 * The typical EmDash site the report compares against: the kit's own measurements, quoted with their source.
 * Not marketing numbers: each value names where it was measured and what it means.
 */
export const EMDASH_TARGETS = {
	source: "docs/spikes/performance-findings.md",
	measured: "on its first migrated sites, November 2026",
	/** Cached HTML time to first byte: measured 240–360 ms with a new connection; the verify gate fails above 600 ms. */
	ttfbMs: { measured: [240, 360] as Range, gate: 600 },
	/** Home page bytes until load: 397 KB desktop / 258 KB phone on the measured site; verify gate 1,500 KB. */
	weightKb: { measured: 397, phone: 258, gate: 1500 },
	/** Requests until load on the measured home page (verify preview run). */
	requests: { measured: 10 },
	/** Content images served as resized WebP through EmDash's image endpoint (srcset). */
	images: "WebP, resized per screen (srcset)",
	/** Lab LCP on the measured site: Playwright, unthrottled — not a Lighthouse score. */
	lcpMs: { desktop: 732, phone: 488, note: "Playwright on an unthrottled connection, not Lighthouse" },
} as const;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Deep-merge an agency's overrides (plain JSON) over the defaults. Arrays (ranges) replace, objects merge. */
export function mergeRules(base: EstimateRules, over: unknown): EstimateRules {
	const merge = (a: unknown, b: unknown): unknown => {
		if (!isObj(a) || !isObj(b)) return b === undefined ? a : b;
		const out: Record<string, unknown> = { ...a };
		for (const [k, v] of Object.entries(b)) out[k] = merge(a[k], v);
		return out;
	};
	const merged = merge(base, over) as EstimateRules;
	merged.crawl.concurrency = Math.max(1, Math.min(4, Math.round(merged.crawl.concurrency)));
	return merged;
}
