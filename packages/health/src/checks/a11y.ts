/**
 * Accessibility check (text-based, no browser): rules read from the HTML the weekly visual check already fetched
 * (checks/visual.ts `stepVisual` calls `inspectA11y` on each page it reads — no extra request). Rule ids follow
 * axe-core's, as the kit's verify phase reports them (src/verify/browser.ts, src/phases/verify.ts), so a finding here
 * and a verify failure name the same thing:
 *
 *   image-alt            <img> without an alt attribute (alt="" is a decorative picture and fine)
 *   image-alt-filename   alt text that is just the file name ("IMG_1234.jpg", "hero-banner")
 *   page-has-heading-one no <h1>; multiple-h1: more than one <h1>
 *   heading-order        a heading two or more levels deeper than the one before (h2 → h4)
 *   link-name            a link with content (an icon, a picture) but no accessible name
 *   empty-link           a link with nothing inside at all
 *   button-name          a button without an accessible name
 *   label                a form field without a label (label[for], a wrapping label, aria-label/-labelledby, title,
 *                        placeholder — axe accepts a placeholder too)
 *   duplicate-id         the same id on two or more elements (outside inline SVG icons, which repeat their own ids)
 *   html-has-lang        <html> without a lang attribute
 *   frame-title          an <iframe> without a title (maps, videos, booking widgets)
 *
 * What is skipped on purpose: anything inside aria-hidden="true", `hidden`, <template>, <noscript>, <script>, <style>,
 * and the comments section (`id="comments"`: visitors' words never reach a finding). The starter's own decorative
 * markup is valid by construction — logo <img alt=""> inside a named link, the hidden form honeypot (aria-hidden), the
 * post-card picture link (aria-hidden, tabindex -1), the hidden motion preloader — and is not reported.
 *
 * A finding carries only a short element summary built from the site's own markup (tag, a file name, a path, a field
 * name, a heading text clipped to 50 characters) — never visitor data. Pure; facts: docs/spikes/health-findings.md.
 */
import { decode } from "./visual.js";

export type A11yRule = "image-alt" | "image-alt-filename" | "page-has-heading-one" | "multiple-h1" | "heading-order" | "link-name" | "empty-link" | "button-name" | "label" | "duplicate-id" | "html-has-lang" | "frame-title";

/** One finding on one page: the rule, a short element summary and how many times it occurs on that page. */
export interface A11yHit {
	r: A11yRule;
	el: string;
	n?: number;
}

/** The same issue (rule + element) grouped across pages: a footer link on every page is one item. */
export interface A11yItem {
	/** Stable id (rule + element), for dismissals. */
	id: string;
	r: A11yRule;
	el: string;
	/** Pages it was found on (checked pages only, at most MAX_VISUAL_PAGES). */
	pages: string[];
	/** Occurrences over all pages. */
	count: number;
}

