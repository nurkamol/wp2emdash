import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { adaptBricks, type BricksElement, bricksElements, bricksFormToDefinition, bricksSite, gridTracks, isBricks, siteTemplates, templateElements } from "../src/adapters/bricks/index.js";
import { atBreakpoint, cssPx, effectiveSettings, liveVariables, resolveColour, resolveLength } from "../src/adapters/bricks/site.js";
import type { BricksBox } from "../src/audit/browser.js";
import { kitConfigSchema } from "../src/config/schema.js";
import { sitePaths } from "../src/core/paths.js";
import { bricksMediaRefs, bricksOptionsNote, readBricksOptions } from "../src/extract/bricks.js";
import { Keys } from "../src/ir/portable-text.js";
import type { IrPage, IrSite, Section } from "../src/ir/schema.js";
import { completeMarianaEmbeds, marianaTenant, withMarianaLoader } from "../src/transform/embeds.js";
import { detectBuilder, runTransform } from "../src/phases/transform.js";

const els: BricksElement[] = [
	{ id: "s1", name: "section", parent: 0, children: ["h1"], settings: {} },
	{ id: "h1", name: "heading", parent: "s1", children: [], settings: { text: "Hello", tag: "h2" } },
];
const opts = { kind: "page" as const, keys: new Keys("t"), popupFor: () => undefined, postCount: 0 };

describe("Bricks adapter", () => {
	it("reads the element list as an array, an index-keyed object or JSON text; not PHP-serialized text", () => {
		expect(bricksElements(els)).toHaveLength(2);
		expect(bricksElements({ 0: els[0], 1: els[1] })).toHaveLength(2);
		expect(bricksElements(JSON.stringify(els))).toHaveLength(2);
		expect(bricksElements('a:1:{i:0;a:2:{s:2:"id";s:2:"s1";}}')).toBeUndefined();
		expect(bricksElements([])).toBeUndefined();
	});
	it("detects Bricks from post meta unless the post is in WordPress editor mode", () => {
		expect(isBricks({ _bricks_page_content_2: els, _bricks_editor_mode: "bricks" })).toBe(true);
		expect(isBricks({ _bricks_page_content_2: els })).toBe(true);
		expect(isBricks({ _bricks_page_content_2: els, _bricks_editor_mode: "wordpress" })).toBe(false);
		expect(detectBuilder("", { _bricks_page_content_2: els })).toBe("bricks");
		expect(detectBuilder("<!-- wp:paragraph --><p>x</p><!-- /wp:paragraph -->", {})).toBe("gutenberg");
	});
	it("a template that embeds itself is reported, not followed forever", () => {
		const self: BricksElement[] = [{ id: "t1", name: "template", parent: 0, children: [], settings: { template: 5 } }];
		const r = adaptBricks(self, { ...opts, template: () => self });
		expect(r.diagnostics.some((d) => d.code === "unmapped" && /could not be loaded/.test(d.message))).toBe(true);
	});
	it("an element without a handler is reported, as an error when it carries content", () => {
		const r = adaptBricks([{ id: "x", name: "brxe-custom", parent: 0, settings: { text: "Hi" } }, { id: "y", name: "spinner", parent: 0, settings: { speed: 2 } }], opts);
		expect(r.diagnostics.map((d) => [d.level, d.carriesContent])).toEqual([
			["error", true],
			["warn", false],
		]);
	});
	it("reads grid templates as column tracks", () => {
		expect(gridTracks("repeat(3, 1fr)")).toEqual([1, 1, 1]);
		expect(gridTracks("1fr 2fr")).toEqual([1, 2]);
		expect(gridTracks("minmax(0, 1fr) 300px")).toEqual([1, 1]);
		expect(gridTracks("repeat(auto-fit, minmax(240px, 1fr))")).toBeUndefined();
	});
});

