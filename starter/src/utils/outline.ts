/**
 * SEO heading outline for the page's main content (kit SEO rules; docs/seo-rules.md): exactly one <h1>, and headings
 * that descend one level at a time. Applied to the HTML as it streams out (middleware, Cloudflare HTMLRewriter), so it
 * covers every section type, rich text and plugin output alike, and the cached copy is the corrected one.
 *
 * - The first heading in <main> becomes the <h1> when the page has none before it (a page whose first heading is an h3).
 * - Every later <h1> becomes an <h2> (WordPress pages often had several).
 * - A heading more than one level below the previous one moves up (h1 → h3 becomes h1 → h2).
 * The look never changes: a re-levelled heading gets its original level's class (`heading--hN`), which outranks the
 * tag selector in base.css. Footer headings get their own outline starting at <h2> (a site part never holds the
 * page's h1); the header and popups are untouched.
 * No imports: this file loads in Node (kit tests) and in the Worker.
 */
export interface OutlineState {
	/** Open headings: original level and the level given, parents first. */
	stack: { orig: number; to: number }[];
	h1: boolean;
	/** Level of a top heading: 1 in <main>, 2 in the footer (a site part, never the page's h1). */
	base: number;
}

export const newOutline = (base = 1): OutlineState => ({ stack: [], h1: false, base });

/**
 * The level a heading should have, given the headings before it in <main>. Levels follow the original parent chain, so
 * a heading moved up takes its siblings and children with it (h1, h3, h3, h4 → h1, h2, h2, h3).
 */
export function outlineLevel(s: OutlineState, level: number): number {
	while (s.stack.length && (s.stack.at(-1) as { orig: number }).orig >= level) s.stack.pop();
	const parent = s.stack.at(-1);
	const to = parent ? Math.min(level, parent.to + 1) : s.base > 1 ? s.base : s.h1 ? 2 : 1;
	if (to === 1) s.h1 = true;
	s.stack.push({ orig: level, to });
	return to;
}

type El = { tagName: string; getAttribute(n: string): string | null; setAttribute(n: string, v: string): void };
type Rewriter = { on(sel: string, h: { element(el: El): void }): Rewriter; transform(r: Response): Response };

/** Wraps an HTML response: headings inside <main> re-levelled by `outlineLevel`, classes kept for the look. */
export function fixOutline(res: Response, HTMLRewriterImpl: new () => Rewriter): Response {
	const relevel = (s: OutlineState) => ({
		element(el: El) {
			const level = Number(el.tagName.slice(1));
			const to = outlineLevel(s, level);
			if (to === level) return;
			const cls = el.getAttribute("class") ?? "";
			if (!/\bheading--h[1-6]\b/.test(cls)) el.setAttribute("class", `${cls ? `${cls} ` : ""}heading--h${level}`);
			el.tagName = `h${to}`;
		},
	});
	const tags = (scope: string) => [1, 2, 3, 4, 5, 6].map((n) => `${scope} h${n}`).join(", ");
	return new HTMLRewriterImpl().on(tags("main"), relevel(newOutline())).on(tags(".site-footer"), relevel(newOutline(2))).transform(res);
}

/** Whether a page's sections render any heading: a section heading, or a heading block in rich text. */
export function hasHeading(blocks: unknown[]): boolean {
	return /"(?:heading|title|question)":(?:"[^"]|\[\{)|"style":"h[1-6]"/.test(JSON.stringify(blocks));
}
