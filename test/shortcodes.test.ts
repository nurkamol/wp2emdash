/** Plugin/theme shortcode registry: pages (WPBakery dispatch, golden plugin-shortcodes), posts (shortcode pass) and the report. */
import { describe, expect, it } from "vitest";
import { shortcodeAction, shortcodeRegistry } from "../src/adapters/shortcodes.js";
import { adaptWpbakery } from "../src/adapters/wpbakery/index.js";
import { Keys } from "../src/ir/portable-text.js";
import { convertPostBody, shortcodePass } from "../src/transform/blog.js";
import { shortcodeSummary, shortcodesReport } from "../src/transform/shortcodes.js";

describe("registry", () => {
	it("classifies form, breadcrumb, wrapper, widget and media shortcodes; unknown ones stay unknown", () => {
		expect(shortcodeAction("contact-form-7")).toEqual({ do: "form", provider: "contact-form-7" });
		expect(shortcodeAction("forminator_form")).toEqual({ do: "form", provider: "forminator" });
		expect(shortcodeAction("yoast-breadcrumb")).toEqual({ do: "breadcrumbs" });
		expect(shortcodeAction("one_third_last")).toEqual({ do: "strip" });
		expect(shortcodeAction("social_warfare")).toMatchObject({ do: "widget", content: false });
		expect(shortcodeAction("rev_slider")).toMatchObject({ do: "widget", content: true });
		expect(shortcodeAction("caption")).toEqual({ do: "media" });
		expect(shortcodeAction("acme_widget")).toBeUndefined();
		expect(new Set(shortcodeRegistry().map((r) => r.tag)).size).toBe(shortcodeRegistry().length);
	});
});

describe("pages", () => {
	const adapt = (src: string) => adaptWpbakery(src, { kind: "page", keys: new Keys("t"), popupFor: () => undefined, postCount: 0 });
	it("page-builder elements keep the old report; plugin shortcodes without content still block", () => {
		const r = adapt("[vc_row][vc_column][vc_fancy_thing][some_counter][/vc_column][/vc_row]");
		expect(r.diagnostics.map((d) => `${d.level}:${d.tag}`)).toEqual(["warn:vc_fancy_thing", "error:some_counter"]);
		expect(r.diagnostics[1]?.carriesContent).toBe(true);
	});
	it("a form shortcode without an id is reported", () => {
		expect(adapt("[vc_row][vc_column][forminator_form][/vc_column][/vc_row]").diagnostics[0]?.message).toMatch(/without a form id/);
	});
	it("summary and coverage table: name, action, count, sample page, blocking", () => {
		const r = adapt("[vc_row][vc_column][vc_column_text][yoast-breadcrumb][acme_widget][acme_widget][/vc_column_text][/vc_column][/vc_row]");
		const s = shortcodeSummary([{ doc: { diagnostics: r.diagnostics, source: { slug: "about" } as never, route: { path: "/about/" } }, published: true }]);
		expect(s.breadcrumbs).toBe(true);
		expect(s.used.map((u) => `${u.name}:${u.action}:${u.count}:${u.pages[0]}:${u.blocking}`)).toEqual(["acme_widget:unknown:2:/about/:true", "yoast-breadcrumb:breadcrumbs:1:/about/:false"]);
		expect(shortcodesReport(s).join("\n")).toMatch(/\| `\[acme_widget\]` \| ❌ unknown: output not rebuilt \| 2 \| \/about\/ \| yes \|/);
	});
});

describe("posts", () => {
	it("wrappers lose their tags (title kept bold), breadcrumbs go, other shortcodes stay for the report", () => {
		expect(shortcodePass('[su_box title="Hours"]Open daily.[/su_box][rank_math_breadcrumb][acme x="1"]')).toBe('<p><strong>Hours</strong></p>Open daily.[acme x="1"]');
	});
	it("share widgets in posts warn; form shortcodes in posts block with a hint", () => {
		const share = convertPostBody("<p>Read on.</p>\n\n<p>[addtoany]</p>", "classic", { keyPrefix: "p", mediaIdForUrl: () => undefined });
		expect(share.diagnostics.map((d) => d.level)).toEqual(["warn"]);
		const form = convertPostBody("<p>[ninja_form id=3]</p>", "classic", { keyPrefix: "p", mediaIdForUrl: () => undefined });
		expect(form.diagnostics[0]).toMatchObject({ level: "error", carriesContent: true });
		expect(form.diagnostics[0]?.message).toMatch(/a form in a post/);
	});
});
