/**
 * What the monthly report reads besides the checks' own history: visits from Cloudflare Web Analytics (the SEO suite's
 * GraphQL query, for the calendar month; needs CF_ANALYTICS_TOKEN), form message counts from the form outbox, the
 * site's pages (EmDash content: titles and publish / update dates) and the average SEO score of published pages
 * (the SEO suite's own analysis, with the focus keywords it keeps).
 */
import { fetchVisits, VisitsError } from "@wp2emdash/seo/analytics/visits";
import { analyseItem, type Item, mediaIds, mediaInfo, type SeoCtx } from "@wp2emdash/seo/plugin/collect";
import { monthCounts } from "./checks/forms.js";
import type { ReportInputs } from "./report.js";
import type { RunDeps } from "./run.js";
import { monthRange } from "./util.js";

export type ReportSources = Pick<ReportInputs, "visits" | "forms" | "content" | "seo">;

const MAX_ITEMS = 500;

export async function listAll(d: Pick<RunDeps, "content">, collection: string): Promise<Item[]> {
	if (!d.content) return [];
	const out: Item[] = [];
	let cursor: string | undefined;
	do {
		const page = await d.content.list(collection, { limit: 100, ...(cursor ? { cursor } : {}) });
		out.push(...(page.items as Item[]).filter((i) => i.status !== "trash"));
		cursor = page.hasMore !== false && page.cursor && out.length < MAX_ITEMS ? page.cursor : undefined;
	} while (cursor);
	return out;
}

/** Focus keywords the SEO suite stored per page (its KV rows `plugin:site-seo:kw:<collection>:<id>` in D1). */
async function focusKeywords(db: RunDeps["env"]["DB"]): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	const prep = db?.prepare("SELECT name, value FROM options WHERE name LIKE 'plugin:site-seo:kw:%' LIMIT 1000") as unknown as { all?<T>(): Promise<{ results?: T[] }> } | undefined;
	if (!prep?.all) return out;
	try {
		for (const r of (await prep.all<{ name: string; value: string }>()).results ?? []) {
			const k = /^plugin:site-seo:kw:(.+)$/.exec(r.name)?.[1];
			const v = JSON.parse(r.value) as unknown;
			if (k && typeof v === "string" && v.trim()) out.set(k, v.trim());
		}
	} catch {}
	return out;
}

export async function reportSources(d: RunDeps, month: string): Promise<ReportSources> {
	const o = d.options;
	const env = d.env;
	const range = monthRange(month);
	// Visits (Cloudflare Web Analytics, the month).
	let visits: ReportSources["visits"];
	const token = env.CF_ANALYTICS_TOKEN?.trim();
	const accountId = (env.CF_ANALYTICS_ACCOUNT_ID ?? o.visits?.accountId ?? "").trim();
	const tag = (env.CF_ANALYTICS_SITE_TAG ?? o.visits?.siteTag ?? "").trim();
	if (!o.visits && !token) visits = { missing: "Visits are not set up for this site." };
	else if (!token || !/^[0-9a-f]{32}$/.test(accountId)) visits = { missing: "Visits need the read-only Cloudflare token CF_ANALYTICS_TOKEN (set by the developer); without it this section stays empty." };
	else {
		try {
			const v = await fetchVisits({ token, accountId, host: new URL(o.productionUrl).host, ...(/^[0-9a-f]{32}$/.test(tag) ? { siteTag: tag } : {}) }, d.fetch as typeof fetch, d.now, range);
			visits = { visits: v.visits, pageViews: v.pageViews, pages: v.pages.map((p) => ({ path: p.path, views: p.views })), referrers: v.topReferrers };
		} catch (e) {
			visits = { missing: `Visits could not be read: ${e instanceof VisitsError ? e.message : "unexpected error."}` };
		}
	}
	// Form messages (counts only).
	const counts = o.formsOutbox ? await monthCounts(env, month).catch(() => undefined) : undefined;
	const forms: ReportSources["forms"] = counts ?? { missing: o.formsOutbox ? "The form outbox could not be read." : "Form messages are emailed directly and not counted on this site." };
	// Content: published pages of the report's collections.
	const collections = o.collections?.length ? o.collections : ["pages"];
	const items = (await Promise.all(collections.map(async (c) => ({ c, items: await listAll(d, c).catch(() => [] as Item[]) })))).flatMap((x) => x.items.map((i) => ({ c: x.c, i })));
	const published = items.filter((x) => x.i.status === "published");
	const content = { items: published.map(({ i }) => ({ title: String(i.data.title ?? i.slug ?? i.id).slice(0, 120), publishedAt: (i as Item & { publishedAt?: string | null }).publishedAt ?? null, ...((i as Item & { updatedAt?: string }).updatedAt ? { updatedAt: (i as Item & { updatedAt?: string }).updatedAt } : {}) })) };
	// SEO score: the SEO suite's analysis of every published page (alt text from the media library, focus keywords).
	let seo: ReportSources["seo"];
	if (o.seo && published.length) {
		try {
			const ctx = { media: d.media } as unknown as SeoCtx;
			const media = await mediaInfo(ctx, mediaIds(published.map((x) => x.i.data.content)));
			const kw = await focusKeywords(env.DB);
			const scores = published.map(({ c, i }) => analyseItem({ productionUrl: o.productionUrl, titleSeparator: o.seo?.titleSeparator ?? "-", ...(o.seo?.ogCards ? { ogCards: true } : {}) }, o.siteName, i, items.filter((x) => x.c === c).map((x) => x.i), media, kw.get(`${c}:${i.id}`)).score);
			seo = { average: Math.round(scores.reduce((n, s) => n + s, 0) / scores.length), pages: scores.length };
		} catch {
			seo = { missing: "The SEO score could not be calculated this month." };
		}
	}
	return { visits, forms, content, ...(seo ? { seo } : {}) };
}
