/**
 * DOM-fallback adapter: a page built with a builder the kit has no adapter for (Avada, Oxygen, Beaver Builder, Brizy,
 * Thrive, SiteOrigin, Breakdance, Visual Composer, Flatsome, a theme's own markup…) is rebuilt from the live page's
 * rendered HTML (the audit snapshot, snapshot/html/<page>.html) instead of stopping at transform.
 *
 * - The main content area is found (builder content roots, then main/#content/.entry-content), after the theme chrome
 *   is removed: header, navigation, footer, sidebar, cookie banners, popups, page title bar, breadcrumbs, comments.
 * - Its top-level structural boxes are the rows (a run of loose headings/paragraphs is split at its top headings);
 *   sibling layout containers (column classes, inline widths, a flex/grid row) are the columns; deeper column groups are
 *   sub-rows.
 * - Elements become the shared fragments: text → rich text (Portable Text), images (lazy-load attributes read, upload
 *   URLs resolved to the media library), button-styled links, iframes through the embed registry (video, map, widget),
 *   forms (a known plugin's form id, else a definition rebuilt from the HTML like formFromSnapshot), and — only when the
 *   markup says so — accordions (aria-controls pairs, details/summary, title/content pairs), tabs (role=tab), testimonial
 *   boxes, galleries and image sliders. Then the shared recognisers turn each row into a section.
 * - Obvious backgrounds (inline background colour/gradient/image, lazy background attributes) and light text are kept.
 * - Nothing is silently dropped: decorative boxes and removed chrome are counted in an info note, elements hidden on
 *   desktop are listed, raw HTML that is not a known embed becomes a sanitised legacy_html section (gate-blocking), and
 *   every page carries a "rebuilt from rendered HTML; check visually" warning (transform gate `dom-fallback-reviewed`).
 * Facts and limits: docs/spikes/dom-fallback-findings.md.
 */
import * as cheerio from "cheerio";
import type { AnyNode, Element } from "domhandler";
import { extractForms, restoreCfEmails } from "../../audit/page.js";
import { formFromSnapshot } from "../../extract/plugin-exports.js";
import type { Keys } from "../../ir/portable-text.js";
import type { Button, Diagnostic, MediaRef, RichText, Section, SectionType } from "../../ir/schema.js";
import { embedProviderOf } from "../../providers/registry.js";
import type { FormDefinitionOut } from "../../scaffold/forms.js";
import { CHROME } from "../../transform/coverage.js";
import { isDarkColour } from "../wpbakery/decode.js";
import { type Col, embedOrLegacy, type Fragment, type HandlerCtx, richFromHtml } from "../wpbakery/elements.js";
import { mergeCollections, mergeRich, recognise, type Row, splitRow } from "../wpbakery/index.js";
import type { FallbackReason } from "./detect.js";

export { bodyClassesOf, type FallbackReason, fallbackReason, unknownShortcodeLayout } from "./detect.js";

export interface DomFallbackOptions {
	kind: "page" | "post" | "partial" | "popup";
	keys: Keys;
	popupFor: HandlerCtx["popupFor"];
	postCount: number;
	rowOverrides?: Record<string, SectionType | "drop">;
	postId?: number;
	title?: string;
	/** Why the page is rebuilt from HTML (detect.ts); named in the page's warning. */
	reason?: FallbackReason;
	/** Media library id of an upload URL (size variants and -scaled copies point at the original). */
	mediaIdForUrl?: (url: string) => number | undefined;
	/** Site-relative form of a link (this site's absolute URLs → paths). */
	relHref?: (url: string) => string;
}

export interface DomFallbackResult {
	sections: Section[];
	diagnostics: Diagnostic[];
	/** Definitions of builder/theme forms rebuilt from their HTML (written to ir/forms by transform). */
	forms: FormDefinitionOut[];
}

/** Plugin form providers whose definitions extract already brings (REST, plugin exports, or the audit's HTML). */
const PLUGIN_FORMS = new Set(["contact-form-7", "gravity-forms", "wpforms", "ninja-forms", "formidable", "forminator", "ws-form", "fluent-forms"]);

/** Theme chrome beyond the text-conservation list: footers, sidebars, consent banners, popups, title bars, comments. */
const MORE_CHROME: { sel: string; what: string }[] = [
	{ sel: "#colophon, .site-footer, #footer, #site-footer, #main-footer, #footer-outer, .footer-wrapper, .fusion-footer, .fl-page-footer, .oxy-footer, .bde-footer, .brz-section__footer, #thrive-footer, .thrv_footer, .elementor-location-footer, .et-l--footer, #brx-footer, .ct-footer, #socket, footer[role=contentinfo]", what: "footer" },
	{ sel: "#header, .site-header, #site-header, .fusion-header-wrapper, .fusion-secondary-header, .fl-page-header, .oxy-header-wrapper, .bde-header-builder, .brz-section__header, #thrive-header, .thrv_header, .ct-header, #top-bar, .top-bar, header[role=banner], .header-wrapper, #wrapper-navigation", what: "header" },
	{ sel: "#secondary, #sidebar, aside.sidebar, .sidebar, .widget-area, .fusion-sidebar, .fl-sidebar, aside[role=complementary]", what: "sidebar" },
	{ sel: "#cookie-notice, #cookie-law-info-bar, .cky-consent-container, .cky-modal, #cmplz-cookiebanner-container, .cmplz-cookiebanner, #moove_gdpr_cookie_info_bar, #catapult-cookie-bar, #CybotCookiebotDialog, #BorlabsCookieBox, .borlabs-cookie, #onetrust-consent-sdk, .cookie-banner, .cookie-notice", what: "cookie banner" },
	{ sel: "[role=dialog], [aria-modal=true], .modal, .fusion-modal, .tve-leads-conversion-object, .pum-container", what: "popup" },
	{ sel: ".entry-header, header.page-header, .page-header, .fusion-page-title-bar, .fl-post-header, #page-title, .page-title-bar, .title-bar, .avia-title-container, .title_container", what: "theme page title" },
	{ sel: ".breadcrumbs, .breadcrumb, #breadcrumbs, .rank-math-breadcrumb, .yoast-breadcrumbs, .woocommerce-breadcrumb, nav[aria-label=breadcrumb], nav[aria-label=Breadcrumb], nav[aria-label=Breadcrumbs]", what: "breadcrumbs" },
	{ sel: "#comments, .comments-area, #respond, .post-navigation, .posts-navigation, .nav-links, .sharedaddy, .jp-relatedposts", what: "comments / post navigation" },
];

