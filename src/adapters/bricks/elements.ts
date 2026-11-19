/**
 * Bricks element handlers: one per content element → the shared fragments (src/adapters/wpbakery/elements.ts),
 * which the shared row recognisers turn into sections. Settings keys are each element's `set_controls()` in
 * includes/elements/<name>.php (Bricks 2.4.6 and 2.5-beta; docs/spikes/bricks-findings.md).
 * Adding a handler: add it to HANDLERS, add a fixture in test/fixtures/bricks and its golden IR.
 */
import type { Button, Diagnostic, MediaRef, PtBlock, RichText } from "../../ir/schema.js";
import { autop } from "../../ir/portable-text.js";
import type { FormDefinitionOut } from "../../scaffold/forms.js";
import { type Col, embedOrLegacy, type Fragment, type HandlerCtx, richFromHtml } from "../wpbakery/elements.js";
import { bricksFormToDefinition } from "./forms.js";
import type { BricksElement, BricksOptions } from "./index.js";
import { type BricksSite, classNames, obj, str } from "./site.js";

type Obj = Record<string, unknown>;

export interface Env {
	site: BricksSite;
	opts: BricksOptions;
	diag(d: Diagnostic): void;
	ctx(path: string): HandlerCtx;
	childrenOf(e: BricksElement): BricksElement[];
	fragments(e: BricksElement, path: string): Fragment[];
	/** Columns of a structural element's children (slides, tab panes). */
	column(e: BricksElement, path: string): Col;
	forms: Map<string, FormDefinitionOut>;
	/** The post whose element list holds the element (a page, or a template it embeds). */
	sourceId(): number | undefined;
}

type Handler = (e: BricksElement, s: Obj, path: string, env: Env) => Fragment[];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
const items = (v: unknown): Obj[] => (Array.isArray(v) ? v : obj(v) ? Object.values(v as Obj) : []).map(obj).filter((x): x is Obj => !!x);
const blocksOf = (frags: Fragment[]): RichText => frags.flatMap((f) => (f.kind === "rich" ? f.blocks : []));
export const plain = (b: PtBlock) => b.children.map((c) => c.text).join("");
const isHeading = (b: PtBlock) => /^h[1-6]$/.test(b.style);
const stripTags = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

// ── shared value readers ─────────────────────────────────────────────────────

/** Link control (`{ type: internal|external|taxonomy|media|lightboxImage|lightboxVideo|meta, url, postId, newTab }`). */
export function linkOf(v: unknown, env: Env): { href?: string; newTab?: boolean } {
	const l = obj(v);
	if (!l) return {};
	const type = str(l.type);
	let href: string | undefined;
	if (type === "internal") {
		const id = Number(l.postId);
		href = (Number.isInteger(id) && id > 0 ? env.opts.permalink?.(id) : undefined) ?? str(l.url) ?? (id > 0 ? `/?page_id=${id}` : undefined);
	} else if (type === "external" || type === "meta" || !type) href = str(l.url);
	else if (type === "lightboxVideo") href = str(l.lightboxVideo) ?? str(l.url);
	else if (type === "media") href = str(obj(l.mediaData)?.url) ?? str(l.url);
	return { ...(href ? { href } : {}), ...(l.newTab === true || l.newTab === "true" ? { newTab: true } : {}) };
}

/** Image control (`{ id, url, full, size, filename }`, or `useDynamicData`). */
export function mediaOf(v: unknown, alt?: string, kind: MediaRef["kind"] = "image"): MediaRef | undefined {
	const m = obj(v);
	if (!m) return undefined;
	const id = Number(m.id);
	// `external`: an image by URL instead of from the media library (image control).
	const ext = typeof m.external === "string" && m.external !== "true" ? m.external : undefined;
	const url = str(m.full) ?? str(m.url) ?? ext;
	if (Number.isInteger(id) && id > 0) return { wpId: id, kind, ...(url ? { url } : {}), ...(alt ? { alt } : {}) };
	return url && !url.includes("{") ? { url, kind, ...(alt ? { alt } : {}) } : undefined;
}

