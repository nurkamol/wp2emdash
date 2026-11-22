/**
 * One home-page check, from outside, like a visitor: GET the URL through the public internet (the Worker sets
 * `global_fetch_strictly_public`, so a site in the same account or zone is reached through Cloudflare's front door, not
 * skipped), follow redirects only while they stay on the same site (same host, www and apex count as one), give up
 * after `timeoutMs` for the whole chain. A check passes when the final answer is 2xx, the page has a <title>, it is not
 * a Cloudflare error / 52x / challenge page, and it contains the site's keyword when one is set.
 *
 * `evaluate` and `sameSite` are pure; `probe` does the network through an injected fetch (tests use a fake one).
 */
import type { Fetch, MonitorSite } from "./types.js";

export const MAX_HOPS = 5;
/** Bytes of the body read and inspected (title, error-page markers, keyword). */
export const BODY_LIMIT = 256 * 1024;
export const USER_AGENT = "wp2emdash-monitor/0.1 (+uptime check)";

export interface CheckResult {
	ok: boolean;
	/** Why it failed (or "OK"), in plain words, no page content. */
	reason: string;
	status: number;
	ms: number;
	finalUrl: string;
	title?: string;
}

const hostKey = (h: string) => h.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");

/** Same site: http(s), and the same host ignoring a leading www. */
export function sameSite(a: string | URL, b: string | URL): boolean {
	try {
		const x = new URL(a);
		const y = new URL(b);
		return /^https?:$/.test(x.protocol) && /^https?:$/.test(y.protocol) && hostKey(x.hostname) === hostKey(y.hostname);
	} catch {
		return false;
	}
}

/** Markers of pages Cloudflare serves instead of the site: 5xx/52x/1xxx error pages and bot challenges. */
const CF_ERROR = [
	/id=["']cf-error-details["']/i,
	/class=["'][^"']*\bcf-error-(?:code|type|title|overview)\b/i,
	/\/cdn-cgi\/styles\/(?:cf\.errors|main)\.css/i,
	// "example.com | 522: Connection timed out", "Worker threw exception | example.com | Cloudflare"
	/<title>[^<]*\|\s*(?:5\d\d|1\d{3}):\s[^<]*<\/title>/i,
	/<title>[^<]*\|\s*Cloudflare\s*<\/title>/i,
	/Worker threw exception/i,
];
const CF_CHALLENGE = [/<title>\s*Just a moment\.\.\.\s*<\/title>/i, /<title>\s*Attention Required! \| Cloudflare\s*<\/title>/i, /\/cdn-cgi\/challenge-platform\//i];

export function cloudflarePage(body: string): "error" | "challenge" | undefined {
	if (CF_CHALLENGE.some((r) => r.test(body))) return "challenge";
	if (CF_ERROR.some((r) => r.test(body))) return "error";
	return undefined;
}

export function pageTitle(body: string): string | undefined {
	const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(body.slice(0, 64 * 1024));
	const t = m?.[1]?.replace(/\s+/g, " ").trim();
	return t ? t.slice(0, 120) : undefined;
}

/** The verdict on a final answer. Pure. */
export function evaluate(o: { status: number; body: string; keyword?: string }): { ok: boolean; reason: string; title?: string } {
	const title = pageTitle(o.body);
	const cf = cloudflarePage(o.body);
	const t = title ? { title } : {};
	if (o.status < 200 || o.status > 299) return { ok: false, reason: cf === "error" ? `HTTP ${o.status} (Cloudflare error page)` : `HTTP ${o.status}`, ...t };
	if (cf === "error") return { ok: false, reason: "Cloudflare error page instead of the site", ...t };
	if (cf === "challenge") return { ok: false, reason: "Cloudflare challenge page (bot check) instead of the site", ...t };
	if (!title) return { ok: false, reason: "the page has no <title> (empty or broken page)" };
	if (o.keyword && !o.body.toLowerCase().includes(o.keyword.toLowerCase())) return { ok: false, reason: `the keyword "${o.keyword}" is missing from the page`, ...t };
	return { ok: true, reason: "OK", ...t };
}

async function readLimited(res: Response, limit: number): Promise<string> {
	if (!res.body) return "";
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (size < limit) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		size += value.byteLength;
	}
	await reader.cancel().catch(() => {});
	const all = new Uint8Array(Math.min(size, limit));
	let at = 0;
	for (const c of chunks) {
		const part = c.subarray(0, Math.min(c.byteLength, all.byteLength - at));
		all.set(part, at);
		at += part.byteLength;
		if (at >= all.byteLength) break;
	}
	return new TextDecoder().decode(all);
}

const errorWords = (e: unknown, timeoutMs: number): string => {
	const name = (e as Error)?.name ?? "Error";
	if (name === "AbortError" || name === "TimeoutError") return `no answer within ${Math.round(timeoutMs / 1000)} s`;
	const msg = String((e as Error)?.message ?? "").replace(/\s+/g, " ").slice(0, 120);
	return `connection failed (${name}${msg ? `: ${msg}` : ""})`;
};

/** Checks one site's home page. Never throws. */
export async function probe(site: Pick<MonitorSite, "url" | "keyword">, o: { fetch: Fetch; timeoutMs: number; now?: () => number }): Promise<CheckResult> {
	const now = o.now ?? Date.now;
	const start = now();
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), o.timeoutMs);
	let url = site.url;
	try {
		for (let hop = 0; hop <= MAX_HOPS; hop++) {
			const res = await o.fetch(url, { method: "GET", redirect: "manual", signal: ctrl.signal, headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" } });
			const loc = res.headers.get("location");
			if (res.status >= 300 && res.status < 400 && loc) {
				await res.body?.cancel().catch(() => {});
				const next = new URL(loc, url).toString();
				if (!sameSite(site.url, next)) return { ok: false, reason: `redirects to another site (${new URL(next).hostname})`, status: res.status, ms: now() - start, finalUrl: next };
				if (hop === MAX_HOPS) return { ok: false, reason: `more than ${MAX_HOPS} redirects`, status: res.status, ms: now() - start, finalUrl: next };
				url = next;
				continue;
			}
			const body = await readLimited(res, BODY_LIMIT);
			const v = evaluate({ status: res.status, body, ...(site.keyword ? { keyword: site.keyword } : {}) });
			return { ...v, status: res.status, ms: now() - start, finalUrl: url };
		}
		return { ok: false, reason: "too many redirects", status: 0, ms: now() - start, finalUrl: url };
	} catch (e) {
		return { ok: false, reason: errorWords(e, o.timeoutMs), status: 0, ms: now() - start, finalUrl: url };
	} finally {
		clearTimeout(timer);
	}
}
