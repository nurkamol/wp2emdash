/**
 * The theme's page title (src/transform/page-title.ts): a classic theme prints `<h1 class="entry-title">` above the
 * content; the migrated page keeps it as its first section. Synthetic markup in the shape Twenty Twenty-One, Astra and
 * Elementor produce (WordPress e2e test, 2026-11-22: /about/ lost "About" and its h1 became "Our kiln").
 */
import { describe, expect, it } from "vitest";
import { Keys } from "../src/ir/portable-text.js";
import type { Section } from "../src/ir/schema.js";
import { themePageTitle, themeTitleSection } from "../src/transform/page-title.js";

const page = (inner: string) => `<html><body><header id="masthead" class="site-header"><h1 class="site-title">Harbor Lane Pottery</h1></header><main id="main"><article class="page">${inner}</article></main></body></html>`;
const TT1 = page(`<header class="entry-header alignwide"><h1 class="entry-title">About</h1></header><div class="entry-content"><h2>Our kiln</h2><p>We fire to cone 6.</p></div>`);
const text = (body: string): Section => ({ type: "rich_text", theme: { tone: "light" }, spacing: "normal", sourceRef: { adapter: "gutenberg", path: "blocks[0]", rawHash: "x" }, fields: { body: [{ _type: "block", _key: "a", style: "h2", children: [{ _type: "span", _key: "b", text: body, marks: [] }], markDefs: [] }], width: "normal", align: "left", buttons: [] } }) as Section;

describe("theme page title", () => {
	it("finds the title the theme printed above the content", () => {
		expect(themePageTitle(TT1, "About")).toBe("About");
		expect(themePageTitle(page(`<div class="page-header"><h1 class="page-title">À propos</h1></div><div class="entry-content"></div>`), "À propos")).toBe("À propos");
	});

	it("ignores the site title, headings inside the content, hidden titles and other text", () => {
		// The header's site title (an h1 on the front page) is chrome.
		expect(themePageTitle(page(`<div class="entry-content"><p>x</p></div>`), "Harbor Lane Pottery")).toBeUndefined();
		// An Elementor page whose own heading says the same: content, migrated by the adapter.
		expect(themePageTitle(page(`<div class="elementor"><h1 class="elementor-heading-title">Classes</h1></div>`), "Classes")).toBeUndefined();
		expect(themePageTitle(page(`<header class="entry-header"><h1 class="entry-title screen-reader-text">About</h1></header>`), "About")).toBeUndefined();
		expect(themePageTitle(TT1, "Contact")).toBeUndefined();
		expect(themePageTitle(TT1, "")).toBeUndefined();
	});

	it("adds an h1 text section first, unless the content already opens with it", () => {
		const s = themeTitleSection(TT1, "About", [text("Our kiln")], new Keys("t"));
		expect(s).toMatchObject({ type: "rich_text", spacing: "compact", sourceRef: { adapter: "html", path: "theme-title" }, fields: { body: [{ style: "h1", children: [{ text: "About" }] }] } });
		expect(themeTitleSection(TT1, "About", [text("About")], new Keys("t"))).toBeUndefined();
		expect(themeTitleSection(undefined, "About", [], new Keys("t"))).toBeUndefined();
	});
});
