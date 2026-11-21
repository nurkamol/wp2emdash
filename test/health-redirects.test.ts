/**
 * Site health → Missing pages → Create redirect: validation (pure), EmDash's redirects through `ctx.redirects`
 * (capability redirects:write; a stand-in with EmDash 1.5's duplicate behaviour), the list afterwards and the logs.
 * Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPlugin } from "../packages/health/src/plugin/index.js";
import { page, type PageData, TABS } from "../packages/health/src/plugin/views.js";
import { addRedirected, checkRedirect, findRelated, type RedirectLike, type RedirectsAccess, redirectSources, REDIRECTED_KEEP, withoutRedirected } from "../packages/health/src/redirects.js";
import { runChecks } from "../packages/health/src/run.js";
import { emptyState, KEYS } from "../packages/health/src/store.js";
import { memoryKv } from "./health-fixtures.js";
import { cache as cfCache, env } from "./stubs/cloudflare-workers.js";

const ORIGIN = "https://acme.example";
const SITE = ["/", "/about-us/", "/services/massage/", "/blog/hello-world/"];
const HOSTS = ["acme.example", "acme-site.acct.workers.dev"];
const check = (source: unknown, target: unknown, existing: RedirectLike[] = []) => checkRedirect({ source, target, sitePaths: SITE, siteHosts: HOSTS, existing });

/** EmDash's redirects, as far as Site health uses them: list (search, cursor) and create (CONFLICT on an existing source). */
function fakeRedirects(initial: RedirectLike[] = []) {
	const items: RedirectLike[] = initial.map((r, i) => ({ id: `r${i}`, enabled: true, isPattern: false, ...r }));
	const access: RedirectsAccess & { items: RedirectLike[]; created: unknown[] } = {
		items,
		created: [],
		async list(o = {}) {
			const all = items.filter((r) => !o.search || r.source.includes(o.search) || r.destination.includes(o.search));
			const from = o.cursor ? Number(o.cursor) : 0;
			const page = all.slice(from, from + (o.limit ?? 50));
			const next = from + page.length;
			return { items: page, ...(next < all.length ? { cursor: String(next), hasMore: true } : { hasMore: false }) };
		},
		async create(input) {
			if (items.some((r) => r.source === input.source)) throw Object.assign(new Error(`A redirect from "${input.source}" already exists`), { code: "CONFLICT" });
			access.created.push(input);
			const r = { id: `r${items.length}`, source: input.source, destination: input.destination ?? "", enabled: true, isPattern: false };
			items.push(r);
			return { redirect: r };
		},
	};
	return access;
}

