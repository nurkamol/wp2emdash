/**
 * Site health: the weekly visual check (checks/visual.ts, visual.ts, the Visual check tab). Synthetic pages in the
 * starter's markup (Section.astro: `<section class="section section--<type> …">`); no network — the site, its
 * pictures, stylesheets and the email provider are mocks (docs/spikes/health-findings.md "Visual check").
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { visualAlertEvents } from "../packages/health/src/alerts.js";
import { acceptBaseline, comparePage, countWords, finishRun, fontFaces, googleFamilies, imageTarget, MAX_VISUAL_RUNS, needsLook, type PageFp, parsePage, pickVisualPages, readVisual, sectionTypes, startVisual, stepVisual, VISUAL_BUDGET, visualDue, type VisualJob, type VisualStore } from "../packages/health/src/checks/visual.js";
import { improvements } from "../packages/health/src/improve.js";
import type { HealthOptions } from "../packages/health/src/index.js";
import { createPlugin } from "../packages/health/src/plugin/index.js";
import { type PageData, TABS, visualTab } from "../packages/health/src/plugin/views.js";
import type { RunDeps } from "../packages/health/src/run.js";
import { emptyState, KEYS } from "../packages/health/src/store.js";
import { editedSince, runVisual } from "../packages/health/src/visual.js";
import { kitConfigSchema } from "../src/config/schema.js";
import { healthOptions } from "../src/scaffold/health.js";
import { memoryKv, SECURE_HEADERS } from "./health-fixtures.js";
import { env } from "./stubs/cloudflare-workers.js";

type B = Record<string, any>;
const ORIGIN = "https://acme.example";
const T0 = Date.UTC(2026, 10, 23, 11, 0, 0);
const WEEK = 7 * 86_400_000;
const OPTIONS: HealthOptions = { productionUrl: ORIGIN, siteName: "Acme", live: true, alertsTo: ["team@agency.example"], reportTo: ["owner@acme.example"], brand: { footer: "Prepared by Example Agency" } };

const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");

/** A page in the starter's markup. */
function page(o: { title?: string; h1?: string; sections?: string[]; images?: string[]; words?: number; footer?: boolean; css?: string[]; fontLink?: boolean } = {}): string {
	const sections = (o.sections ?? ["hero", "rich_text", "feature_grid", "cta_banner"]).map((t, i) => `<section class="section section--${t} section--${t}--wide tone-light space-normal${i === 0 ? " section--full section--media-bg" : ""}" data-reveal><div class="section__inner container">${i === 0 ? `<h1>${o.h1 ?? "Pilates &amp; more"}</h1>` : ""}<p>${i === 1 ? words(o.words ?? 200) : ""}</p></div></section>`);
	const imgs = (o.images ?? ["/_emdash/api/media/file/hero.webp", "/_image?href=%2F_emdash%2Fapi%2Fmedia%2Ffile%2Fteam.jpg&w=640&f=webp"]).map((src) => `<img src="${src}" alt="">`);
	const css = (o.css ?? ["/_astro/site.abc123.css"]).map((h) => `<link rel="stylesheet" href="${h}">`);
	return `<!doctype html><html><head><title>${o.title ?? "Acme Studio | Home"}</title>${css.join("")}${o.fontLink ? `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&amp;family=Inter&amp;display=swap">` : ""}<style>@font-face{font-family:"Brand Sans";src:url(/fonts/a.woff2)}</style></head><body><header><nav>Home About Contact</nav></header><main>${sections.join("")}${imgs.join("")}<img src="data:image/gif;base64,R0lGOD" alt=""></main>${o.footer === false ? "" : "<footer>© Acme</footer>"}<script>var x = "not words";</script></body></html>`;
}

const fp = (o: Partial<PageFp> = {}): PageFp => ({ path: "/", status: 200, title: "Home", h1: "Welcome", sections: ["hero", "rich_text", "cta_banner"], images: 4, broken: [], checked: 4, css: 1, cssBroken: [], words: 300, footer: true, ...o });

