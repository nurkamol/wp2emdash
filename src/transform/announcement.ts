/**
 * Site-wide announcement bar (top bar) rebuilt from what visitors see: the audit's saved page HTML.
 * Plugins such as Announcer keep their bars in post types the REST API does not expose, so the live
 * markup is the source. Detection rules and the verified markup: docs/spikes/announcement-findings.md.
 *
 * Known plugin/theme bars on most pages are rebuilt; anything else that looks like a bar is reported
 * with its text so the operator decides (overrides.ts → announcement: "keep" | "drop").
 */
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";
import type { Element } from "domhandler";
import { htmlToPortableText, type Keys } from "../ir/portable-text.js";
import { type AnnouncementFields, type Button, type Diagnostic, IR_VERSION, type IrPage } from "../ir/schema.js";
import { contrastRatio, readableOn } from "../scaffold/generate.js";

export type AnnouncementPlugin = NonNullable<AnnouncementFields["detected"]>["plugin"];

export interface BarCandidate {
	plugin: AnnouncementPlugin;
	/** CSS selector of the bar on the source page. */
	selector: string;
	messageHtml: string;
	/** Plain message text (whitespace collapsed), the grouping key across pages. */
	text: string;
	buttons: { label: string; href: string; newTab?: boolean; style: "primary" | "secondary" }[];
	colors: { background?: string; text?: string; buttonBackground?: string; buttonText?: string };
	dismissible: boolean;
	sticky: boolean;
	position: "top" | "bottom";
	schedule?: { from?: string; to?: string };
	reshowsAfterClose?: boolean;
	/** Source record id (Announcer post id), when the markup has one. */
	sourceId?: number;
	/** Notes for the report (device targeting, script-only parts…). */
	notes: string[];
}

export interface BarGroup extends BarCandidate {
	pages: number;
	of: number;
	pageNames: string[];
	/** Known plugin/theme bar on at least half of the saved pages. */
	confident: boolean;
}

export interface AnnouncementDetection {
	/** The bar to rebuild (most pages; known plugins first). */
	best?: BarGroup;
	/** Every distinct bar found (best included), for the report. */
	all: BarGroup[];
	/** Bars a script injects after load (their text is not in the saved HTML). */
	scriptOnly: string[];
}

const SCRIPT_BARS: [RegExp, string][] = [
	[/my\.hellobar\.com|hellobar\.js/i, "Hello Bar"],
	[/omappapi\.com|optinmonster/i, "OptinMonster (floating bar campaigns)"],
	[/notification-bar-pro|wpfront-notification-bar-pro/i, "WPFront Notification Bar Pro (scripted mode)"],
];

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** #rgb, #rrggbb, #rrggbbaa (opaque), rgb()/rgba() (opaque), white/black → #rrggbb. */
export function normaliseColour(v: string | undefined): string | undefined {
	if (!v) return undefined;
	const x = v.trim().toLowerCase();
	if (x === "white") return "#ffffff";
	if (x === "black") return "#000000";
	let m = /^#([0-9a-f]{3})$/.exec(x);
	if (m) return `#${[...(m[1] as string)].map((c) => c + c).join("")}`;
	m = /^#([0-9a-f]{6})(?:([0-9a-f]{2}))?$/.exec(x);
	if (m) return m[2] && m[2] !== "ff" ? undefined : `#${m[1]}`;
	m = /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?))?\s*\)$/.exec(x);
	if (m) {
		const a = m[4] === undefined ? 1 : m[4].endsWith("%") ? Number.parseFloat(m[4]) / 100 : Number(m[4]);
		if (a < 1) return undefined;
		return `#${[m[1], m[2], m[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, "0")).join("")}`;
	}
	return undefined;
}

/** First solid colour in a declaration value (`#888 linear-gradient(…)` → #888888). */
function firstColour(value: string | undefined): string | undefined {
	if (!value) return undefined;
	for (const m of value.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|\b(?:white|black)\b/gi)) {
		const c = normaliseColour(m[0]);
		if (c) return c;
	}
	return undefined;
}

/** Declarations of every CSS rule (page <style> blocks) whose selector list contains `selector` exactly. */
function declarations(css: string, selectors: string[]): Record<string, string> {
	const want = new Set(selectors.map((s) => clean(s)));
	const out: Record<string, string> = {};
	for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		const sel = (m[1] as string).split(",").map((s) => clean(s));
		if (!sel.some((s) => want.has(s))) continue;
		for (const d of (m[2] as string).split(";")) {
			const i = d.indexOf(":");
			if (i < 0) continue;
			const k = d.slice(0, i).trim().toLowerCase();
			const v = d.slice(i + 1).replace(/!important/i, "").trim();
			// A later plain value does not beat an earlier one only when it is not a colour (vendor gradients repeat `background`).
			if (k && v && !(k === "background" && out[k] && !firstColour(v))) out[k] = v;
		}
	}
	return out;
}