/** Icon control (`{ library: fontawesomeSolid|fontawesomeBrands|ionicons|themify|svg|<custom set>, icon, svg }`). */
export function iconOf(v: unknown): { library: string; name: string } | undefined {
	const i = obj(v);
	if (!i) return undefined;
	const lib = str(i.library) ?? "";
	const svg = obj(i.svg);
	if (lib === "svg" && svg) return str(svg.url) ? { library: "svg", name: str(svg.url) as string } : undefined;
	const name = str(i.icon);
	if (!name) return undefined;
	return { library: /fontawesome/i.test(lib) ? "fontawesome" : /ionicons/i.test(lib) ? "ionicons" : /themify/i.test(lib) ? "themify" : lib || "custom", name: name.replace(/^(fa[srlbd]?|fa-solid|fa-regular|fa-brands)\s+fa-/, "").replace(/^ion-(?:md-|ios-)?/, "").replace(/^ti-/, "") };
}

/** Bricks dynamic data tags (`{post_title}`, `{acf_x}`, `{echo:fn}`): the few with a known static value are filled in. */
const DYNAMIC_TAG = /\{([a-z][a-z0-9_]*)(?::[^{}]*)?\}/g;
export function dynamicText(text: string, path: string, e: BricksElement, env: Env): string {
	if (!text.includes("{")) return text;
	const known: Record<string, string | undefined> = { post_title: env.opts.title, site_title: env.opts.siteTitle, current_date: "{year}" };
	const unknown: string[] = [];
	const out = text.replace(DYNAMIC_TAG, (m, name: string) => {
		if (name === "current_date" && !/:\s*Y\s*\}$/.test(m)) {
			unknown.push(m);
			return m;
		}
		const v = known[name];
		if (v !== undefined) return name === "current_date" ? v : esc(v);
		if (/^(year|item_index)$/.test(name)) return m;
		unknown.push(m);
		return m;
	});
	if (unknown.length) env.diag({ level: "warn", code: "dynamic", message: `[${e.name}] uses Bricks dynamic data (${[...new Set(unknown)].join(", ")}); the text is kept as written`, path, tag: e.name });
	return out;
}

/** HTML from an editor control: Bricks runs wpautop and shortcodes on it (includes/helpers.php parse_editor_content). */
function editorHtml(html: string, path: string, e: BricksElement, env: Env): Fragment[] {
	const text = dynamicText(html, path, e, env);
	const forms: Fragment[] = [];
	const rest = text.replace(FORM_SHORTCODE, (m) => {
		forms.push(...formShortcode(m));
		return "";
	});
	return [...richFromHtml(autop(rest), env.ctx(path)), ...forms];
}

