/**
 * The search page (pages/search.astro): the query from the address, result addresses, excerpts with the matched words
 * marked, and the result type. EmDash's full-text search (`search()` from "emdash", FTS5, porter stemming, every word
 * must match; docs/spikes/site-features-findings.md) finds posts and collection entries by title, excerpt and body, and
 * pages by title. EmDash 1.5 refuses a searchable blocks field, so the page also reads the text of the pages' sections
 * itself (a brochure site has tens of pages: one query) and adds the pages that contain every word. EmDash's snippet comes
 * from the first indexed field (the title), so excerpts are made here from each entry's text.
 *
 * No imports here: this file must load in Node (kit tests) and in the Worker (starter).
 */

/** Plain text of Portable Text or of a page's sections (every span, at any depth; HTML blocks without their tags). */
export function textOf(value: unknown): string {
	const out: string[] = [];
	const walk = (v: unknown) => {
		if (Array.isArray(v)) return v.forEach(walk);
		if (!v || typeof v !== "object") return;
		const o = v as { _type?: string; text?: unknown; html?: unknown; [k: string]: unknown };
		if (o._type === "span" && typeof o.text === "string") return void out.push(o.text);
		if (o._type === "htmlBlock" && typeof o.html === "string") return void out.push(" ", o.html.replace(/<[^>]+>/g, " "), " ");
		for (const [k, x] of Object.entries(o)) if (k !== "markDefs" && k !== "asset" && k !== "_media") walk(x);
		if (o._type === "block") out.push(" ");
	};
	walk(value);
	return out.join("").replace(/\s+/g, " ").trim();
}

export const SEARCH_PER_PAGE = 10;
/** Pages read for the section-text match (more than any brochure site has). */
export const SEARCH_PAGE_SCAN = 300;
/** Deepest page reachable (EmDash pages the merged results by offset; each page asks for every row before it). */
export const SEARCH_MAX_PAGE = 20;

/** The query (`?q=`, WordPress's `?s=` too) and the page number from a search address. */
export function searchParams(url: URL): { q: string; page: number } {
	const q = (url.searchParams.get("q") ?? url.searchParams.get("s") ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
	const n = Number.parseInt(url.searchParams.get("page") ?? "1", 10);
	return { q, page: Number.isFinite(n) ? Math.min(Math.max(n, 1), SEARCH_MAX_PAGE) : 1 };
}

/** The search page's own address in the site's URL style, with the query and page. */
export function searchHref(q: string, page = 1, style: "always" | "never" | undefined = "always"): string {
	const base = style === "never" ? "/search" : "/search/";
	const params = new URLSearchParams({ q });
	if (page > 1) params.set("page", String(page));
	return `${base}?${params.toString()}`;
}

/** A result's address: every kit collection keeps the WordPress path as the slug (`/{slug}`); the front page is "home". */
export function resultHref(slug: string | null | undefined, style: "always" | "never" | undefined = "always"): string {
	const s = String(slug ?? "").replace(/^\/+|\/+$/g, "");
	if (!s || s === "home") return "/";
	return style === "never" ? `/${s}` : `/${s}/`;
}

const escHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

/** The words of a query worth marking (two letters or more, operators and quotes left out). */
export function queryTerms(q: string): string[] {
	return [...new Set(q.replace(/["*()^:]/g, " ").split(/\s+/).filter((w) => w.length >= 2 && !/^(AND|OR|NOT|NEAR)$/.test(w)).map((w) => w.toLowerCase()))];
}

/** Text made safe for `set:html`, with the query's words wrapped in <mark> (the only markup it contains). */
export function highlight(text: string, q: string): string {
	const terms = queryTerms(q);
	if (!terms.length) return escHtml(text);
	const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "gi");
	return text
		.split(re)
		.map((part, i) => (i % 2 === 1 ? `<mark>${escHtml(part)}</mark>` : escHtml(part)))
		.join("");
}

/** A short excerpt around the first matched word (else the start), about `words` long. */
export function excerptAround(text: string, q: string, words = 32): string {
	const all = text.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
	if (all.length <= words) return all.join(" ");
	const terms = queryTerms(q);
	const at = all.findIndex((w) => terms.some((t) => w.toLowerCase().includes(t)));
	const start = at < 0 ? 0 : Math.max(0, Math.min(at - Math.floor(words / 3), all.length - words));
	return `${start > 0 ? "… " : ""}${all.slice(start, start + words).join(" ")}${start + words < all.length ? " …" : ""}`;
}

/** Readable text of an entry for its excerpt: an excerpt field, else its SEO description, else the text of its body or sections. */
export function entryText(data: Record<string, unknown>, seoDescription?: string | null): string {
	if (typeof data.excerpt === "string" && data.excerpt.trim()) return data.excerpt.trim();
	if (seoDescription?.trim()) return seoDescription.trim();
	const body = textOf(data.body);
	if (body) return body;
	return textOf(data.content);
}

/** Every word of the query is in the text (case-insensitive; a word matches the start of a longer one: "massag" finds "massage"). */
export function matchesAll(text: string, q: string): boolean {
	const terms = queryTerms(q);
	if (!terms.length) return false;
	const t = ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")}`;
	return terms.every((w) => t.includes(` ${w.replace(/[^\p{L}\p{N}]+/gu, " ").trim()}`));
}

export interface SearchHit {
	collection: string;
	slug: string | null;
	id?: string;
	title?: string;
}

/**
 * EmDash's ranked hits first, then the pages whose title or sections contain every word and that EmDash did not return
 * (title matches before section matches), without duplicates. `pages`: the published pages with their text.
 */
export function mergeHits(fts: SearchHit[], pages: { slug: string; title: string; text: string }[], q: string): SearchHit[] {
	const seen = new Set(fts.map((h) => `${h.collection}:${h.slug}`));
	const extra = pages
		.filter((p) => !seen.has(`pages:${p.slug}`) && matchesAll(`${p.title} ${p.text}`, q))
		.map((p) => ({ p, inTitle: matchesAll(p.title, q) }))
		.sort((a, b) => Number(b.inTitle) - Number(a.inTitle))
		.map(({ p }) => ({ collection: "pages", slug: p.slug, title: p.title }));
	return [...fts, ...extra];
}

/** The excerpt shown under a result's title. */
export function resultExcerpt(data: Record<string, unknown>, q: string, seoDescription?: string | null): string {
	const text = entryText(data, seoDescription);
	return text ? excerptAround(text, q) : "";
}