const inlineDecl = (el: Cheerio<Element>): Record<string, string> => Object.fromEntries((el.attr("style") ?? "").split(";").map((d) => [d.slice(0, d.indexOf(":")).trim().toLowerCase(), d.slice(d.indexOf(":") + 1).replace(/!important/i, "").trim()]).filter(([k, v]) => k && v));

const bgOf = (d: Record<string, string>) => firstColour(d["background-color"]) ?? firstColour(d.background);

function buttonsOf($: CheerioAPI, links: Cheerio<Element>): BarCandidate["buttons"] {
	return links
		.toArray()
		.map((a) => {
			const $a = $(a);
			const label = clean($a.text());
			const href = $a.attr("href") ?? "";
			return { label, href, ...($a.attr("target") === "_blank" ? { newTab: true } : {}), style: /secondary/i.test($a.attr("class") ?? "") ? ("secondary" as const) : ("primary" as const) };
		})
		.filter((b) => b.label && b.href && !/^javascript:/i.test(b.href));
}

function messageOf($: CheerioAPI, el: Cheerio<Element>, strip: string): { html: string; text: string } {
	const c = el.clone();
	c.find(["script,style,noscript,svg,form,nav", strip].filter(Boolean).join(",")).remove();
	return { html: (c.html() ?? "").trim(), text: clean(c.text()) };
}

function announcer($: CheerioAPI, css: string): BarCandidate[] {
	return $(".ancr-group")
		.toArray()
		.flatMap((g) => {
			const $g = $(g);
			return $g
				.find(".ancr.ancr-wrap, .ancr-wrap")
				.toArray()
				.map((w): BarCandidate | undefined => {
					const $w = $(w);
					const id = $w.attr("id") ?? "";
					let props: Record<string, unknown> = {};
					try {
						props = JSON.parse($w.attr("data-props") ?? "{}") as Record<string, unknown>;
					} catch {}
					const inner = $w.find(".ancr-content .ancr-inner").first().length ? $w.find(".ancr-content .ancr-inner").first() : $w.find(".ancr-content").first();
					const msg = messageOf($, inner, ".ancr-btn-wrap, .ancr-close");
					if (!msg.text) return undefined;
					const sel = id ? `#${id}` : ".ancr-wrap";
					const btnLinks = $w.find(".ancr-btn-wrap a, a.ancr-btn");
					const firstBtnClass = /ancr-btn-secondary/.test(btnLinks.first().attr("class") ?? "") ? "secondary" : "primary";
					const bar = { ...declarations(css, [sel]), ...inlineDecl($w) };
					const btn = declarations(css, [`${sel} .ancr-btn-${firstBtnClass}`]);
					const ts = (v: unknown) => (/^\d{9,}$/.test(String(v ?? "")) ? new Date(Number(v) * 1000).toISOString() : undefined);
					const from = props.display === "schedule" ? ts(props.schedule_from) : undefined;
					const to = props.display === "schedule" ? ts(props.schedule_to) : undefined;
					const notes: string[] = [];
					if (props.devices && props.devices !== "all") notes.push(`source shows it on ${String(props.devices)} only; the starter shows it on every device`);
					if (props.layout === "ticker") notes.push("source scrolls the message as a ticker; rebuilt as static text");
					if (props.show_on && props.show_on !== "page_open") notes.push(`source opens it on ${String(props.show_on)}; rebuilt as shown on load`);
					return {
						plugin: "announcer",
						selector: sel,
						messageHtml: msg.html,
						text: msg.text,
						buttons: buttonsOf($, btnLinks),
						colors: { background: bgOf(bar), text: firstColour(bar.color), buttonBackground: bgOf(btn), buttonText: firstColour(btn.color) },
						dismissible: props.close_btn === "yes" || $w.hasClass("ancr-has-close-btn") || $w.find(".ancr-close").length > 0,
						sticky: props.sticky === "yes" || $g.hasClass("ancr-sticky"),
						position: props.position === "bottom" || $g.hasClass("ancr-pos-bottom") ? "bottom" : "top",
						...(from || to ? { schedule: { ...(from ? { from } : {}), ...(to ? { to } : {}) } } : {}),
						...(props.keep_closed === "no" ? { reshowsAfterClose: true } : {}),
						...(/^ancr-(\d+)$/.test(id) ? { sourceId: Number(id.slice(5)) } : {}),
						notes,
					};
				})
				.filter((x): x is BarCandidate => !!x);
		});
}

