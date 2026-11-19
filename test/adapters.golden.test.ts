/**
 * Golden tests: every fixture in test/fixtures/<adapter>/ is adapted and compared with
 * test/golden/<adapter>/<name>.json. After an intended change, regenerate with
 *   UPDATE_GOLDEN=1 pnpm test
 * and review the diff before committing.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adaptBricks, type BricksElement, bricksSite } from "../src/adapters/bricks/index.js";
import { adaptGutenberg } from "../src/adapters/gutenberg/index.js";
import { adaptWpbakery } from "../src/adapters/wpbakery/index.js";
import { Keys } from "../src/ir/portable-text.js";
import { section } from "../src/ir/schema.js";

const root = join(import.meta.dirname, "fixtures");
const golden = join(import.meta.dirname, "golden");
const update = process.env.UPDATE_GOLDEN === "1";

const popupFor = ({ href, classes }: { href?: string; classes?: string }) => ((classes ?? "").split(/\s+/).includes("book-now") || href === "#book-now" ? "book-now" : undefined);
const reusable = (id: number) => (id === 99 ? `<!-- wp:paragraph --><p>Shared notice from a reusable block.</p><!-- /wp:paragraph -->` : undefined);

const adapters = {
	wpbakery: (src: string) => adaptWpbakery(src, { kind: "page", keys: new Keys("t"), popupFor, postCount: 0 }),
	gutenberg: (src: string) => adaptGutenberg(src, { kind: "page", keys: new Keys("t"), popupFor, postCount: 0, reusable }),
	// Bricks fixtures: { elements, templates?: { [id]: elements }, options?: { bricks_* }, kind?, title?, postCount?,
	// permalinks?: { [postId]: path }, popups?: { [templateId]: slug }, content?: post_content } — the post meta, the
	// bricks_template posts, the Bricks options (palette, global classes, theme styles, components, breakpoints), the
	// post's own content (post-content element, {post_content}) and what transform knows.
	bricks: (src: string) => {
		const f = JSON.parse(src) as { elements: BricksElement[]; templates?: Record<string, BricksElement[]>; options?: Record<string, unknown>; kind?: "page" | "partial"; title?: string; postCount?: number; permalinks?: Record<string, string>; popups?: Record<string, string>; content?: string };
		return adaptBricks(f.elements, {
			kind: f.kind ?? "page",
			keys: new Keys("t"),
			popupFor,
			postCount: f.postCount ?? 0,
			template: (id) => f.templates?.[String(id)],
			site: bricksSite(f.options ?? {}),
			postId: 10,
			...(f.content !== undefined ? { content: f.content } : {}),
			reusable,
			title: f.title ?? "Fixture page",
			siteTitle: "Fixture Studio",
			permalink: (id) => f.permalinks?.[String(id)],
			popupSlug: (id) => f.popups?.[String(id)],
		});
	},
};

for (const [name, adapt] of Object.entries(adapters)) {
	describe(`${name} golden`, () => {
		const dir = join(root, name);
		for (const file of readdirSync(dir).sort()) {
			it(file, () => {
				const result = adapt(readFileSync(join(dir, file), "utf8"));
				for (const s of result.sections) expect(section.safeParse(s).success, `${file}: ${JSON.stringify(section.safeParse(s).error?.issues?.[0])}`).toBe(true);
				const out = join(golden, name, file.replace(/\.\w+$/, ".json"));
				const json = `${JSON.stringify(result, null, 2)}\n`;
				if (update || !existsSync(out)) writeFileSync(out, json);
				expect(json).toBe(readFileSync(out, "utf8"));
			});
		}
	});
}
