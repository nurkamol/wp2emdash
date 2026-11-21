/**
 * @wp2emdash/health: check logic (uptime incidents, indexability, forms, links, mail DNS, certificate, speed,
 * analytics), cron planning and stagger, alert rate limiting and email gating, and a full run against an in-memory KV
 * with every network request mocked. Synthetic data only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { alertEvents, alertMail, MAX_PER_DAY, pickAlerts } from "../packages/health/src/alerts.js";
import { analyticsCheck, pageTrackers } from "../packages/health/src/checks/analytics.js";
import { compareMail, dnsCheck, isMailRecord, mailBaseline, normalise } from "../packages/health/src/checks/dns.js";
import { formsCheck, readForms } from "../packages/health/src/checks/forms.js";
import { homeIndexing, indexabilityCheck, parseSiteFiles, sitemapPaths } from "../packages/health/src/checks/indexability.js";
import { externalSample, extractLinks, linksCheck, resultOf, startJob, stepJob, updateLedger } from "../packages/health/src/checks/links.js";
import { fetchCrux, rate, speedCheck } from "../packages/health/src/checks/speed.js";
import { readCertificates, sslCheck } from "../packages/health/src/checks/ssl.js";
import { applyProbes, countHome, pickPaths } from "../packages/health/src/checks/uptime.js";
import { mailReady, sendMail } from "../packages/health/src/email.js";
import type { HealthOptions } from "../packages/health/src/index.js";
import { acquireLock, emailBlocked, mergeIncidents, releaseLock, runChecks, type RunDeps } from "../packages/health/src/run.js";
import { DAILY_HOUR, EXTERNAL_SAMPLE, LINK_BUDGET, linksHour, planRun, REPORT_HOUR, reportDue } from "../packages/health/src/schedule.js";
import { emptyState, KEYS, rollDay, upsertDay } from "../packages/health/src/store.js";
import { countMessage, enqueue } from "../packages/forms/src/outbox.js";
import { memoryKv, outboxKv, SECURE_HEADERS } from "./health-fixtures.js";

const HOST = "acme.example";
const ORIGIN = `https://${HOST}`;
const T0 = Date.UTC(2026, 10, 20, 1, 0, 0);

const html = (body: string, head = "") => `<!doctype html><html><head><link rel="canonical" href="${ORIGIN}/">${head}</head><body>${body}</body></html>`;
const SITEMAP = `<urlset><url><loc>${ORIGIN}/</loc></url><url><loc>${ORIGIN}/about/</loc></url><url><loc>${ORIGIN}/contact/</loc></url></urlset>`;

/** The site as the Worker serves it to itself (SELF): a map of path → response factory. */
function site(routes: Record<string, () => Response>, calls: string[] = []) {
	return vi.fn(async (url: string) => {
		const u = new URL(url);
		calls.push(u.pathname);
		const r = routes[u.pathname];
		return r ? r() : new Response("not found", { status: 404 });
	});
}
const page = (body = "", head = "") => () => new Response(html(body, head), { headers: { "content-type": "text/html; charset=utf-8", ...SECURE_HEADERS } });

const OPTIONS: HealthOptions = { productionUrl: ORIGIN, siteName: "Acme", live: true, alertsTo: ["team@agency.example"], reportTo: ["owner@acme.example"], brand: { footer: "Prepared by Example Agency" } };

afterEach(() => vi.unstubAllGlobals());

