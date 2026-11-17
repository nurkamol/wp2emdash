# M6 — load findings

**Date:** 2026-11-17 · **EmDash** 1.5.0 · target: local dev server (workerd, local D1/R2)

## EmDash REST API used by the loader (verified in `src/client`, `src/api/schemas`, `astro/routes/api`)

| Need | Endpoint | Notes |
|---|---|---|
| Auth (local) | `GET /_emdash/api/auth/dev-bypass` → session cookie | Dev only. |
| Auth (staging) | `Authorization: Bearer <token>` | API token created in the admin; stored as `EMDASH_TOKEN` in the site's `.env`. |
| CSRF | `X-EmDash-Request: 1` + `Origin` on POST/PUT/DELETE | Without them, mutations are refused. |
| Schema check | `GET /schema/block-types`, `GET /schema/collections` | |
| Content | `GET/POST /content/{c}`, `GET/PUT /content/{c}/{id}` (`_rev` for optimistic concurrency), `POST …/publish`, `…/unpublish` | Create accepts `status: "draft"` only; publishing is a separate call. `seo: {title, description, image, canonical, noIndex}` on create/update. |
| Media | `GET /media` (paged, `contentHash: "sha1:…"`), `POST /media` (multipart `file`, `alt`) | Dedupe by sha1 before uploading. Field value: `{ provider: "local", id, alt }`. |
| Menus | `GET/DELETE /menus/{name}`, `POST /menus`, `POST /menus/{name}/items` (`type: "custom"`, `customUrl`, `parentId`, `sortOrder`, `cssClasses`, `target`) | Loader recreates each menu (delete + create) — simplest idempotent sync. |
| Settings | `POST /settings` (`title`, `tagline`, `staging`, `seo.titleSeparator`, …) | `staging: true` = noindex until cutover. |
| Setup (local) | `POST /setup/dev-bypass?content=0` | Applies the seed's structure (block types, collections, menus) without sample content. |

The official `EmDashClient` (`emdash/client`) covers content and media but not menus/settings/SEO writes, and its `create()` converts Markdown strings to Portable Text implicitly — the kit uses its own small REST client (`src/targets/emdash/api.ts`) instead.

## Behaviour

- Astro 7 runs `astro dev` as a daemon (`astro dev stop` to end it); the loader starts and stops it for local loads.
- First run into an empty target: 24 media uploaded, 15 documents created (10 pages, 3 private pages as drafts, footer, popup), menus and settings written; gate passed.
- Second run: 0 uploads, 0 creates, 15 updates, counts unchanged → idempotent.
- Gate re-reads every entry from the target: no links to the WordPress host, no upload URLs, no shortcodes; every `media.id` exists; every published page returns 200 and contains its first heading.

## Not done yet

- Staging target needs (owner-approved): Cloudflare login, D1 + R2 for the `staging` env, first deploy, admin passkey setup at `/_emdash/setup`, an API token → `EMDASH_TOKEN`.
- `site export` snapshot before each staging load (A9) — add with the staging run.
- Redirect import from `raw/redirects.csv` (pilot has none) and the `?p=` / uploads-URL middleware from A6.
- Form submission endpoint (`/api/forms/<id>`).