function wpfront($: CheerioAPI, css: string): BarCandidate[] {
	const $b = $("#wpfront-notification-bar").first();
	if (!$b.length) return [];
	const msgEl = $b.find(".wpfront-message").first();
	const msg = messageOf($, msgEl.length ? msgEl : $b, ".wpfront-close, .wpfront-button");
	if (!msg.text) return [];
	const bar = { ...declarations(css, ["#wpfront-notification-bar"]), ...inlineDecl($b) };
	const text = declarations(css, ["#wpfront-notification-bar div.wpfront-message", "#wpfront-notification-bar .wpfront-message"]);
	const btn = declarations(css, ["#wpfront-notification-bar a.wpfront-button", "#wpfront-notification-bar .wpfront-button"]);
	return [
		{
			plugin: "wpfront",
			selector: "#wpfront-notification-bar",
			messageHtml: msg.html,
			text: msg.text,
			buttons: buttonsOf($, $b.find("a.wpfront-button")),
			colors: { background: bgOf(bar), text: firstColour(text.color), buttonBackground: bgOf(btn), buttonText: firstColour(btn.color) },
			dismissible: $b.find(".wpfront-close").length > 0,
			sticky: $b.hasClass("wpfront-fixed") || $("#wpfront-notification-bar-spacer").hasClass("wpfront-fixed-position"),
			position: $b.hasClass("bottom") ? "bottom" : "top",
			notes: $b.find(".wpfront-button[onclick]").length ? ["a button runs a script (onclick) instead of linking; not rebuilt"] : [],
		},
	];
}

function salient($: CheerioAPI, css: string): BarCandidate[] {
	const $o = $("#header-secondary-outer").first();
	const $t = $o.find(".nectar-center-text").first();
	if (!$t.length) return [];
	const msg = messageOf($, $t, "");
	if (!msg.text) return [];
	const bar = declarations(css, ["#header-secondary-outer", "body #header-secondary-outer"]);
	const text = declarations(css, ["#header-secondary-outer .nectar-center-text", "#header-secondary-outer nav > ul > li > a", "#header-secondary-outer nav>ul>li>a"]);
	return [{ plugin: "salient", selector: "#header-secondary-outer .nectar-center-text", messageHtml: msg.html, text: msg.text, buttons: [], colors: { background: bgOf(bar), text: firstColour(text.color) }, dismissible: false, sticky: false, position: "top", notes: ["the secondary header's menu links are migrated with the secondary menu"] }];
}

function astra($: CheerioAPI, css: string): BarCandidate[] {
	const $a = $(".ast-above-header-bar, .ast-above-header").first();
	const $t = $a.find(".ast-builder-html-element").first();
	if (!$t.length) return [];
	const msg = messageOf($, $t, "");
	if (!msg.text) return [];
	const bar = declarations(css, [".ast-above-header-bar", ".ast-above-header.ast-above-header-bar", ".ast-above-header"]);
	const text = declarations(css, [".ast-header-html-1 .ast-builder-html-element", ".ast-above-header-bar .ast-builder-html-element"]);
	const btn = declarations(css, [".ast-header-button-1 .ast-custom-button", ".ast-header-button-1 .menu-link"]);
	return [{ plugin: "astra", selector: ".ast-above-header-bar .ast-builder-html-element", messageHtml: msg.html, text: msg.text, buttons: buttonsOf($, $a.find(".ast-builder-button-wrap a, a.ast-custom-button-link")), colors: { background: bgOf(bar), text: firstColour(text.color), buttonBackground: bgOf(btn), buttonText: firstColour(btn.color) }, dismissible: false, sticky: false, position: "top", notes: ["menus and social icons in the above-header row are not part of the bar"] }];
}

const GENERIC = '[class*="announcement"], [id*="announcement"], [class*="topbar"], [id*="topbar"], [class*="top-bar"], [id*="top-bar"], [class*="notice-bar"], [class*="promo-bar"], [class*="notification-bar"], [class*="sticky-bar"]';
const KNOWN = "#wpfront-notification-bar, #wpfront-notification-bar-spacer, .ancr-group, #header-secondary-outer, .ast-above-header-wrap, .ast-above-header-bar, .ast-above-header";

