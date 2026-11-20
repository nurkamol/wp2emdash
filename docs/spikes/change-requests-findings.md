# Change requests — verified facts, decisions and limits (2026-11-21)

Checked against the installed **EmDash 1.5.0, @emdash-cms/admin 1.5.0, @emdash-cms/blocks 1.5.0,
@emdash-cms/plugin-types 1.5.0, Astro 7.4.12, Wrangler 4.163.0, React 19 types** (read in a kit site project's
`node_modules`, never modified). Built and run in a **throwaway copy** of that project (scratch directory, client seed
and secrets left out, local D1/R2 only, two local-only users and API tokens inserted into the local D1; deleted
afterwards). Nothing deployed, no live site touched, no email sent, no webhook called.

## Block Kit has no file input → one React page

- `@emdash-cms/blocks` 1.5 elements: button, text_input (`multiline`), number_input, select, toggle, secret_input,
  checkbox, date_input, combobox, radio, repeater, `media_picker`. **No file input.** `media_picker` is not a form
  field (`FormField` excludes it) and uploads to the **public** media library — unusable for private attachments.
- Raw plugin route responses refuse active content types (`route-wire.ts` `ACTIVE_RESPONSE_TYPES`: `text/html`,
  `image/svg+xml`, JS, CSS, XML…) and EmDash adds `content-security-policy: sandbox; default-src 'none'`, so a plugin
  cannot serve its own HTML upload form.
- A native plugin descriptor may name an **`adminEntry`** module (`astro/integration/virtual-modules.ts`
  `generateAdminRegistryModule` → `pluginAdmins[id]`). The admin's plugin route (`/_admin/plugins/$pluginId/$`)
  renders `pluginAdmins[id].pages[path]` when that path exists (exact match, trailing slash tolerated) and otherwise
  the Block Kit page (`SandboxedPluginPage`). So `pages = { "/attach": AttachPage }` adds one React page and leaves
  `/requests`, the widget and the panel in Block Kit.
- **Do not set `admin.entry` in `definePlugin`**: the runtime then reports `adminMode: "react"` (sidebar entries are
  shown only for React pages) and `getPluginEditorExtension` returns null for the plugin (`if (configured.admin.entry)
  return null`) — the editor panel would disappear. The descriptor's `adminEntry` alone only feeds the admin bundle.
- Plugin page paths must match `/^\/[a-z0-9][a-z0-9/_-]*$/i` (no query string), so the upload page cannot take the
  request id in its URL: the plugin keeps a per-user "ticket" (30 minutes) naming the request the page opens with,
  and the page offers a select of the open requests anyway.
- In panels, link targets are validated against the declared pages (`pluginPagePaths`); `/attach` is not declared (it
  would get its own sidebar entry), so links to it use `{ kind: "external", url: <absolute> }` (opens a new tab).
