# Changelog

All notable changes to wp2emdash. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
The kit is pre-release (`0.1.0` in `package.json`); until the first tagged release, entries are grouped by day and
milestone, reconstructed from the git history. Package versions (`@wp2emdash/*`) are given where they changed.

## [Unreleased]

### Added
- **DOM-fallback adapter** (`src/adapters/dom-fallback`): pages of a builder without an adapter (Avada, Oxygen, Beaver Builder, Brizy, Thrive, SiteOrigin, Breakdance, Visual Composer, Flatsome, Enfold, a theme's own markup; detected from post meta, shortcode families, builder markup, the live page's body classes, or an empty post_content with a rendered page) are rebuilt from the audit's saved HTML instead of stopping at transform: theme chrome removed, rows and columns from the markup, text, images (upload URLs → media library), buttons, embeds, plugin forms, builder forms rebuilt as definitions, FAQ/tabs/testimonials/galleries from unambiguous markup, inline backgrounds and light text; tables and unknown embeds become sanitised legacy_html. Every such page is flagged and the new transform gate `dom-fallback-reviewed` stays red until `overrides.ts domFallbackReviewed` records the owner's check; coverage report section "Rebuilt from rendered HTML". 8 synthetic fixtures + goldens; not yet run on a real site (`docs/spikes/dom-fallback-findings.md`).
- Elementor adapter (`src/adapters/elementor`): containers and legacy sections, Kit globals, Theme Builder header/footer, Pro forms and popups (synthetic fixtures; no real Elementor site yet).
- **Site search page** `/search/?q=` in the starter (EmDash full-text search + the pages' section text); WordPress `/?s=` and `/search/<terms>/` now 301 there; a header search link when the old header had one; load check `search`.
- **Classic widget areas** → EmDash widget areas (text/HTML/block, image, menu, search and blog widgets; unknown ones gated by `widgets-handled`), rendered as footer columns and the blog sidebar where the old theme showed them.
- **Every menu** is written to EmDash (not only primary/secondary/footer), with classes, title attribute, targets and all levels; mega menus as columns of links (partial).
- The old **404 page**'s own wording (site part `not-found`), **breadcrumbs** when the old site showed them (one trail for the page and the BreadcrumbList).
- Site health (`@wp2emdash/health`): **Missing pages** (EmDash's 404 log, weekly, with suggested redirects) and **coming-soon mode** (503 holding page, admins see the site; never switched on by the migration).
- Divi adapter (`src/adapters/divi`): Divi 4 regular/specialty/fullwidth sections and ~30 modules (text, image, button, blurb, CTA, slider and fullwidth header as hero, gallery, video, testimonial, team, pricing, accordion/toggle/tabs, contact form → form definition, code through the embed registry, social follow, map, counters, menu), global colours, dynamic content, Theme Builder header/footer as site parts; Divi 5 blocks read best effort and flagged. Built, not yet run on a real Divi site (`docs/spikes/divi-findings.md`). The audit no longer treats Divi as unsupported.
- Gutenberg block libraries (`src/adapters/gutenberg/libraries.ts`): Kadence Blocks, Spectra, GenerateBlocks, Stackable and CoBlocks layouts and common blocks (advanced heading, buttons, icon list, info box, tabs, accordion, testimonials, team, counters, pricing, maps, galleries) map to sections; their form blocks become form definitions (recipients never copied); unknown library blocks keep their text and are reported. Not yet run on a real site (`docs/spikes/gutenberg-libraries-findings.md`).
- Extract requests Divi's Theme Builder and Library post types and reads `et_divi` / `et_global_data` (or `raw/divi-options.json`); `gallery_ids` count as media references.
- Comments migration: approved WordPress comments with dates, authors and threads (`@wp2emdash/comments` admin-only import route; EmDash moderation approves them), threaded display and a moderated comment form.
- Footer credit: "Website by PixelKraft" on every migrated site whose footer has no credit of its own (`credit` in kit.config; `false` turns it off).

- **Faster pages:** pages stay in Cloudflare's cache for 7 days (`performance.pageMaxAge`; EmDash purges them on every publish, menu, settings and widget change; posts and collections keep 1 hour because byline edits do not purge), and a page starts loading when a visitor hovers over, focuses or touches its link (`performance.prefetch`; site pages only, never files, off on data saver).
- **Password-protected and private content:** protected pages and posts are published behind a password page with the WordPress password (hashed by extract, never stored in clear; noindex, never cached, out of the sitemap and the search index); private ones become drafts. `overrides.ts protectedContent`; gates `protected-content` (transform), `protected-pages` (verify). See docs/spikes/content-forms-findings.md.
- **Linked documents:** PDFs, Word, Excel, ZIP… linked from content go into the media library and the links point at them (Word/Excel/ZIP through a `wp_documents` file field's allowlist); library documents are uploaded too (`overrides.ts media.library`); captions carried, duplicates collapsed, lost titles/descriptions reported; load gate `documents`.
- **More form plugins:** Ninja Forms, Formidable, WS Form and Forminator exports; a live form without an export is rebuilt from the page's HTML (flagged).
- **`@wp2emdash/forms` 1.7:** file upload fields (private R2 storage, one-time signed download links, retention), conditional fields (`showIf`) and multi-step forms; kit config `forms.uploads`.
- **Shortcode registry** (`src/adapters/shortcodes.ts`): forms, breadcrumbs, layout wrappers, widgets and core media shortcodes; unknown plugin shortcodes block; coverage report "Shortcodes".
- **Team invite list** from the WordPress users (P2 batch, `docs/spikes/p2-batch-findings.md`): administrator/editor/author/contributor → Admin/Editor/Author/Contributor, subscribers and plugin roles only by decision (`overrides.ts users`); names and e-mail addresses only in `sites/<slug>/users/` (reports, ir and client docs show counts per role). Load creates no accounts; `wp2emdash invite <slug> --send` sends the invites when the owner runs it.
- **Page attributes:** manual order, parent page, excerpt and featured image become `pages` fields (`menu_order`, `parent`, `excerpt`, `featured_image`) only when the site uses them; parents written in load's reference pass.
- **Reusable blocks as EmDash sections:** each published `wp_block` is also written as a section (`source: import`) editors can insert with `/section`; pages keep the block inlined.
- **oEmbeds:** Gutenberg embed URLs of X, TikTok, Instagram, Reddit, Pinterest, Dailymotion, TED, Spotify, Loom and Mixcloud become the provider's official embed code; Dailymotion, TED, Twitch, Pinterest, Reddit, Bluesky, Mixcloud, Bandcamp and Apple Podcasts/Music join the provider registry (allowlist + CSP).
- **Adobe Fonts:** a CSS kit the old site loaded is kept (`site.config.json fonts.typekitHref`), with Typekit's hosts in the CSP only on such sites.
- **Image sitemap entries:** a page, post or entry without its own sharing image gets its featured image as the SEO image, which EmDash lists as `<image:image>`.
- **Term meta:** load fills an empty description on a term that already exists on the target (never an editor's); Yoast per-term SEO (`wpseo_taxonomy_meta` via `import-options`) is counted in the coverage report, not carried (EmDash 1.5 has no per-term SEO).
- **Go-live checklist:** the owner exports past form entries from WordPress before the switch and before hosting is retired, and invites the team (counts per role).

### Fixed
- WPBakery/Bricks rows that hold a collection (video, form, gallery…) plus loose images or buttons dropped them without a word: they are now carried as sections after the collection, and icons that have no place are reported in the coverage report.
- Coming-soon mode now purges cached pages when it is saved (a cached page never reaches the middleware), and the middleware reads the switch on every render so a stale isolate cannot re-cache the public page.
- Blog load reruns: child categories were created again ("term already exists") because EmDash returns a hierarchical taxonomy as a tree; the term list is now flattened.

### Changed
- Site health report footer defaults to "Prepared by PixelKraft"; the kit's plugins are presented as PixelKraft plugins.
- Private posts no longer need a decision: they become drafts by default (as private pages already did); password-protected posts are protected by default. `protectedPosts` still works.
- Form sections from `[contact-form-7]` now match their definitions (they used the provider name `cf7`).
- Form messages (the forms outbox and its admin page) is on by default for sites that are not `sensitiveData`; `forms: { outbox: false }` turns it off.

## 2026-11-21 — Change requests, custom post types

### Added
- **Change requests** (`@wp2emdash/change-requests` 0.1), on by default: clients ask the agency for changes inside
  the admin (page, priority, private screenshots/PDFs) and follow the status; agency replies, email notifications,
  optional signed webhook. `changeRequests: false` opts out.
- **Custom post types → EmDash collections**: each public type becomes its own collection with its archive and term
  archives; ACF, Meta Box and Pods fields mapped to EmDash fields; transform gates `cpt-fields`, `cpt-taxonomies`,
  `cpt-bylines`.

### Changed
- Scaffold adds `@types/react` when Change requests is on (typed upload page; `astro check` passes in a real project).

## 2026-11-20 — Plugin suite, single environment, go-live tooling, blog, safety net

### Added
- **Go-live tooling**: `wp2emdash golive` (owner-approved with `--yes`; Worker routes, smoke test on the real domain,
  DNS compared with the preflight snapshot, `production.live`), `--aliases` and `--rollback`; preflight checks
  `golive-token-separate` and `golive-token-scope`; explicit `SESSION` binding.
- **`wp2emdash publish`**: the site's project to a private GitHub repository (secret scan, push, `CLOUDFLARE_ACCOUNT_ID`).
- **Single environment by default**: production only, on `workers.dev` until go-live; staging opt-in
  (`target.staging: true`). `load --force` on a live site records a D1 Time Travel bookmark first; code review on
  Workers preview URLs.
- **Dashboard v3**: actionable launch cockpit (go live, alias redirects, rollback behind a typed-domain confirmation
  and the owner's written approval), publish panel, environment view, Worker secrets.
- **Two sites, one domain**: `init --from`, `compare`, `target.aliasDomains`, `check-aliases`.
- **Performance package**, on by default: route cache in the Workers cache with purge tags, warm-up after deploy,
  responsive images through the Images binding, deferred background video, hashed brand files and immutable fonts;
  verify gates `route-cache`, `cached-ttfb`, `payload`. `performance.phoneVideo` option.
- **SEO & Analytics** (`@wp2emdash/seo` 0.2): tracking codes by ID, conversion events, consent mode and Visits
  (Cloudflare Web Analytics) inside the SEO suite; verify checks analytics in a real browser.
- **Site health & monthly report** (`@wp2emdash/health` 0.1), on by default.
- **Privacy & consent** (`@wp2emdash/consent` 0.1), on by default: built-in cookie banner (off / notice / opt-in /
  auto by region), Consent Mode v2; verify `consent-runtime`.
- **Backups & restore** (`@wp2emdash/backups` 0.1), on by default: nightly content backups to R2, restore of
  settings, menus or one page from the admin.
- **Media assistant** (`@wp2emdash/media` 0.1), on by default: media health, in-place optimizing, reviewed AI alt
  text, focal points, media trash.
- **Sign-in sessions on R2** by default (`<worker>-sessions` bucket with a lifecycle rule): fixes random admin
  logouts caused by Workers KV's eventual consistency. `sessions: "kv"` keeps the old store.
- **Site settings**: EmDash's Settings (General, Social Links, SEO) prefilled from WordPress and read live by the
  starter; `load --only settings` applies them to a live site without touching content.
- **Provider registry** (46 providers) shared by embed detection, the embed allowlist and the CSP; site-wide snippet
  recognizer (head/body code, Header Footer Code Manager) with gate `site-snippets`; site widgets (chat, reviews
  badge, consent tool) carried by provider + ID.
- **Migration safety net**: verify `urls-accounted` (every old address answers 200, one 301, or 404/410 by
  decision), transform `content-types-handled`, a per-site WordPress URL rule set (feeds, search, archives,
  attachment pages, query URLs), Customizer Additional CSS reported and carried by decision, `/locations.kml`
  regenerated from the business data.
- **Blog**: posts collection (Gutenberg/classic → Portable Text, builder posts keep sections), categories, tags and
  custom taxonomies, guest bylines, archives with pagination, RSS feeds.
- **Parity audit**: [WordPress → EmDash matrix](docs/parity/wp-to-emdash.md) (110 features) and a prioritized backlog.
- Bricks visual parity rounds 1–3 on a real Bricks site (site layout tokens, header sheet, footer stacks, FAQ panel,
  CTA cards, calm entrance motion); Salient parity for image-and-text, card and contact rows.

### Changed
- Sharing images (`@wp2emdash/og`) and the SEO suite are on by default for every site.
- `load` sets EmDash's Site URL to the address the site answers on; `golive` sets it to the real domain.
- After go-live the `workers.dev` address is switched off (`target.keepWorkersDev` keeps it).
- A production load clears EmDash's staging flag (it noindexed every page of a launched domain); preflight checks it.
- Warm-up retries requests that fail right after a deploy (`WARM_RETRY_MS`).

### Fixed
- Analytics loader is a real file (an inlined loader was blocked by the CSP); the CSP always allows the
  zone-injected Cloudflare Web Analytics beacon.
- Forms: dropdowns start on their placeholder; every form has an accessible name.

## 2026-11-19 — Verify suite, dashboard, Claude Code, Bricks adapter, forms package

### Added
- **Dashboard** `wp2emdash ui` v1 (portfolio, launch readiness, live runs, visual diff viewer) and v2 (approval
  queue, secrets form, section inspector, launch cockpit, owner checklist).
- **Claude Code**: `wp2emdash mcp` server, approval queue (`wp2emdash proposals`), four kit skills.
- **Bricks adapter** for Bricks 2.4.6 and 2.5 (elements, templates, global classes, palette, components, forms),
  then real-site gaps (post content, NextBricks/BricksExtras elements, logo, Mariana Tek embeds).
- **Forms as a package** (`@wp2emdash/forms`): 1.1 Form messages admin page, 1.2 recipients in the admin and
  `EMAIL_PROVIDER=emdash`, 1.3 waiver forms (radio, consent, form text, signatures), 1.4 optional full inbox
  (`forms.outbox.keepSent`).
- **Sharing cards** (`@wp2emdash/og`) and the **SEO suite** (`@wp2emdash/seo`: editor panel, dashboard, Search
  Console, IndexNow), first as opt-in.
- **Announcement bars** detected on the live site and rebuilt as an editable site part.
- Plugin data exports (forms and redirects plugins) requested in `ACCESS.md`, read by extract, redirects imported
  by load; `import-dump` and `import-options` for backups and builder settings.
- `provision` for production in another Cloudflare account; `projectDir` to keep a project outside the kit;
  terminal-or-web choice in the wizard.

### Changed
- Visual parity work on Salient: parallax, spacing, type, buttons and form fields measured from the live theme.
- Verify capture waits for animations, lazy images and videos before screenshots.

## 2026-11-18 — Verify, forms, SEO and staging

### Added
- Form endpoint: Turnstile, rate limit, validation, sensitive-data policy, Brevo delivery; then Resend, Postmark,
  SendGrid and Mailgun; form outbox in Workers KV.
- Structured data from the live site's JSON-LD, sitemap at real addresses, analytics IDs, sharing images, old URL
  redirects, cutover preflight.
- Content-Security-Policy header; section-by-section visual comparison in verify.
- Scaffold writes the client repository (README, docs, GitHub CI, `.env.example`).

### Changed
- Header built from the audit (layout, toggle label, panel extras, collapsible sub-menus); many Salient layout
  rules measured on the live site.

## 2026-11-17 — First pipeline (M0–M7 start)

### Added
- The kit: CLI, config, site workspaces, phases `init`, `audit`, `extract`, `transform` with the WPBakery/Salient and
  Gutenberg adapters and golden tests (M0–M4).
- M5: section library, starter project, scaffold; GitHub Pages site.
- M6: load phase (media, content, menus, settings into EmDash, idempotent); staging deploy and migrations.
- M7: verify phase (old site vs migrated site, URL by URL, HTML report).
- Cloudflare API token documentation and `doctor` token verification; staging setup runbook.
