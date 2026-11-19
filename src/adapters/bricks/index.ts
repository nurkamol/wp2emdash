/**
 * Bricks Builder adapter. Bricks stores a page as a flat list of elements in post meta `_bricks_page_content_2`
 * (`{ id, name, parent, children[], settings, label? }`; `parent` 0 for top-level elements), not in post_content.
 * Elements → tree → rows (a top-level `section`, its row-direction container's children as columns) → the shared
 * section recognisers, like the Gutenberg adapter. Styling is mapped onto the WPBakery-style row attributes the
 * recognisers read (background colour and image, padding, anchor id).
 *
 * Status: structure and content elements from Bricks' documented element settings, covered by synthetic fixtures.
 * Spacing and look are not measured on a live Bricks site yet (that is how the WPBakery/Salient adapter became
 * accurate): the first real client site confirms the meta shape the exporter returns and the element settings it
 * uses. Unknown elements are reported as unmapped, never dropped silently.
 */
import type { Diagnostic, MediaRef, PtBlock, Section, SectionType } from "../../ir/schema.js";
import type { Keys } from "../../ir/portable-text.js";
import { type Col, embedOrLegacy, type Fragment, type HandlerCtx, richFromHtml } from "../wpbakery/elements.js";
import { mergeRich, recognise, type Row, splitRow } from "../wpbakery/index.js";

export interface BricksElement {
	id: string;
	name: string;
	parent: string | number;
	children?: string[];
	settings?: Record<string, unknown>;
	label?: string;
}

export interface BricksOptions {
	kind: "page" | "post" | "partial" | "popup";
	keys: Keys;
	popupFor: HandlerCtx["popupFor"];
	postCount: number;
	/** A Bricks template's elements by post id (the `template` element embeds one). */
	template?: (id: number) => BricksElement[] | undefined;
	rowOverrides?: Record<string, SectionType | "drop">;
}

/** Structural elements: they hold other elements and carry layout, not content. */
const STRUCTURE = new Set(["section", "container", "block", "div"]);
/** Site chrome and query-driven elements: rendered by the site itself, not migrated as page content. */
const DYNAMIC = new Set(["nav-menu", "nav-nested", "logo", "search", "post-title", "post-content", "post-excerpt", "post-meta", "post-navigation", "post-comments", "posts", "pagination", "breadcrumbs", "sidebar", "related-posts", "query-results-summary", "offcanvas", "toggle", "back-to-top", "language-switcher"]);
const DECORATIVE = new Set(["divider", "spacer"]);

const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
const isRoot = (p: string | number) => p === 0 || p === "0" || p === "" || p === null;

/**
 * Read the meta value: an element array, an object keyed by index (PHP arrays that lost their order), or JSON text.
 * A PHP-serialized string is not decoded here (the exporter returns unserialized meta); it is reported instead.
 */
export function bricksElements(meta: unknown): BricksElement[] | undefined {
	let v = meta;
	if (typeof v === "string") {
		const t = v.trim();
		if (!t.startsWith("[") && !t.startsWith("{")) return undefined;
		try {
			v = JSON.parse(t);
		} catch {
			return undefined;
		}
	}
	const list = Array.isArray(v) ? v : obj(v) ? Object.values(v as object) : undefined;
	if (!list) return undefined;
	const els = list.filter((e): e is BricksElement => !!obj(e) && typeof (e as BricksElement).id === "string" && typeof (e as BricksElement).name === "string");
	return els.length ? els : undefined;
}

/** True when the post is edited with Bricks (its element list is set and the editor mode is not WordPress). */
export function isBricks(meta: Record<string, unknown> | undefined): boolean {
	if (!meta) return false;
	const mode = str(meta._bricks_editor_mode);
	return mode !== "wordpress" && !!bricksElements(meta._bricks_page_content_2);
}

