/**
 * Kit SEO rules (docs/seo-rules.md), checked on every migrated page by verify (`seo-rules`) — the on-page rules an SEO
 * audit scores, so a migrated site starts clean. Errors and warnings fail the check; notes are listed only (content
 * the owner writes: page length, links between pages).
 */
export interface SeoRuleFinding {
	rule: "h1-missing" | "h1-multiple" | "heading-skip" | "title-short" | "title-long" | "desc-missing" | "desc-short" | "desc-long";
	level: "error" | "warning" | "note";
	detail: string;
}

export const SEO_LIMITS = { titleMin: 20, titleMax: 65, descMin: 70, descMax: 160 } as const;

export function seoRules(page: { headings: { level: number; text: string }[]; seo: { title?: string; description?: string } }): SeoRuleFinding[] {
	const out: SeoRuleFinding[] = [];
	const h1 = page.headings.filter((h) => h.level === 1);
	if (!h1.length) out.push({ rule: "h1-missing", level: "error", detail: "no <h1>" });
	if (h1.length > 1) out.push({ rule: "h1-multiple", level: "warning", detail: `${h1.length}: ${h1.map((h) => `"${h.text.slice(0, 40)}"`).join(", ")}` });
	let last = 0;
	for (const h of page.headings) {
		if (last && h.level > last + 1) {
			out.push({ rule: "heading-skip", level: "warning", detail: `h${last} → h${h.level} ("${h.text.slice(0, 40)}")` });
			break;
		}
		last = h.level;
	}
	const title = (page.seo.title ?? "").trim();
	if (title.length < SEO_LIMITS.titleMin) out.push({ rule: "title-short", level: "warning", detail: `${title.length} characters: "${title}"` });
	else if (title.length > SEO_LIMITS.titleMax) out.push({ rule: "title-long", level: "warning", detail: `${title.length} characters (cut off in results)` });
	const desc = (page.seo.description ?? "").trim();
	if (!desc) out.push({ rule: "desc-missing", level: "warning", detail: "no meta description" });
	else if (desc.length < SEO_LIMITS.descMin) out.push({ rule: "desc-short", level: "note", detail: `${desc.length} characters` });
	else if (desc.length > SEO_LIMITS.descMax) out.push({ rule: "desc-long", level: "warning", detail: `${desc.length} characters (cut off in results)` });
	return out;
}
