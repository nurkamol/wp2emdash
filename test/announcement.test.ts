/**
 * Announcement bar: detection across saved pages, transform → ir/partials/announcement.json, load/seed mapping,
 * starter rendering contract and text conservation. Fixtures are synthetic (test/fixtures/announcement).
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { kitConfigSchema } from "../src/config/schema.js";
import { overridesSchema } from "../src/config/overrides.js";
import { sitePaths } from "../src/core/paths.js";
import type { IrPage, IrSite } from "../src/ir/schema.js";
import { irPage } from "../src/ir/schema.js";
import { runTransform } from "../src/phases/transform.js";
import { buildSeed } from "../src/scaffold/seed.js";
import { ANNOUNCEMENT_BLOCK, BLOCK_TYPES } from "../src/starter/library.js";
import { blockKey, conformToBlockType, sectionToBlock } from "../src/targets/emdash/blocks.js";
import { Keys } from "../src/ir/portable-text.js";
import { accessibleColours, announcementDoc, detectAnnouncement, normaliseColour } from "../src/transform/announcement.js";
import { conservation, irText, sourceText } from "../src/transform/coverage.js";
import { announcementVersion, readableText } from "../starter/src/utils/announcement.js";

const fixture = (name: string) => readFileSync(join(import.meta.dirname, "fixtures", "announcement", `${name}.html`), "utf8");
const starter = (f: string) => readFileSync(join(import.meta.dirname, "..", "starter", "src", f), "utf8");
/** The Announcer fixture's bar as transform builds it. */
const doc = (): IrPage => announcementDoc(detectAnnouncement([{ name: "home", html: fixture("announcer") }]).best as NonNullable<ReturnType<typeof detectAnnouncement>["best"]>, new Keys("t"), (h) => h.replace("https://fixture.example", "") || "/");
const plain = (body: string) => `<!doctype html><html><body><header class="site-header"><a href="/">Fixture</a></header><main><h1>Plain page</h1><p>${body}</p></main></body></html>`;

