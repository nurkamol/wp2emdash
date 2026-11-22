/**
 * Certificate and domain expiry, once a day per site. A Worker's fetch does not expose the peer certificate, so:
 *
 * - Certificate: Certificate Transparency logs through Cert Spotter (SSLMate) —
 *   GET https://api.certspotter.com/v1/issuances?domain=<host>&match_wildcards=true&expand=dns_names
 *   → JSON array of unexpired issuances `{ id, dns_names[], not_before, not_after, revoked, … }`. The latest `not_after`
 *   among non-revoked certificates covering the host is the date to watch: when a renewed certificate has been issued,
 *   it is later. crt.sh's JSON (`[{ name_value, not_after, … }]`) is parsed as a fallback shape but not called by
 *   default (it answered 502 to every request when checked, 2026-11-22). An expired certificate the site still serves
 *   also fails the uptime check (fetch refuses the TLS handshake), so this is the early warning.
 * - Domain: RDAP through the rdap.org bootstrap (302 to the registry, e.g. rdap.verisign.com for .com)
 *   → `events[] { eventAction: "expiration", eventDate }`. Some ccTLDs have no RDAP (rdap.org answers 404, e.g. .de):
 *   reported as "unknown", never alerted.
 *
 * Verified with live read-only GETs for example domains: docs/spikes/monitor-findings.md.
 *
 * Scheduling without extra KV writes: site i of n gets the 5-minute slot floor(i·288/n) of the UTC day, so every site
 * is looked up once a day and the lookups spread over the day (Cert Spotter's anonymous quota is hourly).
 */
import type { Fetch, MonitorSite } from "./types.js";

export const DAY_MS = 86_400_000;
export const SLOT_MS = 5 * 60_000;
export const SLOTS_PER_DAY = DAY_MS / SLOT_MS;

export interface ExpiryInfo {
	/** Latest not_after (ISO) of a valid certificate for the host. */
	cert?: string;
	certError?: string;
	/** Domain registration expiry (ISO). */
	domain?: string;
	domainError?: string;
}

/** The slot of the day (0–287) a 5-minute cron tick belongs to. */
export const slotOf = (t: number) => Math.floor((((t % DAY_MS) + DAY_MS) % DAY_MS) / SLOT_MS);

/** Indexes of the sites whose daily expiry lookup is due in this tick. */
export function dueForExpiry(count: number, scheduledTime: number): number[] {
	const slot = slotOf(scheduledTime);
	const out: number[] = [];
	for (let i = 0; i < count; i++) if (Math.floor((i * SLOTS_PER_DAY) / count) === slot) out.push(i);
	return out;
}

export const expiryApplies = (s: MonitorSite) => s.expiry !== false && !/\.workers\.dev$/i.test(hostOf(s.url));

export function hostOf(url: string): string {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return "";
	}
}

/** Second-level public suffixes common enough to matter; anything else takes the last two labels. Override with `domain`. */
const TWO_LEVEL = new Set(
	"co.uk org.uk me.uk ltd.uk plc.uk ac.uk gov.uk com.au net.au org.au edu.au co.nz org.nz net.nz com.br net.br org.br co.jp ne.jp or.jp co.za org.za com.mx org.mx com.tr co.in net.in org.in com.sg com.my com.cn com.hk com.tw co.kr co.il com.ar com.co com.pe com.ua co.id com.ph com.vn com.pk com.ng com.eg co.th".split(" "),
);

export function registrableDomain(host: string): string {
	const labels = host.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
	if (labels.length <= 2) return labels.join(".");
	const last2 = labels.slice(-2).join(".");
	return TWO_LEVEL.has(last2) ? labels.slice(-3).join(".") : last2;
}

/** Whether a certificate name (possibly *.wildcard) covers the host. */
export function covers(name: string, host: string): boolean {
	const n = name.toLowerCase().trim();
	const h = host.toLowerCase();
	if (n === h) return true;
	if (!n.startsWith("*.")) return false;
	const rest = n.slice(2);
	const dot = h.indexOf(".");
	return dot > 0 && h.slice(dot + 1) === rest;
}

const later = (a: string | undefined, b: string) => (!a || Date.parse(b) > Date.parse(a) ? b : a);

