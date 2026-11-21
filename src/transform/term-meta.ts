/**
 * Term meta: descriptions and SEO plugin values of categories, tags and custom taxonomy terms.
 *
 * - Descriptions go into EmDash's term `description` (blog and custom post type terms, at creation since the blog
 *   milestone); load now also fills an empty description on a term that already exists on the target, never replacing
 *   one an editor wrote. The starter prints it under the archive heading and as the archive's meta description.
 * - Per-term SEO (EmDash 1.5 terms have no SEO fields): SEO title, meta description, noindex and the Open Graph / Twitter
 *   text, from Yoast's `wpseo_taxonomy_meta` option (taxonomy → term id → `wpseo_title`, `wpseo_desc`, `wpseo_noindex`,
 *   `wpseo_opengraph-*`, `wpseo_twitter-*`) and Rank Math's term meta (`rank_math_title`, `rank_math_description`,
 *   `rank_math_robots`, `rank_math_facebook_*`, `rank_math_twitter_*`). Neither the Exporter nor REST serves them: both
 *   come from a database dump (`import-options` / `import-dump`: the option by name, Rank Math rows of `<prefix>termmeta`).
 *   Variables are resolved here; an owner override (overrides.ts `seo`, keyed by the archive path) wins. Transform writes
 *   `ir/term-seo.json`; load stores it in the SEO plugin (`term:<taxonomy>:<slug>`); the starter prints the title and the
 *   plugin's `page:metadata` hook the rest. Terms of taxonomies the site does not migrate are counted in the coverage
 *   report as not carried.
 */
import { hasAny, metaString, rankMathSocial, resolveSeoVars, type SeoVarContext, yoastSocial } from "./social-seo.js";

/** The description to write on an existing target term: only when the target has none and WordPress has one. */
export function termDescriptionUpdate(target: { description?: string | null } | undefined, wpDescription: string | undefined): string | undefined {
	const want = (wpDescription ?? "").trim();
	if (!target || !want) return undefined;
	return (target.description ?? "").trim() ? undefined : want;
}

/** raw/<file> written by import-options: `{ rankMath: { <termId>: { rank_math_title, … } } }`. */
export const SEO_TERMMETA_FILE = "seo-termmeta.json";

/** Rank Math term meta keys read from a dump (values only: titles, descriptions, robots, social text and image URLs). */
export const RANK_MATH_TERM_KEYS = ["rank_math_title", "rank_math_description", "rank_math_robots", "rank_math_facebook_title", "rank_math_facebook_description", "rank_math_facebook_image", "rank_math_twitter_use_facebook", "rank_math_twitter_title", "rank_math_twitter_description", "rank_math_twitter_image"];

/** `<prefix>termmeta` rows → term id → Rank Math values (other meta keys are dropped). `decode` unserializes PHP values. */
export function rankMathTermMeta(rows: Record<string, string | null>[], decode: (raw: string) => unknown = (x) => x): Record<string, Record<string, unknown>> {
	const out: Record<string, Record<string, unknown>> = {};
	for (const r of rows) {
		const key = r.meta_key ?? "";
		const id = r.term_id ?? "";
		if (!RANK_MATH_TERM_KEYS.includes(key) || !/^\d+$/.test(id) || r.meta_value == null || r.meta_value === "") continue;
		(out[id] ??= {})[key] = /^(a|s|i|b):\d*/.test(r.meta_value) ? decode(r.meta_value) : r.meta_value;
	}
	return out;
}

/** Owner overrides by path (overrides.ts `seo`): SEO and sharing text. */
export interface SeoOverride {
	title?: string;
	description?: string;
	ogTitle?: string;
	ogDescription?: string;
	twitterTitle?: string;
	twitterDescription?: string;
}

export interface IrTermSeo {
	/** EmDash taxonomy name. */
	taxonomy: string;
	wpTaxonomy: string;
	wpId: number;
	slug: string;
	label: string;
	/** The archive address on the new site (hierarchical terms: base + parents + slug). */
	path: string;
	title?: string;
	description?: string;
	noindex?: boolean;
	ogTitle?: string;
	ogDescription?: string;
	ogImage?: string;
	twitterTitle?: string;
	twitterDescription?: string;
	twitterImage?: string;
	source: "yoast" | "rank-math" | "override";
	/** An owner override (overrides.ts `seo`) changed this term's text. */
	overridden?: boolean;
}