describe("Bricks body weight token", () => {
	it("writes the theme style's body weight only when it is not the default", async () => {
		const { bricksBodyWeight } = await import("../src/phases/scaffold.js");
		expect(bricksBodyWeight({ typography: { typographyBody: { "font-weight": "300" } } })).toContain("--body-weight: 300;");
		expect(bricksBodyWeight({ typography: { typographyBody: { "font-weight": "400" } } })).toBe("");
		expect(bricksBodyWeight(undefined)).toBe("");
	});
});

describe("Bricks layout tokens", () => {
	const live = liveVariables(
		[390, 768, 1440].map((width) => ({
			width,
			rootFontSize: 16,
			variables: { "--content-width": "85.375rem", "--text-line-height": "calc(6px + 2ex)", "--text-text-wrap": "pretty", "--heading-text-wrap": "pretty", "--radius": "5px", "--text-m": "clamp(1rem, calc(0.1988071571vw + 0.9552683897rem), 1.125rem)", "--btn-line-height": "1", "--btn-border-width": "2px", "--paragraph-spacing": "1em" },
		})),
	);
	const site = bricksSite({ bricks_theme_styles: { acss: { label: "ACSS", settings: { conditions: { conditions: [{ main: "any" }] }, container: { width: "var(--content-width)" } } } } }, live);
	const section = (pad: number) => ({ name: "section", w: 0, h: 0, pad: [40, pad, 40, pad] as [number, number, number, number] });
	const shots: { viewport: string; bricks: Record<string, BricksBox> }[] = [
		{ viewport: "mobile", bricks: { "c:0": section(21.2), "c:1": section(21.2), "c:1/0": { name: "container", w: 0, h: 0 } } },
		{ viewport: "tablet", bricks: { "c:0": section(36.2) } },
		{ viewport: "desktop", bricks: { "c:0": section(60), "c:1": section(60), "c:2": section(0) } },
	];
	it("reads the content width from the theme style, the gutter from the measured section padding, and Automatic.css rules", async () => {
		const { bricksLayout } = await import("../src/adapters/bricks/layout.js");
		const layout = bricksLayout(site, shots, { "auto-radius-selectors": '":where(img):not(header img)", ":where(figure)"' });
		expect(layout).toEqual({ container: 1366, gutter: { mobile: 21.2, tablet: 36.2, desktop: 60 }, textLeading: "calc(6px + 2ex)", textWrap: "pretty", headingWrap: "pretty", paragraphSpacing: 1, imageRadius: 5, button: { size: { mobile: 16.06, desktop: 18 }, leading: 1, border: 2 } });
		// Without the automatic image radius in the Automatic.css settings, images keep the starter's corners.
		expect(bricksLayout(site, shots, {}).imageRadius).toBeUndefined();
		const { bricksLayoutTokens } = await import("../src/phases/scaffold.js");
		const css = bricksLayoutTokens(layout);
		expect(css).toContain("--container: 1366px;");
		expect(css).toContain("--gutter: clamp(21.2px, 6.79px + 3.695vw, 60px);");
		expect(css).toContain("--btn-size: clamp(16.06px, 15.34px + 0.185vw, 18px);");
		expect(css).toContain(":where(p, li) { line-height: calc(6px + 2ex); }");
		expect(css).toContain("body { text-wrap: pretty; }");
		expect(css).toContain("--para-gap: 1em;");
		expect(css).toContain(".section .btn:not(.btn--link, .btn--plain) { line-height: 1; border-width: 2px; }");
		expect(css).not.toContain("@media"); // 36.2px at 768 is on the phone→desktop line
		expect(bricksLayoutTokens(undefined)).toBe("");
		expect(bricksLayoutTokens({})).toBe("");
		expect(bricksLayoutTokens({ link: { color: "#1F442C", underline: false } })).toContain(".section .prose a:not(.btn) { color: #1F442C; }");
	});
	it("uses the measured gaps per screen for a title box over a post-content box", () => {
		const page: BricksElement[] = [
			{ id: "s", name: "section", parent: 0, children: ["t", "c"], settings: {} },
			{ id: "t", name: "container", parent: "s", children: ["h"], settings: { _width: "auto" } },
			{ id: "h", name: "heading", parent: "t", children: [], settings: { tag: "h1", text: "Terms" } },
			{ id: "c", name: "container", parent: "s", children: ["p"], settings: {} },
			{ id: "p", name: "text-basic", parent: "c", children: [], settings: { tag: "p", text: "<p>One.</p><ul><li>Two</li></ul>" } },
		];
		const box = (name: string, d: number, m: number) => ({ desktop: { name, w: 0, h: 0, rowGap: d }, mobile: { name, w: 0, h: 0, rowGap: m } });
		const boxes: Record<string, ReturnType<typeof box>> = { "c:0": box("section", 67.5, 43.4), "c:0/1": box("container", 30, 24.2) };
		const r = adaptBricks(page, { ...opts, measured: (k) => boxes[k] });
		const rt = r.sections[0] as Extract<Section, { type: "rich_text" }>;
		expect(rt.fields.width).toBe("wide");
		expect(rt.fields.look).toEqual({ headCenter: true, headGap: "clamp(43.4px, 34.45px + 2.295vw, 67.5px)", blockGap: "clamp(24.2px, 22.05px + 0.552vw, 30px)" });
	});
	it("gives the hero the measured space above its buttons per screen", () => {
		const f = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "bricks", "hero-look.json"), "utf8")) as { elements: BricksElement[]; options: Record<string, unknown>; live: Parameters<typeof liveVariables>[0] };
		const boxes: Record<string, Partial<Record<"desktop" | "mobile", BricksBox>>> = { "c:0/1": { desktop: { name: "container", w: 0, h: 0, rowGap: 48 }, mobile: { name: "container", w: 0, h: 0, rowGap: 32 } } };
		const r = adaptBricks(f.elements, { ...opts, site: bricksSite(f.options, liveVariables(f.live)), measured: (k) => boxes[k] });
		const hero = r.sections[0] as Extract<Section, { type: "hero" }>;
		expect(hero.fields.look?.buttonsAbove).toBe("clamp(32px, 26.06px + 1.524vw, 48px)");
		expect(hero.fields.buttons.every((b) => b.plain && b.light)).toBe(true);
	});
	it("stacks a button row on phones when the live row is twice as tall there with buttons of one width", () => {
		const page: BricksElement[] = [
			{ id: "s", name: "section", parent: 0, children: ["c"], settings: {} },
			{ id: "c", name: "container", parent: "s", children: ["h", "r"], settings: {} },
			{ id: "h", name: "heading", parent: "c", children: [], settings: { tag: "h1", text: "Rentals" } },
			{ id: "r", name: "div", parent: "c", children: ["b1", "b2"], settings: { _direction: "row" } },
			{ id: "b1", name: "button", parent: "r", children: [], settings: { text: "Options", link: { type: "external", url: "#o" } } },
			{ id: "b2", name: "button", parent: "r", children: [], settings: { text: "Request a rental", link: { type: "external", url: "#r" } } },
		];
		const b = (name: string, dw: number, dh: number, mw: number, mh: number) => ({ desktop: { name, w: dw, h: dh }, mobile: { name, w: mw, h: mh } });
		const boxes: Record<string, ReturnType<typeof b>> = { "c:0/0/1": b("div", 389, 67, 209, 113), "c:0/0/1/0": b("button", 167, 40, 182, 36), "c:0/0/1/1": b("button", 182, 40, 182, 36) };
		expect(adaptBricks(page, { ...opts, measured: (k) => boxes[k] }).sections[0]?.buttonsWidth).toBe("equal");
		boxes["c:0/0/1"] = b("div", 389, 67, 389, 67);
		expect(adaptBricks(page, { ...opts, measured: (k) => boxes[k] }).sections[0]?.buttonsWidth).toBeUndefined();
	});
});

