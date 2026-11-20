/**
 * Divi module handlers: one per shortcode tag (`et_pb_*`) → the shared fragments (src/adapters/wpbakery/elements.ts),
 * which the shared row recognisers turn into sections. Attribute names are Divi 4's module fields as saved in
 * post_content, recorded in docs/spikes/divi-findings.md. Effects the section library does not have are `lossy`.
 * Adding a handler: add it to HANDLERS, add a fixture in test/fixtures/divi and its golden IR.
 */
import type { Button, Diagnostic, MediaRef, PtBlock, RichText } from "../../ir/schema.js";
import type { FormDefinitionOut } from "../../scaffold/forms.js";
import { embedOrLegacy, type Fragment, type HandlerCtx, mediaFrom, richFromHtml } from "../wpbakery/elements.js";
import { innerSource, type ShortcodeNode } from "../wpbakery/parser.js";
import { diviFormToDefinition } from "./forms.js";
import type { DiviOptions } from "./index.js";
import { decodeCode, type DiviSite, dynamicContent } from "./site.js";

export interface Env {
	opts: DiviOptions;
	site: DiviSite;
	diag(d: Diagnostic): void;
	ctx(path: string): HandlerCtx;
	/** A module's children (text + nested shortcodes) as fragments. */
	children(n: ShortcodeNode, path: string): Fragment[];
	forms: Map<string, FormDefinitionOut>;
	/** Next contact form number on this post (form ids: `<postId>-<n>`). */
	nextForm(): number;
}

type Handler = (n: ShortcodeNode, path: string, env: Env) => Fragment[];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
export const stripTags = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const kids = (n: ShortcodeNode, tag: string) => n.children.filter((c): c is ShortcodeNode => c.type === "shortcode" && c.tag === tag);
const blocksOf = (frags: Fragment[]): RichText => frags.flatMap((f) => (f.kind === "rich" ? f.blocks : []));
const on = (v: string | undefined) => v === "on";

/**
 * An attribute value with dynamic content (`@ET-DC@…@`) resolved where the kit knows it (post title, site title,
 * current year); otherwise the static text after the token is kept (usually none) and the token reported.
 */
export function attr(n: ShortcodeNode, key: string, path: string, env: Env): string {
	return resolveDynamic(n.attrs[key] ?? "", n.tag, key, path, env);
}

export function resolveDynamic(v: string, tag: string, key: string, path: string, env: Env): string {
	if (!v.includes("@ET-DC@")) return v;
	return v.replace(/@ET-DC@[A-Za-z0-9+/=]+@/g, (token) => {
		const d = dynamicContent(token);
		if (!d) return token;
		const known: Record<string, string | undefined> = { post_title: env.opts.title, site_title: env.opts.siteTitle };
		let value: string | undefined = known[d.content];
		if (d.content === "current_date" && /^Y$/.test(String(d.settings.custom_date_format ?? ""))) value = "{year}";
		if (d.content === "post_title" && env.opts.kind !== "page" && env.opts.kind !== "post") value = undefined;
		if (value !== undefined) return `${String(d.settings.before ?? "")}${value === "{year}" ? value : esc(value)}${String(d.settings.after ?? "")}`;
		env.diag({ level: "warn", code: "dynamic", message: `[${tag}] ${key} has Divi dynamic content (${d.content}) the kit cannot fill; the static text around it is kept`, path, tag });
		return "";
	});
}

/** A module's text content (its enclosed HTML), with dynamic content resolved. */
function contentOf(n: ShortcodeNode, path: string, env: Env): string {
	return resolveDynamic(innerSource(n), n.tag, "content", path, env);
}

function buttonOf(label: string, href: string | undefined, path: string, env: Env, o: { style?: Button["style"]; newTab?: boolean; classes?: string } = {}): Fragment[] {
	const text = stripTags(label);
	if (!text) return [];
	const popup = env.opts.popupFor({ ...(href ? { href } : {}), ...(o.classes ? { classes: o.classes } : {}) });
	if (!href && !popup) env.diag({ level: "warn", code: "link-unknown", message: `Button "${text}" has no link`, path });
	return [{ kind: "button", button: { label: text, href: href?.trim() || (popup ? `#${popup}` : "#"), style: o.style ?? "primary", ...(o.newTab ? { newTab: true } : {}), ...(popup ? { opensPopup: popup } : {}) } }];
}

