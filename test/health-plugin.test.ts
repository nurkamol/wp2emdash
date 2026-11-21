/**
 * @wp2emdash/health: the EmDash plugin (routes, admins only, cron task, run now, settings, reports and one-time
 * downloads, the public heartbeat), and the kit side — kit.config defaults, scaffold options and wrangler binding,
 * client docs, dashboard secrets and the verify check. Synthetic data only; every request mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthOptions } from "../packages/health/src/index.js";
import { healthPlugin } from "../packages/health/src/index.js";
import { createPlugin, ensureCron } from "../packages/health/src/plugin/index.js";
import { overallOf, trend } from "../packages/health/src/plugin/views.js";
import { KEYS } from "../packages/health/src/store.js";
import { kitConfigSchema } from "../src/config/schema.js";
import { wranglerJsonc } from "../src/phases/scaffold.js";
import { clientRepoFiles, type ClientRepoInput } from "../src/scaffold/client-repo.js";
import { healthOptions, mailBaselineFrom } from "../src/scaffold/health.js";
import { SECRET_KEYS } from "../src/ui/secrets.js";
import { healthHeartbeat } from "../src/verify/health.js";
import { env } from "./stubs/cloudflare-workers.js";
import { memoryKv, SECURE_HEADERS } from "./health-fixtures.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type B = Record<string, any>;
type Res = { blocks: B[]; toast?: { message: string; type: string } };
type Route = { permission?: string; public?: boolean; methods?: string[]; response?: string; handler: (ctx: unknown) => Promise<unknown> };
const ORIGIN = "https://acme.example";
const OPTIONS: HealthOptions = { productionUrl: ORIGIN, siteName: "Acme", live: true, alertsTo: ["team@agency.example"], reportTo: ["owner@acme.example"], brand: { footer: "Prepared by Example Agency" } };
const plugin = createPlugin(OPTIONS) as unknown as { id: string; capabilities: string[]; hooks: Record<string, any>; admin: { pages: { path: string; icon: string }[]; widgets: { id: string }[] }; routes: Record<string, Route> };

let kv: ReturnType<typeof memoryKv>;
const cron = { tasks: [] as { name: string; schedule: string }[], schedule: vi.fn(async (name: string, o: { schedule: string }) => void cron.tasks.push({ name, schedule: o.schedule })), list: vi.fn(async () => cron.tasks) };
const ctx = (input: unknown, role = 50, extra: Record<string, unknown> = {}) => ({ input, kv, cron, request: new Request(`${ORIGIN}/_emdash/api/plugins/site-health/admin`), user: { id: "u1", email: "admin@acme.example", name: "Admin", role }, log: { info: vi.fn(), warn: vi.fn() }, ...extra });
const call = (input: unknown, role = 50, extra: Record<string, unknown> = {}) => plugin.routes.admin?.handler(ctx(input, role, extra)) as Promise<Res>;
const tabs = (r: Res) => r.blocks.find((b) => b.type === "tab")?.panels as { label: string; blocks: B[] }[];
const tab = (r: Res, name: string) => tabs(r).find((p) => p.label.startsWith(name))?.blocks ?? [];

const SITEMAP = `<urlset><url><loc>${ORIGIN}/</loc></url><url><loc>${ORIGIN}/about/</loc></url></urlset>`;
const selfFetch = vi.fn(async (req: Request) => {
	const p = new URL(req.url).pathname;
	if (p === "/sitemap.xml") return new Response(SITEMAP, { headers: { "content-type": "application/xml" } });
	if (p === "/robots.txt") return new Response("User-agent: *\nAllow: /", { headers: { "content-type": "text/plain" } });
	return new Response(`<html><head><link rel="canonical" href="${ORIGIN}/"></head><body><a href="/about/">a</a></body></html>`, { headers: { "content-type": "text/html", ...SECURE_HEADERS } });
});

beforeEach(() => {
	kv = memoryKv();
	cron.tasks = [];
	cron.schedule.mockClear();
	for (const k of Object.keys(env)) delete env[k];
	Object.assign(env, { SELF: { fetch: selfFetch }, EMAIL_PROVIDER: "brevo" });
	vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
});
afterEach(() => vi.unstubAllGlobals());

describe("Site health plugin", () => {
	it("is a native plugin descriptor with a page, a widget, a cron hook and admin-only routes", () => {
		expect(healthPlugin(OPTIONS)).toMatchObject({ id: "site-health", format: "native", entrypoint: "@wp2emdash/health/plugin" });
		expect(plugin.capabilities).toEqual(["content:read", "media:read", "email:send", "redirects:write"]);
		expect(plugin.admin.pages[0]).toMatchObject({ path: "/health", icon: "heartbeat" });
		expect(plugin.admin.widgets[0]?.id).toBe("site-health");
		expect(plugin.routes.admin?.permission).toBe("plugins:manage");
		expect(plugin.routes.status?.permission).toBe("plugins:manage");
		expect(plugin.routes.report).toMatchObject({ public: true, methods: ["GET"], response: "raw" });
		expect(plugin.routes.heartbeat).toMatchObject({ public: true, methods: ["GET"] });
		expect(plugin.hooks.cron.timeout).toBeLessThanOrEqual(30_000);
	});
	it("schedules its 5-minute task on install, once", async () => {
		await plugin.hooks["plugin:install"]({}, { cron });
		await plugin.hooks["plugin:activate"]({}, { cron });
		await ensureCron(cron);
		expect(cron.tasks).toEqual([{ name: "tick", schedule: "*/5 * * * *" }]);
	});
	it("is for admins only (page and widget)", async () => {
		expect((await call({}, 40)).blocks[0]).toMatchObject({ type: "banner", title: "Admins only" });
		expect((await call({}, 40, { ui: { surface: "dashboard-widget" } })).blocks).toEqual([]);
	});
	it("shows Starting before the first run, then the checks after the cron ran", async () => {
		const first = await call({});
		expect(tab(first, "Overview")[0]).toMatchObject({ type: "banner", title: "Starting" });
		expect(cron.tasks).toHaveLength(1);
		await plugin.hooks.cron.handler({ name: "tick" }, ctx({}));
		const r = await call({});
		const overview = tab(r, "Overview");
		expect(overview[0]).toMatchObject({ type: "banner", title: "Healthy" });
		const table = overview.find((b) => b.block_id === "checks");
		expect(table?.rows.map((x: B) => x.check)).toEqual(["Uptime", "Search engines", "Form messages", "Broken links", "Email DNS records", "Security certificate", "Speed", "Analytics tags", "Backups", "Media", "Missing pages (404)", "Security headers"]);
		expect(tabs(r).map((p) => p.label)).toEqual(["Overview", "Incidents", "Broken links", "Missing pages", "Speed", "Security", "Reports", "Settings"]);
		const w = await call({}, 50, { ui: { surface: "dashboard-widget" } });
		expect(w.blocks[0]).toMatchObject({ type: "banner", title: "Healthy" });
	});
	it("runs checks now, once at a time and at most every 2 minutes", async () => {
		const r = await call({ type: "block_action", action_id: "run-now" });
		expect(r.toast?.type).toBe("success");
		const again = await call({ type: "block_action", action_id: "run-now" });
		expect(again.toast?.message).toContain("less than 2 minutes");
	});
	it("explains a missing SELF binding instead of reporting the site down", async () => {
		delete env.SELF;
		const r = await call({ type: "block_action", action_id: "run-now" });
		expect(r.toast).toMatchObject({ type: "error" });
		expect(tab(r, "Overview").some((b) => b.title === "Checks cannot reach the site")).toBe(true);
		await plugin.hooks.cron.handler({ name: "tick" }, ctx({}));
		expect(await kv.get(KEYS.state)).toBeNull();
	});
	it("saves recipients (validated) and switches; logs counts, never addresses", async () => {
		const bad = await call({ type: "form_submit", action_id: "save-settings", values: { alertsTo: "not-an-address", reportTo: "", alerts: true, report: true } });
		expect(bad.toast?.type).toBe("error");
		const log = { info: vi.fn() };
		await plugin.routes.admin?.handler(ctx({ type: "form_submit", action_id: "save-settings", values: { alertsTo: "a@agency.example\nb@agency.example", reportTo: "boss@acme.example", alerts: true, report: false } }, 50, { log }));
		expect(await kv.get(KEYS.settings)).toEqual({ alertsTo: ["a@agency.example", "b@agency.example"], reportTo: ["boss@acme.example"], alerts: true, report: false });
		expect(JSON.stringify(log.info.mock.calls)).not.toContain("@");
	});
	it("prepares a report, downloads it once through a token, and never twice", async () => {
		const prepared = await call({ type: "block_action", action_id: "report-prepare" });
		expect(prepared.blocks[0]).toMatchObject({ type: "header", text: expect.stringContaining("Report —") });
		const month = (await kv.get<{ month: string }[]>(KEYS.reports))?.[0]?.month as string;
		const dl = await call({ type: "block_action", action_id: "report-download", value: month });
		const link = tab(dl, "Reports").find((b) => b.type === "actions")?.elements[0];
		const url = new URL(link.target.url);
		expect(url.pathname).toBe("/_emdash/api/plugins/site-health/report");
		const get = (token: string | null) => plugin.routes.report?.handler({ input: { token }, kv }) as Promise<{ status: number; headers: [string, string][]; body: { value: string } }>;
		const ok = await get(url.searchParams.get("token"));
		expect(ok.status).toBe(200);
		expect(ok.headers).toContainEqual(["content-disposition", `attachment; filename="acme-report-${month}.html"`]);
		expect(ok.body.value).toContain("Prepared by Example Agency");
		expect((await get(url.searchParams.get("token"))).status).toBe(410);
		expect((await get("../../etc")).status).toBe(410);
	});
	it("the public heartbeat says only when the checks last ran", async () => {
		await plugin.hooks.cron.handler({ name: "tick" }, ctx({}));
		const h = (await plugin.routes.heartbeat?.handler({ kv })) as Record<string, unknown>;
		expect(Object.keys(h).sort()).toEqual(["lastRunAt", "plugin", "version"]);
		const s = (await plugin.routes.status?.handler(ctx({}))) as Record<string, any>;
		expect(s.overall).toBe("healthy");
	});
	it("summarises status and trends", () => {
		expect(overallOf({ lastRunAt: "x", checks: { uptime: { status: "ok", summary: "", at: "" } }, uptime: { fails: {}, open: {}, cursor: 0, retry: [] } })).toBe("healthy");
		expect(overallOf({ lastRunAt: "x", checks: { links: { status: "fail", summary: "", at: "" } }, uptime: { fails: {}, open: {}, cursor: 0, retry: [] } })).toBe("attention");
		expect(overallOf({ lastRunAt: "x", checks: {}, uptime: { fails: {}, open: { "/": { id: "d", path: "/", startedAt: "", status: 0 } }, cursor: 0, retry: [] } })).toBe("down");
		expect(trend([{ d: "a", probes: 0, fails: 0, s: "owfxuooo" }, { d: "b", probes: 0, fails: 0, s: "foooooooo" }], "uptime")).toBe("✓✗");
		expect(trend([{ d: "a", probes: 0, fails: 0, s: "owfxuooo" }], "forms")).toBe("✗");
	});
});

