/**
 * Element handlers: one per WPBakery / Salient shortcode → typed fragments.
 * Row recognisers (rows.ts) then turn a row's fragments into a section.
 * Adding a handler: add it to HANDLERS, add a fixture in test/fixtures/wpbakery and its golden IR.
 */
import type { Button, Diagnostic, MediaRef, PtBlock, RichText } from "../../ir/schema.js";
import { htmlToPortableText, type Keys, textBlock } from "../../ir/portable-text.js";
import { colourValue, decodeRawHtml, decodeVcLink } from "./decode.js";
import { innerSource, type ShortcodeNode } from "./parser.js";

/** A box height per screen: desktop, and below the stacking breakpoint. */
export interface BoxHeight {
	desktop: string;
	small?: string;
	/** Phones only, when the source sets a phone height different from tablets. */
	phone?: string;
}

export type Fragment =
	| { kind: "rich"; blocks: RichText; /** One line of text (Salient split-line in paragraph style): consecutive lines join into one paragraph. */ line?: boolean; /** Lists drawn with small dots and a wider indent (Salient fancy-ul standard_dot). */ list?: "dots" }
	| { kind: "button"; button: Button; /** Inline-block in the source (nectar_btn): its top margin adds to the column's element spacing instead of collapsing into it. */ inline?: boolean }
	| { kind: "media"; media: MediaRef; role: "content" | "background"; link?: string; /** Height of a background-image box sized by builder spacers. */ height?: BoxHeight; /** Drawn as a circle of this diameter (Salient circle images). */ circle?: string; /** Background picture moves with scroll: layer offset = this × scroll (Salient parallax_bg speed). */ parallax?: number; /** Rounded corners of the picture box (Salient column_border_radius). */ radius?: string }
	| { kind: "icon"; icon: { library: string; name: string } }
	| { kind: "faq"; question: string; answer: RichText; look?: FaqLook }
	| { kind: "tab"; label: string; body: RichText }
	| { kind: "team"; member: { name: string; role?: string; photo?: MediaRef; summary?: string; bio: RichText; links: Button[] }; look?: TeamLook; gap?: string }
	| { kind: "testimonial"; item: { quote: string; name?: string; role?: string; photo?: MediaRef; rating?: number } }
	| { kind: "gallery"; images: MediaRef[]; layout: "grid" | "masonry" | "carousel" | "stack" }
	| { kind: "price"; plan: { name: string; price?: string; period?: string; description?: string; features: string[]; button?: Button; highlight: boolean }; rows?: { radius?: string } }
	| { kind: "stat"; item: { value: string; label: string; prefix?: string; suffix?: string } }
	| { kind: "feature"; item: { title?: string; body: RichText; image?: MediaRef; icon?: { library: string; name: string }; link?: Button } }
	| { kind: "form"; provider: string; id: string }
	| { kind: "embed"; provider: string; html: string }
	| { kind: "video"; video?: MediaRef; embedUrl?: string; poster?: MediaRef }
	| { kind: "map"; embedUrl?: string; address?: string }
	| { kind: "marquee"; blocks: RichText; media?: MediaRef; link?: Button }
	| { kind: "legacy"; html: string; reason: string }
	| { kind: "subrow"; columns: Col[] };

/** Card look of a team style (theme CSS defaults, not shortcode attributes). */
export interface TeamLook {
	photoHeight?: string;
	nameSize?: string;
}

/**
 * Salient team_member styles → their theme CSS defaults, measured on a live Salient site (2026-11):
 * bio_fullscreen_alt = photo 500px tall at every width, name 38px.
 */
const SALIENT_TEAM: Record<string, TeamLook> = {
	bio_fullscreen_alt: { photoHeight: "500px", nameSize: "38px" },
};

