/**
 * Content-Security-Policy violation reports: what visitors' browsers report when the site's CSP blocks something
 * (a script inlined by a build, a widget host missing from the allow list…). The starter's middleware puts
 * `report-uri` and `report-to` into the public CSP (never into signed-in editors' CSP); browsers POST to the plugin's
 * public route `/_emdash/api/plugins/site-health/csp` (docs/spikes/csp-reports-findings.md).
 *
 * Both formats: the legacy `application/csp-report` body (`{"csp-report": {...}}`, Safari, Firefox, older Chrome) and
 * the Reporting API's `application/reports+json` (an array of `{type: "csp-violation", body: {...}}`, Chrome/Edge).
 *
 * Privacy: kept per violation are only the effective directive, the blocked source reduced to its origin (or
 * "inline" / "eval"), the page PATH (no query, no fragment), the origin of the file that caused it, a count and the
 * first/last time. Never IPs, user agents, full URLs, referrers or the code sample. Noise is dropped: browser
 * extensions, about:/data: sources, reports for documents of other origins, reports from signed-in browsers.
 *
 * Abuse limits: the route reads at most CSP_MAX_BYTES, takes at most CSP_MAX_ENTRIES reports per request, a
 * per-isolate rate limit, at most CSP_MAX_KEYS distinct violations kept (oldest dropped), one KV write per request.
 * Pure functions, except `recordViolations` (one KV read, at most one write).
 */
import type { AlertEvent } from "./alerts.js";
import type { Kv } from "./store.js";
import { monthOf, plural } from "./util.js";

export const CSP_ROUTE = "csp";
export const CSP_MAX_BYTES = 8 * 1024;
export const CSP_MAX_ENTRIES = 20;
export const CSP_MAX_KEYS = 50;
export const CSP_MAX_PAGES = 5;
/** Monthly counters kept for the report. */
export const CSP_MONTHS = 13;
/** Per isolate: at most this many reports processed per window; the rest get 204 unread. */
export const CSP_RATE = { max: 30, windowMs: 60_000 };

/** One violation as kept (after reduction). */
export interface CspViolation {
	directive: string;
	/** Origin of the blocked resource, or "inline" / "eval" / "wasm-eval" / "blob:" / "trusted-types" / "unknown". */
	blocked: string;
	/** Page path only. */
	page: string;
	/** Origin of the file that triggered it ("self" = this site). */
	source?: string;
}

export interface CspEntry {
	key: string;
	directive: string;
	blocked: string;
	/** Most recent pages first, at most CSP_MAX_PAGES. */
	pages: string[];
	source?: string;
	count: number;
	first: string;
	last: string;
	/** Not alerted yet (the cron turns it into an alert and clears it). */
	fresh?: true;
}

export interface CspStore {
	v: 1;
	/** The admin switch: off = reports are not stored and no alert is sent (the CSP still names the endpoint). */
	off?: boolean;
	items: CspEntry[];
	/** Reports per month (YYYY-MM), for the monthly report. */
	months: Record<string, number>;
}

export const emptyCsp = (): CspStore => ({ v: 1, items: [], months: {} });

export function readCspStore(v: unknown): CspStore {
	const s = v as Partial<CspStore> | null;
	if (!s || s.v !== 1) return emptyCsp();
	return { v: 1, ...(s.off ? { off: true } : {}), items: Array.isArray(s.items) ? s.items : [], months: s.months && typeof s.months === "object" ? s.months : {} };
}

/** A report as both formats carry it, before filtering. */
interface RawReport {
	documentURL?: unknown;
	blockedURL?: unknown;
	effectiveDirective?: unknown;
	violatedDirective?: unknown;
	sourceFile?: unknown;
}

