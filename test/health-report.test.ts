/**
 * @wp2emdash/health: the monthly report — built from synthetic history, incidents, links ledger, visits, form counts,
 * content and SEO score; rendered as HTML (golden file) and plain text; no personal data. Synthetic data only.
 */
import { describe, expect, it, vi } from "vitest";
import { buildReport, headline, renderReportHtml, renderReportText, reportMail, type ReportInputs } from "../packages/health/src/report.js";
import { makeReport, storeReport } from "../packages/health/src/run.js";
import { KEYS } from "../packages/health/src/store.js";
import { memoryKv } from "./health-fixtures.js";

const NOW = Date.UTC(2026, 10, 1, 8, 5);
const day = (d: number, extra: Record<string, number> = {}) => ({ d: `2026-10-${String(d).padStart(2, "0")}`, probes: 288, fails: d === 14 ? 6 : 0, ttfb50: 300 + d, ...extra });

export const INPUTS: ReportInputs = {
	month: "2026-10",
	site: { name: "Acme Pilates", url: "https://acme.example" },
	history: [{ d: "2026-09-30", probes: 288, fails: 288 }, ...Array.from({ length: 31 }, (_, i) => day(i + 1, i === 29 ? { lcp: 2100, inp: 180, cls: 0.04 } : {}))],
	incidents: [
		{ id: "down-1", kind: "down", title: "Site down: the home page does not answer", startedAt: "2026-10-14T03:10:00.000Z", endedAt: "2026-10-14T03:40:00.000Z", detail: "/: HTTP 503, 2 checks in a row" },
		{ id: "page-1", kind: "page", title: "Page error on /pricing/", startedAt: "2026-10-20T10:00:00.000Z", endedAt: "2026-10-20T10:10:00.000Z" },
		{ id: "old", kind: "down", title: "Site down: the home page does not answer", startedAt: "2026-09-01T00:00:00.000Z", endedAt: "2026-09-01T00:30:00.000Z" },
	],
	cwv: null,
	ledger: { "/old-offer/": { first: "2026-10-03T03:00:00.000Z", fixed: "2026-10-05T03:00:00.000Z" }, "/missing/": { first: "2026-10-21T03:00:00.000Z" }, "https://gone.example/": { first: "2026-09-02T03:00:00.000Z", external: true } },
	visits: { visits: 4210, pageViews: 9876, pages: [{ path: "/", views: 4000 }, { path: "/classes/", views: 2100 }, { path: "/pricing/", views: 900 }], referrers: [{ host: "www.google.com", views: 1500 }, { host: "instagram.com", views: 300 }] },
	forms: { total: 23, emailed: 21, kept: 2 },
	content: {
		items: [
			{ title: "Winter timetable", publishedAt: "2026-10-12T09:00:00.000Z", updatedAt: "2026-10-12T09:00:00.000Z" },
			{ title: "Pricing", publishedAt: "2025-01-01T00:00:00.000Z", updatedAt: "2026-10-18T12:00:00.000Z" },
			{ title: "About", publishedAt: "2025-01-01T00:00:00.000Z", updatedAt: "2025-06-01T00:00:00.000Z" },
		],
	},
	seo: { average: 84, pages: 12 },
	now: NOW,
};
const BRAND = { footer: "Prepared by Example Agency", logo: "https://acme.example/brand/logo.png", colors: { bg: "#ffffff", text: "#222222", accent: "#7a4b8c" } };

describe("monthly report", () => {
	it("summarises the month from what the checks stored", () => {
		const r = buildReport(INPUTS);
		expect(r.uptime).toMatchObject({ probes: 31 * 288, fails: 6, downMinutes: 30 });
		expect(r.uptime.pct).toBeCloseTo(99.93, 2);
		expect(r.uptime.incidents.map((i) => i.title)).toEqual(["Site down: the home page does not answer", "Page error on /pricing/"]);
		expect(r.speed).toMatchObject({ ttfbMedian: 316, cwv: { lcp: 2100, inp: 180, cls: 0.04, at: "2026-10-30" } });
		expect(r.content).toMatchObject({ published: 1, updated: 1 });
		expect(r.links).toEqual({ found: 2, fixed: 1, open: 2 });
		expect(headline(r)).toBe("99.93% uptime, 1 outage, 4,210 visits, 23 form messages.");
	});
	it("renders the branded HTML email (golden file) and a plain-text part", async () => {
		const r = buildReport(INPUTS);
		const html = renderReportHtml(r, BRAND);
		await expect(html).toMatchFileSnapshot("./golden/health-report.html");
		expect(html).toContain('<img src="https://acme.example/brand/logo.png"');
		expect(html).toContain("#7a4b8c");
		expect(html).toContain("Prepared by Example Agency");
		expect(html).toContain("@media print");
		const text = renderReportText(r, BRAND);
		expect(text).toContain("AVAILABILITY");
		expect(text).toContain("23 messages (count only).");
		expect(reportMail(r, { brand: BRAND }).subject).toBe("Acme Pilates: website report for October 2026");
	});
	it("explains what is missing instead of inventing numbers", () => {
		const r = buildReport({ ...INPUTS, history: [], visits: { missing: "Visits need the read-only Cloudflare token CF_ANALYTICS_TOKEN." }, forms: undefined, seo: undefined, incidents: [] });
		const html = renderReportHtml(r, { footer: "Prepared by Example Agency" });
		expect(html).toContain("Availability was not measured this month.");
		expect(html).toContain("CF_ANALYTICS_TOKEN");
		expect(html).toContain("not counted on this site");
		// No raster logo: the site name as text; SVG or non-https logos are never put in an email.
		expect(renderReportHtml(r, { footer: "x", logo: "https://acme.example/brand/logo.svg" })).not.toContain("<img");
		expect(renderReportHtml(r, { footer: "x", logo: "javascript:alert(1)//.png" })).not.toContain("<img");
	});
	it("escapes page titles and never carries personal data", () => {
		const r = buildReport({ ...INPUTS, content: { items: [{ title: '<script>alert("x")</script>', publishedAt: "2026-10-02T00:00:00.000Z" }] } });
		const html = renderReportHtml(r, BRAND);
		expect(html).not.toContain("<script>");
		expect(html).toContain("&#60;script&#62;");
		// The report type has no field for form contents or visitors' details at all.
		expect(Object.keys(r.forms ?? {})).toEqual(["total", "emailed", "kept"]);
	});
	it("is stored for 12 months and built from the plugin's KV", async () => {
		const kv = memoryKv();
		await kv.set(KEYS.history, INPUTS.history);
		await kv.set(KEYS.incidents, INPUTS.incidents);
		await kv.set(KEYS.ledger, INPUTS.ledger);
		const d = { kv, options: { productionUrl: "https://acme.example", siteName: "Acme Pilates", live: true, alertsTo: [], reportTo: [], brand: BRAND }, env: {}, self: vi.fn() as never, fetch: vi.fn() as never, now: NOW };
		const r = await makeReport(d, "2026-10", { visits: INPUTS.visits, forms: INPUTS.forms, content: INPUTS.content, seo: INPUTS.seo });
		expect(r.uptime.downMinutes).toBe(30);
		for (let m = 1; m <= 14; m++) await storeReport(kv, { ...r, month: `2025-${String(m).padStart(2, "0")}`.replace(/^2025-1([3-4])$/, "2026-0$1") });
		const index = (await kv.get<{ month: string }[]>(KEYS.reports)) ?? [];
		expect(index).toHaveLength(12);
		expect([...kv.store.keys()].filter((k) => k.startsWith("report:"))).toHaveLength(12);
	});
});
