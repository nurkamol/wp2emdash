/**
 * SEO & Analytics — EmDash native plugin (loaded in the Worker from `@wp2emdash/seo/plugin`): a Block Kit panel in the page editor.
 *
 * Opening the panel analyses the saved page (`content:read`: its sections and SEO fields, plus other pages for the
 * duplicate check; `media:read`: alt text kept in the media library). "Check unsaved changes" analyses the editor's
 * current title and sections (`admin.editor-draft:read`; EmDash sends the draft with button presses, not on load).
 * The SEO fields live outside the entry, so their unsaved edits are not visible here until saved. A focus keyword per
 * page is kept in the plugin's KV. Contributors and up can use it (EmDash also checks they may edit the entry).
 *
 * Analytics (plugin/analytics.ts, analytics/*): tracking codes, conversion events and consent mode in the dashboard's
 * Analytics tab (changes: admins only; every save purges the cached pages), Cloudflare Web Analytics visits in the
 * Visits tab, the Visits dashboard widget (admins) and the editor panel (this page's views).
 *
 * Sharing text and archive SEO (social.ts, plugin/social.ts): per-entry Open Graph / Twitter text (panel → "Social
 * sharing") and per-term archive SEO (dashboard tab "Archives"), carried from Yoast / Rank Math by the kit's load
 * (`seo-import` route) and printed by the `page:metadata` hook, which runs before the sharing-card plugin (priority 50).
 */
import { definePlugin } from "emdash";
import type { Analysis, Check } from "../analyze.js";
import { SEO_PLUGIN, type SeoPanelOptions } from "../index.js";
import { siteChecks } from "../site-checks.js";
import { allItems, analyseItem, keywordKey, mediaIds, mediaInfo, type SeoCtx, siteReport } from "./collect.js";
import { DASHBOARD_PAGE, dashboard, type GoogleData, type GoogleState, type IndexNowState, type TabKey, WIDGET, widget } from "./dashboard.js";
import { analyticsTab, overviewAnalytics, panelVisits, VISITS_WIDGET, visitsTab, visitsWidget, type VisitsState } from "../analytics/views.js";
import { viewsOfPath } from "../analytics/visits.js";
import { purgePages, type StoredAnalytics } from "../analytics/store.js";
import { ADMIN_ROLE, analyticsAction, loadAnalytics, type Toast, visitsState, workerBits } from "./analytics.js";
import { dateRange, GoogleError, parseServiceAccount, pickProperty, SearchConsole } from "../google.js";
import { type IndexNowResult, submitIndexNow } from "../indexnow.js";
import { importSocial, parseSocial, parseTermSeo, socialKey, socialTags, termFromPath, termKey, termTags } from "../social.js";
import { archivesState, archivesTab, saveSocial, socialPanel, termAction } from "./social.js";

type Block = Record<string, unknown>;

const ICON: Record<Check["status"], string> = { good: "✓", warn: "!", bad: "✗", info: "i" };
const ORDER: Record<Check["status"], number> = { bad: 0, warn: 1, good: 2, info: 3 };

