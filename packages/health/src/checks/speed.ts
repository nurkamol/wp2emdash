/**
 * Speed: (1) how long the site takes to build the home page, measured inside Cloudflare on every uptime check (median
 * per day) — the worst case, since visitors mostly get the cached copy (the route cache; a cached answer never reaches
 * the Worker, so it cannot be timed from here; the kit's verify measures it from outside); (2) Core Web Vitals of real
 * Chrome visitors from Google's Chrome UX Report (CrUX API, origin level, 28-day rolling p75), daily, when the Worker
 * secret CRUX_API_KEY (a free Google Cloud API key with the Chrome UX Report API enabled) is set.
 *
 * API (developer.chrome.com/docs/crux/api): POST https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=KEY,
 * body { origin, metrics }; answer record.metrics.<metric>.percentiles.p75 (LCP/INP in ms as numbers, CLS as a string);
 * 404 when Chrome has too few visits for the origin. Thresholds (web.dev/vitals): LCP ≤ 2500 good, > 4000 poor;
 * INP ≤ 200 / > 500; CLS ≤ 0.1 / > 0.25. The key is sent only to Google and never appears in a result or a log.
 */
import type { Fetcher } from "../probe.js";
import type { CheckState, Cwv } from "../store.js";

export const CRUX_URL = "https://chromeuxreport.googleapis.com/v1/records:queryRecord";
export const METRICS = ["largest_contentful_paint", "interaction_to_next_paint", "cumulative_layout_shift"] as const;

export type Rating = "good" | "needs-improvement" | "poor";
export const THRESHOLDS = { lcp: [2500, 4000], inp: [200, 500], cls: [0.1, 0.25] } as const;
export const rate = (metric: keyof typeof THRESHOLDS, v: number): Rating => (v <= THRESHOLDS[metric][0] ? "good" : v <= THRESHOLDS[metric][1] ? "needs-improvement" : "poor");
export const RATING_LABEL: Record<Rating, string> = { good: "Good", "needs-improvement": "Needs improvement", poor: "Poor" };

export async function fetchCrux(origin: string, key: string | undefined, fetcher: Fetcher, now = Date.now()): Promise<Cwv> {
	const at = new Date(now).toISOString();
	if (!key) return { at, missing: "no-key" };
	try {
		const res = await fetcher(`${CRUX_URL}?key=${encodeURIComponent(key)}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ origin, metrics: METRICS }), signal: AbortSignal.timeout(8_000) });
		if (res.status === 404) return { at, missing: "not-enough-data" };
		if (res.status === 400 || res.status === 403) return { at, missing: "key-refused" };
		if (!res.ok) return { at, missing: `http-${res.status}` };
		const j = (await res.json()) as { record?: { metrics?: Record<string, { percentiles?: { p75?: number | string } }> } };
		const p75 = (m: string) => {
			const v = Number(j.record?.metrics?.[m]?.percentiles?.p75);
			return Number.isFinite(v) ? v : undefined;
		};
		const lcp = p75("largest_contentful_paint");
		const inp = p75("interaction_to_next_paint");
		const cls = p75("cumulative_layout_shift");
		if (lcp === undefined && inp === undefined && cls === undefined) return { at, missing: "not-enough-data" };
		return { at, ...(lcp !== undefined ? { lcp: Math.round(lcp) } : {}), ...(inp !== undefined ? { inp: Math.round(inp) } : {}), ...(cls !== undefined ? { cls: Math.round(cls * 1000) / 1000 } : {}) };
	} catch {
		return { at, missing: "unreachable" };
	}
}

export const MISSING_TEXT: Record<string, string> = {
	"no-key": "Real-visitor speed (Core Web Vitals) needs a free Google API key: create one in Google Cloud with the Chrome UX Report API enabled and set it as the Worker secret CRUX_API_KEY.",
	"not-enough-data": "Google has not published real-visitor speed for this site yet: Chrome needs enough visits over 28 days.",
	"key-refused": "Google refused the API key: check that the Chrome UX Report API is enabled for it.",
	unreachable: "Google's Chrome UX Report could not be reached; trying again tomorrow.",
};
export const missingText = (m: string) => MISSING_TEXT[m] ?? `Google's Chrome UX Report answered ${m.replace("http-", "HTTP ")}; trying again tomorrow.`;

export function speedCheck(ttfbMedian: number | undefined, cwv: Cwv | null, at: string): CheckState {
	const detail: string[] = [];
	if (ttfbMedian !== undefined) detail.push(`Building the home page takes ${ttfbMedian} ms (median today, measured inside Cloudflare; cached pages answer faster).`);
	const parts: { name: string; text: string; r: Rating }[] = [];
	if (cwv?.lcp !== undefined) parts.push({ name: "LCP", text: `${(cwv.lcp / 1000).toFixed(1)} s`, r: rate("lcp", cwv.lcp) });
	if (cwv?.inp !== undefined) parts.push({ name: "INP", text: `${cwv.inp} ms`, r: rate("inp", cwv.inp) });
	if (cwv?.cls !== undefined) parts.push({ name: "CLS", text: cwv.cls.toFixed(2), r: rate("cls", cwv.cls) });
	if (parts.length) detail.push(`Real Chrome visitors (75th percentile, last 28 days): ${parts.map((p) => `${p.name} ${p.text} (${RATING_LABEL[p.r].toLowerCase()})`).join(", ")}.`);
	else if (cwv?.missing) detail.push(missingText(cwv.missing));
	const poor = parts.filter((p) => p.r === "poor");
	const slow = ttfbMedian !== undefined && ttfbMedian > 1500;
	if (poor.length) return { status: "warn", summary: `Real visitors find the site slow: ${poor.map((p) => `${p.name} ${p.text}`).join(", ")}.`, at, detail };
	if (slow) return { status: "warn", summary: `Building a page takes ${ttfbMedian} ms (over 1.5 s).`, at, detail };
	if (!parts.length && ttfbMedian === undefined) return { status: "unknown", summary: "Not measured yet.", at, detail };
	return { status: "ok", summary: parts.length ? `Fast for real visitors: ${parts.map((p) => `${p.name} ${p.text}`).join(", ")}.` : `Pages are built in ${ttfbMedian} ms; real-visitor data not available.`, at, detail };
}
