# Changes since the last extract, and admin edits since the last load — verified facts (2026-11-22)

Checked against the installed **EmDash 1.5.0** (`emdash` package `dist/`, read in the kit's spike project
`node_modules`, never modified). Nothing was deployed; no live WordPress, EmDash site, DNS or production data was touched.
Used by `wp2emdash changes` (`src/extract/changes.ts`) and load's edit protection (`src/targets/emdash/content-record.ts`).

## EmDash: how an admin edit shows on an entry

- `ContentItem` (`types-*.d.mts`) carries `version?: number` and `updatedAt: string` (plus `createdAt`, `publishedAt`,
  `liveRevisionId`, `draftRevisionId`). `ContentRepository.mapRow` fills them from the row's `version` and `updated_at`
  columns (`version` defaults to 1 when absent).
- `GET /_emdash/api/content/<collection>` (`handleContentList`) returns these mapped rows, so the list load already
  makes per collection gives every entry's `version` and `updatedAt` — no extra request per entry.
- **Every write bumps `version`**: `ContentRepository.update` sets `version = version + 1` unconditionally (and
  `updated_at` when a column changes); saving a draft revision (`draft_revision_id = …, updated_at, version + 1`),
  publish, unpublish, schedule and the live-metadata update path all do `version = version + 1`. `PUT
  /content/<collection>/<id>` always goes through `repo.update`, so an SEO-only or references-only save from the admin
  bumps it too.
- `_rev` (`api/rev.ts`) is `base64("<version>:<updatedAt>")`; `validateRev` rejects a write whose `_rev` no longer
  matches (409 `CONFLICT`). Load already sends the `_rev` it just read, so it never races an editor mid-write.
- On multilingual sites `syncNonTranslatableFields` writes the entry's translations too (their `version` moves).

## What the kit does with it

- Load records, per WordPress entry (`<type>:<wpId>`), the EmDash entry id with its `version` / `updatedAt` **as read
  back at the end of the run** (the Verify target step lists every collection after all writes — content, references,
  publish), plus the WordPress modified date and the raw export hash it loaded (`load/content.<target>.json`).
- Next load: same entry id and a different `version` (or `updatedAt`) = changed in the admin since. If the WordPress
  side changed too (raw hash from `raw/manifest.json`, else the modified date) it is a **conflict**; either way the
  entry is not written (nor its references) unless `--overwrite-edited`, and its old record is kept so it stays
  flagged. Conflicts fail the `edited-in-admin` check; admin-only edits are reported but pass.
- Entries with no record (first load, adopted by slug, a new database whose ids differ) are written as before.

## Known limits

- An entry the Worker's cron publishes on schedule after load (scheduled posts) shows as edited on the next load.
- On multilingual sites, an admin edit to one translation can flag its siblings (shared non-translatable fields).
- Entries deleted in WordPress are reported by `changes` and never deleted from EmDash; load never deletes entries.
- `raw/forms/` is not cleared between extracts, so a form deleted in WordPress keeps its file and is not reported as
  gone; menus, media and entries are compared from the fresh export.