/** Plain words per rule: a label, why it matters and how to fix it in the EmDash admin. */
export const A11Y_RULES: Record<A11yRule, { label: string; why: string; fix: string; weight: number }> = {
	"image-alt": { label: "Picture without a description", why: "Screen readers read out the file name or skip the picture, so blind visitors miss what it shows.", fix: "Edit the page (Content → Pages), select the picture and write a short alternative text saying what it shows. A picture that is only decoration can have an empty one.", weight: 3 },
	"image-alt-filename": { label: "Picture described by its file name", why: "Screen readers read the file name (“IMG 1234 jpg”) instead of what the picture shows.", fix: "In Media, open the picture and replace the alternative text with a short description; if it is placed in a page section, change it there too.", weight: 2 },
	"page-has-heading-one": { label: "No main heading (H1)", why: "Screen reader users jump to the main heading to find out what a page is about; search engines use it too.", fix: "Edit the page and set the first section's heading level to H1 (one per page).", weight: 2 },
	"multiple-h1": { label: "More than one main heading (H1)", why: "Several main headings make it unclear what the page is about, for screen readers and search engines.", fix: "Edit the page and keep H1 for the first heading only; set the other section headings to H2.", weight: 1 },
	"heading-order": { label: "Heading levels skipped", why: "Screen reader users move through a page by its headings; a jump (H2 straight to H4) suggests something is missing.", fix: "Edit the page and give the heading the next level down (after an H2 comes an H3). For a size change, use the heading size setting instead of a lower level.", weight: 1 },
	"link-name": { label: "Link without a name", why: "Screen readers announce just “link”, so visitors cannot tell where it goes (usually an icon or a picture without a description).", fix: "Give the icon or picture inside the link a description, or add a link label (for social icons: in Menus or the footer settings, fill in the label).", weight: 3 },
	"empty-link": { label: "Empty link", why: "The link has nothing in it: it is invisible to most visitors but screen readers and keyboards still stop on it.", fix: "Edit the page or menu and remove the empty link, or give it text.", weight: 2 },
	"button-name": { label: "Button without a name", why: "Screen readers announce just “button”, so visitors do not know what it does.", fix: "Give the button text (or a label in its settings). For an icon button, ask your developer to add a label.", weight: 3 },
	label: { label: "Form field without a label", why: "Visitors using a screen reader cannot tell what to type in the field, and tapping the label does not focus it.", fix: "Edit the form (the page's form section, or Plugins → Forms) and give the field a label; a label can be visually hidden if the design needs it.", weight: 3 },
	"duplicate-id": { label: "Duplicate element id", why: "Labels and links that point to an id can reach the wrong element, which confuses screen readers.", fix: "Usually a section was duplicated with a custom anchor id: edit the page and give each section's anchor a unique name. Otherwise ask your developer.", weight: 1 },
	"html-has-lang": { label: "Page language not set", why: "Screen readers read the page with the wrong voice and pronunciation.", fix: "Ask your developer to set the site language (kit setting language); it is added to every page.", weight: 3 },
	"frame-title": { label: "Embed without a title", why: "Screen readers announce an unnamed frame, so visitors do not know it is a map, a video or a booking form.", fix: "Edit the page's embed section and fill in its title (for example “Map to the studio”).", weight: 2 },
};

/** Per page: at most this many findings of one rule (the rest counted in `n` of the last one) and in total. */
export const A11Y_PER_RULE = 8;
export const A11Y_PER_PAGE = 40;
/** Grouped items kept (KV `review`). */
export const MAX_A11Y_ITEMS = 60;
/** HTML read per page (a larger page is cut; the visual check reads up to 1.5 MB). */
const MAX_A11Y_HTML = 600_000;
const MAX_NODES = 20_000;
const MAX_DEPTH = 200;

// ── A small HTML tree (good enough for rules; never executes anything) ────────────────────────────────────────

interface El {
	tag: string;
	attrs: Record<string, string>;
	kids: Node[];
	parent?: El;
	depth: number;
}
type Node = El | string;

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr", "param"]);
const RAW = new Set(["script", "style", "textarea", "title", "noscript", "template", "xmp"]);

