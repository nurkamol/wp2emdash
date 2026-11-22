# Multilingual sites (WPML, Polylang) — findings

**Date:** 2026-11-22 · **EmDash:** 1.5.0 (installed in `spikes/m0-site`, read from `node_modules/emdash/src`) · **Astro:** 7.4.12 · docs: <https://docs.emdashcms.com/guides/internationalization/> (via `llms.txt`)

## Question

Does EmDash 1.5 support localized content (locales, linked translations, per-locale routing), and should the kit
migrate WPML / Polylang sites onto it — or onto a kit-owned model (a `lang` field + a `translationGroup` field, the
starter routing by prefix)?

## What EmDash 1.5 has (verified in source)

| Area | Finding | Where |
|---|---|---|
| Content rows | Row-per-locale: every `ec_*` table has `locale TEXT NOT NULL DEFAULT 'en'` and `translation_group`; slugs unique per `(slug, locale)`. | `database/migrations/019_i18n.ts`, `055_…`, `080_…` |
| Create a translation | `POST /_emdash/api/content/{c}` accepts `locale` and `translationOf` (source id); the new row joins the source's group; a second row in the same locale → `CONFLICT`. Non-translatable fields are copied from the source. | `api/schemas/content.ts` (`contentCreateBody`), `emdash-runtime.ts` `handleContentCreate` |
| Locale validation | Without Astro `i18n` any valid code (`/^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i`) is accepted; with it, only configured locales. Default when omitted: `defaultLocale`, else `"en"`. | `i18n/config.ts` `resolveContentCreateLocale` |
| Config | Read from Astro's `i18n` block (`defaultLocale`, `locales`, `fallback`, `routing.prefixDefaultLocale`). | `i18n/normalize.ts`, `astro/integration/index.ts` |
| Request locale | Middleware puts `Astro.currentLocale` in the request context; every query without an explicit locale then filters by it (`resolveLocale`: explicit > request > `defaultLocale`). | `astro/middleware/request-context.ts`, `i18n/resolve.ts` |
| Lists vs entries | Only single-entry reads fall back through the locale chain; collection lists return the requested locale only. | `query.ts` |
| Translations | `getTranslations(collection, id)` → every row of the group (drafts included). | `query.ts` |
| hreflang | `EmDashHead` adds alternates (self + x-default) when i18n is on and the page has `content`; paths come from the collection's `urlPattern` with `encodeURIComponent(slug)` and the locale prefix. | `components/EmDashHead.astro`, `seo/hreflang.ts`, `i18n/resolve.ts` |
| Menus, terms, bylines, taxonomy definitions | All per locale (`locale` + `translation_group`, `translationOf` on create). Term assignments on content are resolved **in the entry's locale** (`Unknown taxonomy term … (locale 'fr')` otherwise); byline credits render only when a byline row exists in the entry's locale. | migrations `036`, `040`, `078`, `082`, `085`; `api/handlers/content.ts` `assignTaxonomies` |
| Docs | "Keep the default locale unprefixed … a strategy prefixing the default locale breaks the EmDash admin." WXR import carries no WPML/Polylang data. The EmDash Exporter plugin's `content` rows carry `locale` and `translation_group`, its probe `i18n { plugin, default_locale, locales }`. | i18n guide; `import/sources/wordpress-plugin.ts` |
| Astro | `computeCurrentLocale` matches a locale code in **any** path segment, not only the first (`/menu/fr/` → `fr`). | `astro/dist/i18n/utils.js` |

## Decision: kit-owned language fields on the existing path-as-slug model (option b), native rows later

EmDash's native i18n exists and is solid, but switching it on for migrated sites conflicts with how the kit already
guarantees URL parity, and it would touch every subsystem at once:

1. **Routing and hreflang disagree with the kit's slugs.** The kit stores each entry's WordPress path as its slug
   (`about/team`, front page `home`) and the starter serves `[...slug]`. EmDash's hreflang/sitemap paths come from
   `urlPattern` + `encodeURIComponent(slug)`: `/home`, `/about%2Fteam`, `/fr/fr%2Fa-propos` — wrong alternates in
   `<head>` the moment Astro `i18n` is configured.
2. **A prefixed default language cannot be kept** (`/en/…`): EmDash's docs say it breaks the admin.
3. **Every list query changes meaning.** With `i18n` on, blog listings, popups, collections and menus all filter by the
   request locale; site parts and popups that exist once (default language) disappear from translated pages.
4. **Terms, bylines and taxonomy definitions are per locale.** A French post's categories must exist as French terms,
   its byline as a French byline row — new load code for every one of them, none of which can be exercised here
   without a running EmDash (no live instance in this session).
5. **Astro's locale detection reads any segment**, so a default-language page whose path contains `/fr/` would render
   as French.

The kit model keeps all of that unchanged and still preserves every source URL exactly:

- Every routable entry keeps its WordPress path as its slug (as before), so `/fr/a-propos/` stays `/fr/a-propos/`
  with no routing change. A translation the audit did not see gets its language directory in front of its WordPress
  path; the front page's translations are their language's home (`/fr/`).
