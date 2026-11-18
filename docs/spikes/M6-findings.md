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

## Staging deploy (2026-11-17) — what we learned

- **R2 and D1 locations are fixed at creation and default to the creator's region** (here EEUR for a US clinic). R2 honours a location hint only the first time a bucket *name* is created — deleting and recreating the same name keeps the old location. Create production resources with `--location` matching the audience (`enam` for the US East coast) on the first attempt.
- **The Cloudflare Astro adapter flattens `wrangler.jsonc` at build time.** `wrangler deploy --env staging` after a normal build deploys the *top-level* bindings (production names). The environment must be chosen during the build: `CLOUDFLARE_ENV=staging astro build && wrangler deploy` (now the generated `deploy:staging` script). Always dry-run and check the binding names.
- Wrangler auto-provisions the adapter's `SESSION` KV namespace on first deploy (`<worker>-session`).
- **D1 migrations must run before the first request.** In the default `auto` mode the first request runs EmDash's core migrations; if that request is cut off (a client timeout), the migration lock stays held and every request answers 503 (`database migrations are required … migration lock has been held since …`). The supported path (docs: deployment/core-migrations) is deployment-managed: `astro build` writes `.emdash/migrations.json` → `emdash migrate --wrangler-config wrangler.jsonc --wrangler-env staging` → `wrangler deploy` → `emdash migrate --check`. `emdash migrate` needs `CLOUDFLARE_ACCOUNT_ID` and a `CLOUDFLARE_API_TOKEN` with **D1 Edit** in the shell environment (it does not read `.env`); taking over a stuck lock uses the same command.
- `.emdash/migrations.json` is a build artifact: gitignored, kept together with the build it came from.
- **Recovery that worked on the pilot:** `emdash migrate --status` (lock id, 65 applied / 32 pending) → `emdash migrate --take-over-lock=<id> --expected-target-fingerprint=<fp>` (applied 066–097) → `--check` exit 0 → redeploy the same build. Generated projects now run migrate between build and deploy (`deploy:staging`).
- First-run admin setup lives at `/_emdash/admin/setup` (`/_emdash/admin` redirects there); `/_emdash/api/setup/status` reports `needsSetup` and the seed it will apply.

## Staging load (2026-11-17)

- **DNS for a new `*.workers.dev` host is unreliable for a while:** the local resolver cached NXDOMAIN, `cloudflare-dns.com` alternated between SERVFAIL ("No Reachable Authority at delegation workers.dev") and the right answer, and `dns.google` was unreachable from the operator's network. The browser (its own secure DNS) worked. The kit's `kitFetch` (undici) now: system lookup → Cloudflare DoH with retries and a 10-minute cache → optional pinned addresses from `cloudflare.json` (`staging.worker.addresses`), like `curl --resolve`; the connect timeout covers the lookup (60 s).
- **The undici package's `fetch` does not recognise Node's built-in `FormData`** (different class) and sends it as text → EmDash answers `UPLOAD_ERROR` ("Unrecognized Content-Type … FormData can only parse multipart/form-data"). `kitFetch` encodes form bodies with Node's `Request` first and sends bytes with the multipart boundary.
- Result: 24 media uploaded to R2 (incl. the hero video copied from the external CDN), 15 documents, menus, settings; gate passed. A partial first run (uploads failing) left 10 documents without media; the next run created the 5 missing and updated the 10 through the id-map — recovery without cleanup. Second full run: 0 uploads, 0 creates.
- EmDash API token scopes used: `content:read/write`, `media:read/write`, `schema:read`, `menus:manage`, `settings:read/manage` — sufficient for create, update, publish, menus and settings.

- **EmDash refuses to change the `_type` of a block whose `_key` already exists on the entry** (`VALIDATION_ERROR: content[2]._type: cannot change an existing block's type`), checked per key, not per position (verified 2026-11-18 on the local dev server: the same update with new keys loaded fine). Block keys are now `<slug>-<index>-<type>` (`blockKey()`), so a section that becomes another type on a rerun is a new block. The first load after this change re-keys every block once.

## Not done yet

- `site export` snapshot before each staging load (A9) — add with the staging run.
- Redirect import from `raw/redirects.csv` (pilot has none) and the `?p=` / uploads-URL middleware from A6.
- Form submission endpoint (`/api/forms/<id>`) — done in M7, see M7-findings.md.
