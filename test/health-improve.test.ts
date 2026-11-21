/**
 * @wp2emdash/health: "What to improve this month" — ranking, caps, the empty state, the admin links, the on/off
 * options, the SEO suite's cached summary (@wp2emdash/seo/summary), the email and the Site health overview, and that
 * form messages appear as counts only. Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Analysis } from "../packages/seo/src/analyze.js";
import { missingAltImages, parseSeoSummary, readSeoSummary, SUMMARY_OPTION, type SeoSummary, seoSummaryOf, storeSeoSummary } from "../packages/seo/src/summary.js";
import { improvements, improveUrl, MAX_IMPROVEMENTS, NOTHING_TO_IMPROVE, type ImproveInputs } from "../packages/health/src/improve.js";
import { MEDIA_SUMMARY_OPTION } from "../packages/health/src/checks/media.js";
import type { HealthOptions } from "../packages/health/src/index.js";
import { createPlugin } from "../packages/health/src/plugin/index.js";
import { improveBlocks } from "../packages/health/src/plugin/views.js";
import { buildReport, renderReportHtml, renderReportText, type ReportInputs } from "../packages/health/src/report.js";
import { currentImprovements, latestSeoSummary, makeReport, reportFormsTrend, storeReport } from "../packages/health/src/run.js";
import { KEYS, type HealthState } from "../packages/health/src/store.js";
import { memoryKv, outboxKv } from "./health-fixtures.js";
import { env } from "./stubs/cloudflare-workers.js";

type B = Record<string, any>;
const ORIGIN = "https://acme.example";
const NOW = Date.UTC(2026, 10, 1, 8, 5);
const INPUTS: ReportInputs = { month: "2026-10", site: { name: "Acme Pilates", url: ORIGIN }, history: [{ d: "2026-10-01", probes: 288, fails: 0 }], incidents: [], cwv: null, ledger: {}, forms: { total: 23, emailed: 21, kept: 2 }, content: { items: [] }, now: NOW };
const BRAND = { footer: "Prepared by Example Agency" };

const seo = (o: Partial<SeoSummary> = {}): SeoSummary => ({
	v: 1,
	at: "2026-10-31T12:00:00.000Z",
	pages: 12,
	average: 78,
	thin: { count: 5, pages: [{ title: "Prices", words: 80 }, { title: "Classes", words: 120 }, { title: "Team", words: 150 }, { title: "Studio", words: 200 }, { title: "FAQ", words: 250 }] },
	noDescription: { count: 2, pages: ["About", "Blog"] },
	keyword: { count: 1, pages: ["Home"] },
	missingAlt: { count: 3, pages: ["Home", "Studio"] },
	...o,
});
const media = { at: "2026-10-31T03:00:00.000Z", missingAltUsed: 4, oversized: 2, broken: 1 };
const notFound = { at: "2026-10-31T10:00:00.000Z", probes: 3, top: [{ path: "/old-prices/", hits: 40, lastSeen: "2026-10-30" }, { path: "/team.html", hits: 9, lastSeen: "2026-10-30" }, { path: "/a/", hits: 5, lastSeen: "2026-10-30" }, { path: "/b/", hits: 4, lastSeen: "2026-10-30" }, { path: "/rare/", hits: 1, lastSeen: "2026-10-30" }] };
const ALL: ImproveInputs = {
	backups: { status: "fail", summary: "x", at: "2026-10-31T00:00:00.000Z" },
	media,
	seo: seo(),
	notFound,
	cwv: { at: "2026-10-31", lcp: 4600, inp: 150, cls: 0.02 },
	forms: { total: 3, previous: 20 },
};

/** D1 stand-in answering the one-row `options` reads (`.first()` and `.all()`). */
const fakeDb = (rows: Record<string, unknown>) => ({
	prepare: () => ({
		bind: (name: string) => ({
			first: async () => (name in rows ? { value: JSON.stringify(rows[name]) } : null),
			all: async () => ({ results: name in rows ? [{ value: JSON.stringify(rows[name]) }] : [] }),
		}),
	}),
});

