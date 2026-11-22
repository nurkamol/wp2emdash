# Custom post types and custom fields (CPT mapper)

> ACF storage formats (verified in the plugin source), flexible content, ACF on pages/posts and options pages: `acf-findings.md` (2026-11-22).

**Date:** 2026-11-21 · **EmDash:** 1.5.0 (installed source in the pilot project, read-only) · **Astro:** 7.4.12 · **EmDash Exporter:** 1.2.0 (plugin source read from a site backup) · Parity backlog items 8 (P0) and 14 (P1) (`docs/parity/wp-to-emdash.md`).

## What was built

| Piece | Where | What it does |
|---|---|---|
| Extract | `src/phases/extract.ts`, `src/extract/plugin-exports.ts`, `src/extract/php-unserialize.ts` | Writes the post type registrations from REST `/wp/v2/types?context=edit` to `raw/exporter/types.json` (slug, name, rest_base, hierarchical, has_archive, viewable, supports, taxonomies). Asks the Exporter for ACF, Meta Box and Pods configuration posts (`acf-field-group`, `acf-field`, `meta-box`, `_pods_pod`, `_pods_field`). Recognises field-definition exports among `raw/plugin-exports/` (ACF "Export field groups" JSON, Meta Box Builder JSON, Pods package JSON) and copies them to `raw/field-definitions/`. When ACF is active and an entry came without the Exporter's `acf` object, reads `acf` over REST (`/wp/v2/<rest_base>?_fields=id,acf`, fields with "Show in REST"). |
| Field definitions + map | `src/transform/cpt-fields.ts`, `src/transform/cpt-sources.ts` | Definitions per post type from (richest first) the export files, the ACF configuration posts (PHP-serialized settings, parsed without instantiating objects), and the Exporter analyze `acf` list (top-level fields only). Plugin type → kind → EmDash field type (table below). Value conversion from the Exporter's `acf` object (ACF `get_fields()`, images/posts reduced to ids by the Exporter) or the raw meta (dates always from raw meta: ACF formats them for display; repeater rows rebuilt from `<name>_<i>_<sub>`). |
| Mapping (transform) | `src/transform/cpt.ts`, `src/phases/transform.ts` | Per post type: `overrides.ts contentTypes` `{ as: "collection", name?, fields? }` (default for every public type in the Exporter's analyze list), `"pages"` or `"skip"` (reason required). Writes `ir/collections.json` (collections: core fields, custom fields with their WordPress source and notes, taxonomies, address base, archive, definitions used, unmapped meta, fields not carried; CPT-only taxonomies with terms; bylines) and `ir/entries/<collection>/<slug>.json` (IR kind `entry`: `entry.fields`, `entry.references` as `<type>:<wpId>`, body, excerpt, dates, menu order, terms, bylines). Builder entries (WPBakery, Bricks, Gutenberg) keep sections like pages; classic content becomes Portable Text through the blog's converter. Gates: `content-types-handled` (types now "migrated" as collections), new `cpt-fields` (every meta key no definition describes is mapped or skipped). Coverage report section "Custom post types". Select options are completed from the values used (EmDash rejects a value outside the list). Links to the old site in URL fields become site paths. |
| Seed | `src/scaffold/seed.ts` | Only when there are collections: one seed collection per type after pages/posts (sortOrder renumbered), `urlPattern: "/{slug}"` for types with addresses, `routable: false` otherwise; fields from `collectionFields` (title, excerpt, featured_image, body, content blocks, menu_order, parent reference, custom fields with select options, repeater sub-fields, reference `targetCollection`/`multiple`); CPT taxonomies (shared blog taxonomies get the collection added); bylines; entries with `$media` files and `$ref:<type>:<wpId>` references, collections ordered so a reference's target comes first. A brochure or blog-only seed is unchanged. |
| Load | `src/phases/load.ts`, `src/targets/emdash/api.ts` | Creates missing collections (all first), then their fields (reference targets exist by then); CPT taxonomies + terms (parents first), adds a collection to an existing taxonomy (`PUT /taxonomies/{name}`); bylines; entries with core and custom fields (media resolved through the existing uploader and id-map, rich text media resolved like post bodies, media inside repeaters/JSON as EmDash media values), terms, bylines, `publishedAt`; future entries scheduled. **References in a second pass** once every entry has its id (`PUT /content/{c}/{id}` with `references`), then republished; check `references`. Counts and render include the collections. |
| Starter | `pages/[...slug].astro`, `components/collections/{Archive,Entry}.astro`, `utils/collections.ts` (pure, Node-testable), `utils/collections-data.ts`, `pages/sitemap/archives.xml.ts`, `middleware.ts` | Archive at the type's `has_archive` address with numbered pages (menu order when WordPress had one, else newest first), term archives at the live base, single entry after pages and posts: heading, featured image, sections, body, then the fields — short values as a definition list, rich text as prose, image, gallery grid, repeater rows as cards, references as links (with `references` on `getEmDashEntry`), JSON fields as a list of their text; parent link as eyebrow. Design tokens only. Route-cache tags: the collection + its taxonomies. JSON-LD: WebPage + breadcrumb on entries, CollectionPage on archives (`structuredData.pageTypes`). Archives and term archives join `/sitemap/archives.xml`. |
| Verify | `src/phases/verify.ts`, `src/verify/urls-accounted.ts` | Published entries are compared like pages when the audit saw them (text, headings, SEO); new check `entries` (every published entry answers 200 with its title, archives 200); `urls-accounted` requires a 200 for migrated entries and archives (a redirect does not account for them). |
| Client docs | `src/scaffold/client-repo.ts` | `docs/editing-custom-content.md` (one section per collection: where it is listed, its fields in plain words) and a row per collection in the editor guide. |

## Field-type map

Kinds are the plugin-neutral middle step (`fieldKind`); the full table per plugin type is the golden `test/golden/cpt/field-types.json`.

| ACF | Meta Box | Pods | EmDash |
|---|---|---|---|
| text, color_picker, time_picker, email | text, color, time, email | text, phone, color, slug, time, email | `string` (e-mail and time have no own type: noted) |
| textarea | textarea | paragraph, code | `text` |
| wysiwyg | wysiwyg | wysiwyg | `portableText` (EmDash's HTML converter after the kit's shortcode pass; media marked) |
| number, range | number, range, slider | number, currency | `number` |
| true_false | checkbox, switch | boolean | `boolean` |
| select, radio, button_group | radio, select, select_advanced, button_group, image_select | pick (custom-simple) | `select` (options = choices + values used) |
| checkbox, select (multiple) | checkbox_list, select (multiple) | pick (custom-simple, multi) | `multiSelect` |
| date_picker, date_time_picker | date, datetime | date, datetime | `datetime` (ISO 8601 UTC; date-only at 00:00) |
| url, oembed, page_link | url, oembed, file_input | website, oembed | `url` (values outside http/https/mailto/tel//path are left empty with a warning) |
| image | single_image | file (images, single) | `image` |
| file | — | file (single) | `file` |
| gallery | image, image_advanced, image_upload, plupload_image | file (images, multi) | `repeater` with one `image` sub-field |
| — | file, file_advanced, file_upload, video | file (multi) | `json` (list of media) + warning: repeaters cannot hold files |
| relationship, post_object | post | pick (post_type) | `reference` → the target type's collection (`multiple` for relationship/multi); several or unknown targets → `json` of WordPress ids + warning |
| repeater (flat sub-fields; link and group sub-fields flattened since 2026-11-22) | group (clone) | — | `repeater` (sub-fields: string, text, url, number, boolean, datetime, select, image; a link → `<sub>` url + `<sub>_label`, a group → `<group>_<sub>`) |
| repeater with rich text, files, references or nested rows | — | — | `json` + warning |
| group, clone (sub-fields known) | group | — | one field per sub-field, `<group>_<sub>` |
| link (since 2026-11-22) | — | — | `url` + `<name>_label` string |
| flexible_content (since 2026-11-22) | — | — | rows of mapped layouts → the entry's sections; other rows `json` (see `acf-findings.md`) |
| taxonomy, user, google_map | taxonomy, user, map, osm, key_value, fieldset_text | pick (taxonomy/user/other) | `json` + warning |
| password | password | password | not carried (secrets never leave WordPress; listed) |
| message, tab, accordion | heading, divider, custom_html, button | heading, html | no value (layout) |

Field slugs: lowercase `[a-z0-9_]`, starting with a letter; names that clash with the kit's or EmDash's own (`title`, `slug`, `status`, `content`, `body`…) get a `wp_` prefix, duplicates a number. No field is `required` (WordPress did not enforce it on every entry).

## Verified against the installed EmDash 1.5.0

- **Field types** (`schema/types.ts FIELD_TYPES`): the 17 types; repeater sub-fields only `string text url number integer boolean datetime select image` (`REPEATER_SUB_FIELD_TYPES`, API `repeaterSubFieldSchema`) — no nesting, no files, no rich text. No email or time type. `RESERVED_FIELD_SLUGS`, `RESERVED_COLLECTION_SLUGS` checked.
- **Value validation** (`schema/zod-generator.ts`): `datetime` must be ISO with an offset/`Z`; `select` is an enum of its options (a value outside fails); `url` only http/https/mailto/tel or a site-relative path; `boolean` stored as INTEGER; image/file values are media objects with `id`.
- **References** (`references/*`, `seed/apply.ts`, `api/handlers/schema.ts`, `api/schemas/content.ts`): a reference field with `validation.targetCollection` (+ `multiple`) gets a relation created for it (self-referential allowed, as for "related posts"); bound fields store no column — values are relation edges. Content create/update accept `references: { field: [entryId] }`; seed content uses `"$ref:<seed id>"` resolved in file order (a reference to an entry later in the file is skipped with a warning). Reading: `getEmDashEntry(c, slug, { references: { field: true } })` → `entry.references.field.entries`.
- **Schema API** (`api/schemas/schema.ts`): `POST /schema/collections` (`createCollectionBody`: urlPattern, routable, hasSeo, sortOrder; no dateField) and `POST /schema/collections/{slug}/fields` (`validation` with subFields, options, targetCollection, multiple). `PUT /taxonomies/{name}` (`updateTaxonomyDefBody`, strict) changes a taxonomy's collections.
- **Exporter 1.2.0** (`includes/class-content-exporter.php`): analyze lists public post types only, with `supports`, `taxonomies`, `hierarchical`, `has_archive`, `custom_fields` (non-underscore keys used more than once, inferred type, sample) and, with ACF, `acf` groups (location rules + top-level fields: key, name, label, type, required — no sub-fields, choices or targets). Content: `meta` (all post meta, unserialized, `_edit_*`/`_wp_*` dropped), `acf` (`get_fields()`, WP_Post/WP_User/WP_Term reduced to ids, image arrays to `{type, id, url, alt}`; gallery items keep the full image array), `permalink`, `parent`, `menu_order`. The content endpoint has no post type restriction (configuration posts are readable). EmDash's own importer maps ACF types with a smaller table (`ACF_FIELD_TYPES`, everything else `json`); the kit's table is a superset.
- **URL patterns / sitemaps**: `urlPattern: "/{slug}"` with the whole WordPress path as slug (as pages and posts); EmDash lists every routable `hasSeo` collection in `/sitemap.xml` as `sitemap-<collection>.xml` (seen on the running site).
- **Seed validator**: `validateSeed` on the fixture's full seed (three collections, self and cross references, repeaters with image sub-fields, a taxonomy, a byline, entries with `$media`/`$ref`): `{"valid":true,"errors":[],"warnings":[]}`.

## End to end (synthetic site, local EmDash 1.5.0)

Fixture `test/fixtures/cpt/site.json`: ACF `team` (text, image, wysiwyg, date, select, true/false, flat repeater, relationship to itself incl. one deleted target, gallery, link, a taxonomy, an author, a draft without slug), hierarchical `services` with Meta Box fields (classic entries with `[caption]`, a Gutenberg entry, an invalid URL), Pods `location` with a multi relationship to services. Transform → scaffold (no install) → a scratch project with a cloned copy of the pilot's `node_modules`:

- **Seed path** (target set up from the full seed): load `schema`, `media` (5), `cpt-taxonomies`, `cpt-bylines`, `content` (9), `references` (6 links in 5 entries; the deleted target reported in transform, not written), `counts`, `media-integrity`, `id-map`, `render` (2 pages, 6 entries) passed.
- **Existing-target path** (set up from a seed without the CPT collections, as a site migrated before the mapper): load created `location`, `services`, `team` and all fields over the API (including the self reference `parent`, repeater sub-fields with images, a cross-collection reference), then the same checks passed; a second load updated the 9 entries in place (idempotent).
- Probed on the running site: `/team/` and `/services/` archives (menu order, `/services/page/2/`, `/team/page/2/` 404), `/department/coaching/` term archive (unknown term 404), every entry at its WordPress path incl. nested `/services/pilates/private-sessions/` with its parent link, references rendered as links both ways, images and gallery from the media library, the draft 404, `/location/` (no archive) 404; sitemap index lists `sitemap-location/services/team.xml` and `/sitemap/archives.xml` (archives + term archives); JSON-LD CollectionPage on archives, WebPage + breadcrumb on entries. Seed content path (`dev-bypass?content=1`) renders too (forward references and remote `$media` stay empty in that preview, as expected).
- `astro check` (0 errors) and `astro build` pass with a collections config.

## Brochure sites unchanged

Transform + scaffold (no install) of copies of the two pilot brochure sites with the code before and after: `ir/`, `reports/`, `seed/seed.json`, `site.config.json`, `astro.config.mjs`, `wrangler.jsonc` and client docs byte-identical; only kit-owned starter source differs (new collection components and utils, `[...slug].astro`, `archives.xml.ts`, `middleware.ts`).

## Not verified yet

- **A real WordPress site with CPTs** (only the synthetic fixture). Exporter shapes were read from its PHP source; ACF REST `acf` fallback, the `acf-field` posts path and Meta Box/Pods configuration posts were not seen in a real export (the export-file paths are the tested ones). Meta Box/Pods sites without an export file have no definitions: their meta is reported and gated (`cpt-fields`), not guessed.
- **Remote load with an API token** (staging/production): the scopes are the blog's (`schema:write` for collections/fields, `content:write`, `admin` for bylines); not exercised remotely.
- **Route cache on workerd**: the collection tag purge on publish is EmDash's documented behaviour (`[collection, id]`); not measured on a deployed site. Term edits purge `emdash:taxonomy:<name>`.
- **File fields' URL on the page**: `file` values written by load carry the media id; the entry template links `src`/`url`/`meta.storageKey` when EmDash hydrates them (no file field in the fixture's rendered entries).
- **Types the Exporter does not list as public** (`show_ui` only) are not migrated by default: they need `as: "collection"` (no addresses), `"pages"` or `"skip"`. WordPress `?post_type=x` query URLs are not mapped.
- Dates in custom fields are taken as UTC (WordPress stores them without a zone).
