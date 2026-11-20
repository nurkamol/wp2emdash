/**
 * Gutenberg block libraries (PLAN §7): Kadence Blocks (`kadence/`), Spectra (`uagb/`), GenerateBlocks
 * (`generateblocks/`), Stackable (`stackable/`) and CoBlocks (`coblocks/`) → the shared fragments.
 * Block names, attributes and saved markup are the libraries' public block formats (what post_content stores),
 * recorded in docs/spikes/gutenberg-libraries-findings.md. No plugin code is used: handlers read the saved
 * attributes and the static HTML each block saves.
 * - layout blocks: column rows (Kadence row layout, Spectra columns / row containers, GenerateBlocks grid and v2
 *   grid/flex elements, Stackable columns / feature grid, CoBlocks row) become sub-rows; wrappers are transparent;
 * - content blocks: headings, buttons, icon lists, info boxes, tabs, accordions, testimonials, team, counters, maps,
 *   galleries, pricing and form blocks map to fragments; forms become the starter's form definitions (recipients
 *   are never copied);
 * - unknown blocks of these libraries keep their text and inner blocks and are reported (gutenberg adapter default).
 * Adding a handler: add it to LIB_LEAF, add a fixture in test/fixtures/gutenberg and its golden IR.
 */
import type { Button, Diagnostic, MediaRef, RichText } from "../../ir/schema.js";
import type { Keys } from "../../ir/portable-text.js";
import type { FormDefinitionOut, FormFieldOut } from "../../scaffold/forms.js";
import type { Col, Fragment, HandlerCtx } from "../wpbakery/elements.js";
import { mediaFrom, richFromHtml } from "../wpbakery/elements.js";
import type { Block } from "./index.js";

type Obj = Record<string, unknown>;
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : undefined);
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? v.map(obj).filter((x): x is Obj => !!x) : []);
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
export const stripTags = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
const blocksOf = (frags: Fragment[]): RichText => frags.flatMap((f) => (f.kind === "rich" ? f.blocks : []));
const plain = (blocks: RichText) => blocks.map((b) => b.children.map((c) => c.text).join("")).join("\n").trim();

/** The libraries this module knows (block name prefix → library name for messages). */
export const LIBRARIES: Record<string, string> = { kadence: "Kadence Blocks", uagb: "Spectra", generateblocks: "GenerateBlocks", stackable: "Stackable", coblocks: "CoBlocks" };
export const libraryOf = (name: string) => LIBRARIES[name.split("/")[0] ?? ""];

export interface LibEnv {
	keys: Keys;
	ctx(path: string): HandlerCtx;
	diag(d: Diagnostic): void;
	popupFor: HandlerCtx["popupFor"];
	postCount: number;
	postId?: number;
	/** Fragments of any block (layout handled). */
	fragmentsOf(b: Block, path: string): Fragment[];
	forms: Map<string, FormDefinitionOut>;
	nextForm(): number;
}

type Handler = (b: Block, path: string, env: LibEnv) => Fragment[];

// ── Layout ──────────────────────────────────────────────────────────────────

/** Kadence row layout presets (`colLayout`) → column widths. */
const KADENCE_LAYOUT: Record<string, string[]> = {
	"left-golden": ["2/3", "1/3"],
	"right-golden": ["1/3", "2/3"],
	"left-half": ["1/2", "1/4", "1/4"],
	"right-half": ["1/4", "1/4", "1/2"],
	"center-half": ["1/4", "1/2", "1/4"],
	"center-wide": ["1/6", "2/3", "1/6"],
	"first-row": [],
	"last-row": [],
};

const pct = (v: unknown): number | undefined => {
	const n = typeof v === "number" ? v : Number.parseFloat(str(v) ?? "");
	return Number.isFinite(n) && n > 0 && n < 100 ? n : undefined;
};
export const fraction = (n: number | undefined): string | undefined => (n === undefined ? undefined : ([[16.66, "1/6"], [25, "1/4"], [33.33, "1/3"], [50, "1/2"], [66.66, "2/3"], [75, "3/4"]] as const).find(([p]) => Math.abs(p - n) < 1.5)?.[1] ?? `${Math.round(n)}/100`);

