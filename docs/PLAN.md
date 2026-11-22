# wp2emdash — Plan

**Goal:** A reusable kit that migrates any WordPress site to EmDash (Astro on Cloudflare Workers + D1 + R2) and proves, with automated checks, that nothing was lost: content, URLs, SEO, design, forms, integrations.

**Targets:** EmDash (default) or Astro + Pages CMS, chosen per site (§2.3).
**v1 scope:** Gutenberg/classic and WPBakery (incl. Salient `nectar_*` elements). Bricks is the second adapter (most client sites are built with it), on the same core and section format: built from the Bricks 2.4.6/2.5 source (§7b) and measured against a real client site. Elementor and Divi adapters are built (2026-11-21, awaiting a real site), as are the Gutenberg block-library handlers.
**Pilot site:** a ~10-page clinic site on Salient + WPBakery with Rank Math, Fluent Forms, Popup Maker and third-party booking widgets.
**Editing model:** fixed library of section types (EmDash `blocks` field), not a free-form row/column builder.

Supersedes the pilot's original one-site migration notes; their operational safety rules are kept in §11.

---

## 1. Principles

1. **Snapshot first, then check everything against it.** Phase 1 records the live site as a golden baseline (URLs, rendered text, SEO tags, screenshots, links, forms). Every later step is diffed against it.
2. **Every phase ends in a gate.** A gate is a script with thresholds from config. Red gate → the next phase refuses to run (override only with an explicit, logged `--accept <reason>`).
3. **Reproducible from raw exports.** The whole pipeline reruns from the raw WordPress export with one command. Manual decisions (mappings, exceptions, accepted diffs) live in per-site `overrides` and `decisions` files, never as hand edits to generated output. This is what makes the cutover delta safe.
4. **Never silently drop anything.** Every source node is either mapped, deliberately dropped by a named rule, or listed in the coverage report as unmapped.
5. **Own the identity map.** EmDash does not persist WordPress IDs and matches reruns by slug (changed slug → duplicate). The kit keeps `id-map.json` (WP ID ↔ EmDash ID ↔ URL) and does upserts through it.
6. **Use official EmDash paths where they are good, own the rest.** Official importer for posts, taxonomies, authors, menus, media and SEO fields. Kit overlay for builder pages.
7. **Never guess commands or bindings.** Every EmDash/Cloudflare assumption is listed in §12 and proven in the M0 spike before code depends on it.
8. **Read-only toward WordPress.** The kit never writes to the live WordPress site. Anything it needs installed there (exporter plugin, app password) is a human step with a checklist.

---

## 2. Architecture

```
            ┌────────────── WordPress (live, read-only) ──────────────┐
            │ public HTML · sitemap · REST · WXR · EmDash Exporter     │
            └───────┬───────────────────────┬──────────────────────────┘
                    │                       │
              [1 audit]               [2 extract]
         baseline snapshot          raw/: wxr.xml, rest/*.json,
         (urls, text, seo,          exporter bundle, options,
          screenshots, links)       media manifest
                    │                       │
                    │               [3 transform]
                    │      builder adapter → Section IR → validate
                    │      (gutenberg | wpbakery+nectar | dom-fallback)
                    │                       │  coverage report
                    │               [4 scaffold]
                    │      starter project + design tokens + section library
                    │                       │
                    │               [5 load]  → staging (D1/R2)
                    │      official importer (posts, media, tax, menus, SEO)
                    │      + kit overlay (pages as blocks) + fix-ups + id-map
                    │                       │
                    └────────►  [6 verify]  ◄┘   content · seo · urls/redirects
                                     │           · visual · links · forms
                                     │           · a11y · perf · security
                              [7 cutover]  preflight → delta → deploy prod
                                     │      → smoke → monitor  (rollback ready)
                              reports/<site>/index.html
```

### 2.1 Section IR (the core)

A versioned, zod-validated JSON format that every adapter outputs and the EmDash writer consumes:

```ts
Page {
  source: { wpId, type, url, builder, modifiedGmt }
  route:  { path, parentPath?, template }
  seo:    { title, description, canonical, robots, og, jsonLd[] }
  sections: Section[]
  diagnostics: Diagnostic[]   // unmapped nodes, lossy conversions, warnings
}
Section {
  type: "hero" | "rich_text" | "media_text" | ...   // see §5
  variant, theme (light|dark|brand|image), spacing, anchorId?
  fields: { ... typed per section type ... }
  sourceRef: { adapter, path, rawHash }  // trace back to the shortcode/block
}
```

Rich text inside sections is Portable Text. Media is referenced by WP attachment ID or source URL and resolved to EmDash media IDs at load time.

### 2.2 Content routing rule