/** Content roots, best first. `{id}` is the post id. */
const ROOTS = [
	".fl-builder-content-{id}",
	".fl-builder-content:not([data-type=header]):not([data-type=footer])",
	"#tve_editor",
	"#pl-{id}",
	".panel-layout",
	".brz-root__container",
	".ct-inner-content",
	".post-content",
	"main .entry-content",
	"article .entry-content",
	".entry-content",
	"#main",
	"main",
	"[role=main]",
	"#content",
	".site-content",
	"#primary",
	"body",
];

const INLINE = new Set(["a", "span", "strong", "b", "em", "i", "u", "small", "sup", "sub", "mark", "abbr", "time", "code", "s", "del", "ins", "cite", "q", "label", "br", "font", "bdi", "kbd", "var", "data"]);
const TEXT_BLOCKS = new Set(["h1", "h2", "h3", "h4", "h5", "h6", "p", "ul", "ol", "blockquote", "pre", "address", "dl", "center"]);
const CONTAINERS = new Set(["div", "section", "article", "aside", "main", "header", "footer", "nav", "span", "a", "li", "figure", "picture", "dd", "dt", "fieldset", "hgroup"]);
const MEDIA_TAGS = "img, picture, iframe, video, audio, form, table, embed, object, canvas, [data-wp2e-embed]";
const STRUCTURAL_TAGS = new Set(["div", "section", "article", "aside", "main", "header", "footer", "nav", "figure"]);

const BTN_RE = /\b(btn|button|wp-block-button__link|fusion-button|fl-button|bde-button|brz-btn|tve-btn|thrv-button|ct-link-button|ux-button|vc_btn3?|sow-button|vce-button|avia-button|x-btn|cs-btn|elementor-button|et_pb_button|qbutton|w-btn|mk-button|tcb-button-link)\b/i;
const COL_RE = /(?:^|\s)(?:col(?:umn)?s?|cell|span\d+|grid-item|one_(?:half|third|fourth|fifth|sixth)|two_(?:third|fifth)|three_fourth|fusion-layout-column|fusion-builder-column[\w-]*|fl-col|bde-column|brz-columns?|panel-grid-cell|vce-col|tcb-flex-col|ct-column|oxy-column|av_one_(?:half|third|fourth)|av_two_third|flex_column|wp-block-column|col-[\w-]+|large-\d+|medium-\d+|small-\d+|w-col|vc_col-[\w-]+|uk-width-[\w/-]+)(?=\s|$)/i;
const ROW_RE = /(?:^|\s)(?:row|columns|grid|flex|fl-col-group|panel-grid|fusion-row|fusion-builder-row|tcb-flex-row|vce-row-content|brz-row|ct-new-columns|wp-block-columns|bde-columns|w-row|vc_row|uk-grid|av-flex-cells)(?=\s|$)/i;
const SECTION_RE = /(?:^|\s)(?:section|[\w-]*-section|fusion-fullwidth|fl-row|ct-section|bde-section|brz-section|panel-grid|vce-row|thrv-page-section|avia-section|ux-banner|container|wp-block-group|wp-block-cover|hero|banner)(?=\s|$)/i;
/** Elements a builder shows only below desktop (a phone copy of a row): not migrated, reported. */
const HIDDEN_RE = /(?:^|\s)(?:fl-visible-(?:mobile|medium)|fusion-no-large-visibility|hide-for-large|hidden-desktop|hide-desktop|hide-on-desktop|desktop-hidden|elementor-hidden-desktop|brz-hidden-lg|tcb-desktop-hidden|d-lg-none|hidden-lg|visible-xs|visible-sm|show-for-small-only|show-for-medium-down|bde-hide-desktop|ct-hidden-desktop|mobile-only|av-desktop-hide|show-for-small)(?=\s|$)/;
/** Slider clones (the same slide twice for infinite loops). */
const CLONES = ".slick-cloned, .swiper-slide-duplicate, .owl-item.cloned, .flickity-slider .is-clone";

const clean = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
const words = (s: string) => clean(s).split(" ").filter(Boolean).length;

/** Colour of an inline style declaration (`background-color`, `background`, a builder's `--…-background-color`). */
function styleColour(style: string, prop: "background" | "color"): string | undefined {
	const re = prop === "background" ? /(?:^|;)\s*(?:--[\w-]*background-color|background-color|background)\s*:\s*([^;]+)/gi : /(?:^|;)\s*color\s*:\s*([^;]+)/gi;
	for (const m of style.matchAll(re)) {
		const v = /(#[0-9a-f]{3,8}\b|rgba?\([\d\s.,%]+\))/i.exec(m[1] ?? "")?.[1];
		if (v && !/^rgba\([^)]*,\s*0(?:\.0+)?\s*\)$/i.test(v) && !/^transparent$/i.test(v)) return v;
	}
	return undefined;
}

