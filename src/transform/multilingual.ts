/**
 * Multilingual WordPress sites (WPML, Polylang) → one EmDash site that answers every language at its WordPress
 * address. Decision and evidence: docs/spikes/multilingual-findings.md.
 *
 * Model: every routable entry keeps its source path as its slug (as every other entry does, so `/fr/a-propos/` stays
 * `/fr/a-propos/`), and carries two fields: `lang` (the language code) and `translation_group` (shared by the
 * translations of one page). The starter reads them for `<html lang>`, hreflang alternates and the language switcher.
 * EmDash's native i18n (Astro `i18n`, per-locale rows) is not switched on: see the findings for why.
 *
 * Supported URL modes: a language directory for every language but the default (`/fr/…`, WPML "Different languages in
 * directories", Polylang "The language is set from the directory name") and no language in the URL at all (Polylang
 * "The language is set from the content"). A prefixed default language, subdomains, separate domains and `?lang=` are
 * reported and stop the migration for a decision (gate `languages-url-mode`).
 *
 * Pure functions: transform, scaffold, load and verify share them; tests run them on synthetic fixtures.
 */
import type { GateCheck } from "../core/state.js";

export type MlPlugin = "wpml" | "polylang";
export type UrlMode = "directory" | "content" | "subdomain" | "domain" | "query" | "unknown";

export interface MlLanguage {
	/** Language code: the `lang` field value, and the URL prefix in directory mode unless `prefix` says otherwise. */
	code: string;
	/** URL directory of the language ("" for an unprefixed default language). */
	prefix: string;
	/** hreflang value the live site printed for it (else the code). */
	hreflang: string;
	/** Native name for the language switcher. */
	label: string;
	default: boolean;
}

export interface MlPlan {
	plugin: MlPlugin;
	defaultLang: string;
	languages: MlLanguage[];
	urlMode: UrlMode;
	/** The default language has its own directory too (`/en/…`). */
	defaultPrefixed: boolean;
	/** Where the URL mode came from. */
	modeSource: "options" | "hreflang" | "paths" | "none";
	/** Directory or no-language URLs with an unprefixed default: migrated as is. Anything else needs a decision. */
	supported: boolean;
	/** Why it is not supported (empty when supported). */
	problems: string[];
}

/** Per-entry language assignment read from the export. */
export interface EntryLanguage {
	lang?: string;
	group?: string;
}

/** What the exporter (EmDash Exporter ≥ 1.2) and the multilingual plugins leave on a post. */
export interface MlPostInput {
	id: number;
	post_type: string;
	slug: string;
	status: string;
	/** BCP 47 locale (EmDash Exporter, WPML/Polylang detected). */
	locale?: string;
	/** WPML trid / Polylang translation group (EmDash Exporter). */
	translation_group?: string | number;
	taxonomies?: Record<string, { id: number; name: string; slug: string }[]>;
}

/** A row of WPML's `<prefix>icl_translations` table (from a database dump, `import-options`). */
export interface WpmlRow {
	element_id: string | number | null;
	element_type: string | null;
	trid: string | number | null;
	language_code: string | null;
	source_language_code?: string | null;
}

/** Raw multilingual data kept by extract / import-options (raw/multilingual.json). */
export interface MlRaw {
	/** EmDash Exporter probe `i18n`. */
	probe?: { plugin?: string; default_locale?: string; locales?: string[] };
	/** `icl_sitepress_settings` (WPML) and `polylang` options, from a database dump. */
	options?: { icl_sitepress_settings?: unknown; polylang?: unknown };
	/** WPML translations table, from a database dump. */
	wpml?: WpmlRow[];
}

/** Raw multilingual data from a database dump (import-options): raw/multilingual.json. */
export const ML_FILE = "multilingual.json";

/** Taxonomies the multilingual plugins use to classify posts and terms: language data, never content. */
export const ML_TAXONOMIES = ["language", "post_translations", "term_language", "term_translations"];

