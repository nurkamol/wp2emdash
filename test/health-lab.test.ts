/**
 * Site health: the weekly PageSpeed Insights lab score (checks/lab.ts, lab.ts, the Speed tab's "Lab score" section).
 * Google is mocked; response shapes follow developers.google.com/speed/docs/insights/rest/v5/pagespeedapi/runpagespeed
 * and Lighthouse 10+'s list → table nesting of the LCP-element audit (docs/spikes/health-findings.md).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { labAlertEvents } from "../packages/health/src/alerts.js";
import { addRuns, fetchPsi, LAB_DROP, LAB_WEEKS, labDrop, labDue, labKey, type LabRun, type LabStore, MAX_LAB_RUNS, parsePsi, PSI_FIELDS, psiMissing, psiUrl } from "../packages/health/src/checks/lab.js";
import type { HealthOptions } from "../packages/health/src/index.js";
import { runLab } from "../packages/health/src/lab.js";
import { createPlugin } from "../packages/health/src/plugin/index.js";
import { labSection, type PageData, withChange } from "../packages/health/src/plugin/views.js";
import type { RunDeps } from "../packages/health/src/run.js";
import { emptyState, KEYS } from "../packages/health/src/store.js";
import { memoryKv, SECURE_HEADERS } from "./health-fixtures.js";
import { env } from "./stubs/cloudflare-workers.js";

type B = Record<string, any>;
const ORIGIN = "https://acme.example";
const KEY = `AIza${"SyPSITESTKEY0123456789abcdefghijklm"}`;
const CRUX = `AIza${"SyCRUXTESTKEY0123456789abcdefghijkl"}`;
const T0 = Date.UTC(2026, 10, 23, 10, 0, 0);
const OPTIONS: HealthOptions = { productionUrl: ORIGIN, siteName: "Acme", live: true, alertsTo: ["team@agency.example"], reportTo: ["owner@acme.example"], brand: { footer: "Prepared by Example Agency" } };

/** A trimmed PSI answer (what the `fields` selection returns), Lighthouse 10+ shapes. */
function psiAnswer(perf: number | null, o: { lcp?: number; runtimeError?: { code: string; message: string } } = {}) {
	return {
		lighthouseResult: {
			finalUrl: `${ORIGIN}/`,
			...(o.runtimeError ? { runtimeError: o.runtimeError } : {}),
			categories: { performance: { score: perf }, accessibility: { score: 0.968 }, "best-practices": { score: 1 }, seo: { score: 0.92 } },
			audits: {
				"first-contentful-paint": { numericValue: 1234.56 },
				"largest-contentful-paint": { numericValue: o.lcp ?? 2890.4 },
				"total-blocking-time": { numericValue: 152.2 },
				"cumulative-layout-shift": { numericValue: 0.04321 },
				"speed-index": { numericValue: 3010.9 },
				"largest-contentful-paint-element": { details: { type: "list", items: [{ type: "table", headings: [], items: [{ node: { type: "node", selector: "main > img", snippet: `<img src="/media/hero.webp"\n   alt="Hero" fetchpriority="high">`, nodeLabel: "Hero" } }] }, { type: "table", items: [{ phase: "TTFB", timing: 300 }] }] } },
			},
		},
	};
}

