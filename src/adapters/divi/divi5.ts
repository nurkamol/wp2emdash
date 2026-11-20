/**
 * Divi 5 block format → the Divi 4 shortcode tree the adapter already reads (best effort, docs/spikes/divi-findings.md).
 * Divi 5 saves a page as block comments in the `divi/` namespace (`<!-- wp:divi/section {…} -->`), each block's
 * attributes nested per field and breakpoint: `{"content":{"innerContent":{"desktop":{"value":"<p>…</p>"}}}}`,
 * `{"title":{"innerContent":{"desktop":{"value":"…"}}}}`, `{"button":{"innerContent":{"desktop":{"value":{"text","linkUrl","linkTarget"}}}}}`,
 * `{"image":{"innerContent":{"desktop":{"value":{"src","alt","id"}}}}}`, module styling under `module.decoration`.
 * Each `divi/<name>` block becomes `[et_pb_<name>]` with the desktop values flattened onto Divi 4 field names; blocks
 * the reader has no mapping for keep their text (an unknown tag → reported unmapped by the adapter).
 */
import { type Block, parseBlocks } from "../gutenberg/index.js";
import { type AstNode, parseShortcodes, type ShortcodeNode } from "../wpbakery/parser.js";

type Obj = Record<string, unknown>;
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);
const desktop = (v: unknown): unknown => obj(obj(obj(v)?.innerContent)?.desktop)?.value ?? obj(obj(v)?.desktop)?.value;
const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/-/g, "_").toLowerCase();
const text = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);

/** Field names that differ between Divi 5 attribute objects and Divi 4 module fields. */
const RENAME: Record<string, string> = { button_link_url: "button_url", button_link_target: "url_new_window", image_src: "src", image_alt: "alt", image_title_text: "title_text", image_link_url: "url", portrait_url: "portrait_url", image_icon_src: "image", video_src: "src", video_image: "image_src" };
/** Divi 5 module names that are not `et_pb_` + the same name in Divi 4. */
const TAG: Record<string, string> = { "divi/column-inner": "et_pb_column_inner", "divi/row-inner": "et_pb_row_inner" };
/** Blocks this reader knows the attribute shape of (others are converted generically and reported). */
const KNOWN = new Set(["section", "row", "row-inner", "column", "column-inner", "text", "heading", "button", "image", "blurb", "cta", "divider", "code", "video", "accordion", "accordion-item", "toggle", "tabs", "tab", "testimonial", "team-member", "gallery", "social-media-follow", "social-media-follow-network", "map", "map-pin", "number-counter", "circle-counter", "icon", "fullwidth-header", "slider", "slide", "placeholder", "shortcode-module"]);

export function divi5ToShortcodes(content: string): { nodes: AstNode[]; unknown: string[] } {
	const unknown: string[] = [];
	const convert = (b: Block): AstNode[] => {
		if (b.name === "core/freeform") return b.innerHTML.trim() ? [{ type: "text", text: b.innerHTML }] : [];
		if (!b.name.startsWith("divi/")) return [{ type: "text", text: b.innerHTML }, ...b.innerBlocks.flatMap(convert)];
		const name = b.name.slice(5);
		if (name === "placeholder") return b.innerBlocks.flatMap(convert);
		if (name === "shortcode-module") return parseShortcodes(b.innerHTML);
		if (!KNOWN.has(name)) unknown.push(b.name);
		const attrs: Record<string, string> = {};
		let body = "";
		for (const [key, v] of Object.entries(b.attrs)) {
			if (key === "module" || key === "builderVersion") continue;
			const value = desktop(v);
			const k = snake(key);
			if (key === "content") body = text(value) ?? "";
			else if (text(value) !== undefined) attrs[k] = text(value) as string;
			else if (obj(value)) for (const [sk, sv] of Object.entries(obj(value) as Obj)) if (text(sv) !== undefined) attrs[RENAME[`${k}_${snake(sk)}`] ?? `${k}_${snake(sk)}`] = text(sv) as string;
			// Heading level of a title (`title.decoration.font.font.desktop.value.headingLevel`).
			const font = obj(obj(obj(obj(obj(obj(v)?.decoration)?.font)?.font)?.desktop)?.value);
			const level = text(font?.headingLevel);
			if (level) attrs[`${k}_level`] = level;
		}
		if (attrs.url_new_window === "_blank" || attrs.url_new_window === "on") attrs.url_new_window = "on";
		// Module styling: background colour / image, CSS id, column type.
		const module = obj(b.attrs.module);
		const bg = obj(obj(obj(obj(module?.decoration)?.background)?.desktop)?.value);
		if (text(bg?.color)) attrs.background_color = text(bg?.color) as string;
		if (text(obj(bg?.image)?.url)) attrs.background_image = text(obj(bg?.image)?.url) as string;
		const html = obj(obj(obj(module?.advanced)?.htmlAttributes)?.desktop)?.value;
		if (text(obj(html)?.id)) attrs.module_id = text(obj(html)?.id) as string;
		const type = text(obj(obj(obj(module?.advanced)?.type)?.desktop)?.value);
		if (type) attrs.type = type;
		const tag = TAG[b.name] ?? `et_pb_${name.replace(/-/g, "_")}`;
		const kids: AstNode[] = [...(body ? [{ type: "text" as const, text: body }] : []), ...b.innerBlocks.flatMap(convert)];
		const node: ShortcodeNode = { type: "shortcode", tag, attrs, args: [], children: kids, selfClosing: !kids.length, raw: `<!-- wp:${b.name} -->` };
		return [node];
	};
	return { nodes: parseBlocks(content).flatMap(convert), unknown };
}