export interface TermSeoPlan {
	version: 1;
	terms: IrTermSeo[];
	/** Values found for terms the site does not migrate (no archive on the new site), counted per WordPress taxonomy. */
	notCarried: { wpTaxonomy: string; terms: number; why: string }[];
	/** Where the values came from (for the report). */
	sources: { yoast: boolean; rankMath: boolean };
}

export interface TermSeoTaxonomy {
	name: string;
	wpName: string;
	base: string;
	terms: { wpId: number; slug: string; label: string; description?: string; parent?: string }[];
}

const str = (v: unknown) => metaString(v);

/** Every migrated term that has SEO values (Yoast, Rank Math or an owner override), variables resolved. */
export function termSeoPlan(input: { yoast?: unknown; rankMath?: Record<string, Record<string, unknown>>; taxonomies: TermSeoTaxonomy[]; siteName: string; sep?: string; tagline?: string; overrides?: Record<string, SeoOverride> }): TermSeoPlan {
	const yoast = (input.yoast && typeof input.yoast === "object" ? input.yoast : {}) as Record<string, Record<string, Record<string, unknown>> | unknown>;
	const rm = input.rankMath ?? {};
	const plan: TermSeoPlan = { version: 1, terms: [], notCarried: [], sources: { yoast: Object.keys(yoast).length > 0, rankMath: Object.keys(rm).length > 0 } };
	const seen = new Set<number>();
	const norm = (p: string) => (p === "/" ? "/" : `/${p.replace(/^\/+|\/+$/g, "")}/`);
	for (const t of input.taxonomies) {
		const bySlug = new Map(t.terms.map((x) => [x.slug, x]));
		const yTax = (yoast[t.wpName] && typeof yoast[t.wpName] === "object" ? yoast[t.wpName] : {}) as Record<string, Record<string, unknown>>;
		for (const term of t.terms) {
			// Hierarchical archives: /category/parent/child/ (the starter answers on the last segment, any prefix).
			const chain = [term.slug];
			let parent = term.parent ? bySlug.get(term.parent) : undefined;
			for (let guard = 0; parent && guard < 10; guard++) {
				chain.unshift(parent.slug);
				parent = parent.parent ? bySlug.get(parent.parent) : undefined;
			}
			const base = norm(t.base);
			const path = `${base}${chain.join("/")}/`;
			const ctx: SeoVarContext = { siteName: input.siteName, ...(input.sep ? { sep: input.sep } : {}), ...(input.tagline ? { tagline: input.tagline } : {}), title: term.label, termTitle: term.label, ...(term.description ? { termDescription: term.description } : {}) };
			const vars = (s: string | undefined) => resolveSeoVars(s, ctx);
			const fromRm = rm[String(term.wpId)];
			const fromY = yTax[String(term.wpId)];
			let found: Omit<IrTermSeo, "taxonomy" | "wpTaxonomy" | "wpId" | "slug" | "label" | "path"> | undefined;
			if (fromRm) {
				const robots = fromRm.rank_math_robots;
				const noindex = Array.isArray(robots) ? robots.includes("noindex") : Object.values((robots && typeof robots === "object" ? robots : {}) as Record<string, unknown>).includes("noindex") || (typeof robots === "string" && /noindex/.test(robots));
				const v = { ...compactStr({ title: vars(str(fromRm.rank_math_title)), description: vars(str(fromRm.rank_math_description)) }), ...(noindex ? { noindex: true } : {}), ...rankMathSocial((k) => fromRm[k], vars) };
				if (hasAny(v)) found = { ...v, source: "rank-math" };
			}
			if (!found && fromY && typeof fromY === "object") {
				const v = { ...compactStr({ title: vars(str(fromY.wpseo_title)), description: vars(str(fromY.wpseo_desc)) }), ...(str(fromY.wpseo_noindex) === "noindex" ? { noindex: true } : {}), ...yoastSocial((k) => fromY[k], vars, "wpseo_") };
				if (hasAny(v)) found = { ...v, source: "yoast" };
			}
			const ov = input.overrides?.[path] ?? input.overrides?.[`${base}${term.slug}/`];
			const ovText = ov ? compactStr({ title: ov.title, description: ov.description, ogTitle: ov.ogTitle, ogDescription: ov.ogDescription, twitterTitle: ov.twitterTitle, twitterDescription: ov.twitterDescription }) : {};
			if (!found && !Object.keys(ovText).length) continue;
			seen.add(term.wpId);
			plan.terms.push({ taxonomy: t.name, wpTaxonomy: t.wpName, wpId: term.wpId, slug: term.slug, label: term.label, path, ...(found ?? { source: "override" as const }), ...ovText, ...(Object.keys(ovText).length ? { overridden: true } : {}) });
		}
	}
	// Values for terms the site does not migrate (taxonomies without archives on the new site).
	const missed = new Map<string, number>();
	for (const [tax, terms] of Object.entries(yoast)) {
		if (!terms || typeof terms !== "object") continue;
		for (const [id, m] of Object.entries(terms as Record<string, unknown>)) {
			if (seen.has(Number(id)) || !m || typeof m !== "object") continue;
			const x = m as Record<string, unknown>;
			if (!str(x.wpseo_title) && !str(x.wpseo_desc) && str(x.wpseo_noindex) !== "noindex" && !hasAny(yoastSocial((k) => x[k], (s) => s, "wpseo_"))) continue;
			if (input.taxonomies.some((t) => t.wpName === tax && t.terms.some((y) => y.wpId === Number(id)))) continue;
			missed.set(tax, (missed.get(tax) ?? 0) + 1);
		}
	}
	const rmUnknown = Object.keys(rm).filter((id) => !seen.has(Number(id)) && !input.taxonomies.some((t) => t.terms.some((y) => String(y.wpId) === id)));
	for (const [wpTaxonomy, n] of [...missed].sort()) plan.notCarried.push({ wpTaxonomy, terms: n, why: "taxonomy not migrated (no archive on the new site)" });
	if (rmUnknown.length) plan.notCarried.push({ wpTaxonomy: "(Rank Math term meta)", terms: rmUnknown.length, why: "term not in a migrated taxonomy (no archive on the new site)" });
	plan.terms.sort((a, b) => a.path.localeCompare(b.path));
	return plan;
}