describe("checkRedirect", () => {
	it("a missing path to a page of the sitemap", () => {
		expect(check("/old/hello-world/", "/blog/hello-world/")).toEqual({ ok: true, source: "/old/hello-world/", destination: "/blog/hello-world/" });
		// The sitemap's spelling wins (trailing slash), a full https address on this site becomes its path.
		expect(check("/old", "/about-us")).toEqual({ ok: true, source: "/old", destination: "/about-us/" });
		expect(check(" /old ", "https://www.acme.example/services/massage/")).toEqual({ ok: true, source: "/old", destination: "/services/massage/" });
		expect(check("/old", "https://acme-site.acct.workers.dev/")).toEqual({ ok: true, source: "/old", destination: "/" });
	});
	it("refuses what EmDash cannot store or a visitor should not get", () => {
		const err = (s: unknown, t: unknown, ex: RedirectLike[] = []) => {
			const r = check(s, t, ex);
			return r.ok ? "" : r.error;
		};
		expect(err("old", "/about-us/")).toMatch(/starts with \//);
		expect(err("//evil.example/x", "/about-us/")).toMatch(/path on this site/);
		expect(err("/a b", "/about-us/")).toMatch(/no spaces/);
		expect(err("/x/../y", "/about-us/")).toMatch(/not valid/);
		expect(err("/ol\td", "/about-us/")).toMatch(/path on this site/);
		expect(err("/_emdash/admin", "/about-us/")).toMatch(/EmDash's own addresses/);
		expect(err("/old", "https://other.example/page")).toMatch(/only send visitors to pages of this site/);
		expect(err("/old", "http://acme.example/about-us/")).toMatch(/https:\/\//);
		expect(err("/old", "javascript:alert(1)")).toMatch(/https:\/\//);
		expect(err("/old", "/about-us/?x=1")).toMatch(/path on this site/);
		expect(err("/old", "/not-a-page/")).toMatch(/not a page of this site/);
		expect(err("/about-us", "/about-us/")).toMatch(/must differ/);
		expect(err("/services/massage", "/about-us/")).toMatch(/is a page of this site/);
		expect(err("/old/", "/about-us/", [{ source: "/old", destination: "/x/" }])).toMatch(/exists already/);
		expect(err("/old/", "/about-us/", [{ source: "/about-us/", destination: "/services/massage/" }])).toMatch(/itself redirected/);
		expect(checkRedirect({ source: "/old", target: "/about-us/", sitePaths: [], siteHosts: HOSTS, existing: [] })).toMatchObject({ ok: false, error: expect.stringMatching(/sitemap\) has not been read/) });
	});
	it("reads EmDash's redirects page by page; remembers what it made for a week", async () => {
		const many = fakeRedirects(Array.from({ length: 150 }, (_, i) => ({ source: `/a${i}/`, destination: "/about-us/" })));
		expect((await redirectSources(many)).length).toBe(150);
		expect((await findRelated(many, ["/a7/"])).map((r) => r.source)).toEqual(["/a7/", "/a70/", "/a71/", "/a72/", "/a73/", "/a74/", "/a75/", "/a76/", "/a77/", "/a78/", "/a79/"]);
		const now = Date.parse("2026-11-21T10:00:00Z");
		const old = addRedirected(null, "/gone/", "/", now - REDIRECTED_KEEP - 1);
		expect(Object.keys(addRedirected(old, "/old/", "/about-us/", now))).toEqual(["/old/"]);
		expect(withoutRedirected({ at: "t", probes: 0, top: [{ path: "/old/", hits: 3, lastSeen: "t" }, { path: "/x", hits: 1, lastSeen: "t" }] }, ["/old"]).top.map((r) => r.path)).toEqual(["/x"]);
	});
});

describe("Missing pages tab: Create redirect", () => {
	const OPTIONS = { productionUrl: ORIGIN, siteName: "Acme", live: true, alertsTo: [], reportTo: [], brand: { footer: "x" } };
	const plugin = createPlugin(OPTIONS) as unknown as { routes: Record<string, { handler: (c: unknown) => Promise<unknown> }> };
	let kv: ReturnType<typeof memoryKv>;
	let redirects: ReturnType<typeof fakeRedirects>;
	let log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
	const purge = vi.fn(async (_o: { tags?: string[] }) => ({ success: true, errors: [] }));
	type Res = { blocks: Record<string, any>[]; toast?: { message: string; type: string } };
	const call = (input: unknown, extra: Record<string, unknown> = {}) => plugin.routes.admin?.handler({ input, kv, redirects, cron: { schedule: async () => {}, list: async () => [] }, request: new Request(`${ORIGIN}/_emdash/api/plugins/site-health/admin`), user: { role: 50 }, log, ...extra }) as Promise<Res>;
	const missing = (r: Res) => (r.blocks.find((b) => b.type === "tab")?.panels as { label: string; blocks: Record<string, any>[] }[]).find((p) => p.label.startsWith("Missing pages"))?.blocks ?? [];
	const table = (r: Res) => missing(r).find((b) => b.block_id === "missing");

	beforeEach(async () => {
		kv = memoryKv();
		redirects = fakeRedirects([{ source: "/older/", destination: "/about-us/" }]);
		log = { info: vi.fn(), warn: vi.fn() };
		purge.mockClear();
		cfCache.purge = purge;
		for (const k of Object.keys(env)) delete env[k];
		await kv.set(KEYS.state, { ...emptyState(), sitemap: { at: "2026-11-21T09:00:00Z", paths: SITE } });
		await kv.set(KEYS.notFound, { at: "2026-11-21T09:00:00Z", probes: 0, top: [{ path: "/old/hello-world/", hits: 7, lastSeen: "2026-11-20T10:00:00Z", suggest: "/blog/hello-world/" }, { path: "/typo/", hits: 2, lastSeen: "2026-11-19T10:00:00Z" }] });
	});
	afterEach(() => {
		delete cfCache.purge;
	});

	it("each row offers it: to the suggestion in one click, or to another page", async () => {
		const r = await call({});
		const t = table(r);
		expect(t?.columns.at(-1)).toMatchObject({ key: "action", format: "element" });
		expect(t?.rows[0].action).toMatchObject({ type: "menu", action_id: "redirect-menu", items: [{ label: "To /blog/hello-world/", value: "create:/old/hello-world/" }, { label: "To another page…", value: "edit:/old/hello-world/" }] });
		expect(t?.rows[1].action).toMatchObject({ type: "button", action_id: "redirect-edit", value: "/typo/" });
	});

	it("one click: a 301 in EmDash's redirects (group site-health), the row leaves the list, pages purged, a toast; logs carry no address", async () => {
		const r = await call({ type: "block_action", action_id: "redirect-menu", value: "create:/old/hello-world/" });
		expect(r.toast).toMatchObject({ type: "success", message: expect.stringContaining("/old/hello-world/ → /blog/hello-world/ (301)") });
		expect(redirects.created).toEqual([{ source: "/old/hello-world/", destination: "/blog/hello-world/", type: 301, groupName: "site-health" }]);
		expect(table(r)?.rows.map((x: Record<string, unknown>) => x.path)).toEqual(["/typo/"]);
		expect(purge).toHaveBeenCalledTimes(1);
		expect(Object.keys((await kv.get<Record<string, unknown>>(KEYS.redirected)) ?? {})).toEqual(["/old/hello-world/"]);
		expect(JSON.stringify([log.info.mock.calls, log.warn.mock.calls])).not.toMatch(/hello-world|\/typo/);
	});

	it("another page: the form (select of the site's pages + a text box), then the redirect", async () => {
		const open = await call({ type: "block_action", action_id: "redirect-edit", value: "/typo/" });
		const form = missing(open).find((b) => b.block_id === "redirect");
		expect(form?.submit.action_id).toBe("redirect-save");
		expect(form?.fields.find((f: Record<string, unknown>) => f.action_id === "source")?.initial_value).toBe("/typo/");
		expect(form?.fields.find((f: Record<string, unknown>) => f.action_id === "target")?.options.map((o: { value: string }) => o.value)).toEqual(SITE);
		const done = await call({ type: "form_submit", action_id: "redirect-save", values: { source: "/typo/", target: "/", targetOther: "https://acme.example/services/massage/" } });
		expect(done.toast?.type).toBe("success");
		expect(redirects.created).toEqual([{ source: "/typo/", destination: "/services/massage/", type: 301, groupName: "site-health" }]);
	});

	it("refuses another website, a page that does not exist, a duplicate and a chain — the form stays open with the reason", async () => {
		for (const [values, reason] of [
			[{ source: "/typo/", target: "/", targetOther: "https://other.example/" }, /only send visitors to pages of this site/],
			[{ source: "/typo/", target: "/nowhere/" }, /not a page of this site/],
			[{ source: "/older", target: "/" }, /exists already/],
			[{ source: "/typo/", target: "/", targetOther: "/older/" }, /not a page of this site/],
		] as const) {
			const r = await call({ type: "form_submit", action_id: "redirect-save", values });
			expect(r.toast?.type).toBe("error");
			const banner = missing(r).find((b) => b.type === "banner");
			expect(banner?.description).toMatch(reason);
			expect(missing(r).some((b) => b.block_id === "redirect")).toBe(true);
		}
		redirects.items.push({ id: "x", source: "/about-us/", destination: "/", enabled: true, isPattern: false });
		const chain = await call({ type: "form_submit", action_id: "redirect-save", values: { source: "/typo/", target: "/about-us/" } });
		expect(missing(chain).find((b) => b.type === "banner")?.description).toMatch(/itself redirected/);
		expect(redirects.created).toEqual([]);
		expect(purge).not.toHaveBeenCalled();
	});

	it("EmDash's own refusal is shown, its code logged without the address", async () => {
		redirects.create = async () => {
			throw Object.assign(new Error("Redirect would create a loop"), { code: "VALIDATION_ERROR" });
		};
		const r = await call({ type: "block_action", action_id: "redirect-menu", value: "create:/old/hello-world/" });
		expect(missing(r).find((b) => b.type === "banner")?.description).toContain("EmDash did not store it: Redirect would create a loop.");
		expect(log.warn).toHaveBeenCalledWith("health redirect not created", { code: "VALIDATION_ERROR" });
	});

	it("without the redirects capability: no buttons, the old guidance", async () => {
		const r = await call({}, { redirects: undefined });
		expect(table(r)?.columns.some((c: Record<string, unknown>) => c.key === "action")).toBe(false);
		expect(JSON.stringify(missing(r))).toContain("Open Redirects");
		const tried = await call({ type: "block_action", action_id: "redirect-menu", value: "create:/old/hello-world/" }, { redirects: undefined });
		expect(tried.toast?.type).toBe("error");
	});

	it("the hourly read leaves out addresses that redirect now (made here, or any redirect in Redirects)", async () => {
		await kv.set(KEYS.redirected, addRedirected(null, "/old/hello-world/", "/blog/hello-world/", Date.now()));
		const rows = [
			{ path: "/old/hello-world/", hits: 7, last_seen: "2026-11-20T10:00:00Z", referrer: null },
			{ path: "/older", hits: 5, last_seen: "2026-11-20T10:00:00Z", referrer: null },
			{ path: "/typo/", hits: 2, last_seen: "2026-11-19T10:00:00Z", referrer: null },
		];
		const db = { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) };
		const self = async () => new Response("<html></html>", { headers: { "content-type": "text/html" } });
		await runChecks({ kv, options: OPTIONS, env: { DB: db as never }, self, fetch: async () => new Response("", { status: 404 }), redirects, now: Date.parse("2026-11-21T10:00:00Z") });
		expect((await kv.get<{ top: { path: string }[] }>(KEYS.notFound))?.top.map((r) => r.path)).toEqual(["/typo/"]);
	});

	it("views: the tab label counts only what is left", () => {
		const d = { state: { ...emptyState(), sitemap: { at: "t", paths: SITE } }, today: null, history: [], incidents: [], links: null, cwv: null, reports: [], settings: {}, defaults: { alertsTo: [], reportTo: [] }, email: { ready: true, provider: "brevo" }, live: true, staging: false, secrets: { crux: false, zone: false, analytics: false }, selfBinding: true, productionUrl: ORIGIN, redirects: true, notFound: { at: "t", probes: 0, top: [{ path: "/typo/", hits: 2, lastSeen: "t" }] }, redirectForm: { source: "/typo/" } } as unknown as PageData;
		const blocks = page(d, TABS.missing);
		const panels = blocks[1]?.panels as { label: string; blocks: Record<string, any>[] }[];
		expect(panels[TABS.missing]?.label).toBe("Missing pages (1)");
		expect(panels[TABS.missing]?.blocks[0]).toMatchObject({ type: "header", text: "Redirect /typo/" });
	});
});
