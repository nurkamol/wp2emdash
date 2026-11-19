/**
 * EmDash's media library refuses SVG (a fixed upload allow-list: SVGs can carry scripts). An SVG used in content is
 * drawn to a PNG at load: 4× its natural size, at most 1200px on its long side (sharp for a logo up to 600 CSS px on
 * 2× screens; 3000px made a 570 KB footer logo), transparent background, rendered as an <img> in headless
 * Chromium — where scripts inside the SVG never run — so a logo stays sharp on high-density screens.
 */
import type { Browser } from "playwright";

export function svgSize(svg: string): { width: number; height: number } {
	const num = (v: string | undefined) => (v && /^\s*[\d.]+(px)?\s*$/.test(v) ? Number.parseFloat(v) : undefined);
	const tag = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? "";
	const attr = (n: string) => new RegExp(`\\b${n}\\s*=\\s*["']([^"']+)["']`, "i").exec(tag)?.[1];
	const vb = attr("viewBox")?.trim().split(/[\s,]+/).map(Number);
	const w = num(attr("width")) ?? (vb && vb.length === 4 ? vb[2] : undefined) ?? 300;
	const h = num(attr("height")) ?? (vb && vb.length === 4 ? vb[3] : undefined) ?? 150;
	return { width: Math.max(1, w), height: Math.max(1, h) };
}

export async function svgToPng(svg: Buffer, browser: Browser, scale = 4, maxSide = 1200): Promise<Buffer> {
	const { width, height } = svgSize(svg.toString("utf8"));
	const k = Math.min(scale, maxSide / Math.max(width, height));
	const w = Math.max(1, Math.round(width * k));
	const h = Math.max(1, Math.round(height * k));
	const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
	try {
		const src = `data:image/svg+xml;base64,${svg.toString("base64")}`;
		await page.setContent(`<html><body style="margin:0;background:transparent"><img id="i" src="${src}" style="display:block;width:${w}px;height:${h}px"></body></html>`);
		await page.waitForFunction(() => (document.getElementById("i") as HTMLImageElement | null)?.complete === true, undefined, { timeout: 10_000 });
		return await page.locator("#i").screenshot({ omitBackground: true, type: "png" });
	} finally {
		await page.close();
	}
}
