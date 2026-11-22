/**
 * Text conservation: compares the live page's own HTML (audit snapshot, server-rendered) with the IR,
 * so the check does not depend on the adapter that produced the IR.
 */
import * as cheerio from "cheerio";
import { restoreCfEmails } from "../audit/page.js";
import { ptText } from "../ir/portable-text.js";
import type { IrMenuItem, IrPage, Section } from "../ir/schema.js";

/** Theme chrome that is not page content (header, menus, search, skip links, popups, scripts). */
export const CHROME = [
	"script",
	"style",
	"noscript",
	"template",
	"svg",
	".screen-reader-text",
	".skip-link",
	"#header-outer",
	"#header-space",
	"#search-outer",
	"#slide-out-widget-area",
	"#slide-out-widget-area-bg",
	".nectar-skip-to-content",
	"#mobile-menu",
	".pum-overlay",
	"#wpadminbar",
	"header.site-header",
	"nav.main-navigation",
	".elementor-location-header",
	// Elementor Pro popups (rendered hidden in every page; migrated as popups)
	".elementor-location-popup",
	"#masthead",
	"#site-navigation",
	".wp-block-template-part header",
	// Bricks: the header template (menus are compared by the menu check) and popup templates
	"#brx-header",
	".brx-popup",
	// Divi: the theme's own header (#main-header, #top-header) and a Theme Builder header layout (.et-l--header)
	"#main-header",
	"#top-header",
	".et-l--header",
	// Announcement bars (Announcer plugin; the starter's bar): rebuilt as the "announcement" site part with its
	// schedule, which may hide it on one side only (an ended bar stays in the plugin's HTML but is not shown).
	".ancr-group",
	"section.announcement[data-announcement]",
	// WooCommerce template parts catalogue mode does not carry (listed in the shop report): related / upsell products,
	// the reviews tab and its form, tab labels, breadcrumbs, the add-to-cart box, stock and result-count notes, sorting.
	// The product's own text (name, price, descriptions, attributes) stays compared. (WordPress e2e test, 2026-11-22.)
	"section.related.products",
	"section.up-sells",
	".cross-sells",
	"#reviews",
	".woocommerce-Reviews",
	"ul.wc-tabs",
	".woocommerce-breadcrumb",
	"form.cart",
	".woocommerce-product-rating",
	".stock",
	".woocommerce-result-count",
	".woocommerce-ordering",
	".woocommerce-notices-wrapper",
	".product_meta .posted_in",
	".product_meta .tagged_as",
	".onsale",
	".woocommerce-Tabs-panel > h2",
	// WordPress's comment form (comments are imported and shown by the comments feature, with its own form).
	"#respond",
	// wp2emdash starter chrome (verify compares the migrated site's HTML the same way)
	"#menu-panel",
	".menu-overlay",
	"dialog.popup",
];

export function sourceText(html: string): string {
	const $ = cheerio.load(html);
	restoreCfEmails($);
	for (const sel of CHROME) $(sel).remove();
	const root = $("#ajax-content-wrap").length ? $("#ajax-content-wrap") : $("main").length ? $("main").first().parent() : $("body");
	// Block-level elements end a word.
	root.find("p,div,li,h1,h2,h3,h4,h5,h6,br,td,th,tr,section,article,header,footer,aside,nav,main,figure,figcaption,blockquote,dt,dd,ul,ol,table,form,fieldset,legend,label,option,select,textarea,input,button,a").each((_, el) => {
		$(el).append(" ");
	});
	return root.text();
}

export function tokens(text: string): string[] {
	return text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[’‘`´]/g, "'")
		.replace(/&nbsp;| /g, " ")
		.split(/[^\p{L}\p{N}$€£'@.]+/u)
		.map((t) => t.replace(/^[.'@]+|[.'@]+$/g, ""))
		.filter((t) => t.length > 1 || /\d/.test(t));
}

/** Every human-visible string in a section (rich text, labels, questions, names, prices…). */
export function sectionText(s: Section): string {
	const parts: string[] = [];
	const visit = (v: unknown, key = "") => {
		if (v == null) return;
		if (Array.isArray(v)) {
			if (v.length && typeof v[0] === "object" && (v[0] as { _type?: string })?._type === "block") parts.push(ptText(v as never));
			else for (const x of v) visit(x, key);
			return;
		}
		if (typeof v === "object") {
			for (const [k, x] of Object.entries(v)) if (!["href", "url", "html", "provider", "embedUrl", "wpId", "kind", "sourceRef", "id", "formRef", "theme", "width", "ratio", "layout", "align", "mediaSide", "style", "opensPopup", "library", "colors", "schedule", "detected"].includes(k)) visit(x, k);
			return;
		}
		if (typeof v === "string" && key !== "variant" && key !== "type") parts.push(v);
	};
	visit(s.fields);
	return parts.join("\n");
}

export function irText(docs: IrPage[], menus: IrMenuItem[][], extra: string[] = []): string {
	const walk = (items: IrMenuItem[]): string[] => items.flatMap((i) => [i.label, ...walk(i.children)]);
	return [...docs.flatMap((d) => d.sections.map(sectionText)), ...menus.flatMap(walk), ...extra].join("\n");
}

export interface Conservation {
	ratio: number;
	sourceWords: number;
	missing: string[];
}

/** Share of distinct source words present in the IR. `{year}` in the IR matches any 4-digit year. */
export function conservation(source: string, ir: string): Conservation {
	const src = new Set(tokens(source));
	const have = new Set(tokens(ir));
	const yearDynamic = ir.includes("{year}");
	const missing = [...src].filter((w) => !have.has(w) && !(yearDynamic && /^(19|20)\d\d$/.test(w)));
	return { ratio: src.size ? 1 - missing.length / src.size : 1, sourceWords: src.size, missing };
}

/** Context snippets around missing words, for the report. */
export function missingContext(source: string, missing: string[], max = 8): string[] {
	const flat = source.replace(/\s+/g, " ");
	const out: string[] = [];
	for (const w of missing.slice(0, max)) {
		const i = flat.toLowerCase().indexOf(w);
		if (i >= 0) out.push(`…${flat.slice(Math.max(0, i - 40), i + w.length + 40).trim()}…`);
	}
	return out;
}