export function adaptBricks(elements: BricksElement[], opts: BricksOptions): { sections: Section[]; diagnostics: Diagnostic[] } {
	const diagnostics: Diagnostic[] = [];
	const diag = (d: Diagnostic) => diagnostics.push(d);
	const ctxFor = (path: string): HandlerCtx => ({ keys: opts.keys, path, diag, popupFor: opts.popupFor, postCount: opts.postCount, children: () => [] });
	const byId = new Map(elements.map((e) => [e.id, e]));
	// Children in the order the parent lists them; elements a parent does not list follow in document order.
	const childrenOf = (e: BricksElement): BricksElement[] => {
		const listed = (e.children ?? []).flatMap((id) => byId.get(id) ?? []);
		const extra = elements.filter((x) => String(x.parent) === e.id && !listed.includes(x));
		return [...listed, ...extra];
	};
	const roots = elements.filter((e) => isRoot(e.parent) || !byId.has(String(e.parent)));
	const pathOf = (e: BricksElement) => `${e.name}#${e.id}`;
	const seenTemplates = new Set<number>();

	function fragments(e: BricksElement, path: string): Fragment[] {
		if (STRUCTURE.has(e.name)) return mergeRich(childrenOf(e).flatMap((c) => fragments(c, `${path}/${pathOf(c)}`)));
		return leaf(e, path);
	}

	function leaf(e: BricksElement, path: string): Fragment[] {
		const s = e.settings ?? {};
		const ctx = ctxFor(path);
		if (DECORATIVE.has(e.name)) {
			diag({ level: "info", code: "dropped-decorative", message: `[${e.name}] dropped (decorative)`, path, tag: e.name });
			return [];
		}
		if (DYNAMIC.has(e.name)) {
			diag({ level: "info", code: "dynamic", message: `[${e.name}] is rendered by the site (menu, logo, post data), not migrated as content`, path, tag: e.name });
			return [];
		}
		const text = str(s.text) ?? "";
		if (/\{[a-z_]+(?::[^}]*)?\}/.test(text)) diag({ level: "warn", code: "dynamic", message: `[${e.name}] uses Bricks dynamic data (${/\{[a-z_]+/.exec(text)?.[0]}}); the text is kept as written`, path, tag: e.name });
		switch (e.name) {
			case "heading": {
				const tag = /^h[1-6]$/.test(str(s.tag) ?? "") ? (s.tag as string) : "h3";
				return text ? richFromHtml(`<${tag}>${text}</${tag}>`, ctx) : [];
			}
			case "text-basic": {
				const tag = /^(p|div|span|h[1-6])$/.test(str(s.tag) ?? "") ? (s.tag as string) : "p";
				return text ? richFromHtml(`<${tag === "span" || tag === "div" ? "p" : tag}>${text}</${tag === "span" || tag === "div" ? "p" : tag}>`, ctx) : [];
			}
			case "text":
			case "rich-text":
				return text ? richFromHtml(text, ctx) : [];
			case "button": {
				const label = text.replace(/<[^>]+>/g, "").trim();
				if (!label) return [];
				const link = linkOf(s.link);
				const popup = opts.popupFor({ ...(link.href ? { href: link.href } : {}), ...(str(s._cssClasses) ? { classes: str(s._cssClasses) } : {}) });
				const style = /outline|secondary|light/.test(str(s.style) ?? "") || s.outline === true ? "secondary" : "primary";
				return [{ kind: "button", button: { label, href: link.href ?? (popup ? `#${popup}` : "#"), style, ...(str(s.size) === "lg" || str(s.size) === "xl" ? { size: "large" as const } : {}), ...(link.newTab ? { newTab: true } : {}), ...(popup ? { opensPopup: popup } : {}) } }];
			}
			case "image": {
				const media = mediaOf(s.image, str(s.altText));
				const link = linkOf(s.link);
				const caption = str(s.caption);
				return [...(media ? [{ kind: "media" as const, media, role: "content" as const, ...(link.href ? { link: link.href } : {}) }] : []), ...(caption ? richFromHtml(`<p>${esc(caption)}</p>`, ctx) : [])];
			}
			case "video": {
				const type = str(s.videoType) ?? "youtube";
				if (type === "youtube" && str(s.youTubeId)) return [{ kind: "video", embedUrl: `https://www.youtube.com/watch?v=${str(s.youTubeId)}` }];
				if (type === "vimeo" && str(s.vimeoId)) return [{ kind: "video", embedUrl: `https://vimeo.com/${str(s.vimeoId)}` }];
				const file = mediaOf(s.media, undefined, "video") ?? (str(s.fileUrl) ? { url: str(s.fileUrl) as string, kind: "video" as const } : undefined);
				return [{ kind: "video", ...(file ? { video: file } : {}) }];
			}
			case "icon": {
				const icon = iconOf(s.icon);
				return icon ? [{ kind: "icon", icon }] : [];
			}
			case "icon-box": {
				const icon = iconOf(s.icon);
				const body = richFromHtml(str(s.content) ?? "", ctx).flatMap((f) => (f.kind === "rich" ? f.blocks : []));
				const titleBlock = body.find((b) => /^h[1-6]$/.test(b.style ?? ""));
				return [{ kind: "feature", item: { ...(titleBlock ? { title: titleBlock.children.map((c) => c.text).join("") } : {}), body: body.filter((b) => b !== titleBlock), ...(icon ? { icon } : {}) } }];
			}
			case "list": {
				const items = Array.isArray(s.items) ? (s.items as Record<string, unknown>[]) : [];
				const li = items.map((it) => `<li>${[str(it.title), str(it.meta)].filter(Boolean).join(" — ")}</li>`).join("");
				return li ? richFromHtml(`<ul>${li}</ul>`, ctx) : [];
			}
			case "accordion":
			case "accordion-nested": {
				if (e.name === "accordion") return (Array.isArray(s.items) ? (s.items as Record<string, unknown>[]) : []).map((it) => ({ kind: "faq" as const, question: str(it.title) ?? "", answer: richFromHtml(str(it.content) ?? "", ctx).flatMap((f) => (f.kind === "rich" ? f.blocks : [])) }));
				// Nested: each item is a block whose first child is the title, the rest the answer.
				return childrenOf(e).map((item, k) => {
					const [title, ...rest] = childrenOf(item);
					const q = title ? fragments(title, `${path}/${k}`).flatMap((f) => (f.kind === "rich" ? f.blocks : [])).map(plain).join(" ") : "";
					return { kind: "faq" as const, question: q, answer: rest.flatMap((r) => fragments(r, `${path}/${k}`)).flatMap((f) => (f.kind === "rich" ? f.blocks : [])) };
				});
			}
			case "tabs":
			case "tabs-nested": {
				if (e.name === "tabs") return (Array.isArray(s.tabs) ? (s.tabs as Record<string, unknown>[]) : []).map((t) => ({ kind: "tab" as const, label: str(t.title) ?? "", body: richFromHtml(str(t.content) ?? "", ctx).flatMap((f) => (f.kind === "rich" ? f.blocks : [])) }));
				// Nested: two children — the tab titles and the panes, in the same order.
				const [titles, panes] = childrenOf(e);
				const labels = titles ? childrenOf(titles).map((t) => fragments(t, path).flatMap((f) => (f.kind === "rich" ? f.blocks : [])).map(plain).join(" ")) : [];
				return (panes ? childrenOf(panes) : []).map((pane, k) => ({ kind: "tab" as const, label: labels[k] ?? `Tab ${k + 1}`, body: fragments(pane, `${path}/${k}`).flatMap((f) => (f.kind === "rich" ? f.blocks : [])) }));
			}
			case "counter": {
				const value = str(s.countTo);
				return value ? [{ kind: "stat", item: { value, label: str(s.title) ?? "", ...(str(s.prefix) ? { prefix: str(s.prefix) } : {}), ...(str(s.suffix) ? { suffix: str(s.suffix) } : {}) } }] : [];
			}
			case "image-gallery": {
				const raw = obj(s.items)?.images ?? s.items;
				const images = (Array.isArray(raw) ? raw : []).flatMap((i) => mediaOf(i) ?? []);
				return images.length ? [{ kind: "gallery", images, layout: str(s.layout) === "masonry" ? "masonry" : "grid" }] : [];
			}
			case "code":
				return embedOrLegacy(str(s.code) ?? "", ctx, "Bricks code element");
			case "shortcode":
				return embedOrLegacy(str(s.shortcode) ?? "", ctx, "Bricks shortcode element");
			case "html":
				return embedOrLegacy(str(s.html) ?? text, ctx, "Bricks HTML element");
			case "template": {
				const id = Number(s.template);
				const els = Number.isInteger(id) && !seenTemplates.has(id) ? opts.template?.(id) : undefined;
				if (!els) {
					diag({ level: "error", code: "unmapped", message: `[template] ${id || "?"} could not be loaded`, path, carriesContent: true, tag: e.name });
					return [];
				}
				seenTemplates.add(id);
				const tplById = new Map(els.map((x) => [x.id, x]));
				for (const x of els) if (!byId.has(x.id)) byId.set(x.id, x);
				const out = els.filter((x) => isRoot(x.parent) || !tplById.has(String(x.parent))).flatMap((x) => fragments(x, `${path}/template#${id}/${pathOf(x)}`));
				seenTemplates.delete(id);
				return out;
			}
		}
		const carries = !!(text || str(s.content) || str(s.title));
		diag({ level: carries ? "error" : "warn", code: "unmapped", message: `No handler for Bricks [${e.name}]${carries ? " (carries content)" : ""}`, path, carriesContent: carries, tag: e.name });
		return [];
	}

	/** A section's columns: the first row-direction container (or the section itself) with two or more structural children. */
	function columnsOf(section: BricksElement, path: string): Col[] {
		let box: BricksElement | undefined = section;
		for (let depth = 0; box && depth < 3; depth++) {
			const kids = childrenOf(box);
			const structural = kids.filter((k) => STRUCTURE.has(k.name));
			const dir = str(box.settings?._direction) ?? str(obj(box.settings?._flexDirection)?.value);
			if (kids.length >= 2 && structural.length === kids.length && (dir === "row" || box.name === "container" || box.name === "section") && (dir === "row" || kids.some((k) => str(k.settings?._width)))) {
				return kids.map((k) => ({ fragments: fragments(k, `${path}/${pathOf(k)}`), ...(widthOf(k) ? { width: widthOf(k) } : {}) }));
			}
			box = kids.length === 1 && STRUCTURE.has(kids[0]?.name ?? "") ? kids[0] : undefined;
		}
		return [{ fragments: fragments(section, path) }];
	}

	const rows: Row[] = [];
	let loose: BricksElement[] = [];
	const flushLoose = () => {
		if (!loose.length) return;
		rows.push({ attrs: {}, columns: [{ fragments: mergeRich(loose.flatMap((e) => fragments(e, pathOf(e)))) }], path: loose.map(pathOf).join("+"), raw: JSON.stringify(loose), adapter: "bricks" });
		loose = [];
	};
	for (const r of roots) {
		if (r.name !== "section" && r.name !== "container") {
			loose.push(r);
			continue;
		}
		flushLoose();
		const path = pathOf(r);
		rows.push({ attrs: styleOf(r), columns: columnsOf(r, path), path, raw: JSON.stringify(r), adapter: "bricks" });
	}
	flushLoose();

	const sections: Section[] = [];
	for (const row of rows) {
		const forced = opts.rowOverrides?.[row.path];
		if (forced === "drop") continue;
		for (const v of splitRow(row)) sections.push(...recognise(v, { first: sections.length === 0, kind: opts.kind, ...(forced ? { forced } : {}), keys: opts.keys, diag }));
	}
	return { sections, diagnostics };
}

