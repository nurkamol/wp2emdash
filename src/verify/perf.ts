/**
 * Verify: the performance package on a deployed target (docs/spikes/performance-findings.md).
 * - route cache: every page answers `cf-cache-status: HIT` on its second request;
 * - cached TTFB: median of 3 requests to the home page, measured from the machine running verify (geography
 *   matters: a cached page is served by the Cloudflare location nearest that machine);
 * - payload: bytes the home page transfers until its load event (desktop viewport) and no video fetched by then.
 * Local targets (astro dev) have no Workers cache: the cache checks apply to remote targets only.
 */
import type { Browser } from "playwright";

export interface CacheProbe {
	path: string;
	status: number;
	cache: string[];
	ttfbMs: number[];
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Requests `path` `times` times in a row; records cf-cache-status and time to the response headers. */
export async function probeCache(fetcher: Fetch, base: string, path: string, times = 2): Promise<CacheProbe> {
	const out: CacheProbe = { path, status: 0, cache: [], ttfbMs: [] };
	for (let i = 0; i < times; i++) {
		const t = performance.now();
		try {
			const res = await fetcher(`${base}${path}`, { redirect: "manual", headers: { "user-agent": "wp2emdash-verify" } });
			out.ttfbMs.push(Math.round(performance.now() - t));
			out.status = res.status;
			out.cache.push(res.headers.get("cf-cache-status") ?? "none");
			await res.body?.cancel();
		} catch {
			out.cache.push("error");
		}
	}
	return out;
}

export const median = (xs: number[]): number => (xs.length ? ([...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] as number) : Number.NaN);

/** Pages whose second request was not served from the route cache. */
export function cacheMisses(probes: CacheProbe[]): string[] {
	return probes.filter((p) => p.status === 200 && p.cache.at(-1) !== "HIT").map((p) => `${p.path} ${p.cache.join("→")}`);
}

export interface PayloadResult {
	kb: number;
	requests: number;
	videoBeforeLoad: string[];
	error?: string;
}

/** Bytes transferred until the load event on a desktop viewport, and any video requested before it. */
export async function measurePayload(browser: Browser, url: string): Promise<PayloadResult> {
	const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
	const page = await ctx.newPage();
	try {
		const cdp = await ctx.newCDPSession(page);
		await cdp.send("Network.enable");
		const sizes = new Map<string, number>();
		const reqs: { id: string; url: string; type?: string }[] = [];
		cdp.on("Network.requestWillBeSent", (e: { requestId: string; request: { url: string }; type?: string }) => reqs.push({ id: e.requestId, url: e.request.url, ...(e.type ? { type: e.type } : {}) }));
		cdp.on("Network.loadingFinished", (e: { requestId: string; encodedDataLength: number }) => sizes.set(e.requestId, e.encodedDataLength));
		// Chunks of responses still streaming (a video): summed until loadingFinished gives the total.
		const partial = new Map<string, number>();
		cdp.on("Network.dataReceived", (e: { requestId: string; encodedDataLength: number }) => partial.set(e.requestId, (partial.get(e.requestId) ?? 0) + e.encodedDataLength));
		await page.goto(url, { waitUntil: "load", timeout: 60_000 });
		const atLoad = reqs.slice();
		// Responses still streaming at the load event count with what arrived.
		await page.waitForTimeout(300);
		const bytes = atLoad.reduce((n, r) => n + (sizes.get(r.id) ?? partial.get(r.id) ?? 0), 0);
		return { kb: Math.round(bytes / 1024), requests: atLoad.length, videoBeforeLoad: atLoad.filter((r) => r.type === "Media" || /\.(?:mp4|webm|mov|m4v)(?:$|\?)/i.test(r.url)).map((r) => r.url) };
	} catch (e) {
		return { kb: 0, requests: 0, videoBeforeLoad: [], error: (e as Error).message.split("\n")[0] as string };
	} finally {
		await ctx.close();
	}
}
