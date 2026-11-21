# Sharing text per page and archive SEO (@wp2emdash/seo 0.3, 2026-11-21)

Parity rows `og-twitter` (#13) and `term-meta` (#10). Read from the installed `emdash@1.5.0` and `@emdash-cms/blocks@1.5.0`
(`node_modules/emdash/src`, `node_modules/@emdash-cms/blocks/dist`) of a generated project; built and tested on synthetic
fixtures only (`test/fixtures/term-seo`, `test/term-seo.test.ts`), not yet loaded into a live EmDash.

## EmDash facts relied on

- **`page:metadata` context** (`plugins/types.ts` `PublicPageContext`): `url`, `path`, `kind`, `pageType`, `title`,
  `pageTitle`, `description`, `canonical`, `image`, `content?: { collection, id, slug }`, `seo?: { ogTitle, ogDescription,
  ogImage, robots }`, `siteName`, `siteUrl`. The hook finds the entry from `content` and a term archive from `path`.
- **Order** (`components/EmDashHead.astro`, `page/metadata.ts` `resolvePageMetadata`): contributions are
  `[...staging, ...plugin, ...site, ...base]`, first wins per key (`name` for meta, `property` for property). EmDash's
  base tags (`page/seo-contributions.ts`): `og:title = seo.ogTitle ?? pageTitle ?? title`, `og:description =
  seo.ogDescription || description`, `og:image = seo.ogImage || image || defaultOgImage`, `twitter:title/description/image`
  = the same values, `twitter:card` from the image. An entry's SEO panel is overlaid onto the context first
  (`resolveSeoPanelPage`: description, canonical, image, `seo.title` → og/twitter title). So a plugin that prints only
  the fields it has leaves the SEO panel values as the fallback.
- **Between plugins** (`plugins/hooks.ts` `sortHooks`, `define-plugin.ts` `resolveHook`): hooks run by `priority`
  (lower first, default 100; a `{ priority, handler }` HookConfig works for `page:metadata`). The SEO plugin uses 50,
  so its custom image wins over `@wp2emdash/og`'s card (default 100) in the first-wins merge.
- **`<title>`** cannot come from a plugin (`applySeoPanelToPageContext` comment: "The `<title>` element itself stays the
  template's responsibility"); the starter reads the archive's stored title from D1 (`plugin:site-seo:term:<tax>:<slug>`).
- **Plugin KV** (`KVAccess`): `get`, `set`, `delete`, `list(prefix)` — the Archives tab lists stored terms with
  `list("term:")`. Rows are D1 `options` named `plugin:<id>:<key>` (as analytics/store.ts already relies on).
- **Taxonomies** (`plugins/context.ts`): `ctx.taxonomies` exists only with `taxonomies:read` (or `:write`);
  `getTerms(taxonomy)` returns `{ id, taxonomy, slug, label, parentId, data }`.
- **Block Kit 1.5:** `media_picker` is in the element union but the renderer returns `null` for it (`index.js`
  `case "media_picker": return null`) and form fields do not accept it, so image fields are text inputs (an https://
  address or a media library file address). `text_input` has `multiline`.

## WordPress facts relied on (plugin documentation, not observed on a live site in this change)

- Yoast post meta: `_yoast_wpseo_opengraph-title`, `-description`, `-image`, `_yoast_wpseo_twitter-title`,
  `-description`, `-image`. Term values in the option `wpseo_taxonomy_meta` (taxonomy → term id → `wpseo_title`,
  `wpseo_desc`, `wpseo_noindex` = `noindex|index|default`, `wpseo_opengraph-*`, `wpseo_twitter-*`). Separator:
  `wpseo_titles.separator` (`sc-dash`, `sc-pipe`, …).
- Rank Math post and term meta share keys: `rank_math_title`, `rank_math_description`, `rank_math_robots` (serialized
  array), `rank_math_facebook_title/description/image`, `rank_math_twitter_*`, and `rank_math_twitter_use_facebook`
  (default "on": Twitter reuses the Facebook values). Term meta lives in `<prefix>termmeta`, which neither the EmDash
  Exporter nor REST serve: the kit reads it from a database dump (`import-options` / `import-dump`, Rank Math keys only).
- The Exporter's post `meta` carries underscore keys (seen with `_nectar_*` on a real site), so Yoast's `_yoast_wpseo_*`
  should arrive with the post. The Exporter's own `yoast` / `rankmath` objects are read as a fallback; their key names for
  social fields are not documented.

## Not verified

- A real Yoast or Rank Math site with custom social text or term SEO through extract → load (fixtures only).
- The hook, the import route, the panel form and the Archives tab in a running EmDash (unit-tested with the kit's
  `emdash` stand-in; `astro check` in a generated project not run for this change).
