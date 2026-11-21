import { describe, expect, it } from "vitest";
import { analyze, extract, fullTitle, looksEnglish, readingGrade, syllables } from "../packages/seo/src/analyze.js";
import { seoPlugin } from "../packages/seo/src/index.js";
import { createPlugin } from "../packages/seo/src/plugin/index.js";

const pt = (style: string, text: string, href?: string) => ({ _type: "block", style, children: [{ _type: "span", text }], markDefs: href ? [{ _type: "link", href }] : [] });
const img = (id: string, alt?: string) => ({ id, provider: "local", mimeType: "image/webp", filename: `${id}.webp`, ...(alt ? { alt } : {}) });
const long = Array.from({ length: 320 }, (_, k) => (k % 9 === 0 ? "reformer" : "word")).join(" ");
const content = [
	{ _type: "section_hero", heading: "Reformer Pilates in Springfield", heading_level: "h1", body: [pt("normal", `Reformer pilates classes for every level. ${long}`, "/book/")], buttons: [{ label: "Book", url: "/book/" }], media: img("A1", "Studio") },
	{ _type: "section_media_text", heading: "Our studio", heading_level: "h2", body: [pt("h4", "Skipped level"), pt("normal", "Visit https://maps.example.com", "https://maps.example.com")], media: img("A2"), media_2: img("A3") },
];
const base = { title: "Reformer Pilates", slug: "reformer-pilates", content, siteName: "Acme Clinic", separator: "-", productionUrl: "https://acme.example", others: [] as { title: string; description?: string | null }[] };
const by = (a: ReturnType<typeof analyze>, id: string) => a.checks.find((c) => c.id === id);

describe("SEO analysis", () => {
	it("extracts headings, text, images and links from sections", () => {
		const x = extract(content);
		expect(x.headings.map((h) => `${h.level}:${h.text}`)).toEqual(expect.arrayContaining(["1:Reformer Pilates in Springfield", "4:Skipped level", "2:Our studio"]));
		expect(x.headings.filter((h) => h.level === 1)).toHaveLength(1);
		expect(x.images.map((i) => i.id)).toEqual(["A1", "A2", "A3"]);
		expect(x.links).toEqual(expect.arrayContaining(["/book/", "https://maps.example.com"]));
	});
	it("scores title and description lengths and reports missing ones", () => {
		const none = analyze(base);
		expect(fullTitle("Reformer Pilates", "Acme Clinic", "-")).toBe("Reformer Pilates - Acme Clinic");
		expect(by(none, "title")?.status).toBe("good");
		expect(by(none, "description")?.status).toBe("bad");
		expect(by(none, "title-set")?.status).toBe("info");
		const longDesc = analyze({ ...base, seo: { title: "x".repeat(80), description: "y".repeat(170) } });
		expect([by(longDesc, "title")?.status, by(longDesc, "description")?.status]).toEqual(["bad", "warn"]);
		expect(longDesc.serp.titleCut && longDesc.serp.descriptionCut).toBe(true);
		const ok = analyze({ ...base, seo: { description: "d".repeat(140) } });
		expect(by(ok, "description")?.status).toBe("good");
	});
	it("finds duplicates, heading problems, missing alt text and links", () => {
		const a = analyze({ ...base, seo: { description: "Same text here for both pages of the site, long enough to count." }, others: [{ title: "Reformer Pilates - Acme Clinic", description: "Same text here for both pages of the site, long enough to count." }], altOf: (id) => (id === "A2" ? "Room" : undefined) });
		expect(by(a, "unique")?.status).toBe("bad");
		expect(by(a, "h1")?.status).toBe("good");
		expect(by(a, "heading-order")?.status).toBe("warn");
		expect(by(a, "alt")?.detail).toMatch(/^1 of 3 images/);
		expect(by(a, "links")?.detail).toBe("2 internal, 1 external.");
		expect(by(a, "length")?.status).toBe("good");
		const noH1 = analyze({ ...base, content: [{ _type: "section_rich_text", heading: "Hi", heading_level: "h2" }] });
		expect(by(noH1, "h1")?.status).toBe("bad");
	});
	it("checks the focus keyword where it matters and how often", () => {
		const a = analyze({ ...base, seo: { title: "Reformer Pilates Classes", description: "Book reformer pilates classes in Springfield with expert coaches today." }, focusKeyword: "Reformer Pilates" });
		expect(by(a, "keyword")?.status).toBe("good");
		expect(by(a, "keyword-density")?.status).toBe("good");
		expect(by(a, "keyword-density")?.detail).toMatch(/^\d+ times \(\d\.\d%\)/);
		const missing = analyze({ ...base, focusKeyword: "yoga" });
		expect(by(missing, "keyword")?.status).toBe("bad");
		expect(by(missing, "keyword-density")?.status).toBe("bad");
	});
	it("flags hidden pages, foreign canonicals and missing sharing images", () => {
		const a = analyze({ ...base, seo: { noIndex: true, canonical: "https://other.example/x/" } });
		expect(by(a, "index")?.status).toBe("warn");
		expect(by(a, "canonical")?.status).toBe("warn");
		expect(by(a, "social")?.status).toBe("warn");
		expect(by(analyze({ ...base, ogCards: true }), "social")?.status).toBe("good");
		expect(analyze(base).score).toBeGreaterThan(0);
	});
});