export interface Col {
	width?: string;
	fragments: Fragment[];
	/** Space under a heading that sits alone in the column's first inner row (its text block's custom bottom margin + the inner-row gap), px. */
	headingGap?: number;
	background?: { color?: string };
	/** Source asks for centred text on phones. */
	phoneCenter?: boolean;
	/** Source asks for centred text on tablets. */
	tabletCenter?: boolean;
	/** Content right-aligned (every inner row text_align="right"). */
	right?: boolean;
	/** Spacer (divider / empty space) before and after the column's content, if both ends have one. */
	spacer?: { desktop: string; phone?: string; inset?: number };
	/** Tint over the column background (Salient column overlay). */
	overlay?: string;
	/** Column background image moves with scroll (Salient parallax_bg). */
	parallax?: boolean;
	/** Text centred in the column (WPBakery centered_text, on the column or every inner column). */
	centered?: boolean;
	/** Salient column parallax: translateY per pixel the column centre is from the viewport centre (intensity ÷ 10). */
	motion?: number;
	/** Desktop-only space above the content (first inner row's top_padding when tablet/phone reset it to 0). */
	leadTop?: string;
	/** Space below the column once columns stack on phones (Salient bottom_margin_phone, px). */
	gapPhone?: number;
	/** Text column narrowed by its single inner row's padding: trailing edge on desktop, both sides on phones. */
	textInset?: { end?: string; phone?: string; below?: string };
	/** Padding on the column's leading edge (Salient padding-N-percent), as a CSS length. */
	insetStart?: string;
}

export interface HandlerCtx {
	keys: Keys;
	path: string;
	diag(d: Diagnostic): void;
	/** CSS selectors / hrefs that open a popup → popup slug (from Popup Maker settings). */
	popupFor(opts: { href?: string; classes?: string }): string | undefined;
	/** Number of published posts (decides whether a post grid is content or an empty listing). */
	postCount: number;
	/** Process a node's children (text + nested shortcodes) into fragments. */
	children(node: ShortcodeNode, path: string): Fragment[];
}

type Handler = (n: ShortcodeNode, ctx: HandlerCtx) => Fragment[];

// ── helpers ───────────────────────────────────────────────────────────────────
const num = (v: string | undefined) => (v && /^\d+$/.test(v.trim()) ? Number(v.trim()) : undefined);