describe("PageSpeed Insights: request and answer", () => {
	it("asks for one strategy, all four categories (repeated) and a trimmed answer; the key only as `key`", () => {
		const u = new URL(psiUrl(`${ORIGIN}/`, "mobile", KEY));
		expect(u.origin + u.pathname).toBe("https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed");
		expect(u.searchParams.get("url")).toBe(`${ORIGIN}/`);
		expect(u.searchParams.get("strategy")).toBe("MOBILE");
		expect(u.searchParams.getAll("category")).toEqual(["PERFORMANCE", "ACCESSIBILITY", "BEST_PRACTICES", "SEO"]);
		expect(u.searchParams.get("fields")).toBe(PSI_FIELDS);
		expect(u.searchParams.get("key")).toBe(KEY);
		expect(new URL(psiUrl(`${ORIGIN}/`, "desktop", KEY, false)).searchParams.has("fields")).toBe(false);
	});
	it("reads scores (0–100), metrics and the LCP element (Lighthouse 10+ list → table nesting)", () => {
		const r = parsePsi(psiAnswer(0.874), "mobile", "2026-11-23T10:00:00.000Z") as LabRun;
		expect(r).toEqual({ at: "2026-11-23T10:00:00.000Z", strategy: "mobile", perf: 87, a11y: 97, bp: 100, seo: 92, fcp: 1235, lcp: 2890, tbt: 152, cls: 0.043, si: 3011, lcpEl: `<img src="/media/hero.webp" alt="Hero" fetchpriority="high">` });
		// Older Lighthouse: the table directly.
		const old = parsePsi({ lighthouseResult: { categories: { performance: { score: 0.5 } }, audits: { "largest-contentful-paint-element": { details: { type: "table", items: [{ node: { snippet: "<h1>Hi</h1>" } }] } } } } }, "desktop", "t", true) as LabRun;
		expect(old).toMatchObject({ perf: 50, lcpEl: "<h1>Hi</h1>", pre: true });
		expect((parsePsi({ lighthouseResult: { audits: { "largest-contentful-paint-element": { details: { items: [{ node: { snippet: "x".repeat(400) } }] } } }, categories: { performance: { score: 0.1 } } } }, "mobile", "t") as LabRun).lcpEl).toHaveLength(160);
	});
	it("a null score is left out; a Lighthouse runtime error or an empty answer gives no run", () => {
		expect(parsePsi(psiAnswer(null), "mobile", "t")).toMatchObject({ lcp: 2890 });
		expect((parsePsi(psiAnswer(null), "mobile", "t") as LabRun).perf).toBeUndefined();
		expect(parsePsi(psiAnswer(0.9, { runtimeError: { code: "NO_FCP", message: "The page did not paint" } }), "mobile", "t")).toEqual({ missing: "lighthouse-NO_FCP" });
		expect(parsePsi({}, "mobile", "t")).toEqual({ missing: "no-result" });
	});
	it("names failures with fixed words, never Google's text", () => {
		expect(psiMissing(429, "Quota exceeded for quota metric 'Queries'")).toBe("quota");
		expect(psiMissing(400, "API key not valid. Please pass a valid API key.")).toBe("key-refused");
		expect(psiMissing(403, "PageSpeed Insights API has not been used in project 1 before or it is disabled.")).toBe("api-disabled");
		expect(psiMissing(500, "Lighthouse returned error: FAILED_DOCUMENT_REQUEST. Lighthouse was unable to load the page")).toBe("lighthouse-FAILED_DOCUMENT_REQUEST");
		expect(psiMissing(503, "")).toBe("http-503");
	});
	it("fetches with a long time limit, retries once without `fields` when Google rejects the selection", async () => {
		const f = vi.fn(async (url: string, _init?: RequestInit) => (new URL(url).searchParams.has("fields") ? Response.json({ error: { code: 400, message: "Invalid field selection lighthouseResult" } }, { status: 400 }) : Response.json(psiAnswer(0.81))));
		const r = await fetchPsi(`${ORIGIN}/`, "desktop", KEY, f as never, T0);
		expect(r).toMatchObject({ strategy: "desktop", perf: 81 });
		expect(f).toHaveBeenCalledTimes(2);
		expect(f.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
	});
	it("maps quota, refused keys, timeouts and network errors", async () => {
		const answer = (status: number, message: string) => vi.fn(async () => Response.json({ error: { code: status, message } }, { status }));
		expect(await fetchPsi(`${ORIGIN}/`, "mobile", KEY, answer(429, "Quota exceeded") as never)).toEqual({ missing: "quota" });
		expect(await fetchPsi(`${ORIGIN}/`, "mobile", KEY, answer(400, "API key not valid. Please pass a valid API key.") as never)).toEqual({ missing: "key-refused" });
		const timeout = vi.fn(async () => {
			throw new DOMException("The operation timed out.", "TimeoutError");
		});
		expect(await fetchPsi(`${ORIGIN}/`, "mobile", KEY, timeout as never)).toEqual({ missing: "timeout" });
		const down = vi.fn(async () => {
			throw new TypeError("fetch failed");
		});
		expect(await fetchPsi(`${ORIGIN}/`, "mobile", KEY, down as never)).toEqual({ missing: "unreachable" });
	});
	it("uses PAGESPEED_API_KEY, else CRUX_API_KEY", () => {
		expect(labKey({ PAGESPEED_API_KEY: KEY, CRUX_API_KEY: CRUX })).toBe(KEY);
		expect(labKey({ PAGESPEED_API_KEY: " ", CRUX_API_KEY: CRUX })).toBe(CRUX);
		expect(labKey({})).toBeUndefined();
	});
});

const run = (at: number, strategy: "mobile" | "desktop", perf?: number): LabRun => ({ at: new Date(at).toISOString(), strategy, ...(perf !== undefined ? { perf } : {}) });

describe("lab history, schedule and the drop alert", () => {
	it("keeps 26 weeks, sorted, at most MAX_LAB_RUNS", () => {
		const week = 7 * 86_400_000;
		const old = run(T0 - (LAB_WEEKS * week + 86_400_000), "mobile", 50);
		const kept = run(T0 - 10 * week, "mobile", 60);
		expect(addRuns([old, kept], [run(T0, "mobile", 70)], T0).map((r) => r.perf)).toEqual([60, 70]);
		const many = Array.from({ length: 200 }, (_, i) => run(T0 - i * 3_600_000, "desktop", i % 100));
		const trimmed = addRuns([], many, T0);
		expect(trimmed).toHaveLength(MAX_LAB_RUNS);
		expect(trimmed.at(-1)?.at).toBe(new Date(T0).toISOString());
		// Bounded size: well under the plugin KV row budget.
		expect(JSON.stringify(trimmed.map((r) => ({ ...r, a11y: 100, bp: 100, seo: 100, fcp: 1000, lcp: 2000, tbt: 100, cls: 0.1, si: 2000, lcpEl: "x".repeat(160) }))).length).toBeLessThan(40_000);
	});
	it("is due weekly from 09 UTC, at once the first time, and whenever an admin asked", () => {
		const empty: LabStore = { v: 1, runs: [] };
		expect(labDue(empty, null, T0)).toBe("weekly");
		const next = new Date(T0 + 7 * 86_400_000).toISOString();
		expect(labDue({ ...empty, next }, null, T0 + 86_400_000)).toBeUndefined();
		expect(labDue({ ...empty, next }, null, T0 + 7 * 86_400_000)).toBe("weekly");
		expect(labDue({ ...empty, next }, null, Date.UTC(2026, 10, 30, 3))).toBeUndefined();
		expect(labDue({ ...empty, next }, { at: new Date(T0).toISOString() }, T0 + 60_000)).toBe("manual");
		expect(labDue({ ...empty, next }, { at: new Date(T0).toISOString(), done: new Date(T0).toISOString() }, T0 + 60_000)).toBeUndefined();
	});
	it("alerts when mobile performance drops by 15 points or more", () => {
		const before = [run(T0 - 7 * 86_400_000, "mobile", 90), run(T0 - 7 * 86_400_000, "desktop", 99)];
		expect(LAB_DROP).toBe(15);
		expect(labDrop(before, [run(T0, "mobile", 76)])).toBeUndefined();
		expect(labDrop(before, [run(T0, "mobile", 75)])).toEqual({ from: 90, to: 75 });
		expect(labDrop(before, [run(T0, "desktop", 10)])).toBeUndefined();
		expect(labDrop([], [run(T0, "mobile", 10)])).toBeUndefined();
		const [e] = labAlertEvents("Acme", { from: 90, to: 75 });
		expect(e).toMatchObject({ issue: "lab-drop", severity: "problem", subject: "Acme: the mobile speed score dropped to 75" });
		expect(labAlertEvents("Acme", undefined)).toEqual([]);
	});
});

describe("runLab (cron path)", () => {
	afterEach(() => vi.unstubAllGlobals());
	function setup(envExtra: Record<string, string> = {}, o: Partial<HealthOptions> = {}, perf = { mobile: 0.88, desktop: 0.97 }) {
		const kv = memoryKv();
		const logs: unknown[] = [];
		const google: string[] = [];
		const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.startsWith("https://api.brevo.com")) return new Response(JSON.stringify({ messageId: "m" }), { status: 201 });
			if (url.startsWith("https://pagespeedonline.googleapis.com")) {
				google.push(url);
				const s = new URL(url).searchParams.get("strategy");
				return Response.json(psiAnswer(s === "MOBILE" ? perf.mobile : perf.desktop));
			}
			return new Response(null, { status: init?.method === "HEAD" ? 200 : 404 });
		});
		// The email provider is called through the global fetch (@wp2emdash/forms deliver).
		vi.stubGlobal("fetch", fetcher);
		const d = (now: number): RunDeps => ({ kv, options: { ...OPTIONS, ...o }, env: { EMAIL_PROVIDER: "brevo", EMAIL_API_KEY: "xkeysib-secret-email-key", FORM_FROM: "Acme <noreply@acme.example>", ...envExtra } as never, self: vi.fn() as never, fetch: fetcher as never, log: { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a) }, now });
		return { kv, logs, google, fetcher, d };
	}
	const brevo = (f: ReturnType<typeof vi.fn>) => f.mock.calls.filter(([u]) => String(u).startsWith("https://api.brevo.com"));

	it("without a key calls nothing and closes an open request", async () => {
		const s = setup();
		await s.kv.set(KEYS.labRequest, { at: new Date(T0).toISOString() });
		expect(await runLab(s.d(T0))).toEqual({ ran: false, why: "no-key" });
		expect(s.google).toHaveLength(0);
		expect((await s.kv.get<{ done?: string }>(KEYS.labRequest))?.done).toBeDefined();
	});
	it("tests mobile and desktop of the production home page, stores them, plans the next week; falls back to CRUX_API_KEY", async () => {
		const s = setup({ CRUX_API_KEY: CRUX });
		const r = await runLab(s.d(T0));
		expect(r.ran).toBe(true);
		expect(s.google.map((u) => new URL(u).searchParams.get("strategy")).sort()).toEqual(["DESKTOP", "MOBILE"]);
		expect(s.google.every((u) => new URL(u).searchParams.get("url") === `${ORIGIN}/` && new URL(u).searchParams.get("key") === CRUX)).toBe(true);
		const store = await s.kv.get<LabStore>(KEYS.lab);
		expect(store?.runs.map((x) => [x.strategy, x.perf])).toEqual([
			["mobile", 88],
			["desktop", 97],
		]);
		expect(store?.next).toBe(new Date(T0 + 7 * 86_400_000).toISOString());
		expect(await s.kv.get(KEYS.labLock)).toBeNull();
		// Not due again an hour later.
		expect((await runLab(s.d(T0 + 3_600_000))).why).toBe("not-due");
	});
	it("prefers PAGESPEED_API_KEY and never stores or logs it", async () => {
		const s = setup({ PAGESPEED_API_KEY: KEY, CRUX_API_KEY: CRUX });
		await runLab(s.d(T0));
		expect(new URL(s.google[0] as string).searchParams.get("key")).toBe(KEY);
		const kvDump = JSON.stringify([...s.kv.store.entries()]);
		for (const secret of [KEY, CRUX, "xkeysib"]) {
			expect(kvDump).not.toContain(secret);
			expect(JSON.stringify(s.logs)).not.toContain(secret);
		}
	});
	it("retries a day later after a failed attempt and records why", async () => {
		const s = setup({ PAGESPEED_API_KEY: KEY });
		s.fetcher.mockImplementation(async () => Response.json({ error: { code: 429, message: "Quota exceeded" } }, { status: 429 }));
		const r = await runLab(s.d(T0));
		expect(r.missing).toEqual({ mobile: "quota", desktop: "quota" });
		const store = await s.kv.get<LabStore>(KEYS.lab);
		expect(store?.runs).toEqual([]);
		expect(store?.last?.missing).toEqual({ mobile: "quota", desktop: "quota" });
		expect(store?.next).toBe(new Date(T0 + 86_400_000).toISOString());
	});
	it("runs an admin's request at the next tick and closes it", async () => {
		const s = setup({ PAGESPEED_API_KEY: KEY });
		await runLab(s.d(T0));
		await s.kv.set(KEYS.labRequest, { at: new Date(T0 + 3_600_000).toISOString() });
		const r = await runLab(s.d(T0 + 3_660_000));
		expect(r.ran).toBe(true);
		expect((await s.kv.get<{ done?: string }>(KEYS.labRequest))?.done).toBe(new Date(T0 + 3_660_000).toISOString());
		expect((await s.kv.get<LabStore>(KEYS.lab))?.runs).toHaveLength(4);
	});
	it("emails a drop of 15+ points once (live sites only), and never from staging", async () => {
		const s = setup({ PAGESPEED_API_KEY: KEY }, {}, { mobile: 0.75, desktop: 0.97 });
		await s.kv.set(KEYS.lab, { v: 1, runs: [run(T0 - 7 * 86_400_000, "mobile", 95)], next: new Date(T0).toISOString() });
		const r = await runLab(s.d(T0));
		expect(r.alerts).toEqual({ sent: 1, held: 0 });
		const mail = JSON.parse(String((brevo(s.fetcher)[0] as unknown as [string, RequestInit])[1].body));
		expect(mail.subject).toBe("Acme: the mobile speed score dropped to 75");
		expect(JSON.stringify(mail)).not.toContain(KEY);
		const pre = setup({ PAGESPEED_API_KEY: KEY }, { live: false }, { mobile: 0.75, desktop: 0.97 });
		await pre.kv.set(KEYS.lab, { v: 1, runs: [run(T0 - 7 * 86_400_000, "mobile", 95)], next: new Date(T0).toISOString() });
		const held = await runLab(pre.d(T0));
		expect(held.alerts).toMatchObject({ sent: 0, notEmailed: expect.stringContaining("not live") });
		expect((await pre.kv.get<LabStore>(KEYS.lab))?.runs.at(-1)?.pre).toBe(true);
		const staging = setup({ PAGESPEED_API_KEY: KEY, STAGING: "1" });
		expect(await runLab(staging.d(T0))).toEqual({ ran: false, why: "staging" });
		expect(staging.google).toHaveLength(0);
	});
	it("is single-flight", async () => {
		const s = setup({ PAGESPEED_API_KEY: KEY });
		await s.kv.set(KEYS.labLock, { until: new Date(T0 + 60_000).toISOString() });
		expect((await runLab(s.d(T0))).why).toBe("locked");
	});
});

