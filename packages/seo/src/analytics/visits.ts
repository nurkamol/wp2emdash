/**
 * Visits: Cloudflare Web Analytics for the last 7 days through Cloudflare's GraphQL Analytics API (account-scoped
 * dataset `rumPageloadEventsAdaptiveGroups`: `count` = page views, `sum { visits }` = visits, dimensions `date`,
 * `requestPath`, `refererHost`; filter `datetime_geq` / `datetime_lt` plus `siteTag` or `requestHost`). One query
 * feeds the dashboard widget, the Visits tab and the editor panel's per-page views (pages: up to 100 paths).
 * Field names: docs/spikes/analytics-findings.md.
 *
 * The token (Account Analytics: Read, one account) is a Worker secret. It is sent only in the Authorization header to
 * api.cloudflare.com and never appears in a result, an error or a log line.
 */

export const GRAPHQL_URL = "https://api.cloudflare.com/client/v4/graphql";
const DAY = 86_400_000;
export const PAGE_LIMIT = 100;

export interface VisitsConfig {
	token: string;
	accountId: string;
	/** The production host; used when no site tag is given. */
	host: string;
	/** Web Analytics site tag (optional; narrows to one Web Analytics site). */
	siteTag?: string;
}

export interface Visits {
	since: string;
	until: string;
	visits: number;
	pageViews: number;
	days: { date: string; views: number; visits: number }[];
	/** Most viewed paths, up to PAGE_LIMIT. */
	pages: { path: string; views: number; visits: number }[];
	topReferrers: { host: string; views: number }[];
}

/** The GraphQL request for the 7 days before `now` (UTC). */
export function visitsQuery(cfg: Pick<VisitsConfig, "accountId" | "host" | "siteTag">, now = Date.now()): { query: string; variables: Record<string, string> } {
	const until = new Date(now);
	const since = new Date(now - 7 * DAY);
	const by = cfg.siteTag ? "siteTag: $key" : "requestHost: $key";
	const filter = `{ datetime_geq: $since, datetime_lt: $until, ${by} }`;
	const query = `query Visits($accountTag: String!, $since: Time!, $until: Time!, $key: String!) {
  viewer {
    accounts(filter: { accountTag: $accountTag }) {
      total: rumPageloadEventsAdaptiveGroups(limit: 1, filter: ${filter}) { count sum { visits } }
      days: rumPageloadEventsAdaptiveGroups(limit: 10, orderBy: [date_ASC], filter: ${filter}) { count sum { visits } dimensions { date } }
      pages: rumPageloadEventsAdaptiveGroups(limit: ${PAGE_LIMIT}, orderBy: [count_DESC], filter: ${filter}) { count sum { visits } dimensions { requestPath } }
      referrers: rumPageloadEventsAdaptiveGroups(limit: 10, orderBy: [count_DESC], filter: ${filter}) { count dimensions { refererHost } }
    }
  }
}`;
	return { query, variables: { accountTag: cfg.accountId, since: since.toISOString(), until: until.toISOString(), key: cfg.siteTag ?? cfg.host } };
}

type Group = { count?: number; sum?: { visits?: number }; dimensions?: { requestPath?: string; refererHost?: string; date?: string } };
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const bare = (h: string) => h.toLowerCase().replace(/^www\./, "");

/** Parses the GraphQL `data`; own-site and empty referrers are left out (they are navigation within the site). */
export function parseVisits(data: unknown, host: string, since: string, until: string): Visits {
	const acc = ((data as { viewer?: { accounts?: unknown[] } } | undefined)?.viewer?.accounts?.[0] ?? {}) as { total?: Group[]; days?: Group[]; pages?: Group[]; referrers?: Group[] };
	const total = acc.total?.[0];
	return {
		since,
		until,
		visits: num(total?.sum?.visits),
		pageViews: num(total?.count),
		days: (acc.days ?? []).filter((g) => typeof g.dimensions?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(g.dimensions.date)).map((g) => ({ date: String(g.dimensions?.date), views: num(g.count), visits: num(g.sum?.visits) })),
		pages: (acc.pages ?? []).filter((g) => typeof g.dimensions?.requestPath === "string").slice(0, PAGE_LIMIT).map((g) => ({ path: String(g.dimensions?.requestPath).slice(0, 200), views: num(g.count), visits: num(g.sum?.visits) })),
		topReferrers: (acc.referrers ?? []).filter((g) => typeof g.dimensions?.refererHost === "string" && g.dimensions.refererHost !== "" && bare(g.dimensions.refererHost) !== bare(host)).slice(0, 5).map((g) => ({ host: String(g.dimensions?.refererHost).slice(0, 120), views: num(g.count) })),
	};
}

/** Page views of one path in the 7-day data (trailing slash ignored). `undefined`: not among the PAGE_LIMIT most viewed. */
export function viewsOfPath(v: Visits, path: string): { views: number; visits: number } | undefined {
	const norm = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
	const want = norm(path);
	const rows = v.pages.filter((p) => norm(p.path) === want);
	if (rows.length) return { views: rows.reduce((n, r) => n + r.views, 0), visits: rows.reduce((n, r) => n + r.visits, 0) };
	return v.pages.length < PAGE_LIMIT ? { views: 0, visits: 0 } : undefined;
}

export class VisitsError extends Error {}

/** Fetches the 7-day numbers. Errors are short, plain and token-free. */
export async function fetchVisits(cfg: VisitsConfig, fetchFn: typeof fetch = fetch, now = Date.now()): Promise<Visits> {
	const { query, variables } = visitsQuery(cfg, now);
	const scrub = (s: string) => (cfg.token ? s.split(cfg.token).join("[token]") : s).slice(0, 200);
	let res: Response;
	try {
		res = await fetchFn(GRAPHQL_URL, { method: "POST", headers: { authorization: `Bearer ${cfg.token}`, "content-type": "application/json" }, body: JSON.stringify({ query, variables }) });
	} catch (e) {
		throw new VisitsError(scrub(`Cloudflare could not be reached (${(e as Error).message ?? "network error"}).`));
	}
	if (res.status === 401 || res.status === 403) throw new VisitsError("Cloudflare refused the token: it needs Account → Account Analytics → Read for this account.");
	if (!res.ok) throw new VisitsError(`Cloudflare answered HTTP ${res.status}.`);
	const body = (await res.json().catch(() => ({}))) as { data?: unknown; errors?: { message?: string }[] | null };
	if (body.errors?.length) {
		const msg = body.errors.map((e) => e.message ?? "").filter(Boolean)[0] ?? "unknown error";
		throw new VisitsError(scrub(/authz|not authorized|permission/i.test(msg) ? "Cloudflare refused the token for this account: it needs Account Analytics → Read on the account that holds the site." : `Cloudflare: ${msg}`));
	}
	return parseVisits(body.data, cfg.host, variables.since as string, variables.until as string);
}
