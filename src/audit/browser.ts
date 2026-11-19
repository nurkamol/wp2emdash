import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import type { KitConfig } from "../config/schema.js";
import type { Reporter } from "../core/progress.js";
import { USER_AGENT } from "./http.js";

/** File-safe name for a URL path: "/" → "home", "/about-us/" → "about-us", query → hash suffix. */
export function screenName(url: string): string {
	const u = new URL(url);
	const base = u.pathname.replace(/^\/+|\/+$/g, "").replace(/[^a-z0-9]+/gi, "_").toLowerCase() || "home";
	if (!u.search) return base;
	let h = 0;
	for (const ch of u.search) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
	return `${base}__q${h.toString(36)}`;
}

const FREEZE_CSS = `
*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; transition-delay: 0s !important; caret-color: transparent !important; }
html { scroll-behavior: auto !important; }
`;

const CONSENT_BUTTONS = [
	"#cookie_action_close_header",
	".cky-btn-accept",
	"#onetrust-accept-btn-handler",
	"#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
	".cmplz-accept",
	"#cn-accept-cookie",
	"button:has-text('Accept all')",
	"button:has-text('Accept')",
];

/**
 * Bring a page to a stable, fully painted state before a screenshot. Returns how many images still have no picture
 * (0 when every image loaded and decoded), so a capture with a missing photo is retried or reported, never compared
 * silently as a layout difference.
 */
async function settle(page: Page, maskSelectors: string[]): Promise<number> {
	await page.addStyleTag({ content: FREEZE_CSS }).catch(() => {});
	for (const sel of CONSENT_BUTTONS) {
		const btn = page.locator(sel).first();
		if (await btn.isVisible({ timeout: 200 }).catch(() => false)) {
			await btn.click({ timeout: 1000 }).catch(() => {});
			break;
		}
	}
	// Scroll through the page so lazy images and scroll-triggered (waypoint) animations fire.
	await page.evaluate(async () => {
		const step = Math.max(200, Math.floor(window.innerHeight * 0.8));
		for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
			window.scrollTo(0, y);
			await new Promise((r) => setTimeout(r, 120));
		}
		window.scrollTo(0, 0);
	});
	// A lazy image the browser did not reach while scrolling (busy machine, parallel captures) would stay unloaded once
	// the page is back at the top: ask for every image now.
	await page.evaluate(() => {
		for (const i of Array.from(document.images)) if (i.loading === "lazy") i.loading = "eager";
	});
	await page.evaluate(() => document.fonts?.ready).catch(() => {});
	await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
	// Every image with a source finished (loaded or failed): a cold media fetch (R2 through the Worker) can outlast network idle.
	const allDone = (timeout = 20_000) => page.waitForFunction(() => Array.from(document.images).every((i) => !i.getAttribute("src") || (i.complete && (i.naturalWidth > 0 || i.dataset.wp2Failed === "1"))), undefined, { timeout, polling: 250 }).catch(() => {});
	await allDone();
	// An image that failed (cold fetch, rate limit under parallel captures) gets up to three more requests.
	for (let attempt = 1; attempt <= 4; attempt++) {
		const retried = await page.evaluate((last) => {
			let n = 0;
			for (const i of Array.from(document.images)) {
				if (!i.getAttribute("src") || !i.complete || i.naturalWidth > 0) continue;
				if (last) {
					i.dataset.wp2Failed = "1";
					continue;
				}
				const src = i.src;
				i.removeAttribute("srcset");
				i.src = "";
				i.src = `${src}${src.includes("?") ? "&" : "?"}wp2retry=${Date.now()}`;
				n++;
			}
			return n;
		}, attempt === 4);
		if (!retried) break;
		await page.waitForTimeout(500 * attempt);
		await allDone(8_000);
	}
	// Decoded, not just downloaded: a full-page screenshot can otherwise paint an image that is still decoding as empty.
	await page.evaluate(() => Promise.all(Array.from(document.images).filter((i) => i.complete && i.naturalWidth > 0).map((i) => i.decode().catch(() => {})))).catch(() => {});
	if (maskSelectors.length) {
		await page.addStyleTag({ content: `${maskSelectors.join(",")} { visibility: hidden !important; }` }).catch(() => {});
	}
	// Entrance animations run by script (Salient "fade-in-from-bottom", waypoints) start when an element comes into
	// view. A full-page screenshot enlarges the viewport to the whole page, which would start any not yet triggered
	// at the moment of capture and photograph it mid-move. Show the whole page once, let them finish, then restore.
	const size = page.viewportSize();
	const full = await page.evaluate(() => document.documentElement.scrollHeight).catch(() => 0);
	if (size && full > size.height && full <= 40_000) {
		await page.setViewportSize({ width: size.width, height: full }).catch(() => {});
		await page.waitForTimeout(1500);
		await page.setViewportSize(size).catch(() => {});
		await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
	}
	// Background videos: every capture shows the same frame (the first), so two playing videos are never compared
	// mid-play at different moments.
	await page
		.evaluate(() =>
			Promise.all(
				Array.from(document.querySelectorAll("video")).map(
					(v) =>
						new Promise<void>((done) => {
							v.pause();
							if (v.currentTime === 0 || v.readyState === 0) return done();
							const t = setTimeout(done, 3000);
							v.addEventListener("seeked", () => (clearTimeout(t), done()), { once: true });
							v.currentTime = 0;
						}),
				),
			),
		)
		.catch(() => {});
	await page.waitForTimeout(400);
	return page.evaluate(() => Array.from(document.images).filter((i) => i.getAttribute("src") && !i.getAttribute("src")?.startsWith("data:") && (!i.complete || i.naturalWidth === 0) && i.getBoundingClientRect().width > 1).length).catch(() => 0);
}

