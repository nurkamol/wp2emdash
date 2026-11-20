# Comments: WordPress comments → EmDash

**Date:** 2026-11-21 · **EmDash:** 1.5.0 (installed source in the pilot project, read-only) · **Astro:** 7.4.12 · **EmDash Exporter:** 1.2.0 (plugin source read from a site backup) · Parity backlog item 10 (`docs/parity/wp-to-emdash.md`).

## The write path

EmDash 1.5 has no API that creates a comment with its original date, author and thread:

| Path | Why it does not fit |
|---|---|
| Public `POST /_emdash/api/comments/{collection}/{id}` (`comments/public-submission.ts`) | Stamps `created_at` = now, runs Turnstile, rate limit (5 / 10 min per IP hash), moderation and hooks; author from the body; one per request. Meant for visitors. |
| Admin `/_emdash/api/admin/comments` (list, `[id]`, `[id]/status`, `bulk`, `counts`) | Moderation only: no create. |
| `CommentRepository.create` (exported from `emdash`) | Sets `created_at` to now; no way to keep the WordPress date. |
| `importCommentsFromPlugin` (`import/comments.ts`) | Keeps dates and threads, but is **not exported** from any package entry; its only caller, `POST /_emdash/api/import/wordpress-plugin/execute` (`phase: "comments"`), fetches the comments from the **live** WordPress Exporter itself (WordPress URL + credentials in the request, SSRF guard refuses private hosts), imports approved **and** pending, and keys idempotency on post + e-mail + time + body. Not reproducible from `raw/`, cannot leave pending out. |
| Site transfer (`emdash site import`, `transfer/import/writers.ts` has a `comment` kind) | Refuses a non-empty target (`TRANSFER_TARGET_NOT_EMPTY`, `transfer/analyze/target.ts`): useless after the kit's own load. |
| D1 SQL through wrangler | Bypasses EmDash entirely (no validation, no cache invalidation, a second write path to maintain); different databases locally. |

**Decision: a small kit plugin, `@wp2emdash/comments`** (packages/comments), registered only on sites with comments to import:

