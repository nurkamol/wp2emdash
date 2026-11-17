import { mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { USER_AGENT } from "./http.js";

/**
 * Interaction capture: records how the navigation menu and header behave so the
 * starter can reproduce them (same panel, same motion) and verify can replay them.
 * Runs WITHOUT reduced motion or frozen transitions — we want the real animations.
 */

export interface AnimationSpec {
	target: string;
	kind: "transition" | "animation" | "other";
	/** CSS property for transitions, animation-name for keyframe animations. */
	name: string;
	durationMs: number;
	delayMs: number;
	easing: string;
	iterations: number | "infinite";
	keyframes: Record<string, string | number | null>[];
}

export interface MenuCapture {
	viewport: string;
	url: string;
	found: boolean;
	toggle?: {
		selector: string;
		label: string;
		rect: { x: number; y: number; width: number; height: number };
		ariaExpandedBefore: string | null;
		ariaExpandedAfter: string | null;
		ariaControls: string | null;
		isButton: boolean;
	};
	panel?: {
		selector: string;
		type: "off-canvas-left" | "off-canvas-right" | "fullscreen" | "dropdown" | "unknown";
		rect: { x: number; y: number; width: number; height: number };
		background: string;
		zIndex: string;
	};
	overlay?: { selector: string; background: string; opacity: string };
	items: { text: string; href: string; depth: number }[];
	itemStyle?: { fontFamily: string; fontSize: string; fontWeight: string; color: string; letterSpacing: string; textTransform: string; lineHeight: string };
	animations: AnimationSpec[];
	/** Total time until every animation started by the click finished. */
	openDurationMs?: number;
	behaviour: {
		bodyScrollLocked: boolean;
		focusMovedIntoPanel: boolean;
		escCloses: boolean;
		toggleClosesAgain: boolean;
		closeButton?: string;
	};
	files: { closed?: string; open?: string; frames: string[]; video?: string };
	/** Theme motion/menu settings exposed as data-* on <body> (Salient: menu style, easing, durations, hide-on-scroll…). */
	themeSettings: Record<string, string>;
	error?: string;
}

export interface HeaderScrollCapture {
	viewport: string;
	top: HeaderState;
	scrolled: HeaderState;
	changes: string[];
	files: { top?: string; scrolled?: string };
}

interface HeaderState {
	height: number;
	position: string;
	background: string;
	boxShadow: string;
	logoSrc?: string;
	logoHeight?: number;
	color: string;
	transform: string;
}

const NAME_SHIM = "globalThis.__name = globalThis.__name || ((fn) => fn);";

/** Common burger/toggle selectors across themes (Salient, Astra, GeneratePress, Divi, Elementor, Bricks, Kadence, block themes). */
const TOGGLE_SELECTORS = [
	".slide-out-widget-area-toggle a",
	".slide-out-widget-area-toggle",
	"#mobile-toggle",
	"button[aria-controls][aria-expanded]",
	"[aria-controls][aria-expanded]",
	".menu-toggle",
	".mobile-menu-toggle",
	".wp-block-navigation__responsive-container-open",
	".elementor-menu-toggle",
	".brxe-nav-menu .bricks-mobile-menu-toggle",
	".et_mobile_nav_menu .mobile_menu_bar",
	".ast-mobile-menu-trigger-minimal, .menu-toggle.main-header-menu-toggle",
	".hamburger, [class*='hamburger']",
	"[class*='burger']",
	"a[aria-label*='menu' i], button[aria-label*='menu' i]",
];

/** First *visible* match: themes often render several toggles (desktop nav, mobile icon, hidden clones). */
async function findToggle(page: Page): Promise<{ sel: string; index: number } | undefined> {
	for (const sel of TOGGLE_SELECTORS) {
		const all = page.locator(sel);
		const n = Math.min(await all.count().catch(() => 0), 10);
		for (let i = 0; i < n; i++) {
			if (await all.nth(i).isVisible().catch(() => false)) return { sel, index: i };
		}
	}
	return undefined;
}

export async function captureMenu(browser: Browser, url: string, viewport: { name: string; width: number; height: number }, outDir: string): Promise<MenuCapture> {
	const dir = join(outDir, viewport.name);
	mkdirSync(dir, { recursive: true });
	const context = await browser.newContext({
		viewport: { width: viewport.width, height: viewport.height },
		userAgent: USER_AGENT,
		recordVideo: { dir, size: { width: viewport.width, height: viewport.height } },
	});
	await context.addInitScript(NAME_SHIM);
	const page = await context.newPage();
	const result: MenuCapture = {
		viewport: viewport.name,
		url,
		found: false,
		items: [],
		animations: [],
		behaviour: { bodyScrollLocked: false, focusMovedIntoPanel: false, escCloses: false, toggleClosesAgain: false },
		files: { frames: [] },
		themeSettings: {},
	};
	try {
		await page.goto(url, { waitUntil: "load", timeout: 45_000 });
		await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
		await page.waitForTimeout(800);

		result.themeSettings = await page.evaluate(() => ({ ...document.body.dataset }) as Record<string, string>);
		const hit = await findToggle(page);
		if (!hit) return result;
		result.found = true;
		const sel = hit.index ? `${hit.sel} >> nth=${hit.index}` : hit.sel;
		const toggle = page.locator(hit.sel).nth(hit.index);

		// Mark elements that are visible before opening, so we can find what appeared.
		await page.evaluate(() => {
			for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
				const r = el.getBoundingClientRect();
				const cs = getComputedStyle(el);
				if (r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && Number(cs.opacity) > 0.05) el.dataset.w2eVisibleBefore = "1";
			}
		});

		const before = await toggle.evaluate((el) => {
			const r = el.getBoundingClientRect();
			const btn = el.closest("button, a, [role='button']") ?? el;
			return {
				label: ((el as HTMLElement).innerText || el.getAttribute("aria-label") || "").trim().slice(0, 40),
				rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
				ariaExpanded: btn.getAttribute("aria-expanded"),
				ariaControls: btn.getAttribute("aria-controls"),
				isButton: btn.tagName === "BUTTON" || btn.getAttribute("role") === "button",
			};
		});

		result.files.closed = join(dir, "menu-closed.png");
		await page.screenshot({ path: result.files.closed });

		// Click, then sample animations on the next frames and take timed frames.
		const t0 = Date.now();
		await toggle.click({ timeout: 3000 });
		await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
		const animations = await page.evaluate(() => {
			const describe = (el: Element | null) => {
				if (!el) return "?";
				const id = el.id ? `#${el.id}` : "";
				const cls = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean).slice(0, 3).map((c) => `.${c}`).join("");
				return `${el.tagName.toLowerCase()}${id}${cls}`;
			};
			return document.getAnimations().map((a) => {
				const effect = a.effect as KeyframeEffect | null;
				const timing = effect?.getComputedTiming();
				const anyA = a as Animation & { transitionProperty?: string; animationName?: string };
				return {
					target: describe(effect?.target ?? null),
					kind: anyA.transitionProperty ? "transition" : anyA.animationName ? "animation" : "other",
					name: anyA.transitionProperty ?? anyA.animationName ?? "",
					durationMs: Number(timing?.duration ?? 0),
					delayMs: Number(timing?.delay ?? 0),
					easing: String(effect?.getTiming().easing ?? "linear"),
					iterations: timing?.iterations === Number.POSITIVE_INFINITY ? "infinite" : Number(timing?.iterations ?? 1),
					keyframes: (effect?.getKeyframes() ?? []).map((k) => {
						const out: Record<string, string | number | null> = {};
						for (const [key, v] of Object.entries(k)) if (!["composite", "computedOffset"].includes(key)) out[key] = v as string | number | null;
						return out;
					}),
				};
			});
		});
		// Ignore infinite animations (marquees, spinners) — they are not part of the menu motion.
		result.animations = (animations as AnimationSpec[]).filter((a) => a.iterations !== "infinite" && a.durationMs > 0);

		for (const ms of [80, 180, 320]) {
			const wait = t0 + ms - Date.now();
			if (wait > 0) await page.waitForTimeout(wait);
			const f = join(dir, `menu-frame-${ms}ms.png`);
			await page.screenshot({ path: f });
			result.files.frames.push(f);
		}
		const finished = await page.evaluate(
			() =>
				Promise.race([
					Promise.all(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Number.POSITIVE_INFINITY).map((a) => a.finished.catch(() => null))).then(() => true),
					new Promise((r) => setTimeout(() => r(false), 4000)),
				]) as Promise<boolean>,
		);
		result.openDurationMs = finished ? Date.now() - t0 : undefined;
		await page.waitForTimeout(150);
		result.files.open = join(dir, "menu-open.png");
		await page.screenshot({ path: result.files.open });

		const open = await page.evaluate(() => {
			const describe = (el: Element) => {
				const id = el.id ? `#${el.id}` : "";
				const cls = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean).slice(0, 3).map((c) => `.${c}`).join("");
				return `${el.tagName.toLowerCase()}${id}${cls}`;
			};
			const vw = window.innerWidth;
			const vh = window.innerHeight;
			const appeared = Array.from(document.querySelectorAll<HTMLElement>("body *")).filter((el) => {
				if (el.dataset.w2eVisibleBefore) return false;
				const r = el.getBoundingClientRect();
				const cs = getComputedStyle(el);
				return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && Number(cs.opacity) > 0.05;
			});
			const fixedOrAbs = (el: HTMLElement) => ["fixed", "absolute"].includes(getComputedStyle(el).position);
			// Panel: the largest newly visible fixed/absolute element that contains links.
			const candidates = appeared.filter((el) => fixedOrAbs(el) && el.querySelector("a"));
			candidates.sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height);
			let panel = candidates[0];
			// Some themes keep the panel in the DOM but move it on-screen: fall back to any fixed element with links now inside the viewport.
			panel ??= Array.from(document.querySelectorAll<HTMLElement>("body *")).find((el) => {
				const r = el.getBoundingClientRect();
				return getComputedStyle(el).position === "fixed" && el.querySelector("a") && r.width > vw * 0.4 && r.height > vh * 0.5 && r.x >= -2 && r.x < vw;
			});
			const overlayEl = appeared.find((el) => {
				const r = el.getBoundingClientRect();
				const cs = getComputedStyle(el);
				return el !== panel && cs.position === "fixed" && r.width >= vw * 0.95 && r.height >= vh * 0.95 && !el.querySelector("a") && cs.backgroundColor !== "rgba(0, 0, 0, 0)";
			});

			let panelInfo = null;
			let items: { text: string; href: string; depth: number }[] = [];
			let itemStyle = null;
			if (panel) {
				const r = panel.getBoundingClientRect();
				const cs = getComputedStyle(panel);
				const type =
					r.width >= vw * 0.9 && r.height >= vh * 0.9 ? "fullscreen" : r.height >= vh * 0.8 ? (r.x + r.width / 2 > vw / 2 ? "off-canvas-right" : "off-canvas-left") : r.y < vh * 0.4 ? "dropdown" : "unknown";
				panelInfo = { selector: describe(panel), type, rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }, background: cs.backgroundColor, zIndex: cs.zIndex };
				// Laid-out links (collapsed sub-menus included, whether hidden by height or by visibility);
				// textContent, not innerText, so visibility-hidden and visually-hidden labels still count.
				const linkText = (a: HTMLElement) => (a.textContent ?? "").trim().replace(/\s+/g, " ");
				const links = Array.from(panel.querySelectorAll<HTMLAnchorElement>("a")).filter((a) => a.offsetWidth > 0 && linkText(a));
				items = links.map((a) => {
					let depth = 0;
					for (let p = a.parentElement; p && p !== panel; p = p.parentElement) if (p.tagName === "UL" || p.tagName === "OL") depth++;
					return { text: linkText(a).slice(0, 60), href: a.getAttribute("href") ?? "", depth: Math.max(0, depth - 1) };
				});
				const first = links[0];
				if (first) {
					const s = getComputedStyle(first);
					itemStyle = { fontFamily: s.fontFamily, fontSize: s.fontSize, fontWeight: s.fontWeight, color: s.color, letterSpacing: s.letterSpacing, textTransform: s.textTransform, lineHeight: s.lineHeight };
				}
			}
			const lock = (el: Element) => {
				const cs = getComputedStyle(el);
				return cs.overflow === "hidden" || cs.overflowY === "hidden" || cs.position === "fixed";
			};
			const active = document.activeElement;
			return {
				panel: panelInfo,
				overlay: overlayEl ? { selector: describe(overlayEl), background: getComputedStyle(overlayEl).backgroundColor, opacity: getComputedStyle(overlayEl).opacity } : undefined,
				items,
				itemStyle,
				bodyScrollLocked: lock(document.body) || lock(document.documentElement),
				focusMovedIntoPanel: !!(panel && active && panel.contains(active)),
				closeButton: panel ? (Array.from(panel.querySelectorAll("button, a")).find((b) => /close|×|✕/i.test((b as HTMLElement).innerText + (b.getAttribute("aria-label") ?? "") + (b.getAttribute("class") ?? ""))) as HTMLElement | undefined)?.outerHTML.slice(0, 120) : undefined,
			};
		});
		if (open.panel) result.panel = open.panel as MenuCapture["panel"];
		result.overlay = open.overlay;
		result.items = open.items;
		result.itemStyle = open.itemStyle ?? undefined;
		result.behaviour.bodyScrollLocked = open.bodyScrollLocked;
		result.behaviour.focusMovedIntoPanel = open.focusMovedIntoPanel;
		result.behaviour.closeButton = open.closeButton;

		const ariaAfter = await toggle.evaluate((el) => (el.closest("button, a, [role='button']") ?? el).getAttribute("aria-expanded")).catch(() => null);
		result.toggle = { selector: sel, label: before.label, rect: before.rect, ariaExpandedBefore: before.ariaExpanded, ariaExpandedAfter: ariaAfter, ariaControls: before.ariaControls, isButton: before.isButton };

		// Esc closes?
		const panelSel = result.panel?.selector;
		const panelVisible = async () =>
			page.evaluate((s) => {
				if (!s) return false;
				const el = document.querySelector(s.replace(/\.([^.#]*[^a-zA-Z0-9_.#-][^.#]*)/g, ""));
				if (!el) return false;
				const r = el.getBoundingClientRect();
				const cs = getComputedStyle(el);
				return r.width > 0 && r.height > 0 && r.x < window.innerWidth && r.right > 0 && cs.visibility !== "hidden" && Number(cs.opacity) > 0.05;
			}, panelSel);
		await page.keyboard.press("Escape");
		await page.waitForTimeout(900);
		result.behaviour.escCloses = !(await panelVisible());
		if (!result.behaviour.escCloses) {
			await toggle.click({ timeout: 3000, force: true }).catch(() => {});
			await page.waitForTimeout(900);
			result.behaviour.toggleClosesAgain = !(await panelVisible());
		} else {
			result.behaviour.toggleClosesAgain = true;
		}
	} catch (e) {
		result.error = (e as Error).message.split("\n")[0];
	} finally {
		const video = page.video();
		await context.close();
		if (video) {
			const target = join(dir, "menu.webm");
			try {
				renameSync(await video.path(), target);
				result.files.video = target;
			} catch {
				/* video optional */
			}
		}
	}
	return result;
}

export async function captureHeaderScroll(browser: Browser, url: string, viewport: { name: string; width: number; height: number }, outDir: string): Promise<HeaderScrollCapture | undefined> {
	const dir = join(outDir, viewport.name);
	mkdirSync(dir, { recursive: true });
	const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, userAgent: USER_AGENT });
	await context.addInitScript(NAME_SHIM);
	const page = await context.newPage();
	try {
		await page.goto(url, { waitUntil: "load", timeout: 45_000 });
		await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
		const state = () =>
			page.evaluate(() => {
				const header = Array.from(document.querySelectorAll<HTMLElement>("#header-outer, header, .site-header, #masthead")).find((e) => e.offsetHeight > 0);
				if (!header) return null;
				const cs = getComputedStyle(header);
				const logo = header.querySelector<HTMLImageElement>("img");
				const visibleLogo = Array.from(header.querySelectorAll<HTMLImageElement>("img")).find((i) => i.offsetWidth > 0 && getComputedStyle(i).opacity !== "0") ?? logo;
				return {
					height: header.offsetHeight,
					position: cs.position,
					background: cs.backgroundColor,
					boxShadow: cs.boxShadow,
					logoSrc: visibleLogo?.currentSrc || visibleLogo?.src,
					logoHeight: visibleLogo?.offsetHeight,
					color: getComputedStyle(header.querySelector("a") ?? header).color,
					transform: cs.transform,
				};
			});
		const top = await state();
		if (!top) return undefined;
		const files: HeaderScrollCapture["files"] = { top: join(dir, "header-top.png"), scrolled: join(dir, "header-scrolled.png") };
		await page.screenshot({ path: files.top, clip: { x: 0, y: 0, width: viewport.width, height: Math.min(viewport.height, Math.max(120, top.height + 40)) } });
		await page.mouse.wheel(0, 900);
		await page.waitForTimeout(1200);
		const scrolled = (await state()) ?? top;
		await page.screenshot({ path: files.scrolled, clip: { x: 0, y: 0, width: viewport.width, height: Math.min(viewport.height, Math.max(120, scrolled.height + 40)) } });
		const changes = (Object.keys(top) as (keyof HeaderState)[]).filter((k) => top[k] !== scrolled[k]).map((k) => `${k}: ${top[k]} → ${scrolled[k]}`);
		return { viewport: viewport.name, top, scrolled, changes, files };
	} finally {
		await context.close();
	}
}