export interface SectionBox {
	/** Ordinal among content sections (footer sections counted separately). */
	index: number;
	y: number;
	height: number;
	/** In the site footer / global footer section. */
	footer: boolean;
	/** Which builder's markup matched (wpbakery, gutenberg, elementor, divi, bricks, emdash). */
	kind: string;
	/** Computed padding of the section box, px. */
	padTop?: number;
	padBottom?: number;
}

export interface Rect {
	x: number;
	y: number;
	w: number;
	h: number;
}

/**
 * Regions whose pixels depend on scroll position: parallax layers of the common builders (clipped to
 * the element they move inside) and the starter's [data-motion="parallax"] images.
 */
const MOVING = [
	"[data-motion='parallax']",
	"[data-parallax]", // the kit's own image + text parallax picture
	".parallax-layer", // Salient (rows and columns)
	".row-bg.using-image[data-parallax-speed]", // Salient rows (older)
	".jarallax-img, [data-jarallax] > .jarallax-container",
	".elementor-motion-effects-layer",
	".et_parallax_bg",
	".vc_parallax-inner", // WPBakery core
].join(",");

/** Same flat grey on both sides, so tint, text and layout over a moving photo stay comparable. */
const STILL_CSS = `
.parallax-layer, .row-bg.using-image[data-parallax-speed], .jarallax-container, .elementor-motion-effects-layer, .et_parallax_bg, .vc_parallax-inner { background-image: none !important; background-color: #8a8a8a !important; transform: none !important; }
.jarallax-img, .jarallax-container img { visibility: hidden !important; }
[data-motion='parallax'] { background-color: #8a8a8a !important; }
[data-motion='parallax'] img, [data-motion='parallax'] video, [data-motion='parallax'] picture { visibility: hidden !important; }
[data-parallax] { background-color: #8a8a8a !important; }
[data-parallax] img, [data-parallax] picture { visibility: hidden !important; }`;

export async function movingRegions(page: Page): Promise<Rect[]> {
	return page.evaluate((sel) => {
		const sy = window.scrollY;
		const sx = window.scrollX;
		return Array.from(document.querySelectorAll<HTMLElement>(sel))
			.map((el) => {
				const r = el.getBoundingClientRect();
				const clip = (el.parentElement ?? el).getBoundingClientRect();
				const x1 = Math.max(r.left, clip.left);
				const y1 = Math.max(r.top, clip.top);
				const x2 = Math.min(r.right, clip.right);
				const y2 = Math.min(r.bottom, clip.bottom);
				return { x: Math.round(x1 + sx), y: Math.round(y1 + sy), w: Math.round(x2 - x1), h: Math.round(y2 - y1) };
			})
			.filter((r) => r.w > 20 && r.h > 20);
	}, MOVING);
}

