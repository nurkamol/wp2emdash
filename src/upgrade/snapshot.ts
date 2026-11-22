/**
 * `wp2emdash upgrade`: structural snapshots of a delivered site's pages and the page-by-page comparison between two
 * of them (before the kit upgrade vs after it). Pure functions — no network, no files — so they are unit-tested;
 * src/commands/upgrade.ts does the fetching and writing.
 *
 * A snapshot is what a visitor and a search engine get from each page: status, title, meta description, h1s,
 * <html lang>, the number of hreflang alternates, the visible text (hash + word count + a capped copy for the report),
 * the number of links, images and forms, and which stylesheets, scripts and font families the page uses.
 *
 * Expected noise is normalised away before comparing, so a kit upgrade that only rebuilt the assets compares equal:
 * asset hashes in file names (`index.DkPz3Q1a.css`), cache-busting query strings (`?v=…`, `?ver=…`), the footer
 * copyright year (`© 2025` → `© 2026`), the kit's version string, and inline nonces (never part of visible text).
 * Pages are keyed by path (pathname + search), so a staging host and the production domain compare equal.
 */
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";

export interface PageSnapshot {
	/** Site path (pathname + search), host removed. */
	path: string;
	/** HTTP status (0 = no answer). */
	status: number;
	/** Redirect target as a path (same host) or full URL (other host), for 3xx answers. */
	location?: string;
	error?: string;
	title: string;
	description: string;
	h1: string[];
	lang: string;
	hreflang: number;
	/** sha256 (16 hex) of the normalised visible text. */
	textHash: string;
	words: number;
	/** Normalised visible text, capped (TEXT_CAP), so a report can show where it changed. */
	text: string;
	links: number;
	images: number;
	forms: number;
	/** Normalised stylesheet paths (asset hashes and query strings removed), sorted. */
	stylesheets: string[];
	/** Normalised script paths, sorted (inline scripts are not listed). */
	scripts: string[];
	/** Font families the page uses: @font-face in inline/linked CSS, Google Fonts families, Adobe Fonts (typekit). Lower case, sorted. */
	fonts: string[];
}

export interface SiteSnapshot {
	/** Origin the snapshot was taken from (https://example.com). */
	origin: string;
	label: string;
	takenAt: string;
	/** Kit version that took it (package.json). */
	kitVersion?: string;
	pages: PageSnapshot[];
	/** Pages listed in the sitemap but not snapshotted (over the page cap). */
	skipped?: number;
	sitemap: { status: number; urls: number };
}

export const TEXT_CAP = 8000;

const clean = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

/** Year / version noise that changes with every rebuild without being a content change. */
export function normalizeText(s: string): string {
	return clean(s)
		.replace(/(©|&copy;|\(c\)|copyright)\s*(\d{4})(\s*[–—-]\s*\d{4})?/gi, (_m, sym: string) => `${sym} YEAR`)
		.replace(/\b(wp2emdash|emdash)\s+v?\d+\.\d+\.\d+(?:-[\w.]+)?/gi, (_m, name: string) => `${name} VERSION`);
}

/**
 * An asset address without what a rebuild changes: host (same-origin assets only, others keep their host), query
 * string, and content hashes in the file name (`Layout.DkPz3Q1a.css`, `chunk-4f9a1b2c.js`, `app.4f9a1b2c3d.css`).
 */
export function normalizeAsset(href: string, base: string): string {
	let u: URL;
	try {
		u = new URL(href, base);
	} catch {
		return href;
	}
	const sameOrigin = u.origin === new URL(base).origin;
	const path = u.pathname
		// Astro / Vite: name.<8 url-safe chars>.ext (with at least one digit or upper-case letter, so `site.min.css` stays)
		.replace(/\.([A-Za-z0-9_-]{8,12})(?=\.[a-z0-9]+$)/g, (m, h: string) => (/[0-9A-Z]/.test(h) ? ".HASH" : m))
		// name-<hex 8+>.ext / name.<hex 8+>.ext
		.replace(/[.-][a-f0-9]{8,}(?=\.[a-z0-9]+$)/g, ".HASH");
	return sameOrigin ? path : `${u.host}${path}`;
}

