/**
 * Term meta (src/transform/term-meta.ts): term descriptions reach EmDash's term `description` (seed, load create, and
 * load filling an empty one on an existing term); Yoast per-term SEO values are carried into the SEO plugin's archive
 * store (EmDash 1.5 terms have no SEO fields). Blog plan from the blog golden (synthetic fixture test/fixtures/blog/site.json).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SEO_OPTIONS } from "../src/commands/import-options.js";
import { buildSeed } from "../src/scaffold/seed.js";
import type { BlogPlan } from "../src/transform/blog.js";
import { termDescriptionUpdate, termSeoPlan, termSeoReport } from "../src/transform/term-meta.js";

const plan = JSON.parse(readFileSync(join(import.meta.dirname, "golden", "blog", "blog.json"), "utf8")) as BlogPlan;

describe("term descriptions", () => {
	it("the blog plan carries WordPress term descriptions into the seed's terms", () => {
		const seed = buildSeed({ name: "x", site: { version: 1, title: "X", menus: [], partials: [], popups: [] }, pages: [], partials: [], popups: [], media: () => undefined, titleSeparator: "-", forms: [], includeContent: false, blog: { plan, posts: [] } });
		const category = (seed.taxonomies as { name: string; terms: { slug: string; description?: string }[] }[]).find((t) => t.name === "category");
		expect(category?.terms.find((t) => t.slug === "news")?.description).toBe("What is new");
		expect(category?.terms.find((t) => t.slug === "workshops")).not.toHaveProperty("description");
	});

	it("load fills an empty description on an existing term, never replaces one an editor wrote", () => {
		expect(termDescriptionUpdate({ description: "" }, "What is new")).toBe("What is new");
		expect(termDescriptionUpdate({}, " What is new ")).toBe("What is new");
		expect(termDescriptionUpdate({ description: "Edited in the admin" }, "What is new")).toBeUndefined();
		expect(termDescriptionUpdate({ description: "" }, "")).toBeUndefined();
		expect(termDescriptionUpdate(undefined, "What is new")).toBeUndefined();
	});
});

describe("term SEO (Yoast wpseo_taxonomy_meta)", () => {
	const option = {
		category: { 7: { wpseo_title: "News from the studio", wpseo_desc: "What is new" }, 8: { wpseo_desc: "Weekend workshops and intensives" }, 9: { wpseo_focuskw: "only a keyword" } },
		post_tag: { 12: { wpseo_title: "Reformer" } },
		bad: "not an object",
	};
	const taxonomies = plan.taxonomies.map((t) => ({ name: t.name, wpName: t.wpName, base: t.base, terms: t.terms }));

	it("import-options reads it from a database dump; carried for migrated terms, the rest counted (test/term-seo.test.ts has the full path)", () => {
		expect(SEO_OPTIONS).toContain("wpseo_taxonomy_meta");
		const p = termSeoPlan({ yoast: option, taxonomies, siteName: "Example Journal" });
		expect(p.terms.map((t) => [t.path, t.title ?? null, t.description ?? null])).toEqual([
			["/category/news/", "News from the studio", "What is new"],
			["/category/workshops/", null, "Weekend workshops and intensives"],
		]);
		expect(p.notCarried).toEqual([{ wpTaxonomy: "post_tag", terms: 1, why: "taxonomy not migrated (no archive on the new site)" }]);
		expect(termSeoPlan({ yoast: undefined, taxonomies, siteName: "x" }).terms).toEqual([]);
	});

	it("the report says the values are carried (counts only, no text)", () => {
		const md = termSeoReport(termSeoPlan({ yoast: option, taxonomies, siteName: "Example Journal" })).join("\n");
		expect(md).toMatch(/## Term SEO/);
		expect(md).toMatch(/\*\*Carried\*\*/);
		expect(md).toMatch(/\| `category` \| 2 \| 1 \| 2 \| 0 \| 0 \| 0 \|/);
		expect(md).not.toMatch(/Weekend workshops/);
		expect(termSeoReport(undefined)).toEqual([]);
	});
});