describe("kit side", () => {
	const config = (extra: Record<string, unknown> = {}) => kitConfigSchema.parse({ slug: "acme", name: "Acme", source: { url: ORIGIN }, target: { productionUrl: ORIGIN }, email: { to: ["owner@acme.example"], stagingTo: ["team@agency.example"] }, ...extra });
	it("kit.config: on by default, health: false turns it off, recipients default to email.to / stagingTo", () => {
		expect(config().health).toEqual({ brand: "Prepared by PixelKraft", monthlyReport: true, externalLinks: true, cspReports: true });
		expect(config({ health: false }).health).toBe(false);
		const o = healthOptions({ config: config(), productionUrl: ORIGIN, live: false, logo: "/brand/logo.png", colors: { accent: "#123456" } });
		expect(o).toMatchObject({ alertsTo: ["team@agency.example"], reportTo: ["owner@acme.example"], brand: { footer: "Prepared by PixelKraft", logo: `${ORIGIN}/brand/logo.png` }, live: false });
		expect(healthOptions({ config: config({ health: { alertsTo: ["ops@agency.example"], reportTo: ["ceo@acme.example"], brand: "Prepared by Studio X", externalLinks: false } }), productionUrl: ORIGIN, live: true, logo: "/brand/logo.svg" })).toMatchObject({ alertsTo: ["ops@agency.example"], reportTo: ["ceo@acme.example"], brand: { footer: "Prepared by Studio X" }, externalLinks: false });
		expect(healthOptions({ config: config(), productionUrl: ORIGIN, live: false, logo: "/brand/logo.svg" })?.brand.logo).toBeUndefined();
		expect(healthOptions({ config: config({ health: false }), productionUrl: ORIGIN, live: false })).toBeUndefined();
		expect(healthOptions({ config: config({ analytics: false }), productionUrl: ORIGIN, live: false })?.analytics).toBeUndefined();
	});
	it("embeds the mail DNS baseline from cutover/dns-before.json as hashes only", async () => {
		const dir = mkdtempSync(join(tmpdir(), "health-"));
		try {
			expect(await mailBaselineFrom(join(dir, "cutover"))).toBeUndefined();
			mkdirSync(join(dir, "cutover"));
			writeFileSync(join(dir, "cutover", "dns-before.json"), JSON.stringify({ zone: "acme.example", at: "2026-11-01T00:00:00Z", web: [], keep: [{ type: "MX", name: "acme.example", content: "mx.mail.example", priority: 10, ttl: 1 }, { type: "TXT", name: "acme.example", content: "v=spf1 -all", ttl: 1 }, { type: "TXT", name: "acme.example", content: "some-other-token=abc", ttl: 1 }] }));
			const b = await mailBaselineFrom(join(dir, "cutover"));
			expect(b?.records.map((r) => r.type)).toEqual(["MX", "TXT"]);
			expect(JSON.stringify(b)).not.toMatch(/mx\.mail|spf1|some-other-token/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("binds SELF in wrangler.jsonc when health is on, also without the SEO suite", () => {
		const base = { config: config(), workerName: "acme", compatibilityDate: "2026-11-01", cf: {}, staging: false, sandboxedEnvs: [], productionHost: "acme.example" };
		expect(wranglerJsonc({ ...base, seoPanel: false, health: true })).toContain('"services": [{"binding":"SELF","service":"acme"}]');
		expect(wranglerJsonc({ ...base, seoPanel: false, health: false })).not.toContain('"SELF"');
		expect(wranglerJsonc({ ...base, seoPanel: false, health: true })).toContain('"crons": ["*/5 * * * *"]');
	});
	it("client docs explain the page, the emails, the report and the optional secrets", () => {
		const input: ClientRepoInput = { name: "Acme", slug: "acme", sourceUrl: ORIGIN, productionUrl: ORIGIN, workerName: "acme", productionReady: false, sections: [], forms: [], email: { provider: "brevo", to: ["owner@acme.example"] }, turnstileProduction: true, sensitiveData: false, stack: { node: ">=24", astro: "7", emdash: "1.5", wrangler: "4" } };
		const on = clientRepoFiles({ ...input, health: { alertsTo: ["team@agency.example"], reportTo: ["owner@acme.example"], footer: "Prepared by Example Agency" } });
		expect(on["docs/editor-guide.md"]).toContain("## Site health and the monthly report");
		expect(on["docs/editor-guide.md"]).toContain("at most one per issue per day");
		expect(on["docs/deployment.md"]).toContain("CRUX_API_KEY");
		expect(on["docs/deployment.md"]).toContain("CF_ZONE_READ_TOKEN");
		const off = clientRepoFiles(input);
		expect(off["docs/editor-guide.md"]).not.toContain("Site health");
		expect(off["docs/deployment.md"]).not.toContain("CRUX_API_KEY");
	});
	it("the dashboard's Secrets view lists the optional CRUX_API_KEY with a format check", () => {
		const crux = SECRET_KEYS.find((s) => s.key === "CRUX_API_KEY");
		expect(crux?.label).toContain("optional");
		expect(crux?.check?.("AIzaSyTESTKEY0123456789abcdefghijklmnop")).toBe(true);
		expect(crux?.check?.("not a key")).toBe(false);
		expect(SECRET_KEYS.some((s) => s.key === "CF_ZONE_READ_TOKEN")).toBe(true);
	});
	it("verify: the heartbeat shows the plugin is registered and, on a live site, that it ran recently", async () => {
		const now = Date.UTC(2026, 10, 20, 12);
		const reply = (lastRunAt: string | null, status = 200) => vi.fn(async () => (status === 200 ? Response.json({ success: true, data: { plugin: "site-health", version: "0.1.0", lastRunAt } }) : new Response("", { status })));
		expect(await healthHeartbeat(ORIGIN, { fetch: reply(new Date(now - 6 * 60_000).toISOString()), live: true, now })).toMatchObject({ ok: true });
		expect(await healthHeartbeat(ORIGIN, { fetch: reply(new Date(now - 3 * 3600_000).toISOString()), live: true, now })).toMatchObject({ ok: false });
		expect(await healthHeartbeat(ORIGIN, { fetch: reply(null), live: false, now })).toMatchObject({ ok: true });
		expect(await healthHeartbeat(ORIGIN, { fetch: reply(null, 404), live: false, now })).toMatchObject({ ok: false, detail: expect.stringContaining("not registered") });
		// With a token lacking the admin scope (403 on the private route) it falls back to the heartbeat.
		const f = vi.fn(async (url: string) => (url.endsWith("/status") ? new Response("", { status: 403 }) : Response.json({ data: { lastRunAt: new Date(now).toISOString() } })));
		expect(await healthHeartbeat(ORIGIN, { fetch: f, token: "tok", live: true, now })).toMatchObject({ ok: true, detail: expect.stringContaining("heartbeat") });
	});
});