/** Font families defined by @font-face rules in a stylesheet, lower case. */
export function fontFamiliesFromCss(css: string): string[] {
	const out = new Set<string>();
	for (const m of css.matchAll(/@font-face\s*\{[^}]*?font-family:\s*["']?([^;"'}]+)["']?/gi)) out.add(m[1]?.trim().toLowerCase() ?? "");
	out.delete("");
	return [...out].sort();
}

/** Google Fonts families named in a css2/css address (`family=Inter:wght@400;700&family=Lora`). */
function googleFamilies(href: string): string[] {
	const out: string[] = [];
	try {
		const u = new URL(href.replace(/&amp;/g, "&"));
		for (const f of u.searchParams.getAll("family")) for (const part of f.split("|")) out.push(part.split(":")[0]?.replace(/\+/g, " ").trim().toLowerCase() ?? "");
	} catch {
		// not a URL
	}
	return out.filter(Boolean);
}

const textHash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/**
 * HTML → page snapshot. `url` is the address the page was fetched from (for relative assets and the path key).
 * `linkedCss` (optional): text of the page's stylesheets, for @font-face families.
 */
export function htmlToSnapshot(html: string, url: string, status = 200, linkedCss: string[] = []): PageSnapshot {
	const $ = cheerio.load(html);
	const u = new URL(url);
	const path = u.pathname + u.search;
	const title = normalizeText($("head > title").first().text() || $("title").first().text());
	const description = clean($('meta[name="description"]').first().attr("content"));
	const lang = clean($("html").attr("lang")).toLowerCase();
	const hreflang = $('link[rel~="alternate"][hreflang]').length;
	const stylesheets = new Set<string>();
	const fonts = new Set<string>();
	$('link[rel~="stylesheet"][href]').each((_, el) => {
		const href = $(el).attr("href") ?? "";
		stylesheets.add(normalizeAsset(href, url));
		if (/fonts\.googleapis\.com\/css/.test(href)) for (const f of googleFamilies(new URL(href, url).href)) fonts.add(f);
		if (/use\.typekit\.net\//.test(href)) fonts.add("adobe-fonts");
	});
	const scripts = new Set<string>();
	$("script[src]").each((_, el) => {
		scripts.add(normalizeAsset($(el).attr("src") ?? "", url));
	});
	for (const css of [...$("style").map((_, el) => $(el).text()).get(), ...linkedCss]) for (const f of fontFamiliesFromCss(css)) fonts.add(f);

	const counts = { links: $("a[href]").length, images: $("img").length, forms: $("form").length };
	const h1 = $("h1")
		.map((_, el) => normalizeText($(el).text()))
		.get()
		.filter(Boolean);

	// Visible text: body text nodes, without scripts, styles, templates, inline SVG and noscript fallbacks.
	$("script, style, noscript, template, svg, head").remove();
	const parts: string[] = [];
	const walk = (nodes: ReturnType<typeof $>) => {
		nodes.contents().each((_, n) => {
			if (n.type === "text") parts.push((n as unknown as { data: string }).data);
			else if (n.type === "tag") walk($(n));
		});
	};
	walk($("body").length ? $("body") : $.root());
	const text = normalizeText(parts.join(" "));
	return {
		path,
		status,
		title,
		description,
		h1,
		lang,
		hreflang,
		textHash: textHash(text),
		words: text ? text.split(" ").length : 0,
		text: text.slice(0, TEXT_CAP),
		...counts,
		stylesheets: [...stylesheets].sort(),
		scripts: [...scripts].sort(),
		fonts: [...fonts].sort(),
	};
}

/** A page that did not answer with HTML (redirect, error, no answer). */
export function statusSnapshot(url: string, status: number, extra: { location?: string; error?: string } = {}): PageSnapshot {
	const u = new URL(url);
	return { path: u.pathname + u.search, status, ...extra, title: "", description: "", h1: [], lang: "", hreflang: 0, textHash: "", words: 0, text: "", links: 0, images: 0, forms: 0, stylesheets: [], scripts: [], fonts: [] };
}

/** <loc> entries of a sitemap or sitemap index. */
export function sitemapLocs(xml: string): string[] {
	return [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\s\]]+)\s*(?:\]\]>)?\s*<\/loc>/g)].map((m) => (m[1] ?? "").replace(/&amp;/g, "&"));
}

