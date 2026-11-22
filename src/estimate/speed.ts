/**
 * Speed without a browser: time to first byte, HTML size, the files a page references (count, and their size from a
 * HEAD request where the server tells it) and image formats. A browser would see more (files loaded by scripts, fonts
 * from stylesheets), so weight is a lower bound and the report says so. `--lab` adds Google PageSpeed Insights for the
 * home page and CrUX field data comes with a CRUX_API_KEY (both through the health package's own calls).
 */
import * as cheerio from "cheerio";
import { fetchPsi, type LabRun } from "../../packages/health/src/checks/lab.js";
import { fetchCrux } from "../../packages/health/src/checks/speed.js";
import type { Cwv } from "../../packages/health/src/store.js";
import { fetchUrl, mapLimit } from "../audit/http.js";
import { EMDASH_TARGETS } from "./rules.js";
import type { PageSpeed, SpeedComparison, SpeedSummary } from "./types.js";

const kb = (bytes: number) => Math.round((bytes / 1024) * 10) / 10;

/** Image format from a file name (query ignored). */
export function imageFormat(src: string): string {
	const path = src.split(/[?#]/)[0]?.toLowerCase() ?? "";
	const ext = /\.([a-z0-9]+)$/.exec(path)?.[1];
	if (!ext) return /^data:image\/([a-z+]+)/i.exec(src)?.[1]?.replace("svg+xml", "svg") ?? "other";
	return ext === "jpeg" ? "jpg" : ["jpg", "png", "gif", "webp", "avif", "svg"].includes(ext) ? ext : "other";
}

/** The files an HTML page asks for: scripts, stylesheets, images, iframes, preloaded fonts (unique, absolute). Pure. */
export function pageResources(html: string, base: string): { all: string[]; images: string[] } {
	const $ = cheerio.load(html);
	const abs = (v: string | undefined) => {
		if (!v || v.startsWith("data:")) return undefined;
		try {
			return new URL(v.trim(), base).href;
		} catch {
			return undefined;
		}
	};
	const images = new Set<string>();
	const all = new Set<string>();
	$("script[src]").each((_, e) => void (abs($(e).attr("src")) && all.add(abs($(e).attr("src")) as string)));
	$('link[rel~="stylesheet"][href]').each((_, e) => void (abs($(e).attr("href")) && all.add(abs($(e).attr("href")) as string)));
	$('link[rel~="preload"][as="font"][href]').each((_, e) => void (abs($(e).attr("href")) && all.add(abs($(e).attr("href")) as string)));
	$("iframe[src]").each((_, e) => void (abs($(e).attr("src")) && all.add(abs($(e).attr("src")) as string)));
	$("img").each((_, e) => {
		// The file a browser picks first: src, else a lazy-load attribute.
		const el = $(e);
		const src = abs(el.attr("src")) ?? abs(el.attr("data-src")) ?? abs(el.attr("data-lazy-src"));
		if (src) {
			images.add(src);
			all.add(src);
		}
	});
	return { all: [...all], images: [...images] };
}

export interface MeasureOptions {
	userAgent: string;
	timeoutMs?: number;
}

/** One timed GET: TTFB (headers received), total, HTML size and what the page references. Never throws. */
export async function measurePage(url: string, o: MeasureOptions): Promise<{ speed: PageSpeed; html?: string }> {
	const started = performance.now();
	try {
		const res = await fetch(url, { headers: { "User-Agent": o.userAgent, Accept: "text/html,application/xhtml+xml" }, redirect: "follow", signal: AbortSignal.timeout(o.timeoutMs ?? 30_000) });
		const ttfb = performance.now() - started;
		const html = await res.text();
		const total = performance.now() - started;
		const { all, images } = pageResources(html, res.url || url);
		const imageFormats: Record<string, number> = {};
		for (const i of images) imageFormats[imageFormat(i)] = (imageFormats[imageFormat(i)] ?? 0) + 1;
		const htmlBytes = Number(res.headers.get("content-length")) || Buffer.byteLength(html);
		return {
			html,
			speed: {
				url,
				status: res.status,
				ttfbMs: Math.round(ttfb),
				totalMs: Math.round(total),
				htmlKb: kb(htmlBytes),
				...(res.headers.get("content-encoding") ? { compression: res.headers.get("content-encoding") as string } : {}),
				...(res.headers.get("server") ? { server: (res.headers.get("server") as string).slice(0, 40) } : {}),
				requests: 1 + all.length,
				unknownSizes: all.length,
				imageFormats,
				resources: all,
			},
		};
	} catch (e) {
		return { speed: { url, status: 0, requests: 0, unknownSizes: 0, imageFormats: {}, resources: [], error: e instanceof Error ? e.message.slice(0, 120) : String(e) } };
	}
}

/**
 * Size the referenced files with HEAD (GET when HEAD is refused; fetchUrl never reads a binary body), at most `max`
 * files across all pages, `concurrency` at a time. Fills weightKb / unknownSizes in place.
 */
export async function sizeResources(pages: PageSpeed[], o: { userAgent: string; max: number; concurrency: number; allow: (url: string) => boolean }): Promise<void> {
	const unique = [...new Set(pages.flatMap((p) => p.resources))].filter(o.allow).slice(0, o.max);
	const sizes = new Map<string, number>();
	await mapLimit(unique, o.concurrency, async (u) => {
		const r = await fetchUrl(u, { headOnly: true, timeoutMs: 15_000, retries: 0, maxRedirects: 5, userAgent: o.userAgent });
		const n = Number(r.headers["content-length"]);
		if (r.status >= 200 && r.status < 300 && Number.isFinite(n) && n > 0) sizes.set(u, n);
	});
	for (const p of pages) {
		if (p.htmlKb === undefined) continue;
		const known = p.resources.filter((r) => sizes.has(r));
		p.weightKb = Math.round(p.htmlKb + kb(known.reduce((s, r) => s + (sizes.get(r) ?? 0), 0)));
		p.unknownSizes = p.resources.length - known.length;
	}
}

const median = (xs: number[]): number | undefined => {
	if (!xs.length) return undefined;
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	return s.length % 2 ? s[mid] : Math.round((((s[mid - 1] as number) + (s[mid] as number)) / 2) * 10) / 10;
};

const MODERN = new Set(["webp", "avif", "svg"]);

/** Medians, image formats and the comparison with the kit's measured targets. Pure. */
export function summarizeSpeed(pages: PageSpeed[], extra: { lab?: SpeedSummary["lab"]; field?: Cwv } = {}): SpeedSummary {
	const ok = pages.filter((p) => p.status >= 200 && p.status < 400 && !p.error);
	const ttfbMs = median(ok.flatMap((p) => (p.ttfbMs === undefined ? [] : [p.ttfbMs])));
	const weightKb = median(ok.flatMap((p) => (p.weightKb === undefined ? [] : [p.weightKb])));
	const requests = median(ok.map((p) => p.requests));
	const imageFormats: Record<string, number> = {};
	for (const p of ok) for (const [f, n] of Object.entries(p.imageFormats)) imageFormats[f] = (imageFormats[f] ?? 0) + n;
	const images = Object.values(imageFormats).reduce((a, b) => a + b, 0);
	const modern = Object.entries(imageFormats).reduce((a, [f, n]) => a + (MODERN.has(f) ? n : 0), 0);
	const modernImageShare = images ? Math.round((modern / images) * 100) / 100 : undefined;
	const T = EMDASH_TARGETS;
	const comparisons: SpeedComparison[] = [
		{
			metric: "Time to first byte (HTML)",
			prospect: ttfbMs === undefined ? "not measured" : `${ttfbMs} ms`,
			emdash: `${T.ttfbMs.measured[0]}–${T.ttfbMs.measured[1]} ms cached (kit gate ≤ ${T.ttfbMs.gate} ms)`,
			verdict: ttfbMs === undefined ? "unknown" : ttfbMs <= T.ttfbMs.measured[1] ? "similar" : "slower",
		},
		{
			metric: "Page weight (HTML + referenced files)",
			prospect: weightKb === undefined ? "not measured" : `${weightKb.toLocaleString("en-US")} KB+`,
			emdash: `${T.weightKb.measured} KB desktop / ${T.weightKb.phone} KB phone (kit gate ≤ ${T.weightKb.gate.toLocaleString("en-US")} KB)`,
			verdict: weightKb === undefined ? "unknown" : weightKb <= T.weightKb.measured * 1.5 ? "similar" : "slower",
		},
		{
			metric: "Requests referenced by the HTML",
			prospect: requests === undefined ? "not measured" : String(requests),
			emdash: `${T.requests.measured} on the measured home page`,
			verdict: requests === undefined ? "unknown" : requests <= T.requests.measured * 1.5 ? "similar" : "slower",
		},
		{
			metric: "Modern image formats (WebP / AVIF / SVG)",
			prospect: modernImageShare === undefined ? "no images found" : `${Math.round(modernImageShare * 100)} % of ${images} images`,
			emdash: T.images,
			verdict: modernImageShare === undefined ? "unknown" : modernImageShare >= 0.8 ? "similar" : "slower",
		},
	];
	const notes = [
		"Measured once per page from the machine that ran the estimate, without a browser: weight counts the HTML and the files it references directly (a browser also loads files requested by scripts and stylesheets), so the real figure is higher.",
		`Typical EmDash numbers are the kit's own measurements ${T.measured} (documented in the open-source kit, ${T.source}); they show what the kit achieved there, not a promise for every site. What its automated checks enforce on every migrated site are the gate values in parentheses.`,
	];
	const unknown = ok.reduce((a, p) => a + p.unknownSizes, 0);
	if (unknown) notes.push(`${unknown} referenced file(s) did not report a size (or were beyond the check limit) and are not counted in the weight.`);
	return { pages, ...(ttfbMs !== undefined ? { ttfbMs } : {}), ...(weightKb !== undefined ? { weightKb } : {}), ...(requests !== undefined ? { requests } : {}), imageFormats, ...(modernImageShare !== undefined ? { modernImageShare } : {}), comparisons, ...(extra.lab ? { lab: extra.lab } : {}), ...(extra.field ? { field: extra.field } : {}), notes };
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** PageSpeed Insights (mobile + desktop) for the home page; the key goes only to Google, never into a result. */
export async function labRuns(home: string, key: string, fetcher: Fetcher = fetch): Promise<NonNullable<SpeedSummary["lab"]>> {
	const [mobile, desktop] = await Promise.all([fetchPsi(home, "mobile", key, fetcher), fetchPsi(home, "desktop", key, fetcher)]);
	const out: NonNullable<SpeedSummary["lab"]> = {};
	if (!("missing" in mobile)) out.mobile = mobile as LabRun;
	if (!("missing" in desktop)) out.desktop = desktop as LabRun;
	const missing = "missing" in mobile ? mobile.missing : "missing" in desktop ? desktop.missing : undefined;
	if (missing) out.missing = missing;
	return out;
}

/** CrUX origin-level p75 (28 days of real Chrome visitors). */
export const fieldData = (origin: string, key: string, fetcher: Fetcher = fetch): Promise<Cwv> => fetchCrux(origin, key, fetcher);