export interface MotionRecipe {
	panelType?: string;
	overlay?: { durationMs: number; easing: string; background?: string; opacity?: string };
	icon?: { durationMs: number; easing: string; staggerMs: number };
	items?: { properties: string[]; durationMs: number; easing: string; startDelayMs: number; staggerMs: number; count: number };
	totalMs?: number;
}

/**
 * Condenses raw animation records into the handful of numbers a header component needs:
 * overlay fade, burger icon morph, and the menu-item reveal (duration, easing, first delay, stagger step).
 */
export function motionRecipe(raw: MenuCapture): MotionRecipe {
	// Browsers report delays like 300.00000000000006 ms: round to whole milliseconds first.
	const m = { ...raw, animations: raw.animations.map((a) => ({ ...a, durationMs: Math.round(a.durationMs), delayMs: Math.round(a.delayMs) })) };
	const recipe: MotionRecipe = { panelType: m.panel?.type, totalMs: m.openDurationMs };
	const overlay = m.animations.find((a) => a.name === "opacity" && /widget-area-bg|overlay|backdrop|-bg\b/i.test(a.target));
	if (overlay) recipe.overlay = { durationMs: overlay.durationMs, easing: overlay.easing, background: m.overlay?.background, opacity: m.overlay?.opacity };

	const icon = m.animations.filter((a) => a.name === "transform" && /lines|burger|hamburger|toggle|icon/i.test(a.target));
	if (icon[0]) {
		const delays = [...new Set(icon.map((a) => a.delayMs))].sort((a, b) => a - b);
		recipe.icon = { durationMs: icon[0].durationMs, easing: icon[0].easing, staggerMs: delays.length > 1 ? (delays[1] as number) - (delays[0] as number) : 0 };
	}

	// A menu item is an <li> (any classes) or anything with a menu-item class.
	const items = m.animations.filter((a) => (a.target.split(/[.#\s:[]/)[0] ?? "").toLowerCase() === "li" || /menu-item/i.test(a.target));
	if (items.length) {
		// The longest-running property defines the reveal; group by it.
		const main = [...items].sort((a, b) => b.durationMs - a.durationMs)[0] as AnimationSpec;
		const sameProp = items.filter((a) => a.name === main.name && a.durationMs === main.durationMs);
		const delays = [...new Set(sameProp.map((a) => a.delayMs))].sort((a, b) => a - b);
		const steps = delays.slice(1).map((d, i) => d - (delays[i] as number));
		const step = steps.length ? steps.sort((a, b) => steps.filter((x) => x === b).length - steps.filter((x) => x === a).length)[0] : 0;
		recipe.items = {
			properties: [...new Set(items.map((a) => a.name))],
			durationMs: main.durationMs,
			easing: main.easing,
			startDelayMs: delays[0] ?? 0,
			staggerMs: step ?? 0,
			count: delays.length,
		};
	}
	return recipe;
}
