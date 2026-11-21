import { describe, expect, it } from "vitest";
import { kitConfigSchema } from "../src/config/schema.js";
import { rewarmSiteConfig } from "../src/scaffold/perf.js";
import { REWARM_MAX, rewarm, rewarmDue, sitemapLocs } from "../starter/src/utils/rewarm.js";

const perf = (o: Record<string, unknown> = {}) => kitConfigSchema.parse({ slug: "fixture", name: "Fixture", source: { url: "https://fixture.example" }, target: { kind: "emdash", productionUrl: "https://fixture.example" }, performance: o }).performance;
const ORIGIN = "https://acme.example";

describe("rewarm due", () => {
	it("runs on the cron tick that starts each window", () => {
		const at = (h: number, m: number) => Date.UTC(2026, 10, 21, h, m);
		expect(rewarmDue(at(10, 0), 15)).toBe(true);
		expect(rewarmDue(at(10, 5), 15)).toBe(false);
		expect(rewarmDue(at(10, 10), 15)).toBe(false);
		expect(rewarmDue(at(10, 15), 15)).toBe(true);
		expect(rewarmDue(at(10, 15), 0)).toBe(false);
	});
});

describe("sitemap locs", () => {
	it("keeps the site's own origin and decodes &amp;", () => {
		const xml = "<urlset><url><loc>https://www.acme.example/about/</loc></url><url><loc> /x/?a=1&amp;b=2 </loc></url></urlset>";
		expect(sitemapLocs(xml, ORIGIN)).toEqual([`${ORIGIN}/about/`, `${ORIGIN}/x/?a=1&b=2`]);
	});
});

describe("rewarm", () => {
	const site: Record<string, { status: number; body?: string; cache?: string }> = {
		"/sitemap.xml": { status: 200, body: `<sitemapindex><sitemap><loc>${ORIGIN}/sitemap-pages.xml</loc></sitemap></sitemapindex>` },
		"/sitemap-pages.xml": { status: 200, body: `<urlset><url><loc>${ORIGIN}/</loc></url><url><loc>${ORIGIN}/about/</loc></url><url><loc>${ORIGIN}/gone/</loc></url></urlset>` },
		"/": { status: 200, cache: "HIT" },
		"/about/": { status: 200, cache: "MISS" },
		"/gone/": { status: 404 },
	};
	const fake = (calls: string[]) => async (url: string, init?: RequestInit) => {
		calls.push(url);
		expect(new Headers(init?.headers).get("user-agent")).toMatch(/rewarm/);
		const r = site[new URL(url).pathname] ?? { status: 404 };
		return new Response(r.body ?? "ok", { status: r.status, headers: r.cache ? { "cf-cache-status": r.cache } : {} });
	};

	it("requests every page of the child sitemaps and counts renders and failures", async () => {
		const calls: string[] = [];
		const r = await rewarm(ORIGIN, fake(calls));
		expect(r).toMatchObject({ pages: 3, rendered: 1, failed: 1 });
		expect(r.list).toEqual([
			{ path: "/", status: 200, state: "cached" },
			{ path: "/about/", status: 200, state: "rendered" },
			{ path: "/gone/", status: 404, state: "failed" },
		]);
		expect(calls).toContain(`${ORIGIN}/about/`);
	});

	it("caps the number of pages per run", async () => {
		const many = `<urlset>${Array.from({ length: REWARM_MAX + 30 }, (_, i) => `<url><loc>${ORIGIN}/p${i}/</loc></url>`).join("")}</urlset>`;
		const calls: string[] = [];
		const r = await rewarm(ORIGIN, async (u) => (calls.push(u), new Response(u.endsWith("sitemap.xml") ? many : "ok")));
		expect(r.pages).toBe(REWARM_MAX);
		expect(calls).toHaveLength(REWARM_MAX + 1);
	});

	it("never throws when the site cannot be reached", async () => {
		expect(await rewarm(ORIGIN, async () => Promise.reject(new Error("down")))).toMatchObject({ pages: 0, rendered: 0, failed: 0, list: [] });
	});
});

describe("rewarm site config", () => {
	it("only once live on its own domain, with the route cache", () => {
		expect(rewarmSiteConfig(perf(), { live: true, url: "https://acme.example/" })).toEqual({ rewarm: { origin: ORIGIN, everyMinutes: 15 } });
		expect(rewarmSiteConfig(perf(), { live: false, url: "https://acme.example/" })).toEqual({});
		expect(rewarmSiteConfig(perf({ routeCache: false }), { live: true, url: ORIGIN })).toEqual({});
		expect(rewarmSiteConfig(perf({ rewarmMinutes: 0 }), { live: true, url: ORIGIN })).toEqual({});
		expect(() => perf({ rewarmMinutes: 3 })).toThrow();
	});
});