/** A bar-like element above the page content: a class/id that says so, before <main>/the first h1, short text, not a menu. */
function generic($: CheerioAPI): BarCandidate[] {
	const all = $("body *").toArray();
	const contentStart = all.indexOf(($("main").first().get(0) ?? $("h1").first().get(0)) as Element);
	const limit = contentStart >= 0 ? contentStart : Math.min(all.length, 400);
	const seen = new Set<Element>();
	const out: BarCandidate[] = [];
	for (const el of $(GENERIC).toArray()) {
		const i = all.indexOf(el);
		if (i < 0 || i >= limit || seen.has(el)) continue;
		const $e = $(el);
		if ($e.is("script,style,link,meta,nav,ul,li,a,button,body,html") || $e.closest(`main,article,footer,nav,form,dialog,${KNOWN}`).length) continue;
		if ($e.parents().toArray().some((p) => seen.has(p as Element))) continue;
		for (const d of $e.find("*").toArray()) seen.add(d as Element);
		seen.add(el);
		const btnLinks = $e.find('a.button, a.btn, a[class*="btn"], a[class*="button"]');
		const msg = messageOf($, $e, 'a.button, a.btn, a[class*="btn"], a[class*="button"], [class*="close"], [aria-label*="lose"], [aria-label*="ismiss"], ul.menu, .menu, button');
		if (msg.text.length < 3 || msg.text.length > 300) continue;
		const cls = `${$e.attr("class") ?? ""} ${$e.attr("id") ?? ""}`;
		const style = inlineDecl($e);
		const id = $e.attr("id");
		const firstClass = ($e.attr("class") ?? "").split(/\s+/).find((c) => /announcement|top-?bar|notice-bar|promo-bar|notification-bar|sticky-bar/i.test(c));
		out.push({
			plugin: "generic",
			selector: id && /announcement|top-?bar|notice-bar|promo-bar|notification-bar|sticky-bar/i.test(id) ? `#${id}` : `${el.tagName}.${firstClass ?? ($e.attr("class") ?? "").split(/\s+/)[0]}`,
			messageHtml: msg.html,
			text: msg.text,
			buttons: buttonsOf($, btnLinks),
			colors: { background: bgOf(style), text: firstColour(style.color) },
			dismissible: $e.find('[class*="close"], [class*="dismiss"], [aria-label*="lose"], [aria-label*="ismiss"]').length > 0,
			sticky: /sticky|fixed/i.test(cls) || /fixed|sticky/.test(style.position ?? ""),
			position: "top",
			notes: $e.find("nav, ul.menu, .menu").length ? ["contains menu links (not part of the bar)"] : [],
		});
	}
	return out;
}

/** Every bar on one saved page, known plugins first. */
export function barsOnPage(html: string): BarCandidate[] {
	const $ = cheerio.load(html);
	const css = $("style").toArray().map((s) => $(s).text()).join("\n");
	return [...announcer($, css), ...wpfront($, css), ...salient($, css), ...astra($, css), ...generic($)];
}

/** Bars across the saved pages, grouped by plugin + message text. */
export function detectAnnouncement(pages: { name: string; html: string }[]): AnnouncementDetection {
	const groups = new Map<string, BarGroup>();
	const scriptOnly = new Set<string>();
	for (const p of pages) {
		for (const [re, name] of SCRIPT_BARS) if (re.test(p.html)) scriptOnly.add(name);
		const onPage = new Set<string>();
		for (const c of barsOnPage(p.html)) {
			const key = `${c.plugin}|${c.text.toLowerCase()}`;
			if (onPage.has(key)) continue;
			onPage.add(key);
			const g = groups.get(key);
			if (g) {
				g.pages++;
				g.pageNames.push(p.name);
			} else groups.set(key, { ...c, pages: 1, of: pages.length, pageNames: [p.name], confident: false });
		}
	}
	const all = [...groups.values()];
	for (const g of all) g.confident = g.plugin !== "generic" && g.pages * 2 >= g.of;
	all.sort((a, b) => Number(b.confident) - Number(a.confident) || Number(b.plugin !== "generic") - Number(a.plugin !== "generic") || b.pages - a.pages);
	return { ...(all[0] ? { best: all[0] } : {}), all, scriptOnly: [...scriptOnly] };
}