describe("fingerprint from HTML", () => {
	it("reads status, title, h1, section types in order, pictures, stylesheets, fonts, words and the footer", () => {
		const r = parsePage("/", 200, page({ fontLink: true }), ORIGIN);
		expect(r.fp).toMatchObject({ path: "/", status: 200, title: "Acme Studio | Home", h1: "Pilates & more", sections: ["hero", "rich_text", "feature_grid", "cta_banner"], images: 3, checked: 2, css: 1, footer: true });
		// Words of <main> only (nav, footer and scripts left out): the heading ("Pilates", "more") + 200.
		expect(r.fp.words).toBe(202);
		// /_image transforms are checked as their original file; data: pictures are counted, not fetched; Google Fonts CSS is not fetched.
		expect(r.images).toEqual([`${ORIGIN}/_emdash/api/media/file/hero.webp`, `${ORIGIN}/_emdash/api/media/file/team.jpg`]);
		expect(r.css).toEqual([`${ORIGIN}/_astro/site.abc123.css`]);
		expect(r.fonts.sort()).toEqual(["brand sans", "inter", "playfair display"]);
	});
	it("an error page has no fingerprint beyond its status", () => {
		expect(parsePage("/x/", 500, "<html>oops</html>", ORIGIN)).toEqual({ fp: { path: "/x/", status: 500, sections: [], images: 0, broken: [], checked: 0, css: 0, cssBroken: [], words: 0, footer: false }, images: [], css: [], fonts: [] });
	});
	it("helpers: section modifiers are not types, @font-face and Google Fonts families, image targets, words in any script", () => {
		expect(sectionTypes(`<section class="section section--full section--media_text section--media_text--left"><section class="comments"><section class="section space-normal blog">`)).toEqual(["media_text"]);
		expect(fontFaces(`@font-face { font-family: 'Lora'; src: url(a) } @font-face{font-family:Inter Var;src:url(b)} body{font-family:Lora}`)).toEqual(["lora", "inter var"]);
		expect(googleFamilies(`<link href="https://fonts.googleapis.com/css?family=Open+Sans:400|Roboto">`)).toEqual(["open sans", "roboto"]);
		expect(imageTarget("https://cdn.other.example/a.png?x=1", ORIGIN)).toBe("https://cdn.other.example/a.png?x=1");
		expect(imageTarget("data:image/png;base64,AA", ORIGIN)).toBeUndefined();
		expect(imageTarget("/_image?w=10", ORIGIN)).toBeUndefined();
		expect(countWords("Привет мир — hello 42 l'été")).toBe(5);
	});
});

describe("comparison and tolerances", () => {
	it("nothing changed: no differences; no baseline: only absolute problems", () => {
		expect(comparePage(fp(), fp())).toEqual([]);
		expect(comparePage(undefined, fp({ broken: ["/a.jpg"] })).map((d) => d.kind)).toEqual(["broken"]);
	});
	it("text within ±30% is fine, beyond is a change; small pages are left alone", () => {
		expect(comparePage(fp({ words: 300 }), fp({ words: 210 }))).toEqual([]);
		expect(comparePage(fp({ words: 300 }), fp({ words: 390 }))).toEqual([]);
		expect(comparePage(fp({ words: 300 }), fp({ words: 200 }))[0]).toMatchObject({ kind: "words", severity: "change", text: "Much less text: 200 words instead of 300 (-33%)." });
		expect(comparePage(fp({ words: 300 }), fp({ words: 400 }))[0]?.text).toContain("+33%");
		expect(comparePage(fp({ words: 40 }), fp({ words: 5 }))).toEqual([]);
	});
	it("an empty page, an error, a missing footer, broken pictures and stylesheets are problems", () => {
		expect(comparePage(fp(), fp({ words: 3, images: 0, checked: 0 })).find((d) => d.kind === "empty")).toMatchObject({ severity: "problem" });
		expect(comparePage(fp(), fp({ status: 500 }))).toEqual([{ kind: "status", severity: "problem", text: "The page shows an error (HTTP 500)." }]);
		expect(comparePage(fp(), fp({ status: 0 }))[0]?.text).toBe("The page did not answer within 8 seconds.");
		expect(comparePage(fp(), fp({ status: 404 }))[0]?.text).toContain("no longer exists");
		expect(comparePage(fp(), fp({ footer: false })).map((d) => [d.kind, d.severity])).toEqual([["footer", "problem"]]);
		expect(comparePage(fp(), fp({ broken: ["/media/a.jpg"] }))[0]).toEqual({ kind: "broken", severity: "problem", text: "1 picture does not load: /media/a.jpg." });
		expect(comparePage(fp(), fp({ cssBroken: ["/_astro/a.css"] }))[0]?.text).toContain("layout is probably broken");
	});
	it("a section type gone, two sections fewer, fewer pictures, a new title or heading are changes", () => {
		expect(comparePage(fp(), fp({ sections: ["hero", "rich_text"] }))).toEqual([{ kind: "sections", severity: "change", text: "A section is gone: cta banner." }]);
		expect(comparePage(fp({ sections: ["hero", "rich_text", "rich_text", "rich_text"] }), fp({ sections: ["hero", "rich_text"] }))[0]?.text).toBe("2 fewer sections than before (2 instead of 4).");
		expect(comparePage(fp({ sections: ["hero", "rich_text", "rich_text"] }), fp({ sections: ["hero", "rich_text"] }))).toEqual([]);
		expect(comparePage(fp(), fp({ images: 3 }))[0]?.text).toBe("1 picture fewer than before (3 instead of 4).");
		expect(comparePage(fp(), fp({ images: 6 }))).toEqual([]);
		expect(comparePage(fp(), fp({ title: "Hacked" }))[0]?.text).toBe("The page title changed from “Home” to “Hacked”.");
		expect(comparePage(fp(), fp({ h1: undefined }))[0]?.text).toBe("The main heading changed from “Welcome” to nothing.");
	});
});

