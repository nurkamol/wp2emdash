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

## Restore test (2026-11-22, @wp2emdash/backups 0.2.0)

A monthly, automated proof that the newest backup can actually be restored (`packages/backups/src/drill.ts`).

### Where to restore to — options weighed

- **(a) SQLite in memory inside the Worker** (sql.js / wa-sqlite, ~1 MB of Wasm): rejected. It adds a large bundle to
  every site's Worker for a monthly job, and it is a different SQLite build than D1, so a pass proves less.
- **(b) A dedicated empty scratch D1 database, binding `RESTORE_DRILL_DB`** — **chosen**. The real thing: the same
  engine, limits and binding API as the site's database. A Worker cannot create a D1 database (that needs an account
  token, which a site's Worker must never hold), so `wp2emdash provision` creates `<slug>-restore-drill-db` once, next to
  the site's database (production only; `backups.restoreDrill: false` or `backups: false` skips it), records it in
  `cloudflare.json` as `production.restoreDrill`, and the scaffold binds it **only once its id is recorded**. A D1
  binding without `database_id` would be auto-provisioned by `wrangler deploy` (Wrangler 4.163.0:
  `experimental-provision` / `experimental-auto-create`, both default true, `provisionBindings` in wrangler-dist) —
  so existing sites are unchanged until provision + scaffold run. Never bound on staging (the test never runs there).
- **(c) Dry run** — the fallback when the binding is missing (sites built before 0.2.0, or not yet provisioned): the
  same file checks and the same plan against the live schema, with no write anywhere.

### What a run does

1. Picks the newest full backup (not a pre-delete snapshot) from the plugin's list.
2. **File:** reads it from R2; SHA-256 of the stored gzip against the one recorded at store time (new in 0.2.0: R2
   custom metadata `sha256` and the list entry; older backups say "no checksum recorded" and rely on the next checks);
   decompresses; parses; the same format/version check as the restore path (`loadDoc`); its counts recomputed from its
   rows against the counts recorded in it and in the list entry.
3. **Plan** (pure, also the dry run): the live schema is READ (`sqlite_master`, `PRAGMA table_info`, the last
   `_emdash_migrations` name). Each table of the backup is created with the live columns, types, NOT NULL, defaults
   (wrapped in parentheses: `PRAGMA table_info` returns expressions such as `datetime('now')` unparenthesised) and
   primary key, plus any column only the file has; no foreign keys (users are never in a backup and D1 enforces foreign
   keys). Problems a restore would hit: an included live table missing from the backup (a note instead when the schema
   version differs — the schema moved on since), a required column missing, a repeated primary key, more than 100
   columns, rows over 2 MB, a table a backup must never hold. Inserts carry at most 100 bound values each.
4. **Scratch database (b):** refuses before any write when the binding is the live `DB` binding, or the database
   holds any table without the test's marker table `_wp2emdash_restore_drill` (`_cf_*`, `sqlite_*`, `d1_*` ignored);
   drops its previous tables, creates the plan's tables, inserts every row in batches (≤ 50 statements / ~4 MB per
   `batch()`, one transaction each), counts every table back (row counts within `tolerancePct`, default 0 = exact),
   pages/posts per collection, media records, site settings; then drops everything but the marker.
5. **Both modes:** privacy (no excluded table, every options row passes `optionAllowed`; counted, values never read
   out), allowed plugin rows counted (change requests), and `mediaSample` (12) media files from the backup's manifest
   checked with R2 `head()` (exists, same size), plus media records whose `storage_key` is not in the manifest.
6. Result in plugin KV `drill` (D1 row `plugin:site-backups:drill`): date, mode, tables, rows, media sampled/missing,
   each check with a short detail (counts and table names only), last 12 results. Logs: counts only.

### Schedule, budget, lock

