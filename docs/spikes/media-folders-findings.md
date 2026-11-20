# Media folders — findings (2026-11-21)

Parity row `media-folders`. Verified against EmDash **1.5.0**'s installed source (`node_modules/emdash/dist` of a
generated project; library code only). Not yet run on a real WordPress site or against a live EmDash.

## EmDash 1.5.0 (verified in source)

| Fact | Where |
|---|---|
| Folders are **flat**: table `media_folders` (`id`, `name`, `name_key`), no parent | `dist/media-folders-*.mjs` (`MediaFolderRepository`) |
| `GET /_emdash/api/media/folders` (cursor paged, `limit` 1–100, `q`), `POST` `{ name }` → 201 `{ item: { id, name } }`; permissions `media:read` / `media:edit_any` | `dist/astro/routes/api/media/folders/index.mjs` |
| `GET/PUT/DELETE /_emdash/api/media/folders/{id}` (the kit never calls PUT or DELETE on folders) | `dist/astro/routes/api/media/folders/_id_.mjs` |
| `mediaFolderBody = { name }`; name trimmed, 1–200 characters; unique by `trim().normalize("NFKC").toLowerCase()` → **409 CONFLICT** "A media folder with this name already exists" | `dist/media-*.mjs`, `dist/media-folders-*.mjs` |
| Media item has `folderId: string \| null` (null = Main library) | `mediaItemSchema` |
| `POST /media` (multipart, the kit's upload) reads a `folderId` form field (`"unfiled"` → null) | `dist/astro/routes/api/media.mjs` |
| `mediaUploadUrlBody` and `mediaDirectUploadBody` accept `folderId` too | `dist/media-*.mjs` |
| A deduplicated upload (same content hash) returns the existing item **without** changing its folder | `dist/astro/routes/api/media.mjs` |
| `PUT /media/{id}` (`mediaUpdateBody`) accepts `folderId` (`"unfiled"`/null = Main library); the update only touches fields that were sent | `dist/astro/routes/api/media/_id_.mjs`, repository `update` (`if (input.folderId !== void 0)`) |
| `GET /media?folderId=unfiled` filters the Main library | `mediaListQuery` |

## WordPress sources

| Plugin | Storage | How the kit reads it |
|---|---|---|
| Enhanced Media Library | taxonomy `media_category` on attachments | REST `/wp/v2/taxonomies?type=attachment`, terms, `/wp/v2/media?_fields=id,<rest_base>` |
| Folders (Premio) | taxonomy `media_folder` | REST, same (when registered with `show_in_rest`) |
| HappyFiles | taxonomy `happyfiles_category` | REST, same |
| Any other attachment taxonomy in REST | — | REST, labelled by its name |
| FileBird | tables `<prefix>fbv` (id, name, parent, …), `<prefix>fbv_attachment_folder` (folder_id, attachment_id) | database dump (`import-dump` / `import-options`) |
| Real Media Library | tables `<prefix>realmedialibrary` (id, parent −1 = top, name, …), `<prefix>realmedialibrary_posts` (attachment, fid, isShortcut) | database dump; shortcuts sort after the real folder |
| Media Library Folders (Max Foundry), CatFolders, others | real directories / own tables | detected by the audit → reported "not read", never guessed |

Table and column layouts for FileBird and RML come from the plugins' public schemas, not from a real dump: the reader
uses the dump's own `CREATE TABLE` / `INSERT (columns)` so column order does not matter. Owners (`created_by`,
`owner`) are never kept.

## Kit behaviour

- extract → `raw/media-folders.json` (REST); import-options → `raw/media-folders-dump.json` (dump; only the four tables are parsed).
- transform → `ir/media-folders.json`: names "Parent / Child" (whitespace collapsed, ≤ 200 characters, deduped with
  EmDash's key; a parent's part spelled as first seen), attachment id → one folder (dump plugins first, then REST
  taxonomies; an item in several folders takes the first, counted). Coverage report "Media folders" (counts only).
- load → folders created by name when missing, existing ones (an editor's) reused; new uploads carry `folderId`;
  items already on the target are filed with `PUT /media/{id}` only while `folderId` is null. Never renames, deletes
  or moves an editor's choice. Check `media-folders`. Rerun: no writes.

## Not verified

- No real site with any of these plugins; no run against a local or deployed EmDash (fake API in `test/media-folders.test.ts`).
- Whether Folders (Premio) and HappyFiles register their taxonomy with `show_in_rest` on every version (if not, nothing is read and nothing is guessed).
