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
	/** `where`: the first elements (selector, and for contrast the colours and ratio), so the report says what to fix. */
	serious: { id: string; impact: string; help: string; nodes: number; where?: string[] }[];
	moderate: number;
	/** Serious issues inside third-party embeds (booking widgets…): reported, not gated — the site can't change them. */
	thirdParty?: { id: string; nodes: number }[];
	error?: string;
}

/** The first elements of an axe violation: selector, and for colour contrast the colours and the ratio axe measured. */
export function axeWhere(nodes: unknown[], max = 3): string[] {
	return (nodes as { target?: unknown[]; any?: { data?: { fgColor?: string; bgColor?: string; contrastRatio?: number; expectedContrastRatio?: string } }[] }[]).slice(0, max).map((n) => {
		const sel = (n.target ?? []).map(String).join(" ") || "?";
		const d = n.any?.find((x) => x.data?.fgColor)?.data;
		return d ? `${sel} (${d.fgColor} on ${d.bgColor}, ${d.contrastRatio}:1, needs ${d.expectedContrastRatio})` : sel;
	});
}

const AXE_SOURCE = () => readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

export async function accessibility(browser: Browser, url: string): Promise<A11yResult> {
	// Reduced motion: content is checked in its final state, not halfway through a fade-in (half-transparent text
	// would read as low contrast).
	const page = await browser.newPage({ bypassCSP: true, reducedMotion: "reduce", viewport: { width: 1440, height: 900 } });
	await page.addInitScript(NAME_SHIM);
	try {
		await page.goto(url, { waitUntil: "load", timeout: 60_000 });
		// The site's consent banner is part of the page under test: in mode "auto" it appears once the region answer is
		// back, so wait for it briefly (a fresh page has no stored choice).
		if (await page.locator('meta[name="site-consent"]').count()) await page.waitForSelector("[data-consent-banner]:not([hidden])", { timeout: 3000 }).catch(() => {});
		await page.addScriptTag({ content: AXE_SOURCE() });
		type Axe = { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string; impact: string; help: string; nodes: unknown[] }[] }> };
		const opts = { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] };
		// Excluded from the gate: third-party embeds (checked separately below) and a transparent header over a
		// media hero — axe can't see through the video, so that header is checked by the overlay rule instead.
		const EMBEDS = ".section--embed";
		const r = (await page.evaluate(
			async ([o, embeds]) => (window as unknown as { axe: Axe }).axe.run({ exclude: [[embeds], [".over-hero .site-header.is-transparent"]] }, o),
			[opts, EMBEDS] as const,
		)) as { violations: { id: string; impact: string; help: string; nodes: unknown[] }[] };
		const tp = (await page.evaluate(
			async ([o, embeds]) => (document.querySelector(embeds) ? (window as unknown as { axe: Axe }).axe.run({ include: [[embeds]] }, o) : { violations: [] }),
			[opts, EMBEDS] as const,
		)) as { violations: { id: string; impact: string; nodes: unknown[] }[] };
		// White text in a transparent header over a media hero: the hero's overlay must be dark enough (≥ 50% black
		// gives ≥ 4.5:1 for white text over any image).
		const overlay = await page.evaluate(() => {
			if (!document.querySelector(".over-hero .site-header.is-transparent")) return undefined;
			const o = document.querySelector<HTMLElement>(".section--hero .section__overlay");
			return o ? Number(getComputedStyle(o).opacity) : 0;
		});
		const serious: A11yResult["serious"] = r.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.length, where: axeWhere(v.nodes) }));
		if (overlay !== undefined && overlay < 0.5) serious.push({ id: "header-over-media-contrast", impact: "serious", help: `Transparent header over a media hero needs an overlay of at least 50% (is ${Math.round(overlay * 100)}%)`, nodes: 1 });
		const thirdParty = tp.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => ({ id: v.id, nodes: v.nodes.length }));
		return {
			url,
			serious,
			moderate: r.violations.filter((v) => v.impact === "moderate" || v.impact === "minor").length,
			...(thirdParty.length ? { thirdParty } : {}),
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