const pageData = (extra: Partial<PageData> = {}): PageData => ({ state: emptyState(), today: null, history: [], incidents: [], links: null, cwv: null, reports: [], settings: {}, defaults: { alertsTo: [], reportTo: [] }, email: { ready: true, provider: "brevo" }, live: true, staging: false, secrets: { crux: false, zone: false, analytics: false }, selfBinding: true, productionUrl: ORIGIN, ...extra });

describe("the Speed tab's Lab score section", () => {
	it("explains lab vs real-visitor data and how to add a key when none is set", () => {
		const b = labSection(pageData()) as B[];
		expect(b[0]).toEqual({ type: "header", text: "Lab score (PageSpeed)" });
		expect(b[1]?.text).toMatch(/real-visitor/i);
		const setupBanner = b.find((x) => x.type === "banner");
		expect(setupBanner?.description).toContain("PAGESPEED_API_KEY");
		expect(setupBanner?.description).toContain('"PageSpeed Insights API"');
		expect(setupBanner?.description).toContain("CRUX_API_KEY");
		expect(b.some((x) => x.type === "actions")).toBe(false);
	});
	it("shows the latest scores, metrics, the LCP element, a chart and the last 8 tests with up/down marks", () => {
		const w = 7 * 86_400_000;
		const runs: LabRun[] = [];
		for (let i = 9; i >= 0; i--) {
			runs.push({ ...run(T0 - i * w, "mobile", i === 0 ? 70 : 90), lcp: 2500, ...(i === 0 ? { a11y: 98, bp: 100, seo: 91, fcp: 1200, tbt: 150, cls: 0.02, si: 2900, lcpEl: "<img src=/hero.webp>" } : {}) });
			runs.push(run(T0 - i * w, "desktop", 99));
		}
		const b = labSection(pageData({ secrets: { crux: false, pagespeed: true, zone: false, analytics: false }, lab: { v: 1, runs, next: new Date(T0 + w).toISOString() } })) as B[];
		const stats = b.find((x) => x.type === "stats");
		expect(stats?.items.slice(0, 2)).toEqual([
			{ label: "Mobile performance", value: "70", description: "Needs improvement", trend: "neutral" },
			{ label: "Desktop performance", value: "99", description: "Good", trend: "up" },
		]);
		const latest = b.find((x) => x.block_id === "lab-latest");
		expect(latest?.rows[1]).toEqual({ metric: "Largest Contentful Paint (main content shown)", mobile: "2.5 s", desktop: "—" });
		expect(b.some((x) => x.type === "context" && String(x.text).includes("<img src=/hero.webp>"))).toBe(true);
		const chart = b.find((x) => x.type === "chart");
		expect(chart?.config.series.map((s: B) => [s.name, s.data.length])).toEqual([
			["Mobile", 10],
			["Desktop", 10],
		]);
		const history = b.find((x) => x.block_id === "lab-history");
		expect(history?.rows).toHaveLength(8);
		expect(history?.rows[0]).toMatchObject({ mobile: "70 ▼ −20", desktop: "99 =" });
		expect(b.find((x) => x.type === "actions")?.elements[0]).toMatchObject({ action_id: "lab-run" });
		expect([withChange(92, 88), withChange(undefined, 1), withChange(5, undefined)]).toEqual(["92 ▲ +4", "—", "5"]);
	});
	it("says when the last test failed and when a test was asked for", () => {
		const b = labSection(pageData({ secrets: { crux: true, zone: false, analytics: false }, lab: { v: 1, runs: [], last: { at: new Date(T0).toISOString(), missing: { mobile: "api-disabled" } } }, labRequest: { at: new Date(T0).toISOString() } })) as B[];
		expect(b.find((x) => x.title === "The last test did not finish")?.description).toContain("PageSpeed Insights API is not enabled");
		expect(b.some((x) => x.title === "Test asked for")).toBe(true);
		expect(b.at(-1)?.text).toContain("CRUX_API_KEY");
	});
});