function view(a: Analysis, keyword: string, source: "saved" | "draft"): Block[] {
	const variant = a.score >= 80 ? "default" : a.score >= 50 ? "alert" : "error";
	const problems = a.checks.filter((c) => c.status === "bad" || c.status === "warn").length;
	const sorted = [...a.checks].sort((x, y) => ORDER[x.status] - ORDER[y.status]);
	return [
		{ type: "banner", title: `SEO score ${a.score}/100`, description: problems ? `${problems} thing${problems === 1 ? "" : "s"} to improve${source === "draft" ? " (your unsaved changes)" : ""}.` : `Looks good${source === "draft" ? " (your unsaved changes)" : ""}.`, variant },
		{ type: "header", text: "Google preview" },
		{ type: "context", text: a.serp.url },
		{ type: "section", text: a.serp.title },
		{ type: "context", text: a.serp.description || "No description: Google will pick text from the page." },
		...(a.serp.titleCut || a.serp.descriptionCut ? [{ type: "context", text: `Cut off on Google: ${[a.serp.titleCut ? "title" : "", a.serp.descriptionCut ? "description" : ""].filter(Boolean).join(" and ")} (…).` }] : []),
		{ type: "divider" },
		// One wrapping line per check: the editor sidebar is narrow, so no table.
		...(problems ? [{ type: "header", text: "To improve" }, ...sorted.filter((c) => c.status === "bad" || c.status === "warn").map((c) => ({ type: "section", text: `${ICON[c.status]} ${c.label}: ${c.detail}` }))] : []),
		{ type: "accordion", label: `Passed checks (${sorted.filter((c) => c.status === "good").length})`, default_open: !problems, blocks: sorted.filter((c) => c.status === "good" || c.status === "info").map((c) => ({ type: "section", text: `${ICON[c.status]} ${c.label}: ${c.detail}` })) },
		{ type: "divider" },
		{
			type: "form",
			block_id: "keyword",
			fields: [{ type: "text_input", action_id: "keyword", label: "Focus keyword (what people search for to find this page)", placeholder: "e.g. yoga classes in austin", ...(keyword ? { initial_value: keyword } : {}) }],
			submit: { label: "Save keyword", action_id: "keyword" },
		},
		{ type: "actions", elements: [{ type: "button", action_id: "check-draft", label: "Check my unsaved changes", style: "secondary" }] },
		{ type: "context", text: `${a.words} words. SEO title, description and sharing image are edited in the page's SEO fields; save the page to check changes made there.` },
	];
}