const imageFragments = (m: MediaRef | undefined, link?: string): Fragment[] => (m ? [{ kind: "media", media: m, role: "content", ...(link ? { link } : {}) }] : []);

/** Divi font icon (`&#xe08d;||divi||400`, Font Awesome `&#xf0e0;||fa||900`, legacy `%%52%%`) → an icon reference. */
export function iconOf(v: string | undefined): { library: string; name: string } | undefined {
	const t = (v ?? "").trim();
	if (!t) return undefined;
	const [glyph, family] = t.split("||");
	const code = /&#x([0-9a-f]+);/i.exec(glyph ?? "")?.[1] ?? /^%%(\d+)%%$/.exec(glyph ?? "")?.[1] ?? glyph?.trim();
	if (!code) return undefined;
	return { library: family === "fa" ? "fontawesome" : "divi", name: code.toLowerCase() };
}

/** Network name of a social follow item → its link label. */
const NETWORK: Record<string, string> = { facebook: "Facebook", twitter: "X", "x-twitter": "X", instagram: "Instagram", linkedin: "LinkedIn", youtube: "YouTube", pinterest: "Pinterest", tiktok: "TikTok", vimeo: "Vimeo", tumblr: "Tumblr", skype: "Skype", flickr: "Flickr", dribbble: "Dribbble", rss: "RSS", whatsapp: "WhatsApp", telegram: "Telegram", github: "GitHub", behance: "Behance", snapchat: "Snapchat", "google-plus": "Google+" };

/** Social links as one paragraph of links (the starter draws them as round icons), as the Elementor adapter does. */
function socialParagraph(links: { label: string; href: string }[], env: Env): Fragment[] {
	if (!links.length) return [];
	const children: PtBlock["children"] = [];
	const markDefs: PtBlock["markDefs"] = [];
	links.forEach((b, i) => {
		const key = env.opts.keys.next();
		if (i) children.push({ _type: "span", _key: env.opts.keys.next(), text: " ", marks: [] });
		children.push({ _type: "span", _key: env.opts.keys.next(), text: b.label, marks: [key] });
		markDefs.push({ _type: "link", _key: key, href: b.href, blank: true });
	});
	return [{ kind: "rich", blocks: [{ _type: "block", _key: env.opts.keys.next(), style: "normal", children, markDefs }] }];
}

/** A slide / fullwidth header's own content (its background is lifted onto the row by the adapter when it is alone). */
function slideFragments(n: ShortcodeNode, path: string, env: Env, o: { titleKey: string; level: string; withBackground: boolean }): Fragment[] {
	const ctx = env.ctx(path);
	const title = attr(n, o.titleKey, path, env);
	const bg = o.withBackground ? mediaFrom(n.attrs.background_image ?? n.attrs.background_url) : undefined;
	const side = mediaFrom(n.attrs.image ?? n.attrs.header_image_url, "image", n.attrs.image_alt);
	const out: Fragment[] = [
		...imageFragments(bg),
		...(title.trim() ? richFromHtml(`<${o.level}>${title}</${o.level}>`, ctx) : []),
		...(n.attrs.subhead?.trim() ? richFromHtml(`<p>${attr(n, "subhead", path, env)}</p>`, ctx) : []),
		...richFromHtml(contentOf(n, path, env), ctx),
		...imageFragments(side),
	];
	if (n.tag === "et_pb_slide") out.push(...buttonOf(attr(n, "button_text", path, env), n.attrs.button_link, path, env, { newTab: on(n.attrs.url_new_window) }));
	else {
		out.push(...buttonOf(attr(n, "button_one_text", path, env), n.attrs.button_one_url, path, env, { newTab: on(n.attrs.url_new_window) }));
		out.push(...buttonOf(attr(n, "button_two_text", path, env), n.attrs.button_two_url, path, env, { style: "secondary", newTab: on(n.attrs.url_new_window) }));
	}
	if (n.attrs.logo_image_url) env.diag({ level: "info", code: "lossy", message: `[${n.tag}] logo image above the title kept as a picture`, path, tag: n.tag });
	const logo = mediaFrom(n.attrs.logo_image_url, "image", n.attrs.logo_alt_text);
	return [...imageFragments(logo), ...out];
}

