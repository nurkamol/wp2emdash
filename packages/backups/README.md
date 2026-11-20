# @wp2emdash/backups (experimental) — Backups & Restore

A PixelKraft plugin for EmDash sites on Cloudflare Workers, on by default in every site the wp2emdash kit
builds (`backups: false` in `kit.config.ts` turns it off). Admins only.

## What it does

- **Nightly backup** (EmDash plugin cron, task `nightly` hourly at a minute fixed per site; due once a day from the
  site's hour, 01–03 UTC by default; retried hourly, at most 4 attempts a day): a read-only export of the site's D1
  database through the Worker's `DB` binding, gzip JSON in the site's own R2 bucket (`MEDIA`) at
  `backups/<yyyy-mm-dd>/<hhmmss>-<trigger>-<rand>.json.gz`. EmDash's public media route never serves `backups/`.
- **What goes in** (an allowlist, `src/format.ts`): every content table (`ec_*`, drafts and trash), revisions,
  collections and fields, section types, menus, sections, widgets, taxonomies, bylines, SEO, redirects, relations,
  media records and folders, the schema version, and the site settings (`site:*` and the site title / tagline /
  locale, the same rule as EmDash's own backup). A media manifest lists every file in the bucket (key, size, ETag);
  the files are not copied (they already live in R2 and no restore touches them). Every table left out is listed in
  the file's `skipped` with the reason. One plugin's data is allowed by name (`PLUGIN_DATA_PREFIXES`): the Change
  requests plugin's requests (`plugin:change-requests:req:*` options rows — site content without secrets; their files
  stay in R2 under `backups/change-requests/`).
- **Never in a backup:** users, passkeys, sign-in tokens, sessions (KV), API / OAuth tokens and clients, plugin data
  and plugin settings (encrypted secrets), form messages (Workers KV and plugin storage), comments, audit and 404 logs.
  Proven by `test/backups.test.ts` with sentinel values in every one of those tables.
- **Retention:** every backup of the last 30 days + the first full backup of each of the last 12 months
  (`retention: { daily, monthly }`). The newest full backup is never removed.
- **Plugins → Backups**: status, list (when, kind, size, what's in it, off-site), **Back up now** (single flight, KV
  compare-and-set lock; at most every 2 minutes), **Download** (one-time link, two minutes), **Restore…**.
- **Restore** (browser): the site settings, the menus, or one entry — preview of every change → confirm → a fresh
  backup ("Before a restore"; if it fails, nothing is written) → the current state is compared with the preview's
  fingerprint (changed meanwhile → new preview, nothing written) → writes through **EmDash's own REST API** as the
  admin who confirmed (their session cookie or bearer token, sent through the Worker's `SELF` binding), so EmDash
  validates, keeps revisions and purges its caches. Never restored: the site address and the staging switch.
- **Full-site restore** is a developer step (Full site tab): D1 Time Travel by timestamp, one transaction.
- **Pre-change safety:** `content:beforeDelete` (an entry moved to the trash) keeps a snapshot of that entry first;
  the kit's `load --force` and `golive` write markers in `backups/markers/` (listed with their restore commands).
- **Alerts:** two failed nightly attempts in a row → one email (and one when it works again), through the forms
  package's email path; only once the site is live, never from staging; recipients editable on the page.
- **Off-site copy (opt-in):** each backup is also PUT (AWS SigV4) to an S3-compatible bucket; never deleted from there.
- **Public routes:** `download` (one-time token) and `heartbeat` (time of the last good backup and whether the last
  attempt worked — read by Site health's Backups check and the kit's verify).

## Register

```js
import { backupsPlugin } from "@wp2emdash/backups";
emdash({ plugins: [backupsPlugin({ productionUrl: "https://example.com", siteName: "Example", live: true, alertsTo: ["team@agency.example"], database: "example-db" })] });
```

Needs the `DB` (D1) and `MEDIA` (R2) bindings EmDash already uses, the Worker's cron trigger (EmDash's scheduled
handler runs plugin cron), and for restores a service binding of the Worker to itself (`SELF`).

## Optional Worker secrets

| Secret | For |
|---|---|
| `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` | The off-site copy (`offsite: { endpoint, bucket, region, prefix }`). Write access is enough. |

Facts, decisions and what was verified: the kit's `docs/spikes/backup-findings.md`.