export function mediaFrom(v: string | undefined, kind: MediaRef["kind"] = "image", alt?: string): MediaRef | undefined {
	if (!v) return undefined;
	const id = num(v);
	if (id) return { wpId: id, kind, ...(alt ? { alt } : {}) };
	if (/^(https?:)?\/\//.test(v) || v.startsWith("/")) return { url: v, kind, ...(alt ? { alt } : {}) };
	return undefined;
}

export const idList = (v: string | undefined) =>
	(v ?? "")
		.split(",")
		.map((s) => num(s))
		.filter((n): n is number => !!n);

/** HTML (possibly with leftover wpautop tags) → rich fragment(s) + inline images; leftovers become diagnostics. */
export function richFromHtml(html: string, ctx: HandlerCtx, style?: PtBlock["style"]): Fragment[] {
	const cleaned = html.replace(/^\s*<\/p>/, "").replace(/<p>\s*$/, "");
	const r = htmlToPortableText(cleaned, ctx.keys, style ? { defaultStyle: style } : {});
	const out: Fragment[] = [];
	if (r.blocks.length) out.push({ kind: "rich", blocks: r.blocks });
	for (const img of r.images) {
		const media: MediaRef = img.wpId ? { wpId: img.wpId, url: img.src, kind: "image", ...(img.alt ? { alt: img.alt } : {}) } : { url: img.src, kind: "image", ...(img.alt ? { alt: img.alt } : {}) };
		out.push({ kind: "media", media, role: "content" });
	}
	for (const l of r.leftovers) {
		if (l.tag === "style" || l.tag === "noscript") continue;
		out.push(...embedOrLegacy(l.html, ctx, `inline <${l.tag}> in rich text`));
	}
	return out;
}

/** Known widget providers kept as an `embed` section; anything else is legacy HTML (gate-blocking). */
const EMBED_PROVIDERS: [RegExp, string][] = [
	[/momence\.com/i, "momence"],
	[/janeapp\.com/i, "janeapp"],
	[/calendly\.com/i, "calendly"],
	[/acuityscheduling\.com|as\.me\//i, "acuity"],
	[/simplepractice\.com/i, "simplepractice"],
	[/mindbodyonline\.com|healcode/i, "mindbody"],
	[/google\.com\/maps|maps\.google\./i, "google-maps"],
	[/youtube(-nocookie)?\.com|youtu\.be/i, "youtube"],
	[/player\.vimeo\.com|vimeo\.com/i, "vimeo"],
	[/instagram\.com/i, "instagram"],
	[/elfsight|trustindex|widget\.trustpilot/i, "reviews-widget"],
	[/typeform\.com/i, "typeform"],
	[/jotform\.com/i, "jotform"],
	[/hubspot|hsforms/i, "hubspot"],
	[/mailchimp|list-manage\.com/i, "mailchimp"],
	[/spotify\.com/i, "spotify"],
	[/soundcloud\.com/i, "soundcloud"],
];

export function embedOrLegacy(html: string, ctx: HandlerCtx, reason: string): Fragment[] {
	const trimmed = html.trim();
	if (!trimmed) return [];
	const provider = EMBED_PROVIDERS.find(([re]) => re.test(trimmed))?.[1];
	if (provider) {
		if (provider === "google-maps") {
			const src = /src=["']([^"']+)/i.exec(trimmed)?.[1];
			return [{ kind: "map", ...(src ? { embedUrl: src } : {}) }];
		}
		if (provider === "youtube" || provider === "vimeo") {
			const src = /src=["']([^"']+)/i.exec(trimmed)?.[1];
			if (src && /<iframe/i.test(trimmed)) return [{ kind: "video", embedUrl: src }];
		}
		return [{ kind: "embed", provider, html: trimmed }];
	}
	ctx.diag({ level: "error", code: "flagged", message: `Raw HTML kept as legacy_html (${reason}); replace with a section or approve in decisions.md`, path: ctx.path, carriesContent: true });
	return [{ kind: "legacy", html: trimmed, reason }];
}

const inlineButtons = (frags: Fragment[]): Fragment[] => frags.map((f) => (f.kind === "button" ? { ...f, inline: true } : f));

function buttonFrom(label: string | undefined, href: string | undefined, ctx: HandlerCtx, o: { style?: Button["style"]; newTab?: boolean; classes?: string; size?: "large"; textSize?: number; spaceAbove?: string } = {}): Fragment[] {
	const text = (label ?? "").trim();
	const popup = ctx.popupFor({ ...(href ? { href } : {}), ...(o.classes ? { classes: o.classes } : {}) });
	if (!text) return [];
	if (!href && !popup) {
		ctx.diag({ level: "warn", code: "link-unknown", message: `Button "${text}" has no link`, path: ctx.path });
	}
	return [{ kind: "button", button: { label: text, href: href || (popup ? `#${popup}` : "#"), style: o.style ?? "primary", ...(o.size ? { size: o.size } : {}), ...(o.textSize ? { textSize: o.textSize } : {}), ...(spaceAbove(o.spaceAbove) ? { spaceAbove: spaceAbove(o.spaceAbove) } : {}), ...(o.newTab ? { newTab: true } : {}), ...(popup ? { opensPopup: popup } : {}) } }];
}

/** Salient button margin_top (px): the space above the button. */
const spaceAbove = (v: string | undefined): number | undefined => {
	const n = Number.parseFloat(v ?? "");
	return n > 0 && n <= 200 ? Math.round(n) : undefined;
};

const headingStyle = (tag: string | undefined): PtBlock["style"] => {
	const t = (tag ?? "").toLowerCase();
	if (/^h[1-6]$/.test(t)) return t as PtBlock["style"];
	return "normal";
};

/** Line height a Salient split-line paragraph sets for itself (font_line_height), by block (survives joining lines). */
export const LINE_LEADING = new WeakMap<object, number>();

/** Decorative-only elements dropped by a named rule (reported as info). */
export const DECORATIVE = new Set(["divider", "vc_empty_space", "vc_separator", "nectar_animated_shape", "nectar_gradient_blur", "nectar_particles", "vc_zigzag", "nectar_sticky_media_sections_spacer", "nectar_cascading_images_placeholder"]);

// ── handlers ─────────────────────────────────────────────────────────────────
export const HANDLERS: Record<string, Handler> = {
	vc_column_text: (n, ctx) => ctx.children(n, ctx.path),
	nectar_responsive_text: (n, ctx) => ctx.children(n, ctx.path),
	nectar_highlighted_text: (n, ctx) => {
		ctx.diag({ level: "info", code: "lossy", message: "Highlight/scribble animation not reproduced; text kept", path: ctx.path });
		return ctx.children(n, ctx.path);
	},
	// Salient fancy list: standard dots → small dots, 30px indent, 30px under the list (measured); icon lists keep plain bullets.
	"fancy-ul": (n, ctx) => (/^(?:standard_dot)?$/.test(n.attrs.icon_type ?? "") ? ctx.children(n, ctx.path).map((f) => (f.kind === "rich" ? { ...f, list: "dots" as const } : f)) : ctx.children(n, ctx.path)),
	vc_message: (n, ctx) => ctx.children(n, ctx.path),

	split_line_heading: (n, ctx) => {
		const fs = (n.attrs.font_style ?? "h3").toLowerCase();
		const text = n.attrs.text_content;
		if (text !== undefined && text.trim()) {
			// Salient's "i" style is the theme's italic display line: a pull quote.
			const style = /^h[1-6]$/.test(fs) ? (fs as PtBlock["style"]) : fs === "i" ? "blockquote" : "normal";
			const marks = fs === "i" ? ["em"] : [];
			const block = textBlock(text, ctx.keys, style, marks);
			// Salient lets the whole line be a link (link_href + link_target): keep it as a link mark.
			const href = n.attrs.link_href?.trim();
			if (href) {
				const key = ctx.keys.next();
				block.markDefs.push({ _type: "link", _key: key, href, ...(n.attrs.link_target === "_blank" ? { blank: true } : {}) });
				for (const c of block.children) c.marks.push(key);
			}
			const leading = Number.parseFloat(n.attrs.font_line_height ?? "");
			if (style === "normal" && leading >= 1 && leading <= 3) LINE_LEADING.set(block, leading);
			return [{ kind: "rich", blocks: [block], ...(style === "normal" && fs !== "i" ? { line: true } : {}) }];
		}
		// Enclosed form: inner HTML is the heading.
		return richFromHtml(innerSource(n), ctx, /^h[1-6]$/.test(fs) ? (fs as PtBlock["style"]) : undefined);
	},
	vc_custom_heading: (n, ctx) => {
		const tag = /tag:(h[1-6]|p|div)/.exec(n.attrs.font_container ?? "")?.[1] ?? "h2";
		const link = decodeVcLink(n.attrs.link);
		const out: Fragment[] = [{ kind: "rich", blocks: [textBlock(n.attrs.text ?? "", ctx.keys, headingStyle(tag))] }];
		if (link.url) out.push(...buttonFrom(link.title || n.attrs.text, link.url, ctx, { style: "link", newTab: link.target === "_blank" }));
		return out;
	},
	heading: (n, ctx) => richFromHtml(innerSource(n), ctx, "h2"),

	// Buttons & links
	nectar_btn: (n, ctx) => inlineButtons(buttonFrom(n.attrs.text, n.attrs.url, ctx, { ...(n.attrs.size === "large" ? { size: "large" as const, textSize: 14 } : {}), style: /see-through|transparent|underline/i.test(n.attrs.button_style ?? "") ? "secondary" : "primary", newTab: n.attrs.open_new_tab === "true", ...(n.attrs.margin_top ? { spaceAbove: n.attrs.margin_top } : {}), ...(n.attrs.class || n.attrs.el_class ? { classes: `${n.attrs.class ?? ""} ${n.attrs.el_class ?? ""}` } : {}) })),
	nectar_cta: (n, ctx) => {
		const out: Fragment[] = [];
		if (n.attrs.text?.trim()) out.push({ kind: "rich", blocks: [textBlock(n.attrs.text, ctx.keys, headingStyle(n.attrs.heading_tag))] });
		// Salient: "underline" / "arrow…" styles are text links; "text-reveal-wave" with a button colour is a pill.
		const ctaStyle = /underline|arrow/i.test(n.attrs.btn_style ?? "") || (/text-reveal/i.test(n.attrs.btn_style ?? "") && (!n.attrs.button_color || n.attrs.button_color === "default")) ? "link" : "primary";
		// Its own padding (15px+ vertical) makes it a large button, set apart from the text above.
		const large = ctaStyle === "primary" && Number.parseFloat(n.attrs.padding_top ?? "") >= 15;
		out.push(...buttonFrom(n.attrs.link_text, n.attrs.url, ctx, { style: ctaStyle, newTab: n.attrs.link_type === "new_tab", ...(large ? { size: "large" as const } : {}), ...(n.attrs.margin_top ? { spaceAbove: n.attrs.margin_top } : {}), ...(n.attrs.class ? { classes: n.attrs.class } : {}) }));
		return out;
	},
	vc_btn: (n, ctx) => {
		const l = decodeVcLink(n.attrs.link);
		return buttonFrom(n.attrs.title ?? l.title, l.url, ctx, { style: /outline|transparent/i.test(n.attrs.style ?? "") ? "secondary" : "primary", newTab: l.target?.includes("_blank") ?? false, ...(n.attrs.el_class ? { classes: n.attrs.el_class } : {}) });
	},
	button: (n, ctx) => buttonFrom(n.attrs.text, n.attrs.url, ctx, { newTab: n.attrs.open_new_tab === "true" }),

	// Images & media
	image_with_animation: (n, ctx) => {
		const media = mediaFrom(n.attrs.image_url, "image", n.attrs.alt);
		if (!media) return [];
		if ((n.attrs.animation ?? "None") !== "None") ctx.diag({ level: "info", code: "lossy", message: `Entrance animation "${n.attrs.animation}" replaced by the starter's default reveal`, path: ctx.path });
		return [{ kind: "media", media, role: "content", ...(n.attrs.img_link ? { link: n.attrs.img_link } : {}) }];
	},
	vc_single_image: (n, ctx) => {
		const media = mediaFrom(n.attrs.source === "external_link" ? n.attrs.custom_src : n.attrs.image, "image", n.attrs.alt);
		if (!media) {
			ctx.diag({ level: "warn", code: "media-missing", message: "vc_single_image without an image", path: ctx.path });
			return [];
		}
		const link = n.attrs.onclick === "custom_link" ? (decodeVcLink(n.attrs.link).url ?? n.attrs.link) : undefined;
		return [{ kind: "media", media, role: "content", ...(link ? { link } : {}) }];
	},
	nectar_circle_images: (n, ctx) => {
		const ids = idList(n.attrs.images);
		if (ids.length > 1) ctx.diag({ level: "info", code: "lossy", message: "Overlapping circle images rendered side by side", path: ctx.path });
		const size = /^\s*(\d+(?:\.\d+)?)\s*(px|rem|vw)?\s*$/.exec(n.attrs.sizing ?? "");
		const circle = size ? `${size[1]}${size[2] ?? "px"}` : "160px";
		return ids.map((id) => ({ kind: "media" as const, media: { wpId: id, kind: "image" as const }, role: "content" as const, circle }));
	},
	vc_gallery: (n) => [{ kind: "gallery", images: idList(n.attrs.images).map((id) => ({ wpId: id, kind: "image" as const })), layout: /flickity|slider|carousel/i.test(n.attrs.type ?? "") ? "carousel" : /masonry/i.test(n.attrs.type ?? "") ? "masonry" : "grid" }],
	nectar_image_gallery: (n) => [{ kind: "gallery", images: idList(n.attrs.images).map((id) => ({ wpId: id, kind: "image" as const })), layout: "grid" }],
	vc_video: (n) => [{ kind: "video", embedUrl: n.attrs.link ?? "" }],
	nectar_video_lightbox: (n) => {
		const poster = mediaFrom(n.attrs.image_url ?? n.attrs.image);
		return [{ kind: "video", embedUrl: n.attrs.video_url ?? "", ...(poster ? { poster } : {}) }];
	},
	nectar_video_player_self_hosted: (n) => {
		const video = mediaFrom(n.attrs.video_mp4 ?? n.attrs.video_webm, "video");
		const poster = mediaFrom(n.attrs.video_image);
		return [{ kind: "video", ...(video ? { video } : {}), ...(poster ? { poster } : {}) }];
	},

	// Icons
	nectar_icon: (n) => {
		const family = n.attrs.icon_family ?? "fontawesome";
		const name = n.attrs[`icon_${family}`] ?? n.attrs.icon_fontawesome ?? "";
		return name ? [{ kind: "icon", icon: { library: family, name } }] : [];
	},

	// Forms
	fluentform: (n) => [{ kind: "form", provider: "fluent-forms", id: n.attrs.id ?? n.args[0] ?? "" }],
	"contact-form-7": (n) => [{ kind: "form", provider: "cf7", id: n.attrs.id ?? "" }],
	wpforms: (n) => [{ kind: "form", provider: "wpforms", id: n.attrs.id ?? "" }],
	gravityform: (n) => [{ kind: "form", provider: "gravity-forms", id: n.attrs.id ?? "" }],
	ninja_form: (n) => [{ kind: "form", provider: "ninja-forms", id: n.attrs.id ?? "" }],
	formidable: (n) => [{ kind: "form", provider: "formidable", id: n.attrs.id ?? "" }],

	// Raw HTML / JS
	vc_raw_html: (n, ctx) => embedOrLegacy(decodeRawHtml(innerSource(n)), ctx, "vc_raw_html"),
	vc_raw_js: (n, ctx) => {
		const js = decodeRawHtml(innerSource(n));
		ctx.diag({ level: "error", code: "flagged", message: "vc_raw_js is never copied automatically; review and rebuild", path: ctx.path, carriesContent: true });
		return [{ kind: "legacy", html: js, reason: "vc_raw_js" }];
	},
	vc_gmaps: (n, ctx) => {
		const html = decodeRawHtml(n.attrs.link ?? "");
		return embedOrLegacy(html.startsWith("<") ? html : `<iframe src="${html}"></iframe>`, ctx, "vc_gmaps");
	},

	// FAQ / tabs
	toggle: (n, ctx) => [{ kind: "faq", question: (n.attrs.title ?? "").trim(), answer: richOf(ctx.children(n, ctx.path), ctx) }],
	vc_tta_section: (n, ctx) => [{ kind: "tab", label: (n.attrs.title ?? "").trim(), body: richOf(ctx.children(n, ctx.path), ctx) }],
	tab: (n, ctx) => [{ kind: "tab", label: (n.attrs.title ?? "").trim(), body: richOf(ctx.children(n, ctx.path), ctx) }],

	// Team & testimonials
	team_member: (n, ctx) => {
		const links: Button[] = [];
		for (let i = 1; i <= 5; i++) {
			const url = n.attrs[`link_url_${i}`] ?? n.attrs[`social_link_${i}`];
			const icon = n.attrs[`social_icon_${i}`] ?? n.attrs[`link_text_${i}`];
			if (url) links.push({ label: icon || "link", href: url, style: "link", newTab: true });
		}
		const photo = mediaFrom(n.attrs.image_url);
		const bio = richOf(ctx.children(n, ctx.path), ctx);
		const look = SALIENT_TEAM[n.attrs.team_memeber_style ?? n.attrs.team_member_style ?? ""];
		return [{ kind: "team", member: { name: (n.attrs.name ?? "").trim(), ...(n.attrs.job_position ? { role: n.attrs.job_position } : {}), ...(photo ? { photo } : {}), ...(n.attrs.team_member_mini_bio ? { summary: n.attrs.team_member_mini_bio } : {}), bio, links }, ...(look ? { look } : {}) }];
	},
	testimonial: (n, ctx) => {
		const photo = mediaFrom(n.attrs.image);
		const quote = (n.attrs.quote ?? ctx.children(n, ctx.path).flatMap((f) => (f.kind === "rich" ? f.blocks : [])).map((b) => b.children.map((c) => c.text).join("")).join("\n")).trim();
		const rating = n.attrs.star_rating && n.attrs.star_rating !== "none" ? Number.parseFloat(n.attrs.star_rating) : undefined;
		return [{ kind: "testimonial", item: { quote, ...(n.attrs.name ? { name: n.attrs.name } : {}), ...(n.attrs.subtitle ? { role: n.attrs.subtitle } : {}), ...(photo ? { photo } : {}), ...(rating && Number.isFinite(rating) ? { rating } : {}) } }];
	},

	// Pricing
	nectar_horizontal_list_item: (n, ctx) => {
		const cols = [1, 2, 3, 4].map((i) => (n.attrs[`col_${i}_content`] ?? "").trim()).filter(Boolean);
		const priceIdx = cols.findIndex((c, i) => i > 0 && /^[$€£¥₹]|^\d+([.,]\d+)?\s*(usd|eur|gbp)?$|free/i.test(c));
		const name = cols[0] ?? "";
		const price = priceIdx >= 0 ? cols[priceIdx] : undefined;
		const rest = cols.filter((_, i) => i !== 0 && i !== priceIdx);
		const btn = buttonFrom(n.attrs.cta_1_text, n.attrs.cta_1_url, ctx, { newTab: n.attrs.cta_1_open_new_tab === "true" });
		const button = btn[0]?.kind === "button" ? btn[0].button : undefined;
		// A horizontal list item is a bordered row (name · details · price) that stacks on small screens.
		const radius = /^\d+(?:\.\d+)?px$/.test(n.attrs.border_radius ?? "") && n.attrs.border_radius !== "0px" ? n.attrs.border_radius : undefined;
		return [{ kind: "price", plan: { name, ...(price ? { price } : {}), ...(rest.length ? { description: rest.join(" · ") } : {}), features: [], ...(button ? { button } : {}), highlight: false }, rows: radius ? { radius } : {} }];
	},
	pricing_column: (n, ctx) => {
		const features = ctx
			.children(n, ctx.path)
			.flatMap((f) => (f.kind === "rich" ? f.blocks : []))
			.map((b) => b.children.map((c) => c.text).join("").trim())
			.filter(Boolean);
		const link = buttonFrom(n.attrs.link_text ?? n.attrs.button_text, n.attrs.url ?? n.attrs.link_url, ctx);
		const button = link[0]?.kind === "button" ? link[0].button : undefined;
		return [{ kind: "price", plan: { name: n.attrs.title ?? "", ...(n.attrs.price ? { price: `${n.attrs.currency_symbol ?? ""}${n.attrs.price}` } : {}), ...(n.attrs.interval ? { period: n.attrs.interval } : {}), features, ...(button ? { button } : {}), highlight: n.attrs.highlight === "true" } }];
	},

	// Stats
	milestone: (n) => [{ kind: "stat", item: { value: n.attrs.number ?? "", label: n.attrs.subject ?? "", ...(n.attrs.symbol ? (n.attrs.symbol_position === "before" ? { prefix: n.attrs.symbol } : { suffix: n.attrs.symbol }) : {}) } }],

	// Feature-like
	fancy_box: (n, ctx) => {
		const image = mediaFrom(n.attrs.image_url);
		const btn = buttonFrom(n.attrs.link_text ?? "Learn more", n.attrs.link_url, ctx);
		const rich = richOf(ctx.children(n, ctx.path), ctx);
		const title = n.attrs.title;
		return [{ kind: "feature", item: { ...(title ? { title } : {}), body: rich, ...(image ? { image } : {}), ...(n.attrs.link_url && btn[0]?.kind === "button" ? { link: btn[0].button } : {}) } }];
	},
	nectar_icon_list_item: (n, ctx) => {
		const family = n.attrs.icon_type === "numerical" ? undefined : (n.attrs.icon_family ?? "fontawesome");
		const name = family ? n.attrs[`icon_${family}`] : undefined;
		return [{ kind: "feature", item: { ...(n.attrs.header ? { title: n.attrs.header } : {}), body: n.attrs.text ? richOf(richFromHtml(n.attrs.text, ctx), ctx) : [], ...(family && name ? { icon: { library: family, name } } : {}) } }];
	},
	"text-with-icon": (n, ctx) => {
		const family = n.attrs.icon_type === "font_icon" ? "fontawesome" : n.attrs.icon_type;
		const name = n.attrs.icon ?? "";
		return [...(name ? [{ kind: "icon" as const, icon: { library: family ?? "fontawesome", name } }] : []), ...ctx.children(n, ctx.path)];
	},

	// Marquee
	nectar_scrolling_text: (n, ctx) => {
		const frags = ctx.children(n, ctx.path);
		const blocks = richOf(frags, ctx);
		const link = blocks.flatMap((b) => b.markDefs).find((d) => d.href)?.href;
		const media = mediaFrom(n.attrs.background_image_url);
		const label = blocks.map((b) => b.children.map((c) => c.text).join("")).join(" ").trim();
		const btn = link ? buttonFrom(label, link, ctx)[0] : undefined;
		return [{ kind: "marquee", blocks, ...(media ? { media } : {}), ...(btn?.kind === "button" ? { link: btn.button } : {}) }];
	},

	// Dynamic listings
	nectar_post_grid: (n, ctx) => dynamicListing(n, ctx),
	nectar_blog: (n, ctx) => dynamicListing(n, ctx),
	recent_posts: (n, ctx) => dynamicListing(n, ctx),
	vc_basic_grid: (n, ctx) => dynamicListing(n, ctx),
};

function dynamicListing(n: ShortcodeNode, ctx: HandlerCtx): Fragment[] {
	const type = n.attrs.post_type ?? "post";
	if (type === "post" && ctx.postCount === 0) {
		ctx.diag({ level: "info", code: "dynamic", message: `${n.tag}: lists ${type} entries, but the site has none — dropped`, path: ctx.path, tag: n.tag });
		return [];
	}
	ctx.diag({ level: "error", code: "unmapped", message: `${n.tag}: dynamic ${type} listing needs a posts-listing section (not in the v1 library)`, path: ctx.path, carriesContent: true, tag: n.tag });
	return [];
}

export interface FaqLook {
	style?: "card";
	radius?: string;
	openFirst?: boolean;
	inset?: string;
}

/** Salient toggles: minimal_shadow = padded items, circled +/− icons, the open one a raised card; an accordion opens its first item. */
function togglesLook(a: Record<string, string>): FaqLook | undefined {
	const card = /shadow/.test(a.style ?? "");
	const radius = /^\d+(?:\.\d+)?px$/.test(a.border_radius ?? "") && a.border_radius !== "0px" ? a.border_radius : undefined;
	const openFirst = a.accordion === "true" && !/closed/.test(a.accordion_starting_functionality ?? "");
	const look: FaqLook = { ...(card ? { style: "card" as const } : {}), ...(card && radius ? { radius } : {}), ...(openFirst ? { openFirst: true } : {}) };
	return Object.keys(look).length ? look : undefined;
}

/** Containers whose children are processed as a group by the row builder. */
export const CONTAINERS = new Set(["vc_row", "vc_row_inner", "vc_column", "vc_column_inner", "vc_section"]);
/** Grouping elements: children handled individually, the wrapper adds nothing visible. */
export const GROUPS: Record<string, (n: ShortcodeNode, ctx: HandlerCtx) => Fragment[]> = {
	toggles: (n, ctx) => {
		const look = togglesLook(n.attrs);
		return ctx.children(n, ctx.path).map((f) => (f.kind === "faq" && look ? { ...f, look } : f));
	},
	vc_tta_accordion: (n, ctx) => ctx.children(n, ctx.path).map((f) => (f.kind === "tab" ? { kind: "faq" as const, question: f.label, answer: f.body } : f)),
	vc_tta_tabs: (n, ctx) => ctx.children(n, ctx.path),
	vc_tta_tour: (n, ctx) => ctx.children(n, ctx.path),
	tabbed_section: (n, ctx) => ctx.children(n, ctx.path),
	testimonial_slider: (n, ctx) => ctx.children(n, ctx.path),
	pricing_table: (n, ctx) => ctx.children(n, ctx.path),
	nectar_icon_list: (n, ctx) => ctx.children(n, ctx.path),
	nectar_horizontal_list: (n, ctx) => ctx.children(n, ctx.path),
	vc_column_text_wrap: (n, ctx) => ctx.children(n, ctx.path),
};

/** Merge rich fragments (and inline anything textual) into one RichText. */
export function richOf(frags: Fragment[], ctx: HandlerCtx): RichText {
	const out: RichText = [];
	for (const f of frags) {
		if (f.kind === "rich") out.push(...f.blocks);
		else if (f.kind === "button") out.push(linkBlock(f.button, ctx));
	}
	return out;
}

/** A button inside running text becomes a paragraph with a link (nothing is lost). */
export function linkBlock(b: Button, ctx: HandlerCtx): PtBlock {
	const key = ctx.keys.next();
	return { _type: "block", _key: ctx.keys.next(), style: "normal", children: [{ _type: "span", _key: ctx.keys.next(), text: b.label, marks: [key] }], markDefs: [{ _type: "link", _key: key, href: b.href, ...(b.newTab ? { blank: true } : {}) }] };
}

export { colourValue };