describe("schedule: cron planning and stagger", () => {
	const at = (h: number, m = 0, day = 20) => Date.UTC(2026, 10, day, h, m);
	it("runs uptime every tick and the light jobs by interval", () => {
		const fresh = planRun(at(1), { jobs: {} }, { host: HOST, linkJobActive: false, reportDue: false });
		expect(fresh.light).toEqual(["uptime", "forms", "index", "analytics", "backups", "media", "notfound", "headers"]);
		expect(fresh.heavy).toBeUndefined();
		const later = planRun(at(1, 5), { jobs: { forms: new Date(at(1)).toISOString(), index: new Date(at(1)).toISOString(), analytics: new Date(at(1)).toISOString(), backups: new Date(at(1)).toISOString(), media: new Date(at(1)).toISOString(), notfound: new Date(at(1)).toISOString(), headers: new Date(at(1)).toISOString() } }, { host: HOST, linkJobActive: false, reportDue: false });
		expect(later.light).toEqual(["uptime"]);
		expect(planRun(at(1, 15), { jobs: { forms: new Date(at(1)).toISOString(), index: new Date(at(1)).toISOString(), analytics: new Date(at(1)).toISOString(), backups: new Date(at(1)).toISOString(), media: new Date(at(1)).toISOString(), notfound: new Date(at(1)).toISOString(), headers: new Date(at(1)).toISOString() } }, { host: HOST, linkJobActive: false, reportDue: false }).light).toEqual(["uptime", "forms"]);
	});
	it("runs at most one heavy job per tick, staggered over the night", () => {
		const h = linksHour(HOST);
		expect(h).toBeGreaterThanOrEqual(2);
		expect(h).toBeLessThanOrEqual(4);
		expect(planRun(at(h - 1, 55), { jobs: {} }, { host: HOST, linkJobActive: false, reportDue: false }).heavy).toBeUndefined();
		expect(planRun(at(h), { jobs: {} }, { host: HOST, linkJobActive: false, reportDue: false })).toMatchObject({ heavy: "links", startLinks: true });
		// An unfinished link check goes first; everything else waits.
		expect(planRun(at(9), { jobs: {} }, { host: HOST, linkJobActive: true, reportDue: true })).toMatchObject({ heavy: "links" });
		const ran = (jobs: string[]) => Object.fromEntries(jobs.map((j) => [j, new Date(at(4, 10)).toISOString()]));
		expect(planRun(at(7, 30), { jobs: ran(["links"]) }, { host: HOST, linkJobActive: false, reportDue: false }).heavy).toBe("dns");
		expect(planRun(at(7, 35), { jobs: ran(["links", "dns"]) }, { host: HOST, linkJobActive: false, reportDue: false }).heavy).toBe("ssl");
		expect(planRun(at(7, 40), { jobs: ran(["links", "dns", "ssl"]) }, { host: HOST, linkJobActive: false, reportDue: false }).heavy).toBe("speed");
		expect(planRun(at(7, 45), { jobs: ran(["links", "dns", "ssl", "speed"]) }, { host: HOST, linkJobActive: false, reportDue: false }).heavy).toBeUndefined();
		expect(DAILY_HOUR.dns).toBeLessThan(DAILY_HOUR.ssl);
	});
	it("makes the monthly report on the 1st from 08 UTC, catching up until the 3rd", () => {
		expect(reportDue(Date.UTC(2026, 11, 1, 8), [], "2026-11")).toBe(true);
		expect(reportDue(Date.UTC(2026, 11, 3, 23), [], "2026-11")).toBe(true);
		expect(reportDue(Date.UTC(2026, 11, 4, 8), [], "2026-11")).toBe(false);
		expect(reportDue(Date.UTC(2026, 11, 1, 8), ["2026-11"], "2026-11")).toBe(false);
		const ran = { links: new Date(Date.UTC(2026, 11, 1, 3)).toISOString() };
		expect(planRun(Date.UTC(2026, 11, 1, REPORT_HOUR - 1, 30), { jobs: ran }, { host: HOST, linkJobActive: false, reportDue: true }).heavy).toBe("dns");
		expect(planRun(Date.UTC(2026, 11, 1, REPORT_HOUR), { jobs: ran }, { host: HOST, linkJobActive: false, reportDue: true }).heavy).toBe("report");
	});
	it("keeps one tick well inside the Workers subrequest limit (50 on Free)", () => {
		// uptime ≤ 3, index ≤ 5 (robots, sitemap, ≤ 3 children), one heavy job (links ≤ LINK_BUDGET; dns ≤ 8), alerts ≤ 6.
		expect(3 + 5 + Math.max(LINK_BUDGET, 8) + 6).toBeLessThan(50);
		expect(EXTERNAL_SAMPLE).toBeLessThanOrEqual(20);
	});
	it("manual runs do everything except a full link check", () => {
		expect(planRun(T0, { jobs: {} }, { host: HOST, linkJobActive: false, reportDue: false, manual: true })).toMatchObject({ light: ["uptime", "forms", "index", "analytics", "backups", "media", "notfound", "headers"], startLinks: true });
	});
});