/** Cert Spotter issuances → latest not_after of a non-revoked, unexpired certificate covering the host. Pure. */
export function parseCertSpotter(json: unknown, host: string, now: number): string | undefined {
	if (!Array.isArray(json)) return undefined;
	let best: string | undefined;
	for (const it of json as Record<string, unknown>[]) {
		const na = typeof it?.not_after === "string" ? it.not_after : undefined;
		if (!na || Number.isNaN(Date.parse(na)) || Date.parse(na) <= now || it.revoked === true) continue;
		const names = Array.isArray(it.dns_names) ? (it.dns_names as unknown[]).filter((x): x is string => typeof x === "string") : undefined;
		if (names && !names.some((n) => covers(n, host))) continue;
		best = later(best, na);
	}
	return best;
}

/** crt.sh JSON (`name_value` newline-separated, `not_after` without zone = UTC) → same as parseCertSpotter. Pure. */
export function parseCrtSh(json: unknown, host: string, now: number): string | undefined {
	if (!Array.isArray(json)) return undefined;
	let best: string | undefined;
	for (const it of json as Record<string, unknown>[]) {
		const raw = typeof it?.not_after === "string" ? it.not_after : undefined;
		if (!raw) continue;
		const na = /[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw}Z`;
		if (Number.isNaN(Date.parse(na)) || Date.parse(na) <= now) continue;
		const names = String(it.name_value ?? it.common_name ?? "").split(/\s+/).filter(Boolean);
		if (!names.some((n) => covers(n, host))) continue;
		best = later(best, new Date(Date.parse(na)).toISOString());
	}
	return best;
}

/** RDAP domain object → registration expiry (ISO). Pure. */
export function parseRdapExpiry(json: unknown): string | undefined {
	const events = (json as { events?: unknown })?.events;
	if (!Array.isArray(events)) return undefined;
	const e = (events as Record<string, unknown>[]).find((x) => typeof x?.eventAction === "string" && x.eventAction.toLowerCase() === "expiration" && typeof x.eventDate === "string" && !Number.isNaN(Date.parse(x.eventDate)));
	return e ? new Date(Date.parse(e.eventDate as string)).toISOString() : undefined;
}

/** Whole days until `iso` (negative once past). */
export const daysLeft = (iso: string, now: number) => Math.floor((Date.parse(iso) - now) / DAY_MS);

const coarse = (status: number) => (status === 404 ? "no RDAP for this domain" : status === 429 ? "rate limited" : status ? `HTTP ${status}` : "unavailable");

async function getJson(fetch: Fetch, url: string, headers: Record<string, string>, timeoutMs: number): Promise<{ json?: unknown; status: number }> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(url, { headers: { accept: "application/json, application/rdap+json", "user-agent": "wp2emdash-monitor/0.1", ...headers }, redirect: "follow", signal: ctrl.signal });
		if (!res.ok) {
			await res.body?.cancel().catch(() => {});
			return { status: res.status };
		}
		return { json: await res.json(), status: res.status };
	} catch {
		return { status: 0 };
	} finally {
		clearTimeout(timer);
	}
}

/** Looks up one site's certificate and domain expiry. Never throws; errors are coarse (so they rarely change state). */
export async function lookupExpiry(site: MonitorSite, o: { fetch: Fetch; now: number; certspotterKey?: string; timeoutMs?: number }): Promise<ExpiryInfo> {
	const host = hostOf(site.url);
	const t = o.timeoutMs ?? 15_000;
	const out: ExpiryInfo = {};
	const cs = await getJson(o.fetch, `https://api.certspotter.com/v1/issuances?domain=${encodeURIComponent(host)}&match_wildcards=true&expand=dns_names`, o.certspotterKey ? { authorization: `Bearer ${o.certspotterKey}` } : {}, t);
	if (cs.json !== undefined) {
		const na = parseCertSpotter(cs.json, host, o.now);
		if (na) out.cert = na;
		else out.certError = "no valid certificate in the CT logs";
	} else out.certError = coarse(cs.status);
	const domain = site.domain ?? registrableDomain(host);
	const rd = await getJson(o.fetch, `https://rdap.org/domain/${encodeURIComponent(domain)}`, {}, t);
	if (rd.json !== undefined) {
		const exp = parseRdapExpiry(rd.json);
		if (exp) out.domain = exp;
		else out.domainError = "no expiry date in RDAP";
	} else out.domainError = coarse(rd.status);
	return out;
}
