# Changelog

All notable changes to wp2emdash. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Releases follow [Semantic Versioning](https://semver.org/) from `1.0.0`. Entries before it are grouped by day and
milestone, reconstructed from the git history. Package versions (`@wp2emdash/*`) are given where they changed.

## [Unreleased]

## [1.4.0] — 2026-11-22

### Added
- **Tracking loads after the page has drawn** (`@wp2emdash/seo` 0.4.1; SEO & Analytics → Analytics, switch on by default): Google tag / Tag Manager, Meta, Clarity, Hotjar and Cloudflare scripts download after the page's load event and an idle moment (at most 2 s), or at the visitor's first scroll, tap or key. Calls are queued meanwhile (page views and events kept). Takes ~300 KB of Google scripts out of the first view and the Lighthouse LCP estimate. Off: the old immediate loading.
- **Footer business details switch** (`@wp2emdash/seo` 0.4.1): admins show or hide the footer's business name, address, phone and hours on SEO & Analytics → Site checks, without a rebuild. Stored in the SEO plugin's KV (`plugin:site-seo:business`), read with the page chrome, saving purges the cached pages. Never saved or unreadable: the block shows. Only on sites built with the block.

### Changed
- Footer business block is centred, like the credit line under it.
- Self-hosted fonts must cover every family the site uses: scaffold compares the download with the Google Fonts link and, when a family is missing (seen intermittently: a build had only the display font), warns, keeps the Google link and saves Google's answer to `reports/scaffold/google-fonts-answer.css`. A face without a woff2 file fails self-hosting instead of being skipped. The log names the self-hosted families.
- Google Fonts never lose a family to a failed request: only Google's 400 means "not on Google Fonts"; a network error or 5xx is retried twice, then the whole font link is kept (warned). A font file that cannot be downloaded fails self-hosting (Google link kept) instead of leaving that font out. A transient failure had dropped a site's body font from a production build.
- Opening hours group consecutive days: "Mo,Tu,We,Th,Fr" reads "Mon–Fri", all seven days "Every day" (English; other languages "Mon–Sun").
- Test fixtures: dummy Telegram and Google API key values are split in the source so secret scanners do not flag them (they were never real credentials).

## [1.3.0] — 2026-11-22

### Added
- **Instant page switches** (Speculation Rules): pages a visitor points at are prefetched by the browser's speculation rules (`moderate` eagerness, prefetch only, never prerender), delivered as a `Speculation-Rules` header pointing at the static `/speculation-rules.json` (`application/speculationrules+json` via `_headers`; no inline script, CSP untouched). The prefetched page is used on the click despite `Cache-Control: no-cache` (`deliveryType: navigational-prefetch`), which the old `<link rel=prefetch>` was not. Exclusions shared with `prefetchable()`; never for signed-in editors; appended to Cloudflare Speed Brain's header. Safari/Firefox keep the link fallback. Findings: `docs/spikes/performance-findings.md`.
- **Business details in the footer** (`starter/src/components/BusinessInfo.astro`, kit.config `business.footer`, default on): name, address (linked to the map), phone (`tel:`), email and opening hours as visible text, from the same data as the JSON-LD. Scaffold leaves it out when the migrated footer already shows the street address or phone. New `business` entry in `overrides.ts` to correct or add the details.
- **Content checks** (`@wp2emdash/seo` 0.4.0): text length thresholds (under 150 words a problem, under 300 a warning; contact/legal/thank-you pages only noted), **Repeated words** (most frequent meaningful word over 4%, not judged under 80 words), **Easy to read** (Flesch–Kincaid grade, English only; scaffold passes the site language), and a **Pages that need more text** list on the SEO dashboard.
- **WebMCP form annotations** (`@wp2emdash/forms` 1.9.0, `@wp2emdash/forms/webmcp`; kit.config `forms.webmcp`, Worker var `FORM_WEBMCP`): form sections, the comment form and site search carry `toolname`/`tooldescription`/`toolparamdescription` built from the form's own fields, so AI agents in Chrome can fill them in. Agents never submit site forms (the visitor does; Turnstile, honeypot and limits unchanged); only search auto-submits. Sensitive forms (and every form on `sensitiveData` sites) are not exposed. Findings: `docs/spikes/webmcp-findings.md`.

## [1.2.1] — 2026-11-22

### Added
- **ARD manifest** (`/.well-known/ard.json`, `starter/src/utils/ard.ts`): scaffold writes a static Agentic Resource Discovery manifest listing `/llms.txt` and `/sitemap.xml`, served by the asset layer. Lighthouse 13.6's **Agentic Browsing** check failed `ard-schema` because the rendered 404 for that path can exceed its 2-second fetch; now 4/4 (the llms.txt entry's `text/markdown` type is a low note, scored 0.9 = passed). Findings: `docs/spikes/agentic-browsing-findings.md`.
- `<link rel="alternate" type="text/markdown" href="/llms.txt">` on every page, so crawlers and audits find the AI page map.
- **Page preloading status** (Site health → Speed, `@wp2emdash/health` 0.3.1): a "Page preloading" line says whether hovered, focused or first-touched links load before the click (the kit's existing `performance.prefetch`, default on) and what it skips. Status only, no switch: scaffold passes `prefetch: false` to the plugin when the kit turned it off.

### Changed
- The first section's background picture (hero or lead) gets `fetchpriority="high"` as well as eager loading (LCP).
- The menu panel's logo (the same file the header already loaded) is no longer `loading="lazy"`.

## [1.2.0] — 2026-11-21

### Added
- **Page cache controls** (Site health → Speed, `@wp2emdash/health` 0.2–0.3): switch the cache refill on/off, choose every 15, 30 or 60 minutes, see the last run (pages checked, built again, failed, each page's state) and **Refresh all pages now** (clears the page cache; refilled within 5 minutes). The Worker's cron reads the setting from D1 on each tick (no redeploy) and skips while coming-soon mode is on. Default unchanged: on at `performance.rewarmMinutes`.
- **CSP violation reports** (Site health → new **Security** tab, `@wp2emdash/health`; kit.config `health.cspReports`, default on): the public Content-Security-Policy now carries `report-uri` and `report-to` (with a `Reporting-Endpoints` header; never in signed-in editors' CSP, baked in at build via site.config `cspReport`, no per-request read). Browsers report to the plugin's public route `/_emdash/api/plugins/site-health/csp` (legacy `application/csp-report` and Reporting API `application/reports+json`, 8 KB cap, always 204, works during coming-soon). Only the directive, the blocked origin (or inline/eval), page paths, the source origin and counts are kept; extensions, `about:`/`data:`, other origins and signed-in browsers are dropped; 30 requests/min per isolate, 50 sources kept, one KV write per request. A **new** blocked script is emailed through the existing alert limits (live only, never staging); other directives as a note. The tab lists each source in plain words with **Clear the list** and an on/off switch (storage and alerts). The monthly report gets a one-line count. Findings: `docs/spikes/csp-reports-findings.md`.
- **Security headers check** (Site health, hourly, new check `security`): HSTS, CSP (and its report endpoint), X-Content-Type-Options, Referrer-Policy, frame protection and Permissions-Policy of the live home page, shown on the Security tab with the certificate result; a missing CSP alerts.
- **Chat notifications for form messages** (`@wp2emdash/forms`, new `chat.ts`, export `@wp2emdash/forms/chat`): a new message can ping **Telegram** (Bot API, secret `TELEGRAM_BOT_TOKEN`, chat id in the settings), **Slack** (incoming webhook, secret `SLACK_WEBHOOK_URL`) or a **generic webhook** (secret `CHAT_WEBHOOK_URL`; JSON event, `{ text }` for Google Chat, or Discord — also covers Teams workflows, Make, Zapier, n8n, and WhatsApp through those), with a link that opens the message in Form messages. Admins set it up in Form messages → Settings → **Chat notifications**: per channel on/off (offered only once its secret exists, otherwise the `wrangler secret put` line is shown), which forms notify, and what is sent — **summary** (form, time, sender's name, first ~200 characters of the message; never email addresses, phone numbers or files) or **notification only** (form, time, link). Sites with `sensitiveData` (new Worker var `FORM_SENSITIVE="1"`) and sensitive forms get notification only. Content is cleaned, truncated and escaped per channel. Sending never blocks or fails a submission (Worker `waitUntil`); failures are retried by the outbox cron (5 attempts, `chat:` jobs in the outbox KV), then counted — shown in Settings and as a warning in **Site health**'s Forms check. Rate-limited **Send a test notification** button. On by default and silent until a channel is on and its secret is set; `forms.chat: false` (new kit config, Worker var `FORM_CHAT="0"`) removes it. Scaffold passes the site's forms to `formsPlugin({ forms })` for the picker. Findings: `docs/spikes/chat-notifications-findings.md`.
- **Coming-soon preview link** (Site health → Settings): `?preview=<key>` lets people without an admin account see the site while coming-soon mode is on (a cookie for 7 days, never cached); **New link** replaces the key and ends every old link.
- **One-click redirects from Missing pages** (Site health → Missing pages): **Create redirect** on each row adds a 301 to EmDash's own Redirects — to the suggested page in one click, or to another page of the site through a small form (the sitemap's pages, or a path / https address on this site). Written through the plugin capability `redirects:write` (`ctx.redirects`, the same handler as EmDash's redirects API: write lock, loop and duplicate checks, published redirect artifacts), group `site-health`. Validated first: source a path that is not a page, target a page in the sitemap, not the same address, no existing redirect from the source, target not itself redirected. Other websites cannot be targets (EmDash stores site-relative destinations only). The row leaves the list (redirect sources are left out of the hourly read too), cached pages are purged; logs carry counts, never addresses.
- **Scheduled coming-soon mode** (Site health → Settings): optional **Start at** / **End at** (UTC). The holding page shows inside that window even with the switch off (the switch still forces it on); the end time sets Retry-After and a plain "Back at … UTC" line on the holding page. The middleware, preview link, cache refill and paused checks share one rule (`maintenanceActive`). Site health's 5-minute cron purges the page cache once at each scheduled start and end, so a scheduled switch takes up to 5 minutes. Overview, Settings and the dashboard widget show the schedule.

## [1.1.0] — 2026-11-21

### Added
- **Re-warm after edits** (`performance.rewarmMinutes`, default 15; 0 off): once a site is live on its domain, the Worker's 5-minute cron requests every sitemap page every 15 minutes, so pages an edit purged render there instead of for the next visitor (1.7–2 s → ~0.25 s). Max 120 pages per run.
- **Scaffold gate `csp-inline`**: fails when a component would put a script inline that the Content-Security-Policy blocks (`assetsInlineLimit` not 0, `<script is:inline>` code, `define:vars`, unhashed `set:html`, `on*=` handlers) — before the build, instead of on the live site.
- **Media sitemap** (`/sitemap/media.xml`, closes #14): every generated site's sitemap index now also lists a media sitemap with every picture shown inside a page's sections (hero backgrounds, image and text, columns, cards, galleries, logos, team photos…), a post's body and an entry's image fields, using Google's image sitemap extension (`<image:image>`, the site's own address only, deduped, at most 1,000 per page), and the video sections using the video extension (`<video:video>`: an uploaded file as `content_loc` with its poster as thumbnail; a YouTube link as `player_loc` with YouTube's thumbnail; a Vimeo link when it has a poster). Same entries as the other sitemaps (published, indexable, not behind a password). EmDash 1.5's own sitemaps keep listing one SEO image per entry and no videos. Route-cached and purged with the pages. Background videos (decoration) and videos without a thumbnail are left out. Verify's `sitemap` gate lists each page once and requests a sample of the listed pictures and video files; the SEO panel and Site health count each sitemap address once.
- **Gutenberg `core/file` and `core/audio`** (parity row `gutenberg`, issue #5): a file block becomes a link to the file plus its download button, both moved into the media library by load (gate `documents`); an audio block becomes the new **`audio` section** (file through the media import like a video, caption, autoplay/loop; starter `Audio.astro` uses EmDash's audio player). Attachment-page links, the PDF preview and unused attributes are reported.
- **`posts_list` section** for Gutenberg `core/latest-posts` and `core/query` loops of posts: how many posts, category filter (WordPress ids → slugs), which parts show (image, date, author, excerpt), posts per row; the starter's `PostsList.astro` lists the newest published posts at render time and refreshes with the `posts` cache tag. Ordering, offset, author/tag/search filters, pagination and other post-template blocks are reported; a site without posts drops the list (info); other post types, or a list on a site without a blog, are `unmapped` errors. Findings: docs/spikes/gutenberg-core-findings.md.
- Extract and load also take `.aac`, `.flac`, `.oga` and `.opus` uploads.
- **Sharing text per page** (`@wp2emdash/seo` 0.3, parity row `og-twitter`, #13): the Open Graph / Twitter title, description and image editors set in Yoast (`_yoast_wpseo_opengraph-*`, `_yoast_wpseo_twitter-*`) or Rank Math (`rank_math_facebook_*`, `rank_math_twitter_*` when not reusing the Facebook values) are carried: transform → IR `seo.social` (variables resolved) → load → the SEO plugin's per-entry store (`plugin:site-seo:social:<collection>:<id>`, new admin route `seo-import`) → its `page:metadata` hook (priority 50, before the sharing-card plugin). Only set fields are printed; Twitter falls back to Open Graph, then to EmDash's SEO title, description and image (or the sharing card). The Open Graph image stays the entry's EmDash SEO image. Editors change it in the page editor's SEO panel → Social sharing; an edited value is never overwritten by a rerun of load. New load check `seo-social`.
- **Archive SEO** (`@wp2emdash/seo` 0.3, parity row `term-meta`, #10): per-term SEO title, meta description, noindex and sharing text of category, tag and collection term archives, from Yoast's `wpseo_taxonomy_meta` and Rank Math's term meta (rows of `<prefix>termmeta`, now read from a database dump by `import-options` / `import-dump` into `raw/seo-termmeta.json`), variables resolved (`%%term_title%%`, `%term%`, separator from `wpseo_titles` / Rank Math) → `ir/term-seo.json` → the SEO plugin's per-term store (`plugin:site-seo:term:<taxonomy>:<slug>`). The starter's archives print its title, description and noindex; the plugin adds the head tags. New dashboard tab Plugins → SEO → Archives to edit them. Coverage report section "Term SEO" lists what is carried and what is not (taxonomies without archives; an SEO plugin without a dump).
- Owner overrides (`overrides.ts seo`): a path may also set `ogTitle`, `ogDescription`, `twitterTitle`, `twitterDescription`, and may be a term archive path (`/category/news/`) to set that archive's SEO text.

### Changed
- Section library: 23 block types (was 21). `PostCard`/`PostMeta` accept which parts to show (defaults unchanged, except that the byline no longer starts with " · " when a post has no date).
- Entry SEO fallbacks (no audited live page) resolve Yoast `%%…%%` variables and use the old site's separator instead of "-". Scaffold passes the site's term archive bases to the SEO plugin (`archives`); the plugin declares `taxonomies:read`. Synthetic fixtures + goldens (`test/fixtures/term-seo`, `test/golden/term-seo`); not yet run on a real site (`docs/spikes/seo-social-findings.md`).

## [1.0.0] — 2026-11-21

First public release. The full pipeline (init → audit → extract → transform → scaffold → load → verify → cutover) with
gates; adapters for WPBakery/Salient, Gutenberg (and Kadence, Spectra, GenerateBlocks, Stackable, CoBlocks), classic,
Bricks, Elementor and Divi, plus a DOM fallback for other builders; blog, custom post types, comments, forms, media,
menus, widgets, search, SEO, redirects and every old address accounted for; nine PixelKraft plugins in the client's
EmDash admin; single-environment deploys with owner-approved go-live and rollback. WordPress parity: 83 of 103
in-scope features done, none missing ([docs/parity/wp-to-emdash.md](docs/parity/wp-to-emdash.md)). Two real sites
migrated with it; features marked "not yet run on a real site" are tested on synthetic fixtures only.

### Added
- **Motion** (`@wp2emdash/motion` 0.1, a PixelKraft plugin; `motionPanel: false` removes it): Plugins → Motion (admins only) to switch on a first-visit logo preloader (once per session, 1.2 s cap, never for bots or reduced motion), page transitions (cross-document View Transitions: fade or slide-up, duration), element entrances (as built / off / calm / standard — kit.config `motion` stays the migration's default), hover lift, smooth anchor scrolling, image fade-in, the old site's parallax on/off and a scroll progress bar. Every new option is off by default; reduced motion is always respected; with everything off pages are byte-identical. One stylesheet (4.7 KB) and one script (2.5 KB), each loaded only when an option needs it; the panel shows the KB, offers a preview link for unsaved settings (editors only, never cached) and purges cached pages on save. Tried in a browser on a staging site: preloader shown on the first page and gone by ~0.9 s, not on the next page, transitions active, no CSP errors (`docs/spikes/motion-findings.md`).
- **Media folders** (parity row `media-folders`): folders from FileBird and Real Media Library (a database dump's tables, via `import-dump`) and from attachment taxonomies over REST (Enhanced Media Library, Folders, HappyFiles) become EmDash media folders ("Parent / Child", EmDash folders are flat); plan in `ir/media-folders.json`, coverage report section "Media folders"; load creates missing folders, uploads into them and files earlier uploads only while they are unfiled (new check `media-folders`). Synthetic fixtures + golden; not yet run on a real site (`docs/spikes/media-folders-findings.md`).
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

- **SEO rules on every page** ([docs/seo-rules.md](docs/seo-rules.md)): one `<h1>` and no skipped heading levels (the middleware re-levels headings in `<main>` before caching, keeping their look), a visually hidden `<h1>` on heading-less pages, the logo in 1x/2x with `srcset`, `/llms.txt`; verify check `seo-rules`; `overrides.ts seo` for titles and descriptions the owner rewrites after an audit.

- Contact icons beside a form (phone, email, address, hours) are carried: each lands on the line it stands for (a `tel:` link, an email, a street address, opening hours), drawn by the starter in front of the line.

### Fixed
- Backups: the off-site copy was signed with the wall clock instead of the run's clock (a test failed on any day but the one it was written; found by the release checklist's fresh-clone run).
- An inlined component script (the comment form, under Astro's 4 KB inline limit) was blocked by the public CSP on every page: generated projects never inline scripts (`vite.build.assetsInlineLimit: 0`) and the comment script renders only where the comment form does.
- Verify crashed before the old-address check (`archivePaths` used before it was defined).
- Verify's menu capture clicked the consent banner's button instead of the burger, and screenshots accepted the kit's own banner instead of rejecting it: banners are now rejected or hidden on both sides (`src/audit/consent-banners.ts`).
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