/** Post types whose translations are site chrome (headers, footers, popups, templates): only the default language is migrated. */
export const TEMPLATE_TYPES = new Set(["salient_g_sections", "popup", "bricks_template", "elementor_library", "et_template", "et_header_layout", "et_body_layout", "et_footer_layout", "et_pb_layout", "wp_block", "nectar_slider", "home_slider", "popup_theme", "pum_cta"]);

const NATIVE: Record<string, string> = {
	ar: "العربية", bg: "Български", ca: "Català", cs: "Čeština", da: "Dansk", de: "Deutsch", el: "Ελληνικά", en: "English", es: "Español", et: "Eesti", fa: "فارسی", fi: "Suomi", fr: "Français", he: "עברית", hi: "हिन्दी", hr: "Hrvatski", hu: "Magyar", id: "Bahasa Indonesia", it: "Italiano", ja: "日本語", ka: "ქართული", kk: "Қазақ", ko: "한국어", lt: "Lietuvių", lv: "Latviešu", nb: "Norsk bokmål", nl: "Nederlands", pl: "Polski", pt: "Português", "pt-br": "Português (Brasil)", "pt-pt": "Português (Portugal)", ro: "Română", ru: "Русский", sk: "Slovenčina", sl: "Slovenščina", sr: "Српски", sv: "Svenska", th: "ไทย", tr: "Türkçe", uk: "Українська", uz: "O‘zbekcha", vi: "Tiếng Việt", zh: "中文", "zh-hans": "简体中文", "zh-hant": "繁體中文",
};

/** Language codes as EmDash and the URL use them: lower case, `-` separated (`pt_BR` → `pt-br`). */
export const normCode = (s: string) => s.trim().toLowerCase().replace(/_/g, "-");
const primary = (s: string) => normCode(s).split("-")[0] ?? "";