describe("uptime: incident detection", () => {
	const ok = { url: "", status: 200, ms: 120 };
	const down = { url: "", status: 503, ms: 40 };
	const none = { url: "", status: 0, ms: 8000, error: "no answer within 8 s" };
	it("opens an incident after two failures in a row and closes it on recovery", () => {
		let u = emptyState().uptime;
		const one = applyProbes(u, [{ path: "/", probe: down }], 0, T0);
		expect(one.opened).toEqual([]);
		expect(one.uptime.fails["/"]).toBe(1);
		u = one.uptime;
		const two = applyProbes(u, [{ path: "/", probe: none }], 0, T0 + 300_000);
		expect(two.opened).toHaveLength(1);
		expect(two.opened[0]).toMatchObject({ kind: "down", title: expect.stringContaining("Site down") });
		u = two.uptime;
		// Still down: no second incident.
		const three = applyProbes(u, [{ path: "/", probe: down }], 0, T0 + 600_000);
		expect(three.opened).toEqual([]);
		const back = applyProbes(three.uptime, [{ path: "/", probe: ok }], 0, T0 + 900_000);
		expect(back.closed).toHaveLength(1);
		expect(back.closed[0]?.detail).toContain("after 10 min");
		expect(back.uptime.open).toEqual({});
		expect(back.uptime.fails).toEqual({});
	});
	it("a single failure followed by success is not an incident", () => {
		const a = applyProbes(emptyState().uptime, [{ path: "/", probe: down }], 0, T0);
		const b = applyProbes(a.uptime, [{ path: "/", probe: ok }], 0, T0 + 300_000);
		expect([...a.opened, ...b.opened, ...b.closed]).toEqual([]);
	});
	it("rotates through sitemap pages and retries a failed page first", () => {
		const u = emptyState().uptime;
		const p1 = pickPaths(u, ["/", "/a/", "/b/", "/c/"]);
		expect(p1.paths).toEqual(["/", "/a/"]);
		const failed = applyProbes(u, [{ path: "/", probe: ok }, { path: "/a/", probe: down }], p1.cursor, T0);
		expect(failed.uptime.retry).toEqual(["/a/"]);
		const p2 = pickPaths(failed.uptime, ["/", "/a/", "/b/", "/c/"]);
		expect(p2.paths).toEqual(["/", "/a/", "/b/"]);
		const again = applyProbes(failed.uptime, [{ path: "/", probe: ok }, { path: "/a/", probe: down }, { path: "/b/", probe: ok }], p2.cursor, T0 + 300_000);
		expect(again.opened[0]).toMatchObject({ kind: "page", title: "Page error on /a/" });
	});
	it("counts home probes per day and rolls the day into a 90-day history", () => {
		let today = rollDay([], null, T0).today;
		today = countHome(today, { url: "", status: 200, ms: 100 });
		today = countHome(today, { url: "", status: 500, ms: 50 });
		today = countHome(today, { url: "", status: 200, ms: 300 });
		expect(today).toMatchObject({ probes: 3, fails: 1, ttfb: [100, 300] });
		const next = rollDay([], today, T0 + 86_400_000, { s: "oooooooo" });
		expect(next.history).toEqual([{ d: "2026-11-20", probes: 3, fails: 1, ttfb50: 200, s: "oooooooo" }]);
		expect(next.today).toMatchObject({ d: "2026-11-21", probes: 0 });
		let h: ReturnType<typeof upsertDay> = [];
		for (let i = 0; i < 100; i++) h = upsertDay(h, new Date(T0 + i * 86_400_000).toISOString().slice(0, 10), { probes: 1 });
		expect(h).toHaveLength(90);
	});
	it("merges incidents and keeps 90 days", () => {
		const old = { id: "x", kind: "down" as const, title: "Site down", startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T01:00:00.000Z" };
		const open = { id: "y", kind: "down" as const, title: "Site down", startedAt: new Date(T0).toISOString() };
		const merged = mergeIncidents([old, open], [], [{ ...open, endedAt: new Date(T0 + 600_000).toISOString() }], T0 + 600_000);
		expect(merged.map((i) => i.id)).toEqual(["y"]);
		expect(merged[0]?.endedAt).toBeDefined();
	});
});

describe("indexability", () => {
	it("reads noindex from the robots meta and the X-Robots-Tag header, and the canonical host", () => {
		const good = homeIndexing({ url: "", status: 200, ms: 1, html: html("") }, ORIGIN);
		expect(good).toEqual({ noindex: [], canonical: `${ORIGIN}/`, canonicalOk: true });
		const bad = homeIndexing({ url: "", status: 200, ms: 1, xRobotsTag: "noindex, nofollow", html: html("", '<meta name="robots" content="noindex">').replace(ORIGIN, "https://acme.agency.workers.dev") }, ORIGIN);
		expect(bad.noindex).toHaveLength(2);
		expect(bad.canonicalOk).toBe(false);
		const files = parseSiteFiles({ url: "", status: 200, ms: 1, html: "User-agent: *\nDisallow: /" }, 200, [`${ORIGIN}/`]);
		expect(indexabilityCheck(bad, files, 200, "t")).toMatchObject({ status: "fail" });
		expect(indexabilityCheck(good, parseSiteFiles({ url: "", status: 200, ms: 1, html: "User-agent: *\nAllow: /" }, 200, [`${ORIGIN}/`]), 200, "t").status).toBe("ok");
		expect(indexabilityCheck(good, parseSiteFiles({ url: "", status: 200, ms: 1, html: "" }, 404, []), 200, "t").status).toBe("fail");
		expect(sitemapPaths([`${ORIGIN}/a/`, `https://www.${HOST}/b/`, "https://other.example/c/"], ORIGIN)).toEqual(["/a/", "/b/"]);
	});
});

describe("analytics tags", () => {
	const meta = (o: unknown) => `<meta name="site-analytics" content="${JSON.stringify(o).replace(/"/g, "&quot;")}">`;
	it("compares the page's tags with the switched-on codes", () => {
		expect(pageTrackers(html("", meta({ google: ["G-ABC123DEF4"], gtm: [], meta: [] })))).toMatchObject({ google: ["G-ABC123DEF4"] });
		const want = { google: ["G-ABC123DEF4"], gtm: [], meta: ["123456789012345"] };
		expect(analyticsCheck(want, html("", meta(want)), "t").status).toBe("ok");
		expect(analyticsCheck(want, html("", meta({ google: ["G-ABC123DEF4"], gtm: [], meta: [] })), "t")).toMatchObject({ status: "fail", summary: expect.stringContaining("Meta Pixel 123456789012345") });
		expect(analyticsCheck(want, html(""), "t").status).toBe("fail");
		expect(analyticsCheck({ google: [], gtm: [], meta: [] }, html("", meta({ google: ["G-ZZZ999ZZZ9"], gtm: [], meta: [] })), "t").status).toBe("warn");
		expect(analyticsCheck(undefined, html(""), "t").status).toBe("off");
		expect(analyticsCheck(null, html(""), "t").status).toBe("warn");
	});
});

describe("forms (read through @wp2emdash/forms)", () => {
	it("reports waiting and refused messages as counts, never their content", async () => {
		const kv = outboxKv();
		const env = { FORM_OUTBOX: kv, EMAIL_PROVIDER: "brevo", EMAIL_API_KEY: "k", FORM_FROM: "Site <noreply@acme.example>", FORM_TO: "owner@acme.example" };
		await enqueue(env, { form: "contact", replyTo: { email: "visitor@private.example", name: "Visitor Name" }, subject: "Hello", text: "My secret health detail", html: "<p>x</p>", attempts: 2 });
		await countMessage(env, "contact", "emailed");
		const f = await readForms(env, { now: Date.now() });
		expect(f).toMatchObject({ outbox: true, status: "ready", waiting: 1, failed: 1, week: 1 });
		const c = formsCheck(f, "t");
		expect(c.status).toBe("fail");
		expect(JSON.stringify(c)).not.toMatch(/visitor@|Visitor Name|secret health/);
		expect(formsCheck({ outbox: false, waiting: 0, failed: 0, week: 0 }, "t").status).toBe("off");
		expect(formsCheck({ outbox: true, status: "no-email", waiting: 2, failed: 0, week: 2 }, "t").status).toBe("fail");
		expect(formsCheck({ outbox: true, status: "held", waiting: 0, failed: 0, week: 0 }, "t").status).toBe("ok");
	});
});

describe("broken links", () => {
	it("extracts the site's own links and links to other sites", () => {
		const l = extractLinks(`<a href="/about/">a</a><a href="https://www.${HOST}/contact/#form">b</a><a href='mailto:x@y.z'>m</a><a href="tel:1">t</a><a href="#top">t</a><a href="https://other.example/x">o</a><a href="/_emdash/admin">admin</a><!-- <a href="/hidden/"> --><script>"<a href='/js/'>"</script>`, `${ORIGIN}/`, ORIGIN);
		expect(l.internal).toEqual([`${ORIGIN}/about/`, `${ORIGIN}/contact/`]);
		expect(l.external).toEqual(["https://other.example/x"]);
	});
	it("checks every sitemap page and link within the per-tick budget, resumably", async () => {
		const calls: string[] = [];
		const self = site(
			{
				"/": page(`<a href="/about/">About</a><a href="/old-page/">Old</a><a href="/files/menu.pdf">PDF</a><a href="https://gone.example/x">Gone</a><a href="https://blocked.example/">Blocked</a>`),
				"/about/": page(`<a href="/">Home</a><a href="/missing/">Missing</a>`),
				"/contact/": page(""),
				"/files/menu.pdf": () => new Response(null, { status: 200 }),
				"/old-page/": () => new Response(null, { status: 301, headers: { location: "/about/" } }),
			},
			calls,
		);
		const external = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.startsWith("https://gone.example")) return new Response(null, { status: 404 });
			return new Response(null, { status: init?.method === "HEAD" ? 405 : 403 });
		});
		let job = startJob(["/", "/about/", "/contact/"], ORIGIN, true, T0);
		let steps = 0;
		let done = false;
		while (!done) {
			const r = await stepJob(job, { self: self as never, external: external as never, productionUrl: ORIGIN, budget: 2, concurrency: 2, sample: 5, now: T0 });
			expect(r.requests).toBeLessThanOrEqual(2);
			job = r.job;
			done = r.done;
			if (++steps > 20) throw new Error("did not finish");
		}
		expect(steps).toBeGreaterThan(2);
		const result = resultOf(job, ORIGIN, T0);
		expect(result.broken).toEqual([
			{ url: "/missing/", status: 404, on: ["/about/"] },
			{ url: "https://gone.example/x", status: 404, on: ["/"], external: true },
		]);
		expect(result.external).toMatchObject({ checked: 2, broken: 1, unchecked: 1 });
		// HEAD first, GET only where HEAD is not allowed; every address once.
		expect(calls.filter((c) => c === "/about/")).toHaveLength(1);
		expect(external.mock.calls.filter(([u]) => String(u).startsWith("https://blocked.example")).map(([, i]) => (i as RequestInit).method)).toEqual(["HEAD", "GET"]);
		expect(linksCheck(result, undefined, "t").status).toBe("fail");
	});
	it("keeps a ledger: new broken links once, fixed when they stop failing", () => {
		const r1 = { at: "", pages: 1, checked: 2, broken: [{ url: "/a/", status: 404, on: ["/"] }] };
		const a = updateLedger({}, r1, T0, false);
		expect(a.fresh).toHaveLength(1);
		const b = updateLedger(a.ledger, r1, T0 + 86_400_000, false);
		expect(b.fresh).toHaveLength(0);
		const c = updateLedger(b.ledger, { ...r1, broken: [] }, T0 + 2 * 86_400_000, false);
		expect(c.ledger["/a/"]?.fixed).toBeDefined();
	});
	it("samples a different, stable set of external links each week", () => {
		const urls = Array.from({ length: 60 }, (_, i) => `https://site${i}.example/`);
		const w1 = externalSample(urls, T0, 20);
		expect(w1).toHaveLength(20);
		expect(externalSample(urls, T0 + 3600_000, 20)).toEqual(w1);
		expect(externalSample(urls, T0 + 7 * 86_400_000, 20)).not.toEqual(w1);
	});
});

