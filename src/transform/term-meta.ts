/**
 * Term meta: descriptions and SEO plugin values of categories, tags and custom taxonomy terms.
 *
 * - Descriptions go into EmDash's term `description` (blog and custom post type terms, at creation since the blog
 *   milestone); load now also fills an empty description on a term that already exists on the target, never replacing
 *   one an editor wrote. The starter prints it under the archive heading and as the archive's meta description.
 * - Per-term SEO titles and descriptions (Yoast `wpseo_taxonomy_meta`, from a database dump through import-options;
 *   Rank Math keeps them in term meta, which neither the Exporter nor REST serve) have no home in EmDash 1.5: terms have no
 *   SEO fields and the kit's SEO plugin has no per-term store. They are counted in the coverage report, not carried.
 */

/** The description to write on an existing target term: only when the target has none and WordPress has one. */
export function termDescriptionUpdate(target: { description?: string | null } | undefined, wpDescription: string | undefined): string | undefined {
	const want = (wpDescription ?? "").trim();
	if (!target || !want) return undefined;
	return (target.description ?? "").trim() ? undefined : want;
}

export interface TermSeoCounts {
	/** taxonomy → terms with an SEO title / description in the SEO plugin. */
	byTaxonomy: Record<string, { title: number; description: number; terms: number }>;
	/** Terms whose SEO description differs from (or exists without) their WordPress description. */
	differs: number;
}

/**
 * Yoast's per-term values (option `wpseo_taxonomy_meta`: taxonomy → term id → { wpseo_title, wpseo_desc, … }), counted
 * per taxonomy. `descriptionOf(taxonomy, id)` is the term's own WordPress description, to count where they differ.
 */
export function yoastTermSeo(option: unknown, descriptionOf: (taxonomy: string, id: number) => string | undefined = () => undefined): TermSeoCounts | undefined {
	if (!option || typeof option !== "object") return undefined;
	const out: TermSeoCounts = { byTaxonomy: {}, differs: 0 };
	for (const [tax, terms] of Object.entries(option as Record<string, unknown>)) {
		if (!terms || typeof terms !== "object") continue;
		for (const [id, meta] of Object.entries(terms as Record<string, unknown>)) {
			if (!meta || typeof meta !== "object") continue;
			const m = meta as Record<string, unknown>;
			const title = typeof m.wpseo_title === "string" && m.wpseo_title.trim() ? 1 : 0;
			const desc = typeof m.wpseo_desc === "string" && m.wpseo_desc.trim() ? (m.wpseo_desc as string).trim() : "";
			if (!title && !desc) continue;
			const e = (out.byTaxonomy[tax] ??= { title: 0, description: 0, terms: 0 });
			e.terms++;
			e.title += title;
			if (desc) {
				e.description++;
				if (desc !== (descriptionOf(tax, Number(id)) ?? "").trim()) out.differs++;
			}
		}
	}
	return Object.keys(out.byTaxonomy).length ? out : undefined;
}

/** Coverage report lines for term SEO values that cannot be carried (counts only). */
export function termSeoReport(counts: TermSeoCounts | undefined): string[] {
	if (!counts) return [];
	const L = ["", "## Term SEO (Yoast)", "", "Per-term SEO titles and descriptions from Yoast. EmDash 1.5 terms have no SEO fields and the kit's SEO plugin has no per-term store, so they are **not carried**: a category, tag or term archive uses the term's own description as its meta description and the term name as its title.", "", "| Taxonomy | Terms with SEO values | SEO title | SEO description |", "|---|---|---|---|"];
	for (const [tax, e] of Object.entries(counts.byTaxonomy).sort()) L.push(`| \`${tax}\` | ${e.terms} | ${e.title} | ${e.description} |`);
	if (counts.differs) L.push("", `${counts.differs} SEO description(s) differ from (or exist without) the term's own description. If those archives matter for search, copy the wording into the term description in the admin (it is shown under the archive heading too).`);
	return L;
}