export function adaptDomFallback(html: string, opts: DomFallbackOptions): DomFallbackResult {
	const diagnostics: Diagnostic[] = [];
	const diag = (d: Diagnostic) => diagnostics.push(d);
	const forms = new Map<string, FormDefinitionOut>();
	const $ = cheerio.load(html);
	restoreCfEmails($);
	const why = opts.reason ? `${opts.reason.why}` : "no adapter for this page's builder";
	diag({ level: "warn", code: "flagged", message: `Rebuilt from the live page's rendered HTML (${why}); check it visually against the live page, then record the review in overrides.ts domFallbackReviewed`, path: "dom", tag: "dom-fallback" });
	const removed = new Map<string, number>();
	const note = (what: string, n = 1) => removed.set(what, (removed.get(what) ?? 0) + n);

	// Anchors links on the page point at (#id, menus included): kept as section anchors.
	const linked = new Set($("a[href*='#']").map((_, a) => ($(a).attr("href") ?? "").split("#")[1] ?? "").get().filter(Boolean));
	// ── Known widget scripts in the content: kept with their mount element as an embed ──
	const embeds: string[] = [];
	$("body script").each((_, el) => {
		const $s = $(el);
		const own = $.html(el);
		const provider = embedProviderOf(own);
		if (!provider) return;
		const prev = $s.prev();
		const mount = prev.length && !clean(prev.text()) && !prev.find("img, iframe").length && (prev.attr("id") || prev.attr("class") || Object.keys(prev.attr() ?? {}).some((k) => k.startsWith("data-"))) ? $.html(prev) : "";
		if (mount) prev.remove();
		embeds.push(`${mount}${own}`);
		$s.replaceWith(`<div data-wp2e-embed="${embeds.length - 1}"></div>`);
	});
	// ── Sanitise: no scripts, styles or event handlers survive into legacy_html ──
	$("script, style, noscript, template, link, meta, base").remove();
	$("*").each((_, el) => {
		for (const k of Object.keys((el as Element).attribs ?? {})) {
			if (/^on/i.test(k)) $(el).removeAttr(k);
			else if ((k === "href" || k === "src" || k === "action" || k === "formaction") && /^\s*javascript:/i.test((el as Element).attribs[k] ?? "")) $(el).removeAttr(k);
		}
	});
	// Lazy-loaded pictures and frames: the real address into src.
	$("img").each((_, el) => {
		const $i = $(el);
		const src = $i.attr("src");
		const real = $i.attr("data-lazy-src") ?? $i.attr("data-src") ?? $i.attr("data-orig-src") ?? $i.attr("data-original") ?? $i.attr("data-lazyload") ?? (!src || src.startsWith("data:") ? firstSrcset($i.attr("data-srcset") ?? $i.attr("data-lazy-srcset") ?? $i.attr("srcset")) : undefined);
		if (real && (!src || src.startsWith("data:") || real !== src)) $i.attr("src", real);
	});
	$("iframe").each((_, el) => {
		const $f = $(el);
		const src = $f.attr("src");
		const real = $f.attr("data-src") ?? $f.attr("data-lazy-src") ?? $f.attr("data-rocket-src");
		if (real && (!src || src === "about:blank" || src.startsWith("data:"))) $f.attr("src", real);
	});
	$(CLONES).remove();
	// Inline SVG is icon art (arrows, list bullets, social glyphs): counted, not carried.
	const svgs = $("svg").length;
	if (svgs) {
		$("svg").remove();
		note("inline SVG icon", svgs);
	}

	stripChrome($, note);
	const root = findRoot($, opts.postId);
	if (!root) {
		diag({ level: "error", code: "unmapped", message: "No content found in the live page's HTML (empty main area); rebuild the page by hand", path: "dom", carriesContent: true, tag: "dom-fallback" });
		return { sections: [], diagnostics, forms: [] };
	}

	const ctxFor = (path: string): HandlerCtx => ({ keys: opts.keys, path, diag, popupFor: opts.popupFor, postCount: opts.postCount, children: () => [] });
	const rel = (href: string) => (opts.relHref ? opts.relHref(href) : href);

	// ── Helpers ──
	const classOf = (el: Element) => el.attribs?.class ?? "";
	const styleOf = (el: Element) => el.attribs?.style ?? "";
	const elementKids = (el: Element) => el.children.filter((c): c is Element => c.type === "tag");
	const hasDirectText = (el: Element) => el.children.some((c) => c.type === "text" && clean((c as unknown as { data: string }).data));
	const textOf = (el: Element | cheerio.Cheerio<Element>) => clean($(el as Element).text());
	const hasContent = (el: Element) => !!textOf(el) || $(el).find(MEDIA_TAGS).length > 0 || /^(img|iframe|video|form|table)$/.test(el.tagName) || !!el.attribs?.["data-wp2e-embed"] || !!bgImage(el);
	const isHidden = (el: Element) => HIDDEN_RE.test(classOf(el)) || /(?:^|;)\s*display\s*:\s*none/i.test(styleOf(el)) || el.attribs?.hidden !== undefined;

	function bgImage(el: Element): string | undefined {
		const a = el.attribs ?? {};
		const lazy = a["data-bg"] ?? a["data-background"] ?? a["data-bg-src"] ?? a["data-background-image"] ?? a["data-bg-image"] ?? a["data-lazy-background"] ?? a["data-bg-url"];
		if (lazy) return /url\(\s*['"]?([^'")]+)/.exec(lazy)?.[1] ?? lazy;
		for (const m of styleOf(el).matchAll(/(?:^|;)\s*(?:--[\w-]*background-image|background-image|background)\s*:\s*([^;]+)/gi)) {
			const u = /url\(\s*['"]?([^'")]+)['"]?\s*\)/.exec(m[1] ?? "")?.[1];
			if (u && !u.startsWith("data:")) return u.replace(/&quot;/g, "");
		}
		return undefined;
	}
	const bgGradient = (el: Element) => /((?:linear|radial)-gradient\((?:[^()]|\([^()]*\))*\))/i.exec(styleOf(el))?.[1];

	function mediaRef(url: string, alt?: string, cls?: string, dataId?: string): MediaRef {
		const id = Number(/wp-image-(\d+)/.exec(cls ?? "")?.[1] ?? (/^\d+$/.test(dataId ?? "") ? dataId : undefined)) || opts.mediaIdForUrl?.(url);
		return id ? { wpId: id, kind: "image", ...(alt ? { alt } : {}) } : { url, kind: "image", ...(alt ? { alt } : {}) };
	}
	const imageOf = (img: Element): MediaRef | undefined => {
		const src = img.attribs.src;
		if (!src || src.startsWith("data:")) return undefined;
		return mediaRef(src, clean(img.attribs.alt) || undefined, img.attribs.class, img.attribs["data-id"] ?? img.attribs["data-attachment-id"]);
	};
	/** Resolve upload URLs in fragments richFromHtml made (wp-image classes are already ids). */
	const resolved = (frags: Fragment[]): Fragment[] =>
		frags.map((f) => {
			if (f.kind !== "media" || f.media.wpId || !f.media.url) return f;
			const id = opts.mediaIdForUrl?.(f.media.url);
			return id ? { ...f, media: { wpId: id, kind: "image" as const, ...(f.media.alt ? { alt: f.media.alt } : {}) } } : f;
		});
	const rich = (h: string, path: string): Fragment[] => {
		const literal = /\[\/?[a-z][\w-]*(?:\s[^\]]*)?\]/i.exec(h.replace(/<[^>]+>/g, " "));
		if (literal) diag({ level: "warn", code: "lossy", message: `shortcode text shown literally on the live page (a plugin that is no longer active?): ${literal[0].slice(0, 60)}; kept as text`, path });
		return resolved(richFromHtml(h.replace(/\s+/g, " "), ctxFor(path)));
	};

	function buttonOf(a: Element, path: string): Fragment[] {
		const label = textOf(a) || clean(a.attribs["aria-label"] ?? a.attribs.title);
		if (!label) {
			note("icon-only link");
			return [];
		}
		const href = a.attribs.href;
		const cls = classOf(a);
		const popup = opts.popupFor({ ...(href ? { href } : {}), ...(cls ? { classes: cls } : {}) });
		if (!href && !popup) diag({ level: "warn", code: "link-unknown", message: `Button "${label}" has no link`, path });
		const style: Button["style"] = /outline|ghost|secondary|bordered|hollow|alt\b|is-style-outline/i.test(cls) ? "secondary" : /(?:^|\s)(?:text-link|btn-link|is-style-link)(?=\s|$)/i.test(cls) ? "link" : "primary";
		return [{ kind: "button", button: { label, href: href ? rel(href) : popup ? `#${popup}` : "#", style, ...(a.attribs.target === "_blank" ? { newTab: true } : {}), ...(popup ? { opensPopup: popup } : {}) } }];
	}
	const isButton = (el: Element) => el.tagName === "a" && (BTN_RE.test(classOf(el)) || el.attribs.role === "button" || BTN_RE.test(classOf(el.parent as Element) ?? "")) && !$(el).find("img").length;

	// ── Forms ──
	let formCount = 0;
	function formOf(el: Element, path: string): Fragment[] {
		const wrap = $(el).closest(".wpcf7, .gform_wrapper, [id^=nf-form-]");
		const src = $.html(wrap.length ? wrap : el);
		const snap = extractForms(cheerio.load(src), src)[0];
		if (!snap) return [];
		if (snap.provider === "wp-search") {
			diag({ level: "info", code: "dynamic", message: "search form left out (the starter has its own search)", path, tag: "form:wp-search" });
			return [];
		}
		if (PLUGIN_FORMS.has(snap.provider) && snap.providerFormId) return [{ kind: "form", provider: snap.provider, id: snap.providerFormId }];
		if (snap.provider !== "html" && snap.provider !== "elementor-forms") return embedOrLegacy($.html(el), ctxFor(path), `${snap.provider} form`);
		const id = `${opts.postId ?? "x"}-${++formCount}`;
		const f = formFromSnapshot({ provider: "html", providerFormId: id, fields: snap.fields, ...(snap.submitLabel ? { submitLabel: snap.submitLabel } : {}) });
		if (!f?.definition) {
			diag({ level: "error", code: "unmapped", message: "form without fields the kit can rebuild (no named inputs); rebuild it by hand", path, carriesContent: true, tag: "form:html" });
			return [];
		}
		forms.set(f.definition.id, { ...f.definition, warnings: f.definition.warnings ?? [] });
		diag({ level: "warn", code: "lossy", message: `form rebuilt from the rendered HTML (${f.definition.fields.length} fields; recipients, success message and conditional fields are not in the HTML): check it against the live form`, path, tag: "form:html" });
		return [{ kind: "form", provider: "html", id }];
	}

	// ── Patterns (only when the markup says so) ──
	function accordion(el: Element, path: string): Fragment[] | undefined {
		const $el = $(el);
		const pairs: { q: string; a: Element }[] = [];
		const used = new Set<Element>();
		if (el.tagName === "details" || $el.children("details").length >= 2) {
			const items = el.tagName === "details" ? [el] : ($el.children("details").get() as Element[]);
			for (const d of items) {
				const q = textOf($(d).children("summary").first() as cheerio.Cheerio<Element>);
				const body = $(d).clone();
				body.children("summary").remove();
				if (q) pairs.push({ q, a: body.get(0) as Element });
			}
			return pairs.length ? pairs.map((p) => ({ kind: "faq" as const, question: p.q, answer: richBlocks($(p.a).html() ?? "", path) })) : undefined;
		}
		if (!/accordi?an|accordion|toggle|faq|collapsible/i.test(classOf(el))) return undefined;
		$el.find("[aria-controls]").each((_, t) => {
			const id = $(t).attr("aria-controls") ?? "";
			const panel = id ? ($el.find(`[id="${id}"]`).get(0) as Element | undefined) : undefined;
			const q = textOf(t as Element);
			if (panel && q && !used.has(panel)) {
				used.add(panel);
				pairs.push({ q, a: panel });
			}
		});
		if (pairs.length < 2) {
			pairs.length = 0;
			$el.find("[class*=title], [class*=question], [class*=header], [class*=heading], [class*=label], [class*=toggle-button], button, h3, h4, h5").each((_, t) => {
				const q = textOf(t as Element);
				if (!q || $(t).find("[class*=content], [class*=body], [class*=panel], [class*=answer]").length) return;
				let h: cheerio.Cheerio<AnyNode> = $(t);
				while (h.length && h.get(0) !== el) {
					const next = h.next();
					if (next.length && /content|body|panel|answer|collapse|inner/i.test(next.attr("class") ?? "")) {
						const p = next.get(0) as Element;
						if (!used.has(p) && !pairs.some((x) => x.q === q)) {
							used.add(p);
							pairs.push({ q, a: p });
						}
						return;
					}
					h = h.parent();
				}
			});
		}
		if (pairs.length < 2) return undefined;
		return pairs.map((p) => ({ kind: "faq" as const, question: p.q, answer: richBlocks($(p.a).html() ?? "", path) }));
	}

	function tabs(el: Element, path: string): Fragment[] | undefined {
		const $el = $(el);
		const list = $el.find("[role=tab]");
		let pairs: { label: string; panel: Element }[] = [];
		if (list.length >= 2) {
			const panels = $el.find("[role=tabpanel]");
			list.each((i, t) => {
				const id = $(t).attr("aria-controls");
				const panel = (id ? $el.find(`[id="${id}"]`).get(0) : undefined) ?? panels.get(i);
				const label = textOf(t as Element);
				if (panel && label) pairs.push({ label, panel: panel as Element });
			});
		} else if (/\btabs?\b|tabbed/i.test(classOf(el))) {
			const links = $el.find(".nav-tabs a, ul.tabs a, .tab-titles a, [class*=tab-title]");
			const panes = $el.find(".tab-pane, .tab-content > div, [class*=tab-panel], [class*=tab_content]");
			if (links.length >= 2 && links.length === panes.length) pairs = links.get().map((l, i) => ({ label: textOf(l as Element), panel: panes.get(i) as Element })).filter((p) => p.label);
		}
		if (pairs.length < 2 || pairs.length !== Math.max(list.length, pairs.length)) return undefined;
		const out: Fragment[] = [];
		for (const p of pairs) {
			const inner = $(p.panel).find("img, iframe, form, video").length;
			if (inner) diag({ level: "warn", code: "lossy", message: `tab "${p.label}": its pictures, frames or forms are not shown in a tab (text kept)`, path });
			out.push({ kind: "tab", label: p.label, body: richBlocks($(p.panel).html() ?? "", path) });
		}
		return out;
	}

	function testimonials(el: Element, path: string): Fragment[] | undefined {
		if (!/testimonial|review-item|client-say/i.test(classOf(el))) return undefined;
		const $el = $(el);
		const all = [el, ...($el.find("[class*=testimonial], [class*=review-item]").get() as Element[])];
		// Leaf-most item boxes: a testimonial class with a quote and no other item inside.
		const items = all.filter((x) => !$(x).find("[class*=testimonial], [class*=review-item]").filter((_, y) => all.includes(y as Element) && quoteOf(y as Element) !== undefined).length && quoteOf(x) !== undefined);
		const out: Fragment[] = [];
		for (const it of items) {
			const q = quoteOf(it);
			if (!q) continue;
			const $it = $(it);
			const NAME = "cite, [class*=name], [class*=author]";
			const nameEl = $it.find(NAME).filter((_, x) => !$(x).find(NAME).length).first();
			const name = textOf(nameEl as cheerio.Cheerio<Element>).replace(/^[–—-]\s*/, "");
			const roleEl = $it.find("[class*=position], [class*=job], [class*=company], [class*=role], [class*=title], [class*=-info], [class*=meta], [class*=subtitle]").filter((_, r) => !$(r).find(NAME).length && !$(r).is(nameEl) && textOf(r as Element) !== name && !!textOf(r as Element)).first();
			const img = $it.find("img").get(0) as Element | undefined;
			const photo = img ? imageOf(img) : undefined;
			out.push({ kind: "testimonial", item: { quote: q, ...(name ? { name } : {}), ...(textOf(roleEl as cheerio.Cheerio<Element>) ? { role: textOf(roleEl as cheerio.Cheerio<Element>) } : {}), ...(photo ? { photo } : {}) } });
		}
		return out.length ? out : undefined;
	}
	function quoteOf(el: Element): string | undefined {
		const $el = $(el);
		const q = $el.find("blockquote, [class*=content], [class*=text], [class*=quote]").filter((_, x) => !$(x).find("cite, [class*=name], [class*=author]").length).first();
		const t = textOf(q as cheerio.Cheerio<Element>).replace(/^[“"]|[”"]$/g, "");
		return t && words(t) >= 3 ? t : undefined;
	}

	function gallery(el: Element, path: string): Fragment[] | undefined {
		const cls = classOf(el);
		const slider = /\b(swiper|slick-slider|owl-carousel|flexslider|carousel|slider|fusion-slider|bde-slider|ux-slider|flickity|rev_slider)/i.test(cls);
		if (!slider && !/gallery|image-grid|tiled|fl-photo-gallery/i.test(cls)) return undefined;
		const imgs = $(el).find("img").get() as Element[];
		const text = textOf(el);
		if (imgs.length < 2 || words(text) > imgs.length * 6) {
			if (slider && words(text) > 0) diag({ level: "warn", code: "lossy", message: "slider with text: its slides are shown one after another", path });
			return undefined;
		}
		const images = imgs.map(imageOf).filter((m): m is MediaRef => !!m);
		if (text) diag({ level: "info", code: "lossy", message: `${slider ? "slider" : "gallery"} captions not carried: ${text.slice(0, 80)}`, path });
		return [{ kind: "gallery", images, layout: slider ? "carousel" : "grid" }];
	}

	function listing(el: Element, path: string): Fragment[] | undefined {
		const posts = $(el).find("article.post, article.type-post, article[class*=post-]").length;
		if (posts < 2 || !/blog|posts|post-grid|post-list|recent|portfolio|archive|loop/i.test(classOf(el))) return undefined;
		if (opts.postCount === 0) {
			diag({ level: "info", code: "dynamic", message: "post listing dropped (the site has no published posts)", path, tag: "listing" });
			return [];
		}
		diag({ level: "error", code: "unmapped", message: `post listing (${posts} posts shown) needs a posts-listing section (not in the v1 library)`, path, carriesContent: true, tag: "listing" });
		return [];
	}
	const richBlocks = (h: string, path: string): RichText => rich(h, path).flatMap((f) => (f.kind === "rich" ? f.blocks : []));

	/** Several sibling layout boxes laid out side by side: the column boxes, or undefined. */
	function columnGroup(el: Element): Element[] | undefined {
		const kids = elementKids(el).filter((k) => !isHidden(k));
		const filled = kids.filter(hasContent);
		if (filled.length < 2 || filled.length > 6 || kids.length > 8) return undefined;
		if (!kids.every((k) => STRUCTURAL_TAGS.has(k.tagName))) return undefined;
		if (hasDirectText(el)) return undefined;
		const hinted = kids.some((k) => COL_RE.test(classOf(k)) || /(?:^|;)\s*(?:width\s*:\s*[\d.]+%|flex(?:-basis)?\s*:)/i.test(styleOf(k)));
		const rowLike = ROW_RE.test(classOf(el)) || /display\s*:\s*(?:flex|grid)/i.test(styleOf(el));
		return hinted || rowLike ? filled : undefined;
	}
	function widthOf(el: Element): string | undefined {
		const pct = Number(/(?:^|;)\s*(?:width|flex-basis|max-width)\s*:\s*([\d.]+)%/i.exec(styleOf(el))?.[1] ?? /(?:^|;)\s*flex\s*:\s*[\d.]+\s+[\d.]+\s+([\d.]+)%/i.exec(styleOf(el))?.[1]);
		const cls = classOf(el);
		const frac = /\b(?:fusion-)?(one|two|three)[_-](half|third|fourth|fifth|sixth)\b/i.exec(cls);
		const grid = /\b(?:col-(?:xs|sm|md|lg|xl)-|large-|vc_col-(?:sm|md|lg)-|span)(\d{1,2})\b/.exec(cls)?.[1];
		let p = pct > 0 && pct <= 100 ? pct : undefined;
		if (!p && frac) p = ({ one: 1, two: 2, three: 3 }[frac[1]?.toLowerCase() as "one"] / { half: 2, third: 3, fourth: 4, fifth: 5, sixth: 6 }[frac[2]?.toLowerCase() as "half"]) * 100;
		if (!p && grid) p = (Number(grid) / 12) * 100;
		if (!p || p >= 99) return undefined;
		for (const [f, v] of [["1/2", 50], ["1/3", 33.33], ["2/3", 66.67], ["1/4", 25], ["3/4", 75]] as const) if (Math.abs(p - v) < 1.5) return f;
		return `${Math.round(p)}/100`;
	}

	// ── Content walk ──
	function flow(el: Element, path: string): Fragment[] {
		const out: Fragment[] = [];
		let inline = "";
		const flush = () => {
			if (clean(inline.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " "))) out.push(...rich(`<p>${inline}</p>`, path));
			inline = "";
		};
		el.children.forEach((c, i) => {
			if (c.type === "text") {
				inline += $.html(c);
				return;
			}
			if (c.type !== "tag") return;
			const e = c as Element;
			const blocky = $(e).find(`${MEDIA_TAGS}, ${[...TEXT_BLOCKS].join(", ")}, div, section`).length > 0;
			if (INLINE.has(e.tagName) && !blocky && !isButton(e) && !isHidden(e)) {
				inline += $.html(e);
				return;
			}
			flush();
			out.push(...node(e, `${path}/${e.tagName}[${i}]`));
		});
		flush();
		return mergeRich(out);
	}

	function node(e: Element, path: string): Fragment[] {
		if (isHidden(e)) {
			const t = textOf(e);
			if (t) diag({ level: "warn", code: "lossy", message: `element hidden on desktop (a phone/tablet copy?) not migrated: "${t.slice(0, 60)}${t.length > 60 ? "…" : ""}"`, path });
			else note("hidden decorative element");
			return [];
		}
		const tag = e.tagName;
		const embed = e.attribs["data-wp2e-embed"];
		if (embed !== undefined) {
			const h = embeds[Number(embed)] ?? "";
			const provider = embedProviderOf(h);
			return provider ? [{ kind: "embed", provider, html: h }] : [];
		}
		if (isButton(e)) return buttonOf(e, path);
		if (tag === "img") {
			const m = imageOf(e);
			return m ? [{ kind: "media", media: m, role: "content" }] : [];
		}
		if (tag === "a" && $(e).find("img").length && !textOf(e) && $(e).find("img").length === 1) {
			const m = imageOf($(e).find("img").get(0) as Element);
			const href = e.attribs.href;
			const toFile = href && /\.(?:jpe?g|png|gif|webp|avif)(?:\?.*)?$/i.test(href);
			return m ? [{ kind: "media", media: m, role: "content", ...(href && !toFile ? { link: rel(href) } : {}) }] : [];
		}
		if (tag === "iframe") return embedOrLegacy($.html(e), ctxFor(path), "iframe").map((f) => ((f.kind === "map" || f.kind === "video") && f.embedUrl ? { ...f, embedUrl: f.embedUrl.replace(/&amp;/g, "&") } : f));
		if (tag === "video") {
			const src = e.attribs.src ?? $(e).find("source[src]").attr("src");
			const poster = e.attribs.poster;
			if (!src) return [];
			return [{ kind: "video", video: { url: src, kind: "video" }, ...(poster ? { poster: mediaRef(poster) } : {}) }];
		}
		if (tag === "form") return formOf(e, path);
		if (tag === "hr" || tag === "svg" || tag === "canvas" || (tag === "i" && !textOf(e))) {
			note("divider / icon");
			return [];
		}
		if (tag === "details") return accordion(e, path) ?? flow(e, path);
		if (tag === "table" || tag === "audio" || tag === "object" || tag === "embed") return embedOrLegacy($.html(e), ctxFor(path), tag);
		if (TEXT_BLOCKS.has(tag)) {
			// A paragraph that only holds button links is those buttons.
			const btns = $(e).find("a").filter((_, a) => isButton(a as Element));
			if (btns.length && clean($(e).text()) === clean(btns.text())) return (btns.get() as Element[]).flatMap((b) => buttonOf(b, path));
			return rich($.html(e), path);
		}
		if (tag === "figure" && !$(e).find("img, iframe, video").length) return rich($.html(e).replace(/^<figure\b[^>]*>|<\/figure>$/g, ""), path);
		if (tag === "figure" && $(e).children("img, a, picture").length && $(e).find("img").length === 1) {
			const frags = flow(e, path);
			return frags;
		}
		if (tag === "picture") {
			const img = $(e).find("img").get(0) as Element | undefined;
			const m = img ? imageOf(img) : undefined;
			return m ? [{ kind: "media", media: m, role: "content" }] : [];
		}
		if (!CONTAINERS.has(tag) && !hasContent(e)) {
			note("empty element");
			return [];
		}
		if (!hasContent(e)) {
			note("empty box / spacer");
			return [];
		}
		// A box that is only a background picture (a photo module drawn as a background).
		if (!textOf(e) && !$(e).find(MEDIA_TAGS).length && bgImage(e)) return [{ kind: "media", media: mediaRef(bgImage(e) as string), role: "content" }];
		const pattern = listing(e, path) ?? accordion(e, path) ?? tabs(e, path) ?? testimonials(e, path) ?? gallery(e, path);
		if (pattern) return pattern;
		const group = columnGroup(e);
		if (group) return [{ kind: "subrow", columns: group.map((g, j) => column(g, `${path}/col[${j}]`)) }];
		if (tag === "a" && e.attribs.href) {
			const frags = flow(e, path);
			diag({ level: "info", code: "lossy", message: `linked box → ${e.attribs.href}: the box's text is kept, the link around it is not`, path });
			return frags;
		}
		return flow(e, path);
	}

	function column(el: Element, path: string): Col {
		const frags = flow(el, path);
		const bg = bgImage(el);
		const color = styleColour(styleOf(el), "background");
		const width = widthOf(el);
		const centred = /text-align\s*:\s*center/i.test(styleOf(el)) || /\b(?:text-center|has-text-align-center|aligncenter|center-align)\b/.test(classOf(el));
		return {
			fragments: frags.length && bg ? [{ kind: "media", media: mediaRef(bg), role: "background" }, ...frags] : frags,
			...(width ? { width } : {}),
			...(color ? { background: { color } } : {}),
			...(centred ? { centered: true } : {}),
		};
	}

	// ── Rows ──
	/** Wrappers to step through: one structural child, no text of their own, not a column group. */
	const chainOf = (el: Element): Element[] => {
		const chain = [el];
		let cur = el;
		for (;;) {
			const kids = elementKids(cur).filter((k) => !isHidden(k) && hasContent(k));
			if (kids.length !== 1 || hasDirectText(cur) || columnGroup(cur)) break;
			const k = kids[0] as Element;
			if (!STRUCTURAL_TAGS.has(k.tagName)) break;
			cur = k;
			chain.push(cur);
		}
		return chain;
	};
	let top = root.get(0) as Element;
	for (;;) {
		const kids = elementKids(top).filter((k) => !isHidden(k) && hasContent(k));
		if (kids.length !== 1 || hasDirectText(top)) break;
		const k = kids[0] as Element;
		if (!STRUCTURAL_TAGS.has(k.tagName) || SECTION_RE.test(classOf(k)) || k.tagName === "section" || columnGroup(k) || columnGroup(top)) break;
		top = k;
	}

	const rows: (Row & { index: number })[] = [];
	const rowAttrs = (chain: Element[]): Record<string, string> => {
		const a: Record<string, string> = {};
		// A background layer: an empty child box that only paints the row (Flatsome .section-bg, overlay divs).
		const layers = chain.flatMap((el) => elementKids(el).filter((k) => !textOf(k) && !$(k).find("img, iframe, video, form").length && (styleColour(styleOf(k), "background") || bgImage(k) || bgGradient(k))));
		for (const el of [...chain, ...layers]) {
			const st = styleOf(el);
			const color = styleColour(st, "background");
			if (color && !a.bg_color) a.bg_color = color;
			const img = bgImage(el);
			if (img && !a.bg_image) {
				const m = mediaRef(img);
				a.bg_image = m.wpId ? String(m.wpId) : (m.url as string);
				if (/background-attachment\s*:\s*fixed|parallax/i.test(st + classOf(el))) a.parallax_bg = "true";
			}
			const g = bgGradient(el);
			if (g && !a.advanced_gradient) {
				a.gradient_type = "advanced";
				a.advanced_gradient = g;
			}
			const text = styleColour(st, "color");
			if (text && !a.text_color) a.text_color = isDarkColour(text) ? "dark" : "light";
			if (!a.text_color && /(?:^|\s)(?:text-light|light-text|has-light-text|text-white|has-white-color|dark-bg|bg-dark|is-dark|inverted|dark|section-dark)(?=\s|$)/.test(classOf(el))) a.text_color = "light";
			const id = el.attribs.id;
			if (id && linked.has(id) && !a.id) a.id = id;
			if (/(?:^|;)\s*min-height\s*:\s*100vh/i.test(st) || /\b(?:full-?height|fullscreen|full-screen)\b/i.test(classOf(el))) a.full_height = "yes";
		}
		return a;
	};
	let pos = 0;
	const pushRow = (els: Element[], index: number, loose: boolean) => {
		const path = `dom[${index}]`;
		let columns: Col[];
		let attrs: Record<string, string> = {};
		if (loose) {
			const frags: Fragment[] = [];
			let inlineHtml = "";
			for (const e of els) {
				if (e.type === "tag" && !(INLINE.has(e.tagName) && !isButton(e))) {
					if (clean(inlineHtml)) frags.push(...rich(`<p>${inlineHtml}</p>`, path));
					inlineHtml = "";
					frags.push(...node(e, `${path}/${e.tagName}`));
				} else inlineHtml += $.html(e);
			}
			if (clean(inlineHtml.replace(/<[^>]+>/g, ""))) frags.push(...rich(`<p>${inlineHtml}</p>`, path));
			columns = [{ fragments: mergeRich(frags) }];
		} else {
			const el = els[0] as Element;
			const chain = chainOf(el);
			attrs = rowAttrs(chain);
			const last = chain.at(-1) as Element;
			// A muted, looping, autoplaying video without controls is the row's background video.
			const bgVideo = $(last).find("video[autoplay][loop], video.video-bg, video.bg-video, video[class*=background]").filter((_, v) => (v as Element).attribs.controls === undefined).first();
			const videoSrc = bgVideo.attr("src") ?? bgVideo.find("source[src]").attr("src");
			if (bgVideo.length && videoSrc && !$(last).children().is(bgVideo)) {
				attrs.video_bg = "true";
				attrs.video_mp4 = videoSrc;
				const poster = bgVideo.attr("poster");
				if (poster && !attrs.bg_image) {
					const m = mediaRef(poster);
					attrs.bg_image = m.wpId ? String(m.wpId) : (m.url as string);
				}
				bgVideo.remove();
			}
			const group = columnGroup(last);
			columns = group ? group.map((g, j) => column(g, `${path}/col[${j}]`)) : [{ fragments: mergeRich(node(last, path)) }];
		}
		if (columns.some((c) => c.fragments.length)) rows.push({ attrs, columns, path, raw: els.map((e) => $.html(e)).join(""), adapter: "dom-fallback", index });
	};
	// Loose text at the top level: split into rows at the top heading level.
	const topKids = top.children.filter((c) => c.type === "tag" || (c.type === "text" && clean((c as unknown as { data: string }).data))) as Element[];
	const headingLevels = topKids.filter((k) => k.type === "tag" && /^h[1-6]$/.test(k.tagName)).map((k) => Number(k.tagName.slice(1)));
	const splitLevel = headingLevels.length ? Math.min(...headingLevels) : 0;
	let run: Element[] = [];
	let runIndex = 0;
	const flushRun = () => {
		if (run.some((e) => (e.type === "tag" ? hasContent(e) : clean((e as unknown as { data: string }).data)))) pushRow(run, runIndex, true);
		run = [];
	};
	for (const k of topKids) {
		const isTag = k.type === "tag";
		if (isTag && isHidden(k)) {
			node(k, `dom[${pos}]`);
			continue;
		}
		const structural = isTag && STRUCTURAL_TAGS.has(k.tagName) && k.tagName !== "figure" && !k.attribs["data-wp2e-embed"] && !isButton(k);
		if (structural) {
			flushRun();
			if (!hasContent(k)) {
				note("empty box / spacer");
				continue;
			}
			pushRow([k], pos++, false);
			continue;
		}
		const heading = isTag && /^h[1-6]$/.test(k.tagName) && Number(k.tagName.slice(1)) <= splitLevel;
		const prevHeading = run.length && run.at(-1)?.type === "tag" && /^h[1-6]$/.test((run.at(-1) as Element).tagName);
		if (heading && run.length && !prevHeading) flushRun();
		if (!run.length) runIndex = pos++;
		run.push(k);
	}
	flushRun();

	if (removed.size) diag({ level: "info", code: "dropped-decorative", message: `left out of the rebuilt page: ${[...removed].map(([w, n]) => `${w} ×${n}`).join(", ")}`, path: "dom" });

	const sections: Section[] = [];
	for (const row of rows) {
		const forced = opts.rowOverrides?.[row.path];
		if (forced === "drop") {
			diag({ level: "info", code: "dropped-decorative", message: "Row dropped by overrides.ts", path: row.path });
			continue;
		}
		const out: Section[] = [];
		for (const v of splitRow(row)) out.push(...recognise(v, { first: sections.length + out.length === 0, kind: opts.kind, ...(forced ? { forced } : {}), keys: opts.keys, diag }));
		for (const s of mergeCollections(out)) {
			s.sourceRef.row = row.index;
			sections.push(s);
		}
	}
	return { sections, diagnostics, forms: [...forms.values()] };
}

