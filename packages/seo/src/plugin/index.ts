/**
 * SEO — EmDash native plugin (loaded in the Worker from `@wp2emdash/seo/plugin`): a Block Kit panel in the page editor.
 *
 * Opening the panel analyses the saved page (`content:read`: its sections and SEO fields, plus other pages for the
 * duplicate check; `media:read`: alt text kept in the media library). "Check unsaved changes" analyses the editor's
 * current title and sections (`admin.editor-draft:read`; EmDash sends the draft with button presses, not on load).
 * The SEO fields live outside the entry, so their unsaved edits are not visible here until saved. A focus keyword per
 * page is kept in the plugin's KV. Contributors and up can use it (EmDash also checks they may edit the entry).
 */
import { definePlugin } from "emdash";
import type { Analysis, Check } from "../analyze.js";
import { SEO_PLUGIN, type SeoPanelOptions } from "../index.js";
import { siteChecks } from "../site-checks.js";
import { allItems, analyseItem, keywordKey, mediaIds, mediaInfo, type SeoCtx, siteReport } from "./collect.js";
import { DASHBOARD_PAGE, dashboard, type GoogleData, type GoogleState, type IndexNowState, WIDGET, widget } from "./dashboard.js";
import { dateRange, GoogleError, parseServiceAccount, pickProperty, SearchConsole } from "../google.js";
import { type IndexNowResult, submitIndexNow } from "../indexnow.js";

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
			fields: [{ type: "text_input", action_id: "keyword", label: "Focus keyword (what people search for to find this page)", placeholder: "e.g. reformer pilates Example City", ...(keyword ? { initial_value: keyword } : {}) }],
			submit: { label: "Save keyword", action_id: "keyword" },
		},
		{ type: "actions", elements: [{ type: "button", action_id: "check-draft", label: "Check my unsaved changes", style: "secondary" }] },
		{ type: "context", text: `${a.words} words. SEO title, description and sharing image are edited in the page's SEO fields; save the page to check changes made there.` },
	];
}

export function createPlugin(options: SeoPanelOptions) {
	const o = options;
	const collections = o.collections?.length ? o.collections : ["pages"];
	return definePlugin({
		...SEO_PLUGIN,
		capabilities: ["content:read", "media:read", "media:metadata:write", "admin.editor-draft:read"],
		hooks: {
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
			pages: [{ path: DASHBOARD_PAGE, label: "SEO", icon: "chart-line" }],
			widgets: [{ id: WIDGET, title: "SEO", size: "third" }],
			editorPanels: [{ id: "seo", title: "SEO", route: "panel", collections, order: 10, draft: { read: { fields: ["title", "content"] } } }],
		},
		routes: {
			// SEO dashboard page and dashboard widget (editors and admins).
			admin: {
				permission: "content:edit_any",
				handler: async (raw) => {
					const ctx = raw as unknown as SeoCtx;
					const i = (ctx.input ?? {}) as { type?: string; action_id?: string; values?: Record<string, unknown> };
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
					let toast: { message: string; type: "success" | "error" | "info" } | undefined = altSaved ? { message: `${altSaved} image description${altSaved === 1 ? "" : "s"} saved.`, type: "success" } : undefined;
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
					const tabFor: Record<string, number> = { "save-alt": 2, refresh: 3, "indexnow-all": 5 };
					return {
						blocks: dashboard({ pages: report.pages, missingAlt, site, ...(altSaved !== undefined ? { altSaved } : {}), google, ...(indexNow ? { indexNow } : {}), productionUrl: o.productionUrl }, act.startsWith("gsc-") ? 4 : (tabFor[act] ?? 0)),
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
					let toast: { message: string; type: "success" } | undefined;
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
					return { blocks: view(a, keyword, source), ...(toast ? { toast } : {}) };
				},
			},
		},
	});
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
