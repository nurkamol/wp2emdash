/**
 * On-page SEO analysis of one EmDash page (its section blocks and SEO fields). Pure: unit-tested in the kit.
 * Lengths follow what Google shows: about 60 characters of title and 155–160 of description on desktop.
 */
export type Status = "good" | "warn" | "bad" | "info";
export interface Check {
	id: string;
	label: string;
	status: Status;
	detail: string;
}
export interface PageSeo {
	title?: string | null;
	description?: string | null;
	image?: string | null;
	canonical?: string | null;
	noIndex?: boolean;
}
export interface Extracted {
	headings: { level: number; text: string }[];
	paragraphs: string[];
	images: { id?: string; alt?: string; name?: string }[];
	links: string[];
}
export interface AnalyzeInput {
	title: string;
	slug: string | null;
	seo?: PageSeo | null;
	content: unknown;
	siteName: string;
	separator: string;
	productionUrl: string;
	/** Other pages' effective titles (and page titles) and descriptions (duplicate check). */
	others: { title: string; pageTitle?: string; description?: string | null }[];
	focusKeyword?: string;
	/** Alt text from the media library, by media id. */
	altOf?: (id: string) => string | undefined;
	ogCards?: boolean;
	/** Page or site language (BCP 47, e.g. "en-US"). Reading level runs only for English; unknown → guessed from the text. */
	lang?: string;
}
export interface Analysis {
	score: number;
	checks: Check[];
	serp: { title: string; titleCut: boolean; url: string; description: string; descriptionCut: boolean };
	words: number;
	/** Published-and-indexable candidate for the "Pages that need more text" list: under THIN_WORDS, not a short-by-nature page, not hidden. */
	thin: boolean;
}

const TEXT_KEYS = new Set(["heading", "eyebrow", "intro", "text", "title", "question", "answer", "quote", "description", "summary", "caption", "body", "name", "role", "label", "value", "features"]);
const isPt = (v: unknown): v is { _type: "block"; style?: string; children?: { text?: string }[]; markDefs?: { href?: string }[] } => !!v && typeof v === "object" && (v as { _type?: string })._type === "block";
const isImage = (v: unknown) => !!v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string" && (typeof (v as { mimeType?: unknown }).mimeType === "string" ? String((v as { mimeType: string }).mimeType).startsWith("image/") : "provider" in (v as object));

