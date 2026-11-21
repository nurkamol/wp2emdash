import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { adaptGutenberg } from "../src/adapters/gutenberg/index.js";
import { adaptWpbakery } from "../src/adapters/wpbakery/index.js";
import { Keys } from "../src/ir/portable-text.js";
import { fluentFormToDefinition } from "../src/scaffold/forms.js";
import { applyStackBreakpoint, fluid, stackBreakpoint, toHex } from "../src/scaffold/generate.js";
import { routeToSlug } from "../src/scaffold/seed.js";
import { BLOCK_TYPES } from "../src/starter/library.js";
import { conformToBlockType, ptToMd, sectionToBlock, splitHeadingBlocks } from "../src/targets/emdash/blocks.js";

const popupFor = () => undefined;
const media = (m: { wpId?: number; url?: string } | undefined) => (m ? { $media: { url: m.url ?? `https://x.test/${m.wpId}.jpg`, filename: "f.jpg" } } : undefined);

describe("section library", () => {
	it("has one block type per IR section type, all prefixed section_", () => {
		expect(BLOCK_TYPES).toHaveLength(23);
		expect(BLOCK_TYPES.every((b) => b.slug.startsWith("section_") && b.versions[0]?.fields.length)).toBe(true);
	});

	it("repeater sub-fields use only what EmDash 1.5 accepts", () => {
		const allowed = new Set(["slug", "label", "type", "required", "options"]);
		for (const b of BLOCK_TYPES)
			for (const f of b.versions[0]?.fields ?? [])
				if (f.type === "repeater") for (const sf of (f.validation?.subFields ?? []) as Record<string, unknown>[]) expect(Object.keys(sf).every((k) => allowed.has(k)), `${b.slug}.${f.slug}`).toBe(true);
	});
});

describe("IR → EmDash blocks", () => {
	it("converts every WPBakery fixture into values that conform to the block types", () => {
		const dir = join(import.meta.dirname, "fixtures", "wpbakery");
		for (const file of readdirSync(dir)) {
			const { sections } = adaptWpbakery(readFileSync(join(dir, file), "utf8"), { kind: "page", keys: new Keys("t"), popupFor, postCount: 0 });
			sections.forEach((s, i) => {
				const drops: string[] = [];
				const v = sectionToBlock(s, `k${i}`, media, (d) => drops.push(...d));
				expect(conformToBlockType(v).dropped, `${file} ${s.type}`).toEqual([]);
				// only embed variants (duplicating the provider field) may be dropped
				expect(drops.filter((d) => !(s.type === "embed" && d.startsWith("variant="))), `${file} ${s.type}`).toEqual([]);
			});
		}
	});

	it("converts audio and latest-posts sections into values that conform to their block types", () => {
		const dir = join(import.meta.dirname, "fixtures", "gutenberg");
		const terms: Record<string, string> = { "category:7": "news", "category:9": "studio-life" };
		const types = new Set<string>();
		for (const file of ["file-audio.html", "posts-list.html"]) {
			const src = readFileSync(join(dir, file), "utf8").replace(/^<!-- fixture \{.*?\} -->\n?/, "");
			const { sections } = adaptGutenberg(src, { kind: "page", keys: new Keys("t"), popupFor, postCount: 12, termSlug: (tax, id) => terms[`${tax}:${id}`] });
			sections.forEach((s, i) => {
				types.add(s.type);
				const drops: string[] = [];
				const v = sectionToBlock(s, `k${i}`, media, (d) => drops.push(...d));
				expect(conformToBlockType(v).dropped, `${file} ${s.type}`).toEqual([]);
				expect(drops, `${file} ${s.type}`).toEqual([]);
				if (s.type === "audio") expect(v.audio).toBeDefined();
				if (s.type === "posts_list" && s.fields.categories.length) expect(v.categories).toBe(s.fields.categories.join(", "));
			});
		}
		expect([...types]).toEqual(expect.arrayContaining(["audio", "posts_list"]));
	});

	it("drops unknown keys and invalid select values, and says so", () => {
		const r = conformToBlockType({ _type: "section_faq", _version: 1, _key: "a", heading: "Q", spacing: "huge", nope: 1, items: [{ question: "q", answer: "a", extra: true }] });
		expect(r.value).toEqual({ _type: "section_faq", _version: 1, _key: "a", heading: "Q", items: [{ question: "q", answer: "a" }] });
		expect(r.dropped).toEqual(["spacing=huge (not an option)", "nope=1", "items[].extra"]);
	});

	it("keeps two same-level leading headings together in the body, smaller-before-bigger as eyebrow", () => {
		const k = new Keys("h");
		const b = (style: "h2" | "h3" | "h5" | "normal", text: string) => ({ _type: "block" as const, _key: k.next(), style, children: [{ _type: "span" as const, _key: k.next(), text, marks: [] }], markDefs: [] });
		const sec = (body: ReturnType<typeof b>[]) => ({ type: "rich_text" as const, theme: { tone: "light" as const }, spacing: "normal" as const, sourceRef: { adapter: "wpbakery" as const, path: "r", rawHash: "x" }, fields: { body, width: "normal" as const, align: "left" as const, buttons: [] } });
		const two = sectionToBlock(sec([b("h2", "Move with purpose."), b("h2", "Second"), b("normal", "Text")]) as never, "a", media);
		// A pair of same-level headings is one statement in two lines: both stay in the body, styled alike, marks kept.
		expect([two.heading, two.eyebrow]).toEqual([undefined, undefined]);
		expect((two.body as { children: { text: string }[] }[]).map((x) => x.children[0]?.text)).toEqual(["Move with purpose.", "Second", "Text"]);
		const eyebrow = sectionToBlock(sec([b("h5", "Excellence"), b("h3", "Title"), b("normal", "Text")]) as never, "b", media);
		expect([eyebrow.eyebrow, eyebrow.heading, eyebrow.heading_level]).toEqual(["Excellence", "Title", "h3"]);
	});

	it("splits heading blocks and writes the Markdown subset", () => {
		const k = new Keys();
		const b = (style: "h3" | "normal", text: string) => ({ _type: "block" as const, _key: k.next(), style, children: [{ _type: "span" as const, _key: k.next(), text, marks: [] }], markDefs: [] });
		expect(splitHeadingBlocks([b("normal", "Excellence"), b("h3", "Title")])).toEqual({ eyebrow: "Excellence", heading: "Title", heading_level: "h3" });
		const linked = { _type: "block" as const, _key: "p", style: "normal" as const, children: [{ _type: "span" as const, _key: "s1", text: "See ", marks: [] }, { _type: "span" as const, _key: "s2", text: "policy", marks: ["strong", "l1"] }], markDefs: [{ _type: "link" as const, _key: "l1", href: "/p/" }] };
		const item = { _type: "block" as const, _key: "li", style: "normal" as const, listItem: "bullet" as const, level: 1, children: [{ _type: "span" as const, _key: "s3", text: "One", marks: [] }], markDefs: [] };
		expect(ptToMd([linked, item])).toBe("See [**policy**](/p/)\n\n- One");
	});
});

