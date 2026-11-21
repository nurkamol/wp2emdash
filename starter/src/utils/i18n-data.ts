/**
 * The page's language, hreflang alternates and language switcher on a multilingual site (site.config.json `i18n`,
 * migrated from WPML / Polylang): the page's published translations are the entries of its collection with the same
 * `translation_group` (rules in utils/i18n.ts). Single-language sites: undefined, nothing is queried.
 */
import { getEmDashCollection } from "emdash";
import site from "../site.config.json";
import { hreflangAlternates, type I18nConfig, type I18nLanguage, langOfPath, type SwitcherLink, switcherLinks, type Translation } from "./i18n";

export const i18nConfig = (site as { i18n?: I18nConfig }).i18n;

export interface PageLanguages {
	lang: I18nLanguage;
	alternates: { hreflang: string; href: string }[];
	switcher: SwitcherLink[];
}

/** `content.lang`: the entry's own language (wins over its path: sites whose URLs carry no language). */
export async function pageLanguages(pathname: string, origin: string, content?: { collection: string; group?: string | null; lang?: string | null }): Promise<PageLanguages | undefined> {
	if (!i18nConfig) return undefined;
	const style = (site as { trailingSlash?: "always" | "never" }).trailingSlash;
	const lang = i18nConfig.languages.find((l) => l.code === content?.lang) ?? langOfPath(pathname, i18nConfig);
	let translations: Translation[] = [];
	if (content?.group) {
		const r = await getEmDashCollection(content.collection, { status: "published", where: { translation_group: content.group }, limit: 50 }).catch(() => ({ entries: [] }));
		translations = (r.entries as { id: string; data: Record<string, unknown> }[]).flatMap((e) => (typeof e.data.lang === "string" && e.data.lang ? [{ lang: e.data.lang, slug: String(e.data.slug ?? e.id) }] : []));
	}
	return { lang, alternates: hreflangAlternates(translations, i18nConfig, origin, style), switcher: switcherLinks(lang, translations, i18nConfig, style) };
}
