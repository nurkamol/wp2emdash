/**
 * Shortcode parser → AST. Handles nesting, self-closing vs enclosing tags (decided by whether a
 * matching close tag exists, as WordPress does), quoted/unquoted/positional attributes, wptexturize'd
 * quotes (″ ” “ &#8221; &#8243;), `[[escaped]]` shortcodes, and the `<p>`/`</p>` that wpautop wraps
 * around shortcodes. Unknown tags are kept as nodes — nothing is discarded here.
 */

export interface ShortcodeNode {
	type: "shortcode";
	tag: string;
	attrs: Record<string, string>;
	/** Positional (unnamed) attributes. */
	args: string[];
	children: AstNode[];
	selfClosing: boolean;
	/** Exact source of the opening tag (for hashing and diagnostics). */
	raw: string;
}
export interface TextNode {
	type: "text";
	text: string;
}
export type AstNode = ShortcodeNode | TextNode;

const TAG_RE = /\[(\[?)(\/?)([a-zA-Z][\w-]*)((?:[^\]"'″”“]|"[^"]*"|'[^']*'|[″”“][^″”“]*[″”“])*?)(\/?)\](\]?)/g;
const ATTR_RE = /([\w-]+)\s*=\s*"([^"]*)"|([\w-]+)\s*=\s*'([^']*)'|([\w-]+)\s*=\s*([^\s'"]+)|"([^"]*)"|'([^']*)'|(\S+)/g;

/** Undo wptexturize inside tag text so attribute quotes parse. */
export function normaliseQuotes(s: string): string {
	return s.replace(/&#8221;|&#8243;|&#8220;|″|”|“/g, '"').replace(/&#8217;|&#8216;|’|‘/g, "'");
}

export function parseAttrs(text: string): { attrs: Record<string, string>; args: string[] } {
	const attrs: Record<string, string> = {};
	const args: string[] = [];
	for (const m of normaliseQuotes(text).matchAll(ATTR_RE)) {
		if (m[1]) attrs[m[1].toLowerCase()] = m[2] ?? "";
		else if (m[3]) attrs[m[3].toLowerCase()] = m[4] ?? "";
		else if (m[5]) attrs[m[5].toLowerCase()] = m[6] ?? "";
		else {
			const v = m[7] ?? m[8] ?? m[9];
			if (v !== undefined && v !== "/") args.push(v);
		}
	}
	return { attrs, args };
}

/** wpautop leaves `<p>` / `</p>` glued to shortcodes; remove those so text nodes stay meaningful. */
export function stripAutop(content: string): string {
	return content
		.replace(/<p>\s*(\[[^\]]+\])/g, "$1")
		.replace(/(\[[^\]]+\])\s*<\/p>/g, "$1")
		.replace(/(\[[^\]]+\])\s*<br\s*\/?>/g, "$1");
}

export function parseShortcodes(content: string): AstNode[] {
	const src = stripAutop(content);
	const root: ShortcodeNode = { type: "shortcode", tag: "#root", attrs: {}, args: [], children: [], selfClosing: false, raw: "" };
	const stack: ShortcodeNode[] = [root];
	let last = 0;

	const pushText = (text: string) => {
		if (!text) return;
		const parent = stack.at(-1) as ShortcodeNode;
		const prev = parent.children.at(-1);
		if (prev?.type === "text") prev.text += text;
		else parent.children.push({ type: "text", text });
	};

	for (const m of src.matchAll(TAG_RE)) {
		const [whole, openEsc, slash, tagRaw, attrText, selfSlash, closeEsc] = m;
		pushText(src.slice(last, m.index));
		last = (m.index ?? 0) + whole.length;
		const tag = (tagRaw as string).toLowerCase();

		if (openEsc && closeEsc) {
			// [[tag]] → literal [tag]
			pushText(whole.slice(1, -1));
			continue;
		}
		if (slash) {
			const idx = findOpen(stack, tag);
			if (idx < 0) {
				pushText(whole); // stray close tag: keep as text so nothing disappears
				continue;
			}
			// Anything opened after the matching tag but never closed was self-closing: hoist its children.
			while (stack.length - 1 > idx) hoist(stack);
			stack.pop();
			continue;
		}
		const { attrs, args } = parseAttrs(attrText ?? "");
		const node: ShortcodeNode = { type: "shortcode", tag, attrs, args, children: [], selfClosing: !!selfSlash, raw: whole };
		(stack.at(-1) as ShortcodeNode).children.push(node);
		if (!selfSlash) stack.push(node);
	}
	pushText(src.slice(last));
	while (stack.length > 1) hoist(stack);
	return root.children;
}

function findOpen(stack: ShortcodeNode[], tag: string): number {
	for (let i = stack.length - 1; i > 0; i--) if (stack[i]?.tag === tag) return i;
	return -1;
}

/** Pop the top node as self-closing; its collected children move to its parent, right after it. */
function hoist(stack: ShortcodeNode[]) {
	const node = stack.pop() as ShortcodeNode;
	const parent = stack.at(-1) as ShortcodeNode;
	node.selfClosing = true;
	const kids = node.children;
	node.children = [];
	const at = parent.children.indexOf(node);
	parent.children.splice(at + 1, 0, ...kids);
}

/** Visit every shortcode node depth-first. */
export function walk(nodes: AstNode[], fn: (n: ShortcodeNode, path: string) => void, path = ""): void {
	nodes.forEach((n, i) => {
		if (n.type !== "shortcode") return;
		const p = `${path}${path ? "/" : ""}${n.tag}[${i}]`;
		fn(n, p);
		walk(n.children, fn, p);
	});
}

/** Raw inner HTML of a node (text children + nested shortcode source), used for vc_column_text etc. */
export function innerSource(n: ShortcodeNode): string {
	return n.children.map((c) => (c.type === "text" ? c.text : serialise(c))).join("");
}

export function serialise(n: ShortcodeNode): string {
	if (n.selfClosing) return n.raw;
	return `${n.raw}${innerSource(n)}[/${n.tag}]`;
}