describe("SEO content checks: length, repetition, reading level", () => {
	// n distinct words (no repeats), so only the words we add on purpose can dominate.
	const filler = (n: number) => Array.from({ length: n }, (_, k) => `term${String.fromCharCode(97 + (k % 26))}${Math.floor(k / 26)}`).join(" ");
	const page = (text: string, slug = "services", extra: Partial<Parameters<typeof analyze>[0]> = {}) => analyze({ ...base, slug, content: [{ _type: "section_hero", heading: "Services", heading_level: "h1", body: [pt("normal", text)] }], ...extra });

	it("grades text length: bad under 150 words, warn under 300, good from 300", () => {
		expect(by(page(filler(99)), "length")?.status).toBe("bad");
		expect(by(page(filler(99)), "length")?.detail).toMatch(/^Only 100 words.*Add at least 200 words/);
		expect(by(page(filler(199)), "length")?.status).toBe("warn");
		expect(by(page(filler(299)), "length")?.status).toBe("good");
		expect(page(filler(99)).thin).toBe(true);
		expect(page(filler(299)).thin).toBe(false);
	});
	it("only notes length on pages that are short by nature, and leaves hidden pages off the thin list", () => {
		for (const slug of ["contact", "privacy-policy", "thank-you", "legal/terms"]) {
			const a = page(filler(20), slug);
			expect([slug, by(a, "length")?.status, a.thin]).toEqual([slug, "info", false]);
		}
		expect(by(page(filler(20), "contact-lens-guide"), "length")?.status).toBe("bad");
		expect(page(filler(20), "services", { seo: { noIndex: true } }).thin).toBe(false);
	});
	it("flags one overused word, but not on tiny pages or when it is the focus keyword", () => {
		const stuffed = `${filler(89)} ${"pilates ".repeat(10)}`; // + the heading: 100 words
		const a = page(stuffed);
		expect(by(a, "repetition")?.status).toBe("warn");
		expect(by(a, "repetition")?.detail).toMatch(/^“pilates” is 10\.0% of the text \(10 times\)/);
		expect(by(page(`${filler(90)} ${"pilates ".repeat(3)}`), "repetition")?.status).toBe("info");
		// The 37-word home page that an audit called keyword stuffing: too little text to judge.
		const tiny = page(`${filler(31)} pilates pilates pilates`);
		expect(by(tiny, "repetition")).toMatchObject({ status: "info", detail: expect.stringMatching(/^Too little text to judge \(35 words\)/) });
		expect(by(page(stuffed, "services", { focusKeyword: "Pilates classes" }), "repetition")?.status).toBe("info");
		// Stop words never count as overused.
		expect(by(page(`${filler(80)} ${"the and of ".repeat(10)}`), "repetition")?.status).toBe("info");
	});
	it("estimates the Flesch–Kincaid grade on known sentences", () => {
		expect(syllables("cat")).toBe(1);
		expect(syllables("reformer")).toBe(3);
		expect(syllables("rehabilitation")).toBe(6);
		const easy = readingGrade(["The cat sat on the mat. We like our studio. You can book a class with us today."]);
		expect(easy.sentences).toBe(3);
		expect(easy.grade).toBeLessThan(4);
		const hard = readingGrade(["Comprehensive individualized rehabilitation methodologies facilitate neuromuscular reeducation, proprioceptive enhancement and postural stabilization through evidence-based therapeutic interventions administered by credentialed practitioners."]);
		expect(hard.grade).toBeGreaterThan(17);
		// Text blocks without a full stop (labels, buttons) still end a sentence.
		expect(readingGrade(["Book now", "Prices"]).sentences).toBe(2);
	});
	it("warns above grade 12 with plain advice, notes it otherwise", () => {
		const hardText = Array.from({ length: 4 }, () => "Comprehensive individualized rehabilitation methodologies facilitate neuromuscular reeducation and postural stabilization for our clients with the support of credentialed practitioners.").join(" ");
		const hard = by(page(hardText), "reading");
		expect(hard?.status).toBe("warn");
		expect(hard?.detail).toMatch(/grade \d+ \(hard.*shorter sentences/);
		const easyText = Array.from({ length: 6 }, () => "You can book a class with us. We will help you feel strong. It is fun and easy.").join(" ");
		expect(by(page(easyText), "reading")).toMatchObject({ status: "info", detail: expect.stringMatching(/easy to read/) });
		expect(by(page("Book a class with us today."), "reading")?.detail).toBe("Too little text to judge.");
	});
	it("skips the reading level on non-English pages", () => {
		const es = "Ofrecemos clases de pilates para todos los niveles en nuestro estudio. Reserve hoy su primera clase con nuestros instructores certificados y descubra la diferencia.";
		expect(looksEnglish(es)).toBe(false);
		expect(by(page(es.repeat(3)), "reading")).toBeUndefined();
		const en = Array.from({ length: 6 }, () => "You can book a class with us. We will help you feel strong.").join(" ");
		expect(looksEnglish(en)).toBe(true);
		expect(by(page(en, "services", { lang: "de-DE" }), "reading")).toBeUndefined();
		expect(by(page(en, "services", { lang: "en-GB" }), "reading")).toBeDefined();
		expect(by(page("Hola.", "services", { lang: "es" }), "reading")).toBeUndefined();
	});
	it("only scores the new checks when they warn", () => {
		const ok = page(filler(320));
		expect(by(ok, "repetition")?.status).toBe("info");
		const stuffed = page(`${filler(300)} ${"pilates ".repeat(20)}`);
		expect(stuffed.score).toBeLessThan(ok.score);
	});
});

describe("SEO panel plugin", () => {
	const items = [
		{ id: "P1", slug: "reformer-pilates", status: "published", data: { title: "Reformer Pilates", content }, seo: { title: null, description: "d".repeat(140), image: null, canonical: null, noIndex: false } },
		{ id: "P2", slug: "about", status: "published", data: { title: "About", content: [] }, seo: { title: "About us", description: "d".repeat(140), image: null, canonical: null, noIndex: false } },
	];
	const kv = new Map<string, unknown>();
	const ctx = (input: unknown) => ({ input, ui: { entry: { collection: "pages", id: "P1" } }, kv: { get: async (k: string) => kv.get(k) ?? null, set: async (k: string, v: unknown) => void kv.set(k, v) }, content: { get: async (_c: string, id: string) => items.find((i) => i.id === id) ?? null, list: async () => ({ items }) }, media: { get: async () => null }, site: { name: "Acme Clinic" } });
	const plugin = createPlugin({ productionUrl: "https://acme.example", titleSeparator: "-" }) as unknown as { capabilities: string[]; admin: { editorPanels: { id: string; collections: string[]; draft: unknown }[] }; routes: { panel: { permission: string; handler: (c: unknown) => Promise<{ blocks: Record<string, any>[]; toast?: { message: string } }> } } };
	it("declares a draft-reading editor panel for pages, usable by contributors", () => {
		expect(seoPlugin({ productionUrl: "https://acme.example" })).toMatchObject({ id: "site-seo", entrypoint: "@wp2emdash/seo/plugin" });
		expect(plugin.capabilities).toEqual(["content:read", "media:read", "media:metadata:write", "admin.editor-draft:read", "taxonomies:read"]);
		expect(plugin.admin.editorPanels[0]).toMatchObject({ id: "seo", collections: ["pages"], draft: { read: { fields: ["title", "content"] } } });
		expect(plugin.routes.panel.permission).toBe("content:read_drafts");
	});
	it("shows a score, the Google preview and the checklist; finds the duplicate description", async () => {
		const r = await plugin.routes.panel.handler(ctx({ type: "panel_load" }));
		expect(r.blocks[0]).toMatchObject({ type: "banner" });
		expect(r.blocks.find((b) => b.type === "context")?.text).toBe("acme.example › reformer-pilates");
		const lines = r.blocks.filter((b) => b.type === "section").map((b) => b.text as string);
		expect(lines.some((t) => t.startsWith("✗ Unique title and description"))).toBe(true);
		expect(r.blocks.find((b) => b.type === "accordion")?.label).toMatch(/^Passed checks \(\d+\)$/);
	});
	it("analyses the unsaved draft and stores the focus keyword", async () => {
		const draft = await plugin.routes.panel.handler(ctx({ type: "block_action", action_id: "check-draft", draft: { fields: { title: "Draft title", content: [] } } }));
		expect(draft.blocks[0]?.description).toMatch(/unsaved changes/);
		const kw = await plugin.routes.panel.handler(ctx({ type: "form_submit", action_id: "keyword", values: { keyword: "reformer pilates" } }));
		expect(kv.get("kw:pages:P1")).toBe("reformer pilates");
		expect(kw.toast?.message).toBe("Focus keyword saved.");
		const all = JSON.stringify(kw.blocks);
		expect(all).toContain("Focus keyword “reformer pilates”");
	});
});
