# @wp2emdash/comments (experimental) — WordPress comments import route

An EmDash native plugin the wp2emdash kit registers on a site only while it has WordPress comments to import. It has
no admin page: comments are moderated in EmDash's own **Comments** screen.

## Why it exists

EmDash 1.5 cannot create a comment with its original date, author and thread through any API (the public route stamps
"now" and runs the visitor checks; the admin routes only moderate; site transfer needs an empty site). See
`docs/spikes/comments-findings.md` in the kit.

## Routes

- `POST /_emdash/api/plugins/wp2emdash-comments/import` — private (admins; an API token needs the `admin` scope; a
  session needs `X-EmDash-Request: 1`). Body `{ comments: [{ id, wpId, collection, contentId, parentId, authorName,
  authorEmail, body, createdAt }] }`, at most 50, oldest first. Answers `{ results: [{ id, outcome: "created" |
  "exists" | "rejected", status?, reason? }], created }`.
- `POST|GET /_emdash/api/plugins/wp2emdash-comments/status` — private: plugin id and version.

## Rules

- Every row is written **pending**. The kit approves the ones approved in WordPress through EmDash's
  `POST /_emdash/api/admin/comments/bulk`, which also purges the cached pages.
- Idempotent by id (deterministic ULIDs from the kit); an existing row is never changed.
- The entry must exist and not be in the trash; a reply's parent must exist, be on the same entry and be top-level.
- WordPress date kept (`created_at` = `updated_at`); no IP hash, user agent or user id. `moderation_metadata` records
  `{ importedFrom: "wordpress", wpCommentId }`.
- Logs carry counts only; rejection reasons never contain names, addresses or text.

Scaffold keeps it registered while `ir/comments.json` lists comments to import (reruns stay idempotent) and drops it
otherwise. It does nothing unless an admin or an admin token calls it.
