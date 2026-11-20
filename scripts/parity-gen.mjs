// Generates docs/parity/wp-to-emdash.{md,json} from one table so both stay in sync.
import { writeFileSync, mkdirSync } from "node:fs";
const OUT = "/Users/nurkamol/coding/wp-to-emdash-kit/docs/parity";
mkdirSync(OUT, { recursive: true });

// conf: src = read in the installed emdash 1.5.0 source; docs = docs.emdashcms.com only; none = not in source (theme/kit must build it)
// status: done | partial | missing | superseded (WP feature replaced by the platform, nothing to carry) | oos (out of scope)
// sites: how many of the two migrated real sites used the feature ("0/2", "1/2", "2/2"); "" = not measured
// [id, area, feature, emdashHome, conf, status, kitRefs, gapApproach, effort, risk, priority, sites]
const R = [
// ── Content ───────────────────────────────────────────────────────────────
["pages", "Content", "Pages (title, body, slug, publish/draft)", "Seed collection `pages` → `ec_pages`; REST `/content/{c}`", "src", "done", "transform.ts (pages → ir/pages), load.ts (id-map upsert, publish/unpublish), scaffold/seed.ts `buildSeed`", "—", "", "", "", "2/2"],
["page-private", "Content", "Private pages", "No private status (`draft|published|archived`, src/query.ts)", "src", "done", "load.ts: non-`publish` → draft (unpublished)", "Equivalent: drafts are not public. Logged-in WP viewers lose access; acceptable.", "", "", "", "2/2"],
["page-hierarchy", "Content", "Parent/child pages, nested URLs", "No parent column on entries (schema/registry.ts); Relations (`_emdash_relations`) as the only link", "src", "partial", "Nested path stored as slug `a/b` and served by starter `[...slug].astro`; parent link not modelled", "URLs are kept. Admin shows a flat list; renaming a parent does not move children. Option: `parent` reference field + slug check in load. Document the convention in the editor guide.", "S", "low", "P2", ""],
["page-template", "Content", "Page templates (`_wp_page_template`: full width, no title, landing)", "No template column", "none", "partial", "transform.ts records `route.template` in the IR; not loaded or used", "Map common templates to a `template` select field (or a section variant) and render it; report unknown ones.", "S", "low", "P2", ""],
["menu-order", "Content", "`menu_order` (manual page order)", "No order column on entries", "none", "missing", "Not carried", "Only matters for child-page listings. Integer `order` field if a listing section needs it.", "S", "low", "P2", ""],
["front-page", "Content", "Static front page", "No front-page setting; theme decides", "none", "done", "Entry slug `home`; `/home` → 301 `/` ([...slug].astro); sitemap loc fixed (middleware `fixSitemapLoc`)", "—", "", "", "", "2/2"],
["posts", "Content", "Blog posts (Gutenberg/classic body)", "Any collection with `urlPattern`; `@emdash-cms/gutenberg-to-portable-text` converter ships with EmDash", "src", "missing", "Seed has only `pages`, `site_parts`, `popups` (seed.ts); transform skips Gutenberg/classic posts with a note “imported by the EmDash importer” (transform.ts ~L268) but no phase runs an importer; builder posts go to `pages` (load.ts `COLLECTION.post = \"pages\"`)", "Add a `posts` collection (title, excerpt, featured_image, body portableText, optional `content` blocks, seo, search). Convert body with the EmDash converter + the kit shortcode pass; load through the id-map. Do not use EmDash's own import route: it writes SEO into `seo_title` fields instead of `_emdash_seo` (import/wordpress-plugin/execute.ts ~L979) and bypasses the id-map.", "L", "med", "P0", "0/2"],
["post-dates", "Content", "Publish / modified dates", "`published_at` system column; REST create/update accept `publishedAt` (gated by `content:publish_any`, api/schemas/content.ts ~L221)", "src", "missing", "load.ts never sends dates (publish = now)", "Send `publishedAt` from `date_gmt`. Check the API token scope covers `content:publish_any` (M6 token list has no such scope; verify).", "S", "med", "P0", ""],
["post-permalinks", "Content", "Post permalink structure (`/%postname%/`, `/%year%/%monthnum%/%postname%/`, `/blog/…`)", "`urlPattern` with `{slug}` only; no date placeholders found", "src", "missing", "Pages only: `[...slug].astro` resolves `pages` by path", "Store the WP path as the post slug (as pages do) and resolve posts in the catch-all route, or a `/blog/[...slug]` route per pattern; `?p=` map must include posts (scaffold `wpIds` is pages only).", "M", "med", "P0", ""],
["excerpt", "Content", "Excerpts", "Not a system field; EmDash importers add an `excerpt` text field", "src", "missing", "Not carried", "`excerpt` text field on posts (and pages when used); fallback for meta description and listings.", "S", "low", "P0", "1/2"],
["featured-image", "Content", "Featured images", "Not a system field; importers add `featured_image` (image)", "src", "partial", "transform.ts sets `featuredImage`; load.ts uploads the file but stores no field (data = title + content)", "Add `featured_image` image field to pages/posts and write it; use as og:image fallback and in listings.", "S", "low", "P0", "1/2"],
["sticky", "Content", "Sticky posts", "None", "none", "missing", "Not carried", "`featured` boolean field; blog index sorts it first.", "S", "low", "P2", "0/2"],
["post-formats", "Content", "Post formats (aside, video, quote…)", "None", "none", "missing", "Not carried", "Rare on business sites: `format` select field or drop by named rule (reported).", "S", "low", "P2", "0/2"],
["scheduled", "Content", "Scheduled (future) posts", "`scheduled_at` + cron sweep (scheduled-publish.ts); admin `/calendar`", "src", "missing", "load.ts only publishes/unpublishes", "Status `future` → schedule call with the WP date. Verify the REST schedule endpoint (MCP has `content_schedule`).", "S", "low", "P1", "0/2"],
["password-protected", "Content", "Password-protected posts/pages", "None (EmDash importers turn them into drafts)", "src", "missing", "Not detected, not gated", "Detect `post_password` in extract; gate as an owner decision: draft, Cloudflare Access on the path, or a small middleware password cookie.", "M", "med", "P1", "0/2"],
["revisions", "Content", "Revision history", "`revisions` table, restore", "src", "oos", "`revision` type skipped in extract (by design)", "Out of scope: history starts at migration; WordPress backup keeps the old history.", "", "", "OOS", ""],
["bylines", "Content", "Authors (display name, bio, avatar) on posts", "`_emdash_bylines` (+ guest, custom byline fields), many bylines per entry; create/update accept `bylines`", "src", "missing", "extract keeps `analyze.authors` (emails stripped); nothing created", "Create one byline per WP author (no email), link with `bylines` on post create; avatar via media upload.", "M", "low", "P0", ""],
["cpt", "Content", "Custom post types (services, team, portfolio, testimonials, events…)", "Collections with any of 17 field types, `urlPattern`, `routable`", "src", "missing", "extract fetches every type; transform only handles page/post/popup/salient_g_sections/bricks_template — other non-empty types are neither migrated nor listed in the coverage report (breaks the never-silently-drop rule)", "1) Now: list every non-empty unhandled type in coverage + a transform gate (S). 2) Generic mapper: collection per type from `analyze` (supports, taxonomies, custom fields), urlPattern from the live permalinks, body through the adapters, archive/single templates.", "L", "med", "P0", "0/2"],
["acf", "Content", "ACF / Meta Box / Pods custom fields", "Field types `string text url number integer boolean datetime select multiSelect portableText image file reference json slug repeater blocks`; repeater sub-fields flat only; EmDash's own `ACF_FIELD_TYPES` table in the exporter importer", "src", "missing", "Fingerprint says “EmDash fields (via exporter)” (audit/fingerprint.ts) but nothing maps them", "Map ACF groups → fields (wysiwyg→portableText, gallery→repeater of image, relationship→reference, flexible content→blocks, group→json, nested repeater→json + report). Meta Box/Pods from `analyze.custom_fields` inferred types.", "L", "med", "P1", "0/2"],
["reusable-blocks", "Content", "Reusable blocks / synced patterns", "Sections (`_emdash_sections`, source `import`)", "src", "partial", "Inlined by the Gutenberg adapter (`core/block`, transform.ts `reusable`); not created as EmDash sections (PLAN §2.2 says both)", "Also write each `wp_block` as a section so editors can reuse it.", "S", "low", "P2", "0/2"],
["global-parts", "Content", "Theme template parts (Salient global sections, Bricks header/footer templates)", "Kit collection `site_parts`", "src", "partial", "Site-wide header/footer/announcement migrated; conditional (per-page) templates only listed (transform.ts `bricksParts.others`)", "Conditional header/footer per page: a `site_part` reference field on pages.", "M", "med", "P2", "2/2"],
// ── Builders ──────────────────────────────────────────────────────────────
["wpbakery", "Builders", "WPBakery + Salient", "Kit section library as `blocks` field (block types)", "src", "done", "src/adapters/wpbakery (~70 element handlers + row recognisers), golden tests", "Long tail of third-party `vc_*` add-ons via `wp2emdash-map`.", "", "", "", "1/2"],
["gutenberg", "Builders", "Gutenberg core blocks", "Converter supports core audio/file/table/embed/…", "src", "partial", "src/adapters/gutenberg/index.ts: 30 core blocks; no `core/file`, `core/audio`; dynamic blocks (latest-posts, query, categories, archives) → `dynamic` error", "Add file/audio handlers (S). Query/latest-posts need a `posts_list` section (with the blog work).", "M", "low", "P1", "2/2"],
["gutenberg-libs", "Builders", "Gutenberg block libraries (Kadence, Spectra, GenerateBlocks, Stackable, Otter)", "—", "none", "missing", "Fall through to “no handler” diagnostics", "Structural handlers per family (PLAN §7) with fixtures + golden tests.", "M", "med", "P1", "0/2"],
["classic", "Builders", "Classic editor content", "Portable Text", "src", "done", "ir/portable-text.ts `autop`, shortcodes through the shortcode parser", "—", "", "", "", ""],
["bricks", "Builders", "Bricks", "Kit section library", "src", "done", "src/adapters/bricks (elements, templates, components, forms, menus); measured on one real site", "Query loops / posts element need a posts listing section (reported as `dynamic`).", "", "", "", "1/2"],
["elementor", "Builders", "Elementor / Elementor Pro (incl. theme builder, popups, forms)", "Kit section library", "none", "missing", "Fingerprint marks out-of-scope (audit/fingerprint.ts)", "Adapter over `_elementor_data` JSON (sections/containers → rows → shared recognisers), theme-builder templates → site_parts, Elementor forms → form sections. Most common builder after Gutenberg.", "L", "high", "P1", "0/2"],
["divi", "Builders", "Divi", "Kit section library", "none", "missing", "Out-of-scope in fingerprint", "`et_pb_*` shortcodes: reuse the WPBakery shortcode parser + Divi element handlers.", "L", "high", "P1", "0/2"],
["other-builders", "Builders", "Beaver Builder, Oxygen, Breakdance, Avada/Fusion, Thrive, SiteOrigin", "—", "none", "missing", "No adapter; PLAN's `dom-fallback` adapter not built (src/adapters has bricks, gutenberg, wpbakery only)", "Build the DOM-fallback adapter (rendered HTML from the audit → sections, flagged) as the universal safety net; dedicated adapters only on demand.", "L", "high", "P1", "0/2"],
["shortcodes", "Builders", "Unknown / plugin shortcodes in content", "Not expanded by EmDash (docs)", "docs", "partial", "Parsed as nodes and reported `unmapped` (blocks transform for published content); form shortcodes mapped", "Ongoing handler work; WordPress core `[caption]`, `[audio]`, `[video]`, `[embed]`, `[playlist]` handlers should be checked with fixtures (only `[gallery]` confirmed, wpbakery/index.ts).", "S", "low", "P1", ""],
// ── Taxonomies ────────────────────────────────────────────────────────────
["categories-tags", "Taxonomies", "Categories and tags (+ term assignment)", "`_emdash_taxonomy_defs` (hierarchical/flat), `taxonomies`, `content_taxonomies`; REST `/taxonomies/{name}/terms`, `bulk-tag`", "src", "missing", "extract writes raw/exporter/taxonomies.json; not transformed or loaded", "Seed taxonomy defs, load terms (parent, slug, description) via REST, assign on posts.", "M", "low", "P0", "0/2"],
["custom-taxonomies", "Taxonomies", "Custom taxonomies", "Same as above (custom names allowed)", "src", "missing", "As above", "Same path, driven by `analyze` (taxonomies per type); skip plugin-internal ones (FileBird folders, template tags) by named rule.", "S", "low", "P1", "0/2"],
["term-meta", "Taxonomies", "Term descriptions, term SEO (Yoast/Rank Math)", "`data.description` only; no term SEO", "src", "missing", "—", "Description into `data.description`; term SEO title/description need a plugin store (seo package) if archives stay indexable.", "S", "low", "P2", "0/2"],
// ── Media ─────────────────────────────────────────────────────────────────
["media-files", "Media", "Media library files (dedupe)", "`media` table, R2, content-hash dedupe, 50 MB default limit", "src", "partial", "extract downloads the whole library (raw/media); load uploads only media referenced by the IR (sha1 dedupe, load.ts)", "Option `media.uploadAll` (or all non-image files) so library-only items (PDFs sent by email, files linked from outside) stay reachable; legacy upload redirect then finds them.", "S", "low", "P1", "2/2"],
["alt", "Media", "Alt text", "`media.alt`", "src", "done", "Sent on upload; verify `images-alt`; SEO dashboard writes missing alts (packages/seo)", "Both sites had 0 alt in the library: keep reporting it in audit.", "", "", "", "2/2"],
["caption-title", "Media", "Captions, titles, descriptions", "`caption`; no title/description column", "src", "partial", "Manifest keeps caption/title; upload sends alt only (`api.mediaUpload`)", "Send caption; title/description dropped by named rule (reported).", "S", "low", "P2", ""],
["sizes", "Media", "Image sizes / WebP plugins", "`/_image` endpoint, Cloudflare Images binding, webp/avif", "src", "superseded", "perf package `image.domains`, `/_image` fallback in middleware", "—", "", "", "", "1/2"],
["pdf", "Media", "PDFs and documents linked in content", "Allowed type (`pdf` in upload allowlist)", "src", "partial", "Linked upload URLs are rewritten only when the file was uploaded (load.ts `fixHref`)", "Collect `href` upload links as `file` media refs in transform, upload them, gate on it.", "S", "low", "P1", "0/2"],
["svg", "Media", "SVG files", "Blocked by default (allowlist), per-field opt-in", "src", "done", "Drawn to PNG at load (targets/emdash/svg.ts); legacy `.svg` URL → PNG (middleware)", "Lossy (raster). Option: `allowedMimeTypes` opt-in on logo fields instead.", "", "", "", "2/2"],
["video-audio", "Media", "Self-hosted video/audio, external CDN video", "`video/*`, `audio/*` allowed; Stream runtime", "src", "done", "mp4 faststart, external `copy` (overrides.media.external); `hotlink` refused at load", "Hotlinked media support (keep URL) for very large files.", "S", "low", "P2", "1/2"],
["gallery", "Media", "Galleries", "Kit `gallery` section; PT `gallery` block", "src", "done", "Section library `gallery` (grid/masonry/carousel)", "—", "", "", "", ""],
["media-folders", "Media", "Media folders (FileBird, Real Media Library)", "`media_folders` (migration 072)", "src", "missing", "Dropped (fingerprint: “folders are not migrated”)", "Read the folder taxonomy and recreate folders.", "S", "low", "P2", "2/2"],
["attachment-pages", "Media", "Attachment pages (`/?attachment_id=N`, `/parent/file-name/`)", "None", "none", "missing", "Audit discovers them (discover.ts media `link`); no redirect", "301 to the file (or parent page) from the media manifest.", "S", "low", "P1", ""],
// ── Navigation & chrome ───────────────────────────────────────────────────
["menus", "Navigation", "Menus (nesting, custom links, target, classes)", "`_emdash_menus`, `_emdash_menu_items` (custom/page/post/taxonomy/collection), `getMenu`", "src", "partial", "seed.ts + load.ts write `primary`, `secondary`, `footer`; menus with role `other` are not written; every item is a `custom` URL", "Write every menu (named after the WP menu); link items to entries (`page`/`post` types) so slug changes follow.", "S", "low", "P1", "2/2"],
["menu-locations", "Navigation", "Menu locations", "None — templates fetch by name", "src", "done", "WP locations → roles (transform `menuTree`, IrSite.menus.role)", "—", "", "", "", "2/2"],
["mega-menu", "Navigation", "Mega menus (Max Mega Menu, builder mega menus)", "None", "none", "missing", "Classes only", "Header variant with column groups from menu item classes; images/widgets in mega panels reported.", "M", "med", "P2", "0/2"],
["widgets", "Navigation", "Widgets / sidebars (classic themes)", "`_emdash_widget_areas`, `_emdash_widgets` (content, menu, component `core:recent-posts|categories|tags|search|archives`), REST `/widget-areas`", "src", "missing", "No extract (exporter has no widgets endpoint)", "Read `wp/v2/sidebars` + `wp/v2/widgets` (auth, WP ≥ 5.8) or the `sidebars_widgets` option from the dump; text/HTML → content widgets, nav → menu widgets, core widgets → components.", "M", "med", "P1", "0/2"],
["header", "Navigation", "Header (logo, menu, mobile menu, sticky behaviour)", "Theme", "none", "done", "SiteHeader variants + motion recipe from the audit (PLAN §5a)", "—", "", "", "", "2/2"],
["footer", "Navigation", "Footer", "Theme + kit `site_parts`", "none", "done", "Footer site part from global sections / Bricks footer; classic widget footers depend on `widgets`", "—", "", "", "", "2/2"],
["announcement", "Navigation", "Announcement / notification bars", "Kit site part `announcement`", "none", "done", "transform/announcement.ts (Announcer, WPFront, Salient, Astra); script-injected bars reported", "—", "", "", "", "1/2"],
["popups", "Navigation", "Popups (Popup Maker, Bricks popups)", "Kit `popups` collection", "none", "partial", "Enabled Popup Maker + Bricks popups with click/auto-open triggers; others reported", "Elementor popups, OptinMonster, Convert Pro: map via the same IR when met.", "M", "low", "P2", "1/2"],
["identity", "Navigation", "Site title, tagline", "Settings `title`, `tagline`", "src", "done", "load.ts `updateSettings`", "—", "", "", "", "2/2"],
["logo-favicon", "Navigation", "Logo, favicon / site icon", "Settings `logo`, `favicon` (media refs)", "src", "partial", "Copied to `public/brand` + `site.config.json` (scaffold); EmDash settings not set, so the owner cannot change them in the admin", "Upload and set `logo`/`favicon` settings; starter reads settings first. (EmDash Settings prefill is being built by another agent.)", "S", "low", "P1", "2/2"],
["social", "Navigation", "Social profiles", "Settings `social.{twitter,github,facebook,instagram,linkedin,youtube}`", "src", "partial", "Only as `sameAs` in structured data (transform/business.ts)", "Write settings.social (overlaps with the Settings prefill work).", "S", "low", "P2", ""],
["404", "Navigation", "404 page content", "Theme `/404`", "none", "partial", "Generic starter 404 (starter/src/pages/404.astro)", "Carry the source 404 text/links (Bricks `error` template, theme 404) into a `site_parts/404` entry.", "S", "low", "P2", "1/2"],
["archives", "Navigation", "Blog index, category/tag/author/date archives, pagination", "No injected routes; helpers `getEntriesByTerm`, `getEntriesByByline`, cursor/offset queries", "src", "missing", "Starter has only `[...slug].astro`, `404.astro`, `api/forms`", "Starter routes: posts page, `/category/[slug]/`, `/tag/[slug]/`, `/author/[slug]/` (or 301 by decision), `/page/N/`; date archives → 301 to the index unless indexable.", "M", "med", "P0", ""],
["single-post", "Navigation", "Single post template (date, author box, categories, prev/next, related)", "Theme; `buildBlogPostingJsonLd`", "src", "missing", "—", "Post layout component + BlogPosting JSON-LD.", "M", "low", "P0", ""],
["search", "Navigation", "Site search + results page", "FTS5 (`search`, `searchCollection`, `LiveSearch.astro`, widget `core:search`)", "src", "missing", "`pages` collection has `search` support; no `/search` route; `/?s=` falls to the home page", "`/search` page + 301 `/?s=q` → `/search?q=`; keeps the Rank Math WebSite SearchAction valid.", "S", "low", "P1", "2/2"],
["rss", "Navigation", "RSS/Atom feeds (`/feed/`, category/comment feeds)", "None (no feed route or helper in src)", "none", "missing", "Not handled; both sites linked feeds on every page", "Starter `/feed/` (RSS 2.0 from posts), `/category/x/feed/`; `/comments/feed/` → 410. Sites without posts: 301 `/feed/` → `/` or 410 by decision, and a verify check.", "S", "low", "P0", "2/2"],
// ── Comments & users ──────────────────────────────────────────────────────
["comments", "Comments & users", "Comments (approved, threaded)", "`_emdash_comments` (pending/approved/spam/trash, 1-level threading), moderation, Turnstile; no admin bulk-create REST route found", "src", "missing", "extract writes raw/exporter/comments.json; not loaded", "Spike the write path (site-transfer `comment` records via `emdash site import`, or EmDash's `importCommentsFromPlugin`); deeper threads flattened (reported); emails never logged.", "M", "med", "P1", "0/2"],
["comment-settings", "Comments & users", "Comment open/closed per post, discussion settings", "Per collection: `commentsEnabled`, `commentsModeration`, `commentsClosedAfterDays`", "src", "missing", "—", "Map site defaults to collection options; per-post closed state needs a field.", "S", "low", "P2", "0/2"],
["users", "Comments & users", "Users and roles", "Roles SUBSCRIBER…ADMIN, invites, passkeys, magic links, OAuth (GitHub/Google/Microsoft)", "src", "missing", "Owner invites admins by hand (PLAN §8 editor handoff)", "Invite list from WP users with role mapping (administrator→ADMIN, editor→EDITOR, author→AUTHOR, contributor→CONTRIBUTOR); passwords never migrate.", "S", "low", "P2", "2/2"],
// ── Forms ─────────────────────────────────────────────────────────────────
["forms", "Forms", "Form definitions (CF7, Gravity, WPForms, Fluent, Bricks)", "No forms in core (`@emdash-cms/plugin-forms` referenced, not installed)", "src", "done", "Fluent over REST, others from plugin export files (extract/plugin-exports.ts); `@wp2emdash/forms` endpoint, Turnstile, outbox, admin inbox", "—", "", "", "", "2/2"],
["forms-other", "Forms", "Ninja Forms, Formidable, Elementor forms, WS Form, Forminator", "—", "none", "partial", "Shortcodes recognised (wpbakery handlers `ninja_form`, `formidable`); no definition extractor", "Export parsers per plugin when a site needs it.", "M", "low", "P1", "0/2"],
["forms-features", "Forms", "File uploads, multi-step, conditional logic, payments", "—", "none", "partial", "File upload fields dropped with a warning (plugin-exports.ts ~L228); signature/consent supported (forms 1.3)", "Uploads to R2 with size/type limits (never for sensitive sites); conditional logic in the form schema; payments OOS.", "M", "med", "P1", ""],
["form-entries", "Forms", "Past form entries", "—", "none", "partial", "Never read (privacy rule); the forms admin can import CSV/JSON", "Checklist step: owner exports entries before decommissioning WordPress.", "S", "low", "P2", ""],
["smtp", "Forms", "SMTP plugins (WP Mail SMTP, FluentSMTP)", "Email pipeline (SMTP settings, `cloudflare-email` plugin); no attachments", "src", "superseded", "Provider APIs (Brevo default) or `EMAIL_PROVIDER=emdash`", "—", "", "", "", "2/2"],
["spam", "Forms", "Akismet, reCAPTCHA, hCaptcha, ALTCHA", "Turnstile (comments), rate limits", "src", "superseded", "Turnstile + rate limit on the form endpoint", "—", "", "", "", "1/2"],
// ── Redirects & legacy URLs ───────────────────────────────────────────────
["redirects", "Redirects & URLs", "Plugin redirects (Redirection, Rank Math, Yoast)", "`_emdash_redirects` (301/302/307/308/410/451, `[param]` patterns, hits), admin `/redirects`", "src", "done", "plugin-exports.ts → raw/redirects.json → load (group `wordpress`)", "Regex rules are kept out and reported (EmDash has no regex): optional middleware regex table.", "M", "low", "P2", "0/2"],
["404-log", "Redirects & URLs", "404 monitoring after launch", "`_emdash_404_log`, `/redirects/404s`", "src", "partial", "EmDash logs; kit post-launch monitor not built (PLAN §10b #7)", "Scheduled check: new 404s → suggested redirects in the dashboard (check overlap with packages/health, in progress).", "S", "low", "P1", ""],
["wp-ids", "Redirects & URLs", "`/?p=N`, `/?page_id=N`", "Query-string sources never match (M0 A6)", "src", "partial", "Middleware `wpIds` — pages only", "Include posts and CPT entries.", "S", "low", "P0", ""],
["wp-query-urls", "Redirects & URLs", "`/?cat=`, `/?tag=`, `/?author=`, `/?s=`, `/?attachment_id=`, `/?feed=`", "As above", "src", "missing", "Not handled", "Same middleware map, from extract (terms, authors, media).", "S", "low", "P1", ""],
["archive-urls", "Redirects & URLs", "Archive URLs not rebuilt (`/category/x/`, `/tag/x/`, `/author/x/`, `/2024/05/`, `/page/2/`)", "Redirects (`[param]`/`[...splat]` patterns)", "src", "missing", "Audit discovers terms and authors (discover.ts) but verify only checks audited URLs that are published IR pages (verify.ts ~L118–121): everything else is never checked", "Verify gate: every audited URL answers 200, a single-hop 301 to a mapped target, or 410 recorded in decisions.md. Generate pattern redirects for archives not rebuilt.", "M", "med", "P0", "1/2"],
["uploads-urls", "Redirects & URLs", "`/wp-content/uploads/...` links", "Native redirects skip file paths", "src", "done", "Middleware `legacyUpload` (filename → storage key, `-WxH`/`-scaled`); verify `legacy-urls`", "—", "", "", "", "2/2"],
["old-sitemaps", "Redirects & URLs", "Old sitemap URLs", "—", "none", "done", "Middleware `LEGACY_SITEMAP` → `/sitemap.xml`", "—", "", "", "", "2/2"],
["slash-host", "Redirects & URLs", "Trailing slash, www/apex, http→https", "—", "none", "done", "Middleware `canonicalPath` + host policy; cutover `canonical-host`", "—", "", "", "", "2/2"],
["wp-endpoints", "Redirects & URLs", "`/wp-admin`, `/wp-login.php`, `/xmlrpc.php`, `/wp-json`", "—", "none", "done", "Verify `wp-endpoints` (404/410)", "—", "", "", "", "2/2"],
// ── SEO ───────────────────────────────────────────────────────────────────
["seo-meta", "SEO", "SEO title, description, canonical, noindex", "`_emdash_seo` (title, description, image, canonical, no_index), `getSeoMeta`", "src", "done", "load.ts `seo` on pages; verify `seo-title/description/canonical/robots`", "Extend to posts/CPTs with the blog work.", "", "", "", "2/2"],
["og-twitter", "SEO", "Custom OG / Twitter title, description, image", "Only `seo_image`; no separate OG/Twitter text fields", "src", "partial", "og:image carried (load `ogRef`); sharing cards (packages/og)", "Custom OG/Twitter text: per-entry store in the SEO plugin + `page:metadata`.", "S", "low", "P2", ""],
["jsonld", "SEO", "Schema / JSON-LD", "`buildWebSiteJsonLd`, `buildBlogPostingJsonLd`, `page:metadata` jsonld", "src", "done", "StructuredData.astro (business, WebPage, breadcrumb), FAQPage from `faq`; verify `seo-jsonld` passed on both sites", "Rank Math custom schema (`rank_math_schema`: Event, Product, HowTo, Recipe…) is extracted but not mapped.", "M", "low", "P2", "2/2"],
["breadcrumbs", "SEO", "Visible breadcrumbs", "Page context `breadcrumbs` (JSON-LD only)", "src", "missing", "Breadcrumb JSON-LD only", "Breadcrumb component for nested pages/posts when the source showed one.", "S", "low", "P2", ""],
["sitemaps", "SEO", "XML sitemaps", "`/sitemap.xml`, `/sitemap-{collection}.xml` (has_seo + routable; no taxonomy/author)", "src", "partial", "Pages sitemap fixed in middleware; verify `sitemap` gate", "Posts/CPTs come with their collections; taxonomy/author sitemap route when those archives are indexable; image/video sitemaps P2.", "S", "low", "P1", "2/2"],
["robots", "SEO", "robots.txt custom rules", "Settings `seo.robotsTxt`, `disallowAiTraining`", "src", "partial", "Audit stores the live robots.txt (discover.ts); not carried", "Diff the live rules against EmDash's default; carry custom ones into `seo.robotsTxt` (owner-reviewed).", "S", "low", "P1", "2/2"],
["kml", "SEO", "Rank Math Local SEO `locations.kml`", "—", "none", "missing", "Not migrated (non-HTML file in the audit)", "Regenerate from the business data or 410 by decision.", "S", "low", "P2", "2/2"],
["verification", "SEO", "Search-engine verification meta", "Settings `googleVerification`, `bingVerification`", "src", "done", "site.config.json `verification` (scaffold) rendered in Base.astro", "Optionally write Google/Bing into EmDash settings so the owner can edit them.", "S", "low", "P2", "0/2"],
["indexing", "SEO", "Search Console, IndexNow", "—", "none", "done", "packages/seo (GSC service account, IndexNow on publish)", "—", "", "", "", ""],
// ── Tracking & third-party ────────────────────────────────────────────────
["analytics", "Tracking & scripts", "GA4, Google tag, GTM, Meta Pixel, Clarity, Hotjar, CF Web Analytics", "None in core; `page:fragments` hook (trusted plugins)", "src", "done", "packages/seo analytics (IDs, CSP host table, consent mode switch), verify `analytics`, `analytics-runtime`", "—", "", "", "", "2/2"],
["consent", "Tracking & scripts", "Cookie consent banner (Complianz, CookieYes, Cookie Notice, Cookiebot)", "None", "none", "missing", "Detected in audit (audit/integrations.ts); consent mode exists but no banner; hosted CMP scripts are not in the CSP", "Consent banner component (EmDash plugin settings: text, policy link, categories) wired to consent mode; allow-listed hosted CMPs (Cookiebot, OneTrust, Termly) by ID.", "M", "med", "P1", "0/2"],
["snippets", "Tracking & scripts", "Header/footer code (HFCM, WPCode, Insert Headers and Footers, Code Snippets)", "`page:fragments` (head, body:start, body:end; trusted-only)", "src", "partial", "Snippets read from the dump (import-dump → raw/code-snippets.json); known booking embeds rebuilt; unknown scripts not carried (strict CSP)", "Provider/snippet recognizer (in progress, another agent) → known providers by ID; unknown snippets → owner decision; optional trusted-snippet plugin with CSP hashes.", "M", "med", "P1", "1/2"],
["custom-css", "Tracking & scripts", "Customizer Additional CSS", "None", "none", "missing", "`custom_css` is in extract `SKIP_TYPES` (extract.ts L25): never read or reported", "Extract it, list it in coverage, carry reviewed rules to a `custom.css` (selectors rarely match the new markup).", "S", "low", "P1", "0/2"],
["embeds", "Tracking & scripts", "oEmbeds (YouTube, Vimeo, X/Twitter, Instagram, TikTok, Facebook, Spotify)", "`Embed.astro` (YouTube, Vimeo, video/audio, sanitized HTML); no runtime oEmbed", "src", "partial", "video section + embed allowlist (starter/src/utils/embed.ts `PROVIDER_HOSTS`): no X/Twitter, TikTok, Facebook", "Add providers to the allowlist + CSP with fixtures.", "S", "low", "P1", ""],
["widgets-3p", "Tracking & scripts", "Chat, reviews, social feeds, booking widgets", "—", "none", "partial", "Detected (integrations.ts); booking + some reviews hosts allowed; chat widgets (Tawk, Crisp, Intercom, HubSpot chat) not", "Covered by the snippet recognizer + per-provider CSP entries.", "M", "low", "P1", "2/2"],
["fonts", "Tracking & scripts", "Fonts (Google, self-hosted, Adobe), icon fonts", "—", "none", "partial", "scaffold/fonts.ts (Google / self-hosted), icon fonts → inline SVG; Adobe Fonts detected as “keep” but `use.typekit.net` is not in the CSP style/font sources", "Add Typekit hosts to the CSP when the kit embed is kept.", "S", "low", "P2", "2/2"],
["theme-options", "Tracking & scripts", "Theme options / customizer design (colours, type)", "—", "none", "done", "Design capture → tokens.css; Salient/Bricks/ACSS options when exported", "—", "", "", "", "2/2"],
// ── Settings ──────────────────────────────────────────────────────────────
["display-settings", "Settings", "Timezone, date format, posts per page", "Settings `timezone`, `dateFormat`, `postsPerPage`", "src", "missing", "Not carried", "From the exporter `options` (check which keys it returns) or the dump; needed once dates are shown.", "S", "low", "P1", ""],
["language", "Settings", "Site language", "Astro i18n config / `lang`", "src", "done", "`site.lang` from the audited `<html lang>`, og:locale", "—", "", "", "", "2/2"],
["reading", "Settings", "Discourage search engines (blog_public)", "`staging` (noindex), robots", "src", "done", "Audit robots; verify `seo-robots`; cutover `indexable`", "—", "", "", "", ""],
// ── Platform & operations ─────────────────────────────────────────────────
["caching", "Platform", "Caching / CDN / optimisation plugins", "Route cache, Workers", "src", "superseded", "Performance package (scaffold/perf.ts), verify `route-cache`", "—", "", "", "", "2/2"],
["security", "Platform", "Security plugins (Wordfence, login protection)", "Passkeys, magic links, OAuth, Access; Cloudflare WAF", "src", "superseded", "Security headers + CSP (middleware), verify `security-headers`, `wp-endpoints`", "—", "", "", "", "1/2"],
["backups", "Platform", "Backups (UpdraftPlus, host backups)", "`/settings/backups` (content, schema, settings; scheduled; no media binaries, no users); D1 Time Travel 30 days", "src", "partial", "Client docs `operations.md` (D1 Time Travel); bookmark before live loads (targets/d1-backup.ts); R2 media and KV not backed up off-account", "Scaffold a scheduled off-account export (`emdash site export` in CI → private storage) + R2 copy; document restore and test it once.", "M", "med", "P1", ""],
["maintenance", "Platform", "Maintenance / coming-soon mode", "None (`staging` = noindex only)", "none", "missing", "—", "Middleware flag (setting or plugin) serving a 503 page to visitors, editors bypass.", "S", "low", "P2", "0/2"],
["cron", "Platform", "WP-Cron tasks", "Worker `scheduled()`: plugin cron, scheduled publish, cleanup", "src", "superseded", "Forms outbox on the cron (starter/src/worker.ts)", "Plugin-specific jobs rebuilt per feature.", "", "", "", ""],
["a11y", "Platform", "Accessibility", "—", "none", "done", "axe gate, accessible header/menu, reduced motion; overlay widgets (accessiBe, UserWay) → recommend drop", "—", "", "", "", "2/2"],
["legal", "Platform", "Legal pages (privacy, terms, cookie policy)", "Pages", "src", "done", "Ordinary pages; plugin-generated policy shortcodes (Complianz `[cmplz-document]`, CookieYes) would show as unmapped shortcodes", "Handler: take the rendered text from the audit snapshot, flagged for owner review.", "S", "low", "P2", "2/2"],
["i18n", "Platform", "Multilingual (WPML, Polylang)", "Locales, `translation_group`, translatable fields, hreflang, menus/terms per locale; exporter reports locale + translation group", "src", "oos", "Fingerprint marks out-of-scope (v2)", "v2: one locale per WPML language, link by translation group, hreflang from EmDash.", "L", "high", "P2", "0/2"],
// ── Out of scope ──────────────────────────────────────────────────────────
["woocommerce", "Out of scope", "WooCommerce / shops", "None (no commerce)", "none", "oos", "Detected, migration stops for a decision (PLAN §9)", "Needs a commerce platform (Shopify, Stripe Checkout, Snipcart); product catalogue could become a collection, checkout cannot.", "", "", "OOS", "0/2"],
["membership", "Out of scope", "Memberships, LMS, paywalls, front-end accounts", "Roles exist but no paywall/LMS", "src", "oos", "Detected (PLAN §9)", "Separate product decision.", "", "", "OOS", "0/2"],
["events", "Out of scope", "Events plugins (The Events Calendar, Modern Events)", "—", "none", "oos", "Not handled", "Simple event lists via the CPT mapper (`events` collection with datetime fields); recurrence, tickets, iCal feeds out of scope.", "M", "med", "P2", "0/2"],
["booking-plugins", "Out of scope", "WordPress-hosted booking engines (Amelia, Bookly)", "—", "none", "oos", "SaaS booking widgets are kept as embeds; WP-hosted engines are not", "Replace with a SaaS provider (owner decision).", "", "", "OOS", "0/2"],
["multisite", "Out of scope", "Multisite, BuddyPress, bbPress, directories, custom business-logic plugins", "Plugin system (sandboxed Worker plugins)", "src", "oos", "PLAN §9", "Per site, or port via `wordpress-plugin-to-emdash`.", "", "", "OOS", "0/2"],
];

