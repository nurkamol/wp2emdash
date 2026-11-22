/**
 * Visual check: a weekly structural fingerprint of the site's main pages, compared with a baseline, so a page that
 * changed unexpectedly — broken layout (a stylesheet that no longer loads, sections gone), a missing picture, a lost
 * font, a page gone empty or erroring — is noticed whatever caused it: a deploy, an edit in the admin, a settings or
 * menu change, or an outside service (a CDN image, a Google Fonts link).
 *
 * No browser: Cloudflare Browser Rendering would need a new `browser` binding (and @cloudflare/puppeteer), which the
 * kit does not add without an owner decision (docs/spikes/health-findings.md "Visual check"). The page HTML and its
 * stylesheets are read as text, as the deploy check does from outside (src/scaffold/deploy-check.ts):
 *
 *   status, <title>, the first <h1>, the starter's sections in order (`<section class="section section--<type>">`,
 *   starter/src/components/Section.astro), the number of pictures and whether each answers 200 with image/*, whether
 *   each stylesheet loads, the @font-face families in the site's CSS (plus Google Fonts link families), the visible
 *   word count of <main> (else <body> without header/nav/footer) and whether a <footer> is present.
 *
 * Pure parts (parsing, comparison, bounds, schedule, wording) are here; the run is ../visual.ts. Facts and limits:
 * docs/spikes/health-findings.md.
 */
import { type Fetcher, pool, USER_AGENT } from "../probe.js";
import { DAY, HOUR, plural } from "../util.js";

/** Main pages checked by default (HealthOptions.visualPages; 0 turns the check off). */
export const VISUAL_PAGES = 10;
export const MAX_VISUAL_PAGES = 25;
/** Requests per cron tick (page HTML, pictures, stylesheets); the job resumes on the next tick. */
export const VISUAL_BUDGET = 8;
export const VISUAL_CONCURRENCY = 4;
/** Pictures checked per page (all are counted). */
export const MAX_IMAGES_CHECKED = 8;
/** Runs kept (KEYS.visual). */
export const MAX_VISUAL_RUNS = 8;
export const VISUAL_EVERY = 7 * DAY;
/** Weekly runs start from this UTC hour (after the PageSpeed test at 09). */
export const VISUAL_HOUR = 10;
/** "Check now": at most once per this interval. */
export const VISUAL_MANUAL_EVERY = 10 * 60_000;
export const VISUAL_LOCK_MS = 2 * 60_000;
/** Per request (pictures and stylesheets answer fast; a page build may take a few seconds). */
export const VISUAL_TIMEOUT = 8_000;
/** Tolerances. */
export const WORDS_TOLERANCE = 0.3;
/** Word changes on pages with fewer words than this are ignored (a few words swing the percentage). */
export const WORDS_MIN = 50;
const MAX_HTML = 1_500_000;
const MAX_CSS = 600_000;
const MAX_SECTIONS = 40;
const MAX_LISTED = 5;

/** One page's fingerprint. */
export interface PageFp {
	path: string;
	/** HTTP status; 0 = no answer. */
	status: number;
	title?: string;
	h1?: string;
	/** Section types in page order (starter class `section--<type>`), at most 40. */
	sections: string[];
	/** Pictures (<img>) on the page. */
	images: number;
	/** Pictures that did not answer 200 with an image (addresses, at most 5). */
	broken: string[];
	/** Pictures checked (at most MAX_IMAGES_CHECKED per page). */
	checked: number;
	/** Stylesheets linked. */
	css: number;
	/** Stylesheets that did not load (addresses, at most 5). */
	cssBroken: string[];
	/** Visible words of the main content. */
	words: number;
	footer: boolean;
}

export type DiffKind = "status" | "empty" | "broken" | "css" | "footer" | "font" | "title" | "h1" | "sections" | "words" | "images";
/** problem: something is broken whatever the baseline says; change: different from the baseline beyond tolerance. */
export interface Diff {
	kind: DiffKind;
	severity: "problem" | "change";
	/** One plain sentence for the owner. */
	text: string;
}