/** The report bodies in a request (both formats); anything else → []. Pure. */
export function parseCspBody(text: string, contentType: string): RawReport[] {
	const type = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	if (!["application/csp-report", "application/reports+json", "application/json"].includes(type) || !text || text.length > CSP_MAX_BYTES) return [];
	let data: unknown;
	try {
		data = JSON.parse(text);
	} catch {
		return [];
	}
	const out: RawReport[] = [];
	// Reporting API: [{ type: "csp-violation", url, body: { documentURL, blockedURL, effectiveDirective, sourceFile, … } }]
	if (Array.isArray(data)) {
		for (const r of data.slice(0, CSP_MAX_ENTRIES)) {
			const x = r as { type?: unknown; body?: Record<string, unknown> } | null;
			if (!x || x.type !== "csp-violation" || !x.body || typeof x.body !== "object") continue;
			out.push({ documentURL: x.body.documentURL, blockedURL: x.body.blockedURL, effectiveDirective: x.body.effectiveDirective, sourceFile: x.body.sourceFile });
		}
		return out;
	}
	// Legacy report-uri: { "csp-report": { "document-uri", "blocked-uri", "effective-directive", "violated-directive", "source-file", … } }
	const legacy = (data as { "csp-report"?: Record<string, unknown> } | null)?.["csp-report"];
	if (legacy && typeof legacy === "object") out.push({ documentURL: legacy["document-uri"], blockedURL: legacy["blocked-uri"], effectiveDirective: legacy["effective-directive"], violatedDirective: legacy["violated-directive"], sourceFile: legacy["source-file"] });
	return out;
}

const EXTENSION = /^(?:[a-z-]*-extension|webkit-masked-url|extension|resource|chrome|edge):/i;
const KEYWORDS: Record<string, string> = { inline: "inline", eval: "eval", "wasm-eval": "wasm-eval", "trusted-types-policy": "trusted-types", "trusted-types-sink": "trusted-types", self: "self" };
const str = (v: unknown, max = 2048) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** The blocked source reduced to what is kept; null = noise (extension, about:, data:, unknown scheme). Pure. */
export function reduceBlocked(v: unknown): string | null {
	const s = str(v);
	if (!s) return "unknown";
	const k = KEYWORDS[s.toLowerCase()];
	if (k) return k;
	if (EXTENSION.test(s) || /^(?:about|data|filesystem|javascript):/i.test(s)) return null;
	if (/^blob:/i.test(s)) return "blob:";
	try {
		const u = new URL(s);
		return /^(?:https?|wss?):$/.test(u.protocol) ? u.origin : null;
	} catch {
		return null;
	}
}

const DIRECTIVE = /^[a-z][a-z-]{2,39}$/;

/**
 * One raw report → the kept violation, or null when it is noise or not about this site: browser extensions (blocked
 * or source file), about:/data:, a document on another origin, an unreadable directive. Pure.
 */
export function violationOf(r: RawReport, siteOrigins: string[]): CspViolation | null {
	const directive = (str(r.effectiveDirective, 60) || str(r.violatedDirective, 200).split(/\s+/)[0] || "").toLowerCase();
	if (!DIRECTIVE.test(directive)) return null;
	let doc: URL;
	try {
		doc = new URL(str(r.documentURL));
	} catch {
		return null;
	}
	if (!siteOrigins.includes(doc.origin)) return null;
	const sourceRaw = str(r.sourceFile);
	if (sourceRaw && EXTENSION.test(sourceRaw)) return null;
	const blocked = reduceBlocked(r.blockedURL);
	if (blocked === null) return null;
	let source: string | undefined;
	if (sourceRaw) {
		try {
			const u = new URL(sourceRaw);
			if (/^https?:$/.test(u.protocol)) source = u.origin === doc.origin ? "self" : u.origin;
		} catch {}
	}
	const page = doc.pathname.length > 200 ? `${doc.pathname.slice(0, 199)}…` : doc.pathname;
	return { directive, blocked: blocked === "self" ? doc.origin : blocked, page, ...(source ? { source } : {}) };
}

