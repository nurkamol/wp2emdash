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
- **Plugins → Site health**: overall status (Healthy / Attention / Down), each check with its last run and 14-day trend,
  **Run checks now** (single flight, at most every 2 minutes), incidents, broken links, speed, reports, settings; a
  dashboard widget with the overall status.
- **Alerts** by email: down / back up, page errors, new broken links, search engines kept out, form email failing, mail
  DNS changed, certificate, analytics tags missing. One email per issue per day, at most six a day, only once the site is
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
Authorization headers. Public routes: `report` (one-time token, two minutes) and `heartbeat` (time of the last run, so
the kit's verify can see the checks are alive). Everything else is admins only (`plugins:manage`, role checked again).

## Limits (by design)

The Worker cannot observe itself from outside: a deployment that is down entirely cannot report itself (its cron does
not run either) — the kit's verify (`health-plugin`: last run within 30 minutes on live sites) and any outside monitor
cover that. Requests through `SELF` skip the edge, so cached response times and `cf-cache-status` are not measured
here (verify measures them). Facts and measurements: the kit's `docs/spikes/health-findings.md`.