describe("Announcement bars in the text comparison", () => {
	it("leaves the Announcer plugin's bar and the starter's bar out of the page text (their schedules decide)", async () => {
		const { sourceText } = await import("../src/transform/coverage.js");
		const live = '<body><div class="ancr-group ancr-pos-top"><div class="ancr-inner"><p>NOW AVAILABLE</p></div></div><main><p>Welcome in</p></main></body>';
		const staging = '<body><section class="announcement" data-announcement><p>NOW AVAILABLE</p></section><main><p>Welcome in</p></main></body>';
		expect(sourceText(live).trim()).toBe("Welcome in");
		expect(sourceText(staging).trim()).toBe("Welcome in");
	});
});

describe("Bricks header look", () => {
	const site = bricksSite(
		{
			bricks_global_classes: [
				{ id: "hp", name: "header", settings: { _padding: { left: "var(--space-s)", right: "var(--space-s)" } } },
				{ id: "tg", name: "menu-toggle", settings: { _display: "none", "_display:tablet_portrait": "flex" } },
				{ id: "cta", name: "cta", settings: { padding: { top: "12", bottom: "12" } } },
				{ id: "oc", name: "offcanvas-inner", settings: { _padding: { left: "var(--space-m)" }, _rowGap: "var(--space-xl)" } },
				{ id: "cl", name: "close", settings: { _top: "var(--space-l)", iconSize: "42" } },
			],
			bricks_color_palette: [{ id: "p", colors: [{ id: "green", hex: "#1f442c" }, { id: "light", hex: "#4b8352" }, { id: "white", hex: "#ffffff" }] }],
		},
		liveVariables([390, 1440].map((width) => ({ width, rootFontSize: 16, variables: { "--space-s": "clamp(1.125rem, calc(0.1vw + 1.1rem), 1.25rem)", "--space-m": "clamp(1.5rem, calc(0.5964vw + 1.3658rem), 1.875rem)", "--space-l": "2rem", "--space-xl": "clamp(2.7rem, calc(2.3vw + 2.15rem), 4.2rem)" } }))),
	);
	const ripple = (id: string, parent: string, label: string, colour: string, extra: Record<string, unknown> = {}) => ({ id, name: "ripple_button_v3", parent, children: [], settings: { topRippleInnerTitle: label, topRippleBackground: { color: { id: colour } }, topRippleColor: { id: "white" }, link: { type: "external", url: "/x/" }, ...extra } });
	const els = [
		{ id: "h", name: "section", parent: 0, children: ["c"], settings: { _cssGlobalClasses: ["hp"] } },
		{ id: "c", name: "container", parent: "h", children: ["b1", "t", "o", "b2"], settings: {} },
		ripple("b1", "c", "Contact Us", "green", { _cssGlobalClasses: ["cta"], "_display:mobile_landscape": "none" }),
		{ id: "t", name: "toggle", parent: "c", children: [], settings: { _cssGlobalClasses: ["tg"] } },
		{ id: "o", name: "offcanvas", parent: "c", children: ["in"], settings: { width: "756" } },
		{ id: "in", name: "block", parent: "o", children: ["x", "lg", "bb"], settings: { _cssGlobalClasses: ["oc"], _hidden: { _cssClasses: "brx-offcanvas-inner" } } },
		{ id: "x", name: "toggle", parent: "in", children: [], settings: { _cssGlobalClasses: ["cl"] } },
		{ id: "lg", name: "logo", parent: "in", children: [], settings: { logoHeight: "100px" } },
		{ id: "bb", name: "div", parent: "in", children: ["p1", "p2"], settings: { _columnGap: "18" } },
		ripple("p1", "bb", "Contact Us", "green"),
		ripple("p2", "bb", "Book Now", "light"),
		ripple("b2", "c", "Book Now", "light", { _cssGlobalClasses: ["cta"], "_display:mobile_landscape": "none" }),
	];
	it("reads the header gutter, a desktop-hidden toggle, pill buttons and the offcanvas sheet from the template", async () => {
		const { bricksHeaderLook } = await import("../src/adapters/bricks/layout.js");
		const look = bricksHeaderLook(els, site);
		expect(look.gutter).toEqual({ mobile: 18, desktop: 19.04 });
		expect(look.toggleSmallOnly).toBe(true);
		expect(look.buttonsHidePhone).toBe(true);
		expect(look.buttons).toEqual([
			{ label: "Contact Us", bg: "#1f442c", color: "#ffffff", radius: 100, padY: 12, padX: 30 },
			{ label: "Book Now", bg: "#4b8352", color: "#ffffff", radius: 100, padY: 12, padX: 30 },
		]);
		expect(look.panel).toMatchObject({ pad: "clamp(24.18px, 22.02px + 0.554vw, 30px)", closeInset: "32px", closeSize: 42, logoHeight: 100, width: 756, buttonsGap: "18px" });
		expect(look.panel?.buttons?.map((b) => [b.label, b.padY])).toEqual([
			["Contact Us", 15],
			["Book Now", 15],
		]);
		const { bricksHeaderConfig } = await import("../src/phases/scaffold.js");
		const menu = { panel: { background: "rgb(255, 255, 255)" }, overlay: { background: "rgba(0, 0, 0, 0.3)" }, itemStyle: { fontFamily: "Outfit", fontWeight: "500", color: "rgb(0, 0, 0)", lineHeight: "21.087px" }, animations: [{ target: "div.brx-offcanvas-inner", name: "transform", durationMs: 200, easing: "cubic-bezier(0.25, 0, 0.25, 1)", keyframes: [{ transform: "translate(-100%)" }, { transform: "translate(0px)" }] }] };
		expect(bricksHeaderConfig(look, menu as never, '"Outfit", system-ui')?.panelStyle).toEqual({ bg: "rgb(255, 255, 255)", color: "rgb(0, 0, 0)", weight: 500, lineHeight: "21.087px", font: "body", overlay: "rgba(0, 0, 0, 0.3)", from: "left", ms: 200, ease: "cubic-bezier(0.25, 0, 0.25, 1)" });
		expect(bricksHeaderConfig(undefined, menu as never, "Outfit")).toBeUndefined();
	});
});

