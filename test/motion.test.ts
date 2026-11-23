import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it } from "vitest";
import { kitConfigSchema } from "../src/config/schema.js";
import { motionPlugin } from "../packages/motion/src/index.js";
import { adminRoute, createPlugin, previewLink } from "../packages/motion/src/plugin/index.js";
import { decodePreview, defaultSettings, encodePreview, MOTION_CSS, MOTION_CSS_BYTES, MOTION_JS, MOTION_JS_BYTES, motionBytes, type MotionSettings, pageMotion, parseSettings, PRELOADER_CAP_MS, settingsFromForm, speedNote, VIEW_TRANSITION_CSS } from "../packages/motion/src/settings.js";
import { KV_KEY, OPTION_NAME, readStoredMotion } from "../packages/motion/src/store.js";
import { type ClientRepoInput, clientRepoFiles } from "../src/scaffold/client-repo.js";
import { motionOptions } from "../src/scaffold/motion.js";

const ROOT = new URL("..", import.meta.url).pathname;
const starter = (p: string) => readFileSync(join(ROOT, "starter", p), "utf8");
const CSS_PATH = join(ROOT, "starter", "public", MOTION_CSS);
const JS_PATH = join(ROOT, "starter", "public", MOTION_JS);
const CSS = readFileSync(CSS_PATH, "utf8");
const JS = readFileSync(JS_PATH, "utf8");
const ctx = { siteEntrance: "standard" as const, hasLogo: true };
const all: MotionSettings = { ...defaultSettings(), preloader: "logo", preloaderBg: "accent", preloaderMinMs: 300, transition: "slide-up", transitionMs: 400, entrance: "calm", hoverLift: true, smoothScroll: true, imageFade: true, parallax: false, progress: true };

// ── Settings ───────────────────────────────────────────────────────────────────────────────────────────────────
describe("settings: defaults, parsing, form", () => {
	it("everything new is off by default; entrances and parallax stay as the site was built", () => {
		const d = defaultSettings();
		expect([d.preloader, d.transition, d.hoverLift, d.smoothScroll, d.imageFade, d.progress]).toEqual(["off", "off", false, false, false, false]);
		expect([d.entrance, d.parallax, d.preloaderBg, d.preloaderMinMs, d.transitionMs]).toEqual(["site", true, "bg", 0, 250]);
	});
	it("stored values are re-checked on read; damaged fields fall back, a wrong version is ignored", () => {
		expect(parseSettings({ version: 2, preloader: "logo" })).toBeUndefined();
		expect(parseSettings(null)).toBeUndefined();
		const p = parseSettings({ version: 1, preloader: "spinner", preloaderBg: "red", preloaderMinMs: 5000, transition: "zoom", transitionMs: 333, entrance: "wild", hoverLift: "yes", parallax: 0, progress: true, updatedBy: "A\u0007dmin" });
		expect(p).toMatchObject({ preloader: "off", preloaderBg: "bg", preloaderMinMs: 0, transition: "off", transitionMs: 250, entrance: "site", hoverLift: false, parallax: true, progress: true, updatedBy: "A dmin" });
		expect(parseSettings({ version: 1, preloaderMinMs: 333, parallax: false })).toMatchObject({ preloaderMinMs: 350, parallax: false });
	});
	it("form: strict choices and range; unsent fields keep their value; toggles read as booleans", () => {
		const cur = defaultSettings();
		const bad = settingsFromForm(cur, { preloader: "spinner", preloaderMinMs: 900, transitionMs: "333" });
		expect(bad.ok).toBe(false);
		expect(!bad.ok && bad.errors.join(" ")).toMatch(/preloader\..*0 to 800 ms.*duration/);
		const ok = settingsFromForm(cur, { preloader: "logo", preloaderBg: "text", preloaderMinMs: 420, transition: "fade", transitionMs: "600", entrance: "off", hoverLift: true, smoothScroll: false, parallax: false });
		expect(ok.ok && ok.settings).toMatchObject({ preloader: "logo", preloaderBg: "text", preloaderMinMs: 400, transition: "fade", transitionMs: 600, entrance: "off", hoverLift: true, smoothScroll: false, imageFade: false, parallax: false, progress: false });
		expect(settingsFromForm(all, {}).ok && (settingsFromForm(all, {}) as { settings: MotionSettings }).settings).toMatchObject({ preloader: "logo", progress: true });
	});
	it("preview code round-trips and refuses anything else", () => {
		expect(decodePreview(encodePreview(all))).toMatchObject({ ...all, updatedAt: "" });
		expect(decodePreview(encodePreview(defaultSettings()))).toMatchObject({ preloader: "off", entrance: "site", parallax: true });
		for (const bad of [null, "", "pl-logo", "pl-spinner.bg-bg.min-0.tr-off.ms-250.en-site.hv-0.sm-0.im-0.px-1.pg-0", encodePreview(all).replace("min-300", "min-310"), encodePreview(all).replace("ms-400", "ms-401"), `${encodePreview(all)}<script>`, "x".repeat(300)]) expect(decodePreview(bad)).toBeUndefined();
	});
	it("storage: the options-table row, read back validated; unreadable = as built", async () => {
		expect(OPTION_NAME).toBe("plugin:motion:settings");
		const db = (value?: string) => ({ prepare: () => ({ bind: () => ({ first: async <T>() => (value === undefined ? null : ({ value } as T)) }) }) });
		expect(await readStoredMotion(db())).toBeUndefined();
		expect(await readStoredMotion(db("{bad"))).toBeUndefined();
		expect(await readStoredMotion(undefined)).toBeUndefined();
		expect((await readStoredMotion(db(JSON.stringify(all))))?.transition).toBe("slide-up");
	});
});

