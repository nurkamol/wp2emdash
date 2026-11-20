# WordPress → EmDash parity

What a small-business or content WordPress site can contain, where each thing lives in EmDash 1.5.0, what the kit does with it today, and what closing each gap takes. The same data is in [`wp-to-emdash.json`](./wp-to-emdash.json); keep the two in sync.

As of 2026-11-20, against EmDash 1.5.0 (installed source) and the kit at that date. Evidence from real sites is counted across the two migrated sites only, with no client details. Status values: ✅ done · 🟡 partial · ❌ missing · ➖ superseded (the platform replaces the WordPress feature, so nothing has to be carried) · ⛔ out of scope. Effort: S ≤ 1 day, M = 2–5 days, L = 1–3 weeks.

## 1. Executive summary

The matrix covers 110 features; 103 of them are in scope.

| | Count | Share of in-scope |
|---|---|---|
| ✅ Done | 35 | 34% |
| ➖ Superseded (nothing to carry) | 6 | 6% |
| 🟡 Partial | 31 | 30% |
| ❌ Missing | 31 | 30% |
| ⛔ Out of scope (not counted) | 7 | — |

**What this means.** The kit fully migrates a brochure site: builder pages (WPBakery/Salient, Bricks, Gutenberg pages), header and footer, menus, popups and announcement bars, media in use, forms, SEO meta, JSON-LD, analytics, redirects from plugin exports, and old upload/sitemap/`?page_id` URLs. Both real sites were exactly that. They had no posts, comments, CPT entries, terms in use, widgets, consent banner or redirect rules.

Anything beyond that is missing today. The kit has no blog: no posts collection, taxonomies, bylines, archives or feeds. It has no custom post types, ACF fields, comments, widgets, consent banner, and no adapters for Elementor, Divi or other builders. Since 2026-11-20 none of it is lost silently: transform lists every unmigrated post type, taxonomy in use and author (gate `content-types-handled`), Customizer CSS is reported and carried by decision, and verify accounts for every old address (`urls-accounted`): feeds, search, archives, attachment pages and query URLs follow a per-site rule set.

**Top 10 gaps by impact**

1. **Blog posts are not migrated.** No `posts` collection exists, Gutenberg/classic posts are skipped in transform, and builder posts are written into `pages`. Rows: posts, post-dates, post-permalinks, excerpt, featured-image.
2. **~~Verify ignores audited URLs that are not migrated pages.~~** Closed 2026-11-20: verify `urls-accounted` checks every audited, discovered and WordPress-form URL. Row: archive-urls.
3. **Custom post types are not migrated.** Since 2026-11-20 they are reported and gated (`content-types-handled`; skip or migrate as pages by decision); there is no CPT mapper, and ACF, Meta Box and Pods fields are not mapped. Rows: cpt, acf.
4. **Categories, tags and custom taxonomies are extracted but never loaded.** Rows: categories-tags, custom-taxonomies.
5. **No authors or bylines.** Row: bylines.
6. **The starter has no blog index, single-post template, category/tag/author archives, pagination or search page.** EmDash injects none of these. Rows: archives, single-post, search.
7. **No RSS feeds.** EmDash has none. Since 2026-11-20 `/feed/` redirects and comment feeds answer 410 (right for sites without posts); a blog still needs a real feed. Row: rss.
8. **Comments are extracted but not loaded,** and EmDash has no bulk-create API for them. Row: comments.
9. **Third-party scripts have no home.** There is no consent banner (Customizer CSS is reported and carried by decision since 2026-11-20), header/footer snippets are only partly handled, and chat widgets and X/TikTok/Facebook embeds are blocked by the CSP. Rows: consent, custom-css, snippets, embeds, widgets-3p.
10. **Only three builders are supported.** There are no Elementor, Divi or DOM-fallback adapters, so most other WordPress sites stop at transform. Rows: elementor, divi, other-builders.

## 2. Parity matrix

Columns: the WordPress feature · its EmDash 1.5 home (evidence level in italics when it is not from source) · what the kit does now, with file references · the gap and how to close it · effort / risk · priority · how many of the 2 real sites used it.

### Content