const FORM_SHORTCODE = /\[(fluentform|contact-form-7|wpforms|gravityform|ninja_form|formidable)\b[^\]]*\]/g;
const FORM_PROVIDER: Record<string, string> = { fluentform: "fluent-forms", "contact-form-7": "cf7", wpforms: "wpforms", gravityform: "gravity-forms", ninja_form: "ninja-forms", formidable: "formidable" };
function formShortcode(sc: string): Fragment[] {
	const tag = /^\[([\w-]+)/.exec(sc)?.[1] ?? "";
	const id = /\bid=["']?([\w-]+)/.exec(sc)?.[1];
	return FORM_PROVIDER[tag] && id ? [{ kind: "form", provider: FORM_PROVIDER[tag] as string, id }] : [];
}

/** A button fragment; popups open from Bricks interactions (show popup template) or from a class/href the site maps. */
function buttonOf(label: string, link: { href?: string; newTab?: boolean }, e: BricksElement, path: string, env: Env, style: Button["style"], large?: boolean): Fragment[] {
	const text = stripTags(label);
	if (!text) return [];
	const popup = popupOf(e, link.href, env);
	if (!link.href && !popup) env.diag({ level: "warn", code: "link-unknown", message: `Button "${text}" has no link`, path });
	return [{ kind: "button", button: { label: text, href: link.href ?? (popup ? `#${popup}` : "#"), style, ...(large ? { size: "large" as const } : {}), ...(link.newTab ? { newTab: true } : {}), ...(popup ? { opensPopup: popup } : {}) } }];
}

function popupOf(e: BricksElement, href: string | undefined, env: Env): string | undefined {
	const show = items(e.settings?._interactions).find((i) => str(i.action) === "show" && str(i.target) === "popup" && str(i.templateId));
	if (show) {
		const slug = env.opts.popupSlug?.(Number(show.templateId));
		if (slug) return slug;
	}
	return env.opts.popupFor({ ...(href ? { href } : {}), classes: classNames(e, env.site).join(" ") });
}

/** A slide or card's fragments → one feature card (title, body, image, icon, link). */
function cardOf(frags: Fragment[]): Fragment {
	const blocks = blocksOf(frags);
	const title = blocks.find(isHeading);
	const image = frags.find((f): f is Extract<Fragment, { kind: "media" }> => f.kind === "media")?.media;
	const icon = frags.find((f): f is Extract<Fragment, { kind: "icon" }> => f.kind === "icon")?.icon;
	const link = frags.find((f): f is Extract<Fragment, { kind: "button" }> => f.kind === "button")?.button;
	return { kind: "feature", item: { ...(title ? { title: plain(title) } : {}), body: blocks.filter((b) => b !== title), ...(image ? { image } : {}), ...(icon ? { icon } : {}), ...(link ? { link } : {}) } };
}

/** Slides → a carousel gallery when every slide is only pictures, else a row of cards (one column per slide). */
function slides(cols: Col[], e: BricksElement, path: string, env: Env): Fragment[] {
	const filled = cols.filter((c) => c.fragments.length);
	if (!filled.length) return [];
	if (filled.every((c) => c.fragments.every((f) => f.kind === "media"))) return [{ kind: "gallery", images: filled.flatMap((c) => c.fragments.flatMap((f) => (f.kind === "media" ? [f.media] : []))), layout: "carousel" }];
	env.diag({ level: "info", code: "lossy", message: `[${e.name}] ${filled.length} slide(s) shown side by side as cards (no slider in the section library)`, path, tag: e.name });
	return [{ kind: "subrow", columns: filled }];
}

/** Query loops and post lists: the site renders them from its entries (PLAN §7b). */
export function dynamicListing(e: BricksElement, query: unknown, path: string, env: Env, what = "query loop"): Fragment[] {
	const q = obj(query) ?? {};
	const pt = q.post_type;
	const types = (Array.isArray(pt) ? pt.map(String) : str(pt) ? [str(pt) as string] : []).filter(Boolean);
	const type = str(q.objectType) && str(q.objectType) !== "post" ? (str(q.objectType) as string) : types.join("/") || "post";
	if (type === "post" && env.opts.postCount === 0) {
		env.diag({ level: "info", code: "dynamic", message: `[${e.name}] ${what} lists ${type} entries, but the site has none — dropped`, path, tag: e.name });
		return [];
	}
	env.diag({ level: "error", code: "dynamic", message: `[${e.name}] ${what} over ${type} entries is rendered from the site's data; needs a posts-listing section (not in the v1 library) or a decision in overrides.ts`, path, carriesContent: true, tag: e.name });
	return [];
}

// ── handlers ─────────────────────────────────────────────────────────────────
export const HANDLERS: Record<string, Handler> = {
	heading: (e, s, path, env) => {
		const text = dynamicText(str(s.text) ?? "", path, e, env);
		if (!stripTags(text)) return [];
		const tag = /^h[1-6]$/.test(str(s.tag) ?? "") ? (s.tag as string) : "h3";
		const link = linkOf(s.link, env);
		const inner = link.href ? `<a href="${esc(link.href)}"${link.newTab ? ' target="_blank"' : ""}>${text}</a>` : text;
		return richFromHtml(`<${tag}>${inner}</${tag}>`, env.ctx(path));
	},
	"text-basic": (e, s, path, env) => {
		const text = dynamicText(str(s.text) ?? "", path, e, env);
		if (!stripTags(text)) return [];
		const tag = /^h[1-6]$/.test(str(s.tag) ?? "") ? (s.tag as string) : "p";
		const link = linkOf(s.link, env);
		const inner = link.href ? `<a href="${esc(link.href)}"${link.newTab ? ' target="_blank"' : ""}>${text}</a>` : text;
		return richFromHtml(`<${tag}>${inner.replace(/\r?\n/g, "<br>")}</${tag}>`, env.ctx(path));
	},
	text: (e, s, path, env) => editorHtml(str(s.text) ?? "", path, e, env),
	alert: (e, s, path, env) => {
		env.diag({ level: "info", code: "lossy", message: "[alert] notice box styling not reproduced; text kept", path, tag: e.name });
		return editorHtml(str(s.content) ?? "", path, e, env);
	},
	"animated-typing": (e, s, path, env) => {
		const strings = items(s.strings).map((x) => str(x.text) ?? "").filter(Boolean);
		if (strings.length > 1) env.diag({ level: "info", code: "lossy", message: `[animated-typing] typing animation not reproduced; first phrase kept, others: ${strings.slice(1).join(" | ")}`, path, tag: e.name });
		const text = [str(s.prefix), strings[0], str(s.suffix)].filter(Boolean).join(" ");
		const tag = /^h[1-6]$/.test(str(s.tag) ?? "") ? (s.tag as string) : "p";
		return text ? richFromHtml(`<${tag}>${esc(text)}</${tag}>`, env.ctx(path)) : [];
	},
	"post-title": (e, _s, path, env) => {
		if (!env.opts.title || (env.opts.kind !== "page" && env.opts.kind !== "post")) {
			env.diag({ level: "info", code: "dynamic", message: "[post-title] is rendered by the site template", path, tag: e.name });
			return [];
		}
		env.diag({ level: "info", code: "dynamic", message: "[post-title] filled with the page title", path, tag: e.name });
		return richFromHtml(`<h1>${esc(env.opts.title)}</h1>`, env.ctx(path));
	},

	// Buttons & links
	button: (e, s, path, env) => {
		const style = str(s.style) ?? "";
		const kind: Button["style"] = s.outline === true || /^(secondary|light|muted|dark)$/.test(style) ? "secondary" : "primary";
		return buttonOf(dynamicText(str(s.text) ?? "", path, e, env), linkOf(s.link, env), e, path, env, kind, /^(lg|xl)$/.test(str(s.size) ?? ""));
	},
	"text-link": (e, s, path, env) => buttonOf(dynamicText(str(s.text) ?? "", path, e, env), linkOf(s.link, env), e, path, env, "link"),
	"social-icons": (e, s, path, env) =>
		items(s.icons).flatMap((i) => {
			const link = linkOf(i.link, env);
			const name = iconOf(i.icon)?.name ?? "";
			const label = str(i.label) || name.charAt(0).toUpperCase() + name.slice(1);
			return link.href && label ? buttonOf(label, { ...link, newTab: link.newTab ?? true }, e, path, env, "link") : [];
		}),
	file: (e, s, path, env) => {
		const f = obj(s.file);
		const url = str(f?.url) ?? str(s.external);
		if (!url) return [];
		const label = str(s.downloadButtonText) || str(s.customFileName) || str(f?.filename) || "Download";
		return buttonOf(label, { href: url, newTab: !!s.openInNewTab }, e, path, env, "link");
	},

	// Images & media
	image: (e, s, path, env) => {
		if (str(obj(s.image)?.useDynamicData)) {
			env.diag({ level: "warn", code: "dynamic", message: `[image] uses dynamic data (${str(obj(s.image)?.useDynamicData)}); not migrated`, path, tag: e.name });
			return [];
		}
		const media = mediaOf(s.image, str(s.altText));
		if (!media) {
			env.diag({ level: "warn", code: "media-missing", message: "[image] without an image", path, tag: e.name });
			return [];
		}
		const linkType = str(s.link);
		const href = linkType === "url" ? linkOf(s.url, env).href : linkType === "media" ? media.url : undefined;
		const caption = str(s.caption) === "custom" ? str(s.captionCustom) : undefined;
		return [{ kind: "media", media, role: "content", ...(href ? { link: href } : {}) }, ...(caption ? richFromHtml(`<p>${esc(caption)}</p>`, env.ctx(path)) : [])];
	},
	"image-gallery": (e, s, path, env) => {
		const g = obj(s.items);
		if (str(g?.useDynamicData)) {
			env.diag({ level: "warn", code: "dynamic", message: `[image-gallery] uses dynamic data (${str(g?.useDynamicData)}); not migrated`, path, tag: e.name });
			return [];
		}
		const images = items(g?.images ?? s.items).flatMap((i) => mediaOf(i) ?? []);
		const layout = str(s.layout) === "masonry" ? "masonry" : "grid";
		if (str(s.layout) === "metro") env.diag({ level: "info", code: "lossy", message: "[image-gallery] metro layout shown as a grid", path, tag: e.name });
		return images.length ? [{ kind: "gallery", images, layout }] : [];
	},
	carousel: (e, s, path, env) => {
		if (str(s.type) === "posts") return dynamicListing(e, s.query, path, env, "post carousel");
		const images = items(obj(s.items)?.images ?? s.items).flatMap((i) => mediaOf(i) ?? []);
		return images.length ? [{ kind: "gallery", images, layout: "carousel" }] : [];
	},
	video: (e, s, path, env) => {
		const type = str(s.videoType) ?? "youtube";
		const poster = (str(s.previewImage) === "custom" ? mediaOf(s.previewImageCustom) : undefined) ?? mediaOf(s.videoPoster);
		const withPoster = poster ? { poster } : {};
		const yt = str(s.youTubeId)?.trim();
		const vimeo = str(s.vimeoId)?.trim();
		if (type === "youtube" && yt) return [{ kind: "video", embedUrl: /^https?:/.test(yt) ? yt : `https://www.youtube.com/watch?v=${yt}`, ...withPoster }];
		if (type === "vimeo" && vimeo) return [{ kind: "video", embedUrl: /^https?:/.test(vimeo) ? vimeo : `https://vimeo.com/${vimeo}`, ...withPoster }];
		if (type === "meta" || str(s.useDynamicData)) {
			env.diag({ level: "warn", code: "dynamic", message: "[video] source is dynamic data; not migrated", path, tag: e.name });
			return [];
		}
		const file = mediaOf(s.media, undefined, "video") ?? (str(s.fileUrl) ? { url: str(s.fileUrl) as string, kind: "video" as const } : undefined);
		if (!file) {
			env.diag({ level: "warn", code: "media-missing", message: "[video] without a video", path, tag: e.name });
			return [];
		}
		return [{ kind: "video", video: file, ...withPoster }];
	},
	svg: (e, s, path, env) => {
		const src = str(s.source) ?? "file";
		if (src === "iconSet") {
			const icon = iconOf(s.iconSet);
			return icon ? [{ kind: "icon", icon }] : [];
		}
		const file = mediaOf(s.file);
		if (src === "file" && file) return [{ kind: "media", media: file, role: "content" }];
		env.diag({ level: "info", code: "dropped-decorative", message: `[svg] inline/dynamic SVG dropped (decorative)`, path, tag: e.name });
		return [];
	},

	// Icons & cards
	icon: (_e, s) => {
		if (s.isAccordionIcon) return [];
		const icon = iconOf(s.icon);
		return icon ? [{ kind: "icon", icon }] : [];
	},
	"icon-box": (e, s, path, env) => {
		const icon = iconOf(s.icon);
		const body = blocksOf(editorHtml(str(s.content) ?? "", path, e, env));
		const titleBlock = body.find(isHeading);
		const link = linkOf(s.link, env);
		const title = titleBlock ? plain(titleBlock) : undefined;
		return [{ kind: "feature", item: { ...(title ? { title } : {}), body: body.filter((b) => b !== titleBlock), ...(icon ? { icon } : {}), ...(link.href ? { link: { label: title ?? "Learn more", href: link.href, style: "link" as const, ...(link.newTab ? { newTab: true } : {}) } } : {}) } }];
	},
	list: (e, s, path, env) => {
		const li = items(s.items)
			.map((it) => {
				const link = linkOf(it.link, env);
				const title = dynamicText(str(it.title) ?? "", path, e, env);
				const t = link.href ? `<a href="${esc(link.href)}"${link.newTab ? ' target="_blank"' : ""}>${title}</a>` : title;
				const text = [t, str(it.meta)].filter(Boolean).join(" — ") + (str(it.description) ? `: ${str(it.description)}` : "");
				return text ? `<li>${text}</li>` : "";
			})
			.join("");
		return li ? richFromHtml(`<ul>${li}</ul>`, env.ctx(path)) : [];
	},

	// FAQ / tabs
	accordion: (e, s, path, env) =>
		// `accordions` (Bricks 1.x–2.5); older exports used `items`.
		items(s.accordions ?? s.items).map((it) => {
			const answer = blocksOf(editorHtml(str(it.content) ?? "", path, e, env));
			const sub = str(it.subtitle);
			return { kind: "faq" as const, question: stripTags(str(it.title) ?? ""), answer: sub ? [...blocksOf(richFromHtml(`<p>${esc(sub)}</p>`, env.ctx(path))), ...answer] : answer };
		}),
	"accordion-nested": (e, _s, path, env) =>
		// Each item is a block: a title block (heading + icon), then a content block (includes/elements/accordion-nested.php).
		env.childrenOf(e).map((item, k) => {
			const [title, ...rest] = env.childrenOf(item);
			const q = title ? blocksOf(env.fragments(title, `${path}/${k}`)).map(plain).join(" ").trim() : "";
			const answer = rest.flatMap((r) => env.fragments(r, `${path}/${k}`));
			const lost = answer.filter((f) => f.kind !== "rich" && f.kind !== "button");
			if (lost.length) env.diag({ level: "warn", code: "lossy", message: `[accordion-nested] item "${q}": ${lost.map((f) => f.kind).join(", ")} inside the answer not kept (answers are text)`, path, tag: e.name });
			return { kind: "faq" as const, question: q, answer: blocksOf(answer) };
		}),
	tabs: (e, s, path, env) => items(s.tabs).map((t) => ({ kind: "tab" as const, label: stripTags(str(t.title) ?? ""), body: blocksOf(editorHtml(str(t.content) ?? "", path, e, env)) })),
	"tabs-nested": (e, _s, path, env) => {
		// Two children: the tab menu (titles) and the tab content (panes), matched by order.
		const kids = env.childrenOf(e);
		const cls = (x: BricksElement) => classNames(x, env.site).join(" ");
		const menu = kids.find((k) => /\btab-menu\b/.test(cls(k))) ?? kids[0];
		const content = kids.find((k) => /\btab-content\b/.test(cls(k))) ?? kids[1];
		const labels = menu ? env.childrenOf(menu).map((t) => blocksOf(env.fragments(t, path)).map(plain).join(" ").trim()) : [];
		return (content ? env.childrenOf(content) : []).map((pane, k) => ({ kind: "tab" as const, label: labels[k] || `Tab ${k + 1}`, body: blocksOf(env.fragments(pane, `${path}/${k}`)) }));
	},

	// Sliders → gallery or cards
	slider: (e, s, path, env) => {
		const cols: Col[] = items(s.items).map((it) => {
			const tag = /^h[1-6]$/.test(str(it.titleTag) ?? "") ? (it.titleTag as string) : "h3";
			const bg = mediaOf(obj(it.background)?.image);
			const frags: Fragment[] = [
				...(bg ? [{ kind: "media" as const, media: bg, role: "content" as const }] : []),
				...(str(it.title) ? richFromHtml(`<${tag}>${dynamicText(str(it.title) as string, path, e, env)}</${tag}>`, env.ctx(path)) : []),
				...(str(it.content) ? editorHtml(str(it.content) as string, path, e, env) : []),
				...(str(it.buttonText) ? buttonOf(str(it.buttonText) as string, linkOf(it.buttonLink, env), e, path, env, "primary") : []),
			];
			return { fragments: frags };
		});
		return slides(cols, e, path, env);
	},
	"slider-nested": (e, _s, path, env) => slides(env.childrenOf(e).map((slide, k) => env.column(slide, `${path}/${k}`)), e, path, env),

	// Collections
	testimonials: (e, s, path, env) =>
		items(s.items).map((t) => {
			const photo = mediaOf(t.image);
			const quote = blocksOf(editorHtml(str(t.content) ?? "", path, e, env)).map(plain).join("\n").trim();
			return { kind: "testimonial" as const, item: { quote, ...(str(t.name) ? { name: str(t.name) } : {}), ...(str(t.title) ? { role: str(t.title) } : {}), ...(photo ? { photo } : {}) } };
		}),
	"team-members": (e, s, path, env) =>
		items(s.items).map((m) => {
			const photo = mediaOf(m.image);
			return { kind: "team" as const, member: { name: stripTags(str(m.title) ?? ""), ...(str(m.subtitle) ? { role: str(m.subtitle) } : {}), ...(photo ? { photo } : {}), bio: blocksOf(editorHtml(str(m.description) ?? "", path, e, env)), links: [] } };
		}),
	"pricing-tables": (e, s, path, env) => {
		const tabs = !!s.tabs;
		if (tabs) env.diag({ level: "info", code: "lossy", message: `[pricing-tables] ${str(s.tab1Label) ?? "Tab 1"} / ${str(s.tab2Label) ?? "Tab 2"} switch shown as one list (plan names carry the tab)`, path, tag: e.name });
		return items(s.pricingTables).map((t) => {
			const tab = str(t.showUnder) === "tab-2" ? (str(s.tab2Label) ?? "Tab 2") : (str(s.tab1Label) ?? "Tab 1");
			const price = [str(t.pricePrefix), str(t.price), str(t.priceSuffix)].filter(Boolean).join("");
			const btn = str(t.buttonText) ? buttonOf(str(t.buttonText) as string, linkOf(t.buttonLink, env), e, path, env, "primary")[0] : undefined;
			const description = [str(t.subtitle), str(t.additionalInfo) ? stripTags(str(t.additionalInfo) as string) : undefined].filter(Boolean).join(" · ");
			return {
				kind: "price" as const,
				plan: { name: `${stripTags(str(t.title) ?? "")}${tabs ? ` (${tab})` : ""}`, ...(price ? { price } : {}), ...(str(t.priceMeta) ? { period: str(t.priceMeta) } : {}), ...(description ? { description } : {}), features: (str(t.features) ?? "").split(/\r?\n/).map((l) => stripTags(l)).filter(Boolean), ...(btn?.kind === "button" ? { button: btn.button } : {}), highlight: !!str(t.ribbonText) },
			};
		});
	},
	counter: (_e, s) => {
		const value = str(s.countTo);
		return value ? [{ kind: "stat", item: { value, label: "", ...(str(s.prefix) ? { prefix: str(s.prefix) } : {}), ...(str(s.suffix) ? { suffix: str(s.suffix) } : {}) } }] : [];
	},
	"progress-bar": (e, s, path, env) => {
		const bars = items(s.bars).filter((b) => str(b.percentage));
		if (bars.length) env.diag({ level: "info", code: "lossy", message: "[progress-bar] bars shown as figures", path, tag: e.name });
		return bars.map((b) => ({ kind: "stat" as const, item: { value: String(Number.parseFloat(str(b.percentage) as string)), suffix: "%", label: stripTags(str(b.title) ?? "") } }));
	},

	// Maps
	map: (e, s, path, env) => {
		const addrs = items(s.addresses);
		const first = addrs[0] ?? {};
		const address = str(first.address) ?? str(s.address);
		const lat = str(first.latitude);
		const lng = str(first.longitude);
		const q = address ?? (lat && lng ? `${lat},${lng}` : undefined);
		if (!q) {
			env.diag({ level: "warn", code: "unmapped", message: "[map] without an address or coordinates", path, tag: e.name });
			return [];
		}
		if (addrs.length > 1) env.diag({ level: "warn", code: "lossy", message: `[map] ${addrs.length} markers; the map shows the first (${q})`, path, tag: e.name });
		return [{ kind: "map", embedUrl: `https://maps.google.com/maps?q=${encodeURIComponent(q)}&output=embed`, ...(address ? { address } : {}) }];
	},
	"map-leaflet": (e, s, path, env) => {
		const markers = items(s.markers);
		const m = markers[0];
		const [lat, lng] = (str(m?.coordinates) ?? str(s.center) ?? "").split(",").map((x) => Number.parseFloat(x));
		if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
			env.diag({ level: "warn", code: "unmapped", message: "[map-leaflet] without coordinates", path, tag: e.name });
			return [];
		}
		if (markers.length > 1) env.diag({ level: "warn", code: "lossy", message: `[map-leaflet] ${markers.length} markers; the map shows the first`, path, tag: e.name });
		const d = 0.01;
		const label = stripTags(str(m?.popupText) ?? str(m?.label) ?? "");
		const [a, b] = [lat as number, lng as number];
		return [{ kind: "map", embedUrl: `https://www.openstreetmap.org/export/embed.html?bbox=${b - d},${a - d},${b + d},${a + d}&layer=mapnik&marker=${a},${b}`, ...(label ? { address: label } : {}) }];
	},

	// Forms
	form: (e, s, path, env) => {
		const src = env.sourceId();
		const id = src ? `${src}-${e.id}` : e.id;
		const def = bricksFormToDefinition(id, s, e.label ?? `Form ${e.id}`);
		env.forms.set(def.id, def);
		if (def.warnings.length) env.diag({ level: "warn", code: "lossy", message: `[form] ${def.warnings.join("; ")}`, path, tag: e.name });
		return [{ kind: "form", provider: "bricks", id }];
	},

	// Raw HTML / code / shortcodes
	code: (e, s, path, env) => {
		const code = str(s.code) ?? "";
		if (s.executeCode || /<\?php/.test(code)) {
			env.diag({ level: "error", code: "flagged", message: "[code] executes PHP on the server; never copied automatically — review and rebuild", path, carriesContent: true, tag: e.name });
			return code.trim() ? [{ kind: "legacy", html: code, reason: "Bricks code element (PHP)" }] : [];
		}
		const js = str(s.javascriptCode)?.trim();
		if (js) env.diag({ level: "error", code: "flagged", message: "[code] JavaScript is never copied automatically; review and rebuild", path, carriesContent: true, tag: e.name });
		return [...embedOrLegacy(code, env.ctx(path), "Bricks code element"), ...(js ? [{ kind: "legacy" as const, html: `<script>${js}</script>`, reason: "Bricks code element (JavaScript)" }] : [])];
	},
	html: (_e, s, path, env) => embedOrLegacy(str(s.html) ?? "", env.ctx(path), "Bricks HTML element"),
	shortcode: (_e, s, path, env) => {
		const sc = (str(s.shortcode) ?? "").trim();
		const form = new RegExp(`^${FORM_SHORTCODE.source}$`).test(sc) ? formShortcode(sc) : [];
		return form.length ? form : embedOrLegacy(sc, env.ctx(path), "Bricks shortcode element");
	},
};

/** Elements that are site chrome or query-driven: rendered by the site itself, not migrated as page content. */
export const DYNAMIC = new Set(["nav-menu", "nav-nested", "dropdown", "offcanvas", "toggle", "toggle-mode", "logo", "search", "post-content", "post-excerpt", "post-meta", "post-navigation", "post-comments", "post-author", "post-taxonomy", "post-sharing", "post-reading-time", "post-reading-progress-bar", "post-toc", "pagination", "breadcrumbs", "sidebar", "related-posts", "query-results-summary", "back-to-top", "language-switcher", "instagram-feed", "facebook-page", "map-connector"]);
/** Query filter elements (filter-*): they act on a query loop. */
export const isFilter = (name: string) => name.startsWith("filter-");
export const DECORATIVE = new Set(["divider", "spacer", "lottie"]);
