/**
 * Site-wide snippets: every <script>, <noscript>, <iframe>, <link> and <meta> a WordPress site puts in <head> or at
 * the top level of <body> (wp_head / wp_body_open / wp_footer: theme custom code, WPCode, Insert Headers and Footers,
 * Header Footer Code Manager, plugin widgets) — not page content. Read from the audit's raw HTML of every saved page
 * and from a Header Footer Code Manager export (raw/code-snippets.json, `wp2emdash import-dump`), deduplicated across
 * pages, and classified:
 *
 * - tracker          → carried by SEO & Analytics (its own seed reads the same HTML)
 * - verification     → carried → Settings → SEO
 * - page-meta        → rebuilt by the starter / SEO plugin (canonical, description, Open Graph, icons, JSON-LD, fonts)
 * - provider-loader  → a booking/video/… provider's loader: carried with the embed sections that need it
 * - widget           → chat / reviews badge / consent tool: carried as a site widget (provider + ID, kit.config `siteWidgets`)
 * - wordpress        → WordPress, theme, plugin or Cloudflare-edge internals: not needed, listed
 * - unknown          → never carried automatically: a coverage-report item and an overrides.ts decision
 *
 * Pure function of the HTML (and overrides): ir/site-snippets.json is reproduced by a rerun.
 */
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import type { Element } from "domhandler";
import { detectTrackers } from "../../packages/seo/src/analytics/detect.js";
import type { Section } from "../ir/schema.js";
import { hostAllowed, PROVIDER_BY_ID, PROVIDERS, type SiteWidget, widgetIdIn } from "../providers/registry.js";

export type SnippetKind = "tracker" | "verification" | "page-meta" | "provider-loader" | "widget" | "wordpress" | "unknown";
export type SnippetStatus = "carried" | "not-needed" | "decision";

export interface SiteSnippet {
	/** Stable short id (overrides.ts `snippets`). */
	id: string;
	tag: string;
	kind: SnippetKind;
	status: SnippetStatus;
	/** What it is, for people. */
	label: string;
	/** Where it goes (carried), why it is not needed, or what to decide. */
	note: string;
	provider?: string;
	widget?: SiteWidget;
	/** External script URLs of a provider loader (added to that provider's embed sections that lack one). */
	srcs?: string[];
	/** "head" | "body" | "code manager: <snippet name>". */
	where: string[];
	/** Saved pages it appears on. */
	pages: string[];
	/** The element, shortened. */
	sample: string;
}

export interface SiteSnippets {
	pages: number;
	items: SiteSnippet[];
	/** Site widgets carried automatically (scaffold → site.config.json `siteWidgets`, unless kit.config sets them). */
	widgets: SiteWidget[];
	counts: Record<SnippetStatus, number>;
}

export interface SnippetInput {
	/** Saved pages: snapshot/html/<name>.html. */
	pages: { name: string; html: string }[];
	/** raw/code-snippets.json (Header Footer Code Manager export), parsed. */
	codeManager?: unknown;
	/** Hosts of the WordPress site (source URL, alternates, production): their files are WordPress assets. */
	siteHosts: string[];
	/** overrides.ts `snippets`: id → decision for snippets that need one. */
	decisions?: Record<string, "drop" | "rebuilt">;
}