describe("Bricks site data", () => {
	const site = bricksSite({
		bricks_color_palette: [{ id: "p", colors: [{ id: "a1", hex: "#112233" }, { id: "a2", raw: "var(--brand)" }] }],
		bricks_global_variables: JSON.stringify([{ id: "v", name: "brand", value: "#abcdef" }, { id: "w", name: "gap", value: "2rem" }]),
		bricks_global_classes: [{ id: "c1", name: "pad", settings: { _padding: { top: "10" }, _background: { color: { hex: "#000" } } } }],
	});
	it("resolves palette ids, palette and global variables; unresolved variables stay undefined", () => {
		expect(resolveColour({ id: "a1", name: "x" }, site)).toBe("#112233");
		expect(resolveColour({ raw: "var(--bricks-color-a2)" }, site)).toBe("#abcdef");
		expect(resolveColour({ raw: "var(--nope, #fff)" }, site)).toBe("#fff");
		expect(resolveColour({ raw: "var(--nope)" }, site)).toBeUndefined();
		expect(resolveColour({ rgb: "rgba(0, 0, 0, 0.5)" }, site)).toBe("rgba(0, 0, 0, 0.5)");
		expect(resolveLength("var(--gap)", site)).toBe("2rem");
		expect(resolveLength("40", site)).toBe("40px");
	});
	it("evaluates lengths through global and live design variables at a screen width (calc, clamp, rem at the live root size)", () => {
		const live = liveVariables([
			{ width: 390, rootFontSize: 10, variables: { "--space-l": "clamp(3rem, calc(2vw + 2rem), 5rem)", "--width-l": "calc(80rem * 0.6)", "--shade-50": "rgba(0, 0, 0, 0.5)" } },
			{ width: 1440, rootFontSize: 10, variables: { "--space-l": "clamp(3rem, calc(2vw + 2rem), 5rem)", "--width-l": "calc(80rem * 0.6)", "--shade-50": "rgba(0, 0, 0, 0.5)" } },
		]);
		const s = bricksSite({ bricks_global_variables: [{ id: "w", name: "gap", value: "2rem" }] }, live);
		expect(cssPx("var(--width-l)", s)).toBe(480);
		expect(cssPx("var(--space-l)", s, 1440)).toBe(48.8);
		expect(cssPx("var(--space-l)", s, 390)).toBe(30);
		expect(cssPx("var(--gap)", s)).toBe(20);
		expect(cssPx("max(10px, 1.5rem)", s)).toBe(15);
		expect(cssPx("50%", s)).toBeUndefined();
		expect(cssPx("var(--nope, 12px)", s)).toBe(12);
		expect(cssPx("var(--nope)", s)).toBeUndefined();
		expect(resolveColour({ raw: "var(--shade-50)" }, s)).toBe("rgba(0, 0, 0, 0.5)");
		expect(cssPx("calc(1rem + 4px)", site)).toBe(20);
	});
	it("merges global class settings under the element's own", () => {
		const s = effectiveSettings({ id: "e", name: "section", parent: 0, settings: { _cssGlobalClasses: ["c1"], _padding: { bottom: "20" } } }, site);
		expect(s._padding).toEqual({ top: "10", bottom: "20" });
		expect(s._background).toEqual({ color: { hex: "#000" } });
	});
	it("inherits breakpoint values from the wider breakpoint (desktop-first) or the narrower one (mobile-first base)", () => {
		const s = { _padding: { top: "100" }, "_padding:tablet_portrait": { top: "60" } };
		expect(atBreakpoint(s, "_padding", "mobile_portrait", site)).toEqual({ top: "60" });
		expect(atBreakpoint(s, "_padding", "desktop", site)).toEqual({ top: "100" });
		const mobileFirst = bricksSite({ bricks_breakpoints: [{ key: "desktop", width: 1279 }, { key: "tablet_portrait", width: 991 }, { key: "mobile_portrait", width: 478, base: true }] });
		const m = { _padding: { top: "20" }, "_padding:tablet_portrait": { top: "60" } };
		expect(atBreakpoint(m, "_padding", "desktop", mobileFirst)).toEqual({ top: "60" });
		expect(atBreakpoint(m, "_padding", "mobile_portrait", mobileFirst)).toEqual({ top: "20" });
	});
	it("reads a template's elements from the meta key of its type and picks the site-wide header and footer", () => {
		const h = [{ id: "a", name: "section", parent: 0 }];
		expect(templateElements({ _bricks_template_type: "header", _bricks_page_header_2: h }, bricksElements)).toEqual(h);
		expect(templateElements({ _bricks_template_type: "footer", _bricks_page_footer_2: h }, bricksElements)).toEqual(h);
		expect(templateElements({ _bricks_template_type: "section", _bricks_page_content_2: h }, bricksElements)).toEqual(h);
		const t = (id: number, type: string, conditions: unknown[], status = "publish") => ({ id, slug: `t${id}`, title: `T${id}`, status, meta: { _bricks_template_type: type, _bricks_template_settings: { templateConditions: conditions } } });
		const r = siteTemplates([t(1, "header", [{ main: "ids", ids: [5] }]), t(2, "header", [{ main: "any" }]), t(3, "footer", [{ main: "frontpage" }]), t(4, "footer", [{ main: "any" }], "draft"), t(5, "section", [])]);
		expect(r.header?.id).toBe(2);
		expect(r.footer?.id).toBe(3);
		expect(r.others.map((o) => [o.post.id, o.conditions])).toEqual([
			[1, "ids:5"],
			[4, "any"],
		]);
	});
});