/** Styles object of a GenerateBlocks v2 element (`styles: { display, flexDirection, gridTemplateColumns }`). */
const gbStyles = (b: Block) => obj(b.attrs.styles) ?? {};
const gridTracks = (v: unknown) => {
	const s = str(v) ?? "";
	const rep = /repeat\(\s*(\d+)/.exec(s);
	return rep ? Number(rep[1]) : s.split(/\s+(?![^(]*\))/).filter(Boolean).length;
};

/** Does this library block lay its children out side by side (a row of columns)? */
export function isLibRow(b: Block): boolean {
	const kids = b.innerBlocks;
	switch (b.name) {
		case "kadence/rowlayout":
			return str(b.attrs.colLayout) !== "row" && kids.filter((k) => k.name === "kadence/column").length >= 2;
		case "uagb/columns":
		case "stackable/columns":
		case "stackable/feature-grid":
		case "coblocks/row":
		case "generateblocks/grid":
			return kids.length >= 2;
		case "uagb/container":
			return kids.length >= 2 && kids.every((k) => k.name === "uagb/container") && (str(b.attrs.directionDesktop) === "row" || kids.some((k) => pct(k.attrs.widthDesktop) !== undefined));
		case "generateblocks/element": {
			const s = gbStyles(b);
			if (kids.length < 2) return false;
			if (str(s.display) === "grid") return gridTracks(s.gridTemplateColumns) >= 2;
			return str(s.display) === "flex" && !/column/.test(str(s.flexDirection) ?? "");
		}
		default:
			return false;
	}
}

/** Wrappers that add nothing but styling: their children are the content. */
export const LIB_CONTAINERS = new Set(["kadence/rowlayout", "kadence/column", "kadence/section", "uagb/container", "uagb/columns", "uagb/column", "generateblocks/container", "generateblocks/element", "generateblocks/grid", "generateblocks/loop-item", "stackable/columns", "stackable/column", "stackable/feature-grid", "stackable/hero", "stackable/call-to-action", "stackable/horizontal-scroller", "coblocks/row", "coblocks/column", "coblocks/hero"]);

/** A column's own width (%), whatever the library calls it. */
export function libColumnWidth(b: Block, parent: Block, index: number): string | undefined {
	if (parent.name === "kadence/rowlayout") {
		const preset = KADENCE_LAYOUT[str(parent.attrs.colLayout) ?? ""]?.[index];
		if (preset) return preset;
		const own = index === 0 ? pct(parent.attrs.firstColumnWidth) : index === 1 ? pct(parent.attrs.secondColumnWidth) : undefined;
		return fraction(own);
	}
	const sizing = obj(b.attrs.sizing);
	return fraction(pct(b.attrs.colWidth) ?? pct(b.attrs.widthDesktop) ?? pct(b.attrs.columnWidth) ?? pct(b.attrs.width) ?? pct(sizing?.width));
}

const COLOUR_RE = /^(?:#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i;
/** Library container styling → the WPBakery-style row attributes the recognisers read. */
export function libStyle(b: Block): Record<string, string> {
	const a: Record<string, string> = {};
	const at = b.attrs;
	const color = [at.bgColor, at.backgroundColor, at.blockBackgroundBackgroundColor, at.columnBackgroundColor, at.background && obj(at.background)?.color].map(str).find((c) => c && COLOUR_RE.test(c.trim()));
	if (color) a.bg_color = color.trim();
	const img = obj(at.bgImage);
	const image = str(at.bgImgID) ?? str(obj(at.backgroundImageDesktop)?.id) ?? str(img?.id) ?? str(at.blockBackgroundMediaId) ?? str(at.bgImg) ?? str(obj(at.backgroundImageDesktop)?.url) ?? str(obj(img?.image)?.url) ?? str(at.blockBackgroundMediaUrl);
	if (image && image !== "0") a.bg_image = image;
	const video = str(at.bgVideo) ?? str(obj(at.backgroundVideo)?.url);
	if (video && /\.(mp4|webm)(\?|$)/i.test(video)) {
		a.video_bg = "true";
		a.video_mp4 = video;
	}
	const overlay = Number(at.overlayOpacity ?? at.backgroundOverlayOpacity);
	if (image && Number.isFinite(overlay) && overlay > 0) a.color_overlay = `rgba(0,0,0,${overlay > 1 ? overlay / 100 : overlay})`;
	const anchor = str(at.anchor);
	if (anchor) a.id = anchor;
	if (str(at.align) === "full" || str(at.contentWidth) === "alignfull" || str(at.innerContentWidth) === "alignfull") a.type = "full_width_content";
	const text = str(at.textColor) ?? str(at.blockTextColor);
	if (text && COLOUR_RE.test(text) && /^#(?:f|e|d)[0-9a-f]{2,5}$|white|#fff/i.test(text)) a.text_color = "light";
	return a;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Every link in saved HTML → buttons (label = the link text). */
function anchors(html: string, path: string, env: LibEnv, style: Button["style"] = "primary"): Fragment[] {
	const out: Fragment[] = [];
	for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
		const label = stripTags(m[2] ?? "");
		const href = /href="([^"]*)"/.exec(m[1] ?? "")?.[1];
		const classes = /class="([^"]*)"/.exec(m[1] ?? "")?.[1];
		out.push(...button(label, href, path, env, { style: /outline|ghost|secondary|is-style-outline/.test(classes ?? "") ? "secondary" : style, newTab: /target="_blank"/.test(m[1] ?? ""), ...(classes ? { classes } : {}) }));
	}
	return out;
}

function button(label: string, href: string | undefined, path: string, env: LibEnv, o: { style?: Button["style"]; newTab?: boolean; classes?: string } = {}): Fragment[] {
	const text = stripTags(label);
	if (!text) return [];
	const popup = env.popupFor({ ...(href ? { href } : {}), ...(o.classes ? { classes: o.classes } : {}) });
	if (!href && !popup) env.diag({ level: "warn", code: "link-unknown", message: `Button "${text}" has no link`, path });
	return [{ kind: "button", button: { label: text, href: href?.trim() || (popup ? `#${popup}` : "#"), style: o.style ?? "primary", ...(o.newTab ? { newTab: true } : {}), ...(popup ? { opensPopup: popup } : {}) } }];
}

/** The first `<img>` in saved HTML (with its `wp-image-<id>` class when present). */
function imgOf(html: string, id?: unknown): MediaRef | undefined {
	const tag = /<img\b[^>]*>/i.exec(html)?.[0];
	const src = tag ? /\bsrc="([^"]+)"/.exec(tag)?.[1] : undefined;
	const alt = tag ? /\balt="([^"]*)"/.exec(tag)?.[1] : undefined;
	const wpId = Number(id ?? (tag ? /wp-image-(\d+)/.exec(tag)?.[1] : undefined));
	if (Number.isInteger(wpId) && wpId > 0) return { wpId, kind: "image", ...(src ? { url: src } : {}), ...(alt ? { alt } : {}) };
	return src ? { url: src, kind: "image", ...(alt ? { alt } : {}) } : undefined;
}

/** The text of the first element whose class contains `cls` in saved HTML. */
function byClass(html: string, cls: string): string | undefined {
	const re = new RegExp(`<(\\w+)\\b[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)</\\1>`, "i");
	const m = re.exec(html);
	return m ? (m[2] as string) : undefined;
}

