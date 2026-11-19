/**
 * Site chrome of a Bricks site (header menu, header buttons, footer links) and the verify/scaffold fixes that came with
 * the first Bricks site: section pairing by top-level index, custom SEO titles, font family names, date pickers and
 * checkbox groups. All data synthetic.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { BricksElement } from "../src/adapters/bricks/index.js";
import { headerButtons, headerMenu, nestedNavItems } from "../src/adapters/bricks/menus.js";
import { iconLabel } from "../src/adapters/bricks/elements.js";
import { kitConfigSchema } from "../src/config/schema.js";
import { sitePaths } from "../src/core/paths.js";
import type { IrSite, Section } from "../src/ir/schema.js";
import { runTransform } from "../src/phases/transform.js";
import { resolveGoogleHref } from "../src/scaffold/fonts.js";
import { fluentFormToDefinition } from "../src/scaffold/forms.js";
import { familyName, panelExtras } from "../src/scaffold/generate.js";
import { menuItemExtras, productionCanonical } from "../src/scaffold/seed.js";
import { sectionToBlock } from "../src/targets/emdash/blocks.js";
import { groupSections } from "../src/verify/sections.js";
import { fullTitle } from "../packages/seo/src/analyze.js";
import { createFormEndpoint } from "../packages/forms/src/endpoint.js";
import type { FormDefinition } from "../packages/forms/src/index.js";
import { env } from "./stubs/cloudflare-workers.js";
import type { MenuCapture } from "../src/audit/interactions.js";

const el = (id: string, name: string, parent: string | number, settings: Record<string, unknown> = {}, children: string[] = []): BricksElement => ({ id, name, parent, children, settings });

describe("Bricks header menu", () => {
	const menus = [
		{ id: 5, name: "legal" },
		{ id: 4, name: "main" },
	];
	const header = [el("h", "section", 0, {}, ["n1", "n2"]), el("n1", "nav-menu", "h", { menu: "18" }), el("n2", "nav-menu", "h", { menu: "4" })];
	it("takes the menu the live header printed (ul#menu-<slug>), whatever id the element names", () => {
		const r = headerMenu(menus, header, '<div id="brx-header"><ul id="menu-main" class="bricks-nav-menu"></ul><ul id="menu-main-1"></ul></div>');
		expect(r.menu?.name).toBe("main");
		expect(r.via).toMatch(/live header/);
	});
	it("without the live HTML, the first nav-menu whose id is a menu of the site; a stale id is skipped", () => {
		expect(headerMenu(menus, header).menu?.name).toBe("main");
		expect(headerMenu(menus, [el("n", "nav-menu", 0, { menu: "18" })]).menu).toBeUndefined();
		expect(headerMenu(menus, [el("n", "nav-menu", 0, { menu: "18" })]).via).toMatch(/menu 18, not among/);
	});
	it("builds the menu from a nav-nested element's own links and dropdowns", () => {
		const nested = [
			el("nn", "nav-nested", 0, {}, ["ul", "tg"]),
			el("tg", "toggle", "nn"),
			el("ul", "block", "nn", {}, ["a", "dd"]),
			el("a", "text-link", "ul", { text: "Classes", link: { type: "internal", postId: 9 } }),
			el("dd", "dropdown", "ul", { text: "Studio" }, ["dc"]),
			el("dc", "div", "dd", {}, ["d1", "d2"]),
			el("d1", "text-link", "dc", { text: "About", link: { type: "external", url: "/about/" } }),
			el("d2", "text-link", "dc", { text: "Shop", link: { type: "external", url: "https://shop.example", newTab: true } }),
		];
		const href = (l: unknown) => {
			const o = l as { type?: string; postId?: number; url?: string; newTab?: boolean };
			return { href: o?.type === "internal" ? `/page-${o.postId}/` : o?.url, ...(o?.newTab ? { newTab: true } : {}) };
		};
		expect(nestedNavItems(nested, href)).toEqual([
			{ label: "Classes", href: "/page-9/", children: [] },
			{ label: "Studio", href: "/about/", children: [{ label: "About", href: "/about/", children: [] }, { label: "Shop", href: "https://shop.example", newTab: true, children: [] }] },
		]);
	});
	it("header buttons become secondary menu items marked as buttons, once each, with their hover label", () => {
		const sec = { type: "columns", fields: { columns: [{ buttons: [{ label: "Contact Us", href: "/contact/", style: "primary", hoverLabel: "Reach Out" }] }, { buttons: [{ label: "Book Now", href: "/schedule/", style: "primary" }, { label: "Contact Us", href: "/contact/", style: "primary" }, { label: "Home", href: "/", style: "link" }] }] } } as unknown as Section;
		expect(headerButtons([sec])).toEqual([
			{ label: "Contact Us", href: "/contact/", button: true, hoverLabel: "Reach Out", children: [] },
			{ label: "Book Now", href: "/schedule/", button: true, children: [] },
		]);
		expect(menuItemExtras({ label: "Contact Us", href: "/contact/", button: true, hoverLabel: "Reach Out", children: [] })).toEqual({ cssClasses: "button", titleAttr: "Reach Out" });
		expect(menuItemExtras({ label: "Gift", href: "#gift", opensPopup: "gift", button: true, children: [] })).toEqual({ cssClasses: "popup-gift button" });
		expect(menuItemExtras({ label: "FAQ", href: "/faq/", children: [] })).toEqual({});
	});
	it("names linked icons after the icon", () => {
		expect(["instagram", "x-twitter", "envelope", "tiktok", "facebook-square"].map(iconLabel)).toEqual(["Instagram", "X", "Email", "TikTok", "Facebook"]);
	});
	it("the burger panel repeats the header buttons when the source panel shows them after the menu", () => {
		const m = { viewport: "mobile", found: true, items: [{ text: "Home", href: "/", depth: 0 }, { text: "FAQ", href: "/faq/", depth: 0 }, { text: "Contact Us Reach Out", href: "/contact/", depth: 0 }, { text: "Book Now", href: "/schedule/", depth: 0 }] } as unknown as MenuCapture;
		expect(panelExtras([m], ["Home", "FAQ"], ["Contact Us", "Book Now"]).buttons).toBe(true);
		expect(panelExtras([m], ["Home", "FAQ"]).buttons).toBeUndefined();
	});
});

describe("Bricks menus in the transform phase", () => {
	const dir = mkdtempSync(join(tmpdir(), "wp2emdash-bricks-menus-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const paths = sitePaths("bricks-menus", dir);
	const write = (file: string, data: unknown) => {
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
	};
	const post = (id: number, post_type: string, slug: string, title: string, meta: Record<string, unknown>) => ({ id, post_type, status: "publish", slug, title, content: "", excerpt: "", date_gmt: "", modified_gmt: "2026-11-01T00:00:00", parent: null, menu_order: 0, taxonomies: {}, meta });
	const item = (id: number, title: string, url: string, sort: number) => ({ id, parent_id: null, sort_order: sort, type: "custom", object: "custom", object_id: 0, url, title, target: null, classes: null });
	write(join(paths.raw, "extract.json"), {});
	write(join(paths.raw, "exporter", "options.json"), { blogname: "Fixture Studio", page_on_front: 2 });
	write(join(paths.raw, "exporter", "menus.json"), [
		{ id: 5, name: "legal", locations: [], items: [item(1, "Privacy", "https://fixture.example/privacy/", 1)] },
		{ id: 4, name: "main", locations: [], items: [item(2, "Home", "https://fixture.example/", 1), item(3, "Classes", "https://fixture.example/classes/", 2)] },
	]);
	write(join(paths.snapshot, "html", "home.html"), '<header id="brx-header"><nav><ul id="menu-main" class="bricks-nav-menu"><li><a href="/">Home</a></li></ul></nav></header><main id="brx-content"></main>');
	write(join(paths.raw, "exporter", "content", "page.json"), [post(2, "page", "home", "Home", { _bricks_editor_mode: "bricks", _bricks_page_content_2: [el("s1", "section", 0, {}, ["h1"]), el("h1", "heading", "s1", { text: "Welcome", tag: "h1" })] })]);
	write(join(paths.raw, "exporter", "content", "bricks_template.json"), [
		post(30, "bricks_template", "site-header", "Header", {
			_bricks_template_type: "header",
			_bricks_template_settings: { templateConditions: [{ main: "any" }] },
			_bricks_page_header_2: [
				el("hs", "section", 0, { tag: "custom", customTag: "header" }, ["hc"]),
				el("hc", "container", "hs", { _direction: "row" }, ["hb1", "hb2"]),
				el("hb1", "block", "hc", {}, ["nm"]),
				el("nm", "nav-menu", "hb1", { menu: "18" }),
				el("hb2", "block", "hc", {}, ["cta", "oc"]),
				el("cta", "ripple_button_v3", "hb2", { topRippleInnerTitle: "Contact Us", bottomRippleInnerTitle: "Reach Out", link: { type: "external", url: "/contact/" } }),
				el("oc", "offcanvas", "hb2"),
			],
		}),
	]);
	const config = kitConfigSchema.parse({ slug: "bricks-menus", name: "Fixture", source: { url: "https://fixture.example" }, target: { productionUrl: "https://fixture.example" } });
	const run = runTransform({ config, paths, reporter: { runId: "t", emit: () => {} } });

	it("the menu the header prints is the primary menu; the header's buttons are the secondary menu", async () => {
		await run;
		const site = JSON.parse(readFileSync(join(paths.ir, "site.json"), "utf8")) as IrSite;
		expect(site.menus.find((m) => m.role === "primary")?.name).toBe("main");
		expect(site.menus.find((m) => m.name === "legal")?.role).toBe("other");
		expect(site.menus.find((m) => m.role === "secondary")?.items).toEqual([{ label: "Contact Us", href: "/contact/", button: true, hoverLabel: "Reach Out", children: [] }]);
	});
});

describe("verify, SEO and design fixes from the first Bricks site", () => {
	it("pairs Bricks sections with the live page's boxes by their top-level index", () => {
		const g = groupSections(
			[
				{ type: "hero", path: "section#a", row: 0 },
				{ type: "faq", path: "section#b#0", row: 2 },
				{ type: "columns", path: "section#b#1", row: 2 },
				{ type: "rich_text", path: "blocks[3]" },
			],
			false,
		);
		expect(g.map((x) => [x.sourceIndex, x.targetIndexes])).toEqual([
			[0, [0]],
			[2, [1, 2]],
		]);
	});
	it("a custom SEO title is used as written; the page title gets the site name", () => {
		expect(fullTitle("Member Login", "Fixture Studio", "–", "Account")).toBe("Member Login");
		expect(fullTitle("Account", "Fixture Studio", "–", "Account")).toBe("Account – Fixture Studio");
		expect(fullTitle("Account", "Fixture Studio", "–")).toBe("Account – Fixture Studio");
	});
	it("moves a canonical on the old domain to the production domain (same path); other sites' canonicals stay", () => {
		const hosts = new Set(["old-studio.example"]);
		expect(productionCanonical("https://www.old-studio.example/account/", hosts, "https://new-studio.example")).toBe("https://new-studio.example/account/");
		expect(productionCanonical("https://new-studio.example/faq/", hosts, "https://new-studio.example/")).toBe("https://new-studio.example/faq/");
		expect(productionCanonical("https://partner.example/post/", hosts, "https://new-studio.example")).toBe("https://partner.example/post/");
	});
	it("reads a quoted font family as its bare name", () => {
		expect(familyName('"Pinyon Script", cursive')).toBe("Pinyon Script");
		expect(familyName("Outfit")).toBe("Outfit");
		expect(familyName(undefined)).toBeUndefined();
	});
	it("asks Google only for styles it has: each family alone, then upright only, then its default", async () => {
		const asked: string[] = [];
		const fetcher = (async (u: string) => {
			asked.push(u);
			const q = decodeURIComponent(u);
			// "Script One" has only its regular style; "Missing" is not on Google Fonts.
			const bad = q.includes("Missing") || (q.includes("Script+One:") && /ital|wght@[^&]*(300|500|700)/.test(q));
			return new Response("", { status: bad ? 400 : 200 });
		}) as unknown as typeof fetch;
		const href = "https://fonts.googleapis.com/css2?family=Body+Sans:ital,wght@0,400;1,400&family=Script+One:ital,wght@0,300;0,400;1,400&family=Missing:wght@400&display=swap";
		const r = await resolveGoogleHref(href, fetcher);
		expect(r.href).toBe("https://fonts.googleapis.com/css2?family=Body+Sans:ital,wght@0,400;1,400&family=Script+One&display=swap");
		expect(r.dropped).toEqual(["Missing"]);
		expect(r.reduced).toEqual(["Script One (default style only)"]);
		expect(await resolveGoogleHref("https://fonts.googleapis.com/css2?family=Body+Sans&display=swap", (async () => new Response("")) as unknown as typeof fetch)).toEqual({ href: "https://fonts.googleapis.com/css2?family=Body+Sans&display=swap", dropped: [], reduced: [] });
	});
	it("a footer heading with links stays in the text, so the links are kept", () => {
		const block = { _type: "block" as const, _key: "b", style: "h3" as const, children: [{ _type: "span" as const, _key: "s1", text: "© 2025 Studio / Website by ", marks: [] }, { _type: "span" as const, _key: "s2", text: "Agency", marks: ["l"] }], markDefs: [{ _type: "link" as const, _key: "l", href: "https://agency.example" }] };
		const sec = { type: "rich_text", theme: { tone: "light" }, spacing: "normal", sourceRef: { adapter: "bricks", path: "block#f", rawHash: "x" }, fields: { body: [block], width: "normal", align: "left", buttons: [] } };
		const v = sectionToBlock(sec as never, "a", () => undefined);
		expect(v.heading).toBeUndefined();
		expect(JSON.stringify(v.body)).toContain("https://agency.example");
	});
});

describe("forms: date and time, checkbox groups (Forms 1.5.0)", () => {
	const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "fluent", "event-request.json"), "utf8"));
	const def = fluentFormToDefinition(fixture, false);
	it("converts a Fluent date with time and a checkbox list (golden)", () => {
		const out = join(import.meta.dirname, "golden", "fluent", "event-request.json");
		const json = `${JSON.stringify(def, null, 2)}\n`;
		if (process.env.UPDATE_GOLDEN === "1") writeFileSync(out, json);
		expect(json).toBe(readFileSync(out, "utf8"));
		expect(def.fields.find((f) => f.name === "datetime")).toMatchObject({ type: "date", time: true });
		expect(def.fields.find((f) => f.name === "addons")?.options).toEqual(["Reformer access", "Instructor", "Flower wall"]);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});
	it("the endpoint keeps every ticked option of a group (only defined ones) and requires one when the group is required", async () => {
		const form = { ...def, fields: def.fields.map((f) => (f.name === "addons" ? { ...f, required: true } : f)) } as FormDefinition;
		const POST = createFormEndpoint({ getForm: (id) => (id === form.id ? form : undefined) });
		for (const k of Object.keys(env)) delete env[k];
		Object.assign(env, { TURNSTILE_SECRET_KEY: "s", FORM_TO: "studio@example.com", FORM_FROM: "Site <noreply@example.com>", EMAIL_API_KEY: "k" });
		const sent: string[] = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: { body?: string }) => {
				if (String(url).includes("turnstile")) return new Response(JSON.stringify({ success: true }));
				sent.push(String(init?.body ?? ""));
				return new Response("{}", { status: 201 });
			}),
		);
		vi.spyOn(console, "log").mockImplementation(() => {});
		const submit = (ticks: string[]) => {
			const body = new FormData();
			body.set("email", "jane@example.com");
			body.set("cf-turnstile-response", "t");
			for (const t of ticks) body.append("addons", t);
			const request = new Request(`https://studio.example/api/forms/${form.id}`, { method: "POST", body, headers: { accept: "application/json" } });
			return (POST as unknown as (ctx: unknown) => Promise<Response>)({ params: { id: form.id }, request, locals: {}, clientAddress: "203.0.113.1" });
		};
		expect((await submit([])).status).toBe(422);
		expect((await submit(["Flower wall", "Reformer access", "<script>"])).status).toBe(200);
		expect(sent.join("\n")).toContain("Reformer access, Flower wall");
		expect(sent.join("\n")).not.toContain("<script>");
	});
});
