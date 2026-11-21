/**
 * Re-warming the route cache from the Worker's own cron (kit.config performance.rewarm; on with the route cache once
 * the site is live on its domain). Every edit purges the cached pages (EmDash purges by tag on publish, menus, settings),
 * and the next visitor of each page then waits for a full render (1.5–2.5 s instead of ~0.25 s). Every `everyMinutes`
 * the cron requests the sitemap's pages from the live address: a page still cached is a cache hit (the Worker does not
 * run for it), a purged one renders once, here, instead of for a visitor. Warming reaches Cloudflare's upper tier, so
 * other locations get a fast hit too. Never throws: the cron's other work goes on.
 */

/** Pages requested per run at most (well under the Workers subrequest limit), and how many at once. */
export const REWARM_MAX = 120;
const AT_ONCE = 4;

/** True on the cron tick that starts each `everyMinutes` window (the cron runs every 5 minutes). */
export function rewarmDue(scheduledTime: number, everyMinutes: number): boolean {
	if (!(everyMinutes > 0)) return false;
	const minutes = Math.floor(scheduledTime / 60_000);
	return minutes % everyMinutes < 5;
}

/** `<loc>` values of a sitemap or sitemap index, kept to the site's own origin (path and query only). */
export function sitemapLocs(xml: string, origin: string): string[] {
	const out: string[] = [];
	for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
		const raw = (m[1] as string).replace(/&amp;/g, "&");
		if (!URL.canParse(raw, origin)) continue;
		const u = new URL(raw, origin);
		out.push(`${origin}${u.pathname}${u.search}`);
	}
	return out;
}

export interface RewarmResult {
	pages: number;
	rendered: number;
	failed: number;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Requests every page in the sitemap (and its child sitemaps) once. */
export async function rewarm(origin: string, fetchFn: Fetch = fetch, max = REWARM_MAX): Promise<RewarmResult> {
	const base = new URL(origin).origin;
	const init: RequestInit = { redirect: "manual", headers: { "user-agent": "site-rewarm (+cron)" } };
	const text = async (url: string) => {
		try {
			const r = await fetchFn(url, init);
			return r.status === 200 ? await r.text() : "";
		} catch {
			return "";
		}
	};
	const urls = new Set<string>();
	for (const loc of sitemapLocs(await text(`${base}/sitemap.xml`), base)) {
		if (urls.size >= max) break;
		if (/\.xml$/.test(new URL(loc).pathname)) for (const u of sitemapLocs(await text(loc), base)) urls.add(u);
		else urls.add(loc);
	}
	const list = [...urls].slice(0, max);
	const result: RewarmResult = { pages: list.length, rendered: 0, failed: 0 };
	for (let i = 0; i < list.length; i += AT_ONCE) {
		await Promise.all(
			list.slice(i, i + AT_ONCE).map(async (u) => {
				try {
					const r = await fetchFn(u, init);
					await r.body?.cancel();
					if (r.status >= 400) result.failed++;
					else if (r.headers.get("cf-cache-status") !== "HIT") result.rendered++;
				} catch {
					result.failed++;
				}
			}),
		);
	}
	return result;
}
