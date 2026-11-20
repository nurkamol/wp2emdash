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
- **Capabilities** (1.5 names): `content:read`, `media:read` (SEO score with library alt text), `email:send`
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
- Email delivery of alerts and reports (mocked Brevo / `ctx.email`); how mail apps render the report (HTML is
  table-based with inline styles; golden file `test/golden/health-report.html`).
- The admin page in a real browser session (Block Kit shapes follow the 1.5 types; the routes were unit-tested).