const plain = (b: PtBlock) => b.children.map((c) => c.text).join("");

function linkOf(v: unknown): { href?: string; newTab?: boolean } {
	const l = obj(v);
	if (!l) return {};
	const type = str(l.type);
	const href = type === "internal" ? (str(l.url) ?? (str(l.postId) ? `/?page_id=${str(l.postId)}` : undefined)) : str(l.url);
	return { ...(href ? { href } : {}), ...(l.newTab === true || l.newTab === "true" ? { newTab: true } : {}) };
}

function mediaOf(v: unknown, alt?: string, kind: MediaRef["kind"] = "image"): MediaRef | undefined {
	const m = obj(v);
	if (!m) return undefined;
	const id = Number(m.id);
	const url = str(m.url) ?? str(m.full);
	if (Number.isInteger(id) && id > 0) return { wpId: id, kind, ...(url ? { url } : {}), ...(alt ? { alt } : {}) };
	return url ? { url, kind, ...(alt ? { alt } : {}) } : undefined;
}

function iconOf(v: unknown): { library: string; name: string } | undefined {
	const i = obj(v);
	const name = str(i?.icon);
	if (!i || !name) return undefined;
	const lib = str(i.library) ?? "";
	return { library: /fontawesome/i.test(lib) ? "fontawesome" : /ionicons/i.test(lib) ? "ionicons" : /themify/i.test(lib) ? "themify" : lib || "custom", name: name.replace(/^(fa[srlbd]?|fa-solid|fa-regular|fa-brands)\s+fa-/, "").replace(/^ion-/, "").replace(/^ti-/, "") };
}