const VERIFICATION = /^(?:google-site-verification|msvalidate\.01|p:domain_verify|facebook-domain-verification|yandex-verification|norton-safeweb-site-verification|ahrefs-site-verification|baidu-site-verification|apple-domain-verification)$/i;
const PAGE_META = /^(?:description|robots|googlebot|bingbot|viewport|theme-color|format-detection|author|referrer|color-scheme|application-name|mobile-web-app-capable|apple-mobile-web-app-[\w-]+|msapplication-[\w-]+|(?:og|twitter|article|fb|profile|business|place|product):[\w:-]+)$/i;
const PAGE_LINK = /^(?:canonical|icon|shortcut icon|apple-touch-icon|apple-touch-icon-precomposed|mask-icon|manifest)$/i;
const WP_LINK = /^(?:alternate|shortlink|https:\/\/api\.w\.org\/|edituri|wlwmanifest|pingback|profile|prev|next|dns-prefetch|preconnect|prefetch|prerender|preload|modulepreload|author|license|search)$/i;
const FONT_HOSTS = /^(?:fonts\.googleapis\.com|fonts\.gstatic\.com|fonts\.bunny\.net)$/i;
/** Public CDNs serving libraries a theme or plugin used (jQuery, Font Awesome, Bootstrap, sliders…). */
const LIBRARY_HOSTS = /^(?:cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|code\.jquery\.com|ajax\.googleapis\.com|ajax\.aspnetcdn\.com|(?:stackpath|maxcdn|netdna)\.bootstrapcdn\.com|use\.fontawesome\.com|kit\.fontawesome\.com|ka-f\.fontawesome\.com|polyfill\.io|cdn\.polyfill\.io|s\.w\.org|stats\.wp\.com|c0\.wp\.com|i0\.wp\.com|widgets\.wp\.com)$/i;
/** Analytics hosts SEO & Analytics loads by ID (packages/seo/src/analytics). */
const TRACKER_SRC = /(?:googletagmanager\.com|google-analytics\.com|connect\.facebook\.net\/[\w-]+\/fbevents\.js|facebook\.com\/tr\b|clarity\.ms|static\.hotjar\.com|script\.hotjar\.com|static\.cloudflareinsights\.com|googleadservices\.com|googlesyndication\.com|doubleclick\.net)/i;
/** Inline code WordPress, themes and common plugins print (localised settings, no-js class swaps, emoji, caches). */
const WP_INLINE = [
	/_wpemojiSettings|wp-emoji/,
	/documentElement\.class(?:Name|List)|classList\.(?:remove|add)\(\s*["']no-js|setAttribute\(\s*["']class["']\s*,\s*["']js["']/,
	/\bswcfpc_|wpbCustomElement|admin-ajax\.php|\bvar\s+ajaxurl\b/,
	/RocketLazyLoad|rocket_lazy|lazyLoadOptions|lazySizesConfig|\bwpRocket/,
	/\bff_form_instance|intlTelInput|fluentForm/,
	/elementorFrontendConfig|bricksData|nectarLove|pum_vars|wpcf7|wc_add_to_cart|wpforms_settings|_wpUtilSettings|wp\.i18n\.setLocaleData|ElementorProFrontendConfig|et_pb_custom|DIVI\b/,
	// WooCommerce's no-JS body class swap; Elementor's background lazy-load observer (WordPress e2e test, 2026-11-22).
	/woocommerce-no-js|lazyloadRunObserver|e-lazyloaded/,
];

const hash = (s: string, n = 8) => createHash("sha1").update(s).digest("hex").slice(0, n);
const short = (s: string, n = 220) => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/\s+/g, " ");

function urlOf(raw: string | undefined, base: string): URL | undefined {
	if (!raw) return undefined;
	try {
		return new URL(raw.replace(/&amp;/g, "&").replace(/&#0?38;/g, "&"), base);
	} catch {
		return undefined;
	}
}

interface Raw {
	key: string;
	tag: string;
	where: string;
	html: string;
	attrs: Record<string, string>;
	body: string;
	url?: URL;
	/** Site-level markup around it (a widget's mount point, e.g. Elfsight's `elfsight-app-<id>` div), for its ID. */
	context?: string;
}

/** The site-level elements of one page (or one code-manager snippet: every depth, as it all is site-wide code). */
function elementsOf(html: string, where: string | undefined, base: string, siteHosts: Set<string>): Raw[] {
	const $ = cheerio.load(html);
	const out: Raw[] = [];
	// Small body-level markup outside the page's content and chrome (where wp_footer / code managers put widget boxes).
	const context = where
		? html
		: $("body > *")
				.not("script, noscript, iframe, link, meta, style, main, header, footer, nav, section, article")
				.toArray()
				.map((e) => $.html(e) ?? "")
				.filter((h) => h.length < 2000)
				.join("\n");
	const pick = where ? $("script, noscript, iframe, link, meta") : $("head > script, head > noscript, head > iframe, head > link, head > meta, body > script, body > noscript, body > iframe, body > link, body > meta");
	pick.each((_, node) => {
		const el = node as Element;
		const tag = el.tagName.toLowerCase();
		const pos = where ?? ($(el).parent().is("head") ? "head" : "body");
		const attrs = el.attribs ?? {};
		const body = tag === "noscript" ? ($(el).html() ?? "").trim() : ($(el).text() ?? "").trim();
		// Elements inside a <noscript> are reported with the noscript.
		if (where && $(el).parents("noscript").length) return;
		const src = tag === "link" ? attrs.href : attrs.src;
		if (tag === "script" && !src && !body) return;
		const url = urlOf(src, base);
		const own = !!url && siteHosts.has(url.host.replace(/^www\./, ""));
		let key: string;
		if (tag === "meta") key = `meta:${(attrs.name ?? attrs.property ?? attrs["http-equiv"] ?? (attrs.charset !== undefined ? "charset" : hash($.html(el) ?? ""))).toLowerCase()}`;
		else if (tag === "link" && /^(?:canonical|shortlink|alternate|prev|next|edituri|pingback|https:\/\/api\.w\.org\/)$/i.test(attrs.rel ?? "")) key = `link:${(attrs.rel ?? "").toLowerCase()}:${attrs.type ?? ""}`;
		// Per-page inline code that is one thing site-wide: structured data, Cloudflare's bot-check script.
		else if (tag === "script" && /^application\/ld\+json$/i.test(attrs.type ?? "")) key = "script:ld+json";
		else if (tag === "script" && body.includes("__CF$cv$params")) key = "script:cloudflare-challenge";
		else if (url) key = `${tag}:${own ? url.pathname : `${url.host}${url.pathname}${url.search.replace(/[?&](?:ver|rnd|v|t)=[^&]*/g, "")}`}`;
		else if (attrs.id) key = `${tag}#${attrs.id}`;
		else key = `${tag}:${hash(body.replace(/\s+/g, " ").replace(/\d+/g, "0"), 12)}`;
		out.push({ key, tag, where: pos, html: $.html(el) ?? "", attrs, body, ...(url ? { url } : {}), ...(context ? { context } : {}) });
	});
	return out;
}

interface Verdict {
	kind: SnippetKind;
	label: string;
	note: string;
	provider?: string;
	widget?: SiteWidget;
	srcs?: string[];
}

const provName = (id: string) => PROVIDER_BY_ID[id]?.name ?? id;

/** What one site-level element is, and what happens to it. */
export function classifySnippet(r: { tag: string; attrs: Record<string, string>; body: string; html: string; url?: URL; context?: string }, siteHosts: Set<string>): Verdict {
	const { tag, attrs, body, url } = r;
	const host = url?.host.replace(/^www\./, "") ?? "";
	const own = !!url && siteHosts.has(host);
	const what = url ? `${tag} ${url.host}${url.pathname}` : attrs.id ? `inline ${tag} #${attrs.id}` : `inline ${tag}: ${short(body, 70)}`;
	if (tag === "meta") {
		const name = (attrs.name ?? attrs.property ?? "").toLowerCase();
		if (VERIFICATION.test(name)) return { kind: "verification", label: `meta ${name}`, note: "carried → Settings → SEO" };
		if (attrs.charset !== undefined || attrs["http-equiv"] || PAGE_META.test(name)) return { kind: "page-meta", label: `meta ${name || attrs["http-equiv"] || "charset"}`, note: "rebuilt per page by the starter and the SEO plugin" };
		if (name === "generator") return { kind: "wordpress", label: "meta generator", note: "WordPress / builder version tag: not needed" };
		return { kind: "unknown", label: `meta ${name || short(r.html, 60)}`, note: "unrecognised meta tag: carry by hand (Settings → SEO or the starter's head) or drop" };
	}
	const text = `${url?.href ?? ""} ${r.html}`;
	if (tag === "script" && /^application\/ld\+json$/i.test(attrs.type ?? "")) return { kind: "page-meta", label: "structured data (JSON-LD)", note: "rebuilt by the starter (StructuredData) from the site's business details" };
	if (tag === "script" && /^speculationrules$/i.test(attrs.type ?? "")) return { kind: "wordpress", label: "speculation rules", note: "WordPress core prefetch rules: not needed" };
	if (tag === "link") {
		const rel = (attrs.rel ?? "").toLowerCase();
		if (PAGE_LINK.test(rel)) return { kind: "page-meta", label: `link ${rel}`, note: "rebuilt by the starter (canonical, favicons)" };
		if (WP_LINK.test(rel)) return { kind: "wordpress", label: `link ${rel}${url ? ` ${url.host}${url.pathname}` : ""}`, note: "WordPress feed / API / resource hint: not needed" };
		if (url && FONT_HOSTS.test(host)) return { kind: "page-meta", label: `fonts ${url.host}${url.pathname}`, note: "fonts: self-hosted by scaffold from the design capture" };
	}
	// Trackers first: SEO & Analytics carries them by ID (it reads the same HTML).
	const d = detectTrackers([text]);
	const ids = [...d.google, ...d.gtm, ...d.meta.map((m) => `Meta ${m}`), ...d.clarity.map((c) => `Clarity ${c}`), ...d.hotjar.map((h) => `Hotjar ${h}`), ...d.ua.map((u) => `${u} (retired)`)];
	if (ids.length || (url && TRACKER_SRC.test(url.href)) || (!url && TRACKER_SRC.test(body))) return { kind: "tracker", label: ids.length ? `tracker ${[...new Set(ids)].join(", ")} (${what.slice(0, 60)})` : `tracker ${what}`, note: "carried by SEO & Analytics → Analytics (by ID)" };
	if (url && /^challenges\.cloudflare\.com$/i.test(url.host)) return { kind: "wordpress", label: `Cloudflare Turnstile ${url.pathname}`, note: "the old forms' bot check: the starter's forms bring their own Turnstile" };
	if (/\/cdn-cgi\/|__CF\$cv\$params|cloudflare-static|data-cf-beacon/.test(text)) return { kind: "wordpress", label: `Cloudflare edge: ${what}`, note: "added by Cloudflare itself (zone features: email obfuscation, bot checks, Web Analytics): not needed in the code" };
	// Registry providers: site widgets (loaded by ID), then embed providers (loaders of embed sections).
	for (const p of PROVIDERS.filter((x) => x.widget)) {
		if (!p.detect.test(text)) continue;
		const id = widgetIdIn(p.id, text) ?? (r.context ? widgetIdIn(p.id, r.context) : undefined);
		if (id) return { kind: "widget", label: `${p.name} (${id})`, note: "carried as a site widget (kit.config siteWidgets, by ID)", provider: p.id, widget: { provider: p.id, id } };
		return { kind: "widget", label: `${p.name}: ${what}`, note: `${p.name} recognised, but this form of its snippet carries no ID the starter can load: add { provider: "${p.id}", id } to kit.config siteWidgets, or drop`, provider: p.id };
	}
	for (const p of PROVIDERS.filter((x) => x.embed)) {
		if (!p.detect.test(text)) continue;
		const srcs = tag === "script" && url && !body && hostAllowed(url.host, p.id) ? [url.href] : undefined;
		return { kind: "provider-loader", label: `${p.name}: ${what}`, note: "", provider: p.id, ...(srcs ? { srcs } : {}) };
	}
	if (url && own) {
		if (/\/themes\/[^/]*-child\/|\/custom[-_]?(?:js|scripts?)\b/i.test(url.pathname) && tag === "script") return { kind: "unknown", label: `theme custom script ${url.pathname}`, note: "child-theme / custom script: check what it does; rebuild it (section, site widget) or drop" };
		return { kind: "wordpress", label: `${tag} ${url.pathname}`, note: "WordPress / theme / plugin file: not needed (the starter brings its own)" };
	}
	if (url && LIBRARY_HOSTS.test(host)) return { kind: "wordpress", label: `library ${url.host}${url.pathname}`, note: "library the theme or a plugin used: not needed" };
	// Underscore templates WordPress and plugins print for their own scripts (wp.template: WooCommerce variations, media).
	if (!url && tag === "script" && /^text\/(?:template|html|x-template)$/i.test(attrs.type ?? "") && /^tmpl-/.test(attrs.id ?? "")) return { kind: "wordpress", label: what, note: "WordPress / plugin script template: not needed" };
	if (!url && tag === "script" && (/-js-(?:extra|before|after)$/.test(attrs.id ?? "") || WP_INLINE.some((re) => re.test(body)))) return { kind: "wordpress", label: what, note: "WordPress / theme / plugin settings code: not needed" };
	if (tag === "noscript" && !/<(?:iframe|script)\b/i.test(body) && [...body.matchAll(/\bsrc=["']([^"']+)/gi)].every((m) => { const u = urlOf(m[1], "https://x.invalid"); return !u || u.host === "x.invalid" || siteHosts.has(u.host.replace(/^www\./, "")); })) return { kind: "wordpress", label: what, note: "theme no-JS fallback: not needed" };
	return { kind: "unknown", label: what, note: "unrecognised site-wide code: never carried automatically — rebuild it (embed section, site widget, analytics) or drop it, then record the choice in overrides.ts snippets" };
}

const STATUS: Record<SnippetKind, SnippetStatus> = { tracker: "carried", verification: "carried", "page-meta": "carried", "provider-loader": "decision", widget: "carried", wordpress: "not-needed", unknown: "decision" };

/** Header Footer Code Manager export → its active snippets as HTML. */
export function codeManagerSnippets(json: unknown): { name: string; location: string; html: string }[] {
	const list = json && typeof json === "object" && Array.isArray((json as { snippets?: unknown }).snippets) ? ((json as { snippets: Record<string, unknown>[] }).snippets ?? []) : [];
	const decode = (h: string) => h.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, "&");
	return list.filter((x) => x && x.status === "active").map((x) => ({ name: String(x.name ?? "snippet"), location: String(x.location || "manual"), html: decode(String(x.snippet ?? "")) }));
}

export function collectSnippets(input: SnippetInput): SiteSnippets {
	const siteHosts = new Set(input.siteHosts.map((h) => h.toLowerCase().replace(/^www\./, "")));
	const base = `https://${input.siteHosts[0] ?? "x.invalid"}/`;
	const byKey = new Map<string, SiteSnippet>();
	const add = (r: Raw, page: string | undefined) => {
		let s = byKey.get(r.key);
		if (!s) {
			const v = classifySnippet(r, siteHosts);
			s = { id: `sn-${hash(r.key)}`, tag: r.tag, kind: v.kind, status: v.kind === "widget" && !v.widget ? "decision" : STATUS[v.kind], label: v.label, note: v.note, ...(v.provider ? { provider: v.provider } : {}), ...(v.widget ? { widget: v.widget } : {}), ...(v.srcs ? { srcs: v.srcs } : {}), where: [], pages: [], sample: short(r.html) };
			byKey.set(r.key, s);
		} else if (s.kind === "widget" && !s.widget && r.context) {
			// The same loader on another page may sit next to the widget's mount point (its ID).
			const v = classifySnippet(r, siteHosts);
			if (v.widget) Object.assign(s, { status: "carried", label: v.label, note: v.note, widget: v.widget });
		}
		if (!s.where.includes(r.where)) s.where.push(r.where);
		if (page && !s.pages.includes(page)) s.pages.push(page);
	};
	for (const p of input.pages) for (const r of elementsOf(p.html, undefined, base, siteHosts)) add(r, p.name);
	for (const c of codeManagerSnippets(input.codeManager)) {
		const els = elementsOf(c.html, `code manager: ${c.name} (${c.location})`, base, siteHosts);
		for (const r of els) add(r, undefined);
		// Markup outside script/iframe/link/meta (a div, a badge, text): one item of its own, never dropped silently.
		const rest = cheerio.load(c.html);
		rest("script, noscript, iframe, link, meta, style").remove();
		const leftover = (rest("body").html() ?? "").trim();
		if (leftover) add({ key: `markup:${hash(leftover.replace(/\s+/g, " "), 12)}`, tag: "markup", where: `code manager: ${c.name} (${c.location})`, html: leftover, attrs: {}, body: leftover }, undefined);
	}
	const items = [...byKey.values()];
	for (const s of items) {
		const d = input.decisions?.[s.id];
		if (d && s.status === "decision") {
			s.status = d === "drop" ? "not-needed" : "carried";
			s.note = `${d === "drop" ? "dropped" : "rebuilt by hand"} (overrides.ts snippets) — ${s.note}`;
		}
	}
	const order: SnippetKind[] = ["unknown", "widget", "provider-loader", "tracker", "verification", "page-meta", "wordpress"];
	items.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.label.localeCompare(b.label));
	return summarise({ pages: input.pages.length, items, widgets: [], counts: { carried: 0, "not-needed": 0, decision: 0 } });
}

function summarise(r: SiteSnippets): SiteSnippets {
	const seen = new Set<string>();
	r.widgets = r.items.flatMap((s) => (s.widget && s.status === "carried" && !seen.has(`${s.widget.provider}:${s.widget.id}`) && seen.add(`${s.widget.provider}:${s.widget.id}`) ? [s.widget] : []));
	r.counts = { carried: 0, "not-needed": 0, decision: 0 };
	for (const s of r.items) r.counts[s.status]++;
	return r;
}

/** Loader script URLs per embed provider (site-wide snippets that are only an external script on the provider's hosts). */
export function providerLoaders(r: SiteSnippets): Map<string, string[]> {
	const m = new Map<string, string[]>();
	for (const s of r.items) if (s.kind === "provider-loader" && s.provider && s.srcs?.length) m.set(s.provider, [...new Set([...(m.get(s.provider) ?? []), ...s.srcs])]);
	return m;
}

/**
 * An embed section whose markup has no script of its own gets its provider's site-wide loader (external scripts on
 * the provider's hosts only — the starter's embed allowlist keeps nothing else). Mariana Tek has its own completion
 * (transform/embeds.ts) and is skipped here. Returns the providers whose sections received a loader.
 */
export function completeProviderLoaders(sections: Section[], loaders: Map<string, string[]>): string[] {
	const done: string[] = [];
	for (const s of sections) {
		if (s.type !== "embed" || s.fields.provider === "marianatek") continue;
		const srcs = loaders.get(s.fields.provider);
		if (!srcs?.length || /<script\b[^>]*\bsrc=/i.test(s.fields.html)) continue;
		s.fields.html = `${s.fields.html.trim()}\n${srcs.map((src) => `<script src="${src.replace(/"/g, "&quot;")}"></script>`).join("\n")}`;
		done.push(s.fields.provider);
	}
	return done;
}

/**
 * Provider loaders once every page is adapted: carried when an embed section of that provider exists (Mariana Tek's
 * loader is completed per section; others get the site-wide script when they lack one), else a decision — the site
 * loads a provider no page embeds (a floating booking button, a popup), which needs an embed section or a drop.
 */
export function settleLoaders(r: SiteSnippets, embedProviders: Set<string>, decisions: Record<string, "drop" | "rebuilt"> = {}): SiteSnippets {
	for (const s of r.items) {
		if (s.kind !== "provider-loader" || !s.provider || decisions[s.id]) continue;
		if (s.tag === "markup") {
			s.status = "decision";
			s.note = `${provName(s.provider)} markup from a code-manager snippet${s.where.some((w) => w.endsWith("(manual)")) ? " (a manual snippet: shown only where its shortcode sits in page content)" : ""}: rebuild it where it is used (embed section, button) or drop it in overrides.ts snippets`;
		} else if (embedProviders.has(s.provider)) {
			s.status = "carried";
			s.note = s.provider === "marianatek" ? "carried with the Mariana Tek embed sections (their loader is added per section)" : `carried with the ${provName(s.provider)} embed sections${s.srcs?.length ? " (sections without a loader get this script)" : " (sections keep their own loader)"}`;
		} else {
			s.status = "decision";
			s.note = `${provName(s.provider)} is loaded site-wide but no page embeds it (floating button, popup?): add an embed section where it belongs, or drop it in overrides.ts snippets`;
		}
	}
	return summarise(r);
}

/** coverage.md section. */
export function snippetsReport(r: SiteSnippets): string[] {
	if (!r.items.length) return [];
	const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
	const L = ["", "## Site-wide snippets", "", `Head and body-level code on ${r.pages} saved page(s)${r.items.some((s) => s.where.some((w) => w.startsWith("code manager"))) ? " and the Header Footer Code Manager export" : ""}: ${r.counts.carried} carried, ${r.counts["not-needed"]} not needed, ${r.counts.decision} need a decision.`, ""];
	const decide = r.items.filter((s) => s.status === "decision");
	if (decide.length) {
		L.push("### Needs a decision", "", "| Id | What | Where | Pages | Decide |", "|---|---|---|---|---|");
		for (const s of decide) L.push(`| \`${s.id}\` | ${esc(s.label)} | ${s.where.join(", ")} | ${s.pages.length || "—"} | ${esc(s.note)} |`);
		L.push("", "Record each choice in `overrides.ts` (and the reason in `decisions.md`), then rerun transform:", "", "```ts", "snippets: {", ...decide.map((s) => `\t"${s.id}": "drop", // or "rebuilt" — ${s.label.replace(/\*\//g, "")}`), "},", "```", "");
	}
	const carried = r.items.filter((s) => s.status === "carried");
	if (carried.length) {
		L.push("### Carried", "", "| What | Kind | How |", "|---|---|---|");
		for (const s of carried) L.push(`| ${esc(s.label)} | ${s.kind} | ${esc(s.note)} |`);
		L.push("");
	}
	const wp = r.items.filter((s) => s.status === "not-needed");
	if (wp.length) {
		L.push(`<details><summary>${wp.length} not needed (WordPress, theme, plugin and Cloudflare-edge internals)</summary>`, "");
		for (const s of wp) L.push(`- ${esc(s.label)} — ${esc(s.note)}`);
		L.push("", "</details>");
	}
	return L;
}