| WP feature | EmDash 1.5 home | Kit status + refs | Gap & approach | Effort / risk | Pri | Sites |
|---|---|---|---|---|---|---|
| Pages (title, body, slug, publish/draft) <sub>`pages`</sub> | Seed collection `pages` → `ec_pages`; REST `/content/{c}` | ✅ done: transform.ts (pages → ir/pages), load.ts (id-map upsert, publish/unpublish), scaffold/seed.ts `buildSeed` | — | — | — | 2/2 |
| Private pages <sub>`page-private`</sub> | No private status (`draft\|published\|archived`, src/query.ts) | ✅ done: load.ts: non-`publish` → draft (unpublished) | Equivalent: drafts are not public. Logged-in WP viewers lose access; acceptable. | — | — | 2/2 |
| Parent/child pages, nested URLs <sub>`page-hierarchy`</sub> | No parent column on entries (schema/registry.ts); Relations (`_emdash_relations`) as the only link | 🟡 partial: Nested path stored as slug `a/b` and served by starter `[...slug].astro`; parent link not modelled | URLs are kept. Admin shows a flat list; renaming a parent does not move children. Option: `parent` reference field + slug check in load. Document the convention in the editor guide. | S / low | P2 | — |
| Page templates (`_wp_page_template`: full width, no title, landing) <sub>`page-template`</sub> | No template column *(not in EmDash)* | 🟡 partial: transform.ts records `route.template` in the IR; not loaded or used | Map common templates to a `template` select field (or a section variant) and render it; report unknown ones. | S / low | P2 | — |
| `menu_order` (manual page order) <sub>`menu-order`</sub> | No order column on entries *(not in EmDash)* | ❌ missing: Not carried | Only matters for child-page listings. Integer `order` field if a listing section needs it. | S / low | P2 | — |
| Static front page <sub>`front-page`</sub> | No front-page setting; theme decides *(not in EmDash)* | ✅ done: Entry slug `home`; `/home` → 301 `/` ([...slug].astro); sitemap loc fixed (middleware `fixSitemapLoc`) | — | — | — | 2/2 |
| Blog posts (Gutenberg/classic body) <sub>`posts`</sub> | Any collection with `urlPattern`; `@emdash-cms/gutenberg-to-portable-text` converter ships with EmDash | ❌ missing: Seed has only `pages`, `site_parts`, `popups` (seed.ts); builder (WPBakery/Bricks) posts go to `pages` (load.ts `COLLECTION.post = "pages"`); Gutenberg/classic posts are listed in coverage and keep transform gate `content-types-handled` red until decided (`overrides.ts contentTypes.post`: skip, or pages = migrated as pages at their WordPress address) | Add a `posts` collection (title, excerpt, featured_image, body portableText, optional `content` blocks, seo, search). Convert body with the EmDash converter + the kit shortcode pass; load through the id-map. Do not use EmDash's own import route: it writes SEO into `seo_title` fields instead of `_emdash_seo` (import/wordpress-plugin/execute.ts ~L979) and bypasses the id-map. | L / med | P0 | 0/2 |
| Publish / modified dates <sub>`post-dates`</sub> | `published_at` system column; REST create/update accept `publishedAt` (gated by `content:publish_any`, api/schemas/content.ts ~L221) | ❌ missing: load.ts never sends dates (publish = now) | Send `publishedAt` from `date_gmt`. Check the API token scope covers `content:publish_any` (M6 token list has no such scope; verify). | S / med | P0 | — |
| Post permalink structure (`/%postname%/`, `/%year%/%monthnum%/%postname%/`, `/blog/…`) <sub>`post-permalinks`</sub> | `urlPattern` with `{slug}` only; no date placeholders found | ❌ missing: Pages only: `[...slug].astro` resolves `pages` by path | Store the WP path as the post slug (as pages do) and resolve posts in the catch-all route, or a `/blog/[...slug]` route per pattern; `?p=` map must include posts (scaffold `wpIds` is pages only). | M / med | P0 | — |
| Excerpts <sub>`excerpt`</sub> | Not a system field; EmDash importers add an `excerpt` text field | ❌ missing: Not carried | `excerpt` text field on posts (and pages when used); fallback for meta description and listings. | S / low | P0 | 1/2 |
| Featured images <sub>`featured-image`</sub> | Not a system field; importers add `featured_image` (image) | 🟡 partial: transform.ts sets `featuredImage`; load.ts uploads the file but stores no field (data = title + content) | Add `featured_image` image field to pages/posts and write it; use as og:image fallback and in listings. | S / low | P0 | 1/2 |
| Sticky posts <sub>`sticky`</sub> | None *(not in EmDash)* | ❌ missing: Not carried | `featured` boolean field; blog index sorts it first. | S / low | P2 | 0/2 |
| Post formats (aside, video, quote…) <sub>`post-formats`</sub> | None *(not in EmDash)* | ❌ missing: Not carried | Rare on business sites: `format` select field or drop by named rule (reported). | S / low | P2 | 0/2 |
| Scheduled (future) posts <sub>`scheduled`</sub> | `scheduled_at` + cron sweep (scheduled-publish.ts); admin `/calendar` | ❌ missing: load.ts only publishes/unpublishes | Status `future` → schedule call with the WP date. Verify the REST schedule endpoint (MCP has `content_schedule`). | S / low | P1 | 0/2 |
| Password-protected posts/pages <sub>`password-protected`</sub> | None (EmDash importers turn them into drafts) | ❌ missing: Not detected, not gated | Detect `post_password` in extract; gate as an owner decision: draft, Cloudflare Access on the path, or a small middleware password cookie. | M / med | P1 | 0/2 |
| Revision history <sub>`revisions`</sub> | `revisions` table, restore | ⛔ out of scope: `revision` type skipped in extract (by design) | Out of scope: history starts at migration; WordPress backup keeps the old history. | — | OOS | — |
| Authors (display name, bio, avatar) on posts <sub>`bylines`</sub> | `_emdash_bylines` (+ guest, custom byline fields), many bylines per entry; create/update accept `bylines` | ❌ missing: extract keeps `analyze.authors` (emails stripped); nothing created. Authors with published posts are listed in coverage and gated (`content-types-handled`, `overrides.ts authors: skip`) | Create one byline per WP author (no email), link with `bylines` on post create; avatar via media upload. | M / low | P0 | — |
| Custom post types (services, team, portfolio, testimonials, events…) <sub>`cpt`</sub> | Collections with any of 17 field types, `urlPattern`, `routable` | 🟡 partial: extract fetches every type; transform migrates page/post (builder)/popup/salient_g_sections/bricks_template/wp_block. Every other non-empty type is listed in coverage (counts, sample URLs) and keeps transform gate `content-types-handled` red until decided (`overrides.ts contentTypes`: skip, or pages = migrated as pages); configuration types (ACF field groups, builder libraries, orders) listed as internal (src/transform/content-types.ts) | Generic mapper: collection per type from `analyze` (supports, taxonomies, custom fields), urlPattern from the live permalinks, body through the adapters, archive/single templates. | L / med | P0 | 0/2 |
| ACF / Meta Box / Pods custom fields <sub>`acf`</sub> | Field types `string text url number integer boolean datetime select multiSelect portableText image file reference json slug repeater blocks`; repeater sub-fields flat only; EmDash's own `ACF_FIELD_TYPES` table in the exporter importer | ❌ missing: Fingerprint says “EmDash fields (via exporter)” (audit/fingerprint.ts) but nothing maps them | Map ACF groups → fields (wysiwyg→portableText, gallery→repeater of image, relationship→reference, flexible content→blocks, group→json, nested repeater→json + report). Meta Box/Pods from `analyze.custom_fields` inferred types. | L / med | P1 | 0/2 |
| Reusable blocks / synced patterns <sub>`reusable-blocks`</sub> | Sections (`_emdash_sections`, source `import`) | 🟡 partial: Inlined by the Gutenberg adapter (`core/block`, transform.ts `reusable`); not created as EmDash sections (PLAN §2.2 says both) | Also write each `wp_block` as a section so editors can reuse it. | S / low | P2 | 0/2 |
| Theme template parts (Salient global sections, Bricks header/footer templates) <sub>`global-parts`</sub> | Kit collection `site_parts` | 🟡 partial: Site-wide header/footer/announcement migrated; conditional (per-page) templates only listed (transform.ts `bricksParts.others`) | Conditional header/footer per page: a `site_part` reference field on pages. | M / med | P2 | 2/2 |

### Builders

