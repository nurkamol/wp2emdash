# Staging sync (production → staging) — verified facts, decisions and limits (2026-11-22)

`wp2emdash sync-staging <slug>` (`src/commands/sync-staging.ts`, pure parts in `src/sync/staging.ts`) and
`wp2emdash upgrade <slug> --deploy-staging --sync-staging`.

Checked against the installed **Wrangler 4.163.0** and **EmDash 1.5.0** (read in a generated project's
`node_modules`, never modified; `wrangler d1 export --help` / `d1 execute --help` run offline in a scratch directory).
Nothing was run against a Cloudflare account, no site was touched, nothing was deployed. The command was exercised only
in tests: two in-memory SQLite databases (`node:sqlite`, foreign keys on like D1) behind a fake Cloudflare API, and a
fake Wrangler runner that applies the import file in one transaction.

## How production is read — options weighed

- **`wrangler d1 export --remote`: rejected.** Wrangler 4.163.0 calls `POST /accounts/:a/d1/database/:id/export`
  (`output_format: "polling"`, `pollExport`); the bundled Cloudflare SDK documents that endpoint as "this process may
  take some time for larger DBs, during which your D1 will be unavailable to serve queries". A sync must never make the
  live site unavailable. (`d1 execute --file` / import is documented the same way: "Imports block the D1 for their
  duration" — fine for staging, never used on production.)
- **The backups plugin's file: rejected.** It is made inside the production Worker and downloaded through a one-time,
  admin-session link; the CLI holds no admin session. It also leaves out what the sync must leave out anyway.
- **EmDash's REST API: rejected for reading everything.** No endpoint returns raw rows of every table (revisions, bylines,
  relations, redirect rows with their ids), and it needs an admin token on production.
- **Chosen: D1's REST query endpoint**, `POST /accounts/:a/d1/database/:id/query` with `{ sql }` — the call
  `wrangler d1 execute --remote --command` makes (`executeRemotely` → `d1ApiPost(…, "query", { sql })`). A query does not
  block the database. Every statement goes through `assertReadOnly` before it is sent: one statement, `SELECT` or
  `PRAGMA table_info` / `foreign_key_list`, no write keyword outside quotes. Rows are read in rowid pages of 500 (as the
  backups reader does); integers in the SQL are inlined (the endpoint's `params` are typed as strings). Token: D1 Read
  is enough on production (D1 Edit on staging for the import and the bookmark).
- **R2 on production: GET only** — `GET /accounts/:a/r2/buckets/:b/objects/:key`, what `wrangler r2 object get` calls
  (`getR2Object`, `fetchR2Objects`). Writes to staging use `PUT` on the same path (`putRemoteObject`; the kit's backup
  markers already use it, backup-findings.md), with the content type passed on. Wrangler 4.163.0 has no object list
  command; the "already there" check is a `HEAD` on staging's object (see Not verified).

## How staging is written

- One file, imported with **`wrangler d1 execute <staging-db> --remote --file sync.sql --yes --config <tmp>`**. Wrangler
  4.163.0 uploads it and polls the import; its own note: "if the execution fails to complete, your DB will return to its
  original state and you can safely retry" — the sync is all or nothing. The database is addressed through a temporary
  one-binding config (`d1_databases: [{ binding, database_name, database_id: <staging id> }]`):
  `getDatabaseByNameOrBinding` takes the id from the config when the name matches (`getDatabaseInfoFromConfig` +
  `hasUuid`), so there is no name lookup in the account. The default runner refuses anything but `d1 execute … --remote
  --file`; `assertStagingDatabase` refuses production's database id (and its restore-test database) right before the
  call; the credentials passed are staging's (`CLOUDFLARE_API_TOKEN_STAGING` / `…ACCOUNT_ID_STAGING`, else the shared
  pair). The SQL file lives in a fresh temp directory, deleted after the import (it holds client content).