const descendant = (b: Block, name: string): Block | undefined => b.innerBlocks.find((k) => k.name === name) ?? b.innerBlocks.map((k) => descendant(k, name)).find(Boolean);
const kidsFrags = (b: Block, path: string, env: LibEnv, from = 0) => b.innerBlocks.slice(from).flatMap((k, i) => env.fragmentsOf(k, `${path}/${i + from}`));
const listHtml = (items: string[]) => (items.length ? `<ul>${items.map((t) => `<li>${t}</li>`).join("")}</ul>` : "");

/** A card-like composite (Stackable card / icon box / feature, CoBlocks feature / service): its parts as a feature. */
function feature(frags: Fragment[], image?: MediaRef): Fragment[] {
	const blocks = blocksOf(frags);
	const head = blocks.findIndex((b) => /^h[1-6]$/.test(b.style));
	const title = head >= 0 ? plain([blocks[head] as RichText[number]]) : undefined;
	const body = blocks.filter((_, i) => i !== head);
	const media = image ?? frags.flatMap((f) => (f.kind === "media" ? [f.media] : []))[0];
	const link = frags.flatMap((f) => (f.kind === "button" ? [f.button] : []))[0];
	if (!title && !body.length && !media) return frags;
	return [{ kind: "feature", item: { ...(title ? { title } : {}), body, ...(media ? { image: media } : {}), ...(link ? { link } : {}) } }];
}

/** Dynamic listings (posts / query loops): nothing to keep when the site has no posts, else unmapped. */
const listing: Handler = (b, path, env) => {
	if (env.postCount === 0) {
		env.diag({ level: "info", code: "dynamic", message: `${b.name}: lists posts, but the site has none — dropped`, path, tag: b.name });
		return [];
	}
	env.diag({ level: "error", code: "unmapped", message: `${b.name}: dynamic posts listing needs a posts-listing section (not in the v1 library)`, path, carriesContent: true, tag: b.name });
	return [];
};
const decorative: Handler = (b, path, env) => {
	env.diag({ level: "info", code: "dropped-decorative", message: `${b.name} dropped (decorative)`, path, tag: b.name });
	return [];
};
const dynamic: Handler = (b, path, env) => {
	env.diag({ level: "info", code: "dynamic", message: `${b.name} is generated by the site (table of contents, breadcrumbs…), not migrated as content`, path, tag: b.name });
	return [];
};
/** A block that saves plain HTML text (headings, paragraphs, notices): its HTML is the content. */
const prose: Handler = (b, path, env) => richFromHtml(b.innerHTML, env.ctx(path));
/** A block whose content is only its inner blocks. */
const inner: Handler = (b, path, env) => kidsFrags(b, path, env);

// ── Forms ───────────────────────────────────────────────────────────────────

const FIELD_TYPE: Record<string, FormFieldOut["type"]> = { text: "text", name: "text", email: "email", tel: "tel", phone: "tel", textarea: "textarea", message: "textarea", select: "select", radio: "radio", checkbox: "checkbox", toggle: "checkbox", date: "date", datepicker: "date", url: "url", website: "url", number: "number", accept: "consent", acceptance: "consent" };
const slug = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s-]+/g, "_").slice(0, 40);

interface RawField {
	type: string;
	label: string;
	required: boolean;
	placeholder?: string;
	options: string[];
	half?: boolean;
}

function formDefinition(provider: string, id: string, title: string, raw: RawField[], o: { submit?: string; success?: string; recipient?: boolean; defaultSuccess: string }): FormDefinitionOut {
	const warnings: string[] = [];
	const fields: FormFieldOut[] = [];
	const used = new Set<string>();
	for (const f of raw) {
		if (f.type === "hidden") {
			warnings.push(`hidden field "${f.label}" not rebuilt (its value is set by the page); add it by hand if the receiver needs it`);
			continue;
		}
		if (f.type === "submit" || f.type === "captcha" || f.type === "recaptcha" || f.type === "honeypot") continue;
		const type = FIELD_TYPE[f.type];
		if (!type) {
			warnings.push(`field "${f.label || f.type}" (${f.type}) not supported; rebuild by hand`);
			continue;
		}
		// A field block without its own label (CoBlocks email) shows its type as the label.
		if (!f.label) f.label = f.type.charAt(0).toUpperCase() + f.type.slice(1);
		let name = slug(f.label) || `field_${fields.length}`;
		while (used.has(name)) name = `${name}_${fields.length}`;
		used.add(name);
		const autocomplete = type === "email" ? "email" : type === "tel" ? "tel" : f.type === "name" ? "name" : undefined;
		fields.push({ name, label: f.label || name, type, ...(f.required ? { required: true } : {}), ...(f.placeholder ? { placeholder: f.placeholder } : {}), ...(f.options.length && (type === "select" || type === "radio" || type === "checkbox") ? { options: f.options } : {}), ...(f.half ? { half: true } : {}), ...(autocomplete ? { autocomplete } : {}) });
	}
	if (o.recipient) warnings.push(`recipient set in the ${provider} form: set it in the admin (Forms → recipients), it is not copied`);
	if (!fields.some((f) => f.type === "email" || f.type === "tel")) warnings.push("no email or phone field to reply to");
	return { id: `${provider}-${id}`, title, submitLabel: stripTags(o.submit ?? "") || "Submit", successMessage: stripTags(o.success ?? "") || o.defaultSuccess, fields, warnings };
}

function emitForm(provider: string, def: (id: string) => FormDefinitionOut, b: Block, path: string, env: LibEnv): Fragment[] {
	const id = `${env.postId ?? "x"}-${env.nextForm()}`;
	const d = def(id);
	env.forms.set(d.id, d);
	if (d.warnings.length) env.diag({ level: "warn", code: "lossy", message: `${b.name}: ${d.warnings.join("; ")}`, path, tag: b.name });
	return [{ kind: "form", provider, id }];
}

