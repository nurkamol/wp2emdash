/**
 * Site health → Missing pages, the after-launch 404 watcher: filtering (probes, junk), grouping of trailing-slash
 * forms, redirect suggestions (old WordPress address list, spelling, dated post addresses, slug, words), the old-URL
 * list scaffold ships into the plugin options, Dismiss / Show again, the live shadow check before Create redirect and
 * What to improve. Synthetic data only; EmDash's ctx is mocked as in health-redirects.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { groupNotFound, isJunk, notFoundCheck, notFoundId, oldUrlIndex, readNotFound, suggestTarget, summarizeNotFound } from "../packages/health/src/checks/notfound.js";
import { improvements } from "../packages/health/src/improve.js";
import { createPlugin } from "../packages/health/src/plugin/index.js";
import { liveAnswer, type RedirectLike, type RedirectsAccess } from "../packages/health/src/redirects.js";
import { dismiss, readDismissed } from "../packages/health/src/review.js";
import { currentImprovements, runChecks } from "../packages/health/src/run.js";
import { emptyState, KEYS } from "../packages/health/src/store.js";
import { kitConfigSchema } from "../src/config/schema.js";
import { healthOptions, OLD_URLS_MAX, oldUrlMap } from "../src/scaffold/health.js";
import { memoryKv } from "./health-fixtures.js";
import { cache as cfCache, env } from "./stubs/cloudflare-workers.js";

const ORIGIN = "https://acme.example";
const SITE = ["/", "/about-us/", "/services/massage/", "/services/yoga-classes/", "/hello-world/", "/contact/"];
const OLD = { "/our-team/": "/about-us/", "/massage-therapy/": "/services/massage/", "/classes/yoga/": "/yoga-old-name/", "/summer-camp/": "" };

describe("filtering: bot probes and junk are counted, never listed", () => {
	it("WordPress internals (also in a sub-directory), scripts, dot-files, backups and device probes", () => {
		for (const p of ["/wp-login.php", "/blog/wp-login.php", "/wordpress/wp-admin/setup-config.php", "/wp-content/plugins/x/readme.txt", "/xmlrpc.php", "/.env", "/.git/HEAD", "/backup.sql", "/site.tar.gz", "/wp-config.php.bak", "/boaform/admin/formLogin", "/HNAP1/", "/actuator/health", "/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php", "/cgi-bin/luci", "/server-status"]) expect(isJunk(p), p).toBe(true);
		// Injection attempts and nonsense.
		for (const p of ["/<script>alert(1)</script>", "/x%3Cscript%3E", "/a\u0000b", `/${"a".repeat(301)}`, "relative", "/%E0%A4%A"]) expect(isJunk(p), p).toBe(true);
	});
	it("real addresses stay, even with WordPress-looking words", () => {
		for (const p of ["/old-page/", "/services/massage-therapy/", "/.well-known/security.txt", "/2023/05/hello-world/", "/wp-guide-for-beginners/", "/About-Us", "/admin-assistant-jobs/", "/caf%C3%A9-menu/"]) expect(isJunk(p), p).toBe(false);
	});
});

describe("grouping: one row per address as EmDash's redirects match it", () => {
	it("trailing-slash forms add up; the most asked spelling, the latest time, only the referrer's host", () => {
		const g = groupNotFound([
			{ path: "/old-page", hits: 2, lastSeen: "2026-11-20T10:00:00Z", referrer: "https://news.example/article?id=7&utm=x" },
			{ path: "/old-page/", hits: 5, lastSeen: "2026-11-19T10:00:00Z", referrer: "https://www.google.com/" },
			{ path: "/Old-Page/", hits: 1, lastSeen: "2026-11-18T10:00:00Z", referrer: null },
			{ path: "/x/", hits: 4, lastSeen: "2026-11-21T10:00:00Z", referrer: "not a url" },
		]);
		expect(g).toEqual([
			{ path: "/old-page/", hits: 7, lastSeen: "2026-11-20T10:00:00Z", from: "news.example" },
			{ path: "/x/", hits: 4, lastSeen: "2026-11-21T10:00:00Z" },
			// Capitals differ: a separate address for EmDash (its match is case-sensitive), suggested as a spelling.
			{ path: "/Old-Page/", hits: 1, lastSeen: "2026-11-18T10:00:00Z" },
		]);
		expect(JSON.stringify(g)).not.toMatch(/utm|id=7|google/);
	});
	it("reads path, count, time and referrer only: never EmDash's user agent or IP columns", async () => {
		const seen: string[] = [];
		const db = { prepare: (q: string) => (seen.push(q), { bind: () => ({ all: async () => ({ results: [] }) }) }) };
		await readNotFound(db as never, "2026-11-14T00:00:00.000Z");
		expect(seen[0]).not.toMatch(/user_agent|\bip\b|\*/);
	});
});

