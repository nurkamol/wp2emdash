import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { adaptDivi, diviDesign, diviSite, isDivi, isDivi5, themeBuilderParts } from "../src/adapters/divi/index.js";
import { iconOf } from "../src/adapters/divi/elements.js";
import { diviOptions } from "../src/adapters/divi/forms.js";
import { colourOf, columnWidth, decodeAttrJson, decodeCode, disabledOn, dynamicContent, paddingOf } from "../src/adapters/divi/site.js";
import { kitConfigSchema } from "../src/config/schema.js";
import { sitePaths } from "../src/core/paths.js";
import { diviNote, readDiviOptions, usesDivi } from "../src/extract/divi.js";
import { Keys } from "../src/ir/portable-text.js";
import type { IrPage, IrSite } from "../src/ir/schema.js";
import { detectBuilder, runTransform } from "../src/phases/transform.js";

const opts = { kind: "page" as const, keys: new Keys("t"), popupFor: () => undefined, postCount: 0 };
const dc = (j: unknown) => `@ET-DC@${Buffer.from(JSON.stringify(j)).toString("base64")}@`;

describe("Divi detection and value readers", () => {
	it("detects Divi 4 shortcodes and Divi 5 blocks, before WPBakery and Gutenberg", () => {
		expect(isDivi('[et_pb_section fb_built="1"][/et_pb_section]')).toBe(true);
		expect(isDivi("<!-- wp:divi/section -->\n<!-- /wp:divi/section -->")).toBe(true);
		expect(isDivi("[et_pb_text]hi[/et_pb_text]", { _et_pb_use_builder: "on" })).toBe(true);
		expect(isDivi("[et_pb_text]hi[/et_pb_text]")).toBe(false);
		expect(isDivi5("<!-- wp:divi/section -->")).toBe(true);
		expect(detectBuilder('[et_pb_section][et_pb_row][et_pb_column type="4_4"][et_pb_text]Hi[/et_pb_text][/et_pb_column][/et_pb_row][/et_pb_section]')).toBe("divi");
		expect(detectBuilder("<!-- wp:divi/placeholder --><!-- /wp:divi/placeholder -->")).toBe("divi");
		expect(detectBuilder("<!-- wp:paragraph --><p>x</p><!-- /wp:paragraph -->")).toBe("gutenberg");
	});
	it("decodes attribute JSON, code module placeholders, dynamic content and column types", () => {
		expect(decodeAttrJson("%91{%22value%22:%22A%22}%93")).toBe('[{"value":"A"}]');
		expect(diviOptions("%91{%22value%22:%22Yes%22,%22checked%22:0},{%22value%22:%22No%22}%93")).toEqual(["Yes", "No"]);
		expect(decodeCode("<div>a</div><!-- [et_pb_line_break_holder] --><p>&#91;b&#93;</p>")).toBe("<div>a</div>\n<p>[b]</p>");
		expect(dynamicContent(dc({ dynamic: true, content: "post_title", settings: { before: "" } }))?.content).toBe("post_title");
		expect(dynamicContent("plain")).toBeUndefined();
		expect(columnWidth("1_2")).toBe("1/2");
		expect(columnWidth("2_3")).toBe("2/3");
		expect(columnWidth("4_4")).toBeUndefined();
		expect(columnWidth("1_5")).toBe("20/100");
		expect(paddingOf("80px|0px|60px|0px|false|false")).toEqual({ top: "80px", bottom: "60px" });
		expect(paddingOf("||40px||")).toEqual({ bottom: "40px" });
		expect(disabledOn({ disabled_on: "on|off|off" }, "phone")).toBe(true);
		expect(disabledOn({ disabled_on: "on|off|off" }, "desktop")).toBe(false);
		expect(iconOf("&#xe08a;||divi||400")).toEqual({ library: "divi", name: "e08a" });
		expect(iconOf("&#xf073;||fa||900")).toEqual({ library: "fontawesome", name: "f073" });
	});
	it("resolves global colours from et_global_data and reports the theme options as design values", () => {
		const site = diviSite({ et_divi: { accent_color: "#aa5533", body_font: "Lora", content_width: "1180" }, et_global_data: { global_colors: { "gcid-clay": { color: "#c06040", active: "yes" }, "gcid-old": { color: "#000", active: "no" } } } });
		expect(colourOf("gcid-clay", site)).toBe("#c06040");
		expect(colourOf("gcid-old", site)).toBeUndefined();
		expect(colourOf("var(--gcid-clay)", site)).toBe("#c06040");
		expect(colourOf("#fff", site)).toBe("#fff");
		expect(diviDesign(site)).toEqual({ colors: { "gcid-clay": "#c06040" }, theme: { accent_color: "#aa5533", body_font: "Lora", content_width: "1180" } });
		expect(diviSite({}).present).toBe(false);
	});
	it("adapts a minimal page and fills post title / current year dynamic content", () => {
		const r = adaptDivi(`[et_pb_section][et_pb_row][et_pb_column type="4_4"][et_pb_text]<h2>${dc({ dynamic: true, content: "post_title", settings: {} })}</h2><p>© ${dc({ dynamic: true, content: "current_date", settings: { date_format: "custom", custom_date_format: "Y" } })} Studio</p>[/et_pb_text][/et_pb_column][/et_pb_row][/et_pb_section]`, { ...opts, title: "About us" });
		expect(r.sections[0]?.type).toBe("rich_text");
		expect(r.sections[0]?.sourceRef.adapter).toBe("divi");
		expect(JSON.stringify(r.sections)).toContain('"text":"About us"');
		expect(JSON.stringify(r.sections)).toContain("© {year} Studio");
		expect(r.diagnostics).toEqual([]);
	});
	it("reports dynamic content it cannot fill and keeps the text around it", () => {
		const r = adaptDivi(`[et_pb_section][et_pb_row][et_pb_column type="4_4"][et_pb_text]<p>By ${dc({ dynamic: true, content: "post_author", settings: {} })} today</p>[/et_pb_text][/et_pb_column][/et_pb_row][/et_pb_section]`, opts);
		expect(JSON.stringify(r.sections)).toContain("By today");
		expect(r.diagnostics.map((d) => d.code)).toEqual(["dynamic"]);
	});
});

