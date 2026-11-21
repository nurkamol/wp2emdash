/**
 * Scheduled coming-soon mode: the starter's middleware, its cache refill and Site health decide "on" with the same rule
 * (the switch, or now inside [startAt, endAt)), the holding page says when the site is back, and Site health's cron
 * purges the cached pages once at each scheduled start and end. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as plugin from "../packages/health/src/maintenance.js";
import { createPlugin, parseSchedule } from "../packages/health/src/plugin/index.js";
import { page, type PageData, TABS, widget } from "../packages/health/src/plugin/views.js";
import { runChecks } from "../packages/health/src/run.js";
import { KEYS } from "../packages/health/src/store.js";
import * as starter from "../starter/src/utils/maintenance.js";
import { maintenanceOn, planRewarm } from "../starter/src/utils/rewarm.js";
import { memoryKv } from "./health-fixtures.js";
import { cache as cfCache, env } from "./stubs/cloudflare-workers.js";

const T = (s: string) => Date.parse(`${s}Z`);
const START = "2026-12-01T09:00:00.000Z";
const END = "2026-12-02T09:00:00.000Z";
const KEY = "abcdefghijklmnopqrstuvwxyz012345";

describe("one rule for 'coming-soon is showing'", () => {
	const rows: Record<string, unknown>[] = [
		{ on: true },
		{ on: false },
		{},
		{ on: false, startAt: START },
		{ on: false, endAt: END },
		{ on: false, startAt: START, endAt: END },
		{ on: true, startAt: START, endAt: END },
		{ on: false, startAt: "soon", endAt: "" },
		{ on: "yes", startAt: START },
	];
	const times = ["2026-11-30T12:00:00", "2026-12-01T08:59:59", "2026-12-01T09:00:00", "2026-12-01T20:00:00", "2026-12-02T08:59:59", "2026-12-02T09:00:00", "2026-12-05T00:00:00"].map(T);
	it("the middleware's, the cache refill's and Site health's copies agree", () => {
		for (const r of rows)
			for (const now of times) {
				const expected = starter.maintenanceActive(starter.parseMaintenance(JSON.stringify(r)), now);
				expect(plugin.maintenanceActive(r as Partial<plugin.MaintenanceSetting>, now), JSON.stringify([r, now])).toBe(expected);
				expect(maintenanceOn(JSON.stringify(r), now), JSON.stringify([r, now])).toBe(expected);
			}
	});
	it("schedule semantics: [start, end), either end open; the switch forces it on", () => {
		const s = { on: false, startAt: START, endAt: END };
		expect(starter.maintenanceActive(s, T("2026-12-01T08:59:59"))).toBe(false);
		expect(starter.maintenanceActive(s, T("2026-12-01T09:00:00"))).toBe(true);
		expect(starter.maintenanceActive(s, T("2026-12-02T09:00:00"))).toBe(false);
		expect(starter.maintenanceActive({ on: false, endAt: END }, T("2026-11-01T00:00:00"))).toBe(true);
		expect(starter.maintenanceActive({ on: false, startAt: START }, T("2027-06-01T00:00:00"))).toBe(true);
		expect(starter.maintenanceActive({ on: true, endAt: START }, T("2027-06-01T00:00:00"))).toBe(true);
		expect(starter.maintenanceActive({ on: false }, T("2027-06-01T00:00:00"))).toBe(false);
	});
	it("the stored row keeps a schedule with the switch off; unreadable times are dropped", () => {
		expect(starter.parseMaintenance(JSON.stringify({ on: false, startAt: START, endAt: END, heading: "Soon", previewKey: KEY }))).toEqual({ on: false, startAt: START, endAt: END, heading: "Soon", previewKey: KEY });
		expect(starter.parseMaintenance(JSON.stringify({ on: false, startAt: "next week", heading: "Soon" }))).toEqual({ on: false });
	});
	it("the preview link works while the schedule shows the holding page, and not outside it", () => {
		const s = starter.parseMaintenance(JSON.stringify({ on: false, startAt: START, endAt: END, previewKey: KEY }));
		expect(starter.previewAccess(s, KEY, undefined, T("2026-12-01T10:00:00"))).toBe("link");
		expect(starter.previewAccess(s, KEY, undefined, T("2026-11-30T10:00:00"))).toBeNull();
	});
	it("the cache refill skips while the schedule is on", () => {
		const row = JSON.stringify({ on: false, startAt: START, endAt: END });
		expect(planRewarm({ maintenance: row }, T("2026-12-01T10:00:00"), 15)).toEqual({ run: false, reason: "coming-soon" });
		expect(planRewarm({ maintenance: row }, T("2026-12-02T10:00:00"), 15)).toEqual({ run: true, trigger: "schedule" });
	});
});

describe("the holding page: Retry-After and 'Back at', static text only", () => {
	it("the scheduled end sets Retry-After and the 'Back at' line; else Expected back; past times are ignored", () => {
		const now = T("2026-12-02T07:00:00");
		const s = { on: false, startAt: START, endAt: END, until: "2026-12-03T09:00:00.000Z" };
		expect(starter.backAt(s, now)).toBe(END);
		expect(starter.retryAfter(s, now)).toBe(7200);
		expect(starter.backAt({ on: true, until: "2026-12-03T09:00:00.000Z" }, now)).toBe("2026-12-03T09:00:00.000Z");
		expect(starter.backAt({ on: true, endAt: START }, now)).toBeUndefined();
		const html = starter.comingSoonHtml(s, { siteName: "Acme" }, now);
		expect(html).toContain('<p class="back">Back at 2026-12-02 09:00 UTC</p>');
		expect(html).not.toContain("<script");
		expect(starter.comingSoonHtml({ on: true }, { siteName: "Acme" }, now)).not.toContain("Back at");
	});
});

describe("Site health: schedule form, boundary purge, paused checks, views", () => {
	it("parses and checks the form's times", () => {
		const now = T("2026-11-21T10:00:00");
		expect(parseSchedule({ startAt: "2026-12-01 09:00", endAt: "2026-12-02 09:00 UTC" }, now)).toEqual({ startAt: START, endAt: END, errors: [] });
		expect(parseSchedule({ startAt: "2026-12-02 09:00", endAt: "2026-12-01 09:00" }, now).errors).toEqual(["End at must be later than Start at."]);
		expect(parseSchedule({ endAt: "2026-11-01 09:00" }, now).errors).toEqual(["End at has passed: clear it, or pick a later time."]);
		expect(parseSchedule({ startAt: "tomorrow" }, now).errors[0]).toMatch(/^Start at: write the date/);
		expect(parseSchedule({}, now)).toEqual({ errors: [] });
	});

	it("the cron purges once at the start and once at the end, never in between", async () => {
		const kv = memoryKv();
		const purge = vi.fn(async () => "purged");
		await kv.set(KEYS.maintenance, { on: false, startAt: START, endAt: END });
		const at = async (s: string) => plugin.applyMaintenanceSchedule(kv, T(s), purge);
		expect(await at("2026-11-30T12:00:00")).toEqual({ changed: false, active: false });
		expect(await at("2026-12-01T09:04:00")).toEqual({ changed: true, active: true, purge: "purged" });
		expect(await at("2026-12-01T09:09:00")).toEqual({ changed: false, active: true });
		expect(await at("2026-12-02T09:01:00")).toEqual({ changed: true, active: false, purge: "purged" });
		expect(await at("2026-12-02T09:06:00")).toEqual({ changed: false, active: false });
		expect(purge).toHaveBeenCalledTimes(2);
	});

	describe("through the plugin", () => {
		const OPTIONS = { productionUrl: "https://acme.example", siteName: "Acme", live: true, alertsTo: [], reportTo: [], brand: { footer: "x" } };
		const p = createPlugin(OPTIONS) as unknown as { hooks: Record<string, any>; routes: Record<string, { handler: (c: unknown) => Promise<unknown> }> };
		let kv: ReturnType<typeof memoryKv>;
		const purge = vi.fn(async (_o: { tags?: string[] }) => ({ success: true, errors: [] }));
		const self = vi.fn(async (_r: Request) => new Response("<html></html>", { headers: { "content-type": "text/html" } }));
		const ctx = (input: unknown, extra: Record<string, unknown> = {}) => ({ input, kv, cron: { schedule: async () => {}, list: async () => [{ name: "tick", schedule: "*/5 * * * *" }] }, request: new Request("https://acme.example/_emdash/api/plugins/site-health/admin"), user: { role: 50 }, log: { info: vi.fn(), warn: vi.fn() }, ...extra });
		const call = (input: unknown, extra: Record<string, unknown> = {}) => p.routes.admin?.handler(ctx(input, extra)) as Promise<{ blocks: Record<string, any>[]; toast?: { message: string; type: string } }>;
		const panel = (blocks: Record<string, any>[], label: string) => (blocks.find((b) => b.type === "tab")?.panels as { label: string; blocks: Record<string, any>[] }[]).find((x) => x.label.startsWith(label))?.blocks ?? [];
		beforeEach(() => {
			kv = memoryKv();
			purge.mockClear();
			self.mockClear();
			cfCache.purge = purge;
			for (const k of Object.keys(env)) delete env[k];
			Object.assign(env, { SELF: { fetch: self } });
			vi.useFakeTimers({ toFake: ["Date"] });
			vi.setSystemTime(new Date("2026-11-21T10:00:00Z"));
		});
		afterEach(() => {
			vi.useRealTimers();
			delete cfCache.purge;
		});

		it("saves a schedule with the switch off: no purge yet, 'scheduled' in Settings, Overview and the widget; the cron switches it", async () => {
			const r = await call({ type: "form_submit", action_id: "save-maintenance", values: { on: false, heading: "Opening soon", startAt: "2026-12-01 09:00", endAt: "2026-12-02 09:00" } });
			expect(r.toast?.message).toMatch(/scheduled from 2026-12-01 09:00 UTC until 2026-12-02 09:00 UTC/);
			expect(await kv.get(KEYS.maintenance)).toMatchObject({ on: false, startAt: START, endAt: END });
			expect(purge).not.toHaveBeenCalled();
			expect(panel(r.blocks, "Overview").some((b) => b.title === "Coming-soon mode is scheduled")).toBe(true);
			const settings = JSON.stringify(panel(r.blocks, "Settings"));
			expect(settings).toContain('"action_id":"startAt"');
			expect(settings).toContain('"initial_value":"2026-12-01 09:00"');
			expect(settings).toContain("(not started yet)");
			const w = await call({}, { ui: { surface: "dashboard-widget" } });
			expect(JSON.stringify(w.blocks)).toContain("Coming-soon scheduled from 2026-12-01 09:00 UTC");

			// The start passes: the next tick purges once and the checks that request the site pause.
			vi.setSystemTime(new Date("2026-12-01T09:03:00Z"));
			await p.hooks.cron.handler({ name: "tick" }, ctx({}));
			expect(purge).toHaveBeenCalledTimes(1);
			expect(self).not.toHaveBeenCalled();
			const on = await call({});
			expect(panel(on.blocks, "Overview").find((b) => b.title === "Coming-soon mode is on")?.description).toMatch(/Scheduled from 2026-12-01 09:00 UTC until 2026-12-02 09:00 UTC/);
			await p.hooks.cron.handler({ name: "tick" }, ctx({}));
			expect(purge).toHaveBeenCalledTimes(1);

			// The end passes: one more purge, the site is checked again.
			vi.setSystemTime(new Date("2026-12-02T09:02:00Z"));
			await p.hooks.cron.handler({ name: "tick" }, ctx({}));
			expect(purge).toHaveBeenCalledTimes(2);
			expect(self).toHaveBeenCalled();
		});

		it("switching on now purges at once, and the cron does not purge again", async () => {
			const r = await call({ type: "form_submit", action_id: "save-maintenance", values: { on: true } });
			expect(r.toast?.message).toMatch(/Coming-soon mode is on/);
			expect(purge).toHaveBeenCalledTimes(1);
			await p.hooks.cron.handler({ name: "tick" }, ctx({}));
			expect(purge).toHaveBeenCalledTimes(1);
			// Editing the message while it stays on purges nothing (the holding page is never cached).
			await call({ type: "form_submit", action_id: "save-maintenance", values: { on: true, message: "New text" } });
			expect(purge).toHaveBeenCalledTimes(1);
		});

		it("refuses an end before the start", async () => {
			const r = await call({ type: "form_submit", action_id: "save-maintenance", values: { on: false, startAt: "2026-12-02 09:00", endAt: "2026-12-01 09:00" } });
			expect(r.toast?.type).toBe("error");
			expect(await kv.get(KEYS.maintenance)).toBeNull();
		});

		it("the checks pause inside the schedule with the switch off", async () => {
			await kv.set(KEYS.maintenance, { on: false, startAt: START, endAt: END });
			const res = await runChecks({ kv, options: OPTIONS, env: {}, self: (u, i) => self(new Request(u, i)), fetch: async () => new Response("", { status: 404 }), now: T("2026-12-01T12:00:00") });
			expect(self).not.toHaveBeenCalled();
			expect(res.state.checks.uptime?.status).toBe("off");
		});
	});

	it("views: on by the switch past its end time says so; a finished schedule shows nothing", () => {
		const d = { state: { checks: {}, jobs: {}, uptime: { fails: {}, open: {}, cursor: 0, retry: [] } }, today: null, history: [], incidents: [], links: null, cwv: null, reports: [], settings: {}, defaults: { alertsTo: [], reportTo: [] }, email: { ready: true, provider: "brevo" }, live: true, staging: false, secrets: { crux: false, zone: false, analytics: false }, selfBinding: true, productionUrl: "https://acme.example", now: T("2026-12-01T12:00:00") } as unknown as PageData;
		const overview = (m: PageData["maintenance"]) => (page({ ...d, maintenance: m }, TABS.overview)[1]?.panels as { blocks: Record<string, any>[] }[])[0]?.blocks ?? [];
		expect(overview({ on: true, endAt: END }).find((b) => b.title === "Coming-soon mode is on")?.description).toMatch(/the switch keeps it on/);
		expect(overview({ on: false, startAt: "2026-11-01T00:00:00.000Z", endAt: "2026-11-02T00:00:00.000Z" }).some((b) => String(b.title).startsWith("Coming-soon"))).toBe(false);
		expect(JSON.stringify(widget({ ...d, maintenance: { on: false, endAt: END } }))).toContain("Coming-soon mode is on: visitors see the holding page. Scheduled until 2026-12-02 09:00 UTC.");
	});
});
