/**
 * Lab score: Google PageSpeed Insights (Lighthouse in Google's data centre) for the home page, mobile and desktop,
 * weekly and on an admin's "Run PageSpeed test now". Needs a Google Cloud API key with the PageSpeed Insights API
 * enabled: Worker secret PAGESPEED_API_KEY, or CRUX_API_KEY when the same key has both APIs enabled. Without a key
 * Google's shared anonymous quota is close to zero (verified: HTTP 429, quota_limit_value "0"), so nothing is called.
 *
 * API (developers.google.com/speed/docs/insights/rest/v5/pagespeedapi/runpagespeed): GET
 * https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed?url=…&strategy=MOBILE|DESKTOP&category=…
 * (repeated: PERFORMANCE, ACCESSIBILITY, BEST_PRACTICES, SEO)&key=…; answer lighthouseResult.categories.<id>.score
 * (0–1 or null; ids performance, accessibility, best-practices, seo), lighthouseResult.audits.<id>.numericValue (ms;
 * CLS unitless), lighthouseResult.runtimeError { code, message }. A run takes 10–60 s. Errors: { error: { code,
 * message, status } }. The response is trimmed with Google's standard `fields` parameter (partial response); a 400
 * that names the field selection is retried once without it. The key is sent only to Google and never appears in a
 * result or a log. Facts: docs/spikes/health-findings.md.
 */
import type { Fetcher } from "../probe.js";
import { DAY, HOUR } from "../util.js";

export const PSI_URL = "https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed";
export const PSI_CATEGORIES = ["PERFORMANCE", "ACCESSIBILITY", "BEST_PRACTICES", "SEO"] as const;
export const STRATEGIES = ["mobile", "desktop"] as const;
export type Strategy = (typeof STRATEGIES)[number];
const AUDITS = { fcp: "first-contentful-paint", lcp: "largest-contentful-paint", tbt: "total-blocking-time", cls: "cumulative-layout-shift", si: "speed-index" } as const;
export const PSI_FIELDS = `lighthouseResult(finalUrl,runtimeError,categories(performance(score),accessibility(score),best-practices(score),seo(score)),audits(${Object.values(AUDITS)
	.map((a) => `${a}(numericValue)`)
	.join(",")},largest-contentful-paint-element(details)))`;

/** One PageSpeed run: scores 0–100, times in ms, CLS unitless. */
export interface LabRun {
	at: string;
	strategy: Strategy;
	perf?: number;
	a11y?: number;
	bp?: number;
	seo?: number;
	fcp?: number;
	lcp?: number;
	tbt?: number;
	cls?: number;
	si?: number;
	/** The largest-contentful-paint element's HTML, shortened. */
	lcpEl?: string;
	/** Run before go-live: the domain still showed the old site. */
	pre?: true;
}

/** Stored in plugin KV (KEYS.lab): the runs (≤ 26 weeks, ≤ MAX_LAB_RUNS), the last attempt and when the next is due. */
export interface LabStore {
	v: 1;
	runs: LabRun[];
	/** Last attempt per strategy: why it gave no result (absent: it worked). */
	last?: { at: string; missing?: Partial<Record<Strategy, string>> };
	/** When the next scheduled test is due (ISO). */
	next?: string;
}

/** "Run PageSpeed test now" (KEYS.labRequest): asked at, done at. */
export interface LabRequest {
	at: string;
	done?: string;
}

export const LAB_WEEKS = 26;
/** Bounded: 26 weekly pairs plus room for manual runs. */
export const MAX_LAB_RUNS = 80;
export const LAB_EVERY = 7 * DAY;
/** After a failed attempt (quota, Google unreachable): try again a day later. */
export const LAB_RETRY = DAY;
/** Weekly tests run from this UTC hour (after the daily jobs and the monthly report). */
export const LAB_HOUR = 9;
/** "Run PageSpeed test now": at most once per this interval. */
export const LAB_MANUAL_EVERY = 10 * 60_000;
/** Per request (a Lighthouse run takes up to about a minute); mobile and desktop run in parallel. */
export const PSI_TIMEOUT = 90_000;
/** A run holds its own lock this long at most. */
export const LAB_LOCK_MS = 3 * 60_000;
/** Mobile performance falling this many points from the previous run is an alert. */
export const LAB_DROP = 15;