function compactStr(o: Record<string, string | undefined>): Record<string, string> {
	return Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === "string" && v.trim())) as Record<string, string>;
}

/** Coverage report lines: what is carried per taxonomy, and what is not. Counts and paths only. */
export function termSeoReport(plan: TermSeoPlan | undefined, missingDump?: string): string[] {
	if (!plan || (!plan.terms.length && !plan.notCarried.length)) return missingDump ? ["", "## Term SEO", "", `The old site uses ${missingDump}, but no database dump with its term values was imported (\`wp2emdash import-dump\`): per-term SEO titles, descriptions and sharing text of category, tag and other archives are **not carried** (the Exporter and REST do not serve them). Archives use the term name and description.`] : [];
	const from = [plan.sources.yoast ? "Yoast (`wpseo_taxonomy_meta`)" : "", plan.sources.rankMath ? "Rank Math (term meta)" : ""].filter(Boolean).join(" and ") || "owner overrides";
	const L = ["", "## Term SEO", "", `Per-term SEO title, meta description, noindex and sharing text from ${from}, read from a database dump (neither the Exporter nor REST serves them). **Carried** into the SEO plugin's archive store (load → Plugins → SEO → Archives): the archive's \`<title>\` and head tags use them; an archive without its own uses the term name and description.`, ""];
	if (plan.terms.length) {
		const byTax = new Map<string, { terms: number; title: number; description: number; noindex: number; social: number; overridden: number }>();
		for (const t of plan.terms) {
			const e = byTax.get(t.wpTaxonomy) ?? { terms: 0, title: 0, description: 0, noindex: 0, social: 0, overridden: 0 };
			e.terms++;
			if (t.title) e.title++;
			if (t.description) e.description++;
			if (t.noindex) e.noindex++;
			if (t.ogTitle || t.ogDescription || t.ogImage || t.twitterTitle || t.twitterDescription || t.twitterImage) e.social++;
			if (t.overridden) e.overridden++;
			byTax.set(t.wpTaxonomy, e);
		}
		L.push("| Taxonomy | Terms carried | SEO title | Description | noindex | Sharing text | Owner override |", "|---|---|---|---|---|---|---|");
		for (const [tax, e] of [...byTax].sort()) L.push(`| \`${tax}\` | ${e.terms} | ${e.title} | ${e.description} | ${e.noindex} | ${e.social} | ${e.overridden} |`);
	}
	if (plan.notCarried.length) {
		L.push("", "Not carried:", "");
		for (const n of plan.notCarried) L.push(`- \`${n.wpTaxonomy}\`: ${n.terms} term(s) — ${n.why}`);
	}
	if (missingDump) L.push("", `No database dump with ${missingDump} term values was imported (\`wp2emdash import-dump\`): only owner overrides are carried.`);
	return L;
}
