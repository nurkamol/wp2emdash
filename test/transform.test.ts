import { describe, expect, it } from "vitest";
import { parseBlocks } from "../src/adapters/gutenberg/index.js";
import { colourValue, columnFraction, decodeRawHtml, decodeVcLink, isDarkColour, spacingFromPadding } from "../src/adapters/wpbakery/decode.js";
import { carriesContent } from "../src/adapters/wpbakery/index.js";
import { parseAttrs, parseShortcodes, type ShortcodeNode } from "../src/adapters/wpbakery/parser.js";
import { autop, htmlToPortableText, Keys } from "../src/ir/portable-text.js";
import { conservation, sourceText, tokens } from "../src/transform/coverage.js";
import { detectBuilder } from "../src/phases/transform.js";

const sc = (n: unknown) => n as ShortcodeNode;

describe("shortcode parser", () => {
	it("nests enclosing tags and hoists self-closing ones", () => {
		const ast = parseShortcodes('<p>[vc_row][vc_column][nectar_btn text="Go" url="/x/"]after[/vc_column][/vc_row]</p>');
		const row = sc(ast[0]);
		expect(row.tag).toBe("vc_row");
		const col = sc(row.children[0]);
		expect(col.children.map((c) => (c.type === "text" ? c.text : sc(c).tag))).toEqual(["nectar_btn", "after"]);
		expect(sc(col.children[0]).selfClosing).toBe(true);
	});

	it("parses texturized quotes, unquoted and positional attributes", () => {
		expect(parseAttrs(' title=″Hello world″ id=5 "positional" flag')).toEqual({ attrs: { title: "Hello world", id: "5" }, args: ["positional", "flag"] });
		expect(parseAttrs(" a=&#8221;x&#8221;").attrs.a).toBe("x");
	});

	it("keeps escaped shortcodes and stray closers as text", () => {
		const ast = parseShortcodes("[[gallery]] and [/oops]");
		expect(ast).toEqual([{ type: "text", text: "[gallery] and [/oops]" }]);
	});

	it("knows which unknown elements carry content", () => {
		expect(carriesContent(sc(parseShortcodes('[x title="Hi there"]')[0]))).toBe(true);
		expect(carriesContent(sc(parseShortcodes('[x height="32px" style="default"]')[0]))).toBe(false);
		expect(carriesContent(sc(parseShortcodes("[x]text[/x]")[0]))).toBe(true);
	});
});

describe("decoders", () => {
	it("decodes vc_link and raw html", () => {
		expect(decodeVcLink("url:https%3A%2F%2Fa.b%2Fc|title:Read%20more|target:_blank")).toEqual({ url: "https://a.b/c", title: "Read more", target: "_blank" });
		expect(decodeVcLink("/plain/")).toEqual({ url: "/plain/" });
		const b64 = Buffer.from(encodeURIComponent("<b>Hi</b>")).toString("base64");
		expect(decodeRawHtml(`<p>${b64}</p>`)).toBe("<b>Hi</b>");
	});

	it("maps widths, padding and colours", () => {
		expect(columnFraction("2/3")).toBeCloseTo(0.667, 2);
		expect(columnFraction("vc_col-sm-6")).toBe(0.5);
		expect(spacingFromPadding("8%", "3%")).toBe("normal");
		expect(spacingFromPadding("0", "0")).toBe("none");
		expect(spacingFromPadding("12%", "12%")).toBe("spacious");
		expect(isDarkColour("#f4ece2")).toBe(false);
		expect(isDarkColour("#2b323a")).toBe(true);
		expect(isDarkColour("#fff")).toBe(false);
		expect(isDarkColour("rgba(0,0,0,0.5)")).toBe(true);
		expect(colourValue("Accent-Color")).toBe("var(--color-accent-color)");
		expect(colourValue("nonsense")).toBeUndefined();
	});
});

describe("portable text", () => {
	it("keeps top-level text, marks, links and nested lists", () => {
		const r = htmlToPortableText('Intro <strong>bold</strong><ul><li>A<ul><li>A1</li></ul></li></ul><p><a href="/x" target="_blank">link</a></p>', new Keys());
		expect(r.blocks.map((b) => [b.style, b.listItem ?? "", b.level ?? 0, b.children.map((c) => c.text).join("")])).toEqual([
			["normal", "", 0, "Intro bold"],
			["normal", "bullet", 1, "A"],
			["normal", "bullet", 2, "A1"],
			["normal", "", 0, "link"],
		]);
		expect(r.blocks[3]?.markDefs[0]).toMatchObject({ href: "/x", blank: true });
	});

	it("returns images and non-text HTML separately", () => {
		const r = htmlToPortableText('<p>x<img class="wp-image-7" src="/a.jpg" alt="A"></p><iframe src="https://maps.google.com/x"></iframe>', new Keys());
		expect(r.images).toEqual([{ src: "/a.jpg", alt: "A", wpId: 7 }]);
		expect(r.leftovers[0]?.tag).toBe("iframe");
	});

	it("applies wpautop like WordPress", () => {
		expect(autop("one\n\ntwo\nthree")).toBe("<p>one</p>\n<p>two<br>three</p>");
		expect(autop("<p>kept</p>")).toBe("<p>kept</p>");
		expect(autop("text\n<h2>T</h2>\nmore")).toBe("<p>text</p>\n<h2>T</h2>\n<p>more</p>");
		// a newline right after a typed <br /> is the same line break, not a second one
		expect(autop("intro\n\n- <b>Level:</b> Beginner<br />\nThe class text.")).toBe("<p>intro</p>\n<p>- <b>Level:</b> Beginner<br>The class text.</p>");
	});
});

describe("gutenberg parser", () => {
	it("builds the block tree with attrs and freeform", () => {
		const b = parseBlocks('<p>classic</p><!-- wp:group {"anchor":"x"} --><div><!-- wp:paragraph --><p>a</p><!-- /wp:paragraph --></div><!-- /wp:group --><!-- wp:block {"ref":4} /-->');
		expect(b.map((x) => x.name)).toEqual(["core/freeform", "core/group", "core/block"]);
		expect(b[1]?.attrs).toEqual({ anchor: "x" });
		expect(b[1]?.innerBlocks[0]?.name).toBe("core/paragraph");
		expect(b[2]?.attrs.ref).toBe(4);
	});

	it("detects the builder", () => {
		expect(detectBuilder("[vc_row][/vc_row]")).toBe("wpbakery");
		expect(detectBuilder("<!-- wp:paragraph --><p>x</p><!-- /wp:paragraph -->")).toBe("gutenberg");
		expect(detectBuilder("<p>x</p>")).toBe("classic");
		expect(detectBuilder("  ")).toBe("empty");
	});
});

describe("text conservation", () => {
	it("ignores theme chrome and compares distinct words", () => {
		const html = '<body><div id="header-outer">Menu Search</div><div id="ajax-content-wrap"><h1>Hello</h1><p>World <a class="__cf_email__" data-cfemail="422302236c212d2f">[email&#160;protected]</a></p><script>var x</script></div></body>';
		const src = sourceText(html);
		expect(tokens(src)).toEqual(["hello", "world", "a@a.com"]);
		expect(conservation(src, "Hello world a@a.com").ratio).toBe(1);
		const c = conservation(src, "Hello");
		expect(c.missing.sort()).toEqual(["a@a.com", "world"]);
	});

	it("treats {year} as any year", () => {
		expect(conservation("© 2026 Acme", "© {year} Acme").ratio).toBe(1);
	});
});