export interface ScreenshotResult {
	url: string;
	viewport: string;
	file?: string;
	height?: number;
	/** Top-level page sections at the moment of the screenshot (for section-by-section comparison). */
	sections?: SectionBox[];
	/** Images that move with scroll (parallax), page coordinates. */
	moving?: Rect[];
	/** Second screenshot with every moving image replaced by flat grey (only when `moving` is set). */
	stillFile?: string;
	/** How far the page scrolls sideways (document wider than the screen), px; 0 when it fits. */
	overflowX?: number;
	/** Images still without a picture when the screenshot was taken (after retries and one reload); omitted when 0. */
	missingImages?: number;
	error?: string;
	consoleErrors: number;
}

/**
 * Outermost section-level blocks of a rendered page, for any of the supported builders and for the
 * wp2emdash starter. Measured in the same render as the screenshot so the boxes line up with it.
 */
export async function sectionBoxes(page: Page): Promise<SectionBox[]> {
	return page.evaluate(() => {
		const kinds: [string, string][] = [
			["section.section", "emdash"],
			[".wpb_row", "wpbakery"],
			[".et_pb_section", "divi"],
			[".elementor-top-section, .e-con.e-parent", "elementor"],
			["section.brxe-section", "bricks"],
			[".entry-content > .alignfull, .entry-content > .wp-block-group, .entry-content > .wp-block-cover", "gutenberg"],
		];
		const all = kinds.flatMap(([sel, kind]) => Array.from(document.querySelectorAll<HTMLElement>(sel)).map((el) => ({ el, kind })));
		const set = new Set(all.map((x) => x.el));
		const outer = all.filter(({ el }) => {
			for (let p = el.parentElement; p; p = p.parentElement) if (set.has(p)) return false;
			return true;
		});
		outer.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
		const isFooter = (el: Element) => !!el.closest("footer, .site-footer, #footer-outer, .nectar-global-section, [data-elementor-type='footer']");
		let content = 0;
		let foot = 0;
		const sy = window.scrollY;
		return outer
			.map(({ el, kind }) => {
				const r = el.getBoundingClientRect();
				const footer = isFooter(el);
				const cs = getComputedStyle(el);
				const box = { index: footer ? foot++ : content++, y: Math.round(r.top + sy), height: Math.round(r.height), footer, kind, padTop: Math.round(Number.parseFloat(cs.paddingTop) || 0), padBottom: Math.round(Number.parseFloat(cs.paddingBottom) || 0) };
				return box;
			})
			.filter((b) => b.height > 0);
	});
}

/** tsx/esbuild wraps named functions with a \`__name\` helper; page.evaluate code runs in the browser, which lacks it. */
const NAME_SHIM = "globalThis.__name = globalThis.__name || ((fn) => fn);";

export async function withBrowser<T>(fn: (b: Browser) => Promise<T>): Promise<T> {
	const browser = await chromium.launch();
	try {
		return await fn(browser);
	} finally {
		await browser.close();
	}
}