/** Remove the theme chrome (header, menus, footer, sidebar, banners, popups, title bar…), counting what went. */
function stripChrome($: cheerio.CheerioAPI, note: (what: string, n?: number) => void): void {
	for (const sel of CHROME) {
		const n = $(sel).length;
		if (n && !["script", "style", "noscript", "template", "svg"].includes(sel)) {
			$(sel).remove();
			note("theme chrome (header, menus, skip links)", n);
		}
	}
	for (const c of MORE_CHROME) {
		const n = $(c.sel).length;
		if (n) {
			$(c.sel).remove();
			note(c.what, n);
		}
	}
	// Site header/footer elements outside the content (an <header>/<footer> inside an article or a quote is content).
	$("header, footer, body nav").each((_, el) => {
		const $e = $(el);
		if ($e.parents("main, article, blockquote, figure, .entry-content, .post-content, [role=main]").length) return;
		if (el.tagName === "nav" && $e.parents("main, #content, .entry-content").length) return;
		$e.remove();
		note(el.tagName === "nav" ? "navigation" : el.tagName);
	});
}

/** The page's main content area (first content root with text or media), after the chrome is gone. */
function findRoot($: cheerio.CheerioAPI, postId: number | undefined): cheerio.Cheerio<Element> | undefined {
	for (const sel of ROOTS) {
		const c = $(sel.replace("{id}", String(postId ?? "x"))).first() as cheerio.Cheerio<Element>;
		if (c.length && (clean(c.text()) || c.find(MEDIA_TAGS).length)) return c;
	}
	return undefined;
}

/** Words in the main content area of a saved page (theme chrome left out): does the live page show content? */
export function liveContentWords(html: string, postId?: number): number {
	const $ = cheerio.load(html);
	$("script, style, noscript, template, svg").remove();
	stripChrome($, () => {});
	const root = findRoot($, postId);
	return root ? words((root.html() ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ")) : 0;
}

/** The first URL of a srcset (`a.jpg 300w, b.jpg 1024w` → the widest). */
function firstSrcset(v: string | undefined): string | undefined {
	if (!v) return undefined;
	const list = v.split(",").map((s) => s.trim().split(/\s+/)).filter((p) => p[0]);
	list.sort((a, b) => Number.parseInt(b[1] ?? "0", 10) - Number.parseInt(a[1] ?? "0", 10));
	return list[0]?.[0];
}
