/**
 * Elementor widget handlers: one per `widgetType` → the shared fragments (src/adapters/wpbakery/elements.ts), which
 * the shared row recognisers turn into sections. Control ids are the widgets' registered controls (Elementor core
 * `includes/widgets/<name>.php`; Pro widgets from Elementor's documentation and exported template JSON), recorded in
 * docs/spikes/elementor-findings.md. Effects the section library does not have are reported as `lossy`.
 * Adding a handler: add it to HANDLERS, add a fixture in test/fixtures/elementor and its golden IR.
 */
import type { Button, Diagnostic, MediaRef, PtBlock, RichText } from "../../ir/schema.js";
import { autop } from "../../ir/portable-text.js";
import type { FormDefinitionOut } from "../../scaffold/forms.js";
import { type Col, embedOrLegacy, type Fragment, type HandlerCtx, richFromHtml } from "../wpbakery/elements.js";
import { elementorFormToDefinition } from "./forms.js";
import type { ElementorOptions } from "./index.js";
import { type ElementorElement, type ElementorKit, obj, settingsOf, str } from "./site.js";

type Obj = Record<string, unknown>;

export interface Env {
	kit: ElementorKit;
	opts: ElementorOptions;
	diag(d: Diagnostic): void;
	ctx(path: string): HandlerCtx;
	/** Fragments of a nested element (nested tabs/accordion/carousel panes are containers). */
	fragments(e: ElementorElement, path: string): Fragment[];
	column(e: ElementorElement, path: string): Col;
	forms: Map<string, FormDefinitionOut>;
	/** The post whose tree holds the element (a page, or a library template it embeds). */
	sourceId(): number | undefined;
}

type Handler = (e: ElementorElement, s: Obj, path: string, env: Env) => Fragment[];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
const items = (v: unknown): Obj[] => (Array.isArray(v) ? v : obj(v) ? Object.values(v as Obj) : []).map(obj).filter((x): x is Obj => !!x);
const blocksOf = (frags: Fragment[]): RichText => frags.flatMap((f) => (f.kind === "rich" ? f.blocks : []));
export const plain = (b: PtBlock) => b.children.map((c) => c.text).join("");
const isHeading = (b: PtBlock) => /^h[1-6]$/.test(b.style);
export const stripTags = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const tagOf = (v: unknown, d: string) => (/^h[1-6]$/.test(str(v) ?? "") ? (str(v) as string) : /^(p|div|span)$/.test(str(v) ?? "") ? "p" : d);
const wtype = (e: ElementorElement) => e.widgetType ?? e.elType;

// ── value readers ────────────────────────────────────────────────────────────

/** A dynamic tag (`[elementor-tag id="…" name="post-title" settings="%7B…%7D"]`) → its name and settings. */
export function dynamicTag(v: unknown): { name: string; settings: Obj } | undefined {
	const m = /\[elementor-tag\b[^\]]*\bname="([^"]+)"(?:[^\]]*\bsettings="([^"]*)")?/.exec(str(v) ?? "");
	if (!m) return undefined;
	let settings: Obj = {};
	try {
		settings = obj(JSON.parse(decodeURIComponent(m[2] ?? ""))) ?? {};
	} catch {}
	return { name: m[1] as string, settings };
}

/**
 * A text control, with its dynamic tag (`__dynamic__[key]`) resolved where the kit knows the value (post title, site
 * title, current year); otherwise the static value is kept and the tag reported.
 */
export function textOf(e: ElementorElement, s: Obj, key: string, path: string, env: Env): string {
	const tag = dynamicTag(obj(s.__dynamic__)?.[key]);
	const own = str(s[key]) ?? "";
	if (!tag) return own;
	const known: Record<string, string | undefined> = { "post-title": env.opts.title, "site-title": env.opts.siteTitle, "page-title": env.opts.title };
	if (tag.name === "current-date-time" && /^Y$/.test(str(tag.settings.custom_format) ?? "")) return "{year}";
	const v = known[tag.name];
	if (v !== undefined && (env.opts.kind === "page" || env.opts.kind === "post" || tag.name === "site-title")) return esc(v);
	env.diag({ level: "warn", code: "dynamic", message: `[${wtype(e)}] ${key} is Elementor dynamic data (${tag.name}); ${own.trim() ? "the static text is kept" : "nothing to keep"}`, path, tag: wtype(e) });
	return own;
}

