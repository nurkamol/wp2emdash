# Site features — findings (2026-11-21, EmDash 1.5.0)

Search page, classic widget areas, every menu and mega menus, the old 404 page, 404 monitoring, breadcrumbs and
coming-soon mode. What the code depends on, where it was verified, and what is still unexercised.

**How it was checked.** Source reading of the installed `emdash@1.5.0` (a client project's `node_modules`, read only),
plus an in-memory spike: EmDash's own `runMigrations`, `validateSeed`, `applySeed`, `searchWithDb` and
`RedirectRepository` (from its `dist/`) on a throwaway libSQL file, fed with a pilot's generated seed plus synthetic
content, a footer menu and widget areas in the shape the kit writes. Nothing was written to a live site.

## Search

| Fact | Source | Verified |
|---|---|---|
| `search(query, { collections?, status = "published", locale?, limit = 20, cursor?, scope? })` from `"emdash"`; FTS5 per collection, merged by bm25 score, paged by offset (opaque cursor, max offset 10 000) | `search/query.ts` | source + spike |
| A collection is indexed when its seed `supports` has `"search"` **and** it has at least one `searchable` field; `applySeed` then enables it (`search_config {"enabled":true}`) | `seed/apply.ts` step 11 | spike: pages → enabled with `title` searchable |
| **Blocks fields cannot be searchable** (`SchemaError: Blocks fields cannot be searchable`) — the kit's first attempt (sections searchable) made `applySeed` throw | `schema/registry.ts` `normalizeBlocksFieldValidation` | spike |
| Porter stemming, every word must match ("about us" does not find "About our practice"); drafts are not found | `search/query.ts`, `fts-manager.ts` | spike |
| `snippet()` comes from the first indexed column (the title for pages and posts) and is HTML-escaped with literal `<mark>` | `search/query.ts` | source + spike (`"Massage <mark>therapy</mark>"`) |
| Portable Text fields are indexed as prose (`text`, `alt`, `caption`, `code` keys); other JSON as stored | `fts-manager.ts searchValueExpr` | source |
| Switching search on for an existing collection: `POST /_emdash/api/search/enable` and `GET /search/stats` need the `admin` token scope (`search:manage`); a field's `searchable` flag via `PUT /schema/collections/{c}/fields/{f}`, whose body **requires** `validation` (nullable) — send the field's own value back | `astro/middleware/auth.ts` SCOPE_RULES, `api/schemas/schema.ts` | source |
| EmDash's core `Search` widget posts to `/search?q=`; no `SearchAction` anywhere in EmDash's JSON-LD | `components/widgets/Search.astro`, grep | source |

**Kit design.** Pages seed `title` as searchable (FTS for page titles, and EmDash's own search API finds pages); posts
and CPT collections already index title / excerpt / body. Because sections cannot be indexed, the starter's
`/search/` page also reads the published pages (one `getEmDashCollection("pages", { limit: 300 })`) and adds the
pages whose title or section text contains every word, after EmDash's ranked hits (`starter/src/utils/search.ts`
`mergeHits`). Excerpts come from each entry (excerpt → SEO description → body/sections), not from EmDash's snippet.
Results are never route-cached; the empty form is. WordPress `/?s=` and `/search/<terms>/` 301 to `/search/?q=` (rule
`search`, default changed from home); load's `search` check marks `title` searchable and enables search on targets set
up before the search page.

## Widget areas

| Fact | Source | Verified |
|---|---|---|
| Tables `_emdash_widget_areas` (name, label, description) and `_emdash_widgets` (type `content` \| `menu` \| `component`, title, content JSON = Portable Text, menu_name, component_id, component_props) | migration `007_widgets`, `widgets/types.ts` | source |
| Seed key `widgetAreas: [{ name, label, description?, widgets: [{ type, title?, content?, menuName?, componentId?, props? }] }]` — component options go in `props` (`settings` is ignored with a warning) | `seed/types.ts`, `seed/validate.ts` | spike: 2 areas, 3 widgets, `props` → `component_props` |
| REST: `GET/POST /_emdash/api/widget-areas`, `DELETE /widget-areas/{name}`, `POST /widget-areas/{name}/widgets` ({ type, title, content, menuName, componentId, componentProps }); token scope `content:write` (GET `content:read`), role permission `widgets:manage` = Editor | `astro/routes/api/widget-areas/*`, `auth.ts`, `@emdash-cms/auth rbac.ts` | source |
| Core components: `core:recent-posts` (count, showThumbnails, showDate, urlTemplate — default links `/posts/:slug`, so the kit sets `/:slug`), `core:categories` (links `/category/<slug>`), `core:tags`, `core:search`, `core:archives` | `widgets/components.ts`, `components/widgets/*` | source |
| `getWidgetAreaWithCacheHint(name)` from `"emdash"` (tag `widgetAreaTag(name)`); `WidgetArea` from `"emdash/ui"` renders an area | `widgets/index.ts`, `ui.ts` | source |

**WordPress side.** `wp/v2/sidebars` and `wp/v2/widgets` (WP ≥ 5.8) need `edit_theme_options`: an administrator's
application password. `instance.raw` is present for widgets that show their instance in REST (all core widgets);
`rendered` is always there (used only for the owner's `html` decision). **Not yet exercised against a real WordPress**
— extract treats a refusal as "no widgets" with a note. A database dump's `sidebars_widgets` + `widget_<type>` options
give the same model (`widgetsFromOptions`).

## Menus

EmDash menu items have `label, url, target, titleAttr, cssClasses, children` — **no description** (reported in the
coverage report). Nesting via `parentId` (load) / `children` (seed) at any depth. The kit now writes every WordPress
menu (the first of each header role under `primary` / `secondary` / `footer`, the others under their own slug —
`emdashMenuNames`) — previously menus without a header role were dropped (one pilot gains its `legal` menu). Item
description / `attr_title` / classes come from `wp/v2/menu-items` (WP ≥ 5.9, administrator) when allowed. Max Mega Menu
keeps its panel settings in item meta the exporter does not read: a mega panel is recognised from the rendered header
(`mega-menu-megamenu` + `mega-menu-item-<id>`) or a theme's `megamenu` class, and rebuilt as columns of links in the
menu panel (class `mega`), reported as partial.

## 404 log and monitoring

| Fact | Source | Verified |
|---|---|---|
| `_emdash_404_log`: one row per path (UNIQUE since migration 035), `hits` running count, `last_seen_at` (nullable, backfilled), latest `referrer`, `user_agent`; written by EmDash's redirect middleware after every 404 response or redirect to `/404` (the `/404` page itself is not logged); bounded by `cleanup404Log` | `035_bounded_404_log.ts`, `astro/middleware/redirect.ts`, `repositories/redirect.ts` | source + spike (`log404` twice → `hits: 2`) |
| Admin: `GET /_emdash/api/redirects/404s/summary` (`redirects:read`, Editor); the admin's Redirects page is `/_emdash/admin/redirects` | routes, `@emdash-cms/admin` router | source |

Site health reads the log directly through its D1 binding, hourly (`SELECT path, hits, COALESCE(last_seen_at,
created_at) … WHERE … >= <7 days ago> ORDER BY hits DESC LIMIT 60` — the query ran in the spike), drops bot probes,
and suggests a sitemap page per path (same last segment, else the most shared words). Hits are all-time counts for
paths still asked for this week. Never an alert.

## Coming-soon mode

Stored by Site health in its plugin KV, which is EmDash's `options` table: key `plugin:site-health:maintenance`
(`createKVAccess` prefixes `plugin:<id>:`; the spike confirmed the `options(name, value)` columns). The starter's
middleware reads that row with one D1 query at most every 30 s per isolate and, for visitors without an
`astro-session` cookie, answers every page with a self-contained holding page: 503, `Retry-After`, `X-Robots-Tag:
noindex`, `Cache-Control: no-store`, the route cache off. `/_emdash`, `/_image`, `/api/`, `/_astro/` and files pass. While
it is on, Site health pauses uptime, search-engine, analytics and link checks (no false "down"). Never switched on by
the migration; an old maintenance plugin is reported (fingerprint slugs or markup).

## Breadcrumbs and the 404 page

EmDash's `createPublicPageContext` accepts `breadcrumbs` but core prints no BreadcrumbList; the starter's
`StructuredData.astro` does. With `breadcrumbs` in site.config (old site showed Rank Math / Yoast / NavXT / theme
crumbs), pages and posts render a visible trail and the BreadcrumbList uses the same trail (no second trail).
Audit now fetches `/wp2emdash-404-check/` (snapshot/not-found.html when it answers 404/410); transform keeps the content
area minus chrome and stock theme sentences, and only a customised page becomes the site part `not-found`.

## Not exercised yet

- A real classic-theme WordPress (sidebars/widgets/menu-items REST with an application password).
- Load's widget, menu and search steps against a running EmDash (remote or local dev server); the starter pages in a
  browser (they pass `astro check` with 0 errors on a pilot's generated project).
- Coming-soon mode and the Missing pages tab on a deployed Worker.