/** A redirect target as a path when it stays on the same host, else the full URL. */
export function locationKey(location: string | null | undefined, url: string): string | undefined {
	if (!location) return undefined;
	try {
		const t = new URL(location, url);
		return t.host === new URL(url).host ? t.pathname + t.search : t.href;
	} catch {
		return location;
	}
}

// ── comparison ──────────────────────────────────────────────────────────────────────────────────────────

export type FieldName = "missing" | "status" | "location" | "title" | "description" | "h1" | "lang" | "hreflang" | "text" | "links" | "images" | "forms" | "stylesheets" | "scripts" | "fonts" | "new";

export interface Difference {
	field: FieldName;
	before: string | number;
	after: string | number;
	/** For text: a short excerpt around the first change. */
	detail?: string;
}

export interface PageComparison {
	path: string;
	/** Changes that need a look: a failed upgrade looks like this. */
	differences: Difference[];
	/** Changes that are reported but expected after a kit upgrade (asset files renamed or added, a font added, new page). */
	notices: Difference[];
}

export interface Comparison {
	before: { origin: string; label: string; takenAt: string; pages: number };
	after: { origin: string; label: string; takenAt: string; pages: number };
	/** true when nothing but expected changes. */
	identical: boolean;
	pagesCompared: number;
	pagesWithDifferences: number;
	pagesWithNotices: number;
	pages: PageComparison[];
}

/** Where two texts first differ, as two short excerpts. */
export function firstTextChange(a: string, b: string, context = 60): string {
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	const from = Math.max(0, i - context);
	const cut = (s: string) => `${from > 0 ? "…" : ""}${s.slice(from, i + context)}${i + context < s.length ? "…" : ""}`;
	return `before: "${cut(a)}" · after: "${cut(b)}"`;
}

const list = (a: string[]) => a.join(", ") || "(none)";

/** One page, before vs after. */
export function comparePage(b: PageSnapshot, a: PageSnapshot): PageComparison {
	const differences: Difference[] = [];
	const notices: Difference[] = [];
	const diff = (field: FieldName, before: string | number, after: string | number, detail?: string) => {
		if (before !== after) differences.push({ field, before, after, ...(detail ? { detail } : {}) });
	};
	diff("status", b.status, a.status);
	if (b.status >= 300 && b.status < 400) diff("location", b.location ?? "", a.location ?? "");
	if (b.status !== 200 || a.status !== 200) return { path: b.path, differences, notices };
	diff("title", b.title, a.title);
	diff("description", b.description, a.description);
	diff("h1", b.h1.join(" | "), a.h1.join(" | "));
	diff("lang", b.lang, a.lang);
	diff("hreflang", b.hreflang, a.hreflang);
	if (b.textHash !== a.textHash) differences.push({ field: "text", before: `${b.words} words`, after: `${a.words} words`, detail: firstTextChange(b.text, a.text) });
	diff("links", b.links, a.links);
	diff("images", b.images, a.images);
	diff("forms", b.forms, a.forms);
	// Assets: a kit upgrade may rename, add or drop bundles — reported, not failing, unless the page lost all stylesheets.
	const sets = (field: "stylesheets" | "scripts") => {
		const before = b[field];
		const after = a[field];
		if (before.join("\n") === after.join("\n")) return;
		const entry = { field, before: list(before), after: list(after) };
		if (field === "stylesheets" && before.length && !after.length) differences.push({ ...entry, detail: "the page has no stylesheet any more" });
		else notices.push(entry);
	};
	sets("stylesheets");
	sets("scripts");
	// Fonts: one lost is a difference (visitors would see a fallback font); one gained is a notice.
	const lost = b.fonts.filter((f) => !a.fonts.includes(f));
	const gained = a.fonts.filter((f) => !b.fonts.includes(f));
	if (lost.length) differences.push({ field: "fonts", before: list(b.fonts), after: list(a.fonts), detail: `lost: ${lost.join(", ")}` });
	else if (gained.length) notices.push({ field: "fonts", before: list(b.fonts), after: list(a.fonts), detail: `added: ${gained.join(", ")}` });
	return { path: b.path, differences, notices };
}

