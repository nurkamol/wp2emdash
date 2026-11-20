# EmDash's built-in Settings, prefilled from WordPress — verified facts (2026-11-20)

Checked against the installed **EmDash 1.5.0 and @emdash-cms/admin 1.5.0** (read in a kit site project's
`node_modules`, never modified) and a throwaway copy of a generated project (scratch directory, local dev server on
localhost with dev-bypass, structure-only setup; `astro check`: 0 errors). Nothing was deployed; no live site, DNS or
production data was touched.

## Settings schema and API

- Keys (`emdash/src/api/schemas/settings.ts`, `settings/types.ts`): `title`, `tagline`, `logo`, `favicon` (media
  references), `url`, `staging`, `postsPerPage` (int 1–100), `dateFormat`, `timezone`, `social.{twitter, github,
  facebook, instagram, linkedin, youtube}` (free strings; no other networks), `seo.{titleSeparator (≤10),
  defaultOgImage (media ref), robotsTxt (≤5000), disallowAiTraining, googleVerification (≤100), bingVerification
  (≤100)}`.
- Write: `POST /_emdash/api/settings` (permission `settings:manage`). A media reference is written as
  `{ mediaId, alt? }`; resolved fields a client posts back are stripped by Zod. `null` removes `logo` / `favicon` /
  `seo.defaultOgImage`. Top-level keys are replaced; **`seo` and `social` are merged field by field**
  (`settings/index.ts` `NESTED_SETTING_KEYS`). Measured: a second POST with only `social.youtube` kept the facebook and
  instagram values written before.
- Read: `GET /_emdash/api/settings` returns media references resolved: `{ mediaId, alt, url:
  "/_emdash/api/media/file/<storageKey>", contentType, width, height }` (measured).
- The admin's General, Social Links and SEO screens each save the whole settings object they loaded (minus `url` on
  General); the General screen writes `alt: media.alt || ""` when a logo is picked. Load therefore compares media by
  `mediaId` only.
- Date format: the admin formats with **date-fns** (`format(date, pattern)`, default `MMMM d, yyyy`). WordPress's PHP
  `date_format` is converted (`F j, Y` → `MMMM d, yyyy`, `jS` → `do`, escaped letters quoted); a token date-fns has no
  match for leaves the default and is reported. Timezone must pass `Intl.DateTimeFormat` (the admin refuses others):
  `timezone_string`, else a whole-hour `gmt_offset` as `Etc/GMT∓N`.
- Social Links hints in the admin ask for handles ("@username", "channel ID or handle"); core EmDash never reads
  `social`. Load stores full profile URLs (LinkedIn company pages and YouTube channels are ambiguous as handles); the
  starter accepts both (`utils/settings.ts` `socialHref`).
- Media uploads: `GLOBAL_UPLOAD_ALLOWLIST` has png, jpeg, gif, webp, avif, bmp, jxl (no SVG, no `.ico`). EmDash dedupes
  uploads by `contentHash` = `sha1:<hex>` of the bytes and returns the existing item (keeping its file name).

## What EmDash's head prints from settings (EmDashHead.astro, page/site-identity.ts, page/seo-contributions.ts)

- `<link rel="icon" href="<favicon url>" type="<mime>">` when `favicon` is set — always, it cannot be suppressed by
  the template. No apple-touch-icon (deliberately, upstream).
- `google-site-verification` and `msvalidate.01` meta tags from `seo.googleVerification` / `seo.bingVerification`.
- `og:image` / `twitter:image` from `seo.defaultOgImage` only when the page has no image of its own and no plugin
  contributed one (plugin contributions win; the sharing-cards plugin does). Absolutized with `settings.url`.
- Measured on the local copy: favicon link, both verification tags, `robots.txt` from the setting.

## robots.txt

- EmDash serves `/robots.txt` itself (`astro/routes/robots.txt.ts`); the starter has no route of its own. With
  `seo.robotsTxt` set it is served as written, a `Sitemap:` line appended only when none is present; without it a
  default (`Allow: /`, `Disallow: /_emdash/`, `Sitemap: <site url>/sitemap.xml`). `Cache-Control: no-store` while
  `staging`, else `public, max-age=86400` (measured: no-store on the staging-flagged copy).
- The kit sets `seo.robotsTxt` only when the live file had rules of its own: WordPress-only rules (`/wp-admin/`,
  `/wp-includes/`, `/wp-content/…`, `?s=`, feeds, `xmlrpc.php`…) are dropped, every `Sitemap:` line becomes
  `<productionUrl>/sitemap.xml`, and `Disallow: /_emdash/` + `Allow: /_emdash/api/media/file/` keep EmDash's admin out
  while images stay crawlable. A stock WordPress file leaves the setting empty (EmDash's default is equivalent).

## Freshness

- Settings saves call `invalidateRouteCache(cache, [siteSettingsTag()])` (`astro/routes/api/settings.ts`): every page
  carries that tag through the chrome loader (`utils/chrome.ts` → `getSiteSettingsWithCacheHint`), so the logo,
  favicon, social links, verification and default image the starter reads purge with the save (settings purges were
  measured visible in 3.2 s: performance-findings.md). The media-row lookup below runs in the same render.
- Worker isolates keep a 30 s stale-while-revalidate snapshot of settings (`SITE_SETTINGS_CACHE_TTL_MS`); see
  M8-findings.md for the redeploy note on `staging`.

## The migrated logo keeps its optimized files

- Scaffold writes `brandSha1.{logo,favicon}` (sha1 of the original brand files) into `site.config.json`. Load uploads
  those files as the logo/favicon settings, named `wp2emdash-<name>-<sha1:10>.<ext>` (an SVG is drawn to PNG and an
  `.ico` replaced by the largest sized PNG/WebP icon, so the bytes differ; the name still identifies them).
- The starter reads `SELECT id, content_hash, filename FROM media WHERE id IN (logo, favicon)` (one D1 query, only
  when a logo/favicon setting is set). Same content hash, or the `wp2emdash-` name → the hashed brand files
  (WebP logo with size, sized favicons, light logo over the hero) stay. Measured on the copy: with `brandSha1` matching
  the uploaded file the header kept `/brand/h/logo.<hash>.webp` (155×200) and the sized favicon links; without it the
  header served the media file at the header's logo height (`width=100 height=100`) and the favicon links were EmDash's
  plus an apple-touch icon from the same file.
- Known duplicate: with a favicon setting EmDash always prints its own `<link rel="icon">` next to the starter's sized
  icons. Browsers choose among them by size; not measured which one Chrome/Safari fetch first.

## Not verified here

- The end-to-end admin flow in a browser (picking a logo in Settings → General on a deployed site, then the cached page
  updating): the purge path is read from source, the render path measured on the local copy.
- A Rank Math / Yoast database with `social_url_*`, `twitter_author_names`, `wpseo_social` filled in: the option names
  are from the plugins' documented option arrays; the one real Rank Math export at hand had none of them set.
- `og:image:width/height` for the default image when sharing cards are off (the copy had cards on, so the plugin's
  card won, as expected).