/** The multilingual plugin in use: the exporter's probe, else the language taxonomies / WPML rows the export carries. */
export function detectPlugin(raw: MlRaw, posts: MlPostInput[], plugins: string[] = []): MlPlugin | undefined {
	const p = raw.probe?.plugin?.toLowerCase();
	if (p === "wpml" || p === "polylang") return p;
	if (raw.wpml?.length || raw.options?.icl_sitepress_settings) return "wpml";
	if (raw.options?.polylang || posts.some((x) => x.taxonomies?.language?.length)) return "polylang";
	if (plugins.some((x) => /sitepress|wpml/i.test(x))) return "wpml";
	if (plugins.some((x) => /polylang/i.test(x))) return "polylang";
	return undefined;
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** URL mode from the plugin's own settings (database dump). */
export function urlModeFromOptions(plugin: MlPlugin, options: MlRaw["options"]): { mode: UrlMode; defaultPrefixed: boolean; defaultLang?: string } | undefined {
	if (plugin === "wpml") {
		const s = asRecord(options?.icl_sitepress_settings);
		if (!Object.keys(s).length) return undefined;
		const t = Number(s.language_negotiation_type);
		const urls = asRecord(s.urls);
		const defaultPrefixed = !!Number(urls.directory_for_default_language ?? 0);
		const domains = Object.values(asRecord(s.language_domains)).map(String);
		const mode: UrlMode = t === 1 ? "directory" : t === 2 ? (domains.length && domains.every((d) => /^[a-z0-9-]+\.[^.]+\.[^.]+/i.test(d.replace(/^https?:\/\//, ""))) ? "subdomain" : "domain") : t === 3 ? "query" : "unknown";
		return { mode, defaultPrefixed: mode === "directory" && defaultPrefixed, ...(typeof s.default_language === "string" ? { defaultLang: normCode(s.default_language) } : {}) };
	}
	const s = asRecord(options?.polylang);
	if (!Object.keys(s).length) return undefined;
	const f = Number(s.force_lang);
	const mode: UrlMode = f === 0 ? "content" : f === 1 ? "directory" : f === 2 ? "subdomain" : f === 3 ? "domain" : "unknown";
	return { mode, defaultPrefixed: mode === "directory" && !Number(s.hide_default ?? 1), ...(typeof s.default_lang === "string" ? { defaultLang: normCode(s.default_lang) } : {}) };
}

/** URL mode from the live pages' hreflang links (audit snapshots): what the visitor actually sees. */
export function urlModeFromHreflang(pages: { url: string; hreflang: { lang: string; href: string }[] }[], codes: string[], defaultLang: string): { mode: UrlMode; defaultPrefixed: boolean } | undefined {
	const votes = new Map<UrlMode, number>();
	let defaultPrefixed = 0;
	let defaultPlain = 0;
	for (const p of pages) {
		let host: string;
		try {
			host = new URL(p.url).host.replace(/^www\./, "");
		} catch {
			continue;
		}
		for (const a of p.hreflang) {
			if (a.lang === "x-default") continue;
			let u: URL;
			try {
				u = new URL(a.href, p.url);
			} catch {
				continue;
			}
			const code = matchCode(a.lang, codes);
			const seg = normCode(u.pathname.split("/")[1] ?? "");
			if (code === defaultLang) {
				if (seg === defaultLang) defaultPrefixed++;
				else defaultPlain++;
				continue;
			}
			const h = u.host.replace(/^www\./, "");
			const mode: UrlMode = h !== host ? (h.endsWith(`.${host}`) || host.split(".").slice(1).join(".") === h.split(".").slice(1).join(".") ? "subdomain" : "domain") : u.searchParams.has("lang") ? "query" : code && seg === code ? "directory" : "content";
			votes.set(mode, (votes.get(mode) ?? 0) + 1);
		}
	}
	const best = [...votes].sort((a, b) => b[1] - a[1])[0];
	if (!best) return undefined;
	return { mode: best[0], defaultPrefixed: best[0] === "directory" && defaultPrefixed > defaultPlain };
}

/** The language code a locale or hreflang value names, among the site's codes (`fr-FR` → `fr`, `pt-BR` → `pt-br`). */
export function matchCode(value: string, codes: string[]): string | undefined {
	const v = normCode(value);
	if (codes.includes(v)) return v;
	const p = primary(v);
	const same = codes.filter((c) => primary(c) === p);
	return same.length === 1 ? same[0] : undefined;
}

/**
 * Canonical codes for a set of locales: the primary subtag (`fr`, `fr-FR` → `fr`), unless two regional variants of it
 * are both in use (`pt-br`, `pt-pt` stay apart).
 */
export function codesFor(locales: string[]): Map<string, string> {
	const norm = [...new Set(locales.map(normCode).filter(Boolean))];
	const out = new Map<string, string>();
	for (const l of norm) out.set(l, l.includes("-") && norm.filter((x) => x.includes("-") && primary(x) === primary(l)).length > 1 ? l : primary(l));
	return out;
}

/** Each post's language and translation group: exporter fields, else Polylang's taxonomies, else WPML's table. */
export function entryLanguages(posts: MlPostInput[], raw: MlRaw, codeOf: (locale: string) => string): Map<number, EntryLanguage> {
	const out = new Map<number, EntryLanguage>();
	const wpml = new Map<string, WpmlRow>();
	for (const r of raw.wpml ?? []) if (r.element_id != null && r.element_type?.startsWith("post_")) wpml.set(`${r.element_type}:${r.element_id}`, r);
	for (const p of posts) {
		const row = wpml.get(`post_${p.post_type}:${p.id}`);
		const pllLang = p.taxonomies?.language?.[0]?.slug;
		const pllGroup = p.taxonomies?.post_translations?.[0];
		const lang = p.locale ? codeOf(p.locale) : pllLang ? codeOf(pllLang) : row?.language_code ? codeOf(row.language_code) : undefined;
		const group = p.translation_group !== undefined && p.translation_group !== null && String(p.translation_group) !== "" ? `g-${String(p.translation_group)}` : pllGroup ? `pll-${pllGroup.slug || pllGroup.id}` : row?.trid != null ? `trid-${row.trid}` : undefined;
		out.set(p.id, { ...(lang ? { lang } : {}), group: group ?? `${p.post_type}-${p.id}` });
	}
	return out;
}

export interface PlanInput {
	raw: MlRaw;
	posts: MlPostInput[];
	/** Plugin slugs the audit saw (snapshot/fingerprint.json). */
	plugins?: string[];
	/** The live pages' hreflang links (audit snapshots). */
	snapshots?: { url: string; hreflang: { lang: string; href: string }[] }[];
	/** Live path of every audited entry (snapshot/urls.json). */
	pathById?: Map<number, string>;
	/** WordPress's own site language (exporter probe `site.language`). */
	siteLanguage?: string;
	/** Language names Polylang keeps on its language terms (`language` taxonomy term name). */
	names?: Map<string, string>;
}

/** The site's languages, URL mode and whether it can be migrated as is. Undefined: not a multilingual site. */
export function buildPlan(input: PlanInput): { plan: MlPlan; entries: Map<number, EntryLanguage> } | undefined {
	const plugin = detectPlugin(input.raw, input.posts, input.plugins);
	if (!plugin) return undefined;
	const locales = [...(input.raw.probe?.locales ?? []), ...(input.raw.probe?.default_locale ? [input.raw.probe.default_locale] : []), ...input.posts.flatMap((p) => [p.locale, p.taxonomies?.language?.[0]?.slug].filter((x): x is string => !!x)), ...(input.raw.wpml ?? []).flatMap((r) => (r.language_code ? [r.language_code] : []))];
	const fromOptions = urlModeFromOptions(plugin, input.raw.options);
	if (fromOptions?.defaultLang) locales.push(fromOptions.defaultLang);
	const codes = codesFor(locales);
	const codeOf = (l: string) => codes.get(normCode(l)) ?? matchCode(l, [...new Set(codes.values())]) ?? primary(l);
	const entries = entryLanguages(input.posts, input.raw, codeOf);
	const all = [...new Set(codes.values())];
	const defaultLang = fromOptions?.defaultLang ? codeOf(fromOptions.defaultLang) : input.raw.probe?.default_locale ? codeOf(input.raw.probe.default_locale) : input.siteLanguage && all.includes(codeOf(input.siteLanguage)) ? codeOf(input.siteLanguage) : (mostCommon([...entries.values()].map((e) => e.lang)) ?? all[0] ?? "en");
	if (!all.includes(defaultLang)) all.unshift(defaultLang);
	// URL mode: the plugin's settings, else the live hreflang links, else the audited paths of translated entries.
	const fromHreflang = fromOptions ? undefined : urlModeFromHreflang(input.snapshots ?? [], all, defaultLang);
	let mode = fromOptions ?? fromHreflang;
	let modeSource: MlPlan["modeSource"] = fromOptions ? "options" : fromHreflang ? "hreflang" : "none";
	const firstSegments = (code: string) => [...entries].filter(([, e]) => e.lang === code).flatMap(([id]) => (input.pathById?.get(id) ? [normCode(input.pathById.get(id)?.split("/")[1] ?? "")] : []));
	if (!mode) {
		const others = all.filter((c) => c !== defaultLang);
		const segs = others.map((c) => ({ c, s: firstSegments(c) })).filter((x) => x.s.length);
		if (segs.length) {
			const dir = segs.every((x) => x.s.filter((s) => s === x.c).length > x.s.length / 2);
			mode = { mode: dir ? "directory" : "content", defaultPrefixed: dir && firstSegments(defaultLang).some((s) => s === defaultLang) && firstSegments(defaultLang).filter((s) => s === defaultLang).length > firstSegments(defaultLang).length / 2 };
			modeSource = "paths";
		}
	}
	const urlMode = mode?.mode ?? "unknown";
	const defaultPrefixed = mode?.defaultPrefixed ?? false;
	// Directory per language: the live paths' first segment when they agree, else the code.
	const prefixOf = (code: string) => {
		if (urlMode !== "directory" || (code === defaultLang && !defaultPrefixed)) return "";
		const segs = firstSegments(code);
		const top = mostCommon(segs);
		return top && segs.filter((s) => s === top).length > segs.length / 2 && top !== "" ? top : code;
	};
	const hreflangOf = (code: string) => {
		for (const p of input.snapshots ?? []) for (const a of p.hreflang) if (a.lang !== "x-default" && matchCode(a.lang, all) === code) return a.lang;
		return code;
	};
	const languages: MlLanguage[] = [defaultLang, ...all.filter((c) => c !== defaultLang).sort()].map((code) => ({ code, prefix: prefixOf(code), hreflang: hreflangOf(code), label: input.names?.get(code) ?? NATIVE[code] ?? NATIVE[primary(code)] ?? code.toUpperCase(), default: code === defaultLang }));
	const problems: string[] = [];
	if (urlMode === "unknown") problems.push("URL mode not found: no plugin settings (import-dump a database backup), no hreflang links on the live pages and no audited translated pages");
	if (urlMode === "subdomain" || urlMode === "domain") problems.push(`languages on ${urlMode === "subdomain" ? "subdomains" : "separate domains"}: one Worker per host or host-based routing is needed (owner decision)`);
	if (urlMode === "query") problems.push("language in the query string (?lang=xx): the paths of translations collide; choose directory URLs with redirects from ?lang= (owner decision)");
	if (urlMode === "directory" && defaultPrefixed) problems.push(`the default language has its own directory (/${defaultLang}/): keep it with redirects from / or drop the prefix (owner decision)`);
	if (languages.length < 2) problems.push(`only one language (${defaultLang}) has content: migrate as a single-language site (owner decision)`);
	return { plan: { plugin, defaultLang, languages, urlMode, defaultPrefixed, modeSource, supported: problems.length === 0, problems }, entries };
}

function mostCommon<T>(list: (T | undefined)[]): T | undefined {
	const n = new Map<T, number>();
	for (const x of list) if (x !== undefined) n.set(x, (n.get(x) ?? 0) + 1);
	return [...n].sort((a, b) => b[1] - a[1])[0]?.[0];
}

/** A route in its language: the language directory in front when the route does not already start with it. */
export function localizeRoute(path: string, lang: string | undefined, plan: MlPlan): string {
	if (!lang || !plan.supported || plan.urlMode !== "directory") return path;
	const l = plan.languages.find((x) => x.code === lang);
	if (!l?.prefix) return path;
	if (path === `/${l.prefix}` || path === `/${l.prefix}/` || path.startsWith(`/${l.prefix}/`)) return path;
	return path === "/" ? `/${l.prefix}/` : `/${l.prefix}${path.startsWith("/") ? path : `/${path}`}`;
}

/** The language a site path belongs to (its first segment), the default language otherwise. */
export function langOfPath(path: string, plan: Pick<MlPlan, "languages" | "defaultLang">): string {
	const seg = normCode(path.split("/")[1] ?? "");
	return plan.languages.find((l) => l.prefix && l.prefix === seg)?.code ?? plan.defaultLang;
}

/** A WordPress menu's language: the exporter's field, Polylang's `location___xx`, WPML's table, else the language most of its links point into. */
export function menuLanguage(menu: { id?: number; locations: string[]; locale?: string; items: { url: string }[] }, plan: MlPlan, wpml: WpmlRow[] = [], siteHosts: Set<string> = new Set()): string {
	const codes = plan.languages.map((l) => l.code);
	if (menu.locale) return matchCode(menu.locale, codes) ?? plan.defaultLang;
	for (const loc of menu.locations) {
		const m = /___([a-z_-]+)$/i.exec(loc);
		if (m?.[1]) return matchCode(m[1], codes) ?? plan.defaultLang;
	}
	const row = wpml.find((r) => r.element_type === "tax_nav_menu" && String(r.element_id) === String(menu.id));
	if (row?.language_code) return matchCode(row.language_code, codes) ?? plan.defaultLang;
	const langs = menu.items.flatMap((i) => {
		try {
			const u = new URL(i.url, "https://site.invalid");
			if (u.host !== "site.invalid" && !siteHosts.has(u.host.replace(/^www\./, ""))) return [];
			return [langOfPath(u.pathname, plan)];
		} catch {
			return [];
		}
	});
	const top = mostCommon(langs.filter((l) => l !== plan.defaultLang));
	return top && langs.filter((l) => l === top).length > langs.length / 2 ? top : plan.defaultLang;
}

/**
 * Roles for translated menus that carry no theme location (WPML assigns locations per language, the export shows the
 * default language's): the role of the default-language menu in the same WPML translation group, else — when the
 * language has a single such menu and the default language has a primary menu — "primary". `role: other` otherwise
 * (still migrated under its own name, listed in the menus report).
 */
export function inheritMenuRoles<T extends { id?: number; role: string; lang?: string; wpLocations: string[] }>(menus: T[], wpml: WpmlRow[] = []): T[] {
	const trid = (id?: number) => wpml.find((r) => r.element_type === "tax_nav_menu" && String(r.element_id) === String(id))?.trid;
	const defaults = menus.filter((m) => !m.lang);
	return menus.map((m) => {
		if (!m.lang || m.role !== "other" || m.wpLocations.length) return m;
		const t = trid(m.id);
		const twin = t != null ? defaults.find((d) => trid(d.id) != null && String(trid(d.id)) === String(t) && d.role !== "other") : undefined;
		if (twin) return { ...m, role: twin.role };
		const siblings = menus.filter((x) => x.lang === m.lang && x.role === "other" && !x.wpLocations.length);
		if (siblings.length === 1 && defaults.some((d) => d.role === "primary") && !menus.some((x) => x.lang === m.lang && x.role === "primary")) return { ...m, role: "primary" };
		return m;
	});
}

/** Menu locations without Polylang's language suffix (`primary___fr` → `primary`). */
export const baseLocations = (locations: string[]) => [...new Set(locations.map((l) => l.replace(/___[a-z_-]+$/i, "")))];

/** Routable IR documents as the multilingual checks see them. */
export interface MlDoc {
	kind: string;
	wpId: number;
	type: string;
	path?: string;
	published: boolean;
	lang?: string;
	group?: string;
}

/** Translation groups of the routable documents (page, post, entry), each with its documents. */
export function translationGroups(docs: MlDoc[]): Map<string, MlDoc[]> {
	const out = new Map<string, MlDoc[]>();
	for (const d of docs) if (d.group && d.path) (out.get(d.group) ?? out.set(d.group, []).get(d.group))?.push(d);
	return out;
}

/** The transform gates of a multilingual site. */
export function multilingualChecks(plan: MlPlan, docs: MlDoc[]): GateCheck[] {
	const routable = docs.filter((d) => d.path && ["page", "post", "entry"].includes(d.kind));
	// Pages and posts always have a language when the plugin is active (missing = a data gap); custom post types the
	// plugin does not translate have none: listed in the report, shown as the default language.
	const missing = routable.filter((d) => !d.lang && d.kind !== "entry");
	const dupes = [...translationGroups(routable)].filter(([, list]) => new Set(list.map((d) => d.lang)).size < list.length);
	const misplaced = plan.urlMode === "directory" && plan.supported ? routable.filter((d) => d.published && d.lang && langOfPath(d.path as string, plan) !== d.lang) : [];
	const counts = plan.languages.map((l) => `${l.code} ${routable.filter((d) => d.lang === l.code).length}`).join(", ");
	return [
		{ id: "languages-url-mode", label: "Language URLs kept as they are (a directory per language, or no language in the URL)", ok: plan.supported, detail: plan.supported ? `${plan.plugin}: ${plan.urlMode === "directory" ? `directories ${plan.languages.filter((l) => l.prefix).map((l) => `/${l.prefix}/`).join(" ")}` : "no language in the URL"}, default ${plan.defaultLang} unprefixed (from ${plan.modeSource})` : `${plan.plugin}: ${plan.problems.join("; ")}` },
		{ id: "languages-assigned", label: "Every migrated page and post has its language", ok: missing.length === 0, detail: missing.length ? `no language: ${missing.slice(0, 8).map((d) => `${d.type}#${d.wpId} ${d.path}`).join(", ")}${missing.length > 8 ? ", …" : ""}` : counts },
		{ id: "languages-groups", label: "Each translation group holds one entry per language", ok: dupes.length === 0, detail: dupes.length ? dupes.slice(0, 6).map(([g, list]) => `${g}: ${list.map((d) => `${d.lang ?? "?"} ${d.path}`).join(", ")}`).join("; ") : `${[...translationGroups(routable)].filter(([, l]) => l.length > 1).length} translated groups` },
		...(plan.urlMode === "directory" && plan.supported ? [{ id: "languages-routes", label: "Every published translation keeps its language directory", ok: misplaced.length === 0, ...(misplaced.length ? { detail: misplaced.slice(0, 8).map((d) => `${d.path} is ${d.lang}`).join(", ") } : {}) }] : []),
	];
}

/** Coverage report section: languages, counts, URL mode, and everything language-related that was not migrated. */
export function multilingualReport(plan: MlPlan, docs: MlDoc[], notMigrated: string[]): string[] {
	const routable = docs.filter((d) => d.path && ["page", "post", "entry"].includes(d.kind));
	const groups = [...translationGroups(routable)];
	const L = ["", "## Languages", "", `${plan.plugin === "wpml" ? "WPML" : "Polylang"}, default language **${plan.defaultLang}**, URL mode **${plan.urlMode}**${plan.defaultPrefixed ? " (default prefixed)" : ""} (from ${plan.modeSource}). ${plan.supported ? "Migrated with every address kept: each entry carries `lang` and `translation_group`; the starter prints `<html lang>`, hreflang alternates and a language switcher." : `**Needs a decision:** ${plan.problems.join("; ")}.`}`, "", "| Language | Directory | hreflang | Pages | Posts | Entries |", "|---|---|---|---|---|---|"];
	for (const l of plan.languages) {
		const n = (k: string) => routable.filter((d) => d.lang === l.code && d.kind === k).length;
		L.push(`| ${l.label} (${l.code})${l.default ? " — default" : ""} | ${l.prefix ? `/${l.prefix}/` : "—"} | ${l.hreflang} | ${n("page")} | ${n("post")} | ${n("entry")} |`);
	}
	const untranslated = groups.filter(([, list]) => list.length === 1 && list[0]?.lang === plan.defaultLang).length;
	L.push("", `${groups.filter(([, l]) => l.length > 1).length} translation group(s); ${untranslated} default-language entr${untranslated === 1 ? "y" : "ies"} without a translation (the switcher links to the language's home page there).`);
	const missing = routable.filter((d) => !d.lang);
	if (missing.length) L.push("", "**Without a language** (pages are gated by `languages-assigned`; entries of a post type the plugin does not translate are shown as the default language):", "", ...missing.map((d) => `- ${d.type}#${d.wpId} ${d.path}`));
	if (notMigrated.length) L.push("", "**Not migrated** (listed so nothing is lost silently; decide in overrides.ts / decisions.md):", "", ...notMigrated.map((n) => `- ${n}`));
	L.push("", "Not carried by design: string translations (WPML String Translation, Polylang strings: theme and widget texts) and per-language taxonomy term links (terms of every language are migrated as their own terms, unlinked).");
	return L;
}

/** Fields the load phase adds to every routable collection of a multilingual site. */
export const LANG_FIELD = { slug: "lang", label: "Language", type: "string" } as const;
export const GROUP_FIELD = { slug: "translation_group", label: "Translation group (same value on every translation of this page)", type: "string" } as const;

/**
 * The language switcher's links for one page and the hreflang alternates, from the page's translations. Pure: the
 * starter has its own copy (starter/src/utils/i18n.ts, which cannot import the kit) and the tests hold both to the
 * same answers. `translations`: the published entries of the group (the page itself included), as path + lang.
 */
export function hreflangAlternates(translations: { lang: string; path: string }[], plan: Pick<MlPlan, "languages" | "defaultLang">, origin: string): { hreflang: string; href: string }[] {
	const out: { hreflang: string; href: string }[] = [];
	for (const l of plan.languages) {
		const t = translations.find((x) => x.lang === l.code);
		if (t) out.push({ hreflang: l.hreflang, href: `${origin}${t.path}` });
	}
	if (out.length < 2) return [];
	const def = translations.find((x) => x.lang === plan.defaultLang);
	if (def) out.push({ hreflang: "x-default", href: `${origin}${def.path}` });
	return out;
}
