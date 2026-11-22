/**
 * @wp2emdash/monitor (the agency's outside-in monitor) and `wp2emdash monitor init|build`: check evaluation, redirects,
 * the incident state machine, expiry parsing (shapes recorded from live read-only requests, docs/spikes/monitor-
 * findings.md) and slot scheduling, alert rate limiting and composition, a whole tick against an in-memory KV with a
 * fake fetch, the status page, and config generation from fake sites dirs. Synthetic data, no network.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { composeMessage, duration, emptyLog, expiryEvents, incidentEvents, pickAlerts, slackBody, telegramBody, type AlertEvent } from "../packages/monitor/src/alerts.js";
import { cloudflarePage, evaluate, pageTitle, probe, sameSite } from "../packages/monitor/src/check.js";
import { covers, daysLeft, dueForExpiry, expiryApplies, parseCertSpotter, parseCrtSh, parseRdapExpiry, registrableDomain, slotOf, SLOTS_PER_DAY } from "../packages/monitor/src/expiry.js";
import { step, type SiteState } from "../packages/monitor/src/incident.js";
import { emptyState, parseState, STATE_KEY } from "../packages/monitor/src/state.js";
import { authorized, handleRequest, renderStatus, safeEqual } from "../packages/monitor/src/status.js";
import { mergeExpiry, runTick, summaryEvent } from "../packages/monitor/src/tick.js";
import type { Fetch, MonitorConfig, MonitorEnv } from "../packages/monitor/src/types.js";
import { collectSites, generateMonitorConfig, monitorBuild, monitorInit, operatorSchema, siteUrl, subrequestEstimate, wranglerConfig } from "../src/commands/monitor.js";

const PAGE = `<!doctype html><html><head><title>Acme Studio</title></head><body><h1>Welcome to Acme</h1></body></html>`;
const CF_522 = `<!DOCTYPE html><html><head><title>acme.example | 522: Connection timed out</title><link rel="stylesheet" href="/cdn-cgi/styles/cf.errors.css"></head><body><div id="cf-error-details" class="cf-error-details-wrapper"><span class="cf-error-code">522</span></div></body></html>`;
const CF_1101 = `<html><head><title>Worker threw exception | acme.example | Cloudflare</title></head><body><div id="cf-error-details">Error 1101</div></body></html>`;
const CHALLENGE = `<html><head><title>Just a moment...</title></head><body><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"></script></body></html>`;

const T0 = Date.parse("2026-11-23T10:00:00Z"); // a Monday

function html(body: string, status = 200, headers: Record<string, string> = {}) {
	return new Response(body, { status, headers: { "content-type": "text/html", ...headers } });
}

function memoryKv() {
	const m = new Map<string, string>();
	let puts = 0;
	return {
		map: m,
		get puts() {
			return puts;
		},
		async get(k: string) {
			return m.get(k) ?? null;
		},
		async put(k: string, v: string) {
			puts++;
			m.set(k, v);
		},
	};
}

const cfg = (over: Partial<MonitorConfig> = {}): MonitorConfig => ({ version: 1, sites: [{ id: "acme", url: "https://acme.example/" }], alertTo: ["ops@agency.example"], from: "Monitor <monitor@agency.example>", timeoutMs: 5000, expiryWarnDays: 14, maxAlertsPerDay: 20, weeklySummary: false, ...over });

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("check evaluation", () => {
	it("passes a 2xx page with a title, fails status, error pages, challenges, missing title and keyword", () => {
		expect(evaluate({ status: 200, body: PAGE })).toEqual({ ok: true, reason: "OK", title: "Acme Studio" });
		expect(evaluate({ status: 503, body: "busy" }).reason).toBe("HTTP 503");
		expect(evaluate({ status: 522, body: CF_522 }).reason).toBe("HTTP 522 (Cloudflare error page)");
		expect(evaluate({ status: 200, body: CF_522 })).toMatchObject({ ok: false, reason: "Cloudflare error page instead of the site" });
		expect(evaluate({ status: 200, body: CF_1101 }).ok).toBe(false);
		expect(evaluate({ status: 200, body: CHALLENGE }).reason).toMatch(/challenge/);
		expect(evaluate({ status: 200, body: "<html><body>hi</body></html>" }).reason).toMatch(/no <title>/);
		expect(evaluate({ status: 200, body: "<title>  </title>" }).ok).toBe(false);
		expect(evaluate({ status: 200, body: PAGE, keyword: "welcome to ACME" }).ok).toBe(true);
		expect(evaluate({ status: 200, body: PAGE, keyword: "Pilates" }).reason).toBe('the keyword "Pilates" is missing from the page');
	});

	it("does not mistake an ordinary title with numbers for an error page", () => {
		expect(cloudflarePage("<title>Suite 520 | Acme Dental</title>")).toBeUndefined();
		expect(cloudflarePage("<title>Since 1050 — Acme</title>")).toBeUndefined();
		expect(cloudflarePage(CF_522)).toBe("error");
		expect(cloudflarePage(CHALLENGE)).toBe("challenge");
		expect(pageTitle("<TITLE>\n A\n B </TITLE>")).toBe("A B");
	});

	it("treats www and apex as the same site, other hosts not", () => {
		expect(sameSite("https://acme.example/", "https://www.acme.example/home")).toBe(true);
		expect(sameSite("https://www.acme.example/", "http://acme.example/")).toBe(true);
		expect(sameSite("https://acme.example/", "https://parked.example/")).toBe(false);
		expect(sameSite("https://acme.example/", "ftp://acme.example/")).toBe(false);
		expect(sameSite("https://acme.example/", "not a url")).toBe(false);
	});
});

describe("probe (fake fetch)", () => {
	it("follows same-site redirects with redirect: manual and checks the final page", async () => {
		const calls: { url: string; init?: RequestInit }[] = [];
		const fetch: Fetch = async (url, init) => {
			calls.push({ url, ...(init ? { init } : {}) });
			return url === "https://acme.example/" ? html("", 301, { location: "https://www.acme.example/" }) : html(PAGE);
		};
		const r = await probe({ url: "https://acme.example/" }, { fetch, timeoutMs: 1000 });
		expect(r).toMatchObject({ ok: true, status: 200, finalUrl: "https://www.acme.example/", title: "Acme Studio" });
		expect(calls.map((c) => c.url)).toEqual(["https://acme.example/", "https://www.acme.example/"]);
		expect(calls[0]?.init?.redirect).toBe("manual");
	});

	it("fails a redirect to another site, a redirect loop, a thrown error and a timeout", async () => {
		const off: Fetch = async () => html("", 302, { location: "https://parked.example/lander" });
		expect((await probe({ url: "https://acme.example/" }, { fetch: off, timeoutMs: 1000 })).reason).toBe("redirects to another site (parked.example)");
		const loop: Fetch = async () => html("", 302, { location: "/again" });
		expect((await probe({ url: "https://acme.example/" }, { fetch: loop, timeoutMs: 1000 })).reason).toBe("more than 5 redirects");
		const dns: Fetch = async () => {
			throw new TypeError("fetch failed");
		};
		expect((await probe({ url: "https://acme.example/" }, { fetch: dns, timeoutMs: 1000 })).reason).toBe("connection failed (TypeError: fetch failed)");
		const slow: Fetch = (_u, init) =>
			new Promise((_, reject) => {
				init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
			});
		expect((await probe({ url: "https://acme.example/" }, { fetch: slow, timeoutMs: 20 })).reason).toBe("no answer within 0 s");
	});
});

describe("incident state machine", () => {
	const ok = { ok: true, reason: "OK" };
	const bad = { ok: false, reason: "HTTP 522" };
	it("opens after two failures in a row, closes on the first good check, blips do not alert", () => {
		let s: SiteState | undefined;
		let t = step(s, ok, T0, "acme");
		expect(t).toMatchObject({ changed: true, next: { status: "up" } });
		s = t.next;
		expect(step(s, ok, T0 + 300_000, "acme").changed).toBe(false);
		t = step(s, bad, T0 + 300_000, "acme");
		expect(t).toMatchObject({ changed: true, next: { status: "suspect", fails: 1 } });
		expect(t.event).toBeUndefined();
		const blip = step(t.next, ok, T0 + 600_000, "acme");
		expect(blip).toMatchObject({ changed: true, next: { status: "up" } });
		expect(blip.event).toBeUndefined();
		const t2 = step(t.next, bad, T0 + 600_000, "acme");
		expect(t2.next.status).toBe("down");
		expect(t2.event).toMatchObject({ type: "open", site: "acme", startedAt: new Date(T0 + 300_000).toISOString() });
		const still = step(t2.next, { ok: false, reason: "no answer within 10 s" }, T0 + 900_000, "acme");
		expect(still.changed).toBe(false);
		const back = step(t2.next, ok, T0 + 1_500_000, "acme");
		expect(back.event).toMatchObject({ type: "close", incident: t2.event?.incident, durationMs: 1_200_000 });
		expect(back.next).toMatchObject({ status: "up", fails: 0 });
	});
	it("a new site failing starts as suspect", () => {
		expect(step(undefined, bad, T0, "x").next).toMatchObject({ status: "suspect", fails: 1 });
	});
});

describe("expiry", () => {
	// Shapes from live GETs (2026-11-22): Cert Spotter issuances for example.com, RDAP for cloudflare.com via rdap.org.
	const certspotter = [
		{ id: "1", dns_names: ["example.com", "www.example.com", "example.net"], not_before: "2025-12-02T00:00:00Z", not_after: "2026-12-02T23:59:59Z", revoked: false },
		{ id: "2", dns_names: ["*.example.com", "example.com"], not_before: "2026-09-24T00:00:00Z", not_after: "2026-12-21T09:32:54Z", revoked: false },
		{ id: "3", dns_names: ["*.example.com", "example.com"], not_before: "2026-10-01T00:00:00Z", not_after: "2027-01-30T00:00:00Z", revoked: true },
		{ id: "4", dns_names: ["other.example"], not_before: "2026-10-01T00:00:00Z", not_after: "2027-05-01T00:00:00Z", revoked: false },
	];
	const rdap = { objectClassName: "domain", ldhName: "CLOUDFLARE.COM", events: [{ eventAction: "registration", eventDate: "2009-02-17T22:07:54Z" }, { eventAction: "expiration", eventDate: "2033-02-17T22:07:54Z" }, { eventAction: "last update of RDAP database", eventDate: "2026-11-22T06:57:13Z" }] };

	it("takes the latest valid, non-revoked certificate covering the host", () => {
		expect(parseCertSpotter(certspotter, "example.com", T0)).toBe("2026-12-21T09:32:54Z");
		expect(parseCertSpotter(certspotter, "shop.example.com", T0)).toBe("2026-12-21T09:32:54Z");
		expect(parseCertSpotter(certspotter, "a.b.example.com", T0)).toBeUndefined();
		expect(parseCertSpotter(certspotter, "example.com", Date.parse("2027-01-01T00:00:00Z"))).toBeUndefined();
		expect(parseCertSpotter({ code: "rate_limited" }, "example.com", T0)).toBeUndefined();
	});
	it("parses crt.sh's shape (UTC without zone, newline-separated names)", () => {
		expect(parseCrtSh([{ name_value: "example.com\nwww.example.com", not_after: "2026-12-10T12:00:00" }, { name_value: "*.example.com", not_after: "2026-12-01T00:00:00" }], "www.example.com", T0)).toBe("2026-12-10T12:00:00.000Z");
	});
	it("reads RDAP expiration", () => {
		expect(parseRdapExpiry(rdap)).toBe("2033-02-17T22:07:54.000Z");
		expect(parseRdapExpiry({ errorCode: 404 })).toBeUndefined();
	});
	it("covers, registrable domains, days left", () => {
		expect(covers("*.example.com", "www.example.com")).toBe(true);
		expect(covers("*.example.com", "example.com")).toBe(false);
		expect(registrableDomain("www.acme.example")).toBe("acme.example");
		expect(registrableDomain("shop.acme.co.uk")).toBe("acme.co.uk");
		expect(registrableDomain("acme.com.au")).toBe("acme.com.au");
		expect(daysLeft("2026-12-03T10:00:00Z", T0)).toBe(10);
		expect(expiryApplies({ id: "x", url: "https://acme.agency.workers.dev/" })).toBe(false);
		expect(expiryApplies({ id: "x", url: "https://acme.example/", expiry: false })).toBe(false);
		expect(expiryApplies({ id: "x", url: "https://acme.example/" })).toBe(true);
	});
	it("spreads daily lookups over the day: each site exactly once", () => {
		for (const n of [1, 3, 50, 288, 600]) {
			const seen = new Map<number, number>();
			for (let slot = 0; slot < SLOTS_PER_DAY; slot++) for (const i of dueForExpiry(n, Date.UTC(2026, 10, 23) + slot * 300_000)) seen.set(i, (seen.get(i) ?? 0) + 1);
			expect(seen.size).toBe(n);
			expect([...seen.values()].every((c) => c === 1)).toBe(true);
		}
		expect(slotOf(Date.parse("2026-11-23T08:00:00Z"))).toBe(96);
		expect(slotOf(Date.parse("2026-11-23T08:04:59Z"))).toBe(96);
	});
	it("keeps the last known date when a lookup fails, drops past dates", () => {
		expect(mergeExpiry({ cert: "2026-12-21T00:00:00Z", domain: "2030-01-01T00:00:00Z" }, { certError: "rate limited", domainError: "HTTP 503" }, T0)).toEqual({ cert: "2026-12-21T00:00:00Z", certError: "rate limited", domain: "2030-01-01T00:00:00Z", domainError: "HTTP 503" });
		expect(mergeExpiry({ cert: "2026-01-01T00:00:00Z" }, { certError: "unavailable" }, T0)).toEqual({ certError: "unavailable" });
	});
	it("warns at ≤ 14 days, once per site, kind and day", () => {
		const site = { id: "acme", url: "https://acme.example/" };
		const ev = expiryEvents(site, { cert: "2026-12-03T10:00:00Z", domain: "2026-12-30T00:00:00Z" }, T0, 14);
		expect(ev.map((e) => e.key)).toEqual(["cert:acme:2026-11-23"]);
		expect(ev[0]?.title).toBe("acme: the TLS certificate expires in 10 days");
		expect(expiryEvents(site, { domain: "2026-11-30T00:00:00Z" }, T0, 14)[0]?.key).toBe("domain:acme:2026-11-23");
	});
});

describe("alerts", () => {
	const ev = (key: string, kind: AlertEvent["kind"] = "down"): AlertEvent => ({ key, kind, severity: kind === "up" ? "recovery" : "problem", title: key, lines: [] });
	it("sends each key once, one message per tick, at most maxPerDay messages, resets daily", () => {
		let r = pickAlerts([ev("open:a"), ev("open:b"), ev("open:a")], emptyLog(), T0, 2);
		expect(r.send.map((e) => e.key)).toEqual(["open:a", "open:b"]);
		expect(r.log.count).toBe(1);
		r = pickAlerts([ev("open:a")], r.log, T0 + 1000, 2);
		expect(r.send).toEqual([]);
		expect(r.log.count).toBe(1);
		r = pickAlerts([ev("close:a", "up")], r.log, T0 + 2000, 2);
		expect(r.log.count).toBe(2);
		r = pickAlerts([ev("open:c")], r.log, T0 + 3000, 2);
		expect(r.send).toEqual([]);
		expect(r.held.map((e) => e.key)).toEqual(["open:c"]);
		expect(r.log.held).toBe(1);
		const tomorrow = pickAlerts([ev("open:c")], r.log, T0 + 86_400_000, 2);
		expect(tomorrow.send.map((e) => e.key)).toEqual(["open:c"]);
		expect(tomorrow.log).toMatchObject({ count: 1, held: 0, day: "2026-11-24" });
		const later = pickAlerts([], tomorrow.log, T0 + 10 * 86_400_000, 2);
		expect(later.log.sent).toEqual({});
	});
	it("composes one message: subject counts, text, escaped html; chat bodies", () => {
		const events = incidentEvents([{ type: "open", site: "acme", incident: "acme-x", startedAt: "2026-11-23T09:55:00.000Z", at: "2026-11-23T10:00:00.000Z", reason: "HTTP 522" }, { type: "close", site: "beta", incident: "beta-y", startedAt: "2026-11-23T08:00:00.000Z", at: "2026-11-23T10:00:00.000Z", reason: "OK", durationMs: 7_200_000 }], [{ id: "acme", url: "https://acme.example/" }, { id: "beta", url: "https://beta.example/" }]);
		const one = composeMessage(events.slice(0, 1), { label: "Agency" });
		expect(one.subject).toBe("Agency monitor: acme is DOWN: HTTP 522");
		const m = composeMessage([...events, { key: "k", kind: "cert", severity: "problem", title: "<b>x</b>", lines: [] }], {});
		expect(m.subject).toBe("Site monitor: 1 down, 1 back up, 1 expiring");
		expect(m.text).toContain("https://acme.example/ failed two checks in a row");
		expect(m.text).toContain("beta is back up after 2 h 0 min");
		expect(m.html).toContain("&#60;b&#62;x&#60;/b&#62;");
		expect(telegramBody(m, "-100123").text).toContain("&lt;b&gt;x&lt;/b&gt;");
		expect(slackBody(m).text.startsWith("*Site monitor")).toBe(true);
		expect(duration(90_000)).toBe("2 min");
		expect(duration(3 * 86_400_000)).toBe("3 days 0 h");
	});
});

describe("tick (in-memory KV, fake fetch)", () => {
	function env(kv = memoryKv(), extra: Partial<MonitorEnv> = {}) {
		return { MONITOR_KV: kv, ...extra } as MonitorEnv & { MONITOR_KV: ReturnType<typeof memoryKv> };
	}
	const slot = (t: number) => t; // scheduledTime

	it("writes only on change plus a daily heartbeat, alerts once per open and recovery", async () => {
		const kv = memoryKv();
		const e = env(kv, { TELEGRAM_BOT_TOKEN: "123456:abcdefghijklmnopqrstuvwxyz", SLACK_WEBHOOK_URL: "https://hooks.slack.example/T/B/x" });
		const config = cfg({ telegramChatId: "-100123", from: undefined });
		let up = true;
		const sent: string[] = [];
		const fetch: Fetch = async (url, init) => {
			if (url.startsWith("https://api.telegram.org/") || url.startsWith("https://hooks.slack.example/")) {
				sent.push(`${url.includes("telegram") ? "telegram" : "slack"}:${JSON.parse(String(init?.body)).text.split("\n")[0]}`);
				return new Response("{}", { status: 200 });
			}
			if (url.startsWith("https://api.certspotter.com/") || url.startsWith("https://rdap.org/")) return new Response("[]", { status: 200 });
			return up ? html(PAGE) : html(CF_522, 522);
		};
		// Not 00:00 UTC, so the single site's expiry slot (0) is not due.
		let t = T0;
		const tick = () => runTick({ config, env: e, fetch, scheduledTime: slot(t), now: () => t });
		let r = await tick();
		expect(r).toMatchObject({ checked: 1, failing: 0, wrote: true, expiryLookups: 0 });
		expect(kv.puts).toBe(1);
		t += 300_000;
		r = await tick();
		expect(r.wrote).toBe(false);
		up = false;
		t += 300_000;
		r = await tick();
		expect(r).toMatchObject({ failing: 1, opened: 0, wrote: true });
		t += 300_000;
		r = await tick();
		expect(r).toMatchObject({ opened: 1, sent: 1, delivered: ["telegram", "slack"], wrote: true });
		t += 300_000;
		r = await tick();
		expect(r).toMatchObject({ failing: 1, sent: 0, wrote: false });
		up = true;
		t += 300_000;
		r = await tick();
		expect(r).toMatchObject({ closed: 1, sent: 1, wrote: true });
		expect(sent).toEqual(["telegram:<b>Site monitor: acme is DOWN: HTTP 522 (Cloudflare error page)</b>", "slack:*Site monitor: acme is DOWN: HTTP 522 (Cloudflare error page)*", "telegram:<b>Site monitor: acme is back up after 15 min</b>", "slack:*Site monitor: acme is back up after 15 min*"]);
		expect(kv.puts).toBe(4); // first run, suspect, down, up
		// Next day: one heartbeat write even with nothing changed.
		t += 86_400_000;
		r = await tick();
		expect(r.wrote).toBe(true);
		expect(kv.puts).toBe(5);
		expect(parseState(kv.map.get(STATE_KEY) ?? null).heartbeat).toBe("2026-11-24");
	});

	it("emails through the forms deliver (Brevo by default) and retries when every channel fails", async () => {
		const kv = memoryKv();
		const e = env(kv, { EMAIL_API_KEY: "test-key" });
		const brevo: { status: number; body?: unknown }[] = [];
		let brevoStatus = 500;
		vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
			expect(url).toBe("https://api.brevo.com/v3/smtp/email");
			brevo.push({ status: brevoStatus, body: JSON.parse(String(init?.body)) });
			return new Response("{}", { status: brevoStatus });
		});
		const fetch: Fetch = async () => html("down", 503);
		let t = T0;
		const tick = () => runTick({ config: cfg(), env: e, fetch, scheduledTime: t, now: () => t });
		await tick();
		t += 300_000;
		let r = await tick();
		expect(r).toMatchObject({ opened: 1, delivered: [], failedChannels: ["email"] });
		let st = parseState(kv.map.get(STATE_KEY) ?? null);
		expect(st.pending).toHaveLength(1);
		expect(st.alerts.count).toBe(0);
		expect(st.lastDeliveryFailed).toEqual(["email"]);
		brevoStatus = 201;
		t += 300_000;
		r = await tick();
		expect(r).toMatchObject({ sent: 1, delivered: ["email"] });
		st = parseState(kv.map.get(STATE_KEY) ?? null);
		expect(st.pending).toEqual([]);
		expect(st.lastDeliveryFailed).toBeUndefined();
		expect(brevo).toHaveLength(2);
		expect(brevo[1]?.body).toMatchObject({ sender: { email: "monitor@agency.example", name: "Monitor" }, to: [{ email: "ops@agency.example" }], subject: "Site monitor: acme is DOWN: HTTP 503" });
	});

	it("looks up expiry in the site's slot and warns once that day", async () => {
		const kv = memoryKv();
		const midnight = Date.parse("2026-11-23T00:00:00Z");
		const fetched: string[] = [];
		const fetch: Fetch = async (url) => {
			fetched.push(url.replace(/\?.*/, ""));
			if (url.startsWith("https://api.certspotter.com/")) return Response.json([{ id: "9", dns_names: ["acme.example"], not_after: "2026-11-30T00:00:00Z", not_before: "2026-09-01T00:00:00Z", revoked: false }]);
			if (url.startsWith("https://rdap.org/")) return Response.json({ events: [{ eventAction: "expiration", eventDate: "2031-01-01T00:00:00Z" }] });
			return html(PAGE);
		};
		const r = await runTick({ config: cfg({ alertTo: [] }), env: env(kv), fetch, scheduledTime: midnight, now: () => midnight });
		expect(r.expiryLookups).toBe(1);
		expect(fetched).toContain("https://api.certspotter.com/v1/issuances");
		expect(fetched).toContain("https://rdap.org/domain/acme.example");
		expect(r.state.expiry.acme).toEqual({ cert: "2026-11-30T00:00:00Z", domain: "2031-01-01T00:00:00.000Z" });
		expect(r.state.alerts.sent["cert:acme:2026-11-23"]).toBe("2026-11-23"); // no channel: recorded, nothing sent
	});

	it("forgets removed sites and survives unreadable state", async () => {
		const kv = memoryKv();
		kv.map.set(STATE_KEY, JSON.stringify({ ...emptyState(), sites: { gone: { status: "down", since: "2026-11-01T00:00:00Z", fails: 2 } } }));
		const r = await runTick({ config: cfg(), env: env(kv), fetch: async () => html(PAGE), scheduledTime: T0, now: () => T0 });
		expect(Object.keys(r.state.sites)).toEqual(["acme"]);
		expect(parseState("{nope").v).toBe(1);
		expect(parseState(JSON.stringify({ v: 9 })).sites).toEqual({});
	});

	it("weekly summary only when switched on, Mondays 08:00 UTC", () => {
		const monday8 = Date.parse("2026-11-23T08:02:00Z");
		const st = emptyState();
		expect(summaryEvent(cfg(), st, monday8)).toBeUndefined();
		expect(summaryEvent(cfg({ weeklySummary: true }), st, monday8)?.key).toBe("summary:2026-11-23");
		expect(summaryEvent(cfg({ weeklySummary: true }), st, monday8 + 86_400_000)).toBeUndefined();
		expect(summaryEvent(cfg({ weeklySummary: true }), st, monday8 + 3_600_000)).toBeUndefined();
	});

	it("pings the heartbeat URL each tick when set", async () => {
		const urls: string[] = [];
		await runTick({ config: cfg({ sites: [] }), env: env(memoryKv(), { HEARTBEAT_URL: "https://hc.example/ping/abc" }), fetch: async (u) => (urls.push(u), new Response("ok")), scheduledTime: T0, now: () => T0 });
		expect(urls).toEqual(["https://hc.example/ping/abc"]);
	});
});

