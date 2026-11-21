/**
 * hreflang checks for multilingual sites (src/transform/multilingual.ts): on the migrated pages, every alternate must
 * point back (reciprocal), name a page that answers, and match what the live WordPress page announced (as paths, so
 * the staging host and the production domain compare equal).
 */

export interface HreflangPage {
	/** Site path of the page (`/fr/a-propos/`). */
	path: string;
	hreflang: { lang: string; href: string }[];
}

const pathOf = (href: string, base: string) => {
	try {
		return new URL(href, base).pathname;
	} catch {
		return href;
	}
};

/** Alternate sets that do not point back: page A lists B, but B does not list A (or is missing from the checked pages). */
export function reciprocityProblems(pages: HreflangPage[], base = "https://site.invalid"): string[] {
	const byPath = new Map(pages.map((p) => [p.path, new Set(p.hreflang.filter((a) => a.lang !== "x-default").map((a) => pathOf(a.href, base)))]));
	const out: string[] = [];
	for (const p of pages) {
		const alts = byPath.get(p.path) ?? new Set();
		if (alts.size && !alts.has(p.path)) out.push(`${p.path}: no self-referencing hreflang`);
		for (const other of alts) {
			if (other === p.path) continue;
			const back = byPath.get(other);
			if (!back) out.push(`${p.path} → ${other}: alternate not checked (not among the verified pages)`);
			else if (!back.has(p.path)) out.push(`${p.path} → ${other}: ${other} does not link back`);
		}
	}
	return out;
}

/** Live vs migrated: the same languages pointing at the same paths (x-default included when the live page had it). */
export function hreflangParity(source: HreflangPage["hreflang"], target: HreflangPage["hreflang"], base = "https://site.invalid"): string[] {
	const norm = (list: HreflangPage["hreflang"]) => new Map(list.map((a) => [a.lang.toLowerCase(), pathOf(a.href, base)]));
	const s = norm(source);
	const t = norm(target);
	const out: string[] = [];
	for (const [lang, path] of s) {
		if (!t.has(lang)) out.push(`missing ${lang} → ${path}`);
		else if (t.get(lang) !== path) out.push(`${lang}: ${t.get(lang)} instead of ${path}`);
	}
	for (const lang of t.keys()) if (!s.has(lang)) out.push(`extra ${lang} → ${t.get(lang)}`);
	return out;
}
