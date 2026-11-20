import { XMLParser } from "fast-xml-parser";
import type { Reporter } from "../core/progress.js";
import { fetchUrl } from "./http.js";
import { isInternal, normalizeUrl, type SiteHosts } from "./urls.js";

export type UrlSource = "home" | "sitemap" | "rest" | "crawl";

export interface RestItem {
	id: number;
	type: string;
	restBase: string;
	slug: string;
	link: string;
	parent?: number;
	modifiedGmt?: string;
	template?: string;
}

export interface RestTerm {
	id: number;
	taxonomy: string;
	slug: string;
	name: string;
	link: string;
	count: number;
}

export interface RestMedia {
	id: number;
	link: string;
	sourceUrl: string;
	mimeType: string;
	parent?: number;
}

export interface Discovery {
	sitemaps: string[];
	sitemapUrls: Map<string, { lastmod?: string }>;
	restAvailable: boolean;
	restNamespaces: string[];
	restSiteName?: string;
	types: { slug: string; restBase: string; count: number }[];
	items: RestItem[];
	terms: RestTerm[];
	media: RestMedia[];
	authors: { id: number; slug: string; link: string; name?: string; description?: string; avatar?: string }[];
	robotsTxt?: string;
}

const xml = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true });
const asArray = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Types never treated as public pages. */
const SKIP_TYPES = new Set([
	"attachment",
	"nav_menu_item",
	"wp_block",
	"wp_template",
	"wp_template_part",
	"wp_navigation",
	"wp_global_styles",
	"wp_font_family",
	"wp_font_face",
	// Theme/plugin template parts and data-only types (migrated in extract, never public pages)
	"salient_g_sections",
	"rank_math_schema",
	"elementor_library",
	"bricks_template",
	"et_pb_layout",
	"vc_grid_item",
	"templately_library",
]);

async function fetchJson<T>(url: string): Promise<{ data?: T; totalPages: number; status: number }> {
	const r = await fetchUrl(url, { headers: { Accept: "application/json" } });
	if (r.status !== 200 || !/json/.test(r.contentType)) return { totalPages: 0, status: r.status };
	try {
		return { data: JSON.parse(r.body) as T, totalPages: Number(r.headers["x-wp-totalpages"] ?? 1), status: r.status };
	} catch {
		return { totalPages: 0, status: r.status };
	}
}

async function fetchAllPages<T>(base: string, reporter: Reporter, label: string): Promise<T[]> {
	const out: T[] = [];
	const sep = base.includes("?") ? "&" : "?";
	const first = await fetchJson<T[]>(`${base}${sep}per_page=100&page=1`);
	if (!first.data) return out;
	out.push(...first.data);
	for (let page = 2; page <= first.totalPages; page++) {
		reporter.emit({ type: "step:progress", step: "REST discovery", done: page, total: first.totalPages, item: label });
		const next = await fetchJson<T[]>(`${base}${sep}per_page=100&page=${page}`);
		if (!next.data) break;
		out.push(...next.data);
	}
	return out;
}

export async function discoverSitemaps(site: SiteHosts, reporter: Reporter): Promise<Pick<Discovery, "sitemaps" | "sitemapUrls" | "robotsTxt">> {
	reporter.emit({ type: "step:start", step: "Sitemaps" });
	const robots = await fetchUrl(`${site.origin}/robots.txt`);
	const robotsTxt = robots.status === 200 ? robots.body : undefined;
	const declared = [...(robotsTxt ?? "").matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1] as string);
	const queue = [...new Set([...declared, `${site.origin}/sitemap_index.xml`, `${site.origin}/wp-sitemap.xml`, `${site.origin}/sitemap.xml`])];
	const seen = new Set<string>();
	const sitemaps: string[] = [];
	const sitemapUrls = new Map<string, { lastmod?: string }>();

	while (queue.length) {
		const url = queue.shift() as string;
		if (seen.has(url)) continue;
		seen.add(url);
		const r = await fetchUrl(url);
		if (r.status !== 200 || !/xml/.test(r.contentType + r.body.slice(0, 100))) continue;
		sitemaps.push(r.finalUrl);
		seen.add(r.finalUrl);
		let doc: Record<string, unknown>;
		try {
			doc = xml.parse(r.body);
		} catch {
			continue;
		}
		const index = doc.sitemapindex as { sitemap?: unknown } | undefined;
		for (const s of asArray(index?.sitemap as { loc: string }[] | { loc: string })) if (s?.loc) queue.push(String(s.loc).trim());
		const set = doc.urlset as { url?: unknown } | undefined;
		for (const u of asArray(set?.url as { loc: string; lastmod?: string }[] | { loc: string; lastmod?: string })) {
			if (!u?.loc || !isInternal(String(u.loc).trim(), site)) continue;
			sitemapUrls.set(normalizeUrl(String(u.loc).trim(), site), { lastmod: u.lastmod ? String(u.lastmod) : undefined });
		}
		reporter.emit({ type: "step:progress", step: "Sitemaps", done: sitemaps.length, item: r.finalUrl });
	}
	reporter.emit({ type: "step:end", step: "Sitemaps", ok: true, detail: `${sitemaps.length} sitemap(s), ${sitemapUrls.size} URLs` });
	return { sitemaps, sitemapUrls, robotsTxt };
}

