import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { adaptGutenberg, parseBlocks } from "../src/adapters/gutenberg/index.js";
import { fraction, isLibRow, libColumnWidth, libraryOf, libStyle } from "../src/adapters/gutenberg/libraries.js";
import { kitConfigSchema } from "../src/config/schema.js";
import { sitePaths } from "../src/core/paths.js";
import { Keys } from "../src/ir/portable-text.js";
import type { IrPage } from "../src/ir/schema.js";
import { runTransform } from "../src/phases/transform.js";

const opts = { kind: "page" as const, keys: new Keys("t"), popupFor: () => undefined, postCount: 0 };
const block = (src: string) => parseBlocks(src)[0] as NonNullable<ReturnType<typeof parseBlocks>[number]>;

describe("Gutenberg block libraries: layout", () => {
	it("names the library of a block", () => {
		expect(libraryOf("kadence/rowlayout")).toBe("Kadence Blocks");
		expect(libraryOf("uagb/container")).toBe("Spectra");
		expect(libraryOf("core/group")).toBeUndefined();
	});
	it("recognises rows of columns per library", () => {
		const two = (name: string, attrs: object, child: string, childAttrs: object[] = [{}, {}]) => block(`<!-- wp:${name} ${JSON.stringify(attrs)} -->${childAttrs.map((a) => `<!-- wp:${child} ${JSON.stringify(a)} --><!-- wp:paragraph --><p>x</p><!-- /wp:paragraph --><!-- /wp:${child} -->`).join("")}<!-- /wp:${name} -->`);
		expect(isLibRow(two("kadence/rowlayout", { colLayout: "equal" }, "kadence/column"))).toBe(true);
		expect(isLibRow(two("kadence/rowlayout", { colLayout: "row" }, "kadence/column"))).toBe(false);
		expect(isLibRow(two("uagb/container", { directionDesktop: "row" }, "uagb/container"))).toBe(true);
		expect(isLibRow(two("uagb/container", {}, "uagb/container"))).toBe(false);
		expect(isLibRow(two("uagb/container", {}, "uagb/container", [{ widthDesktop: 50 }, { widthDesktop: 50 }]))).toBe(true);
		expect(isLibRow(two("generateblocks/element", { styles: { display: "grid", gridTemplateColumns: "1fr 2fr" } }, "generateblocks/element"))).toBe(true);
		expect(isLibRow(two("generateblocks/element", { styles: { display: "flex", flexDirection: "column" } }, "generateblocks/element"))).toBe(false);
		expect(isLibRow(two("stackable/columns", {}, "stackable/column"))).toBe(true);
	});
	it("reads column widths: Kadence presets, percentages per library", () => {
		const row = block('<!-- wp:kadence/rowlayout {"colLayout":"left-golden"} --><!-- wp:kadence/column /--><!-- wp:kadence/column /--><!-- /wp:kadence/rowlayout -->');
		expect(libColumnWidth(row.innerBlocks[0] as typeof row, row, 0)).toBe("2/3");
		expect(libColumnWidth(row.innerBlocks[1] as typeof row, row, 1)).toBe("1/3");
		const gb = block('<!-- wp:generateblocks/grid --><!-- wp:generateblocks/container {"sizing":{"width":"25%"}} /--><!-- /wp:generateblocks/grid -->');
		expect(libColumnWidth(gb.innerBlocks[0] as typeof gb, gb, 0)).toBe("1/4");
		expect(fraction(60)).toBe("60/100");
	});
	it("maps container styling (hex colours only, never preset slugs)", () => {
		expect(libStyle(block('<!-- wp:uagb/container {"backgroundColor":"#f6f1e9","anchor":"top","align":"full"} /-->'))).toEqual({ bg_color: "#f6f1e9", id: "top", type: "full_width_content" });
		expect(libStyle(block('<!-- wp:generateblocks/container {"bgImage":{"id":7,"image":{"url":"https://x.example/a.jpg"}}} /-->'))).toEqual({ bg_image: "7" });
		expect(libStyle(block('<!-- wp:kadence/rowlayout {"bgColor":"palette3"} /-->'))).toEqual({});
	});
});

describe("Gutenberg block libraries: results", () => {
	it("adds form definitions only when a page has library forms", () => {
		expect("forms" in adaptGutenberg("<!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph -->", opts)).toBe(false);
		const r = adaptGutenberg('<!-- wp:coblocks/form {"to":"x@shop.example"} --><div><!-- wp:coblocks/field-email {"required":true} /--></div><!-- /wp:coblocks/form -->', { ...opts, postId: 4 });
		expect(r.forms?.map((f) => f.id)).toEqual(["coblocks-4-1"]);
		expect(JSON.stringify(r.forms)).not.toContain("x@shop.example");
		expect(r.sections[0]?.type).toBe("form");
	});
	it("keeps the text of an unknown library block and reports it", () => {
		const r = adaptGutenberg('<!-- wp:uagb/review --><div class="wp-block-uagb-review"><p>Five stars for the rye.</p></div><!-- /wp:uagb/review -->', opts);
		expect(JSON.stringify(r.sections)).toContain("Five stars for the rye.");
		expect(r.diagnostics[0]).toMatchObject({ level: "error", code: "unmapped", tag: "uagb/review", carriesContent: true });
		expect(r.diagnostics[0]?.message).toMatch(/Spectra block without a handler, its text kept/);
	});
});

describe("Gutenberg block library forms in the transform phase", () => {
	const dir = mkdtempSync(join(tmpdir(), "wp2emdash-gblibs-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const paths = sitePaths("gblibs-fixture", dir);
	const write = (file: string, data: unknown) => {
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, JSON.stringify(data));
	};
	write(join(paths.raw, "extract.json"), {});
	write(join(paths.raw, "exporter", "options.json"), { blogname: "Fixture Studio", page_on_front: 3 });
	write(join(paths.raw, "exporter", "content", "page.json"), [
		{ id: 3, post_type: "page", status: "publish", slug: "contact", title: "Contact", content: '<!-- wp:kadence/form {"fields":[{"label":"Email","type":"email","required":true,"options":[]}],"submit":[{"text":"Go"}]} -->\n<div class="wp-block-kadence-form"></div>\n<!-- /wp:kadence/form -->', excerpt: "", date_gmt: "", modified_gmt: "2026-11-01T00:00:00", parent: null, menu_order: 0, taxonomies: {}, meta: {} },
	]);
	const config = kitConfigSchema.parse({ slug: "gblibs-fixture", name: "Fixture", source: { url: "https://fixture.example" }, target: { productionUrl: "https://fixture.example" } });
	const run = runTransform({ config, paths, reporter: { runId: "t", emit: () => {} } });

	it("writes the Kadence form definition next to the page that uses it", async () => {
		await run;
		const page = JSON.parse(readFileSync(join(paths.ir, "pages", "contact.json"), "utf8")) as IrPage;
		const form = page.sections.find((s) => s.type === "form");
		expect(form?.type === "form" && form.fields.formRef).toEqual({ provider: "kadence", id: "3-1" });
		expect(JSON.parse(readFileSync(join(paths.ir, "forms", "kadence-3-1.json"), "utf8")).submitLabel).toBe("Go");
	});
});
