/** Shared data access for the SEO panel and dashboard: pages, alt text, focus keywords, one page's analysis. */
import { type Analysis, analyze, type PageSeo } from "../analyze.js";
import type { SeoPanelOptions } from "../index.js";

export interface Item {
	id: string;
	slug: string | null;
	status?: string;
	data: Record<string, unknown>;
	seo?: PageSeo;
}
export interface Kv {
	get<T>(k: string): Promise<T | null>;
	set(k: string, v: unknown): Promise<void>;
	delete?(k: string): Promise<boolean>;
}
export interface SeoCtx {
	input: unknown;
	request?: Request;
	user?: { role: number };
	ui?: { surface?: string; entry?: { collection: string; id: string } };
	kv: Kv;
	content?: { get(c: string, id: string): Promise<Item | null>; list(c: string, o?: { limit?: number; cursor?: string }): Promise<{ items: Item[]; cursor?: string; hasMore?: boolean }> };
	media?: {
		get(id: string): Promise<{ id?: string; alt?: string | null; filename?: string; url?: string; mimeType?: string } | null>;
		list?(o?: { limit?: number; cursor?: string; mimeType?: string }): Promise<{ items: { id: string; alt?: string | null; filename: string; url: string; mimeType: string }[]; cursor?: string; hasMore?: boolean }>;
		updateMetadata?(id: string, patch: { alt?: string | null }): Promise<unknown>;
	};
	site: { name: string; url?: string };
	settings?: { get<T>(k: string): Promise<T | null>; set(k: string, v: unknown): Promise<void>; delete(k: string): Promise<boolean> };
	log?: { info(m: string, d?: Record<string, unknown>): void; warn?(m: string, d?: Record<string, unknown>): void };
}

/** Every entry of a collection (up to `max`), trash excluded. */
export async function allItems(ctx: SeoCtx, collection: string, max = 500): Promise<Item[]> {
	if (!ctx.content) return [];
	const out: Item[] = [];
	let cursor: string | undefined;
	do {
		const page = await ctx.content.list(collection, { limit: 100, ...(cursor ? { cursor } : {}) });
		out.push(...page.items.filter((i) => i.status !== "trash"));
		cursor = page.hasMore !== false && page.cursor && out.length < max ? page.cursor : undefined;
	} while (cursor);
	return out;
}

/** Media ids (EmDash ULIDs) referenced anywhere in a value. */
export const mediaIds = (v: unknown) => [...new Set(JSON.stringify(v ?? []).match(/"id":"[0-9A-HJKMNP-TV-Z]{26}"/g)?.map((m) => m.slice(6, -1)) ?? [])];

/** Alt text and file name of media items, by id (library values; a field's own alt is read by the analysis). */
export interface MediaInfo {
	alt?: string;
	filename?: string;
	url?: string;
	mimeType?: string;
}
export async function mediaInfo(ctx: SeoCtx, ids: string[]): Promise<Map<string, MediaInfo>> {
	const out = new Map<string, MediaInfo>();
	await Promise.all(
		ids.slice(0, 300).map(async (id) => {
			const m = await ctx.media?.get(id).catch(() => null);
			if (m) out.set(id, { ...(m.alt ? { alt: m.alt } : {}), ...(m.filename ? { filename: m.filename } : {}), ...(m.url ? { url: m.url } : {}), ...(m.mimeType ? { mimeType: m.mimeType } : {}) });
		}),
	);
	return out;
}

export const keywordKey = (collection: string, id: string) => `kw:${collection}:${id}`;

export interface PageReport {
	item: Item;
	collection: string;
	title: string;
	analysis: Analysis;
	keyword?: string;
}

/** Analyse one entry against the rest of its collection. */
export function analyseItem(o: SeoPanelOptions, siteName: string, item: Item, all: Item[], media: Map<string, { alt?: string }>, keyword: string | undefined, draft?: Record<string, unknown>): Analysis {
	const others = all.filter((x) => x.id !== item.id).map((x) => ({ title: (x.seo?.title || String(x.data.title ?? "")).trim(), pageTitle: String(x.data.title ?? "").trim(), description: x.seo?.description ?? null }));
	return analyze({
		title: String(draft?.title ?? item.data.title ?? ""),
		slug: item.slug,
		seo: item.seo ?? null,
		content: draft?.content ?? item.data.content,
		siteName,
		separator: o.titleSeparator ?? "-",
		productionUrl: o.productionUrl,
		others,
		...(keyword ? { focusKeyword: keyword } : {}),
		altOf: (id) => media.get(id)?.alt,
		...(o.ogCards ? { ogCards: true } : {}),
	});
}

/** Reports for every published entry of the given collections. */
export async function siteReport(ctx: SeoCtx, o: SeoPanelOptions, collections: string[]): Promise<{ pages: PageReport[]; media: Map<string, MediaInfo>; usage: Map<string, PageReport[]> }> {
	const pages: PageReport[] = [];
	const usage = new Map<string, PageReport[]>();
	const perCollection = await Promise.all(collections.map(async (c) => ({ c, items: await allItems(ctx, c) })));
	const media = await mediaInfo(ctx, mediaIds(perCollection.flatMap((x) => x.items.filter((i) => i.status === "published").map((i) => i.data.content))));
	for (const { c, items } of perCollection) {
		for (const item of items.filter((i) => i.status === "published")) {
			const keyword = (await ctx.kv.get<string>(keywordKey(c, item.id))) ?? undefined;
			const r: PageReport = { item, collection: c, title: String(item.data.title ?? item.slug ?? item.id), analysis: analyseItem(o, ctx.site.name, item, items, media, keyword), ...(keyword ? { keyword } : {}) };
			pages.push(r);
			for (const id of mediaIds(item.data.content)) usage.set(id, [...(usage.get(id) ?? []), r]);
		}
	}
	return { pages, media, usage };
}
