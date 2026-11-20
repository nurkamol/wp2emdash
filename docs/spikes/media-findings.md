# Media Assistant — verified facts (2026-11-20)

Checked against the installed **EmDash 1.5.0, @emdash-cms/blocks 1.5.0, @astrojs/cloudflare 14.4.8, Wrangler 4.163.0,
@cloudflare/workers-types 5.20261116.1** (read in a kit site project's `node_modules`, never modified) and Cloudflare's
Workers AI model catalogue (2026-11-20). Build-checked in a throwaway copy of that project (below). Nothing deployed.

## Plugin media API (`emdash/src/plugins/types.ts`, `plugins/context.ts`, `plugins/media.ts`)

- `ctx.media`: `get`, `list({ limit, cursor, mimeType })` (capability `media:read`); `readBytes(id, { maxBytes })`
  (`media:bytes:read`; default 10 MB, **at most 16 MB**, ready items only, returns `contentHash` when stored);
  `updateMetadata(id, { alt, caption, focalX, focalY })` (`media:metadata:write`; focal point must be a complete pair,
  at least one field must change — an empty patch throws); `upload`, `getUploadUrl`, `delete` (`media:write`).
- `MediaItem` carries `width`, `height`, `alt`, `focalX/Y`, `folderId`, `blurhash` — **not** the storage key or the
  content hash. **No replace, no folder move, no usage** in the plugin API.
- Hooks: `media:beforeUpload(event: { file: { name, type, size } })` — metadata only, **never the bytes** (needs
  `media:write`); `media:afterUpload(event: { media })` (needs `media:read`) — not fired for deduplicated uploads.
  So optimize-on-upload cannot transform during the upload: the plugin queues the id.
- Upload allowlist (`api/handlers/media-allowlist.ts`): png, jpeg, gif, webp, avif, bmp, jxl, video/*, audio/*, pdf.
  **SVG is not accepted** (it can only exist from imports) — the Formats list says so.
- Uploads are deduplicated by content hash (`content_hash` = SHA-1 hex, `utils/hash.ts`): duplicates in a library come
  from imports or older uploads; the scan groups by `media.content_hash`.

## Replacing a file in place

- `PUT /_emdash/api/media/:id/replace` (multipart `file`, `width`, `height`; permission `media:edit_own`/`edit_any`):
  uploads to the **same storage key**, then `MediaRepository.replaceReadyFile` updates `size`, `width`, `height`,
  `content_hash` and **clears `blurhash`, `dominant_color`, `focal_x`, `focal_y`**. The id, storage key, filename, alt and
  every reference stay. Accepts only `image/jpeg`, `image/png`, `image/webp`, and the replacement must be the **same
  type** as the original → Optimize keeps the type; PNG→JPEG/WebP is reported, not done (a new upload + swapping the
  pages would be needed; not automated — risky, and visitors already get WebP/AVIF from `/_image`).
- The plugin calls it as the person who confirmed: their cookie (or bearer token) + `X-EmDash-Request: 1`, through the
  Worker's `SELF` binding (same mechanism as the Backups restore, `astro/middleware/auth.ts`; tokens skip the CSRF
  header). Then it puts the focal point back (`PUT /media/:id` with `focalX/focalY`).
- Caches: the replace route purges nothing (also performance-findings.md). `/_image` variants are route-cached under
  the tag `emdash:media` (kit route rule), so the plugin calls `cache.purge({ tags: ["emdash:media"] })` from
  `cloudflare:workers` once per action. Media file URLs are `max-age=0, must-revalidate`.
- Hourly processing of the upload queue without a person needs an EmDash API token with media write access as the
  Worker secret `MEDIA_API_TOKEN` (bearer through `SELF`); without it the queue waits for an editor's click. No direct
  D1/R2 writes to EmDash's media rows (they would bypass EmDash's checks).

## Old-file backups

- Kept in the site's `MEDIA` R2 bucket under **`backups/media-originals/<id>/<time>-<name>`** (custom metadata:
  media id, original width/height, `until` = +30 days), not a top-level `media-originals/`: EmDash's public file route
  (`/_emdash/api/media/file/[...key]`) serves any key except the private prefixes `backups/` and `transfers/`
  (`transfer/staging/keys.ts`), so a top-level prefix would be downloadable. The Backups plugin only deletes keys that
  match its own pattern and leaves `backups/` out of its media manifest. Deleted after 30 days by the hourly task.
- "Delete for good" (trash older than 30 days) keeps one more copy there (`deleted-…`, 30 days) before
  `DELETE /_emdash/api/media/:id` (EmDash deletes the row and the stored object).

## Images binding (Optimize)

- `@astrojs/cloudflare` adds `"images": { "binding": "IMAGES" }` to the built `wrangler.json` (checked in
  `dist/server/wrangler.json`). workers-types: `IMAGES.input(stream).transform({ width, height, fit, … })
  .output({ format: "image/jpeg"|"image/png"|"image/webp"|"image/avif"|…, quality })` → `ImageTransformationResult`
  with `.image()` (stream), `.contentType()`, `.response()`; `IMAGES.info(stream)` → `{ format, fileSize, width, height }`.
- Each transform is a Cloudflare Images unique transformation: 5,000/month free per account, shared with `/_image`;
  error 9422 when the free quota is used up (performance-findings.md). The plugin counts its own transforms per month.

## Media usage

- EmDash has a media usage index (migrations 046, 050, 052, 061–066, 094: `_emdash_media_usage_sources`,
  `_emdash_media_usage`, status/work/cleanup tables). It is **content-only** (`source_type = 'content'`), generation-
  based with overlays and reconciliation, has **no plugin API**, and its route `GET /_emdash/api/media/:id/usage` needs
  a signed-in user with `media:read` + `content:read_drafts` and the `admin` scope.
- So the plugin scans D1 read-only through the `DB` binding: every table except the library, the usage index, auth,
  people, logs, queues and transfer tables; `ec_*` (drafts and trashed entries count as uses), `options` (`site:*` →
  settings, other plugins' rows; its own `plugin:media-assistant:*` rows excluded), menus, widgets, sections, SEO,
  bylines, taxonomies, plugin storage, unknown tables (counted as uses), `revisions` (shown as "only older versions").
  Any media id or storage key mentioned is a use. At most 40,000 rows a scan; above that nothing is called unused.
  Content is in `ec_<collection>` columns as JSON text (backup-findings.md); image fields hold `{ id, provider, … }`.
- Folders (migration 072): `media_folders(id, name, name_key)`, `media.folder_id`. REST: `GET/POST
  /_emdash/api/media/folders` (`{ name }`, POST needs `media:edit_any`), move with `PUT /_emdash/api/media/:id
  { folderId }` (`"unfiled"` = none). EmDash has no media trash of its own: the plugin uses a folder "Trash (Media
  Assistant)" and a 30-day ledger; deletion only by an editor's confirmation after 30 days (never automatic).
- Roles (`@emdash-cms/auth`): editor 40 has `media:edit_any`, `media:delete_any`, `content:edit_any`; admin 50 has
  `plugins:manage`. The page route uses `content:edit_any` (editors and admins); Settings and the AI licence are admins.

## Focal point (migration 073)

- `media.focal_x`, `focal_y` (0–1). Block Kit 1.5 has an `image` block (display only) but **no click-on-image picker**,
  so the plugin offers a nine-position radio (top left … bottom right) on the file's Details view, written with
  `updateMetadata({ focalX, focalY })`. The admin's own media library already edits the exact point. Whether the
  starter's pictures use the focal point when cropping was not checked here.

## Workers AI (alt text)

- Wrangler 4.163 schema: `"ai": { "binding": "AI" }`, **not inherited by named environments** — the scaffold writes it
  at the top level and in `env.staging` when `media.aiAlt` is on (default on, off with `sensitiveData`).
- Catalogue 2026-11-20: `@cf/llava-hf/llava-1.5-7b-hf` (image-to-text) is **deprecated as of 2026-11-20**;
  `@cf/unum/uform-gen2-qwen-500m` is no longer listed. Used: **`@cf/meta/llama-3.2-11b-vision-instruct`** (listed,
  not deprecated; workers-types input `{ prompt, image: number[] | string, max_tokens }`, output `{ response }`).
  It requires accepting the Meta licence once per account by sending `{ prompt: "agree" }` — the plugin never does
  that on its own: an admin presses "Accept the licence" (with a confirm dialog) after a licence error. The model can
  be changed (`aiModel` option). The image sent is a 512 px JPEG copy made with the Images binding.

## Build check

A throwaway copy of a generated site (EmDash 1.5.0, Astro 7.4.12) with `packages/media` linked, `mediaPlugin()` in
astro.config and `"ai": { "binding": "AI" }`: `astro build` passed (the built `wrangler.json` carries `ai` and
`images`), `astro check` 0 errors, `tsc` of packages/media and packages/health against the real `emdash` types passed.

## Not verified

- On a deployed Worker or local dev: the Media page in a real browser, the replace/folder/delete calls through `SELF`
  with a browser session (Backups verified the same path locally only with a bearer token), the Images binding
  output and `info()` sizes, the `emdash:media` purge, Workers AI responses and the licence flow, the afterUpload hook.
- How the admin's media library shows the "Trash (Media Assistant)" folder (expected: as an ordinary folder).