describe("suggestions", () => {
	const old = oldUrlIndex(OLD);
	it("an old WordPress address that moved at the migration: its page, whatever the spelling", () => {
		expect(suggestTarget("/our-team/", SITE, old)).toEqual({ to: "/about-us/", why: "wordpress" });
		expect(suggestTarget("/Our-Team", SITE, old)).toEqual({ to: "/about-us/", why: "wordpress" });
		expect(suggestTarget("/massage-therapy.html", SITE, old)).toEqual({ to: "/services/massage/", why: "wordpress" });
		// Renamed again after launch: the page with the same last part as the launch address.
		expect(suggestTarget("/classes/yoga/", ["/", "/yoga-old-name-2/", "/studio/yoga-old-name/"], old)).toEqual({ to: "/studio/yoga-old-name/", why: "wordpress" });
	});
	it("an old address that was not carried over is marked; a close page is still offered", () => {
		expect(suggestTarget("/summer-camp/", SITE, old)).toEqual({ removed: true });
		expect(suggestTarget("/summer-camp/", [...SITE, "/camps/summer-camp-2027/"], old)).toEqual({ removed: true, to: "/camps/summer-camp-2027/", why: "words" });
	});
	it("other spelling, dated post addresses, the same last part, similar words; never the address itself", () => {
		expect(suggestTarget("/Contact", SITE)).toEqual({ to: "/contact/", why: "spelling" });
		expect(suggestTarget("/contact.php", SITE)).toEqual({ to: "/contact/", why: "spelling" });
		expect(suggestTarget("/hello-world/page/2/", SITE)).toEqual({ to: "/hello-world/", why: "spelling" });
		expect(suggestTarget("/2023/05/hello-world/", SITE)).toEqual({ to: "/hello-world/", why: "date" });
		expect(suggestTarget("/blog/2023/05/12/hello-world/amp/", SITE)).toEqual({ to: "/hello-world/", why: "date" });
		expect(suggestTarget("/old/massage/", SITE)).toEqual({ to: "/services/massage/", why: "slug" });
		expect(suggestTarget("/yoga-classes-online/", SITE)).toEqual({ to: "/services/yoga-classes/", why: "words" });
		expect(suggestTarget("/zzz/", SITE)).toEqual({});
		expect(suggestTarget("/contact/", SITE)).toEqual({});
		expect(suggestTarget("/", SITE)).toEqual({});
	});
	it("summary: probes counted, dismissed left out and counted, reasons kept, at most 20 rows", () => {
		const rows = [
			{ path: "/our-team/", hits: 9, lastSeen: "2026-11-20T10:00:00Z", referrer: "https://www.google.com/search?q=acme" },
			{ path: "/wp-login.php", hits: 80, lastSeen: "2026-11-20T10:00:00Z" },
			{ path: "/typo-link/", hits: 4, lastSeen: "2026-11-19T10:00:00Z" },
			...Array.from({ length: 30 }, (_, i) => ({ path: `/x${i}/`, hits: 1, lastSeen: "2026-11-18T10:00:00Z" })),
		];
		const s = summarizeNotFound(rows, SITE, "t", { oldUrls: OLD, skip: (p) => p === "/typo-link/" });
		expect(s.top[0]).toEqual({ path: "/our-team/", hits: 9, lastSeen: "2026-11-20T10:00:00Z", from: "www.google.com", suggest: "/about-us/", why: "wordpress" });
		expect(s.top).toHaveLength(20);
		expect(s.top.some((r) => r.path === "/typo-link/")).toBe(false);
		expect(s).toMatchObject({ probes: 1, dismissed: 1 });
		expect(JSON.stringify(s)).not.toContain("q=acme");
		expect(notFoundCheck(s, "t")).toMatchObject({ status: "warn", detail: ["/our-team/ (9× → /about-us/)", "1 bot probe left out (wp-login.php, .env and similar).", "1 dismissed address left out."] });
	});
	it("ids are stable per address (both trailing-slash forms) and fit the Dismiss value", () => {
		expect(notFoundId("/old-page")).toBe(notFoundId("/old-page/"));
		expect(notFoundId("/old-page/")).not.toBe(notFoundId("/other/"));
		expect(notFoundId("/a/")).toMatch(/^[0-9a-z]{4,16}$/);
	});
});