function slider(n: ShortcodeNode, path: string, env: Env): Fragment[] {
	const slides = kids(n, "et_pb_slide");
	if (slides.length === 1) return slideFragments(slides[0] as ShortcodeNode, `${path}/et_pb_slide[0]`, env, { titleKey: "heading", level: "h2", withBackground: false });
	const cols = slides.map((s, i) => ({ fragments: slideFragments(s, `${path}/et_pb_slide[${i}]`, env, { titleKey: "heading", level: "h3", withBackground: true }) })).filter((c) => c.fragments.length);
	if (!cols.length) return [];
	if (cols.every((c) => c.fragments.every((f) => f.kind === "media"))) return [{ kind: "gallery", images: cols.flatMap((c) => c.fragments.flatMap((f) => (f.kind === "media" ? [f.media] : []))), layout: "carousel" }];
	env.diag({ level: "info", code: "lossy", message: `[${n.tag}] ${cols.length} slides shown side by side as cards (no slider in the section library)`, path, tag: n.tag });
	return [{ kind: "subrow", columns: cols }];
}

function video(src: string | undefined, poster: string | undefined): Fragment[] {
	const url = (src ?? "").trim();
	if (!url) return [];
	const p = mediaFrom(poster);
	const withPoster = p ? { poster: p } : {};
	if (/youtu\.?be|vimeo\.com/i.test(url)) return [{ kind: "video", embedUrl: url, ...withPoster }];
	const v = mediaFrom(url, "video");
	return v ? [{ kind: "video", video: v, ...withPoster }] : [];
}

function map(n: ShortcodeNode, path: string, env: Env): Fragment[] {
	const pins = kids(n, "et_pb_map_pin");
	const first = pins[0]?.attrs;
	const address = (first?.pin_address ?? n.attrs.address ?? "").trim() || [first?.pin_address_lat ?? n.attrs.address_lat, first?.pin_address_lng ?? n.attrs.address_lng].filter(Boolean).join(",");
	if (pins.length > 1) env.diag({ level: "info", code: "lossy", message: `[${n.tag}] ${pins.length} pins: the map shows the first (${address}); the others are listed below it`, path, tag: n.tag });
	const more = pins.slice(1).map((p) => [p.attrs.title, p.attrs.pin_address].filter(Boolean).join(": ")).filter(Boolean);
	return [...(address ? [{ kind: "map" as const, address }] : []), ...(more.length ? richFromHtml(`<ul>${more.map((m) => `<li>${esc(m)}</li>`).join("")}</ul>`, env.ctx(path)) : [])];
}

/** Pricing table body: one feature per line; a leading `-` marks an excluded feature, `+` an included one. */
function features(html: string): { text: string; included: boolean }[] {
	return html
		.replace(/<\/(p|li|div)>|<br\s*\/?>/gi, "\n")
		.replace(/<[^>]+>/g, "")
		.split(/\n/)
		.map((l) => l.replace(/&nbsp;/g, " ").trim())
		.filter(Boolean)
		.map((l) => ({ text: l.replace(/^[-+]\s*/, ""), included: !l.startsWith("-") }));
}