describe("scaffold generators", () => {
	it("makes fluid sizes and hex colours", () => {
		expect(fluid(16, 16)).toBe("16px");
		expect(fluid(46.8, 86.4)).toBe("clamp(46.8px, 32.09px + 3.771vw, 86.4px)");
		expect(toHex("rgb(244, 236, 226)")).toBe("#f4ece2");
		expect(toHex("rgba(0, 0, 0, 0.5)")).toBe("rgba(0, 0, 0, 0.5)");
	});

	it("picks the stacking breakpoint from the theme's CSS and rewrites marked queries", () => {
		const d = (bps: number[]) => [{ breakpoints: bps }] as never;
		expect(stackBreakpoint(d([480, 768, 999, 1300]))).toBe(1000);
		expect(stackBreakpoint(d([600, 1024]))).toBe(1024);
		expect(stackBreakpoint(d([767]))).toBe(768);
		expect(stackBreakpoint(d([]))).toBe(900);
		expect(applyStackBreakpoint("@media (min-width: 900px) /* stack */ {} @media (min-width: 600px) and (max-width: 899.98px) /* stack-below */ {} @media (min-width: 900px) {}", 1000)).toBe("@media (min-width: 1000px) {} @media (min-width: 600px) and (max-width: 999.98px) {} @media (min-width: 900px) {}");
	});

	it("maps routes to EmDash slugs", () => {
		expect(routeToSlug("/")).toBe("home");
		expect(routeToSlug("/services/physio/")).toBe("services/physio");
	});

	it("converts a Fluent Forms definition (name group, columns, custom submit)", () => {
		const def = fluentFormToDefinition(
			{
				id: "9",
				title: "Contact",
				form: {
					form_fields: {
						fields: [
							{ element: "input_name", fields: { first_name: { attributes: { name: "first_name", placeholder: "First*" }, settings: { label: "First Name", validation_rules: { required: { value: true } } } }, middle_name: { attributes: { name: "middle_name" }, settings: { visible: false } } } },
							{ element: "container", columns: [{ fields: [{ element: "input_email", attributes: { name: "email" }, settings: { label: "Email", validation_rules: { required: { value: true } } } }] }, { fields: [{ element: "phone", attributes: { name: "phone" }, settings: { label: "Phone" } }] }] },
							{ element: "select", attributes: { name: "topic" }, settings: { label: "Topic", advanced_options: [{ label: "Pilates" }, { label: "Physio" }] } },
							{ element: "custom_submit_button", settings: { button_ui: { text: "Book" } } },
							{ element: "mystery_widget", settings: {} },
						],
					},
				},
				settings: { formSettings: [{ value: { confirmation: { messageToShow: "<p>Thanks!</p>" } } }] },
			},
			true,
		);
		expect(def.fields.map((f) => [f.name, f.type, !!f.required, !!f.half])).toEqual([
			["first_name", "text", true, false],
			["email", "email", true, true],
			["phone", "tel", false, true],
			["topic", "select", false, false],
		]);
		expect(def.submitLabel).toBe("Book");
		expect(def.successMessage).toBe("Thanks!");
		expect(def.sensitive).toBe(true);
		expect(def.warnings).toEqual(['field "mystery_widget" not supported; rebuild by hand']);
	});
});