describe("scaffold: the old WordPress address list shipped in the plugin options", () => {
	it("moved and removed addresses only, attachments and query forms left out, moved first, capped", () => {
		const map = oldUrlMap({
			urls: [
				{ path: "/about/", status: 200, wp: { id: 2, type: "page" } },
				{ path: "/our-team/", status: 200, wp: { id: 3, type: "page" } },
				{ path: "/old-redirect/", status: 301, wp: { id: 4, type: "page" } },
				{ path: "/photo/", status: 200, wp: { id: 9, type: "attachment" } },
				{ path: "/", status: 200, wp: { id: 1, type: "page" } },
			],
			items: [
				{ id: 4, type: "page", link: "https://acme.example/kept-but-moved/" },
				{ id: 5, type: "post", link: "https://acme.example/2023/05/hello-world/" },
				{ id: 6, type: "event", link: "https://acme.example/events/summer-camp/" },
				{ id: 7, type: "attachment", link: "https://acme.example/img/" },
				{ id: 8, type: "page", link: "https://acme.example/?page_id=8" },
			],
			wpIds: { "1": "/", "2": "/about", "3": "/about-us/", "4": "/moved/", "5": "/hello-world/" },
		});
		expect(map).toEqual({ "/2023/05/hello-world/": "/hello-world/", "/kept-but-moved/": "/moved/", "/our-team/": "/about-us/", "/events/summer-camp/": "" });
		expect(Object.keys(oldUrlMap({ items: Array.from({ length: OLD_URLS_MAX + 5 }, (_, i) => ({ id: i + 1, type: "page", link: `https://acme.example/p${i}/` })), wpIds: {} }))).toHaveLength(OLD_URLS_MAX);
	});
	it("healthOptions carries the list only when there is one", () => {
		const config = kitConfigSchema.parse({ slug: "acme", name: "Acme", source: { url: ORIGIN }, target: { productionUrl: ORIGIN }, email: { to: ["owner@acme.example"], stagingTo: ["team@agency.example"] } });
		expect(healthOptions({ config, productionUrl: ORIGIN, live: true, oldUrls: { "/a/": "/b/" } })?.oldUrls).toEqual({ "/a/": "/b/" });
		expect(healthOptions({ config, productionUrl: ORIGIN, live: true, oldUrls: {} })?.oldUrls).toBeUndefined();
	});
});

/** EmDash's redirects as Site health uses them (see health-redirects.test.ts). */
function fakeRedirects(initial: RedirectLike[] = []) {
	const items: RedirectLike[] = initial.map((r, i) => ({ id: `r${i}`, enabled: true, isPattern: false, ...r }));
	const access: RedirectsAccess & { created: unknown[] } = {
		created: [],
		async list(o = {}) {
			return { items: items.filter((r) => !o.search || r.source.includes(o.search) || r.destination.includes(o.search)), hasMore: false };
		},
		async create(input) {
			access.created.push(input);
			const r = { id: `r${items.length}`, source: input.source, destination: input.destination ?? "", enabled: true, isPattern: false };
			items.push(r);
			return { redirect: r };
		},
	};
	return access;
}