describe("Divi Theme Builder", () => {
	const t = (id: number, meta: Record<string, unknown>, status = "publish") => ({ id, slug: `t${id}`, title: `T${id}`, status, meta });
	it("picks the default website template's header and footer, and reports the rest", () => {
		const parts = themeBuilderParts([t(1, { _et_default: "1", _et_enabled: "1", _et_header_layout_id: "11", _et_header_layout_enabled: "1", _et_footer_layout_id: "12", _et_footer_layout_enabled: "1", _et_body_layout_id: "0" }), t(2, { _et_use_on: ["singular:post_type:post:all"], _et_header_layout_id: "21" })]);
		expect(parts.template?.id).toBe(1);
		expect(parts.header).toBe(11);
		expect(parts.footer).toBe(12);
		expect(parts.body).toBeUndefined();
		expect(parts.others.map((o) => o.conditions)).toEqual(["singular:post_type:post:all"]);
	});
	it("skips disabled layouts and falls back to the home page template", () => {
		const parts = themeBuilderParts([t(3, { _et_use_on: ["homepage"], _et_header_layout_id: "31", _et_header_layout_enabled: "0", _et_footer_layout_id: "32" })]);
		expect(parts.template?.id).toBe(3);
		expect(parts.header).toBeUndefined();
		expect(parts.footer).toBe(32);
		expect(themeBuilderParts([t(4, { _et_default: "1", _et_footer_layout_id: "41" }, "draft")]).footer).toBeUndefined();
	});
});