describe("announcement detection", () => {
	it("normalises colours and finds the first solid one", () => {
		expect(normaliseColour("#FFF")).toBe("#ffffff");
		expect(normaliseColour("rgb(20, 24, 28)")).toBe("#14181c");
		expect(normaliseColour("rgba(0,0,0,0.5)")).toBeUndefined();
		expect(normaliseColour("#11223380")).toBeUndefined();
		expect(normaliseColour("white")).toBe("#ffffff");
	});

	it("rebuilds a known plugin bar on most pages; one shown on few pages is only reported", () => {
		const bar = fixture("announcer");
		const most = detectAnnouncement([{ name: "home", html: bar }, { name: "about", html: bar }, { name: "faq", html: plain("No bar here") }]);
		expect(most.best).toMatchObject({ plugin: "announcer", pages: 2, of: 3, confident: true, sticky: true, dismissible: true, sourceId: 42 });
		const few = detectAnnouncement([{ name: "home", html: bar }, { name: "a", html: plain("x") }, { name: "b", html: plain("y") }]);
		expect(few.best?.confident).toBe(false);
	});

	it("a class-name match is never confident, and script-injected bars are named", () => {
		const d = detectAnnouncement([{ name: "home", html: fixture("generic") }, { name: "about", html: fixture("generic") }]);
		expect(d.best).toMatchObject({ plugin: "generic", pages: 2, confident: false, text: "Free parking for members after 6pm. Read more" });
		// The menu row in the header and the card inside <main> are not bars.
		expect(d.all).toHaveLength(1);
		expect(d.scriptOnly).toEqual(["Hello Bar"]);
	});

	it("raises a failing text colour to WCAG AA and keeps the source value", () => {
		const r = accessibleColours({ background: "#f0c400", text: "#ffffff" });
		expect(r.colors.text).toBe("#000000");
		expect(r.source).toEqual({ text: "#ffffff" });
		expect(r.fixes[0]).toMatch(/1\.67:1; changed to #000000/);
		expect(accessibleColours({ background: "#222222", text: "#ffffff" }).fixes).toEqual([]);
	});

	it("overrides accept keep/drop and refuse the bar as a forced row type", () => {
		expect(overridesSchema.parse({}).announcement).toBe("auto");
		expect(overridesSchema.parse({ announcement: "keep" }).announcement).toBe("keep");
		expect(overridesSchema.safeParse({ elements: { "home:vc_row[0]": "announcement" } }).success).toBe(false);
	});
});

describe("announcement in the transform phase", () => {
	const dir = mkdtempSync(join(tmpdir(), "wp2emdash-announce-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const write = (file: string, data: unknown) => {
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
	};
	const post = (id: number, slug: string, title: string, content: string) => ({ id, post_type: "page", status: "publish", slug, title, content, excerpt: "", date_gmt: "", modified_gmt: "2026-11-01T00:00:00", parent: null, menu_order: 0, taxonomies: {}, meta: {} });
	const config = kitConfigSchema.parse({ slug: "s", name: "Fixture", source: { url: "https://fixture.example" }, target: { productionUrl: "https://fixture.example" } });

	/** A site whose two saved pages carry `barHtml` (or not), with page content matching the saved HTML. */
	const setup = (name: string, pageHtml: (i: number) => string, overrides?: string) => {
		const paths = sitePaths(name, dir);
		write(join(paths.raw, "extract.json"), {});
		write(join(paths.raw, "exporter", "options.json"), { blogname: "Fixture Studio", page_on_front: 1 });
		write(join(paths.raw, "exporter", "content", "page.json"), [post(1, "home", "Home", "<p>Welcome to the studio.</p>"), post(2, "about", "About", "<p>Welcome to the studio.</p>")]);
		write(join(paths.raw, "exporter", "content", "workshops.json"), []);
		write(join(paths.snapshot, "urls.json"), [{ path: "/", wp: { id: 1 } }, { path: "/about/", wp: { id: 2 } }, { path: "/workshops/" }, { path: "/book/" }, { path: "/parking/" }, { path: "/join/" }]);
		for (const [i, n] of ["home", "about"].entries()) {
			write(join(paths.snapshot, "pages", `${n}.json`), { wpId: i + 1, url: `https://fixture.example${i ? "/about/" : "/"}`, seo: {} });
			write(join(paths.snapshot, "html", `${n}.html`), pageHtml(i));
		}
		if (overrides) write(paths.overrides, overrides);
		return paths;
	};
	const read = <T>(paths: ReturnType<typeof sitePaths>, f: string) => JSON.parse(readFileSync(join(paths.ir, f), "utf8")) as T;
	const withBar = (html: string) => (i: number) => html.replace("<h1>Fixture Studio</h1><p>Welcome to the studio.</p>", `<h1>${i ? "About" : "Home"}</h1><p>Welcome to the studio.</p>`);

	it("writes ir/partials/announcement.json, lists it in site.json and counts its text in conservation", async () => {
		const paths = setup("announcer", withBar(fixture("announcer")));
		const checks = await runTransform({ config, paths, reporter: { runId: "t", emit: () => {} } });
		const site = read<IrSite>(paths, "site.json");
		expect(site.partials).toContainEqual({ role: "announcement", file: "partials/announcement.json" });
		const doc = read<IrPage>(paths, "partials/announcement.json");
		expect(irPage.safeParse(doc).success).toBe(true);
		expect(doc.source).toMatchObject({ slug: "announcement", type: "announcement", wpId: 42, builder: "html" });
		const s = doc.sections[0];
		expect(s?.type === "announcement" && s.fields.buttons.map((b) => b.href)).toEqual(["/book/", "https://partner.example/info"]);
		const cov = JSON.parse(readFileSync(join(paths.reports, "transform", "coverage.json"), "utf8")) as { documents: { file: string; conservation?: { missing: string[] } }[]; announcement: { rebuilt?: string } };
		expect(cov.announcement.rebuilt).toMatch(/^announcer `#ancr-42` on 2\/2 pages/);
		const home = cov.documents.find((d) => d.file === "pages/home.json");
		// "evening", "workshops", "seat" are only in the bar: found because the bar is in the IR.
		for (const w of ["evening", "workshops", "seat", "details"]) expect(home?.conservation?.missing).not.toContain(w);
		expect(checks.find((c) => c.id === "links")?.ok).toBe(true);
		expect(readFileSync(join(paths.reports, "transform", "coverage.md"), "utf8")).toMatch(/## Announcement bar[\s\S]*changed to #000000/);
	});

	it("reports an uncertain bar with its text and rebuilds it only when overrides say keep", async () => {
		const auto = setup("generic-auto", () => fixture("generic"));
		await runTransform({ config, paths: auto, reporter: { runId: "t", emit: () => {} } });
		expect(read<IrSite>(auto, "site.json").partials.some((p) => p.role === "announcement")).toBe(false);
		const cov = JSON.parse(readFileSync(join(auto.reports, "transform", "coverage.json"), "utf8")) as { notTransformed: string[] };
		expect(cov.notTransformed.some((n) => /Free parking for members.*possible announcement bar, not rebuilt \(matched by class name only\).*announcement: "keep"/.test(n))).toBe(true);
		expect(cov.notTransformed.some((n) => /Hello Bar is loaded by a script/.test(n))).toBe(true);

		const keep = setup("generic-keep", () => fixture("generic"), `export default { announcement: "keep" };\n`);
		await runTransform({ config, paths: keep, reporter: { runId: "t", emit: () => {} } });
		expect(read<IrSite>(keep, "site.json").partials).toContainEqual({ role: "announcement", file: "partials/announcement.json" });

		const drop = setup("announcer-drop", withBar(fixture("announcer")), `export default { announcement: "drop" };\n`);
		await runTransform({ config, paths: drop, reporter: { runId: "t", emit: () => {} } });
		const dropped = JSON.parse(readFileSync(join(drop.reports, "transform", "coverage.json"), "utf8")) as { notTransformed: string[] };
		expect(dropped.notTransformed.some((n) => /overrides\.announcement is "drop"/.test(n))).toBe(true);
	});
});

describe("announcement in EmDash (load and seed)", () => {
	it("defines an editable block type: on/off, message, two buttons, colours, dismissible, sticky, schedule", () => {
		const bt = BLOCK_TYPES.find((b) => b.slug === ANNOUNCEMENT_BLOCK);
		const fields = bt?.versions[0]?.fields ?? [];
		expect(fields.map((f) => f.slug)).toEqual(["enabled", "message", "buttons", "bg_color", "text_color", "button_bg", "button_color", "dismissible", "sticky", "starts_at", "ends_at"]);
		expect(fields.find((f) => f.slug === "buttons")?.validation?.maxItems).toBe(2);
		expect(fields.find((f) => f.slug === "message")?.type).toBe("portableText");
	});

	it("maps the IR section to a block value that conforms (nothing dropped)", () => {
		const d = doc();
		const s = d.sections[0] as IrPage["sections"][number];
		const drops: string[][] = [];
		const block = sectionToBlock(s, blockKey("announcement", 0, s.type), () => undefined, (x) => drops.push(x));
		expect(drops).toEqual([]);
		expect(block).toMatchObject({ _type: "section_announcement", _key: "announcement-0-announcement", enabled: true, bg_color: "#f0c400", text_color: "#000000", button_bg: "#14181c", button_color: "#ffffff", dismissible: true, sticky: true, starts_at: "2026-01-01T00:00:00.000Z", ends_at: "2027-01-01T00:00:00.000Z" });
		expect(block.buttons).toEqual([{ label: "Book a seat", url: "/book/", style: "primary", new_tab: false }, { label: "Details", url: "https://partner.example/info", style: "secondary", new_tab: true }]);
		expect(conformToBlockType(block).dropped).toEqual([]);
	});

	it("is seeded as the site part with slug announcement", () => {
		const d = doc();
		const site: IrSite = { version: 1, title: "Fixture", menus: [], partials: [{ role: "announcement", file: "partials/announcement.json" }], popups: [] };
		const seed = buildSeed({ name: "Fixture", site, pages: [], partials: [d], popups: [], media: () => undefined, titleSeparator: "-", forms: [], includeContent: true }) as { content: { site_parts: { slug: string; data: { content: { _type: string }[] } }[] } };
		expect(seed.content.site_parts[0]?.slug).toBe("announcement");
		expect(seed.content.site_parts[0]?.data.content[0]?._type).toBe("section_announcement");
	});
});

describe("announcement in the starter", () => {
	it("keeps readable colours and changes failing ones", () => {
		expect(readableText("#222222", "#ffffff")).toBe("#ffffff");
		expect(readableText("#f0c400", "#ffffff")).toBe("#000000");
		expect(readableText("#1d3557", undefined)).toBe("#ffffff");
		expect(readableText("var(--color-accent)", "#fff")).toBe("#fff");
	});

	it("versions a dismissal by what the bar says, not by block keys", () => {
		const msg = (text: string, key: string) => [{ _type: "block", _key: key, children: [{ _type: "span", _key: `${key}s`, text }] }];
		expect(announcementVersion({ message: msg("Hello", "a") })).toBe(announcementVersion({ message: msg("Hello", "b") }));
		expect(announcementVersion({ message: msg("Hello", "a") })).not.toBe(announcementVersion({ message: msg("Hello!", "a") }));
	});

	it("renders above the header on every page, as a labelled region, server-side with a pre-paint script", () => {
		const base = starter("layouts/Base.astro");
		expect(base.indexOf("<Announcement")).toBeGreaterThan(base.indexOf('class="skip-link"'));
		expect(base.indexOf("<Announcement")).toBeLessThan(base.indexOf("<SiteHeader"));
		expect(starter("utils/chrome.ts")).toContain('getEmDashEntry("site_parts", "announcement")');
		const c = starter("components/Announcement.astro");
		expect(c).toMatch(/<section class="announcement" aria-label="Announcement"/);
		expect(c).toMatch(/<button type="button" class="announcement__close" data-announcement-close aria-label="Close announcement">/);
		// The pre-paint script is a fixed file, inlined verbatim and allowed by the CSP through its hash (test/perf.test.ts).
		expect(c).toContain('import announcementScript from "../scripts/inline/announcement.js?raw";');
		expect(c).toContain("<script is:inline set:html={announcementScript} />");
		expect(starter("scripts/inline/announcement.js")).toMatch(/localStorage\.getItem\("announcement:" \+ b\.dataset\.version\)[\s\S]*--announce-h/);
		expect(starter("components/Sections.astro")).toContain("section_announcement: SitePartOnly");
		const css = starter("styles/base.css");
		expect(css).toMatch(/\.site-header \{ position: fixed; inset: var\(--announce-offset, 0px\) 0 auto;/);
		expect(css).toMatch(/prefers-reduced-motion: reduce\) \{ \.announcement \{ transition: none; \} \}/);
		const js = starter("scripts/site.ts");
		expect(js).toMatch(/localStorage\.setItem\(`announcement:\$\{bar\.dataset\.version\}`, "closed"\)/);
		expect(js).toContain("for (const el of [main, footer, bar]) if (el) el.inert = open;");
	});

	it("verify counts the bar's text on the migrated page (it is not stripped as header chrome)", () => {
		const target = `<html><body><a class="skip-link" href="#main">Skip to content</a><section class="announcement" aria-label="Announcement"><div class="announcement__inner container"><div class="prose"><p><strong>New:</strong> evening workshops start in <a href="/workshops/">March</a></p></div><div class="announcement__actions"><a class="announcement__btn" href="/book/">Book a seat</a></div></div><button type="button" class="announcement__close" aria-label="Close announcement"><svg></svg></button></section><header class="site-header"><a href="/">Fixture</a></header><main id="main"><h1>Home</h1></main></body></html>`;
		const text = sourceText(target);
		for (const w of ["evening", "workshops", "March", "Book a seat"]) expect(text).toContain(w);
		expect(text).not.toContain("Close announcement");
		const src = sourceText(fixture("announcer"));
		expect(conservation(src, text).missing).not.toContain("evening");
		expect(irText([doc()], [])).toContain("evening workshops");
	});
});
