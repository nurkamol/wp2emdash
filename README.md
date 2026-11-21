<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/logo-light.svg">
    <img src="assets/logo-light.svg" width="420" alt="wp2emdash — WordPress to EmDash, proven by gates">
  </picture>
</p>

<p align="center"><strong>Move a WordPress site to EmDash on Cloudflare, and prove nothing was lost.</strong></p>

<p align="center">
  <a href="https://github.com/nurkamol/wp2emdash/actions/workflows/ci.yml"><img alt="CI status" src="https://github.com/nurkamol/wp2emdash/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-F6821F"></a>
  <img alt="Node.js 24 or newer" src="https://img.shields.io/badge/node-%E2%89%A524-171717?logo=nodedotjs&logoColor=white">
  <img alt="Tests: 1348 passing" src="https://img.shields.io/badge/tests-1348%20passing-1F9D6B">
</p>

wp2emdash is an open-source kit, built by [Nurkamol Vokhidov](https://github.com/nurkamol) at [PixelKraft](https://pixelkraft.net), that migrates WordPress sites to
[EmDash](https://docs.emdashcms.com/) (Astro on Cloudflare Workers, D1 and R2). It rebuilds builder pages as editable
EmDash sections, carries content, media, menus, forms, SEO and old URLs, ships each site with an in-house admin plugin
suite, and stops at an automated gate whenever the result does not match the live site.

**Status.** The full pipeline (`init` → `verify`) runs end to end on two real sites, a WPBakery/Salient site and a
Bricks site. On the WPBakery/Salient site: 0 unmapped content, 100% of live page text carried over, loaded
idempotently into EmDash and compared with the live WordPress site section by section at phone, tablet and desktop
widths. The cutover preflight is implemented; `golive` and `publish` are built and unit-tested against mocked Cloudflare and GitHub, not yet run on a
launch. Per-milestone status: [docs/PLAN.md §13](docs/PLAN.md#13-milestones). What changed: [CHANGELOG.md](CHANGELOG.md).

**Requires** Node.js 24+ and pnpm. Generated sites run on Cloudflare Workers (Workers Paid plan: the EmDash Worker is
above the free plan's 3 MB limit) with the latest Astro that EmDash supports.

## Contents

- [Quick start](#quick-start)
- [How it works](#how-it-works)
- [What gets migrated](#what-gets-migrated)
- [Commands](#commands)
- [Plugin suite](#plugin-suite)
- [Environments](#environments)
- [Launch](#launch)
- [Performance and security](#performance-and-security)
- [Dashboard](#dashboard) · [Claude Code](#claude-code)
- [Working with site workspaces](#working-with-site-workspaces)
- [Docs](#docs)
- [Privacy](#privacy) · [License](#license)

## Quick start

```bash
pnpm install
cp .env.example .env       # Cloudflare token: see docs/cloudflare-api-token.md
pnpm wp2emdash doctor      # check prerequisites (verifies the token)
pnpm wp2emdash             # asks how you want to work: Terminal or Web dashboard
```

**Terminal or web.** The first question is how you want to work: **Terminal** (guided steps: create a site, run
each phase, accept gates) or **Web dashboard** (opens in the browser: every site, launch readiness, live runs and
the visual review). The choice is remembered on this machine (`.wp2emdash.local.json`, not committed);
`WP2EMDASH_MODE=terminal` or `WP2EMDASH_MODE=web` skips the question. The dashboard reviews, approves and takes
secrets; creating a site and recording gates are done in the terminal.

Or without the wizard:

```bash
pnpm wp2emdash init --slug acme --name "Acme Clinic" --source https://acme.com --sensitive
# tick the (required) items in sites/acme/ACCESS.md
pnpm wp2emdash run acme init
pnpm wp2emdash run acme audit        # then extract, transform, scaffold, load, verify, cutover
pnpm wp2emdash status
pnpm wp2emdash ui                    # local dashboard in the browser (--no-open to only print the URL)
```

## How it works

`init → audit → extract → transform → scaffold → load → verify → cutover`. Each phase ends in a gate: a list of
checks, each with an id, a label and pass/fail. The next phase runs only when every earlier gate has passed or was
accepted by the owner with a recorded reason (`wp2emdash accept`). The terminal, CI, the dashboard and Claude Code
all read the same gate data. State lives in `sites/<slug>/state.json`, progress events in `sites/<slug>/runs/`.

| Phase | Does | Status |
|---|---|---|
| `init` | Workspace, config, access & backup checklist (`ACCESS.md`) | ✅ |
| `audit` | Crawl the public site: snapshots, screenshots, design tokens, menu motion, forms & integrations scan, builder fingerprint | ✅ |
| `extract` | EmDash Exporter API (read-only): raw content, meta, SEO, menus, forms, plugin exports, media download | ✅ |
| `transform` | WPBakery/Salient, Gutenberg, classic and Bricks content → a typed section IR; posts, taxonomies, bylines, custom post types and fields; site-wide snippets, consent, settings, WordPress URL rules; gates for coverage, text conservation, content types and snippets | ✅ |
| `scaffold` | EmDash project: section library, design tokens, header/menu motion, forms, plugin suite, performance package, seed; client README, docs and GitHub CI; builds and type-checks | ✅ |
| `load` | Media, content, menus, taxonomies, bylines, redirects, settings and sharing images into EmDash through its API; idempotent id-map. Default target: production (`workers.dev`) on a provisioned single-environment site, else local; after go-live only with `--force` and a D1 bookmark | ✅ local, staging, production |
| `verify` | Old site vs new, URL by URL: text, headings, SEO (og:image, structured data, sitemap), every old address accounted for, links, forms, analytics and consent in a real browser, security headers, route cache and payload, section-by-section visual diff, no sideways scroll, a11y, menu motion; HTML report | ✅ · visual sections over the threshold are fixed or go to the owner |
| `cutover` | Read-only preflight (resources, secrets, Turnstile, separate zone-scoped go-live token, zone and DNS, alias domains, runbook), then the owner-approved switch with `wp2emdash golive` (see [Launch](#launch)) | Preflight ✅ · `golive` unit-tested, not yet run on a launch |

## What gets migrated

Nothing the old site had is dropped silently: whatever the kit does not carry is listed in `reports/transform/coverage.md` and keeps a gate red until it is decided in `overrides.ts` (with the owner's reason; `decisions.md` holds the longer story). Full feature matrix: [WordPress → EmDash parity](docs/parity/wp-to-emdash.md).

| WordPress | On the new site |
|---|---|
| Pages (WPBakery/Salient, Gutenberg incl. Kadence/Spectra/GenerateBlocks/Stackable/CoBlocks blocks, classic, Bricks, Elementor, Divi), header/footer, menus, popups, announcement bar, forms, media in use, SEO meta, JSON-LD, analytics, plugin redirects | Migrated |
| Pages of any other builder or theme (Avada, Oxygen, Beaver Builder, Brizy, Thrive, SiteOrigin, Breakdance, Visual Composer, Flatsome, Enfold…) | Rebuilt from the live page's rendered HTML (DOM fallback): sections, columns, text, images, buttons, embeds, forms, FAQ/tabs/testimonials/galleries where the markup is unambiguous; flagged on every page and held by the transform gate `dom-fallback-reviewed` until the owner has compared each page with the live one (`overrides.ts domFallbackReviewed`) |
| Comments (approved, threaded) | EmDash comments with their WordPress date, author name and thread (one level), shown under posts and entries with a moderated comment form (Turnstile, honeypot); pending only with `comments.includePending`; spam, trash and pingbacks counted, not imported; off on `sensitiveData` sites until decided |
| Password-protected pages and posts | Published behind the starter's password page with the WordPress password (read by extract as an editor and kept as a salted hash only; the owner can change it in the admin's *Access password* field): an accessible form, a signed cookie per page for 10 days, rate limited; never cached (`Cache-Control: private, no-store`), noindex, not in the sitemap, posts' text out of the search index. A page whose password cannot be read takes `WP2EMDASH_PROTECTED_PASSWORD` from the site's `.env`. Other choices: `protectedContent: { password: { as: "draft" \| "skip" \| "publish", reason } }` |
| Private pages and posts | Drafts (editors see them, visitors get a 404, as on WordPress); `protectedContent: { private: { as: "skip" \| "publish", reason } }` |
| PDFs and documents linked in content | Every upload a page links to (PDF, Word, Excel, PowerPoint, OpenDocument, ZIP, audio…) goes into the media library and the link points at it; library documents nobody links are uploaded too (`media: { library: "documents" }`, default; `"referenced"` or `"all"`), so old links from emails and other sites still reach the file through the old address. Same file twice → one media item. Alt text and captions are carried; attachment titles and descriptions have no field in EmDash and are listed by load. EmDash serves documents as downloads (a PDF no longer opens in the browser tab) |
| Media folders (FileBird, Real Media Library, Enhanced Media Library, Folders, HappyFiles) | EmDash media folders. EmDash folders are flat, so a tree becomes names like "Photos / Classes". Attachment taxonomies come over REST; FileBird and Real Media Library folders come from a backup's database.sql (`import-dump`). A file in several folders goes to the first one (counted in the coverage report → Media folders). Load creates the missing folders, reuses a folder an editor already made with the same name, and files only items still in the Main library: an editor's folders and filing are never changed. Other folder plugins are reported, not guessed |
| Forms: Contact Form 7, Gravity Forms, WPForms, Fluent Forms, Ninja Forms, Formidable, WS Form, Forminator, Elementor Pro, Bricks | Rebuilt as the site's own forms from each plugin's export file (Fluent over REST; a live form without an export is rebuilt from the page's HTML and flagged for review): fields, required marks, options, file uploads (private storage, one-time download links in the email, size/type limits; off on sensitive sites unless the owner allows), simple conditional fields (show when another field has a value), multi-step forms; recipients are never copied (kit config decides). Payment fields keep the scaffold gate red (out of scope); logic the new form cannot express is reported |
| Plugin and theme shortcodes in content | A registry (`src/adapters/shortcodes.ts`): form shortcodes → form sections, `[rank_math_breadcrumb]`/`[yoast-breadcrumb]` → flagged for the theme's breadcrumbs, layout leftovers (`[row]`, `[one_half]`, `[su_box]`…) → removed with their content kept, `[button]` → a button, share/social/review widgets → reported, content widgets (tables, sliders, galleries…) and unknown shortcodes → gate `unmapped` red; coverage report "Shortcodes" lists each one with its count and a sample page |
| Blog posts (Gutenberg, classic, WPBakery, Bricks) | A `posts` collection, only on sites that have posts (or `blog: true` in kit.config): Gutenberg/classic bodies as EmDash Portable Text (EmDash's own converter after the kit's shortcode pass: `[caption]`, `[gallery]`, `[embed]`, `[audio]`, `[video]`, oEmbed URLs), builder posts keep their sections; at their WordPress address with the WordPress publish date, excerpt, featured image, sticky → "featured", post format, SEO; scheduled posts scheduled; drafts as drafts; private and password-protected posts need `protectedPosts: { as: "draft" \| "skip" \| "publish", reason }` |
| Categories, tags, custom taxonomies of posts | EmDash taxonomies with every term (hierarchy and descriptions kept) and each post's assignments |
| Authors with posts | Guest bylines (name, bio, an avatar the site hosted; no emails, no user accounts), credited on their posts. Skip with `authors: { as: "skip", reason }` |
| Posts page, category/tag/author archives, `/page/N/`, feeds | Rebuilt at the WordPress addresses: posts page (sticky posts first), archives with numbered pages, single post with byline, terms, author box, newer/older and related posts; RSS 2.0 at `/feed/` and `/category/<slug>/feed/` (…tag, author) with autodiscovery; archives in the sitemap. Date archives 301 to the posts page. Details: [blog findings](docs/spikes/blog-findings.md) |
| Custom post types (team, services, portfolio, locations…) | Each public type becomes its own EmDash collection (change it with `contentTypes: { team: { as: "collection", name?: "people" } }`, or `{ as: "pages" \| "skip", reason }`): title, slug, status, dates, featured image, excerpt, content (classic → Portable Text; WPBakery/Bricks/Gutenberg entries keep their sections), order, parent, terms of their taxonomies, byline; at their WordPress address, with an archive (numbered pages) where WordPress had one and term archives at the live bases; in the sitemap; editing guide `docs/editing-custom-content.md` in the client repo. Types the Exporter does not list as public still need a decision. Details: [CPT findings](docs/spikes/cpt-findings.md) |
| ACF, Meta Box and Pods fields | Mapped to EmDash fields from the field definitions (ACF field groups, or the plugins' JSON exports dropped in `raw/plugin-exports/`): text → string/text, WYSIWYG → Portable Text, number, true/false, select/radio/checkbox, date/time, URL, image, file, gallery → repeater of images, relationship/post object → references (resolved after every entry exists), flat repeaters → repeaters, groups → one field per sub-field; flexible content, links, maps and nested repeaters are kept as JSON fields and flagged in the coverage report; password fields are never carried. Meta without a definition is listed and keeps gate `cpt-fields` red until mapped (`fields: { legacy_code: "string" }`) or skipped |
| Taxonomies no migrated content uses | Listed; `taxonomies: { genre: { as: "skip", reason } }` |
| Page order, parent page, page excerpt and featured image | Fields on EmDash's `pages` (`menu_order`, `parent` reference, `excerpt`, `featured_image`), added only for the ones the site actually uses; addresses stay as they were. The featured image is carried, not drawn on the page (the coverage report counts the live pages whose theme showed it); it also becomes the page's sharing and sitemap image when the page has none of its own |
| Reusable blocks / synced patterns | Still inlined where pages used them, and each one also becomes an EmDash **section** (admin → Sections, inserted into rich text with `/section`; EmDash inserts a copy, so sections are not synced) |
| Term descriptions; Yoast / Rank Math term SEO | Descriptions go to the EmDash term (shown under the archive heading and as its meta description; an empty one on an existing term is filled, an editor's is kept). Per-term SEO title, description, noindex and sharing text (from a database dump) go to the SEO plugin's archive store: the archive's title and head tags use them, editable in Plugins → SEO → Archives |
| Users and roles | **No accounts are created and passwords never move.** Extract (administrator's application password) reads names, e-mail addresses and roles into an invite checklist in `sites/<slug>/users/` (gitignored; reports and client docs get counts per role only): administrator → Admin, editor → Editor, author → Author, contributor → Contributor; subscribers and plugin roles only when `overrides.ts users.roles` says so. The owner invites people from it in the admin, or runs `wp2emdash invite <slug> --send` |
| Past form entries | Never read. The client go-live checklist has the owner export them from each form plugin before the switch (they disappear with WordPress hosting) |
| Menus (every location: primary, secondary, footer, social, menus without a location) | Every WordPress menu becomes an EmDash menu (the header reads `primary` and `secondary`; a classic footer without a footer site part shows `footer`), all nesting levels, new-tab targets, the item's own CSS classes and title attribute. Item descriptions (EmDash has no field) are listed in the coverage report. Mega menus (Max Mega Menu, theme `megamenu` classes) → **partial**: columns of links in the menu panel; images, widgets and HTML inside the panel are reported, not carried |
| Widgets and sidebars (classic themes) | EmDash widget areas, one per WordPress sidebar (`wp/v2/sidebars` + `wp/v2/widgets`, or a database dump's `sidebars_widgets`): Text, Custom HTML and block widgets → content widgets (Portable Text, images in the media library), Image → image (its link reported), Navigation Menu → menu widget, Search / Recent Posts / Categories / Archives / Tag Cloud → EmDash's core widgets (blog ones only on a blog site). Shown where the old theme showed them: footer areas as footer columns, the blog sidebar next to posts and listings. Any other widget keeps gate `widgets-handled` red until `widgets: { "calendar-2": "html" \| "skip" }` |
| Site search (`/?s=`, `/search/<terms>/`) | The starter's search page at `/search/?q=` (EmDash full-text search over posts and collections, page titles, plus the text of every page's sections): ranked results with type and excerpt, matched words marked, numbered pages, a no-results state; results never cached, the empty form cached like a page. A search icon in the header when the old header had one; a migrated `/search/` page shows above the form |
| Breadcrumbs (Rank Math, Yoast, Breadcrumb NavXT, theme) | Shown on pages and/or posts when the old site showed them, with the same trail as the BreadcrumbList structured data |
| The 404 page | Its own wording, when the old 404 page had more than the theme's stock text (audit fetches `/wp2emdash-404-check/`): the site part “not-found”, editable. After launch Site health lists the most requested missing addresses each week with suggested redirects |
| Maintenance / coming-soon plugins | Reported; never switched on by the migration. The new site has its own coming-soon mode (Site health → Settings): a branded holding page with 503 + Retry-After and noindex, signed-in people see the site |
| Sites without a blog: feeds, category/tag/author/date archives, attachment pages, `?cat=` `?tag=` `?author=` `?attachment_id=` `?feed=` `?m=` (blog sites: attachment pages, comment feeds and date archives) | One 301 to the most sensible migrated page, or a 410, by a rule set decided per site (coverage report → "WordPress URLs"; change with `wpUrls: { feed: "/blog/" \| "home" \| "gone", … }`). Defaults and the feed SEO reasoning: [wp-urls findings](docs/spikes/wp-urls-findings.md) |
| `/?p=`, `/?page_id=`, old upload and sitemap URLs | 301 to the page, the post or the file in the media library; unknown ids answer 404 |
| Customizer "Additional CSS" | Reported (size, selectors, media queries, images, external imports); carried only with `customCss: "carry"`, as its own stylesheet loaded after the starter's CSS (never inline) |
| Anything else the old site answered | Verify gate `urls-accounted`: every audited address answers 200, one 301 to a 200, or 404/410 only by decision (`gone: { "/locations.kml": "reason" }`, patterns with `*`) |

### Builders and editors

| Source | Status |
|---|---|
| WPBakery + Salient (`vc_*`, `nectar_*`) | Supported: ~70 element handlers and row recognisers, measured against a real site |
| Gutenberg (30 core blocks, reusable blocks) and the classic editor | Supported |
| Gutenberg block libraries: Kadence Blocks, Spectra, GenerateBlocks, Stackable, CoBlocks | Built (row/column/container layouts, advanced heading, buttons, icon list, info box, tabs, accordion, testimonials, team, counters, pricing, maps, galleries, form blocks); not yet run on a real site. Other library blocks keep their text and are reported; Otter and Stackable v2 are not mapped |
| Bricks 2.4.6 / 2.5 | Supported: elements, templates, global classes, palette, components, forms; measured against a real site |
| Elementor | Built (containers and legacy sections, Kit globals, Theme Builder, Pro forms and popups); not yet run on a real Elementor site |
| Divi 4 (`et_pb_*` shortcodes) | Built, not yet run on a real Divi site: regular/specialty/fullwidth sections, ~30 modules (text, image, button, blurb, CTA, slider/fullwidth header, gallery, video, testimonial, team, pricing, accordion/toggle/tabs, contact form, code, social follow, map, counters, menu), global colours, Theme Builder header/footer |
| Divi 5 (`divi/` blocks) | Best effort: converted to the Divi 4 reader and flagged in the coverage report; unverified on a real Divi 5 site |
| Beaver Builder, Oxygen, Avada, Breakdance, Brizy, Thrive, SiteOrigin, Visual Composer, Flatsome, Enfold, theme markup | DOM fallback (built 2026-11-21, not yet run on a real site): no dedicated adapter; pages are rebuilt from the audit's saved HTML, flagged, and gated until reviewed. Styling set in stylesheets is not carried, and content a script draws after load is missing ([findings](docs/spikes/dom-fallback-findings.md)) |

Comments: in progress (extracted today, not yet loaded).

### Plugin data (forms and redirects)

The REST API does not expose most plugins' settings. After the audit, `ACCESS.md` gets a **Plugin data** section
listing, for every forms or redirects plugin it found, the exact export steps in WordPress admin. The owner exports;
the files go in `sites/<slug>/raw/plugin-exports/` (any file name). `extract` recognises each file by its content:

| Plugin | Export | Becomes |
|---|---|---|
| Fluent Forms | read over REST automatically; Tools → Export Forms as a fallback | site form |
| Gravity Forms | Forms → Import/Export → Export Forms (.json) | site form |
| WPForms | WPForms → Tools → Export → Form Exports (.json) | site form |
| Contact Form 7 | Tools → Export → Contact Forms (.xml) | site form |
| Redirection | Tools → Redirection → Import/Export → Everything, JSON | EmDash redirects |
| Rank Math | Redirections → Export (.htaccess or Nginx) | EmDash redirects |
| Yoast SEO Premium | Redirects → Export (.csv); any `from,to,code` CSV works too | EmDash redirects |

Forms keep their fields, labels, required flags, options, button text and success message. Notification recipients
stay in `raw/` and are set in the site's admin (Form messages → Settings), never written into the project. `load`
imports the redirects into EmDash (group `wordpress`, so a rerun updates them and never touches redirects added in the
admin). Rules EmDash cannot hold (conditional rules, complex regular expressions, redirects to another site) are
listed in `raw/redirects.json` → `unconverted` and fail the extract gate until handled or accepted: nothing is dropped
silently. Ninja Forms and Formidable exports are flagged for a rebuild by hand.

### Site settings

EmDash's own **Settings → General, Social Links and SEO** come prefilled from the WordPress site, and the starter reads
them on every page, so editors change the logo, favicon, social profiles, verification tags, default social image and
robots.txt in the admin and the live site follows within seconds (the save purges cached pages):

| Setting | From WordPress | The starter |
|---|---|---|
| Logo, favicon | brand files captured from the live header (`public/brand`), else `custom_logo` / `site_icon` | header, menu sheet, structured data; favicon + apple-touch icon. While the setting is the migrated file, the optimized brand files stay (hashed WebP, sized favicons, light logo over the hero) |
| Posts per page, date format, timezone | `posts_per_page`, `date_format` (→ date-fns), `timezone_string` / `gmt_offset` | (EmDash's own use) |
| Social Links | Rank Math / Yoast social options, home-page JSON-LD `sameAs`, social links in the header/footer | footer social links/icons and the menu sheet's icons point at them; a network missing from the footer's icon row is added; JSON-LD `sameAs` |
| Default social image | Rank Math / Yoast default, else the og:image most pages share | og:image of pages without their own (EmDash's head) with its size |
| Google / Bing verification | audited page head, else the SEO plugin | printed by EmDash's head; `site.config.json` → `verification` is the fallback and keeps other services' tags |
| robots.txt | the live file's own rules (WordPress-only rules dropped, sitemap at the new domain); none → EmDash's default | served by EmDash |

Every value and its source is in the transform coverage report. `load` never overwrites a value an editor changed
after the previous load (`--overwrite-settings` does). Facts and limits: [settings findings](docs/spikes/settings-findings.md).

### Widgets and site-wide snippets

One **provider registry** (`starter/src/utils/providers.ts`, imported by the kit as `src/providers/registry.ts`) lists
every third-party widget the kit knows: how it is recognised, its category, and the hosts it may load from. The
adapters use it to keep a widget in page content as an `embed` section; the starter uses the same table for the embed
allowlist and the Content-Security-Policy, so nothing an embed needs is blocked and nothing else is allowed. A
Gutenberg embed block stores only the URL; for X, TikTok, Instagram, Reddit, Pinterest, Dailymotion, TED, Spotify, Loom
and Mixcloud the adapter writes the provider's official embed code from it. An Adobe Fonts project the old site loaded
(CSS embed) is kept, and Typekit's hosts join the CSP only on such a site.

| Category | Providers |
|---|---|
| Booking & calendars | Mariana Tek, Momence, Jane, Calendly, Acuity, SimplePractice, Mindbody, Google Calendar, Vagaro, Glofox, Zenoti, Square Appointments, Booksy, Fresha, OpenTable, Resy, Tock, Arketa, ClassPass |
| Video, audio, social | YouTube, Vimeo, Wistia, Loom, Dailymotion, TED, Twitch, Spotify, SoundCloud, Mixcloud, Bandcamp, Apple Podcasts/Music, Instagram, TikTok, Facebook page/video, X (Twitter), Pinterest, Reddit, Bluesky |
| Forms, maps, newsletter | Typeform, Jotform, HubSpot forms, Google Forms, Google Maps, Mailchimp |
| Reviews | Elfsight, Trustindex, Trustpilot (in content); Elfsight and Trustindex also as site widgets |
| Site widgets (by ID) | Chat: Tawk.to, Crisp, Intercom, HubSpot (tracking code & chat). Consent: CookieYes, Cookiebot, Termly, iubenda |

**Site-wide snippets.** Theme custom code, WPCode, Insert Headers and Footers, Header Footer Code Manager and plugin
widgets put code in `<head>` and at the end of `<body>` on every page. `transform` reads it from the audit's saved
pages (and from a Header Footer Code Manager export that `import-dump` put in `raw/code-snippets.json`), removes
duplicates across pages, classifies every `<script>`, `<noscript>`, `<iframe>`, `<link>` and `<meta>`, and writes
`ir/site-snippets.json` and a **Site-wide snippets** section in the coverage report:

| Found | What happens |
|---|---|
| Trackers (Google tag, GTM, Meta Pixel, Clarity, Hotjar, Cloudflare beacon) | carried by SEO & Analytics (by ID) |
| Verification meta (Google, Bing, Pinterest, Facebook…) | carried → Settings → SEO |
| Canonical, description, Open Graph, icons, JSON-LD, Google Fonts | rebuilt by the starter and the SEO plugin |
| A booking/video provider's loader (e.g. Mariana Tek) | carried with that provider's embed sections (a section without a loader gets the site-wide script) |
| Chat, reviews badge, consent tool with a readable ID | carried as a **site widget**: `siteWidgets` in `site.config.json`, loaded by `components/SiteWidgets.astro` from provider + ID only — never free-form code; production domain only, never for signed-in editors; CSP from the registry. A consent tool is loaded before analytics, and CookieYes / Cookiebot acceptance of statistics cookies calls the analytics consent hook |
| WordPress, theme, plugin, CDN-library and Cloudflare-edge internals (jQuery, emoji, wp-embed, builder runtimes, plugin CSS/JS, email obfuscation) | not needed — listed, collapsed |
| Anything else (unknown inline or external code, child-theme scripts, legacy iubenda config, markup in a snippet, a provider loaded site-wide that no page embeds, a widget whose snippet carries no ID) | **never carried automatically**: the transform gate `site-snippets` fails until each is decided in `overrides.ts` → `snippets: { "sn-…": "drop" \| "rebuilt" }` (the report prints the block to paste; the reason goes in `decisions.md`) |

`kit.config.ts` → `siteWidgets` overrides what was recognised: a list (`[{ provider: "crisp", id: "…" }]`) is exactly
those, `false` is none. Host lists and their sources: [docs/spikes/providers-findings.md](docs/spikes/providers-findings.md).

## Commands

Run as `pnpm wp2emdash <command>`; `pnpm wp2emdash <command> --help` lists every option.

| Command | What it does |
|---|---|
| `wp2emdash` | Interactive wizard (terminal or web dashboard) |
| `init --slug … --name … --source …` | Create `sites/<slug>/` (`--sensitive` for health, legal or finance sites; `--production <url>`; `--from <slug>` to start from another site's settings) |
| `run <slug> <phase> [--json] [--preview]` | Run a phase; exit 0 pass · 2 gate failed · 3 not built yet · 1 error. `--preview` runs a read-only phase out of order without recording the gate |
| `run <slug> load --force` | Load into a **live** production (after go-live): records a D1 Time Travel bookmark first and prints the restore command; refused without `--force` |
| `run <slug> load --only settings` | Apply Settings (General, Social Links, SEO) only, without touching pages, media, menus or redirects: the safe way to update a live site's settings |
| `run <slug> load --overwrite-settings` | Also replace settings an editor changed in the admin since the last load; without it those are kept and reported |
| `accept <slug> <phase> --reason "…" --by "…"` | Record the owner's acceptance of a failed gate |
| `status [slug] [--json]` | Phase timeline for one or all sites |
| `phases` | List the pipeline phases |
| `doctor [--json]` | Local prerequisites; verifies the Cloudflare token and the EmDash encryption key format |
| `provision <slug> [production\|staging] [--location <hint>]` | Create or reuse D1, R2, the form outbox and the sign-in sessions bucket in the environment's account; record them in `cloudflare.json`. Default `production`; `staging` only for sites that opted in |
| `import-dump <slug> [dir]` | Sort everything exported from the site (`sites/<slug>/dump/`) into the places the phases read |
| `import-options <slug> <dump>` | Read builder settings (Bricks palette, global classes, theme styles, components) from a backup's `database.sql` |
| `compare <a> <b> [--json]` | Content diff between two audited sites (read-only, no network) |
| `invite <slug> [--send]` | Team invites from the WordPress users (counts per role). `--send` creates them through EmDash (it e-mails them when the site has an e-mail provider; otherwise the kit stops and the owner invites from the admin) — the owner's step, never part of load |
| `check-aliases <slug> [--paths-from <slugs>]` | Every audited path on each alias domain answers 301 to the same path on the primary (read-only) |
| `golive <slug> [--yes]` | The owner-approved traffic switch (see [Launch](#launch)). Plan only without `--yes` |
| `golive <slug> --aliases [--yes]` | Separate step once the primary is live: one Single Redirect rule per alias domain |
| `golive <slug> --rollback [--aliases] [--yes]` | Delete exactly the routes / rules recorded in `cutover/golive.json`; `production.live = false` |
| `publish <slug> [--repo owner/name] [--yes]` | Project → private GitHub repository: secret scan (file names only), commit, `gh repo create --private`, push, `CLOUDFLARE_ACCOUNT_ID` variable. Never sets the token secret. Plan only without `--yes` |
| `proposals <slug> [approve\|reject <id>] --by "…"` | Approval queue for proposed `overrides.ts` / `decisions.md` changes |
| `ui [--no-open] [--port <n>]` | Local dashboard on 127.0.0.1 |
| `mcp` | MCP server on stdio for Claude Code |

Load and verify targets: `WP2EMDASH_LOAD_TARGET` / `WP2EMDASH_TARGET` = `local`, `staging` or `production`.

## Plugin suite

Every migrated site ships with nine PixelKraft plugins, built as native EmDash admin pages inside the client's
own site (no external service, no extra account). Each is switched in the site's `sites/<slug>/kit.config.ts` and
takes effect at the next `scaffold`.

| Plugin | Package | Admin page (who) | Default | Turn off |
|---|---|---|---|---|
| Sharing images | `@wp2emdash/og` | Plugins → Sharing images (admins) | On | `og: { cards: false }` |
| SEO & Analytics | `@wp2emdash/seo` | SEO panel in the page editor (contributors and up); Plugins → SEO & Analytics (editors; analytics changes: admins) | On | `seo: { panel: false }` |
| Site health & monthly report | `@wp2emdash/health` | Plugins → Site health (admins) | On | `health: false` |
| Privacy & consent | `@wp2emdash/consent` | Plugins → Privacy & consent (admins) | On | `consent: false` |
| Backups & restore | `@wp2emdash/backups` | Plugins → Backups (admins) | On | `backups: false` |
| Media assistant | `@wp2emdash/media` | Plugins → Media (editors and admins) | On | `media: false` |
| Change requests | `@wp2emdash/change-requests` | Plugins → Change requests (editors and admins) | On | `changeRequests: false` |
| Motion | `@wp2emdash/motion` | Plugins → Motion (admins) | On (the panel; every motion option in it starts off) | `motionPanel: false` |
| Form messages | `@wp2emdash/forms` | Plugins → Form messages (admins) | On (off by default on `sensitiveData` sites: storing visitor text is an owner decision there) | `forms: { outbox: false }` |

The form endpoint itself (`@wp2emdash/forms`: Turnstile, rate limit, validation, email delivery) is part of every
site. Form messages (the outbox and its admin page) is on by default too — only messages that could not be emailed are kept, for 30 days — except on `sensitiveData` sites, where storing visitors' text stays an owner decision; `forms: { outbox: false }` turns it off.

### Sharing images

Every page can get its own branded sharing image (og:image): the site's logo, the page title and the site's colours
and fonts on a 1200×630 card, drawn in the Worker the first time it is asked for and stored in R2. On for every site;
to leave it out:

```ts
// sites/<slug>/kit.config.ts
og: { cards: false },
```

The next `scaffold` downloads TrueType copies of the site's fonts, takes the colours from the generated design tokens
and the logo from the brand files, adds the `@wp2emdash/og` package and its two renderer libraries (+1.1 MB gzip to
the Worker), and registers the plugin. After deploying, an admin chooses under **Plugins → Sharing images** whether
cards replace every page's image or only fill in where a page has none (the default), and can preview and redraw
them. Verify downloads every og:image and fails on any that does not load. Details:
[packages/og/README.md](packages/og/README.md).

### SEO & Analytics

Technical SEO is part of every migration (titles, descriptions, canonicals, robots, sitemap, structured data, old
URLs redirected, analytics, verification tags — and verify checks all of it). On top of that, every site gets an SEO
and analytics toolkit for its editors, the EmDash plugin `@wp2emdash/seo`; to leave it out:

```ts
// sites/<slug>/kit.config.ts
seo: { panel: false },
```

| Part | Where | What it does |
|---|---|---|
| **SEO panel** | Page editor sidebar (contributors and up) | Score out of 100, Google result preview with cut-off warnings, plain-words checklist (title and description length, duplicates across pages, one H1, heading order, text length, image alt text, links, address, indexing, canonical, sharing image), focus keyword per page, "Check my unsaved changes". |
| **SEO dashboard** | Plugins → SEO, dashboard widget (editors and admins) | Average score and a score per page, the most common issues and where they are, every page with a link to fix it, every image without a description with a form that writes alt text to the media library, robots.txt / sitemap / indexability checks (environment-aware). |
| **Google Search Console** | SEO dashboard → Google | Connected once with a service account (key stored encrypted): clicks, impressions, click rate, position, daily chart, top searches and pages, sitemaps (submit), index status per page. Works before go-live. |
| **IndexNow** | SEO dashboard → IndexNow | After go-live, publishing a page notifies Bing, Yandex and the other IndexNow engines; key file at the domain root; notification log; notify-all button. |
| **Analytics** | SEO & Analytics → Analytics (changes: admins) | Tracking codes by ID only — GA4, Google tag, Google Ads, Tag Manager, Meta Pixel, Microsoft Clarity, Hotjar, Cloudflare Web Analytics — prefilled with everything the audit found on the old site (retired `UA-` listed, never loaded); on/off, edit, remove; conversion events as switches (form sent, phone/email, booking links, outbound) with no visitor data; consent mode (driven by the built-in [Privacy & consent](#privacy--consent) banner); Google/Bing verification points to EmDash's Settings → SEO, other carried tags listed read-only. Saving purges cached pages: live within seconds. The site loads trackers on the production domain only, never for signed-in editors, and its CSP allows exactly the switched-on services (one host table, `packages/seo/src/analytics/csp.ts`). |
| **Visits** | SEO & Analytics → Visits, dashboard widget (admins), page editor | Cloudflare Web Analytics, last 7 days: visits, page views, daily chart, top pages, referrers; each page's views in its SEO box. Needs the Worker secret `CF_ANALYTICS_TOKEN` (Account Analytics: Read); the site tag is looked up at scaffold. |

No effect on visitors and negligible Worker size. The site checks call the Worker through a `SELF` service binding the
scaffold adds (a Worker fetching its own address would skip itself). Details: [packages/seo/README.md](packages/seo/README.md).

### Site health & monthly report

Every site gets **Plugins → Site health** (admins only; `@wp2emdash/health`, a PixelKraft plugin) and a
dashboard widget: overall status (Healthy / Attention / Down), one row per check with its last run and a 14-day
trend, an incidents timeline, the broken-links table, real-visitor Core Web Vitals, 12 months of reports and the email
settings. To leave it out, or to change the defaults:

```ts
// sites/<slug>/kit.config.ts
health: false,
// or
health: { alertsTo: ["ops@agency.example"], reportTo: ["owner@client.example"], brand: "Prepared by PixelKraft", externalLinks: true, monthlyReport: true },
```

| Check | How often | How |
|---|---|---|
| Uptime | every 5 min | Home page + one sitemap page in rotation (+ retries), through the Worker itself (`SELF`); incident = 2 failures in a row, recovery noted |
| Search engines | hourly | No `noindex` (meta / X-Robots-Tag), canonical host, robots.txt, sitemap answers |
| Form messages | every 15 min | `@wp2emdash/forms` outbox: waiting / refused counts, email status, last emailed day (counts only) |
| Broken links | daily (02–04 UTC), resumable | Every sitemap page, every internal link once (HEAD, GET fallback, 3 at a time, 12 requests a tick); links to other sites: 20 sampled weekly |
| Email DNS | daily | MX/SPF/DMARC/DKIM over DNS-over-HTTPS vs the hashed baseline from `cutover/dns-before.json` |
| Certificate | daily | Optional `CF_ZONE_READ_TOKEN`; otherwise "renewed by Cloudflare" |
| Speed | daily + every probe | Page build time median; Chrome UX Report p75 LCP/INP/CLS with optional `CRUX_API_KEY` |
| Analytics tags | hourly | The page's `site-analytics` tag carries the codes switched on in SEO & Analytics (the browser check stays in verify) |
| Missing pages (404) | hourly | EmDash's own 404 log (one D1 read): the addresses asked for in the last 7 days, most requested first, each with a suggested redirect from the sitemap; bot probes (wp-login.php, .env…) counted, not listed. Tab **Missing pages**, a dashboard hint; never an alert |

**Coming-soon mode** (Settings tab): an admin switches on a branded holding page (logo, heading, message, optional
"expected back" time) for every visitor — HTTP 503 with `Retry-After`, `noindex`, never cached — while anyone signed in
to the admin sees the site. The starter's middleware reads the switch (at most every 30 seconds per isolate). While it
is on, the checks that request the site (uptime, search engines, analytics, links) pause instead of reporting it down.
The migration never switches it on.

Alerts (down / back up, page errors, new broken links, indexability, form email, mail DNS, certificate, analytics)
go to `health.alertsTo` (default `email.stagingTo`) — one email per issue per day, at most six a day, only once the site
is live and never from staging — through the forms package's email path (provider API or EmDash email). On the 1st a
branded HTML report (logo and colours from the design tokens, `health.brand` footer) goes to `health.reportTo` (default
`email.to`) plus the alert recipients: uptime and incidents, speed and CWV, visits/top pages/referrers
(`CF_ANALYTICS_TOKEN`), form message counts, pages published/updated, broken links found/fixed/open, average SEO score.
No form contents or personal data anywhere. Verify gets `health-plugin` (registered; on a live site its checks ran in
the last 30 minutes). Cron design, limits and what was verified: [docs/spikes/health-findings.md](docs/spikes/health-findings.md);
details: [packages/health/README.md](packages/health/README.md).

### Privacy & consent

Every site gets a built-in cookie banner and **Plugins → Privacy & consent** (admins only; `@wp2emdash/consent`, an
built-in wp2emdash plugin). Modes: *off*, *notice* (US style, opt-out), *opt-in* (EU/UK style) and *auto* — the
default: opt-in for visitors from the EU/EEA, UK, Switzerland and Québec (and unknown regions), a notice elsewhere.
The SEO & Analytics trackers and the chat/review widgets follow the visitor's choice: Google Consent Mode v2 starts
denied and Google's scripts load only once allowed; Meta Pixel needs marketing consent (`fbq consent grant/revoke`);
Clarity (`consentv2`) and Hotjar need analytics consent; Cloudflare Web Analytics (cookieless) always runs; Global
Privacy Control keeps marketing off. Pages stay one cached HTML for everyone: the choice lives in the visitor's browser
and the region comes from an uncached `/_consent/region`.

The migration prefills it: a consent service kept as a site widget (CookieYes, Cookiebot, Termly, iubenda) → banner
off (one banner, not two; the admin can switch); a WordPress consent plugin (Complianz, CookieYes, GDPR Cookie
Consent, Cookie Notice, Borlabs, Real Cookie Banner, Moove…) → the built-in banner in that plugin's mode with its
wording (coverage report → Consent banner); the privacy policy page is found by slug.

```ts
// sites/<slug>/kit.config.ts
consent: false,
// or
consent: { mode: "opt-in", position: "card", policy: "/privacy-policy" },
```

Verify: `consent-runtime` on a live site (no analytics or marketing request before interaction, trackers after
"Accept all"; reported as not applicable when the banner shows the notice style from the verifying machine's region);
the banner is part of the existing `a11y` axe pass. Facts and limits: [docs/spikes/consent-findings.md](docs/spikes/consent-findings.md);
details: [packages/consent/README.md](packages/consent/README.md).

### Backups & restore

Every site gets **Plugins → Backups** (admins only; `@wp2emdash/backups`, a PixelKraft plugin). Every night
(01–03 UTC, a minute fixed per site) the Worker writes a read-only export of the site's content to its own R2 bucket
under `backups/<yyyy-mm-dd>/` (compressed JSON, a few KB to a few MB): every collection (drafts and trash too),
revisions, menus, site settings, redirects, sections, widgets, taxonomies, bylines, SEO, the media library's records
and a manifest of the media files (keys, sizes, ETags — the files already live in R2 and are never touched). Never in
a backup: users, passkeys, sessions, API/OAuth tokens, plugin data and secrets, form messages, comments, logs — an
allowlist; every table left out is listed in the file with the reason.

```ts
// sites/<slug>/kit.config.ts
backups: false,
// or
backups: { retention: { daily: 30, monthly: 12 }, hourUtc: 2, alertsTo: ["ops@agency.example"], offsite: { endpoint: "https://<other-account>.r2.cloudflarestorage.com", bucket: "client-backups", prefix: "acme" } },
```

| From the browser (admins) | From the command line (developer) |
|---|---|
| List backups (when, kind, size, what's in it), **Back up now** (single flight, at most every 2 min) | Whole-site restore: `npx wrangler d1 time-travel restore <db> --timestamp=<backup time>` (any minute of the last 30 days) |
| **Download** (one-time link, 2 minutes) | `load --force` / `golive` record a D1 bookmark and a marker the Backups page lists with its restore command |
| **Restore** the settings, the menus or one page from any backup — preview of every change, a fresh backup first, refused if the site changed since the preview | Older than 30 days: settings/menus/pages one by one from the page; a full rebuild from a file is manual |

Kept: 30 daily + the first of each of 12 months (configurable). When an entry is moved to the trash a snapshot of it is
kept first (`content:beforeDelete`). Two failed nightly attempts in a row email `backups.alertsTo` (default
`health.alertsTo`, then `email.stagingTo`); Site health gets a **Backups** check; verify gets `backups-plugin`; the
dashboard's Environment view shows the last backup. Optional off-site copy: any S3-compatible bucket, keys as Worker
secrets `BACKUP_S3_ACCESS_KEY_ID` / `BACKUP_S3_SECRET_ACCESS_KEY` (write-only; lifecycle rules there). Why the plugin and
not EmDash's own Settings → Backups, and what was verified: [docs/spikes/backup-findings.md](docs/spikes/backup-findings.md);
details: [packages/backups/README.md](packages/backups/README.md).

### Media assistant

Every site gets **Plugins → Media** (editors and admins; `@wp2emdash/media`, a PixelKraft plugin): media
health (size by type, oversized originals, images without alt text and where each is used, unused files, duplicates,
formats, broken references — from a read-only scan of the database), **Optimize** (resize + re-encode in place with
the Images binding through EmDash's own Replace, old file kept 30 days, undo), reviewed **alt text suggestions**
(Workers AI, or file names and headings; nothing saved until a person marks it), a nine-position **focal point**, and a
**trash** folder with a 30-day undo (brand files and recent uploads never offered; nothing deleted automatically).
Every file change is preview → confirm. Site health gets a **Media** check.

```ts
// sites/<slug>/kit.config.ts
media: false,
// or
media: { aiAlt: false, autoOptimize: true, maxDimension: 3000, protect: ["^partner-"] },
```

AI alt text is on by default except on `sensitiveData` sites; when on, the scaffold adds `"ai": { "binding": "AI" }`
to wrangler.jsonc. Optional Worker secret `MEDIA_API_TOKEN` lets the hourly task optimize queued uploads. Client guide:
`docs/media.md` in the site repo. Facts and limits: [docs/spikes/media-findings.md](docs/spikes/media-findings.md);
details: [packages/media/README.md](packages/media/README.md).

### Change requests

Every site gets **Plugins → Change requests** (editors and admins; `@wp2emdash/change-requests`, a built-in
wp2emdash plugin): the client asks the agency for a change inside the admin — title, description, page (or anywhere),
priority, up to 3 private screenshots/PDFs, how to get back — and follows its status (New → Seen → In progress →
Waiting for you → Done / Declined) with a comment timeline. The agency (admins) replies and moves the status on the
same page; a "Request a change" editor panel and a dashboard widget come with it. New requests email the agency;
status changes and replies email the requester (opt-out). Optional signed webhook for the agency's tracker.

```ts
// sites/<slug>/kit.config.ts
changeRequests: false,
// or
changeRequests: { agencyTo: ["pm@agency.example"], agencyDomains: ["agency.example"], webhook: "https://hooks.zapier.com/…", retentionMonths: 12 },
```

`agencyTo` defaults to `email.stagingTo`. With `webhook`, put the Worker secret `CHANGE_REQUESTS_WEBHOOK_SECRET`.
Closed requests are deleted with their files after `retentionMonths`; the requests (not their files) are in the
nightly backups. Client guide: `docs/change-requests.md` in the site repo. Facts and limits:
[docs/spikes/change-requests-findings.md](docs/spikes/change-requests-findings.md); details and the webhook payload:
[packages/change-requests/README.md](packages/change-requests/README.md).

### Motion

Every site gets **Plugins → Motion** (admins only; `@wp2emdash/motion`, a PixelKraft plugin), where the owner turns
on the motion a client wants. Everything new starts **off** (speed first): a first-visit logo preloader (once per
browser session, hard cap 1.2 s, never for bots or reduced motion, no layout shift; background from the site's colour
tokens, minimum 0–800 ms), page transitions (fade or slide-up with the cross-document View Transitions API — no
router, no script; Chrome, Edge, Safari 18.2+), and extras: hover lift on cards and buttons, smooth anchor scrolling,
image fade-in, a thin scroll progress bar. Element entrances (calm / standard / off) and the old site's parallax and
drifting columns default to *as the site was built* (kit.config `motion` stays the migration's default), so existing
sites do not change when the panel ships. `prefers-reduced-motion` is always respected (no switch). The page shows
how many KB the switched-on options add and gives a preview link for unsaved settings (signed-in editors, never
cached); saving purges the cached pages.

With everything off the pages are byte-identical to a site without the panel: settings render as attributes and a
class on `<html>` plus at most one stylesheet (`public/styles/site-motion.css`, 4.7 KB, 1.6 KB gzipped) and one script
(`public/scripts/site-motion.js`, 2.5 KB, 1.1 KB gzipped), each linked only when an option needs it; no inline script.

```ts
// sites/<slug>/kit.config.ts
motionPanel: false, // removes the panel (the default is true; the motion itself is always off until an admin turns it on)
```

Facts and limits: [docs/spikes/motion-findings.md](docs/spikes/motion-findings.md); details:
[packages/motion/README.md](packages/motion/README.md).

### Form messages (outbox and inbox)

With `forms.outbox` in a site's `kit.config.ts` (an owner decision: it stores visitors' messages), messages that cannot be emailed are kept in Workers KV, retried by the
Worker's cron and shown to admins under **Plugins → Form messages** (inbox, insights, export/import, activity,
recipients). By default a message is deleted once emailed, so the inbox only ever shows what is still waiting. An owner
who wants to see every message there can opt in to a full inbox:

```ts
// sites/<slug>/kit.config.ts
forms: { outbox: { days: 30, keepSent: true } },   // → FORM_OUTBOX_KEEP_SENT="1" in both environments
```

Every message is then kept, marked **Emailed**, **Waiting** or **Failed**, until `days` ends — with a status filter,
"Email again", and the newest messages on the dashboard widget. This is a **data-retention decision**: what visitors
wrote stays in the site for the retention period even after it was emailed. Record it in the site's `decisions.md`;
on sites with `sensitiveData: true` leave it off unless the owner explicitly asks for an inbox. Details:
[`packages/forms/README.md`](packages/forms/README.md#configuration-wranglerjsonc-per-environment--environments-do-not-inherit).

### Footer credit

Every migrated site gets a small "Website by [PixelKraft](https://pixelkraft.net)" line in its footer, unless the old footer
already carried a credit ("website by", "designed by", "developed by"…), so a site never shows two. Change or remove it per site:

```ts
// sites/<slug>/kit.config.ts
credit: { text: "Website by", name: "Your Studio", url: "https://your.studio" },
// or
credit: false,
```

## Environments

**One Cloudflare environment per site by default: production**, deployed to its `workers.dev` address until go-live
(owner decision 2026-11-20). The client reviews the real site there; nothing public changes until `golive` adds the
Worker routes. Staging is opt-in. Details and commands: [docs/staging-setup.md](docs/staging-setup.md), [docs/PLAN.md §7a](docs/PLAN.md#7a-environments-and-launch-topology).

| | Single environment (default) | Opt-in staging (`target.staging: true`) |
|---|---|---|
| Cloudflare | `<slug>` Worker, `<slug>-db`, `<slug>-media`, `<slug>-sessions` (sign-in sessions), outbox KV | the same, plus `<slug>-staging` with its own D1/R2/KV/secrets |
| Before go-live | production on workers.dev: `noindex`, no analytics, form messages are tests | staging for review; production on workers.dev before the switch |
| `load` / `verify` default | production once provisioned (else local) | load: local; verify: staging |
| Form test messages | any host but the domain (workers.dev, preview URLs) → `email.stagingTo` only, `[Test]` subject, never the client, also from the outbox after launch | staging → `email.stagingTo` only |
| Client CI on push to `main` | deploys production until go-live (`target.ciDeploy`), manual after | deploys staging; production manual |
| After go-live | content edited in the admin; `load --force` takes a D1 Time Travel bookmark first; code changes via Workers preview URLs (`pnpm versions:upload` → `pnpm versions:deploy`) — previews share production's data, so code/layout review only | as before, plus staging |
| EmDash token | `EMDASH_TOKEN_PRODUCTION` (`EMDASH_TOKEN` accepted as an alias) | `EMDASH_TOKEN` = staging, `EMDASH_TOKEN_PRODUCTION` = production |

**Opt into staging** when the client signs off big changes on a copy of the data (redesigns, EmDash upgrades with
migrations), when the site takes bookings, payments or sensitive data (tests must not touch production records), or
when many editors share the admin. Sites that already had staging (a `target.stagingUrl`, or staging resources in
`cloudflare.json`) keep it unchanged; `target.staging: false` turns it off.

## Launch

The switch from WordPress to EmDash is a command, run only after a green (or owner-accepted) cutover preflight:

```bash
pnpm wp2emdash run acme cutover          # read-only preflight: resources, secrets, Turnstile, go-live token, zone, DNS, runbook
pnpm wp2emdash golive acme               # prints the plan: routes, Site URL, live flag, blockers; changes nothing
pnpm wp2emdash golive acme --yes         # after the owner's go-ahead
pnpm wp2emdash golive acme --rollback --yes
```

`golive --yes` creates the Worker routes for apex and `www` (idempotent; refuses routes pointing elsewhere), sets
EmDash's Site URL to the real domain, smoke-tests the domain (200s, canonical host, no `noindex`), compares DNS with
the preflight snapshot, records `production.live` and the route ids in `cutover/golive.json`, and switches the
`workers.dev` address off (`target.keepWorkersDev` keeps it). `--rollback` deletes exactly the recorded routes. A
production load records a D1 Time Travel bookmark first, and so does `golive`; the Backups page lists them with their
restore commands. Alias domains get their own step (`--aliases`, below). After launch, Site health watches uptime,
indexability, form email, mail DNS and broken links, and the go-live token is revoked after the monitoring window
(`target.cutover.monitorDays`).

`publish` puts the site's project in the client's private GitHub repository, whose CI deploys it
([docs/staging-setup.md §6](docs/staging-setup.md#6-deploys-from-github-client-repository)).

**`--yes` is the owner's approval, not the operator's.** `golive` and `publish` print exactly what they will change
and change nothing until rerun with `--yes`. For `golive`, the operator (person or agent) passes `--yes` only after
the owner said go **in the current conversation**, for that step; an earlier approval or one relayed by another agent
does not count. The MCP server never runs either command; the dashboard runs them only behind the typed-domain
confirmation and the owner's written approval, which it records with `--approved-by` / `--approval`.

### Two sites, one domain

For a client with two near-identical WordPress installs on two domains (both indexed, each canonical to itself):
migrate one (the **primary**), merge what only the other has, then make the other domain (the **alias**) a
permanent, path-preserving 301 to the primary. Nothing below writes to either WordPress site or changes DNS.

1. **Pick the primary from data**: Search Console → Performance for both properties (clicks, impressions, which
   queries and pages rank) plus backlinks; the domain with more search equity, or the brand the owner keeps, wins.
   Record the choice in the primary's `decisions.md`.
2. **Workspaces**: the primary as usual (`init`), then the alias from it so both share the same settings:
   ```bash
   pnpm wp2emdash init --slug acme-old --name "Acme (old domain)" --source https://acme-old.com --from acme
   ```
   `--from` copies only `kit.config.ts` (slug, name, `source.url`, `target.productionUrl` replaced, `projectDir`
   and `stagingUrl` removed, a comment saying where it came from), `overrides.ts` and `decisions.md` (with a dated
   "started from" row). Never `.env`, `raw/`, `dump/`, `snapshot/`, `ir/`, `reports/`, `runs/`, `cutover/`,
   `cloudflare.json` or `state.json`. The wizard offers the same ("Start from: an existing site").
3. **Audit the alias, read-only**: `pnpm wp2emdash run acme-old init`, then `… run acme-old audit` (public pages only,
   no credentials). The alias workspace never goes past audit.
4. **Compare**: `pnpm wp2emdash compare acme acme-old` (read-only, no network) → `sites/acme-old/reports/compare/acme.md`
   and `.json`: pages only on one side; for matched paths, distinct-word similarity with a verdict (identical /
   minor ≥ 98% / differs), sentences and words found on one side only, title/description/canonical/H1, forms
   (provider, id, field types) and external links (booking, social, phone, email).
5. **Merge unique content into the primary**: pages or sections only on the alias go into the primary through
   `overrides.ts` / `decisions.md` and a rerun, or in the EmDash admin after load — never by hand-editing `ir/`.
   Record each choice (kept, merged, dropped) in `decisions.md`.
6. **Set the alias** in the primary's `kit.config.ts`:
   ```ts
   target: { productionUrl: "https://acme.com", aliasDomains: ["acme-old.com"] /* www. included */ },
   ```
7. **Preflight**: add the alias zone to the go-live token (Zone Read, DNS Read, Single Redirect Read; Single
   Redirect Edit on launch day — docs/cloudflare-api-token.md) and run `pnpm wp2emdash run acme cutover`. Per alias
   it checks the zone, snapshots DNS to `cutover/dns-before.acme-old.com.json` with mail records flagged (MX, SPF,
   DKIM, DMARC, autodiscover — they stay untouched), checks apex and www are proxied and lists existing redirect
   rules. `cutover/runbook.md` §4 has the exact calls.
8. **Go-live** (owner approval at each step): switch the primary first (`pnpm wp2emdash golive acme`, then `--yes`;
   §1 of the runbook) and verify it; then per alias create its one Single Redirect rule (apex + www →
   `https://acme.com` + same path, query kept, 301) — `pnpm wp2emdash golive acme --aliases`, then `--yes`, appends it
   to the zone's existing redirect rules and runs the check below and a DNS comparison — or by hand, and run
   ```bash
   pnpm wp2emdash check-aliases acme --paths-from acme-old    # every audited path, apex and www, no redirect followed
   ```
   which must show a 301 to the same path on the primary for every URL (it reports 200, 404, 302 and chains).
   Rollback: `pnpm wp2emdash golive acme --rollback --aliases --yes` (or delete that rule by id, runbook). No DNS record
   changes, so the alias domain's email is unaffected.
9. **Change of Address**: in the alias's Search Console property, Settings → Change of address → the primary; submit
   the primary's sitemap; update Google Business Profile, social profiles, booking and other third-party links.
   Keep the alias domain registered (auto-renew) and its redirect rule in place for good — at least 180 days.
10. **Monitor** for `target.cutover.monitorDays`: rerun `check-aliases`, watch both Search Console properties (the
    alias's pages drop out, the primary picks them up) and the primary's 404 log.

## Performance and security

### Performance (on by default)

Every generated site ships a performance package (`src/scaffold/perf.ts`; facts and measurements in
[docs/spikes/performance-findings.md](docs/spikes/performance-findings.md)):

- **Route caching.** Rendered pages are kept in Cloudflare's Workers cache next to visitors (Astro route caching,
  `cacheCloudflare()`); a cached page answers like a static file (staging: 80 ms on a warm connection instead of
  0.8–1.8 s far from the database). One route rule per public page plus the sitemaps, tagged with EmDash collection
  names; the page also sets the tags of the chrome it shows (settings, menus, footer and announcement site parts,
  popups), so a publish or a menu/settings save purges the affected pages within seconds. 404s, redirects, signed-in
  editors and previews are never cached; browsers always revalidate HTML (`no-cache`).
- **Warm-up after deploy.** Each deploy starts with an empty cache (`cross_version_cache: false`: new templates at
  once); the deploy scripts and CI then run `scripts/warm.mjs`, which requests every sitemap URL and the image sizes
  those pages use.
- **Images.** Responsive `srcset`/`sizes` through EmDash's `/_image` endpoint (Cloudflare Images binding, no zone
  setting; a failed transform falls back to the original file), width/height on every image the starter renders,
  the logo as WebP sized for the header and small favicons, fonts and brand files cached by browsers for a year
  under content-hashed names.
- **Background video.** The picture paints first (LCP); the video is attached after load when the browser is idle,
  and not at all on phones (< 768 px), with Save-Data or reduced motion.
- **Announcement schedules** are checked in the browser (the inline script is allowed by its hash in the CSP, never
  `'unsafe-inline'`), and a cached page lives no longer than the bar's next start or end.
- **Verify** gates it on the deployed target: every page `cf-cache-status: HIT` on its second request, cached home
  page TTFB ≤ `gates.maxCachedTtfbMs` (600 ms, measured from the machine running verify — geography matters), home
  page ≤ `gates.maxPayloadKb` (1500 KB) until load with no video fetched.

Opt-outs, per site:

```ts
// sites/<slug>/kit.config.ts
performance: { routeCache: false },        // render every page per request (also turns off the warm-up)
performance: { responsiveImages: false },  // original image files only (no Images transformations)
performance: { warmup: false },            // no warm-up after deploy
performance: { maxAge: 600, swr: 3600 },   // shorter cache lifetime (seconds)
```

Smart Placement stays off (`performance: { smartPlacement: true }` to try it): see the findings for why.

### Security and privacy

- **Content-Security-Policy** on every page, built from one provider table: embeds, site widgets and the
  switched-on trackers are allowed by host; visitors' pages allow inline scripts only by hash (signed-in editors get
  the looser policy the EmDash admin needs). Security headers
  and closed WordPress endpoints (`/wp-admin`, `/xmlrpc.php`, `/wp-json`) are verify checks.
- **Consent**: trackers and widgets follow the visitor's choice in the built-in banner ([Privacy & consent](#privacy--consent)).
- **Forms**: Turnstile, rate limiting and validation on the endpoint; on sites with `sensitiveData: true` forms are
  rebuilt under the policy the owner chose (`forms.sensitive`: contact fields only, or contact fields plus one
  message box with a notice), and the scaffold gate fails until that choice is made.
- **Trackers and widgets** load on the production domain only, never for signed-in editors.

### Sign-in sessions

EmDash admin sign-in sessions live in a private R2 bucket per environment, `<worker>-sessions`
(`kit.config` `sessions`, default `"r2"`). Workers KV — the Cloudflare adapter's default — is eventually consistent and
caches reads at the edge, misses included, so editors were signed out at random ("Not authenticated", Retry → sign-in
page). R2 is strongly consistent. A lifecycle rule deletes session objects after `sessions.days` (default 30) and the
session lasts as long: editors sign in again every 30 days. The bucket is never public. `sessions: "kv"` keeps the old
store. Scaffold uses R2 only once every environment has its bucket (`provision`), else KV with a warning.
**Switching a live site signs everyone out once** (sessions do not move); the old `<worker>-session` KV namespace is
left unbound, delete it by hand later. Details: [sessions findings](docs/spikes/sessions-findings.md).

## Dashboard

`pnpm wp2emdash ui` serves a local dashboard on `127.0.0.1` (random free port) and opens it in the browser. The printed
URL carries a token that is new on every start; the first load swaps it for an HttpOnly, SameSite=Strict cookie and every
request without it is refused. Every mutating endpoint is a POST that also needs a same-origin `Origin` header and the
`X-WP2EMDASH-CSRF` header (derived from the token, delivered in the page). No remote access, no CDN.

- **Portfolio** — every site in `sites/` with its phase timeline, readiness score, blockers and last run, a **Live**
  badge, launch date, monitoring end and alias status. "Next" combines the recorded gates, the latest run of every phase
  (preview runs included, marked "from runs") and `cloudflare.json` → `production.live`: a site with only preview runs
  shows the phase it really reached, a site whose gates are all green shows "Go live", a live site shows alias
  redirects or the monitoring window.
- **Launch readiness** — one score per site: the share of launch checks that pass (gates `init` → `verify`, every
  check in the latest `reports/verify/verify.json`, every cutover preflight check). Accepted gates count as passing.
  The failing checks form the "what blocks launch" list, each with the command or link that fixes it.
- **Live runs** — `sites/<slug>/runs/*.jsonl` streamed with server-sent events: steps, progress and log as they happen.
- **Visual diff viewer** — WordPress vs EmDash per page × viewport: slider, side by side and pixel diff, plus the
  section-by-section table. Approve or reject a difference with a reason: a dated row is appended to `decisions.md`.
  This does **not** accept the verify gate: the owner still runs `wp2emdash accept <slug> verify --reason … --by …`
  (the dashboard shows the command).
- **Section inspector** — click a WordPress row on the audit screenshot: the row's raw shortcode / block source
  (`raw/exporter/content`), the IR section(s) it became, and the WordPress / staging / difference crops from verify.
  "Change section type" and "drop row" create a **proposal** that patches `overrides.ts` → `elements` (never `ir/`).
- **Approval queue** — `sites/<slug>/proposals/*.json` (from Claude via `wp2emdash mcp`, or from the inspector), pending
  first, with the summary, file, the unified diff (shown as text) and the phase to rerun. Approve or reject with your
  name and an optional note: approve applies the diff (a patch that no longer applies is marked failed and nothing is
  written). After approving, the dashboard can start a **preview** run of `transform`, `scaffold` or `verify` (gate not
  recorded) and stream it; it never starts `load` or `cutover`. The command that records the gate is shown.
- **Secrets** — a form per site that writes one allow-listed key at a time to `sites/<slug>/.env` (migration key, app
  password, EmDash tokens and encryption keys, email key, production Turnstile/Cloudflare values, go-live token), with
  format checks where the format is known. Values are **write-only**: never returned, logged or streamed; the page shows
  only "set / not set" and a fingerprint (first 8 hex of the SHA-256). Other lines and comments are kept, the file stays
  mode 600, values with line breaks are refused. Reminds you to revoke the app password once extract has run.
- **Owner checklist** — `ACCESS.md` as sections with items, required markers and the generated "Plugin data" section.
  Read-only: ticking stays in the file.
- **Launch cockpit** — the last cutover preflight, the go-live prerequisites, the runbook and the commands, plus the
  owner-approved steps **Go live**, **Add alias redirects**, **Roll back** and **Roll back alias redirects**. "Show plan"
  runs `golive … --json` without `--yes` (what will change: routes, alias rules, Site URL, live flag; blockers). Each
  step needs the production domain typed exactly, the tick "The owner approved this in writing", the approval as
  written (who, when, where) and your name — checked again on the server. The approval is appended to `decisions.md`
  and recorded in `cutover/golive.json` → `approvals`; then `wp2emdash golive … --yes` runs as a child process and
  streams like a run. Also shown: recorded route / rule ids, the smoke result, the last DNS comparison, DNS snapshots,
  approvals and history.
- **Publish** — repository, CI runs (`gh run list`, when gh is available), a dry run (`publish --json`: the file list
  and the secret scan, file names only) and "Publish" (`publish --yes`) behind the same confirmation. It never sets the
  `CLOUDFLARE_API_TOKEN` secret: the `gh secret set` command is shown to run by hand.
- **Environment** — single environment or opt-in staging, workers.dev address, live domain and date, resources, last
  load, the `load --force` rule once live, the preview-URL flow and where form messages go.
- **Worker secrets** (Secrets tab, per environment) — for each runtime secret (`EMDASH_ENCRYPTION_KEY`,
  `EMAIL_API_KEY`, `TURNSTILE_SECRET_KEY`, anything in the project's `.dev.vars.example`): "saved locally" (which `.env`
  key, fingerprint) and "set on Worker" (Cloudflare API, names only). "Set on Worker" pipes the local value into
  `wrangler secret put` on stdin; on a live production it needs the typed domain. Operator credentials (build and
  go-live tokens, EmDash tokens, WordPress key) are local-only: presence, fingerprint, Cloudflare token-verify status
  and expiry, and the reminder to revoke the go-live token after the monitoring window.

Long-running actions run one at a time per site and are logged to `runs/<runId>.jsonl` (phase `golive`, `publish`,
`secret-put`, … — never a pipeline gate). What it writes: rows in `decisions.md` (visual decisions, approved proposals,
launch / publish approvals), `overrides.ts` (approved proposals only), new files in `proposals/`, keys in `.env`, and
what the owner-approved commands write themselves. Everything it returns passes through the site's secret scrubber (no
`.env` value leaves the server). It serves files only from `reports/` and `snapshot/screens/`, never changes DNS, and
never accepts a gate.

## Claude Code

The kit ships a stdio MCP server and four skills, so Claude Code can drive the pipeline while the owner keeps every
decision.

**MCP server** — `pnpm wp2emdash mcp`. Tools: `status`, `run_phase`, `read_report`, `list_diagnostics`, `explain_gate`,
`propose_override`. `run_phase` runs init → verify and any preview run; `load`/`verify` only against `local` or
`staging` (a single-environment site's default target, production, falls back to `local` there); `cutover` only as its
read-only preflight. Anything that would deploy to production or change DNS / Worker
routes is refused. Results never include `.env` contents, and values from the kit and site `.env` are scrubbed out.

Register it:

- **In the kit:** the checked-in `.mcp.json` registers it as a project server. Claude Code asks you to approve it the
  first time.
- **From anywhere** (e.g. a site's own repo):
  `claude mcp add wp2emdash -- pnpm --silent --dir /path/to/wp-to-emdash-kit wp2emdash mcp`
  (keep `--silent`, because stdout is the protocol channel).

**Approval queue** — `propose_override` never edits a file. It writes `sites/<slug>/proposals/<id>.json` (a unified
diff for `overrides.ts` or `decisions.md`, checked to apply cleanly). The owner decides:

```bash
pnpm wp2emdash proposals <slug>                       # pending proposals (--all for decided ones, --json)
pnpm wp2emdash proposals <slug> approve <id> --by "…" # applies the patch, prints the rerun command
pnpm wp2emdash proposals <slug> reject <id> --by "…" --note "…"
```

**Skills** (in `skills/`): `wp2emdash-run` (phase by phase, stop and explain red gates), `wp2emdash-map` (coverage
items → adapter handler + fixture, or an override proposal), `wp2emdash-visual-fix` (red visual sections → measured
cause → fix → new numbers), `wp2emdash-cutover` (preflight and go-live with the owner's confirmation at every
irreversible step). Install them for yourself or for a project:

```bash
cp -R skills/wp2emdash-* ~/.claude/skills/              # every project
cp -R skills/wp2emdash-* <project>/.claude/skills/      # one project (e.g. a site repo)
```

Claude never accepts a gate (only `wp2emdash accept` with the owner's reason) and never writes `overrides.ts` /
`decisions.md` directly.

## Working with site workspaces

### Where each site lives

`sites/<slug>/` holds the kit's working data for a client: config, `.env`, raw exports, audit snapshots, IR, reports
(all gitignored). The deployable project — the client's own repository — is generated in `sites/<slug>/project` by
default. To keep it with the client's other files instead, set `projectDir` in `sites/<slug>/kit.config.ts`:

```ts
projectDir: "~/Projects/Acme/emdash", // a plain string: ~ = home, relative = from sites/<slug>
```

Every phase then reads and writes the project there; `pnpm wp2emdash status` shows the path. Scaffold refuses to
write into a folder that already holds something other than this kit's project. To move an existing project: move
the folder, set `projectDir`, run `pnpm install` in it once (pnpm's helper scripts keep absolute paths).

### One folder for everything

The fastest start: ask the owner (or do it yourself in WordPress admin) for every export in one folder,
`sites/<slug>/dump/` — inside the site workspace, so it is gitignored and never leaves your machine:

- the plugin exports the audit lists in `ACCESS.md` (forms, redirects, SEO settings)
- builder and theme settings (Bricks settings and theme styles, Salient options, Automatic.css settings)
- a full backup, unzipped, with its `database.sql` (and, for reference, plugins and themes — useful when a
  third-party element pack needs mapping)

Then run:

```bash
pnpm wp2emdash import-dump <slug>
```

It sorts every file by its content: plugin exports into `raw/plugin-exports/` (read by extract), builder settings into
`raw/`, and from the database dump only the allow-listed builder options (Bricks palette, global classes, theme styles,
components) with anything that looks like a credential left out. Every file is listed with what it was used for; files
it does not recognise are named, never guessed. Inside a backup, uploads, form uploads, plugins and caches are counted,
never opened — form entries are never read. With Claude Code (see below), the same folder is what the agent inspects to
map unknown elements: give it the plugin's source from the backup and the audit's screenshots, and it proposes the
handler with a fixture and a test. Delete the folder when the project ends.

## Docs

The full index, with a line on every document, is [docs/README.md](docs/README.md). The most used:

- [Plan](docs/PLAN.md): scope, architecture, phases, gates, section library, milestones and status
- [WordPress → EmDash parity](docs/parity/wp-to-emdash.md): what is migrated, partial or missing, feature by feature
- [Environment setup](docs/staging-setup.md): production on `workers.dev` (default) and opt-in staging, first admin sign-in, CI, go-live, troubleshooting
- [Cloudflare API tokens](docs/cloudflare-api-token.md): the reusable build token and the per-launch go-live token
- [Spike findings](docs/README.md#spike-findings-verified-facts): every EmDash and Cloudflare behaviour the kit relies on, checked against the installed versions
- Package READMEs: [forms](packages/forms/README.md) · [og](packages/og/README.md) · [seo](packages/seo/README.md) · [health](packages/health/README.md) · [consent](packages/consent/README.md) · [backups](packages/backups/README.md) · [media](packages/media/README.md) · [change-requests](packages/change-requests/README.md)
- [Site workspaces](sites/README.md) · [Changelog](CHANGELOG.md) · [Agent rules](CLAUDE.md)

## Privacy

Client workspaces (`sites/<slug>/`) never enter this repository: only `sites/README.md` is tracked. Credentials live in each workspace's `.env`. The kit only reads from WordPress (GET requests) and never reads form submissions.

## License

MIT © Nurkamol Vokhidov — see [LICENSE](LICENSE). Built by [Nurkamol Vokhidov](https://github.com/nurkamol) at [PixelKraft](https://pixelkraft.net).
Project page: <https://nurkamol.github.io/wp2emdash/>.