describe("Divi extract helpers", () => {
	it("notices Divi content and missing theme options", () => {
		expect(usesDivi([{ post_type: "page", content: "[et_pb_section][/et_pb_section]" }])).toBe(true);
		expect(usesDivi([{ post_type: "et_template" }])).toBe(true);
		expect(usesDivi([{ post_type: "page", content: "<p>x</p>" }])).toBe(false);
		expect(diviNote([{ post_type: "page" }], {})).toMatch(/divi-options\.json/);
		expect(diviNote([{ post_type: "et_template" }], { et_divi: {} })).toMatch(/no et_header_layout/);
		expect(diviNote([], { et_divi: {} })).toBeUndefined();
		const dir = mkdtempSync(join(tmpdir(), "wp2emdash-divi-opts-"));
		writeFileSync(join(dir, "divi-options.json"), JSON.stringify({ et_divi: { accent_color: "#123" }, other: 1 }));
		expect(readDiviOptions(dir, { et_global_data: { global_colors: {} } })).toEqual({ et_global_data: { global_colors: {} }, et_divi: { accent_color: "#123" } });
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("Divi in the transform phase", () => {
	const dir = mkdtempSync(join(tmpdir(), "wp2emdash-divi-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const paths = sitePaths("divi-fixture", dir);
	const write = (file: string, data: unknown) => {
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, JSON.stringify(data));
	};
	const post = (id: number, post_type: string, slug: string, title: string, content: string, meta: Record<string, unknown> = {}, status = "publish") => ({ id, post_type, status, slug, title, content, excerpt: "", date_gmt: "", modified_gmt: "2026-11-01T00:00:00", parent: null, menu_order: 0, taxonomies: {}, meta });
	write(join(paths.raw, "extract.json"), {});
	write(join(paths.raw, "exporter", "options.json"), { blogname: "Fixture Studio", page_on_front: 2, et_global_data: { global_colors: { "gcid-ink": { color: "#1d1b19", active: "yes" } } } });
	write(join(paths.raw, "divi-options.json"), { et_divi: { accent_color: "#aa5533", heading_font: "Fraunces" } });
	write(join(paths.raw, "exporter", "menus.json"), [{ id: 7, name: "Main Menu", locations: [], items: [{ id: 1, parent_id: null, sort_order: 1, type: "custom", object: "custom", object_id: 0, url: "https://fixture.example/classes/", title: "Classes", target: "", classes: null }] }]);
	write(join(paths.raw, "exporter", "content", "page.json"), [
		post(2, "page", "home", "Home", '[et_pb_section fb_built="1" background_color="gcid-ink"][et_pb_row][et_pb_column type="4_4"][et_pb_text background_layout="dark"]<h2>Write to us</h2>[/et_pb_text][et_pb_contact_form title="Contact" email="owner@fixture.example"][et_pb_contact_field field_id="Email" field_title="Email" field_type="email"][/et_pb_contact_field][et_pb_contact_field field_id="Message" field_title="Message" field_type="text" fullwidth_field="on"][/et_pb_contact_field][/et_pb_contact_form][/et_pb_column][/et_pb_row][/et_pb_section]', { _et_pb_use_builder: "on" }),
	]);
	write(join(paths.raw, "exporter", "content", "et_template.json"), [
		post(30, "et_template", "", "Default Website Template", "", { _et_default: "1", _et_enabled: "1", _et_header_layout_id: "31", _et_header_layout_enabled: "1", _et_footer_layout_id: "32", _et_footer_layout_enabled: "1", _et_body_layout_id: "33", _et_body_layout_enabled: "1" }),
		post(34, "et_template", "", "Blog posts", "", { _et_use_on: ["singular:post_type:post:all"], _et_footer_layout_id: "35" }),
	]);
	write(join(paths.raw, "exporter", "content", "et_header_layout.json"), [post(31, "et_header_layout", "site-header", "Theme Builder Layout", '[et_pb_section fb_built="1"][et_pb_row][et_pb_column type="4_4"][et_pb_menu menu_id="7"][/et_pb_menu][et_pb_button button_url="/book/" button_text="Book"][/et_pb_button][/et_pb_column][/et_pb_row][/et_pb_section]')]);
	write(join(paths.raw, "exporter", "content", "et_footer_layout.json"), [post(32, "et_footer_layout", "site-footer", "Theme Builder Layout", '[et_pb_section fb_built="1"][et_pb_row][et_pb_column type="4_4"][et_pb_text]<p>Fixture Studio footer</p>[/et_pb_text][/et_pb_column][/et_pb_row][/et_pb_section]')]);
	write(join(paths.raw, "exporter", "content", "et_body_layout.json"), [post(33, "et_body_layout", "body-wrapper", "Theme Builder Layout", '[et_pb_section][et_pb_row][et_pb_column type="4_4"][et_pb_post_content][/et_pb_post_content][/et_pb_column][/et_pb_row][/et_pb_section]')]);
	const config = kitConfigSchema.parse({ slug: "divi-fixture", name: "Fixture", source: { url: "https://fixture.example" }, target: { productionUrl: "https://fixture.example" } });
	const run = runTransform({ config, paths, reporter: { runId: "t", emit: () => {} } });
	const read = <T>(f: string) => JSON.parse(readFileSync(join(paths.ir, f), "utf8")) as T;

	it("adapts the page with the global colour and writes its contact form definition without the recipient", async () => {
		await run;
		const home = read<IrPage>("pages/home.json");
		expect(home.source.builder).toBe("divi");
		const form = home.sections.find((s) => s.type === "form");
		expect(form?.theme.background?.color).toBe("#1d1b19");
		expect(form?.theme.tone).toBe("dark");
		expect(form?.type === "form" && form.fields.formRef).toEqual({ provider: "divi", id: "2-1" });
		const def = read<{ fields: { name: string; type: string }[]; warnings: string[] }>("forms/divi-2-1.json");
		expect(def.fields.map((f) => `${f.name}:${f.type}`)).toEqual(["email:email", "message:textarea"]);
		expect(JSON.stringify(def)).not.toContain("owner@fixture.example");
		expect(def.warnings.some((w) => /recipient/.test(w))).toBe(true);
	});
	it("turns the Theme Builder header and footer into site parts and the header menu into the primary menu", async () => {
		await run;
		const site = read<IrSite>("site.json");
		expect(site.partials).toEqual([
			{ role: "header", file: "partials/site-header.json" },
			{ role: "footer", file: "partials/site-footer.json" },
		]);
		expect(read<IrPage>("partials/site-footer.json").source.builder).toBe("divi");
		expect(site.menus.find((m) => m.role === "primary")?.name).toBe("Main Menu");
		expect(site.menus.find((m) => m.role === "secondary")?.items.map((i) => i.label)).toEqual(["Book"]);
		const coverage = JSON.parse(readFileSync(join(paths.reports, "transform", "coverage.json"), "utf8")) as { notTransformed: string[] };
		expect(coverage.notTransformed.some((n) => /body layout #33 \(body-wrapper\)/.test(n))).toBe(true);
		expect(coverage.notTransformed.some((n) => /et_template 34 \(publish\): applies to singular:post_type:post:all/.test(n))).toBe(true);
		const design = JSON.parse(readFileSync(join(paths.reports, "transform", "divi-design.json"), "utf8"));
		expect(design.colors["gcid-ink"]).toBe("#1d1b19");
		expect(design.theme.heading_font).toBe("Fraunces");
		expect(design.themeBuilder).toEqual({ template: 30, header: 31, footer: 32, body: 33 });
	});
});
