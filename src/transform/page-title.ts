/**
 * The page title the WordPress theme prints above the content (Twenty Twenty-One, Astra, Hello, GeneratePress…:
 * `<h1 class="entry-title">About</h1>` in the entry header). It is not in the page's content, so no adapter sees it,
 * and the migrated page lost its visible title and its h1 ("About" became "Our kiln", the first content heading;
 * WordPress e2e test, 2026-11-22). Read from the audit's saved HTML of the page: when the theme showed the title, it
 * comes back as the page's first section, an h1 the owner can edit or delete. A page whose builder hides the title
 * (Elementor's "Hide title", a canvas template) shows none, and none is added.
 */
import * as cheerio from "cheerio";
import type { Keys } from "../ir/portable-text.js";
import type { Section } from "../ir/schema.js";
import { CHROME } from "./coverage.js";

/** Where themes print the title of a page (classic themes, block themes, page-header bands). */
const TITLE = ["h1.entry-title", "h1.page-title", "h1.wp-block-post-title", ".entry-header h1", ".page-header h1", "h1.elementor-page-title", ".page-title-bar h1"];
/** The page's own content (builder or editor output): a heading in here is content, already migrated. */
const CONTENT = ".entry-content, .elementor, #brx-content, .et_builder_inner_content, .et-l--post, .wpb-content-wrapper, .wp-block-post-content";

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const same = (a: string, b: string) => clean(a).toLowerCase().replace(/[’‘]/g, "'") === clean(b).toLowerCase().replace(/[’‘]/g, "'");

/** The title as the live page showed it (a visible h1 outside the content, equal to the page's title), else undefined. */
export function themePageTitle(html: string, title: string): string | undefined {
	if (!clean(title)) return undefined;
	const $ = cheerio.load(html);
	for (const sel of CHROME) $(sel).remove();
	const hit = $(TITLE.join(", "))
		.toArray()
		.find((el) => !$(el).closest(CONTENT).length && !/\b(?:screen-reader-text|visually-hidden|sr-only|hidden)\b/.test($(el).attr("class") ?? "") && same($(el).text(), title));
	return hit ? clean($(hit).text()) : undefined;
}

/** Whether the page's first section already opens with this heading (an adapter that kept it, a hero with the same words). */
function opensWith(sections: Section[], text: string): boolean {
	const first = sections[0] as { fields?: Record<string, unknown> } | undefined;
	const f = first?.fields ?? {};
	if (typeof f.heading === "string" && same(f.heading, text)) return true;
	const body = Array.isArray(f.body) ? (f.body as { style?: string; children?: { text?: string }[] }[]) : [];
	const head = body.find((b) => /^h[1-6]$/.test(b.style ?? ""));
	return !!head && same((head.children ?? []).map((c) => c.text ?? "").join(""), text);
}

/** The theme's page title as a first section (a heading-only text section, h1), or undefined when none is needed. */
export function themeTitleSection(html: string | undefined, title: string, sections: Section[], keys: Keys): Section | undefined {
	const text = html ? themePageTitle(html, title) : undefined;
	if (!text || opensWith(sections, text)) return undefined;
	return {
		type: "rich_text",
		theme: { tone: "light" },
		spacing: "compact",
		sourceRef: { adapter: "html", path: "theme-title", rawHash: "theme-title" },
		fields: { body: [{ _type: "block", _key: keys.next(), style: "h1", children: [{ _type: "span", _key: keys.next(), text, marks: [] }], markDefs: [] }], width: "normal", align: "left", buttons: [] },
	} as Section;
}