export async function captureScreenshots(
	browser: Browser,
	urls: string[],
	config: KitConfig,
	outDir: string,
	reporter: Reporter,
	/**
	 * The source is captured with reduced motion (fewer moving parts); a builder theme's scroll parallax ignores that
	 * setting, while the generated site honours it. The target is therefore captured with motion on, so both show the
	 * same scroll-linked positions.
	 */
	reducedMotion: "reduce" | "no-preference" = "reduce",
): Promise<ScreenshotResult[]> {
	const results: ScreenshotResult[] = [];
	const total = urls.length * config.audit.viewports.length;
	let done = 0;
	reporter.emit({ type: "step:start", step: "Screenshots", total });
	for (const vp of config.audit.viewports) {
		const dir = join(outDir, vp.name);
		mkdirSync(dir, { recursive: true });
		const context = await browser.newContext({ bypassCSP: true, 
			viewport: { width: vp.width, height: vp.height },
			userAgent: `${USER_AGENT} ${vp.name}`,
			reducedMotion,
			deviceScaleFactor: 1,
		});
		await context.addInitScript(NAME_SHIM);
		const queue = [...urls];
		const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
			const page = await context.newPage();
			let consoleErrors = 0;
			page.on("console", (m) => {
				if (m.type() === "error") consoleErrors++;
			});
			while (queue.length) {
				const url = queue.shift() as string;
				consoleErrors = 0;
				const file = join(dir, `${screenName(url)}.png`);
				try {
					await page.goto(url, { waitUntil: "load", timeout: 45_000 });
					let missingImages = await settle(page, config.audit.maskSelectors);
					// A photo that still did not load: one fresh load of the page before the capture counts.
					if (missingImages) {
						await page.reload({ waitUntil: "load", timeout: 45_000 });
						missingImages = await settle(page, config.audit.maskSelectors);
					}
					// Clip to the viewport width: marquees/off-canvas menus can make the document wider than the screen.
					const height = await page.evaluate(() => document.documentElement.scrollHeight);
					// Visible sideways scroll only: content clipped by an overflow:hidden ancestor (off-canvas menus) does not count.
					const overflowX = await page.evaluate(() => Math.max(0, Math.round(document.documentElement.scrollWidth - document.documentElement.clientWidth)));
					const sections = await sectionBoxes(page).catch(() => undefined);
					const moving = await movingRegions(page).catch(() => undefined);
					await page.screenshot({ path: file, fullPage: true, clip: { x: 0, y: 0, width: vp.width, height }, timeout: 60_000 });
					let stillFile: string | undefined;
					if (moving?.length) {
						// Parallax framing depends on scroll position: compare a still copy with the photos greyed out.
						stillFile = join(outDir, "still", vp.name, `${screenName(url)}.png`);
						mkdirSync(dirname(stillFile), { recursive: true });
						const tag = await page.addStyleTag({ content: STILL_CSS });
						await page.waitForTimeout(150);
						await page.screenshot({ path: stillFile, fullPage: true, clip: { x: 0, y: 0, width: vp.width, height }, timeout: 60_000 });
						await tag.evaluate((el) => (el as Element).remove());
					}
					results.push({ url, viewport: vp.name, file, height, ...(sections ? { sections } : {}), ...(moving?.length ? { moving } : {}), ...(stillFile ? { stillFile } : {}), overflowX, ...(missingImages ? { missingImages } : {}), consoleErrors });
				} catch (e) {
					results.push({ url, viewport: vp.name, error: (e as Error).message.split("\n")[0], consoleErrors });
				}
				reporter.emit({ type: "step:progress", step: "Screenshots", done: ++done, total, item: `${vp.name} ${new URL(url).pathname}` });
			}
			await page.close();
		});
		await Promise.all(workers);
		await context.close();
	}
	const failed = results.filter((r) => r.error).length;
	reporter.emit({ type: "step:end", step: "Screenshots", ok: failed === 0, detail: `${results.length - failed}/${total} captured${failed ? `, ${failed} failed` : ""}` });
	return results;
}

export interface FormFieldLook {
	background: string;
	/** "none" or "<width> <style> <colour>" of the bottom border (themes often draw only an underline). */
	border: string;
	borderTop: string;
	radius: number;
	height: number;
	fontSize: number;
	paddingInline: number;
	labelsHidden: boolean;
}