/** Text and button colours that meet WCAG AA (4.5:1); what changed, for the report. */
export function accessibleColours(c: BarCandidate["colors"]): { colors: BarCandidate["colors"]; fixes: string[]; source: Record<string, string> } {
	const colors = { ...c };
	const fixes: string[] = [];
	const source: Record<string, string> = {};
	const fix = (fill: string | undefined, key: "text" | "buttonText", label: string) => {
		const wanted = colors[key];
		if (!fill || !wanted) return;
		const r = readableOn(fill, wanted, wanted);
		if (!r.fixed) return;
		source[key] = wanted;
		colors[key] = r.color;
		fixes.push(`${label} ${wanted} on ${fill} is ${contrastRatio(fill, wanted).toFixed(2)}:1; changed to ${r.color} (${contrastRatio(fill, r.color).toFixed(2)}:1, WCAG AA)`);
	};
	fix(colors.background, "text", "text");
	fix(colors.buttonBackground, "buttonText", "button text");
	return { colors, fixes, source };
}

/** The bar as a site part: ir/partials/announcement.json, one `announcement` section. */
export function announcementDoc(g: BarGroup, keys: Keys, relHref: (href: string) => string): IrPage {
	const diagnostics: Diagnostic[] = [];
	const pt = htmlToPortableText(g.messageHtml, keys);
	const relLinks = pt.blocks.map((b) => ({ ...b, markDefs: b.markDefs.map((d) => ({ ...d, href: relHref(d.href) })) }));
	for (const l of pt.leftovers) diagnostics.push({ level: "warn", code: "lossy", message: `<${l.tag}> in the bar message not kept`, path: g.selector });
	const buttons: Button[] = g.buttons.slice(0, 2).map((b) => ({ label: b.label, href: relHref(b.href), style: b.style, ...(b.newTab ? { newTab: true } : {}) }));
	for (const b of g.buttons.slice(2)) diagnostics.push({ level: "warn", code: "lossy", message: `bar button "${b.label}" (${b.href}) not kept: the bar takes two buttons`, path: g.selector, carriesContent: true });
	const { colors, fixes, source } = accessibleColours(g.colors);
	for (const f of fixes) diagnostics.push({ level: "info", code: "lossy", message: `Announcement colours: ${f}`, path: g.selector });
	diagnostics.push({ level: "info", code: "flagged", message: `Announcement bar rebuilt from ${g.plugin} (${g.selector}) on ${g.pages} of ${g.of} saved pages`, path: g.selector });
	if (g.pages < g.of) diagnostics.push({ level: "warn", code: "flagged", message: `The bar is on ${g.pages} of ${g.of} saved pages (missing on ${g.of - g.pages}); the starter shows it on every page`, path: g.selector });
	if (g.position === "bottom") diagnostics.push({ level: "warn", code: "lossy", message: "The source bar sits at the bottom of the window; rebuilt above the header", path: g.selector });
	for (const n of g.notes) diagnostics.push({ level: "info", code: "lossy", message: `Announcement bar: ${n}`, path: g.selector });
	const fields: AnnouncementFields = {
		message: relLinks,
		buttons,
		colors: Object.fromEntries(Object.entries(colors).filter(([, v]) => v)) as AnnouncementFields["colors"],
		dismissible: g.dismissible,
		sticky: g.sticky,
		enabled: true,
		...(g.schedule ? { schedule: g.schedule } : {}),
		detected: { plugin: g.plugin, selector: g.selector, pages: g.pages, of: g.of, position: g.position, ...(g.reshowsAfterClose ? { reshowsAfterClose: true } : {}), ...(Object.keys(source).length ? { sourceColors: source } : {}) },
	};
	return {
		version: IR_VERSION,
		kind: "partial",
		source: { wpId: g.sourceId ?? 0, type: "announcement", status: "publish", slug: "announcement", builder: "html" },
		title: "Announcement bar",
		seo: { jsonLdTypes: [] },
		sections: [{ type: "announcement", theme: { tone: "light" }, spacing: "none", sourceRef: { adapter: "html", path: g.selector, rawHash: createHash("sha1").update(g.messageHtml + JSON.stringify(g.buttons)).digest("hex").slice(0, 10) }, fields }],
		diagnostics,
	};
}

/** One line per bar for the report (text shortened). */
export const describeBar = (g: BarGroup) => `${g.plugin} \`${g.selector}\` on ${g.pages}/${g.of} pages: “${g.text.length > 140 ? `${g.text.slice(0, 140)}…` : g.text}”${g.buttons.length ? ` · buttons: ${g.buttons.map((b) => `${b.label} → ${b.href}`).join(", ")}` : ""}`;
