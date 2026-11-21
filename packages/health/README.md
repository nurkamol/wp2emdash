# @wp2emdash/health (experimental) — Site health & monthly report

A PixelKraft plugin for EmDash sites on Cloudflare Workers, on by default in every site the wp2emdash kit
builds (`health: false` in `kit.config.ts` turns it off). Admins only.

## What it does

- **Scheduled checks** (EmDash plugin cron, task `tick` every 5 minutes, driven by the Worker's `*/5 * * * *` trigger):
  uptime (home page + a rotating sitemap page; incident = two failures in a row, recovery noted), search engines
  (noindex meta / X-Robots-Tag, canonical host, robots.txt, sitemap), form messages (the `@wp2emdash/forms` outbox:
  waiting / refused counts, email status — read through that package, counts only), broken links (daily, resumable;
  20 sampled external links weekly), email DNS records against the go-live baseline (DNS over HTTPS), the certificate
  (optional token), speed (page build time; Chrome UX Report p75 LCP / INP / CLS with an optional key) and the
  analytics tags (the page carries the codes switched on in SEO & Analytics), backups (the backups plugin's heartbeat)
  and media (the Media Assistant's daily counts: images on pages without alt text, oversized originals, broken image
  references; one D1 read, never an alert). Cadence and limits: `src/schedule.ts`.
- **Missing pages** (hourly, one D1 read of EmDash's `_emdash_404_log`): the addresses asked for in the last 7 days,
  most requested first, each with a suggested redirect from the sitemap; bot probes (wp-login.php, .env…) counted, not
  listed. Its own tab and a dashboard hint; never an alert. **Create redirect** on a row (on by default; capability
  `redirects:write`): one click to the suggested page, or a small form (the sitemap's pages, or a path / full https
  address on this site) → a 301 in EmDash's own redirects (`ctx.redirects.create`, group `site-health`, editable in
  Redirects). Validated first: the source is a path that is not a page of the site, the target a page in the
  sitemap, not the same address, no redirect from the source yet, the target not redirected itself (EmDash checks loops
  and duplicates again). EmDash stores site-relative destinations only, so another website cannot be a target. The row
  leaves the list (KV key `notfound:redirected`, 8 days; the hourly read also leaves out every redirect source), the
  cached pages are purged. Logs carry counts, never addresses.
- **Coming-soon mode** (Settings tab): stored as the KV key `maintenance` (EmDash `options` row
  `plugin:site-health:maintenance`), which the kit's starter middleware reads to serve a branded 503 holding page
  (Retry-After, noindex, never cached) to visitors while signed-in people see the site. While it is on, uptime,
  search-engine, analytics and link checks pause. Never switched on by the migration. **Preview link**
  (`?preview=<key>`, 32 random URL-safe characters kept in the same row): people without an admin account see the site
  for 7 days in that browser (cookie `site-preview`, never cached); "New link" replaces the key and ends every old link.
  **Schedule** (optional `startAt` / `endAt` in the same row, UTC, entered as `YYYY-MM-DD HH:MM`): the holding page
  shows while now is inside [startAt, endAt) — either end may be empty — even with the switch off; the switch still
  forces it on. `endAt` also sets Retry-After and a plain "Back at … UTC" line on the holding page (no script: the CSP
  allows none). One rule decides everywhere (`maintenanceActive`: `src/maintenance.ts` here, the starter's
  `utils/maintenance.ts` and `utils/rewarm.ts` keep copies, kept in step by `test/coming-soon-schedule.test.ts`): the
  middleware, the preview link, the cache refill and the paused checks. Cached pages never reach the middleware, so the
  5-minute cron tick compares the active state with the one it last applied (KV key `maintenance:applied`) and purges
  the page cache once at each start and end: a scheduled switch takes up to 5 minutes. Saving the form purges at once
  when it changes the state now. Overview, Settings and the dashboard widget show "Coming-soon scheduled …".
- **Lab score (PageSpeed)** (Speed tab, `src/checks/lab.ts`, `src/lab.ts`): every 7 days (from 09:00 UTC; a failed
  attempt retries a day later) Google PageSpeed Insights v5 tests the production home page, **mobile and desktop**,
  categories performance, accessibility, best practices and SEO. Stored per run (KV key `lab`, 26 weeks, at most 80
  runs, ~25 KB): date, strategy, the four scores (0–100), FCP, LCP, TBT, CLS, Speed Index and the LCP element's HTML
  (160 characters). The tab shows the latest scores and metrics, a chart of the performance scores, the last 8 tests
  with ▲ / ▼ changes, a plain-words line on lab vs real-visitor data, and setup steps while no key is set. **Run
  PageSpeed test now** (admins, at most every 10 minutes) only stores a request (KV `lab:request`); the next cron tick
  runs it, because a Lighthouse run takes 10–60 s — longer than an admin request's `waitUntil` (30 s) allows, while a
  scheduled event may wait up to 15 minutes. The test runs after the checks in the same tick (own lock `lab:lock`;
  both calls in parallel, 90 s limit each; cron hook timeout 150 s). Key: `PAGESPEED_API_KEY`, else `CRUX_API_KEY`
  (one Google Cloud key can have both APIs enabled). Without a key nothing is called: Google's anonymous quota is
  effectively zero (HTTP 429). Production only (a staging Worker tests nothing); runs before go-live are kept, marked
  "old site". Alert: mobile performance down 15 points or more from the previous run (issue `lab-drop`).
- **Page cache refill** (Speed tab; kit.config `performance.rewarmMinutes`, option `rewarm`): on/off and every 15, 30 or
  60 minutes (KV key `rewarm`, absent = on at the kit's interval), the last run (KV key `rewarm:last`: pages checked,
  built again, failed, each page's state) and **Refresh all pages now** (purges the page cache and leaves `rewarm:request`;
  at most every 5 minutes). The generated site's Worker cron does the refill (starter `src/utils/rewarm.ts`) and reads
  these rows with D1; it never runs while coming-soon mode is on, and only once the site is live on its own domain.
- **Security tab: blocked-content reports (CSP violations)**. The kit's starter puts `report-uri` and `report-to`
  (with a `Reporting-Endpoints` header) into the public Content-Security-Policy — never into signed-in editors' — when
  site.config.json has `cspReport` (kit.config `health.cspReports`, default on; option `cspReports`). Browsers POST to
  the public route **`/_emdash/api/plugins/site-health/csp`** (both formats: legacy `application/csp-report` and the
  Reporting API's `application/reports+json`; read as text, at most 8 KB, always 204). Kept per source (directive +
  blocked origin, KV key `csp`): the effective directive, the blocked source reduced to its origin (or inline / eval),
  up to 5 page **paths** (no query, no fragment), the source file's origin, count, first and last seen; per-month
  counts for the report. Never IPs, user agents, full URLs, referrers or code samples. Dropped: browser extensions
  (`chrome-` / `moz-` / `safari-` / `safari-web-` / `ms-browser-extension:` as blocked source or source file), `about:`,
  `data:`, documents on another origin, requests carrying an admin session cookie. Abuse limits: 8 KB body, 20 reports
  per request, 30 requests a minute per isolate, 50 sources kept (oldest dropped), one KV read and at most one
  compare-and-set write per request. The 5-minute tick turns each **new** source into an alert (scripts — `script-src`,
  `-elem`, `-attr`, `worker-src` — as a problem, issue `csp-script`; anything else as a note, `csp-other`), through the
  normal alert limits; reports seen before go-live or on staging never alert later. The tab shows each source in plain
  words ("A script from cdn.example.com was blocked on /pricing/ and 2 other pages"), **Clear the list**, and a switch:
  off = reports are dropped and nothing alerts (the CSP keeps naming the endpoint until a rebuild with
  `cspReports: false` — the middleware reads no setting per request). The monthly report gets one line with the count.
- **Security headers** (check `security`, hourly, from that tick's home page through `SELF`): HSTS (≥ 6 months), CSP
  present and naming the report endpoint, `X-Content-Type-Options: nosniff`, Referrer-Policy, frame protection
  (`frame-ancestors` or `X-Frame-Options`), Permissions-Policy — a table on the Security tab, with the certificate
  check's result below it. A missing CSP is a problem (alerted like other failing checks); anything else is Attention.
  Headers added by Cloudflare zone rules outside the Worker are not seen.
- **Plugins → Site health**: overall status (Healthy / Attention / Down), each check with its last run and 14-day trend,
  **Run checks now** (single flight, at most every 2 minutes), incidents, broken links, speed, reports, settings; a
  dashboard widget with the overall status.
- **Alerts** by email: down / back up, page errors, new broken links, search engines kept out, form email failing, mail
  DNS changed, certificate, analytics tags missing, security policy missing, a new blocked script (CSP report), the weekly PageSpeed mobile score dropping by 15+ points. One email per issue per day, at most six a day, only once the site is
  live (`live` option), never from a staging Worker, switchable on the page.
- **Monthly report** on the 1st (from 08:00 UTC, catch-up until the 3rd): branded HTML email (logo, colours, footer) to
  the report recipients plus the alert recipients — availability and incidents, speed and Core Web Vitals, visits,
  top pages and referrers (Cloudflare Web Analytics, `CF_ANALYTICS_TOKEN`), form message counts, pages published and
  updated, broken links found / fixed / open, average SEO score (the SEO suite's analysis). Kept 12 months under
  **Reports**; **Download** gives a print-friendly HTML file (print → Save as PDF) through a one-time link.
- **What to improve this month** (0.4; `src/improve.ts`), at the top of the report and on the **Overview**: at most six
  plain sentences, most important first, each with how many pages / addresses / pictures it concerns (three named),
  and a link to the admin page that fixes it. Ranked: backups failing (Backups) → pictures that no longer exist
  (Media) → slow real-visitor speed, poor before needs-improvement (Speed tab) → missing addresses asked for 3+ times
  a week without a redirect (Missing pages tab) → form messages down by half or more from a month with 5+ (Form
  messages; the two monthly **counts** only, no message is read) → pages with too little text, pages without a meta
  description (SEO) → pictures without a description (Media, else SEO) → oversized pictures (Media) → focus keyword
  missing (SEO). Built from what is already stored — no request, no analysis: this plugin's checks, the Media
  Assistant's scan counts (`plugin:media-assistant:summary`) and the SEO suite's page summary
  (`plugin:site-seo:summary`, written when its dashboard opens; the monthly report calculates and keeps its own,
  the newer one wins). Plugins a site does not run (`seo`, `media`, `backups`, `formsOutbox` options) are skipped.
  Nothing to do: one positive line. Reports made before 0.4 show no section.

## Register

```js
// astro.config.mjs (the kit's scaffold writes this)
import { healthPlugin } from "@wp2emdash/health";
emdash({ plugins: [healthPlugin({ productionUrl: "https://example.com", siteName: "Example", live: true, alertsTo: ["team@agency.example"], reportTo: ["owner@example.com"], brand: { footer: "Prepared by Example Agency" } })] });
```

Needs, in `wrangler.jsonc`: a cron trigger (the kit's starter has `*/5 * * * *` and runs EmDash's scheduled handler)
and a service binding of the Worker to itself, `"services": [{ "binding": "SELF", "service": "<worker name>" }]` —
the checks request the site through it (a Worker's fetch to its own hostname would skip the Worker). Imports
`@wp2emdash/forms` (outbox, email delivery) and `@wp2emdash/seo` (analytics settings, site checks, visits, SEO analysis):
link all three packages.

## Email

The same path as the website's forms: `EMAIL_PROVIDER` + Worker secret `EMAIL_API_KEY`, sender `FORM_FROM`
(Brevo, Resend, Postmark, SendGrid, Mailgun), or `EMAIL_PROVIDER=emdash` → EmDash's Settings → Email (`ctx.email`,
capability `email:send`). **Send a test email** on the Settings tab checks it.

## Optional Worker secrets

| Secret | For | Token / key |
|---|---|---|
| `CRUX_API_KEY` | Real-visitor Core Web Vitals | Google Cloud API key with the Chrome UX Report API enabled (free) |
| `PAGESPEED_API_KEY` | Weekly lab score (PageSpeed) | Google Cloud API key with the PageSpeed Insights API enabled (free). Optional even for the lab score: `CRUX_API_KEY` is used when this is not set — enable the PageSpeed Insights API on that key's project |
| `CF_ZONE_READ_TOKEN` | Certificate expiry | Cloudflare custom token: Zone → Zone → Read, Zone → SSL and Certificates → Read, this zone only |
| `CF_ANALYTICS_TOKEN` | Visits in the report | The SEO suite's token (Account Analytics: Read) |

Without them the page says what is missing; nothing fails.

## Privacy and security

No form contents and no personal data in state, logs, alerts or reports (counts, page paths and titles, times and
statuses only). Requests leave the site only for Cloudflare (DNS over HTTPS, API), Google (CrUX, PageSpeed Insights) and — weekly, HEAD
only, `externalLinks: false` to stop it — hosts the site already links to. Tokens live only in Worker secrets and
Authorization headers. Public routes: `report` (one-time token, two minutes), `heartbeat` (time of the last run, so
the kit's verify can see the checks are alive) and `csp` (POST only, violation reports reduced as above, 204). Everything else is admins only (`plugins:manage`, role checked again).

## Limits (by design)

The Worker cannot observe itself from outside: a deployment that is down entirely cannot report itself (its cron does
not run either) — the kit's verify (`health-plugin`: last run within 30 minutes on live sites) and any outside monitor
cover that. Requests through `SELF` skip the edge, so cached response times and `cf-cache-status` are not measured
here (verify measures them). Facts and measurements: the kit's `docs/spikes/health-findings.md`.