/** The origins a report's document may have: the request's own (workers.dev, staging) and the production one. */
export function siteOrigins(requestUrl: string | undefined, productionUrl: string): string[] {
	const out = new Set<string>();
	for (const u of [requestUrl, productionUrl]) {
		try {
			if (u) out.add(new URL(u).origin);
		} catch {}
	}
	return [...out];
}

export const cspKey = (v: Pick<CspViolation, "directive" | "blocked">) => `${v.directive} ${v.blocked}`;

/** Adds violations to the store: counts, pages, first/last seen, new entries flagged; keeps CSP_MAX_KEYS. Pure. */
export function addViolations(store: CspStore, list: CspViolation[], now: number): CspStore {
	const at = new Date(now).toISOString();
	const items = store.items.map((e) => ({ ...e, pages: [...e.pages] }));
	for (const v of list) {
		const key = cspKey(v);
		const e = items.find((x) => x.key === key);
		if (e) {
			e.count += 1;
			e.last = at;
			e.pages = [v.page, ...e.pages.filter((p) => p !== v.page)].slice(0, CSP_MAX_PAGES);
			if (v.source) e.source = v.source;
		} else items.push({ key, directive: v.directive, blocked: v.blocked, pages: [v.page], ...(v.source ? { source: v.source } : {}), count: 1, first: at, last: at, fresh: true });
	}
	items.sort((a, b) => (a.last < b.last ? 1 : a.last > b.last ? -1 : 0));
	const month = monthOf(now);
	const months = { ...store.months, [month]: (store.months[month] ?? 0) + list.length };
	const keep = Object.keys(months).sort().slice(-CSP_MONTHS);
	return { ...store, items: items.slice(0, CSP_MAX_KEYS), months: Object.fromEntries(keep.map((m) => [m, months[m] as number])) };
}

/** A fixed-window rate limiter (per isolate: module state in the plugin). */
export function createLimiter(max = CSP_RATE.max, windowMs = CSP_RATE.windowMs): (now: number) => boolean {
	let start = 0;
	let n = 0;
	return (now) => {
		if (now - start >= windowMs) {
			start = now;
			n = 0;
		}
		n += 1;
		return n <= max;
	};
}

/** Stores the violations: one read, at most one write (compare-and-set; a concurrent write wins and this is dropped). */
export async function recordViolations(kv: Kv, list: CspViolation[], now: number): Promise<"stored" | "off" | "conflict"> {
	if (kv.getVersioned && kv.compareAndSet) {
		const cur = await kv.getVersioned<CspStore>(KEYS_CSP);
		const store = readCspStore(cur?.value ?? null);
		if (store.off) return "off";
		const r = await kv.compareAndSet(KEYS_CSP, cur ? cur.revision : null, addViolations(store, list, now));
		return r.applied ? "stored" : "conflict";
	}
	const store = readCspStore(await kv.get(KEYS_CSP));
	if (store.off) return "off";
	await kv.set(KEYS_CSP, addViolations(store, list, now));
	return "stored";
}

/** Plugin KV key of the store (also KEYS.csp in store.ts). */
export const KEYS_CSP = "csp";

/**
 * The cron's part: the entries not alerted yet, and the store with their flag cleared (written by the caller with
 * compare-and-set before any email, so a report never alerts twice). Pure.
 */
export function takeFresh(store: CspStore): { fresh: CspEntry[]; store: CspStore } {
	const fresh = store.items.filter((e) => e.fresh);
	if (!fresh.length) return { fresh, store };
	return { fresh, store: { ...store, items: store.items.map(({ fresh: _f, ...e }) => e) } };
}

/** Scripts (and background scripts): what breaks a page. Everything else is lower severity. */
export const isScriptDirective = (d: string) => /^(?:script-src(?:-elem|-attr)?|worker-src|default-src)$/.test(d);