export interface DesignCapture {
	url: string;
	viewport: string;
	fonts: { family: string; count: number }[];
	colors: { value: string; count: number; usage: "text" | "background" | "border" }[];
	/** custom: every visible element of that tag on the page has an element-level size (not the theme's own style). */
	typography: Record<string, { custom?: true; fontFamily: string; fontSize: string; fontWeight: string; lineHeight: string; letterSpacing: string; color: string; textTransform: string } | null>;
	buttons: { selector: string; text: string; styles: Record<string, string> }[];
	containerWidths: { width: number; count: number }[];
	/** Most common left edge of body text and headings in the main content: the page gutter, px. */
	gutter?: number;
	/** Most common corner radius of large photos (img or background-image boxes) in the main content, px. */
	mediaRadius?: number;
	/** Space between consecutive paragraphs (text to text, px): the most common value in the content. */
	paragraphGap?: number;
	/** Space between list items and the item text's offset from the list edge (px), most common in content. */
	listItemGap?: number;
	listIndent?: number;
	breakpoints: number[];
	header: { height: number; position: string; background: string } | null;
	footer: { height: number; background: string; color: string } | null;
	/** First opaque background walking up from the main content area: the page colour sections sit on. */
	pageBackground?: string;
	/** The first visible text field of a content form: its look, and whether its label is visible. */
	formField?: FormFieldLook;
	logo?: { src: string; width: number; height: number };
	favicon?: string;
	cssVariables: Record<string, string>;
}