export type PageState = "baseline" | "same" | "changed" | "problem" | "updated";
export interface PageResult {
	path: string;
	state: PageState;
	diffs: Diff[];
	status: number;
	words: number;
	images: number;
	/** The page was saved in the editor after its baseline (content updatedAt): differences were taken as intended. */
	edited?: string;
	/** An admin accepted this look as the new baseline (ISO). */
	accepted?: string;
}

export interface VisualRun {
	at: string;
	trigger: VisualTrigger;
	pages: PageResult[];
	/** Font families found in the site's CSS at this run (lower case). */
	fonts: string[];
	/** Baseline font families no longer defined. */
	missingFonts: string[];
	/** Run before go-live (the checks render this Worker, so the baseline is the new site; alerts are held). */
	pre?: true;
}

export interface Baseline extends PageFp {
	at: string;
	/** How it became the baseline: the first run, an admin's "Accept", or an edit of the page in the admin. */
	by: "first" | "accepted" | "edited";
}

/** Stored in plugin KV (KEYS.visual). Bounded: ≤ 25 baselines, ≤ 25 current fingerprints, the last 8 runs. */
export interface VisualStore {
	v: 1;
	baseline: Record<string, Baseline>;
	fonts?: { at: string; list: string[] };
	/** The latest fingerprint per page (what "Accept" makes the baseline). */
	current: Record<string, PageFp>;
	currentFonts?: string[];
	runs: VisualRun[];
	/** When the next weekly run is due (ISO). */
	next?: string;
}

export type VisualTrigger = "first" | "weekly" | "manual";

/** A run in progress (KEYS.visualJob), resumed tick by tick. */
export interface VisualJob {
	v: 1;
	startedAt: string;
	trigger: VisualTrigger;
	paths: string[];
	pi: number;
	done: PageFp[];
	/** The page being read: its fingerprint so far and the assets still to check. */
	cur?: { fp: PageFp; images: string[]; css: string[] };
	/** Asset address → HTTP status (0 no answer) and whether it is usable. */
	assets: Record<string, { s: number; ok: boolean }>;
	fonts: string[];
}

export const emptyVisual = (): VisualStore => ({ v: 1, baseline: {}, current: {}, runs: [] });
export const readVisual = (v: unknown): VisualStore => {
	const s = v as VisualStore | null;
	return s && typeof s === "object" && s.v === 1 && Array.isArray(s.runs) ? { ...emptyVisual(), ...s, baseline: s.baseline ?? {}, current: s.current ?? {} } : emptyVisual();
};
export const readJob = (v: unknown): VisualJob | null => {
	const j = v as VisualJob | null;
	return j && typeof j === "object" && j.v === 1 && Array.isArray(j.paths) ? j : null;
};

// ── Parsing ─────────────────────────────────────────────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
export function decode(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
		if (e[0] === "#") {
			const n = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
			return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
		}
		return ENTITIES[e.toLowerCase()] ?? m;
	});
}
const text = (html: string) =>
	decode(html.replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " "))
		.replace(/\s+/g, " ")
		.trim();
const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const attr = (tag: string, name: string) => {
	const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
	const v = m?.[1] ?? m?.[2] ?? m?.[3];
	return v === undefined ? undefined : decode(v);
};

/** Words: runs of letters or digits (any script). */
export const countWords = (s: string) => (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu) ?? []).length;

/** Section modifiers that share the `section--` prefix but are not types (starter Section.astro). */
const NOT_TYPES = new Set(["full", "media-bg"]);

/** The starter's section types in page order: `<section class="section section--hero …">` (variants `section--hero--x` left out). */
export function sectionTypes(html: string): string[] {
	const out: string[] = [];
	for (const m of html.matchAll(/<section\b[^>]*>/gi)) {
		const cls = attr(m[0], "class")?.split(/\s+/) ?? [];
		if (!cls.includes("section")) continue;
		const type = cls.map((c) => /^section--([a-z0-9_-]+)$/i.exec(c)?.[1]).find((t): t is string => !!t && !t.includes("--") && !NOT_TYPES.has(t));
		if (type) out.push(type);
		if (out.length >= MAX_SECTIONS) break;
	}
	return out;
}