- The file: `PRAGMA defer_foreign_keys = true;` (a PRAGMA D1 documents as supported), `CREATE TABLE` + indexes for a
  collection only production has, `ALTER TABLE … ADD COLUMN` for a field only production has, then `DELETE` dependents
  first and `INSERT` referenced tables first (order from staging's `PRAGMA foreign_key_list`), one `INSERT` per row
  with literal values. No `BEGIN`/`COMMIT` (D1 refuses explicit transactions; the import is atomic on its own).
- **Before the import: a D1 Time Travel bookmark of staging** (`GET …/time_travel/bookmark`, the call
  `wrangler d1 time-travel info` makes; single-env-findings.md), recorded in `sites/<slug>/sync/d1-bookmarks.jsonl`
  with `npx wrangler d1 time-travel restore <staging-db> --bookmark=…`. No bookmark → nothing is written.
- **Media before rows** (additive): staging's pages never point at a file staging does not have yet.

## What is copied — the allowlist (EmDash 1.5, migrations 001_initial … 097_room_storage)

Read from `dist/runner-*.mjs` (every `createTable` / `alterTable` and `references(...)`):

- **Copied in full:** `ec_*` (content, drafts and trash), `revisions`, `media`, `media_folders`, `taxonomies`,
  `content_taxonomies`, `_emdash_taxonomy_defs`, `_emdash_taxonomy_def_groups`, `_emdash_menus`, `_emdash_menu_items`,
  `_emdash_widget_areas`, `_emdash_widgets`, `_emdash_sections`, `_emdash_seo`, `_emdash_redirects`, `_emdash_bylines`,
  `_emdash_content_bylines`, `_emdash_byline_fields`, `_emdash_byline_field_values`, `_emdash_byline_field_group_values`,
  `_emdash_relations`, `_emdash_content_references`, `_emdash_collections`, `_emdash_fields`, `_emdash_block_types`,
  `_emdash_block_type_versions`. The same set as a backup (`packages/backups/src/format.ts`) minus the schema version;
  a test keeps the two in step.
- **`options`, filtered rows only** (the same predicate in SQL for reading production and replacing staging, and in
  code): `site:*` except `site:url` and `site:staging` (they belong to the deployment; `staging` noindexes the site),
  `emdash:site_title|site_tagline|locale`, and these kit plugin KV rows (EmDash 1.5 keeps plugin KV as
  `plugin:<id>:<key>` rows, migration `092_plugin_kv_options`): `plugin:site-seo:business`, `plugin:site-seo:social:*`,
  `plugin:site-seo:term:*`, `plugin:site-seo:kw:*`, `plugin:privacy-consent:settings`, `plugin:motion:settings`,
  `plugin:site-og:settings`. A value holding an encrypted envelope (`"$emdash"`) never goes, whatever its key.
- **Never copied** (listed in the plan with the reason): `users`, `credentials`, `auth_tokens`, `auth_challenges`,
  `oauth_accounts`, `allowed_domains`, `_emdash_api_tokens`, `_emdash_oauth_tokens`, `_emdash_oauth_clients`,
  `_emdash_device_codes`, `_emdash_authorization_codes`, `_plugin_storage` / `_plugin_state` / `_plugin_indexes` (form
  messages and every plugin's records), `_emdash_comments`, `_emdash_comment_reactions`, `audit_logs`,
  `_emdash_404_log`, rate limits, entry locks, live-editing rooms, cron tasks, migration lock, revision prune queue,
  redirect lock / state / artifacts, media usage index, upload attempts, site-transfer staging, the search index,
  `_emdash_migrations`, and any table not classified yet. Plugin rows left out: form recipients, CRM and chat settings
  (`cfg:*`: addresses, ids, keys), CRM retry jobs, change requests (names and emails), `plugin:site-og:secret`,
  analytics (staging must not count into production's), caches, logs, locks, health state, coming-soon mode, backups'
  index. Sign-in sessions live in R2/KV, never in D1, and are not touched. Staging's users stay, so the agency still
  signs in.
- **Foreign keys to tables staging keeps:** `_emdash_bylines.user_id → users` (ON DELETE SET NULL) is written as NULL.
  A NOT NULL foreign key to a kept table would block the plan (none in 1.5: `_emdash_entry_locks` and comments are
  excluded). `author_id` on content, media and revisions is a plain column (no foreign key): production's user ids are
  copied as they are.

## Safety checks

- Refused (exit 2) before any read: a site without staging; production or staging D1 / R2 not recorded in
  `cloudflare.json`; staging's D1 id equal to production's or to production's restore-test database; the same D1 name
  in the same account; any R2 bucket (media or sessions) shared in the same account.
- Plan blockers (exit 2, nothing written): staging's schema behind production's (a migration production has and staging
  has not — deploy staging at production's version first), a system table missing on staging, a required column only
  one side has.
- Dry run by default; `--yes` applies. Logs and the result: table names and counts only, never row contents; the
  Wrangler output of a failed import goes to `sites/<slug>/sync/<time>-wrangler.log` with secrets scrubbed.

## Caches after the import

- **Route cache:** the only purge is `cache.purge` inside the Worker. Reachable from the CLI: a settings save through
  EmDash's REST API — `astro/routes/api/settings.ts` calls `invalidateRouteCache(cache, [siteSettingsTag()])` and every
  page carries that tag (settings-findings.md). The sync reads staging's settings and saves the title back unchanged
  with `EMDASH_TOKEN` (needs `settings:manage`, which the load token has). Without the token: noted; cached pages
  expire on their own, and a staging deploy starts with an empty cache (`cross_version_cache: false`,
  performance-findings.md).
- **Settings in isolates:** 30 s stale-while-revalidate (`SITE_SETTINGS_CACHE_TTL_MS`); `upgrade --sync-staging`
  waits 35 s before the staging snapshot.
- **Redirects:** migration `091_redirect_artifacts` installs triggers on `_emdash_redirects` (insert / delete of enabled
  rows bump `_emdash_redirect_state.revision`), so the import's DELETE/INSERT marks the published redirect artifacts
  stale and EmDash regenerates them; redirect state and artifacts are therefore not copied.
- **Search:** FTS triggers on content tables (039, 064) follow the DELETE/INSERT.

## Upgrade integration (decision)

`upgrade <slug> --deploy-staging --sync-staging` runs the sync first — before the production snapshot, the staging
before-snapshot, the rebuild and the deploy — so the staging comparison runs on production's content and a refused or
failed sync costs nothing. The sync keeps its dry-run default: without `--yes` upgrade prints the sync plan and stops
(exit 1, "rerun with --yes"); `--yes` belongs to `--sync-staging` only (upgrade itself never needed it).
`--sync-staging` without `--deploy-staging` is refused (the sync exists for the staging comparison).

## Not verified

- **Nothing was run against Cloudflare.** The REST query response shape (`result[0].results`), the import of the
  generated file (statement forms, `PRAGMA defer_foreign_keys` inside an import, the 100 KB statement limit for rows
  with large content — counted as `oversized`, an oversized statement would fail the whole import and leave staging
  unchanged), and BLOB values over the REST API (encoded as `X'…'` when they come back as byte arrays) are unverified.
- `HEAD` on the R2 object REST path (used to skip files already on staging with the same size): any answer but 200 with
  the same `content-length` copies the file again (idempotent, staging only).
- Time Travel restore of staging after a sync (the bookmark call is the verified one; the restore command is Wrangler's).
- Rows changed on production while the sync reads it: no single point in time across tables (the REST API has no
  session); counts are read back on staging, and a rerun fixes drift.
- Integers beyond 2^53 lose precision through JSON (EmDash 1.5 stores ids as text; rowids are not copied).
- EmDash's media usage index (`_emdash_media_usage_*`) on staging is left as it was; EmDash's reconciliation
  (migrations 061–066) rebuilds it — not observed.