describe("status page", () => {
	const TOKEN = "s3cret-status-token-0123456789";
	it("is private: 404 without a configured token or with a wrong one", async () => {
		const kv = memoryKv();
		const res = await handleRequest(new Request("https://mon.example/?token=x"), { MONITOR_KV: kv }, cfg());
		expect(res.status).toBe(404);
		expect(await res.text()).not.toContain("acme");
		expect((await handleRequest(new Request("https://mon.example/?token=wrong"), { MONITOR_KV: kv, STATUS_TOKEN: TOKEN }, cfg())).status).toBe(404);
		expect(authorized(new URL("https://m.example/"), new Headers({ authorization: `Bearer ${TOKEN}` }), TOKEN)).toBe(true);
		expect(authorized(new URL("https://m.example/?token=short"), new Headers(), "short")).toBe(false);
		expect(safeEqual("abc", "abd")).toBe(false);
	});
	it("renders state with safe headers for the right token", async () => {
		const kv = memoryKv();
		const st = emptyState();
		st.sites.acme = { status: "down", since: "2026-11-23T09:55:00.000Z", fails: 2, reason: "HTTP 522", incident: "acme-x" };
		st.expiry.acme = { cert: "2026-11-30T00:00:00Z", domainError: "no RDAP for this domain" };
		kv.map.set(STATE_KEY, JSON.stringify(st));
		const res = await handleRequest(new Request(`https://mon.example/?token=${TOKEN}`), { MONITOR_KV: kv, STATUS_TOKEN: TOKEN }, cfg(), T0);
		expect(res.status).toBe(200);
		expect(res.headers.get("referrer-policy")).toBe("no-referrer");
		expect(res.headers.get("x-robots-tag")).toContain("noindex");
		expect(res.headers.get("cache-control")).toBe("no-store");
		const body = await res.text();
		expect(body).toContain("1 of 1 sites down");
		expect(body).toContain("HTTP 522");
		expect(body).toContain('class="bad">2026-11-30 (6 d)');
		expect(body).toContain("No alert channel is configured");
		expect(renderStatus(cfg({ sites: [] }), emptyState(), T0, { channels: ["email"] })).toContain("No sites configured");
	});
});