describe("form field tokens", () => {
	const design = (formField?: Record<string, unknown>) =>
		["desktop", "mobile"].map((viewport) => ({ url: "https://x.test/", viewport, fonts: [], colors: [{ value: "rgb(244, 236, 226)", count: 9, usage: "background" }], typography: {}, buttons: [], containerWidths: [], breakpoints: [], header: null, footer: null, cssVariables: {}, ...(formField ? { formField } : {}) })) as never;

	it("takes the source field's look and hides labels the source hides", async () => {
		const { buildTokens } = await import("../src/scaffold/generate.js");
		const { css } = buildTokens(design({ background: "rgb(255, 255, 255)", border: "none", borderTop: "none", radius: 0, height: 48, fontSize: 14, paddingInline: 12, labelsHidden: true }));
		expect(css).toContain("--color-input-bg: #ffffff;");
		expect(css).toContain("--input-border: 0;");
		expect(css).toContain("--input-height: 48px;");
		expect(css).toContain("--radius-input: 0px;");
		expect(css).toMatch(/\.field__label \{ position: absolute;/);
	});

	it("keeps the defaults when the source has no form", async () => {
		const { buildTokens } = await import("../src/scaffold/generate.js");
		const { css } = buildTokens(design());
		expect(css).toContain("--radius-input: 8px;");
		expect(css).not.toContain("--input-height");
		expect(css).not.toContain(".field__label");
	});
});

describe("gutter tokens", () => {
	const designs = (g: Record<string, number>) => Object.entries(g).map(([viewport, gutter]) => ({ url: "https://x.test/", viewport, fonts: [], colors: [{ value: "rgb(244, 236, 226)", count: 9, usage: "background" }], typography: {}, buttons: [], containerWidths: [], breakpoints: [], header: null, footer: null, cssVariables: {}, gutter })) as never;

	it("uses the tablet's share of the width on phones when the phone gutter is that share (whole-pixel capture)", async () => {
		const { buildTokens } = await import("../src/scaffold/generate.js");
		// 46px at 768 = 5.99vw; 23px at 390 is 5.99vw within rounding (23.4px): phones get the share too.
		expect(buildTokens(designs({ desktop: 100, mobile: 23, tablet: 46 })).css).toContain("@media (min-width: 0px) and (max-width: 999.98px) { :root { --gutter: 5.99vw; } }");
		// 21px on phones vs 76px at 768 (9.9vw): phones keep their own gutter.
		expect(buildTokens(designs({ desktop: 100, mobile: 21, tablet: 76 })).css).toContain("@media (min-width: 691px) and (max-width: 999.98px) { :root { --gutter: 9.896vw; } }");
	});
});

describe("section library", () => {
	it("has unique field slugs in every block type (EmDash refuses duplicates)", async () => {
		const { BLOCK_TYPES } = await import("../src/starter/library.js");
		for (const bt of BLOCK_TYPES) {
			const slugs = (bt.versions.at(-1)?.fields ?? []).map((f) => (f as { slug: string }).slug);
			const dupes = slugs.filter((s, i) => slugs.indexOf(s) !== i);
			expect(dupes, bt.slug).toEqual([]);
		}
	});
});

describe("more buttons than a section holds", () => {
	it("keeps the first three as buttons and turns the rest into links after the text", () => {
		const k = new Keys("o");
		const btn = (label: string, href: string) => ({ label, href, style: "link" as const });
		const sec = { type: "rich_text" as const, theme: { tone: "light" as const }, spacing: "normal" as const, sourceRef: { adapter: "bricks" as const, path: "r", rawHash: "x" }, fields: { body: [{ _type: "block" as const, _key: k.next(), style: "normal" as const, children: [{ _type: "span" as const, _key: k.next(), text: "Links", marks: [] }], markDefs: [] }], width: "normal" as const, align: "left" as const, buttons: [btn("Home", "/"), btn("Privacy", "/privacy/"), btn("Terms", "/terms/"), btn("Waiver", "/waiver/"), btn("Contact", "/contact/")] } };
		const b = sectionToBlock(sec as never, "s1", media);
		expect((b.buttons as { label: string }[]).map((x) => x.label)).toEqual(["Home", "Privacy", "Terms"]);
		const last = (b.body as { children: { text: string }[]; markDefs: { href: string }[] }[]).at(-1);
		expect(last?.children.map((c) => c.text).join("")).toBe("Waiver · Contact");
		expect(last?.markDefs.map((m) => m.href)).toEqual(["/waiver/", "/contact/"]);
	});
});
