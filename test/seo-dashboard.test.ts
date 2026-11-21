import { describe, expect, it, vi } from "vitest";
import { parseRobots, siteChecks, sitemapLocs } from "../packages/seo/src/site-checks.js";
import { createPlugin } from "../packages/seo/src/plugin/index.js";

const ULID = (n: number) => `01ARZ3NDEKTSV4RRFFQ69G5FA${n}`;
const pt = (style: string, text: string) => ({ _type: "block", style, children: [{ _type: "span", text }], markDefs: [] });
const page = (id: string, slug: string, title: string, img: string, h1 = true) => ({ id, slug, status: "published", data: { title, content: [{ _type: "section_hero", heading: title, heading_level: h1 ? "h1" : "h2", body: [pt("normal", "word ".repeat(320))], media: { id: img, provider: "local", mimeType: "image/webp", filename: `${slug}.webp` }, buttons: [{ label: "Go", url: "/x/" }] }] }, seo: { title: null, description: "d".repeat(140), image: "/img.webp", canonical: null, noIndex: false } });

describe("site checks", () => {
	it("parses robots.txt and sitemaps", () => {
		expect(parseRobots("User-agent: *\nDisallow: /\nSitemap: https://a.example/sitemap.xml")).toEqual({ blocksAll: true, sitemaps: ["https://a.example/sitemap.xml"] });
		expect(parseRobots("User-agent: bad\nDisallow: /\nUser-agent: *\nAllow: /").blocksAll).toBe(false);
		expect(sitemapLocs("<urlset><url><loc>https://a.example/</loc></url><url><loc> https://a.example/b/ </loc></url></urlset>")).toEqual(["https://a.example/", "https://a.example/b/"]);
	});
	const site = (robots: string, homeExtra = "") =>
		vi.fn(async (u: string) => {
			const p = new URL(u).pathname;
			if (p === "/robots.txt") return new Response(robots);
			if (p === "/sitemap.xml") return new Response("<urlset><url><loc>https://a.example/</loc></url></urlset>");
			return new Response(`<html><head>${homeExtra}<link rel="canonical" href="https://a.example/"><script type="application/ld+json">{}</script></head></html>`);
		}) as unknown as typeof fetch;
	it("on the live domain: crawlable, sitemap complete, flags missing pages", async () => {
		const c = await siteChecks("https://a.example", "https://a.example", ["/", "/b/"], site("User-agent: *\nAllow: /\nSitemap: https://a.example/sitemap.xml"));
		const s = Object.fromEntries(c.map((x) => [x.id, x.status]));
		expect(s).toMatchObject({ robots: "good", sitemap: "warn", home: "good", "canonical-host": "good", "structured-data": "good" });
		expect(c.find((x) => x.id === "sitemap")?.detail).toContain("/b/");
	});
	it("on a non-live address: blocking and noindex are expected, not errors", async () => {
		const c = await siteChecks("https://stage.example", "https://a.example", ["/"], site("User-agent: *\nDisallow: /", '<meta name="robots" content="noindex">'));
		expect(c.find((x) => x.id === "environment")?.status).toBe("info");
		expect(c.find((x) => x.id === "robots")?.status).toBe("info");
		expect(c.find((x) => x.id === "home")?.status).toBe("info");
	});
	it("on the live domain a blocked site is an error", async () => {
		const c = await siteChecks("https://a.example", "https://a.example", ["/"], site("User-agent: *\nDisallow: /", '<meta name="robots" content="noindex">'));
		expect(c.find((x) => x.id === "robots")?.status).toBe("bad");
		expect(c.find((x) => x.id === "home")?.status).toBe("bad");
	});
});