- Plugin cron task `restore-drill`, every 15 minutes at minutes fixed per site (it only reads one KV row unless a test
  is due or running). Due when the last test is `everyDays` (30) old — a failed one is retried the next day — and the
  UTC hour has reached the nightly hour + 2 (so it normally tests that night's backup). Never on staging.
- Per tick at most 400 statements and 60 s (EmDash's hook timeout for this plugin is 120 s; D1 allows 1,000 queries
  per Worker invocation on Paid and the same scheduled invocation also runs other plugins' tasks — the docs do not say
  whether a `batch()` counts as one query, so every statement is counted). Progress (table/row cursor) is kept in KV;
  the next tick reloads the backup from R2 and continues. A run older than a day is abandoned and reported as failed.
- Own KV compare-and-set lock (`drill-lock`, 3 minutes), separate from the backup/restore lock: the test only reads R2.
- **Run restore test now** (admins, at most every 10 minutes): queues the test and runs the first slice in the admin
  request (20 s / 200 statements); a larger site continues on the next ticks.
- Alerts: the first failure emails the backup alert recipients (same path, same rules as the nightly alert: never
  before go-live, never from staging, switchable); a pass after a failure sends one recovery email.
- Site health: the Backups check reads the D1 row (one SELECT, like the Media summary): a failed test turns an
  otherwise good check into a warning; the last test is a detail line ("Last restore test: passed 2026-11-03, 1,234
  rows across 38 tables, 12 media sampled."), and a note after 45 days without one.

### Verified (local workerd through the installed Wrangler 4.163.0, `getPlatformProxy`, a throwaway local D1)

Against EmDash 1.5.0, Wrangler 4.163.0, @cloudflare/workers-types 5.20261116.1 (read in a generated project's
`node_modules`, not modified). In a scratch directory with a synthetic one-binding config; nothing deployed, no
Cloudflare resource created, no client data:
- `batch([CREATE TABLE …, CREATE TABLE IF NOT EXISTS …])` works; `PRAGMA table_info` returns
  `{cid,name,type,notnull,dflt_value,pk}` with `dflt_value` `"0"` / `"datetime('now')"`.
- A `Uint8Array` binds as BLOB and reads back as a number array (the backup's JSON form; `bindable()` turns it back).
- 100 bound parameters in one INSERT work; 101 fail with `too many SQL variables` (the documented limit, enforced).
- A `batch()` whose second statement violates the primary key throws and rolls back the first (`r1` count 0).
- `PRAGMA foreign_keys` is 1 (enforced) — hence no `REFERENCES` in the scratch tables.
- `DROP TABLE IF EXISTS` in a batch works; `sqlite_master` then lists only the marker table.
- EmDash 1.5 plugin KV: `createKVAccess` prefixes keys `plugin:<id>:` in the options table (`context-*.mjs`), values
  JSON-serialised (`options-*.mjs`), keys any non-empty string ≤ the max length (so `drill-lock` is fine).
- D1 limits page (developers.cloudflare.com/d1/platform/limits, read 2026-11-22): 100 bound parameters per query,
  100 KB statement, 2 MB row, 100 columns, 1,000 queries per invocation (Paid), databases per account: 1,000,000 on
  Paid (first 100,000 included) — one extra, normally empty database per site is well within that.

### Not verified

- On a deployed Worker: the task through plugin cron, a real `RESTORE_DRILL_DB` created by provision (the provision
  code path is unit-tested against a fake API only; `provision` was not run against any account), real R2 `head()`.
- Whether a `batch()` counts as one query toward the 1,000-per-invocation limit (budgeted as if not).
- Very large sites (tens of thousands of revisions): the run spans many ticks and reloads the backup from R2 each
  tick; CPU time per tick for gunzip + JSON.parse of a multi-MB file was not measured on workerd.

## Restore test: first live run (2026-11-22, a live client site, dry run)

- "Run restore test now" on a deployed Worker without `RESTORE_DRILL_DB`: passed, 247 rows across 30 tables, 12 media files sampled in R2 (`head()` works on the real binding), within the admin request. The scratch-database path (b) is still unverified until a site is provisioned with it.
