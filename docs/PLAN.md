# wp2emdash — Plan

**Goal:** A reusable kit that migrates any WordPress site to EmDash (Astro on Cloudflare Workers + D1 + R2) and proves, with automated checks, that nothing was lost: content, URLs, SEO, design, forms, integrations.

**Targets:** EmDash (default) or Astro + Pages CMS, chosen per site (§2.3).
**v1 scope:** Gutenberg/classic and WPBakery (incl. Salient `nectar_*` elements). Bricks is the next adapter (most client sites are built with it), on the same core and section format, built and measured against a real client site.
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
| Posts (blog) | Official importer → Portable Text body (they're Gutenberg/classic). Kit fix-ups only. |
| Pages built with WPBakery | Kit adapter → IR → `layout` blocks field (overlay). |
| Pages built with Gutenberg | Kit adapter → IR when the page uses layout blocks (cover, columns, group, media-text); plain-prose pages stay Portable Text. |
| Custom post types | Official importer for fields; builder content in them goes through the adapter. |
| Reusable blocks / WPBakery templates | Inlined into pages by the adapter; also imported as EmDash sections (`source: import`). |

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
- **Forms:** definitions, notification and confirmation settings, integrations through the form plugin's REST (Fluent Forms in M3; CF7/WPForms/Gravity extractors added when a site needs them). **Submissions are never read.**
- **Media:** every library item downloaded to `raw/media/` (hidden upload paths such as WP Ghost's `/storage` handled), sha1 recorded in `raw/media-manifest.json`; every reference in content/meta resolved — attachment IDs in shortcode attributes, `wp-image-N`, gallery `ids`, URLs incl. `-300x200`/`-scaled` variants, URL-encoded link attributes and base64 `vc_raw_html`. Site uploads missing from the library are downloaded too; external media (CDN videos) are checked and listed for a keep-hotlinked vs copy-to-R2 decision. Reruns reuse cached files.
- **Not available over REST (manual, optional, read in transform):** Salient Redux theme options (`raw/salient-options.json` from Salient → Options → Import/Export; otherwise design capture is the source), Rank Math redirections (`raw/redirects.csv`), WXR (`raw/export.xml`) as a cross-check.
- `extract.json` keeps the latest `modified_gmt` per type for the cutover delta.
**Gate:** credentials valid for the configured host; exporter ≥ 1.2.0; authenticated read; every type fetched and counts equal the exporter's totals; menus present when the audit saw a menu; Salient global sections present on Salient sites; every live form's definition extracted; media library fully listed and downloaded; every attachment ID used by **published** content resolves (unpublished leftovers reported); every page the audit found is in the extract.
**Report:** `reports/extract/extract.md` (no credentials, usernames or emails).

### Phase 3 — `transform`
Implemented in M4 (`src/phases/transform.ts`, `src/adapters/`, `src/ir/`). Pure function of `raw/` + `overrides.ts`; reruns give byte-identical IR.
- **Adapters:** WPBakery/Salient shortcode parser → element handlers → row recognisers (§6); Gutenberg block parser → the same recognisers (§7); classic content via wpautop → Portable Text (shortcodes inside it go through the shortcode adapter).
- **Output:** `ir/pages/*.json`, `ir/posts/*.json` (builder posts only), `ir/partials/*.json` (Salient global sections → footer/header), `ir/popups/*.json` (enabled Popup Maker popups with their trigger selectors), `ir/site.json` (identity, menus with roles, partials, popups). Buttons/links that open a popup carry `opensPopup`.
- **Overrides:** `elements["<slug>:<row path>"]` forces a section type or drops a decorative row; `approvedLegacy` lets a reviewed `legacy_html` ship; `routes` fixes paths.
- **Coverage report** (`reports/transform/coverage.md`): per document section map, text kept, diagnostics; site-wide unmapped-element table.
**Gate:** IR validates; 0 unmapped nodes carrying content in published pages, footer and popups; 0 unapproved `legacy_html`; every media reference resolves to the extract; every image published content uses in WordPress is in the IR; every internal link points at a migrated page, anchor, popup or file; **text conservation** — share of distinct words of the live page's own server HTML (theme chrome removed) found in the IR ≥ `gates.textConservation` (default 99%). Unpublished content is transformed and reported but not gated.

### Phase 4 — `scaffold`
Implemented in M5 (`src/phases/scaffold.ts`, `src/scaffold/`, `src/starter/library.ts`, `starter/`). Facts it relies on: `docs/spikes/M5-findings.md`.
- **Section library = one TypeScript definition** (`src/starter/library.ts`) → seed `blockTypes`, the starter's components and the IR → block mapping (`src/targets/emdash/blocks.ts`, which conforms every value to its block type).
- **Generated per site:** `tokens.css` (design capture: colours, fluid type scale between the mobile and desktop captures, container, radii), `motion.css` (menu motion recipe), `site.config.json` (header panel variant, breakpoint, transparent/hide-on-scroll, logos, fonts, URL style), forms (`src/forms/*.json` from the form plugin, published forms only), `seed/seed.json` (block types, `pages` / `site_parts` / `popups` collections, menus, settings with `staging: true`, and the migrated content for local preview), `package.json` with exact verified versions, `astro.config.mjs`, `wrangler.jsonc` (production + `staging` env, separate D1/R2).
- **Local preview:** `pnpm dev` in `sites/<slug>/project`, then `/_emdash/api/setup/dev-bypass?redirect=/` — the migrated site with live WordPress media.
- **Runtime pins (every generated project):** Node 24+ for install/build/CI (`engines`, `.nvmrc`, CI image); the Worker itself runs on workerd (V8), not Node — Node APIs come from the `nodejs_compat` flag, and `compatibility_date` is set to the scaffold date so the newest runtime behaviour is used. Astro = latest stable that EmDash's peer range allows (checked by `doctor`: EmDash 1.5 needs `astro >=6`; latest is 7.4.12 on 2026-11-17, used by the M0 spike). Exact versions in the lockfile; upgrades are a deliberate step with a rerun of verify.
- Copy `starter/` into `sites/<slug>/project/` (or create with `npm create emdash@latest` and apply the starter as an overlay — decided in M0).
- Write `tokens.css` from design capture; generate header/footer from captured structure; register per-site section variants.
- Seed: collections (pages with `template` + `layout` blocks field, posts, CPTs), `blockTypes`, menus, widget areas, site settings.
- Staging resources: separate D1 + R2 + secrets per environment (`emdash secrets generate`). Staging host from `target.staging.host` (e.g. `staging.example.com` on the client zone; empty = `*.workers.dev`), protected per `target.staging.protection`: `access` (default: Cloudflare Access login wall + robots `Disallow: /` + `X-Robots-Tag: noindex`) or `noindex` only. Canonicals on staging already point at the production host. Behind Access, `verify` and Playwright authenticate with an Access service token kept in `sites/<slug>/.env`. See §7a.
**Gate (local, M5):** every IR section type has a block type and component; every form section has a definition; brand assets copied; install; `seed.json` passes EmDash's validator; build; Worker < 10 MB gzip. **Staging gate (with load, M6, owner-approved deploy):** staging deploy answers, admin login works, every route renders.

### Phase 5 — `load` (local, then staging)
Implemented in M6 (`src/phases/load.ts`, `src/targets/emdash/api.ts`); API facts in `docs/spikes/M6-findings.md`; operator runbook for staging in `docs/staging-setup.md`.
- **Targets:** `local` (default: the kit starts the project's dev server, applies the seed structure with `?content=0`, logs in with dev-bypass) and `staging` (`WP2EMDASH_LOAD_TARGET=staging`, `target.stagingUrl`, `EMDASH_TOKEN` in `.env`). Staging is owner-approved: deploy, admin passkey and API token are human steps.
- **Media:** every IR media reference → file from `raw/media/` (external media per `overrides.media.external`: `copy` downloads it) → sha1 → reuse the target's item with that `contentHash`, else upload.
- **Content:** pages / `site_parts` (footer) / `popups` written through the id-map (`load/id-map.<target>.json`, keyed by WordPress type + id; first load adopts an entry with the same slug). Updates send the entry's `_rev`. SEO title/description/canonical/noindex from the IR. Published in WordPress → published; private/draft → draft.
- **Fix-ups:** links to the WordPress host become paths; WordPress upload URLs become EmDash media URLs.
- **Menus and settings:** menus recreated from the IR (popup triggers as `popup-<slug>` classes); title, tagline, title separator; `staging: true` until cutover.
- Before every staging load: snapshot (`site export`) — with the first staging run.
**Gate:** target reachable and authenticated; section library and collections present; every media reference on the target; every document written; menus and settings written; entry counts equal the IR with no duplicate slugs; no WordPress host links, upload URLs or shortcodes in stored content; every media id exists; id-map complete; every published page renders (200) and shows its first heading. Verified idempotent: a second run uploads and creates nothing.

### Phase 6 — `verify` (old live site vs staging, URL by URL)
Implemented in M7 (`src/phases/verify.ts`, `src/verify/`): HTTP checks per page (status, text recall, headings, SEO title/description/canonical/robots/JSON-LD/OpenGraph, external links, alt text, form fields), internal link crawl, security headers, WordPress endpoints, form endpoints; browser checks reuse the audit's capture (screenshots → pixel diff over the overlapping height, axe WCAG 2.1 AA, lab LCP/CLS on mobile, burger-menu capture → motion recipe comparison). Fresh `workers.dev` hosts are reached with the pinned addresses (`--host-resolver-rules`, no proxy). Report: `reports/verify/index.html` (gate summary, per-page table, slider / side-by-side / diff per viewport) + `verify.json`.
| Check | Pass rule (defaults, configurable) |
|---|---|
| Content | normalised visible text similarity ≥ 0.98 per page; heading outline identical; every source image present with alt |
| URLs | every baseline URL → 200 at same path, or a 301 (single hop) to its mapped target; documented exceptions only |
| SEO | title, description, canonical (pointing to prod host), robots, OG, JSON-LD types identical or decided; sitemap contains exactly the indexable URLs; no `noindex` leaking to prod config |
| Links | 0 broken internal links; external links same as source (booking, phone, email, socials) |
| Visual | per page × viewport pixel diff ≤ 3% after masks, plus structural diff (section order/count) = 0; anything above → `decisions.md` approval |
| Forms | each form submits on staging to the test destination; Turnstile active; validation errors accessible |
| Integrations | analytics/tag manager loads once, consent respected, booking/embeds/maps work |
| Accessibility | axe: 0 serious/critical; keyboard nav of menu/accordions/forms; reduced-motion respected |
| Performance | Lighthouse mobile ≥ 90 perf, LCP ≤ 2.5s, CLS ≤ 0.1 on representative pages |
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
- **Post-launch (scheduled checks):** 404 log → new redirects, Search Console sitemap submit + coverage watch, form deliverability, error rates, for `target.cutover.monitorDays` (default 14). WordPress kept running and restorable for `target.cutover.keepWordPressDays` (default 30), not publicly reachable.
- **Finalise (optional, owner-approved):** after the monitoring window, convert the route to a Worker Custom Domain (this is the only step that removes the WordPress A/AAAA record), then decommission WordPress hosting after `keepWordPressDays`, keeping the final backup.

### 7a. Environments and launch topology
| Stage | Where | Data | Who sees it | Purpose |
|---|---|---|---|---|
| Local | `pnpm dev` (Miniflare: local D1/R2) | local copy | developer | build sections, header/menu motion, content checks. Not used for verify: forms, email, Turnstile, R2 images, caching and CPU limits only behave for real on Cloudflare. |
| Staging | `staging.<domain>` or `*.workers.dev` | staging D1/R2/secrets | owner + client, behind Access | `load` and `verify` run here (live WordPress vs staging); client review and sign-off; rollback rehearsal. |
| Production | `<domain>` via Worker route | production D1/R2/secrets | public | cutover delta, smoke, monitoring. |

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
| `form` | form definition ref, heading, intro | CF7/WPForms/Gravity/Salient forms (§8) |
| `map` | embed URL or address, height | `vc_gmaps`, map embeds |
| `embed` | sanitised HTML from allowlist (iframe providers), height | `vc_raw_html` that is a known widget |
| `legacy_html` | raw HTML, reason | fallback only; always red in the report until replaced or approved |

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
- Third-party libraries (Kadence, Spectra, GenerateBlocks, Stackable): structural handlers by block family; unknown → `dom-fallback`.
- Classic editor content: HTML → Portable Text; embedded shortcodes go through the shortcode parser.
- Prose-only pages and all posts stay Portable Text (no sections needed).

---

## 8. Everything else a migration touches

| Area | Plan |
|---|---|
| **Routing** | Root paths via `src/pages/[...slug].astro` resolving nested page paths (`/services/physical-therapy/`); keep source trailing-slash policy; posts keep their permalink structure (configurable pattern); category/tag/author archives only if they were indexable. |
| **Redirects** | Generated from the URL map + imported plugin redirects + synthetic WP URLs (`?p=`, `?page_id=`, attachment pages → parent/media, `/feed/` → new feed or home, `wp-content/uploads/...` → R2 URLs). Single hop, 301, tested. Implementation (middleware vs Workers redirect rules vs Cloudflare Bulk Redirects) chosen in M0. |
| **Media** | Originals into R2 via importer (SHA-1 dedup); responsive sizes generated by the frontend (Cloudflare Images/transform or Astro image), not copied from WP's `-WxH` files; alt text preserved, missing alts listed; SVG sanitised; favicon/app icons/OG default image migrated. |
| **Design** | Tokens from computed styles + theme options; fonts self-hosted where licence allows (Adobe Fonts kept as kit embed); icon fonts → SVG; Salient animations reduced to a small motion set (fade/slide on enter, parallax off by default) with `prefers-reduced-motion`. |
| **Header/footer/menus** | Menus via importer (exporter 1.2.0+) rendered with `getMenu()`; mobile menu rebuilt accessible (focus trap, Esc, aria-expanded); footer widgets → widget areas; social links → site settings. |
| **Forms** | Per form, choose: keep third-party embed, or rebuild as `form` section posting to a Worker endpoint with Turnstile, server-side validation, rate limit, email delivery and optional D1 storage. **Email providers** (pluggable, HTTP APIs, chosen per site): **Brevo (default)**, Resend, SendGrid, Postmark, Mailgun, Amazon SES, Google Workspace (Gmail API with a service account and domain-wide delegation), Microsoft 365 (Graph `sendMail`), Cloudflare Email Routing `send_email` (verified recipients only). Raw SMTP is not used from Workers. **Health/PHI data never goes into Worker/D1/email; it stays with the approved provider.** |
| **Booking & third-party** | Keep existing providers; links/embeds tested in verify. |
| **SEO** | Yoast/Rank Math fields via exporter; JSON-LD regenerated (Organization/LocalBusiness/MedicalBusiness, BreadcrumbList, FAQPage from `faq`, Article for posts); sitemap + robots generated; OG images; hreflang if multilingual. |
| **Analytics & consent** | GA4/GTM/pixels carried over once; header/footer scripts from theme options reviewed one by one; consent banner if the source had one or jurisdiction requires it. |
| **Blog** | Posts, categories, tags, authors/bylines, featured images, pagination, RSS feed, search page. Comments: import (EmDash supports them) or drop by decision. |
| **Search** | EmDash search or AI Search plugin if the source site had search. |
| **i18n** | WPML/Polylang detected in audit; v1 flags it as out of scope, v2 maps to EmDash i18n. |
| **Accessibility** | WCAG 2.2 AA target; axe in verify; fixed issues from the source site noted as improvements, not regressions. |
| **Security** | Admin passkeys/MFA, least-privilege users, secrets only in Wrangler secrets/`.env`, app password + migration key revoked after import, staging behind Access/noindex, no backups in public storage. |
| **Editor handoff** | Generated editor guide: list of section types with screenshots, how to add/edit pages, menus, media, SEO fields; admin accounts invited, not shared. |
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

## 9. Out of scope for v1 (detected and reported, migration stops for a decision)

WooCommerce/shop, membership/LMS/paywalls, multisite, WPML/Polylang, user accounts/front-end login, custom plugins with business logic (→ later via `wordpress-plugin-to-emdash`), Bricks pages (adapter in v2, built against a real client site).

---

## 10. Claude Code integration

- **Install official EmDash skills** in the kit and every site project: `building-emdash-site`, `emdash-cli`, `creating-plugins`, `wordpress-theme-to-emdash`, `wordpress-plugin-to-emdash`. Also use EmDash's docs index (`llms.txt`) / Docs MCP for current API facts.
- **Kit skills** (in `skills/`):
  - `wp2emdash-run` — runs the pipeline phase by phase, stops at red gates, explains them.
  - `wp2emdash-map` — takes coverage-report items + source snippet + screenshot crop, proposes a handler or override, writes it to `overrides.ts` (or a new element handler + fixture test when it's generic), reruns transform.
  - `wp2emdash-visual-fix` — takes a red visual diff, adjusts tokens/section variants, reruns verify for that page.
  - `wp2emdash-cutover` — walks preflight and cutover with explicit human confirmation at each irreversible step.
- **CLAUDE.md rules:** never edit generated `ir/` or imported content by hand; never write to the WordPress site; never put secrets in prompts/logs; never change DNS/routes or production without explicit approval; always rerun the affected gate after a change.

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
| # | Feature | What it does |
|---|---|---|
| 1 | Visual diff viewer | Old vs new per page × viewport: slider, onion-skin and pixel-diff modes, masked regions; approve/reject writes `decisions.md`; menu open-state and motion timing shown next to the recipe. |
| 2 | Section inspector | Click a region on the source screenshot → the WordPress row/block, the IR section it became, and the rendered staging section. Change the section type or drop it → `overrides.elements`, rerun transform for that page only. |
| 3 | Launch readiness score | One score per site from every gate (content, URLs, SEO, visual, forms, a11y, performance, security, editing); "what blocks launch" list with links to the fix. |
| 4 | Launch cockpit | Cutover preflight, Worker route switch (owner-confirmed), live smoke checks, one-click rollback (delete routes), post-launch timer. |
| 5 | Change watcher | Polls the exporter for `modified_gmt` changes during the project; shows which pages changed in WordPress and resyncs only those (cutover delta made continuous). |
| 6 | Client sign-off page | Static export of the verify report + screenshots that the client reviews and signs; signature and date recorded in `decisions.md`. |
| 7 | Post-launch monitor | 404 log → suggested redirects, form deliverability, Lighthouse and Core Web Vitals before vs after, Search Console coverage. |
| 8 | Portfolio view | Every site in `sites/` with phase, readiness score, blockers and last run. |
| 9 | Run history | Every run's IR and reports kept; diff two runs; restore an earlier IR. |
| 10 | Guided owner checklist | ACCESS.md as a step-by-step guide with screenshots; automatic checks where possible (exporter installed, key valid, backup file present, DNS export parsed). |

Built in the order above; 1–3 with M7, 4 with M8, 5–10 after the pilot launch.

---

## 11. Safety rules (carried over)

- WordPress stays live and restorable until production has passed smoke checks and the observation window ends.
- Full hosting backup (DB + uploads + themes/plugins + config) downloaded off-server and test-opened before anything else.
- Staging and production use separate D1, R2 and secrets.
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
| A8 | Route caching / cache invalidation on publish works as expected on Workers. | Editing check. |
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

**Status (2026-11-19):** M0–M6 done. M7: the verify suite runs against staging and production and every check passes on the pilot except visual parity, which is being closed section by section (measured Salient rules in `docs/spikes/M7-findings.md`); the dashboard (§10b) is not built yet. M8: cutover preflight done; the pilot runs in production on `workers.dev` and waits for the owner's go-live approval, the go-live token and a working email account (form messages are held in the KV outbox until then). The form outbox has an admin page (Plugins → Form messages, admins only: inbox with search, filters, read state and bulk actions; insights from per-day counts; CSV/JSON export via one-time links and import; activity log; dashboard widget). Forms are the kit package `@wp2emdash/forms` (`packages/forms`: endpoint, email, outbox, admin plugin), copied into each client repo and linked from its package.json; usable in any EmDash project (its README). Backlog: recipients editable in the admin and sending through EmDash's email pipeline (`email:send`).

---

## 14. Owner decisions

1. Client projects: one private repo per client. ✅
2. Email: Brevo default; Resend, SendGrid, Postmark, Mailgun, SES, Google Workspace, Microsoft 365, Cloudflare Email Routing supported. ✅
3. Visual threshold: 3% default, configurable per site. ✅
4. Licence: MIT (owner decision 2026-11-18). The repo stays private until it is made public; `LICENSE` and `package.json` already say MIT. ✅