describe("Bricks forms and extract helpers", () => {
	it("a form with the defaults sends email with Bricks' default texts; recipients are never copied", () => {
		const d = bricksFormToDefinition("9-abc", { fields: [{ id: "x", type: "email", label: "Email", required: true }], emailTo: "custom", emailToCustom: "someone@example.invalid", emailBcc: "x@example.invalid" }, "Signup");
		expect(d).toMatchObject({ id: "bricks-9-abc", submitLabel: "Send", fields: [{ name: "email", type: "email", required: true }] });
		expect(d.successMessage).toMatch(/^Message successfully sent/);
		expect(JSON.stringify(d)).not.toContain("example.invalid");
	});
	it("finds attachment ids and upload URLs in element settings", () => {
		const refs = bricksMediaRefs([
			{ name: "image", settings: { image: { id: 5, url: "https://x.test/wp-content/uploads/a.jpg" } } },
			{ name: "section", settings: { _background: { image: { id: 6, url: "https://x.test/wp-content/uploads/b.jpg" } } } },
			{ name: "image-gallery", settings: { items: { images: [{ id: 7, url: "https://x.test/wp-content/uploads/c.jpg" }] } } },
			{ name: "counter", settings: { countTo: "12" } },
		]);
		expect(refs.filter((r) => r.kind === "id").map((r) => r.value)).toEqual(["5", "6", "7"]);
		expect(refs[0]?.via).toBe("content:bricks image");
	});
	it("reports missing Bricks options with the read-only command that exports them", () => {
		expect(bricksOptionsNote({})).toMatch(/bricks_color_palette.*wp eval/);
		expect(bricksOptionsNote({ bricks_color_palette: [], bricks_global_variables: [], bricks_global_classes: [], bricks_theme_styles: {}, bricks_components: [], bricks_breakpoints: [] })).toBeUndefined();
		expect(readBricksOptions(join(tmpdir(), "no-such-dir-bricks"), { bricks_global_classes: [], blogname: "x" })).toEqual({ bricks_global_classes: [] });
	});
});