/** A field block's label: its attributes, else the label it saved in its HTML. */
function fieldLabel(b: Block): string {
	const a = b.attrs;
	const own = [a.label, a.name, a.fieldLabel, a.question, ...Object.entries(a).filter(([k]) => /(?:Name|Label|_label|_name)$/.test(k)).map(([, v]) => v)].map(str).find((x) => x?.trim());
	return stripTags(own ?? /<label\b[^>]*>([\s\S]*?)<\/label>/i.exec(b.innerHTML)?.[1] ?? byClass(b.innerHTML, "[\\w-]*label") ?? "");
}
const fieldOptions = (b: Block) => (Array.isArray(b.attrs.options) ? (b.attrs.options as unknown[]).map((o) => stripTags(str(o) ?? str(obj(o)?.optiontitle) ?? str(obj(o)?.label) ?? str(obj(o)?.value) ?? "")).filter(Boolean) : []);
const fieldRequired = (b: Block) => Object.entries(b.attrs).some(([k, v]) => /^required$|Required$/.test(k) && (v === true || v === "true" || v === 1));

// ── Handlers ────────────────────────────────────────────────────────────────

const testimonialOf = (t: { quote?: string; name?: string; role?: string; photo?: MediaRef }): Fragment[] => {
	const quote = stripTags(t.quote ?? "");
	if (!quote) return [];
	const name = stripTags(t.name ?? "");
	const role = stripTags(t.role ?? "");
	return [{ kind: "testimonial", item: { quote, ...(name ? { name } : {}), ...(role ? { role } : {}), ...(t.photo ? { photo: t.photo } : {}) } }];
};
const mediaAttr = (v: unknown): MediaRef | undefined => {
	const o = obj(v);
	const id = Number(o?.id);
	const url = str(o?.url);
	if (Number.isInteger(id) && id > 0) return { wpId: id, kind: "image", ...(url ? { url } : {}) };
	return mediaFrom(url ?? str(v));
};
const stat = (value: string | undefined, label: string | undefined, prefix?: string, suffix?: string): Fragment[] => {
	const v = (value ?? "").trim();
	if (!v) return [];
	return [{ kind: "stat", item: { value: v, label: stripTags(label ?? ""), ...(prefix?.trim() ? { prefix: prefix.trim() } : {}), ...(suffix?.trim() ? { suffix: suffix.trim() } : {}) } }];
};

