import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { activeKit, adaptElementor, elementorDesign, elementorElements, elementorEntranceAnimations, elementorFormToDefinition, elementorKit, isElementor, popupAutoOpen, siteTemplates, templateConditions } from "../src/adapters/elementor/index.js";
import { dynamicTag, iconOf, mediaOf, popupActionId } from "../src/adapters/elementor/elements.js";
import { atDevice, colourOf, globalId, sizePx } from "../src/adapters/elementor/site.js";
import { kitConfigSchema } from "../src/config/schema.js";
import { sitePaths } from "../src/core/paths.js";
import { elementorMediaRefs, elementorNote, readElementorOptions, usesElementor } from "../src/extract/elementor.js";
import { Keys } from "../src/ir/portable-text.js";
import type { IrPage, IrSite } from "../src/ir/schema.js";
import { detectBuilder, runTransform } from "../src/phases/transform.js";

const tree = [{ id: "s1", elType: "container", settings: { flex_direction: "column" }, elements: [{ id: "h1", elType: "widget", widgetType: "heading", settings: { title: "Hello", header_size: "h2" }, elements: [] }] }];
const opts = { kind: "page" as const, keys: new Keys("t"), popupFor: () => undefined, postCount: 0 };

describe("Elementor element tree", () => {
	it("reads _elementor_data as stored (JSON text), slashed JSON text, or a decoded array", () => {
		const json = JSON.stringify(tree);
		expect(elementorElements(json)?.[0]?.elements?.[0]?.widgetType).toBe("heading");
		expect(elementorElements(json.replace(/"/g, '\\"'))?.[0]?.id).toBe("s1");
		expect(elementorElements(tree)?.[0]?.elType).toBe("container");
		expect(elementorElements("not json")).toBeUndefined();
		expect(elementorElements("{}")).toBeUndefined();
	});
	it("detects Elementor pages by edit mode builder and a tree", () => {
		expect(isElementor({ _elementor_edit_mode: "builder", _elementor_data: JSON.stringify(tree) })).toBe(true);
		expect(isElementor({ _elementor_edit_mode: "", _elementor_data: JSON.stringify(tree) })).toBe(false);
		expect(isElementor({ _elementor_edit_mode: "builder", _elementor_data: "[]" })).toBe(true);
		expect(detectBuilder("<p>fallback copy</p>", { _elementor_edit_mode: "builder", _elementor_data: JSON.stringify(tree) })).toBe("elementor");
		expect(detectBuilder("<p>classic</p>", { _elementor_edit_mode: "" })).toBe("classic");
	});
	it("adapts a minimal container page", () => {
		const r = adaptElementor(elementorElements(tree) ?? [], opts);
		expect(r.sections[0]?.type).toBe("rich_text");
		expect(r.sections[0]?.sourceRef.adapter).toBe("elementor");
		expect(r.diagnostics).toEqual([]);
	});
});

describe("Elementor responsive values and Kit globals", () => {
	it("inherits a device value from the larger device and reads sliders/dimensions as px", () => {
		const s = { padding: { unit: "px", top: "80", bottom: "60" }, padding_mobile: { unit: "px", top: "", bottom: "" }, align: "left", align_mobile: "center" };
		expect(sizePx(atDevice(s, "padding", "tablet"), "top")).toBe(80);
		expect(sizePx(atDevice(s, "padding", "mobile"), "top")).toBe(80);
		expect(atDevice(s, "align", "mobile")).toBe("center");
		expect(atDevice(s, "align", "tablet")).toBe("left");
		expect(sizePx({ unit: "em", size: 2 })).toBe(32);
		expect(sizePx({ unit: "%", size: 50 })).toBeUndefined();
	});
	it("resolves global colour references through the Kit", () => {
		const kit = elementorKit({ system_colors: [{ _id: "primary", title: "Primary", color: "#123456" }], custom_colors: [{ _id: "8e2c1a4", title: "Sand", color: "#EEDDCC" }], viewport_mobile: 600 });
		expect(globalId("globals/colors?id=primary", "colors")).toBe("primary");
		expect(globalId("globals/typography?id=primary", "colors")).toBeUndefined();
		expect(colourOf({ __globals__: { background_color: "globals/colors?id=8e2c1a4" }, background_color: "#000" }, "background_color", kit)).toBe("#EEDDCC");
		expect(colourOf({ background_color: "#000" }, "background_color", kit)).toBe("#000");
		expect(kit.mobile).toBe(600);
		expect(kit.tablet).toBe(1024);
	});
	it("writes the Kit's colours, fonts and headings as design values", () => {
		const kit = elementorKit({
			system_colors: [{ _id: "primary", title: "Primary", color: "#2F4F4F" }],
			system_typography: [{ _id: "primary", title: "Primary", typography_typography: "custom", typography_font_family: "Lora", typography_font_weight: "600", typography_font_size: { unit: "px", size: 40 } }],
			body_typography_typography: "custom",
			body_typography_font_family: "Inter",
			body_typography_line_height: { unit: "em", size: 1.6 },
			__globals__: { body_color: "globals/colors?id=primary" },
			h1_typography_font_size: { unit: "px", size: 56 },
			container_width: { unit: "px", size: 1200 },
		});
		const d = elementorDesign(kit);
		expect(d.colors.primary).toEqual({ title: "Primary", color: "#2F4F4F" });
		expect(d.typography.primary).toEqual({ title: "Primary", "font-family": "Lora", "font-weight": "600", "font-size": "40px" });
		expect(d.body).toEqual({ "font-family": "Inter", "line-height": "1.6", color: "#2F4F4F" });
		expect(d.headings.h1).toEqual({ "font-size": "56px" });
		expect(d.containerWidth).toBe(1200);
	});
	it("counts entrance animations on sections, containers and widgets", () => {
		expect(elementorEntranceAnimations([[{ id: "a", elType: "container", settings: { animation: "fadeIn" }, elements: [{ id: "b", elType: "widget", widgetType: "heading", settings: { _animation: "zoomIn" }, elements: [] }, { id: "c", elType: "widget", widgetType: "heading", settings: { _animation: "none" }, elements: [] }] }], undefined])).toBe(2);
	});
});

describe("Elementor widget value readers", () => {
	it("parses dynamic tags and popup action links", () => {
		expect(dynamicTag('[elementor-tag id="1" name="popup" settings="%7B%22popup%22%3A%2212%22%7D"]')).toEqual({ name: "popup", settings: { popup: "12" } });
		expect(dynamicTag("plain")).toBeUndefined();
		const b64 = Buffer.from(JSON.stringify({ id: "77", toggle: false })).toString("base64");
		expect(popupActionId(`#elementor-action:action=popup:open&settings=${b64}`)).toBe(77);
		expect(popupActionId(encodeURIComponent(`#elementor-action:action=popup:open&settings=${b64}`))).toBe(77);
		expect(popupActionId("/contact/")).toBeUndefined();
	});
	it("reads media (placeholder = none) and icons", () => {
		expect(mediaOf({ url: "https://x.example/wp-content/plugins/elementor/assets/images/placeholder.png", id: "" })).toBeUndefined();
		expect(mediaOf({ url: "https://x.example/a.jpg", id: 5, alt: "A" })).toEqual({ wpId: 5, kind: "image", url: "https://x.example/a.jpg", alt: "A" });
		expect(iconOf({ value: "fab fa-instagram", library: "fa-brands" })).toEqual({ library: "fontawesome", name: "instagram" });
		expect(iconOf({ value: { url: "https://x.example/i.svg", id: 3 }, library: "svg" })).toEqual({ library: "svg", name: "https://x.example/i.svg" });
	});
});

describe("Elementor Theme Builder templates", () => {
	const t = (id: number, type: string, conditions: unknown, status = "publish") => ({ id, slug: `t${id}`, title: `T${id}`, status, meta: { _elementor_template_type: type, _elementor_conditions: conditions } });
	it("picks the site-wide header and footer and reports the others", () => {
		const r = siteTemplates([t(1, "header", ["include/singular/front_page"]), t(2, "header", ["include/general"]), t(3, "footer", ["include/general", "exclude/singular/page/9"]), t(4, "footer", ["include/archive/post_archive"]), t(5, "single-post", ["include/singular/post"]), t(6, "header", ["include/general"], "draft")]);
		expect(r.header?.id).toBe(2);
		expect(r.footer?.id).toBe(3);
		expect(r.others.map((o) => `${o.post.id}:${o.conditions}`)).toEqual(["1:singular/front_page", "4:archive/post_archive", "5:singular/post", "6:general"]);
		expect(templateConditions({ _elementor_conditions: '["include/general"]' })).toEqual([{ exclude: false, path: ["general"] }]);
	});
	it("finds the active kit and popup page-load triggers", () => {
		const kits = [t(10, "kit", []), t(11, "kit", [])];
		expect(activeKit(kits, 11)?.id).toBe(11);
		expect(activeKit(kits)?.id).toBe(10);
		expect(popupAutoOpen({ _elementor_popup_display_settings: { triggers: { page_load: "yes", page_load_delay: 3 }, timing: {} } })).toEqual({ delayMs: 3000 });
		expect(popupAutoOpen({ _elementor_popup_display_settings: { triggers: { click: "yes" } } })).toBeUndefined();
	});
});

describe("Elementor forms and extract helpers", () => {
	it("builds a form definition without copying recipients", () => {
		const def = elementorFormToDefinition("2-f", { form_fields: [{ custom_id: "email", field_type: "email", field_label: "Email", required: "true" }, { field_type: "honeypot" }], email_to: "x@example.com", button_text: "Go" }, "Form");
		expect(def.id).toBe("elementor-2-f");
		expect(def.fields).toEqual([{ name: "email", label: "Email", type: "email", required: true, autocomplete: "email" }]);
		expect(JSON.stringify(def)).not.toContain("x@example.com");
		expect(def.successMessage).toBe("Your submission was successful.");
	});
	it("finds media in the tree, notices Elementor content and a missing library", () => {
		const data = JSON.stringify([{ id: "a", elType: "container", settings: { background_image: { url: "https://f.example/wp-content/uploads/a.jpg", id: 9 } }, elements: [{ id: "b", elType: "widget", widgetType: "image-gallery", settings: { wp_gallery: [{ id: 10, url: "https://f.example/wp-content/uploads/b.jpg" }] }, elements: [] }] }]);
		expect(elementorMediaRefs(data).filter((r) => r.kind === "id").map((r) => r.value)).toEqual(["9", "10"]);
		const posts = [{ post_type: "page", meta: { _elementor_edit_mode: "builder" } }];
		expect(usesElementor(posts)).toBe(true);
		expect(usesElementor([{ post_type: "page", meta: {} }])).toBe(false);
		expect(elementorNote(posts, {})).toMatch(/no elementor_library posts/);
		expect(elementorNote([...posts, { post_type: "elementor_library", meta: { _elementor_template_type: "kit" } }], {})).toBeUndefined();
		expect(readElementorOptions(join(tmpdir(), "no-such-dir-elementor"), { elementor_active_kit: 5, blogname: "x" })).toEqual({ elementor_active_kit: 5 });
	});
});

describe("Elementor in the transform phase", () => {
	const dir = mkdtempSync(join(tmpdir(), "wp2emdash-elementor-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const paths = sitePaths("elementor-fixture", dir);
	const write = (file: string, data: unknown) => {
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, JSON.stringify(data));
	};
	const post = (id: number, post_type: string, slug: string, title: string, meta: Record<string, unknown>, status = "publish") => ({ id, post_type, status, slug, title, content: "", excerpt: "", date_gmt: "", modified_gmt: "2026-11-01T00:00:00", parent: null, menu_order: 0, taxonomies: {}, meta });
	const data = (els: unknown[]) => JSON.stringify(els);
	const popupLink = `#elementor-action%3Aaction%3Dpopup%3Aopen%26settings%3D${Buffer.from(JSON.stringify({ id: "40", toggle: false })).toString("base64")}`;
	write(join(paths.raw, "extract.json"), {});
	write(join(paths.raw, "exporter", "options.json"), { blogname: "Fixture Studio", page_on_front: 2 });
	write(join(paths.raw, "exporter", "menus.json"), [{ id: 7, name: "Main Menu", locations: [], items: [{ id: 1, parent_id: null, sort_order: 1, type: "custom", object: "custom", object_id: 0, url: "https://fixture.example/classes/", title: "Classes", target: "", classes: null }] }]);
	write(join(paths.raw, "exporter", "content", "page.json"), [
		post(2, "page", "home", "Home", {
			_elementor_edit_mode: "builder",
			_wp_page_template: "elementor_header_footer",
			_elementor_data: data([
				{
					id: "s1", elType: "container", settings: { background_background: "classic", __globals__: { background_color: "globals/colors?id=primary" }, animation: "fadeIn" },
					elements: [
						{ id: "h1", elType: "widget", widgetType: "heading", settings: { title: "Write to us", header_size: "h2", _animation: "fadeInUp" }, elements: [] },
						{ id: "f1", elType: "widget", widgetType: "form", settings: { form_fields: [{ custom_id: "email", field_type: "email", field_label: "Email", required: "true" }], button_text: "Go" }, elements: [] },
						{ id: "b1", elType: "widget", widgetType: "button", settings: { text: "Newsletter", link: { url: popupLink }, _animation: "fadeIn" }, elements: [] },
					],
				},
			]),
		}),
	]);
	write(join(paths.raw, "exporter", "content", "elementor_library.json"), [
		post(20, "elementor_library", "default-kit", "Default Kit", { _elementor_template_type: "kit", _elementor_page_settings: { system_colors: [{ _id: "primary", title: "Primary", color: "#14181C" }] } }),
		post(30, "elementor_library", "site-header", "Header", { _elementor_edit_mode: "builder", _elementor_template_type: "header", _elementor_conditions: ["include/general"], _elementor_data: data([{ id: "hc", elType: "container", settings: {}, elements: [{ id: "nm", elType: "widget", widgetType: "nav-menu", settings: { menu: "main-menu" }, elements: [] }, { id: "hb", elType: "widget", widgetType: "button", settings: { text: "Book", link: { url: "/book/" } }, elements: [] }] }]) }),
		post(31, "elementor_library", "site-footer", "Footer", { _elementor_edit_mode: "builder", _elementor_template_type: "footer", _elementor_conditions: ["include/general"], _elementor_data: data([{ id: "fc", elType: "container", settings: {}, elements: [{ id: "ft", elType: "widget", widgetType: "heading", settings: { title: "Fixture Studio footer", header_size: "p" }, elements: [] }] }]) }),
		post(32, "elementor_library", "blog-footer", "Blog footer", { _elementor_edit_mode: "builder", _elementor_template_type: "footer", _elementor_conditions: ["include/archive/post_archive"], _elementor_data: "[]" }),
		post(40, "elementor_library", "newsletter", "Newsletter", { _elementor_edit_mode: "builder", _elementor_template_type: "popup", _elementor_popup_display_settings: { triggers: { page_load: "yes", page_load_delay: 2 } }, _elementor_data: data([{ id: "pc", elType: "container", settings: {}, elements: [{ id: "pt", elType: "widget", widgetType: "heading", settings: { title: "Join the list" }, elements: [] }] }]) }),
	]);
	const config = kitConfigSchema.parse({ slug: "elementor-fixture", name: "Fixture", source: { url: "https://fixture.example" }, target: { productionUrl: "https://fixture.example" } });
	const run = runTransform({ config, paths, reporter: { runId: "t", emit: () => {} } });
	const read = <T>(f: string) => JSON.parse(readFileSync(join(paths.ir, f), "utf8")) as T;

	it("adapts the page with the Kit colour, writes its form definition and links the popup", async () => {
		await run;
		const home = read<IrPage>("pages/home.json");
		expect(home.source.builder).toBe("elementor");
		const form = home.sections.find((s) => s.type === "form");
		expect(form?.theme.background?.color).toBe("#14181C");
		expect(form?.type === "form" && form.fields.formRef).toEqual({ provider: "elementor", id: "2-f1" });
		expect(read<{ submitLabel: string }>("forms/elementor-2-f1.json").submitLabel).toBe("Go");
		expect(JSON.stringify(home.sections)).toContain('"href":"#elementor-newsletter"');
	});
	it("turns the site-wide header and footer into site parts, popups into popups, and the header menu into the primary menu", async () => {
		await run;
		const site = read<IrSite>("site.json");
		expect(site.partials).toEqual([
			{ role: "header", file: "partials/site-header.json" },
			{ role: "footer", file: "partials/site-footer.json" },
		]);
		expect(site.popups).toEqual([{ slug: "elementor-newsletter", file: "popups/elementor-newsletter.json" }]);
		expect(read<IrPage>("popups/elementor-newsletter.json").popup?.autoOpen).toEqual({ delayMs: 2000 });
		expect(site.menus.find((m) => m.role === "primary")?.name).toBe("Main Menu");
		expect(site.menus.find((m) => m.role === "secondary")?.items.map((i) => i.label)).toEqual(["Book"]);
		const coverage = JSON.parse(readFileSync(join(paths.reports, "transform", "coverage.json"), "utf8")) as { notTransformed: string[] };
		expect(coverage.notTransformed.some((n) => /blog-footer \(footer, publish\): applies to archive\/post_archive/.test(n))).toBe(true);
		expect(coverage.notTransformed.some((n) => /Canvas \/ Full Width\) on: home/.test(n))).toBe(true);
		const design = JSON.parse(readFileSync(join(paths.reports, "transform", "elementor-design.json"), "utf8"));
		expect(design.colors.primary.color).toBe("#14181C");
		expect(design.kitPost).toBe(20);
		expect(design.entranceAnimations).toBe(3);
	});
});