export const emptyLab = (): LabStore => ({ v: 1, runs: [] });
export const readLab = (v: unknown): LabStore => (v && typeof v === "object" && (v as LabStore).v === 1 && Array.isArray((v as LabStore).runs) ? (v as LabStore) : emptyLab());

/** The key to use: PAGESPEED_API_KEY, else CRUX_API_KEY (one Google Cloud key may have both APIs enabled). */
export const labKey = (env: { PAGESPEED_API_KEY?: string; CRUX_API_KEY?: string }): string | undefined => env.PAGESPEED_API_KEY?.trim() || env.CRUX_API_KEY?.trim() || undefined;

const score = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) : undefined);
const num = (v: unknown, digits = 0) => {
	if (typeof v !== "number" || !Number.isFinite(v)) return undefined;
	const f = 10 ** digits;
	return Math.round(v * f) / f;
};

/** The LCP element's snippet: Lighthouse ≥ 10 nests a table in a list, older versions give the table directly. */
function lcpSnippet(details: unknown, depth = 0): string | undefined {
	if (!details || typeof details !== "object" || depth > 3) return undefined;
	const d = details as { items?: unknown[]; node?: { snippet?: unknown; nodeLabel?: unknown } };
	const s = d.node?.snippet ?? d.node?.nodeLabel;
	if (typeof s === "string" && s.trim()) return s.replace(/\s+/g, " ").trim();
	for (const item of Array.isArray(d.items) ? d.items : []) {
		const found = lcpSnippet(item, depth + 1);
		if (found) return found;
	}
	return undefined;
}
export const shortSnippet = (s: string, max = 160) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** A PSI answer → a run, or why there is none. Pure. */
export function parsePsi(j: unknown, strategy: Strategy, at: string, pre = false): LabRun | { missing: string } {
	const lr = (j as { lighthouseResult?: Record<string, any> } | null)?.lighthouseResult;
	if (!lr) return { missing: "no-result" };
	const code = lr.runtimeError?.code;
	if (typeof code === "string" && code && code !== "NO_ERROR") return { missing: `lighthouse-${code.replace(/[^A-Z0-9_]/gi, "").slice(0, 40)}` };
	const c = lr.categories ?? {};
	const a = lr.audits ?? {};
	const el = lcpSnippet(a["largest-contentful-paint-element"]?.details);
	const run: LabRun = {
		at,
		strategy,
		...pick("perf", score(c.performance?.score)),
		...pick("a11y", score(c.accessibility?.score)),
		...pick("bp", score(c["best-practices"]?.score)),
		...pick("seo", score(c.seo?.score)),
		...pick("fcp", num(a[AUDITS.fcp]?.numericValue)),
		...pick("lcp", num(a[AUDITS.lcp]?.numericValue)),
		...pick("tbt", num(a[AUDITS.tbt]?.numericValue)),
		...pick("cls", num(a[AUDITS.cls]?.numericValue, 3)),
		...pick("si", num(a[AUDITS.si]?.numericValue)),
		...(el ? { lcpEl: shortSnippet(el) } : {}),
		...(pre ? { pre: true as const } : {}),
	};
	if (run.perf === undefined && run.lcp === undefined) return { missing: "no-result" };
	return run;
}
const pick = <K extends string>(k: K, v: number | undefined) => (v === undefined ? {} : ({ [k]: v } as Record<K, number>));

/** Why an error answer gave no result (fixed words, never Google's message text). */
export function psiMissing(status: number, message: string): string {
	if (status === 429) return "quota";
	if (/API key not valid|API_KEY_INVALID/i.test(message)) return "key-refused";
	if (status === 403 || /has not been used|is disabled|SERVICE_DISABLED|API_KEY_SERVICE_BLOCKED/i.test(message)) return "api-disabled";
	const lh = /Lighthouse returned error: ([A-Z0-9_]+)/.exec(message);
	if (lh) return `lighthouse-${lh[1]?.slice(0, 40)}`;
	if (status === 400) return "key-refused";
	return `http-${status}`;
}

export function psiUrl(pageUrl: string, strategy: Strategy, key: string, fields = true): string {
	const q = new URLSearchParams({ url: pageUrl, strategy: strategy.toUpperCase() });
	for (const c of PSI_CATEGORIES) q.append("category", c);
	if (fields) q.set("fields", PSI_FIELDS);
	q.set("key", key);
	return `${PSI_URL}?${q.toString()}`;
}

