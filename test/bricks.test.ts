import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { adaptBricks, type BricksElement, bricksElements, bricksFormToDefinition, bricksSite, gridTracks, isBricks, siteTemplates, templateElements } from "../src/adapters/bricks/index.js";
import { atBreakpoint, effectiveSettings, resolveColour, resolveLength } from "../src/adapters/bricks/site.js";
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