- One private route, `POST /_emdash/api/plugins/wp2emdash-comments/import` (+ `status`). EmDash authenticates it like its own admin API: `plugins:manage` (admins), an API token needs the `admin` scope (`SCOPE_RULES`: `/_emdash/api/plugins` → admin; `http-route-dispatch.ts` re-checks), sessions need `X-EmDash-Request` — **also on GET** (the kit's client sends `status` as POST for that reason; seen on the dev server: `CSRF_REJECTED` on GET).
- Writes through EmDash's own database handle (`getDb()` from `emdash/runtime`, public export; the same Kysely handle EmDash's template helpers use), with EmDash's importer's rules: `created_at` = `updated_at` = WordPress date, `ip_hash`/`user_agent`/`author_user_id` null, threads one level (EmDash `assembleThreads` nests replies under roots only). Plus checks the importer leaves out: id is a ULID, collection exists, entry exists and is not trashed, parent exists (stored or earlier in the batch), same entry, top-level. Rejections carry no personal data. `invalidateCommentObjectCache()` (exported) after writes. D1's 100-bound-parameter limit: `IN` lists of 90, inserts of 6 rows.
- **It only ever writes `pending`.** Comments approved in WordPress are approved afterwards through EmDash's own `POST /_emdash/api/admin/comments/bulk` `{ action: "approve" }` (`comments:moderate`), which updates the status, invalidates the object cache and purges the route cache tags `[collection, contentId]` (`getCommentRouteCacheTags`; the route only computes tags for rows whose visibility changes — so inserting approved rows directly would leave cached pages stale). Bulk approve fires no hooks and sends no e-mail (`handleCommentBulk`).
- Idempotent: ids are deterministic ULIDs (time part = the comment's date, random part = SHA-256 of site host + WordPress id), inserts are `ON CONFLICT (id) DO NOTHING`, an existing row is reported with its status and never touched. load's id-map (`comments`: WordPress id → id, wanted status, settled) keeps settled comments out of later runs, so an editor's spam/trash/delete after a load is kept (not re-created, not re-approved); an approval interrupted by an error is finished by the next load.

## What else was checked in the installed source

- **Table** (`027_comments`, `028_drop_author_url`, `044_comment_reactions`): `_emdash_comments` id, collection, content_id, parent_id (FK, cascade), author_name/author_email (NOT NULL), author_user_id, body, status (pending/approved/spam/trash), ip_hash, user_agent, moderation_metadata (JSON), created_at, updated_at. **`author_url` was dropped in 028**: author websites are counted, not carried. Reactions: separate table, salted voter hash; not used by the kit.
- **Collection settings** (`_emdash_collections`): `comments_enabled` (default 0), `comments_moderation` (`all | first_time | none`, default `first_time`), `comments_closed_after_days` (**default 90**; 0 = never), `comments_auto_approve_users`. `PUT /schema/collections/{slug}` (`updateCollectionBody`) takes them (schema:write); `GET ?includeFields=true` reads them back. Seed collections accept `commentsEnabled` only. EmDash has no per-entry open/closed and no "registered users only".
- **Public submission**: JSON only (`parseBody` → `request.json()`), honeypot `website_url` (silent fake success), Turnstile when `EMDASH_TURNSTILE_SECRET_KEY` or `TURNSTILE_SECRET_KEY` is set (fails closed), rate limit after the CAPTCHA, `first_time` = the e-mail has an approved comment, parent forced to its root, closing by `published_at + closedAfterDays`, notification e-mail to a verified content author when auto-approved.
- **Template API**: `getComments({ collection, contentId, threaded })` (exported; approved only, ≤500, object-cached under the comments namespace, invalidated on every write) and `getCommentCount`. EmDash's own `Comments.astro`/`CommentForm.astro` (`emdash/ui/comments`) need the collection's `commentsEnabled` to show anything, and the form has no `method`, so without JavaScript a submit would put the e-mail address in the page URL — the starter has its own component instead.
- **Plugins**: `CommentAccess` (`comments:read`/`comments:moderate`) can list, count and set status, not create. Plugin routes cannot purge the route cache.
- **Backups** (`@wp2emdash/backups`) leave `_emdash_comments` out by design (personal data): D1 Time Travel covers comments; said in the client guide.
- **Exporter 1.2.0** (`class-comment-exporter.php`): `status: ['approve','hold']`, `type: 'comment'` — spam, trash, pingbacks and trackbacks never leave WordPress; body = `wp_strip_all_tags(comment_content)` (links lose their address there; the kit keeps `text (url)` when a source sends HTML); `date_gmt` ISO UTC; `parent_id`; e-mail included; no author URL, IP or user agent. Options carry no discussion settings; per-entry `comment_status` is in the content items. REST `/wp/v2/settings` exposes `default_comment_status` only; the rest (`comment_moderation`, `comment_previously_approved`, `close_comments_for_old_posts`, `close_comments_days_old`, `comment_registration`, `thread_comments(_depth)`) comes from a backup's SQL dump (`wp2emdash import-options`, allow-listed).

## What was built

| Piece | Where |
|---|---|
| Extract | `raw/exporter/comments.json` (as before); `raw/exporter/discussion.json` from REST settings when there are comments; `import-options` adds `raw/discussion.json` |
| Transform | `src/transform/comments.ts` → `ir/comments.json` (plan + items). Gate `comments` (only when WordPress has comments). Coverage section "Comments" — counts only. `overrides.ts comments: { migrate, includePending, form, moderation, closedAfterDays, reason }`. Sensitive sites (`sensitiveData`): the gate fails until `migrate` is decided; the form stays off unless `form: true`. Registered-users-only sites: form off. Comment-feed rule text says comments are migrated (still 410). |
| Mapping | WordPress `comment_moderation` → `all`; else `comment_previously_approved` → `first_time`; else `none`. `close_comments_for_old_posts` + days → `closedAfterDays`, else 0. Form (`commentsEnabled`) per collection: a published entry with `comment_status: open` (or WordPress's default when the entry has none). Entries `closed` in a collection with the form → field `comments_closed` ("Comments closed"). |
| Seed / scaffold | `commentsEnabled` + field on form collections; `site.config.json comments`; `@wp2emdash/comments` copied, linked and registered only while there are comments to import; `docs/moderating-comments.md` for the client. |
| Load | `comment-settings` (field, collection settings; kept on a live site), content writes `comments_closed`, step `comments` (src/targets/emdash/comments.ts): import → approve → read back every comment by status; per entry the imported comments with their status, editor changes since an earlier load reported, not failed. |
| Starter | `components/comments/Comments.astro` (on posts, CPT entries, pages when their collection is listed): approved comments threaded one level, `<ol>`/`<article>`/`<time>`, links `nofollow ugc`, `data-comment-count`; form with name/e-mail/comment, honeypot, Turnstile (the site's key; rendered by the existing explicit loader), privacy note + policy link, live status region; hidden until `scripts/comments.ts` runs (noscript note); posts JSON to EmDash's uncached endpoint; hidden when the entry is closed or past the closing age. Middleware refuses EmDash's public POST for a closed entry (`COMMENTS_CLOSED`, 403). |
| Verify | `comments`: every published entry with migrated comments shows that many (`data-comment-count`). `urls-accounted` unchanged: `#comment-123` fragments are never requested; `/comments/feed/` stays 410 (a comment feed is not trivial: no EmDash feed helper, and it would publish commenter names site-wide). |

## End to end (synthetic blog, local EmDash 1.5.0)

Blog fixture + `test/fixtures/comments/site.json` (threads three deep, pending, spam, trash, pingback, a reply to a pending comment, a comment on a missing entry, a script-only body, author URLs, a page comment, an entry closed in WordPress) → transform → scaffold (no install) → a scratch project with a cloned copy of the pilot's `node_modules` (dev server, structure-only setup):

- transform gate: 6 of 12 to import on 3 entries; left out 1 each of pending, spam, pingback, entry-not-migrated, trash, empty; 1 deeper reply flattened.
- load: `comment-settings` (posts: form on, first_time, 30 days; pages: form off), `comments` 6 written + 6 approved through EmDash's moderation; rerun: 0 written, 0 approved, passed. Rows read straight from the local D1: WordPress dates kept, threads, `pending`→`approved`, `moderation_metadata {"importedFrom":"wordpress","wpCommentId":…}`, `comments_closed` = 1 on the closed post.
- Pages: `/hello-gutenberg/` 3 comments (1 thread with 2 replies) + form + Turnstile test widget, no e-mail address in the HTML; `/classic-notes/` 2 comments, "Comments are closed"; `/` 1 comment, no form.
- Public endpoint: a comment on an open post → 201 `pending` (first-time commenter), honeypot → fake success and no row, a comment on the closed post → 403 `COMMENTS_CLOSED` from the starter middleware.
- `astro check` on the generated project: no errors in the new files (2 pre-existing errors in `SiteHeader.astro` from the scratch site's synthetic header config).

## Brochure sites unchanged

Transform + scaffold (no install) of copies of the two pilot brochure sites with the code before and after (projectDir removed from the copies): `ir/`, `reports/`, `seed/seed.json`, `site.config.json`, `astro.config.mjs`, `wrangler.jsonc`, `package.json` and client docs byte-identical; only kit-owned starter source differs (comments component, script and utils; `Single.astro`, `Entry.astro`, `[...slug].astro`, `middleware.ts`). The component renders nothing without `site.config.json comments` (no database query).

## Not verified yet

- **A real WordPress site with comments** (both pilot sites had none) and a real Exporter comments export.
- **Remote load with an API token** (`admin` scope for the plugin route and moderation, `schema:write` for collection settings): read in source, exercised only with the dev-bypass session.
- **Route cache purge on workerd** after the bulk approve and after a visitor's auto-approved comment (dev has no route cache).
- Real Turnstile (only the test keys); the 5-per-10-minutes limit was read, not hit.
- A collection whose comments were imported while the target already held other comments with the same deterministic id (impossible unless the same site is imported twice into one database).
- Unrelated, seen on the third local reload: the blog taxonomies step reported `CONFLICT: Term 'studio-news' already exists` (nested term) — pre-existing blog load behaviour, not touched here.
