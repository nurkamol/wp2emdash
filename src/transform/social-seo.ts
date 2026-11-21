/**
 * SEO plugin text per entry: title variables (Yoast `%%title%%`, Rank Math `%title%`) and the custom social sharing
 * text editors set in WordPress (Open Graph / Twitter title, description, image).
 *
 * Sources (post meta, which the EmDash Exporter returns in full, underscore keys included):
 * - Yoast: `_yoast_wpseo_opengraph-title`, `-description`, `-image`; `_yoast_wpseo_twitter-title`, `-description`, `-image`.
 * - Rank Math: `rank_math_facebook_title`, `_description`, `_image`; `rank_math_twitter_*` only when
 *   `rank_math_twitter_use_facebook` is "off" (Rank Math's default reuses the Facebook values for Twitter).
 * The Exporter's `rankmath` / `yoast` objects are read as a fallback (their key names for social fields are not
 * documented; the meta keys above are what the plugins store).
 *
 * Carried: IR `seo.social` (transform) → the SEO plugin's per-entry store (load, `seo-import`) → `page:metadata`.
 */

export interface SeoVarContext {
	siteName: string;
	sep?: string;
	/** The post or page title (`%%title%%`, `%title%`). */
	title?: string;
	tagline?: string;
	excerpt?: string;
	/** Term archives: the term's name and description. */
	termTitle?: string;
	termDescription?: string;
}

/** Yoast's separator option (`wpseo_titles.separator`) → the character it prints. */
export const YOAST_SEPARATORS: Record<string, string> = { "sc-dash": "-", "sc-ndash": "–", "sc-mdash": "—", "sc-colon": ":", "sc-middot": "·", "sc-bull": "•", "sc-star": "*", "sc-smstar": "⋆", "sc-pipe": "|", "sc-tilde": "~", "sc-laquo": "«", "sc-raquo": "»", "sc-lt": "<", "sc-gt": ">" };