export const LIB_LEAF: Record<string, Handler> = {
	// ── Kadence Blocks ──
	"kadence/advancedheading": prose,
	"kadence/advancedbtn": (b, path, env) => (b.innerBlocks.length ? kidsFrags(b, path, env) : arr(b.attrs.btns).length ? arr(b.attrs.btns).flatMap((x) => button(str(x.text) ?? "", str(x.link), path, env, { newTab: str(x.target) === "_blank" })) : anchors(b.innerHTML, path, env)),
	"kadence/singlebtn": (b, path, env) => (str(b.attrs.text) ? button(str(b.attrs.text) as string, str(b.attrs.link), path, env, { newTab: str(b.attrs.target) === "_blank", ...(str(b.attrs.inheritStyles) === "outline" ? { style: "secondary" as const } : {}) }) : anchors(b.innerHTML, path, env)),
	"kadence/icon": decorative,
	"kadence/single-icon": decorative,
	"kadence/spacer": decorative,
	"kadence/lottie": decorative,
	"kadence/iconlist": (b, path, env) => {
		const items = b.innerBlocks.length ? b.innerBlocks.map((k) => (str(k.attrs.text) ?? byClass(k.innerHTML, "kt-svg-icon-list-text") ?? stripTags(k.innerHTML)).trim()).filter(Boolean) : [...b.innerHTML.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => stripTags(m[1] ?? "")).filter(Boolean);
		return richFromHtml(listHtml(items.map((t) => (/<a\b/.test(t) ? t : esc(stripTags(t))))), env.ctx(path));
	},
	"kadence/infobox": (b, path, env) => {
		const title = stripTags(byClass(b.innerHTML, "kt-blocks-info-box-title") ?? "");
		const text = byClass(b.innerHTML, "kt-blocks-info-box-text") ?? "";
		const more = stripTags(byClass(b.innerHTML, "kt-blocks-info-box-learnmore") ?? "");
		const href = str(b.attrs.link) ?? /<a\b[^>]*href="([^"]+)"/.exec(b.innerHTML)?.[1];
		const image = mediaAttr(arr(b.attrs.mediaImage)[0]) ?? imgOf(b.innerHTML);
		const link = href ? (button(more || title, href, path, env, { style: "link", newTab: str(b.attrs.target) === "_blank" })[0] as Extract<Fragment, { kind: "button" }> | undefined)?.button : undefined;
		return [{ kind: "feature", item: { ...(title ? { title } : {}), body: blocksOf(richFromHtml(`<p>${text}</p>`, env.ctx(path))), ...(image ? { image } : {}), ...(link ? { link } : {}) } }];
	},
	"kadence/tabs": (b, path, env) => {
		const titles = arr(b.attrs.titles).map((t) => stripTags(str(t.text) ?? ""));
		return b.innerBlocks.map((tab, i) => ({ kind: "tab" as const, label: titles[i] || stripTags(str(tab.attrs.title) ?? "") || `Tab ${i + 1}`, body: blocksOf(kidsFrags(tab, `${path}/${i}`, env)) }));
	},
	"kadence/accordion": (b, path, env) =>
		b.innerBlocks.map((pane, i) => ({ kind: "faq" as const, question: stripTags(byClass(pane.innerHTML, "kt-blocks-accordion-title") ?? str(pane.attrs.title) ?? ""), answer: blocksOf(kidsFrags(pane, `${path}/${i}`, env)) })),
	"kadence/testimonials": (b, path, env) =>
		b.innerBlocks.length
			? kidsFrags(b, path, env)
			: arr(b.attrs.testimonials).flatMap((t) => testimonialOf({ quote: str(t.content), name: str(t.name), role: str(t.occupation), photo: mediaFrom(str(t.url)) })),
	"kadence/testimonial": (b) => testimonialOf({ quote: str(b.attrs.content) ?? byClass(b.innerHTML, "kt-testimonial-content"), name: str(b.attrs.name) ?? byClass(b.innerHTML, "kt-testimonial-name"), role: str(b.attrs.occupation) ?? byClass(b.innerHTML, "kt-testimonial-occupation"), photo: mediaAttr({ id: b.attrs.id, url: b.attrs.url }) ?? imgOf(b.innerHTML, b.attrs.id) }),
	"kadence/countup": (b) => stat(str(b.attrs.end), str(b.attrs.title) ?? byClass(b.innerHTML, "kb-count-up-title"), str(b.attrs.prefix), str(b.attrs.suffix)),
	"kadence/image": (b) => {
		const m = imgOf(b.innerHTML, b.attrs.id);
		const href = /<a\b[^>]*href="([^"]+)"/.exec(b.innerHTML)?.[1];
		return m ? [{ kind: "media", media: m, role: "content", ...(href ? { link: href } : {}) }] : [];
	},
	"kadence/advancedgallery": (b) => {
		const ids = Array.isArray(b.attrs.ids) ? (b.attrs.ids as unknown[]).map(Number).filter((n) => n > 0) : [];
		const images: MediaRef[] = ids.length ? ids.map((id) => ({ wpId: id, kind: "image" as const })) : [...b.innerHTML.matchAll(/<img\b[^>]*>/gi)].map((m) => imgOf(m[0])).filter((x): x is MediaRef => !!x);
		return images.length ? [{ kind: "gallery", images, layout: /carousel|slider|fluidcarousel/.test(str(b.attrs.type) ?? "") ? "carousel" : /masonry/.test(str(b.attrs.type) ?? "") ? "masonry" : "grid" }] : [];
	},
	"kadence/videopopup": (b) => {
		const url = str(b.attrs.url) ?? str(obj(b.attrs.media)?.url) ?? /href="([^"]*(?:youtu|vimeo)[^"]*)"/.exec(b.innerHTML)?.[1];
		return url ? [{ kind: "video", embedUrl: url }] : [];
	},
	"kadence/googlemaps": (b) => (str(b.attrs.location) ? [{ kind: "map", address: str(b.attrs.location) as string }] : []),
	"kadence/form": (b, path, env) => {
		const a = b.attrs;
		const raw: RawField[] = arr(a.fields).map((f) => ({ type: str(f.type) ?? "text", label: stripTags(str(f.label) ?? str(f.placeholder) ?? ""), required: f.required === true, ...(str(f.placeholder) ? { placeholder: str(f.placeholder) } : {}), options: arr(f.options).map((o) => stripTags(str(o.label) ?? str(o.value) ?? "")).filter(Boolean), half: Array.isArray(f.width) && Number(f.width[0]) > 0 && Number(f.width[0]) <= 50 }));
		const recipient = arr(a.email).some((e) => !!str(e.emailTo)?.trim());
		if (Array.isArray(a.actions) && (a.actions as unknown[]).some((x) => x !== "email")) env.diag({ level: "warn", code: "lossy", message: `${b.name}: actions not rebuilt: ${(a.actions as unknown[]).filter((x) => x !== "email").join(", ")}`, path, tag: b.name });
		return emitForm("kadence", (id) => formDefinition("kadence", id, `Form ${id}`, raw, { submit: str(arr(a.submit)[0]?.text), success: str(arr(a.messages)[0]?.success), recipient, defaultSuccess: "Submission Success, Thanks for getting in touch!" }), b, path, env);
	},
	"kadence/advanced-form": (b, path, env) => {
		env.diag({ level: "error", code: "unmapped", message: `${b.name}: the form is stored in a kadence_form post (#${str(b.attrs.id) ?? "?"}); rebuild it or export it`, path, carriesContent: true, tag: b.name });
		return [];
	},
	"kadence/posts": listing,
	"kadence/table-of-contents": dynamic,

	// ── Spectra (uagb) ──
	"uagb/advanced-heading": prose,
	"uagb/blockquote": prose,
	"uagb/inline-notice": prose,
	"uagb/buttons": inner,
	"uagb/buttons-child": (b, path, env) => (str(b.attrs.label) ? button(str(b.attrs.label) as string, str(b.attrs.link), path, env, { newTab: b.attrs.opensInNewTab === true }) : anchors(b.innerHTML, path, env)),
	"uagb/marketing-button": (b, path, env) => anchors(b.innerHTML, path, env),
	"uagb/icon-list": (b, path, env) => richFromHtml(listHtml(b.innerBlocks.map((k) => esc(stripTags(str(k.attrs.label) ?? byClass(k.innerHTML, "uagb-icon-list__label") ?? k.innerHTML))).filter(Boolean)), env.ctx(path)),
	"uagb/info-box": (b, path, env) => {
		const title = stripTags(str(b.attrs.infoBoxTitle) ?? byClass(b.innerHTML, "uagb-ifb-title") ?? "");
		const desc = str(b.attrs.headingDesc) ?? byClass(b.innerHTML, "uagb-ifb-desc") ?? "";
		const href = str(b.attrs.ctaLink);
		const image = mediaAttr(b.attrs.iconImage) ?? imgOf(b.innerHTML);
		const link = href ? (button(str(b.attrs.ctaText) || title, href, path, env, { style: "link", newTab: b.attrs.ctaTarget === true })[0] as Extract<Fragment, { kind: "button" }> | undefined)?.button : undefined;
		return [{ kind: "feature", item: { ...(title ? { title } : {}), body: blocksOf(richFromHtml(`<p>${desc}</p>`, env.ctx(path))), ...(image ? { image } : {}), ...(link ? { link } : {}) } }];
	},
	"uagb/call-to-action": (b, path, env) => {
		const title = str(b.attrs.ctaTitle) ?? byClass(b.innerHTML, "uagb-cta__title") ?? "";
		const desc = str(b.attrs.description) ?? byClass(b.innerHTML, "uagb-cta__desc") ?? "";
		return [...(stripTags(title) ? richFromHtml(`<h2>${title}</h2>`, env.ctx(path)) : []), ...(stripTags(desc) ? richFromHtml(`<p>${desc}</p>`, env.ctx(path)) : []), ...(str(b.attrs.ctaText) ? button(str(b.attrs.ctaText) as string, str(b.attrs.ctaLink), path, env, { newTab: b.attrs.ctaTarget === true }) : anchors(b.innerHTML, path, env))];
	},
	"uagb/tabs": (b, path, env) => {
		const titles = (Array.isArray(b.attrs.tabHeaders) ? (b.attrs.tabHeaders as unknown[]) : []).map((t) => stripTags(str(t) ?? str(obj(t)?.title) ?? ""));
		return b.innerBlocks.map((tab, i) => ({ kind: "tab" as const, label: titles[i] || `Tab ${i + 1}`, body: blocksOf(kidsFrags(tab, `${path}/${i}`, env)) }));
	},
	"uagb/faq": (b, path, env) =>
		b.innerBlocks.map((q, i) => ({ kind: "faq" as const, question: stripTags(str(q.attrs.question) ?? byClass(q.innerHTML, "uagb-question") ?? ""), answer: blocksOf(richFromHtml(str(q.attrs.answer) ?? byClass(q.innerHTML, "uagb-faq-content") ?? "", env.ctx(`${path}/${i}`))) })),
	"uagb/testimonial": (b) => arr(b.attrs.test_block).flatMap((t) => testimonialOf({ quote: str(t.description), name: str(t.name), role: str(t.company), photo: mediaAttr(t.image) })),
	"uagb/team": (b, path, env) => {
		const links: Button[] = [];
		for (const [k, label] of [["twitterLink", "X"], ["fbLink", "Facebook"], ["linkedinLink", "LinkedIn"], ["pinLink", "Pinterest"], ["instaLink", "Instagram"]] as const) {
			const href = str(b.attrs[k])?.trim();
			if (href && href !== "#") links.push({ label, href, style: "link", newTab: true });
		}
		const photo = mediaAttr(b.attrs.image) ?? imgOf(b.innerHTML);
		const role = stripTags(str(b.attrs.prefix) ?? "");
		return [{ kind: "team", member: { name: stripTags(str(b.attrs.title) ?? byClass(b.innerHTML, "uagb-team__title") ?? ""), ...(role ? { role } : {}), ...(photo ? { photo } : {}), bio: blocksOf(richFromHtml(`<p>${str(b.attrs.description) ?? byClass(b.innerHTML, "uagb-team__desc") ?? ""}</p>`, env.ctx(path))), links } }];
	},
	"uagb/counter": (b) => stat(str(b.attrs.endNumber), str(b.attrs.heading), str(b.attrs.numberPrefix), str(b.attrs.numberSuffix)),
	"uagb/google-map": (b) => (str(b.attrs.address) ? [{ kind: "map", address: str(b.attrs.address) as string }] : []),
	"uagb/image": (b) => {
		const m = imgOf(b.innerHTML, b.attrs.id);
		return m ? [{ kind: "media", media: m, role: "content" }] : [];
	},
	"uagb/image-gallery": (b) => {
		const images = arr(b.attrs.mediaGallery).map((g) => mediaAttr(g)).filter((x): x is MediaRef => !!x);
		return images.length ? [{ kind: "gallery", images, layout: /carousel/.test(str(b.attrs.feedLayout) ?? "") ? "carousel" : /masonry/.test(str(b.attrs.feedLayout) ?? "") ? "masonry" : "grid" }] : [];
	},
	"uagb/separator": decorative,
	"uagb/icon": decorative,
	"uagb/lottie": decorative,
	"uagb/post-grid": listing,
	"uagb/post-carousel": listing,
	"uagb/post-masonry": listing,
	"uagb/post-timeline": listing,
	"uagb/table-of-contents": dynamic,
	"uagb/forms": (b, path, env) => {
		const raw: RawField[] = b.innerBlocks.map((f) => ({ type: f.name.replace(/^uagb\/forms-/, ""), label: fieldLabel(f), required: fieldRequired(f), ...(str(f.attrs.placeholder) ? { placeholder: str(f.attrs.placeholder) } : {}), options: fieldOptions(f) }));
		return emitForm("spectra", (id) => formDefinition("spectra", id, str(b.attrs.formLabel) ?? `Form ${id}`, raw, { submit: str(b.attrs.submitButtonText), success: str(b.attrs.successMessageText) ?? str(b.attrs.confirmationMessage), recipient: !!str(b.attrs.afterSubmitToEmail)?.trim(), defaultSuccess: "The form has been submitted successfully!" }), b, path, env);
	},

	// ── GenerateBlocks ──
	"generateblocks/headline": prose,
	"generateblocks/text": (b, path, env) => (/^\s*<a\b/i.test(b.innerHTML) ? anchors(b.innerHTML, path, env) : prose(b, path, env)),
	"generateblocks/button-container": inner,
	"generateblocks/button": (b, path, env) => anchors(b.innerHTML, path, env),
	"generateblocks/image": (b) => {
		const m = imgOf(b.innerHTML, b.attrs.mediaId);
		return m ? [{ kind: "media", media: m, role: "content" }] : [];
	},
	"generateblocks/media": (b) => {
		const m = imgOf(b.innerHTML, b.attrs.mediaId);
		return m ? [{ kind: "media", media: m, role: "content" }] : [];
	},
	"generateblocks/shape": decorative,
	"generateblocks/query-loop": listing,
	"generateblocks/query": listing,
	"generateblocks/looper": listing,
	"generateblocks/query-page-numbers": dynamic,
	"generateblocks/query-no-results": dynamic,

	// ── Stackable (v3) ──
	"stackable/heading": prose,
	"stackable/text": prose,
	"stackable/subtitle": prose,
	"stackable/blockquote": inner,
	"stackable/icon-list": prose,
	"stackable/button-group": inner,
	"stackable/button": (b, path, env) => anchors(b.innerHTML, path, env),
	"stackable/icon-button": (b, path, env) => anchors(b.innerHTML, path, env),
	"stackable/image": (b) => {
		const m = imgOf(b.innerHTML, b.attrs.imageId);
		return m ? [{ kind: "media", media: m, role: "content" }] : [];
	},
	"stackable/icon": decorative,
	"stackable/divider": decorative,
	"stackable/spacer": decorative,
	"stackable/separator": decorative,
	"stackable/count-up": (b) => stat(stripTags(byClass(b.innerHTML, "stk-block-count-up__text") ?? b.innerHTML), ""),
	"stackable/video-popup": (b) => (str(b.attrs.videoLink) ? [{ kind: "video", embedUrl: str(b.attrs.videoLink) as string }] : []),
	"stackable/map": (b) => (str(b.attrs.address) ? [{ kind: "map", address: str(b.attrs.address) as string }] : []),
	"stackable/posts": listing,
	"stackable/table-of-contents": dynamic,
	"stackable/card": (b, path, env) => feature(kidsFrags(b, path, env)),
	"stackable/icon-box": (b, path, env) => feature(kidsFrags(b, path, env)),
	"stackable/feature": (b, path, env) => feature(kidsFrags(b, path, env)),
	"stackable/image-box": (b, path, env) => feature(kidsFrags(b, path, env)),
	"stackable/notification": inner,
	"stackable/number-box": (b, path, env) => feature(kidsFrags(b, path, env)),
	"stackable/testimonial": (b, path, env) => {
		const frags = kidsFrags(b, path, env);
		const blocks = blocksOf(frags);
		const heads = blocks.filter((x) => /^h[1-6]$/.test(x.style));
		const body = blocks.filter((x) => !/^h[1-6]$/.test(x.style));
		return testimonialOf({ quote: plain(body.slice(0, Math.max(1, body.length - (heads.length ? 1 : 0)))), name: heads[0] ? plain([heads[0]]) : undefined, role: heads.length && body.length > 1 ? plain(body.slice(-1)) : undefined, photo: frags.flatMap((f) => (f.kind === "media" ? [f.media] : []))[0] });
	},
	"stackable/team-member": (b, path, env) => {
		const frags = kidsFrags(b, path, env);
		const blocks = blocksOf(frags);
		const head = blocks.findIndex((x) => /^h[1-6]$/.test(x.style));
		const rest = blocks.filter((_, i) => i !== head);
		const photo = frags.flatMap((f) => (f.kind === "media" ? [f.media] : []))[0];
		const links = frags.flatMap((f) => (f.kind === "button" ? [{ ...f.button, style: "link" as const }] : []));
		const role = rest[0] && rest.length > 1 ? plain([rest[0]]) : undefined;
		return [{ kind: "team", member: { name: head >= 0 ? plain([blocks[head] as RichText[number]]) : "", ...(role ? { role } : {}), ...(photo ? { photo } : {}), bio: role ? rest.slice(1) : rest, links } }];
	},
	"stackable/pricing-box": (b, path, env) => {
		const frags = kidsFrags(b, path, env);
		const blocks = blocksOf(frags);
		const name = plain(blocks.filter((x) => /^h[1-6]$/.test(x.style)).slice(0, 1));
		const priceBlock = descendant(b, "stackable/price");
		const price = priceBlock ? stripTags(byClass(priceBlock.innerHTML, "stk-block-price__price") ?? priceBlock.innerHTML) || undefined : undefined;
		const features = blocks.filter((x) => x.listItem).map((x) => plain([x]));
		const btn = frags.flatMap((f) => (f.kind === "button" ? [f.button] : []))[0];
		return [{ kind: "price", plan: { name, ...(price ? { price } : {}), features, ...(btn ? { button: btn } : {}), highlight: false } }];
	},
	"stackable/price": (b, path, env) => prose(b, path, env),
	"stackable/accordion": (b, path, env) => {
		const [head, ...body] = b.innerBlocks;
		if (!head) return [];
		return [{ kind: "faq", question: plain(blocksOf(env.fragmentsOf(head, `${path}/0`))), answer: blocksOf(body.flatMap((k, i) => env.fragmentsOf(k, `${path}/${i + 1}`))) }];
	},
	"stackable/tabs": (b, path, env) => {
		const labels = b.innerBlocks.find((k) => k.name === "stackable/tab-labels");
		const content = b.innerBlocks.find((k) => k.name === "stackable/tab-content");
		const names = arr(labels?.attrs.tabLabels).map((l) => stripTags(str(l.label) ?? ""));
		return (content?.innerBlocks ?? []).map((pane, i) => ({ kind: "tab" as const, label: names[i] || `Tab ${i + 1}`, body: blocksOf(env.fragmentsOf(pane, `${path}/content/${i}`)) }));
	},
	"stackable/carousel": inner,
	"stackable/icon-label": inner,

	// ── CoBlocks ──
	"coblocks/accordion": inner,
	"coblocks/accordion-item": (b, path, env) => [{ kind: "faq", question: stripTags(str(b.attrs.title) ?? byClass(b.innerHTML, "wp-block-coblocks-accordion-item__title") ?? /<summary[^>]*>([\s\S]*?)<\/summary>/.exec(b.innerHTML)?.[1] ?? ""), answer: blocksOf(kidsFrags(b, path, env)) }],
	"coblocks/features": inner,
	"coblocks/feature": (b, path, env) => feature(kidsFrags(b, path, env)),
	"coblocks/services": inner,
	"coblocks/service": (b, path, env) => feature(kidsFrags(b, path, env), mediaAttr({ id: b.attrs.imageId, url: b.attrs.imageUrl })),
	"coblocks/pricing-table": inner,
	"coblocks/pricing-table-item": (b, path, env) => {
		const h = b.innerHTML;
		const name = stripTags(byClass(h, "wp-block-coblocks-pricing-table-item__title") ?? str(b.attrs.title) ?? "");
		const amount = stripTags(byClass(h, "wp-block-coblocks-pricing-table-item__amount") ?? str(b.attrs.amount) ?? "");
		const currency = stripTags(byClass(h, "wp-block-coblocks-pricing-table-item__currency") ?? str(b.attrs.currency) ?? "");
		const features = [...(byClass(h, "wp-block-coblocks-pricing-table-item__features") ?? "").matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((m) => stripTags(m[1] ?? "")).filter(Boolean);
		const btn = [...anchors(h, path, env), ...kidsFrags(b, path, env)].flatMap((f) => (f.kind === "button" ? [f.button] : []))[0];
		return [{ kind: "price", plan: { name, ...(amount ? { price: `${currency}${amount}` } : {}), features, ...(btn ? { button: btn } : {}), highlight: false } }];
	},
	"coblocks/alert": prose,
	"coblocks/highlight": prose,
	"coblocks/click-to-tweet": prose,
	"coblocks/buttons": (b, path, env) => (b.innerBlocks.length ? kidsFrags(b, path, env) : anchors(b.innerHTML, path, env)),
	"coblocks/map": (b) => (str(b.attrs.address) ? [{ kind: "map", address: str(b.attrs.address) as string }] : []),
	"coblocks/social-profiles": (b, path, env) => {
		const nets = ["facebook", "twitter", "instagram", "linkedin", "youtube", "pinterest", "tumblr", "yelp", "houzz"];
		const links = nets.flatMap((n) => (str(b.attrs[n])?.trim() ? [`<a href="${esc(str(b.attrs[n]) as string)}">${n === "twitter" ? "X" : n.charAt(0).toUpperCase() + n.slice(1)}</a>`] : []));
		return links.length ? richFromHtml(`<p>${links.join(" ")}</p>`, env.ctx(path)) : [];
	},
	"coblocks/logos": (b) => {
		const images = [...b.innerHTML.matchAll(/<img\b[^>]*>/gi)].map((m) => imgOf(m[0])).filter((x): x is MediaRef => !!x);
		return images.length ? [{ kind: "gallery", images, layout: "grid" }] : [];
	},
	"coblocks/gallery-masonry": (b) => galleryOf(b, "masonry"),
	"coblocks/gallery-stacked": (b) => galleryOf(b, "stack"),
	"coblocks/gallery-carousel": (b) => galleryOf(b, "carousel"),
	"coblocks/gallery-collage": (b) => galleryOf(b, "grid"),
	"coblocks/gallery-offset": (b) => galleryOf(b, "grid"),
	"coblocks/shape-divider": decorative,
	"coblocks/dynamic-separator": decorative,
	"coblocks/icon": decorative,
	"coblocks/posts": listing,
	"coblocks/post-carousel": listing,
	"coblocks/form": (b, path, env) => {
		const raw: RawField[] = b.innerBlocks.map((f) => ({ type: f.name.replace(/^coblocks\/field-/, "").replace(/^submit-button$/, "submit"), label: fieldLabel(f), required: fieldRequired(f), options: fieldOptions(f) }));
		const submit = b.innerBlocks.find((f) => f.name === "coblocks/field-submit-button");
		return emitForm("coblocks", (id) => formDefinition("coblocks", id, str(b.attrs.subject) ?? `Form ${id}`, raw, { submit: str(submit?.attrs.submitButtonText) ?? (submit ? stripTags(submit.innerHTML) : undefined), recipient: !!str(b.attrs.to)?.trim(), defaultSuccess: "Your message was sent." }), b, path, env);
	},
};

function galleryOf(b: Block, layout: Extract<Fragment, { kind: "gallery" }>["layout"]): Fragment[] {
	const fromAttrs = arr(b.attrs.images).map((i) => mediaAttr({ id: i.id, url: i.url })).filter((x): x is MediaRef => !!x);
	const images = fromAttrs.length ? fromAttrs : [...b.innerHTML.matchAll(/<img\b[^>]*>/gi)].map((m) => imgOf(m[0])).filter((x): x is MediaRef => !!x);
	return images.length ? [{ kind: "gallery", images, layout }] : [];
}

/** A library row's columns (with their widths). */
export function libColumns(b: Block, path: string, env: LibEnv): Col[] {
	return b.innerBlocks.map((c, i) => {
		const width = libColumnWidth(c, b, i);
		const bg = libStyle(c);
		const frags = env.fragmentsOf(c, `${path}/${i}`);
		const image = mediaFrom(bg.bg_image);
		return { ...(width ? { width } : {}), ...(bg.bg_color ? { background: { color: bg.bg_color } } : {}), fragments: image && frags.length ? [{ kind: "media" as const, media: image, role: "background" as const }, ...frags] : frags };
	});
}
