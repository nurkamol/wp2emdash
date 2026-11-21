/**
 * @wp2emdash/health: Content-Security-Policy violation reports (both browser formats, privacy reduction, noise
 * filters, abuse limits, aggregation), the public `csp` route, alerts on new blocked scripts, the Security tab, the
 * security-headers check, the report line, and the starter/scaffold wiring. Synthetic data only; every request mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { headerRows, headersCheck } from "../packages/health/src/checks/headers.js";
import { addViolations, createLimiter, CSP_MAX_BYTES, CSP_MAX_KEYS, cspAlertEvents, cspMonth, type CspStore, emptyCsp, meaning, parseCspBody, readCspStore, recordViolations, reduceBlocked, siteOrigins, takeFresh, violationOf } from "../packages/health/src/csp.js";
import type { HealthOptions } from "../packages/health/src/index.js";
import { createPlugin } from "../packages/health/src/plugin/index.js";
import { buildReport, renderReportText } from "../packages/health/src/report.js";
import { type RunDeps, runChecks } from "../packages/health/src/run.js";
import { KEYS } from "../packages/health/src/store.js";
import { kitConfigSchema } from "../src/config/schema.js";
import { healthOptions } from "../src/scaffold/health.js";
import { CSP_REPORT_PATH, reportDirectives, reportingEndpoints } from "../starter/src/utils/csp-report.js";
import { maintenanceBypass } from "../starter/src/utils/maintenance.js";
import { env } from "./stubs/cloudflare-workers.js";
import { memoryKv, SECURE_HEADERS } from "./health-fixtures.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type B = Record<string, any>;
const ORIGIN = "https://acme.example";
const WORKERS = "https://acme.agency.workers.dev";
const NOW = Date.UTC(2026, 10, 21, 10, 0);
const legacy = (r: Record<string, unknown>) => JSON.stringify({ "csp-report": r });
const reporting = (bodies: Record<string, unknown>[], type = "csp-violation") => JSON.stringify(bodies.map((body) => ({ type, age: 10, url: body.documentURL, user_agent: "Mozilla/5.0 (secret UA)", body })));

describe("CSP reports: parsing both formats", () => {
	it("reads the legacy application/csp-report body", () => {
		const r = parseCspBody(legacy({ "document-uri": `${ORIGIN}/pricing/?email=a@b.example#top`, "blocked-uri": "inline", "effective-directive": "script-src-elem", "violated-directive": "script-src-elem", "source-file": `${ORIGIN}/pricing/`, "script-sample": "alert(1)", referrer: "https://google.com/" }), "application/csp-report");
		expect(r).toHaveLength(1);
		expect(violationOf(r[0] as never, [ORIGIN])).toEqual({ directive: "script-src-elem", blocked: "inline", page: "/pricing/", source: "self" });
	});
	it("reads Reporting API batches (application/reports+json), csp-violation entries only, at most 20", () => {
		const body = reporting([{ documentURL: `${ORIGIN}/`, blockedURL: "https://cdn.widget.example/w.js?key=123", effectiveDirective: "script-src-elem", sourceFile: "https://cdn.widget.example/loader.js", sample: "", disposition: "enforce", statusCode: 200 }]);
		const r = parseCspBody(body, "application/reports+json; charset=utf-8");
		expect(violationOf(r[0] as never, [ORIGIN])).toEqual({ directive: "script-src-elem", blocked: "https://cdn.widget.example", page: "/", source: "https://cdn.widget.example" });
		expect(parseCspBody(reporting([{ documentURL: `${ORIGIN}/` }], "deprecation"), "application/reports+json")).toEqual([]);
		const many = reporting(Array.from({ length: 40 }, () => ({ documentURL: `${ORIGIN}/`, blockedURL: "eval", effectiveDirective: "script-src" })));
		expect(parseCspBody(many, "application/reports+json").length).toBeLessThanOrEqual(20);
	});
	it("ignores other content types, broken JSON and oversized bodies", () => {
		const ok = legacy({ "document-uri": `${ORIGIN}/`, "blocked-uri": "eval", "effective-directive": "script-src" });
		expect(parseCspBody(ok, "text/plain")).toEqual([]);
		expect(parseCspBody(ok, "application/x-www-form-urlencoded")).toEqual([]);
		expect(parseCspBody("{not json", "application/csp-report")).toEqual([]);
		expect(parseCspBody(" ".repeat(CSP_MAX_BYTES + 1), "application/csp-report")).toEqual([]);
		expect(parseCspBody(ok, "application/json")).toHaveLength(1);
	});
});

describe("CSP reports: privacy and noise", () => {
	const v = (r: Record<string, unknown>, origins = [ORIGIN]) => violationOf({ documentURL: `${ORIGIN}/a/`, effectiveDirective: "script-src-elem", ...r }, origins);
	it("keeps the blocked origin only, the page path only, and keywords", () => {
		expect(reduceBlocked("https://evil.example/path/x.js?token=abc#f")).toBe("https://evil.example");
		expect(reduceBlocked("wss://socket.example/live")).toBe("wss://socket.example");
		expect(reduceBlocked("inline")).toBe("inline");
		expect(reduceBlocked("eval")).toBe("eval");
		expect(reduceBlocked("trusted-types-sink")).toBe("trusted-types");
		expect(reduceBlocked("blob:https://acme.example/uuid")).toBe("blob:");
		expect(reduceBlocked("")).toBe("unknown");
		expect(v({ documentURL: `${ORIGIN}/thank-you/?name=Jane&phone=555#x`, blockedURL: "inline" })?.page).toBe("/thank-you/");
		expect(v({ blockedURL: "self" })?.blocked).toBe(ORIGIN);
		expect(JSON.stringify(v({ blockedURL: "https://x.example/a?b=c", sample: "secret()" }))).not.toMatch(/secret|b=c/);
	});
	it("drops browser extensions, about:, data:, other documents and unreadable directives", () => {
		for (const ext of ["chrome-extension://abc/inject.js", "moz-extension://abc/x.js", "safari-extension://x/y.js", "safari-web-extension://x/y.js", "ms-browser-extension://x/y.js"]) {
			expect(v({ blockedURL: ext })).toBeNull();
			expect(v({ blockedURL: "inline", sourceFile: ext })).toBeNull();
		}
		expect(v({ blockedURL: "about:blank" })).toBeNull();
		expect(v({ blockedURL: "data:text/javascript,alert(1)" })).toBeNull();
		expect(v({ documentURL: "https://copycat.example/a/", blockedURL: "inline" })).toBeNull();
		expect(v({ documentURL: "about:srcdoc", blockedURL: "inline" })).toBeNull();
		expect(v({ effectiveDirective: "<script>", blockedURL: "inline" })).toBeNull();
		// The legacy violated-directive (old browsers) gives the directive when effective-directive is missing.
		expect(violationOf({ documentURL: `${ORIGIN}/`, blockedURL: "eval", violatedDirective: "script-src 'self' https://x.example" }, [ORIGIN])?.directive).toBe("script-src");
	});
	it("accepts the site's own origins: the request's (workers.dev, staging) and production", () => {
		const origins = siteOrigins(`${WORKERS}/_emdash/api/plugins/site-health/csp`, ORIGIN);
		expect(origins).toEqual([WORKERS, ORIGIN]);
		expect(violationOf({ documentURL: `${WORKERS}/`, blockedURL: "inline", effectiveDirective: "script-src-elem" }, origins)?.page).toBe("/");
	});
});

describe("CSP reports: aggregation and limits", () => {
	const viol = (blocked: string, page = "/", directive = "script-src-elem") => ({ directive, blocked, page });
	it("counts by directive + blocked source, keeps the 5 latest pages, flags new entries, counts per month", () => {
		let s = addViolations(emptyCsp(), [viol("inline", "/a/")], NOW);
		s = addViolations(s, [viol("inline", "/b/"), viol("inline", "/a/")], NOW + 1000);
		expect(s.items).toHaveLength(1);
		expect(s.items[0]).toMatchObject({ key: "script-src-elem inline", count: 3, pages: ["/a/", "/b/"], fresh: true, first: new Date(NOW).toISOString(), last: new Date(NOW + 1000).toISOString() });
		for (let i = 0; i < 8; i++) s = addViolations(s, [viol("inline", `/p${i}/`)], NOW + 2000 + i);
		expect(s.items[0]?.pages).toHaveLength(5);
		expect(s.months).toEqual({ "2026-11": 11 });
	});
	it(`keeps at most ${CSP_MAX_KEYS} sources, dropping the oldest`, () => {
		let s = emptyCsp();
		for (let i = 0; i < CSP_MAX_KEYS + 5; i++) s = addViolations(s, [viol(`https://h${i}.example`)], NOW + i * 1000);
		expect(s.items).toHaveLength(CSP_MAX_KEYS);
		expect(s.items.some((e) => e.blocked === "https://h0.example")).toBe(false);
		expect(s.items[0]?.blocked).toBe(`https://h${CSP_MAX_KEYS + 4}.example`);
	});
	it("rate-limits per isolate in a fixed window", () => {
		const allow = createLimiter(3, 60_000);
		expect([allow(0), allow(1), allow(2), allow(3)]).toEqual([true, true, true, false]);
		expect(allow(60_000)).toBe(true);
	});
	it("stores with one read and one compare-and-set write; nothing while switched off", async () => {
		const kv = memoryKv();
		expect(await recordViolations(kv, [viol("inline")], NOW)).toBe("stored");
		expect(readCspStore(await kv.get(KEYS.csp)).items).toHaveLength(1);
		await kv.set(KEYS.csp, { ...readCspStore(await kv.get(KEYS.csp)), off: true });
		expect(await recordViolations(kv, [viol("eval")], NOW)).toBe("off");
		expect(readCspStore(await kv.get(KEYS.csp)).items).toHaveLength(1);
		// A concurrent write in between (another isolate, or an admin's Clear) wins: this report is dropped.
		const kv2 = memoryKv();
		const real = kv2.getVersioned?.bind(kv2);
		kv2.getVersioned = (async (k: string) => {
			const cur = await real?.(k);
			await kv2.set(KEYS.csp, emptyCsp());
			return cur;
		}) as never;
		expect(await recordViolations(kv2, [viol("inline")], NOW)).toBe("conflict");
	});
	it("explains each entry in plain words", () => {
		expect(meaning({ directive: "script-src-elem", blocked: "https://cdn.widget.example", pages: ["/pricing/", "/", "/about/"] })).toBe("A script from cdn.widget.example was blocked on /pricing/ and 2 other pages.");
		expect(meaning({ directive: "script-src-elem", blocked: "inline", pages: ["/contact/"] })).toBe("A script written into the page (inline code) was blocked on /contact/.");
		expect(meaning({ directive: "script-src", blocked: "eval", pages: ["/"] })).toBe("A script (code built at run time, eval) was blocked on /.");
		expect(meaning({ directive: "frame-src", blocked: "https://maps.example", pages: ["/visit/"] })).toBe("An embedded frame (video, map, booking widget…) from maps.example was blocked on /visit/.");
	});
});

describe("CSP alerts", () => {
	it("scripts are a problem (csp-script), other directives a note (csp-other)", () => {
		const s = addViolations(emptyCsp(), [{ directive: "script-src-elem", blocked: "inline", page: "/" }, { directive: "img-src", blocked: "http://old.example", page: "/" }], NOW);
		const { fresh, store } = takeFresh(s);
		expect(fresh).toHaveLength(2);
		expect(store.items.some((e) => e.fresh)).toBe(false);
		const ev = cspAlertEvents(fresh, "Acme");
		expect(ev.map((e) => [e.issue, e.severity])).toEqual([
			["csp-script", "problem"],
			["csp-other", "info"],
		]);
		expect(ev[0]?.lines.join("\n")).toContain("A script written into the page (inline code) was blocked on /.");
	});

	const OPTIONS: HealthOptions = { productionUrl: ORIGIN, siteName: "Acme", live: true, alertsTo: ["team@agency.example"], reportTo: ["owner@acme.example"], brand: { footer: "Prepared by Example Agency" } };
	function setup(o: Partial<HealthOptions> = {}, extraEnv: Record<string, string> = {}) {
		const kv = memoryKv();
		const self = vi.fn(async (url: string) => (new URL(url).pathname === "/" ? new Response("<html><head></head><body></body></html>", { headers: { "content-type": "text/html", ...SECURE_HEADERS } }) : new Response("nf", { status: 404 })));
		const external = vi.fn(async (url: string, _init?: RequestInit) => (url.startsWith("https://api.brevo.com") ? new Response(JSON.stringify({ messageId: "m" }), { status: 201 }) : new Response("", { status: 404 })));
		vi.stubGlobal("fetch", external);
		const d = (now: number): RunDeps => ({ kv, options: { ...OPTIONS, ...o }, env: { EMAIL_PROVIDER: "brevo", EMAIL_API_KEY: "xkeysib-test", FORM_FROM: "Acme <noreply@acme.example>", FORM_TO: "owner@acme.example", ...extraEnv }, self: self as never, fetch: external as never, now });
		const mails = () => external.mock.calls.filter(([u]) => String(u).startsWith("https://api.brevo.com")).map(([, init]) => JSON.parse(String((init as RequestInit).body)) as { subject: string; textContent?: string }).filter((m) => /blocked/.test(m.subject));
		return { kv, d, mails };
	}
	afterEach(() => vi.unstubAllGlobals());

	it("a new blocked script on the live site is emailed once by the next tick; the same source again is not", async () => {
		const s = setup();
		await runChecks(s.d(NOW));
		expect(s.mails()).toHaveLength(0);
		await recordViolations(s.kv, [{ directive: "script-src-elem", blocked: "inline", page: "/pricing/" }], NOW + 60_000);
		await runChecks(s.d(NOW + 300_000));
		expect(s.mails().map((m) => m.subject)).toEqual(["Acme: a visitor's browser blocked a script on the website"]);
		await recordViolations(s.kv, [{ directive: "script-src-elem", blocked: "inline", page: "/about/" }], NOW + 360_000);
		await runChecks(s.d(NOW + 600_000));
		expect(s.mails()).toHaveLength(1);
		expect(readCspStore(await s.kv.get(KEYS.csp)).items[0]).toMatchObject({ count: 2, pages: ["/about/", "/pricing/"] });
	});
	it("never alerts from staging, before go-live, or with the switch off (and does not alert later for those)", async () => {
		for (const [o, e] of [[{}, { STAGING: "1" }], [{ live: false }, {}]] as const) {
			const s = setup(o, e);
			await recordViolations(s.kv, [{ directive: "script-src-elem", blocked: "inline", page: "/" }], NOW);
			await runChecks(s.d(NOW));
			expect(s.mails()).toHaveLength(0);
			expect(readCspStore(await s.kv.get(KEYS.csp)).items[0]?.fresh).toBeUndefined();
		}
		const s = setup();
		await recordViolations(s.kv, [{ directive: "script-src-elem", blocked: "inline", page: "/" }], NOW);
		await s.kv.set(KEYS.csp, { ...readCspStore(await s.kv.get(KEYS.csp)), off: true });
		await runChecks(s.d(NOW));
		expect(s.mails()).toHaveLength(0);
	});
	it("the security headers check reads the home page and fails without a CSP", async () => {
		const s = setup();
		const r = await runChecks(s.d(NOW));
		expect(r.ran).toContain("headers");
		expect(r.state.checks.security?.status).toBe("ok");
		expect(await s.kv.get(KEYS.security)).toMatchObject({ status: 200, headers: { "content-security-policy": expect.stringContaining("report-uri") } });
	});
});

describe("security headers", () => {
	const f = (headers: Record<string, string>, status = 200) => ({ at: new Date(NOW).toISOString(), status, headers });
	it("is OK with what the starter sends; flags each missing protection in plain words", () => {
		expect(headerRows(SECURE_HEADERS, { reports: true }).every((r) => r.ok)).toBe(true);
		expect(headersCheck(f(SECURE_HEADERS), "t", { reports: true }).status).toBe("ok");
		const { "content-security-policy": _c, ...noCsp } = SECURE_HEADERS;
		expect(headersCheck(f(noCsp), "t", { reports: true })).toMatchObject({ status: "fail" });
		const { "permissions-policy": _p, ...noPerm } = SECURE_HEADERS;
		expect(headersCheck(f({ ...noPerm, "strict-transport-security": "max-age=300" }), "t", { reports: true })).toMatchObject({ status: "warn", summary: expect.stringContaining("HTTPS only (HSTS), Permissions policy") });
		expect(headerRows({ ...SECURE_HEADERS, "content-security-policy": "default-src 'self'" }, { reports: true }).find((r) => r.id === "reports")?.ok).toBe(false);
		expect(headerRows({ ...SECURE_HEADERS, "content-security-policy": "default-src 'self'" }, { reports: false }).some((r) => r.id === "reports")).toBe(false);
		expect(headersCheck(f({}, 503), "t", { reports: true }).status).toBe("unknown");
	});
});

describe("the public csp route and the Security tab", () => {
	const OPTIONS: HealthOptions = { productionUrl: ORIGIN, siteName: "Acme", live: true, alertsTo: ["team@agency.example"], reportTo: ["owner@acme.example"], brand: { footer: "Prepared by Example Agency" } };
	const plugin = createPlugin(OPTIONS) as unknown as { routes: Record<string, { public?: boolean; methods?: string[]; request?: { body: string; maxBytes?: number }; response?: string; handler: (ctx: unknown) => Promise<any> }> };
	let kv: ReturnType<typeof memoryKv>;
	const post = (body: string, type: string, headers: Record<string, string> = {}) => plugin.routes.csp?.handler({ input: body, kv, request: new Request(`${ORIGIN}${CSP_REPORT_PATH}`, { method: "POST", headers: { "content-type": type, ...headers } }) });
	const admin = (input: unknown) => plugin.routes.admin?.handler({ input, kv, request: new Request(`${ORIGIN}/_emdash/api/plugins/site-health/admin`), user: { id: "u1", email: "admin@acme.example", name: "Admin", role: 50 }, log: { info: vi.fn() } }) as Promise<{ blocks: B[]; toast?: { message: string } }>;
	const securityTab = (r: { blocks: B[] }) => (r.blocks.find((b) => b.type === "tab")?.panels as { label: string; blocks: B[] }[]).find((p) => p.label.startsWith("Security"));
	beforeEach(() => {
		kv = memoryKv();
		for (const k of Object.keys(env)) delete env[k];
		vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
	});
	afterEach(() => vi.unstubAllGlobals());

	it("is a public POST route reading text up to 8 KB and answering a raw 204", async () => {
		expect(plugin.routes.csp).toMatchObject({ public: true, methods: ["POST"], request: { body: "text", maxBytes: 8192 }, response: "raw" });
		const r = await post(legacy({ "document-uri": `${ORIGIN}/pricing/?x=1`, "blocked-uri": "https://cdn.widget.example/a.js", "effective-directive": "script-src-elem" }), "application/csp-report");
		expect(r).toMatchObject({ status: 204, body: null });
		expect(readCspStore(await kv.get(KEYS.csp)).items).toMatchObject([{ blocked: "https://cdn.widget.example", pages: ["/pricing/"], count: 1 }]);
		const stored = JSON.stringify(await kv.get(KEYS.csp));
		expect(stored).not.toMatch(/x=1|a\.js/);
	});
	it("answers 204 and stores nothing for noise, signed-in browsers and junk", async () => {
		expect((await post(legacy({ "document-uri": `${ORIGIN}/`, "blocked-uri": "chrome-extension://x/y.js", "effective-directive": "script-src-elem" }), "application/csp-report")).status).toBe(204);
		expect((await post(legacy({ "document-uri": `${ORIGIN}/`, "blocked-uri": "inline", "effective-directive": "script-src-elem" }), "application/csp-report", { cookie: "astro-session=abc" })).status).toBe(204);
		expect((await post("garbage", "application/csp-report")).status).toBe(204);
		expect((await post("", "text/plain")).status).toBe(204);
		expect(await kv.get(KEYS.csp)).toBeNull();
	});
	it("shows the reports in plain words, clears them, and switches reporting off", async () => {
		await post(reporting([{ documentURL: `${ORIGIN}/contact/`, blockedURL: "inline", effectiveDirective: "script-src-elem" }]), "application/reports+json");
		const page = await admin({});
		const tab = securityTab(page);
		expect(tab?.label).toBe("Security (1)");
		const table = tab?.blocks.find((b) => b.block_id === "csp");
		expect(table?.rows[0]).toMatchObject({ what: "A script written into the page (inline code) was blocked on /contact/.", kind: "Script", blocked: "Inline code", directive: "script-src-elem", pages: "/contact/", count: 1 });
		expect(tab?.blocks.find((b) => b.type === "banner")).toMatchObject({ title: "A script was blocked", variant: "error" });
		const cleared = await admin({ type: "block_action", action_id: "csp-clear" });
		expect(securityTab(cleared)?.blocks.find((b) => b.block_id === "csp")?.rows).toEqual([]);
		const off = await admin({ type: "form_submit", action_id: "save-csp", values: { on: false } });
		expect(securityTab(off)?.blocks.find((b) => b.type === "banner")).toMatchObject({ title: "Reporting is off" });
		await post(legacy({ "document-uri": `${ORIGIN}/`, "blocked-uri": "eval", "effective-directive": "script-src" }), "application/csp-report");
		expect(readCspStore(await kv.get(KEYS.csp)).items).toEqual([]);
		await admin({ type: "form_submit", action_id: "save-csp", values: { on: true } });
		expect(readCspStore(await kv.get(KEYS.csp)).off).toBeUndefined();
	});
	it("shows the security headers table once the cron read them", async () => {
		await kv.set(KEYS.security, { at: new Date(NOW).toISOString(), status: 200, headers: SECURE_HEADERS });
		const tab = securityTab(await admin({}));
		const rows = tab?.blocks.find((b) => b.block_id === "headers")?.rows as B[];
		expect(rows.map((r) => r.label)).toEqual(["HTTPS only (HSTS)", "Content Security Policy", "Blocked-content reports", "No content sniffing", "Referrer policy", "No framing by other sites", "Permissions policy"]);
		expect(rows.every((r) => r.status === "OK")).toBe(true);
	});
});

describe("the monthly report line", () => {
	it("counts the month's reports and sources", () => {
		const s: CspStore = addViolations(addViolations(emptyCsp(), [{ directive: "script-src-elem", blocked: "inline", page: "/" }], Date.UTC(2026, 9, 5)), [{ directive: "img-src", blocked: "http://x.example", page: "/" }], Date.UTC(2026, 9, 6));
		expect(cspMonth(s, "2026-10")).toEqual({ reports: 2, sources: 2 });
		expect(cspMonth(s, "2026-09")).toEqual({ reports: 0, sources: 0 });
		const base = { month: "2026-10", site: { name: "Acme", url: ORIGIN }, history: [], incidents: [], cwv: null, ledger: {}, content: { items: [] }, now: Date.UTC(2026, 10, 1, 8) };
		expect(renderReportText(buildReport({ ...base, csp: { reports: 2, sources: 2 } }), { footer: "" })).toContain("Visitors' browsers reported 2 times that the site's security policy blocked something (2 different sources)");
		expect(renderReportText(buildReport({ ...base, csp: { reports: 0, sources: 0 } }), { footer: "" })).toContain("No visitor's browser reported a blocked script");
		expect(buildReport(base).csp).toBeUndefined();
	});
});

describe("starter and scaffold wiring", () => {
	it("visitors' CSP names the report endpoint (report-uri + report-to); editors' never", () => {
		expect(reportDirectives(CSP_REPORT_PATH, false)).toEqual([`report-uri ${CSP_REPORT_PATH}`, "report-to csp-endpoint"]);
		expect(reportDirectives(CSP_REPORT_PATH, true)).toEqual([]);
		expect(reportDirectives(undefined, false)).toEqual([]);
		expect(reportDirectives("/x; script-src *", false)).toEqual([]);
		expect(reportingEndpoints(ORIGIN, CSP_REPORT_PATH, false)).toBe(`csp-endpoint="${ORIGIN}${CSP_REPORT_PATH}"`);
		expect(reportingEndpoints(ORIGIN, CSP_REPORT_PATH, true)).toBeUndefined();
		expect(reportingEndpoints(ORIGIN, undefined, false)).toBeUndefined();
	});
	it("the middleware adds them to the public CSP and sends Reporting-Endpoints, from site.config (no per-request read)", () => {
		const mw = readFileSync(join(import.meta.dirname, "..", "starter", "src", "middleware.ts"), "utf8");
		expect(mw).toContain("const cspReport = (site as { cspReport?: string }).cspReport;");
		expect(mw).toContain("...reportDirectives(cspReport, editor),");
		expect(mw).toContain('headers.set("Reporting-Endpoints", endpoints)');
		// The report route is under /_emdash: coming-soon mode never answers it with the holding page.
		expect(maintenanceBypass(CSP_REPORT_PATH)).toBe(true);
	});
	it("kit.config health.cspReports: on by default; false reaches the plugin options", () => {
		const config = (extra: Record<string, unknown> = {}) => kitConfigSchema.parse({ slug: "acme", name: "Acme", source: { url: ORIGIN }, target: { productionUrl: ORIGIN }, email: { to: ["owner@acme.example"], stagingTo: ["team@agency.example"] }, ...extra });
		expect(config().health).toMatchObject({ cspReports: true });
		expect(healthOptions({ config: config(), productionUrl: ORIGIN, live: true })?.cspReports).toBeUndefined();
		expect(healthOptions({ config: config({ health: { cspReports: false } }), productionUrl: ORIGIN, live: true })?.cspReports).toBe(false);
		// Page preloading status for the Speed tab: on by default (absent), false only when the kit turned it off.
		expect(healthOptions({ config: config(), productionUrl: ORIGIN, live: true })?.prefetch).toBeUndefined();
		expect(healthOptions({ config: config({ performance: { prefetch: false } }), productionUrl: ORIGIN, live: true })?.prefetch).toBe(false);
		const scaffold = readFileSync(join(import.meta.dirname, "..", "src", "phases", "scaffold.ts"), "utf8");
		expect(scaffold).toContain("if (health.cspReports !== false) (siteConfig as { cspReport?: string }).cspReport = CSP_REPORT_PATH;");
	});
});
