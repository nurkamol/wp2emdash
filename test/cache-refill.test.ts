import { describe, expect, it } from "vitest";
import * as plugin from "../packages/health/src/cache.js";
import { page, type PageData, TABS } from "../packages/health/src/plugin/views.js";
import * as worker from "../starter/src/utils/rewarm.js";

const at = (h: number, m: number) => Date.UTC(2026, 10, 21, h, m);

describe("cache refill: the plugin's and the Worker's copies stay in step", () => {
	it("same option rows", () => {
		expect(worker.REWARM_OPTIONS).toEqual(plugin.REWARM_OPTIONS);
	});
	it("same reading of the stored setting", () => {
		const cases: unknown[] = [null, "", "{bad", JSON.stringify({ on: true, everyMinutes: 30 }), JSON.stringify({ on: false }), { on: true, everyMinutes: 3 }, { on: true, everyMinutes: 60, at: "x" }];
		for (const c of cases)
			for (const d of [15, 0]) {
				const { on, everyMinutes } = plugin.parseRewarmSetting(c, d);
				expect(worker.parseRewarmSetting(c, d)).toEqual({ on, everyMinutes });
			}
	});
});

describe("cache refill plan", () => {
	it("follows the default when nothing is stored", () => {
		expect(worker.planRewarm({}, at(10, 15), 15)).toEqual({ run: true, trigger: "schedule" });
		expect(worker.planRewarm({}, at(10, 20), 15)).toEqual({ run: false, reason: "not-due" });
	});
	it("follows the admin's switch and interval", () => {
		expect(worker.planRewarm({ setting: JSON.stringify({ on: false, everyMinutes: 15 }) }, at(10, 15), 15)).toEqual({ run: false, reason: "off" });
		expect(worker.planRewarm({ setting: JSON.stringify({ on: true, everyMinutes: 60 }) }, at(10, 15), 15)).toEqual({ run: false, reason: "not-due" });
		expect(worker.planRewarm({ setting: JSON.stringify({ on: true, everyMinutes: 60 }) }, at(11, 0), 15)).toEqual({ run: true, trigger: "schedule" });
	});
	it("runs a requested refresh on the next tick, even when switched off", () => {
		expect(worker.planRewarm({ setting: JSON.stringify({ on: false, everyMinutes: 15 }), request: JSON.stringify({ at: "x" }) }, at(10, 20), 15)).toEqual({ run: true, trigger: "manual" });
	});
	it("never while coming-soon mode is on", () => {
		expect(worker.planRewarm({ request: "{}", maintenance: JSON.stringify({ on: true }) }, at(10, 15), 15)).toEqual({ run: false, reason: "coming-soon" });
		expect(worker.planRewarm({ maintenance: JSON.stringify({ on: false }) }, at(10, 15), 15)).toEqual({ run: true, trigger: "schedule" });
	});
});

describe("cache refill tick", () => {
	const site = async (url: string) => {
		const p = new URL(url).pathname;
		if (p === "/sitemap.xml") return new Response("<urlset><url><loc>https://acme.example/</loc></url></urlset>");
		return new Response("ok", { headers: { "cf-cache-status": "MISS" } });
	};
	const fakeDb = (rows: Record<string, string>) => {
		const writes: { q: string; v: unknown[] }[] = [];
		const db = {
			prepare: (q: string) => ({
				bind: (...v: unknown[]) => ({
					all: async <T>() => ({ results: Object.entries(rows).filter(([n]) => v.includes(n)).map(([name, value]) => ({ name, value })) as T[] }),
					run: async () => {
						writes.push({ q, v });
						return {};
					},
				}),
			}),
		};
		return { db, writes };
	};
	const cfg = { origin: "https://acme.example", everyMinutes: 15 };

	it("stores the result and clears a manual request", async () => {
		const { db, writes } = fakeDb({ [worker.REWARM_OPTIONS.request]: JSON.stringify({ at: "x" }) });
		expect(await worker.rewarmTick(db, cfg, at(10, 20), site, () => "rev")).toBe("rewarm (manual): 1 pages, 1 rendered, 0 failed");
		expect(writes[0]?.v[0]).toBe(worker.REWARM_OPTIONS.last);
		expect(JSON.parse(writes[0]?.v[1] as string)).toMatchObject({ trigger: "manual", pages: 1, rendered: 1, list: [{ path: "/", state: "rendered" }] });
		expect(writes[1]).toEqual({ q: "DELETE FROM options WHERE name = ?", v: [worker.REWARM_OPTIONS.request] });
	});
	it("is quiet when not due, and says why when skipped", async () => {
		expect(await worker.rewarmTick(fakeDb({}).db, cfg, at(10, 20), site)).toBeUndefined();
		expect(await worker.rewarmTick(fakeDb({ [worker.REWARM_OPTIONS.setting]: JSON.stringify({ on: false, everyMinutes: 15 }) }).db, cfg, at(10, 15), site)).toBe("rewarm skipped: off");
	});
	it("still runs on the default without a database", async () => {
		expect(await worker.rewarmTick(undefined, cfg, at(10, 15), site)).toBe("rewarm (schedule): 1 pages, 1 rendered, 0 failed");
	});
});

describe("Speed tab: page cache", () => {
	const base = { state: { checks: {}, jobs: {} }, today: null, history: [], incidents: [], links: null, cwv: null, reports: [], settings: {}, defaults: { alertsTo: [], reportTo: [] }, email: { ready: true, provider: "brevo" }, live: true, staging: false, secrets: { crux: false, zone: false, analytics: false }, selfBinding: true, productionUrl: "https://acme.example" } as unknown as PageData;
	const speed = (d: PageData) => JSON.stringify((page(d, TABS.speed)[1] as { panels: { label: string; blocks: unknown[] }[] }).panels.find((p) => p.label === "Speed"));

	it("shows the last run, the switch and the refresh button", () => {
		const s = speed({ ...base, cache: { available: true, defaultMinutes: 15, setting: { on: true, everyMinutes: 15 }, last: { at: "2026-11-21T11:00:00.000Z", trigger: "schedule", pages: 2, rendered: 1, failed: 0, ms: 900, list: [{ path: "/", state: "cached", status: 200 }, { path: "/about/", state: "rendered", status: 200 }] } } });
		expect(s).toContain("Page cache");
		expect(s).toContain("Every 15 minutes the site refills them itself");
		expect(s).toContain('"action_id":"save-cache"');
		expect(s).toContain('"action_id":"cache-refresh"');
		expect(s).toContain("Built now");
	});
	it("explains it waits for go-live, and is absent when the kit turned it off", () => {
		expect(speed({ ...base, cache: { available: false, defaultMinutes: 15, setting: { on: true, everyMinutes: 15 }, last: null } })).toContain("once the site is live on its own domain");
		expect(speed(base)).not.toContain("Page cache");
	});
});