describe("mail DNS against the go-live baseline", () => {
	const records = [
		{ type: "MX", name: HOST, content: "mx1.mail.example", priority: 10 },
		{ type: "TXT", name: HOST, content: '"v=spf1 include:_spf.mail.example ~all"' },
		{ type: "TXT", name: `_dmarc.${HOST}`, content: "v=DMARC1; p=none" },
		{ type: "TXT", name: HOST, content: "google-site-verification=abc" },
		{ type: "A", name: `shop.${HOST}`, content: "192.0.2.1" },
	];
	it("hashes mail records only and normalises like DNS answers", async () => {
		expect(records.filter(isMailRecord).map((r) => r.type)).toEqual(["MX", "TXT", "TXT"]);
		expect(normalise("MX", "mx1.mail.example", 10)).toBe(normalise("MX", "10 MX1.mail.example."));
		expect(normalise("TXT", '"v=spf1 include:a" " ~all"')).toBe("v=spf1 include:a ~all");
		const base = await mailBaseline(HOST, records, "2026-11-01T00:00:00Z");
		expect(base.records).toHaveLength(3);
		expect(JSON.stringify(base)).not.toContain("mx1.mail.example");
		expect(JSON.stringify(base)).not.toContain("spf1");
	});
	it("compares the baseline with DNS over HTTPS", async () => {
		const base = await mailBaseline(HOST, records, "2026-11-01T00:00:00Z");
		const answers: Record<string, { type: number; data: string }[]> = {
			[`${HOST} MX`]: [{ type: 15, data: "10 mx1.mail.example." }],
			[`${HOST} TXT`]: [{ type: 16, data: '"v=spf1 include:_spf.mail.example ~all"' }, { type: 16, data: '"google-site-verification=abc"' }],
			[`_dmarc.${HOST} TXT`]: [{ type: 16, data: '"v=DMARC1; p=none"' }],
		};
		const doh = (over: Record<string, { type: number; data: string }[]> = {}) =>
			vi.fn(async (url: string) => {
				const u = new URL(url);
				expect(u.host).toBe("cloudflare-dns.com");
				const k = `${u.searchParams.get("name")} ${u.searchParams.get("type")}`;
				return Response.json({ Status: 0, Answer: over[k] ?? answers[k] ?? [] });
			});
		const same = await compareMail(base, doh() as never);
		expect(dnsCheck(base, same, "t").status).toBe("ok");
		const changed = await compareMail(base, doh({ [`${HOST} MX`]: [{ type: 15, data: "10 mx.other.example." }] }) as never);
		expect(dnsCheck(base, changed, "t")).toMatchObject({ status: "fail", summary: expect.stringContaining(`MX ${HOST}`) });
		expect(dnsCheck(undefined, undefined, "t").status).toBe("off");
	});
});