describe("Bricks in the transform phase", () => {
	const dir = mkdtempSync(join(tmpdir(), "wp2emdash-bricks-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const paths = sitePaths("bricks-fixture", dir);
	const write = (file: string, data: unknown) => {
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, JSON.stringify(data));
	};
	const post = (id: number, post_type: string, slug: string, title: string, meta: Record<string, unknown>) => ({ id, post_type, status: "publish", slug, title, content: "", excerpt: "", date_gmt: "", modified_gmt: "2026-11-01T00:00:00", parent: null, menu_order: 0, taxonomies: {}, meta });
	write(join(paths.raw, "extract.json"), {});
	write(join(paths.raw, "exporter", "options.json"), { blogname: "Fixture Studio", page_on_front: 2 });
	write(join(paths.raw, "bricks-options.json"), { bricks_color_palette: [{ id: "p", colors: [{ id: "ink", hex: "#14181c" }] }] });
	write(join(paths.raw, "exporter", "content", "page.json"), [
		post(2, "page", "home", "Home", {
			_bricks_editor_mode: "bricks",
			_bricks_page_content_2: [
				{ id: "s1", name: "section", parent: 0, children: ["c1"], settings: { _background: { color: { id: "ink" } } } },
				{ id: "c1", name: "container", parent: "s1", children: ["h1", "f1", "b1"], settings: {} },
				{ id: "h1", name: "heading", parent: "c1", settings: { text: "Write to us", tag: "h2" } },
				{ id: "f1", name: "form", parent: "c1", settings: { fields: [{ id: "e", type: "email", label: "Email", required: true }], submitButtonText: "Go" } },
				{ id: "b1", name: "button", parent: "c1", settings: { text: "Newsletter", _interactions: [{ trigger: "click", action: "show", target: "popup", templateId: 40 }] } },
			],
		}),
	]);
	write(join(paths.raw, "exporter", "content", "bricks_template.json"), [
		post(30, "bricks_template", "site-header", "Header", { _bricks_template_type: "header", _bricks_template_settings: { templateConditions: [{ main: "any" }] }, _bricks_page_header_2: [{ id: "n", name: "nav-menu", parent: 0, settings: {} }] }),
		post(31, "bricks_template", "site-footer", "Footer", { _bricks_template_type: "footer", _bricks_template_settings: { templateConditions: [{ main: "any" }] }, _bricks_page_footer_2: [{ id: "fs", name: "section", parent: 0, children: ["ft"], settings: {} }, { id: "ft", name: "text-basic", parent: "fs", settings: { text: "© {current_date:Y} Fixture Studio" } }] }),
		post(32, "bricks_template", "blog-footer", "Blog footer", { _bricks_template_type: "footer", _bricks_template_settings: { templateConditions: [{ main: "postType", postType: ["post"] }] }, _bricks_page_footer_2: [] }),
		post(40, "bricks_template", "newsletter", "Newsletter", { _bricks_template_type: "popup", _bricks_page_content_2: [{ id: "ps", name: "section", parent: 0, children: ["pt"], settings: {} }, { id: "pt", name: "heading", parent: "ps", settings: { text: "Join the list" } }] }),
	]);
	const config = kitConfigSchema.parse({ slug: "bricks-fixture", name: "Fixture", source: { url: "https://fixture.example" }, target: { productionUrl: "https://fixture.example" } });
	const run = runTransform({ config, paths, reporter: { runId: "t", emit: () => {} } });
	const read = <T>(f: string) => JSON.parse(readFileSync(join(paths.ir, f), "utf8")) as T;

	it("adapts the page with the palette, writes its form definition and links the popup", async () => {
		await run;
		const home = read<IrPage>("pages/home.json");
		expect(home.source.builder).toBe("bricks");
		const form = home.sections.find((s) => s.type === "form");
		expect(form?.theme.background?.color).toBe("#14181c");
		expect(form?.type === "form" && form.fields.formRef).toEqual({ provider: "bricks", id: "2-f1" });
		expect(read<{ submitLabel: string }>("forms/bricks-2-f1.json").submitLabel).toBe("Go");
		expect(JSON.stringify(home.sections)).toContain('"href":"#bricks-newsletter"');
	});
	it("turns the site-wide header and footer templates into site parts and Bricks popups into popups", async () => {
		await run;
		const site = read<IrSite>("site.json");
		expect(site.partials).toEqual([
			{ role: "header", file: "partials/site-header.json" },
			{ role: "footer", file: "partials/site-footer.json" },
		]);
		expect(site.popups).toEqual([{ slug: "bricks-newsletter", file: "popups/bricks-newsletter.json" }]);
		expect(JSON.stringify(read<IrPage>("partials/site-footer.json").sections)).toContain("© {year} Fixture Studio");
		const coverage = JSON.parse(readFileSync(join(paths.reports, "transform", "coverage.json"), "utf8")) as { notTransformed: string[] };
		expect(coverage.notTransformed.some((n) => /blog-footer \(footer, publish\): applies to postType:post/.test(n))).toBe(true);
		expect(JSON.parse(readFileSync(join(paths.reports, "transform", "bricks-design.json"), "utf8")).palette).toEqual({ ink: "#14181c" });
	});
});

describe("Mariana Tek embeds", () => {
	const embed = (html: string) => ({ type: "embed", variant: "default", theme: { tone: "light" }, spacing: "normal", sourceRef: { adapter: "bricks", path: "section#s", rawHash: "x" }, fields: { provider: "marianatek", html } }) as unknown as Section;
	it("reads the tenant from a script src or the loader snippet", () => {
		expect(marianaTenant('<script src="https://fixturestudio.marianaiframes.com/js"></script>')).toBe("fixturestudio");
		expect(marianaTenant("<script>var TENANT_NAME = 'fixturestudio'; s.src = 'https://' + TENANT_NAME + '.marianaiframes.com/' + x;</script>")).toBe("fixturestudio");
		expect(marianaTenant('<div data-mariana-integrations="/buy"></div>')).toBeUndefined();
	});
	it("adds the tenant's loader scripts to mount-point markup, once; reports a missing tenant", () => {
		const s = embed('<div data-mariana-integrations="/buy"></div>');
		expect(completeMarianaEmbeds([s], "fixturestudio")).toEqual([]);
		const html = s.type === "embed" ? s.fields.html : "";
		expect(html).toContain('<script src="https://fixturestudio.marianaiframes.com/polyfills"></script>');
		expect(withMarianaLoader(html, "other")).toBe(html);
		expect(completeMarianaEmbeds([embed('<div data-mariana-integrations="/buy"></div>')], undefined)[0]?.message).toMatch(/embeds\.marianatekTenant/);
	});
});
