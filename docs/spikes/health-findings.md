# Site health & monthly report — verified facts, design and limits (2026-11-20)

Checked against the installed **EmDash 1.5.0, @emdash-cms/cloudflare 1.5.0, @emdash-cms/blocks 1.5.0, Astro 7.4.12,
Wrangler 4.163.0** (the `STACK` versions, read in a generated project's `node_modules`, never modified) and run in a
**throwaway copy** of a generated project (scratch directory, not under `~/Projects`, deleted afterwards). Nothing was
deployed, no live site was touched, no email was sent.

## Plugin cron vs the Worker's scheduled handler — plugin cron

- `@emdash-cms/cloudflare/worker` → `createScheduledHandler()` calls `runScheduledTasks()` (`emdash/middleware`), which
  runs `CronExecutor.tick()` (`emdash/dist/cron-*.mjs`): claims up to **10** due tasks across all plugins
  (`_emdash_cron_tasks`, `next_run_at <= now`, status idle → running), invokes each plugin's `cron` hook with
  `{ name, data, scheduledAt }` and the plugin's normal context (`ctx.kv`, `ctx.content`, `ctx.email`, …), then sets the
  next run from the cron expression (croner, **UTC**). Stale `running` locks are freed after 10 minutes.
- `ctx.cron.schedule(name, { schedule })` upserts by (plugin, task name); `list()` returns name, schedule, next/last run.
  Hooks may be `{ handler, timeout }` (`HookConfig`, default timeout 5 s; `executeWithTimeout` races, it does not abort).
- Config plugins get `plugin:install` → `plugin:activate` once, when no `_plugin_state` row exists for the plugin id
  (`installUnrecordedConfigPlugins`); a later version bump does not re-run them. The plugin therefore also re-checks its
  task whenever an admin opens the page (`ensureCron`).
- **Decision:** plugin cron (task `tick`, `*/5 * * * *`), not a new branch in `src/worker.ts`: it gets the plugin
  context (KV in D1, content, EmDash email) for free and the starter's Worker already runs EmDash's scheduled handler on
  the existing `*/5 * * * *` trigger. No wrangler change besides the `SELF` binding.
- **Run in local workerd** (`wrangler dev --local` on the built copy, synthetic options, empty local D1): the first
  request ran `plugin:install` and `_emdash_cron_tasks` held `site-health / tick / */5 * * * * / idle`; with its
  `next_run_at` moved into the past (local D1 only), a scheduled event (Wrangler's local explorer
  `POST /cdn-cgi/local/explorer/api/local/scheduled?worker=…`) logged `[plugin:site-health] health run { ran:
  'uptime,index,analytics,forms,links' }` and the plugin KV rows (`options`, `plugin:site-health:*`) held the state:
  SELF requests answered from inside the scheduled event (home 404 and an empty sitemap — the local D1 had no content),
  plugin KV writes work in cron context. Public `heartbeat` returned `{ plugin, version, lastRunAt }`; `report` with a
  bad token → 410 text/plain; `admin` and `status` without a session → 401.

## Reaching the site from inside — the SELF service binding

- A Worker's fetch to its own hostname skips the Worker (docs/spikes/M7-findings.md). Health requests every page through
  `env.SELF.fetch(new Request("https://<production host>/…"))`, so the Worker renders exactly what the domain serves,
  before and after go-live. Scaffold now adds `SELF` when health **or** the SEO suite is on.
- Consequences (by design, documented on the page): these requests do not pass Cloudflare's edge — no DNS, TLS or route
  check, and a route-cache HIT never reaches the Worker, so **cached TTFB and `cf-cache-status` are not measurable from
  inside** (the probe records `cf-cache-status` / `Cloudflare-CDN-Cache-Control` when present). The speed number is the
  page **build** time (uncached), the worst case. Cached TTFB stays verify's `cached-ttfb` gate from outside.
- **If the Worker itself is down, its cron does not run either.** Health catches page and database failures, not a
  dead deployment; verify's `health-plugin` check (last run within 30 minutes on a live site) and any outside monitor
  cover that. A plugin without `SELF` skips the checks (the page says so) instead of reporting the site down.

## Limits per tick (schedule.ts)

| Job | When (UTC) | Requests |
|---|---|---|
| uptime | every tick | ≤ 3 to itself (home + 1 rotating sitemap page + retries / open incidents) |
| forms | every 15 min | 0 (Workers KV list + per-day count reads of the last 7 days) |
| index (robots + sitemap) | hourly | ≤ 5 to itself (robots, sitemap, ≤ 3 child sitemaps) |
| analytics | hourly | 0 (reads that tick's home HTML; 1 D1 row) |
| links | daily from 02/03/04 (per-host offset), resumable | ≤ 12 a tick, 3 at a time; ≤ 300 pages, ≤ 1,000 internal addresses; weekly + 20 external (HEAD, GET on 403/405/501) |
| report | 1st from 08 (catch-up to the 3rd) | 1 Cloudflare GraphQL + D1 reads + ≤ 1 email |
| dns | daily from 05 | ≤ 8 DoH queries |
| ssl | daily from 06 | ≤ 2 Cloudflare API calls (only with the token) |
| speed | daily from 07 | 1 CrUX call (only with the key) |

One heavy job per tick; worst case ≈ 3 + 5 + 12 + 6 alert emails ≈ 26 subrequests — inside Workers Free's 50 and far
inside Paid. Each request has an 8 s time limit (`AbortSignal.timeout`); the hook timeout is 25 s. CPU: regular
expressions over ≤ 12 pages of HTML (≤ 1.5 MB each, capped). "Run checks now": all light jobs + dns, ssl, speed and one
link step (≈ 30 subrequests), single-flight (KV `compareAndSet` lock, 4 min expiry) and at most every 2 minutes.

## Other facts used (from the installed source / provider docs)

- **Private plugin routes** (`http-route-dispatch-*.mjs`): permission (default `plugins:manage`) + for API tokens the
  **`admin` scope** + `X-EmDash-Request: 1` for sessions. The kit's load tokens normally lack `admin`, so verify falls
  back to the public `heartbeat` route (no status, no data — only the time of the last run).
- **Block Kit 1.5** block types used: header, banner, stats, table (badge, relative_time, element), chart (timeseries),
  fields, form (text_input multiline, toggle), actions (button with confirm, link with plugin-page/external target),
  context, empty, tab. Plugin page icon names are Phosphor icons (`heartbeat`).
- **Capabilities** (1.5 names): `content:read`, `media:read` (SEO score with library alt text), `redirects:write` (Create redirect, below), `email:send`
  (`ctx.email` exists only when an EmDash email provider is selected).
- **Plugin KV** = D1 `options` rows `plugin:site-health:<key>`; `compareAndSet` / `getVersioned` exist (used for the
  lock). No expiry: download grants carry their own and are pruned when a new one is made.
- **Content**: `ctx.content.list(collection, { limit, cursor })` → items with `status`, `publishedAt`, `updatedAt`
  (one each per entry): the report counts "published" (publish date in the month) and "updated" (saved in the month,
  not published in it) for published pages.
- **CrUX API** (developer.chrome.com/docs/crux/api, not called live): `POST
  https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=…` `{ origin, metrics }`, p75 per metric (CLS as a
  string), 404 when the origin has too little data. Thresholds from web.dev: LCP 2.5/4 s, INP 200/500 ms, CLS 0.1/0.25.
- **DNS over HTTPS**: `https://cloudflare-dns.com/dns-query?name=…&type=MX|TXT|CNAME`, `accept: application/dns-json`
  → `{ Status, Answer: [{ type, data }] }`; TXT data quoted and possibly split (`"a" "b"`), MX `"<prio> <host>."`.
  The baseline (scaffold, from `cutover/dns-before.json`) and the Worker normalise identically and compare SHA-256
  prefixes; record values never reach the plugin options. Other TXT records at the same name are ignored.
- **Certificate packs** (Cloudflare API reference, not called live): `GET /zones?name=`, `GET
  /zones/{id}/ssl/certificate_packs?status=all` → `certificates[].expires_on`, `hosts`. Needs a zone token with Zone
  Read + SSL and Certificates Read (`CF_ZONE_READ_TOKEN`, optional). Without it the check says Cloudflare renews the
  certificate itself — the Worker cannot see TLS details.
- **Visits for a month**: the SEO suite's `rumPageloadEventsAdaptiveGroups` query now takes a `range` (calendar month;
  the day rows' limit grows with it). Same `CF_ANALYTICS_TOKEN`. Not run against the live API (as the 7-day query).

## Redirects from Missing pages — the `redirects:write` capability (verified 2026-11-21, emdash 1.5.0 source)

Three ways a plugin could write a redirect; the official one is a plugin capability:

- **`capabilities: ["redirects:write"]` → `ctx.redirects`** (`plugins/context.ts` `createRedirectAccess(db, true)`,
  `plugins/types.ts` `RedirectAccessWithWrite`; `redirects:read` is implied; both names are in
  `plugins/manifest-schema.ts`). `create({ source, destination, type, enabled, groupName })` parses the input with the
  same `createRedirectBody` schema as `POST /_emdash/api/redirects` and calls the same `handleRedirectCreate`
  (`api/handlers/redirects.ts`): redirect write lock (`REDIRECT_BUSY`), source ≠ destination, pattern validation,
  `CONFLICT` on an existing source, `wouldCreateLoop` on the enabled rules, then `publishRedirectChanges` (the
  content-addressed redirect artifacts the redirect middleware reads, `redirects/artifacts.ts`). Errors throw
  `RedirectAccessError` with `code` + `message` (the message names the source). `list({ limit ≤ 100, cursor, search })`
  returns `{ items, cursor, hasMore }`; `search` is a LIKE on source **or** destination. The context is built per
  plugin by `PluginContextFactory.createContext`, used for hooks (cron) and routes alike. **Chosen.**
- **SELF + admin API with a token** (as the media plugin does): works, but needs an API token with
  `redirects:manage` kept as a Worker secret — more moving parts for the same handler.
- **Direct D1 insert into `_emdash_redirects`**: rejected. It would skip the write lock, the loop check and the
  artifact publish (migrations 081/090/091), so the middleware could serve a stale rule set until a repair.

Facts used: `source` and `destination` must be **site-relative paths** (`urlPath` in `api/schemas/redirects.ts`:
starts with `/`, not `//`, no CR/LF, no `..` segment) — a redirect to another website cannot be stored, so Site
health accepts a full `https://` address only on the site's own host (production host or the admin's address) and
stores its path. The redirect middleware matches the request path exactly and then its other trailing-slash form
(`astro/middleware/redirect.ts` `matchRedirect`), and keeps 404 responses out of the route cache; it logs 404s to
`_emdash_404_log`, whose rows stay after a redirect is added — so the Missing pages read leaves out paths redirected
from the tab (KV `notfound:redirected`, 8 days) and every non-pattern redirect source (`ctx.redirects.list`, ≤ 1,000).
Purging the page cache after a redirect is not needed for the redirect itself (404s are not cached) but is done, as
for the other admin saves, so a page that linked there is rebuilt.

## Scheduled coming-soon — purge at the boundaries

- The middleware evaluates `maintenanceActive(state, now)` on every rendered request (the row is read each time,
  `MAINTENANCE_TTL_MS` 0), so an uncached page switches exactly at `startAt` / `endAt`. Cached pages never run the
  Worker: Site health's cron tick (every 5 minutes) compares the active state with KV `maintenance:applied` and calls
  `purgePages` once when it changed. Up to 5 minutes late; documented in Settings and the client guide.
- Purging from the cron: `cache.purge` from `cloudflare:workers` outside a request is what EmDash's own Cloudflare
  `scheduled()` handler does for the scheduled-publish sweep (`@emdash-cms/cloudflare` `src/worker.ts`
  `invalidatePublishedTags` → the cache provider's `invalidate`), and plugin cron runs inside that handler
  (`runScheduledTasks`). Not yet observed on a deployed Worker for this plugin.
- The holding page (503, `no-store`) is never cached, so at `endAt` nothing stale remains; the end purge only rebuilds
  pages that were cached before the start (harmless; the cache refill fills them again).

## What to improve — reading other plugins' summaries (0.4, emdash 1.5.0)

- Other plugins' KV is read as D1 `options` rows `plugin:<id>:<key>` (createKVAccess → OptionsRepository, same fact
  as `@wp2emdash/seo/analytics/store.ts`): `plugin:media-assistant:summary` (already used by the Media check) and the
  new `plugin:site-seo:summary` (`@wp2emdash/seo/summary`), one primary-key SELECT each. Both plugins run in the same
  Worker and D1, so no capability is involved; a missing row means "not scanned / not analysed yet" and the items skip.
- Links to other plugins' pages use `/_emdash/admin/plugins/<id><path>` (`resolvePluginLinkTarget`, see
  chat-notifications-findings.md C2); in Block Kit they are `{ kind: "external", url }` (a `plugin-page` target is
  validated against this plugin's own pages; change-requests-findings.md). Table cells take link and button
  elements (analytics-findings.md), so Site health's own tabs open with an `improve-tab` button.
- Form messages: only the outbox's per-day **counts** (`stat:` keys) feed the "fewer messages" item; message keys are
  never opened (test plants a message and asserts its text is absent from the report, HTML and text).

## Weekly lab score — PageSpeed Insights v5 (2026-11-22)

Sources: Google's reference (developers.google.com/speed/docs/insights/rest/v5/pagespeedapi/runpagespeed), Cloudflare's
limits page (developers.cloudflare.com/workers/platform/limits), the installed EmDash 1.5.0 / @emdash-cms/cloudflare
1.5.0 / @emdash-cms/blocks 1.5.0 source (read in the kit's `spikes/m0-site` node_modules, unchanged), and one live
keyless call.

- **Request**: `GET https://pagespeedonline.googleapis.com/pagespeedonline/v5/runPagespeed` (Google's documented host;
  `www.googleapis.com/pagespeedonline/v5/…` is the older alias), empty body. Query: `url` (required), `strategy`
  `MOBILE` | `DESKTOP` (default DESKTOP — so each strategy is its own call), `category` enum `PERFORMANCE`,
  `ACCESSIBILITY`, `BEST_PRACTICES`, `SEO` (default: performance only; repeated parameter for several), `locale`,
  `key`. The kit also sends Google's standard partial-response parameter `fields` (see below).
- **Response** (documented fields used): `lighthouseResult.categories.{performance,accessibility,best-practices,seo}.score`
  (the docs give no range and allow null; Lighthouse scores are 0–1, shown ×100 with bands 0–49 / 50–89 / 90–100),
  `lighthouseResult.audits` (map of audit results), `lighthouseResult.runtimeError { code, message }` ("may make the
  result unusable"), `lighthouseResult.finalUrl`, `analysisUTCTimestamp`, plus CrUX copies in `loadingExperience` /
  `originLoadingExperience` (not used: the daily CrUX call already covers them). **Not in Google's PSI reference**
  (Lighthouse's own result format): audit fields `numericValue` (ms for `first-contentful-paint`,
  `largest-contentful-paint`, `total-blocking-time`, `speed-index`; unitless for `cumulative-layout-shift`) and the
  `largest-contentful-paint-element` details — Lighthouse ≥ 10 nests a `table` with `node.snippet` / `nodeLabel` in a
  `list`, older versions give the table directly; the parser accepts both.
- **Errors** (verified live 2026-11-22, keyless call): HTTP 429 `{ error: { code: 429, message: "Quota exceeded for
  quota metric 'Queries' and limit 'Queries per day' …", status: "RESOURCE_EXHAUSTED", details: [{ reason:
  "RATE_LIMIT_EXCEEDED", metadata: { quota_limit_value: "0", quota_limit: "defaultPerDayPerProject" } }] } }` — the
  anonymous quota is effectively zero, hence a key is required and nothing is called without one. Other mappings
  (400 "API key not valid", 403 API not enabled, "Lighthouse returned error: CODE") follow Google's standard API
  errors; kept as fixed reason codes, never Google's text.
- **Key**: `PAGESPEED_API_KEY`, else `CRUX_API_KEY` — a Google Cloud API key belongs to a project and works for every
  API enabled on that project (and allowed by the key's API restrictions), so one key can serve CrUX and PSI.
- **Duration and Workers limits**: a Lighthouse run takes roughly 10–60 s. Cloudflare: HTTP requests have no hard
  duration limit, but `waitUntil()` extends work only **30 s** after the response; **scheduled Workers get 15 minutes
  of wall time**; waiting on fetch does not count as CPU time (CPU: Free 10 ms, Paid 30 s default / 5 min max);
  subrequests 50 (Free) / 10,000 (Paid). EmDash 1.5: `@emdash-cms/cloudflare` `createScheduledHandler` wraps
  `runScheduledTasks` in `ctx.waitUntil`; `CronExecutor.tick()` runs claimed tasks **sequentially** and
  `invokeCronHook` → `executeWithTimeout` **races** the hook against its timeout without aborting it (stale `running`
  tasks freed after 10 minutes). **Decision:** the test runs from the cron tick after the checks (own KV lock), mobile
  and desktop in parallel with a 90 s `AbortSignal.timeout` each; the cron hook timeout is 150 s (checks ≤ 25 s + 90 s
  + margin) so the scheduled event's `waitUntil` does not end while Google is still answering. "Run PageSpeed test now"
  only stores a request (at most every 10 minutes); the next tick (≤ 5 minutes) runs it. Another plugin's cron task in
  the same tick waits up to ~90 s longer once a week. Subrequests per tick: + 2 (+ 1 alert email at most).
- **CPU**: the full PSI answer is about 0.5–2 MB of JSON; `fields=lighthouseResult(finalUrl,runtimeError,categories(…
  (score)),audits(<5 metrics>(numericValue),largest-contentful-paint-element(details)))` trims it to a few KB (Google's
  standard partial-response system parameter). If Google rejects the selection (400 naming the field), the call is
  retried once without it.
- **Block Kit 1.5**: `chart` with `chart_type: "timeseries"` takes several `series` (`[timestamp_ms, value][]`, optional
  colour) — used for mobile vs desktop performance; `stats` items take `trend: up | down | neutral`.

## Visual check — structural fingerprints, no screenshots (2026-11-22, @wp2emdash/health 0.6.0)

Checked against the installed **EmDash 1.5.0** (`spikes/m0-site/node_modules/emdash`, unchanged), the Astro Cloudflare
adapter's build output in the same spike and Cloudflare's static-assets docs. Nothing deployed, no live site requested;
everything below is unit-tested with a mocked site (`test/health-visual.test.ts`).

- **Screenshots: not added.** Cloudflare Browser Rendering is a separate `browser` binding (plus `@cloudflare/puppeteer`
  in the bundle); no generated project has it, and it is a small daily allowance on Workers Free and billed by browser
  time on Paid. Per the kit rules no new binding or paid feature is added without an owner decision. The check is
  **structural** instead, the same text reading the deploy check does from outside (`src/scaffold/deploy-check.ts`).
  A future pixel diff would add the binding as an opt-in and keep images in R2, not KV.
- **What a fingerprint holds** (per page, `checks/visual.ts`): HTTP status; `<title>`; the first `<h1>`; the starter's
  section types in order — `starter/src/components/Section.astro` renders `<section class="section section--<type>
  [section--<type>--<variant>] … [section--full] [section--media-bg]">`, so the type is the one `section--x` class that
  is not a variant (`--` inside) or one of the two modifiers; the number of `<img>` and whether each (up to 8 per page,
  each address once per run) answers **200 with `image/*`**; whether each `<link rel=stylesheet>` loads; the
  `@font-face` families in the site's CSS (linked + inline) plus the families named in a Google Fonts link; the
  visible word count of `<main>` (else `<body>` without header/nav/footer); whether a `<footer>` exists. Pages: the
  home page, the baseline's pages still in the sitemap, then the sitemap's shallowest paths — default 10, kit.config
  `health.visualPages` (0–25, 0 = off; HealthOptions `visualPages`).
- **EmDash's `/_image` transforms are not requested.** `<Image>` emits `/_image?href=<media path>&w=…`; each variant
  is a Cloudflare Images transformation (performance-findings.md: 5,000 unique/month free) and SELF requests skip the
  route cache. The check requests the `href` original (`/_emdash/api/media/file/…`, R2) instead: a missing file is
  what breaks a picture, and the starter's middleware already turns a failed transform into a 302 to the original.
- **Stylesheets and the asset layer.** Astro's CSS lives in `/_astro/*.css`, served by Workers static assets.
  Cloudflare documents "assets first, then the Worker" for incoming requests but says nothing about **service-binding**
  calls, so it is not known whether `SELF.fetch("/_astro/x.css")` reaches the asset layer. The Astro Cloudflare adapter
  writes `assets: { binding: "ASSETS", directory: "../client" }` into `dist/server/wrangler.json` (checked in the
  spike build), so the binding exists in every generated Worker at no cost: a file the site answers 404 for is asked of
  `env.ASSETS` before it is called missing. **Not verified on a deployed Worker** (either path).
- **Time and request budget.** The cron hook timeout is 150 s (checks ≤ 25 s + PageSpeed ≤ 90 s). The visual step runs
  after the checks **only in a tick where the PageSpeed test did not run**, spends at most **8 requests a tick**
  (page HTML, then its pictures and stylesheets), 4 at a time, 8 s limit each (≤ ~24 s). The job (KV `visual:job`)
  resumes on the next tick, so a 10-page run takes a few ticks (minutes). Subrequests per tick: checks ≤ 26 + 8 + 1
  alert email — inside Workers Free's 50. Single flight: own lock `visual:lock` (2 min). Weekly from 10:00 UTC
  (`next` = finish + 7 days), the first run at once (it is the baseline), "Check now" at most every 10 minutes (stored
  request, picked up by the next tick, like the PageSpeed button). Not on staging; paused while coming-soon mode shows
  the holding page. Before go-live it runs (SELF renders this Worker, so the baseline is the new site) and marks the
  run; alerts are held by the normal alert path.
- **Tolerances** (`comparePage`): problems — status not 200, a picture or stylesheet that does not load, a baseline
  font no longer defined (site-wide, listed on the home page), the footer gone, the page empty (< 20 words and no
  picture where the baseline had ≥ 50 words); changes — words ±30 % (pages with ≥ 50 words), fewer pictures, a section
  type gone or two sections fewer, title or h1 changed. Problems and changes both alert (one email per day, issue
  `visual-change`, through `deliverAlerts`) and become a "What to improve" item (broken: impact 95; changed: 55).
- **Auto-update after an edit — `updatedAt` via `ctx.content.list`.** EmDash 1.5 `ContentListOptions` has `orderBy`
  (`context-*.mjs` `list()` → `ContentRepository.findMany`, which maps `updatedAt` → `updated_at` and caps `limit` at
  100); items carry `updatedAt`. One `list(collection, { limit: 100, orderBy: { updatedAt: "desc" } })` per collection
  (HealthOptions `collections`, default `["pages"]`), stopping at the first entry older than the oldest baseline, at
  most 3 pages — the `content:read` capability the plugin already has. Entry slug = WordPress path, `home` = `/`
  (starter `entryHref`). A page saved after its baseline takes its new look as the baseline **unless something is
  broken** (problems still alert). Limits: `updatedAt` also moves on a draft save, so an unpublished edit can make an
  unrelated live change look intended for that page; menus, site settings, widgets and the design are not entries, so
  their changes are reported and the admin accepts them.
- **Accept** (`visual-accept`, admin route = `plugins:manage` + role ≥ 50 checked again): all pages and the font list,
  or one page (`value` = path), take the latest fingerprint; error pages never become a baseline; broken pictures and
  stylesheets stay problems after an accept.
- **Storage** (KV `visual`): baselines (≤ 25 pages), the latest fingerprint per page, the baseline and current font
  lists, the last **8** runs (per page: state, plain-language differences, status, words, pictures — no page text).
  Worst case well under 400 KB (asserted in tests), normally ~20 KB. Nothing on the public site is changed or purged.

## Accessibility and content freshness (2026-11-22, @wp2emdash/health 0.8.0)

Checked against the installed **EmDash 1.5.0** and **@emdash-cms/admin 1.5.0** (`spikes/m0-site/node_modules`,
unchanged). Nothing deployed, no live site requested; unit-tested with synthetic HTML and a mocked content API
(`test/health-review.test.ts`).

- **No extra request, no browser.** Both read the HTML the visual check already has in hand: `stepVisual` calls an
  optional `inspect(path, html)` right after parsing a page (`VisualIo.inspect`, set by `runVisual`), and the job (KV
  `visual:job`) keeps the short findings per page until the run ends. The request count per tick is unchanged (test:
  identical request lists with and without the inspector). Same schedule, staging / coming-soon rules and page set as
  the visual check (so `visualPages: 0` turns these off too). CPU: one regex tokenizer pass into a loose tree (cut at
  600 KB, 20,000 elements, depth 200 — deeper nesting is flattened so the rules' recursion cannot exhaust the stack)
  plus a few regexes over the text; a few ms for a typical 100 KB page.
- **Accessibility rule names follow axe-core** (`image-alt`, `page-has-heading-one`, `heading-order`, `link-name`,
  `button-name`, `label`, `duplicate-id`, `html-has-lang`, `frame-title`), as the kit's verify phase reports them
  (`src/verify/browser.ts` runs axe; `src/phases/verify.ts` gate `a11y`). Additions without an axe default rule:
  `image-alt-filename`, `multiple-h1`, `empty-link` (split from `link-name` for a plainer fix). Decisions to keep it
  quiet: `alt=""` is decorative (fine); a placeholder counts as a field's name (axe's `label` rule accepts
  `non-empty-placeholder`); `heading-order` only for a jump of two or more levels; ids inside `<svg>` ignored (inline
  icons repeat their gradient / clip ids); 1×1 pixels ignored; everything under aria-hidden / `hidden` / `<template>` /
  `<noscript>` and the comments section (`id="comments"`, starter `Comments.astro`) skipped — so the starter's own
  decorative parts (logo `<img alt="">` inside a link named by aria-label, the form honeypot `_hp` with aria-hidden,
  `PostCard.astro`'s aria-hidden picture link, the hidden preloader) never appear. Contrast and keyboard focus need a
  rendered page: left to verify (axe in Playwright). At most 8 findings per rule and 40 per page (the rest counted).
- **Grouping**: an item is rule + element summary across pages (a footer link on every page = one item); "site-wide"
  = on 3+ pages or at least half of the pages checked → "What to improve" impact 62 (between form messages 65 and thin
  pages 60); the rest impact 44. Element summaries come only from the site's markup: tag, first class, a file name, a
  path (mail / phone links reduced to `mailto:…` / `tel:…`), a field name, an id, a heading text ≤ 50 characters.
- **Freshness** reads (a) the visual check's HTML — `<main>` (else body without header / nav / footer), with
  `<time>` (the starter's post dates, `PostMeta.astro`), post cards and comments removed and block ends turned into
  sentence breaks; the copyright line from the whole body — and (b) the pages' entries: one `ctx.content.list("pages",
  { limit: 100 })` pass (≤ 3 pages) at the end of the run; EmDash 1.5 `ContentItem` has `status` ("published" /
  "draft"), `slug`, `data`, `updatedAt` (types `ContentItem`, `ContentListWhere`). Drafts are skipped; string leaves
  of `data` are scanned (keys such as url, slug, id, style, colour skipped; address-like values skipped). Posts are
  never listed (old posts are fine, as the owner asked); HTML findings of pages that are not page entries (posts,
  archives) are dropped once the content was read — except the copyright line, which is site-wide.
- **Date rules (conservative)**: a full date with a weekday is an event; a full date without one, a numeric date and a
  month-year need an event word in the same sentence (join us, workshop, class, register, until, through, tickets,
  sale, offer, a time like "7 pm", and a few German / French / Spanish / Dutch words); history words before the date
  (since, founded, established, posted, published, updated, effective, award, won …) skip it. Numeric dates only with
  `/` or `.` (never `-`, so `713-555-0199` cannot match), not preceded by a letter, digit, currency sign or `+` (so
  `v2.1.2024` and `$1.2.2024` cannot match), and only when every valid reading (US M/D and European D/M) is past.
  Past = the end of that day (UTC) before now. Year phrases: seasons / holidays with a year (each ends with its
  period: summer → 31 Aug, winter → end of Feb next year, Black Friday → 30 Nov …), "<year> offer / schedule /
  pricing / classes / events …", "schedule for <year>", and `©` / `(c)` / "Copyright" lines whose last year is before
  this year. The starter's footer credit is `© {new Date().getFullYear()}` (`Base.astro`, `SiteHeader.astro`): never
  stale. Legal and thank-you pages are skipped by slug (privacy, terms, cookies, imprint / impressum, legal, refund,
  returns, shipping, disclaimer, accessibility statement, waiver, thank-you, confirmation …).
- **Not updated**: an entry's `updatedAt` older than `staleMonths` calendar months (default 18; kit.config
  `health.staleMonths`, 0 = never) → impact 20 (low). Past dates and phrases → impact 42 (between missing
  descriptions 50 and pictures without a description 40). Limit: `updatedAt` also moves on a draft save, so a page
  with an unpublished edit counts as updated.
- **Edit links**: the EmDash admin's router (`@emdash-cms/admin` 1.5, TanStack Router with `basepath:
  "/_emdash/admin"`) has the route `/content/$collection/$id` — so a page's editor is
  `/_emdash/admin/content/pages/<entry id>`. `ImproveLink.admin` carries such a path; `improveUrl` builds the full
  address (plugin links unchanged). Used when an item concerns exactly one page whose entry is known.
- **Storage**: KV `review` — ≤ 60 accessibility and ≤ 60 freshness items, ≤ 25 pages each, strings ≤ 80–120
  characters, an `edit` map for listed pages (worst case asserted < 100 KB). KV `review:dismissed` — id → until /
  when / label (≤ 120 characters), ≤ 200 entries, expired ones dropped and the oldest beyond 200 dropped on every write.
  Dismiss periods: 90, 365 or 1,825 days ("for good"); only ids of listed items are accepted, admin route only (role
  ≥ 50 checked again), logs carry the kind and period only. **No email alert** for either part (weekly noise); both
  reach the monthly report through "What to improve".

## Privacy

Stored, logged, emailed and shown: URLs/paths of the site, page titles, statuses, counts, times, hostnames of
referrers and of broken external links. Never: form contents, visitors' names or addresses, tokens or keys (the CrUX
key is only in the request URL to Google, tokens only in Authorization headers; error texts are ours or HTTP statuses).
Logs carry counts and reasons. Unit tests assert none of the secrets or a test message's personal data appear in KV,
logs or emails after a full run. Settings logs carry recipient counts, never addresses.

## Not verified yet

- Plugin cron on a deployed Worker (only local workerd); a service-binding request from a deployed scheduled event.
- Whether a `SELF` request passes the Workers cache layer on Cloudflare (assumed not; only headers are recorded).
- CrUX, certificate-pack and month-range GraphQL calls against the live APIs (mocked in tests).
- A successful PageSpeed Insights call with a key (only the keyless 429 was observed): the `fields` selection syntax
  with hyphenated names (retried without it on a 400), and the exact error texts for a refused key or a disabled API.
- A 60-second PSI wait inside a deployed scheduled event (follows from the documented 15-minute wall time and EmDash's
  non-aborting hook timeout; not observed).
- Email delivery of alerts and reports (mocked Brevo / `ctx.email`); how mail apps render the report (HTML is
  table-based with inline styles; golden file `test/golden/health-report.html`).
- The admin page in a real browser session (Block Kit shapes follow the 1.5 types; the routes were unit-tested).
- `ctx.redirects.create` from the admin route on a deployed site (source-read and unit-tested with a stand-in), and the
  `menu` element inside a table cell (Block Kit 1.5 `TableColumn.format: "element"` allows button, link or menu).
- The cron's boundary purge on a deployed Worker (see "Scheduled coming-soon").
- The visual check on a deployed Worker: whether `SELF` serves `/_astro/*.css` and other static files or the `ASSETS`
  fallback is needed, and `ctx.content.list` with `orderBy: { updatedAt: "desc" }` against D1 (source-read only).
- Accessibility and freshness on a deployed Worker (same path as the visual check), and `ctx.content.list("pages")`
  item `data` against D1 (types read; mocked in tests). The `/_emdash/admin/content/<collection>/<id>` edit link was
  read from the admin bundle's route table, not opened in a browser.

## Visual check: first live run (2026-11-22, a live client site)

- Verified on a deployed Worker: the first run took the baseline at 04:40 UTC without errors; page reads through the SELF binding worked and both `@font-face` families were found in the site's stylesheets, so stylesheet reads (SELF, or the ASSETS fallback) work. The view reported "All checked pages look as expected". Next weekly comparison 7 days later.