describe("certificate (optional zone token)", () => {
	const TOKEN = "zone-read-token-0123456789abcdefghijklmnopqrstuv";
	it("reads the earliest expiry of active packs covering the host; the token never leaks", async () => {
		const f = vi.fn(async (url: string, init?: RequestInit) => {
			expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
			if (url.includes("/zones?name=")) return Response.json({ success: true, result: [{ id: "z1" }] });
			return Response.json({ success: true, result: [{ status: "active", certificate_authority: "google", certificates: [{ hosts: [HOST, `*.${HOST}`], expires_on: "2027-02-01T00:00:00Z" }, { hosts: ["other.example"], expires_on: "2026-12-01T00:00:00Z" }] }] });
		});
		const c = await readCertificates(HOST, TOKEN, f as never);
		expect(c).toMatchObject({ expiresOn: "2027-02-01T00:00:00Z", issuer: "google" });
		expect(sslCheck(c, true, "t", Date.parse("2027-01-10T00:00:00Z")).status).toBe("ok");
		expect(sslCheck(c, true, "t", Date.parse("2027-01-28T00:00:00Z")).status).toBe("fail");
		const refused = await readCertificates(HOST, TOKEN, (async () => new Response("no", { status: 403 })) as never);
		expect(JSON.stringify(refused)).not.toContain(TOKEN);
		expect(sslCheck(undefined, true, "t").summary).toContain("CF_ZONE_READ_TOKEN");
	});
});