/** Every page of `before`, compared with the same path in `after`. Pages only in `after` are notices. */
export function compareSnapshots(before: SiteSnapshot, after: SiteSnapshot): Comparison {
	const afterBy = new Map(after.pages.map((p) => [p.path, p]));
	const beforePaths = new Set(before.pages.map((p) => p.path));
	const pages: PageComparison[] = [];
	for (const b of before.pages) {
		const a = afterBy.get(b.path);
		if (!a) pages.push({ path: b.path, differences: [{ field: "missing", before: b.status, after: "not checked", detail: "the page was not found in the second snapshot" }], notices: [] });
		else pages.push(comparePage(b, a));
	}
	for (const a of after.pages) if (!beforePaths.has(a.path)) pages.push({ path: a.path, differences: [], notices: [{ field: "new", before: "", after: a.status, detail: "page only in the second snapshot" }] });
	const head = (s: SiteSnapshot) => ({ origin: s.origin, label: s.label, takenAt: s.takenAt, pages: s.pages.length });
	const pagesWithDifferences = pages.filter((p) => p.differences.length).length;
	return {
		before: head(before),
		after: head(after),
		identical: pagesWithDifferences === 0,
		pagesCompared: before.pages.length,
		pagesWithDifferences,
		pagesWithNotices: pages.filter((p) => p.notices.length).length,
		pages,
	};
}

const md = (v: string | number) => String(v).replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 300);

/** Short markdown report of a comparison. */
export function comparisonReport(c: Comparison, title: string): string {
	const lines = [
		`# ${title}`,
		"",
		`- Before: ${c.before.label} — ${c.before.origin} (${c.before.takenAt}, ${c.before.pages} pages)`,
		`- After: ${c.after.label} — ${c.after.origin} (${c.after.takenAt}, ${c.after.pages} pages)`,
		`- Result: **${c.identical ? "identical (only expected changes)" : `${c.pagesWithDifferences} page(s) with differences`}** · ${c.pagesCompared} compared · ${c.pagesWithNotices} with expected changes`,
		"",
		"Ignored as expected: asset hashes in file names, cache-busting query strings, the copyright year, the kit version. Pages are compared by path, so the host does not matter.",
		"",
	];
	const changed = c.pages.filter((p) => p.differences.length);
	if (changed.length) {
		lines.push("## Differences", "", "| Page | What | Before | After | Detail |", "|---|---|---|---|---|");
		for (const p of changed) for (const d of p.differences) lines.push(`| ${md(p.path)} | ${d.field} | ${md(d.before)} | ${md(d.after)} | ${md(d.detail ?? "")} |`);
		lines.push("");
	}
	const noticed = c.pages.filter((p) => p.notices.length);
	if (noticed.length) {
		lines.push("## Expected changes (not failing)", "", "| Page | What | Detail |", "|---|---|---|");
		for (const p of noticed.slice(0, 100)) for (const d of p.notices) lines.push(`| ${md(p.path)} | ${d.field} | ${md(d.detail ?? `${d.before} → ${d.after}`)} |`);
		if (noticed.length > 100) lines.push(`| … | | ${noticed.length - 100} more pages |`);
		lines.push("");
	}
	return lines.join("\n");
}
