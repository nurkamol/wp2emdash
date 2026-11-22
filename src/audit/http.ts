/**
 * Polite, read-only HTTP client for auditing a live site: identifies itself,
 * limits concurrency, backs off on 429/503, records redirect chains.
 */

export const USER_AGENT = "Mozilla/5.0 (compatible; wp2emdash-audit/0.1; read-only site audit)";

export interface FetchResult {
	requestedUrl: string;
	finalUrl: string;
	status: number;
	redirects: { url: string; status: number }[];
	headers: Record<string, string>;
	contentType: string;
	body: string;
	error?: string;
	ms: number;
}

export interface HttpOptions {
	timeoutMs?: number;
	maxRedirects?: number;
	retries?: number;
	headers?: Record<string, string>;
	/** Do not read the body (link checks). */
	headOnly?: boolean;
	/** Overrides USER_AGENT (the estimate identifies as itself; always generic, never personal details). */
	userAgent?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetch following redirects manually so the chain is recorded. Never throws. */
export async function fetchUrl(url: string, opts: HttpOptions = {}): Promise<FetchResult> {
	const { timeoutMs = 30_000, maxRedirects = 10, retries = 2 } = opts;
	const started = Date.now();
	const redirects: { url: string; status: number }[] = [];
	let current = url;

	for (let hop = 0; hop <= maxRedirects; hop++) {
		let res: Response | undefined;
		let lastError: string | undefined;
		for (let attempt = 0; attempt <= retries; attempt++) {
			try {
				res = await fetch(current, {
					method: opts.headOnly ? "HEAD" : "GET",
					redirect: "manual",
					headers: { "User-Agent": opts.userAgent ?? USER_AGENT, Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8", ...opts.headers },
					signal: AbortSignal.timeout(timeoutMs),
				});
				if ((res.status === 429 || res.status === 503) && attempt < retries) {
					const retryAfter = Number(res.headers.get("retry-after")) || 2 ** attempt * 2;
					await sleep(Math.min(retryAfter, 30) * 1000);
					continue;
				}
				// Some servers reject HEAD; fall back to GET once.
				if (opts.headOnly && (res.status === 405 || res.status === 501)) {
					return fetchUrl(current, { ...opts, headOnly: false });
				}
				break;
			} catch (e) {
				lastError = e instanceof Error ? e.message : String(e);
				res = undefined;
				if (attempt < retries) await sleep(1000 * (attempt + 1));
			}
		}
		if (!res) {
			return { requestedUrl: url, finalUrl: current, status: 0, redirects, headers: {}, contentType: "", body: "", error: lastError, ms: Date.now() - started };
		}

		const location = res.headers.get("location");
		if (res.status >= 300 && res.status < 400 && location) {
			redirects.push({ url: current, status: res.status });
			current = new URL(location, current).href;
			await res.body?.cancel();
			continue;
		}

		const headers = Object.fromEntries(res.headers.entries());
		const contentType = res.headers.get("content-type") ?? "";
		const body = opts.headOnly || !/text|json|xml|javascript/.test(contentType) ? (await res.body?.cancel(), "") : await res.text();
		return { requestedUrl: url, finalUrl: current, status: res.status, redirects, headers, contentType, body, ms: Date.now() - started };
	}
	return { requestedUrl: url, finalUrl: current, status: 0, redirects, headers: {}, contentType: "", body: "", error: "too many redirects", ms: Date.now() - started };
}

/** Run tasks with bounded concurrency, preserving input order in the result. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const out = new Array<R>(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const i = next++;
			out[i] = await fn(items[i] as T, i);
		}
	});
	await Promise.all(workers);
	return out;
}