describe("speed: Chrome UX Report", () => {
	const KEY = "AIzaSyTESTKEY0123456789abcdefghijklmnop";
	it("reads p75 LCP / INP / CLS and rates them; explains a missing key or data", async () => {
		const f = vi.fn(async () => Response.json({ record: { metrics: { largest_contentful_paint: { percentiles: { p75: 2300 } }, interaction_to_next_paint: { percentiles: { p75: 250 } }, cumulative_layout_shift: { percentiles: { p75: "0.31" } } } } }));
		const c = await fetchCrux(ORIGIN, KEY, f as never, T0);
		expect(c).toMatchObject({ lcp: 2300, inp: 250, cls: 0.31 });
		const body = JSON.parse(String((f.mock.calls[0] as unknown as [string, RequestInit])[1].body));
		expect(body).toMatchObject({ origin: ORIGIN });
		expect([rate("lcp", 2300), rate("inp", 250), rate("cls", 0.31)]).toEqual(["good", "needs-improvement", "poor"]);
		const s = speedCheck(400, c, "t");
		expect(s.status).toBe("warn");
		expect(JSON.stringify(s)).not.toContain(KEY);
		expect(await fetchCrux(ORIGIN, undefined, f as never)).toMatchObject({ missing: "no-key" });
		expect(await fetchCrux(ORIGIN, KEY, (async () => new Response("", { status: 404 })) as never)).toMatchObject({ missing: "not-enough-data" });
		expect(speedCheck(undefined, { at: "", missing: "no-key" }, "t").detail?.join(" ")).toContain("CRUX_API_KEY");
	});
});

