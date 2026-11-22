import type { LabRun } from "../../packages/health/src/checks/lab.js";
import type { Cwv } from "../../packages/health/src/store.js";
import type { PluginInfo } from "../audit/fingerprint.js";
import type { Integration } from "../audit/integrations.js";
import type { ShopFacts } from "../transform/shop.js";
import type { AdapterId, Range } from "./rules.js";

/** One page fetched in detail (no content kept: structure only). */
export interface SampledPage {
	url: string;
	status: number;
	builders: string[];
	forms: number;
	words: number;
	passwordField: boolean;
}

/** Everything the public site told us. Facts only, no judgement (that is blockers.ts / effort.ts). */
export interface Detections {
	url: string;
	origin: string;
	host: string;
	at: string;
	homeStatus: number;
	isWordPress: boolean;
	wordpressVersion?: string;
	siteName?: string;
	theme?: string;
	robots: { present: boolean; crawlDelay?: number; blocked: number };
	sitemaps: number;
	restAvailable: boolean;
	restNamespaces: string[];
	/** Published entries per public type (REST X-WP-Total), when the REST API answers. */
	types: { slug: string; count: number }[];
	media?: number;
	terms: number;
	/** URLs found in sitemaps and links (capped at rules.crawl.maxDiscovered). */
	discovered: number;
	discoveredCapped: boolean;
	/** Page / post split guessed from the URLs when the REST API is closed. */
	urlGuess: { pages: number; posts: number; archives: number };
	sample: SampledPage[];
	/** Pages in the sample per builder marker (detectBuilders). */
	builders: Record<string, number>;
	plugins: PluginInfo[];
	hiddenWpPaths: boolean;
	integrations: Integration[];
	shop?: ShopFacts;
	/** languages: hreflang alternates on this host; otherHosts: languages served from other hosts (separate sites). */
	multilingual: { plugin?: string; languages: string[]; otherHosts: number };
	multisite: boolean;
	accounts: { loginForms: number; accountLinks: string[] };
}

export type FindingLevel = "blocker" | "decision" | "complexity" | "info";

export interface Finding {
	id: string;
	level: FindingLevel;
	title: string;
	/** What we saw, in plain words. */
	what: string;
	/** What it means for the migration. */
	impact: string;
	/** What the kit does with it. */
	handling: string;
	/** Where the kit documents it (internal report only). */
	ref?: string;
	/** Not estimated: needs separate scoping. */
	excluded?: boolean;
}

export interface AdapterUse {
	adapter: AdapterId;
	label: string;
	proven: boolean;
	status: string;
	ref: string;
	/** Share of sampled pages (0–1). */
	share: number;
}

export interface EffortLine {
	id: string;
	label: string;
	hours: Range;
	basis: string;
}

export interface Effort {
	lines: EffortLine[];
	subtotal: Range;
	contingency: Range;
	/** Fraction added as contingency (rules.effort.contingency). */
	contingencyRate: number;
	total: Range;
	size: "Small" | "Medium" | "Large";
	excluded: string[];
	rate?: number;
	cost?: Range;
	currency?: string;
}

export interface PageSpeed {
	url: string;
	status: number;
	ttfbMs?: number;
	totalMs?: number;
	htmlKb?: number;
	compression?: string;
	server?: string;
	requests: number;
	/** HTML plus the referenced files whose size the server told us (content-length). */
	weightKb?: number;
	unknownSizes: number;
	imageFormats: Record<string, number>;
	resources: string[];
	error?: string;
}

export interface SpeedComparison {
	metric: string;
	prospect: string;
	emdash: string;
	/** similar: on par with (or better than) the kit's measured site; slower: clearly behind it. */
	verdict: "similar" | "slower" | "unknown";
}

export interface SpeedSummary {
	pages: PageSpeed[];
	ttfbMs?: number;
	weightKb?: number;
	requests?: number;
	imageFormats: Record<string, number>;
	modernImageShare?: number;
	comparisons: SpeedComparison[];
	lab?: { mobile?: LabRun; desktop?: LabRun; missing?: string };
	field?: Cwv;
	notes: string[];
}

export interface Estimate {
	kit: string;
	generatedAt: string;
	detections: Detections;
	adapters: AdapterUse[];
	findings: Finding[];
	effort: Effort;
	speed: SpeedSummary;
	agency: { name: string; url: string; contact?: string };
}