- Configured (trusted) plugins may serve undeclared Block Kit page paths (`resolveTrustedUiContext`: "configured
  plugins are not held to their declarations"); `/requests/<id>` deep links work that way (the interaction's `page`).

## Routes

- Route options (`@emdash-cms/plugin-types`): `methods`, `request: { body: "none"|"json"|"text"|"bytes"|"form-data",
  maxBytes }` (≤ 8 MiB; default 1 MiB), `response: "json"|"raw"`. **form-data parts are limited to 1 MiB each**
  (`PLUGIN_ROUTE_MAX_MULTIPART_PART_BYTES`), so uploads use `body: "bytes"` with `maxBytes` 5 MiB (one file per
  request; name and request id in the query string, read from `ctx.request.url`). A larger body → 413 before the
  handler (seen locally with a 6 MB body).
- Private routes: permission check (`requirePerm`), token scope `admin`, and the CSRF header `X-EmDash-Request: 1` for
  session requests (`http-route-dispatch.ts`). The upload page sends it; a browser download cannot → downloads use a
  public route with a one-time token (as Backups does).
- `ctx.request` body methods are guarded (body parsed into `ctx.input`); headers and URL are readable.
- Roles (`@emdash-cms/auth`): editor 40 has `content:edit_any`; the routes use it (editors and admins).
- Editor panels: `admin.editorPanels: [{ id, title, route, collections, order }]`, dispatched through
  `/_emdash/api/content/<collection>/<id>/plugin-extensions/<plugin>/panel/<id>` with `ctx.ui = { surface:
  "content-editor-panel", entry: { collection, id, locale, version } }`; the response is Block Kit-validated.

## Storage, privacy and Backups

- Plugin KV = D1 `options` rows `plugin:<id>:<key>` (`createKVAccess`), with `list(prefix)`, `getVersioned` and
  `compareAndSet` — requests are `req:<id>` rows, updated with compare-and-set.
- Attachments go to the site's `MEDIA` bucket under `backups/change-requests/<request>/<file id>-<name>`.
  `PRIVATE_STORAGE_PREFIXES = ["backups/", "transfers/"]` (`transfer/staging/keys.ts`): EmDash's public media route
  refuses them (404 locally). EmDash's own backup retention only lists `backups/emdash-backup-*`; the Backups plugin
  only deletes its own keys and leaves `backups/` out of its media manifest; Media's hourly task only lists
  `backups/media-originals/`. No collision.
- **Backups:** `_plugin_storage` and `plugin:*` options are excluded by design (encrypted settings, form messages). The
  Backups allowlist now has `PLUGIN_DATA_PREFIXES = { "plugin:change-requests:req:": "change requests" }` (filtered in
  SQL and in `optionAllowed`; encrypted envelopes still refused; restore code still reads `site:*` only). Verified
  locally: a "Back up now" file held `plugin:change-requests:req:<id>` and no other `plugin:*` row, and no attachment in
  its media manifest.

## Email and webhook

- Email the way Backups / Site health send it (`@wp2emdash/forms/deliver` over the provider HTTP API, or
  `EMAIL_PROVIDER=emdash` → `ctx.email`, capability `email:send`). EmDash's `EmailMessage` has `replyTo` (used when
  the client chose "Email me"). Never when `STAGING=1`. Locally without `EMAIL_API_KEY` the delivery log recorded
  "the email key (EMAIL_API_KEY) is not set" and nothing was sent.
- Webhook: global `fetch` from the native plugin (as Backups' off-site copy), `AbortSignal.timeout(8000)`, HMAC-SHA256
  over `<timestamp>.<body>` with `crypto.subtle` (same result as Node's `createHmac`, unit-tested). No secret → not
  sent.

## Cron

`cron.schedule("daily", { schedule: "<m> <3–5> * * *" })` on `plugin:install` / `plugin:activate` and on page loads
(as Media). Locally the task appeared in `_emdash_cron_tasks` (`change-requests / daily / "46 4 * * *"`). The
retention run itself is unit-tested only.

## Run in local workerd (throwaway copy)

`astro build` passed with `changeRequestsPlugin()` added; the client `admin-registry` chunk carries the upload page
(`pluginAdmins["change-requests"].pages`). `tsc` of `packages/change-requests` and `packages/backups` against the real
emdash 1.5 and React 19 types: only `cloudflare:workers` unresolved (as for every kit plugin outside the site's
worker types). `wrangler dev --local` on the build, with local-only bearer tokens:
- `file?token=bad` → 410; `admin`, `upload` without auth → 401.
- Editor: create (urgent, anywhere) → `#1`, `uploads` listed it as selected; PNG upload → stored; renamed HTML →
  refused ("Only pictures…"); 6 MB → 413.
- Agency: deep link `/requests/<id>` → shown, status New → **Seen**; reply + "Waiting for you" → saved.
- Editor trying "In progress" → "You cannot move this request…".
- Download: one-time link → 200 `image/png`, `Content-Disposition: attachment`, CSP sandbox, bytes identical to the
  upload; second use → 410.
- Widget: open 1, urgent 1, waiting 1, latest change listed. Editor panel on a page: form shown, "Request this
  change" → `#2` with the page; the form's page picker listed the page ("Contact (draft)").

## Not verified

- The admin in a real browser (needs a passkey sign-in): how the Block Kit page, the tabs, the widget, the panel and
  the React upload page look; file choosing and clipboard paste; the upload page's session + CSRF fetch (verified only
  with bearer tokens through curl).
- Real email delivery and a real webhook receiver (mocked in tests; locally email was not configured).
- The daily retention task on a deployed Worker; R2 deletes from cron.
- Behaviour when two people upload the third file at the same moment (compare-and-set on the request; the losing file
  is deleted again — unit-tested logic only).