describe("wp2emdash monitor init|build (fake sites dir)", () => {
	let dir: string;
	afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

	function site(sites: string, slug: string, o: { cf?: unknown; productionUrl?: string }) {
		mkdirSync(join(sites, slug), { recursive: true });
		writeFileSync(join(sites, slug, "kit.config.ts"), `export default { slug: "${slug}", name: "Synthetic", target: { productionUrl: "${o.productionUrl ?? `https://${slug}.example`}" } };\n`);
		if (o.cf) writeFileSync(join(sites, slug, "cloudflare.json"), JSON.stringify(o.cf));
	}

	it("picks the production domain once live, else workers.dev, and skips undeployed sites", async () => {
		dir = mkdtempSync(join(tmpdir(), "wp2e-monitor-"));
		const sites = join(dir, "sites");
		site(sites, "alpha", { cf: { production: { live: true, worker: { url: "https://alpha.agency.workers.dev" } } }, productionUrl: "https://www.alpha.example" });
		site(sites, "beta", { cf: { production: { worker: { url: "https://beta.agency.workers.dev" } } } });
		site(sites, "gamma", {});
		const collected = await collectSites(sites);
		expect(collected).toEqual([
			{ slug: "alpha", url: "https://www.alpha.example", live: true },
			{ slug: "beta", url: "https://beta.agency.workers.dev", live: false },
			{ slug: "gamma", skip: "not deployed yet (no production.worker.url in cloudflare.json)" },
		]);
		expect(siteUrl(undefined, { production: { live: true } })).toEqual({ skip: "live but no target.productionUrl" });
	});

	it("generates URLs and alert addresses only, with extras, keywords, excludes and de-duplication", () => {
		const op = operatorSchema.parse({ alertTo: ["ops@agency.example"], from: "Monitor <monitor@agency.example>", extraUrls: ["https://agency.example", { url: "https://www.alpha.example/landing", id: "dup" }, { url: "http://legacy.example/x", keyword: "Contact", expiry: false }], keywords: { alpha: "Alpha" }, exclude: ["beta"] });
		const { config, skipped } = generateMonitorConfig(op, [{ slug: "alpha", url: "https://www.alpha.example", live: true }, { slug: "beta", url: "https://beta.agency.workers.dev" }, { slug: "gamma", skip: "not deployed yet" }]);
		expect(config.sites).toEqual([
			{ id: "alpha", url: "https://www.alpha.example/", source: "site", keyword: "Alpha" },
			{ id: "agency.example", url: "https://agency.example/", source: "extra" },
			{ id: "legacy.example", url: "https://legacy.example/", source: "extra", keyword: "Contact", expiry: false },
		]);
		expect(skipped.map((s) => s.slug)).toEqual(["beta", "gamma", "dup"]);
		expect(config).toMatchObject({ alertTo: ["ops@agency.example"], timeoutMs: 10_000, expiryWarnDays: 14, weeklySummary: false, emailProvider: "brevo" });
		expect(JSON.stringify(config)).not.toMatch(/token|api.?key|secret|password/i);
		expect(subrequestEstimate(20)).toBeLessThanOrEqual(50);
		expect(subrequestEstimate(30)).toBeGreaterThan(50);
	});

	it("wrangler config: one Worker, 5-minute cron, KV, strictly-public fetch, optional account", () => {
		const w = wranglerConfig(operatorSchema.parse({ accountId: "0123456789abcdef0123456789abcdef", kvNamespaceId: "fedcba9876543210fedcba9876543210" }), "2026-11-15");
		const json = JSON.parse(w.replace(/^\/\/.*$/gm, ""));
		expect(json).toMatchObject({ name: "wp2emdash-monitor", account_id: "0123456789abcdef0123456789abcdef", main: "src/worker.ts", compatibility_date: "2026-11-15", compatibility_flags: ["global_fetch_strictly_public"], workers_dev: true, triggers: { crons: ["*/5 * * * *"] }, kv_namespaces: [{ binding: "MONITOR_KV", id: "fedcba9876543210fedcba9876543210" }] });
		expect(JSON.parse(wranglerConfig(operatorSchema.parse({}), "2026-11-15").replace(/^\/\/.*$/gm, "")).account_id).toBeUndefined();
	});

	it("init writes the template once; build writes a self-contained Worker project", async () => {
		dir = mkdtempSync(join(tmpdir(), "wp2e-monitor-"));
		const sites = join(dir, "sites");
		site(sites, "beta", { cf: { production: { worker: { url: "https://beta.agency.workers.dev" } } } });
		const out = join(dir, "monitor");
		await expect(monitorBuild({ dir: out, sitesDir: sites })).rejects.toThrow(/monitor init/);
		expect(monitorInit({ dir: out }).created).toBe(true);
		const opFile = join(out, "monitor.config.json");
		writeFileSync(opFile, JSON.stringify({ ...JSON.parse(readFileSync(opFile, "utf8")), alertTo: ["ops@agency.example"] }));
		expect(monitorInit({ dir: out }).created).toBe(false);
		expect(JSON.parse(readFileSync(opFile, "utf8")).alertTo).toEqual(["ops@agency.example"]);
		const r = await monitorBuild({ dir: out, sitesDir: sites, now: new Date("2026-11-22T00:00:00Z") });
		expect(r.sites.map((s) => s.url)).toEqual(["https://beta.agency.workers.dev/"]);
		expect(r.warnings.join(" ")).toMatch(/"from"/);
		expect(r.warnings.join(" ")).toMatch(/kvNamespaceId/);
		expect(r.files).toEqual(expect.arrayContaining(["src/worker.ts", "src/tick.ts", "src/deliver.ts", "src/monitor-config.ts", "wrangler.jsonc", "package.json", ".gitignore"]));
		const alerts = readFileSync(join(out, "src", "alerts.ts"), "utf8");
		expect(alerts).toContain('from "./deliver.js"');
		expect(alerts).not.toContain("@wp2emdash/");
		const generated = readFileSync(join(out, "src", "monitor-config.ts"), "utf8");
		expect(generated).toContain("https://beta.agency.workers.dev/");
		expect(readFileSync(join(out, "wrangler.jsonc"), "utf8")).toContain('"compatibility_date": "2026-11-15"');
		// A rebuild keeps the compatibility date.
		await monitorBuild({ dir: out, sitesDir: sites, now: new Date("2027-03-01T00:00:00Z") });
		expect(readFileSync(join(out, "wrangler.jsonc"), "utf8")).toContain('"compatibility_date": "2026-11-15"');
	});
});