describe("alerts: rate limiting and gating", () => {
	const e = (issue: string) => ({ issue, subject: issue, lines: [issue], severity: "problem" as const });
	it("sends at most one email per issue per day and at most MAX_PER_DAY a day", () => {
		const first = pickAlerts([e("down")], {}, T0);
		expect(first.send).toHaveLength(1);
		const again = pickAlerts([e("down"), e("up")], first.log, T0 + 3600_000);
		expect(again.send.map((x) => x.issue)).toEqual(["up"]);
		expect(again.held.map((x) => x.issue)).toEqual(["down"]);
		expect(pickAlerts([e("down")], again.log, T0 + 86_400_000).send).toHaveLength(1);
		const many = pickAlerts(Array.from({ length: 10 }, (_, i) => e(`issue-${i}`)), {}, T0);
		expect(many.send).toHaveLength(MAX_PER_DAY);
		// Old entries are pruned after a week.
		expect(Object.keys(pickAlerts([], { down: "2026-01-01" }, T0).log)).toEqual([]);
	});
	it("emails on a change into failure, not while a check stays failing", () => {
		const fail = { status: "fail" as const, summary: "Search engines are kept out.", at: "t" };
		expect(alertEvents({ siteName: "Acme", before: {}, after: { indexability: fail }, opened: [], closed: [], freshLinks: [] }).map((x) => x.issue)).toEqual(["indexability-fail"]);
		expect(alertEvents({ siteName: "Acme", before: { indexability: fail }, after: { indexability: fail }, opened: [], closed: [], freshLinks: [] })).toEqual([]);
		const m = alertMail(alertEvents({ siteName: "Acme <b>", before: {}, after: { forms: { ...fail, summary: "2 form messages refused." } }, opened: [], closed: [], freshLinks: [] })[0] as never, { siteName: "Acme <b>", adminUrl: `${ORIGIN}/_emdash/admin/plugins/site-health/health`, footer: "Prepared by Example Agency" });
		expect(m.html).not.toContain("<b>");
		expect(m.text).toContain("Prepared by Example Agency");
	});
	it("never emails before go-live, from staging, or with alerts switched off", () => {
		expect(emailBlocked({ ...OPTIONS, live: false }, {}, {}, "alerts")).toContain("not live");
		expect(emailBlocked(OPTIONS, { STAGING: "1" }, {}, "alerts")).toContain("staging");
		expect(emailBlocked(OPTIONS, {}, { alerts: false }, "alerts")).toContain("off");
		expect(emailBlocked(OPTIONS, {}, { report: false }, "report")).toContain("off");
		expect(emailBlocked(OPTIONS, {}, {}, "alerts")).toBeUndefined();
	});
	it("sends through the forms package's provider path or EmDash email, never logging addresses", async () => {
		expect(mailReady({ EMAIL_PROVIDER: "brevo" }, undefined)).toMatchObject({ ok: false });
		const fetchMock = vi.fn(async () => new Response(JSON.stringify({ messageId: "m1" }), { status: 201 }));
		vi.stubGlobal("fetch", fetchMock);
		const r = await sendMail({ EMAIL_PROVIDER: "brevo", EMAIL_API_KEY: "key", FORM_FROM: "Acme <noreply@acme.example>" }, undefined, ["a@agency.example"], { subject: "s", text: "t", html: "<p>t</p>" });
		expect(r).toEqual({ ok: true });
		expect(String((fetchMock.mock.calls[0] as unknown as [string])[0])).toBe("https://api.brevo.com/v3/smtp/email");
		const sent: unknown[] = [];
		expect(await sendMail({ EMAIL_PROVIDER: "emdash" }, { send: async (m) => void sent.push(m) }, ["a@agency.example", "b@agency.example"], { subject: "s", text: "t", html: "h" })).toEqual({ ok: true });
		expect(sent[0]).toMatchObject({ to: "a@agency.example", cc: ["b@agency.example"] });
		expect(await sendMail({ EMAIL_PROVIDER: "emdash" }, undefined, ["a@agency.example"], { subject: "s", text: "t", html: "h" })).toMatchObject({ ok: false });
	});
});