describe("pages and schedule", () => {
	it("home first, the baseline's pages kept, then the shallowest sitemap pages, capped", () => {
		const sitemap = ["/", "/blog/2020/old-post/", "/about/", "/classes/", "/classes/reformer/", "/sitemap-media.xml", "/contact/"];
		expect(pickVisualPages(sitemap, [], 4)).toEqual(["/", "/about/", "/classes/", "/contact/"]);
		expect(pickVisualPages(sitemap, ["/classes/reformer/", "/gone/"], 3)).toEqual(["/", "/classes/reformer/", "/about/"]);
		expect(pickVisualPages([], [], 10)).toEqual(["/"]);
		expect(pickVisualPages(Array.from({ length: 60 }, (_, i) => `/p${i}/`), [], 99)).toHaveLength(25);
	});
	it("first run at once, weekly from 10 UTC, and on an admin's request", () => {
		const empty = readVisual(null);
		expect(visualDue(empty, null, T0)).toBe("first");
		const ran: VisualStore = { ...empty, runs: [{ at: new Date(T0).toISOString(), trigger: "first", pages: [], fonts: [], missingFonts: [] }], next: new Date(T0 + WEEK).toISOString() };
		expect(visualDue(ran, null, T0 + 86_400_000)).toBeUndefined();
		expect(visualDue(ran, null, T0 + WEEK)).toBe("weekly");
		expect(visualDue(ran, null, Date.UTC(2026, 10, 30, 9, 30))).toBeUndefined();
		expect(visualDue(ran, { at: new Date(T0).toISOString() }, T0 + 60_000)).toBe("manual");
		expect(visualDue(ran, { at: new Date(T0).toISOString(), done: new Date(T0).toISOString() }, T0 + 60_000)).toBeUndefined();
	});
});

/** The site behind SELF: pages by path, files by path (status + type), counting requests. */
function site(pages: Record<string, string | number>, files: Record<string, [number, string] | string> = {}) {
	const calls: string[] = [];
	const self = vi.fn(async (url: string, init?: RequestInit) => {
		const u = new URL(url);
		calls.push(u.pathname);
		const p = pages[u.pathname];
		if (p !== undefined) return typeof p === "number" ? new Response("err", { status: p }) : new Response(p, { headers: { "content-type": "text/html", ...SECURE_HEADERS } });
		const f = files[u.pathname];
		if (typeof f === "string") return new Response(f, { headers: { "content-type": "text/css" } });
		if (f) return new Response(f[0] === 200 ? "bytes" : "", { status: f[0], headers: { "content-type": f[1] } });
		if (u.pathname.startsWith("/_emdash/api/media/file/")) return new Response("img", { headers: { "content-type": "image/webp" } });
		if (u.pathname.endsWith(".css")) return new Response("body{}", { headers: { "content-type": "text/css" } });
		void init;
		return new Response("nf", { status: 404 });
	});
	return { self, calls };
}

