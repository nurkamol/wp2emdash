/**
 * HTML → Portable Text for the subset WordPress content uses: paragraphs, headings, lists (nested),
 * blockquotes, links, strong/em/underline/code, line breaks. Images and other embedded media inside
 * rich text are returned separately so the caller can place them as media.
 */
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import type { PtBlock, PtLinkDef, PtSpan, RichText } from "./schema.js";

/** Deterministic keys so reruns and golden tests are stable. */
export class Keys {
	private n = 0;
	constructor(private prefix = "k") {}
	next(): string {
		return `${this.prefix}${(this.n++).toString(36)}`;
	}
}

export interface PtResult {
	blocks: RichText;
	images: { src: string; alt?: string; wpId?: number }[];
	/** Things that were not representable (iframes, scripts, forms, tables…), as raw HTML. */
	leftovers: { tag: string; html: string }[];
}

type Style = PtBlock["style"];
const HEADING: Record<string, Style> = { h1: "h1", h2: "h2", h3: "h3", h4: "h4", h5: "h5", h6: "h6" };
const MARK: Record<string, string> = { strong: "strong", b: "strong", em: "em", i: "em", u: "underline", code: "code", s: "strike-through", del: "strike-through", mark: "highlight", sup: "sup", sub: "sub" };
const BLOCK_TAGS = new Set(["p", "div", "section", "article", "header", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote", "figure", "figcaption", "center", "address", "pre", "main", "aside", "nav"]);
const LEFTOVER_TAGS = new Set(["iframe", "script", "style", "form", "table", "video", "audio", "object", "embed", "svg", "noscript", "canvas", "select", "input", "button", "textarea"]);

const decodeEntities = (s: string) => cheerio.load(`<i>${s}</i>`, null, false)("i").text();

/** Whitespace-normalise like a browser does for inline text. */
const collapse = (s: string) => s.replace(/[\t\n\r ]+/g, " ");

const AUTOP_BLOCK = "p|h[1-6]|ul|ol|li|div|blockquote|table|thead|tbody|tr|td|th|figure|figcaption|section|article|aside|header|footer|nav|main|pre|form|fieldset|address|dl|dt|dd|hr|details|summary|iframe|script|style|video|audio";

/**
 * wpautop, as WordPress does it: raw post_content stores paragraphs as blank lines and line breaks
 * as single newlines. Block-level tags are separated onto their own chunks; bare text chunks become
 * <p> with <br> for single newlines (not after an existing <br>, as WordPress does). Content that is already wrapped is left alone.
 */
export function autop(html: string): string {
	if (!/\n/.test(html)) return html;
	const spaced = html.replace(new RegExp(`(<(?:${AUTOP_BLOCK})\\b[^>]*>)`, "gi"), "\n\n$1").replace(new RegExp(`(</(?:${AUTOP_BLOCK})>)`, "gi"), "$1\n\n");
	return spaced
		.split(/\n\s*\n/)
		.map((c) => c.trim())
		.filter(Boolean)
		.map((c) => (new RegExp(`^</?(?:${AUTOP_BLOCK})\\b`, "i").test(c) ? c : `<p>${c.replace(/(?:<br\s*\/?>)?[ \t]*\n/gi, "<br>")}</p>`))
		.join("\n");
}

export function htmlToPortableText(html: string, keys: Keys, opts: { defaultStyle?: Style } = {}): PtResult {
	const $ = cheerio.load(autop(html), null, false);
	const blocks: PtBlock[] = [];
	const images: PtResult["images"] = [];
	const leftovers: PtResult["leftovers"] = [];

	let current: PtBlock | undefined;
	const open = (style: Style, list?: { type: "bullet" | "number"; level: number }) => {
		current = { _type: "block", _key: keys.next(), style, children: [], markDefs: [], ...(list ? { listItem: list.type, level: list.level } : {}) };
		blocks.push(current);
		return current;
	};
	const close = () => {
		if (current) {
			trimBlock(current);
			if (!current.children.some((c) => c.text.length)) blocks.splice(blocks.indexOf(current), 1);
		}
		current = undefined;
	};

	const inline = (node: AnyNode, marks: string[], style: Style, list?: { type: "bullet" | "number"; level: number }) => {
		if (node.type === "text") {
			const text = collapse((node as unknown as { data: string }).data);
			if (!text) return;
			if (!current) {
				if (!text.trim()) return;
				open(style, list);
			}
			pushSpan(current as PtBlock, text, marks, keys);
			return;
		}
		if (node.type !== "tag") return;
		const el = node as Element;
		const tag = el.tagName.toLowerCase();
		if (tag === "br") {
			if (current) pushSpan(current, "\n", marks, keys);
			return;
		}
		if (tag === "img") {
			const src = el.attribs.src ?? el.attribs["data-src"];
			if (src) {
				const id = /wp-image-(\d+)/.exec(el.attribs.class ?? "")?.[1];
				images.push({ src, ...(el.attribs.alt ? { alt: el.attribs.alt } : {}), ...(id ? { wpId: Number(id) } : {}) });
			}
			return;
		}
		if (LEFTOVER_TAGS.has(tag)) {
			leftovers.push({ tag, html: $.html(el) ?? "" });
			return;
		}
		if (BLOCK_TAGS.has(tag)) {
			block(el, style, list);
			return;
		}
		let next = marks;
		if (MARK[tag]) next = [...marks, MARK[tag] as string];
		if (tag === "a" && el.attribs.href) {
			if (!current) open(style, list);
			const def: PtLinkDef = { _type: "link", _key: keys.next(), href: el.attribs.href, ...(el.attribs.target === "_blank" ? { blank: true } : {}) };
			(current as PtBlock).markDefs.push(def);
			next = [...next, def._key];
		}
		for (const c of el.children) inline(c, next, style, list);
	};

	const block = (el: Element, inherited: Style, list?: { type: "bullet" | "number"; level: number }) => {
		const tag = el.tagName.toLowerCase();
		if (tag === "ul" || tag === "ol") {
			close();
			const level = (list?.level ?? 0) + 1;
			for (const li of el.children) {
				if (li.type === "tag" && (li as Element).tagName.toLowerCase() === "li") {
					close();
					open("normal", { type: tag === "ol" ? "number" : "bullet", level });
					for (const c of (li as Element).children) {
						if (c.type === "tag" && ["ul", "ol"].includes((c as Element).tagName.toLowerCase())) block(c as Element, "normal", { type: tag === "ol" ? "number" : "bullet", level });
						else inline(c, [], "normal", { type: tag === "ol" ? "number" : "bullet", level });
					}
					close();
				}
			}
			return;
		}
		const style: Style = HEADING[tag] ?? (tag === "blockquote" ? "blockquote" : inherited);
		close();
		for (const c of el.children) {
			if (c.type === "tag" && BLOCK_TAGS.has((c as Element).tagName.toLowerCase())) {
				close();
				block(c as Element, style === "blockquote" ? "blockquote" : (HEADING[tag] ?? inherited), list);
			} else inline(c, [], style, list);
		}
		close();
	};

	const style = opts.defaultStyle ?? "normal";
	for (const node of $.root().contents()) {
		if (node.type === "tag" && BLOCK_TAGS.has((node as Element).tagName.toLowerCase())) block(node as Element, style);
		else inline(node as AnyNode, [], style);
	}
	close();
	return { blocks: blocks.map(mergeSpans), images, leftovers };
}

function pushSpan(block: PtBlock, text: string, marks: string[], keys: Keys) {
	const last = block.children.at(-1);
	if (last && sameMarks(last.marks, marks)) last.text += text;
	else block.children.push({ _type: "span", _key: keys.next(), text, marks: [...marks] });
}

const sameMarks = (a: string[], b: string[]) => a.length === b.length && a.every((m, i) => m === b[i]);

function trimBlock(b: PtBlock) {
	// Drop whitespace at the edges and around hard breaks, like the browser does.
	for (const s of b.children) s.text = s.text.replace(/ *\n */g, "\n");
	const first = b.children[0];
	if (first) first.text = first.text.replace(/^[\s\n]+/, "");
	const last = b.children.at(-1);
	if (last) last.text = last.text.replace(/[\s\n]+$/, "");
	b.children = b.children.filter((c) => c.text.length > 0);
	const used = new Set(b.children.flatMap((c) => c.marks));
	b.markDefs = b.markDefs.filter((d) => used.has(d._key));
}

function mergeSpans(b: PtBlock): PtBlock {
	const out: PtSpan[] = [];
	for (const s of b.children) {
		const last = out.at(-1);
		if (last && sameMarks(last.marks, s.marks)) last.text += s.text;
		else out.push(s);
	}
	return { ...b, children: out };
}

/** One-block helper for headings/labels that come from shortcode attributes. */
export function textBlock(text: string, keys: Keys, style: Style = "normal", marks: string[] = []): PtBlock {
	return { _type: "block", _key: keys.next(), style, children: [{ _type: "span", _key: keys.next(), text: decodeEntities(text).trim(), marks }], markDefs: [] };
}

/** Plain text of rich text (for coverage and search). */
export function ptText(blocks: RichText | undefined): string {
	return (blocks ?? []).map((b) => b.children.map((c) => c.text).join("")).join("\n");
}

export { decodeEntities };
