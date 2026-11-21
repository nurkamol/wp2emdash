# CSP violation reports — verified facts, design and limits (2026-11-21)

Why: the generated sites send a strict Content-Security-Policy (starter `src/middleware.ts`: `script-src 'self'` +
allowed providers + SHA-256 hashes of `scripts/inline/*`; `'unsafe-inline'` only for signed-in editors). A component
script that a build inlined was once silently blocked on a live site and only a manual verify run noticed. Goal: the
first real visitor whose browser blocks a script reports it, and the owner/agency gets an alert (Site health).

Checked against the installed **EmDash 1.5.0** and **@emdash-cms/plugin-types 1.5.0** (read in
`spikes/m0-site/node_modules`, never modified). Browser behaviour is from the CSP3 / Reporting API specifications and
has **not yet been observed on a deployed site** (see "Needs a live check").

## EmDash 1.5: a plugin route can receive CSP reports — no starter API route needed

- Plugin routes are served at `/_emdash/api/plugins/<pluginId>/<route>` for every method
  (`dist/astro/routes/api/plugins/_pluginId_/_...path_.mjs` → `dispatchPluginApiRequest`). `public: true` skips the
  permission / `X-EmDash-Request` checks (`authorizePrivatePluginRouteRequest` runs only for private routes).
- **Body parsing** (`dist/route-wire-*.mjs`, `parseDeclaredPluginRouteInput`): with a declared
  `request: { body: "text", maxBytes }` the body is read up to `maxBytes` (a `Content-Length` above it, or a stream
  that exceeds it → `PluginRouteRequestError` 413 before the handler) and decoded as UTF-8 — **whatever the
  Content-Type**. Only `form-data` checks the type; `json` parses regardless of type. So `application/csp-report` and
  `application/reports+json` both reach the handler as `ctx.input: string`. Without a declaration, POST bodies go
  through `request.json()` and a failure gives `undefined` (would also work, but without the size cap).
  `maxBytes` must be a positive integer ≤ 8 MiB (`pluginRouteRequestSchema`); default 1 MiB.
- The handler gets the original request (headers readable; body methods throw — `guardConsumedRequestBody`).
- `response: "raw"` with `pluginResponse({ status: 204 })` → `pluginRouteResponseFromWire` builds a `Response` with a
  null body for 204; EmDash adds `Cache-Control: private, no-store`, `X-Content-Type-Options`, a sandbox CSP and
  `Referrer-Policy: no-referrer`.
- **CSRF** (`dist/astro/middleware/auth.mjs`, `checkPublicCsrf`, applied to every non-GET under
  `/_emdash/api/plugins/`): allowed when there is no `Origin` header, or it equals the request origin or the configured
  public origin; otherwise 403. Reports go to the page's own origin (same-origin endpoint, relative `report-uri`,
  absolute same-origin `Reporting-Endpoints`), so they pass. Astro's own `checkOrigin` only covers form content types.
- POSTs to plugin routes call `ensureStorageIndexesSynced(pluginId)` first (cheap once synced).
- Plugin KV (`ctx.kv`) = EmDash `options` rows `plugin:site-health:<key>`, with `getVersioned` / `compareAndSet`
  (`dist/context-*.mjs`, `createKVAccess`): used so a report never overwrites an admin's "Clear" or switch.

**Decision:** plugin route `csp` (`public`, `methods: ["POST"]`, `request: { body: "text", maxBytes: 8192 }`,
`response: "raw"`, always 204). Endpoint: **`/_emdash/api/plugins/site-health/csp`**. It is under `/_emdash`, so the
starter's coming-soon mode never answers it with the holding page (`maintenanceBypass`) and the middleware's canonical /
WordPress-URL handling skips it.

## Report formats (spec)

- **Legacy `report-uri`** (Safari, Firefox; Chrome when there is no `report-to`): one POST per violation,
  `Content-Type: application/csp-report`, body `{"csp-report": {"document-uri", "referrer", "violated-directive",
  "effective-directive", "original-policy", "disposition", "blocked-uri", "status-code", "script-sample",
  "source-file", "line-number", "column-number"}}`. `blocked-uri` is `inline`, `eval`, `wasm-eval`, `self`, an origin
  (cross-origin blocked URLs are already reduced by the browser) or a full same-origin URL.
- **Reporting API** (Chrome, Edge): `report-to <name>` + response header `Reporting-Endpoints: <name>="<url>"`;
  batched POSTs, `Content-Type: application/reports+json`, body `[{"type": "csp-violation", "age", "url",
  "user_agent", "body": {"documentURL", "referrer", "blockedURL", "effectiveDirective", "originalPolicy",
  "sourceFile", "sample", "disposition", "statusCode", "lineNumber", "columnNumber"}}]`. A browser that supports
  `report-to` ignores `report-uri` in the same policy, so sending both reports once per browser.
- The endpoint name is not `default`, so deprecation / intervention reports are not sent to it; any non
  `csp-violation` entry is ignored anyway.

## What is kept, what is dropped (packages/health/src/csp.ts)

Kept per source (key = effective directive + blocked source): directive, blocked source reduced to its origin (or
`inline` / `eval` / `wasm-eval` / `blob:` / `trusted-types`), up to 5 page **paths** (no query, no fragment), the source
file's origin (`self` for the page's own), count, first/last seen, and a per-month counter. Never IPs, user agents,
full URLs, referrers, the original policy or code samples. Dropped: extension schemes (`chrome-extension:`,
`moz-extension:`, `safari-extension:`, `safari-web-extension:`, `ms-browser-extension:` and other `*-extension:`) as
blocked source or source file, `about:`, `data:` (the site never loads scripts or styles from `data:`; images and fonts
are allowed, so a `data:` violation comes from an extension), documents on another origin than the request's or the
production one, requests carrying the admin session cookie. Signed-in editors' CSP has no report directives at all.

Abuse limits: 8 KB body (EmDash, before the handler), 20 reports per request, 30 requests a minute per isolate
(module-level fixed window), 50 sources kept (oldest by last seen dropped), one KV read and at most one
compare-and-set write per request (a concurrent write wins; the report is dropped).

## On/off: baked in at build, the switch only stops storage and alerts

The middleware reads D1 per request only for coming-soon mode. An extra D1 read on every page view to know whether to
add `report-uri` is not worth it: the report directives are decided at build from site.config.json `cspReport`
(scaffold sets it when Site health is on and kit.config `health.cspReports` is not false). The admin switch on the
Security tab (KV `csp.off`) makes the route drop reports and the tick send no alerts; browsers may still send reports
(each costs one KV read). Turning reports off in the CSP itself = `health.cspReports: false`, rescaffold, deploy.

## Alerts

The 5-minute tick reads the `csp` row; entries flagged `fresh` have their flag cleared by compare-and-set **before**
any email (so one violation never alerts twice; on a conflict they wait for the next tick), then go through the normal
alert machinery: `csp-script` (script-src / -elem / -attr / worker-src, severity problem) and `csp-other` (anything
else, info), one per issue per day, six a day overall, only when live and never on staging. Flags are cleared even
when the email is held, so reports from before go-live do not alert at go-live.

## Needs a live check

- That Chrome sends the Reporting API batch (with `Origin` equal to the site) and Safari/Firefox the legacy POST to
  the endpoint, and EmDash answers 204 (not 403 CSRF) — e.g. a test page on staging with a deliberately blocked inline
  script, then Site health → Security.
- Whether reports arrive with an `astro-session` cookie for signed-in editors browsing with a stale CSP (they are
  dropped either way).
- The Security tab's headers table against the live home page (zone-level header rules are not visible through SELF).