describe("resumable run across ticks", () => {
	it("spends at most 8 requests a tick, checks each asset once, and finishes over several ticks", async () => {
		const pages = { "/": page(), "/about/": page({ title: "About" }), "/classes/": page({ title: "Classes" }) };
		const s = site(pages);
		let job: VisualJob = startVisual(["/", "/about/", "/classes/"], "first", T0);
		const io = { self: s.self as never, external: vi.fn() as never, origin: ORIGIN };
		const steps: number[] = [];
		for (let i = 0; i < 5 && job.pi < job.paths.length; i++) {
			const r = await stepVisual(job, io);
			steps.push(r.requests);
			job = r.job;
			expect(r.requests).toBeLessThanOrEqual(VISUAL_BUDGET);
		}
		expect(job.pi).toBe(3);
		// 3 pages + 1 stylesheet + 2 pictures shared by all pages = 6 requests in one tick.
		expect(steps).toEqual([6]);
		expect(job.done.map((p) => p.title)).toEqual(["Acme Studio | Home", "About", "Classes"]);
		expect(job.fonts).toEqual(["brand sans"]);
	});
	it("resumes mid-page when a page has more assets than the budget", async () => {
		const imgs = Array.from({ length: 8 }, (_, i) => `/_emdash/api/media/file/p${i}.jpg`);
		const s = site({ "/": page({ images: imgs }) });
		const io = { self: s.self as never, external: vi.fn() as never, origin: ORIGIN, budget: 4 };
		const a = await stepVisual(startVisual(["/"], "weekly", T0), io);
		expect(a).toMatchObject({ done: false, requests: 4 });
		expect(a.job.cur?.fp.path).toBe("/");
		const b = await stepVisual(a.job, io);
		const c = await stepVisual(b.job, io);
		expect(c.done).toBe(true);
		expect(c.job.done[0]).toMatchObject({ images: 9, checked: 8, broken: [] });
		expect(s.calls.filter((p) => p === "/")).toHaveLength(1);
	});
	it("records broken pictures (wrong type, 404, other hosts) and stylesheets, asking the asset layer before calling a file missing", async () => {
		const s = site({ "/": page({ images: ["/_emdash/api/media/file/gone.jpg", "/_emdash/api/media/file/html.jpg", "https://cdn.other.example/x.png"], css: ["/_astro/site.css", "/_astro/missing.css"] }) }, { "/_emdash/api/media/file/gone.jpg": [404, "text/plain"], "/_emdash/api/media/file/html.jpg": [200, "text/html"], "/_astro/site.css": [404, "text/plain"], "/_astro/missing.css": [404, "text/plain"] });
		const external = vi.fn(async () => new Response("", { status: 500 }));
		const assets = vi.fn(async (url: string) => (new URL(url).pathname === "/_astro/site.css" ? new Response("@font-face{font-family:Lora;src:url(x)}", { headers: { "content-type": "text/css" } }) : new Response("", { status: 404 })));
		const r = await stepVisual(startVisual(["/"], "weekly", T0), { self: s.self as never, external: external as never, assets: assets as never, origin: ORIGIN });
		expect(r.job.done[0]?.broken).toEqual(["/_emdash/api/media/file/gone.jpg", "/_emdash/api/media/file/html.jpg", "cdn.other.example/x.png"]);
		expect(r.job.done[0]?.cssBroken).toEqual(["/_astro/missing.css"]);
		expect(r.job.fonts).toContain("lora");
		expect(external).toHaveBeenCalledTimes(1);
	});
});

const job = (pages: PageFp[], fonts: string[] = ["brand sans"], trigger: VisualJob["trigger"] = "weekly"): VisualJob => ({ ...startVisual(pages.map((p) => p.path), trigger, T0), pi: pages.length, done: pages, fonts });

describe("baseline, runs and accept", () => {
	it("the first run is the baseline; later runs compare; runs are bounded", () => {
		const first = finishRun(readVisual(null), job([fp(), fp({ path: "/about/" })], ["brand sans"], "first"), { now: T0 });
		expect(first.run.pages.map((p) => p.state)).toEqual(["baseline", "baseline"]);
		expect(Object.keys(first.store.baseline).sort()).toEqual(["/", "/about/"]);
		expect(first.store.fonts?.list).toEqual(["brand sans"]);
		let store = first.store;
		for (let i = 1; i <= 12; i++) store = finishRun(store, job([fp(), fp({ path: "/about/", images: 2 })], []), { now: T0 + i * WEEK }).store;
		expect(store.runs).toHaveLength(MAX_VISUAL_RUNS);
		const last = store.runs.at(-1);
		expect(last?.pages[0]).toMatchObject({ path: "/", state: "problem" });
		expect(last?.pages[0]?.diffs.at(-1)?.text).toBe("A font is no longer loaded: brand sans. Visitors see a fallback font.");
		expect(last?.pages.find((p) => p.path === "/about/")?.state).toBe("changed");
		// Bounded size: 25 pages × 8 runs with long texts stays far under a D1 row.
		const big = finishRun(readVisual(null), job(Array.from({ length: 25 }, (_, i) => fp({ path: `/p${i}/`, title: "t".repeat(120), h1: "h".repeat(120), sections: Array(40).fill("feature_grid") }))), { now: T0 }).store;
		let b2 = big;
		for (let i = 1; i <= 10; i++) b2 = finishRun(b2, job(Array.from({ length: 25 }, (_, k) => fp({ path: `/p${k}/`, title: "x".repeat(120), broken: Array(5).fill("/_emdash/api/media/file/a-long-name.jpg") }))), { now: T0 + i * WEEK }).store;
		expect(JSON.stringify(b2).length).toBeLessThan(400_000);
	});
	it("a page saved in the editor since its baseline takes its new look, unless something is broken", () => {
		const base = finishRun(readVisual(null), job([fp(), fp({ path: "/about/" })], [], "first"), { now: T0 }).store;
		const edited = new Map([
			["/", new Date(T0 + 3600_000).toISOString()],
			["/about", new Date(T0 + 3600_000).toISOString()],
		]);
		const r = finishRun(base, job([fp({ title: "New home" }), fp({ path: "/about/", title: "New about", broken: ["/x.jpg"] })], []), { now: T0 + WEEK, edited });
		const home = r.run.pages.find((p) => p.path === "/");
		expect(home).toMatchObject({ state: "updated", diffs: [], edited: new Date(T0 + 3600_000).toISOString() });
		expect(r.store.baseline["/"]).toMatchObject({ title: "New home", by: "edited" });
		const about = r.run.pages.find((p) => p.path === "/about/");
		expect(about?.state).toBe("problem");
		expect(about?.diffs.map((d) => d.kind)).toEqual(["broken"]);
		expect(r.store.baseline["/about/"]?.title).toBe("Home");
		// An edit older than the baseline changes nothing.
		const old = finishRun(base, job([fp({ title: "Changed" })], []), { now: T0 + WEEK, edited: new Map([["/", new Date(T0 - 1000).toISOString()]]) });
		expect(old.run.pages[0]?.state).toBe("changed");
	});
	it("Accept makes the latest look the baseline (all pages and fonts, or one page); error pages are never a baseline", () => {
		const base = finishRun(readVisual(null), job([fp(), fp({ path: "/about/" })], ["lora"], "first"), { now: T0 }).store;
		const changed = finishRun(base, job([fp({ title: "New" }), fp({ path: "/about/", status: 500 })], []), { now: T0 + WEEK }).store;
		// The home page carries the lost font (site-wide), the about page its error.
		expect(needsLook(changed.runs.at(-1)).problems.map((p) => p.path)).toEqual(["/", "/about/"]);
		const one = acceptBaseline(changed, T0 + WEEK + 1, "/");
		expect(one.accepted).toBe(1);
		expect(one.store.baseline["/"]).toMatchObject({ title: "New", by: "accepted" });
		expect(one.store.fonts?.list).toEqual(["lora"]);
		const all = acceptBaseline(changed, T0 + WEEK + 1);
		expect(all.accepted).toBe(1);
		expect(all.store.baseline["/about/"]?.status).toBe(200);
		expect(all.store.fonts?.list).toEqual([]);
		expect(all.store.runs.at(-1)?.pages.find((p) => p.path === "/")).toMatchObject({ state: "same", diffs: [] });
		expect(needsLook(all.store.runs.at(-1)).problems.map((p) => p.path)).toEqual(["/about/"]);
		const next = finishRun(all.store, job([fp({ title: "New" })], []), { now: T0 + 2 * WEEK });
		expect(next.run.pages[0]?.state).toBe("same");
	});
});

