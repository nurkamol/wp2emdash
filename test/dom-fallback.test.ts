/**
 * DOM fallback: when a page goes to it (and when it never does), and what transform does with it (gate, report, forms).
 * The rendered-HTML → sections mapping itself is covered by the goldens (test/fixtures/dom-fallback).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { adaptDomFallback, bodyClassesOf, fallbackReason, liveContentWords, unknownShortcodeLayout } from "../src/adapters/dom-fallback/index.js";
import { kitConfigSchema } from "../src/config/schema.js";
import { sitePaths } from "../src/core/paths.js";
import { Keys } from "../src/ir/portable-text.js";
import type { IrPage } from "../src/ir/schema.js";
import { runTransform } from "../src/phases/transform.js";

const page = (body: string, bodyClass = "page") => `<!DOCTYPE html><html><head><title>x</title></head><body class="${bodyClass}"><header id="masthead"><a href="/">Site</a></header><main id="main">${body}</main><footer id="colophon">Footer text</footer></body></html>`;

describe("DOM fallback detection", () => {
	it("never takes pages an adapter handles", () => {
		for (const b of ["wpbakery", "gutenberg", "bricks", "elementor", "divi"]) expect(fallbackReason(b, "[fusion_builder_container]", { _fl_builder_enabled: "1" })).toBeUndefined();
	});
	it("reads builder post meta", () => {
		expect(fallbackReason("classic", "<p>copy</p>", { _fl_builder_enabled: "1" })?.builder).toBe("beaver-builder");
		expect(fallbackReason("empty", "", { ct_builder_shortcodes: "[ct_section]" })?.builder).toBe("oxygen");
		expect(fallbackReason("empty", "", { _breakdance_data: "{}" })?.builder).toBe("breakdance");
		expect(fallbackReason("classic", "<p>x</p>", { panels_data: { widgets: [1] } })?.builder).toBe("siteorigin");
		expect(fallbackReason("classic", "<p>x</p>", { tcb_editor_enabled: "1" })?.builder).toBe("thrive-architect");
		// Disabled flags are not evidence.
		expect(fallbackReason("classic", "<p>Plain words.</p>", { _fl_builder_enabled: "0", fusion_builder_status: "off" })).toBeUndefined();
	});
	it("recognises shortcode families and builder markup in post_content", () => {
		expect(fallbackReason("classic", '[fusion_builder_container][fusion_text]Hi[/fusion_text][/fusion_builder_container]', {})?.builder).toBe("avada");
		expect(fallbackReason("classic", "[av_section][av_textblock]Hi[/av_textblock][/av_section]", {})?.builder).toBe("enfold");
		expect(fallbackReason("classic", '[section bg="1"][row][col span="6"][ux_image id="4"][/col][/row][/section]', {})?.builder).toBe("flatsome");
		expect(fallbackReason("classic", '<div class="fl-builder-content"><div class="fl-row">x</div></div>', {})?.builder).toBe("beaver-builder");
		expect(fallbackReason("classic", '<div class="panel-grid">x</div>', {})?.builder).toBe("siteorigin");
	});
	it("treats content that is mostly unknown shortcodes as an unknown builder", () => {
		const c = '[lt_wrap][lt_box style="a"]One two three[/lt_box][lt_box]Four five[/lt_box][/lt_wrap]';
		expect(unknownShortcodeLayout(c)).toEqual(["lt_wrap", "lt_box"]);
		expect(fallbackReason("classic", c, {})?.builder).toBe("unknown");
		// A known plugin shortcode inside prose is not a layout.
		expect(unknownShortcodeLayout("<p>Long prose paragraph with many words.</p>[contact-form-7 id=\"1\"][gallery ids=\"1,2\"]")).toBeUndefined();
		expect(unknownShortcodeLayout('<p>Lots of real prose here, more words than the shortcodes hold.</p>[a1]x[/a1][a2]y[/a2][a3]z[/a3]')).toBeUndefined();
	});
	it("uses the live page for empty post_content: page-only markers, site renderers, or enough words", () => {
		const beaver = page("<p>Hello there</p>", "page fl-builder");
		expect(bodyClassesOf(beaver)).toEqual(["page", "fl-builder"]);
		expect(fallbackReason("classic", "<p>stale copy</p>", {}, { html: beaver, words: 2 })?.builder).toBe("beaver-builder");
		// A site-wide renderer (every page of an Oxygen site) explains an empty post_content only.
		const oxy = page("<p>Hi</p>", "page oxygen-body");
		expect(fallbackReason("classic", "<p>Plain words.</p>", {}, { html: oxy, words: 1 })).toBeUndefined();
		expect(fallbackReason("empty", "", {}, { html: oxy, words: 1 })?.builder).toBe("oxygen");
		const text = page(`<section><h2>Opening hours</h2><p>${"word ".repeat(20)}</p></section>`);
		expect(liveContentWords(text)).toBe(22);
		expect(fallbackReason("empty", "", {}, { html: text, words: liveContentWords(text) })?.builder).toBe("unknown");
		expect(fallbackReason("empty", "", {}, { html: page("<p>Tiny</p>"), words: 1 })).toBeUndefined();
		// Classic content without any marker stays with the classic adapter.
		expect(fallbackReason("classic", "<p>Plain words.</p>", {}, { html: text, words: 22 })).toBeUndefined();
	});
});

describe("DOM fallback adapter", () => {
	const opts = { kind: "page" as const, keys: new Keys("t"), popupFor: () => undefined, postCount: 0, postId: 7 };
	it("keeps the main area only, warns on every page, and never ships a script", () => {
		const r = adaptDomFallback(page('<section style="background-color:#000"><h2 onclick="steal()">Hi</h2><p>Body <a href="javascript:alert(1)">x</a></p><script>bad()</script></section><div class="cookie-notice">Cookies</div>'), opts);
		const json = JSON.stringify(r);
		expect(json).not.toMatch(/Footer text|Cookies|steal|bad\(\)|javascript:/);
		expect(r.sections[0]?.theme).toEqual({ tone: "dark", background: { color: "#000" } });
		expect(r.sections[0]?.sourceRef.adapter).toBe("dom-fallback");
		expect(r.diagnostics[0]).toMatchObject({ level: "warn", code: "flagged", tag: "dom-fallback" });
	});
	it("reports an empty main area instead of returning nothing silently", () => {
		const r = adaptDomFallback(page(""), opts);
		expect(r.sections).toEqual([]);
		expect(r.diagnostics.some((d) => d.code === "unmapped" && d.carriesContent)).toBe(true);
	});
	it("splits loose text at the top headings, keeping consecutive headings together", () => {
		const r = adaptDomFallback(page('<div class="entry-content"><p>Intro words here.</p><h2>One</h2><h3>Sub</h3><p>Text one.</p><h2>Two</h2><p>Text two.</p></div>'), opts);
		expect(r.sections.map((s) => s.sourceRef.path)).toEqual(["dom[0]", "dom[1]", "dom[2]"]);
	});
});

describe("DOM fallback in the transform phase", () => {
	const dir = mkdtempSync(join(tmpdir(), "wp2emdash-dom-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const paths = sitePaths("dom-fixture", dir);
	const put = (file: string, data: unknown) => {
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
	};
	const post = (id: number, slug: string, title: string, content: string, meta: Record<string, unknown> = {}) => ({ id, post_type: "page", status: "publish", slug, title, content, excerpt: "", date_gmt: "", modified_gmt: "2026-11-01T00:00:00", parent: null, menu_order: 0, taxonomies: {}, meta });
	put(join(paths.raw, "extract.json"), {});
	put(join(paths.raw, "exporter", "options.json"), { blogname: "Fixture Studio", page_on_front: 2, page_for_posts: 6 });
	put(join(paths.raw, "exporter", "content", "page.json"), [
		post(2, "home", "Home", '<div class="fl-builder-content">stale copy</div>', { _fl_builder_enabled: "1" }),
		post(3, "classes", "Classes", "", { ct_builder_shortcodes: "[ct_section]" }),
		post(4, "about", "About", "<!-- wp:paragraph --><p>About us in blocks.</p><!-- /wp:paragraph -->", { _fl_builder_enabled: "1" }),
		post(5, "plain", "Plain", "<p>Just words written in the classic editor.</p>"),
		post(6, "news", "News", ""),
	]);
	const snap = (id: number, name: string, url: string, html: string) => {
		put(join(paths.snapshot, "pages", `${name}.json`), { wpId: id, url });
		put(join(paths.snapshot, "html", `${name}.html`), html);
	};
	snap(2, "home", "https://fixture.example/", page('<div class="fl-builder-content fl-builder-content-2"><div class="fl-row"><div class="fl-col-group"><div class="fl-col" style="width:50%"><h1>Strength classes</h1><p>Small groups, real coaching.</p><a class="fl-button" href="https://fixture.example/classes/">See classes</a></div><div class="fl-col" style="width:50%"><img src="https://fixture.example/wp-content/uploads/gym.jpg" alt="Gym"></div></div></div><div class="fl-row"><form class="fl-contact-form"><input type="text" name="fl-name" placeholder="Your name"><input type="email" name="fl-email" placeholder="Email"><button type="submit">Send</button></form></div></div>', "page fl-builder"));
	put(join(paths.snapshot, "urls.json"), [{ path: "/", wp: { id: 2 } }, { path: "/classes/", wp: { id: 3 } }, { path: "/about/", wp: { id: 4 } }, { path: "/plain/", wp: { id: 5 } }, { path: "/news/", wp: { id: 6 } }]);
	snap(6, "news", "https://fixture.example/news/", page(`<article class="post"><h2>Post one</h2><p>${"news ".repeat(30)}</p></article>`));
	put(join(paths.raw, "media-manifest.json"), [{ id: 41, url: "https://fixture.example/wp-content/uploads/gym.jpg", file: "gym.jpg" }]);
	const config = kitConfigSchema.parse({ slug: "dom-fixture", name: "Fixture", source: { url: "https://fixture.example" }, target: { productionUrl: "https://fixture.example" } });
	const read = <T>(f: string) => JSON.parse(readFileSync(join(paths.ir, f), "utf8")) as T;

	it("rebuilds the Beaver page from its HTML, writes the form definition and keeps the gate red until reviewed", async () => {
		const checks = await runTransform({ config, paths, reporter: { runId: "t", emit: () => {} } });
		const home = read<IrPage>("pages/home.json");
		expect(home.source.builder).toBe("dom-fallback");
		expect(JSON.stringify(home.sections)).toContain('"wpId":41');
		expect(JSON.stringify(home.sections)).toContain('"href":"/classes/"');
		const form = home.sections.find((s) => s.type === "form");
		expect(form?.type === "form" && form.fields.formRef).toEqual({ provider: "html", id: "2-1" });
		expect(read<{ fields: { name: string }[] }>("forms/html-2-1.json").fields.map((f) => f.name)).toEqual(["fl_name", "fl_email"]);
		const gate = checks.find((c) => c.id === "dom-fallback-reviewed");
		expect(gate?.ok).toBe(false);
		expect(gate?.detail).toContain("home (beaver-builder)");
		// Oxygen page without a saved page: reported as blocking, never silently empty.
		const classes = read<IrPage>("pages/classes.json");
		expect(classes.source.builder).toBe("empty");
		expect(classes.diagnostics.some((d) => d.tag === "dom-fallback" && d.carriesContent && /no HTML of this page/.test(d.message))).toBe(true);
		// Gutenberg blocks and plain classic content keep their adapter; the posts page is never rebuilt.
		expect(read<IrPage>("pages/about.json").source.builder).toBe("gutenberg");
		expect(read<IrPage>("pages/plain.json").source.builder).toBe("classic");
		expect(read<IrPage>("pages/news.json").source.builder).toBe("empty");
		const md = readFileSync(join(paths.reports, "transform", "coverage.md"), "utf8");
		expect(md).toContain("## Rebuilt from rendered HTML (DOM fallback)");
		expect(md).toMatch(/\| \/ \| beaver-builder \| post meta _fl_builder_enabled/);
	});
	it("passes the review gate once the owner's review is recorded, and downgrades the page warning", async () => {
		put(paths.overrides, 'export default { domFallbackReviewed: { home: "checked against the live page by the owner, 2026-11-21" } };\n');
		const checks = await runTransform({ config, paths, reporter: { runId: "t", emit: () => {} } });
		expect(checks.find((c) => c.id === "dom-fallback-reviewed")).toMatchObject({ ok: true, detail: "1 page(s), all reviewed" });
		const home = read<IrPage>("pages/home.json");
		expect(home.diagnostics.find((d) => d.tag === "dom-fallback")).toMatchObject({ level: "info" });
	});
});
