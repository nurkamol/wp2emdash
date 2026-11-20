# Content & forms: protected content, linked documents, more form plugins, shortcodes (2026-11-21)

What the kit does for password-protected/private content, files linked from content, the remaining form plugins and
plugin shortcodes — and the EmDash 1.5.0 behaviour each part depends on, read in the installed source
(`emdash/src`, `@emdash-cms/auth`, read-only) unless marked otherwise. No client data.

## Verified in EmDash 1.5.0

| Fact | Where | Used by |
|---|---|---|
| Entry statuses are `draft \| published \| archived`; no private or password status. EmDash's own WordPress importers turn password-protected posts into drafts and list them (`passwordProtected`) | `astro/routes/api/import/wordpress/execute.ts` (`const status = passwordProtected ? "draft" : …`), `cli/commands/import/wordpress.ts` | protected content |
| The Exporter plugin's post shape has no password field (`PluginPost`); the WXR parser reads `wp:post_password` | `import/sources/wordpress-plugin.ts`, `cli/wxr/parser.ts` | extract reads passwords over WordPress REST instead |
| The sitemap lists published, slugged rows that are **not** `seo_no_index` | `api/handlers/seo.ts` (`AND (s.seo_no_index IS NULL OR s.seo_no_index = 0)`) | protected pages: noindex keeps them out |
| Public search returns published content only (drafts need `content:read_drafts`) and indexes a collection's `searchable` fields | `astro/routes/api/search/index.ts`, `search/fts-manager.ts` | posts' protected text moves to a non-searchable `access_body`; pages' `content` is not searchable in the kit's seed |
| Content REST needs `content:read` (no anonymous reads) | `astro/routes/api/content/[collection]/index.ts` | the hash in `access_password` is not public |
| `content:beforeSave` plugin hook exists (could hash a password typed in the admin) | `plugins/hooks.ts` | not used yet (follow-up): an owner's new password is stored as typed; the starter accepts hash or text |
| Media upload stores `alt` and `caption` only (`mediaUploadMetadataForm`) | `api/schemas/media.ts`, `astro/routes/api/media.ts` | captions carried; titles/descriptions reported |
| Global upload allowlist: PNG, JPEG, GIF, WebP, AVIF, BMP, JXL, `video/`, `audio/`, PDF | `api/handlers/media-allowlist.ts` `GLOBAL_UPLOAD_ALLOWLIST` | PDFs/audio go in directly |
| An upload naming `fieldId` of a `file`/`image` field with `validation.allowedMimeTypes` uses that list instead | `resolveFieldAllowlist`, `astro/routes/api/media.ts` (`formData.get("fieldId")`); schema allows 1–64 entries (`api/schemas/schema.ts`) | Word/Excel/ZIP… through the `wp_documents` field load creates on `pages` |
| `GET /schema/collections/{c}/fields` → `{ items: Field[] }` with each field's `id` (`schema:read`) | `astro/routes/api/schema/collections/[slug]/fields/index.ts`, `api/handlers/schema.ts` | load finds the field id |
| Uploads dedupe by content hash (`findByContentHash`, `contentHash` column) | `astro/routes/api/media.ts` | duplicate WordPress files → one media item (the kit also dedupes by sha1) |
| The file route sends everything but simple images/audio/video as `Content-Disposition: attachment` with the original filename | `astro/routes/api/media/file/[...key].ts` (`SAFE_INLINE_TYPES`) | reported: PDFs download instead of opening in the tab |
| Keys under `backups/` are never served by the public media route | `transfer/staging/keys.ts` `PRIVATE_STORAGE_PREFIXES` (also docs/spikes/change-requests-findings.md) | form uploads under `backups/form-uploads/` |

**Workers runtime (Cloudflare docs, not re-tested here):** WebCrypto PBKDF2 accepts at most 100,000 iterations — the
kit hashes with exactly 100,000 (node `pbkdf2Sync` in the kit, `crypto.subtle.deriveBits` in the starter; the test
`test/protected.test.ts` checks that one verifies the other).

## Password-protected and private content