describe("alerts and What to improve", () => {
	it("one alert email listing the pages in plain words", () => {
		const run = finishRun(finishRun(readVisual(null), job([fp(), fp({ path: "/about/" })], [], "first"), { now: T0 }).store, job([fp({ status: 502 }), fp({ path: "/about/", h1: "Other" })], []), { now: T0 + WEEK }).run;
		const [e, ...rest] = visualAlertEvents("Acme", needsLook(run));
		expect(rest).toEqual([]);
		expect(e).toMatchObject({ issue: "visual-change", severity: "problem", subject: "Acme: 1 page looks broken" });
		expect(e?.lines).toContain("/: The page shows an error (HTTP 502).");
		expect(e?.lines).toContain("/about/: The main heading changed from “Welcome” to “Other”.");
		expect(e?.lines.at(-1)).toContain("Accept as new baseline");
		expect(visualAlertEvents("Acme", { problems: [], changes: [] })).toEqual([]);
	});
	it("broken pages rank near the top, changes in the middle", () => {
		const broken = improvements({ visual: { problems: ["/", "/about/"], changes: ["/x/"] }, notFound: { at: "", probes: 0, top: [{ path: "/old/", hits: 9, lastSeen: "" }] } as never });
		expect(broken[0]).toMatchObject({ id: "visual", impact: 95, count: 2, names: { label: "Pages", items: ["/", "/about/"], more: 0 }, link: { tab: "visual" } });
		const changed = improvements({ visual: { problems: [], changes: ["/x/"] } });
		expect(changed[0]).toMatchObject({ id: "visual", impact: 55, count: 1 });
		expect(changed[0]?.text).toContain("accept the new look");
		expect(improvements({ visual: { problems: [], changes: [] } })).toEqual([]);
	});
});