/** The separator the old site's SEO plugin printed: Rank Math `title_separator`, Yoast `wpseo_titles.separator`, else "-". */
export function seoSeparator(options: { rankMathTitles?: unknown; yoastTitles?: unknown }): string {
	const rm = (options.rankMathTitles as { title_separator?: unknown } | undefined)?.title_separator;
	if (typeof rm === "string" && rm.trim() && rm.trim().length <= 3) return rm.trim();
	const y = (options.yoastTitles as { separator?: unknown } | undefined)?.separator;
	if (typeof y === "string" && YOAST_SEPARATORS[y]) return YOAST_SEPARATORS[y];
	return "-";
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Resolves Yoast (`%%var%%`) and Rank Math (`%var%`) title variables. Unknown Yoast variables print nothing (as Yoast
 * does); only the Rank Math variables listed here are replaced, so a literal "50% off" stays. Empty result → undefined.
 */
export function resolveSeoVars(s: string | undefined, c: SeoVarContext): string | undefined {
	if (typeof s !== "string" || !s.trim()) return undefined;
	const sep = c.sep ?? "-";
	const values: Record<string, string> = {
		title: c.title ?? "",
		sitename: c.siteName,
		sitedesc: c.tagline ?? "",
		sep,
		excerpt: c.excerpt ?? "",
		excerpt_only: c.excerpt ?? "",
		term_title: c.termTitle ?? "",
		term: c.termTitle ?? "",
		category: c.termTitle ?? "",
		tag: c.termTitle ?? "",
		term_description: c.termDescription ?? "",
		category_description: c.termDescription ?? "",
		tag_description: c.termDescription ?? "",
		page: "",
		pagenumber: "",
		pagetotal: "",
	};
	let out = s.replace(/%%([a-z_]+)%%/gi, (_, k: string) => values[k.toLowerCase()] ?? "");
	out = out.replace(/%(title|sitename|sitedesc|sep|excerpt|excerpt_only|term|term_description|category|tag|page)%/gi, (_, k: string) => values[k.toLowerCase()] ?? "");
	// Separators left at either end or doubled once a variable printed nothing ("News  - " → "News").
	const sepRe = esc(sep);
	out = out.replace(/\s+/g, " ").trim();
	out = out.replace(new RegExp(`(?:\\s*${sepRe}\\s*){2,}`, "g"), ` ${sep} `).replace(new RegExp(`^(?:${sepRe}\\s*)+|(?:\\s*${sepRe})+$`, "g"), "").trim();
	return out || undefined;
}

export interface IrSocial {
	ogTitle?: string;
	ogDescription?: string;
	ogImage?: string;
	twitterTitle?: string;
	twitterDescription?: string;
	twitterImage?: string;
	source: "yoast" | "rank-math" | "override";
}

/** A meta value as one string (the Exporter returns single values, sometimes as one-element arrays). */
export const metaString = (v: unknown): string | undefined => {
	const x = Array.isArray(v) ? v[0] : v;
	return typeof x === "string" && x.trim() ? x.trim() : typeof x === "number" ? String(x) : undefined;
};

const IMAGE = /^https?:\/\/\S+$/i;

/** Rank Math social values in a key → value map (post meta or term meta: the keys are the same). */
export function rankMathSocial(get: (key: string) => unknown, vars: (s: string | undefined) => string | undefined): Omit<IrSocial, "source"> {
	const fb = (k: string) => metaString(get(`rank_math_facebook_${k}`));
	const twOwn = metaString(get("rank_math_twitter_use_facebook")) === "off";
	const tw = (k: string) => (twOwn ? metaString(get(`rank_math_twitter_${k}`)) : undefined);
	return compact({ ogTitle: vars(fb("title")), ogDescription: vars(fb("description")), ogImage: image(fb("image")), twitterTitle: vars(tw("title")), twitterDescription: vars(tw("description")), twitterImage: image(tw("image")) });
}

/** Yoast social values; `prefix` is `_yoast_wpseo_` for post meta and `wpseo_` for term meta. */
export function yoastSocial(get: (key: string) => unknown, vars: (s: string | undefined) => string | undefined, prefix = "_yoast_wpseo_"): Omit<IrSocial, "source"> {
	const v = (k: string) => metaString(get(`${prefix}${k}`));
	return compact({ ogTitle: vars(v("opengraph-title")), ogDescription: vars(v("opengraph-description")), ogImage: image(v("opengraph-image")), twitterTitle: vars(v("twitter-title")), twitterDescription: vars(v("twitter-description")), twitterImage: image(v("twitter-image")) });
}

const image = (u: string | undefined) => (u && IMAGE.test(u) ? u : undefined);
function compact<T extends Record<string, string | undefined>>(o: T): { [K in keyof T]?: string } {
	return Object.fromEntries(Object.entries(o).filter(([, v]) => !!v)) as { [K in keyof T]?: string };
}
export const hasAny = (s: object) => Object.keys(s).some((k) => k !== "source");

/**
 * An entry's custom sharing text from Rank Math (first) or Yoast post meta, variables resolved; undefined when the
 * editor set none (then the SEO title, description and image are what links show, as on the old site).
 */
export function entrySocial(p: { meta?: Record<string, unknown>; rankmath?: Record<string, unknown>; yoast?: Record<string, unknown> }, vars: (s: string | undefined) => string | undefined): IrSocial | undefined {
	const meta = p.meta ?? {};
	const rmObj = p.rankmath ?? {};
	const yObj = p.yoast ?? {};
	const rm = rankMathSocial((k) => meta[k] ?? rmObj[k.replace(/^rank_math_/, "")], vars);
	if (hasAny(rm)) return { ...rm, source: "rank-math" };
	const y = yoastSocial((k) => meta[k] ?? yObj[k.replace(/^_yoast_wpseo_/, "")], vars);
	if (hasAny(y)) return { ...y, source: "yoast" };
	return undefined;
}
