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
}
export interface Analysis {
	score: number;
	checks: Check[];
	serp: { title: string; titleCut: boolean; url: string; description: string; descriptionCut: boolean };
	words: number;
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

	// Length
	const n = wordList.length;
	add("length", "Text length", n >= 300 ? "good" : "warn", n >= 300 ? `${n} words.` : `${n} words: pages with under 300 words rarely rank for competitive searches (fine for contact or legal pages).`);

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
	};
}