describe("runVisual (cron path)", () => {
	afterEach(() => vi.unstubAllGlobals());
	function setup(pages: Record<string, string | number>, o: Partial<HealthOptions> = {}, envExtra: Record<string, string> = {}, content?: RunDeps["content"]) {
		const kv = memoryKv();
		const logs: unknown[] = [];
		const s = site(pages);
		const brevo = vi.fn(async () => new Response(JSON.stringify({ messageId: "m" }), { status: 201 }));
		vi.stubGlobal("fetch", brevo);
		const d = (now: number): RunDeps => ({ kv, options: { ...OPTIONS, ...o }, env: { EMAIL_PROVIDER: "brevo", EMAIL_API_KEY: "xkeysib-secret-email-key", FORM_FROM: "Acme <noreply@acme.example>", ...envExtra } as never, self: s.self as never, fetch: vi.fn(async () => new Response("", { status: 404 })) as never, ...(content ? { content } : {}), log: { info: (...a: unknown[]) => logs.push(a), warn: (...a: unknown[]) => logs.push(a) }, now });
		return { kv, logs, s, brevo, d };
	}
	const untilDone = async (x: ReturnType<typeof setup>, now: number) => {
		for (let i = 0; i < 10; i++) {
			const r = await runVisual(x.d(now + i * 300_000));
			if (r.run || !r.ran) return r;
		}
		throw new Error("did not finish");
	};

	it("first run: baseline of home + sitemap pages over ticks; later: a broken page emails once", async () => {
		const pages: Record<string, string | number> = { "/": page(), "/about/": page({ title: "About", images: Array.from({ length: 6 }, (_, i) => `/_emdash/api/media/file/a${i}.jpg`) }), "/contact/": page({ title: "Contact" }) };
		const x = setup(pages);
		await x.kv.set(KEYS.state, { ...emptyState(), sitemap: { at: "", paths: ["/", "/about/", "/contact/"] } });
		const first = await runVisual(x.d(T0));
		expect(first).toMatchObject({ ran: true, progress: { pages: 3 } });
		expect(first.run).toBeUndefined();
		expect(await x.kv.get(KEYS.visualJob)).not.toBeNull();
		const done = await untilDone(x, T0 + 300_000);
		expect(done.run?.pages.map((p) => p.state)).toEqual(["baseline", "baseline", "baseline"]);
		expect(await x.kv.get(KEYS.visualJob)).toBeNull();
		expect(await x.kv.get(KEYS.visualLock)).toBeNull();
		expect(x.brevo).not.toHaveBeenCalled();
		expect((await runVisual(x.d(T0 + 3_600_000))).why).toBe("not-due");
		// A week later the about page lost its pictures and the contact page errors.
		pages["/about/"] = page({ title: "About", images: [] });
		pages["/contact/"] = 500;
		const later = await untilDone(x, T0 + WEEK);
		expect(needsLook(later.run).problems.map((p) => p.path)).toEqual(["/contact/"]);
		expect(needsLook(later.run).changes.map((p) => p.path)).toEqual(["/about/"]);
		expect(later.alerts).toEqual({ sent: 1, held: 0 });
		const mail = JSON.parse(String((x.brevo.mock.calls[0] as unknown as [string, RequestInit])[1].body));
		expect(mail.subject).toBe("Acme: 1 page looks broken");
		expect(mail.textContent ?? mail.htmlContent).toContain("/contact/: The page shows an error (HTTP 500).");
		expect(JSON.stringify(x.logs)).not.toContain("xkeysib");
		expect(JSON.stringify(x.logs)).not.toContain("word1");
	});
	it("held before go-live; off with visualPages 0; never on staging; paused in coming-soon mode", async () => {
		const pre = setup({ "/": page() }, { live: false });
		await untilDone(pre, T0);
		await pre.kv.set(KEYS.visualRequest, { at: new Date(T0 + 1000).toISOString() });
		const r = await untilDone(pre, T0 + 60_000);
		expect(r.run?.pre).toBe(true);
		expect((await pre.kv.get<{ done?: string }>(KEYS.visualRequest))?.done).toBeDefined();
		expect((await runVisual(setup({ "/": page() }, { visualPages: 0 }).d(T0))).why).toBe("off");
		const staging = setup({ "/": page() }, {}, { STAGING: "1" });
		expect((await runVisual(staging.d(T0))).why).toBe("staging");
		expect(staging.s.self).not.toHaveBeenCalled();
		const cs = setup({ "/": page() });
		await cs.kv.set(KEYS.maintenance, { on: true });
		expect((await runVisual(cs.d(T0))).why).toBe("paused");
	});
	it("is single-flight", async () => {
		const x = setup({ "/": page() });
		await x.kv.set(KEYS.visualLock, { until: new Date(T0 + 60_000).toISOString() });
		expect((await runVisual(x.d(T0))).why).toBe("locked");
	});
	it("pages edited in the admin since the baseline take their new look (content updatedAt, newest first)", async () => {
		const pages: Record<string, string | number> = { "/": page(), "/about/": page({ title: "About" }) };
		const items = [
			{ id: "1", slug: "home", data: {}, updatedAt: new Date(T0 - 86_400_000).toISOString() },
			{ id: "2", slug: "about", data: {}, updatedAt: new Date(T0 - 86_400_000).toISOString() },
		];
		const list = vi.fn(async (_c: string, o?: { orderBy?: Record<string, string> }) => ({ items: [...items].sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)), hasMore: false, o }));
		const x = setup(pages, {}, {}, { list } as never);
		await x.kv.set(KEYS.state, { ...emptyState(), sitemap: { at: "", paths: ["/", "/about/"] } });
		await untilDone(x, T0);
		pages["/about/"] = page({ title: "About us", sections: ["hero", "rich_text"] });
		pages["/"] = page({ title: "Welcome home" });
		items[1] = { ...items[1], updatedAt: new Date(T0 + 86_400_000).toISOString() } as (typeof items)[number];
		const r = await untilDone(x, T0 + WEEK);
		expect(r.run?.pages.find((p) => p.path === "/about/")).toMatchObject({ state: "updated", diffs: [] });
		expect(r.run?.pages.find((p) => p.path === "/")?.state).toBe("changed");
		expect(list.mock.calls.at(-1)?.[1]).toMatchObject({ limit: 100, orderBy: { updatedAt: "desc" } });
		expect(r.alerts?.sent).toBe(1);
	});
	it("editedSince: stops at the first older entry and survives a collection that fails", async () => {
		const list = vi.fn(async (c: string) => {
			if (c === "posts") throw new Error("no such collection");
			return { items: [{ id: "a", slug: "classes/reformer", data: {}, updatedAt: "2026-11-20T00:00:00.000Z" }, { id: "b", slug: "about", data: {}, updatedAt: "2026-11-01T00:00:00.000Z" }], hasMore: true, cursor: "c" };
		});
		const m = await editedSince({ list } as never, ["pages", "posts"], ["/classes/reformer/", "/about/"], "2026-11-10T00:00:00.000Z");
		expect([...m]).toEqual([["/classes/reformer", "2026-11-20T00:00:00.000Z"]]);
		expect(list).toHaveBeenCalledTimes(2);
		expect((await editedSince(undefined, ["pages"], ["/"], "x")).size).toBe(0);
	});
});

