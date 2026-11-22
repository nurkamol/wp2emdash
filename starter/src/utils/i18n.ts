/**
 * Multilingual sites (migrated from WPML / Polylang; site.config.json `i18n`): every page keeps its WordPress address
 * as its slug (`fr/a-propos`) and carries `lang` and `lang_group`. From those this file works out the page's
 * language (`<html lang>`), its hreflang alternates (self, every published translation, x-default) and the language
 * switcher's links (the translation of this page, else that language's home page).
 * No imports: this file loads in Node (kit tests) and in the Worker. The kit's copy of the same rules is
 * src/transform/multilingual.ts; test/multilingual.test.ts holds both to the same answers.
 */

export interface I18nLanguage {
	code: string;
	/** URL directory ("" for the unprefixed default language). */
	prefix: string;
	hreflang: string;
	label: string;
	/** The language's home page when it is not its directory (`/fr/accueil/`: WordPress served the translated front page there). */
	home?: string;
}
export interface I18nConfig {
	defaultLang: string;
	languages: I18nLanguage[];
}
/** A published translation of the current page: its language and slug (the slug is its path). */
export interface Translation {
	lang: string;
	slug: string;
}
export interface SwitcherLink {
	code: string;
	label: string;
	hreflang: string;
	href: string;
	current: boolean;
	/** The link goes to the language's home page (this page has no translation in it). */
	home: boolean;
}

/** The site path of an entry slug (`home` → `/`, `fr` → `/fr/`, `fr/a-propos` → `/fr/a-propos/`). */
export function pathOfSlug(slug: string | null | undefined, style: "always" | "never" | undefined = "always"): string {
	const s = String(slug ?? "").replace(/^\/+|\/+$/g, "");
	if (!s || s === "home") return "/";
	return style === "never" ? `/${s}` : `/${s}/`;
}

/** The language of a site path: its first segment when that is a language directory, the default language otherwise. */
export function langOfPath(pathname: string, cfg: I18nConfig): I18nLanguage {
	const seg = (pathname.split("/")[1] ?? "").toLowerCase();
	return cfg.languages.find((l) => l.prefix && l.prefix === seg) ?? cfg.languages.find((l) => l.code === cfg.defaultLang) ?? (cfg.languages[0] as I18nLanguage);
}

/** The home page of a language (`/`, `/fr/`, or the translated front page's own address, `/fr/accueil/`). */
export function homeOf(lang: I18nLanguage, style: "always" | "never" | undefined = "always"): string {
	const p = lang.home ?? (lang.prefix ? `/${lang.prefix}/` : "/");
	return p === "/" ? "/" : style === "never" ? p.replace(/\/+$/, "") : p.replace(/\/?$/, "/");
}

/**
 * hreflang alternates: one per language that has a published translation (the page itself included), plus x-default
 * on the default language's version. Nothing when the page has no translation (a lone page announces no set).
 */
export function hreflangAlternates(translations: Translation[], cfg: I18nConfig, origin: string, style: "always" | "never" | undefined = "always"): { hreflang: string; href: string }[] {
	const out: { hreflang: string; href: string }[] = [];
	for (const l of cfg.languages) {
		const t = translations.find((x) => x.lang === l.code);
		if (t) out.push({ hreflang: l.hreflang, href: `${origin}${pathOfSlug(t.slug, style)}` });
	}
	if (out.length < 2) return [];
	const def = translations.find((x) => x.lang === cfg.defaultLang);
	if (def) out.push({ hreflang: "x-default", href: `${origin}${pathOfSlug(def.slug, style)}` });
	return out;
}

/** The language switcher: every language, linking to this page's translation in it, else to that language's home. */
export function switcherLinks(current: I18nLanguage, translations: Translation[], cfg: I18nConfig, style: "always" | "never" | undefined = "always"): SwitcherLink[] {
	return cfg.languages.map((l) => {
		const t = translations.find((x) => x.lang === l.code);
		return { code: l.code, label: l.label, hreflang: l.hreflang, href: t ? pathOfSlug(t.slug, style) : homeOf(l, style), current: l.code === current.code, home: !t };
	});
}

/** The menu a language's pages show: `primary-fr` when that menu exists, else the default language's `primary`. */
export function menuNameFor(base: string, lang: I18nLanguage, cfg: I18nConfig): string {
	return lang.code === cfg.defaultLang ? base : `${base}-${lang.code}`;
}
