/**
 * One HTTP request with a time limit and timing. Checks of the site itself go through the Worker's service binding to
 * itself (SELF): a Worker's fetch to its own hostname skips the Worker (on workers.dev nothing answers; on the domain
 * the old origin would — docs/spikes/M7-findings.md), so the request is handed to the Worker directly with the
 * production URL, and the site renders exactly what visitors on the domain get.
 */
import { SECURITY_HEADERS } from "./checks/headers.js";

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export const USER_AGENT = "wp2emdash-health/0.1 (+site health check)";
/** A request taking longer than this counts as failed. */
export const TIMEOUT_MS = 8_000;
const MAX_HTML = 1_500_000;

export interface Probe {
	url: string;
	/** HTTP status; 0 = no answer (network error or time limit). */
	status: number;
	/** Time until the response headers arrived. */
	ms: number;
	error?: string;
	location?: string;
	contentType?: string;
	xRobotsTag?: string;
	/** cf-cache-status, when the response carries one (requests through the service binding usually do not). */
	cacheStatus?: string;
	/** Cloudflare-CDN-Cache-Control: the page asks the edge to keep it (route cache on). */
	cdnCache?: string;
	html?: string;
	/** Security headers of the response (lower-case names, checks/headers.ts SECURITY_HEADERS), when present. */
	headers?: Record<string, string>;
}

/** Whether a page answered: 2xx or 3xx within the time limit. */
export const answered = (p: Pick<Probe, "status">) => p.status >= 200 && p.status < 400;

export async function probe(fetcher: Fetcher, url: string, o: { method?: "GET" | "HEAD"; body?: boolean; timeoutMs?: number; redirect?: "manual" | "follow"; now?: () => number } = {}): Promise<Probe> {
	const now = o.now ?? Date.now;
	const start = now();
	try {
		const res = await fetcher(url, { method: o.method ?? "GET", redirect: o.redirect ?? "manual", headers: { "user-agent": USER_AGENT, accept: o.method === "HEAD" ? "*/*" : "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" }, signal: AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_MS) });
		const ms = Math.max(0, Math.round(now() - start));
		const h = (k: string) => res.headers.get(k) ?? undefined;
		const out: Probe = { url, status: res.status, ms };
		const set = <K extends keyof Probe>(k: K, v: Probe[K] | undefined) => {
			if (v !== undefined && v !== "") out[k] = v;
		};
		set("location", h("location"));
		set("contentType", h("content-type"));
		set("xRobotsTag", h("x-robots-tag"));
		set("cacheStatus", h("cf-cache-status"));
		set("cdnCache", h("cloudflare-cdn-cache-control"));
		const security = Object.fromEntries(SECURITY_HEADERS.flatMap((k) => (res.headers.has(k) ? [[k, (res.headers.get(k) as string).slice(0, 4000)]] : [])));
		if (Object.keys(security).length) out.headers = security;
		if (o.body && res.status === 200 && /html|xml|text\/plain/i.test(out.contentType ?? "text/html")) {
			const text = await res.text().catch(() => "");
			out.html = text.length > MAX_HTML ? text.slice(0, MAX_HTML) : text;
		} else await res.body?.cancel().catch(() => {});
		return out;
	} catch (e) {
		const name = (e as Error)?.name ?? "Error";
		return { url, status: 0, ms: Math.max(0, Math.round(now() - start)), error: name === "TimeoutError" || name === "AbortError" ? `no answer within ${Math.round((o.timeoutMs ?? TIMEOUT_MS) / 1000)} s` : "no answer (network error)" };
	}
}

/** Runs `fn` over `items` with at most `n` at a time, keeping the order of results. */
export async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i] as T);
		}
	};
	await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
	return out;
}
