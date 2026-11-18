/**
 * Browser checks for verify: visual diff against the audit's screenshots, axe accessibility, lab
 * performance (LCP, CLS, TTFB). Screenshots reuse the audit's capture so masks, frozen animations
 * and viewport sizes are identical on both sides.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import pixelmatch from "pixelmatch";
import { type Browser, chromium } from "playwright";
import { PNG } from "pngjs";

const require = createRequire(import.meta.url);
/** tsx wraps functions with a `__name` helper that does not exist in the page (same shim as the audit). */
const NAME_SHIM = "globalThis.__name = globalThis.__name || ((fn) => fn);";

/** Launch Chromium; pinned hosts (fresh workers.dev names) bypass system DNS and proxies. */
export async function launchFor(pins: { host: string; addresses: string[] }[]): Promise<Browser> {
	const rules = pins.filter((p) => p.addresses[0]).map((p) => `MAP ${p.host} ${p.addresses[0]}`);
	return chromium.launch({ args: rules.length ? ["--no-proxy-server", `--host-resolver-rules=${rules.join(", ")}`] : [] });
}

export interface VisualResult {
	ratio: number;
	comparedHeight: number;
	sourceHeight: number;
	targetHeight: number;
	diffFile?: string;
	error?: string;
}

/**
 * Pixel difference over the overlapping area (same width, up to the shorter height, max 12 000 px).
 * Height differences are reported separately: a page that grew or shrank is a layout change of its own.
 */
export function visualDiff(sourcePng: string, targetPng: string, diffOut: string): VisualResult {
	try {
		const a = PNG.sync.read(readFileSync(sourcePng));
		const b = PNG.sync.read(readFileSync(targetPng));
		const w = Math.min(a.width, b.width);
		const h = Math.min(a.height, b.height, 12_000);
		const crop = (img: PNG) => {
			const out = new PNG({ width: w, height: h });
			for (let y = 0; y < h; y++) img.data.copy(out.data, y * w * 4, y * img.width * 4, y * img.width * 4 + w * 4);
			return out;
		};
		const ca = crop(a);
		const cb = crop(b);
		const diff = new PNG({ width: w, height: h });
		const n = pixelmatch(ca.data, cb.data, diff.data, w, h, { threshold: 0.15, includeAA: false, alpha: 0.25 });
		mkdirSync(dirname(diffOut), { recursive: true });
		writeFileSync(diffOut, PNG.sync.write(diff));
		return { ratio: n / (w * h), comparedHeight: h, sourceHeight: a.height, targetHeight: b.height, diffFile: diffOut };
	} catch (e) {
		return { ratio: 1, comparedHeight: 0, sourceHeight: 0, targetHeight: 0, error: (e as Error).message };
	}
}

export interface A11yResult {
	url: string;
	serious: { id: string; impact: string; help: string; nodes: number }[];
	moderate: number;
	error?: string;
}

const AXE_SOURCE = () => readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

export async function accessibility(browser: Browser, url: string): Promise<A11yResult> {
	const page = await browser.newPage({ bypassCSP: true,  viewport: { width: 1440, height: 900 } });
	await page.addInitScript(NAME_SHIM);
	try {
		await page.goto(url, { waitUntil: "load", timeout: 60_000 });
		await page.addScriptTag({ content: AXE_SOURCE() });
		const r = (await page.evaluate(async () => {
			const axe = (window as unknown as { axe: { run: (ctx: Document, opts: unknown) => Promise<{ violations: { id: string; impact: string; help: string; nodes: unknown[] }[] }> } }).axe;
			return axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] });
		})) as { violations: { id: string; impact: string; help: string; nodes: unknown[] }[] };
		return {
			url,
			serious: r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length })),
			moderate: r.violations.filter((v) => v.impact === "moderate" || v.impact === "minor").length,
		};
	} catch (e) {
		return { url, serious: [], moderate: 0, error: (e as Error).message.split("\n")[0] };
	} finally {
		await page.close();
	}
}

export interface PerfResult {
	url: string;
	ttfbMs?: number;
	lcpMs?: number;
	cls?: number;
	transferKb?: number;
	error?: string;
}

/** Lab metrics on a phone-sized viewport (no throttling): an early signal, not a Lighthouse score. */
export async function measurePerformance(browser: Browser, url: string): Promise<PerfResult> {
	const ctx = await browser.newContext({ bypassCSP: true, viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true });
	const page = await ctx.newPage();
	await page.addInitScript(NAME_SHIM);
	await page.addInitScript(() => {
		const w = window as unknown as { __lcp: number; __cls: number };
		w.__lcp = 0;
		w.__cls = 0;
		new PerformanceObserver((l) => {
			for (const e of l.getEntries()) w.__lcp = e.startTime;
		}).observe({ type: "largest-contentful-paint", buffered: true });
		new PerformanceObserver((l) => {
			for (const e of l.getEntries() as unknown as { value: number; hadRecentInput: boolean }[]) if (!e.hadRecentInput) w.__cls += e.value;
		}).observe({ type: "layout-shift", buffered: true });
	});
	try {
		await page.goto(url, { waitUntil: "load", timeout: 60_000 });
		await page.waitForTimeout(2500);
		const m = await page.evaluate(() => {
			const w = window as unknown as { __lcp: number; __cls: number };
			const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
			const res = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
			const bytes = res.reduce((n, r) => n + (r.transferSize || 0), nav?.transferSize ?? 0);
			return { ttfb: nav ? nav.responseStart - nav.requestStart : undefined, lcp: w.__lcp, cls: w.__cls, kb: bytes / 1024 };
		});
		return { url, ...(m.ttfb !== undefined ? { ttfbMs: Math.round(m.ttfb) } : {}), lcpMs: Math.round(m.lcp), cls: Math.round(m.cls * 1000) / 1000, transferKb: Math.round(m.kb) };
	} catch (e) {
		return { url, error: (e as Error).message.split("\n")[0] };
	} finally {
		await ctx.close();
	}
}