export function createPlugin(options: SeoPanelOptions, deps: { fetch?: typeof fetch } = {}) {
	const o = options;
	const fetchFn = deps.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
	const collections = o.collections?.length ? o.collections : ["pages"];
	return definePlugin({
		...SEO_PLUGIN,
		capabilities: ["content:read", "media:read", "media:metadata:write", "admin.editor-draft:read", "taxonomies:read"],
		hooks: {
			// Sharing text of the entry, or SEO of the term archive, from KV (one row by primary key). Before the sharing-card
			// plugin (@wp2emdash/og, default priority 100): plugin tags are first-wins, so a custom image beats the card.
			"page:metadata": {
				priority: 50,
				handler: async (event, raw) => {
					const ctx = raw as unknown as { kv: SeoCtx["kv"] };
					const page = event.page as { url: string; path?: string; siteUrl?: string; content?: { collection: string; id: string } };
					const base = page.siteUrl && URL.canParse(page.siteUrl) ? page.siteUrl : page.url;
					const origin = URL.canParse(base) ? new URL(base).origin : undefined;
					if (page.content) {
						const s = parseSocial(await ctx.kv.get(socialKey(page.content.collection, page.content.id)));
						if (!s) return null;
						return socialTags(s, { ...(origin ? { origin } : {}), ...(s.ogImage ? { ogImageMeta: await imageMeta(s.ogImage) } : {}) });
					}
					const t = page.path && o.archives?.length ? termFromPath(page.path, o.archives) : undefined;
					const ts = t ? parseTermSeo(await ctx.kv.get(termKey(t.taxonomy, t.slug))) : undefined;
					if (!ts) return null;
					return termTags(ts, { ...(origin ? { origin } : {}), ...(ts.ogImage ? { ogImageMeta: await imageMeta(ts.ogImage) } : {}) });
				},
			},
			// IndexNow on publish (only once the domain serves this site; before go-live it serves the old one).
			"content:afterPublish": async (event, raw) => {
				const ctx = raw as unknown as SeoCtx;
				if (!o.indexNow?.live || !collections.includes(event.collection)) return;
				const slug = typeof event.content.slug === "string" ? event.content.slug : null;
				await logIndexNow(ctx, await submitIndexNow(o.productionUrl, o.indexNow.key, [pageUrl(o, slug)]), `Published ${slug ?? "a page"}`);
			},
		},
		admin: {
			settingsSchema: {
				gscKey: { type: "secret", label: "Google Search Console service account key (JSON)" },
				gscProperty: { type: "string", label: "Search Console property (optional)" },
			},
			pages: [{ path: DASHBOARD_PAGE, label: o.analytics ? "SEO & Analytics" : "SEO", icon: "chart-line" }],
			widgets: [{ id: WIDGET, title: "SEO", size: "third" }, ...(o.analytics ? [{ id: VISITS_WIDGET, title: "Visits", size: "half" as const }] : [])],
			editorPanels: [{ id: "seo", title: "SEO", route: "panel", collections, order: 10, draft: { read: { fields: ["title", "content"] } } }],
		},
		routes: {
			// Sharing text and archive SEO carried from WordPress, written by the kit's load (admins / admin-scope token).
			"seo-import": {
				methods: ["POST"],
				request: { body: "json", maxBytes: 4 * 1024 * 1024 },
				handler: async (raw) => {
					const ctx = raw as unknown as SeoCtx & { user?: { role: number } };
					if ((ctx.user?.role ?? 0) < ADMIN_ROLE) return { error: "admins only" };
					const r = await importSocial(ctx.kv, ctx.input);
					const purge = r.entries.written || r.terms.written ? await purgePages((await workerBits()).cache) : "no-cache";
					ctx.log?.info("seo import", { entries: r.entries.written, terms: r.terms.written, kept: r.entries.kept + r.terms.kept, purge });
					return { plugin: SEO_PLUGIN.id, version: SEO_PLUGIN.version, ...r };
				},
			},
			// SEO dashboard page and dashboard widget (editors and admins).
			admin: {
				permission: "content:edit_any",
				handler: async (raw) => {
					const ctx = raw as unknown as SeoCtx & { user?: { role: number; name?: string | null; email?: string } };
					const i = (ctx.input ?? {}) as { type?: string; action_id?: string; block_id?: string; value?: unknown; page?: string; values?: Record<string, unknown> };
					const host = new URL(o.productionUrl).host;
					// Visits widget: admins only, no SEO report needed.
					if (ctx.ui?.surface === "dashboard-widget" && i.page === `widget:${VISITS_WIDGET}`) {
						if (!o.analytics || (ctx.user?.role ?? 0) < ADMIN_ROLE) return { blocks: [] };
						return { blocks: visitsWidget(await visitsState(ctx, o, await workerBits(), fetchFn), host, DASHBOARD_PAGE) };
					}
					// Archive SEO actions: the edit form replaces the dashboard.
					const archives = o.archives ?? [];
					let archiveToast: Toast | undefined;
					if ((i.action_id ?? "").startsWith("term-")) {
						const r = await termAction(ctx, await archivesState(ctx, archives), i, (await workerBits()).cache);
						if ("view" in r) return { blocks: r.view, ...(r.toast ? { toast: r.toast } : {}) };
						archiveToast = r.toast;
					}
					// Analytics actions first: the add / edit forms replace the dashboard.
					let analytics: StoredAnalytics | undefined = o.analytics ? await loadAnalytics(ctx, o) : undefined;
					let anErrors: string[] | undefined;
					let anToast: Toast | undefined;
					const bits = o.analytics ? await workerBits() : undefined;
					if (analytics && bits && (i.action_id ?? "").startsWith("an-")) {
						const r = await analyticsAction(ctx, analytics, i, bits);
						if ("view" in r) return { blocks: r.view, ...(r.toast ? { toast: r.toast } : {}) };
						analytics = r.stored;
						anErrors = r.errors;
						anToast = r.toast;
					}
					let altSaved: number | undefined;
					if (i.type === "form_submit" && i.action_id === "save-alt" && ctx.media?.updateMetadata) {
						altSaved = 0;
						for (const [k, v] of Object.entries(i.values ?? {})) {
							const id = /^alt:([0-9A-HJKMNP-TV-Z]{26})$/.exec(k)?.[1];
							const alt = typeof v === "string" ? v.trim().slice(0, 300) : "";
							if (!id || !alt) continue;
							await ctx.media.updateMetadata(id, { alt });
							altSaved++;
						}
					}
					const report = await siteReport(ctx, o, collections);
					const missingAlt = [...report.usage.entries()]
						// Pictures only (videos and files have no alt text), and only those the library knows.
						.filter(([id]) => report.media.get(id)?.mimeType?.startsWith("image/") && !report.media.get(id)?.alt?.trim())
						.map(([id, used]) => ({ id, filename: report.media.get(id)?.filename ?? id, ...(report.media.get(id)?.url ? { url: report.media.get(id)?.url } : {}), pages: [...new Set(used.map((p) => p.title))] }));
					if (ctx.ui?.surface === "dashboard-widget") return { blocks: widget(report.pages, missingAlt.length) };
					const origin = ctx.request && URL.canParse(ctx.request.url) ? new URL(ctx.request.url).origin : o.productionUrl;
					const paths = report.pages.map((p) => (p.item.slug && p.item.slug !== "home" && p.item.slug !== "index" ? `/${p.item.slug}/` : "/"));
					// Through the Worker's binding to itself: a fetch to its own address skips the Worker (workers.dev: nothing
					// answers; the domain: the old origin would). Local dev has no such routing, so plain fetch works there.
					const { env } = (await import("cloudflare:workers")) as unknown as { env: { SELF?: { fetch(r: Request): Promise<Response> } } };
					const self = env.SELF;
					const fetcher = (self ? (input: RequestInfo | URL, init?: RequestInit) => self.fetch(new Request(String(input), init)) : fetch) as typeof fetch;
					const site = await siteChecks(origin, o.productionUrl, paths, fetcher).catch((e: Error) => [{ id: "site", label: "Site checks", status: "warn" as const, detail: `Could not run: ${e.message}` }]);
					// Google Search Console and IndexNow actions.
					let toast: { message: string; type: "success" | "error" | "info" } | undefined = altSaved ? { message: `${altSaved} image description${altSaved === 1 ? "" : "s"} saved.`, type: "success" } : (anToast ?? archiveToast);
					let google: GoogleState;
					const act = i.action_id ?? "";
					if (act.startsWith("gsc-")) {
						const r = await googleAction(ctx, o, act, i.values ?? {}, report.pages.map((p) => pageUrl(o, p.item.slug)));
						google = r.state;
						toast = r.toast;
					} else google = await googleState(ctx, o, false);
					let indexNow: IndexNowState | undefined;
					if (o.indexNow) {
						if (act === "indexnow-all" && o.indexNow.live) {
							const res = await submitIndexNow(o.productionUrl, o.indexNow.key, report.pages.map((p) => pageUrl(o, p.item.slug)));
							await logIndexNow(ctx, res, "All pages");
							toast = { message: res.ok ? `${res.urls} pages sent to IndexNow.` : `IndexNow refused: ${res.note ?? res.status}`, type: res.ok ? "success" : "error" };
						}
						const keyFile = o.indexNow.live ? ((await fetcher(new URL(`/${o.indexNow.key}.txt`, origin).toString()).then(async (r) => (r.ok && (await r.text()).trim() === o.indexNow?.key ? "ok" : "missing")).catch(() => "missing")) as "ok" | "missing") : "not-checked";
						indexNow = { live: o.indexNow.live, keyFile, host: new URL(o.productionUrl).host, log: (await ctx.kv.get<IndexNowState["log"]>("indexnow:log")) ?? [] };
					}
					let visits: VisitsState | undefined;
					if (o.analytics && bits) visits = await visitsState(ctx, o, bits, fetchFn, act === "visits-refresh");
					const an =
						o.analytics && analytics && visits
							? { overview: overviewAnalytics(visits, analytics), visits: visitsTab(visits, host), tab: analyticsTab({ enabled: true, stored: analytics, options: o.analytics, productionUrl: o.productionUrl, admin: (ctx.user?.role ?? 0) >= ADMIN_ROLE, ...(anErrors ? { errors: anErrors } : {}) }) }
							: undefined;
					const tabFor: Record<string, TabKey> = { "save-alt": "images", refresh: "site", "indexnow-all": "indexnow", "visits-refresh": "visits" };
					const archivesBlocks = archives.length ? archivesTab(await archivesState(ctx, archives)) : undefined;
					return {
						blocks: dashboard({ pages: report.pages, missingAlt, site, ...(altSaved !== undefined ? { altSaved } : {}), google, ...(indexNow ? { indexNow } : {}), productionUrl: o.productionUrl, ...(an ? { analytics: an } : {}), ...(archivesBlocks ? { archives: archivesBlocks } : {}) }, act.startsWith("gsc-") ? "google" : act.startsWith("an-") ? "analytics" : act.startsWith("term-") ? "archives" : (tabFor[act] ?? "overview")),
						...(toast ? { toast } : {}),
					};
				},
			},
			panel: {
				permission: "content:read_drafts",
				handler: async (raw) => {
					const ctx = raw as unknown as SeoCtx;
					const entry = ctx.ui?.entry;
					if (!entry || !ctx.content) return { blocks: [{ type: "context", text: "Save the page once to see its SEO checks." }] };
					const i = (ctx.input ?? {}) as { type?: string; action_id?: string; values?: Record<string, unknown>; draft?: { fields?: Record<string, unknown> } };
					const kvKey = keywordKey(entry.collection, entry.id);
					let keyword = (await ctx.kv.get<string>(kvKey)) ?? "";
					let toast: { message: string; type: "success" | "error" | "info" } | undefined;
					const socialK = socialKey(entry.collection, entry.id);
					let social = parseSocial(await ctx.kv.get(socialK));
					if (i.type === "form_submit" && i.action_id === "social") {
						const r = await saveSocial(ctx, entry, i.values, (await workerBits()).cache);
						social = r.stored;
						toast = r.toast;
					}
					if (i.type === "form_submit" && i.action_id === "keyword") {
						keyword = typeof i.values?.keyword === "string" ? i.values.keyword.trim().slice(0, 80) : "";
						await ctx.kv.set(kvKey, keyword);
						toast = { message: keyword ? "Focus keyword saved." : "Focus keyword removed.", type: "success" };
					}
					const saved = await ctx.content.get(entry.collection, entry.id);
					if (!saved) return { blocks: [{ type: "context", text: "This page could not be read." }] };
					const draft = i.draft?.fields;
					const source = draft ? "draft" : "saved";
					const all = await allItems(ctx, entry.collection, 300);
					const media = await mediaInfo(ctx, mediaIds(draft?.content ?? saved.data.content).slice(0, 60));
					const a = analyseItem(o, ctx.site.name, saved, all, media, keyword || undefined, draft);
					// This page's views (7 days) from the same cached Cloudflare query, when Visits are set up.
					let traffic: Record<string, unknown>[] = [];
					if (o.analytics) {
						const vs = await visitsState(ctx, o, await workerBits(), fetchFn).catch(() => undefined);
						const slug = typeof saved.slug === "string" ? saved.slug : null;
						if (vs?.kind === "data") traffic = panelVisits(viewsOfPath(vs.visits, new URL(pageUrl(o, slug)).pathname));
					}
					const fallback = { ...(saved.seo?.title || saved.data.title ? { title: String(saved.seo?.title || saved.data.title) } : {}), ...(saved.seo?.description ? { description: saved.seo.description } : {}) };
					return { blocks: [...traffic, ...view(a, keyword, source), ...socialPanel(social, fallback)], ...(toast ? { toast } : {}) };
				},
			},
		},
	});
}