const WHAT: Record<string, string> = {
	script: "A script",
	"script-attr": "An inline event handler (onclick=… in the page's code)",
	style: "A stylesheet",
	"style-attr": "An inline style",
	img: "An image",
	font: "A font",
	connect: "A connection (a script talking to a server)",
	frame: "An embedded frame (video, map, booking widget…)",
	child: "An embedded frame",
	media: "A video or audio file",
	worker: "A background script",
	object: "A plugin object",
	manifest: "The app manifest",
	"form-action": "A form submission",
	"base-uri": "A base address",
	"frame-ancestors": "Showing this site inside another site",
	default: "A resource",
};

const baseOf = (d: string) => (d === "script-src-attr" ? "script-attr" : d === "style-src-attr" ? "style-attr" : d.replace(/-src(?:-elem)?$/, ""));
const hostOf = (origin: string) => origin.replace(/^[a-z]+:\/\//, "");

/** What was blocked, in plain words: "A script from cdn.example.com was blocked on /pricing/ and 2 other pages." Pure. */
export function meaning(e: Pick<CspEntry, "directive" | "blocked" | "pages">): string {
	const base = baseOf(e.directive);
	const inline = e.blocked === "inline";
	let what = WHAT[base] ?? WHAT.default ?? "A resource";
	if (inline && base === "script") what = "A script written into the page (inline code)";
	if (inline && base === "style") what = "A style written into the page";
	const from = inline || base === "script-attr" || base === "style-attr" ? "" : e.blocked === "eval" || e.blocked === "wasm-eval" ? " (code built at run time, eval)" : e.blocked === "unknown" ? "" : e.blocked === "blob:" ? " from a temporary blob: address" : e.blocked === "trusted-types" ? " (a Trusted Types rule)" : ` from ${hostOf(e.blocked)}`;
	const pages = e.pages.length ? ` on ${e.pages[0]}${e.pages.length > 1 ? ` and ${plural(e.pages.length - 1, "other page")}` : ""}` : "";
	return `${what}${from} was blocked${pages}.`;
}

/** The blocked source for tables. */
export const blockedLabel = (b: string) => (b === "inline" ? "Inline code" : b === "eval" || b === "wasm-eval" ? "eval()" : b === "unknown" ? "—" : b === "blob:" ? "blob:" : b === "trusted-types" ? "Trusted Types" : hostOf(b));

/** Alert events for new violations: scripts → a problem (issue csp-script), others → info (issue csp-other). Pure. */
export function cspAlertEvents(fresh: CspEntry[], siteName: string): AlertEvent[] {
	const out: AlertEvent[] = [];
	const scripts = fresh.filter((e) => isScriptDirective(e.directive));
	const other = fresh.filter((e) => !isScriptDirective(e.directive));
	const list = (es: CspEntry[]) => [...es.slice(0, 5).map((e) => `- ${meaning(e)}`), ...(es.length > 5 ? [`…and ${es.length - 5} more on the Site health page (Security).`] : [])];
	if (scripts.length)
		out.push({
			issue: "csp-script",
			severity: "problem",
			subject: `${siteName}: a visitor's browser blocked a script on the website`,
			lines: ["The site's security policy (CSP) blocked a script for a real visitor. Something on that page may not work (a widget, a form, a tracking code):", ...list(scripts), "Send this to your developer: the script either needs to be allowed or moved into a file the policy already allows. Nothing about the visitor is stored."],
		});
	if (other.length)
		out.push({
			issue: "csp-other",
			severity: "info",
			subject: `${siteName}: the security policy blocked content on the website`,
			lines: ["The site's security policy (CSP) blocked something for a visitor. This is usually harmless, but a missing image, font, video or embed can look broken:", ...list(other), "Your developer can allow the source if it belongs on the site."],
		});
	return out;
}

/** The monthly report's line: reports that month and distinct sources last seen in it. Pure. */
export function cspMonth(store: CspStore, month: string): { reports: number; sources: number } {
	return { reports: store.months[month] ?? 0, sources: store.items.filter((e) => e.last.startsWith(month) || e.first.startsWith(month)).length };
}
