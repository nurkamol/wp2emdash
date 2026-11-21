/**
 * Golden tests: every fixture in test/fixtures/<adapter>/ is adapted and compared with
 * test/golden/<adapter>/<name>.json. After an intended change, regenerate with
 *   UPDATE_GOLDEN=1 pnpm test
 * and review the diff before committing.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adaptBricks, type BricksElement, bricksSite, liveVariables } from "../src/adapters/bricks/index.js";
import { adaptDivi, diviSite } from "../src/adapters/divi/index.js";
import { adaptDomFallback } from "../src/adapters/dom-fallback/index.js";
import { adaptElementor, type ElementorElement, elementorKit } from "../src/adapters/elementor/index.js";
import { adaptGutenberg } from "../src/adapters/gutenberg/index.js";
import { adaptWpbakery } from "../src/adapters/wpbakery/index.js";
import { Keys } from "../src/ir/portable-text.js";
import { type IrMenuItem, section } from "../src/ir/schema.js";
import { announcementDoc, describeBar, detectAnnouncement } from "../src/transform/announcement.js";

const root = join(import.meta.dirname, "fixtures");
const golden = join(import.meta.dirname, "golden");
const update = process.env.UPDATE_GOLDEN === "1";

const popupFor = ({ href, classes }: { href?: string; classes?: string }) => ((classes ?? "").split(/\s+/).includes("book-now") || href === "#book-now" ? "book-now" : undefined);
const reusable = (id: number) => (id === 99 ? `<!-- wp:paragraph --><p>Shared notice from a reusable block.</p><!-- /wp:paragraph -->` : undefined);

const adapters = {
	wpbakery: (src: string) => adaptWpbakery(src, { kind: "page", keys: new Keys("t"), popupFor, postCount: 0 }),
	// Gutenberg fixtures: post_content, optionally after a `<!-- fixture {"postCount":n} -->` line (what transform knows).
	gutenberg: (src: string) => {
		const head = /^<!-- fixture (\{.*?\}) -->\n?/.exec(src);
		const f = JSON.parse(head?.[1] ?? "{}") as { postCount?: number };
		const terms: Record<string, string> = { "category:7": "news", "category:9": "studio-life" };
		return adaptGutenberg(head ? src.slice(head[0].length) : src, { kind: "page", keys: new Keys("t"), popupFor, postCount: f.postCount ?? 0, reusable, postId: 10, termSlug: (tax, id) => terms[`${tax}:${id}`] });
	},
	// Bricks fixtures: { elements, templates?: { [id]: elements }, options?: { bricks_* }, kind?, title?, postCount?,
	// permalinks?: { [postId]: path }, popups?: { [templateId]: slug }, content?: post_content, menus?: { [menuId]: items } } — the post meta, the
	// bricks_template posts, the Bricks options (palette, global classes, theme styles, components, breakpoints), the
	// post's own content (post-content element, {post_content}) and what transform knows.
	bricks: (src: string) => {
		const f = JSON.parse(src) as { elements: BricksElement[]; templates?: Record<string, BricksElement[]>; options?: Record<string, unknown>; kind?: "page" | "partial"; title?: string; postCount?: number; permalinks?: Record<string, string>; popups?: Record<string, string>; content?: string; menus?: Record<string, IrMenuItem[]>; live?: { width: number; rootFontSize: number; variables: Record<string, string> }[] };
		return adaptBricks(f.elements, {
			kind: f.kind ?? "page",
			keys: new Keys("t"),
			popupFor,
			postCount: f.postCount ?? 0,
			template: (id) => f.templates?.[String(id)],
			site: bricksSite(f.options ?? {}, liveVariables(f.live)),
			postId: 10,
			...(f.content !== undefined ? { content: f.content } : {}),
			reusable,
			title: f.title ?? "Fixture page",
			siteTitle: "Fixture Studio",
			permalink: (id) => f.permalinks?.[String(id)],
			popupSlug: (id) => f.popups?.[String(id)],
			menuItems: (id) => f.menus?.[id],
		});
	},
	// Elementor fixtures (hand-written in Elementor's documented format, no client data): { elements, templates?: { [id]:
	// elements }, kit?: the Kit's _elementor_page_settings, kind?, role?, title?, postCount?, permalinks?, popups?, menus? }.
	elementor: (src: string) => {
		const f = JSON.parse(src) as { elements: ElementorElement[]; templates?: Record<string, ElementorElement[]>; kit?: Record<string, unknown>; kind?: "page" | "partial"; role?: "header" | "footer"; title?: string; postCount?: number; permalinks?: Record<string, string>; popups?: Record<string, string>; menus?: Record<string, IrMenuItem[]> };
		return adaptElementor(f.elements, {
			kind: f.kind ?? "page",
			...(f.role ? { role: f.role } : {}),
			keys: new Keys("t"),
			popupFor,
			postCount: f.postCount ?? 0,
			template: (id) => f.templates?.[String(id)],
			kit: elementorKit(f.kit),
			postId: 10,
			title: f.title ?? "Fixture page",
			siteTitle: "Fixture Studio",
			permalink: (id) => f.permalinks?.[String(id)],
			popupSlug: (id) => f.popups?.[String(id)],
			menuItems: (id) => f.menus?.[id],
		});
	},
	// Divi fixtures (hand-written in Divi 4's saved shortcode format / Divi 5's block format, no client data): the raw
	// post_content (.txt), or { content, kind?, role?, title?, postCount?, menus?: { [menuId]: items }, options?: the
	// et_divi / et_global_data options } (.json).
	divi: (src: string) => {
		const f = (src.trimStart().startsWith("{") ? JSON.parse(src) : { content: src }) as { content: string; kind?: "page" | "partial"; role?: "header" | "footer"; title?: string; postCount?: number; menus?: Record<string, IrMenuItem[]>; options?: Record<string, unknown> };
		return adaptDivi(f.content, {
			kind: f.kind ?? "page",
			...(f.role ? { role: f.role } : {}),
			keys: new Keys("t"),
			popupFor,
			postCount: f.postCount ?? 0,
			site: diviSite(f.options ?? {}),
			postId: 10,
			title: f.title ?? "Fixture page",
			siteTitle: "Fixture Studio",
			menuItems: (id) => f.menus?.[id],
		});
	},
	// DOM fallback (pages of builders without an adapter, rebuilt from the audit's saved HTML): hand-written pages in the
	// style of Avada, Beaver Builder, Oxygen, Thrive, SiteOrigin, Flatsome, Breakdance and a plain theme, invented
	// businesses on .example domains. First line: <!-- fixture {"builder", "postId", "postCount"} -->. Upload URLs end
	// in -<id>(-WxH).ext, which the stub media library resolves; this site's absolute links become paths.
	"dom-fallback": (src: string) => {
		const f = JSON.parse(/^<!-- fixture (\{.*?\}) -->/.exec(src)?.[1] ?? "{}") as { builder?: string; postId?: number; postCount?: number };
		return adaptDomFallback(src, {
			kind: "page",
			keys: new Keys("t"),
			popupFor,
			postCount: f.postCount ?? 0,
			postId: f.postId ?? 10,
			title: "Fixture page",
			reason: { builder: f.builder ?? "unknown", why: `fixture (${f.builder ?? "unknown"})` },
			mediaIdForUrl: (u) => {
				const m = /^https:\/\/[a-z]+\.example\/wp-content\/uploads\/(?:.*\/)?[a-z]+-(\d+)(?:-\d+x\d+)?\.[a-z0-9]+$/i.exec(u);
				return m ? Number(m[1]) : undefined;
			},
			relHref: (u) => u.replace(/^https:\/\/[a-z]+\.example(?=\/|$)/, "") || "/",
		});
	},
	// Announcement bars: one saved page of HTML → what detection found and the site part it becomes.
	announcement: (src: string) => {
		const d = detectAnnouncement([{ name: "page", html: src }]);
		if (!d.best) throw new Error("no bar detected");
		const doc = announcementDoc(d.best, new Keys("t"), (h) => h.replace(/^https:\/\/fixture\.example/, "") || "/");
		return { confident: d.best.confident, found: d.all.map(describeBar), scriptOnly: d.scriptOnly, sections: doc.sections, diagnostics: doc.diagnostics };
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