describe("SEO dashboard", () => {
	const items = [page("P1", "home", "Welcome home", ULID(1)), page("P2", "about", "About", ULID(2), false), { ...page("P3", "draft", "Draft", ULID(3)), status: "draft" }];
	const alts = new Map<string, string>([[ULID(1), "Studio"]]);
	const kv = new Map<string, unknown>();
	const ctx = (input: unknown, extra: Record<string, unknown> = {}) => ({
		input,
		request: new Request("https://stage.example/_emdash/api/plugins/site-seo/admin"),
		kv: { get: async (k: string) => kv.get(k) ?? null, set: async (k: string, v: unknown) => void kv.set(k, v) },
		content: { get: async (_c: string, id: string) => items.find((i) => i.id === id) ?? null, list: async () => ({ items, hasMore: false }) },
		media: { get: async (id: string) => ({ id, alt: alts.get(id) ?? null, filename: `${id}.webp`, url: `/m/${id}`, mimeType: "image/webp" }), updateMetadata: vi.fn(async (id: string, p: { alt?: string }) => void alts.set(id, p.alt ?? "")) },
		site: { name: "Acme" },
		...extra,
	});
	vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
	const plugin = createPlugin({ productionUrl: "https://a.example" }) as unknown as { capabilities: string[]; admin: { pages: { path: string }[]; widgets: { id: string }[] }; routes: { admin: { permission: string; handler: (c: unknown) => Promise<{ blocks: Record<string, any>[]; toast?: { message: string } }> } } };
	const tab = (r: { blocks: Record<string, any>[] }, n: number) => r.blocks.find((b) => b.type === "tab")?.panels[n].blocks as Record<string, any>[];
	it("declares the page, the widget and alt-text writing for editors", () => {
		expect(plugin.admin.pages.map((p) => p.path)).toEqual(["/seo"]);
		expect(plugin.admin.widgets.map((w) => w.id)).toEqual(["seo-overview"]);
		expect(plugin.capabilities).toContain("media:metadata:write");
		expect(plugin.routes.admin.permission).toBe("content:edit_any");
	});
	it("scores published pages, ranks issues and lists images without a description", async () => {
		const r = await plugin.routes.admin.handler(ctx({ type: "page_load" }));
		const stats = tab(r, 0).find((b) => b.type === "stats")?.items.map((x: { value: unknown }) => x.value);
		expect(stats?.[1]).toBe(2);
		expect(stats?.[3]).toBe(1);
		const issueRows = tab(r, 0).find((b) => b.block_id === "issues")?.rows as { issue: string; count: number }[];
		expect(issueRows.some((x) => /One main heading/.test(x.issue))).toBe(true);
		const pageRows = tab(r, 1).find((b) => b.block_id === "pages")?.rows as { page: string; open: { target: unknown } }[];
		expect(pageRows.map((x) => x.page)).toEqual(["About", "Welcome home"]);
		expect(pageRows[0]?.open.target).toEqual({ kind: "content", collection: "pages", id: "P2" });
		const altForm = tab(r, 2).find((b) => b.type === "form");
		expect(altForm?.fields.map((f: { action_id: string }) => f.action_id)).toEqual([`alt:${ULID(2)}`]);
		expect(tab(r, 3).some((b) => b.type === "section" && /not the live address/.test(b.text))).toBe(true);
		// Cached for Site health's "What to improve" (KV `summary` = D1 row plugin:site-seo:summary): titles and counts.
		expect(kv.get("summary")).toMatchObject({ v: 1, pages: 2, thin: { count: 0 }, noDescription: { count: 0 }, missingAlt: { count: 1, pages: ["About"] } });
	});
	it("saves image descriptions to the media library", async () => {
		const r = await plugin.routes.admin.handler(ctx({ type: "form_submit", action_id: "save-alt", values: { [`alt:${ULID(2)}`]: " Team photo ", "alt:bogus": "x" } }));
		expect(alts.get(ULID(2))).toBe("Team photo");
		expect(r.toast?.message).toBe("1 image description saved.");
		expect(tab(r, 2)[0]?.type).toBe("empty");
	});
	it("fills the dashboard widget", async () => {
		const w = await plugin.routes.admin.handler(ctx({ type: "page_load" }, { ui: { surface: "dashboard-widget" } }));
		expect(w.blocks[0]?.items.map((x: { label: string }) => x.label)).toEqual(["Average score", "Pages under 80", "Images to describe"]);
	});
});

describe("SEO dashboard: pages that need more text", () => {
	const text = (id: string, slug: string, words: number, noIndex = false) => ({ id, slug, status: "published", data: { title: slug, content: [{ _type: "section_hero", heading: slug, heading_level: "h1", body: [pt("normal", Array.from({ length: words }, (_, k) => `w${k}x`).join(" "))] }] }, seo: { title: null, description: "d".repeat(140), image: "/img.webp", canonical: null, noIndex } });
	const items = [text("A", "services", 200), text("B", "home", 36), text("C", "contact", 20), text("D", "hidden", 50, true), text("E", "about", 400), { ...text("F", "draft", 10), status: "draft" }];
	vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
	const plugin = createPlugin({ productionUrl: "https://a.example" }) as unknown as { routes: { admin: { handler: (c: unknown) => Promise<{ blocks: Record<string, any>[] }> } } };
	const ctx = { input: { type: "page_load" }, request: new Request("https://stage.example/_emdash/api/plugins/site-seo/admin"), kv: { get: async () => null, set: async () => {} }, content: { get: async () => null, list: async () => ({ items, hasMore: false }) }, media: { get: async () => null }, site: { name: "Acme" } };
	const overview = (r: { blocks: Record<string, any>[] }) => r.blocks.find((b) => b.type === "tab")?.panels[0].blocks as Record<string, any>[];
	it("lists published, indexable pages under 300 words, fewest first, with a link to edit", async () => {
		const o = overview(await plugin.routes.admin.handler(ctx));
		expect(o.some((b) => b.type === "header" && b.text === "Pages that need more text (2)")).toBe(true);
		const rows = o.find((b) => b.block_id === "thin")?.rows as { page: string; words: number; need: number; open: { target: unknown } }[];
		// Words include the heading (the page's title here).
		expect(rows.map((x) => [x.page, x.words, x.need])).toEqual([["home", 37, 263], ["services", 201, 99]]);
		expect(rows[0]?.open.target).toEqual({ kind: "content", collection: "pages", id: "B" });
	});
	it("shows nothing when no page is thin", async () => {
		const o = overview(await plugin.routes.admin.handler({ ...ctx, content: { ...ctx.content, list: async () => ({ items: [items[4]], hasMore: false }) } }));
		expect(o.some((b) => b.block_id === "thin")).toBe(false);
	});
});
