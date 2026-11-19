import { describe, expect, it } from "vitest";
import { adaptBricks, type BricksElement, bricksElements, isBricks } from "../src/adapters/bricks/index.js";
import { Keys } from "../src/ir/portable-text.js";
import { detectBuilder } from "../src/phases/transform.js";

const els: BricksElement[] = [
	{ id: "s1", name: "section", parent: 0, children: ["h1"], settings: {} },
	{ id: "h1", name: "heading", parent: "s1", children: [], settings: { text: "Hello", tag: "h2" } },
];

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
		const r = adaptBricks(self, { kind: "page", keys: new Keys("t"), popupFor: () => undefined, postCount: 0, template: () => self });
		expect(r.diagnostics.some((d) => d.code === "unmapped" && /could not be loaded/.test(d.message))).toBe(true);
	});
});