/** Headings, text, images and links of a page's section blocks (EmDash Portable Text and section fields). */
export function extract(content: unknown): Extracted {
	const out: Extracted = { headings: [], paragraphs: [], images: [], links: [] };
	const walk = (v: unknown, key?: string): void => {
		if (Array.isArray(v)) return v.forEach((x) => walk(x, key));
		if (typeof v === "string") {
			if (key && TEXT_KEYS.has(key) && v.trim()) out.paragraphs.push(v.replace(/[#*_`>]/g, " ").trim());
			return;
		}
		if (!v || typeof v !== "object") return;
		if (isPt(v)) {
			const text = (v.children ?? []).map((c) => c.text ?? "").join("").trim();
			const h = /^h([1-6])$/.exec(v.style ?? "");
			if (text) (h ? out.headings.push({ level: Number(h[1]), text }) : out.paragraphs.push(text));
			for (const m of v.markDefs ?? []) if (m.href) out.links.push(m.href);
			return;
		}
		if (isImage(v)) {
			const img = v as { id: string; alt?: string; filename?: string };
			out.images.push({ id: img.id, ...(img.alt ? { alt: img.alt } : {}), ...(img.filename ? { name: img.filename } : {}) });
			return;
		}
		const o = v as Record<string, unknown>;
		const type = typeof o._type === "string" ? o._type : "";
		if (type.startsWith("section_") && typeof o.heading === "string" && o.heading.trim()) {
			const lvl = /^h([1-6])$/.exec(String(o.heading_level ?? ""))?.[1];
			out.headings.push({ level: lvl ? Number(lvl) : type === "section_hero" ? 1 : 2, text: o.heading.trim() });
		}
		for (const [k, x] of Object.entries(o)) {
			if (type.startsWith("section_") && k === "heading") continue;
			if ((k === "url" || k === "link_url" || k === "button_url" || k === "href") && typeof x === "string" && x) out.links.push(x);
			else walk(x, k);
		}
	};
	walk(content);
	return out;
}

const words = (s: string) => s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");

/**
 * Text length thresholds. Under 150 words a page meant to rank gives Google little to go on (audits call it thin
 * content); under 300 it rarely ranks for competitive searches. Contact, legal, thank-you and similar pages are short
 * by nature, so for them length is only noted, never scored.
 */
export const THIN_WORDS = 300;
export const VERY_THIN_WORDS = 150;
// Whole slug or its last segment ("legal/terms"), so "contact-lens-guide" still counts as a page meant to rank.
const SHORT_BY_NATURE = /(^|\/)(contact|contact-us|privacy|privacy-policy|terms|terms-of-service|terms-and-conditions|legal|imprint|impressum|cookies|cookie-policy|disclaimer|accessibility|accessibility-statement|thank-you|thanks|confirmation|success|404|not-found|login|sitemap)\/?$/;
export const isShortByNature = (slug: string | null) => !!slug && SHORT_BY_NATURE.test(slug.toLowerCase());

/** Below this, word shares and reading level swing wildly on one sentence: we say so instead of judging. */
const MIN_WORDS_REPETITION = 80;
const MIN_WORDS_READING = 30;
/** One meaningful word above this share of all words reads as keyword stuffing to audit tools. */
const REPEAT_SHARE = 4;
/** Flesch–Kincaid grade above which most visitors find the text hard (US grade 12 ≈ end of high school). */
const MAX_GRADE = 12;

// Small English stop-word list: enough to skip the glue words when looking for an overused word, and to guess English.
const STOP = new Set("a about after all also an and any are as at be been but by can do does for from get has have he her his how i if in into is it its just more most my no not of on one or our out over she so than that the their them then there these they this to up us was we were what when which who will with you your".split(" "));

/** Rough English syllable count (the usual vowel-group heuristic: good enough for a grade estimate). */
export function syllables(word: string): number {
	const w = word.toLowerCase().replace(/[^a-z]/g, "");
	if (!w) return 0;
	if (w.length <= 3) return 1;
	const m = w.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, "").replace(/^y/, "").match(/[aeiouy]{1,2}/g);
	return Math.max(1, m?.length ?? 0);
}

/** Flesch–Kincaid grade of a set of text blocks (each block ends at least one sentence: labels and buttons have no full stop). */
export function readingGrade(blocks: string[]): { grade: number; words: number; sentences: number } {
	let ws = 0;
	let ss = 0;
	let syl = 0;
	for (const b of blocks) {
		const parts = b.split(/[.!?;:]+(?=\s|$)/).map((p) => words(p)).filter((p) => p.length);
		ss += parts.length;
		for (const p of parts) for (const w of p) (ws++, (syl += syllables(w)));
	}
	const grade = ws && ss ? 0.39 * (ws / ss) + 11.8 * (syl / ws) - 15.59 : 0;
	return { grade: Math.max(0, Math.round(grade * 10) / 10), words: ws, sentences: ss };
}

/** True when the language tag is English, or (no tag) the text uses enough common English words. */
export function looksEnglish(text: string, lang?: string): boolean {
	if (lang?.trim()) return /^en\b/i.test(lang.trim());
	const ws = words(text.toLowerCase());
	if (ws.length < 10) return false;
	return ws.filter((w) => STOP.has(w.replace(/[^\p{L}']/gu, ""))).length / ws.length >= 0.12;
}

/** The most frequent meaningful word (stop words, numbers and 1–2 letter words skipped) and its share of all words, in %. */
export function topWord(ws: string[]): { word: string; count: number; share: number } | undefined {
	const counts = new Map<string, number>();
	for (const raw of ws) {
		const w = norm(raw).replace(/[^\p{L}\p{N}'-]/gu, "").replace(/^['-]+|['-]+$/g, "");
		if (w.length < 3 || STOP.has(w) || !/\p{L}/u.test(w)) continue;
		counts.set(w, (counts.get(w) ?? 0) + 1);
	}
	let best: [string, number] | undefined;
	for (const e of counts) if (!best || e[1] > best[1]) best = e;
	return best && ws.length ? { word: best[0], count: best[1], share: (best[1] * 100) / ws.length } : undefined;
}


/**
 * The <title> the layout renders: the page title, plus " <sep> Site" unless it already names the site. An SEO title of
 * its own (`pageTitle` given and different) is used as written.
 */
export function fullTitle(title: string, siteName: string, separator: string, pageTitle?: string): string {
	if (pageTitle !== undefined && title.trim() !== pageTitle.trim()) return title;
	return title.includes(siteName) ? title : `${title} ${separator} ${siteName}`;
}

export function analyze(i: AnalyzeInput): Analysis {
	const x = extract(i.content);
	const checks: Check[] = [];
	const add = (id: string, label: string, status: Status, detail: string) => checks.push({ id, label, status, detail });
	const seoTitle = i.seo?.title?.trim() || i.title.trim();
	const title = fullTitle(seoTitle, i.siteName, i.separator, i.title.trim());
	const description = i.seo?.description?.trim() ?? "";
	const host = URL.canParse(i.productionUrl) ? new URL(i.productionUrl).host : i.productionUrl;
	const path = i.slug && i.slug !== "index" && i.slug !== "home" ? `/${i.slug}/` : "/";
	const allText = [...x.headings.map((h) => h.text), ...x.paragraphs].join(" ");
	const wordList = words(allText);
	const h1 = x.headings.filter((h) => h.level === 1);

	// Title
	if (title.length > 70) add("title", "SEO title", "bad", `${title.length} characters: Google cuts titles at about 60, so the end will not show.`);
	else if (title.length > 60) add("title", "SEO title", "warn", `${title.length} characters: may be cut at about 60.`);
	else if (title.length < 30) add("title", "SEO title", "warn", `${title.length} characters: short. A clear 40–60 character title earns more clicks.`);
	else add("title", "SEO title", "good", `${title.length} characters.`);
	if (!i.seo?.title?.trim()) add("title-set", "Own SEO title", "info", "No SEO title set: the page title is used.");

	// Description
	if (!description) add("description", "Meta description", "bad", "Missing: Google picks a random snippet from the page. Write 120–160 characters that make people click.");
	else if (description.length > 200) add("description", "Meta description", "bad", `${description.length} characters: much longer than Google shows (about 160).`);
	else if (description.length > 160) add("description", "Meta description", "warn", `${description.length} characters: may be cut at about 160.`);
	else if (description.length < 70) add("description", "Meta description", "warn", `${description.length} characters: short. Aim for 120–160.`);
	else add("description", "Meta description", "good", `${description.length} characters.`);

	// Duplicates across the site
	const sameTitle = i.others.filter((o) => norm(fullTitle(o.title, i.siteName, i.separator, o.pageTitle)) === norm(title)).length;
	const sameDesc = description ? i.others.filter((o) => o.description && norm(o.description) === norm(description)).length : 0;
	if (sameTitle || sameDesc) add("unique", "Unique title and description", "bad", [sameTitle ? `${sameTitle} other page${sameTitle > 1 ? "s have" : " has"} the same title` : "", sameDesc ? `${sameDesc} other page${sameDesc > 1 ? "s have" : " has"} the same description` : ""].filter(Boolean).join("; ") + ".");
	else add("unique", "Unique title and description", "good", "No other page uses them.");

	// Headings
	if (h1.length === 1) add("h1", "One main heading (H1)", "good", `“${cut(h1[0]?.text ?? "", 60)}”`);
	else if (!h1.length) add("h1", "One main heading (H1)", "bad", "No H1: set the first section's heading level to H1.");
	else add("h1", "One main heading (H1)", "warn", `${h1.length} H1 headings: keep one and make the others H2.`);
	const skips: string[] = [];
	x.headings.reduce((prev, h) => {
		if (prev && h.level > prev + 1) skips.push(`H${prev} → H${h.level} (“${cut(h.text, 30)}”)`);
		return h.level;
	}, 0);
	add("heading-order", "Heading order", skips.length ? "warn" : "good", skips.length ? `Skips a level: ${skips.slice(0, 3).join(", ")}.` : "No skipped levels.");

	// Length: home and service pages need text to rank; contact, legal and thank-you pages are short by nature (noted only).
	const n = wordList.length;
	const shortOk = isShortByNature(i.slug);
	if (n >= THIN_WORDS) add("length", "Text length", "good", `${n} words.`);
	else if (shortOk) add("length", "Text length", "info", `${n} words: fine for this kind of page, which does not need to rank.`);
	else if (n < VERY_THIN_WORDS) add("length", "Text length", "bad", `Only ${n} words: Google sees too little here to rank the page. Add at least ${THIN_WORDS - n} words: what you offer, who it is for, prices or what to expect, and common questions.`);
	else add("length", "Text length", "warn", `${n} words: pages under ${THIN_WORDS} words rarely rank for competitive searches. Add a few paragraphs (e.g. a short FAQ) to reach ${THIN_WORDS}.`);

	// Repetition: the focus keyword check covers its own words, so this looks at the most-used other word.
	const kwWords = new Set(words(norm(i.focusKeyword ?? "")).map((w) => w.replace(/[^\p{L}\p{N}'-]/gu, "")));
	if (n < MIN_WORDS_REPETITION) add("repetition", "Repeated words", "info", `Too little text to judge (${n} words). Once the page has more text, check that no word is overused.`);
	else {
		const top = topWord(wordList);
		if (top && top.share > REPEAT_SHARE && !kwWords.has(top.word)) add("repetition", "Repeated words", "warn", `“${top.word}” is ${top.share.toFixed(1)}% of the text (${top.count} times): it can look like keyword stuffing. Use it less often, or swap some for other words people would search for.`);
		else add("repetition", "Repeated words", "info", "No word is overused.");
	}

	// Reading level (English only): Flesch–Kincaid grade of the body text.
	// Too little text to tell the language either: say so, unless the site is known not to be English.
	const r = readingGrade(x.paragraphs);
	if (r.words < MIN_WORDS_READING) {
		if (!i.lang?.trim() || looksEnglish("", i.lang)) add("reading", "Easy to read", "info", "Too little text to judge.");
	} else if (looksEnglish(allText, i.lang)) {
		if (r.grade > MAX_GRADE) add("reading", "Easy to read", "warn", `Reading level: grade ${r.grade.toFixed(0)} (hard; most visitors read comfortably at grade 8–10). Use shorter sentences (under 20 words) and everyday words instead of long ones.`);
		else add("reading", "Easy to read", "info", `Reading level: grade ${r.grade.toFixed(0)}${r.grade <= 9 ? " (easy to read)" : " (fine; shorter sentences make it easier still)"}.`);
	}

	// Images
	const missingAlt = x.images.filter((im) => !im.alt?.trim() && !(im.id && i.altOf?.(im.id)?.trim()));
	if (!x.images.length) add("alt", "Image descriptions (alt text)", "info", "No images in the sections.");
	else add("alt", "Image descriptions (alt text)", missingAlt.length ? "warn" : "good", missingAlt.length ? `${missingAlt.length} of ${x.images.length} images have no description${missingAlt[0]?.name ? ` (e.g. ${missingAlt[0].name})` : ""}. Add it in the media library: it helps image search and people using screen readers.` : `All ${x.images.length} images described.`);

	// Links
	const internal = x.links.filter((l) => l.startsWith("/") || l.includes(host));
	const external = x.links.filter((l) => /^https?:/.test(l) && !l.includes(host));
	add("links", "Links to other pages", internal.length ? "good" : "warn", internal.length ? `${internal.length} internal, ${external.length} external.` : "No links to other pages of the site: link related pages so visitors and Google find them.");

	// Address
	const slug = i.slug ?? "";
	if (/[A-Z_ ]/.test(slug) || slug.length > 75) add("slug", "Page address", "warn", "Use short lowercase words separated by hyphens.");
	else add("slug", "Page address", "good", `${host}${path}`);

	// Indexing and canonical
	if (i.seo?.noIndex) add("index", "Shown in Google", "warn", "“Hide from search engines” is on: this page will not appear in Google.");
	else add("index", "Shown in Google", "good", "Indexable.");
	const own = `${i.productionUrl.replace(/\/$/, "")}${path}`;
	if (i.seo?.canonical && i.seo.canonical.replace(/\/$/, "") !== own.replace(/\/$/, "")) add("canonical", "Canonical address", "warn", `Points to ${i.seo.canonical}: Google will treat that page as the original.`);

	// Sharing image
	add("social", "Sharing image", i.seo?.image || i.ogCards ? "good" : "warn", i.seo?.image ? "Set." : i.ogCards ? "A branded card is made automatically." : "None: shared links show no picture. Set one in the page's SEO fields.");

	// Focus keyword
	const kw = i.focusKeyword?.trim();
	if (kw) {
		const k = norm(kw);
		const has = (s: string) => norm(s).includes(k);
		const first = wordList.slice(0, 100).join(" ");
		const hits = (norm(allText).match(new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length;
		const density = n ? (hits * words(kw).length * 100) / n : 0;
		const where: [string, boolean][] = [["SEO title", has(title)], ["description", has(description)], ["H1", h1.some((h) => has(h.text))], ["first paragraph", has(first)], ["address", has(slug.replace(/-/g, " "))]];
		const missing = where.filter(([, ok]) => !ok).map(([w]) => w);
		add("keyword", `Focus keyword “${kw}”`, missing.length > 2 ? "bad" : missing.length ? "warn" : "good", missing.length ? `Not in: ${missing.join(", ")}.` : "In the title, description, H1, first paragraph and address.");
		add("keyword-density", "Keyword use", density === 0 ? "bad" : density > 3 ? "warn" : density < 0.5 ? "warn" : "good", `${hits} time${hits === 1 ? "" : "s"} (${density.toFixed(1)}%): aim for natural use, about 0.5–3%.`);
	}

	const scored = checks.filter((c) => c.status !== "info");
	const score = scored.length ? Math.round((100 * scored.reduce((s, c) => s + (c.status === "good" ? 1 : c.status === "warn" ? 0.5 : 0), 0)) / scored.length) : 0;
	return {
		score,
		checks,
		serp: { title: cut(title, 60), titleCut: title.length > 60, url: `${host}${path === "/" ? "" : ` › ${path.replace(/^\/|\/$/g, "").split("/").join(" › ")}`}`, description: cut(description || x.paragraphs.join(" "), 160), descriptionCut: (description || x.paragraphs.join(" ")).length > 160 },
		words: n,
		thin: n < THIN_WORDS && !shortOk && !i.seo?.noIndex,
	};
}