/** Size and type of a media-library image (EmDash's media table), so link previews lay it out right. */
async function imageMeta(u: string): Promise<{ width?: number; height?: number; type?: string }> {
	const key = /\/_emdash\/api\/media\/file\/([^/?#]+)$/.exec(u)?.[1];
	if (!key) return {};
	const { env } = (await import("cloudflare:workers")) as unknown as { env: { DB?: { prepare(q: string): { bind(...v: unknown[]): { first<T>(): Promise<T | null> } } } } };
	const row = env.DB ? await env.DB.prepare("SELECT width, height, mime_type FROM media WHERE storage_key = ? LIMIT 1").bind(decodeURIComponent(key)).first<{ width: number | null; height: number | null; mime_type: string | null }>().catch(() => null) : null;
	return { ...(row?.width ? { width: row.width } : {}), ...(row?.height ? { height: row.height } : {}), ...(row?.mime_type?.startsWith("image/") ? { type: row.mime_type } : {}) };
}

const pageUrl = (o: SeoPanelOptions, slug: string | null) => `${o.productionUrl.replace(/\/$/, "")}${slug && slug !== "home" && slug !== "index" ? `/${slug}/` : "/"}`;

async function logIndexNow(ctx: SeoCtx, r: IndexNowResult, trigger: string): Promise<void> {
	const log = (await ctx.kv.get<(IndexNowResult & { trigger: string })[]>("indexnow:log")) ?? [];
	await ctx.kv.set("indexnow:log", [{ ...r, trigger }, ...log].slice(0, 20));
	ctx.log?.info("indexnow", { urls: r.urls, status: r.status, ok: r.ok });
}

const CACHE_MS = 6 * 3600_000;

async function client(ctx: SeoCtx): Promise<{ gsc: SearchConsole; account: string } | undefined> {
	const raw = await ctx.settings?.get<string>("gscKey");
	if (!raw) return undefined;
	const sa = parseServiceAccount(raw);
	return { gsc: new SearchConsole(sa), account: sa.client_email };
}

async function property(ctx: SeoCtx, o: SeoPanelOptions, gsc: SearchConsole): Promise<string> {
	const set = (await ctx.settings?.get<string>("gscProperty"))?.trim();
	if (set) return set;
	const found = pickProperty(await gsc.sites(), o.productionUrl);
	if (!found) throw new GoogleError(`The service account cannot see a Search Console property for ${new URL(o.productionUrl).host}. Add it as a user of the property.`, 403);
	return found;
}

async function loadGoogle(gsc: SearchConsole, site: string): Promise<GoogleData> {
	const range = dateRange();
	const [totals, byDate, queries, pages, sitemaps] = await Promise.all([
		gsc.analytics(site, { ...range, dimensions: [] }),
		gsc.analytics(site, { ...range, dimensions: ["date"], rowLimit: 100 }),
		gsc.analytics(site, { ...range, dimensions: ["query"], rowLimit: 15 }),
		gsc.analytics(site, { ...range, dimensions: ["page"], rowLimit: 15 }),
		gsc.sitemaps(site),
	]);
	const t = totals[0] ?? { clicks: 0, impressions: 0, ctr: 0, position: 0 };
	return {
		at: new Date().toISOString(),
		property: site,
		range,
		totals: { clicks: t.clicks, impressions: t.impressions, ctr: t.ctr, position: t.position },
		byDate: byDate.map((r) => ({ date: r.keys?.[0] ?? "", clicks: r.clicks, impressions: r.impressions })),
		queries: queries.map((r) => ({ query: r.keys?.[0] ?? "", clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })),
		pages: pages.map((r) => ({ page: r.keys?.[0] ?? "", clicks: r.clicks, impressions: r.impressions, ctr: r.ctr, position: r.position })),
		sitemaps: sitemaps.map((s) => ({ path: s.path, ...(s.lastSubmitted ? { lastSubmitted: s.lastSubmitted } : {}), ...(s.lastDownloaded ? { lastDownloaded: s.lastDownloaded } : {}), ...(s.isPending ? { isPending: true } : {}), ...(s.errors ? { errors: s.errors } : {}), ...(s.warnings ? { warnings: s.warnings } : {}), ...(s.contents?.[0]?.submitted ? { submitted: s.contents[0].submitted } : {}), ...(s.contents?.[0]?.indexed ? { indexed: s.contents[0].indexed } : {}) })),
	};
}

/** Connection state with cached data (6 hours unless forced). Errors are reported, never thrown at the page. */
async function googleState(ctx: SeoCtx, o: SeoPanelOptions, force: boolean): Promise<GoogleState> {
	let c: Awaited<ReturnType<typeof client>>;
	try {
		c = await client(ctx);
	} catch (e) {
		return { connected: false, error: (e as Error).message };
	}
	if (!c) return { connected: false };
	const cached = await ctx.kv.get<GoogleData>("gsc:cache");
	if (cached && !force && Date.now() - Date.parse(cached.at) < CACHE_MS) return { connected: true, account: c.account, data: cached };
	try {
		const data = await loadGoogle(c.gsc, await property(ctx, o, c.gsc));
		if (cached?.inspections) data.inspections = cached.inspections;
		await ctx.kv.set("gsc:cache", data);
		return { connected: true, account: c.account, data };
	} catch (e) {
		return { connected: true, account: c.account, ...(cached ? { data: cached } : {}), error: (e as Error).message };
	}
}

async function googleAction(ctx: SeoCtx, o: SeoPanelOptions, act: string, values: Record<string, unknown>, urls: string[]): Promise<{ state: GoogleState; toast?: { message: string; type: "success" | "error" | "info" } }> {
	if (act === "gsc-connect") {
		const key = typeof values.key === "string" ? values.key.trim() : "";
		const prop = typeof values.property === "string" ? values.property.trim().slice(0, 200) : "";
		try {
			const sa = parseServiceAccount(key);
			const gsc = new SearchConsole(sa);
			const site = prop || pickProperty(await gsc.sites(), o.productionUrl);
			if (!site) throw new Error(`Connected to Google, but ${sa.client_email} is not a user of a Search Console property for ${new URL(o.productionUrl).host} yet (step 3).`);
			await ctx.settings?.set("gscKey", key);
			if (prop) await ctx.settings?.set("gscProperty", prop);
			await ctx.kv.delete?.("gsc:cache");
			ctx.log?.info("search console connected", { account: sa.client_email });
			return { state: await googleState(ctx, o, true), toast: { message: "Search Console connected.", type: "success" } };
		} catch (e) {
			return { state: { connected: false, error: (e as Error).message } };
		}
	}
	if (act === "gsc-disconnect") {
		await ctx.settings?.delete("gscKey");
		await ctx.settings?.delete("gscProperty");
		await ctx.kv.delete?.("gsc:cache");
		return { state: { connected: false }, toast: { message: "Search Console disconnected; the key was deleted.", type: "success" } };
	}
	const c = await client(ctx).catch(() => undefined);
	if (!c) return { state: { connected: false } };
	try {
		const site = await property(ctx, o, c.gsc);
		if (act === "gsc-submit-sitemap") {
			await c.gsc.submitSitemap(site, `${o.productionUrl.replace(/\/$/, "")}/sitemap.xml`);
			return { state: await googleState(ctx, o, true), toast: { message: "Sitemap submitted to Google.", type: "success" } };
		}
		if (act === "gsc-inspect") {
			// URL Inspection allows 2,000 a day per property; this checks at most 25 pages.
			const rows = await Promise.all(urls.slice(0, 25).map(async (url) => ({ url, ...(await c.gsc.inspect(site, url).catch((e: Error) => ({ coverageState: e.message }))) })));
			const state = await googleState(ctx, o, false);
			if (state.data) {
				state.data.inspections = { at: new Date().toISOString(), rows };
				await ctx.kv.set("gsc:cache", state.data);
			}
			return { state, toast: { message: `Index status checked for ${rows.length} pages.`, type: "success" } };
		}
		return { state: await googleState(ctx, o, true), toast: { message: "Updated from Google.", type: "info" } };
	} catch (e) {
		return { state: { ...(await googleState(ctx, o, false)), error: (e as Error).message } };
	}
}

export default createPlugin;