| WP feature | EmDash 1.5 home | Kit status + refs | Gap & approach | Effort / risk | Pri | Sites |
|---|---|---|---|---|---|---|
| WPBakery + Salient <sub>`wpbakery`</sub> | Kit section library as `blocks` field (block types) | ✅ done: src/adapters/wpbakery (~70 element handlers + row recognisers), golden tests | Long tail of third-party `vc_*` add-ons via `wp2emdash-map`. | — | — | 1/2 |
| Gutenberg core blocks <sub>`gutenberg`</sub> | Converter supports core audio/file/table/embed/… | 🟡 partial: src/adapters/gutenberg/index.ts: 30 core blocks; no `core/file`, `core/audio`; dynamic blocks (latest-posts, query, categories, archives) → `dynamic` error | Add file/audio handlers (S). Query/latest-posts need a `posts_list` section (with the blog work). | M / low | P1 | 2/2 |
| Gutenberg block libraries (Kadence, Spectra, GenerateBlocks, Stackable, Otter) <sub>`gutenberg-libs`</sub> | — *(not in EmDash)* | ❌ missing: Fall through to “no handler” diagnostics | Structural handlers per family (PLAN §7) with fixtures + golden tests. | M / med | P1 | 0/2 |
| Classic editor content <sub>`classic`</sub> | Portable Text | ✅ done: ir/portable-text.ts `autop`, shortcodes through the shortcode parser | — | — | — | — |
| Bricks <sub>`bricks`</sub> | Kit section library | ✅ done: src/adapters/bricks (elements, templates, components, forms, menus); measured on one real site | Query loops / posts element need a posts listing section (reported as `dynamic`). | — | — | 1/2 |
| Elementor / Elementor Pro (incl. theme builder, popups, forms) <sub>`elementor`</sub> | Kit section library *(not in EmDash)* | ❌ missing: Fingerprint marks out-of-scope (audit/fingerprint.ts) | Adapter over `_elementor_data` JSON (sections/containers → rows → shared recognisers), theme-builder templates → site_parts, Elementor forms → form sections. Most common builder after Gutenberg. | L / high | P1 | 0/2 |
| Divi <sub>`divi`</sub> | Kit section library *(not in EmDash)* | ❌ missing: Out-of-scope in fingerprint | `et_pb_*` shortcodes: reuse the WPBakery shortcode parser + Divi element handlers. | L / high | P1 | 0/2 |
| Beaver Builder, Oxygen, Breakdance, Avada/Fusion, Thrive, SiteOrigin <sub>`other-builders`</sub> | — *(not in EmDash)* | ❌ missing: No adapter; PLAN's `dom-fallback` adapter not built (src/adapters has bricks, gutenberg, wpbakery only) | Build the DOM-fallback adapter (rendered HTML from the audit → sections, flagged) as the universal safety net; dedicated adapters only on demand. | L / high | P1 | 0/2 |
| Unknown / plugin shortcodes in content <sub>`shortcodes`</sub> | Not expanded by EmDash (docs) *(docs)* | 🟡 partial: Parsed as nodes and reported `unmapped` (blocks transform for published content); form shortcodes mapped | Ongoing handler work; WordPress core `[caption]`, `[audio]`, `[video]`, `[embed]`, `[playlist]` handlers should be checked with fixtures (only `[gallery]` confirmed, wpbakery/index.ts). | S / low | P1 | — |

### Taxonomies

| WP feature | EmDash 1.5 home | Kit status + refs | Gap & approach | Effort / risk | Pri | Sites |
|---|---|---|---|---|---|---|
| Categories and tags (+ term assignment) <sub>`categories-tags`</sub> | `_emdash_taxonomy_defs` (hierarchical/flat), `taxonomies`, `content_taxonomies`; REST `/taxonomies/{name}/terms`, `bulk-tag` | ❌ missing: extract writes raw/exporter/taxonomies.json; not transformed or loaded. Taxonomies with terms in use are listed in coverage and gated (`content-types-handled`, `overrides.ts taxonomies: skip`); their archive URLs follow the WordPress-URL rules | Seed taxonomy defs, load terms (parent, slug, description) via REST, assign on posts. | M / low | P0 | 0/2 |
| Custom taxonomies <sub>`custom-taxonomies`</sub> | Same as above (custom names allowed) | ❌ missing: As above (listed and gated; plugin-internal ones such as Bricks template tags and media folders listed as internal) | Same path, driven by `analyze` (taxonomies per type); skip plugin-internal ones (FileBird folders, template tags) by named rule. | S / low | P1 | 0/2 |
| Term descriptions, term SEO (Yoast/Rank Math) <sub>`term-meta`</sub> | `data.description` only; no term SEO | ❌ missing: — | Description into `data.description`; term SEO title/description need a plugin store (seo package) if archives stay indexable. | S / low | P2 | 0/2 |

### Media

| WP feature | EmDash 1.5 home | Kit status + refs | Gap & approach | Effort / risk | Pri | Sites |
|---|---|---|---|---|---|---|
| Media library files (dedupe) <sub>`media-files`</sub> | `media` table, R2, content-hash dedupe, 50 MB default limit | 🟡 partial: extract downloads the whole library (raw/media); load uploads only media referenced by the IR (sha1 dedupe, load.ts) | Option `media.uploadAll` (or all non-image files) so library-only items (PDFs sent by email, files linked from outside) stay reachable; legacy upload redirect then finds them. | S / low | P1 | 2/2 |
| Alt text <sub>`alt`</sub> | `media.alt` | ✅ done: Sent on upload; verify `images-alt`; SEO dashboard writes missing alts (packages/seo) | Both sites had 0 alt in the library: keep reporting it in audit. | — | — | 2/2 |
| Captions, titles, descriptions <sub>`caption-title`</sub> | `caption`; no title/description column | 🟡 partial: Manifest keeps caption/title; upload sends alt only (`api.mediaUpload`) | Send caption; title/description dropped by named rule (reported). | S / low | P2 | — |
| Image sizes / WebP plugins <sub>`sizes`</sub> | `/_image` endpoint, Cloudflare Images binding, webp/avif | ➖ superseded: perf package `image.domains`, `/_image` fallback in middleware | — | — | — | 1/2 |
| PDFs and documents linked in content <sub>`pdf`</sub> | Allowed type (`pdf` in upload allowlist) | 🟡 partial: Linked upload URLs are rewritten only when the file was uploaded (load.ts `fixHref`) | Collect `href` upload links as `file` media refs in transform, upload them, gate on it. | S / low | P1 | 0/2 |
| SVG files <sub>`svg`</sub> | Blocked by default (allowlist), per-field opt-in | ✅ done: Drawn to PNG at load (targets/emdash/svg.ts); legacy `.svg` URL → PNG (middleware) | Lossy (raster). Option: `allowedMimeTypes` opt-in on logo fields instead. | — | — | 2/2 |
| Self-hosted video/audio, external CDN video <sub>`video-audio`</sub> | `video/*`, `audio/*` allowed; Stream runtime | ✅ done: mp4 faststart, external `copy` (overrides.media.external); `hotlink` refused at load | Hotlinked media support (keep URL) for very large files. | S / low | P2 | 1/2 |
| Galleries <sub>`gallery`</sub> | Kit `gallery` section; PT `gallery` block | ✅ done: Section library `gallery` (grid/masonry/carousel) | — | — | — | — |
| Media folders (FileBird, Real Media Library) <sub>`media-folders`</sub> | `media_folders` (migration 072) | ❌ missing: Dropped (fingerprint: “folders are not migrated”) | Read the folder taxonomy and recreate folders. | S / low | P2 | 2/2 |
| Attachment pages (`/?attachment_id=N`, `/parent/file-name/`) <sub>`attachment-pages`</sub> | None *(not in EmDash)* | ✅ done: Starter middleware (utils/wp-urls.ts): attachment pages and `?attachment_id=` → parent page if migrated, else the file from the media library, else home (rule `attachment`); verify `urls-accounted` checks every one discovery found | — | — | — | — |

### Navigation