/** Elementor Pro popup action URL (`#elementor-action:action=popup:open&settings=<base64 {"id":"123"}>`) → popup id. */
export function popupActionId(href: string | undefined): number | undefined {
	if (!href) return undefined;
	let h = href;
	try {
		h = decodeURIComponent(href);
	} catch {}
	const m = /#elementor-action:action=popup:open(?:&|&amp;)settings=([A-Za-z0-9+/=]+)/.exec(h);
	if (!m) return undefined;
	try {
		const id = Number(obj(JSON.parse(Buffer.from(m[1] as string, "base64").toString("utf8")))?.id);
		return Number.isInteger(id) && id > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

/** URL control (`{ url, is_external: "on", nofollow }`), with a dynamic link tag (internal URL, popup) resolved. */
export function linkOf(e: ElementorElement, s: Obj, key: string, env: Env, path: string): { href?: string; newTab?: boolean; popup?: string } {
	const l = obj(s[key]) ?? (typeof s[key] === "string" ? { url: s[key] } : undefined);
	const tag = dynamicTag(obj(s.__dynamic__)?.[key]);
	const newTab = l?.is_external === "on" || l?.is_external === true || l?.is_external === "true";
	if (tag) {
		if (tag.name === "popup") {
			const slug = env.opts.popupSlug?.(Number(tag.settings.popup));
			if (slug) return { href: `#${slug}`, popup: slug };
		}
		if (tag.name === "internal-url") {
			const id = Number(tag.settings.post_id);
			const href = id > 0 ? env.opts.permalink?.(id) : undefined;
			if (href) return { href, ...(newTab ? { newTab } : {}) };
		}
		env.diag({ level: "warn", code: "dynamic", message: `[${wtype(e)}] link is Elementor dynamic data (${tag.name}); ${str(l?.url) ? "the static URL is kept" : "no link kept"}`, path, tag: wtype(e) });
	}
	const url = str(l?.url)?.trim();
	const pid = popupActionId(url);
	if (pid) {
		const slug = env.opts.popupSlug?.(pid);
		if (slug) return { href: `#${slug}`, popup: slug };
		env.diag({ level: "warn", code: "link-unknown", message: `[${wtype(e)}] opens Elementor popup ${pid}, which is not migrated (unpublished or missing)`, path, tag: wtype(e) });
		return {};
	}
	const popup = url ? env.opts.popupFor({ href: url }) : undefined;
	return { ...(url ? { href: url } : {}), ...(newTab ? { newTab } : {}), ...(popup ? { popup } : {}) };
}

const PLACEHOLDER = /\/elementor\/assets\/images\/placeholder\.png$/;
/** Media control (`{ url, id, alt? }`); Elementor's placeholder image counts as no image. */
export function mediaOf(v: unknown, alt?: string, kind: MediaRef["kind"] = "image"): MediaRef | undefined {
	const m = obj(v);
	if (!m) return undefined;
	const id = Number(m.id);
	const url = str(m.url)?.trim();
	if (url && PLACEHOLDER.test(url) && !(id > 0)) return undefined;
	const a = alt ?? str(m.alt);
	if (Number.isInteger(id) && id > 0) return { wpId: id, kind, ...(url ? { url } : {}), ...(a ? { alt: a } : {}) };
	return url ? { url, kind, ...(a ? { alt: a } : {}) } : undefined;
}

/** Icons control (`{ value: "fas fa-star", library: "fa-solid" }`, or `{ value: { url, id }, library: "svg" }`). */
export function iconOf(v: unknown): { library: string; name: string } | undefined {
	const i = obj(v);
	if (!i) return undefined;
	const lib = str(i.library) ?? "";
	if (lib === "svg") {
		const url = str(obj(i.value)?.url);
		return url ? { library: "svg", name: url } : undefined;
	}
	const name = str(i.value)?.trim();
	if (!name) return undefined;
	return { library: /^fa-|fontawesome/i.test(lib) ? "fontawesome" : lib || "custom", name: name.replace(/^(?:fa[srlbd]?|fa-solid|fa-regular|fa-brands)\s+fa-/, "").replace(/^eicon-/, "") };
}

/** An icon name (`facebook-f`, `x-twitter`, `envelope`) → a link label. */
export function iconLabel(name: string): string {
	const n = name.toLowerCase().replace(/-(square|alt|circle|fill|outline|sharp|f)$/g, "");
	const known: Record<string, string> = { "x-twitter": "X", twitter: "X", envelope: "Email", phone: "Phone", "phone-alt": "Phone", tiktok: "TikTok", youtube: "YouTube", linkedin: "LinkedIn", "linkedin-in": "LinkedIn", whatsapp: "WhatsApp" };
	return known[n] ?? n.split(/[-_]/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

const FORM_SHORTCODE = /\[(fluentform|contact-form-7|wpforms|gravityform|ninja_form|formidable)\b[^\]]*\]/g;
const FORM_PROVIDER: Record<string, string> = { fluentform: "fluent-forms", "contact-form-7": "cf7", wpforms: "wpforms", gravityform: "gravity-forms", ninja_form: "ninja-forms", formidable: "formidable" };
function formShortcode(sc: string): Fragment[] {
	const tag = /^\[([\w-]+)/.exec(sc)?.[1] ?? "";
	const id = /\bid=["']?([\w-]+)/.exec(sc)?.[1];
	return FORM_PROVIDER[tag] && id ? [{ kind: "form", provider: FORM_PROVIDER[tag] as string, id }] : [];
}

/** WYSIWYG HTML (Elementor runs wpautop and shortcodes on the text editor): rich text, form shortcodes as forms. */
export function editorHtml(html: string, path: string, env: Env): Fragment[] {
	const forms: Fragment[] = [];
	const rest = html.replace(FORM_SHORTCODE, (m) => {
		forms.push(...formShortcode(m));
		return "";
	});
	return [...richFromHtml(autop(rest), env.ctx(path)), ...forms];
}

function buttonOf(label: string, link: { href?: string; newTab?: boolean; popup?: string }, path: string, env: Env, style: Button["style"], large?: boolean): Fragment[] {
	const text = stripTags(label);
	if (!text) return [];
	if (!link.href) env.diag({ level: "warn", code: "link-unknown", message: `Button "${text}" has no link`, path });
	return [{ kind: "button", button: { label: text, href: link.href ?? "#", style, ...(large ? { size: "large" as const } : {}), ...(link.newTab ? { newTab: true } : {}), ...(link.popup ? { opensPopup: link.popup } : {}) } }];
}

function linkedText(text: string, tag: string, link: { href?: string; newTab?: boolean }, path: string, env: Env): Fragment[] {
	const inner = link.href ? `<a href="${esc(link.href)}"${link.newTab ? ' target="_blank"' : ""}>${text}</a>` : text;
	return richFromHtml(`<${tag}>${inner}</${tag}>`, env.ctx(path));
}

/** Social links as one paragraph of links (the starter draws them as round icons). */
function socialParagraph(links: { label: string; href: string; newTab?: boolean }[], env: Env): Fragment[] {
	if (!links.length) return [];
	const children: PtBlock["children"] = [];
	const markDefs: PtBlock["markDefs"] = [];
	links.forEach((b, i) => {
		const key = env.opts.keys.next();
		if (i) children.push({ _type: "span", _key: env.opts.keys.next(), text: " ", marks: [] });
		children.push({ _type: "span", _key: env.opts.keys.next(), text: b.label, marks: [key] });
		markDefs.push({ _type: "link", _key: key, href: b.href, ...(b.newTab ? { blank: true } : {}) });
	});
	return [{ kind: "rich", blocks: [{ _type: "block", _key: env.opts.keys.next(), style: "normal", children, markDefs }] }];
}

/** Query-driven widgets (posts, loop grids, portfolio): rendered from the site's entries (PLAN §7b), reported. */
export function dynamicListing(e: ElementorElement, s: Obj, path: string, env: Env): Fragment[] {
	const type = str(s.posts_post_type) ?? str(s.post_type) ?? (wtype(e) === "portfolio" ? "portfolio" : "post");
	if (type === "post" && env.opts.postCount === 0) {
		env.diag({ level: "info", code: "dynamic", message: `[${wtype(e)}] lists ${type} entries, but the site has none — dropped`, path, tag: wtype(e) });
		return [];
	}
	env.diag({ level: "error", code: "dynamic", message: `[${wtype(e)}] lists ${type} entries from the site's data; needs a posts-listing section (not in the v1 library) or a decision in overrides.ts`, path, carriesContent: true, tag: wtype(e) });
	return [];
}

/** A card's fragments → one feature item (title, body, image, icon, link). */
function cardOf(frags: Fragment[]): Fragment {
	const blocks = blocksOf(frags);
	const title = blocks.find(isHeading);
	const image = frags.find((f): f is Extract<Fragment, { kind: "media" }> => f.kind === "media")?.media;
	const icon = frags.find((f): f is Extract<Fragment, { kind: "icon" }> => f.kind === "icon")?.icon;
	const link = frags.find((f): f is Extract<Fragment, { kind: "button" }> => f.kind === "button")?.button;
	return { kind: "feature", item: { ...(title ? { title: plain(title) } : {}), body: blocks.filter((b) => b !== title), ...(image ? { image } : {}), ...(icon ? { icon } : {}), ...(link ? { link } : {}) } };
}

/** Slides → a carousel gallery when every slide is only pictures, else a row of cards (one column per slide). */
function slides(cols: Col[], e: ElementorElement, path: string, env: Env): Fragment[] {
	const filled = cols.filter((c) => c.fragments.length);
	if (!filled.length) return [];
	if (filled.every((c) => c.fragments.every((f) => f.kind === "media"))) return [{ kind: "gallery", images: filled.flatMap((c) => c.fragments.flatMap((f) => (f.kind === "media" ? [f.media] : []))), layout: "carousel" }];
	env.diag({ level: "info", code: "lossy", message: `[${wtype(e)}] ${filled.length} slide(s) shown side by side as cards (no slider in the section library)`, path, tag: wtype(e) });
	return [{ kind: "subrow", columns: filled }];
}

const CURRENCY: Record<string, string> = { dollar: "$", euro: "€", pound: "£", yen: "¥", franc: "₣", lira: "₺", peseta: "₧", baht: "฿", krona: "kr", real: "R$", rupee: "₹", indian_rupee: "₹", shekel: "₪", won: "₩", guilder: "ƒ" };

const imageFragments = (m: MediaRef | undefined, link?: string): Fragment[] => (m ? [{ kind: "media", media: m, role: "content", ...(link ? { link } : {}) }] : []);

// ── handlers ─────────────────────────────────────────────────────────────────
export const HANDLERS: Record<string, Handler> = {
	heading: (e, s, path, env) => {
		const text = textOf(e, s, "title", path, env);
		if (!stripTags(text)) return [];
		return linkedText(text.replace(/\r?\n/g, "<br>"), tagOf(s.header_size, "h2"), linkOf(e, s, "link", env, path), path, env);
	},
	"text-editor": (e, s, path, env) => {
		if (str(s.drop_cap) === "yes") env.diag({ level: "info", code: "lossy", message: "[text-editor] drop cap not reproduced", path, tag: e.widgetType });
		return editorHtml(textOf(e, s, "editor", path, env), path, env);
	},
	"animated-headline": (e, s, path, env) => {
		const rotating = (str(s.rotating_text) ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
		const middle = str(s.headline_style) === "rotate" ? rotating[0] : str(s.highlighted_text);
		const text = [str(s.before_text), middle, str(s.after_text)].filter(Boolean).join(" ");
		if (!text.trim()) return [];
		env.diag({ level: "info", code: "lossy", message: `[animated-headline] animation not reproduced${rotating.length > 1 ? `; first phrase kept, others: ${rotating.slice(1).join(" | ")}` : ""}`, path, tag: e.widgetType });
		return linkedText(esc(text), tagOf(s.tag, "h3"), linkOf(e, s, "link", env, path), path, env);
	},
	blockquote: (e, s, path, env) => {
		const quote = textOf(e, s, "blockquote_content", path, env);
		const name = str(s.author_name);
		return quote.trim() ? richFromHtml(`<blockquote>${quote}${name ? `<br>— ${esc(name)}` : ""}</blockquote>`, env.ctx(path)) : [];
	},
	alert: (e, s, path, env) => {
		env.diag({ level: "info", code: "lossy", message: "[alert] notice box styling not reproduced; text kept", path, tag: e.widgetType });
		return [...(str(s.alert_title) ? richFromHtml(`<p><strong>${esc(str(s.alert_title) as string)}</strong></p>`, env.ctx(path)) : []), ...editorHtml(str(s.alert_description) ?? "", path, env)];
	},
	"star-rating": (e, s, path, env) => {
		const r = Number(s.rating ?? 5);
		const scale = Number(s.rating_scale ?? 5);
		env.diag({ level: "info", code: "lossy", message: "[star-rating] stars shown as text", path, tag: e.widgetType });
		return richFromHtml(`<p>${esc([str(s.title), `${r}/${scale}`].filter(Boolean).join(" "))}</p>`, env.ctx(path));
	},

	// Buttons
	button: (e, s, path, env) => {
		const type = str(s.button_type) ?? "";
		return buttonOf(textOf(e, s, "text", path, env), linkOf(e, s, "link", env, path), path, env, type === "info" || type === "warning" ? "secondary" : "primary", /^(lg|xl)$/.test(str(s.size) ?? ""));
	},
	"call-to-action": (e, s, path, env) => {
		const tag = tagOf(s.title_tag, "h2");
		const link = linkOf(e, s, "link", env, path);
		const bg = mediaOf(s.bg_image);
		const graphic = str(s.graphic_element) === "image" ? mediaOf(s.graphic_image) : undefined;
		const icon = str(s.graphic_element) === "icon" ? iconOf(s.selected_icon) : undefined;
		if (str(s.ribbon_title)) env.diag({ level: "info", code: "lossy", message: `[call-to-action] ribbon "${str(s.ribbon_title)}" not reproduced`, path, tag: e.widgetType });
		return [
			...imageFragments(bg ?? graphic),
			...(icon ? [{ kind: "icon" as const, icon }] : []),
			...(str(s.title) ? richFromHtml(`<${tag}>${textOf(e, s, "title", path, env)}</${tag}>`, env.ctx(path)) : []),
			...(str(s.description) ? editorHtml(textOf(e, s, "description", path, env), path, env) : []),
			...(str(s.button) ? buttonOf(textOf(e, s, "button", path, env), link, path, env, "primary") : []),
		];
	},

	// Images & media
	image: (e, s, path, env) => {
		const media = mediaOf(s.image);
		if (!media) {
			if (dynamicTag(obj(s.__dynamic__)?.image)) env.diag({ level: "warn", code: "dynamic", message: `[image] is Elementor dynamic data (${dynamicTag(obj(s.__dynamic__)?.image)?.name}); not migrated`, path, tag: e.widgetType });
			else env.diag({ level: "warn", code: "media-missing", message: "[image] without an image", path, tag: e.widgetType });
			return [];
		}
		const to = str(s.link_to);
		const href = to === "custom" ? linkOf(e, s, "link", env, path).href : to === "file" ? media.url : undefined;
		const caption = str(s.caption_source) === "custom" ? str(s.caption) : undefined;
		if (str(s.caption_source) === "attachment") env.diag({ level: "info", code: "lossy", message: "[image] caption from the media library not shown", path, tag: e.widgetType });
		return [...imageFragments(media, href), ...(caption ? richFromHtml(`<p>${esc(caption)}</p>`, env.ctx(path)) : [])];
	},
	"image-gallery": (e, s, path, env) => {
		const images = items(s.wp_gallery).flatMap((i) => mediaOf(i) ?? []);
		return images.length ? [{ kind: "gallery", images, layout: "grid" }] : [];
	},
	gallery: (e, s, path, env) => {
		const multi = str(s.gallery_type) === "multiple";
		const images = multi ? items(s.galleries).flatMap((g) => items(g.multiple_gallery).flatMap((i) => mediaOf(i) ?? [])) : items(s.gallery).flatMap((i) => mediaOf(i) ?? []);
		if (multi) env.diag({ level: "info", code: "lossy", message: `[gallery] ${items(s.galleries).length} filtered galleries shown as one gallery (no filter bar)`, path, tag: e.widgetType });
		if (str(s.gallery_layout) === "justified") env.diag({ level: "info", code: "lossy", message: "[gallery] justified layout shown as a grid", path, tag: e.widgetType });
		return images.length ? [{ kind: "gallery", images, layout: str(s.gallery_layout) === "masonry" ? "masonry" : "grid" }] : [];
	},
	"image-carousel": (e, s) => {
		const images = items(s.carousel).flatMap((i) => mediaOf(i) ?? []);
		return images.length ? [{ kind: "gallery", images, layout: "carousel" }] : [];
	},
	"media-carousel": (e, s, path, env) => {
		const images = items(s.slides).flatMap((i) => (str(i.type) === "video" ? [] : (mediaOf(i.image) ?? [])));
		const videos = items(s.slides).filter((i) => str(i.type) === "video").length;
		if (videos) env.diag({ level: "warn", code: "lossy", message: `[media-carousel] ${videos} video slide(s) not kept (the carousel shows pictures)`, path, tag: e.widgetType });
		return images.length ? [{ kind: "gallery", images, layout: "carousel" }] : [];
	},
	video: (e, s, path, env) => {
		const type = str(s.video_type) ?? "youtube";
		const poster = str(s.show_image_overlay) === "yes" ? mediaOf(s.image_overlay) : undefined;
		const withPoster = poster ? { poster } : {};
		const url = type === "youtube" ? str(s.youtube_url) : type === "vimeo" ? str(s.vimeo_url) : type === "dailymotion" ? str(s.dailymotion_url) : undefined;
		if (dynamicTag(obj(s.__dynamic__)?.[`${type}_url`] ?? obj(s.__dynamic__)?.hosted_url)) {
			env.diag({ level: "warn", code: "dynamic", message: "[video] source is Elementor dynamic data; not migrated", path, tag: e.widgetType });
			return [];
		}
		if (url?.trim()) {
			// The starter's video section plays YouTube, Vimeo and files only: a Dailymotion video stays a link to it.
			if (type === "dailymotion") {
				env.diag({ level: "warn", code: "lossy", message: `[video] Dailymotion video kept as a link (${url.trim()}); the video section plays YouTube, Vimeo and uploaded files`, path, tag: e.widgetType });
				return richFromHtml(`<p><a href="${esc(url.trim())}" target="_blank">Watch the video on Dailymotion</a></p>`, env.ctx(path));
			}
			return [{ kind: "video", embedUrl: url.trim(), ...withPoster }];
		}
		const file = str(s.insert_url) === "yes" ? (str(obj(s.external_url)?.url) ? { url: str(obj(s.external_url)?.url) as string, kind: "video" as const } : undefined) : mediaOf(s.hosted_url, undefined, "video");
		if (!file) {
			env.diag({ level: "warn", code: "media-missing", message: "[video] without a video", path, tag: e.widgetType });
			return [];
		}
		return [{ kind: "video", video: file, ...withPoster }];
	},
	audio: (e, s, path, env) => {
		const url = str(obj(s.link)?.url);
		return url ? embedOrLegacy(`<iframe src="https://w.soundcloud.com/player/?url=${encodeURIComponent(url)}"></iframe>`, env.ctx(path), "Elementor SoundCloud widget") : [];
	},

	// Icons & cards
	icon: (e, s, path, env) => {
		const icon = iconOf(s.selected_icon);
		const link = linkOf(e, s, "link", env, path);
		if (link.href && icon && icon.library !== "svg") {
			env.diag({ level: "info", code: "lossy", message: `[icon] linked icon kept as a "${iconLabel(icon.name)}" link (the icon itself is not drawn)`, path, tag: e.widgetType });
			return buttonOf(iconLabel(icon.name), { ...link, newTab: link.newTab ?? /^https?:/.test(link.href) }, path, env, "link");
		}
		return icon ? [{ kind: "icon", icon }] : [];
	},
	"icon-box": (e, s, path, env) => {
		const icon = iconOf(s.selected_icon);
		const link = linkOf(e, s, "link", env, path);
		const title = stripTags(textOf(e, s, "title_text", path, env));
		const body = blocksOf(editorHtml(textOf(e, s, "description_text", path, env), path, env));
		return [{ kind: "feature", item: { ...(title ? { title } : {}), body, ...(icon ? { icon } : {}), ...(link.href ? { link: { label: title || "Learn more", href: link.href, style: "link" as const, ...(link.newTab ? { newTab: true } : {}), ...(link.popup ? { opensPopup: link.popup } : {}) } } : {}) } }];
	},
	"image-box": (e, s, path, env) => {
		const image = mediaOf(s.image);
		const link = linkOf(e, s, "link", env, path);
		const title = stripTags(textOf(e, s, "title_text", path, env));
		const body = blocksOf(editorHtml(textOf(e, s, "description_text", path, env), path, env));
		return [{ kind: "feature", item: { ...(title ? { title } : {}), body, ...(image ? { image } : {}), ...(link.href ? { link: { label: title || "Learn more", href: link.href, style: "link" as const, ...(link.newTab ? { newTab: true } : {}) } } : {}) } }];
	},
	"flip-box": (e, s, path, env) => {
		const back = [str(s.title_text_b), stripTags(str(s.description_text_b) ?? "")].filter(Boolean).join(" — ");
		env.diag({ level: "info", code: "lossy", message: `[flip-box] flip effect not reproduced; front and back shown together${back ? ` (back: ${back.slice(0, 80)})` : ""}`, path, tag: e.widgetType });
		const link = linkOf(e, s, "link", env, path);
		const body = blocksOf([...editorHtml(str(s.description_text_a) ?? "", path, env), ...(str(s.title_text_b) ? richFromHtml(`<p><strong>${esc(str(s.title_text_b) as string)}</strong></p>`, env.ctx(path)) : []), ...editorHtml(str(s.description_text_b) ?? "", path, env)]);
		const icon = iconOf(s.selected_icon);
		const image = mediaOf(s.image);
		const title = stripTags(str(s.title_text_a) ?? "");
		return [{ kind: "feature", item: { ...(title ? { title } : {}), body, ...(image ? { image } : {}), ...(icon ? { icon } : {}), ...(link.href && str(s.button_text) ? { link: { label: stripTags(str(s.button_text) as string), href: link.href, style: "link" as const } } : {}) } }];
	},
	"icon-list": (e, s, path, env) => {
		const li = items(s.icon_list)
			.map((it) => {
				const text = str(it.text) ?? "";
				if (!stripTags(text)) return "";
				const link = linkOf(e, it, "link", env, path);
				return `<li>${link.href ? `<a href="${esc(link.href)}"${link.newTab ? ' target="_blank"' : ""}>${text}</a>` : text}</li>`;
			})
			.join("");
		return li ? richFromHtml(`<ul>${li}</ul>`, env.ctx(path)) : [];
	},
	"social-icons": (e, s, path, env) =>
		socialParagraph(
			items(s.social_icon_list).flatMap((i) => {
				const link = linkOf(e, i, "link", env, path);
				const name = iconOf(i.social_icon)?.name ?? "";
				return link.href && name ? [{ label: iconLabel(name), href: link.href, newTab: link.newTab ?? true }] : [];
			}),
			env,
		),

	// FAQ / tabs (legacy widgets keep items in a `tabs` repeater; nested ones keep each pane as a child container)
	accordion: (e, s, path, env) => items(s.tabs).map((t) => ({ kind: "faq" as const, question: stripTags(str(t.tab_title) ?? ""), answer: blocksOf(editorHtml(str(t.tab_content) ?? "", path, env)) })),
	toggle: (e, s, path, env) => items(s.tabs).map((t) => ({ kind: "faq" as const, question: stripTags(str(t.tab_title) ?? ""), answer: blocksOf(editorHtml(str(t.tab_content) ?? "", path, env)) })),
	"nested-accordion": (e, s, path, env) => {
		const titles = items(s.items).map((t) => stripTags(str(t.item_title) ?? ""));
		return (e.elements ?? []).map((pane, k) => {
			const frags = env.fragments(pane, `${path}/${k}`);
			const lost = frags.filter((f) => f.kind !== "rich" && f.kind !== "button");
			if (lost.length) env.diag({ level: "warn", code: "lossy", message: `[nested-accordion] item "${titles[k] ?? k + 1}": ${lost.map((f) => f.kind).join(", ")} inside the answer not kept (answers are text)`, path, tag: e.widgetType });
			return { kind: "faq" as const, question: titles[k] || `Item ${k + 1}`, answer: blocksOf(frags) };
		});
	},
	tabs: (e, s, path, env) => items(s.tabs).map((t) => ({ kind: "tab" as const, label: stripTags(str(t.tab_title) ?? ""), body: blocksOf(editorHtml(str(t.tab_content) ?? "", path, env)) })),
	"nested-tabs": (e, s, path, env) => {
		const labels = items(s.tabs).map((t) => stripTags(str(t.tab_title) ?? ""));
		return (e.elements ?? []).map((pane, k) => ({ kind: "tab" as const, label: labels[k] || `Tab ${k + 1}`, body: blocksOf(env.fragments(pane, `${path}/${k}`)) }));
	},

	// Sliders / carousels
	slides: (e, s, path, env) =>
		slides(
			items(s.slides).map((it) => {
				const bg = mediaOf(it.background_image);
				const frags: Fragment[] = [
					...imageFragments(bg),
					...(str(it.heading) ? richFromHtml(`<h2>${str(it.heading)}</h2>`, env.ctx(path)) : []),
					...(str(it.description) ? editorHtml(str(it.description) as string, path, env) : []),
					...(str(it.button_text) ? buttonOf(str(it.button_text) as string, linkOf(e, it, "link", env, path), path, env, "primary") : []),
				];
				return { fragments: frags };
			}),
			e,
			path,
			env,
		),
	"nested-carousel": (e, _s, path, env) => slides((e.elements ?? []).map((pane, k) => env.column(pane, `${path}/${k}`)), e, path, env),

	// Collections
	testimonial: (e, s, path, env) => {
		const quote = stripTags(textOf(e, s, "testimonial_content", path, env));
		const photo = mediaOf(s.testimonial_image);
		const name = stripTags(textOf(e, s, "testimonial_name", path, env));
		const role = stripTags(textOf(e, s, "testimonial_job", path, env));
		return quote ? [{ kind: "testimonial", item: { quote, ...(name ? { name } : {}), ...(role ? { role } : {}), ...(photo ? { photo } : {}) } }] : [];
	},
	"testimonial-carousel": (e, s) =>
		items(s.slides).flatMap((t) => {
			const quote = stripTags(str(t.content) ?? "");
			const photo = mediaOf(t.image);
			return quote ? [{ kind: "testimonial" as const, item: { quote, ...(str(t.name) ? { name: str(t.name) } : {}), ...(str(t.title) ? { role: str(t.title) } : {}), ...(photo ? { photo } : {}) } }] : [];
		}),
	reviews: (e, s) =>
		items(s.slides).flatMap((t) => {
			const quote = stripTags(str(t.content) ?? "");
			const photo = mediaOf(t.image);
			const rating = Number(t.rating);
			return quote ? [{ kind: "testimonial" as const, item: { quote, ...(str(t.name) ? { name: str(t.name) } : {}), ...(str(t.title) ? { role: str(t.title) } : {}), ...(photo ? { photo } : {}), ...(rating >= 1 && rating <= 5 ? { rating } : {}) } }] : [];
		}),
	counter: (e, s, path, env) => {
		const value = str(s.ending_number);
		if (!value) return [];
		return [{ kind: "stat", item: { value, label: stripTags(textOf(e, s, "title", path, env)), ...(str(s.prefix) ? { prefix: str(s.prefix) } : {}), ...(str(s.suffix) ? { suffix: str(s.suffix) } : {}) } }];
	},
	progress: (e, s, path, env) => {
		const pct = Number(obj(s.percent)?.size ?? s.percent);
		if (!Number.isFinite(pct)) return [];
		env.diag({ level: "info", code: "lossy", message: "[progress] bar shown as a figure", path, tag: e.widgetType });
		return [{ kind: "stat", item: { value: String(Math.min(100, Math.max(0, pct))), suffix: "%", label: stripTags(textOf(e, s, "title", path, env)) } }];
	},
	"price-table": (e, s, path, env) => {
		const sym = str(s.currency_symbol) === "custom" ? (str(s.currency_symbol_custom) ?? "") : (CURRENCY[str(s.currency_symbol) ?? "dollar"] ?? "");
		const price = str(s.price) ? `${sym}${str(s.price)}` : undefined;
		const btn = str(s.button_text) ? buttonOf(str(s.button_text) as string, linkOf(e, s, "link", env, path), path, env, "primary")[0] : undefined;
		const description = [str(s.sub_heading), str(s.footer_additional_info)].filter(Boolean).join(" · ");
		if (str(s.sale) === "yes" && str(s.original_price)) env.diag({ level: "info", code: "lossy", message: `[price-table] original price ${sym}${str(s.original_price)} (on sale) not shown`, path, tag: e.widgetType });
		return [{ kind: "price", plan: { name: stripTags(str(s.heading) ?? ""), ...(price ? { price } : {}), ...(str(s.period) ? { period: str(s.period) } : {}), ...(description ? { description } : {}), features: items(s.features_list).map((f) => stripTags(str(f.item_text) ?? "")).filter(Boolean), ...(btn?.kind === "button" ? { button: btn.button } : {}), highlight: str(s.show_ribbon) === "yes" } }];
	},
	"price-list": (e, s, path, env) =>
		items(s.price_list).flatMap((it) => {
			const name = stripTags(str(it.title) ?? "");
			if (!name) return [];
			const link = linkOf(e, it, "link", env, path);
			return [{ kind: "price" as const, plan: { name, ...(str(it.price) ? { price: str(it.price) } : {}), ...(str(it.item_description) ? { description: stripTags(str(it.item_description) as string) } : {}), features: [], ...(link.href ? { button: { label: name, href: link.href, style: "link" as const } } : {}), highlight: false } }];
		}),

	// Maps
	google_maps: (e, s, path, env) => {
		const address = str(s.address)?.trim();
		if (!address) {
			env.diag({ level: "warn", code: "unmapped", message: "[google_maps] without an address", path, tag: e.widgetType });
			return [];
		}
		return [{ kind: "map", embedUrl: `https://maps.google.com/maps?q=${encodeURIComponent(address)}&output=embed`, address }];
	},

	// Forms
	form: (e, s, path, env) => {
		const src = env.sourceId();
		const id = src ? `${src}-${e.id}` : e.id;
		const def = elementorFormToDefinition(id, s, str(s.form_name) ?? `Form ${e.id}`);
		env.forms.set(def.id, def);
		if (def.warnings.length) env.diag({ level: "warn", code: "lossy", message: `[form] ${def.warnings.join("; ")}`, path, tag: e.widgetType });
		return [{ kind: "form", provider: "elementor", id }];
	},

	// Raw HTML / shortcodes
	html: (e, s, path, env) => embedOrLegacy(str(s.html) ?? "", env.ctx(path), "Elementor HTML widget"),
	shortcode: (e, s, path, env) => {
		const sc = (str(s.shortcode) ?? "").trim();
		const form = new RegExp(`^${FORM_SHORTCODE.source}$`).test(sc) ? formShortcode(sc) : [];
		return form.length ? form : embedOrLegacy(sc, env.ctx(path), "Elementor shortcode widget");
	},

	// Menus and logo (theme builder parts)
	"nav-menu": (e, s, path, env) => {
		const id = str(s.menu);
		const list = id ? env.opts.menuItems?.(id) : undefined;
		if (!list?.length) {
			env.diag({ level: "info", code: "dynamic", message: `[nav-menu] menu "${id ?? "?"}" is rendered by the site (header menu)`, path, tag: e.widgetType });
			return [];
		}
		if (env.opts.role === "header") {
			env.diag({ level: "info", code: "dynamic", message: `[nav-menu] menu "${id}" becomes the site's primary menu`, path, tag: e.widgetType });
			return [];
		}
		env.diag({ level: "info", code: "dynamic", message: `[nav-menu] menu "${id}": its ${list.length} links kept as text links (edit them on the page, not under Menus)`, path, tag: e.widgetType });
		return list.flatMap((i) => buttonOf(i.label, { href: i.href, ...(i.newTab ? { newTab: true } : {}) }, path, env, "link"));
	},
	"theme-site-logo": (e, s, path, env) => {
		env.diag({ level: "info", code: "dynamic", message: "[site-logo] the starter's header draws the site logo", path, tag: e.widgetType });
		return [];
	},
	"theme-post-title": (e, _s, path, env) => {
		if (!env.opts.title || (env.opts.kind !== "page" && env.opts.kind !== "post")) {
			env.diag({ level: "info", code: "dynamic", message: `[${e.widgetType}] is rendered by the site template`, path, tag: e.widgetType });
			return [];
		}
		env.diag({ level: "info", code: "dynamic", message: `[${e.widgetType}] filled with the page title`, path, tag: e.widgetType });
		return richFromHtml(`<h1>${esc(env.opts.title)}</h1>`, env.ctx(path));
	},
};
HANDLERS["site-logo"] = HANDLERS["theme-site-logo"] as Handler;
HANDLERS["theme-page-title"] = HANDLERS["theme-post-title"] as Handler;

/** Query-driven widgets: reported as dynamic listings. */
export const LISTINGS = new Set(["posts", "archive-posts", "portfolio", "loop-grid", "loop-carousel", "theme-archive-posts"]);
/** Site chrome or per-request data: rendered by the site, not migrated as page content. */
export const DYNAMIC = new Set(["search-form", "search", "theme-site-title", "site-title", "theme-post-content", "post-content", "theme-post-excerpt", "theme-post-featured-image", "post-info", "post-navigation", "post-comments", "author-box", "breadcrumbs", "sitemap", "share-buttons", "sidebar", "wp-widget-recent-posts", "login", "table-of-contents", "countdown", "progress-tracker", "reading-time", "woocommerce-menu-cart", "mega-menu", "menu-anchor", "facebook-page", "facebook-embed", "facebook-button", "facebook-comments"]);
export const DECORATIVE = new Set(["divider", "spacer", "lottie", "text-path"]);
export { settingsOf };