// ── handlers ─────────────────────────────────────────────────────────────────
export const HANDLERS: Record<string, Handler> = {
	et_pb_text: (n, path, env) => env.children(n, path),
	et_pb_post_title: (n, path, env) => {
		if (!env.opts.title || (env.opts.kind !== "page" && env.opts.kind !== "post")) {
			env.diag({ level: "info", code: "dynamic", message: `[${n.tag}] is rendered by the site template`, path, tag: n.tag });
			return [];
		}
		env.diag({ level: "info", code: "dynamic", message: `[${n.tag}] filled with the page title`, path, tag: n.tag });
		return richFromHtml(`<h1>${esc(env.opts.title)}</h1>`, env.ctx(path));
	},
	et_pb_heading: (n, path, env) => {
		const level = /^h[1-6]$/.test(n.attrs.title_level ?? "") ? (n.attrs.title_level as string) : "h2";
		const t = attr(n, "title", path, env);
		return t.trim() ? richFromHtml(`<${level}>${t}</${level}>`, env.ctx(path)) : [];
	},

	// Buttons
	et_pb_button: (n, path, env) => buttonOf(attr(n, "button_text", path, env), n.attrs.button_url, path, env, { newTab: on(n.attrs.url_new_window), ...(n.attrs.module_class ? { classes: n.attrs.module_class } : {}) }),
	et_pb_cta: (n, path, env) => {
		const ctx = env.ctx(path);
		const title = attr(n, "title", path, env);
		return [...(title.trim() ? richFromHtml(`<h2>${title}</h2>`, ctx) : []), ...richFromHtml(contentOf(n, path, env), ctx), ...buttonOf(attr(n, "button_text", path, env), n.attrs.button_url, path, env, { newTab: on(n.attrs.url_new_window) })];
	},

	// Images & media
	et_pb_image: (n, path, env) => {
		const m = mediaFrom(n.attrs.src, "image", n.attrs.alt);
		if (!m) {
			env.diag({ level: "warn", code: "media-missing", message: `[${n.tag}] without an image`, path, tag: n.tag });
			return [];
		}
		if (on(n.attrs.show_in_lightbox)) env.diag({ level: "info", code: "lossy", message: `[${n.tag}] lightbox not reproduced; the picture is shown`, path, tag: n.tag });
		const link = n.attrs.url?.trim() || undefined;
		if (link) env.diag({ level: "info", code: "lossy", message: `[${n.tag}] links to ${link}; pictures in the section library carry no link, add it on the page if it matters`, path, tag: n.tag });
		return imageFragments(m, link);
	},
	et_pb_gallery: (n, path, env) => {
		const ids = (n.attrs.gallery_ids ?? "").split(",").map((s) => Number(s.trim())).filter((x) => Number.isInteger(x) && x > 0);
		if (!ids.length) {
			env.diag({ level: "warn", code: "media-missing", message: `[${n.tag}] has no pictures`, path, tag: n.tag });
			return [];
		}
		return [{ kind: "gallery", images: ids.map((id) => ({ wpId: id, kind: "image" as const })), layout: on(n.attrs.fullwidth) ? "carousel" : "grid" }];
	},
	et_pb_video: (n) => video(n.attrs.src || n.attrs.src_webm, n.attrs.image_src),
	et_pb_video_slider: (n, path, env) => {
		const items = kids(n, "et_pb_video_slider_item");
		if (items.length > 1) env.diag({ level: "info", code: "lossy", message: `[${n.tag}] ${items.length} videos shown one after another (no video slider)`, path, tag: n.tag });
		return items.flatMap((i) => video(i.attrs.src || i.attrs.src_webm, i.attrs.image_src));
	},
	et_pb_slider: slider,
	et_pb_fullwidth_header: (n, path, env) => {
		if (n.attrs.scroll_down_icon === "on" || n.attrs.show_scroll_down === "on") env.diag({ level: "info", code: "lossy", message: `[${n.tag}] scroll-down arrow not reproduced`, path, tag: n.tag });
		return slideFragments(n, path, env, { titleKey: "title", level: "h1", withBackground: false });
	},

	// Icons, blurbs
	et_pb_icon: (n) => {
		const icon = iconOf(n.attrs.font_icon);
		return icon ? [{ kind: "icon", icon }] : [];
	},
	et_pb_blurb: (n, path, env) => {
		const title = stripTags(attr(n, "title", path, env));
		const image = on(n.attrs.use_icon) ? undefined : mediaFrom(n.attrs.image, "image", n.attrs.alt);
		const icon = on(n.attrs.use_icon) ? iconOf(n.attrs.font_icon) : undefined;
		const url = n.attrs.url?.trim();
		const link = url && title ? (buttonOf(title, url, path, env, { style: "link", newTab: on(n.attrs.url_new_window) })[0] as Extract<Fragment, { kind: "button" }> | undefined)?.button : undefined;
		return [{ kind: "feature", item: { ...(title ? { title } : {}), body: blocksOf(richFromHtml(contentOf(n, path, env), env.ctx(path))), ...(image ? { image } : {}), ...(icon ? { icon } : {}), ...(link ? { link } : {}) } }];
	},

	// Collections
	et_pb_testimonial: (n, path, env) => {
		const quote = stripTags(contentOf(n, path, env));
		if (!quote) return [];
		const photo = mediaFrom(n.attrs.portrait_url);
		const role = [n.attrs.job_title, n.attrs.company_name].map((x) => stripTags(x ?? "")).filter(Boolean).join(", ");
		const name = stripTags(attr(n, "author", path, env));
		return [{ kind: "testimonial", item: { quote, ...(name ? { name } : {}), ...(role ? { role } : {}), ...(photo ? { photo } : {}) } }];
	},
	et_pb_team_member: (n, path, env) => {
		const links: Button[] = [];
		for (const [key, label] of [["facebook_url", "Facebook"], ["twitter_url", "X"], ["google_url", "Google"], ["linkedin_url", "LinkedIn"], ["instagram_url", "Instagram"]] as const) {
			const href = n.attrs[key]?.trim();
			if (href) links.push({ label, href, style: "link", newTab: true });
		}
		const photo = mediaFrom(n.attrs.image_url);
		const position = stripTags(n.attrs.position ?? "");
		return [{ kind: "team", member: { name: stripTags(attr(n, "name", path, env)), ...(position ? { role: position } : {}), ...(photo ? { photo } : {}), bio: blocksOf(richFromHtml(contentOf(n, path, env), env.ctx(path))), links } }];
	},
	et_pb_pricing_tables: (n, path, env) =>
		kids(n, "et_pb_pricing_table").flatMap((t, i) => {
			const p = `${path}/et_pb_pricing_table[${i}]`;
			const list = features(contentOf(t, p, env));
			const excluded = list.filter((f) => !f.included);
			if (excluded.length) env.diag({ level: "info", code: "lossy", message: `[et_pb_pricing_table] ${excluded.length} excluded feature(s) (struck through in Divi) kept with "(not included)"`, path: p, tag: "et_pb_pricing_table" });
			const btn = buttonOf(attr(t, "button_text", p, env), t.attrs.button_url, p, env, { newTab: on(t.attrs.url_new_window) })[0];
			const sum = (t.attrs.sum ?? "").trim();
			return [{ kind: "price" as const, plan: { name: stripTags(attr(t, "title", p, env)), ...(sum ? { price: `${t.attrs.currency ?? ""}${sum}` } : {}), ...(t.attrs.per?.trim() ? { period: t.attrs.per.trim() } : {}), ...(t.attrs.subtitle?.trim() ? { description: stripTags(t.attrs.subtitle) } : {}), features: list.map((f) => (f.included ? f.text : `${f.text} (not included)`)), ...(btn?.kind === "button" ? { button: btn.button } : {}), highlight: on(t.attrs.featured) } }];
		}),
	et_pb_accordion: (n, path, env) => kids(n, "et_pb_accordion_item").map((it, i) => ({ kind: "faq" as const, question: stripTags(attr(it, "title", `${path}/et_pb_accordion_item[${i}]`, env)), answer: blocksOf(richFromHtml(contentOf(it, `${path}/et_pb_accordion_item[${i}]`, env), env.ctx(`${path}/et_pb_accordion_item[${i}]`))) })),
	et_pb_toggle: (n, path, env) => [{ kind: "faq", question: stripTags(attr(n, "title", path, env)), answer: blocksOf(richFromHtml(contentOf(n, path, env), env.ctx(path))) }],
	et_pb_tabs: (n, path, env) => kids(n, "et_pb_tab").map((t, i) => ({ kind: "tab" as const, label: stripTags(attr(t, "title", `${path}/et_pb_tab[${i}]`, env)), body: blocksOf(env.children(t, `${path}/et_pb_tab[${i}]`)) })),

	// Stats
	et_pb_number_counter: (n, path, env) => {
		const value = (n.attrs.number ?? "").trim();
		if (!value) return [];
		return [{ kind: "stat", item: { value, label: stripTags(attr(n, "title", path, env)), ...((n.attrs.percent_sign ?? "on") === "on" ? { suffix: "%" } : {}) } }];
	},
	et_pb_circle_counter: (n, path, env) => {
		const value = (n.attrs.number ?? "").trim();
		if (!value) return [];
		env.diag({ level: "info", code: "lossy", message: `[${n.tag}] circle shown as a figure`, path, tag: n.tag });
		return [{ kind: "stat", item: { value, label: stripTags(attr(n, "title", path, env)), ...((n.attrs.percent_sign ?? "on") === "on" ? { suffix: "%" } : {}) } }];
	},
	et_pb_counters: (n, path, env) => {
		const bars = kids(n, "et_pb_counter");
		if (bars.length) env.diag({ level: "info", code: "lossy", message: `[${n.tag}] ${bars.length} bar counter(s) shown as figures`, path, tag: n.tag });
		return bars.flatMap((b) => ((b.attrs.percent ?? "").trim() ? [{ kind: "stat" as const, item: { value: (b.attrs.percent as string).trim().replace(/%$/, ""), label: stripTags(innerSource(b)), suffix: "%" } }] : []));
	},

	// Forms
	et_pb_contact_form: (n, path, env) => {
		const id = `${env.opts.postId ?? "x"}-${env.nextForm()}`;
		const def = diviFormToDefinition(id, n, `Contact form ${id}`);
		env.forms.set(def.id, def);
		if (def.warnings.length) env.diag({ level: "warn", code: "lossy", message: `[${n.tag}] ${def.warnings.join("; ")}`, path, tag: n.tag });
		const title = attr(n, "title", path, env);
		return [...(title.trim() ? richFromHtml(`<h2>${title}</h2>`, env.ctx(path)) : []), { kind: "form", provider: "divi", id }];
	},

	// Code, maps, social
	et_pb_code: (n, path, env) => embedOrLegacy(decodeCode(innerSource(n)), env.ctx(path), "Divi code module"),
	et_pb_map: map,
	et_pb_social_media_follow: (n, path, env) =>
		socialParagraph(
			kids(n, "et_pb_social_media_follow_network").flatMap((s) => {
				const href = s.attrs.url?.trim();
				const net = s.attrs.social_network ?? "";
				// Divi saves the network slug as the item's content; a custom label differs from it.
				const own = stripTags(innerSource(s));
				const label = (own && own.toLowerCase() !== net.toLowerCase() ? own : undefined) ?? NETWORK[net] ?? (net || own);
				return href && href !== "#" && label ? [{ label, href }] : [];
			}),
			env,
		),

	// Menus and logo (Theme Builder parts)
	et_pb_menu: (n, path, env) => {
		const id = n.attrs.menu_id?.trim();
		const list = id ? env.opts.menuItems?.(id) : undefined;
		const logo = mediaFrom(n.attrs.logo, "image", n.attrs.logo_alt);
		if (logo) env.diag({ level: "info", code: "dynamic", message: `[${n.tag}] logo: the starter's header draws the site logo`, path, tag: n.tag });
		if (!list?.length) {
			env.diag({ level: "info", code: "dynamic", message: `[${n.tag}] menu "${id ?? "?"}" is rendered by the site (header menu)`, path, tag: n.tag });
			return [];
		}
		if (env.opts.role === "header") {
			env.diag({ level: "info", code: "dynamic", message: `[${n.tag}] menu "${id}" becomes the site's primary menu`, path, tag: n.tag });
			return [];
		}
		env.diag({ level: "info", code: "dynamic", message: `[${n.tag}] menu "${id}": its ${list.length} links kept as text links (edit them on the page, not under Menus)`, path, tag: n.tag });
		return list.flatMap((i) => buttonOf(i.label, i.href, path, env, { style: "link", ...(i.newTab ? { newTab: true } : {}) }));
	},
};
// Fullwidth twins read the same fields.
HANDLERS.et_pb_fullwidth_slider = HANDLERS.et_pb_slider as Handler;
HANDLERS.et_pb_fullwidth_image = HANDLERS.et_pb_image as Handler;
HANDLERS.et_pb_fullwidth_code = HANDLERS.et_pb_code as Handler;
HANDLERS.et_pb_fullwidth_map = HANDLERS.et_pb_map as Handler;
HANDLERS.et_pb_fullwidth_menu = HANDLERS.et_pb_menu as Handler;
HANDLERS.et_pb_fullwidth_post_title = HANDLERS.et_pb_post_title as Handler;

/** Query-driven modules: lists of posts or projects (a posts-listing section is not in the library). */
export const LISTINGS = new Set(["et_pb_blog", "et_pb_portfolio", "et_pb_filterable_portfolio", "et_pb_fullwidth_portfolio", "et_pb_post_slider", "et_pb_fullwidth_post_slider"]);
/** Site chrome or per-request data: rendered by the site, not migrated as page content. */
export const DYNAMIC = new Set(["et_pb_search", "et_pb_login", "et_pb_sidebar", "et_pb_comments", "et_pb_post_nav", "et_pb_countdown_timer", "et_pb_post_content", "et_pb_fullwidth_post_content", "et_pb_shop"]);
/** Decorative only (Divi has no spacer module: a divider with show_divider="off" is the spacer). */
export const DECORATIVE = new Set(["et_pb_divider"]);

/** Modules with these tags hold nested items handled by their parent's handler. */
export const ITEMS = new Set(["et_pb_slide", "et_pb_accordion_item", "et_pb_tab", "et_pb_pricing_table", "et_pb_contact_field", "et_pb_map_pin", "et_pb_social_media_follow_network", "et_pb_counter", "et_pb_video_slider_item"]);