- **Extract:** `wp/v2/<pages|posts>?context=edit&_fields=id,password` (an editor's application password); without it,
  `_fields=id,content` → `content.protected`. Passwords are hashed at once (`pbkdf2-sha256$100000$salt$hash`) into
  `raw/protected.json`; a `password`/`post_password` field in Exporter output is stripped before raw/ is written.
- **Transform:** `overrides.ts protectedContent` (defaults: password → `protect`, private → `draft`; `protectedPosts`
  still decides posts). WordPress's password form in the audit snapshot (`post-password-form`,
  `wp-login.php?action=postpass`) also marks a page protected. IR: `access: { kind, as }` (never the hash). Gate
  `protected-content` is red only when a `protect` item has no hash and the site has no `WP2EMDASH_PROTECTED_PASSWORD`.
- **Load:** fields `access_password` (pages/posts) and `access_body` (posts) created on demand; the hash is written on
  the first load and an owner's later value is kept; posts' body/excerpt emptied (search), SEO noindex, no description.
- **Starter:** `[...slug].astro` → `components/AccessGate.astro` until `wp2e_access_<id>` (HMAC of id + expiry, keyed with
  `ACCESS_SECRET` + the stored value; 10 days) is valid; `POST /api/access` (rate limited by `PROTECT_LIMITER`, else
  `FORM_LIMITER`); every protected response `Cache-Control: private, no-store` + `X-Robots-Tag: noindex, nofollow`;
  scaffold leaves protected paths out of the route-cache rules; seed keeps them drafts.
- **Verify:** `protected-pages` (password page, no content, no-store, noindex, not in the sitemap); owner-decided drafts
  count as gone for `urls-accounted`. **Not tested on a live EmDash yet** (unit tests + `astro check` only).

## Files linked from content

Load collects every site upload address in `href` values and in `href`/`src` attributes of raw HTML, maps it to the
file extract downloaded (library or not; `uploadsPath` folds case and image size suffixes), uploads it (fieldId for
non-global types), rewrites the links (also inside raw HTML), and checks gate `documents`. `overrides.ts
media.library` (default `documents`) uploads library documents nobody links, so the starter's `legacyUpload` finds
them by name. Extract's URL scan now also finds `.odt .ods .odp .rtf .csv .txt .rar .7z .epub .pps(x) .dotx .gz .tar`
under the uploads folder. **Not exercised against a live EmDash yet.**

## Forms

- Parsers (data shapes from each plugin's public export format, no plugin code): Ninja Forms `.nff`, Formidable XML,
  WS Form JSON, Forminator JSON; Gravity/WPForms/CF7/Fluent/Elementor gained file fields, simple conditions and steps.
  Synthetic fixtures (`test/fixtures/forms`); **check each against the first real export a client sends.** Ninja and
  Forminator exports carry no form id: it comes from the file name (`ninja-form-3.nff`).
- Conditions carried: one controlling field, `is` / `is not`, one or several values (`showIf`); anything else is a
  note. Payment fields are blocking warnings.
- Rendered-HTML fallback: a live form (audit `integrations.json`) without an export becomes a definition with a
  blocking warning.
- `@wp2emdash/forms` 1.7: file fields (`uploads.ts`), `showIf`/`step` (`logic.ts`), download route
  `src/pages/api/forms/file.ts` and an hourly purge (only on sites with file fields). Needs `FORM_FILE_SECRET`.
- Fixed: WPBakery/Bricks/Elementor form sections used provider `cf7` while definitions are `contact-form-7-<id>`; CF7
  5.8+ hash ids (`[contact-form-7 id="1a2b3c4"]`) now resolve through an alias definition.

## Shortcodes

`src/adapters/shortcodes.ts` (≈170 names): forms, breadcrumbs (flag `ir/shortcodes.json breadcrumbs: true`), wrappers
(stripped, content kept), widgets (warn; content widgets block), core media in pages (`[gallery]`, `[caption]`,
`[embed]`, `[video]`, `[audio]` → link). Unknown non-builder shortcodes now block even without attributes. Coverage
report "Shortcodes": name, action, count, sample page, blocking.

**Pre-existing, not changed here:** a WPBakery row that holds a video or another collection element together with a
button and an image drops the button and the image without a diagnostic (row recogniser in
`src/adapters/wpbakery/index.ts`). Reproduce: `[vc_column_text]Text[/vc_column_text][nectar_btn …][vc_single_image …][vc_video …]` in one column.