function parseAttrs(s: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const m of s.matchAll(/([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
		const k = (m[1] as string).toLowerCase();
		if (!(k in out)) out[k] = decode(m[2] ?? m[3] ?? m[4] ?? "");
	}
	return out;
}

/** Parses HTML into a loose tree: unknown closes are ignored, unclosed elements end with their parent. Pure. */
export function parseHtml(html: string): El {
	const root: El = { tag: "#root", attrs: {}, kids: [], depth: 0 };
	let cur = root;
	let nodes = 0;
	const src = html.length > MAX_A11Y_HTML ? html.slice(0, MAX_A11Y_HTML) : html;
	const re = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\/([a-zA-Z][\w:-]*)\s*>|<([a-zA-Z][\w:-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>/g;
	let last = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(src)) && nodes < MAX_NODES) {
		if (m.index > last) cur.kids.push(src.slice(last, m.index));
		last = re.lastIndex;
		if (m[1]) {
			const tag = m[1].toLowerCase();
			for (let e: El | undefined = cur; e && e !== root; e = e.parent) {
				if (e.tag === tag) {
					cur = e.parent ?? root;
					break;
				}
			}
			continue;
		}
		if (!m[2]) continue;
		const tag = m[2].toLowerCase();
		const el: El = { tag, attrs: parseAttrs(m[3] ?? ""), kids: [], parent: cur, depth: cur.depth + 1 };
		cur.kids.push(el);
		nodes++;
		if (RAW.has(tag)) {
			const end = new RegExp(`</${tag}\\s*>`, "ig");
			end.lastIndex = last;
			const e = end.exec(src);
			const inner = src.slice(last, e ? e.index : src.length);
			if (tag === "title" || tag === "textarea") el.kids.push(inner);
			last = e ? end.lastIndex : src.length;
			re.lastIndex = last;
			continue;
		}
		// Nesting deeper than MAX_DEPTH is flattened (the rules recurse; a broken page must not exhaust the stack).
		if (!VOID.has(tag) && !m[4] && el.depth < MAX_DEPTH) cur = el;
	}
	if (last < src.length && nodes < MAX_NODES) cur.kids.push(src.slice(last));
	return root;
}

const isEl = (n: Node): n is El => typeof n !== "string";
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const squash = (s: string) => decode(s).replace(/\s+/g, " ").trim();

/** Skipped subtrees: hidden from everyone (or from assistive tech), not content, or visitors' comments. */
const skipped = (e: El) => e.attrs["aria-hidden"] === "true" || "hidden" in e.attrs || e.tag === "template" || e.tag === "noscript" || e.tag === "script" || e.tag === "style" || e.attrs.id === "comments" || (e.tag === "input" && e.attrs.type?.toLowerCase() === "hidden");

function walk(e: El, visit: (el: El) => void): void {
	for (const k of e.kids) {
		if (!isEl(k) || skipped(k)) continue;
		visit(k);
		walk(k, visit);
	}
}

/** Visible text of a subtree (aria-hidden parts left out), with picture alts and SVG titles as text. */
function nameText(e: El): string {
	let out = "";
	for (const k of e.kids) {
		if (!isEl(k)) out += ` ${k}`;
		else if (!skipped(k)) {
			if (k.tag === "img" || (k.tag === "input" && k.attrs.type === "image")) out += ` ${k.attrs.alt ?? ""} ${k.attrs["aria-label"] ?? ""}`;
			else if (k.tag === "svg") out += ` ${k.attrs["aria-label"] ?? ""} ${svgTitle(k)}`;
			else if (k.attrs["aria-label"]?.trim()) out += ` ${k.attrs["aria-label"]}`;
			else out += ` ${nameText(k)}`;
		}
	}
	return squash(out);
}
const svgTitle = (svg: El): string => {
	const t = svg.kids.find((k): k is El => isEl(k) && k.tag === "title");
	return t ? squash(t.kids.filter((k): k is string => typeof k === "string").join(" ")) : "";
};

/** Has any content at all (an element or non-blank text), aria-hidden or not. */
const hasContent = (e: El) => e.kids.some((k) => (isEl(k) ? true : k.trim().length > 0));

/** The site's own address as a path, another site's as host + path; scheme only for mail and phone links. */
function shortHref(href: string | undefined): string {
	const h = (href ?? "").trim();
	if (!h) return "";
	if (/^(mailto|tel|sms):/i.test(h)) return `${h.split(":")[0]?.toLowerCase()}:…`;
	if (h.startsWith("#")) return clip(h, 40);
	try {
		const u = new URL(h, "https://site.invalid");
		return clip(u.host === "site.invalid" ? u.pathname : `${u.host}${u.pathname}`, 60);
	} catch {
		return clip(h, 60);
	}
}

/** The file name a picture loads (EmDash's /_image?href=… names the original). */
export function fileName(src: string | undefined): string {
	const s = (src ?? "").trim();
	if (!s || /^data:/i.test(s)) return "";
	try {
		const u = new URL(s, "https://site.invalid");
		const p = u.pathname === "/_image" ? (new URL(u.searchParams.get("href") ?? "", "https://site.invalid").pathname ?? "") : u.pathname;
		return clip(decodeURIComponent(p.split("/").filter(Boolean).at(-1) ?? ""), 60);
	} catch {
		return clip(s.split("/").at(-1) ?? "", 60);
	}
}

/** Alt text that is just the file name or a camera / CMS default. */
export function altIsFileName(alt: string, src: string | undefined): boolean {
	const a = alt.trim().toLowerCase();
	if (!a) return false;
	if (/\.(jpe?g|png|webp|gif|svg|avif|heic|tiff?|bmp)$/.test(a)) return true;
	if (/^(img|image|dsc|dscn|dscf|pxl|photo|pic|screenshot|screen shot|untitled|wp-image)[\s_-]*\d[\d\s_-]*$/.test(a)) return true;
	const f = fileName(src).toLowerCase();
	const stem = f.replace(/\.[a-z0-9]+$/, "").replace(/-(\d+x\d+|scaled|e\d{6,})$/g, "");
	if (!stem || stem.length < 3) return false;
	const norm = (x: string) => x.replace(/[\s_-]+/g, "-");
	return norm(a) === norm(stem) || norm(a) === norm(f);
}

const elSummary = (e: El, extra = "") => {
	const cls = (e.attrs.class ?? "").split(/\s+/).filter(Boolean)[0];
	return `<${e.tag}${cls ? ` class="${clip(cls, 30)}"` : ""}${extra}>`;
};

/** The accessibility findings of one page's HTML. Pure. */
export function inspectA11y(html: string): A11yHit[] {
	if (!html) return [];
	const root = parseHtml(html);
	const hits: A11yHit[] = [];
	const perRule = new Map<A11yRule, number>();
	const add = (r: A11yRule, el: string) => {
		const same = hits.find((h) => h.r === r && h.el === el);
		if (same) {
			same.n = (same.n ?? 1) + 1;
			return;
		}
		const n = perRule.get(r) ?? 0;
		if (n >= A11Y_PER_RULE || hits.length >= A11Y_PER_PAGE) {
			const lastOf = [...hits].reverse().find((h) => h.r === r);
			if (lastOf) lastOf.n = (lastOf.n ?? 1) + 1;
			return;
		}
		perRule.set(r, n + 1);
		hits.push({ r, el });
	};

	// <html lang>
	let htmlEl: El | undefined;
	walk(root, (e) => {
		if (!htmlEl && e.tag === "html") htmlEl = e;
	});
	if (htmlEl && !htmlEl.attrs.lang?.trim() && !htmlEl.attrs["xml:lang"]?.trim()) add("html-has-lang", "<html>");

	// ids, labels (for=), headings
	const ids = new Map<string, number>();
	const labelFor = new Set<string>();
	const idText = new Map<string, string>();
	const headings: { level: number; text: string }[] = [];
	const inSvg = (e: El) => {
		for (let p = e.parent; p; p = p.parent) if (p.tag === "svg") return true;
		return false;
	};
	walk(root, (e) => {
		const id = e.attrs.id?.trim();
		if (id && !inSvg(e)) ids.set(id, (ids.get(id) ?? 0) + 1);
		if (id) idText.set(id, nameText(e));
		if (e.tag === "label" && e.attrs.for) labelFor.add(e.attrs.for.trim());
		const h = /^h([1-6])$/.exec(e.tag);
		if (h) headings.push({ level: Number(h[1]), text: clip(nameText(e), 50) });
	});
	for (const [id, n] of ids) if (n > 1) add("duplicate-id", `id="${clip(id, 40)}" (${n} times)`);

	const h1 = headings.filter((h) => h.level === 1).length;
	if (htmlEl || headings.length) {
		if (h1 === 0) add("page-has-heading-one", "No <h1> on the page");
		else if (h1 > 1) add("multiple-h1", `${h1} × <h1>`);
	}
	for (let i = 1; i < headings.length; i++) {
		const a = headings[i - 1] as { level: number };
		const b = headings[i] as { level: number; text: string };
		if (b.level - a.level >= 2) add("heading-order", `h${a.level} → h${b.level}: “${b.text || "(empty)"}”`);
	}

	const labelledby = (e: El) =>
		(e.attrs["aria-labelledby"] ?? "")
			.split(/\s+/)
			.filter(Boolean)
			.map((id) => idText.get(id) ?? "")
			.join(" ")
			.trim();
	const insideLabel = (e: El) => {
		for (let p = e.parent; p; p = p.parent) if (p.tag === "label") return true;
		return false;
	};

	walk(root, (e) => {
		const a = e.attrs;
		if (e.tag === "img") {
			const w = Number(a.width);
			const hgt = Number(a.height);
			if ((w > 0 && w <= 1) || (hgt > 0 && hgt <= 1)) return;
			if (a.role === "presentation" || a.role === "none") return;
			if (!("alt" in a)) {
				if (a["aria-label"]?.trim() || labelledby(e) || a.title?.trim()) return;
				add("image-alt", `<img src="…/${fileName(a.src) || "?"}">`);
			} else if (altIsFileName(a.alt ?? "", a.src)) add("image-alt-filename", `<img alt="${clip((a.alt ?? "").trim(), 40)}">`);
			return;
		}
		if (e.tag === "a" && "href" in a) {
			if (a["aria-label"]?.trim() || labelledby(e) || a.title?.trim()) return;
			if (nameText(e)) return;
			const target = shortHref(a.href);
			if (!hasContent(e)) add("empty-link", `<a href="${target}">`);
			else add("link-name", `<a href="${target}">${e.kids.some((k) => isEl(k) && (k.tag === "img" || k.tag === "picture")) ? " (picture without a description)" : " (icon only)"}`);
			return;
		}
		if (e.tag === "button" || (e.tag === "input" && ["button", "image"].includes((a.type ?? "").toLowerCase()))) {
			if (a["aria-label"]?.trim() || labelledby(e) || a.title?.trim()) return;
			if (e.tag === "input" && (a.type ?? "").toLowerCase() === "button" && a.value?.trim()) return;
			if (e.tag === "input" && (a.type ?? "").toLowerCase() === "image" && a.alt?.trim()) return;
			if (e.tag === "button" && nameText(e)) return;
			add("button-name", e.tag === "input" ? `<input type="${(a.type ?? "").toLowerCase()}">` : elSummary(e));
			return;
		}
		if (e.tag === "input" || e.tag === "select" || e.tag === "textarea") {
			const type = (a.type ?? "text").toLowerCase();
			if (e.tag === "input" && ["hidden", "submit", "reset", "button", "image"].includes(type)) return;
			if (a["aria-label"]?.trim() || labelledby(e) || a.title?.trim() || a.placeholder?.trim()) return;
			if (a.id && labelFor.has(a.id.trim())) return;
			if (insideLabel(e)) return;
			add("label", `<${e.tag}${e.tag === "input" ? ` type="${clip(type, 20)}"` : ""}${a.name ? ` name="${clip(a.name, 30)}"` : ""}>`);
			return;
		}
		if (e.tag === "iframe") {
			if (a.title?.trim() || a["aria-label"]?.trim() || labelledby(e)) return;
			add("frame-title", `<iframe src="${shortHref(a.src) || "?"}">`);
		}
	});
	return hits;
}

// ── Grouping across pages ───────────────────────────────────────────────────────────────────────────────────

/** A short stable id (FNV-1a, base 36) for dismissals. */
export function itemId(...parts: string[]): string {
	let h = 0x811c9dc5;
	for (const ch of parts.join("\u0000")) {
		h ^= ch.codePointAt(0) as number;
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(36).padStart(7, "0");
}

/** Groups per-page findings by rule + element: the same issue on many pages is one item, most pages first. Pure. */
export function groupA11y(pages: Record<string, A11yHit[] | undefined>, order: string[] = Object.keys(pages)): A11yItem[] {
	const byKey = new Map<string, A11yItem>();
	for (const path of order) {
		for (const h of pages[path] ?? []) {
			const key = `${h.r}\u0000${h.el}`;
			const it = byKey.get(key) ?? { id: itemId("a11y", h.r, h.el), r: h.r, el: h.el, pages: [], count: 0 };
			if (!it.pages.includes(path)) it.pages.push(path);
			it.count += h.n ?? 1;
			byKey.set(key, it);
		}
	}
	return [...byKey.values()].sort((a, b) => b.pages.length - a.pages.length || A11Y_RULES[b.r].weight - A11Y_RULES[a.r].weight || b.count - a.count).slice(0, MAX_A11Y_ITEMS);
}

/** An item on many pages: on 3 or more pages, or on at least half of the pages checked (2 of 2–4). */
export const isSiteWide = (it: Pick<A11yItem, "pages">, checked: number) => it.pages.length >= 3 || (checked >= 2 && it.pages.length >= Math.max(2, Math.ceil(checked / 2)));