- Two string fields on routable collections: `lang` (language code) and `lang_group` (shared by the
  translations of one page; WPML `trid`, Polylang `post_translations` term, or the exporter's group).
- The starter reads them: `<html lang>`, `<link rel="alternate" hreflang>` for self + each published translation +
  `x-default` (default-language version), a language switcher (translation, else the language's home), per-language
  menus `primary-<lang>` (fallback `primary`). Translations are found with
  `getEmDashCollection(c, { where: { lang_group } })` — `where` on a content column is documented in
  `query.ts` (`CollectionFilterBase.where`).
- Astro `i18n` stays off, so EmDash keeps its single-locale behaviour (no list filtering, no automatic hreflang — no
  duplicate links).

Moving to native rows later is a mapping, not a migration of content: `lang` → `locale`, `lang_group` →
`translationOf` on create, plus per-locale terms/bylines and slugs without the prefix. Revisit when EmDash's hreflang
honours nested slugs and a prefixed default locale.

## URL modes

| Mode | WPML (`icl_sitepress_settings.language_negotiation_type`) | Polylang (`polylang.force_lang`) | Kit |
|---|---|---|---|
| Directory, default unprefixed | `1`, `urls.directory_for_default_language = 0` | `1`, `hide_default = 1` | **migrated** |
| No language in the URL | — | `0` (language from the content) | **migrated** (paths are unique) |
| Directory, default prefixed | `1`, `directory_for_default_language = 1` | `1`, `hide_default = 0` | gate `languages-url-mode` red: owner decision |
| Subdomains / domains | `2` (`language_domains`) | `2` / `3` | gate red: one Worker per host or host routing |
| `?lang=xx` | `3` | — | gate red: paths collide |

Where the mode comes from, in order: the plugin's options (database dump → `import-dump` / `import-options` →
`raw/multilingual.json`), the live pages' hreflang links (audit snapshots), the audited paths of translated entries.

## Data sources (extract)

- EmDash Exporter `content`: `locale`, `translation_group` per entry; probe `i18n`.
- Polylang: the `language` and `post_translations` taxonomies on each entry (no description needed: entries sharing
  the term are one group).
- WPML: `<prefix>icl_translations` (element_type, element_id, trid, language_code) from a dump; also `tax_nav_menu`
  rows for menus.
- Polylang's `primary___fr` menu locations, `#pll_switcher` menu items (replaced by the switcher, listed).

## Not carried (reported in the coverage report → Languages)

- Translated site chrome (Salient global sections, Bricks / Elementor / Divi templates, popups, reusable blocks): the
  default language's is migrated, each translation is listed.
- String translations (WPML String Translation, Polylang strings) and per-language term links (terms of every
  language are migrated as their own terms, unlinked).
- Blog listings, archives and feeds per language: they list the default language's posts; a translated posts page,
  category or author archive under `/fr/…` has no list of posts (the translated posts page migrates as a page with its own text only).
- Previous/next and related posts are not filtered by language.

## Field name collision (2026-11-22, WordPress end-to-end test)

The group field was first named `translation_group`. That is a **system column** on every EmDash 1.5 content table
(migration `019_i18n`; the kit's `RESERVED_SLUGS` already listed it), so a real setup failed with
`D1_ERROR: duplicate column name: translation_group` — the synthetic fixtures never created a database. Renamed to
`lang_group`; a test now checks both language fields against `RESERVED_SLUGS`. No delivered site used it.

## Every French page 404 (2026-11-22, WordPress end-to-end test)

Symptom: load created the French pages and posts without errors, then its `render` check got 404 for every `/fr/…`
address (`[404] (rewrite) /fr/a-propos/` in the dev server log); English pages and products rendered.

**EmDash is not the cause — verified on EmDash 1.5.0 / Astro 7.4.12** (a copy of `spikes/m0-site`, `astro dev` with
local D1, `POST /_emdash/api/setup/dev-bypass?content=0`, fields and entries created through the kit's `EmDashApi`
with `devBypass`, a `[...slug].astro` printing what `getEmDashEntry("pages", decodeSlug(slug))` returns):

| Entry (published) | GET | Result |
|---|---|---|
| slug `fr/a-propos`, `{ lang: "fr", lang_group: "g1" }` | `/fr/a-propos/` and `/fr/a-propos` | 200, found, `locale: "en"`, `lang: "fr"` |
| slug `about`, `{ lang: "en", lang_group: "g1" }` | `/about/` | 200, found |
| slug `fr/plain`, no language fields | `/fr/plain/` | 200, found |
| slug `xx/a-propos`, `{ lang: "fr" }` | `/xx/a-propos/` | 200, found |

- `lang` / `lang_group` are plain columns (`ec_pages.lang`); no collision with the `locale` system column or reserved keys.
- `Astro.currentLocale` is `undefined` without an Astro `i18n` block (`FetchState.computeCurrentLocale` returns early
  when `manifest.i18n` is unset), so EmDash's request context has no locale and the slug lookup is unscoped
  (`loader.ts` `loadEntry`: `c.slug = ? OR c.id = ?`).
- A slug whose first segment looks like a language is stored and resolved as written; entries are created in the
  default locale `en` and published by `POST …/publish`.

**Cause: the blog's category base was `/fr/`.** The generated `site.config.json` of the failing run had
`blog.archives[category].base = "/fr/"` (and `wpUrls.bases.category = "/fr/"`). Bases come from the live term links
(`baseOf`, `src/transform/wp-urls.ts`: the first path segment before the term slug, most common wins). Polylang links a
French term as `/fr/category/actualites/`; the test site has two French and two English categories, the French ones
listed first, so `/fr/` won the tie. The starter's `blogRoute` runs before the page lookup and took `/fr/a-propos/` for
the archive of a category `a-propos`, found no such term and rewrote to 404 — for every French page and post.

**Fix:** `baseOf(items, langDirs)` leaves a language directory (the plan's non-empty prefixes) out of each link before
reading the base; transform passes it for the blog taxonomies, the author base and the WordPress-URL rules. Sites
without languages pass none, so their bases are unchanged. Translated term archives (`/fr/category/actualites/`) stay
as listed under "Not carried".