describe("What to improve: ranking and caps", () => {
	it("ranks by impact and keeps at most six", () => {
		const list = improvements(ALL);
		expect(list).toHaveLength(MAX_IMPROVEMENTS);
		expect(list.map((x) => x.id)).toEqual(["backups", "broken-images", "speed", "notfound", "forms", "thin"]);
		for (let k = 1; k < list.length; k++) expect((list[k - 1] as { impact: number }).impact).toBeGreaterThanOrEqual((list[k] as { impact: number }).impact);
	});
	it("names at most three pages or addresses and counts the rest", () => {
		const list = improvements({ seo: seo(), notFound });
		const thin = list.find((x) => x.id === "thin");
		expect(thin?.names).toEqual({ label: "Pages", items: ["Prices", "Classes", "Team"], more: 2 });
		expect(thin?.text).toBe("5 pages have too little text for Google to show them in search. Add a few paragraphs: what you offer, who it is for and common questions.");
		// Only addresses asked for 3+ times this week count; redirected ones are already out of the summary.
		const nf = list.find((x) => x.id === "notfound");
		expect(nf).toMatchObject({ count: 4, names: { label: "Addresses", items: ["/old-prices/", "/team.html", "/a/"], more: 1 } });
	});
	it("uses the singular for one and ranks equal kinds by count", () => {
		const list = improvements({ seo: seo({ thin: { count: 1, pages: [{ title: "Prices", words: 80 }] }, noDescription: { count: 0, pages: [] }, keyword: { count: 0, pages: [] }, missingAlt: { count: 0, pages: [] } }) });
		expect(list.map((x) => x.text)).toEqual(["1 page has too little text for Google to show it in search. Add a few paragraphs: what you offer, who it is for and common questions."]);
		expect(list[0]?.names?.more).toBe(0);
	});
	it("speed: poor ranks high, needs-improvement lower, good not at all", () => {
		expect(improvements({ cwv: { at: "x", lcp: 2000, inp: 100, cls: 0.01 } })).toEqual([]);
		const ni = improvements({ cwv: { at: "x", lcp: 3000 } })[0];
		expect(ni).toMatchObject({ id: "speed", impact: 50, link: { plugin: "site-health", tab: "speed" } });
		expect(ni?.text).toContain("3.0 seconds");
		expect(improvements({ cwv: { at: "x", lcp: 5000, cls: 0.3 } })[0]).toMatchObject({ impact: 85, count: 2 });
		expect(improvements({ cwv: { at: "x", missing: "no-key" } })).toEqual([]);
	});
	it("forms: only a clear drop from a meaningful month counts", () => {
		expect(improvements({ forms: { total: 3, previous: 20 } })[0]?.text).toBe("Form messages fell from 20 to 3 compared with the month before. Send yourself a test message to make sure the forms still work.");
		expect(improvements({ forms: { total: 11, previous: 20 } })).toEqual([]);
		expect(improvements({ forms: { total: 0, previous: 4 } })).toEqual([]);
		expect(improvements({ forms: { total: 0 } })).toEqual([]);
	});
	it("pictures without description: the Media Assistant's count (its page) wins over the SEO suite's", () => {
		const withMedia = improvements({ media: { ...media, broken: 0, oversized: 0 }, seo: seo({ thin: { count: 0, pages: [] }, noDescription: { count: 0, pages: [] }, keyword: { count: 0, pages: [] } }) });
		expect(withMedia).toHaveLength(1);
		expect(withMedia[0]).toMatchObject({ id: "alt", count: 4, link: { plugin: "media-assistant", path: "/media" }, names: { label: "On", items: ["Home", "Studio"] } });
		const seoOnly = improvements({ seo: seo({ thin: { count: 0, pages: [] }, noDescription: { count: 0, pages: [] }, keyword: { count: 0, pages: [] } }) });
		expect(seoOnly[0]).toMatchObject({ id: "alt", count: 3, link: { plugin: "site-seo", path: "/seo" } });
	});
});