const pageData = (extra: Partial<PageData> = {}): PageData => ({ state: emptyState(), today: null, history: [], incidents: [], links: null, cwv: null, reports: [], settings: {}, defaults: { alertsTo: [], reportTo: [] }, email: { ready: true, provider: "brevo" }, live: true, staging: false, secrets: { crux: false, zone: false, analytics: false }, selfBinding: true, productionUrl: ORIGIN, ...extra });

describe("the Visual check tab", () => {
	it("before the first run, while running, and when switched off", () => {
		expect((visualTab(pageData({ visual: { on: true, store: readVisual(null) } })) as B[]).find((b) => b.type === "empty")?.title).toBe("No visual check yet");
		expect((visualTab(pageData({ visual: { on: true, store: readVisual(null), job: { pages: 10, done: 4 } } })) as B[]).find((b) => b.type === "banner")?.description).toContain("4 of 10 pages");
		expect((visualTab(pageData({ visual: { on: false, store: readVisual(null) } })) as B[]).find((b) => b.type === "banner")?.title).toBe("Visual check is off");
	});
	it("lists each page in plain words with Accept buttons for changes", () => {
		const base = finishRun(readVisual(null), job([fp(), fp({ path: "/about/" })], [], "first"), { now: T0 }).store;
		const store = finishRun(base, job([fp({ broken: ["/a.jpg"] }), fp({ path: "/about/", words: 100 })], []), { now: T0 + WEEK }).store;
		const b = visualTab(pageData({ visual: { on: true, store } })) as B[];
		expect(b.filter((x) => x.type === "banner").map((x) => x.title)).toEqual(["1 page looks broken", "1 page looks different"]);
		const rows = b.find((x) => x.block_id === "visual-pages")?.rows as B[];
		expect(rows.map((r) => [r.path, r.state])).toEqual([
			["/", "Problem"],
			["/about/", "Changed"],
		]);
		expect(rows[1]?.what).toBe("Much less text: 100 words instead of 300 (-67%).");
		expect(rows[1]?.accept).toMatchObject({ type: "button", action_id: "visual-accept", value: "/about/" });
		expect(rows[0]?.accept).toBe("");
		const actions = b.find((x) => x.type === "actions")?.elements as B[];
		expect(actions.map((e) => e.action_id)).toEqual(["visual-accept", "visual-run"]);
		expect(actions[0]?.confirm).toBeDefined();
		expect(b.find((x) => x.block_id === "visual-runs")?.rows).toHaveLength(2);
		expect(String(b.at(-1)?.text)).toContain("Browser Rendering");
	});
});