describe("a full run (in-memory KV, mocked network)", () => {
	const TOKENS = { CRUX_API_KEY: "AIzaSyTESTKEY0123456789abcdefghijklmnop", CF_ZONE_READ_TOKEN: "zone-read-token-0123456789abcdefghijklmnopqrstuv", EMAIL_API_KEY: "xkeysib-secret-email-key", CF_ANALYTICS_TOKEN: "cf-analytics-token-0123456789abcdefghijklmn" };
	function setup(o: Partial<HealthOptions> = {}, routes: Record<string, () => Response> = {}) {
		const kv = memoryKv();
		const outbox = outboxKv();
		const logs: unknown[] = [];
		let up = true;
		const self = site({ "/": () => (up ? page(`<a href="/about/">About</a>`)() : new Response("err", { status: 500 })), "/about/": page(""), "/contact/": page(""), "/robots.txt": () => new Response(`User-agent: *\nAllow: /\nSitemap: ${ORIGIN}/sitemap.xml`, { headers: { "content-type": "text/plain" } }), "/sitemap.xml": () => new Response(SITEMAP, { headers: { "content-type": "application/xml" } }), ...routes });
		const external = vi.fn(async (url: string, init?: RequestInit) => {
			if (url.startsWith("https://api.brevo.com")) return new Response(JSON.stringify({ messageId: "m" }), { status: 201 });
			if (url.startsWith("https://chromeuxreport.googleapis.com")) return new Response("", { status: 404 });
			if (url.startsWith("https://cloudflare-dns.com")) return Response.json({ Status: 0, Answer: [] });
			if (url.startsWith("https://api.cloudflare.com")) return Response.json({ success: true, result: [] });
			return new Response(null, { status: init?.method === "HEAD" ? 200 : 200 });
		});
		vi.stubGlobal("fetch", external);
		const d = (now: number): RunDeps => ({ kv, options: { ...OPTIONS, formsOutbox: true, ...o }, env: { FORM_OUTBOX: outbox, EMAIL_PROVIDER: "brevo", FORM_FROM: "Acme <noreply@acme.example>", FORM_TO: "owner@acme.example", ...TOKENS }, self: self as never, fetch: external as never, log: { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a) }, now });
		return { kv, outbox, logs, self, external, d, setUp: (v: boolean) => (up = v) };
	}
	const brevo = (f: ReturnType<typeof vi.fn>) => f.mock.calls.filter(([u]) => String(u).startsWith("https://api.brevo.com"));

	it("runs the checks, records state and history, and stays healthy", async () => {
		const s = setup();
		const r = await runChecks(s.d(T0));
		expect(r.ran).toEqual(["uptime", "index", "analytics", "backups", "media", "notfound", "headers", "forms"]);
		expect(r.state.checks.uptime?.status).toBe("ok");
		expect(r.state.checks.indexability?.status).toBe("ok");
		expect(r.state.sitemap?.paths).toEqual(["/", "/about/", "/contact/"]);
		expect(await s.kv.get(KEYS.lock)).toBeNull();
		// Next tick 5 minutes later: uptime only (plus nothing else due).
		expect((await runChecks(s.d(T0 + 300_000))).ran).toEqual(["uptime"]);
	});
	it("declares the site down after two failed checks, emails once, and emails the recovery", async () => {
		const s = setup();
		await runChecks(s.d(T0));
		s.setUp(false);
		const one = await runChecks(s.d(T0 + 300_000));
		expect(one.alerts.sent).toBe(0);
		const two = await runChecks(s.d(T0 + 600_000));
		expect(two.state.checks.uptime?.status).toBe("fail");
		expect(two.alerts.sent).toBe(1);
		expect(brevo(s.external)).toHaveLength(1);
		const mail = JSON.parse(String((brevo(s.external)[0] as unknown as [string, RequestInit])[1].body));
		expect(mail.subject).toBe("Acme: the website is down");
		expect(mail.to).toEqual([{ email: "team@agency.example" }]);
		// Still down: no new email.
		expect((await runChecks(s.d(T0 + 900_000))).alerts.sent).toBe(0);
		s.setUp(true);
		const back = await runChecks(s.d(T0 + 1_200_000));
		expect(back.alerts.sent).toBe(1);
		expect(JSON.parse(String((brevo(s.external)[1] as unknown as [string, RequestInit])[1].body)).subject).toBe("Acme: the website is back up");
		const incidents = (await s.kv.get<{ endedAt?: string }[]>(KEYS.incidents)) ?? [];
		expect(incidents).toHaveLength(1);
		expect(incidents[0]?.endedAt).toBeDefined();
		// Down again the same day: held (one email per issue per day).
		s.setUp(false);
		await runChecks(s.d(T0 + 1_500_000));
		const again = await runChecks(s.d(T0 + 1_800_000));
		expect(again.alerts).toMatchObject({ sent: 0, held: 1 });
	});
	it("emails nothing before go-live", async () => {
		const s = setup({ live: false });
		await runChecks(s.d(T0));
		s.setUp(false);
		await runChecks(s.d(T0 + 300_000));
		const r = await runChecks(s.d(T0 + 600_000));
		expect(r.state.checks.uptime?.status).toBe("fail");
		expect(r.alerts.notEmailed).toContain("not live");
		expect(brevo(s.external)).toHaveLength(0);
	});
	it("is single-flight and rate-limits manual runs", async () => {
		const s = setup();
		expect(await acquireLock(s.kv, T0)).toBe(true);
		expect((await runChecks(s.d(T0))).skipped).toBe("locked");
		await releaseLock(s.kv);
		// An expired lock (a crashed run) is taken over.
		await s.kv.set(KEYS.lock, { until: new Date(T0 - 1).toISOString() });
		const manual = await runChecks(s.d(T0), { manual: true });
		expect(manual.ran).toEqual(expect.arrayContaining(["uptime", "dns", "ssl", "speed", "links"]));
		expect((await runChecks(s.d(T0 + 60_000), { manual: true })).skipped).toBe("too-soon");
	});
	it("never stores, logs or emails a secret, a visitor's message or address", async () => {
		const s = setup();
		await enqueue({ FORM_OUTBOX: s.outbox }, { form: "contact", replyTo: { email: "visitor@private.example", name: "Visitor Name" }, subject: "About my treatment", text: "My private health details", html: "<p>x</p>", attempts: 1 });
		await runChecks(s.d(T0), { manual: true });
		s.setUp(false);
		await runChecks(s.d(T0 + 300_000));
		await runChecks(s.d(T0 + 600_000));
		const stored = JSON.stringify([...s.kv.store.values()].map((e) => e.v));
		const logged = JSON.stringify(s.logs);
		const mails = JSON.stringify(brevo(s.external).map((c) => (c as unknown as [string, RequestInit])[1].body));
		for (const text of [stored, logged, mails]) {
			for (const secret of Object.values(TOKENS)) expect(text).not.toContain(secret);
			for (const pii of ["visitor@private.example", "Visitor Name", "About my treatment", "private health"]) expect(text).not.toContain(pii);
		}
		expect(brevo(s.external).length).toBeGreaterThan(0);
	});
});