describe("What to improve: empty state and links", () => {
	it("nothing to improve is an empty list and one positive line", () => {
		expect(improvements({})).toEqual([]);
		expect(improvements({ backups: { status: "ok", summary: "fine", at: "x" }, media: { ...media, missingAltUsed: 0, oversized: 0, broken: 0 }, notFound: { at: "x", probes: 0, top: [{ path: "/rare/", hits: 2, lastSeen: "x" }] } })).toEqual([]);
		const r = buildReport({ ...INPUTS, improve: [] });
		expect(renderReportHtml(r, BRAND)).toContain(NOTHING_TO_IMPROVE);
		expect(renderReportText(r, BRAND)).toContain(`WHAT TO IMPROVE THIS MONTH\n${NOTHING_TO_IMPROVE}`);
		expect(improveBlocks([], ORIGIN)).toEqual([{ type: "header", text: "What to improve this month" }, { type: "context", text: `✓ ${NOTHING_TO_IMPROVE}` }]);
	});
	it("older reports without the list show no section", () => {
		const r = buildReport(INPUTS);
		expect(r.improve).toBeUndefined();
		expect(renderReportHtml(r, BRAND)).not.toContain("What to improve");
		expect(improveBlocks(undefined, ORIGIN)).toEqual([]);
	});
	it("links to the exact admin page that fixes each item", () => {
		const list = improvements({ ...ALL, cwv: null, forms: undefined, backups: undefined });
		const urls = Object.fromEntries(list.map((x) => [x.id, improveUrl(`${ORIGIN}/`, x.link)]));
		expect(urls).toMatchObject({ "broken-images": `${ORIGIN}/_emdash/admin/plugins/media-assistant/media`, thin: `${ORIGIN}/_emdash/admin/plugins/site-seo/seo`, notfound: `${ORIGIN}/_emdash/admin/plugins/site-health/health` });
		expect(improveUrl(ORIGIN, improvements({ forms: { total: 0, previous: 10 } })[0]?.link as never)).toBe(`${ORIGIN}/_emdash/admin/plugins/site-forms/messages`);
		expect(improveUrl(ORIGIN, improvements({ backups: { status: "warn", summary: "x", at: "x" } })[0]?.link as never)).toBe(`${ORIGIN}/_emdash/admin/plugins/site-backups/backups`);
		// Admin: Site health's own tabs open with a button, other plugins' pages with a link.
		const rows = (improveBlocks(list, ORIGIN)[1] as B).rows as B[];
		expect(rows.find((r) => r.todo.includes("redirect"))?.open).toEqual({ type: "button", action_id: "improve-tab", label: "See Missing pages", value: "missing" });
		expect(rows[0]?.open).toEqual({ type: "link", label: "Open Media", target: { kind: "external", url: `${ORIGIN}/_emdash/admin/plugins/media-assistant/media` } });
	});
	it("renders in the email (HTML, escaped, and plain text) with the production address", () => {
		const list = improvements({ ...ALL, seo: seo({ thin: { count: 1, pages: [{ title: "<b>Prices</b>", words: 80 }] } }) });
		const r = buildReport({ ...INPUTS, improve: list });
		const html = renderReportHtml(r, BRAND);
		expect(html).toContain("What to improve this month");
		expect(html).toContain(`href="${ORIGIN}/_emdash/admin/plugins/site-backups/backups"`);
		expect(html).toContain("Pages: &#60;b&#62;Prices&#60;/b&#62;");
		expect(html).not.toContain("<b>Prices");
		expect(html.indexOf("What to improve")).toBeLessThan(html.indexOf("Availability"));
		const text = renderReportText(r, BRAND);
		expect(text).toContain("1. Backups are not working");
		expect(text).toContain(`   Open Backups: ${ORIGIN}/_emdash/admin/plugins/site-backups/backups`);
		expect(text).toContain("   Addresses: /old-prices/, /team.html, /a/ and 1 more");
	});
});

