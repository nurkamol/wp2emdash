# Backups & Restore — verified facts, design decisions and limits (2026-11-20)

Checked against the installed **EmDash 1.5.0, @emdash-cms/admin 1.5.0, @emdash-cms/auth 1.5.0, Astro 7.4.12,
Wrangler 4.163.0, @cloudflare/workers-types 5.20261116.1** (read in a generated project's `node_modules`, never
modified) and run in a **throwaway copy** of a generated project (scratch directory, client seed and secrets left out,
synthetic plugin options, local D1/R2 only, deleted afterwards). Nothing was deployed, no live site was touched, no
email was sent.

## What EmDash 1.5 already has — and why the kit adds a plugin

- **Settings → Backups (core).** `api/handlers/backup.ts`: `generateBackupJson` (a `generateSnapshot` with drafts and
  trash, options limited to `site:*` + `emdash:site_title|site_tagline|locale`), stored as
  `backups/emdash-backup-<iso>-<rand8>.json` in the storage backend (R2 `MEDIA`); daily when enabled (off by default,
  option `emdash:backups`), run from the runtime's maintenance tick (`maybeRunScheduledBackup`, 23 h interval, no lock);
  retention 1–30 (default 7); routes `GET/PUT /_emdash/api/settings/backups`, `POST …/archives`, `GET|DELETE
  …/archives/:name`, `GET …/export` (permission `backups:manage`). Admin UI strings: "Automatic Backups", "Download
  Backup", "Stored Backups". **There is no restore** (no reader of the `emdash-backup` format anywhere in the source),
  no alerts, no monthly copies, and the snapshot's table list (`SYSTEM_TABLES`) leaves out redirects, bylines,
  relations and content references. `generateBackupJson` is not exported to plugins (not in the package exports).
- **Site transfer** (migration `084_site_transfer`, `src/transfer/*`, `emdash site export|import`, route
  `/_emdash/api/admin/transfer/[...path]`): a resumable `.emdash` package driven by the CLI with an admin token.
  **Import refuses a non-empty target** (`advance.ts`: `TRANSFER_TARGET_NOT_EMPTY`), so it moves a site to a new
  database; it does not restore in place.
- **Media route privacy:** `transfer/staging/keys.ts` `PRIVATE_STORAGE_PREFIXES = ["backups/", "transfers/"]` — the
  public media route refuses any key under `backups/`. The plugin stores everything there.