describe("Missing pages tab: Dismiss, Show again, the shadow check, What to improve", () => {
	const OPTIONS = { productionUrl: ORIGIN, siteName: "Acme", live: true, alertsTo: [], reportTo: [], brand: { footer: "x" }, oldUrls: OLD };
	const plugin = createPlugin(OPTIONS) as unknown as { routes: Record<string, { handler: (c: unknown) => Promise<unknown> }> };
	let kv: ReturnType<typeof memoryKv>;
	let redirects: ReturnType<typeof fakeRedirects>;
	let log: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
	type Res = { blocks: Record<string, any>[]; toast?: { message: string; type: string } };
	const call = (input: unknown) => plugin.routes.admin?.handler({ input, kv, redirects, cron: { schedule: async () => {}, list: async () => [] }, request: new Request(`${ORIGIN}/_emdash/api/plugins/site-health/admin`), user: { role: 50 }, log }) as Promise<Res>;
	const panel = (r: Res) => (r.blocks.find((b) => b.type === "tab")?.panels as { label: string; blocks: Record<string, any>[] }[]).find((p) => p.label.startsWith("Missing pages"));
	const table = (r: Res, id = "missing") => panel(r)?.blocks.find((b) => b.block_id === id);
	const TOP = [
		{ path: "/our-team/", hits: 9, lastSeen: "2026-11-20T10:00:00Z", from: "www.google.com", suggest: "/about-us/", why: "wordpress" },
		{ path: "/typo-link/", hits: 4, lastSeen: "2026-11-19T10:00:00Z" },
		{ path: "/summer-camp/", hits: 3, lastSeen: "2026-11-19T10:00:00Z", removed: true },
	];

	beforeEach(async () => {
		kv = memoryKv();
		redirects = fakeRedirects();
		log = { info: vi.fn(), warn: vi.fn() };
		cfCache.purge = async () => ({ success: true, errors: [] });
		for (const k of Object.keys(env)) delete env[k];
		await kv.set(KEYS.state, { ...emptyState(), sitemap: { at: "2026-11-21T09:00:00Z", paths: SITE } });
		await kv.set(KEYS.notFound, { at: "2026-11-21T09:00:00Z", probes: 2, top: TOP });
	});
	afterEach(() => {
		delete cfCache.purge;
		for (const k of Object.keys(env)) delete env[k];
	});

	it("each row: hits, the reason of the suggestion, Create redirect and a Dismiss menu", async () => {
		const r = await call({});
		const t = table(r);
		expect(t?.columns.map((c: { key: string }) => c.key)).toEqual(["path", "hits", "last", "from", "suggest", "why", "action", "dismiss"]);
		expect(t?.rows.map((x: Record<string, unknown>) => [x.path, x.hits, x.why, x.from])).toEqual([["/our-team/", 9, "Old WordPress address", "www.google.com"], ["/typo-link/", 4, "—", "—"], ["/summer-camp/", 3, "Removed at the migration", "—"]]);
		expect(t?.rows[1].dismiss).toMatchObject({ type: "menu", action_id: "missing-dismiss", items: [{ value: `${notFoundId("/typo-link/")}:90` }, { value: `${notFoundId("/typo-link/")}:365` }, { value: `${notFoundId("/typo-link/")}:1825` }] });
	});

	it("Dismiss: the row leaves the list, the tab count and What to improve; Show again restores it; logs carry no address", async () => {
		const before = await currentImprovements({ kv, options: OPTIONS, env: {} });
		expect(before.find((x) => x.id === "notfound")).toMatchObject({ count: 3, text: expect.stringContaining("1 with a suggested page") });
		const r = await call({ type: "block_action", action_id: "missing-dismiss", value: `${notFoundId("/typo-link/")}:365` });
		expect(r.toast).toMatchObject({ type: "success", message: expect.stringMatching(/^Dismissed until \d{4}-\d{2}-\d{2}/) });
		expect(table(r)?.rows.map((x: Record<string, unknown>) => x.path)).toEqual(["/our-team/", "/summer-camp/"]);
		expect(panel(r)?.label).toBe("Missing pages (2)");
		const listed = table(r, "missing-dismissed");
		expect(listed?.rows).toEqual([{ what: "/typo-link/", until: expect.stringMatching(/^\d{4}-/), restore: { type: "button", action_id: "missing-restore", label: "Show again", value: notFoundId("/typo-link/"), style: "secondary" } }]);
		expect((await currentImprovements({ kv, options: OPTIONS, env: {} })).find((x) => x.id === "notfound")?.count).toBe(2);
		expect(JSON.stringify([log.info.mock.calls, log.warn.mock.calls])).not.toMatch(/typo-link/);
		expect(log.info).toHaveBeenCalledWith("health missing address dismissed", { days: 365 });

		const back = await call({ type: "block_action", action_id: "missing-restore", value: notFoundId("/typo-link/") });
		expect(back.toast?.type).toBe("success");
		expect(readDismissed(await kv.get(KEYS.notFoundDismissed)).items).toEqual({});
		expect(table(back, "missing-dismissed")).toBeUndefined();
	});

	it("Dismiss refuses what is not listed or a period it does not offer", async () => {
		for (const value of [`${notFoundId("/never-listed/")}:90`, `${notFoundId("/typo-link/")}:7`, "nonsense"]) {
			const r = await call({ type: "block_action", action_id: "missing-dismiss", value });
			expect(r.toast?.type).toBe("info");
		}
		expect(await kv.get(KEYS.notFoundDismissed)).toBeNull();
	});

	it("the hourly read leaves dismissed addresses out and suggests old WordPress addresses first", async () => {
		await kv.set(KEYS.notFoundDismissed, dismiss(readDismissed(null), notFoundId("/typo-link"), 90, "/typo-link/", Date.now()));
		const rows = [
			{ path: "/our-team", hits: 6, last_seen: "2026-11-20T10:00:00Z", referrer: null },
			{ path: "/our-team/", hits: 3, last_seen: "2026-11-21T08:00:00Z", referrer: "https://www.facebook.com/groups/123" },
			{ path: "/typo-link/", hits: 4, last_seen: "2026-11-19T10:00:00Z", referrer: null },
			{ path: "/xmlrpc.php", hits: 40, last_seen: "2026-11-21T09:00:00Z", referrer: null },
		];
		const db = { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) };
		// The sitemap read fails this hour: the stored page list (SITE) stays the source of suggestions.
		const self = async (url: string) => (url.endsWith("/sitemap.xml") ? new Response("", { status: 404 }) : new Response("<html></html>", { headers: { "content-type": "text/html" } }));
		await runChecks({ kv, options: OPTIONS, env: { DB: db as never }, self, fetch: async () => new Response("", { status: 404 }), redirects, now: Date.parse("2026-11-21T10:00:00Z") });
		const s = await kv.get<{ top: unknown[]; probes: number; dismissed?: number }>(KEYS.notFound);
		expect(s).toMatchObject({ top: [{ path: "/our-team", hits: 9, from: "www.facebook.com", suggest: "/about-us/", why: "wordpress" }], probes: 1, dismissed: 1 });
		expect(JSON.stringify(s)).not.toContain("groups/123");
	});

	it("Create redirect asks the site first: refuses an address that answers as a page or redirects already", async () => {
		const answers: Record<string, Response> = { "/our-team/": new Response("<html></html>", { status: 200 }), "/typo-link/": new Response(null, { status: 301, headers: { location: `${ORIGIN}/contact/` } }) };
		const asked: string[] = [];
		env.SELF = { fetch: async (r: Request) => (asked.push(new URL(r.url).pathname), answers[new URL(r.url).pathname] ?? new Response("", { status: 404 })) };
		const page = await call({ type: "block_action", action_id: "redirect-menu", value: "create:/our-team/" });
		expect(page.toast?.type).toBe("error");
		expect(panel(page)?.blocks.find((b) => b.type === "banner")?.description).toMatch(/answers as a page of this site now/);
		const again = await call({ type: "form_submit", action_id: "redirect-save", values: { source: "/typo-link/", target: "/contact/" } });
		expect(panel(again)?.blocks.find((b) => b.type === "banner")?.description).toMatch(/already redirects to \/contact\//);
		expect(redirects.created).toEqual([]);
		const ok = await call({ type: "form_submit", action_id: "redirect-save", values: { source: "/summer-camp/", target: "/services/yoga-classes/" } });
		expect(ok.toast?.type).toBe("success");
		expect(redirects.created).toEqual([{ source: "/summer-camp/", destination: "/services/yoga-classes/", type: 301, groupName: "site-health" }]);
		expect(asked).toEqual(["/our-team/", "/typo-link/", "/summer-camp/"]);
	});

	it("liveAnswer: no binding or a failed request never blocks (EmDash still checks loops and duplicates)", async () => {
		expect(await liveAnswer(undefined, ORIGIN, "/x/")).toBeUndefined();
		expect(await liveAnswer(async () => Promise.reject(new Error("down")), ORIGIN, "/x/")).toBeUndefined();
		expect(await liveAnswer(async () => new Response("", { status: 410 }), ORIGIN, "/x/")).toBeUndefined();
	});

	it("What to improve: the item counts frequent addresses only and names them", () => {
		const items = improvements({ notFound: { at: "t", probes: 0, top: [...TOP, { path: "/rare/", hits: 1, lastSeen: "t" }] } as never });
		expect(items[0]).toMatchObject({ id: "notfound", count: 3, names: { items: ["/our-team/", "/typo-link/", "/summer-camp/"] }, link: { tab: "missing" } });
	});
});