describe("What to improve: sources and options", () => {
	const OPTS: HealthOptions = { productionUrl: ORIGIN, siteName: "Acme", live: true, alertsTo: [], reportTo: [], brand: BRAND, seo: {}, media: true, backups: true, formsOutbox: true };
	const failing: HealthState = { v: 1, jobs: {}, checks: { backups: { status: "fail", summary: "x", at: "x" } }, uptime: { fails: {}, open: {}, cursor: 0, retry: [] } };

	it("reads the other plugins' stored summaries and skips the plugins a site does not run", async () => {
		const kv = memoryKv();
		await kv.set(KEYS.state, failing);
		await kv.set(KEYS.notFound, notFound);
		const DB = fakeDb({ [SUMMARY_OPTION]: seo(), [MEDIA_SUMMARY_OPTION]: media });
		const on = await currentImprovements({ kv, options: OPTS, env: { DB } as never }, { forms: { total: 3, previous: 20 } });
		expect(on.map((x) => x.id)).toEqual(["backups", "broken-images", "notfound", "forms", "thin", "description"]);
		const off = await currentImprovements({ kv, options: { ...OPTS, seo: undefined, media: false, backups: false, formsOutbox: false }, env: { DB } as never }, { forms: { total: 3, previous: 20 } });
		expect(off.map((x) => x.id)).toEqual(["notfound"]);
		// No D1 at all: the stored checks still work.
		expect((await currentImprovements({ kv, options: OPTS, env: {} })).map((x) => x.id)).toEqual(["backups", "notfound"]);
	});
	it("uses the newest SEO summary: the SEO suite's own or the one the last report calculated", async () => {
		const kv = memoryKv();
		await kv.set(KEYS.seoSummary, seo({ at: "2026-11-01T08:00:00.000Z", average: 90 }));
		const DB = fakeDb({ [SUMMARY_OPTION]: seo({ at: "2026-10-20T00:00:00.000Z", average: 70 }) });
		expect((await latestSeoSummary({ kv, env: { DB } as never }))?.average).toBe(90);
		expect((await latestSeoSummary({ kv, env: { DB: fakeDb({ [SUMMARY_OPTION]: seo({ at: "2026-11-02T00:00:00.000Z", average: 60 }) }) } as never }))?.average).toBe(60);
		expect(await latestSeoSummary({ kv: memoryKv(), env: {} })).toBeUndefined();
	});
	it("the report compares form counts with the month before and never reads a message", async () => {
		const kv = memoryKv();
		const outbox = outboxKv();
		await outbox.put("stat:2026-10-04:emailed:contact", "2");
		await outbox.put("stat:2026-10-09:kept:contact", "1");
		await outbox.put("msg:2026-10-04T10:00:00.000Z:ab12", JSON.stringify({ fields: { message: "PRIVATE-MESSAGE-TEXT", email: "visitor@example.com" } }), { metadata: { at: "2026-10-04T10:00:00.000Z" } });
		await kv.set(KEYS.report("2026-09"), { ...buildReport({ ...INPUTS, month: "2026-09" }), forms: { total: 20, emailed: 20, kept: 0 } });
		const d = { kv, options: { ...OPTS, seo: undefined, media: false, backups: false }, env: { FORM_OUTBOX: outbox } as never, self: vi.fn() as never, fetch: vi.fn() as never, now: NOW };
		const r = await makeReport(d, "2026-10");
		expect(r.forms).toEqual({ total: 3, emailed: 2, kept: 1 });
		expect(r.improve?.map((x) => x.id)).toEqual(["forms"]);
		expect(r.improve?.[0]?.text).toContain("from 20 to 3");
		const all = JSON.stringify(r) + renderReportHtml(r, BRAND) + renderReportText(r, BRAND);
		expect(all).not.toContain("PRIVATE-MESSAGE-TEXT");
		expect(all).not.toContain("visitor@example.com");
		// The admin compares the last two stored reports the same way (counts only).
		await storeReport(kv, r);
		expect(await reportFormsTrend(kv)).toEqual({ total: 3, previous: 20 });
	});
});