export async function discoverRest(site: SiteHosts, reporter: Reporter): Promise<Omit<Discovery, "sitemaps" | "sitemapUrls" | "robotsTxt">> {
	reporter.emit({ type: "step:start", step: "REST discovery" });
	const root = await fetchJson<{ name?: string; namespaces?: string[] }>(`${site.origin}/wp-json/`);
	const empty = { restAvailable: false, restNamespaces: [], types: [], items: [], terms: [], media: [], authors: [] };
	if (!root.data) {
		reporter.emit({ type: "step:end", step: "REST discovery", ok: true, detail: `REST API not available (HTTP ${root.status}); relying on sitemap + crawl` });
		return empty;
	}

	const typesRes = await fetchJson<Record<string, { slug: string; rest_base?: string; rest_namespace?: string }>>(`${site.origin}/wp-json/wp/v2/types`);
	const types: Discovery["types"] = [];
	const items: RestItem[] = [];
	for (const t of Object.values(typesRes.data ?? {})) {
		if (SKIP_TYPES.has(t.slug) || !t.rest_base || (t.rest_namespace && t.rest_namespace !== "wp/v2")) continue;
		const list = await fetchAllPages<{ id: number; slug: string; link: string; type: string; parent?: number; modified_gmt?: string; template?: string }>(
			`${site.origin}/wp-json/wp/v2/${t.rest_base}?_fields=id,slug,link,type,parent,modified_gmt,template`,
			reporter,
			t.slug,
		);
		types.push({ slug: t.slug, restBase: t.rest_base, count: list.length });
		for (const i of list) {
			if (!i.link) continue;
			items.push({ id: i.id, type: i.type ?? t.slug, restBase: t.rest_base, slug: i.slug, link: normalizeUrl(i.link, site), parent: i.parent || undefined, modifiedGmt: i.modified_gmt, template: i.template || undefined });
		}
	}

	const taxRes = await fetchJson<Record<string, { slug: string; rest_base?: string; rest_namespace?: string }>>(`${site.origin}/wp-json/wp/v2/taxonomies`);
	const terms: RestTerm[] = [];
	for (const tax of Object.values(taxRes.data ?? {})) {
		if (!tax.rest_base || tax.slug === "nav_menu" || (tax.rest_namespace && tax.rest_namespace !== "wp/v2")) continue;
		const list = await fetchAllPages<{ id: number; slug: string; name: string; link: string; count: number }>(
			`${site.origin}/wp-json/wp/v2/${tax.rest_base}?_fields=id,slug,name,link,count&hide_empty=true`,
			reporter,
			tax.slug,
		);
		for (const term of list) terms.push({ id: term.id, taxonomy: tax.slug, slug: term.slug, name: term.name, link: normalizeUrl(term.link, site), count: term.count });
	}

	const mediaList = await fetchAllPages<{ id: number; link: string; source_url: string; mime_type: string; post?: number }>(
		`${site.origin}/wp-json/wp/v2/media?_fields=id,link,source_url,mime_type,post`,
		reporter,
		"media",
	);
	const media = mediaList.map((m) => ({ id: m.id, link: m.link, sourceUrl: m.source_url, mimeType: m.mime_type, parent: m.post || undefined }));

	// Public author profiles (what WordPress shows on author archives): name, bio and avatar become bylines (blog).
	const usersRes = await fetchJson<{ id: number; slug: string; link: string; name?: string; description?: string; avatar_urls?: Record<string, string> }[]>(`${site.origin}/wp-json/wp/v2/users?_fields=id,slug,link,name,description,avatar_urls&per_page=100`);
	const authors = (usersRes.data ?? []).map((u) => {
		const avatar = Object.entries(u.avatar_urls ?? {}).sort((a, b) => Number(b[0]) - Number(a[0]))[0]?.[1];
		return { id: u.id, slug: u.slug, link: normalizeUrl(u.link, site), ...(u.name ? { name: u.name } : {}), ...(u.description?.trim() ? { description: u.description.trim() } : {}), ...(avatar ? { avatar } : {}) };
	});

	reporter.emit({
		type: "step:end",
		step: "REST discovery",
		ok: true,
		detail: `${items.length} entries in ${types.length} types, ${terms.length} terms, ${media.length} media, ${root.data.namespaces?.length ?? 0} namespaces`,
	});
	return { restAvailable: true, restNamespaces: root.data.namespaces ?? [], restSiteName: root.data.name, types, items, terms, media, authors };
}
