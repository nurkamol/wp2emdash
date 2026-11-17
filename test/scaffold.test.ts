import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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
		expect(BLOCK_TYPES).toHaveLength(20);
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

	it("drops unknown keys and invalid select values, and says so", () => {
		const r = conformToBlockType({ _type: "section_faq", _version: 1, _key: "a", heading: "Q", spacing: "huge", nope: 1, items: [{ question: "q", answer: "a", extra: true }] });
		expect(r.value).toEqual({ _type: "section_faq", _version: 1, _key: "a", heading: "Q", items: [{ question: "q", answer: "a" }] });
		expect(r.dropped).toEqual(["spacing=huge (not an option)", "nope=1", "items[].extra"]);
	});

	it("keeps two same-level leading headings as heading + body, smaller-before-bigger as eyebrow", () => {
		const k = new Keys("h");
		const b = (style: "h2" | "h3" | "h5" | "normal", text: string) => ({ _type: "block" as const, _key: k.next(), style, children: [{ _type: "span" as const, _key: k.next(), text, marks: [] }], markDefs: [] });
		const sec = (body: ReturnType<typeof b>[]) => ({ type: "rich_text" as const, theme: { tone: "light" as const }, spacing: "normal" as const, sourceRef: { adapter: "wpbakery" as const, path: "r", rawHash: "x" }, fields: { body, width: "normal" as const, align: "left" as const, buttons: [] } });
		const two = sectionToBlock(sec([b("h2", "Move with purpose."), b("h2", "Second"), b("normal", "Text")]) as never, "a", media);
		expect([two.heading, two.eyebrow]).toEqual(["Move with purpose.", undefined]);
		expect((two.body as { children: { text: string }[] }[]).map((x) => x.children[0]?.text)).toEqual(["Second", "Text"]);
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