/** One PSI call (with one retry without `fields` when Google rejects the field selection). */
export async function fetchPsi(pageUrl: string, strategy: Strategy, key: string, fetcher: Fetcher, now = Date.now(), o: { pre?: boolean; timeout?: number } = {}): Promise<LabRun | { missing: string }> {
	const at = new Date(now).toISOString();
	const once = async (fields: boolean) => {
		const res = await fetcher(psiUrl(pageUrl, strategy, key, fields), { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(o.timeout ?? PSI_TIMEOUT) });
		if (res.ok) return { ok: true as const, run: parsePsi(await res.json(), strategy, at, !!o.pre) };
		const body = (await res.json().catch(() => null)) as { error?: { message?: unknown } } | null;
		const message = typeof body?.error?.message === "string" ? body.error.message : "";
		return { ok: false as const, status: res.status, message };
	};
	try {
		let r = await once(true);
		if (!r.ok && r.status === 400 && /field/i.test(r.message)) r = await once(false);
		return r.ok ? r.run : { missing: psiMissing(r.status, r.message) };
	} catch (e) {
		return { missing: e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError") ? "timeout" : "unreachable" };
	}
}

/** Adds runs, keeps 26 weeks and at most MAX_LAB_RUNS, oldest first. Pure. */
export function addRuns(runs: LabRun[], fresh: LabRun[], now: number): LabRun[] {
	const cutoff = now - LAB_WEEKS * 7 * DAY;
	return [...runs, ...fresh]
		.filter((r) => Date.parse(r.at) >= cutoff)
		.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
		.slice(-MAX_LAB_RUNS);
}

/** Whether a test should run now: an open request, or the weekly one (from LAB_HOUR UTC) is due. Pure. */
export function labDue(store: LabStore, request: LabRequest | null, now: number): "manual" | "weekly" | undefined {
	if (request && !request.done) return "manual";
	if (new Date(now).getUTCHours() < LAB_HOUR && store.next) return undefined;
	if (!store.next) return "weekly";
	return now >= Date.parse(store.next) - HOUR ? "weekly" : undefined;
}

/** The latest run per strategy. */
export const latestOf = (runs: LabRun[], s: Strategy) => runs.filter((r) => r.strategy === s).at(-1);

/** Mobile performance dropped by LAB_DROP points or more between the two latest mobile runs. Pure. */
export function labDrop(before: LabRun[], fresh: LabRun[]): { from: number; to: number } | undefined {
	const cur = fresh.find((r) => r.strategy === "mobile");
	const prev = before.filter((r) => r.strategy === "mobile" && r.perf !== undefined).at(-1);
	if (cur?.perf === undefined || prev?.perf === undefined) return undefined;
	return prev.perf - cur.perf >= LAB_DROP ? { from: prev.perf, to: cur.perf } : undefined;
}

export const LAB_MISSING_TEXT: Record<string, string> = {
	"no-key": "The weekly PageSpeed test needs a Google Cloud API key with the PageSpeed Insights API enabled (Worker secret PAGESPEED_API_KEY).",
	quota: "Google's daily PageSpeed quota for this key is used up; trying again tomorrow.",
	"key-refused": "Google refused the API key: check the key, and that its restrictions allow the PageSpeed Insights API.",
	"api-disabled": "The PageSpeed Insights API is not enabled for this key's Google Cloud project: enable it in Google Cloud → APIs & Services → Library.",
	timeout: "The test took longer than 90 seconds; trying again tomorrow.",
	unreachable: "Google's PageSpeed service could not be reached; trying again tomorrow.",
	"no-result": "Google answered without scores; trying again tomorrow.",
};
export const labMissingText = (m: string) => LAB_MISSING_TEXT[m] ?? (m.startsWith("lighthouse-") ? `Lighthouse could not test the home page (${m.slice(11)}); trying again tomorrow.` : `Google's PageSpeed service answered ${m.replace("http-", "HTTP ")}; trying again tomorrow.`);

/** Lighthouse score colours: 90–100 good, 50–89 needs improvement, 0–49 poor. */
export const scoreTrend = (v: number | undefined): "up" | "down" | "neutral" => (v === undefined ? "neutral" : v >= 90 ? "up" : v < 50 ? "down" : "neutral");
export const scoreLabel = (v: number | undefined) => (v === undefined ? "—" : v >= 90 ? "Good" : v < 50 ? "Poor" : "Needs improvement");
