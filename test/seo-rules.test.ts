import { describe, expect, it } from "vitest";
import { overridesSchema } from "../src/config/overrides.js";
import { seoRules } from "../src/verify/seo-rules.js";
import { llmsListed, llmsTxt } from "../starter/src/utils/llms.js";
import { fixOutline, hasHeading, newOutline, outlineLevel } from "../starter/src/utils/outline.js";

const plan = (levels: number[]) => {
	const s = newOutline();
	return levels.map((l) => outlineLevel(s, l));
};

describe("heading outline (starter middleware)", () => {
	it("keeps one h1: later h1s become h2 (a WordPress page with three h1s)", () => expect(plan([1, 1, 1, 3])).toEqual([1, 2, 2, 3]));
	it("never skips a level: h1 → h3 becomes h1 → h2, and children follow", () => expect(plan([1, 3, 3, 4, 2])).toEqual([1, 2, 2, 3, 2]));
	it("a page whose first heading is an h3 gets it as its h1", () => expect(plan([3, 4])).toEqual([1, 2]));
	it("moves a whole sub-tree with its parent", () => expect(plan([1, 4, 5, 4, 2, 4])).toEqual([1, 2, 3, 2, 2, 3]));
	it("footer headings start at h2, never h1 (an h4 after the page content becomes h2)", () => {
		const s = newOutline(2);
		expect([4, 5, 1, 4].map((l) => outlineLevel(s, l))).toEqual([2, 3, 2, 3]);
	});
	it("leaves a correct outline alone", () => expect(plan([1, 2, 3, 2, 3])).toEqual([1, 2, 3, 2, 3]));

	it("re-tags inside <main> only and keeps the look with the original level's class", () => {
		type H = { element(el: { tagName: string; getAttribute(n: string): string | null; setAttribute(n: string, v: string): void }): void };
		const els = [{ tagName: "h1", cls: "heading heading--h1" }, { tagName: "h1", cls: "heading heading--h1" }, { tagName: "h3", cls: "" }].map((e) => ({ tagName: e.tagName, attrs: { class: e.cls } as Record<string, string>, getAttribute(n: string) { return this.attrs[n] || null; }, setAttribute(n: string, v: string) { this.attrs[n] = v; } }));
		const selectors: string[] = [];
		class FakeRewriter {
			on(sel: string, h: H) { selectors.push(sel); if (selectors.length === 1) for (const el of els) h.element(el); return this; }
			transform(r: Response) { return r; }
		}
		fixOutline(new Response("<main></main>"), FakeRewriter as never);
		expect(selectors[0]?.split(",").every((x) => x.trim().startsWith("main h"))).toBe(true);
		expect(selectors[1]?.split(",").every((x) => x.trim().startsWith(".site-footer h"))).toBe(true);
		expect(els.map((e) => `${e.tagName}.${e.attrs.class}`)).toEqual(["h1.heading heading--h1", "h2.heading heading--h1", "h3."]);
	});

	it("knows when a page has no heading at all (then the page gets a visually hidden h1 with its title)", () => {
		expect(hasHeading([{ _type: "embed", html: "<div id=widget></div>" }])).toBe(false);
		expect(hasHeading([{ _type: "hero", heading: "Welcome" }])).toBe(true);
		expect(hasHeading([{ _type: "rich_text", body: [{ _type: "block", style: "h3" }] }])).toBe(true);
	});
});

describe("SEO rules (verify seo-rules)", () => {
	const ok = { headings: [{ level: 1, text: "Pilates in Portland" }, { level: 2, text: "Classes" }], seo: { title: "Pilates Classes in Portland – Example Studio", description: "Reformer and mat Pilates classes for every level in Portland. Book your first class online today." } };
	it("passes a clean page", () => expect(seoRules(ok)).toEqual([]));
	it("flags what the SEO audit flagged", () => {
		const r = seoRules({ headings: [{ level: 1, text: "A" }, { level: 1, text: "B" }, { level: 3, text: "C" }], seo: { title: "Member Login", description: "Log in to book and manage your classes" } });
		expect(r.map((x) => `${x.level} ${x.rule}`)).toEqual(["warning h1-multiple", "warning heading-skip", "warning title-short", "note desc-short"]);
		expect(seoRules({ headings: [], seo: { title: ok.seo.title, description: ok.seo.description } }).map((x) => x.rule)).toEqual(["h1-missing"]);
	});
});

describe("/llms.txt", () => {
	it("lists the site's public pages and posts as Markdown links", () => {
		const t = llmsTxt({ name: "Example Studio", tagline: "Pilates in Portland" }, [{ title: "Home", url: "https://studio.example/" }, { title: "FAQ [new]", url: "https://studio.example/faq/", description: "Answers  to common\nquestions." }], [{ title: "Spring schedule", url: "https://studio.example/spring/" }]);
		expect(t).toBe("# Example Studio\n\n> Pilates in Portland\n\n## Pages\n\n- [Home](https://studio.example/)\n- [FAQ new](https://studio.example/faq/): Answers to common questions.\n\n## Posts\n\n- [Spring schedule](https://studio.example/spring/)\n");
	});
	it("leaves out noindex and password-protected entries", () => {
		expect(llmsListed("noindex, follow", {})).toBe(false);
		expect(llmsListed(undefined, { access_password: "x" })).toBe(false);
		expect(llmsListed("index, follow", {})).toBe(true);
	});
});

describe("overrides.ts seo", () => {
	it("takes a rewritten title/description per path, with the owner's reason", () => {
		const o = overridesSchema.parse({ seo: { "/account/": { title: "Member Login – Example Studio", description: "Sign in to book classes.", reason: "SEO audit 2026-11-21" } } });
		expect(o.seo["/account/"]?.title).toBe("Member Login – Example Studio");
		expect(() => overridesSchema.parse({ seo: { "/account/": { title: "x" } } })).toThrow();
	});
});
