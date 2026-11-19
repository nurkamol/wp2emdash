/**
 * Rich text in form definitions — a consent label with links, the terms shown above a waiver — kept as plain data
 * (text runs with an optional link), never as HTML. Pages render the runs as elements, so nothing from a form
 * definition is ever inserted as markup; links survive only when they are http(s) or site-relative.
 *
 * `htmlToParts` / `htmlToContent` turn a WordPress form plugin's HTML (Fluent Forms `tnc_html`, `custom_html`) into
 * that data when the migration kit converts a form; the rest renders it for email (escaped) and for text.
 */

/** A run of text, optionally bold, italic or a link (`href` is http(s) or site-relative; see `safeHref`). */
export interface InlinePart {
	text: string;
	href?: string;
	strong?: boolean;
	em?: boolean;
}

/** A display block: paragraph, list item, heading or rule. */
export interface ContentBlock {
	kind: "p" | "li" | "h" | "hr";
	parts?: InlinePart[];
}

/**
 * A link target a page may use: `http:`/`https:` URLs and site-relative paths (`/terms/`). Everything else
 * (`javascript:`, `data:`, protocol-relative `//host`, backslashes, control characters) is refused: undefined.
 */
export function safeHref(href: unknown): string | undefined {
	if (typeof href !== "string") return undefined;
	const h = href.trim();
	if (!h || h.length > 2000 || /[\u0000-\u001f\u007f\\\s]/.test(h)) return undefined;
	if (h.startsWith("/")) return h.startsWith("//") ? undefined : h;
	try {
		const u = new URL(h);
		return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
	} catch {
		return undefined;
	}
}

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", hellip: "…", copy: "©", reg: "®", trade: "™", bull: "•", middot: "·" };
export function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
		if (e[0] === "#") {
			const n = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
			return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
		}
		return NAMED[e.toLowerCase()] ?? m;
	});
}

const BLOCK = new Set(["p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "blockquote", "section", "article", "table", "tr", "hr", "br"]);
const DROP = new Set(["script", "style", "template", "noscript", "iframe", "object", "svg", "button", "select", "textarea"]);

/** Sanitised display blocks from HTML: paragraphs, list items, headings, rules; bold, italic and safe links inline. */
export function htmlToContent(html: string): ContentBlock[] {
	const blocks: ContentBlock[] = [];
	let kind: ContentBlock["kind"] = "p";
	let parts: InlinePart[] = [];
	let strong = 0;
	let em = 0;
	let link: string | undefined;
	let dropping = "";
	let inLi = false;
	const flush = () => {
		const cleaned = normaliseParts(parts);
		if (cleaned.length) blocks.push({ kind, parts: cleaned });
		parts = [];
		kind = inLi ? "li" : "p";
	};
	const re = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+|<)/g;
	for (let m = re.exec(html); m; m = re.exec(html)) {
		const [whole, tagName, attrs, text] = m;
		if (text !== undefined) {
			if (!dropping) parts.push({ text: decodeEntities(text), ...(strong ? { strong: true } : {}), ...(em ? { em: true } : {}), ...(link ? { href: link } : {}) });
			continue;
		}
		if (!tagName) continue; // comment
		const tag = tagName.toLowerCase();
		const closing = whole.startsWith("</");
		if (dropping) {
			if (closing && tag === dropping) dropping = "";
			continue;
		}
		if (DROP.has(tag)) {
			if (!closing && !whole.endsWith("/>")) dropping = tag;
			continue;
		}
		if (tag === "strong" || tag === "b") strong = Math.max(0, strong + (closing ? -1 : 1));
		else if (tag === "em" || tag === "i") em = Math.max(0, em + (closing ? -1 : 1));
		else if (tag === "a") link = closing ? undefined : safeHref(decodeEntities(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs ?? "")?.slice(1).find((x) => x !== undefined) ?? ""));
		else if (tag === "hr") {
			flush();
			blocks.push({ kind: "hr" });
		} else if (tag === "br") parts.push({ text: "\n" });
		else if (BLOCK.has(tag)) {
			flush();
			if (tag === "li") inLi = !closing;
			// <li><p>…</p></li> (WordPress editors write lists like this) is still a list item.
			if (!closing) kind = tag === "li" || (inLi && (tag === "p" || tag === "div")) ? "li" : /^h[1-6]$/.test(tag) ? "h" : "p";
			else kind = inLi ? "li" : "p";
		}
	}
	flush();
	return blocks;
}

