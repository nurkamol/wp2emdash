/**
 * Term meta (src/transform/term-meta.ts): term descriptions reach EmDash's term `description` (seed, load create, and
 * load filling an empty one on an existing term); Yoast per-term SEO values are counted, not carried (EmDash 1.5 terms
 * have no SEO fields). Blog plan from the blog golden (synthetic fixture test/fixtures/blog/site.json).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SEO_OPTIONS } from "../src/commands/import-options.js";
import { buildSeed } from "../src/scaffold/seed.js";
import type { BlogPlan } from "../src/transform/blog.js";
import { termDescriptionUpdate, termSeoReport, yoastTermSeo } from "../src/transform/term-meta.js";

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
	const descriptions: Record<string, string> = { "category:7": "What is new", "category:8": "" };

	it("import-options reads it from a database dump; counted per taxonomy, with descriptions that differ", () => {
		expect(SEO_OPTIONS).toContain("wpseo_taxonomy_meta");
		const counts = yoastTermSeo(option, (t, id) => descriptions[`${t}:${id}`]);
		expect(counts).toEqual({ byTaxonomy: { category: { terms: 2, title: 1, description: 2 }, post_tag: { terms: 1, title: 1, description: 0 } }, differs: 1 });
		expect(yoastTermSeo(undefined)).toBeUndefined();
		expect(yoastTermSeo({ category: { 1: { wpseo_focuskw: "x" } } })).toBeUndefined();
	});

	it("the report says the values are not carried (counts only)", () => {
		const md = termSeoReport(yoastTermSeo(option, (t, id) => descriptions[`${t}:${id}`])).join("\n");
		expect(md).toMatch(/## Term SEO \(Yoast\)/);
		expect(md).toMatch(/\*\*not carried\*\*/);
		expect(md).toMatch(/\| `category` \| 2 \| 1 \| 2 \|/);
		expect(md).toMatch(/1 SEO description\(s\) differ/);
		expect(md).not.toMatch(/Weekend workshops/);
		expect(termSeoReport(undefined)).toEqual([]);
	});
});