// ── What the page renders ─────────────────────────────────────────────────────────────────────────────────────
describe("page output: attributes, classes, files", () => {
	it("with everything off the page gets nothing: no attribute, no file, no rule, no overlay (byte-identical)", () => {
		for (const stored of [undefined, defaultSettings(), { ...defaultSettings(), parallax: true, entrance: "site" as const }]) {
			for (const siteEntrance of ["calm", "standard"] as const) {
				const m = pageMotion(stored, { siteEntrance, hasLogo: true, hasLightLogo: true });
				expect(m).toEqual({ attrs: {}, calm: siteEntrance === "calm", css: false, js: false, viewTransition: false });
			}
		}
		// The defaults with preview on add nothing either (no stored settings = no preview marker).
		expect(pageMotion(undefined, { ...ctx, preview: true }).attrs).toEqual({});
	});
	it("the layout only adds motion through guarded expressions, and calm keeps its old meaning", () => {
		const base = starter("src/layouts/Base.astro");
		expect(base).not.toContain('"motion-calm": (site as { motion?: string }).motion === "calm"');
		expect(base).toContain('"motion-calm": motion.calm');
		expect(base).toContain('data-prefetch={(site as { prefetch?: boolean }).prefetch === false ? "off" : undefined} {...motion.attrs} class:list={{');
		const added = base.split("\n").filter((l) => /motion\.|preloaderLogo|MOTION_/.test(l) && !/^\s*(import|const|\/\/|\{\/\*)/.test(l));
		for (const l of added) expect(l.trim()).toMatch(/^(<html .*\{\.\.\.motion\.attrs\}.*|\{motion\.css && .*\}|\{motion\.js === "sync" && .*\}|\{motion\.js === "defer" && .*\}|\{motion\.viewTransition && .*\}|\{preloaderLogo && .*\})$/);
		expect(base).toContain('const preloaderLogo = motion.preloader ? (motion.preloader.logo === "onTop" ? brand.logoOnTop : brand.logo) : undefined;');
		// The settings come with the chrome, only when the panel is on.
		const chrome = starter("src/utils/chrome.ts");
		expect(chrome).toContain("motionPanelOn ? loadMotion() : undefined");
		expect(chrome).toContain("...(motion ? { motion } : {})");
		expect(starter("src/utils/motion.ts")).toContain('export const motionPanelOn = (site as { motionPanel?: boolean }).motionPanel === true;');
	});
	it("each option sets its attribute; the files load only when needed; the preloader script decides before paint", () => {
		const m = pageMotion(all, { ...ctx, hasLightLogo: true });
		expect(m.attrs).toEqual({ "data-motion-preloader": "logo", "data-motion-preloader-bg": "accent", "data-motion-preloader-min": "300", "data-motion-transition": "slide-up", "data-motion-transition-ms": "400", "data-motion-hover": "on", "data-motion-smooth": "on", "data-motion-images": "on", "data-motion-parallax": "off", "data-motion-progress": "on" });
		expect([m.calm, m.css, m.js, m.viewTransition, m.preloader]).toEqual([true, true, "sync", true, { logo: "onTop" }]);
		const only = (p: Partial<MotionSettings>) => pageMotion({ ...defaultSettings(), ...p }, ctx);
		expect([only({ hoverLift: true }).css, only({ hoverLift: true }).js]).toEqual([true, false]);
		expect([only({ smoothScroll: true }).css, only({ progress: true }).js]).toEqual([true, false]);
		expect([only({ imageFade: true }).css, only({ imageFade: true }).js]).toEqual([true, "defer"]);
		expect([only({ transition: "fade" }).css, only({ transition: "fade" }).js, only({ transition: "fade" }).viewTransition]).toEqual([true, false, true]);
		expect(only({ entrance: "off" })).toEqual({ attrs: { "data-motion-entrance": "off" }, calm: false, css: false, js: false, viewTransition: false });
		expect(only({ entrance: "standard" }).calm).toBe(false);
		expect(pageMotion({ ...defaultSettings(), entrance: "standard" }, { siteEntrance: "calm", hasLogo: true }).calm).toBe(false);
		expect(only({ parallax: false }).attrs).toEqual({ "data-motion-parallax": "off" });
		// No logo: no preloader at all (and no file just for it).
		expect(pageMotion({ ...defaultSettings(), preloader: "logo" }, { ...ctx, hasLogo: false })).toEqual({ attrs: {}, calm: false, css: false, js: false, viewTransition: false });
		// The light logo is used on the dark backgrounds only.
		expect(pageMotion({ ...defaultSettings(), preloader: "logo" }, { ...ctx, hasLightLogo: true }).preloader).toEqual({ logo: "default" });
		// Preview: the preloader ignores "once per visit".
		expect(pageMotion({ ...defaultSettings(), preloader: "logo" }, { ...ctx, preview: true }).attrs["data-motion-preview"]).toBe("on");
	});
	it("the starter honours entrance off and parallax off; no inline script was added (CSP)", () => {
		const site = starter("src/scripts/site.ts");
		expect(site).toContain('if (!reduce && "IntersectionObserver" in window && !motionOff("motionEntrance")) {');
		expect(site).toContain('if (drifters.length && !reduce && !motionOff("motionParallax")) {');
		expect(site).toContain('if (parallax.length && !reduce && !motionOff("motionParallax")) {');
		const mw = starter("src/middleware.ts");
		expect(mw).toContain("const INLINE_SCRIPTS = [announcementScript];");
		expect(mw).toContain("if (context.url.searchParams.has(MOTION_PREVIEW) && context.cache?.enabled) context.cache.set(false);");
		expect(mw).toMatch(/style-src 'self' 'unsafe-inline'/);
		const base = starter("src/layouts/Base.astro");
		expect(base).toContain("<script is:inline src={asset(MOTION_JS)}></script>");
		expect(base).toContain("<script is:inline src={asset(MOTION_JS)} defer></script>");
		expect(base).not.toMatch(/<script is:inline set:html=\{(?!announcement)/);
		// Preview only for signed-in editors (whose pages are never cached).
		expect(starter("src/utils/motion.ts")).toContain("motionPanelOn && o.editor ? decodePreview(o.url.searchParams.get(PREVIEW_PARAM)) : undefined");
	});
	it("speed note: 0 KB with everything off, the real file sizes otherwise", () => {
		expect(motionBytes(defaultSettings()).total).toBe(0);
		expect(speedNote(defaultSettings())).toContain("Speed: 0 KB");
		expect(motionBytes({ ...defaultSettings(), hoverLift: true })).toEqual({ css: MOTION_CSS_BYTES, js: 0, total: MOTION_CSS_BYTES });
		expect(motionBytes(all).total).toBe(MOTION_CSS_BYTES + MOTION_JS_BYTES);
		expect(speedNote(all)).toMatch(/Speed: \d+\.\d KB of motion files \(stylesheet \d+\.\d KB \+ script \d+\.\d KB/);
		expect(motionBytes({ ...defaultSettings(), entrance: "calm", parallax: false }).total).toBe(0);
	});
});

// ── CSS and JS: reduced motion, the cap, the budget ──────────────────────────────────────────────────────────
describe("motion files", () => {
	it("size budget; the sizes the panel reports are the files' sizes", () => {
		expect(statSync(CSS_PATH).size).toBe(MOTION_CSS_BYTES);
		expect(statSync(JS_PATH).size).toBe(MOTION_JS_BYTES);
		expect(MOTION_CSS_BYTES).toBeLessThanOrEqual(5120);
		expect(MOTION_JS_BYTES).toBeLessThanOrEqual(3072);
		expect(gzipSync(CSS).length).toBeLessThanOrEqual(2048);
		expect(gzipSync(JS).length).toBeLessThanOrEqual(1536);
	});
	it("reduced motion: the preloader and transitions are switched off; every other effect waits for no-preference", () => {
		expect(VIEW_TRANSITION_CSS).toBe("@media (prefers-reduced-motion: no-preference){@view-transition{navigation:auto}}");
		const reduceBlock = CSS.slice(CSS.indexOf("@media (prefers-reduced-motion: reduce)"));
		expect(reduceBlock).toContain(".motion-preloader { display: none !important; }");
		expect(reduceBlock).toMatch(/::view-transition-new\(\*\) \{ animation: none !important; \}/);
		// Smooth scroll, image fade, hover lift and the progress bar sit inside no-preference blocks.
		for (const sel of [':root[data-motion-smooth="on"]', ".motion-img {", ':root[data-motion-hover="on"]', ':root[data-motion-progress="on"]::after']) {
			const at = CSS.indexOf(sel);
			expect(at).toBeGreaterThan(0);
			const before = CSS.slice(0, at);
			expect(before.lastIndexOf("prefers-reduced-motion: no-preference")).toBeGreaterThan(before.lastIndexOf("}\n}"));
		}
		expect(JS).toContain('matchMedia("(prefers-reduced-motion: reduce)").matches');
		expect(JS).toMatch(/d\.motionPreloader === "logo" && !reduce/);
		expect(JS).toMatch(/d\.motionImages === "on" && !reduce/);
	});
	it("the preloader can never hold the page: CSS fades it by 1.2 s, it never takes clicks, without the script it stays hidden", () => {
		const rule = /\.motion-preloading \.motion-preloader \{([^}]*)\}/.exec(CSS)?.[1] ?? "";
		expect(rule).toContain("position: fixed");
		expect(rule).toContain("pointer-events: none");
		const [, dur, delay] = /animation: motion-pre-out ([\d.]+)s ease-out ([\d.]+)s forwards/.exec(rule) ?? [];
		expect((Number(dur) + Number(delay)) * 1000).toBeLessThanOrEqual(PRELOADER_CAP_MS);
		expect(CSS).toMatch(/@keyframes motion-pre-out \{ to \{ opacity: 0; visibility: hidden; \} \}/);
		expect(CSS).toMatch(/^\.motion-preloader \{ display: none; \}$/m);
		expect(starter("src/layouts/Base.astro")).toContain('<div class="motion-preloader" aria-hidden="true" hidden>');
	});
});

// A small stand-in browser for site-motion.js (node:vm): html classes and dataset, timers, storage, load events.
function browser(o: { data?: Record<string, string>; reduce?: boolean; webdriver?: boolean; ua?: string; store?: Map<string, string>; storageThrows?: boolean; readyState?: string; hidden?: boolean; imgs?: { complete: boolean; classList: Set<string>; on: Record<string, () => void> }[] } = {}) {
	const classes = new Set<string>();
	const store = o.store ?? new Map<string, string>();
	let clock = 50;
	let timers: { at: number; fn: () => void }[] = [];
	const listeners: Record<string, (() => void)[]> = {};
	const imgs = (o.imgs ?? []).map((i) => ({ complete: i.complete, classList: { add: (c: string) => i.classList.add(c) }, addEventListener: (t: string, f: () => void) => (i.on[t] = f) }));
	const document = {
		documentElement: { dataset: o.data ?? {}, classList: { add: (...c: string[]) => c.forEach((x) => classes.add(x)), remove: (...c: string[]) => c.forEach((x) => classes.delete(x)) } },
		readyState: o.readyState ?? "loading",
		visibilityState: o.hidden ? "hidden" : "visible",
		prerendering: false,
		querySelectorAll: () => imgs,
		addEventListener: (t: string, f: () => void) => (listeners[`doc:${t}`] ??= []).push(f),
	};
	const performance = { now: () => clock };
	const window = { matchMedia: (q: string) => ({ matches: !!o.reduce && q.includes("reduce") }), addEventListener: (t: string, f: () => void) => (listeners[t] ??= []).push(f), performance };
	const sessionStorage = {
		getItem: (k: string) => {
			if (o.storageThrows) throw new Error("denied");
			return store.get(k) ?? null;
		},
		setItem: (k: string, v: string) => void store.set(k, v),
	};
	runInNewContext(JS, { window, document, navigator: { webdriver: !!o.webdriver, userAgent: o.ua ?? "Mozilla/5.0 (Macintosh)" }, sessionStorage, performance, setTimeout: (fn: () => void, ms: number) => timers.push({ at: clock + ms, fn }), Math, Number });
	const advance = (to: number) => {
		for (;;) {
			const due = timers.filter((t) => t.at <= to).sort((a, b) => a.at - b.at)[0];
			if (!due) break;
			timers = timers.filter((t) => t !== due);
			clock = due.at;
			due.fn();
		}
		clock = to;
	};
	const fire = (t: string) => (listeners[t] ?? []).forEach((f) => f());
	return { classes, store, advance, fire, setClock: (t: number) => (clock = t) };
}

describe("preloader script (site-motion.js)", () => {
	const data = { motionPreloader: "logo" };
	it("first page of a visit: shown, then hidden by the 1.2 s cap even if the page never finishes loading", () => {
		const b = browser({ data });
		expect(b.classes.has("motion-preloading")).toBe(true);
		expect(b.store.get("motion:preloaded")).toBe("1");
		b.advance(PRELOADER_CAP_MS - 1);
		expect(b.classes.has("motion-preloaded")).toBe(false);
		b.advance(PRELOADER_CAP_MS);
		expect(b.classes.has("motion-preloaded")).toBe(true);
		b.advance(PRELOADER_CAP_MS + 300);
		expect([...b.classes]).toEqual([]);
	});
	it("hides when the page has loaded, but not before the minimum", () => {
		const b = browser({ data: { ...data, motionPreloaderMin: "600" } });
		b.setClock(300);
		b.fire("load");
		b.advance(599);
		expect(b.classes.has("motion-preloaded")).toBe(false);
		b.advance(600);
		expect(b.classes.has("motion-preloaded")).toBe(true);
		const fast = browser({ data, readyState: "complete" });
		fast.advance(60);
		expect(fast.classes.has("motion-preloaded")).toBe(true);
	});
	it("once per session; never for bots, background tabs, reduced motion or blocked storage; preview always shows", () => {
		const store = new Map<string, string>();
		browser({ data, store });
		expect(browser({ data, store }).classes.size).toBe(0);
		for (const o of [{ reduce: true }, { webdriver: true }, { ua: "Mozilla/5.0 (compatible; Googlebot/2.1)" }, { ua: "Chrome-Lighthouse" }, { hidden: true }, { storageThrows: true }]) expect(browser({ data, ...o }).classes.size).toBe(0);
		const p = browser({ data: { ...data, motionPreview: "on" }, store });
		expect(p.classes.has("motion-preloading")).toBe(true);
		const fresh = new Map<string, string>();
		browser({ data: { ...data, motionPreview: "on" }, store: fresh });
		expect(fresh.size).toBe(0);
		expect(browser({ data: {} }).classes.size).toBe(0);
	});
	it("image fade-in marks lazy images still loading, not loaded ones; off under reduced motion", () => {
		const img = (complete: boolean) => ({ complete, classList: new Set<string>(), on: {} as Record<string, () => void> });
		const a = img(false);
		const b = img(true);
		const br = browser({ data: { motionImages: "on" }, readyState: "interactive", imgs: [a, b] });
		expect([...a.classList]).toEqual(["motion-img"]);
		expect([...b.classList]).toEqual([]);
		a.on.load?.call({ classList: { add: (c: string) => a.classList.add(c) } });
		expect(a.classList.has("is-loaded")).toBe(true);
		expect(br.classes.size).toBe(0);
		const c = img(false);
		browser({ data: { motionImages: "on" }, readyState: "interactive", reduce: true, imgs: [c] });
		expect(c.classList.size).toBe(0);
	});
});

// ── Plugin ─────────────────────────────────────────────────────────────────────────────────────────────────────
class MemKv {
	m = new Map<string, unknown>();
	async get<T>(k: string) {
		return (this.m.get(k) as T) ?? null;
	}
	async set(k: string, v: unknown) {
		this.m.set(k, JSON.parse(JSON.stringify(v)));
	}
}

describe("Motion plugin", () => {
	const o = { productionUrl: "https://acme.example", siteName: "Acme", siteEntrance: "calm" as const };
	let kv: MemKv;
	let purged: string[][];
	const bits = (fail = false) => ({ cache: { purge: async (x: { tags: string[] }) => (purged.push(x.tags), { success: !fail, errors: [] }) } });
	const admin = (input: unknown, role = 50, fail = false) => adminRoute({ kv, input, user: { role, name: "Owner" }, request: new Request("https://acme-site.workers.dev/_emdash/api/plugins/motion/admin") }, o, bits(fail));
	beforeEach(() => {
		kv = new MemKv();
		purged = [];
	});
	it("descriptor: native plugin, Worker entrypoint, admin page for admins", () => {
		expect(motionPlugin(o)).toMatchObject({ id: "motion", format: "native", entrypoint: "@wp2emdash/motion/plugin", displayName: "Motion" });
		const p = createPlugin(o) as unknown as { admin: { pages: { label: string; icon: string }[] }; routes: Record<string, { permission?: string; public?: boolean }> };
		expect(p.admin.pages[0]).toMatchObject({ label: "Motion", icon: "sparkle" });
		expect(p.routes.admin).toMatchObject({ permission: "plugins:manage" });
		expect(p.routes.admin?.public).toBeUndefined();
	});
	it("admins only; opening the page stores nothing (the site stays as built); the page shows the speed note and a preview link", async () => {
		expect(JSON.stringify((await admin({ type: "page_load" }, 40)).blocks)).toContain("Administrators only");
		const page = JSON.stringify((await admin({ type: "page_load" })).blocks);
		expect(kv.m.size).toBe(0);
		expect(page).toContain("Speed: 0 KB");
		expect(page).toContain("As the site was built (calm)");
		expect(page).toContain(`https://acme-site.workers.dev/?motion-preview=${encodePreview(defaultSettings())}`);
		expect(page).toContain("reduced motion never see any of this");
	});
	it("save: validated, stored with who saved, pages purged; the toast says when visitors see it", async () => {
		const bad = await admin({ type: "form_submit", action_id: "save", values: { transition: "zoom" } });
		expect(bad.toast?.type).toBe("error");
		expect(purged).toEqual([]);
		const ok = await admin({ type: "form_submit", action_id: "save", values: { transition: "fade", transitionMs: "400", hoverLift: true } });
		expect(ok.toast).toEqual({ type: "success", message: "Motion saved. Visitors see it within a few seconds (on their next page)." });
		expect(kv.m.get(KV_KEY)).toMatchObject({ transition: "fade", transitionMs: 400, hoverLift: true, preloader: "off", updatedBy: "Owner" });
		expect(purged).toEqual([["wp2emdash:analytics", "emdash:settings"]]);
		expect(JSON.stringify(ok.blocks)).toMatch(/Speed: \d+\.\d KB of motion files \(stylesheet/);
		const failed = await admin({ type: "form_submit", action_id: "save", values: { progress: true } }, 50, true);
		expect(failed.toast?.type).toBe("info");
		expect(failed.toast?.message).toContain("within the hour");
	});
	it("preview only: nothing stored or purged, a link with the typed settings, the form keeps them", async () => {
		const r = await admin({ type: "form_submit", action_id: "save", values: { preloader: "logo", transition: "slide-up", previewOnly: true } });
		expect(kv.m.size).toBe(0);
		expect(purged).toEqual([]);
		const typed = { ...defaultSettings(), preloader: "logo" as const, transition: "slide-up" as const };
		const s = JSON.stringify(r.blocks);
		expect(s).toContain("Preview ready (not saved)");
		expect(s).toContain(previewLink(typed, "https://acme-site.workers.dev/"));
		expect(s).toContain('"action_id":"preloader","label":"First-visit preloader"');
		expect(r.toast?.message).toContain("Nothing was published");
	});
	it("turn all motion off: back to the defaults, purged", async () => {
		await admin({ type: "form_submit", action_id: "save", values: { preloader: "logo", entrance: "off", parallax: false } });
		await admin({ type: "block_action", action_id: "reset" });
		expect(kv.m.get(KV_KEY)).toMatchObject({ preloader: "off", entrance: "site", parallax: true });
		expect(purged).toHaveLength(2);
	});
});

// ── Kit config, scaffold, client docs ────────────────────────────────────────────────────────────────────────
describe("kit config and scaffold", () => {
	const base = { slug: "acme", name: "Acme", source: { url: "https://acme.example" }, target: { productionUrl: "https://acme.example" }, email: { to: ["owner@acme.example"] } };
	it("motionPanel: on by default; false removes the panel", () => {
		expect(kitConfigSchema.parse(base).motionPanel).toBe(true);
		const c = kitConfigSchema.parse({ ...base, motionPanel: false });
		expect(motionOptions({ config: c, productionUrl: "https://acme.example", siteEntrance: "standard" })).toBeUndefined();
		expect(motionOptions({ config: kitConfigSchema.parse(base), productionUrl: "https://acme.example", siteEntrance: "calm" })).toEqual({ productionUrl: "https://acme.example", siteName: "Acme", siteEntrance: "calm" });
	});
	it("scaffold always ships the package, registers the plugin when on, marks the site; client docs explain it", () => {
		const s = readFileSync(join(ROOT, "src/phases/scaffold.ts"), "utf8");
		expect(s).toContain('"@wp2emdash/motion": "link:./packages/motion"');
		expect(s).toContain('cpSync(join(KIT_ROOT, "packages", "motion")');
		expect(s).toContain("motionPlugin(${JSON.stringify(motionPanel)})");
		expect(s).toContain("(siteConfig as { motionPanel?: boolean }).motionPanel = true;");
		const input = { name: "Acme", slug: "acme", sourceUrl: "https://acme.example", productionUrl: "https://acme.example", workerName: "acme", productionReady: false, sections: [], forms: [], email: { provider: "brevo", to: [] }, turnstileProduction: false, sensitiveData: false, stack: {} } as unknown as ClientRepoInput;
		const guide = clientRepoFiles({ ...input, motion: { siteEntrance: "calm" } })["docs/editor-guide.md"] ?? "";
		for (const t of ["## Motion", "Plugins → Motion", "First-visit preloader", "Page transitions", "Preview only", "reduced motion", "(calm on this site)"]) expect(guide).toContain(t);
		expect(clientRepoFiles(input)["docs/editor-guide.md"]).not.toContain("## Motion");
	});
});
