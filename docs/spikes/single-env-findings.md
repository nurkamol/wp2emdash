# Single environment by default — Wrangler and Cloudflare facts (2026-11-20)

Owner decision 2026-11-20: one Cloudflare environment per site (production, on workers.dev until go-live), staging
opt-in (docs/PLAN.md §7a). Checked against the **installed Wrangler 4.163.0** (`STACK.wrangler`, the version in the
generated projects): `--help` output and the bundled `wrangler-dist/cli.js`. Nothing here was run against Cloudflare.

## D1 Time Travel (backup before a reload of live production)

- `wrangler d1 time-travel info <database> [--timestamp=<unix|RFC3339>] [--json]` — "Retrieve information about a
  database at a specific point-in-time using Time Travel". Acts on the remote database.
- `wrangler d1 time-travel restore <database> [--bookmark=<b> | --timestamp=<t>] [--json]` — restores in place
  (`--timestamp` within the last 30 days).
- Both call the REST API (`src/d1/timeTravel/utils.ts` in the bundle):
  `GET /accounts/:account/d1/database/:database_id/time_travel/bookmark[?timestamp=<ISO>]` → `result.bookmark`, and
  `POST …/time_travel/restore?bookmark=…|timestamp=…`. Wrangler refuses alpha-version databases.
- The kit calls the bookmark endpoint itself (`src/targets/d1-backup.ts`) with the build token (token A has D1 Edit,
  which covers it — no new scope), appends `{ at, database, databaseId, bookmark }` to
  `sites/<slug>/load/d1-bookmarks.jsonl` and prints `npx wrangler d1 time-travel restore <db> --bookmark=<b>` (run in
  the project, where wrangler.jsonc names the database; by name it is looked up through the API).
- Retention (Cloudflare docs, not re-checked here): 30 days on Workers Paid, 7 on Free. Always on, no setup.
- Not covered: R2 (media) and KV (form outbox). `load` only adds media (deduplicated by sha1) and never deletes a file,
  so a content restore does not need an R2 restore.
- **Unverified:** the exact response of the bookmark endpoint was taken from Wrangler's source (`result.bookmark`),
  not from a live call; a restore has not been exercised.

## Workers preview URLs (code review after go-live)

- `wrangler versions upload [--tag] [--message] [--preview-alias <name>] [--dry-run] …` — "Uploads your Worker code and
  config as a new Version" without routing traffic to it. After the upload it prints `Worker Version ID: <id>` and, when
  the Worker's subdomain has `previews_enabled` and a `preview_url_suffix`,
  `Version Preview URL: https://<first 8 chars of the id><suffix>` (and `Version Preview Alias URL` with
  `--preview-alias`). Wrangler's machine-readable output file (`WRANGLER_OUTPUT_FILE_PATH` /
  `WRANGLER_OUTPUT_FILE_DIRECTORY`) gets a `version-upload` record with `version_id` and `preview_url`.
- `wrangler versions deploy [<version-id>@<percentage>..] [--yes] [--message]` — sends traffic to version(s); without
  arguments it is interactive. The client scripts run `emdash migrate` first, then this.
- Both commands use the config redirect (`useConfigRedirectIfAvailable: true` in their command definitions), like
  `wrangler deploy`, so the Astro Cloudflare adapter's generated config is used after `astro build`.
- Config: `preview_urls` (boolean, top level and per environment, "Whether we use
  `<version>-<name>.<subdomain>.workers.dev` to serve Preview URLs"). `workers_dev` defaults to `routes.length === 0`
  in the Wrangler config — the kit creates Worker routes through the API (golive), not in wrangler.jsonc, so
  workers.dev stays on; `preview_urls` has no client-side default (`undefined`: the API keeps or picks its own), so
  scaffold writes `"workers_dev": true, "preview_urls": true` explicitly for single-environment sites. On deploy
  Wrangler POSTs `{ enabled, previews_enabled }` to the script's `/subdomain` endpoint.
- Preview versions run with the **same bindings** as production (D1, R2, KV, secrets): edits made through a preview's
  admin are real, and a preview may not run code that needs a database migration (migrations change the live database
  for every version). Hence: preview = code and layout review; anything needing a migration goes through
  `deploy:production` after a local check (or opt-in staging).
- Cron triggers, routes and other non-versioned settings apply on `versions deploy` / `triggers deploy`, not on upload.
- **Unverified:** a real upload of an EmDash Worker and that its preview URL serves the admin; Turnstile on preview
  hosts (the client docs suggest adding the account's `<subdomain>.workers.dev` to the widget's hostnames — whether a
  widget hostname covers its subdomains was not checked).

## Form test messages instead of a pre-launch flag

The brief suggested a `PRELAUNCH=1` var written while `production.live` is false. The kit decides per request instead:
`FORM_LIVE_HOST` (production host) + `FORM_TEST_TO` (test inbox). Any request whose host is not the production host is
a test. Reasons: (1) no window after go-live where real leads still go to the test inbox until someone rescaffolds and
redeploys; (2) preview URLs after launch are covered too; (3) messages are stored with `test: true`, so the outbox
never delivers a pre-launch message to the client after launch. Tested in `test/single-env.test.ts`.