/**
 * A picture's address worth checking: EmDash's `/_image?href=<original>&w=…` is checked as the original file (the
 * transform costs a Cloudflare Images unique transformation and falls back to the original anyway — the starter's
 * middleware turns a failed transform into a 302 to it). data: and empty addresses are skipped.
 */
export function imageTarget(src: string | undefined, origin: string): string | undefined {
	if (!src || /^(data|blob):/i.test(src.trim())) return undefined;
	try {
		const u = new URL(src.trim(), origin);
		if (!/^https?:$/.test(u.protocol)) return undefined;
		if (u.origin === origin && u.pathname === "/_image") {
			const href = u.searchParams.get("href");
			if (!href) return undefined;
			const o = new URL(href, origin);
			return /^https?:$/.test(o.protocol) ? o.href : undefined;
		}
		return u.href;
	} catch {
		return undefined;
	}
}

/** Families defined by @font-face in a stylesheet (lower case). */
export function fontFaces(css: string): string[] {
	return [...new Set([...css.matchAll(/@font-face\s*\{[^}]*?font-family\s*:\s*(?:"([^"]+)"|'([^']+)'|([^;}]+))/gi)].map((m) => (m[1] ?? m[2] ?? m[3] ?? "").trim().toLowerCase()).filter(Boolean))];
}

/** Families a Google Fonts link loads (`fonts.googleapis.com/css2?family=Inter:wght@400&family=Playfair+Display`). */
export function googleFamilies(html: string): string[] {
	const out: string[] = [];
	for (const m of html.matchAll(/https:\/\/fonts\.googleapis\.com\/css2?\?[^"'\s>]+/gi)) {
		const q = decode(m[0]).split("?")[1] ?? "";
		for (const part of q.split("&")) {
			const [k, v] = part.split("=");
			if (k !== "family" || !v) continue;
			for (const f of decodeURIComponent(v.replace(/\+/g, " ")).split("|")) {
				const name = f.split(":")[0]?.trim().toLowerCase();
				if (name) out.push(name);
			}
		}
	}
	return [...new Set(out)];
}

/** What one page's HTML tells (assets still to check). Pure. */
export function parsePage(path: string, status: number, html: string, origin: string): { fp: PageFp; images: string[]; css: string[]; fonts: string[] } {
	const fp: PageFp = { path, status, sections: [], images: 0, broken: [], checked: 0, css: 0, cssBroken: [], words: 0, footer: false };
	if (status !== 200 || !html) return { fp, images: [], css: [], fonts: [] };
	const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];
	if (title && text(title)) fp.title = clip(text(title));
	const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1];
	if (h1 && text(h1)) fp.h1 = clip(text(h1));
	fp.sections = sectionTypes(html);
	const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
	const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(body)?.[1];
	fp.words = countWords(text(main ?? body.replace(/<(header|nav|footer)\b[\s\S]*?<\/\1>/gi, " ")));
	fp.footer = /<footer[\s>]/i.test(body);
	const imgs = [...body.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
	fp.images = imgs.length;
	const images = [...new Set(imgs.map((t) => imageTarget(attr(t, "src"), origin)).filter((u): u is string => !!u))].slice(0, MAX_IMAGES_CHECKED);
	fp.checked = images.length;
	const css: string[] = [];
	for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
		const rel = attr(m[0], "rel")?.toLowerCase().split(/\s+/) ?? [];
		const href = attr(m[0], "href");
		if (!rel.includes("stylesheet") || !href) continue;
		try {
			const u = new URL(href, origin);
			// Google Fonts' CSS is not fetched: its families are read from the link itself.
			if (u.hostname === "fonts.googleapis.com") continue;
			if (/^https?:$/.test(u.protocol)) css.push(u.href);
		} catch {}
	}
	fp.css = css.length;
	const inline = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1] ?? "").join("\n");
	return { fp, images, css: [...new Set(css)], fonts: [...new Set([...fontFaces(inline), ...googleFamilies(html)])] };
}

// ── Fetching (resumable job) ────────────────────────────────────────────────────────────────────────────────────

export interface VisualIo {
	/** The site itself (SELF binding, production URL). */
	self: Fetcher;
	/** Other hosts (pictures on a CDN or another service). */
	external: Fetcher;
	/** The Worker's static assets (Astro's ASSETS binding): tried when the site answers 404 for a file. */
	assets?: Fetcher;
	origin: string;
	budget?: number;
	concurrency?: number;
	timeout?: number;
}

/** One asset: status, content type and (for stylesheets) the text. Never throws. */
export async function getAsset(io: VisualIo, url: string, wantText: boolean): Promise<{ s: number; type: string; body?: string }> {
	const once = async (f: Fetcher) => {
		try {
			const res = await f(url, { method: "GET", redirect: "follow", headers: { "user-agent": USER_AGENT, accept: wantText ? "text/css,*/*;q=0.1" : "image/*,*/*;q=0.8" }, signal: AbortSignal.timeout(io.timeout ?? VISUAL_TIMEOUT) });
			const type = res.headers.get("content-type") ?? "";
			if (wantText && res.status === 200) {
				const t = await res.text().catch(() => "");
				return { s: res.status, type, body: t.length > MAX_CSS ? t.slice(0, MAX_CSS) : t };
			}
			await res.body?.cancel().catch(() => {});
			return { s: res.status, type };
		} catch {
			return { s: 0, type: "" };
		}
	};
	const own = new URL(url).origin === io.origin;
	const r = await once(own ? io.self : io.external);
	// Static files (/_astro/*.css, /brand/…) may be served by the asset layer before the Worker: ask it directly.
	if (own && r.s === 404 && io.assets) {
		const a = await once(io.assets);
		if (a.s === 200) return a;
	}
	return r;
}

/** Starts a run over these pages. Pure. */
export const startVisual = (paths: string[], trigger: VisualTrigger, now: number): VisualJob => ({ v: 1, startedAt: new Date(now).toISOString(), trigger, paths, pi: 0, done: [], assets: {}, fonts: [] });

/**
 * One tick's share of the run: at most `budget` requests (a page's HTML, then its pictures and stylesheets — each
 * address once per run, shared by all pages), then it stops and resumes on the next tick.
 */
export async function stepVisual(job: VisualJob, io: VisualIo): Promise<{ job: VisualJob; done: boolean; requests: number }> {
	const j: VisualJob = structuredClone(job);
	let budget = io.budget ?? VISUAL_BUDGET;
	let requests = 0;
	while (budget > 0 && j.pi < j.paths.length) {
		if (!j.cur) {
			const path = j.paths[j.pi] as string;
			const url = `${io.origin}${path}`;
			let status = 0;
			let html = "";
			try {
				const res = await io.self(url, { method: "GET", redirect: "manual", headers: { "user-agent": USER_AGENT, accept: "text/html" }, signal: AbortSignal.timeout(io.timeout ?? VISUAL_TIMEOUT) });
				status = res.status;
				if (status === 200) {
					const t = await res.text().catch(() => "");
					html = t.length > MAX_HTML ? t.slice(0, MAX_HTML) : t;
				} else await res.body?.cancel().catch(() => {});
			} catch {
				status = 0;
			}
			budget--;
			requests++;
			const p = parsePage(path, status, html, io.origin);
			j.fonts = [...new Set([...j.fonts, ...p.fonts])];
			j.cur = { fp: p.fp, images: p.images, css: p.css };
		}
		const cur = j.cur;
		const todo = [...cur.css.map((u) => ({ u, css: true })), ...cur.images.map((u) => ({ u, css: false }))].filter((x) => !j.assets[x.u]);
		const take = todo.slice(0, budget);
		const results = await pool(take, io.concurrency ?? VISUAL_CONCURRENCY, (x) => getAsset(io, x.u, x.css));
		take.forEach((x, k) => {
			const r = results[k] as { s: number; type: string; body?: string };
			j.assets[x.u] = { s: r.s, ok: r.s === 200 && (x.css || /^image\//i.test(r.type)) };
			if (x.css && r.body) j.fonts = [...new Set([...j.fonts, ...fontFaces(r.body)])];
		});
		budget -= take.length;
		requests += take.length;
		if (todo.length > take.length) break;
		const bad = (list: string[]) => list.filter((u) => !j.assets[u]?.ok).map((u) => shortAsset(u, io.origin));
		j.done.push({ ...cur.fp, broken: bad(cur.images).slice(0, MAX_LISTED), cssBroken: bad(cur.css).slice(0, MAX_LISTED) });
		j.cur = undefined;
		j.pi++;
	}
	return { job: j, done: j.pi >= j.paths.length, requests };
}

/** The site's own files by path (query dropped), others by host and path; at most 100 characters. */
export function shortAsset(url: string, origin: string): string {
	try {
		const u = new URL(url);
		return clip(u.origin === origin ? u.pathname : `${u.host}${u.pathname}`, 100);
	} catch {
		return clip(url, 100);
	}
}

// ── Pages, schedule, comparison ─────────────────────────────────────────────────────────────────────────────────

const norm = (p: string) => p.replace(/\/+$/, "") || "/";
const depth = (p: string) => norm(p).split("/").filter(Boolean).length;

/**
 * The pages to check: the home page, the pages already in the baseline that are still in the sitemap (so the set is
 * stable week to week), then the sitemap's shallowest pages (main pages before deep ones), at most `cap`. Pure.
 */
export function pickVisualPages(sitemap: string[], baseline: string[], cap = VISUAL_PAGES): string[] {
	const n = Math.max(1, Math.min(MAX_VISUAL_PAGES, Math.floor(cap)));
	const inMap = new Set(sitemap.map(norm));
	const out = ["/"];
	const add = (p: string) => {
		if (out.length < n && !out.some((x) => norm(x) === norm(p))) out.push(p);
	};
	for (const p of baseline) if (inMap.has(norm(p))) add(p);
	const ranked = sitemap.map((p, i) => ({ p, i })).filter(({ p }) => !/\.(xml|txt|pdf|json)$/i.test(p));
	ranked.sort((a, b) => depth(a.p) - depth(b.p) || a.i - b.i);
	for (const { p } of ranked) add(p);
	return out;
}

/** Why a run should start now: the first run (baseline), an admin's "Check now", or the weekly one from 10 UTC. Pure. */
export function visualDue(store: VisualStore, request: { at: string; done?: string } | null, now: number): VisualTrigger | undefined {
	if (!store.runs.length && !Object.keys(store.baseline).length) return "first";
	if (request && !request.done) return "manual";
	if (!store.next) return "weekly";
	if (new Date(now).getUTCHours() < VISUAL_HOUR) return undefined;
	return now >= Date.parse(store.next) - HOUR ? "weekly" : undefined;
}

const quote = (s: string | undefined) => (s ? `“${s}”` : "nothing");

/** Differences of a page against its baseline (problems hold whatever the baseline). Pure. */
export function comparePage(base: PageFp | undefined, cur: PageFp): Diff[] {
	const out: Diff[] = [];
	if (cur.status !== 200) {
		out.push({ kind: "status", severity: "problem", text: cur.status === 0 ? "The page did not answer within 8 seconds." : cur.status === 404 || cur.status === 410 ? `The page no longer exists (HTTP ${cur.status}).` : cur.status >= 300 && cur.status < 400 ? `The page now redirects elsewhere (HTTP ${cur.status}).` : `The page shows an error (HTTP ${cur.status}).` });
		return out;
	}
	if (cur.broken.length) out.push({ kind: "broken", severity: "problem", text: `${plural(cur.broken.length, "picture")} ${cur.broken.length === 1 ? "does" : "do"} not load: ${cur.broken.join(", ")}.` });
	if (cur.cssBroken.length) out.push({ kind: "css", severity: "problem", text: `${plural(cur.cssBroken.length, "stylesheet")} ${cur.cssBroken.length === 1 ? "does" : "do"} not load, so the layout is probably broken: ${cur.cssBroken.join(", ")}.` });
	if (!base || base.status !== 200) return out;
	if (base.words >= WORDS_MIN && cur.words < 20 && cur.images === 0) out.push({ kind: "empty", severity: "problem", text: `The page is empty: ${base.words} words before, ${cur.words} now.` });
	else if (base.words >= WORDS_MIN && Math.abs(cur.words - base.words) > base.words * WORDS_TOLERANCE) {
		const pct = Math.round(((cur.words - base.words) / base.words) * 100);
		out.push({ kind: "words", severity: "change", text: `${pct < 0 ? "Much less" : "Much more"} text: ${cur.words} words instead of ${base.words} (${pct > 0 ? "+" : ""}${pct}%).` });
	}
	if (base.footer && !cur.footer) out.push({ kind: "footer", severity: "problem", text: "The footer is missing." });
	if ((base.title ?? "") !== (cur.title ?? "")) out.push({ kind: "title", severity: "change", text: `The page title changed from ${quote(base.title)} to ${quote(cur.title)}.` });
	if ((base.h1 ?? "") !== (cur.h1 ?? "")) out.push({ kind: "h1", severity: "change", text: `The main heading changed from ${quote(base.h1)} to ${quote(cur.h1)}.` });
	const count = (l: string[]) => l.reduce<Record<string, number>>((m, t) => ((m[t] = (m[t] ?? 0) + 1), m), {});
	const before = count(base.sections);
	const now = count(cur.sections);
	const gone = Object.keys(before).filter((t) => !now[t]);
	if (gone.length) out.push({ kind: "sections", severity: "change", text: `${gone.length === 1 ? "A section is" : "Sections are"} gone: ${gone.map(sectionLabel).join(", ")}.` });
	else if (base.sections.length - cur.sections.length >= 2) out.push({ kind: "sections", severity: "change", text: `${base.sections.length - cur.sections.length} fewer sections than before (${cur.sections.length} instead of ${base.sections.length}).` });
	if (cur.images < base.images) out.push({ kind: "images", severity: "change", text: `${plural(base.images - cur.images, "picture")} fewer than before (${cur.images} instead of ${base.images}).` });
	return out;
}

/** "rich_text" → "rich text". */
export const sectionLabel = (t: string) => t.replace(/[_-]+/g, " ");

/** Baseline fonts no longer defined in the site's CSS. Pure. */
export const missingFonts = (base: string[] | undefined, cur: string[]) => (base ?? []).filter((f) => !cur.includes(f));

const STATE_ORDER: Record<PageState, number> = { problem: 0, changed: 1, updated: 2, baseline: 3, same: 4 };

/**
 * Compares a finished run with the stored baselines and returns the run and the next store. A page saved in the editor
 * after its baseline (`edited`: normalised path → updatedAt) takes its new look as the baseline unless something is
 * broken (problems always count). Pages without a baseline become their own. Keeps MAX_VISUAL_RUNS runs. Pure.
 */
export function finishRun(store: VisualStore, job: VisualJob, o: { now: number; pre?: boolean; edited?: Map<string, string> }): { store: VisualStore; run: VisualRun } {
	const at = new Date(o.now).toISOString();
	const baseline = { ...store.baseline };
	const lost = store.fonts ? missingFonts(store.fonts.list, job.fonts) : [];
	const pages: PageResult[] = job.done.map((fp) => {
		const base = baseline[fp.path];
		const edited = base ? o.edited?.get(norm(fp.path)) : undefined;
		const editedSince = edited && base && Date.parse(edited) > Date.parse(base.at) ? edited : undefined;
		const facts = { path: fp.path, status: fp.status, words: fp.words, images: fp.images };
		if (!base) {
			const diffs = comparePage(undefined, fp);
			if (fp.status === 200 && !diffs.length) baseline[fp.path] = { ...fp, at, by: "first" };
			return { ...facts, state: diffs.length ? "problem" : "baseline", diffs };
		}
		let diffs = comparePage(base, fp);
		if (editedSince) {
			const problems = diffs.filter((x) => x.severity === "problem");
			if (!problems.length) {
				baseline[fp.path] = { ...fp, at, by: "edited" };
				return { ...facts, state: diffs.length ? "updated" : "same", diffs: [], edited: editedSince };
			}
			diffs = problems;
		}
		return { ...facts, state: diffs.some((x) => x.severity === "problem") ? "problem" : diffs.length ? "changed" : "same", diffs, ...(editedSince ? { edited: editedSince } : {}) };
	});
	// A lost font is site-wide: it is listed on the home page (or the first page read).
	if (lost.length && pages[0]) {
		const first = pages[0];
		first.diffs = [...first.diffs, { kind: "font", severity: "problem", text: `${lost.length === 1 ? "A font is" : "Fonts are"} no longer loaded: ${lost.join(", ")}. Visitors see a fallback font.` }];
		first.state = "problem";
	}
	pages.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || job.paths.indexOf(a.path) - job.paths.indexOf(b.path));
	const run: VisualRun = { at, trigger: job.trigger, pages, fonts: job.fonts, missingFonts: lost, ...(o.pre ? { pre: true as const } : {}) };
	const fonts = store.fonts ?? (job.fonts.length ? { at, list: job.fonts } : undefined);
	const current = Object.fromEntries(job.done.map((fp) => [fp.path, fp]));
	return { run, store: { v: 1, baseline: pruneBaseline(baseline, job.paths), ...(fonts ? { fonts } : {}), current, currentFonts: job.fonts, runs: [...store.runs, run].slice(-MAX_VISUAL_RUNS), next: new Date(o.now + VISUAL_EVERY).toISOString() } };
}

/** Baselines of pages checked this run, plus older ones up to MAX_VISUAL_PAGES (a page that left the set may return). */
function pruneBaseline(b: Record<string, Baseline>, paths: string[]): Record<string, Baseline> {
	const keep = Object.entries(b).sort(([pa, a], [pb, c]) => Number(paths.includes(pb)) - Number(paths.includes(pa)) || (a.at < c.at ? 1 : -1));
	return Object.fromEntries(keep.slice(0, MAX_VISUAL_PAGES));
}

/** "Accept current as new baseline": every page (or one) and the fonts take the latest fingerprint. Pure. */
export function acceptBaseline(store: VisualStore, now: number, path?: string): { store: VisualStore; accepted: number } {
	const at = new Date(now).toISOString();
	const baseline = { ...store.baseline };
	let accepted = 0;
	for (const [p, fp] of Object.entries(store.current)) {
		if (path !== undefined && p !== path) continue;
		if (fp.status !== 200) continue;
		baseline[p] = { ...fp, at, by: "accepted" };
		accepted++;
	}
	const fonts = path === undefined && store.currentFonts ? { at, list: store.currentFonts } : store.fonts;
	// The latest run's rows for accepted pages read "accepted" so the tab and "What to improve" stop listing them.
	const runs = store.runs.map((r, i) => {
		if (i !== store.runs.length - 1 || !accepted) return r;
		const pages = r.pages.map((pg) => {
			if ((path !== undefined && pg.path !== path) || store.current[pg.path]?.status !== 200 || pg.state === "same") return pg;
			// Broken pictures and stylesheets stay problems: accepting a look does not make a missing file load.
			const left = pg.diffs.filter((x) => x.kind === "broken" || x.kind === "css" || (x.kind === "font" && path !== undefined));
			return { ...pg, state: left.length ? ("problem" as const) : ("same" as const), diffs: left, accepted: at };
		});
		return { ...r, ...(path === undefined ? { missingFonts: [] } : {}), pages };
	});
	return { store: { ...store, baseline, ...(fonts ? { fonts } : {}), runs }, accepted };
}

/** The latest run's pages that need a look: problems and unexplained changes (for alerts and "What to improve"). */
export function needsLook(run: VisualRun | undefined): { problems: PageResult[]; changes: PageResult[] } {
	const pages = run?.pages ?? [];
	return { problems: pages.filter((p) => p.diffs.some((x) => x.severity === "problem")), changes: pages.filter((p) => p.diffs.length && !p.diffs.some((x) => x.severity === "problem")) };
}

/** Plain words for a page's state. */
export const STATE_TEXT: Record<PageState, string> = { problem: "Problem", changed: "Changed", updated: "Updated after an edit", baseline: "New baseline", same: "As before" };