| WP feature | EmDash 1.5 home | Kit status + refs | Gap & approach | Effort / risk | Pri | Sites |
|---|---|---|---|---|---|---|
| Menus (nesting, custom links, target, classes) <sub>`menus`</sub> | `_emdash_menus`, `_emdash_menu_items` (custom/page/post/taxonomy/collection), `getMenu` | 🟡 partial: seed.ts + load.ts write `primary`, `secondary`, `footer`; menus with role `other` are not written; every item is a `custom` URL | Write every menu (named after the WP menu); link items to entries (`page`/`post` types) so slug changes follow. | S / low | P1 | 2/2 |
| Menu locations <sub>`menu-locations`</sub> | None — templates fetch by name | ✅ done: WP locations → roles (transform `menuTree`, IrSite.menus.role) | — | — | — | 2/2 |
| Mega menus (Max Mega Menu, builder mega menus) <sub>`mega-menu`</sub> | None *(not in EmDash)* | ❌ missing: Classes only | Header variant with column groups from menu item classes; images/widgets in mega panels reported. | M / med | P2 | 0/2 |
| Widgets / sidebars (classic themes) <sub>`widgets`</sub> | `_emdash_widget_areas`, `_emdash_widgets` (content, menu, component `core:recent-posts\|categories\|tags\|search\|archives`), REST `/widget-areas` | ❌ missing: No extract (exporter has no widgets endpoint) | Read `wp/v2/sidebars` + `wp/v2/widgets` (auth, WP ≥ 5.8) or the `sidebars_widgets` option from the dump; text/HTML → content widgets, nav → menu widgets, core widgets → components. | M / med | P1 | 0/2 |
| Header (logo, menu, mobile menu, sticky behaviour) <sub>`header`</sub> | Theme *(not in EmDash)* | ✅ done: SiteHeader variants + motion recipe from the audit (PLAN §5a) | — | — | — | 2/2 |
| Footer <sub>`footer`</sub> | Theme + kit `site_parts` *(not in EmDash)* | ✅ done: Footer site part from global sections / Bricks footer; classic widget footers depend on `widgets` | — | — | — | 2/2 |
| Announcement / notification bars <sub>`announcement`</sub> | Kit site part `announcement` *(not in EmDash)* | ✅ done: transform/announcement.ts (Announcer, WPFront, Salient, Astra); script-injected bars reported | — | — | — | 1/2 |
| Popups (Popup Maker, Bricks popups) <sub>`popups`</sub> | Kit `popups` collection *(not in EmDash)* | 🟡 partial: Enabled Popup Maker + Bricks popups with click/auto-open triggers; others reported | Elementor popups, OptinMonster, Convert Pro: map via the same IR when met. | M / low | P2 | 1/2 |
| Site title, tagline <sub>`identity`</sub> | Settings `title`, `tagline` | ✅ done: load.ts `updateSettings` | — | — | — | 2/2 |
| Logo, favicon / site icon <sub>`logo-favicon`</sub> | Settings `logo`, `favicon` (media refs) | 🟡 partial: Copied to `public/brand` + `site.config.json` (scaffold); EmDash settings not set, so the owner cannot change them in the admin | Upload and set `logo`/`favicon` settings; starter reads settings first. (EmDash Settings prefill is being built by another agent.) | S / low | P1 | 2/2 |
| Social profiles <sub>`social`</sub> | Settings `social.{twitter,github,facebook,instagram,linkedin,youtube}` | 🟡 partial: Only as `sameAs` in structured data (transform/business.ts) | Write settings.social (overlaps with the Settings prefill work). | S / low | P2 | — |
| 404 page content <sub>`404`</sub> | Theme `/404` *(not in EmDash)* | 🟡 partial: Generic starter 404 (starter/src/pages/404.astro) | Carry the source 404 text/links (Bricks `error` template, theme 404) into a `site_parts/404` entry. | S / low | P2 | 1/2 |
| Blog index, category/tag/author/date archives, pagination <sub>`archives`</sub> | No injected routes; helpers `getEntriesByTerm`, `getEntriesByByline`, cursor/offset queries | ❌ missing: Starter has only `[...slug].astro`, `404.astro`, `api/forms`. Archive URLs of a site that does not rebuild them follow the WordPress-URL rules (301 to the blog page, else 410 / home; verify `urls-accounted`) | Starter routes: posts page, `/category/[slug]/`, `/tag/[slug]/`, `/author/[slug]/` (or 301 by decision), `/page/N/`; date archives → 301 to the index unless indexable. | M / med | P0 | — |
| Single post template (date, author box, categories, prev/next, related) <sub>`single-post`</sub> | Theme; `buildBlogPostingJsonLd` | ❌ missing: — | Post layout component + BlogPosting JSON-LD. | M / low | P0 | — |
| Site search + results page <sub>`search`</sub> | FTS5 (`search`, `searchCollection`, `LiveSearch.astro`, widget `core:search`) | 🟡 partial: No `/search` route yet; `/?s=q` and `/search/q/` → 301 home, or `/search/?q=` when a migrated `/search/` page exists (WordPress-URL rule `search`; verify `urls-accounted`) | `/search` page (FTS5) in the starter; then the rule sends the query there and the Rank Math WebSite SearchAction resolves. | S / low | P1 | 2/2 |
| RSS/Atom feeds (`/feed/`, category/comment feeds) <sub>`rss`</sub> | None (no feed route or helper in src) *(not in EmDash)* | 🟡 partial: Sites without posts: `/feed/`, `?feed=`, `/wp-rss2.php` → 301 home (or the blog page), `/comments/feed/` → 410, `/<page>/feed/` → the page; verify `urls-accounted`. Reasoning: docs/spikes/wp-urls-findings.md. Sites with posts get the same redirect plus a coverage flag (`feedPending`): no RSS is generated yet | Starter `/feed/` (RSS 2.0 from posts) and `/category/x/feed/` with the blog milestone; then the feed rule stops redirecting. | S / low | P0 | 2/2 |

### Comments & users