describe("SEO suite: cached page summary", () => {
	const analysis = (o: Partial<Analysis> & { kw?: "bad" | "good" }): Analysis => ({ score: 70, serp: {} as never, words: 400, thin: false, ...o, checks: o.kw ? [{ id: "keyword", label: "Focus keyword", status: o.kw, detail: "" }] : [] });
	it("summarises the analysis: thin pages fewest words first, missing descriptions, focus keyword, pictures", () => {
		const pages = [
			{ title: "Home", analysis: analysis({ score: 90, kw: "bad" }), seo: { description: "Studio in town." } },
			{ title: "Prices", analysis: analysis({ score: 50, words: 200, thin: true }), seo: null },
			{ title: "Team", analysis: analysis({ score: 60, words: 90, thin: true }), seo: { description: "  " } },
			{ title: "Hidden", analysis: analysis({ score: 40, kw: "bad" }), seo: { noIndex: true } },
		];
		const media = new Map([["01HZZZZZZZZZZZZZZZZZZZZZZA", { mimeType: "image/jpeg", filename: "a.jpg" }], ["01HZZZZZZZZZZZZZZZZZZZZZZB", { mimeType: "image/jpeg", alt: "Desk" }], ["01HZZZZZZZZZZZZZZZZZZZZZZC", { mimeType: "application/pdf" }]]);
		const alt = missingAltImages([{ title: "Home", ids: ["01HZZZZZZZZZZZZZZZZZZZZZZA", "01HZZZZZZZZZZZZZZZZZZZZZZB"] }, { title: "Team", ids: ["01HZZZZZZZZZZZZZZZZZZZZZZA", "01HZZZZZZZZZZZZZZZZZZZZZZC"] }], media);
		expect(alt).toEqual([{ id: "01HZZZZZZZZZZZZZZZZZZZZZZA", filename: "a.jpg", pages: ["Home", "Team"] }]);
		const s = seoSummaryOf(pages, alt, NOW);
		expect(s).toEqual({ v: 1, at: new Date(NOW).toISOString(), pages: 4, average: 60, thin: { count: 2, pages: [{ title: "Team", words: 90 }, { title: "Prices", words: 200 }] }, noDescription: { count: 2, pages: ["Prices", "Team"] }, keyword: { count: 1, pages: ["Home"] }, missingAlt: { count: 1, pages: ["Home", "Team"] } });
		expect(parseSeoSummary(s)).toEqual(s);
		expect(parseSeoSummary({ v: 1, at: "x" })).toBeUndefined();
	});
	it("writes only when something changed or the stored one is 6 hours old, and reads back from D1", async () => {
		const kv = memoryKv();
		const s = seo({ at: "2026-11-01T08:00:00.000Z" });
		expect(await storeSeoSummary(kv, s)).toBe(true);
		expect(await storeSeoSummary(kv, { ...s, at: "2026-11-01T09:00:00.000Z" })).toBe(false);
		expect(await storeSeoSummary(kv, { ...s, at: "2026-11-01T09:00:00.000Z", average: 80 })).toBe(true);
		expect(await storeSeoSummary(kv, { ...s, at: "2026-11-01T16:00:00.000Z", average: 80 })).toBe(true);
		expect(await readSeoSummary(fakeDb({ [SUMMARY_OPTION]: s }) as never)).toEqual(s);
		expect(await readSeoSummary(fakeDb({}) as never)).toBeNull();
		expect(await readSeoSummary(undefined)).toBeUndefined();
	});
});

describe("Site health overview", () => {
	const OPTIONS: HealthOptions = { productionUrl: ORIGIN, siteName: "Acme", live: true, alertsTo: [], reportTo: [], brand: BRAND, seo: {} };
	const plugin = createPlugin(OPTIONS) as unknown as { routes: Record<string, { handler: (ctx: unknown) => Promise<unknown> }> };
	let kv: ReturnType<typeof memoryKv>;
	const call = (input: unknown) => plugin.routes.admin?.handler({ input, kv, request: new Request(`${ORIGIN}/_emdash/api/plugins/site-health/admin`), user: { id: "u1", role: 50 }, log: { info: vi.fn() } }) as Promise<{ blocks: B[] }>;
	const panels = (r: { blocks: B[] }) => r.blocks.find((b) => b.type === "tab") as { default_tab: number; panels: { label: string; blocks: B[] }[] };
	beforeEach(() => {
		kv = memoryKv();
		for (const k of Object.keys(env)) delete env[k];
		Object.assign(env, { SELF: { fetch: vi.fn(async () => new Response("")) }, EMAIL_PROVIDER: "brevo" });
	});
	afterEach(() => vi.unstubAllGlobals());

	it("shows the same list as the report on the Overview, and opens Site health's own tabs", async () => {
		await kv.set(KEYS.notFound, notFound);
		Object.assign(env, { DB: fakeDb({ [SUMMARY_OPTION]: seo() }) });
		const r = await call({ type: "page_load", page: "/health" });
		const overview = panels(r).panels[0]?.blocks ?? [];
		expect(overview.find((b) => b.type === "header" && b.text === "What to improve this month")).toBeTruthy();
		const rows = overview.find((b) => b.block_id === "improve")?.rows as B[];
		expect(rows.map((x) => x.n)).toEqual(["1.", "2.", "3.", "4.", "5."]);
		expect(rows[0]?.todo).toContain("Visitors keep arriving at 4 addresses");
		expect(rows[1]?.open).toMatchObject({ type: "link", target: { kind: "external", url: `${ORIGIN}/_emdash/admin/plugins/site-seo/seo` } });
		const missing = await call({ type: "block_action", action_id: "improve-tab", value: "missing" });
		expect(panels(missing).default_tab).toBe(3);
	});
	it("says so in one line when nothing needs doing", async () => {
		const r = await call({ type: "page_load", page: "/health" });
		const overview = panels(r).panels[0]?.blocks ?? [];
		expect(overview.find((b) => b.type === "context" && String(b.text).includes(NOTHING_TO_IMPROVE))).toBeTruthy();
	});
});
