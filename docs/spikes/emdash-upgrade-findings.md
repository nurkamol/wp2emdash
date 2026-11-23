# EmDash version upgrades on delivered sites (2026-11-24, emdash 1.5.0 → 1.6.0)

How `wp2emdash upgrade` moves a live site to a new EmDash version without a window where the site is down or the
database cannot be recovered. Code: `src/upgrade/emdash.ts`, `src/commands/upgrade.ts`.

## What was verified

- **`emdash migrate --status --json`** (1.6.0) is read-only and prints `target.fingerprint`, `knownApplied`,
  `pending`, `unknownApplied`, `executed`. Against a live 1.5.0 site's production D1 after the rebuild:
  `pending: ["098_user_last_login"]`, nothing unknown.
- **1.6.0 adds one core migration**, `098_user_last_login` (a `last_login_at` column on users). Compared from the
  installed `dist` of 1.5.0 (last: `097_room_storage`) and 1.6.0.
- **An older EmDash keeps running on a database migrated by a newer one.** 1.5.0's migration runner has a fast path:
  when the migrations table holds at least as many rows as the build knows, the build's migrations are treated as
  applied. So applying 1.6.0's change while 1.5.0 serves is safe, and a `wrangler rollback` to the 1.5.0 Worker after
  the deploy keeps working. (`emdash migrate --check` of the older build would report the newer change as unknown;
  rollback does not run it.)
- **Projects use EmDash's default `auto` mode**, plus the kit's deployment-managed `emdash migrate` before
  `wrangler deploy` (docs/spikes/M6-findings.md). In `auto` mode the first request of a new version applies pending
  changes itself, so a preview of the new version uploaded before the database step would migrate the production
  database outside any recovery point. Hence the order below.
- **`emdash media repair-usage --all --url <site> --json`** reads the token from `EMDASH_TOKEN` (1.6.0 `dist`), so the
  admin token is passed in the environment, never on the command line.
- **Release age:** both projects' `pnpm-workspace.yaml` set `minimumReleaseAge: 1440`; 1.6.0 (published
  2026-11-22T19:48Z) installed from 2026-11-23T19:48Z. The kit's pin moves only after that.
- **Maintenance window:** EmDash's upgrade guide asks for one when `095_plugin_storage_unique_scope` is pending; the
  plan stops on it (`MAINTENANCE_MIGRATIONS`).

## The order

1. `wp2emdash upgrade <slug>`: snapshot the live site, rebuild on the new version, then read the production database's
   migration status (read-only) and plan. Stops when a change needs a maintenance window, the database has changes
   the new version does not know, the fingerprint is not the one provision recorded, the version goes down, or the
   kit has no entry for the version in `EMDASH_RELEASES`. Writes `reports/upgrade/<timestamp>/emdash.json`.
2. `upgrade <slug> --prepare-db --yes`: D1 Time Travel bookmark + Backups marker (stops without a bookmark), then
   `emdash migrate --expected-target-fingerprint=…` and `--check`. The live site keeps serving the older version.
3. `pnpm run versions:upload` → `upgrade <slug> --verify <preview-url>` (required; recorded as `previewVerified`).
4. `pnpm run versions:deploy` (owner's approval): the previewed version goes live.
5. `upgrade <slug> --verify`, then `upgrade <slug> --after-release --yes` (1.6.0: media usage repair).

Undo: `npx wrangler rollback` in the project; restore the bookmark only if data went wrong
(`npx wrangler d1 time-travel restore <database> --bookmark=<bookmark>`).

## Adding a release

Read its release notes and upgrade guide, then add an entry to `EMDASH_RELEASES` (its migrations from the installed
`dist`, one-time steps, a one-line note) and any migration that needs a window to `MAINTENANCE_MIGRATIONS`. Bump
`STACK.emdash` and `STACK["@emdash-cms/cloudflare"]` together (they share a version), build a site on it, run the tests.