const cols = ["id", "area", "feature", "emdash", "emdashConfidence", "status", "kit", "gap", "effort", "risk", "priority", "sitesUsed"];
const rows = R.map((r) => Object.fromEntries(cols.map((c, i) => [c, r[i]])));
for (const r of rows) if (r.length !== undefined) throw new Error("bad row");
for (const r of R) if (r.length !== cols.length) throw new Error(`row ${r[0]} has ${r.length} cells`);

const inScope = rows.filter((r) => r.status !== "oos");
const count = (s) => inScope.filter((r) => r.status === s).length;
const pct = (n) => `${Math.round((n / inScope.length) * 100)}%`;
const summary = { areas: rows.length, inScope: inScope.length, done: count("done"), superseded: count("superseded"), partial: count("partial"), missing: count("missing"), outOfScope: rows.length - inScope.length };

const backlog = [
	// [rank, priority, title, rows, effort, notes]
	[1, "P0", "Posts collection: Gutenberg/classic → Portable Text (EmDash converter + kit shortcode pass), dates, excerpt, featured image, permalinks, `?p=` for posts", ["posts", "post-dates", "post-permalinks", "excerpt", "featured-image", "wp-ids"], "L", "Biggest gap: no blog content reaches EmDash today. Builder posts currently land in `pages`."],
	[2, "P0", "Verify every audited URL: 200, single-hop 301 to a mapped target, or 410 with a decision", ["archive-urls"], "M", "Closes the silent hole: today only published IR pages are checked (verify.ts ~L118)."],
	[3, "P0", "List every non-empty unhandled post type in coverage + transform gate", ["cpt"], "S", "Never-silently-drop rule; prerequisite for the CPT mapper."],
	[4, "P0", "Taxonomies: defs, terms, assignments", ["categories-tags", "custom-taxonomies"], "M", "REST `/taxonomies/{name}/terms` and `bulk-tag` exist."],
	[5, "P0", "Bylines from WordPress authors", ["bylines"], "M", "Content create/update accept `bylines`."],
	[6, "P0", "Starter blog templates: single post, blog index, category/tag/author archives, pagination", ["archives", "single-post"], "M", "EmDash injects no archive routes."],
	[7, "P0", "Feeds: `/feed/` + category feeds from posts; redirect/410 rule and verify check for sites without posts", ["rss"], "S", "Both real sites linked feeds on every page."],
	[8, "P0", "Custom post type mapper (collection per type, fields, urlPattern, templates)", ["cpt"], "L", "Builds on items 1, 3, 4."],
	[9, "P1", "Search page + `/?s=` redirect; other WP query URLs (`?cat`, `?tag`, `?author`, `?attachment_id`, `?feed`) and attachment pages", ["search", "wp-query-urls", "attachment-pages"], "S", "Keeps the WebSite SearchAction valid."],
	[10, "P1", "Comments import (spike the write path first)", ["comments", "comment-settings"], "M", "No admin bulk-create route found; site-transfer `comment` records are the likely path."],
	[11, "P1", "Third-party scripts: snippet recognizer (in progress), consent banner, chat/embeds allowlist, Customizer CSS", ["snippets", "consent", "custom-css", "embeds", "widgets-3p"], "M", "The consent banner is P0 for EU/UK clients."],
	[12, "P1", "Elementor adapter", ["elementor"], "L", "Most common builder after Gutenberg."],
	[13, "P1", "DOM-fallback adapter (any builder, flagged)", ["other-builders"], "L", "Universal safety net in the PLAN; not built."],
	[14, "P1", "ACF / Meta Box / Pods field mapping", ["acf"], "L", "Reuse EmDash's `ACF_FIELD_TYPES` mapping."],
	[15, "P1", "Settings into EmDash: logo, favicon, social, robots.txt rules, timezone, date format, posts per page (EmDash Settings prefill in progress)", ["logo-favicon", "social", "robots", "display-settings"], "S", "Lets the owner edit identity in the admin."],
	[16, "P1", "Menus: write every menu, link items to entries", ["menus"], "S", "`other`-role menus are dropped today."],
	[17, "P1", "Widgets / sidebars", ["widgets"], "M", "Classic-theme footers and sidebars."],
	[18, "P1", "Media completeness: upload library-only files and PDFs linked in content", ["media-files", "pdf"], "S", ""],
	[19, "P1", "Divi adapter", ["divi"], "L", "Reuses the shortcode parser."],
	[20, "P1", "Gutenberg: core file/audio, block libraries (Kadence, Spectra, GenerateBlocks)", ["gutenberg", "gutenberg-libs"], "M", ""],
	[21, "P1", "Scheduled and password-protected content", ["scheduled", "password-protected"], "M", ""],
	[22, "P1", "Off-account backups (scheduled site export + R2)", ["backups"], "M", ""],
	[23, "P1", "Forms: Ninja/Formidable/Elementor extractors, file uploads, conditional logic", ["forms-other", "forms-features"], "M", ""],
	[24, "P1", "Post-launch 404 → redirect suggestions; sitemaps for posts/terms", ["404-log", "sitemaps"], "S", "Check overlap with packages/health."],
];
const p2 = rows.filter((r) => r.priority === "P2").map((r) => r.id);
const oos = rows.filter((r) => r.priority === "OOS" || r.status === "oos");

