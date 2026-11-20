/**
 * WordPress reusable blocks (`wp_block`) → EmDash sections (src/transform/sections.ts, src/targets/emdash/sections.ts).
 * Synthetic fixture: test/fixtures/reusable/blocks.json. Golden: test/golden/reusable/sections.json (regenerate after an
 * intended change: UPDATE_GOLDEN=1 pnpm test).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { kitConfigSchema } from "../src/config/schema.js";
import { sitePaths } from "../src/core/paths.js";
import { runTransform } from "../src/phases/transform.js";
import { resolvePostBody } from "../src/phases/load.js";
import { buildSeed, seedMediaResolver } from "../src/scaffold/seed.js";
import { EmDashHttpError } from "../src/targets/emdash/api.js";
import { writeSections } from "../src/targets/emdash/sections.js";
import { planSections, type SectionsPlan } from "../src/transform/sections.js";

const blocks = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "reusable", "blocks.json"), "utf8"));
const goldenDir = join(import.meta.dirname, "golden", "reusable");
const golden = (name: string, value: unknown) => {
	const file = join(goldenDir, name);
	const json = `${JSON.stringify(value, null, "\t")}\n`;
	if (process.env.UPDATE_GOLDEN === "1" || !existsSync(file)) {
		mkdirSync(goldenDir, { recursive: true });
		writeFileSync(file, json);
	}
	expect(json).toBe(readFileSync(file, "utf8"));
};
const byId = new Map<number, string>(blocks.map((b: { id: number; content: string }) => [b.id, b.content]));
const mediaIdForUrl = (u: string) => (/studio/.test(u) ? 31 : undefined);
const plan = planSections(blocks, { mediaIdForUrl, reusable: (id) => byId.get(id) });

describe("reusable blocks → EmDash sections", () => {
	it("published blocks with content become sections (Portable Text, media marked); drafts and empty ones are listed (golden)", () => {
		golden("sections.json", plan);
		expect(plan.sections.map((s) => s.slug)).toEqual(["wp-opening-hours", "wp-call-to-action", "wp-legacy-form"]);
		expect(plan.skipped).toEqual([{ wpId: 43, title: "Unfinished", why: "status draft" }, { wpId: 44, title: "Reusable block 44", why: "empty" }]);
		const hours = plan.sections[0];
		expect(hours?.content.map((b) => b._type)).toEqual(["block", "block", "image"]);
		expect(hours?.content[2]).toMatchObject({ _media: { wpId: 31, kind: "image", alt: "The studio" } });
		// A reusable block inside another is inlined into the outer section.
		expect(JSON.stringify(plan.sections[1]?.content)).toContain("Opening hours");
		// Shortcodes are flagged like in post bodies, never silently dropped.
		expect(plan.sections[2]?.diagnostics.some((d) => d.tag === "shortcode")).toBe(true);
		for (const s of plan.sections) expect(s.slug).toMatch(/^[a-z0-9-]+$/);
	});

	it("transform writes ir/sections.json and a report section; a site without reusable blocks writes nothing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "wp2e-reusable-"));
		const config = kitConfigSchema.parse({ slug: "r", name: "Example Studio", source: { url: "https://reusable.example.test" }, target: { productionUrl: "https://reusable.example.test" } });
		const run = async (name: string, withBlocks: boolean) => {
			const paths = sitePaths(name, dir);
			const put = (f: string, d: unknown) => {
				mkdirSync(join(f, ".."), { recursive: true });
				writeFileSync(f, JSON.stringify(d));
			};
			put(join(paths.raw, "extract.json"), {});
			put(join(paths.raw, "exporter", "options.json"), { blogname: "Example Studio", page_on_front: 1 });
			put(join(paths.raw, "exporter", "content", "page.json"), [{ id: 1, post_type: "page", status: "publish", slug: "home", title: "Home", content: '<!-- wp:block {"ref":41} /-->', excerpt: "", date_gmt: "", modified_gmt: "", parent: null, menu_order: 0, taxonomies: {}, meta: {} }]);
			if (withBlocks) put(join(paths.raw, "exporter", "content", "wp_block.json"), blocks);
			await runTransform({ config, paths, reporter: { runId: "t", emit: () => {} } });
			return paths;
		};
		const withBlocks = await run("with", true);
		const ir = JSON.parse(readFileSync(join(withBlocks.ir, "sections.json"), "utf8")) as SectionsPlan;
		expect(ir.sections.map((s) => s.slug)).toEqual(["wp-opening-hours", "wp-call-to-action", "wp-legacy-form"]);
		const md = readFileSync(join(withBlocks.reports, "transform", "coverage.md"), "utf8");
		expect(md).toMatch(/## Reusable blocks → EmDash sections/);
		expect(md).toMatch(/\| `wp-opening-hours` \| Opening hours \(#41\) \|/);
		// The page still has the block inlined where it was used.
		expect(readFileSync(join(withBlocks.ir, "pages", "home.json"), "utf8")).toContain("Opening hours");
		const without = await run("without", false);
		expect(existsSync(join(without.ir, "sections.json"))).toBe(false);
		expect(readFileSync(join(without.reports, "transform", "coverage.md"), "utf8")).not.toMatch(/Reusable blocks →/);
	});

	it("seed: sections with source import, images at their WordPress file; none without reusable blocks", () => {
		const media = seedMediaResolver(new Map([[31, { url: "https://reusable.example.test/wp-content/uploads/2024/02/studio.jpg" }]]), (u) => u);
		const base = { name: "x", site: { version: 1 as const, title: "X", menus: [], partials: [], popups: [] }, pages: [], partials: [], popups: [], media, titleSeparator: "-", forms: [], includeContent: true };
		const seed = buildSeed({ ...base, sections: plan.sections });
		const sections = seed.sections as { slug: string; source: string; content: Record<string, unknown>[] }[];
		expect(sections.map((s) => [s.slug, s.source])).toEqual([["wp-opening-hours", "import"], ["wp-call-to-action", "import"], ["wp-legacy-form", "import"]]);
		expect(sections[0]?.content[2]?.asset).toMatchObject({ url: "https://reusable.example.test/wp-content/uploads/2024/02/studio.jpg" });
		expect(JSON.stringify(sections)).not.toContain('"_media"');
		expect(buildSeed(base).sections).toBeUndefined();
	});

	it("load: creates missing sections, updates the kit's own, leaves an editor's section with the same slug alone", async () => {
		const existing: Record<string, { id: string; slug: string; title: string; source: string }> = { "wp-call-to-action": { id: "S2", slug: "wp-call-to-action", title: "Old", source: "import" }, "wp-legacy-form": { id: "S3", slug: "wp-legacy-form", title: "Mine", source: "user" } };
		const calls: string[] = [];
		const api = {
			section: async (slug: string) => existing[slug],
			createSection: async (i: { slug: string; source: string; content: unknown[] }) => void calls.push(`create ${i.slug} ${i.source} ${JSON.stringify(i.content).includes('"_ref":"M31"')}`),
			updateSection: async (slug: string) => void calls.push(`update ${slug}`),
		};
		const r = await writeSections(api as never, plan.sections, (c) => resolvePostBody(c, (m) => ({ id: `M${m.wpId}`, url: `/_emdash/api/media/file/${m.wpId}.jpg` })));
		expect(calls).toEqual(["create wp-opening-hours import true", "update wp-call-to-action"]);
		expect(r).toMatchObject({ created: 1, updated: 1 });
		expect(r.errors).toEqual(["wp-legacy-form: a section with this slug was made in the admin (source user); left as it is"]);
		const denied = await writeSections({ section: async () => undefined, createSection: async () => { throw new EmDashHttpError(403, "INSUFFICIENT_SCOPE", "x"); }, updateSection: async () => {} } as never, plan.sections.slice(0, 1), (c) => c);
		expect(denied.errors).toEqual(["wp-opening-hours: the API token needs the content:write scope"]);
	});
});
