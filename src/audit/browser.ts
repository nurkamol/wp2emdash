import { mkdirSync } from "node:fs";
import { join } from "node:path";
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

async function settle(page: Page, maskSelectors: string[]): Promise<void> {
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
	await page.evaluate(() => document.fonts?.ready).catch(() => {});
	await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
	if (maskSelectors.length) {
		await page.addStyleTag({ content: `${maskSelectors.join(",")} { visibility: hidden !important; }` }).catch(() => {});
	}
	await page.waitForTimeout(400);
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

export interface ScreenshotResult {
	url: string;
	viewport: string;
	file?: string;
	height?: number;
	/** Top-level page sections at the moment of the screenshot (for section-by-section comparison). */
	sections?: SectionBox[];
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
): Promise<ScreenshotResult[]> {
	const results: ScreenshotResult[] = [];
	const total = urls.length * config.audit.viewports.length;
	let done = 0;
	reporter.emit({ type: "step:start", step: "Screenshots", total });
	for (const vp of config.audit.viewports) {
		const dir = join(outDir, vp.name);
		mkdirSync(dir, { recursive: true });
		const context = await browser.newContext({
			viewport: { width: vp.width, height: vp.height },
			userAgent: `${USER_AGENT} ${vp.name}`,
			reducedMotion: "reduce",
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
					await settle(page, config.audit.maskSelectors);
					// Clip to the viewport width: marquees/off-canvas menus can make the document wider than the screen.
					const height = await page.evaluate(() => document.documentElement.scrollHeight);
					const sections = await sectionBoxes(page).catch(() => undefined);
					await page.screenshot({ path: file, fullPage: true, clip: { x: 0, y: 0, width: vp.width, height }, timeout: 60_000 });
					results.push({ url, viewport: vp.name, file, height, ...(sections ? { sections } : {}), consoleErrors });
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

export interface DesignCapture {
	url: string;
	viewport: string;
	fonts: { family: string; count: number }[];
	colors: { value: string; count: number; usage: "text" | "background" | "border" }[];
	typography: Record<string, { fontFamily: string; fontSize: string; fontWeight: string; lineHeight: string; letterSpacing: string; color: string; textTransform: string } | null>;
	buttons: { selector: string; text: string; styles: Record<string, string> }[];
	containerWidths: { width: number; count: number }[];
	breakpoints: number[];
	header: { height: number; position: string; background: string } | null;
	footer: { height: number; background: string; color: string } | null;
	/** First opaque background walking up from the main content area: the page colour sections sit on. */
	pageBackground?: string;
	logo?: { src: string; width: number; height: number };
	favicon?: string;
	cssVariables: Record<string, string>;
}

/** Computed styles from a rendered page: fonts, colour usage, type scale, buttons, layout widths, breakpoints. */
export async function captureDesign(browser: Browser, url: string, viewport: { name: string; width: number; height: number }, maskSelectors: string[]): Promise<DesignCapture> {
	const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, userAgent: USER_AGENT, reducedMotion: "reduce" });
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
			const pick = (sel: string) => {
				const el = document.querySelector<HTMLElement>(sel);
				if (!el) return null;
				const cs = getComputedStyle(el);
				return { fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontWeight: cs.fontWeight, lineHeight: cs.lineHeight, letterSpacing: cs.letterSpacing, color: cs.color, textTransform: cs.textTransform };
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
				breakpoints: [...breakpoints].sort((a, b) => a - b),
				header: header ? { height: header.offsetHeight, position: getComputedStyle(header).position, background: getComputedStyle(header).backgroundColor } : null,
				footer: footer ? { height: footer.offsetHeight, background: getComputedStyle(footer).backgroundColor, color: getComputedStyle(footer).color } : null,
				logo: logo ? { src: logo.currentSrc || logo.src, width: logo.naturalWidth, height: logo.naturalHeight } : undefined,
				favicon,
				...(pageBackground ? { pageBackground } : {}),
				cssVariables,
			};
		});
		return { url, viewport: viewport.name, ...data };
	} finally {
		await context.close();
	}
}