describe("plugin: Run PageSpeed test now and the cron tick", () => {
	const plugin = createPlugin(OPTIONS) as unknown as { hooks: Record<string, any>; routes: Record<string, { handler: (ctx: unknown) => Promise<unknown> }> };
	let kv: ReturnType<typeof memoryKv>;
	const cron = { schedule: vi.fn(async () => {}), list: vi.fn(async () => [{ name: "tick", schedule: "*/5 * * * *" }]) };
	const ctx = (input: unknown, role = 50) => ({ input, kv, cron, request: new Request(`${ORIGIN}/_emdash/api/plugins/site-health/admin`), user: { id: "u1", role }, log: { info: vi.fn(), warn: vi.fn() } });
	const call = (input: unknown, role = 50) => plugin.routes.admin?.handler(ctx(input, role)) as Promise<{ blocks: B[]; toast?: { message: string; type: string } }>;
	const selfFetch = vi.fn(async () => new Response(`<html><head><link rel="canonical" href="${ORIGIN}/"></head><body></body></html>`, { headers: { "content-type": "text/html", ...SECURE_HEADERS } }));
	const google = vi.fn(async (url: string) => (String(url).startsWith("https://pagespeedonline.googleapis.com") ? Response.json(psiAnswer(0.9)) : new Response("", { status: 404 })));

	beforeEach(() => {
		kv = memoryKv();
		for (const k of Object.keys(env)) delete env[k];
		Object.assign(env, { SELF: { fetch: selfFetch }, EMAIL_PROVIDER: "brevo" });
		google.mockClear();
		vi.stubGlobal("fetch", google);
	});
	afterEach(() => vi.unstubAllGlobals());

	it("is for admins only", async () => {
		expect((await call({ type: "block_action", action_id: "lab-run" }, 40)).blocks[0]).toMatchObject({ title: "Admins only" });
		expect(await kv.get(KEYS.labRequest)).toBeNull();
	});
	it("asks for a key first", async () => {
		const r = await call({ type: "block_action", action_id: "lab-run" });
		expect(r.toast?.type).toBe("error");
		expect(await kv.get(KEYS.labRequest)).toBeNull();
	});
	it("stores the request (at most every 10 minutes); the next tick runs it and the tab shows the scores", async () => {
		env.PAGESPEED_API_KEY = KEY;
		const r = await call({ type: "block_action", action_id: "lab-run" });
		expect(r.toast?.type).toBe("success");
		expect(google).not.toHaveBeenCalled();
		const again = await call({ type: "block_action", action_id: "lab-run" });
		expect(again.toast?.message).toContain("already on its way");
		await plugin.hooks.cron.handler({ name: "tick" }, ctx({}));
		expect(google.mock.calls.filter(([u]) => String(u).startsWith("https://pagespeedonline.googleapis.com"))).toHaveLength(2);
		const page = await call({});
		const speed = (page.blocks.find((b) => b.type === "tab")?.panels as { label: string; blocks: B[] }[]).find((p) => p.label === "Speed")?.blocks ?? [];
		expect(speed.find((b) => b.type === "stats" && b.items[0]?.label === "Mobile performance")?.items[0].value).toBe("90");
		const done = await call({ type: "block_action", action_id: "lab-run" });
		expect(done.toast?.message).toContain("less than 10 minutes");
	});
});