/** Computed styles from a rendered page: fonts, colour usage, type scale, buttons, layout widths, breakpoints. */
export async function captureDesign(browser: Browser, url: string, viewport: { name: string; width: number; height: number }, maskSelectors: string[]): Promise<DesignCapture> {
	const context = await browser.newContext({ bypassCSP: true, viewport: { width: viewport.width, height: viewport.height }, userAgent: USER_AGENT, reducedMotion: "reduce" });
	await context.addInitScript(NAME_SHIM);
	const page = await context.newPage();
	try {
		await page.goto(url, { waitUntil: "load", timeout: 45_000 });
		await settle(page, maskSelectors);
		const data = await page.evaluate(() => {
			const tally = <K,>(m: Map<K, number>, k: K) => m.set(k, (m.get(k) ?? 0) + 1);
			const fonts = new Map<string, number>();
			const text = new Map<string, number>();
			const bg = new Map<string, number>();
			const border = new Map<string, number>();
			const widths = new Map<number, number>();
			const els = Array.from(document.querySelectorAll<HTMLElement>("body *")).filter((e) => e.offsetWidth > 0 && e.offsetHeight > 0);
			for (const el of els) {
				const cs = getComputedStyle(el);
				if (el.childNodes.length && Array.from(el.childNodes).some((n) => n.nodeType === 3 && n.textContent?.trim())) {
					tally(fonts, cs.fontFamily);
					tally(text, cs.color);
				}
				if (cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent") tally(bg, cs.backgroundColor);
				if (parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== "none") tally(border, cs.borderTopColor);
				if (cs.maxWidth !== "none" && cs.maxWidth.endsWith("px") && (cs.marginLeft === cs.marginRight || cs.marginLeft === "auto")) tally(widths, Math.round(parseFloat(cs.maxWidth)));
			}
			// The usual style of a tag: the most common font size among visible ones, skipping one-off sizes set on a
			// single element (Salient split headings with a custom size, inline font-size).
			const pick = (sel: string) => {
				const all = Array.from(document.querySelectorAll<HTMLElement>(sel)).filter((e) => e.offsetWidth > 0 && e.offsetHeight > 0);
				const plain = all.filter((e) => !e.closest("[data-custom-font-size='true'], [class*='font_size_'], [style*='font-size']"));
				const pool = plain.length ? plain : all;
				// Each distinct text counts once (marquees and sliders repeat the same line many times).
				const sizes = new Map<string, Map<string, HTMLElement>>();
				for (const e of pool) {
					const k = getComputedStyle(e).fontSize;
					const texts = sizes.get(k) ?? new Map<string, HTMLElement>();
					const t = (e.textContent ?? "").trim().slice(0, 80);
					if (!texts.has(t)) texts.set(t, e);
					sizes.set(k, texts);
				}
				const best = [...sizes.values()].sort((a, b) => b.size - a.size)[0];
				const el = best ? [...best.values()][0] : document.querySelector<HTMLElement>(sel);
				if (!el) return null;
				const cs = getComputedStyle(el);
				return {
					count: best?.size ?? 1, ...(plain.length ? {} : { custom: true as const }), fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing, color: cs.color, textTransform: cs.textTransform };
			};
			const typography: Record<string, ReturnType<typeof pick>> = {};
			for (const sel of ["body", "h1", "h2", "h3", "h4", "h5", "h6", "p", "a", "li", "blockquote", "small"]) typography[sel] = pick(sel);

			// Buttons: any link/button that looks like one (filled background or visible border), deduped by style.
			const buttons: { selector: string; text: string; styles: Record<string, string> }[] = [];
			const seenStyles = new Set<string>();
			for (const el of Array.from(document.querySelectorAll<HTMLElement>("a, button, input[type=submit]"))) {
				if (!el.offsetWidth || !el.offsetHeight) continue;
				const cs = getComputedStyle(el);
				const isPaint = (c: string) => c !== "rgba(0, 0, 0, 0)" && c !== "transparent";
				// Themes like Salient paint the button shape on ::before/::after.
				const pseudo = ["::before", "::after"].map((p) => getComputedStyle(el, p)).find((p) => p.content !== "none" && isPaint(p.backgroundColor));
				const filled = isPaint(cs.backgroundColor) || !!pseudo;
				const bordered = parseFloat(cs.borderTopWidth) > 0 && cs.borderTopStyle !== "none";
				if (!filled && !bordered) continue;
				const styles = {
					background: isPaint(cs.backgroundColor) ? cs.backgroundColor : (pseudo?.backgroundColor ?? cs.backgroundColor),
					paintedBy: isPaint(cs.backgroundColor) ? "element" : pseudo ? "pseudo-element" : "border",
					color: cs.color,
					borderRadius: pseudo && cs.borderRadius === "0px" ? pseudo.borderRadius : cs.borderRadius,
					border: `${cs.borderTopWidth} ${cs.borderTopStyle} ${cs.borderTopColor}`,
					padding: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`,
					size: `${el.offsetWidth}×${el.offsetHeight}`,
					fontFamily: cs.fontFamily,
					fontSize: cs.fontSize,
					fontWeight: cs.fontWeight,
					letterSpacing: cs.letterSpacing,
					textTransform: cs.textTransform,
					boxShadow: cs.boxShadow,
					inHeader: el.closest("header, nav, #header-outer, [role=dialog]") ? "yes" : "no",
				};
				const sig = JSON.stringify(styles);
				if (seenStyles.has(sig)) continue;
				seenStyles.add(sig);
				const cls = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean).slice(0, 2).join(".");
				buttons.push({ selector: `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`, text: (el.innerText || (el as HTMLInputElement).value || "").trim().slice(0, 40), styles });
				if (buttons.length >= 8) break;
			}

			const breakpoints = new Set<number>();
			for (const sheet of Array.from(document.styleSheets)) {
				let rules: CSSRuleList | undefined;
				try {
					rules = sheet.cssRules;
				} catch {
					continue;
				}
				for (const r of Array.from(rules ?? [])) {
					if (r instanceof CSSMediaRule) for (const m of r.conditionText.matchAll(/(min|max)-width:\s*([\d.]+)px/g)) breakpoints.add(Math.round(Number(m[2])));
				}
			}

			const firstVisible = (sel: string) => Array.from(document.querySelectorAll<HTMLElement>(sel)).find((e) => e.offsetHeight > 0);
			const header = firstVisible("#header-outer, header, .site-header, #masthead");
			const footer = firstVisible("#footer-outer, footer, .site-footer, #colophon, [class*='footer']");
			const logo = document.querySelector<HTMLImageElement>("#logo img, .logo img, .custom-logo, header img");
			const favicon = document.querySelector<HTMLLinkElement>("link[rel~='icon']")?.href;
			const opaque = (c: string) => c && c !== "transparent" && !/rgba\([^)]*,\s*0\)$/.test(c);
			let pageBackground: string | undefined;
			for (let el: HTMLElement | null = document.querySelector<HTMLElement>("main, #ajax-content-wrap .container-wrap, .container-wrap, #content, .site-content, #page") ?? document.body; el; el = el.parentElement) {
				const c = getComputedStyle(el).backgroundColor;
				if (opaque(c)) {
					pageBackground = c;
					break;
				}
			}

			const cssVariables: Record<string, string> = {};
			const rootCs = getComputedStyle(document.documentElement);
			for (let i = 0; i < rootCs.length; i++) {
				const name = rootCs[i] as string;
				if (name.startsWith("--") && Object.keys(cssVariables).length < 200) cssVariables[name] = rootCs.getPropertyValue(name).trim();
			}

			const top = (m: Map<string, number>, n: number) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
			return {
				fonts: top(fonts, 10).map(([family, count]) => ({ family, count })),
				colors: [
					...top(text, 12).map(([value, count]) => ({ value, count, usage: "text" as const })),
					...top(bg, 12).map(([value, count]) => ({ value, count, usage: "background" as const })),
					...top(border, 6).map(([value, count]) => ({ value, count, usage: "border" as const })),
				],
				typography,
				buttons,
				containerWidths: [...widths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([width, count]) => ({ width, count })),
				...(() => {
					// Gutter: the left edge most text starts at (outside header/footer, within the first fifth of the screen).
					const lefts = new Map<number, number>();
					for (const el of Array.from(document.querySelectorAll<HTMLElement>("p, h1, h2, h3, h4, li"))) {
						if (el.closest("header, footer, nav, #header-outer, #footer-outer, .nectar-global-section, [role=dialog]")) continue;
						const r = el.getBoundingClientRect();
						if (r.width < 40 || r.height === 0 || r.left < 4 || r.left > window.innerWidth / 5) continue;
						const x = Math.round(r.left);
						lefts.set(x, (lefts.get(x) ?? 0) + 1);
					}
					const best = [...lefts.entries()].sort((a, b) => b[1] - a[1])[0];
					return best && best[1] >= 3 ? { gutter: best[0] } : {};
				})(),
				...(() => {
					// Photo corners: the radius a large picture is drawn with (its own, or a clipping ancestor's within 3 levels).
					const radii = new Map<number, number>();
					for (const el of Array.from(document.querySelectorAll<HTMLElement>("main img, #ajax-content-wrap img, [style*='background-image'], .column-image-bg, .row-bg"))) {
						if (el.closest("header, footer, nav, #header-outer, #footer-outer, .nectar-global-section, [role=dialog]")) continue;
						const r = el.getBoundingClientRect();
						if (r.width < 200 || r.height < 150) continue;
						if (el.tagName !== "IMG" && getComputedStyle(el).backgroundImage.indexOf("url(") < 0) continue;
						let radius = Number.parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0;
						let up: HTMLElement | null = el.parentElement;
						for (let i = 0; i < 3 && up && !radius; i++, up = up.parentElement) {
							const cs = getComputedStyle(up);
							if (cs.overflow !== "visible") radius = Number.parseFloat(cs.borderTopLeftRadius) || 0;
						}
						const k = Math.round(radius);
						radii.set(k, (radii.get(k) ?? 0) + 1);
					}
					const best = [...radii.entries()].sort((a, b) => b[1] - a[1])[0];
					return best && best[1] >= 2 ? { mediaRadius: best[0] } : {};
				})(),
				...(() => {
					// Paragraph rhythm: from the end of one paragraph's text to the start of the next sibling's
					// (themes put it in margin or, like Salient, in padding-bottom).
					const gaps = new Map<number, number>();
					for (const el of Array.from(document.querySelectorAll<HTMLElement>("p + p"))) {
						if (el.closest("header, footer, nav, #header-outer, #footer-outer, .nectar-global-section, [role=dialog]")) continue;
						const prev = el.previousElementSibling as HTMLElement | null;
						if (!prev || !prev.offsetHeight || !el.offsetHeight || !(prev.textContent ?? "").trim() || !(el.textContent ?? "").trim()) continue;
						const a = prev.getBoundingClientRect();
						const b = el.getBoundingClientRect();
						const pa = getComputedStyle(prev);
						const pb = getComputedStyle(el);
						const gap = Math.round(b.top + Number.parseFloat(pb.paddingTop) - (a.bottom - Number.parseFloat(pa.paddingBottom)));
						if (gap < 0 || gap > 120) continue;
						gaps.set(gap, (gaps.get(gap) ?? 0) + 1);
					}
					const best = [...gaps.entries()].sort((a, b) => b[1] - a[1])[0];
					return best && best[1] >= 2 ? { paragraphGap: best[0] } : {};
				})(),
				...(() => {
					// List rhythm: space between items and where item text starts relative to the list's edge.
					const gaps = new Map<number, number>();
					const indents = new Map<number, number>();
					for (const li of Array.from(document.querySelectorAll<HTMLElement>("ul > li + li, ol > li + li"))) {
						if (li.closest("header, footer, nav, #header-outer, #footer-outer, .nectar-global-section, [role=dialog], .menu, [class*=menu]")) continue;
						const prev = li.previousElementSibling as HTMLElement | null;
						const list = li.parentElement as HTMLElement;
						if (!prev?.offsetHeight || !li.offsetHeight || !(li.textContent ?? "").trim()) continue;
						const gap = Math.round(li.getBoundingClientRect().top - prev.getBoundingClientRect().bottom);
						if (gap >= 0 && gap <= 60) gaps.set(gap, (gaps.get(gap) ?? 0) + 1);
						const indent = Math.round(li.getBoundingClientRect().left + Number.parseFloat(getComputedStyle(li).paddingLeft) - list.getBoundingClientRect().left);
						if (indent >= 0 && indent <= 80) indents.set(indent, (indents.get(indent) ?? 0) + 1);
					}
					const top = (m: Map<number, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0];
					const g = top(gaps);
					const i = top(indents);
					return { ...(g && g[1] >= 3 ? { listItemGap: g[0] } : {}), ...(i && i[1] >= 3 ? { listIndent: i[0] } : {}) };
				})(),
				breakpoints: [...breakpoints].sort((a, b) => a - b),
				header: header ? { height: header.offsetHeight, position: getComputedStyle(header).position, background: getComputedStyle(header).backgroundColor } : null,
				footer: footer ? { height: footer.offsetHeight, background: getComputedStyle(footer).backgroundColor, color: getComputedStyle(footer).color } : null,
				logo: logo ? { src: logo.currentSrc || logo.src, width: logo.naturalWidth, height: logo.naturalHeight } : undefined,
				favicon,
				...(pageBackground ? { pageBackground } : {}),
				...(() => {
					const input = Array.from(document.querySelectorAll<HTMLInputElement>("form input[type=text], form input[type=email], form input[type=tel]")).find(
						(i) => i.offsetHeight > 20 && i.offsetWidth > 100 && !i.closest("header, nav, #header-outer, [role=search], .search, [class*=search], [class*=newsletter]"),
					);
					if (!input) return {};
					const cs = getComputedStyle(input);
					const line = (w: string, s: string, c: string) => (Number.parseFloat(w) > 0 && s !== "none" ? `${w} ${s} ${c}` : "none");
					const label = (input.id && document.querySelector<HTMLElement>(`label[for="${CSS.escape(input.id)}"]`)) || input.closest("label") || input.closest("[class*=field], [class*=group]")?.querySelector<HTMLElement>("label");
					const lr = label?.getBoundingClientRect();
					const labelsHidden = !label || !lr || lr.width <= 1 || lr.height <= 1 || getComputedStyle(label).visibility === "hidden" || getComputedStyle(label).clipPath === "inset(50%)";
					const formField: FormFieldLook = {
						background: cs.backgroundColor,
						border: line(cs.borderBottomWidth, cs.borderBottomStyle, cs.borderBottomColor),
						borderTop: line(cs.borderTopWidth, cs.borderTopStyle, cs.borderTopColor),
						radius: Math.round(Number.parseFloat(cs.borderTopLeftRadius) || 0),
						height: Math.round(input.getBoundingClientRect().height),
						fontSize: Number.parseFloat(cs.fontSize),
						paddingInline: Math.round(Number.parseFloat(cs.paddingLeft) || 0),
						labelsHidden,
					};
					return { formField };
				})(),
				cssVariables,
			};
		});
		return { url, viewport: viewport.name, ...data };
	} finally {
		await context.close();
	}
}