function widthOf(e: BricksElement): string | undefined {
	const w = str(e.settings?._width);
	const n = w ? Number.parseFloat(w) : Number.NaN;
	if (!Number.isFinite(n) || !/%$/.test(w ?? "")) return undefined;
	const known: [number, string][] = [[25, "1/4"], [33.33, "1/3"], [50, "1/2"], [66.66, "2/3"], [75, "3/4"]];
	return known.find(([p]) => Math.abs(p - n) < 1)?.[1];
}

const colour = (v: unknown) => {
	const c = obj(v);
	return str(c?.hex) ?? str(c?.rgb) ?? str(c?.hsl) ?? str(c?.raw);
};
const px = (v: unknown) => {
	const s = str(v)?.trim();
	return s && /^\d+(?:\.\d+)?$/.test(s) ? `${s}px` : s;
};

/** A section's styling as the WPBakery-style row attributes the recognisers read. */
function styleOf(e: BricksElement): Record<string, string> {
	const s = e.settings ?? {};
	const a: Record<string, string> = {};
	const bg = obj(s._background);
	const color = colour(bg?.color);
	if (color) a.bg_color = color;
	const image = obj(bg?.image);
	const imageId = Number(image?.id);
	if (Number.isInteger(imageId) && imageId > 0) a.bg_image = String(imageId);
	else if (str(image?.url)) a.bg_image = str(image?.url) as string;
	const pad = obj(s._padding);
	if (px(pad?.top)) a.top_padding = px(pad?.top) as string;
	if (px(pad?.bottom)) a.bottom_padding = px(pad?.bottom) as string;
	const textColor = colour(obj(s._typography)?.color);
	if (textColor) a.text_color = /^#?f{3,6}$|white|255,\s*255,\s*255/i.test(textColor.replace(/^#/, "")) ? "light" : "dark";
	if (str(s._cssId)) a.id = str(s._cssId) as string;
	if (str(s._height) === "100vh" || str(s._minHeight) === "100vh") a.full_height = "yes";
	return a;
}