| WP feature | EmDash 1.5 home | Kit status + refs | Gap & approach | Effort / risk | Pri | Sites |
|---|---|---|---|---|---|---|
| Comments (approved, threaded) <sub>`comments`</sub> | `_emdash_comments` (pending/approved/spam/trash, 1-level threading), moderation, Turnstile; no admin bulk-create REST route found | ❌ missing: extract writes raw/exporter/comments.json; not loaded | Spike the write path (site-transfer `comment` records via `emdash site import`, or EmDash's `importCommentsFromPlugin`); deeper threads flattened (reported); emails never logged. | M / med | P1 | 0/2 |
| Comment open/closed per post, discussion settings <sub>`comment-settings`</sub> | Per collection: `commentsEnabled`, `commentsModeration`, `commentsClosedAfterDays` | ❌ missing: — | Map site defaults to collection options; per-post closed state needs a field. | S / low | P2 | 0/2 |
| Users and roles <sub>`users`</sub> | Roles SUBSCRIBER…ADMIN, invites, passkeys, magic links, OAuth (GitHub/Google/Microsoft) | ❌ missing: Owner invites admins by hand (PLAN §8 editor handoff) | Invite list from WP users with role mapping (administrator→ADMIN, editor→EDITOR, author→AUTHOR, contributor→CONTRIBUTOR); passwords never migrate. | S / low | P2 | 2/2 |

### Forms

| WP feature | EmDash 1.5 home | Kit status + refs | Gap & approach | Effort / risk | Pri | Sites |
|---|---|---|---|---|---|---|
| Form definitions (CF7, Gravity, WPForms, Fluent, Bricks) <sub>`forms`</sub> | No forms in core (`@emdash-cms/plugin-forms` referenced, not installed) | ✅ done: Fluent over REST, others from plugin export files (extract/plugin-exports.ts); `@wp2emdash/forms` endpoint, Turnstile, outbox, admin inbox | — | — | — | 2/2 |
| Ninja Forms, Formidable, Elementor forms, WS Form, Forminator <sub>`forms-other`</sub> | — *(not in EmDash)* | 🟡 partial: Shortcodes recognised (wpbakery handlers `ninja_form`, `formidable`); no definition extractor | Export parsers per plugin when a site needs it. | M / low | P1 | 0/2 |
| File uploads, multi-step, conditional logic, payments <sub>`forms-features`</sub> | — *(not in EmDash)* | 🟡 partial: File upload fields dropped with a warning (plugin-exports.ts ~L228); signature/consent supported (forms 1.3) | Uploads to R2 with size/type limits (never for sensitive sites); conditional logic in the form schema; payments OOS. | M / med | P1 | — |
| Past form entries <sub>`form-entries`</sub> | — *(not in EmDash)* | 🟡 partial: Never read (privacy rule); the forms admin can import CSV/JSON | Checklist step: owner exports entries before decommissioning WordPress. | S / low | P2 | — |
| SMTP plugins (WP Mail SMTP, FluentSMTP) <sub>`smtp`</sub> | Email pipeline (SMTP settings, `cloudflare-email` plugin); no attachments | ➖ superseded: Provider APIs (Brevo default) or `EMAIL_PROVIDER=emdash` | — | — | — | 2/2 |
| Akismet, reCAPTCHA, hCaptcha, ALTCHA <sub>`spam`</sub> | Turnstile (comments), rate limits | ➖ superseded: Turnstile + rate limit on the form endpoint | — | — | — | 1/2 |

### Redirects & URLs

| WP feature | EmDash 1.5 home | Kit status + refs | Gap & approach | Effort / risk | Pri | Sites |
|---|---|---|---|---|---|---|
| Plugin redirects (Redirection, Rank Math, Yoast) <sub>`redirects`</sub> | `_emdash_redirects` (301/302/307/308/410/451, `[param]` patterns, hits), admin `/redirects` | ✅ done: plugin-exports.ts → raw/redirects.json → load (group `wordpress`) | Regex rules are kept out and reported (EmDash has no regex): optional middleware regex table. | M / low | P2 | 0/2 |
| 404 monitoring after launch <sub>`404-log`</sub> | `_emdash_404_log`, `/redirects/404s` | 🟡 partial: EmDash logs; kit post-launch monitor not built (PLAN §10b #7) | Scheduled check: new 404s → suggested redirects in the dashboard (check overlap with packages/health, in progress). | S / low | P1 | — |
| `/?p=N`, `/?page_id=N` <sub>`wp-ids`</sub> | Query-string sources never match (M0 A6) | 🟡 partial: Middleware `wpIds` (pages, and entries of types decided `pages`); unknown ids answer 404 (WordPress-URL matcher); verify `urls-accounted` checks a sample per type | Include posts and CPT entries. | S / low | P0 | — |
| `/?cat=`, `/?tag=`, `/?author=`, `/?s=`, `/?attachment_id=`, `/?feed=` <sub>`wp-query-urls`</sub> | As above | ✅ done: Starter middleware (utils/wp-urls.ts, rule set from transform → site.config.json `wpUrls`): `?s=`, `?feed=`, `?cat=`, `?tag=`, `?author=`, `?attachment_id=`, `?m=` → one 301 or 410; verify `urls-accounted` checks them | — | — | — | — |
| Archive URLs not rebuilt (`/category/x/`, `/tag/x/`, `/author/x/`, `/2024/05/`, `/page/2/`) <sub>`archive-urls`</sub> | Redirects (`[param]`/`[...splat]` patterns) | ✅ done: Verify `urls-accounted` (src/verify/urls-accounted.ts): every audited URL plus every entry/term/author/attachment page REST discovery found, the upload files the pages used, feeds, search and the query forms answer 200, one 301/308 to a 200, or 404/410 by decision (`overrides.ts gone`, the WordPress-URL rules, a skip decision); unaccounted ones listed by kind. Archives not rebuilt follow the rules (category/tag/date → blog page, else 410; author → blog page, else home; live archive bases detected) | — | — | — | 1/2 |
| `/wp-content/uploads/...` links <sub>`uploads-urls`</sub> | Native redirects skip file paths | ✅ done: Middleware `legacyUpload` (filename → storage key, `-WxH`/`-scaled`); verify `legacy-urls` | — | — | — | 2/2 |
| Old sitemap URLs <sub>`old-sitemaps`</sub> | — *(not in EmDash)* | ✅ done: Middleware `LEGACY_SITEMAP` → `/sitemap.xml` | — | — | — | 2/2 |
| Trailing slash, www/apex, http→https <sub>`slash-host`</sub> | — *(not in EmDash)* | ✅ done: Middleware `canonicalPath` + host policy; cutover `canonical-host` | — | — | — | 2/2 |
| `/wp-admin`, `/wp-login.php`, `/xmlrpc.php`, `/wp-json` <sub>`wp-endpoints`</sub> | — *(not in EmDash)* | ✅ done: Verify `wp-endpoints` (404/410) | — | — | — | 2/2 |

### SEO

| WP feature | EmDash 1.5 home | Kit status + refs | Gap & approach | Effort / risk | Pri | Sites |
|---|---|---|---|---|---|---|
| SEO title, description, canonical, noindex <sub>`seo-meta`</sub> | `_emdash_seo` (title, description, image, canonical, no_index), `getSeoMeta` | ✅ done: load.ts `seo` on pages; verify `seo-title/description/canonical/robots` | Extend to posts/CPTs with the blog work. | — | — | 2/2 |
| Custom OG / Twitter title, description, image <sub>`og-twitter`</sub> | Only `seo_image`; no separate OG/Twitter text fields | 🟡 partial: og:image carried (load `ogRef`); sharing cards (packages/og) | Custom OG/Twitter text: per-entry store in the SEO plugin + `page:metadata`. | S / low | P2 | — |
| Schema / JSON-LD <sub>`jsonld`</sub> | `buildWebSiteJsonLd`, `buildBlogPostingJsonLd`, `page:metadata` jsonld | ✅ done: StructuredData.astro (business, WebPage, breadcrumb), FAQPage from `faq`; verify `seo-jsonld` passed on both sites | Rank Math custom schema (`rank_math_schema`: Event, Product, HowTo, Recipe…) is extracted but not mapped. | M / low | P2 | 2/2 |
| Visible breadcrumbs <sub>`breadcrumbs`</sub> | Page context `breadcrumbs` (JSON-LD only) | ❌ missing: Breadcrumb JSON-LD only | Breadcrumb component for nested pages/posts when the source showed one. | S / low | P2 | — |
| XML sitemaps <sub>`sitemaps`</sub> | `/sitemap.xml`, `/sitemap-{collection}.xml` (has_seo + routable; no taxonomy/author) | 🟡 partial: Pages sitemap fixed in middleware; verify `sitemap` gate | Posts/CPTs come with their collections; taxonomy/author sitemap route when those archives are indexable; image/video sitemaps P2. | S / low | P1 | 2/2 |
| robots.txt custom rules <sub>`robots`</sub> | Settings `seo.robotsTxt`, `disallowAiTraining` | 🟡 partial: Audit stores the live robots.txt (discover.ts); not carried | Diff the live rules against EmDash's default; carry custom ones into `seo.robotsTxt` (owner-reviewed). | S / low | P1 | 2/2 |
| Rank Math Local SEO `locations.kml` <sub>`kml`</sub> | — *(not in EmDash)* | ❌ missing: Not migrated; now surfaces in verify `urls-accounted` (both real sites) until regenerated or recorded in `overrides.ts gone` | Regenerate from the business data or 410 by decision. | S / low | P2 | 2/2 |
| Search-engine verification meta <sub>`verification`</sub> | Settings `googleVerification`, `bingVerification` | ✅ done: site.config.json `verification` (scaffold) rendered in Base.astro | Optionally write Google/Bing into EmDash settings so the owner can edit them. | S / low | P2 | 0/2 |
| Search Console, IndexNow <sub>`indexing`</sub> | — *(not in EmDash)* | ✅ done: packages/seo (GSC service account, IndexNow on publish) | — | — | — | — |

### Tracking & scripts

| WP feature | EmDash 1.5 home | Kit status + refs | Gap & approach | Effort / risk | Pri | Sites |
|---|---|---|---|---|---|---|
| GA4, Google tag, GTM, Meta Pixel, Clarity, Hotjar, CF Web Analytics <sub>`analytics`</sub> | None in core; `page:fragments` hook (trusted plugins) | ✅ done: packages/seo analytics (IDs, CSP host table, consent mode switch), verify `analytics`, `analytics-runtime` | — | — | — | 2/2 |
| Cookie consent banner (Complianz, CookieYes, Cookie Notice, Cookiebot) <sub>`consent`</sub> | None *(not in EmDash)* | ❌ missing: Detected in audit (audit/integrations.ts); consent mode exists but no banner; hosted CMP scripts are not in the CSP | Consent banner component (EmDash plugin settings: text, policy link, categories) wired to consent mode; allow-listed hosted CMPs (Cookiebot, OneTrust, Termly) by ID. | M / med | P1 | 0/2 |
| Header/footer code (HFCM, WPCode, Insert Headers and Footers, Code Snippets) <sub>`snippets`</sub> | `page:fragments` (head, body:start, body:end; trusted-only) | 🟡 partial: Snippets read from the dump (import-dump → raw/code-snippets.json); known booking embeds rebuilt; unknown scripts not carried (strict CSP) | Provider/snippet recognizer (in progress, another agent) → known providers by ID; unknown snippets → owner decision; optional trusted-snippet plugin with CSP hashes. | M / med | P1 | 1/2 |
| Customizer Additional CSS <sub>`custom-css`</sub> | None *(not in EmDash)* | ✅ done: Read from the live pages (`<style id="wp-custom-css">`) or the `custom_css` post (extract → raw/custom-css.json); coverage lists size, selectors, media queries, uploads and external imports; transform gate `custom-css` until `overrides.ts customCss: carry \| drop`; carry → scaffold writes `public/styles/custom-<hash>.css`, linked first in `<body>` (after the bundled CSS, never inline) | Selectors written for the WordPress theme rarely match the new markup: review before carrying. | — | — | 0/2 |
| oEmbeds (YouTube, Vimeo, X/Twitter, Instagram, TikTok, Facebook, Spotify) <sub>`embeds`</sub> | `Embed.astro` (YouTube, Vimeo, video/audio, sanitized HTML); no runtime oEmbed | 🟡 partial: video section + embed allowlist (starter/src/utils/embed.ts `PROVIDER_HOSTS`): no X/Twitter, TikTok, Facebook | Add providers to the allowlist + CSP with fixtures. | S / low | P1 | — |
| Chat, reviews, social feeds, booking widgets <sub>`widgets-3p`</sub> | — *(not in EmDash)* | 🟡 partial: Detected (integrations.ts); booking + some reviews hosts allowed; chat widgets (Tawk, Crisp, Intercom, HubSpot chat) not | Covered by the snippet recognizer + per-provider CSP entries. | M / low | P1 | 2/2 |
| Fonts (Google, self-hosted, Adobe), icon fonts <sub>`fonts`</sub> | — *(not in EmDash)* | 🟡 partial: scaffold/fonts.ts (Google / self-hosted), icon fonts → inline SVG; Adobe Fonts detected as “keep” but `use.typekit.net` is not in the CSP style/font sources | Add Typekit hosts to the CSP when the kit embed is kept. | S / low | P2 | 2/2 |
| Theme options / customizer design (colours, type) <sub>`theme-options`</sub> | — *(not in EmDash)* | ✅ done: Design capture → tokens.css; Salient/Bricks/ACSS options when exported | — | — | — | 2/2 |

### Settings

| WP feature | EmDash 1.5 home | Kit status + refs | Gap & approach | Effort / risk | Pri | Sites |
|---|---|---|---|---|---|---|
| Timezone, date format, posts per page <sub>`display-settings`</sub> | Settings `timezone`, `dateFormat`, `postsPerPage` | ❌ missing: Not carried | From the exporter `options` (check which keys it returns) or the dump; needed once dates are shown. | S / low | P1 | — |
| Site language <sub>`language`</sub> | Astro i18n config / `lang` | ✅ done: `site.lang` from the audited `<html lang>`, og:locale | — | — | — | 2/2 |
| Discourage search engines (blog_public) <sub>`reading`</sub> | `staging` (noindex), robots | ✅ done: Audit robots; verify `seo-robots`; cutover `indexable` | — | — | — | — |

### Platform

| WP feature | EmDash 1.5 home | Kit status + refs | Gap & approach | Effort / risk | Pri | Sites |
|---|---|---|---|---|---|---|
| Caching / CDN / optimisation plugins <sub>`caching`</sub> | Route cache, Workers | ➖ superseded: Performance package (scaffold/perf.ts), verify `route-cache` | — | — | — | 2/2 |
| Security plugins (Wordfence, login protection) <sub>`security`</sub> | Passkeys, magic links, OAuth, Access; Cloudflare WAF | ➖ superseded: Security headers + CSP (middleware), verify `security-headers`, `wp-endpoints` | — | — | — | 1/2 |
| Backups (UpdraftPlus, host backups) <sub>`backups`</sub> | `/settings/backups` (content, schema, settings; scheduled; no media binaries, no users); D1 Time Travel 30 days | 🟡 partial: Client docs `operations.md` (D1 Time Travel); bookmark before live loads (targets/d1-backup.ts); R2 media and KV not backed up off-account | Scaffold a scheduled off-account export (`emdash site export` in CI → private storage) + R2 copy; document restore and test it once. | M / med | P1 | — |
| Maintenance / coming-soon mode <sub>`maintenance`</sub> | None (`staging` = noindex only) *(not in EmDash)* | ❌ missing: — | Middleware flag (setting or plugin) serving a 503 page to visitors, editors bypass. | S / low | P2 | 0/2 |
| WP-Cron tasks <sub>`cron`</sub> | Worker `scheduled()`: plugin cron, scheduled publish, cleanup | ➖ superseded: Forms outbox on the cron (starter/src/worker.ts) | Plugin-specific jobs rebuilt per feature. | — | — | — |
| Accessibility <sub>`a11y`</sub> | — *(not in EmDash)* | ✅ done: axe gate, accessible header/menu, reduced motion; overlay widgets (accessiBe, UserWay) → recommend drop | — | — | — | 2/2 |
| Legal pages (privacy, terms, cookie policy) <sub>`legal`</sub> | Pages | ✅ done: Ordinary pages; plugin-generated policy shortcodes (Complianz `[cmplz-document]`, CookieYes) would show as unmapped shortcodes | Handler: take the rendered text from the audit snapshot, flagged for owner review. | S / low | P2 | 2/2 |
| Multilingual (WPML, Polylang) <sub>`i18n`</sub> | Locales, `translation_group`, translatable fields, hreflang, menus/terms per locale; exporter reports locale + translation group | ⛔ out of scope: Fingerprint marks out-of-scope (v2) | v2: one locale per WPML language, link by translation group, hreflang from EmDash. | L / high | P2 | 0/2 |

### Out of scope

| WP feature | EmDash 1.5 home | Kit status + refs | Gap & approach | Effort / risk | Pri | Sites |
|---|---|---|---|---|---|---|
| WooCommerce / shops <sub>`woocommerce`</sub> | None (no commerce) *(not in EmDash)* | ⛔ out of scope: Detected, migration stops for a decision (PLAN §9) | Needs a commerce platform (Shopify, Stripe Checkout, Snipcart); product catalogue could become a collection, checkout cannot. | — | OOS | 0/2 |
| Memberships, LMS, paywalls, front-end accounts <sub>`membership`</sub> | Roles exist but no paywall/LMS | ⛔ out of scope: Detected (PLAN §9) | Separate product decision. | — | OOS | 0/2 |
| Events plugins (The Events Calendar, Modern Events) <sub>`events`</sub> | — *(not in EmDash)* | ⛔ out of scope: Not handled | Simple event lists via the CPT mapper (`events` collection with datetime fields); recurrence, tickets, iCal feeds out of scope. | M / med | P2 | 0/2 |
| WordPress-hosted booking engines (Amelia, Bookly) <sub>`booking-plugins`</sub> | — *(not in EmDash)* | ⛔ out of scope: SaaS booking widgets are kept as embeds; WP-hosted engines are not | Replace with a SaaS provider (owner decision). | — | OOS | 0/2 |
| Multisite, BuddyPress, bbPress, directories, custom business-logic plugins <sub>`multisite`</sub> | Plugin system (sandboxed Worker plugins) | ⛔ out of scope: PLAN §9 | Per site, or port via `wordpress-plugin-to-emdash`. | — | OOS | 0/2 |

## 3. Prioritized backlog

**P0** is what a typical small-business site with a blog needs to call the migration “100%”. **P1** covers common plugins and builders. **P2** covers fidelity details and rarer features. Items in progress elsewhere are marked as such.

| # | Pri | Item | Rows | Effort | Notes |
|---|---|---|---|---|---|
| 1 | P0 | Posts collection: Gutenberg/classic → Portable Text (EmDash converter + kit shortcode pass), dates, excerpt, featured image, permalinks, `?p=` for posts | `posts`, `post-dates`, `post-permalinks`, `excerpt`, `featured-image`, `wp-ids` | L | Biggest gap: no blog content reaches EmDash today. Builder posts currently land in `pages`. |
| 2 | P0 | Verify every audited URL: 200, single-hop 301 to a mapped target, or 410 with a decision | `archive-urls` | M | Done 2026-11-20: verify `urls-accounted` (docs/spikes/wp-urls-findings.md). |
| 3 | P0 | List every non-empty unhandled post type in coverage + transform gate | `cpt` | S | Done 2026-11-20: transform `content-types-handled` (types, taxonomies in use, authors with posts; `overrides.ts contentTypes` skip \| pages). |
| 4 | P0 | Taxonomies: defs, terms, assignments | `categories-tags`, `custom-taxonomies` | M | REST `/taxonomies/{name}/terms` and `bulk-tag` exist. |
| 5 | P0 | Bylines from WordPress authors | `bylines` | M | Content create/update accept `bylines`. |
| 6 | P0 | Starter blog templates: single post, blog index, category/tag/author archives, pagination | `archives`, `single-post` | M | EmDash injects no archive routes. |
| 7 | P0 | Feeds: `/feed/` + category feeds from posts; redirect/410 rule and verify check for sites without posts | `rss` | S | Sites without posts done 2026-11-20 (feed → 301, comment feeds → 410, verify). Real RSS from posts remains, with the blog milestone. |
| 8 | P0 | Custom post type mapper (collection per type, fields, urlPattern, templates) | `cpt` | L | Builds on items 1, 3, 4. |
| 9 | P1 | Search page + `/?s=` redirect; other WP query URLs (`?cat`, `?tag`, `?author`, `?attachment_id`, `?feed`) and attachment pages | `search`, `wp-query-urls`, `attachment-pages` | S | Done 2026-11-20 except the search page: WordPress-URL rule set in the starter middleware (search → home until a `/search` page exists). |
| 10 | P1 | Comments import (spike the write path first) | `comments`, `comment-settings` | M | No admin bulk-create route found; site-transfer `comment` records are the likely path. |
| 11 | P1 | Third-party scripts: snippet recognizer (in progress), consent banner, chat/embeds allowlist, Customizer CSS | `snippets`, `consent`, `custom-css`, `embeds`, `widgets-3p` | M | The consent banner is P0 for EU/UK clients. Customizer CSS done 2026-11-20 (reported, carried by decision). |
| 12 | P1 | Elementor adapter | `elementor` | L | Most common builder after Gutenberg. |
| 13 | P1 | DOM-fallback adapter (any builder, flagged) | `other-builders` | L | Universal safety net in the PLAN; not built. |
| 14 | P1 | ACF / Meta Box / Pods field mapping | `acf` | L | Reuse EmDash's `ACF_FIELD_TYPES` mapping. |
| 15 | P1 | Settings into EmDash: logo, favicon, social, robots.txt rules, timezone, date format, posts per page (EmDash Settings prefill in progress) | `logo-favicon`, `social`, `robots`, `display-settings` | S | Lets the owner edit identity in the admin. |
| 16 | P1 | Menus: write every menu, link items to entries | `menus` | S | `other`-role menus are dropped today. |
| 17 | P1 | Widgets / sidebars | `widgets` | M | Classic-theme footers and sidebars. |
| 18 | P1 | Media completeness: upload library-only files and PDFs linked in content | `media-files`, `pdf` | S |  |
| 19 | P1 | Divi adapter | `divi` | L | Reuses the shortcode parser. |
| 20 | P1 | Gutenberg: core file/audio, block libraries (Kadence, Spectra, GenerateBlocks) | `gutenberg`, `gutenberg-libs` | M |  |
| 21 | P1 | Scheduled and password-protected content | `scheduled`, `password-protected` | M |  |
| 22 | P1 | Off-account backups (scheduled site export + R2) | `backups` | M |  |
| 23 | P1 | Forms: Ninja/Formidable/Elementor extractors, file uploads, conditional logic | `forms-other`, `forms-features` | M |  |
| 24 | P1 | Post-launch 404 → redirect suggestions; sitemaps for posts/terms | `404-log`, `sitemaps` | S | Check overlap with packages/health. |

**P2:** `page-hierarchy`, `page-template`, `menu-order`, `sticky`, `post-formats`, `reusable-blocks`, `global-parts`, `term-meta`, `caption-title`, `video-audio`, `media-folders`, `mega-menu`, `popups`, `social`, `404`, `comment-settings`, `users`, `form-entries`, `redirects`, `og-twitter`, `jsonld`, `breadcrumbs`, `kml`, `verification`, `fonts`, `maintenance`, `legal`, `i18n`, `events`. Each row in §2 gives its approach.

**Out of scope (detected, migration stops for an owner decision):**

- **Revision history**: Out of scope: history starts at migration; WordPress backup keeps the old history.
- **Multilingual (WPML, Polylang)**: v2: one locale per WPML language, link by translation group, hreflang from EmDash.
- **WooCommerce / shops**: Needs a commerce platform (Shopify, Stripe Checkout, Snipcart); product catalogue could become a collection, checkout cannot.
- **Memberships, LMS, paywalls, front-end accounts**: Separate product decision.
- **Events plugins (The Events Calendar, Modern Events)**: Simple event lists via the CPT mapper (`events` collection with datetime fields); recurrence, tickets, iCal feeds out of scope.
- **WordPress-hosted booking engines (Amelia, Bookly)**: Replace with a SaaS provider (owner decision).
- **Multisite, BuddyPress, bbPress, directories, custom business-logic plugins**: Per site, or port via `wordpress-plugin-to-emdash`.

**Suggested order.** Start with items 2 and 3 (S/M): they make every remaining gap visible as a red gate instead of a silent loss. Then items 1, 4, 5, 6 and 7 together as one “blog” milestone, tested against a fixture blog and a real WordPress blog. After that, item 8 and the P1 items in the order the next client sites need them.

## 4. Verification notes

**Confirmed in the installed EmDash 1.5.0 source** (`emdash/src`, `@emdash-cms/*`; read 2026-11-20):

- 17 field types and flat-only repeaters (`schema/types.ts`).
- Entry system columns: no parent, menu_order or template; statuses `draft|published|archived` (`schema/registry.ts`, `query.ts`).
- Taxonomy, menu, widget, section and byline tables plus their REST routes (`astro/routes/api/{taxonomies,menus,widget-areas,sections}`).
- Content create/update accept `bylines` and `publishedAt`; `publishedAt` requires `content:publish_any` (`api/schemas/content.ts`).
- Comments: table, statuses, one-level threading, Turnstile; only the per-entry public submission route was found (`comments/public-submission.ts`, `routes/api/comments/[collection]/[contentId]`).
- Redirects (301/302/307/308/410/451, `[param]` patterns, 404 log) and auto-redirects on slug change.
- `SiteSettings` keys: `title tagline logo favicon url staging postsPerPage dateFormat timezone social seo{titleSeparator defaultOgImage robotsTxt disallowAiTraining googleVerification bingVerification}` (`settings/types.ts`).
- Sitemaps cover only collections that are both SEO-enabled and routable, with no taxonomy or author sitemaps; the robots.txt route exists.
- **No RSS/Atom anywhere in src.**
- FTS5 search; media allowlist (no SVG by default; PDF, audio and video allowed); media has `caption` but no title/description.
- Scheduled publishing runs on the Worker `scheduled()` handler.
- `page:fragments` hook is trusted-only; `page:metadata` exists.
- Email has no attachments.
- Seed keys: `settings collections blockTypes relations taxonomies menus redirects widgetAreas sections bylines content`; there are no seed keys for comments or SEO.
- EmDash's own WordPress import paths: WXR upload; Exporter-plugin import, which writes SEO into `seo_title`/`seo_description` content fields; CLI. The Exporter-plugin import is the only one that imports comments. None of them imports redirects or widgets.
- `@emdash-cms/gutenberg-to-portable-text` handles core audio/file/table/embed among others.

**Docs only (not re-checked in source):** atproto/Atmosphere login; the Docs MCP and agent skills; “shortcodes are not expanded” by the converter.

**Kit status** comes from reading the kit source at the paths cited. Line numbers are approximate (~). The real-site columns come from each site's audit, extract, transform and verify reports and `decisions.md`, and are counts only.

**Assumed or still to verify before code depends on it** (record each result in `docs/spikes/`):

- Whether the kit's API token scopes allow `publishedAt` overrides (needs `content:publish_any`; the scopes listed in M6-findings do not name it).
- The REST schedule endpoint for future posts. MCP has `content_schedule`; the REST path was not read.
- A write path for comments: `emdash site import` with `comment` records, or `importCommentsFromPlugin`. Neither is exercised yet.
- Which `options` keys the Exporter returns: timezone, date_format and posts_per_page were not confirmed (M3 lists identity, front page, permalink structure and site icon).
- Which WordPress widget REST routes work with an application password on WP ≥ 5.8.
- Whether `urlPattern` can express date-based permalinks. No placeholders other than `{slug}` were found, so the plan stores the WP path as the slug.
- Whether EmDash's `buildWebSiteJsonLd` emits a SearchAction.
- The kit's handling of WordPress core `[caption]`, `[audio]`, `[video]`, `[embed]` and `[playlist]` shortcodes. Only `[gallery]` was confirmed.