describe("plugin: Accept, Check now, the tab and the cron tick", () => {
	const plugin = createPlugin(OPTIONS) as unknown as { hooks: Record<string, any>; routes: Record<string, { handler: (ctx: unknown) => Promise<unknown> }> };
	let kv: ReturnType<typeof memoryKv>;
	const cron = { schedule: vi.fn(async () => {}), list: vi.fn(async () => [{ name: "tick", schedule: "*/5 * * * *" }]) };
	const ctx = (input: unknown, role = 50) => ({ input, kv, cron, request: new Request(`${ORIGIN}/_emdash/api/plugins/site-health/admin`), user: { id: "u1", role }, log: { info: vi.fn(), warn: vi.fn() } });
	const call = (input: unknown, role = 50) => plugin.routes.admin?.handler(ctx(input, role)) as Promise<{ blocks: B[]; toast?: { message: string; type: string } }>;
	const tabOf = (r: { blocks: B[] }) => r.blocks.find((b) => b.type === "tab") as { default_tab: number; panels: { label: string; blocks: B[] }[] };
	let pages: Record<string, string | number>;

	beforeEach(() => {
		kv = memoryKv();
		pages = { "/": page() };
		for (const k of Object.keys(env)) delete env[k];
		Object.assign(env, { SELF: { fetch: (r: Request) => site(pages).self(r.url, { method: r.method }) }, EMAIL_PROVIDER: "brevo" });
		vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
	});
	afterEach(() => vi.unstubAllGlobals());

	it("the cron tick makes the baseline; a changed page shows on the tab; only admins can accept; Accept clears it", async () => {
		await plugin.hooks.cron.handler({ name: "tick" }, ctx({}));
		expect(readVisual(await kv.get(KEYS.visual)).runs).toHaveLength(1);
		pages["/"] = page({ title: "Something else" });
		await kv.set(KEYS.visualRequest, { at: new Date(Date.now() - 60_000).toISOString() });
		await plugin.hooks.cron.handler({ name: "tick" }, ctx({}));
		const r = await call({ type: "block_action", action_id: "improve-tab", value: "visual" });
		const t = tabOf(r);
		expect(t.default_tab).toBe(TABS.visual);
		expect(t.panels[TABS.visual]?.label).toBe("Visual check (1)");
		expect((t.panels[0]?.blocks.find((b) => b.block_id === "improve")?.rows as B[])[0]).toMatchObject({ open: { type: "button", action_id: "improve-tab", value: "visual" } });
		const denied = await call({ type: "block_action", action_id: "visual-accept" }, 40);
		expect(denied.blocks[0]).toMatchObject({ title: "Admins only" });
		expect(readVisual(await kv.get(KEYS.visual)).baseline["/"]?.title).toBe("Acme Studio | Home");
		const ok = await call({ type: "block_action", action_id: "visual-accept" });
		expect(ok.toast).toMatchObject({ type: "success" });
		expect(readVisual(await kv.get(KEYS.visual)).baseline["/"]).toMatchObject({ title: "Something else", by: "accepted" });
		expect(tabOf(ok).panels[TABS.visual]?.label).toBe("Visual check");
	});
	it("Check now stores a request at most every 10 minutes", async () => {
		const a = await call({ type: "block_action", action_id: "visual-run" });
		expect(a.toast?.type).toBe("success");
		expect(await kv.get(KEYS.visualRequest)).not.toBeNull();
		const b = await call({ type: "block_action", action_id: "visual-run" });
		expect(b.toast?.message).toContain("already on its way");
		expect((await call({ type: "block_action", action_id: "visual-accept" })).toast?.message).toContain("Nothing to accept yet");
	});
	it("skips the visual step in a tick where the PageSpeed test ran", async () => {
		env.PAGESPEED_API_KEY = `AIza${"SyPSITESTKEY0123456789abcdefghijklm"}`;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string) => (String(url).startsWith("https://pagespeedonline.googleapis.com") ? Response.json({ lighthouseResult: { categories: { performance: { score: 0.9 } }, audits: {} } }) : new Response("", { status: 404 }))),
		);
		await plugin.hooks.cron.handler({ name: "tick" }, ctx({}));
		expect(await kv.get(KEYS.lab)).not.toBeNull();
		expect(await kv.get(KEYS.visual)).toBeNull();
		await plugin.hooks.cron.handler({ name: "tick" }, ctx({}));
		expect(readVisual(await kv.get(KEYS.visual)).runs).toHaveLength(1);
	});
});

describe("kit side", () => {
	const config = (extra: Record<string, unknown> = {}) => kitConfigSchema.parse({ slug: "acme", name: "Acme", source: { url: ORIGIN }, target: { productionUrl: ORIGIN }, email: { to: ["owner@acme.example"], stagingTo: ["team@agency.example"] }, ...extra });
	it("kit.config health.visualPages: default 10 (not written), 0 turns the check off, at most 25", () => {
		expect(healthOptions({ config: config(), productionUrl: ORIGIN, live: true })?.visualPages).toBeUndefined();
		expect(healthOptions({ config: config({ health: { visualPages: 0 } }), productionUrl: ORIGIN, live: true })?.visualPages).toBe(0);
		expect(healthOptions({ config: config({ health: { visualPages: 15 } }), productionUrl: ORIGIN, live: true })?.visualPages).toBe(15);
		expect(() => config({ health: { visualPages: 30 } })).toThrow();
	});
});