const json = {
	$comment: "Generated with docs/parity/wp-to-emdash.md. Status: done | partial | missing | superseded | oos. emdashConfidence: src (installed emdash 1.5.0 source) | docs | none (not in EmDash; theme/kit builds it). sitesUsed: of the two migrated real sites.",
	generated: "2026-11-20",
	emdashVersion: "1.5.0",
	summary,
	rows,
	backlog: backlog.map(([rank, priority, title, ids, effort, notes]) => ({ rank, priority, title, rows: ids, effort, notes })),
	p2,
	outOfScope: oos.map((r) => ({ id: r.id, feature: r.feature, reason: r.gap })),
};
writeFileSync(`${OUT}/wp-to-emdash.json`, JSON.stringify(json, null, "\t") + "\n");

// ── Markdown ───────────────────────────────────────────────────────────────
const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
const STATUS = { done: "✅ done", partial: "🟡 partial", missing: "❌ missing", superseded: "➖ superseded", oos: "⛔ out of scope" };
const CONF = { src: "", docs: " *(docs)*", none: " *(not in EmDash)*" };
const areas = [...new Set(rows.map((r) => r.area))];
const L = [];
L.push(`# WordPress → EmDash parity`, "");
L.push(`What a small-business or content WordPress site can contain, where each thing lives in EmDash 1.5.0, what the kit does with it today, and what closing each gap takes. The same data is in [\`wp-to-emdash.json\`](./wp-to-emdash.json); keep the two in sync.`, "");
L.push(`As of 2026-11-20, against EmDash 1.5.0 (installed source) and the kit at that date. Evidence from real sites is counted across the two migrated sites only, with no client details. Status values: ✅ done · 🟡 partial · ❌ missing · ➖ superseded (the platform replaces the WordPress feature, so nothing has to be carried) · ⛔ out of scope. Effort: S ≤ 1 day, M = 2–5 days, L = 1–3 weeks.`, "");
L.push(`## 1. Executive summary`, "");
L.push(`The matrix covers ${summary.areas} features; ${summary.inScope} of them are in scope.`, "");
L.push(`| | Count | Share of in-scope |`, `|---|---|---|`);
L.push(`| ✅ Done | ${summary.done} | ${pct(summary.done)} |`);
L.push(`| ➖ Superseded (nothing to carry) | ${summary.superseded} | ${pct(summary.superseded)} |`);
L.push(`| 🟡 Partial | ${summary.partial} | ${pct(summary.partial)} |`);
L.push(`| ❌ Missing | ${summary.missing} | ${pct(summary.missing)} |`);
L.push(`| ⛔ Out of scope (not counted) | ${summary.outOfScope} | — |`, "");
L.push(`**What this means.** The kit fully migrates a brochure site: builder pages (WPBakery/Salient, Bricks, Gutenberg pages), header and footer, menus, popups and announcement bars, media in use, forms, SEO meta, JSON-LD, analytics, redirects from plugin exports, and old upload/sitemap/\`?page_id\` URLs. Both real sites were exactly that. They had no posts, comments, CPT entries, terms in use, widgets, consent banner or redirect rules.`, "");
L.push(`Anything beyond that is missing today. The kit has no blog: no posts collection, taxonomies, bylines, archives or feeds. It has no custom post types, ACF fields, comments, widgets, consent banner or Customizer CSS, and no adapters for Elementor, Divi or other builders. Verify also has a blind spot: it checks only the audited URLs that became migrated pages, so a lost post, category or author URL would not turn any gate red.`, "");
L.push(`**Top 10 gaps by impact**`, "");
const top = [
	"**Blog posts are not migrated.** No `posts` collection exists, Gutenberg/classic posts are skipped in transform, and builder posts are written into `pages`. Rows: posts, post-dates, post-permalinks, excerpt, featured-image.",
	"**Verify ignores audited URLs that are not migrated pages.** Post, term, author, attachment and feed URLs are never checked (verify.ts ~L118), which goes against the never-silently-drop rule. Row: archive-urls.",
	"**Custom post types are neither migrated nor reported.** The extract fetches them; transform ignores them without a coverage entry. ACF, Meta Box and Pods fields are not mapped. Rows: cpt, acf.",
	"**Categories, tags and custom taxonomies are extracted but never loaded.** Rows: categories-tags, custom-taxonomies.",
	"**No authors or bylines.** Row: bylines.",
	"**The starter has no blog index, single-post template, category/tag/author archives, pagination or search page.** EmDash injects none of these. Rows: archives, single-post, search.",
	"**No RSS feeds.** EmDash has none, and `/feed/` returns 404 even though both real sites linked feeds on every page. Row: rss.",
	"**Comments are extracted but not loaded,** and EmDash has no bulk-create API for them. Row: comments.",
	"**Third-party scripts have no home.** There is no consent banner, no carry-over of Customizer CSS (it is skipped in extract), header/footer snippets are only partly handled, and chat widgets and X/TikTok/Facebook embeds are blocked by the CSP. Rows: consent, custom-css, snippets, embeds, widgets-3p.",
	"**Only three builders are supported.** There are no Elementor, Divi or DOM-fallback adapters, so most other WordPress sites stop at transform. Rows: elementor, divi, other-builders.",
];
top.forEach((t, i) => L.push(`${i + 1}. ${t}`));
L.push("");
L.push(`## 2. Parity matrix`, "");
L.push(`Columns: the WordPress feature · its EmDash 1.5 home (evidence level in italics when it is not from source) · what the kit does now, with file references · the gap and how to close it · effort / risk · priority · how many of the 2 real sites used it.`, "");
for (const a of areas) {
	L.push(`### ${a}`, "");
	L.push(`| WP feature | EmDash 1.5 home | Kit status + refs | Gap & approach | Effort / risk | Pri | Sites |`);
	L.push(`|---|---|---|---|---|---|---|`);
	for (const r of rows.filter((x) => x.area === a)) {
		L.push(`| ${esc(r.feature)} <sub>\`${r.id}\`</sub> | ${esc(r.emdash)}${CONF[r.emdashConfidence]} | ${STATUS[r.status]}: ${esc(r.kit)} | ${esc(r.gap)} | ${r.effort ? `${r.effort} / ${r.risk}` : "—"} | ${r.priority || "—"} | ${r.sitesUsed || "—"} |`);
	}
	L.push("");
}
L.push(`## 3. Prioritized backlog`, "");
L.push(`**P0** is what a typical small-business site with a blog needs to call the migration “100%”. **P1** covers common plugins and builders. **P2** covers fidelity details and rarer features. Items in progress elsewhere are marked as such.`, "");
L.push(`| # | Pri | Item | Rows | Effort | Notes |`, `|---|---|---|---|---|---|`);
for (const [rank, pri, title, ids, effort, notes] of backlog) L.push(`| ${rank} | ${pri} | ${esc(title)} | ${ids.map((i) => `\`${i}\``).join(", ")} | ${effort} | ${esc(notes)} |`);
L.push("");
L.push(`**P2:** ${p2.map((i) => `\`${i}\``).join(", ")}. Each row in §2 gives its approach.`, "");
L.push(`**Out of scope (detected, migration stops for an owner decision):**`, "");
for (const r of oos) L.push(`- **${r.feature}**: ${r.gap}`);
L.push("");
L.push(`**Suggested order.** Start with items 2 and 3 (S/M): they make every remaining gap visible as a red gate instead of a silent loss. Then items 1, 4, 5, 6 and 7 together as one “blog” milestone, tested against a fixture blog and a real WordPress blog. After that, item 8 and the P1 items in the order the next client sites need them.`, "");
L.push(`## 4. Verification notes`, "");
L.push(`**Confirmed in the installed EmDash 1.5.0 source** (\`emdash/src\`, \`@emdash-cms/*\`; read 2026-11-20):`, "");
L.push(`- 17 field types and flat-only repeaters (\`schema/types.ts\`).`);
L.push(`- Entry system columns: no parent, menu_order or template; statuses \`draft|published|archived\` (\`schema/registry.ts\`, \`query.ts\`).`);
L.push(`- Taxonomy, menu, widget, section and byline tables plus their REST routes (\`astro/routes/api/{taxonomies,menus,widget-areas,sections}\`).`);
L.push(`- Content create/update accept \`bylines\` and \`publishedAt\`; \`publishedAt\` requires \`content:publish_any\` (\`api/schemas/content.ts\`).`);
L.push(`- Comments: table, statuses, one-level threading, Turnstile; only the per-entry public submission route was found (\`comments/public-submission.ts\`, \`routes/api/comments/[collection]/[contentId]\`).`);
L.push(`- Redirects (301/302/307/308/410/451, \`[param]\` patterns, 404 log) and auto-redirects on slug change.`);
L.push(`- \`SiteSettings\` keys: \`title tagline logo favicon url staging postsPerPage dateFormat timezone social seo{titleSeparator defaultOgImage robotsTxt disallowAiTraining googleVerification bingVerification}\` (\`settings/types.ts\`).`);
L.push(`- Sitemaps cover only collections that are both SEO-enabled and routable, with no taxonomy or author sitemaps; the robots.txt route exists.`);
L.push(`- **No RSS/Atom anywhere in src.**`);
L.push(`- FTS5 search; media allowlist (no SVG by default; PDF, audio and video allowed); media has \`caption\` but no title/description.`);
L.push(`- Scheduled publishing runs on the Worker \`scheduled()\` handler.`);
L.push(`- \`page:fragments\` hook is trusted-only; \`page:metadata\` exists.`);
L.push(`- Email has no attachments.`);
L.push(`- Seed keys: \`settings collections blockTypes relations taxonomies menus redirects widgetAreas sections bylines content\`; there are no seed keys for comments or SEO.`);
L.push(`- EmDash's own WordPress import paths: WXR upload; Exporter-plugin import, which writes SEO into \`seo_title\`/\`seo_description\` content fields; CLI. The Exporter-plugin import is the only one that imports comments. None of them imports redirects or widgets.`);
L.push(`- \`@emdash-cms/gutenberg-to-portable-text\` handles core audio/file/table/embed among others.`, "");
L.push(`**Docs only (not re-checked in source):** atproto/Atmosphere login; the Docs MCP and agent skills; “shortcodes are not expanded” by the converter.`, "");
L.push(`**Kit status** comes from reading the kit source at the paths cited. Line numbers are approximate (~). The real-site columns come from each site's audit, extract, transform and verify reports and \`decisions.md\`, and are counts only.`, "");
L.push(`**Assumed or still to verify before code depends on it** (record each result in \`docs/spikes/\`):`, "");
L.push(`- Whether the kit's API token scopes allow \`publishedAt\` overrides (needs \`content:publish_any\`; the scopes listed in M6-findings do not name it).`);
L.push(`- The REST schedule endpoint for future posts. MCP has \`content_schedule\`; the REST path was not read.`);
L.push(`- A write path for comments: \`emdash site import\` with \`comment\` records, or \`importCommentsFromPlugin\`. Neither is exercised yet.`);
L.push(`- Which \`options\` keys the Exporter returns: timezone, date_format and posts_per_page were not confirmed (M3 lists identity, front page, permalink structure and site icon).`);
L.push(`- Which WordPress widget REST routes work with an application password on WP ≥ 5.8.`);
L.push(`- Whether \`urlPattern\` can express date-based permalinks. No placeholders other than \`{slug}\` were found, so the plan stores the WP path as the slug.`);
L.push(`- Whether EmDash's \`buildWebSiteJsonLd\` emits a SearchAction.`);
L.push(`- The kit's handling of WordPress core \`[caption]\`, \`[audio]\`, \`[video]\`, \`[embed]\` and \`[playlist]\` shortcodes. Only \`[gallery]\` was confirmed.`);
L.push("");
writeFileSync(`${OUT}/wp-to-emdash.md`, L.join("\n"));
console.log(JSON.stringify(summary));
