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
  listed. Its own tab and a dashboard hint; never an alert.
- **Coming-soon mode** (Settings tab): stored as the KV key `maintenance` (EmDash `options` row
  `plugin:site-health:maintenance`), which the kit's starter middleware reads to serve a branded 503 holding page
  (Retry-After, noindex, never cached) to visitors while signed-in people see the site. While it is on, uptime,
  search-engine, analytics and link checks pause. Never switched on by the migration. **Preview link**
  (`?preview=<key>`, 32 random URL-safe characters kept in the same row): people without an admin account see the site
  for 7 days in that browser (cookie `site-preview`, never cached); "New link" replaces the key and ends every old link.
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
  DNS changed, certificate, analytics tags missing, security policy missing, a new blocked script (CSP report). One email per issue per day, at most six a day, only once the site is
  live (`live` option), never from a staging Worker, switchable on the page.
- **Monthly report** on the 1st (from 08:00 UTC, catch-up until the 3rd): branded HTML email (logo, colours, footer) to
  the report recipients plus the alert recipients — availability and incidents, speed and Core Web Vitals, visits,
  top pages and referrers (Cloudflare Web Analytics, `CF_ANALYTICS_TOKEN`), form message counts, pages published and
  updated, broken links found / fixed / open, average SEO score (the SEO suite's analysis). Kept 12 months under
  **Reports**; **Download** gives a print-friendly HTML file (print → Save as PDF) through a one-time link.

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
| `CF_ZONE_READ_TOKEN` | Certificate expiry | Cloudflare custom token: Zone → Zone → Read, Zone → SSL and Certificates → Read, this zone only |
| `CF_ANALYTICS_TOKEN` | Visits in the report | The SEO suite's token (Account Analytics: Read) |

Without them the page says what is missing; nothing fails.

## Privacy and security

No form contents and no personal data in state, logs, alerts or reports (counts, page paths and titles, times and
statuses only). Requests leave the site only for Cloudflare (DNS over HTTPS, API), Google (CrUX) and — weekly, HEAD
only, `externalLinks: false` to stop it — hosts the site already links to. Tokens live only in Worker secrets and
Authorization headers. Public routes: `report` (one-time token, two minutes), `heartbeat` (time of the last run, so
the kit's verify can see the checks are alive) and `csp` (POST only, violation reports reduced as above, 204). Everything else is admins only (`plugins:manage`, role checked again).

## Limits (by design)

The Worker cannot observe itself from outside: a deployment that is down entirely cannot report itself (its cron does
not run either) — the kit's verify (`health-plugin`: last run within 30 minutes on live sites) and any outside monitor
cover that. Requests through `SELF` skip the edge, so cached response times and `cf-cache-status` are not measured
here (verify measures them). Facts and measurements: the kit's `docs/spikes/health-findings.md`.
