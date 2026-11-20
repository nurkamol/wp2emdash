/**
 * Blog feeds (verify `feeds`): the site feed and archive feeds answer RSS 2.0 that feed readers accept — the rss
 * element with version 2.0, a channel with title, link and description, and items with title, link, guid and an
 * RFC 822 pubDate; the newest posts first, as many as the feed setting allows.
 */
import { XMLParser } from "fast-xml-parser";

export interface FeedCheck {
	ok: boolean;
	items: number;
	problems: string[];
	links: string[];
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", isArray: (name) => name === "item" || name === "category" });

export function validateRss(xml: string, expect: { items?: number; titles?: string[] } = {}): FeedCheck {
	const problems: string[] = [];
	let doc: Record<string, any>;
	try {
		doc = parser.parse(xml) as Record<string, any>;
	} catch (e) {
		return { ok: false, items: 0, problems: [`not XML: ${(e as Error).message.split("\n")[0]}`], links: [] };
	}
	const rss = doc.rss;
	if (!rss) return { ok: false, items: 0, problems: ["no <rss> element"], links: [] };
	if (rss["@version"] !== "2.0") problems.push(`rss version ${rss["@version"] ?? "missing"}`);
	const ch = rss.channel;
	if (!ch) return { ok: false, items: 0, problems: [...problems, "no <channel>"], links: [] };
	for (const k of ["title", "link", "description"]) if (ch[k] === undefined || ch[k] === "") problems.push(`channel ${k} missing`);
	const items = (ch.item ?? []) as Record<string, any>[];
	const links: string[] = [];
	let prev = Number.POSITIVE_INFINITY;
	for (const [i, it] of items.entries()) {
		for (const k of ["title", "link", "guid", "pubDate"]) if (it[k] === undefined || it[k] === "") problems.push(`item ${i + 1}: ${k} missing`);
		const t = Date.parse(String(it.pubDate ?? ""));
		if (Number.isNaN(t)) problems.push(`item ${i + 1}: pubDate not a date`);
		else if (t > prev) problems.push(`item ${i + 1}: not newest first`);
		else prev = t;
		if (typeof it.link === "string") links.push(it.link);
	}
	if (expect.items !== undefined && items.length !== expect.items) problems.push(`${items.length} items, expected ${expect.items}`);
	const titles = new Set(items.map((it) => String(it.title ?? "")));
	const missing = (expect.titles ?? []).filter((t) => !titles.has(t));
	if (missing.length) problems.push(`missing posts: ${missing.slice(0, 3).join(", ")}`);
	return { ok: problems.length === 0, items: items.length, problems, links };
}