- **Decision:** a plugin that dumps the database read-only through the Worker's D1 binding with an explicit table
  allowlist (EmDash's options rule, wider table set), keeps 30 daily + 12 monthly, restores settings / menus / one
  entry through EmDash's own API, and alerts. EmDash's own Settings → Backups stays available (its daily toggle can
  stay off; the two never collide: different key prefixes).

## Plugin APIs used (installed source)

- Plugin cron, KV (`getVersioned`/`compareAndSet`), `ctx.email`, Block Kit, private/public routes: as in
  health-findings.md. `cron.schedule(name, { schedule })` with `"<m> * * * *"`.
- **No plugin API for menus or settings** (`PluginContext`: content, schema, taxonomies, bylines, redirects, media,
  users, comments, cron, email). Menus use an object cache with epochs and settings an object cache + route-cache tags
  + transfer-fence epochs, so **direct D1 writes would leave stale caches** — rejected. Restores call EmDash's REST
  API instead (below).
- **Content hooks:** `content:beforeDelete` needs `content:read`; EmDash 1.5 runs it **only when an entry is moved to
  the trash** (`trashEntry`; the event's `permanent` is hard-coded `false`); permanent deletes run only
  `afterDelete` (too late). Returning `false` blocks the delete — the plugin always returns `true` and swallows errors.
  No bulk-delete or bulk-publish event exists; publish hooks need `hooks.content-policy:register` and are not used.
- **Plugin route request:** `ctx.request` is the original request (body-read methods guarded), so its `cookie` /
  `authorization` headers are readable. Private API routes need the session or a token, plus `X-EmDash-Request: 1`
  for sessions (`astro/middleware/auth.ts`).
- **Content rows:** fields are columns of `ec_<collection>`; `SYSTEM_COLUMNS` (`database/repositories/content.ts`)
  are not data; values that look like JSON are parsed (`deserializeValue`) — the backup reader does the same.
- **REST shapes used:** `POST /settings` (`settingsUpdateBody`: title, tagline, logo, favicon, url, staging,
  postsPerPage, dateFormat, timezone, social, seo; `seo`/`social` merged field by field), `POST /menus`,
  `PUT /menus/:name` (label), `POST /menus/:name/items` (`createMenuItemBody`), `DELETE /menus/:name/items/:id`,
  `GET|PUT /content/:c/:id` (`_rev`), `POST /content/:c/:id/restore|publish`, `POST /content/:c`. Envelope
  `{ success, data }`.
- **Admin icon:** `history` is in the admin's `PLUGIN_NAV_ICON_MAP` (ClockCounterClockwise).

## Cloudflare facts

- **D1 from the Worker:** `SELECT … FROM sqlite_master`, `PRAGMA table_info`, rowid-paged `SELECT` work through the
  binding (run locally). `env.DB.withSession("first-primary")` + `getBookmark()` returns a **session** bookmark
  (local run: `00000000-00000008-…`); it is stored as `timeTravel.sessionBookmark`, labelled informational. **A Worker
  cannot take a Time Travel bookmark** (that is the REST API `GET …/time_travel/bookmark`, needing an account token).
  Restore commands therefore use **`--timestamp=<backup time>`**, which Wrangler 4.163.0 documents as "Unix … or
  RFC3339 timestamp (e.g. 2023-07-13T08:46:42.228Z)". The CLI (`load --force`, `golive`) keeps taking real bookmarks.
- **R2 object API for kit markers:** Wrangler's `r2 object put` calls
  `PUT /accounts/:account/r2/buckets/:bucket/objects/:key` (`putRemoteObject`, wrangler-dist/cli.js). Token A has
  Workers R2 Storage Edit.
- **gzip:** `CompressionStream("gzip")` in Workers and Node.
- **Off-site SigV4:** the signer reproduces AWS's published S3 example signature
  (`f0e8bdb8…bdb41`, GET `/test.txt` with Range) — a unit test. Not called against a real S3/R2 endpoint.

## Run in local workerd (throwaway copy)

`astro build` OK; `tsc` of `packages/backups` and `packages/health` against the real `emdash` 1.5 types: no errors.
`wrangler dev --local` on the build:
- `heartbeat` → `{ plugin: "site-backups", version: "0.1.0", lastBackupAt: null, ok: true }`; `download?token=bad` →
  410; `admin` without auth → 401. `plugin:install` scheduled `site-backups / nightly / "55 * * * *"`.
- With `next_run_at` moved into the past (local D1 only) a scheduled event ran the nightly backup:
  `backups/2026-11-20/175447-nightly-<rand>.json.gz`, 4.2 KB. Real 1.5 schema coverage: all expected tables in;
  skipped all auth/runtime tables; the only **unclassified** tables were EmDash's full-text search index
  (`_emdash_fts_*`) — now classified as "search index (rebuilt by EmDash)".
- With a local-only admin API token (inserted into the local D1; `_emdash_api_tokens.token_hash` =
  base64url(SHA-256(token)), scope `admin`), through the plugin's admin route: **Back up now** → stored; settings
  restore: preview `[title: "Changed by mistake" → "Original title"]`, confirm → pre-restore backup, then
  `POST /settings` through `SELF` → title back; **page** restore: preview of the title change, confirm → saved and
  published again; **menu** restore: deleted item came back (2 added, 1 removed); one-time download → 200
  `application/gzip`, second use 410; moving a page to the trash → pre-delete snapshot logged.
- EmDash's own route-cache purge logs `cache.purge is not a function` locally (workerd has no purge) — also on direct
  API edits; not a plugin issue.

## Decisions

- **Full-site restore is not a browser button.** D1 Time Travel restores the whole database atomically to a minute;
  replaying a backup table by table over HTTP could stop halfway, race editors, and would need users (excluded by
  design) for authorship. The page shows the guided CLI step (with the database name and each backup's timestamp) and
  the kit markers. Older than 30 days: per-item restores in the browser; a full rebuild from the file is manual and
  not tooled (unverified).
- **Restores act as the confirming admin** through EmDash's API (`SELF`, forwarded cookie / bearer). Nothing leaves
  the Worker. Every restore takes a fresh backup first and refuses if the current state's SHA-256 fingerprint changed
  since the preview. Settings never restore `url` or `staging` (deployment-specific; `staging` would noindex the site).
- **Menus are not transactional** (no bulk API): items are added first, then the old ones removed; a failure while
  adding removes what was added.
- **Off-site copies are never deleted by the Worker** (write-only keys, lifecycle rules there): a compromised site
  cannot wipe them.

## Not verified

- On a deployed Worker: plugin cron, R2 writes from cron, `SELF` restore with a **browser session cookie** (verified
  locally only with a bearer token), the admin page in a real browser (Block Kit shapes follow 1.5 / health).
- Menu items that reference translated entries (`reference_id` is a translation group; restored as-is).
- Whether a D1 session bookmark is accepted by `wrangler d1 time-travel restore --bookmark` (not relied on).
- Off-site PUT against real R2/S3; alert email delivery (mocked).
- Restoring an entry whose collection schema changed (fields that no longer exist are dropped and listed; new
  required fields could make the save fail — the error is shown and the pre-restore backup kept).