| Content | Path into EmDash |
|---|---|
| Posts (blog) | Kit transform (built 2026-11-20, `src/transform/blog.ts`): EmDash's converter (`@emdash-cms/gutenberg-to-portable-text`) after the kit's shortcode pass → `posts.body` Portable Text; builder posts → adapter → `posts.content` blocks. Loaded through the id-map (not EmDash's import route, which bypasses the id-map and `_emdash_seo`). |
| Pages built with WPBakery | Kit adapter → IR → `layout` blocks field (overlay). |
| Pages built with Gutenberg | Kit adapter → IR when the page uses layout blocks (cover, columns, group, media-text); plain-prose pages stay Portable Text. |
| Custom post types | Kit CPT mapper (2026-11-21, `docs/spikes/cpt-findings.md`): a collection per public type, ACF/Meta Box/Pods fields mapped to EmDash field types (unsupported → JSON + warning), builder content in them goes through the adapter. |
| Reusable blocks / WPBakery templates | Inlined into pages by the adapter; published `wp_block` posts also imported as EmDash sections (`source: import`, built 2026-11-21, `src/transform/sections.ts`; EmDash inserts a copy, not a synced block). WPBakery templates are not imported as sections. |
| Page attributes | Order, parent page, excerpt and featured image → `pages` fields only when the site uses them (2026-11-21, `src/transform/pages.ts`). |
| Users | Never accounts, never passwords: an invite checklist under `sites/<slug>/users/` (counts only elsewhere); `wp2emdash invite --send` is the owner's opt-in (2026-11-21, `src/transform/users.ts`). |

---

### 2.3 Targets — EmDash or Astro + Pages CMS

The target is chosen per site in `kit.config.ts → target.kind`. Everything up to the Section IR is target-neutral; only the last mile differs.

| Shared by both targets | Target-specific |
|---|---|
| audit, extract, builder adapters, Section IR, coverage report | **scaffold** (starter project) |
| section components (Astro), design tokens, header/menu motion recipe | **load** (EmDash CLI/REST vs JSON files + commit) |
| verify (content, URLs, SEO, visual, interactions, a11y, perf) | **redirects** (EmDash native vs `_redirects` file) |
| forms Worker + email providers, cutover/rollback | **editor docs** (EmDash admin vs Pages CMS guide) |

| | `emdash` (default, v1) | `astro-pagescms` (after M9) |
|---|---|---|
| Runtime | Worker + D1 + R2, server-rendered with route caching | Static HTML on Cloudflare, no database |
| Editing | Admin + on-page visual editing, instant publish, drafts, scheduling, revisions, roles | Form-based editor in Pages CMS, each save = Git commit → rebuild (≈1–3 min), no live preview |
| Media | R2 media library, de-duplicated, resized on the fly | Committed to the repo (`media.input`), or R2 with URL fields for large libraries |
| Cost | Workers Paid, $5/month per Cloudflare account (Worker is ≈5.3 MB gzipped, above the free 3 MB limit; free plan's 10 ms CPU also too tight for SSR + DB) | $0 (static hosting + free Pages CMS app); forms Worker fits the free plan |
| Main risks | Young platform (1.x), upgrades/migrations, secrets and auth to operate | Invalid saves break the build silently, repo bloat from images, Git edit conflicts |

**Choosing (asked by `init`):**
- `emdash` when the client edits often or wants to see edits instantly / on the page, has several editors, needs drafts/scheduling, a growing blog or large media library, or wants to manage redirects themselves.
- `astro-pagescms` when edits are rare, budget is $0, and longevity with minimal moving parts matters more than editing comfort.

**Target-specific guard rails:**
- `emdash`: preflight checks Workers Paid is active and the bundle is under 10 MB gzipped.
- `astro-pagescms`: the Astro content schema and `.pages.yml` are generated from the same section definitions, so the CMS cannot save content the build rejects; CI validates content on every commit and blocks deploys of invalid content (the site keeps serving the last good build); upload limits (size, extensions, filename normalisation) are set in `.pages.yml`.

---

## 3. Repository layout

```
wp2emdash/
  CLAUDE.md                     agent rules: phases, gates, never-do list, where overrides go
  package.json                  single TS package, CLI `wp2emdash`
  src/
    cli/                        commander entry, one command per phase
    config/                     kit.config schema (zod) + loader
    audit/                      crawler, sitemap/REST discovery, fingerprinting, snapshots
    extract/                    WXR parser, REST (auth'd, context=edit) puller, options, media manifest
    adapters/
      gutenberg/                block-comment parser → IR
      wpbakery/                 shortcode parser → AST → IR
        elements/               one handler per vc_* / nectar_* element
      dom-fallback/             rendered-HTML → IR (flagged) for anything unknown
      _shared/                  link/attr decoding, heuristics, media refs
    ir/                         schema, validators, normalizers
    load/                       importer driver, overlay writer, fix-ups, id-map
    verify/                     content, seo, urls, visual, links, forms, a11y, perf, security
    redirects/                  URL map → redirect rules
    cutover/                    preflight, delta, smoke, rollback
    report/                     HTML report generator
  starter/                      EmDash/Astro project template (copied per site)
    seed/seed.json              collections, blockTypes (section library), menus, widget areas
    src/components/sections/    one Astro component per section type
    src/pages/[...slug].astro   root-path page routing
    src/middleware.ts           redirects, security headers
    src/styles/tokens.css       filled per site
  skills/                       Claude Code skills wrapping phases (§10)
  sites/<slug>/
    kit.config.ts               per-site config
    overrides.ts                per-site mapping overrides (custom handlers, route fixes)
    decisions.md                accepted diffs/exceptions with reason + who approved
    raw/        (gitignored)    exports, dumps — never committed
    snapshot/                   baseline from audit
    ir/                         generated IR per page
    project/                    the generated EmDash site (own git repo)
    reports/                    gate results + HTML report per run
  test/
    fixtures/                   anonymised real WPBakery/Gutenberg samples
    golden/                     expected IR per fixture
```

Stack: Node 24+ (kit, CI and every generated project: `engines`, `.nvmrc`), TypeScript, Playwright, pixelmatch, cheerio/parse5, fast-xml-parser, zod, vitest, axe-core, Lighthouse CI.

---

## 4. Phases

Each phase lists **inputs → outputs → gate**.

### Phase 0 — `wp2emdash init <slug>`
Creates `sites/<slug>/` with config template, `.gitignore` for `raw/`, and a human checklist (`ACCESS.md`): admin login, full hosting backup downloaded and test-opened, WXR export, EmDash Exporter 1.2.0+ installed + migration key, application password (revoked after), Cloudflare account/zone access, DNS export, Search Console access, booking/forms provider access.
**Gate:** backup confirmed, DNS baseline saved, access checklist complete.

### Phase 1 — `audit` (public site only, no credentials)
- **URL discovery:** union of sitemap(s) (Yoast/Rank Math/core), REST listing of every public post type + taxonomy, crawl from home (internal links, pagination), plus synthetic WP URLs: `/feed/`, `/?p=ID`, `/?page_id=ID`, attachment pages, author/date archives, `/page/N/`, `/wp-content/uploads/…` direct media links.
- **Fingerprinting:** theme/child theme, builder(s) per page, plugins (asset paths, HTML markers, REST namespaces), forms, analytics/tag managers/pixels, cookie consent, booking widgets, maps, embeds, fonts (Google/self-hosted/Adobe), icon fonts.
- **Per URL snapshot:** status, redirect chain, final URL, `<title>`, meta description, canonical, robots, OG/Twitter, JSON-LD, hreflang, H1–H3 outline, normalised visible text, every link and its status, images (src, alt, dimensions), forms (fields, action, provider), iframes/scripts.
- **Screenshots:** 390 / 768 / 1440, full page, fonts loaded, animations disabled, cookie banner dismissed, configurable masks (sliders, tickers, dates).
- **Design capture:** computed styles from the rendered DOM → colours, font families/sizes/weights, line heights, container widths, breakpoints, button and link styles, header/footer structure, mobile menu behaviour.
- **Forms & integrations scan** (dedicated pass, produces `integrations.json` + `integrations.md`):
  - **Forms:** every form on every URL, deduplicated by definition. Detects CF7, WPForms, Gravity Forms, Ninja, Fluent, Formidable, Elementor/Salient/WPBakery forms, HubSpot/Mailchimp/Typeform/Jotform embeds, raw `<form>`s. Records fields (name, type, label, required, options, validation), multi-step, file uploads, honeypot/reCAPTCHA/hCaptcha, action URL, success message/redirect, and where it appears. From the admin export: notification recipients, autoresponders, integrations (Mailchimp, CRM, webhooks). Flags fields that may collect health data.
  - **Booking & scheduling:** Calendly, Acuity, Jane, SimplePractice, Mindbody, Square, Setmore, custom links. Records URLs and embed type.
  - **Other integrations:** analytics/tag managers/pixels (GA4, GTM, Meta, LinkedIn, Hotjar, Clarity), consent banners, chat widgets, maps, video, social feeds, reviews widgets, newsletter popups, phone/WhatsApp/email links, `tel:`/`mailto:` click tracking, custom header/footer scripts.
  - Each item gets a proposed action: **keep as is** / **rebuild natively** (`form` section + Worker endpoint) / **replace with X** / **drop**, which the owner confirms before the load phase.
**Outputs:** `snapshot/urls.json`, `snapshot/pages/*.json`, `snapshot/screens/`, `audit.md`, `integrations.md`, `plugin-matrix.md` (each plugin → keep / replace with X / drop / out of scope).
**Gate:** crawl complete (no unexplained URL-count gaps between sitemap/REST/crawl), out-of-scope features flagged (§9) and acknowledged.

### Phase 2 — `extract` (credentials via `.env`, never in prompts; GET-only)
Implemented in M3 (`src/phases/extract.ts`). Credentials: the exporter migration key (`EMDASH_WP_MIGRATION_KEY`, `em1.` + base64url JSON with url/user/app-password) or `WP_APP_USER` + `WP_APP_PASSWORD`.
- **EmDash Exporter API (primary):** `probe`, `analyze`, `content` for every post type incl. private (raw `content` with shortcodes intact, all meta incl. `_wpb_*`/`_nectar_*`, Rank Math/Yoast, taxonomies, featured image, parent, order, dates), `media`, `taxonomies`, `menus` (items + theme locations), `options` (identity, front page, icon), `comments`. Types not advertised by the exporter are still requested (`salient_g_sections`, `wp_block`, `wp_navigation`, `popup`, `rank_math_schema`, …). Author and admin emails are stripped.
- **Forms:** definitions, notification and confirmation settings, integrations through the form plugin's REST (Fluent Forms in M3); every other plugin from its own export file in `raw/plugin-exports/` (Contact Form 7, Gravity Forms, WPForms, Ninja Forms, Formidable, WS Form, Forminator — file fields, simple conditions and steps carried, payments blocking), or from the live form's HTML when there is no export (flagged). **Submissions are never read.**
- **Post passwords:** read over REST as an editor and hashed at once into `raw/protected.json` (never stored in clear); transform carries protected pages/posts behind the starter's password page, private ones as drafts (decisions in `overrides.ts protectedContent`; [content & forms findings](spikes/content-forms-findings.md)).
- **Media:** every library item downloaded to `raw/media/` (hidden upload paths such as WP Ghost's `/storage` handled), sha1 recorded in `raw/media-manifest.json`; every reference in content/meta resolved — attachment IDs in shortcode attributes, `wp-image-N`, gallery `ids`, URLs incl. `-300x200`/`-scaled` variants, URL-encoded link attributes and base64 `vc_raw_html`. Site uploads missing from the library are downloaded too; external media (CDN videos) are checked and listed for a keep-hotlinked vs copy-to-R2 decision. Reruns reuse cached files.
- **Not available over REST (manual, optional, read in transform):** Salient Redux theme options (`raw/salient-options.json` from Salient → Options → Import/Export; otherwise design capture is the source), Rank Math redirections (`raw/redirects.csv`), WXR (`raw/export.xml`) as a cross-check.
- `extract.json` keeps the latest `modified_gmt` per type for the cutover delta.
**Gate:** credentials valid for the configured host; exporter ≥ 1.2.0; authenticated read; every type fetched and counts equal the exporter's totals; menus present when the audit saw a menu; Salient global sections present on Salient sites; every live form's definition extracted; media library fully listed and downloaded; every attachment ID used by **published** content resolves (unpublished leftovers reported); every page the audit found is in the extract.
**Report:** `reports/extract/extract.md` (no credentials, usernames or emails).

### Phase 3 — `transform`
Implemented in M4 (`src/phases/transform.ts`, `src/adapters/`, `src/ir/`). Pure function of `raw/` + `overrides.ts`; reruns give byte-identical IR.
- **Adapters:** WPBakery/Salient shortcode parser → element handlers → row recognisers (§6); Gutenberg block parser → the same recognisers (§7); classic content via wpautop → Portable Text (shortcodes inside it go through the shortcode adapter); pages of builders without an adapter → the DOM fallback from the audit's saved HTML (§7h).
- **Output:** `ir/pages/*.json`, `ir/posts/*.json` (builder posts only), `ir/partials/*.json` (Salient global sections → footer/header), `ir/popups/*.json` (enabled Popup Maker popups with their trigger selectors), `ir/site.json` (identity, menus with roles, partials, popups). Buttons/links that open a popup carry `opensPopup`.
- **Site settings** (`ir/settings.json`, `src/transform/settings.ts`): EmDash's Settings → General / Social Links / SEO prefilled from WordPress — logo and site icon, posts per page, date format (PHP → date-fns), timezone; social profiles (Rank Math / Yoast options, home-page JSON-LD `sameAs`, header/footer links); default social image (SEO plugin default, else the og:image most pages share); Google/Bing verification (audited head, else SEO plugin); robots.txt (the site's own rules, WordPress-only rules dropped, sitemap at the new domain). Every value names its source in the coverage report; what EmDash has no field for is listed (docs/spikes/settings-findings.md).
- **Overrides:** `elements["<slug>:<row path>"]` forces a section type or drops a decorative row; `approvedLegacy` lets a reviewed `legacy_html` ship; `routes` fixes paths; `snippets["sn-…"]` decides a site-wide snippet (drop | rebuilt); `contentTypes` / `taxonomies` / `authors` decide what the kit does not migrate yet (skip | pages, with the owner's reason); `wpUrls` changes a WordPress-URL rule; `customCss` carries or drops the Customizer Additional CSS; `gone` lists old addresses the owner decided are gone (verify).
- **Nothing lost silently (2026-11-20, `docs/spikes/wp-urls-findings.md`):** content inventory (every non-empty post type, taxonomy with terms in use, authors with posts → coverage "Content types"); Additional CSS (live `<style id="wp-custom-css">` or the `custom_css` post → coverage, scaffold writes `public/styles/custom-<hash>.css` on "carry", linked after the starter CSS); WordPress-URL rule set (`ir/wp-urls.json`: feeds, search, archives, attachment pages, query forms → 301 or 410, decided per site from the audit; scaffold → `site.config.json wpUrls`, applied by the starter middleware, judged by verify).
- **Blog (2026-11-20, `docs/spikes/blog-findings.md`):** on when WordPress has posts (or kit.config `blog: true`; `false` turns it off): `ir/posts/*.json` with `post` data (Portable Text body, dates, excerpt, sticky, format, terms, bylines, visibility) and `ir/blog.json` (posts page, per page, feed, taxonomies with terms, bylines, archive bases). Gate `protected-posts` until `overrides.ts protectedPosts` decides private/password posts. Seed/load add the `posts` collection, taxonomies, terms and guest bylines; the starter serves the posts page, archives, single posts and RSS feeds; the WordPress-URL rules treat them as real routes; verify checks `posts` and `feeds`.
- **Custom post types (2026-11-21, `docs/spikes/cpt-findings.md`):** every public type the Exporter describes is its own collection by default (`overrides.ts contentTypes: { <type>: { as: "collection", name?, fields? } }`; `pages`/`skip` with a reason as before). `ir/collections.json` (collections, core and custom fields with their WordPress source, taxonomies, bylines, unmapped meta) and `ir/entries/<collection>/*.json` (`entry`: fields, references `<type>:<wpId>`, body, terms, order). Field definitions: plugin exports in `raw/plugin-exports` (ACF field groups, Meta Box, Pods → `raw/field-definitions/`), ACF `acf-field` posts, the Exporter analyze list; values from the Exporter `acf` object or raw meta. Gate `cpt-fields` until every meta key without a definition is mapped or skipped. Seed/load create the collections and fields, taxonomies and terms, write entries and resolve references in a second pass (check `references`); the starter serves archives (numbered pages), term archives and single entries; verify checks `entries`, and `urls-accounted` wants a 200 for entries and archives.
- **Coverage report** (`reports/transform/coverage.md`): per document section map, text kept, diagnostics; site-wide unmapped-element table; site-wide snippets (carried / not needed / needs a decision, `ir/site-snippets.json`).
**Gate:** IR validates; every site-wide snippet carried, not needed or decided; every non-empty post type, taxonomy in use and author with posts migrated or decided (`content-types-handled`); Additional CSS carried or dropped by decision (`custom-css`, only when the site has some); 0 unmapped nodes carrying content in published pages, footer and popups; 0 unapproved `legacy_html`; every media reference resolves to the extract; every image published content uses in WordPress is in the IR; every internal link points at a migrated page, anchor, popup or file; **text conservation** — share of distinct words of the live page's own server HTML (theme chrome removed) found in the IR ≥ `gates.textConservation` (default 99%). Unpublished content is transformed and reported but not gated.

### Phase 4 — `scaffold`
Implemented in M5 (`src/phases/scaffold.ts`, `src/scaffold/`, `src/starter/library.ts`, `starter/`). Facts it relies on: `docs/spikes/M5-findings.md`.
- **Section library = one TypeScript definition** (`src/starter/library.ts`) → seed `blockTypes`, the starter's components and the IR → block mapping (`src/targets/emdash/blocks.ts`, which conforms every value to its block type).
- **Generated per site:** `tokens.css` (design capture: colours, fluid type scale between the mobile and desktop captures, container, radii), `motion.css` (menu motion recipe), `site.config.json` (header panel variant, breakpoint, transparent/hide-on-scroll, logos, fonts, URL style), forms (`src/forms/*.json` from the form plugin, published forms only), `seed/seed.json` (block types, `pages` / `site_parts` / `popups` collections, menus, settings with `staging: true`, and the migrated content for local preview), `package.json` with exact verified versions, `astro.config.mjs`, `wrangler.jsonc` (production; plus a `staging` env with separate D1/R2 only when the site opted into staging, §7a).
- **Performance package (default, `src/scaffold/perf.ts`, opt-outs under `performance` in kit.config):** route caching (`cacheCloudflare()`, one route rule per public page + sitemaps + `/_image`, EmDash collection tags; chrome cache hints set in the page frontmatter), `"cache": { "enabled": true, "cross_version_cache": false }` in `wrangler.jsonc`, `scripts/warm.mjs` appended to every deploy script, `image.domains` for responsive EmDash images (Images binding), hashed brand files with sizes and `public/_headers` (immutable fonts/brand), deferred background video, announcement schedule in the browser with a CSP hash. Smart Placement off. Facts and measurements: `docs/spikes/performance-findings.md`.
- **Local preview:** `pnpm dev` in `sites/<slug>/project`, then `/_emdash/api/setup/dev-bypass?redirect=/` — the migrated site with live WordPress media.
- **Runtime pins (every generated project):** Node 24+ for install/build/CI (`engines`, `.nvmrc`, CI image); the Worker itself runs on workerd (V8), not Node — Node APIs come from the `nodejs_compat` flag, and `compatibility_date` is set to the scaffold date so the newest runtime behaviour is used. Astro = latest stable that EmDash's peer range allows (checked by `doctor`: EmDash 1.5 needs `astro >=6`; latest is 7.4.12 on 2026-11-17, used by the M0 spike). Exact versions in the lockfile; upgrades are a deliberate step with a rerun of verify.
- Copy `starter/` into `sites/<slug>/project/` (or create with `npm create emdash@latest` and apply the starter as an overlay — decided in M0).
- Write `tokens.css` from design capture; generate header/footer from captured structure; register per-site section variants.
- Seed: collections (pages with `template` + `layout` blocks field, posts, CPTs), `blockTypes`, menus, widget areas, site settings.
- Staging resources (opt-in, §7a): separate D1 + R2 + secrets per environment (`emdash secrets generate`). Staging host from `target.staging.host` (e.g. `staging.example.com` on the client zone; empty = `*.workers.dev`), protected per `target.staging.protection`: `access` (default: Cloudflare Access login wall + robots `Disallow: /` + `X-Robots-Tag: noindex`) or `noindex` only. Canonicals on staging already point at the production host. Behind Access, `verify` and Playwright authenticate with an Access service token kept in `sites/<slug>/.env`. See §7a.
**Gate (local, M5):** every IR section type has a block type and component; every form section has a definition; brand assets copied; install; `seed.json` passes EmDash's validator; build; Worker < 10 MB gzip. **Staging gate (with load, M6, owner-approved deploy):** staging deploy answers, admin login works, every route renders.

### Phase 5 — `load` (local, then staging)
Implemented in M6 (`src/phases/load.ts`, `src/targets/emdash/api.ts`); API facts in `docs/spikes/M6-findings.md`; operator runbook for staging in `docs/staging-setup.md`.
- **Targets:** `local` (the kit starts the project's dev server, applies the seed structure with `?content=0`, logs in with dev-bypass), `production` (default for a provisioned single-environment site: its workers.dev address before go-live; `EMDASH_TOKEN_PRODUCTION` or `EMDASH_TOKEN`; after go-live only with `--force` and a D1 Time Travel bookmark) and, for opt-in staging, `staging` (`WP2EMDASH_LOAD_TARGET=staging`, `target.stagingUrl`, `EMDASH_TOKEN`). Sites with staging keep `local` as the default. Deploy, admin passkey and API token are human steps (§7a).
- **Media:** every IR media reference → file from `raw/media/` (external media per `overrides.media.external`: `copy` downloads it) → sha1 → reuse the target's item with that `contentHash`, else upload.
- **Content:** pages / `site_parts` (footer) / `popups` written through the id-map (`load/id-map.<target>.json`, keyed by WordPress type + id; first load adopts an entry with the same slug). Updates send the entry's `_rev`. SEO title/description/canonical/noindex from the IR. Published in WordPress → published; private/draft → draft.
- **Fix-ups:** links to the WordPress host become paths; WordPress upload URLs become EmDash media URLs.
- **Menus and settings:** menus recreated from the IR (popup triggers as `popup-<slug>` classes); `staging: true` until cutover; every setting of `ir/settings.json` plus title and tagline — logo and favicon uploaded from the scaffolded brand files (named `wp2emdash-<name>-<sha1:10>` so the starter keeps serving their optimized copies), default social image from the media pipeline. Load records a hash of each value it wrote (`load/settings.<target>.json`) and keeps a value an editor changed since (reported "kept editor's value"); `--overwrite-settings` replaces it. On a live production without a record, values already there count as the editor's; a record that matches nothing on the target (a reset or new database) is ignored.
- Before every staging load: snapshot (`site export`) — with the first staging run.
**Gate:** target reachable and authenticated; section library and collections present; every media reference on the target; every document written; menus written; site settings written (or kept as the editor changed them); entry counts equal the IR with no duplicate slugs; no WordPress host links, upload URLs or shortcodes in stored content; every media id exists; id-map complete; every published page renders (200) and shows its first heading. Verified idempotent: a second run uploads and creates nothing.

### Phase 6 — `verify` (old live site vs staging, URL by URL)
Implemented in M7 (`src/phases/verify.ts`, `src/verify/`): HTTP checks per page (status, text recall, headings, SEO title/description/canonical/robots/JSON-LD/OpenGraph, external links, alt text, form fields), internal link crawl, security headers, WordPress endpoints, form endpoints; browser checks reuse the audit's capture (screenshots → pixel diff over the overlapping height, axe WCAG 2.1 AA, lab LCP/CLS on mobile, burger-menu capture → motion recipe comparison). Fresh `workers.dev` hosts are reached with the pinned addresses (`--host-resolver-rules`, no proxy). Report: `reports/verify/index.html` (gate summary, per-page table, slider / side-by-side / diff per viewport) + `verify.json`.
| Check | Pass rule (defaults, configurable) |
|---|---|
| Content | normalised visible text similarity ≥ 0.98 per page; heading outline identical; every source image present with alt |
| URLs | every baseline URL → 200 at same path, or a 301 (single hop) to its mapped target; documented exceptions only. Built (`urls-accounted`, 2026-11-20): every audited URL, every REST-discovered entry/term/author/attachment page, the upload files the pages used and WordPress's query forms and feeds answer 200, one 301/308 to a 200, or 404/410 by decision (`overrides.ts gone`, the site's WordPress-URL rules, a skip decision); unaccounted ones listed by kind |
| SEO | title, description, canonical (pointing to prod host), robots, OG, JSON-LD types identical or decided; sitemap contains exactly the indexable URLs; no `noindex` leaking to prod config |
| Links | 0 broken internal links; external links same as source (booking, phone, email, socials) |
| Visual | per page × viewport pixel diff ≤ 3% after masks, plus structural diff (section order/count) = 0; anything above → `decisions.md` approval |
| Forms | each form submits on staging to the test destination; Turnstile active; validation errors accessible |
| Integrations | analytics/tag manager loads once, consent respected, booking/embeds/maps work |
| Accessibility | axe: 0 serious/critical; keyboard nav of menu/accordions/forms; reduced-motion respected |
| Performance | Lighthouse mobile ≥ 90 perf, LCP ≤ 2.5s, CLS ≤ 0.1 on representative pages; on deployed targets every page `cf-cache-status: HIT` on its second request, cached home-page TTFB ≤ 600 ms (from the runner), home page ≤ 1500 KB until load with no video fetched (performance package, `docs/spikes/performance-findings.md`) |
| Security | headers (CSP, HSTS, X-Content-Type-Options, Referrer-Policy, Permissions-Policy), no secrets in bundle, admin passkey/MFA, `/wp-admin`, `/wp-login.php`, `/xmlrpc.php` → 404/410 |
| Editing | scripted: create/edit/publish/unpublish a page with each section type, preview works, edit shows on frontend (cache invalidation) |

Output: `reports/<run>/index.html` — one row per URL, every check green/red, side-by-side screenshots and diffs.
**Gate:** all green or each red item has an approved entry in `decisions.md`. Owner sign-off recorded.

### Phase 7 — `cutover`
Implemented so far: the read-only **preflight** (`src/phases/cutover.ts`): last verify passed or accepted, production resources and Worker secrets present, production Turnstile key set, zone on Cloudflare with proxied apex/www records and no Worker route in the way (go-live token), canonical-host redirects; it records the zone's DNS and writes `cutover/runbook.md` with the launch and rollback commands. Production is deployed and loaded on its `workers.dev` address first (`WP2EMDASH_LOAD_TARGET=production`, `WP2EMDASH_TARGET=production`). The traffic switch below is a separate, owner-approved step.
- **Preflight:** production D1/R2/secrets separate from staging; domain/zone ready; DNS records (MX, SPF, DKIM, DMARC, verification TXT) recorded and untouched; TTLs lowered 24–48h ahead if DNS changes; canonical host policy (apex vs www, trailing slash, http→https); rollback owner and procedure tested.
- **Freeze + delta:** content freeze on WordPress; REST query for anything with `modified_gmt` after the last extract; rerun `extract → transform → load` (idempotent through id-map); re-verify changed URLs.
- **Deploy:** production deploy (`workers.dev` first, smoke-tested there), then switch traffic by `target.cutover.method` — default `route`: add Worker routes for apex + www in front of the existing proxied WordPress record. Never delete the WordPress A/AAAA records at launch. See §7a.
- **Smoke:** run the URL, SEO, forms and redirect checks against production from outside any admin session.
- **Rollback:** `route` method: delete the Worker routes; the proxied record still points at WordPress, so traffic returns in seconds with no DNS wait. `custom-domain`: remove the Custom Domain and restore the recorded A/AAAA record (minutes). `dns`: DNS revert with the lowered TTL. Script + tested runbook (rehearsed on staging before launch). Any EmDash edits after cutover listed for reconciliation.
- **Post-launch (scheduled checks):** 404 log → new redirects, Search Console sitemap submit + coverage watch, form deliverability, error rates, for `target.cutover.monitorDays` (default 14). Site health (§7e) watches uptime, indexability, form email, links, mail DNS, speed and analytics from inside the site for its whole life, with alerts and a monthly report. WordPress kept running and restorable for `target.cutover.keepWordPressDays` (default 30), not publicly reachable.
- **Alias domains (`target.aliasDomains`):** a second domain of the same business (e.g. a near-identical WordPress install) becomes a permanent, path-preserving 301 to the primary. Before launch: `init --from` creates the alias's workspace from the primary's config, its read-only audit feeds `wp2emdash compare <primary> <alias>` (pages only on one side, distinct-word similarity, sentences/words only on one side, title/description/canonical/H1, forms, external booking/social links → `sites/<alias>/reports/compare/<primary>.md`), and unique content is merged into the primary through overrides/decisions or the CMS. Preflight, per alias (go-live token with the alias zone: Zone Read, DNS Read, Single Redirect Read; Edit only for the switch): zone active, DNS snapshot `cutover/dns-before.<alias>.json` with mail records flagged (MX, SPF, DKIM, DMARC, autodiscover, Microsoft 365), apex and www proxied (a redirect rule only sees proxied traffic; a missing record gets a proxied-placeholder instruction, never an automatic change), existing redirect rules listed. Runbook §4: one Single Redirect rule per alias in the `http_request_dynamic_redirect` phase (`http.host in {alias www.alias}` → `concat("https://<primary>", http.request.uri.path)`, 301, query string kept), curl verification, rollback by deleting that rule id; Search Console Change of Address, sitemap, off-site checklist (Business Profile, social, booking providers, keep the domain registered). No DNS record changes. After the switch, `wp2emdash check-aliases <slug> [--paths-from <aliasSlug>]` requests every audited path on each alias (apex and www) without following redirects and requires a 301 to the same path on the primary (reports 200/404/302/chains).
- **Finalise (optional, owner-approved):** after the monitoring window, convert the route to a Worker Custom Domain (this is the only step that removes the WordPress A/AAAA record), then decommission WordPress hosting after `keepWordPressDays`, keeping the final backup.

### 7a. Environments and launch topology
**Owner decision 2026-11-20: one Cloudflare environment per site by default — production — deployed to its
`workers.dev` address until go-live. Staging is opt-in** (`target.staging: true`; rules in `src/core/environments.ts`).

| Stage | Where | Data | Who sees it | Purpose |
|---|---|---|---|---|
| Local | `pnpm dev` (Miniflare: local D1/R2) | local copy | developer | build sections, header/menu motion, content checks. Not used for verify: forms, email, Turnstile, R2 images, caching and CPU limits only behave for real on Cloudflare. |
| Production, before go-live | `<worker>.<subdomain>.workers.dev` | production D1/R2/KV/secrets | owner + client (unlisted, `noindex`) | `load` and `verify` run here by default; client review and sign-off. Form messages are tests (test inbox only). |
| Production, after go-live | `<domain>` via Worker route (workers.dev keeps answering) | the same | public | cutover delta, smoke, monitoring. Content edited in the admin; code changes reviewed on Workers preview URLs. |
| Staging (opt-in) | `staging.<domain>` or `<worker>-staging.*.workers.dev` | separate D1/R2/KV/secrets | owner + client, behind Access | a copy to change and sign off without touching production data. |

**Single environment (default).**
- `provision <slug>` creates production only (D1, R2 media, KV outbox, R2 sign-in sessions bucket — KV session with `sessions: "kv"`); `provision <slug> staging` is refused.
- Scaffold: `wrangler.jsonc` without `env.staging`, with `workers_dev: true` and `preview_urls: true`; scripts
  `deploy:production` (+ `ci:deploy:production` once `production.d1.fingerprint` is recorded), `versions:upload`,
  `versions:deploy`.
- Client CI: check on every PR and push; `deploy-production` on push to `main` **only before go-live** (only the
  workers.dev address changes, nothing public) and from *Run workflow* always. After go-live production deploys are
  manual, because each one reaches visitors at once; `target.ciDeploy: "always" | "manual"` changes that. The rescaffold
  that follows `golive` writes the post-launch workflow.
- Forms: production gets `FORM_LIVE_HOST` (the production host) and `FORM_TEST_TO` (`email.stagingTo`). A message from
  any other host — workers.dev before go-live, a preview URL after it — is a test: `[Test]` subject, test inbox only,
  stored with `test: true` so neither the outbox cron nor "Email it now" ever sends it to `FORM_TO` or the admin's
  recipients, also after launch. Host-based, so go-live needs no redeploy for forms to reach the client, and no
  pre-launch message can reach them. Without a test inbox, test messages are kept unsent (outbox) or refused.
- `load` and `verify` default to production once provisioned (local before that; `WP2EMDASH_LOAD_TARGET` /
  `WP2EMDASH_TARGET` override); `EMDASH_TOKEN_PRODUCTION`, with `EMDASH_TOKEN` accepted as an alias. The MCP server
  never targets production (`WP2EMDASH_NO_PRODUCTION`).
- After go-live, `load` into production needs `--force` and first records a D1 Time Travel bookmark
  (`sites/<slug>/load/d1-bookmarks.jsonl`) and prints `wrangler d1 time-travel restore <db> --bookmark=…`
  (docs/spikes/single-env-findings.md). R2 is not covered (load only adds media).
- Code changes after go-live: `pnpm versions:upload` (a version with no traffic + its preview URL) → review →
  `pnpm versions:deploy <id>@100% --yes` (migrations first). Preview URLs share production's D1, R2 and KV: they are
  for code and layout review only, never for trying content or settings.

**When to opt into staging** (`target.staging: true`, then `provision <slug> staging`, scaffold, deploy):
client sign-off on big changes after launch (redesigns, new sections, EmDash upgrades with migrations) on a copy of
the data; bookings, payments or sensitive data, where a test must not touch production records; many editors, where
experiments in a shared admin would be seen by everyone. Existing sites with staging (`target.stagingUrl`, or staging
resources in `cloudflare.json`) keep it unchanged; `target.staging: false` turns it off.

Launch sequence (zone on Cloudflare, `method: "route"`):
1. Before launch: WordPress A/AAAA for apex + www stay **proxied** (orange cloud); MX, SPF, DKIM, DMARC and verification TXT recorded and never touched.
2. Launch: add Worker routes `<domain>/*` and `www.<domain>/*`. Requests hit the Worker before the origin, so the switch is instant and needs no DNS propagation. WordPress keeps running behind it, unreachable to the public.
3. Rollback at any time during monitoring: delete the routes.
4. After `monitorDays` and owner approval: switch to a Custom Domain (removes the old record), then retire WordPress after `keepWordPressDays`.

Why not "delete the A records, then point the domain at the Worker": it causes a gap where the site is down, rollback waits on DNS, and WordPress becomes hard to reach because it redirects every hostname to its configured site URL.
If the zone is not on Cloudflare (`method: "dns"`): lower TTLs 24–48h ahead, and prefer moving the zone to Cloudflare first (nameservers only, records copied 1:1 and diffed against the DNS export) as a separate, earlier step so launch day can still use routes.


---

## 5. Section library (v1)

Implemented once in `starter/` as EmDash `blockTypes` + Astro components. Styling comes from per-site tokens; variants are small enums, not free CSS.

| Type | Key fields | Typical sources |
|---|---|---|
| `hero` | heading, subheading, body, buttons[], media (image/video/bg), overlay, height, align | first full-width row with bg image, `nectar_slider`, core/cover |
| `rich_text` | body (Portable Text), width (narrow/normal/wide), align | `vc_column_text`, paragraphs/headings/lists |
| `media_text` | media, body, buttons[], media side, ratio | 2-col row with image + text, core/media-text |
| `columns` | 2–4 columns of Portable Text (escape hatch for generic layouts) | generic multi-column rows |
| `feature_grid` | items[] (icon/image, title, text, link), columns | `nectar_icon_list`, `fancy_box`, icon boxes |
| `cta_banner` | heading, body, buttons[], background | `nectar_cta`, call-to-action rows |
| `faq` | items[] (question, answer PT), schema toggle (FAQPage JSON-LD) | `vc_tta_accordion`, `toggle`/`toggles`, core/details |
| `pricing` | plans[] (name, price, period, features[], button, highlight) | `pricing_table`/`pricing_column` |
| `testimonials` | items[] (quote, name, role, photo, rating), layout | `testimonial_slider`, quote blocks |
| `team` | members[] (photo, name, role, bio, links) | team member elements |
| `gallery` | images[], layout (grid/masonry/carousel), lightbox | `vc_gallery`, `nectar_image_gallery`, core/gallery |
| `logo_strip` | logos[] with links | client/partner rows |
| `stats` | items[] (value, label, prefix/suffix) | `milestone`, counters |
| `steps` | items[] (title, text, icon) | process/timeline elements |
| `tabs` | tabs[] (label, body PT) | `vc_tta_tabs`, `tabbed_section` |
| `video` | provider/url or file, poster, caption | `vc_video`, `nectar_video_lightbox`, core/embed |
| `audio` | audio file, caption, autoplay/loop | core/audio |
| `posts_list` | count, category slugs, show image/date/author/excerpt, columns (listed at render time) | core/latest-posts, core/query |
| `form` | form definition ref, heading, intro | CF7/WPForms/Gravity/Salient forms (§8) |
| `map` | embed URL or address, height | `vc_gmaps`, map embeds |
| `embed` | sanitised HTML from allowlist (iframe providers), height | `vc_raw_html` that is a known widget |
| `legacy_html` | raw HTML, reason | fallback only; always red in the report until replaced or approved |
| `announcement` (site part, not page content) | on/off, message (Portable Text), ≤ 2 buttons, background/text/button colours, dismissible, sticky, show from / hide after | top bars detected in the audit's saved HTML: Announcer, WPFront Notification Bar, Salient `#header-secondary-outer` text, Astra above-header HTML; generic `[class*=announcement|topbar|top-bar|notice-bar|promo-bar|notification-bar]` above `<main>` is reported only (operator: `overrides.announcement: "keep" \| "drop"`) |

Rules: no spacer/divider blocks (spacing is a section property); section `theme` covers background colour/image/dark text; `anchorId` preserves in-page links (`#pricing`).

---

## 5a. Interactions & motion parity (header, burger menu, scroll behaviour)

The navigation is part of the design, not a detail. The kit reproduces it from measurements, not guesses.

**Audit (built, M2):** per viewport, on the home page, without reduced motion:
- Finds the visible menu toggle (Salient, Astra, GeneratePress, Divi, Elementor, Bricks, Kadence, block themes, generic `aria-expanded` buttons).
- Records closed / mid-animation (80, 180, 320 ms) / open screenshots and a `menu.webm` video.
- Reads every animation the click starts through the browser's Web Animations API: target, property, duration, delay, easing, keyframes. Infinite animations (marquees) are ignored.
- Identifies the panel (off-canvas left/right, fullscreen, dropdown), overlay colour/opacity, menu items with nesting, item typography.
- Tests behaviour: scroll lock, focus moved into the menu, Esc closes, toggle closes, close button, `aria-expanded`.
- Header on scroll: background, height, shadow, logo swap, hide/reveal transform.
- Theme settings from `<body data-*>` (Salient: `slideOutWidgetAreaStyle`, `cae`/`cad` easing/duration, `hhun` hide-header-on-scroll, `headerBreakpoint`…).
- Condenses it into a **motion recipe**: overlay fade, icon morph (duration, easing, stagger), item reveal (properties, duration, easing, first delay, stagger step).

Output: `snapshot/interactions.json`, `snapshot/interactions/<viewport>/…`, `reports/audit/interactions.md`.

**Starter (M5):** one accessible `SiteHeader` component with variants chosen from the audit:
- Panel: `fullscreen`, `fullscreen-split`, `off-canvas-left`, `off-canvas-right`, `dropdown`.
- Toggle icon: `lines-to-x` (Salient "simple-transform"), `lines-collapse`, `plus-rotate`, text-only label; optional "MENU" label.
- Motion from the recipe as CSS custom properties (`--menu-item-duration`, `--menu-item-easing`, `--menu-item-stagger`, `--menu-overlay-duration`, `--menu-icon-duration`…), so the numbers are data, not code.
- Header scroll modes: static, sticky, transparent→solid, hide-on-scroll-down/reveal-on-up, logo swap.
- Items come from EmDash `getMenu("primary")`, so the client edits the menu in the admin and the animation still works.
- Always: real `<button>` with `aria-expanded`/`aria-controls`, focus trap, Esc, focus return, `inert` background, scroll lock, `prefers-reduced-motion` (instant open). Source accessibility gaps are fixed, not copied.

**Verify (M7):** replays the same recipe on staging at every viewport:
- Open-state screenshot diff against the source (same threshold as pages).
- Timing parity: each recipe value within ±15% (durations, delays, stagger), same easing curve.
- Menu items and links identical to the source menu (or the approved change in `decisions.md`).
- Behaviour checks must pass even when the source failed them (keyboard, Esc, focus, aria).
- Header-scroll states compared the same way.

---

## 6. WPBakery + Salient adapter

**Parser:** a real shortcode parser (nesting, self-closing vs enclosing, quoted/unquoted attrs, `&#8221;`-style encoded quotes, `[[escaped]]` shortcodes, unknown shortcodes kept as nodes) → AST. Tested against fixtures, not regex replacement.

**Decoders:**
- `vc_link` attrs: `url:…|title:…|target:…|rel:…` (URL-encoded).
- `vc_raw_html` / `vc_raw_js`: base64 + URL-encoded content. Raw JS is always flagged for review, never auto-copied.
- `css=".vc_custom_123{…}"` attrs + `_wpb_shortcodes_custom_css` meta → padding/margin/background/border, mapped to the nearest `spacing`/`theme` enum, raw values kept in diagnostics.
- Attachment IDs in `image`, `images`, `bg_image` attrs → media manifest.
- Column widths (`1/2`, `2/3`, `offset`, responsive `vc_col-sm-*`) → layout hints and `media_text` ratio.
- Row attrs: `full_width`, `bg_color`, `bg_image`, `text_color` (light/dark), `parallax`, `video_bg`, `id`/`el_id` → section theme, variant, anchorId.

**Mapping strategy (two layers):**
1. **Element handlers:** one per shortcode (`vc_column_text`, `vc_single_image`, `vc_btn`/`nectar_btn`, `vc_custom_heading`, `vc_tta_*`, `toggle(s)`, `nectar_icon_list`, `fancy_box`, `pricing_*`, `testimonial_slider`, `milestone`, `nectar_slider`, `nectar_cta`, `vc_video`, `vc_gmaps`, `vc_gallery`, `nectar_image_gallery`, `team_member`, …) → typed IR fragments.
2. **Row recognisers:** look at a whole `vc_row` (columns + fragments + attrs) and pick the section type (image col + text col → `media_text`; N identical icon boxes → `feature_grid`; first full-bleed row with bg image + heading + button → `hero`, etc.). Unrecognised rows fall back to `columns`, never to raw HTML.

**Salient specifics:** `nectar_*` elements; Redux global options for colours/typography/header/footer; Salient header variants (transparent on hero, sticky, off-canvas mobile menu); page-header meta (`_nectar_header_*` title/bg per page) → `hero`; Salient portfolio CPT; icon fonts (Iconsmind, Linecons, Font Awesome, Steadysets) → inline SVG icon set with a mapping table.

**Cross-check:** for every page, the adapter's text and image set is compared against the rendered snapshot of the same URL; mismatches become diagnostics (this catches shortcodes rendered with server-side defaults).

---

## 7. Gutenberg adapter

- Parse block comments (`<!-- wp:name {attrs} -->`) into a block tree, the same format WordPress's own parser outputs.
- Core blocks: paragraph, heading, list, quote, image, gallery, buttons, columns/column, group, cover, media-text, table, details, embed, video, audio, file, separator, spacer (dropped), html (flagged), shortcode (routed to the shortcode parser).
- Reusable blocks (`core/block` ref) and synced patterns: resolved inline; also imported as EmDash sections.
- Server-rendered/dynamic blocks (latest posts, query loop, categories, plugin blocks): mapped to a component when known (e.g. `query` → posts listing section, added later if needed) else flagged; content taken from the rendered snapshot.
- Third-party libraries (built 2026-11-21, `src/adapters/gutenberg/libraries.ts`, facts in `docs/spikes/gutenberg-libraries-findings.md`): Kadence Blocks, Spectra (UAG), GenerateBlocks (v1 and v2), Stackable (v3) and CoBlocks. Layout blocks (Kadence row layout with its `colLayout` presets, Spectra columns and row-direction containers, GenerateBlocks grid and grid/flex elements, Stackable columns and feature grid, CoBlocks row) become rows/sub-rows with column widths and container background; wrappers are transparent. Content blocks map to fragments: advanced heading, buttons, icon list, info box → feature, tabs, accordion/FAQ, testimonials, team, counters → stats, maps, galleries, pricing, CTA; Kadence/Spectra/CoBlocks form blocks → form definitions (`ir/forms/<library>-<post>-<n>.json`, recipients never copied). A top-level library collection block is a section of its own (a heading just before it is its title). Query loops/post grids are listings (dropped when the site has no posts, else unmapped); shapes/spacers/icons decorative. Unknown blocks of these libraries keep their text and inner blocks and are reported with the library name. Not mapped: Otter, Stackable v2 (`ugb/`), Kadence advanced form (stored in a `kadence_form` post). Not yet run on a real site.
- Classic editor content: HTML → Portable Text; embedded shortcodes go through the shortcode parser.
- Prose-only pages and all posts stay Portable Text (no sections needed).

---

## 7b. Bricks adapter (Bricks 2.4.6 stable + 2.5 beta, built from the theme source 2026-11-19)
`src/adapters/bricks/` (`index.ts` tree/rows/styling, `elements.ts` handlers, `site.ts` options/templates, `forms.ts`), `src/extract/bricks.ts` (options, media refs). Verified facts, settings keys and 2.4.6 → 2.5 differences: `docs/spikes/bricks-findings.md`. Bricks keeps a page in post meta `_bricks_page_content_2` (a flat element list: `id`, `name`, `parent`, `children`, `settings`; component instances add `cid` + `properties`), so detection reads the meta (`_bricks_editor_mode` ≠ `wordpress`), not post_content. Elements → tree → rows (a top-level `section`/`container`; a row-direction or multi-track grid container's structural children are the columns; nested rows become sub-rows) → the shared section recognisers.
- **Styling:** element settings merged with their global classes (`_cssGlobalClasses` → `bricks_global_classes`, element wins); colours resolved through the palette (`bricks_color_palette`, `var(--bricks-color-<id>)`) and global variables (`bricks_global_variables`); `_background` colour/image/video/fixed (parallax), `_gradient` (background/overlay), `_padding` per breakpoint (desktop → phone as a fluid `pad`, tablet when off the line; theme-style section padding as fallback), `_typography` colour (tone) and text-align, `_heightMin`/`_height` 100vh (+ `_justifyContent` → valign), full-width inner container, `_columnGap: 0`, column `_width` % and `_gridTemplateColumns` fractions; cards in a grid keep its tracks per row. Breakpoint suffixes (`:mobile_portrait`) follow Bricks' cascade, desktop-first or a mobile-first base. Elements hidden on desktop (`_display: none`) are reported, not migrated.
- **Mapped:** section/container/block/div, heading (+ link), text-basic, text, text-link, button (style/outline/size, internal links → migrated paths, popups via "show popup" interactions), alert, animated-typing (first phrase), list, icon, icon-box → feature, image (+ link, custom caption), image-gallery, carousel (media) → gallery, video (YouTube, Vimeo, media, file, poster), svg (file/icon set), file → download link, accordion (`accordions`) and accordion-nested → FAQ, tabs and tabs-nested, slider and slider-nested → carousel gallery (pictures only) or cards, testimonials, team-members, pricing-tables (both tabs), counter (+ the short text after it as label) and progress-bar → stats, social-icons → links, map (Google) and map-leaflet (OpenStreetMap) → map, form → form section + definition (`ir/forms/bricks-<post>-<element>.json`, read by scaffold; recipients never copied), form shortcodes in shortcode/text elements → that plugin's form, html/code/shortcode → embed or legacy_html (code with "Execute code": real PHP vs the static HTML/CSS/JS it outputs named in the diagnostic, still blocked; known widget markup such as Mariana Tek mount points → embed), post-title → the page title, post-content and a text that is only `{post_content}` → the page's own post_content through the Gutenberg adapter (blocks, classic, shortcodes → form sections) in place, logo → picture linking home (header/footer partial), NextBricks blade-title / next_blur_reveal / swap-hover / underlined-hover → text or text link, ripple_button_v2/v3 / neumorphicbutton → buttons, imagereveal → image, spotlight → its content (each with a `lossy` note naming the effect; swap/hover labels named in a warning), BricksExtras xfluentform → Fluent Forms form section, template (section templates inlined; self-embedding guarded), components (`bricks_components`, property values applied, slots filled), `{post_title}`/`{site_title}`/`{current_date:Y}` filled.
- **Site parts:** the site-wide header and footer templates (`_bricks_template_type`, condition "entire website", else front page; elements in `_bricks_page_header_2` / `_bricks_page_footer_2`) → `ir/partials/<slug>.json` (roles header/footer); other header/footer templates are listed in the coverage report with their conditions; popup templates → `ir/popups/bricks-<slug>.json`. Palette, theme-style colours and typography → `reports/transform/bricks-design.json` (no IR field yet).
- **Reported, not migrated:** orphan elements (parent missing: Bricks never renders them), site chrome (nav-menu, nav-nested, dropdown, offcanvas, toggle, search, breadcrumbs, post-* …) and query filters as `dynamic` info; query loops (`hasLoop`), the posts element and post carousels as `dynamic` errors when the site has entries (a posts-listing section is not in the v1 library); other dynamic data tags as a warning with the text kept; decorative divider/lottie/inline SVG as `dropped-decorative`; anything else as `unmapped` (error when it carries content).
- **Extract hookup (done 2026-11-19):** extract adds `bricksMediaRefs` for `_bricks_page_content_2` / `_page_header_2` / `_page_footer_2` to raw/refs.json and the Bricks options note when a site uses Bricks. Still to confirm on a real site: the exporter must return page/post meta `_bricks_page_content_2`, `_bricks_editor_mode`, `_bricks_page_settings` and, for `bricks_template` (already in EXTRA_TYPES), `_bricks_template_type`, `_bricks_template_settings`, `_bricks_page_header_2`, `_bricks_page_footer_2` (unserialized). The Bricks options are not on REST: `readBricksOptions` takes them from options.json if the exporter adds them, else from `raw/bricks-options.json` (WP-CLI command in `BRICKS_OPTIONS_WP_CLI`; `bricksOptionsNote` is the extract note); `bricksMediaRefs` adds the element images to raw/refs.json.
- **First real site (2026-11-19, Bricks 2.x + NextBricks 3.0.1 + BricksExtras + Automatic.css + Fluent Forms):** exporter returns the meta unserialized; legal pages are Gutenberg content shown via `{post_content}`; booking pages are Mariana Tek mount points in code elements (loader from Header Footer Code Manager; transform adds `<tenant>.marianaiframes.com` scripts, tenant from markup → `embeds.marianatekTenant` → live HTML). Transform after the fixes: every gate passes except text conservation, held back by (a) hover-only labels of ripple buttons / swap titles (reported `lossy`), (b) a site-wide Announcer plugin bar (post type `announcer`, not in the extract) and (c) the waiver text inside the Fluent form's `custom_html` field (the forms package does not render custom_html yet).
- **Header menus and footer links (verify on the first site, 2026-11-20):** Bricks has no menu locations, so transform reads the site header template (`src/adapters/bricks/menus.ts`): the menu the live header printed (`<ul id="menu-<slug>">` in the audit HTML; a stale nav-menu `menu` id is common) else the first `nav-menu` whose id is a site menu becomes the **primary** menu; a header with `nav-nested` gets a primary menu of its own text-link/dropdown links; the header template's buttons (button, ripple…; not plain links) become the **secondary** menu, items marked `button` with their hover label (EmDash menu item `cssClasses: "button"`, `titleAttr` = hover label; load and seed write both). The starter draws them as header buttons with the label swap and repeats them in the burger panel when the source panel shows them after the menu (`panelExtras.buttons`). In content and footers, a nav-menu whose menu is known keeps its links as text links; an `icon` with a link becomes a link named after the icon (Instagram, TikTok…); a heading carrying links stays in the text (the heading field is plain text); a linked block/div/container (`tag: a`, contact cards with tel:/mailto:/map links) gives its text the link. Verify pairs Bricks sections with the live page by top-level index (`sourceRef.row`; live boxes: `#brx-content > .brxe-*`, `#brx-footer > .brxe-*`).
- **Visual parity (first site, 2026-11-20):** the audit captures the live site's design variables (`snapshot/css-variables.json`, framework tokens such as Automatic.css) and every rendered Bricks element's box by position (`screens.json` → `bricks`); lengths evaluate `calc`/`clamp`/`var` at each screen width. Rules: top-level blocks are styled rows; a centred flex stack with a sized picture is one column (picture width/height/position, item gap, rows of text links as a link list drawn in a row, social links as round icons, text sizes); hero overlay box, minimum height, content width, heading sizes, gaps; light buttons and minimum widths; `_hideElementFrontend` elements reported, not migrated; measured section padding applies to Bricks rows; theme-style body weight token. Details: `docs/spikes/bricks-findings.md` → "Visual parity".
- **Still open:** the meta shape the exporter returns, which settings that site uses, spacing measured against the live site (as for Salient; measured padding is not applied to Bricks rows yet), global classes/theme styles in the audit's design capture, conditional (page-specific) headers/footers, and Bricks' own popups' trigger settings.

## 7g. Divi adapter (Divi 4 shortcodes; Divi 5 best effort; built 2026-11-21, not yet run on a real Divi site)
`src/adapters/divi/` (`index.ts` sections/rows/styling, `elements.ts` module handlers, `forms.ts` contact form, `site.ts` detection/encodings/theme options/Theme Builder, `divi5.ts` block reader), `src/extract/divi.ts`. Facts and open questions: `docs/spikes/divi-findings.md`. Divi 4 keeps a page in post_content as `[et_pb_section][et_pb_row][et_pb_column type="1_2"][et_pb_*]…` (meta `_et_pb_use_builder` = `on`), parsed with the WPBakery shortcode parser; detection runs before WPBakery and Gutenberg (Divi 5 is `<!-- wp:divi/… -->`).
- **Rows:** a regular section's rows are rows (section styling under the row's own); a specialty section (`specialty="on"`) is one row whose columns hold inner rows (sub-rows); a fullwidth section's modules are full-width rows, and a fullwidth header or a one-slide slider lends its background to its row (the first one becomes the hero). Styling: background colour (global colours `gcid-…` resolved from `et_global_data`), gradient (stops or start/end), image, parallax, MP4 video, `custom_padding`, CSS id, full width (`fullwidth`, `make_fullwidth`, 100% width), `header_fullscreen`, light text (`background_layout="dark"`). Hidden on desktop (`disabled_on` …|on) and disabled modules are reported, not migrated.
- **Mapped:** text, heading, post title, button, CTA, image / fullwidth image, gallery (grid; fullwidth → carousel), video, video slider, slider / fullwidth slider (one slide → its content; several → cards), fullwidth header, icon, blurb → feature, testimonial, team member, pricing tables (excluded features kept with "(not included)"), accordion, toggle, tabs, number / circle / bar counters → stats, contact form → form section + definition (`ir/forms/divi-<post>-<n>.json`; recipient, redirect and custom body become warnings, never copied), code / fullwidth code → the provider registry (embed) or legacy_html (never executed), map / fullwidth map (+ pins listed), social follow → links, menu (header: the site's primary menu; elsewhere text links), other plugins' shortcodes (forms) through the shared handlers. Dynamic content (`@ET-DC@…@`) filled for post title, site title and the current year, else reported.
- **Site parts:** the Theme Builder's default website template (`et_template` with `_et_default`, else one used on the home page) → its header and footer layouts (`et_header_layout` / `et_footer_layout`) become `ir/partials/<slug>.json`; the header layout's menu module names the primary menu and its buttons the secondary menu; body layouts and templates for other conditions are listed in the coverage report. `reports/transform/divi-design.json` holds the theme options (accent, text, heading and link colours, fonts, content width) and global colours for comparison with the design capture.
- **Reported, not migrated:** blog/portfolio/post-slider modules (listings), search, login, sidebar, comments, post navigation, countdown, post content, shop/WooCommerce modules (`dynamic`); email opt-in, audio and third-party Divi modules (unmapped, gate-blocking when they carry content); global modules use the copy saved in each page (info).
- **Divi 5:** blocks are converted to the Divi 4 tree (desktop values of `innerContent`, button/image objects, `module.decoration.background`, `module.advanced.htmlAttributes.id`) and flagged with a coverage warning; unverified on a real Divi 5 export.
- **Extract:** `et_template`, `et_header_layout`, `et_body_layout`, `et_footer_layout`, `et_theme_builder`, `et_pb_layout` are requested; options `et_divi` and `et_global_data` come from the exporter's options.json or `raw/divi-options.json` (WP-CLI command in `src/extract/divi.ts`); `gallery_ids` count as media references.

## 7h. DOM-fallback adapter (any other builder or theme; built 2026-11-21, not yet run on a real site)
`src/adapters/dom-fallback/` (`detect.ts` when a page goes to it, `index.ts` rendered HTML → rows → fragments → the shared recognisers). Facts and limits: `docs/spikes/dom-fallback-findings.md`. The universal safety net: no site stops at transform because its builder has no adapter.
- **When:** only pages `detectBuilder` calls `classic` or `empty` (an adapter's pages are never touched), when post meta names a builder without an adapter (Beaver Builder `_fl_builder_enabled`, Oxygen `ct_builder_*`, Breakdance, Brizy, Thrive `tcb_editor_enabled`, SiteOrigin `panels_data`, Visual Composer, Zion, Cornerstone, Themify, Live Composer, Avada `fusion_builder_status`, Enfold), post_content holds a builder's shortcode family (`[fusion_…]`, `[av_…]`, `[ux_…]`, `[cs_…]`, `[mk_…]`, `[us_…]`…) or its rendered markup, post_content is mostly shortcodes no handler knows, or (empty post_content) the live page's body classes name a renderer or its main area shows ≥ 15 words. Never the posts page, the shop page or a password-protected page. Without a saved page the classic/empty handling stays and a blocking diagnostic asks for an audit of that page.
- **Main area:** the theme chrome is removed (the text-conservation chrome list plus footers, sidebars, consent banners, popups, title bars, breadcrumbs, comments, site `<header>`/`<footer>`/`<nav>` outside the content), then the first content root with text: builder roots (`.fl-builder-content-<id>`, `#tve_editor`, `#pl-<id>`, `.brz-root__container`, `.ct-inner-content`, `.post-content`), then `.entry-content`, `main`, `#content`, `body`. Scripts, styles and event handlers are stripped before anything is kept (legacy_html is sanitised); known widget scripts (provider registry) are kept with their mount element as embeds.
- **Rows and columns:** each top-level structural box is a row (single-child wrappers are stepped through and lend their background); loose headings and paragraphs are grouped and split at the top heading level (consecutive headings stay together); 2–6 sibling boxes with column classes (`col-*`, `fl-col`, `fusion-layout-column`, `panel-grid-cell`, `tcb-flex-col`…), inline widths or a flex/grid/row parent are columns (width from the inline % or the class fraction); deeper groups are sub-rows. Section ids are kept as anchors when a link points at them.
- **Mapped:** headings, paragraphs, lists, quotes → rich text; images (lazy `data-*` attributes and srcset read; `wp-image-N`, `data-id` or the upload URL → media library id), linked images; button-styled links (outline/ghost → secondary); iframes through the embed registry (YouTube/Vimeo → video, Google Maps → map, providers → embed); `<video>` (a muted autoplay loop → the row's background video); forms: a plugin's form by id (CF7, Gravity, WPForms, Ninja, Formidable, Forminator, WS Form, Fluent), builder/theme forms → a definition rebuilt from the HTML (`ir/forms/html-<post>-<n>.json`, as formFromSnapshot does), the search form left out; accordions (`details`/`summary`, `aria-controls` pairs, title/content pairs in an accordion box), tabs (`role=tab` / `.nav-tabs` + panes), testimonial boxes, galleries and image-only sliders (clones removed) only when the markup says so; post listings → `dynamic` (none) or unmapped. Backgrounds: inline colour, gradient, image (also `--…-background-*` variables and lazy background attributes, empty background layers), light text from an inline colour or `dark`/`text-light` classes, `min-height: 100vh`.
- **Not mapped:** tables, unknown iframes, objects, audio → sanitised legacy_html (gate-blocking until approved); elements hidden on desktop (builder visibility classes, `display:none`) → reported, not migrated; dividers, icons, inline SVG, empty boxes → counted in one info note; a link around a whole box → its text kept, the link reported. Styling from stylesheets, spacing and fonts are not read (the starter's defaults apply); audit section boxes are not applied (they are paired by builder row).
- **Review gate:** every page carries a `flagged` warning ("rebuilt from rendered HTML; check visually"); transform gate `dom-fallback-reviewed` fails until `overrides.ts domFallbackReviewed: { "<slug>": "<who checked it, when>" }` records the owner's review (the warning then drops to info). Coverage report section "Rebuilt from rendered HTML" lists page, builder, evidence, sections, legacy_html count, review.

## 7c. Sharing cards (on by default; `og: { cards: false }` turns them off)
`packages/og` (`@wp2emdash/og`). A 1200×630 card per page — logo, page title (site-name suffix removed), optional line above it, domain, site colours and fonts — rendered in the Worker with Satori + resvg (WebAssembly imported at build time), stored in R2 under `og-cards/` and served immutable. Links are HMAC-signed (secret in the plugin's KV), so the public card route renders only what the site issued. EmDash `page:metadata` hook sets og:image, size, type, alt and the Twitter image (plugin tags win over EmDash's); mode "missing" keeps a page's own image, "always" replaces it. Admin page: Plugins → Sharing images. Scaffold: TTF fonts into `public/fonts/og-*.ttf`, colours from tokens, logo from `public/brand`, renderer packages pinned in the site's package.json, `site.config.json → ogCards` (the layout then leaves og:image tags to the plugin). Pilot: on, every page (2026-11-19). Measurements in `docs/spikes/M7-findings.md`.

## 7d. SEO panel in the page editor (on by default; `seo: { panel: false }` turns it off)
`packages/seo` (`@wp2emdash/seo`). EmDash native plugin with an `editorPanels` entry on pages (Block Kit in the editor sidebar). Analysis is a pure module (`analyze.ts`): Google preview (title as the layout renders it, address, description, cut-off warnings), checks with good/improve/fix and a 0–100 score, focus keyword per page (plugin KV). Capabilities: `content:read`, `media:read`, `admin.editor-draft:read`; route permission `content:read_drafts`. Plus the **SEO dashboard** (admin page and widget, permission `content:edit_any`): overview with average score, score chart and issue counts; every page with an editor link; images without alt text with a form that writes alt to the media library (`media:metadata:write`); site checks (robots.txt, sitemap coverage, home page indexability, canonical host, JSON-LD), environment-aware. Plus **Google Search Console** (service account key in an encrypted plugin setting; JWT RS256 signed in the Worker; Search Analytics, Sitemaps list/submit, URL Inspection; 6-hour KV cache) and **IndexNow** (`content:afterPublish` hook and a notify-all button; key derived from the production host, file in `public/`; active only with `production.live`). Pilot: on (2026-11-19); Search Console waits for the owner's service account.

**Analytics in the suite (0.2.0, 2026-11-20; "SEO & Analytics").** Tracking codes managed by ID in the dashboard's
Analytics tab (admins only): GA4, Google tag, Google Ads, Tag Manager, Meta Pixel, Microsoft Clarity, Hotjar, Cloudflare
Web Analytics; strict per-service ID formats, no code fields; retired UA- listed, never loaded. Prefill at scaffold from
the audit's raw HTML (`snapshot/html`) plus a read-only Cloudflare `rum/site_info/list` lookup (site tag; a
zone-injected beacon is not loaded twice). Settings live in the plugin's KV (D1 `options` row
`plugin:site-seo:analytics`), read by the starter once per uncached render; saving purges `wp2emdash:analytics` +
`emdash:settings`. Middleware CSP from one host table (`analytics/csp.ts`). Conversion events (form sent, contact,
booking, outbound) and consent mode are switches; the loader (`public/scripts/site-analytics.js`) maps them per
service. Visits: Cloudflare GraphQL `rumPageloadEventsAdaptiveGroups` (Visits tab, admin widget, per-page views in the
editor panel), Worker secret `CF_ANALYTICS_TOKEN`. Opt-out: `seo: { panel: false }` (whole suite; the site loads exactly
`analytics`), `analytics: false` (no trackers at all). Verify's `analytics-runtime` expects each live service's
loader request (gtag.js, gtm.js, fbevents.js, clarity.ms tag, hotjar script). Facts: docs/spikes/analytics-findings.md.

## 7e. Site health & monthly report (on by default; `health: false` turns it off)
`packages/health` (`@wp2emdash/health`, 0.1, experimental; a PixelKraft plugin). EmDash native plugin, admins
only: **Plugins → Site health** (Block Kit tabs Overview / Incidents / Broken links / Speed / Reports / Settings) and a
dashboard widget. Checks run from **EmDash's plugin cron** (task `tick`, `*/5 * * * *`, scheduled in
`plugin:install`/`plugin:activate` and re-checked when the page opens), which the Worker's existing `*/5` trigger
drives through `runScheduledTasks` — no change to `src/worker.ts`. One tick = the light jobs that are due (uptime every
tick, forms 15 min, robots/sitemap and analytics hourly) + at most one heavy job (links daily from 02–04 UTC and
resumable, 12 requests a tick; report on the 1st from 08 UTC; mail DNS 05, certificate 06, CrUX 07). Requests to the
site go through the `SELF` service binding (scaffold adds it whenever health or SEO is on); everything else goes only
to cloudflare-dns.com (DoH), api.cloudflare.com, chromeuxreport.googleapis.com, pagespeedonline.googleapis.com (weekly lab score) and — the weekly sampled external link
check, `health.externalLinks: false` to stop it — HEAD requests to hosts the site links to. State in plugin KV
(D1 options): current checks, today's probes, 90 daily rows, 100 incidents / 90 days, link ledger 400 days, 12
reports. Alerts and the monthly report use the forms package's email path (provider API, or `ctx.email` for
`EMAIL_PROVIDER=emdash`), one email per issue per day, at most six alerts a day, only when `production.live` (baked at
scaffold, like IndexNow), alerts/report switchable in Settings, never on staging. Recipients: `health.alertsTo`
(default `email.stagingTo`), `health.reportTo` (default `email.to`) + the alert recipients; footer `health.brand`
("Prepared by <agency>", empty by default). Branding: og colours from the tokens, the copied raster logo. Optional Worker secrets:
`CRUX_API_KEY`, `PAGESPEED_API_KEY` (weekly PageSpeed lab score; falls back to `CRUX_API_KEY`), `CF_ZONE_READ_TOKEN` (dashboard Secrets/Environment list them as optional); visits in the report use
`CF_ANALYTICS_TOKEN`. Verify: `health-plugin` (heartbeat route, or the `status` route with an admin-scoped token;
live sites must have run within 30 minutes). Weekly **visual check** (0.6): structural fingerprints of the home page and up to 10 main pages (`health.visualPages`) compared with a baseline — broken pictures, stylesheets, fonts, errors, empty pages, lost sections, changed headings — with an alert, a "What to improve" item and Accept-as-baseline; no screenshots (Browser Rendering not added). Facts and limits: docs/spikes/health-findings.md. Since 2026-11-20 a
ninth check, **Backups**, reads the backups plugin's heartbeat hourly (through `SELF`).

## 7f. Backups & Restore (on by default; `backups: false` turns it off)
`packages/backups` (`@wp2emdash/backups`, 0.1, experimental; a PixelKraft plugin). EmDash native plugin, admins
only: **Plugins → Backups** (tabs Backups / Restore / Full site / Settings). Plugin cron task `nightly`, hourly at a
minute fixed per site; due once a day from 01–03 UTC (`backups.hourUtc`), retried hourly up to 4 attempts. A backup is
a read-only D1 dump through the Worker's `DB` binding (allowlisted tables + `ec_*`, options filtered to `site:*` and
the site identity keys — EmDash's own backup rule) plus an R2 media manifest, gzip JSON at
`backups/<yyyy-mm-dd>/<hhmmss>-<trigger>-<rand>.json.gz` in the site's `MEDIA` bucket (EmDash's media route refuses
`backups/`). Retention 30 daily + 12 monthly (first full backup of the month). Restore of settings / menus / one entry
in the browser: plan (read current state from D1, diff, fingerprint) → confirm → fresh backup → fingerprint re-check
→ writes through EmDash's REST API as the confirming admin via `SELF` (EmDash validates, keeps revisions, purges
caches). Whole site: D1 Time Travel by timestamp (CLI), never a browser button. Pre-change safety: `content:beforeDelete`
snapshot of the entry; `load --force` and `golive` record a D1 bookmark + `backups/markers/` object (R2 object API,
token A). Alerts after 2 failed nightly attempts in a row (forms email path, live only, never staging). Off-site copy:
SigV4 PUT to an S3-compatible bucket, keys as Worker secrets, no deletes. Public routes: `download` (one-time token)
and `heartbeat`. Verify: `backups-plugin` (live: a backup within 36 h). Facts: docs/spikes/backup-findings.md.

## 7f. Media Assistant (on by default; `media: false` turns it off)
`packages/media` (`@wp2emdash/media`, 0.1, experimental; a PixelKraft plugin). EmDash native plugin, **Plugins → Media**
for editors and admins (route permission `content:edit_any`; Settings and the AI licence admins only). Capabilities
`media:read`, `media:bytes:read`, `media:metadata:write` only. Report = read-only D1 scan (`DB`) of the library and
every table that can name a file (EmDash's media usage index is content-only and has no plugin API); cached 10 min,
rescanned daily by the cron task `hourly` (minute fixed per site), counts kept in plugin KV `summary` for Site health's
**Media** check (hourly, one D1 read, no alerts). File changes through EmDash's REST API as the confirming person via
`SELF` (replace original, folders, delete), each preview → one-time plan → confirm: Optimize (Images binding,
same type, quality 82, old file in `backups/media-originals/` 30 days, focal point restored, `emdash:media` purge),
trash (folder "Trash (Media Assistant)", 30-day undo, deletion only by an editor after 30 days with a last copy kept).
Alt text: suggestions (Workers AI `@cf/meta/llama-3.2-11b-vision-instruct` when `media.aiAlt` — default
`!sensitiveData`, adds the `AI` binding — else file name / heading), saved only when reviewed. Upload queue via
`media:afterUpload` (default off); processed by a click or hourly with `MEDIA_API_TOKEN`. Verify: nothing new. Client
guide `docs/media.md`. Facts: docs/spikes/media-findings.md.

## 7f. Change requests (on by default; `changeRequests: false` turns it off)
`packages/change-requests` (`@wp2emdash/change-requests`, 0.1, experimental; a PixelKraft plugin). EmDash native
plugin, **Plugins → Change requests** for editors and admins (routes `content:edit_any`), dashboard widget, editor
panel on pages (posts too on blog sites). Capabilities `content:read`, `email:send`. Requests in plugin KV (`req:<id>`,
compare-and-set), attachments (3 × 5 MB, PNG/JPEG/GIF/WebP/PDF by magic bytes) in `MEDIA` under
`backups/change-requests/` (never served by EmDash's media route), one-time download tokens (5 min) through a public
raw route. The upload page is the only React part (descriptor `adminEntry`, page `/attach`; Block Kit has no file
input; `admin.entry` deliberately unset so the panel stays). Agency = admins (optionally narrowed by
`agencyDomains`); requester may withdraw / mark done / reopen within 30 days; other editors comment. Email through the
forms delivery path (never from staging); optional webhook signed with `CHANGE_REQUESTS_WEBHOOK_SECRET`. Daily task
deletes closed requests after `retentionMonths` (12). Backups allowlist: `plugin:change-requests:req:*` rows only.
Site health: nothing new. Verify: nothing new. Client guide `docs/change-requests.md`. Facts:
docs/spikes/change-requests-findings.md.

## 7f. Privacy & consent (on by default; `consent: false` turns it off)
`packages/consent` (`@wp2emdash/consent`, 0.1, experimental; a PixelKraft plugin). Built-in banner in the starter
(`components/Consent.astro`, `public/scripts/site-consent.js`, before SiteWidgets and Analytics in `<head>`), no inline
script. Modes off / notice / opt-in / **auto (default)**: opt-in for EU/EEA/UK/CH/Québec and unknown, notice elsewhere,
from `GET /_consent/region` answered by the middleware from `request.cf` (never route-cached, `no-store`). Pages stay
identical for every visitor; the choice is kept in the browser (localStorage + `site_consent` cookie: version,
revision, flags, time; 180 days). Categories: analytics (GA4/Google tag/GTM, Clarity, Hotjar), marketing (Google Ads,
Meta Pixel), preferences (chat, reviews widgets); Cloudflare Web Analytics cookieless, always on. The analytics loader
with `banner: true`: Consent Mode v2 default denied first, Google loaded only once allowed (basic mode), Meta
`grant`/`revoke`, Clarity `consentv2`; GPC → marketing off. Admin page **Privacy & consent** (Block Kit, admins only):
mode, position, wording (plain text, limits), policy page picker, category descriptions, service table, footer link,
preview (`?consent-preview=1`), "Ask every visitor again" (revision), optional consent log (public POST route, counts
per day only, 90 days). Saving purges the cached pages (SEO suite mechanism). Migration: transform writes
`ir/consent.json` (old consent plugin/service from the audit HTML + carried site widgets → mode and wording; coverage
report "Consent banner"); a kept consent service → mode off. Verify: `consent-runtime` (live; Playwright: nothing
before consent, trackers after Accept all) and the existing axe pass. Facts and limits: docs/spikes/consent-findings.md.

## 7f. Motion (the panel on by default; `motionPanel: false` removes it)
`packages/motion` (`@wp2emdash/motion`, 0.1, experimental; a PixelKraft plugin). EmDash native plugin, **Plugins →
Motion** (Block Kit, admins only, route permission `plugins:manage`). Settings in plugin KV (`plugin:motion:settings`),
read by the site with the chrome in the page frontmatter (`starter/src/utils/motion.ts` via `utils/chrome.ts`, one
primary-key row, only when `site.config.json motionPanel`). Options, all new ones **off by default**: first-visit
logo preloader (sync head script decides before paint: once per session via sessionStorage, never for bots /
prerender / hidden tabs / reduced motion; CSS animation and script both cap it at 1.2 s; fixed, pointer-events none,
`hidden` without the stylesheet; background from tokens; minimum 0–800 ms), page transitions (cross-document View
Transitions: `@view-transition` opt-in written into the head only when on, inside a no-preference media query;
fade / slide-up; 150–600 ms), element entrances (as built = kit.config `motion` / off / calm / standard), hover lift,
smooth anchor scrolling, image fade-in (lazy images still loading), parallax/drift (as built / off), scroll progress
bar (scroll-driven animation, no script). Rendered as `data-motion-*` attributes and `motion-calm` on `<html>`, plus at
most `public/styles/site-motion.css` and `public/scripts/site-motion.js`, each only when needed; with everything off
the page is byte-identical (compiled template checked, docs/spikes/motion-findings.md). Speed note in the panel from
the files' real sizes (test-enforced budget). Preview: "Preview only" returns `/?motion-preview=<code>` (strictly
parsed; honoured for signed-in editors only; middleware never caches it). Save purges the cached pages
(`purgePages`). Verify: nothing new (Playwright runs with `navigator.webdriver`, so the preloader never shows in
captures). Client guide: editor guide "Motion". Facts: docs/spikes/motion-findings.md.

## 8. Everything else a migration touches

| Area | Plan |
|---|---|
| **Routing** | Root paths via `src/pages/[...slug].astro` resolving nested page paths (`/services/physical-therapy/`); keep source trailing-slash policy; posts keep their permalink structure (configurable pattern); category/tag/author archives only if they were indexable. |
| **Redirects** | Generated from the URL map + imported plugin redirects + synthetic WP URLs (`?p=`, `?page_id=`, attachment pages → parent/media, `/feed/` → new feed or home, `wp-content/uploads/...` → R2 URLs). Single hop, 301, tested. Implementation (middleware vs Workers redirect rules vs Cloudflare Bulk Redirects) chosen in M0. |
| **Media** | Originals into R2 via importer (SHA-1 dedup); responsive sizes generated by the frontend (Cloudflare Images/transform or Astro image), not copied from WP's `-WxH` files; alt text preserved, missing alts listed; SVG sanitised; favicon/app icons/OG default image migrated. |
| **Design** | Tokens from computed styles + theme options; fonts self-hosted where licence allows (Adobe Fonts kept as kit embed); icon fonts → SVG; Salient animations reduced to a small motion set (fade/slide on enter, parallax off by default) with `prefers-reduced-motion`. |
| **Header/footer/menus** | Menus via importer (exporter 1.2.0+) rendered with `getMenu()`; mobile menu rebuilt accessible (focus trap, Esc, aria-expanded); social links → site settings. **Every** WordPress menu becomes an EmDash menu (header roles by name, the rest by their own name), all levels, targets, the item's classes and title attribute (REST `wp/v2/menu-items` when the application password allows); descriptions reported; mega menus → columns of links in the panel (partial, reported). Classic widget areas (`wp/v2/sidebars` + `wp/v2/widgets`, or a dump's `sidebars_widgets`) → EmDash widget areas (`src/transform/widgets.ts`): content / menu / core component widgets, unknown ones gated (`widgets-handled`, `overrides.ts widgets`); rendered where the old theme showed them (footer columns, blog sidebar). Visible breadcrumbs when the old site showed them; the old 404 page's own wording as the site part `not-found`. Details: [site-features findings](spikes/site-features-findings.md). |
| **Announcement bar** | Plugin bars (Announcer, WPFront…) live in post types REST does not expose, so transform rebuilds the bar from the audit's saved page HTML (`src/transform/announcement.ts`, markup in `docs/spikes/announcement-findings.md`): known plugin/theme bar on ≥ half the saved pages → `ir/partials/announcement.json` (site part slug `announcement`, block `section_announcement`); class-name matches, bars on fewer pages and script-injected bars (Hello Bar, OptinMonster) are listed in the coverage report with their text for the operator. Its text counts in text conservation (transform and verify). Starter: rendered on the server above the header in `Base.astro` as a labelled region; a pre-paint inline script hides a closed message version (localStorage) or one outside its schedule and sets `--announce-h`, which offsets the fixed header and the page (no layout shift); close button, `prefers-reduced-motion`, text colour raised to WCAG AA (also at transform, reported). |
| **Forms** | Per form, choose: keep third-party embed, or rebuild as `form` section posting to a Worker endpoint with Turnstile, server-side validation, rate limit, email delivery and optional D1 storage. **Email providers** (pluggable, HTTP APIs, chosen per site): **Brevo (default)**, Resend, SendGrid, Postmark, Mailgun, Amazon SES, Google Workspace (Gmail API with a service account and domain-wide delegation), Microsoft 365 (Graph `sendMail`), Cloudflare Email Routing `send_email` (verified recipients only). Raw SMTP is not used from Workers. **Health/PHI data never goes into Worker/D1/email; it stays with the approved provider.** |
| **Booking & third-party** | Keep existing providers; links/embeds tested in verify. One provider registry (`starter/src/utils/providers.ts`, kit import `src/providers/registry.ts`): per provider id → name, detection pattern, category (booking, video, map, reviews, forms, newsletter, audio, social, chat, consent, tracker), hosts for script/frame/connect (+ style/font/img/media extras) and, for site widgets, the ID format and where the ID sits in the official snippet. Adapters (embed detection), `section_embed`'s provider list, the starter's embed allowlist and the CSP all read it; `test/providers.test.ts` checks every provider's sample is detected and every URL it loads is covered by its hosts. |
| **Site-wide snippets** | `src/transform/snippets.ts`, run in transform: every `<script>/<noscript>/<iframe>/<link>/<meta>` in `<head>` or at body level of the saved pages, plus active Header Footer Code Manager snippets (`raw/code-snippets.json`), deduplicated → `ir/site-snippets.json` and the coverage report. Kinds: tracker (SEO & Analytics), verification (Settings → SEO), page-meta (starter/SEO plugin), provider-loader (with the embed sections; a section without its own loader gets the site-wide src-only script), widget (site widget by provider + ID: `siteWidgets` in kit.config / site.config.json, `components/SiteWidgets.astro` + `public/scripts/site-widgets.js`, CSP from the registry, production only), wordpress (not needed, listed), unknown (never auto-carried). Gate check `site-snippets` fails while any item needs a decision; decisions live in `overrides.ts` → `snippets`. |
| **SEO** | Yoast/Rank Math fields via exporter; JSON-LD regenerated (Organization/LocalBusiness/MedicalBusiness, BreadcrumbList, FAQPage from `faq`, Article for posts); sitemap + robots generated; OG images; hreflang alternates on multilingual sites (§8b). |
| **Analytics & consent** | GA4/GTM/pixels carried over once; header/footer scripts from theme options reviewed one by one; consent banner if the source had one or jurisdiction requires it. |
| **Blog** | Posts, categories, tags, authors/bylines, featured images, pagination, RSS feed (built 2026-11-20). Comments: imported since 2026-11-21 (approved, threaded one level, settings per collection, starter list + form; `docs/spikes/comments-findings.md`), or left out by decision (`overrides.ts comments`). |
| **Search** | Starter search page `/search/?q=` (built 2026-11-21): EmDash FTS5 over posts, collections and page titles plus a scan of the pages' section text (EmDash 1.5 refuses a searchable blocks field); WordPress `?s=` and `/search/<terms>/` 301 there; results uncached; a header search link when the old header had one. |
| **After launch** | Site health lists EmDash's 404 log weekly with suggested redirects (Missing pages); coming-soon mode (503 holding page, admins bypass) is an admin switch, never set by the migration. |
| **i18n** | WPML and Polylang sites are migrated (built 2026-11-22): every language at its WordPress address, `lang` + `translation_group` on each entry, hreflang, language switcher, per-language menus — §8c. |
| **Accessibility** | WCAG 2.2 AA target; axe in verify; fixed issues from the source site noted as improvements, not regressions. |
| **Security** | Admin passkeys/MFA, least-privilege users, secrets only in Wrangler secrets/`.env`, app password + migration key revoked after import, staging behind Access/noindex, no backups in public storage. |
| **Editor handoff** | Generated editor guide: list of section types with screenshots, how to add/edit pages, menus, media, SEO fields; admin accounts invited, not shared — from the invite checklist the kit builds from the WordPress users (roles mapped; names and e-mails only in `sites/<slug>/users/`), by the owner in the admin or with `wp2emdash invite <slug> --send`. The go-live checklist has the owner export past form entries from WordPress before it is retired. |
| **Backups & ops** | D1 Time Travel/export schedule, R2 lifecycle, `emdash site export` before every load and before cutover; logs and alerts on the Worker. |

---

## 8a. Deliverables — what the client gets

The end result of a run is a **finished, working client project**, not a set of reports.

**Client project repo** (`sites/<slug>/project/`, its own git repo, ready to push to GitHub):
- A working EmDash + Astro site deployed to Cloudflare (staging + production): all content, media, menus, SEO, redirects, forms, booking and integrations working and verified.
- `README.md`: what the site is, stack, quick start, environments, deploy, where content lives.
- `docs/`
  - `editor-guide.md` — for the client: logging in, editing pages, every section type with a screenshot, media, menus, SEO fields, publishing/scheduling, preview.
  - `architecture.md` — Worker/D1/R2/bindings diagram, content model, section library, routing, caching.
  - `deployment.md` — exact commands (confirmed against `package.json`), secrets, environments, CI.
  - `operations.md` — backups and restore, updating EmDash, monitoring, adding redirects, rotating secrets.
  - `forms-and-integrations.md` — each form's fields/destination/spam protection, booking providers, analytics, consent.
  - `seo.md` — sitemap, robots, structured data, redirect map, Search Console steps.
  - `migration-report.md` — final verify report summary, counts, accepted decisions, known differences.
  - `rollback.md` + `cutover-checklist.md`.
- `.github/`: CI workflow (typecheck, build, lint, link check, a11y smoke on PRs; deploy on main), PR template, CODEOWNERS, Dependabot/Renovate.
- `.env.example`, `.gitignore`, no secrets committed.

**Kit repo** (`wp2emdash`, GitHub-ready):
- `README.md` — what it does, badges, 5-minute quick start, pipeline diagram, supported builders matrix, example report screenshot.
- `docs/`: `getting-started.md`, `configuration.md` (every `kit.config` option), `pipeline.md` (each phase, inputs/outputs/gates), `section-library.md`, `adapters/gutenberg.md`, `adapters/wpbakery.md`, `writing-an-adapter.md`, `element-handlers.md`, `verify-checks.md`, `cutover-and-rollback.md`, `security-and-privacy.md`, `troubleshooting.md`, `faq.md`, `claude-code.md` (skills and workflow).
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `CHANGELOG.md` (Keep a Changelog + semver), `LICENSE` (MIT, §14), issue/PR templates, CI (lint, typecheck, vitest with fixtures/golden IR, e2e against a sample WP site).
- `examples/` with an anonymised sample site config and its generated report.

Docs are generated from real data where possible (config schema → `configuration.md`, section `blockTypes` → `section-library.md` and the client `editor-guide.md`, verify results → `migration-report.md`) so they can't drift from the code.

---

## 8b. WooCommerce catalogue mode (owner decision; built 2026-11-22, not yet run on a real shop)

Small shops migrate with their products as pages and an external checkout; there is no cart, checkout or customer account on EmDash. Verified facts and limits: `docs/spikes/shop-findings.md`.

- **Decision first.** A WooCommerce site stops at the audit gate `shop` until the owner sets `shop: { mode: "catalogue", checkout: "external" | "stripe-payment-links" | "contact" }` in kit.config (`currency`, `contactPath`, `maxProducts` optional). The audit reads the public Store API and writes `reports/audit/shop.md`: product count and types, variations, sales, downloads, stock tracking, reviews, coupons, attributes, extensions — and what catalogue mode does with each. The transform repeats the gate with the Exporter's data (every product and variation).
- **Still out of scope:** more than `maxProducts` (default 200) products, subscriptions (type or plugin), memberships. The gate stays red whatever is set.
- **Reported, never silently dropped:** cart and checkout, customer accounts, orders/customers (never migrated), coupons, payment/tax/shipping settings, variable products (price "from" + variations table), grouped and other product types, bookings, digital downloads (the external checkout delivers them), stock levels (availability kept), scheduled sales, reviews and ratings, attribute archives, hidden products. Each is a row in the shop report and the coverage report.
- **Products collection** `products` (the CPT mapper, §8 / `cpt-findings.md`, with built-in fields): title, slug, description (body), short description, featured image, gallery, `product_type`, `price` (variable: lowest variation price), `sale_price` (only a running sale), `currency` (`shop.currency` → `woocommerce_currency` → Store API), `sku`, `stock_status`, `attributes` and `variations` (repeaters), `buy_url`, `buy_label`; product categories/tags (and brands) as taxonomies. Addresses kept exactly: `/product/<slug>/`, the listing at the shop page's address (`/shop/`), `/product-category/<slug>/`, `/product-tag/<slug>/` (verify parity as for any collection).
- **Buy button:** `external` → the entry's `buy_url` (filled in by the owner; `_product_url` + `_button_text` for external products); `stripe-payment-links` → the same field holding a Stripe Payment Link; `contact` → `<contactPath>?product=<name>` (the forms package prefills the message). A product without a link falls back to the contact page when there is one; out of stock → a disabled button.
- **WooCommerce pages:** the shop page becomes the listing; cart, checkout and my-account are not migrated and 301 to the listing with everything under them and `?add-to-cart=` (wpUrls `shop`, also judged by verify).
- **Starter:** product cards on the listings, a product page (pictures, price with sale, availability, SKU, Buy button, description, attributes, variations), Product + Offer/AggregateOffer JSON-LD through `StructuredData`, products in the collection sitemap, `/sitemap/archives.xml`, llms.txt and search.
- Not built: a `product_grid` section for product blocks/shortcodes on other pages (reported by the adapters), multi-currency, real checkout.

## 8c. Multilingual sites (WPML, Polylang; built 2026-11-22, not yet run on a real multilingual site)

Decision and evidence: `docs/spikes/multilingual-findings.md`. EmDash 1.5 has native i18n (row per locale), but its
hreflang/sitemap paths ignore the kit's path-as-slug routing, a prefixed default locale breaks its admin, and turning
it on makes every list, term and byline per-locale. The kit therefore keeps its model and adds two fields.

| Step | What happens |
|---|---|
| audit | WPML / Polylang are `migrate-data` plugins (no longer out of scope); the live pages' hreflang links are snapshotted as before. |
| extract | The EmDash Exporter's `locale` / `translation_group` per entry and probe `i18n`; Polylang's `language` / `post_translations` taxonomies; gate `languages` (every published entry has a language). `import-dump` / `import-options` add `icl_sitepress_settings`, `polylang` (secrets dropped) and WPML's `icl_translations` → `raw/multilingual.json`. |
| transform | `src/transform/multilingual.ts`: languages (code, URL directory, live hreflang value, native label), default language, URL mode (plugin options → live hreflang → audited paths). Every page, post and entry gets `i18n { lang, group }`; its route is its WordPress path (a translation the audit missed gets its language directory; the front page's translations are `/<lang>/`). Translated menus become `<role>-<lang>` (Polylang `primary___fr`, WPML menu groups, else link majority); `#pll_switcher` items are replaced by the switcher. Translated site chrome (global sections, builder templates, popups) is listed, only the default language's migrates. Gates `languages-url-mode`, `languages-assigned`, `languages-groups`, `languages-routes`; `ir/i18n.json`; coverage report → Languages. |
| scaffold / load | `lang` and `translation_group` fields on every routable collection (seed and load); `site.config.json → i18n`. |
| starter | `utils/i18n.ts` (pure, held to the kit's copy by tests): `<html lang>` and `og:locale` per language, hreflang alternates (self, each published translation, `x-default` on the default language) on the production address, `LanguageSwitcher.astro` in the header and the menu panel (translation, else the language's home), menus `primary-<lang>` with fallback, blog listings and `llms.txt` in the default language (llms.txt links the other languages' homes). EmDash's Astro `i18n` stays off. |
| verify | `languages-urls`: every published translation answers 200 at its address (audited or not); `hreflang`: the live page's alternates kept (as paths) and every pair reciprocal. The existing `urls`, `sitemap` and `urls-accounted` gates cover every language. |

Supported URL modes: a directory per non-default language with the default unprefixed, and Polylang's "language
from the content" (no language in the URL). A prefixed default language, subdomains, separate domains and `?lang=`
turn `languages-url-mode` red: the owner decides (redirects, per-host routing) before anything is loaded.

Not carried, listed in the report: string translations (WPML String Translation, Polylang strings), per-language term
links (each language's terms migrate as their own terms), per-language blog archives and feeds, language-aware
previous/next and related posts.

---

## 9. Out of scope for v1 (detected and reported, migration stops for a decision)

WooCommerce/shop beyond catalogue mode (carts and checkout on EmDash, more than `shop.maxProducts` products, subscriptions, memberships; small shops: catalogue mode by owner decision, §8b), membership/LMS/paywalls, multisite, user accounts/front-end login, custom plugins with business logic (→ later via `wordpress-plugin-to-emdash`), Bricks pages (adapter in v2, built against a real client site).

---

## 10. Claude Code integration

- **Install official EmDash skills** in the kit and every site project: `building-emdash-site`, `emdash-cli`, `creating-plugins`, `wordpress-theme-to-emdash`, `wordpress-plugin-to-emdash`. Also use EmDash's docs index (`llms.txt`) / Docs MCP for current API facts.
- **Kit skills** (in `skills/`):
  - `wp2emdash-run` — runs the pipeline phase by phase, stops at red gates, explains them.
  - `wp2emdash-map` — takes coverage-report items + source snippet + screenshot crop, proposes a handler or override, writes it to `overrides.ts` (or a new element handler + fixture test when it's generic), reruns transform.
  - `wp2emdash-visual-fix` — takes a red visual diff, adjusts tokens/section variants, reruns verify for that page.
  - `wp2emdash-cutover` — walks preflight and cutover with explicit human confirmation at each irreversible step.
- **CLAUDE.md rules:** never edit generated `ir/` or imported content by hand; never write to the WordPress site; never put secrets in prompts/logs; never change DNS/routes or production without explicit approval; always rerun the affected gate after a change.

**Status (2026-11-19):** built. Kit skills `wp2emdash-run`, `wp2emdash-map`, `wp2emdash-visual-fix` and `wp2emdash-cutover` are in `skills/` (install: README → Claude Code). They drive the kit MCP server (§10b), and every change Claude wants in `overrides.ts` / `decisions.md` goes through the approval queue. Official EmDash skills in site projects: unchanged.

Deterministic code does the bulk of the work; Claude handles the long tail (unknown elements, design tuning) and every decision ends up in versioned files, so reruns don't depend on the conversation.

---

## 10a. Operator experience — one engine, three front-ends

| Layer | What it is | Built in |
|---|---|---|
| **Engine** | Every phase is a pure command over `sites/<slug>/state.json`: resumable, idempotent, `--json` output, exit code = gate result. Works in CI. | M1 |
| **Terminal wizard** | `wp2emdash` with no args: pick/create a site, see the phase timeline (done / running / red gate / next), run the next phase with live per-step progress, answer decision prompts (keep/rebuild/drop a form, accept a diff). | M1 (shell), grows with each phase |
| **Local web dashboard** | `wp2emdash ui`: same state files, for what a terminal can't show — side-by-side screenshots and diffs, coverage review with source snippets, integrations approvals, the final report. Local only, no hosting. Paired with Claude Code — see §10b. | M7 |
| **Claude Code** | Kit skills call the CLI and read `--json`; subagents only for parallel long-tail work (one per unmapped element family, one per red visual page). Every result lands in `overrides.ts` / `decisions.md`. | M4 onward |

Progress model: phases → steps → items (e.g. `audit › screenshots › 34/120 URLs`), streamed to the terminal and appended to `sites/<slug>/runs/<id>.jsonl`, which the dashboard and the agents read.

### 10b. Local dashboard paired with Claude Code (M7)

`wp2emdash ui` serves a dashboard on `127.0.0.1` (random port, one-time token in the URL, no remote access). It drives the same engine as the CLI and streams progress from `runs/*.jsonl` (server-sent events).

**Division of work**
- **Browser — the human loop:** see progress, compare, approve, enter secrets, sign off. Everything the owner decides is written to `overrides.ts` / `decisions.md` / `ACCESS.md`, exactly as if done by hand.
- **Claude Code — the reasoning loop:** a kit MCP server (`wp2emdash mcp`) exposes typed tools: `status`, `run_phase`, `read_report`, `list_diagnostics`, `propose_override` (writes a pending change with its diff), `explain_gate`. Claude never writes `overrides.ts` directly from the dashboard flow: proposals land in an **approval queue** in the browser; approve applies the change and reruns the affected phase.
- **Secrets:** a form in the dashboard writes `.env` directly (migration key, app password, provider API keys); values are never shown again, never sent to Claude, never logged. Revocation reminders after import.

**Features (priority order)**
| # | Feature | What it does | Status |
|---|---|---|---|
| 1 | Visual diff viewer | Old vs new per page × viewport: slider, onion-skin and pixel-diff modes, masked regions; approve/reject writes `decisions.md`; menu open-state and motion timing shown next to the recipe. | Built (v1): slider, side by side, pixel diff, section table, approve/reject → `decisions.md`. Onion-skin, masked regions, menu motion next to the recipe: pending |
| 2 | Section inspector | Click a region on the source screenshot → the WordPress row/block, the IR section it became, and the rendered staging section. Change the section type or drop it → `overrides.elements`, rerun transform for that page only. | Built (v2): row boxes on the audit screenshot → raw WPBakery/Gutenberg source, IR section JSON, verify crops; type change / drop → a proposal patching `overrides.elements`, transform reruns (preview) after approval. Rerun for one page only: pending |
| 3 | Launch readiness score | One score per site from every gate (content, URLs, SEO, visual, forms, a11y, performance, security, editing); "what blocks launch" list with links to the fix. | Built (v1): gates + `verify.json` + cutover preflight; blockers with the fix command or link |
| 4 | Launch cockpit | Cutover preflight, Worker route switch (owner-confirmed), live smoke checks, one-click rollback (delete routes), post-launch timer. | Built (v2), read-only: last preflight, go-live prerequisites, runbook as text, exact commands. Route switch, rollback, smoke checks and timer stay in the terminal (owner) for now |
| 5 | Change watcher | Polls the exporter for `modified_gmt` changes during the project; shows which pages changed in WordPress and resyncs only those (cutover delta made continuous). | Pending |
| 6 | Client sign-off page | Static export of the verify report + screenshots that the client reviews and signs; signature and date recorded in `decisions.md`. | Pending |
| 7 | Post-launch monitor | 404 log → suggested redirects, form deliverability, Lighthouse and Core Web Vitals before vs after, Search Console coverage. | Pending |
| 8 | Portfolio view | Every site in `sites/` with phase, readiness score, blockers and last run. | Built (v1) |
| 9 | Run history | Every run's IR and reports kept; diff two runs; restore an earlier IR. | Pending |
| 10 | Guided owner checklist | ACCESS.md as a step-by-step guide with screenshots; automatic checks where possible (exporter installed, key valid, backup file present, DNS export parsed). | Built (v2, basic): ACCESS.md as sections with items, required markers and the Plugin data section; read-only. Screenshots, ticking from the browser and automatic checks: pending |

Built in the order above; 1–3 with M7, 4 with M8, 5–10 after the pilot launch. **v1 (2026-11-19):** `wp2emdash ui` with the portfolio (8), launch readiness (3), live run progress over SSE and the visual diff viewer (1); `127.0.0.1` only, a per-run token exchanged for an HttpOnly SameSite=Strict cookie, Host and Origin checks, files only from `reports/` and `snapshot/screens/`. Approving a visual difference appends to `decisions.md` and never accepts a gate. **v2 (2026-11-19):** approval queue in the browser (approve applies the proposal's diff via `src/core/proposals.ts`, optional preview rerun of transform/scaffold/verify streamed over SSE; never load or cutover), secrets form (allow-listed keys → `sites/<slug>/.env`, write-only, fingerprint only, format checks, CR/LF refused, mode 600), section inspector (2), read-only launch cockpit (4) and owner checklist (10, basic). Every site response is passed through `scrubSecrets`; POSTs also refuse a cross-site `Sec-Fetch-Site`. Not built yet: features 5–7, 9, and the interactive parts of 10. **v3 (2026-11-20):** feature 4 is actionable — go-live plan from `golive --json`; Go live / alias redirects / rollback behind a typed production domain + the owner's written approval (recorded in `decisions.md` and `cutover/golive.json` → `approvals` via `golive --approved-by/--approval`), run as the CLI with live progress; route/rule ids, smoke, DNS comparison and history shown. Publish panel (dry-run file list + secret scan, `publish --yes` behind the same confirmation, CI runs via gh; the token secret is never set). Environment view (single/staging, workers.dev, live date, `load --force` rule, preview URLs). Worker secrets per environment ("saved locally" / "set on Worker" by name, `wrangler secret put` on stdin; typed domain on a live production) and operator credentials (presence, token-verify status/expiry, go-live token revocation reminder). Portfolio "next" derived from gates + latest runs (previews) + `production.live`, Live badge, launch date, alias status. Every POST needs Origin + a CSRF header; long actions are single-flight per site and logged to `runs/`. Not run against a real launch yet (mocked in tests).

**MCP server and approval queue (2026-11-19):** `wp2emdash mcp` (stdio, `@modelcontextprotocol/sdk`) with `status`, `run_phase`, `read_report`, `list_diagnostics`, `explain_gate` and `propose_override`. `run_phase` refuses production targets and non-preview cutover. Results are scrubbed of every kit/site `.env` value. Proposals live in `sites/<slug>/proposals/<id>.json` (contract and apply logic: `src/core/proposals.ts`, a strict dependency-free unified-diff applier in `src/core/diff.ts`). Approval CLI: `wp2emdash proposals <slug> [approve|reject <id> --by …]`. Approving applies the patch and prints the rerun command; it never reruns by itself. Browser approval queue: pending (built against the same module).

---

## 11. Safety rules (carried over)

- WordPress stays live and restorable until production has passed smoke checks and the observation window ends.
- Full hosting backup (DB + uploads + themes/plugins + config) downloaded off-server and test-opened before anything else.
- Staging (opt-in, §7a) and production use separate D1, R2 and secrets; a preview URL shares production's data and is for code review only.
- No passwords, migration keys, tokens or patient data in prompts, Git, screenshots or logs.
- Irreversible or outward-facing steps (DNS, routes, production deploy, deleting anything) need explicit owner approval at the time.
- Cloudflare access uses two tokens (`docs/cloudflare-api-token.md`): a reusable account-scoped build & staging token without zone access, and a per-launch go-live token scoped to the client's zone, revoked after monitoring.
- Final switch only after owner sign-off on the verify report and a tested rollback.

---

## 12. Assumptions to prove in M0 (spike)

| # | Assumption | Why it matters |
|---|---|---|
| A1 | `blocks` field + `blockTypes` in seed give editors a usable admin UI for every v1 section field type (repeaters, images, links, Portable Text inside blocks). | Whole editing model depends on it. |
| A2 | Pages can be served at root paths with a catch-all route without conflicting with `/_emdash` admin/API routes. | URL parity. |
| A3 | The overlay can write `layout` blocks via CLI (`emdash content create/update --file`) or REST with a token, against remote staging. | Load phase automation. |
| A4 | Media imported by the official importer can be looked up by source URL/hash to resolve IR media refs. | Overlay needs EmDash media IDs. |
| A5 | Running official import + overlay together leaves no duplicates and is safely re-runnable. | Delta at cutover. |
| A6 | Best redirect mechanism on Workers for this stack (middleware vs Workers redirect rules vs Bulk Redirects), incl. performance. | SEO parity. |
| A7 | Exporter 1.2.0+ delivers menus, Yoast/Rank Math, site identity for a Salient site; Bot Fight Mode workaround works. | Importer coverage. |
| A8 | Route caching / cache invalidation on publish works as expected on Workers. | Editing check. Confirmed on staging 2026-11-20 (page 0.5 s, menu 0.5 s, settings 3.2 s) once the chrome cache hints moved into the page frontmatter: `docs/spikes/performance-findings.md`. |
| A9 | `emdash site export` / D1 backups give a restorable staging snapshot. | Safe reruns. |

Any failed assumption changes the plan before code depends on it.

**M0 status (2026-11-17):** A1, A3, A4, A5, A9 confirmed; A2, A6 confirmed with gaps the starter closes; A7 deferred to M3 (needs WP admin); A8 confirmed locally, re-check on Workers in M5. Details and plan changes: `docs/spikes/M0-findings.md`.

---

## 13. Milestones

| # | Milestone | Done when |
|---|---|---|
| M0 | Spike: prove §12 on a throwaway EmDash project with a small WPBakery and Gutenberg sample | Every assumption confirmed or the plan updated |
| M1 | Kit skeleton: CLI, config schema, site workspace, report generator, CLAUDE.md | `init` + empty pipeline runs and renders a report |
| M2 | Audit + snapshot | Full baseline of the pilot site captured; URL sets reconcile |
| M3 | Extract | Raw WXR/REST/options/media manifest for the pilot site; counts gate green |
| M4 | IR + WPBakery/Salient adapter + Gutenberg adapter, fixture/golden tests | Pilot coverage report: 0 unmapped content nodes |
| M5 | Starter project + section library + tokens + header/footer (menu variants from the motion recipe) | All section types editable in admin; header/menu matches the recipe; staging deploys |
| M6 | Load: media, content, menus, settings via the EmDash API; fix-ups; id-map | Load gate green locally (done) and on staging (owner-approved deploy); rerun is idempotent (verified) |
| M7 | Verify suite + dashboard (§10b features 1–3, MCP server, approval queue, secrets form) | Full report for the pilot; reds fixed or decided; every owner decision possible from the browser |
| M8 | Cutover tooling + pilot go-live | Production live, smoke green, rollback tested, monitoring running |
| M8a | Docs: client project docs generated for the pilot; kit GitHub docs complete | Both repos pass a docs review checklist; every command in docs verified by running it |
| M9 | Second site (Gutenberg-heavy) to harden the kit | Runs end-to-end with only config + overrides |
| M10 | `astro-pagescms` target: starter, file writer, `_redirects`, `.pages.yml` + schema generation, CI content validation | Same site migrates to either target from one IR; verify passes for both |
| v2 | Bricks adapter (`_bricks_page_content_2` + templates), built and measured against a real client site; i18n; plugin porting | A real Bricks client site migrates with 0 unmapped content and passes verify |

**Status (2026-11-21).** "Unit-tested" below means against mocked Cloudflare / HTTP / child processes; "run locally" means a throwaway copy of a generated project in local workerd. Details live in the linked findings and in [CHANGELOG.md](../CHANGELOG.md).

- **M0–M6 — done.** Spike, kit skeleton, audit, extract, IR with the WPBakery/Salient and Gutenberg adapters, starter + section library, load (local, staging, production; idempotent).
- **M7 — verify and dashboard: done; visual parity open.** Verify runs against staging and production; every check passes on the WPBakery/Salient pilot except visual parity, closed section by section (measured rules: [M7 findings](spikes/M7-findings.md)). Dashboard v1–v3 built (`wp2emdash ui`: portfolio, readiness, live runs, visual diff, approval queue, secrets, section inspector, launch cockpit, publish, environments, Worker secrets); MCP server and kit skills built.
- **M8 — cutover: preflight done; `golive` / `publish` built, not yet run for real.** `golive` (routes, smoke, DNS comparison, `--aliases`, `--rollback`), go-live token checks and `publish` are unit-tested ([M8 findings](spikes/M8-findings.md)). A pilot was switched by hand before `golive` existed. Two sites → one domain (`init --from`, `compare`, `aliasDomains`, `check-aliases`) unit-tested, not yet run against a real alias zone.
- **Environments — single environment by default** (§7a): built and unit-tested, Wrangler commands checked against 4.163.0 ([single-env findings](spikes/single-env-findings.md)); not yet run end to end on a new single-environment site (preview URL, bookmark restore unexercised).
- **Sign-in sessions on R2 — built,** run locally, unit-tested; not yet deployed ([sessions findings](spikes/sessions-findings.md)).
- **Plugin suite — built, all on by default (Form messages off on sensitiveData sites).** Forms 1.7.0 (endpoint, providers, outbox, Form messages, waivers, full inbox, file uploads, conditional fields, steps); Sharing images; SEO & Analytics 0.2; Site health, Privacy & consent, Backups & restore, Media assistant and Change requests 0.1: unit-tested and build-checked / run locally, not yet deployed to a client site (see each findings file).
- **Performance package — built,** measured on a staging Worker ([performance findings](spikes/performance-findings.md)).
- **Migration safety net, settings, providers — built:** `urls-accounted`, `content-types-handled`, WordPress URL rules, Additional CSS, Settings prefill, 55-provider registry and site-wide snippets, unit-tested; the Settings prefill also checked on a local dev server ([settings findings](spikes/settings-findings.md)).
- **Blog and custom post types — built,** tested on a synthetic WordPress blog and a local EmDash; not yet on a real blog ([blog](spikes/blog-findings.md), [CPT](spikes/cpt-findings.md)).
- **Bricks (v2 row) — adapter built and measured** on one real Bricks site through three visual parity rounds ([Bricks findings](spikes/bricks-findings.md)).
- **Built, awaiting a real site:** Elementor adapter (2026-11-21); site features (2026-11-21): every menu, mega-menu fallback, classic widget areas, search page, breadcrumbs, the old 404 page, Site health's Missing pages and coming-soon mode — unit-tested on a synthetic classic-theme fixture, EmDash seed/FTS/widget/404-log behaviour checked against the installed 1.5.0 in an in-memory spike ([site-features findings](spikes/site-features-findings.md)); not yet loaded into a running EmDash or run on a real classic-theme site.
- **Built, awaiting a real site:** Divi adapter and the Gutenberg block-library handlers (Kadence, Spectra, GenerateBlocks, Stackable, CoBlocks) (2026-11-21).
- **Built, awaiting a real site:** DOM-fallback adapter for every other builder and theme (2026-11-21; 8 synthetic fixtures, [findings](spikes/dom-fallback-findings.md)).
- **Built, awaiting a real site:** comments migration (2026-11-21; synthetic blog + local EmDash).
- **Built, awaiting a real site:** content & forms batch (2026-11-21): password-protected/private content, linked documents and library documents, Ninja/Formidable/WS Form/Forminator, forms 1.7 (file uploads, conditional fields, steps), shortcode registry — unit-tested, starter `astro check` clean; not yet loaded into a live EmDash ([findings](spikes/content-forms-findings.md)).
- **Built, awaiting a real site:** media folders (2026-11-21, [media folders findings](spikes/media-folders-findings.md)): FileBird / Real Media Library tables from a dump and attachment taxonomies over REST → flat EmDash folders, filing only unfiled items; fake-API tests, no real site or live EmDash yet.
- **Built, awaiting a real site:** P2 parity batch (2026-11-21, [P2 batch findings](spikes/p2-batch-findings.md)): team invite list from WordPress users + opt-in `invite` command, term descriptions on existing terms (Yoast term SEO counted, not carried), page order/parent/excerpt/featured image fields, reusable blocks as EmDash sections, oEmbed URLs → official embed markup and nine more providers, Adobe Fonts kept with Typekit in the CSP, featured image as the sitemap image fallback, form-entries step in the go-live checklist — unit-tested and checked with EmDash's `validateSeed`; not run against a local or deployed EmDash.
- **M8a, M9, M10 — not started** (M8a: kit docs refreshed 2026-11-21; the docs review checklist and the full configuration reference remain).

---

## 14. Owner decisions

1. Client projects: one private repo per client. ✅
2. Email: Brevo default; Resend, SendGrid, Postmark, Mailgun, SES, Google Workspace, Microsoft 365, Cloudflare Email Routing supported. ✅
3. Visual threshold: 3% default, configurable per site. ✅
4. Licence: MIT (owner decision 2026-11-18). The repo stays private until it is made public; `LICENSE` and `package.json` already say MIT. ✅
5. Environments: one Cloudflare environment per site by default (production on workers.dev until go-live); staging opt-in (owner decision 2026-11-20, §7a). ✅