/** Inline runs from HTML (a consent label): block structure is flattened into one line. */
export function htmlToParts(html: string): InlinePart[] {
	const blocks = htmlToContent(html).filter((b) => b.parts?.length);
	const out: InlinePart[] = [];
	blocks.forEach((b, i) => {
		if (i) out.push({ text: " " });
		out.push(...(b.parts ?? []));
	});
	return normaliseParts(out);
}

/** Collapse whitespace, merge runs that look the same, trim the ends, drop links that are not safe. */
export function normaliseParts(parts: InlinePart[]): InlinePart[] {
	const out: InlinePart[] = [];
	for (const p of parts) {
		if (typeof p?.text !== "string") continue;
		const text = p.text.replace(/[ \t\r\f\v ]+/g, " ").replace(/ ?\n ?/g, "\n");
		const href = safeHref(p.href);
		const next: InlinePart = { text, ...(p.strong ? { strong: true } : {}), ...(p.em ? { em: true } : {}), ...(href ? { href } : {}) };
		const last = out.at(-1);
		if (last && last.href === next.href && !!last.strong === !!next.strong && !!last.em === !!next.em) last.text = (last.text + text).replace(/ {2,}/g, " ");
		else if (last && /\s$/.test(last.text) && /^\s/.test(text)) out.push({ ...next, text: text.replace(/^\s+/, "") });
		else out.push(next);
	}
	if (out[0]) out[0].text = out[0].text.replace(/^\s+/, "");
	const end = out.at(-1);
	if (end) end.text = end.text.replace(/\s+$/, "");
	return out.filter((p) => p.text);
}

/** The words of the runs, links as "text (url)" when the URL adds something. */
export function partsToText(parts: InlinePart[] | undefined, opts: { links?: boolean } = {}): string {
	return (parts ?? []).map((p) => (opts.links && p.href ? `${p.text} (${p.href})` : p.text)).join("").replace(/[ \t]+/g, " ").trim();
}

export function contentToText(blocks: ContentBlock[] | undefined, opts: { links?: boolean } = {}): string {
	return (blocks ?? []).map((b) => (b.kind === "hr" ? "—" : b.kind === "li" ? `• ${partsToText(b.parts, opts)}` : partsToText(b.parts, opts))).join("\n");
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** Escaped HTML for an email. Site-relative links become absolute against `origin` when one is given. */
export function partsToHtml(parts: InlinePart[] | undefined, origin?: string): string {
	return (parts ?? [])
		.map((p) => {
			let h = esc(p.text).replace(/\n/g, "<br>");
			if (p.strong) h = `<strong>${h}</strong>`;
			if (p.em) h = `<em>${h}</em>`;
			const href = safeHref(p.href);
			if (href) h = `<a href="${esc(href.startsWith("/") && origin ? `${origin}${href}` : href)}">${h}</a>`;
			return h;
		})
		.join("");
}

export function contentToHtml(blocks: ContentBlock[] | undefined, origin?: string): string {
	return (blocks ?? []).map((b) => (b.kind === "hr" ? "<hr>" : b.kind === "li" ? `<p style="margin:0 0 0 1em">• ${partsToHtml(b.parts, origin)}</p>` : b.kind === "h" ? `<p><strong>${partsToHtml(b.parts, origin)}</strong></p>` : `<p>${partsToHtml(b.parts, origin)}</p>`)).join("");
}
