# Outside-in monitor — verified facts, design and limits (2026-11-22)

Why: every delivered site's Site health (uptime, alerts) runs inside the site's own Worker. If that Worker, the
Cloudflare account, DNS or the domain breaks, the site is down and nothing tells the agency. `packages/monitor` +
`wp2emdash monitor init|build` generate ONE Worker the agency runs for all its sites. Nothing was deployed, no
Cloudflare resource was created, no client domain was requested. Live requests below were read-only GETs to example
domains (example.com, cloudflare.com).

## Scheduler: Worker cron, not GitHub Actions

- **Cloudflare Cron Triggers** (developers.cloudflare.com/workers/configuration/cron-triggers, read 2026-11-22): UTC;
  `triggers.crons` in wrangler.jsonc; changes take up to 15 minutes to propagate; local test via
  `/cdn-cgi/local/scheduled` (`cron`, `time` query parameters, `format=json`). `ScheduledController.scheduledTime` is
  the scheduled time in ms (used for the expiry slot, so a late start does not shift the schedule).
- **GitHub Actions `schedule`** (docs.github.com, events-that-trigger-workflows): shortest interval 5 minutes; "can be
  delayed during periods of high loads"; "some queued jobs may be dropped"; in a public repository scheduled workflows
  are disabled after 60 days without repository activity. → Not used: an uptime monitor that can be 10–30 minutes late,
  skip runs, or silently switch itself off is the wrong tool.

## Workers limits that shape the design (developers.cloudflare.com/workers/platform/limits, 2026-11-22)

| | Free | Paid |
|---|---|---|
| Subrequests per invocation | 50 | 10,000 |
| CPU per Cron Trigger | 10 ms | 30 s default (5 min max) |
| Cron Triggers per account | 5 | 1,000 |
| Simultaneous open connections | 6 | 6 |
| Cron handler duration | 15 min | 15 min |

- A tick costs ≈ 2 subrequests per site (home page + one same-site redirect, e.g. apex → www), ~2–4 for the expiry
  lookups due in that slot, 1 per alert channel when something happened, 1 for the optional heartbeat ping.
  `subrequestEstimate(n) = 2n + 4·ceil(n/288) + 4` → **Free fits ≈ 20 sites**; build warns above 50 (`plan: "free"`).
- 6 simultaneous connections: probes run with `Promise.all`; the runtime queues the rest. Worst case
  ceil(n/6) × timeout (10 s) — 50 sites ≈ 90 s, far inside 15 min.
- Free CPU (10 ms) covers a handful of sites; each check reads ≤ 256 KB and runs a few regexes. More than ~10 sites:
  Workers Paid recommended (docs/monitor.md).

## Reaching sites in the same account: `global_fetch_strictly_public`

compatibility-flags docs: the flag makes global `fetch()` "strictly route requests as if they were made on the public
Internet" — a request to a zone/Worker of the same account goes back through Cloudflare's front door instead of
straight to the origin (skipping Workers on that route). The fetch runtime docs: Worker-to-Worker fetch is possible
"with Service bindings" or this flag. The monitor sets it, so a monitor that shares an account with sites still sees
exactly what a visitor sees (routes, Workers, WAF, cache).

## KV (developers.cloudflare.com/kv/platform/limits, 2026-11-22)

Free: 100,000 reads/day, 1,000 writes/day, 1 write/second to the same key, 25 MiB values, 1,000 operations per
invocation. Design: the whole state is **one key** (`state`), read once per tick and written **at most once per tick**,
only when it changed or for the daily heartbeat.

- Reads/day: 288 + status page views.
- Writes/day, hard bound: 288 (one per tick). Typical: 1 heartbeat + 2 per blip (suspect, up) + 3 per incident
  (suspect, down, up) + expiry changes (a renewed certificate, a warning sent — the alert log lives in the same value).
  A quiet day for 20 sites ≈ 1–3 writes.
- Repeated failures while down write nothing (the state machine does not change); lookup errors are coarse ("HTTP 503",
  "rate limited") and the last known date is kept, so a flaky lookup service does not churn writes.
- KV is eventually consistent (up to ~60 s across locations); ticks are 5 minutes apart, so the next tick reads the
  previous write.

## Certificate expiry: Cert Spotter (crt.sh as a parsed fallback shape)

A Worker's fetch exposes no peer certificate. Certificate Transparency instead:

- `GET https://crt.sh/?q=<domain>&output=json[&exclude=expired&deduplicate=Y]` → **HTTP 502 (nginx) to every request**
  on 2026-11-22 (cloudflare.com, example.com, workers.cloudflare.com, with and without parameters). Not called;
  `parseCrtSh` keeps its documented shape (`[{ name_value: "a\nb", not_after: "2026-12-10T12:00:00" (UTC, no zone),
  … }]`) for a future fallback.
- `GET https://api.certspotter.com/v1/issuances?domain=example.com&expand=dns_names` → 200 `application/json`, an
  array of **unexpired** issuances: `{ id, tbs_sha256, cert_sha256, dns_names[] (with expand), pubkey_sha256,
  not_before, not_after ("2026-12-21T09:32:54Z"), revoked }`. cloudflare.com with `match_wildcards=true`: 14 issuances,
  latest not_after 2027-02-14. SSLMate's reference: `include_subdomains`, `match_wildcards` (default false), `after`
  for paging, expired certificates are not returned, an unstated hourly quota for unauthenticated use (production use
  wants an API key → optional `CERTSPOTTER_API_KEY` secret, `Authorization: Bearer`).
- Rule: latest `not_after` among non-revoked certificates whose names cover the host (exact or `*.parent`). When a
  renewal has been issued it is later, so ≤ 14 days means no renewal yet. This does not prove which certificate the edge
  serves; an expired certificate that is actually served makes `fetch()` fail the TLS handshake, so the uptime check
  opens an incident anyway — CT is the early warning.

## Domain expiry: RDAP via rdap.org

- `GET https://rdap.org/domain/cloudflare.com` → **302** to `https://rdap.verisign.com/com/v1/domain/cloudflare.com`
  (`cache-control: public, max-age=28800`), then 200 `application/rdap+json`: `{ objectClassName: "domain",
  ldhName: "CLOUDFLARE.COM", events: [{ eventAction: "registration", … }, { eventAction: "expiration", eventDate:
  "2033-02-17T22:07:54Z" }, { eventAction: "last changed", … }, { eventAction: "last update of RDAP database", … }],
  status, nameservers, entities, … }`. The monitor follows the redirect (`redirect: "follow"`).
- `rdap.org/domain/denic.de` → 404 `application/rdap+json` (.de has no RDAP); an unregistered .com → 404. Shown as
  "no RDAP for this domain" on the status page, never alerted.
- Registrable domain: last two labels, three for common second-level suffixes (co.uk, com.au, …); `domain` per extra
  URL overrides it. No public-suffix list is bundled (size; the override covers the rest).
- Run in local workerd (Wrangler 4.152.0 `wrangler dev`, scratch copy of a generated project with a synthetic site
  list, `/cdn-cgi/local/scheduled?time=<12:00 UTC>` = example.com's slot): status page showed certificate
  2026-12-25 (33 d) and domain 2027-08-13 (263 d) for example.com — both live lookups parsed inside the runtime.

## Generated project checked with Wrangler

- `wrangler deploy --dry-run --outdir` (Wrangler 4.152.0, the newest installed locally; the kit pins 4.163.0 in
  `STACK`): bundles `src/worker.ts` with the copied `deliver.ts` — 35.9 KiB, gzip 11.8 KiB; binding `env.MONITOR_KV`.
- `wrangler dev`: 4.152.0's workerd supports compatibility dates up to 2026-10-26, so the local run used
  `--compatibility-date 2026-10-20`; generated projects use a week back (like scaffold) and keep it on rebuild.
  Without a token the page answered 404 "Not found"; `/cdn-cgi/local/scheduled` → `{"outcome":"ok"}`, log
  `{"monitor":{"checked":2,"failing":1,…,"wrote":true}}`; with `?token=` the status page listed both rows.

## Separate account (trade-off)

- Same account as the sites: one login, but an account-level problem (suspended account, billing, a revoked token, an
  accidental `wrangler delete`, account-wide WAF rule) silences the monitor exactly when the sites fail.
- Separate free account (recommended, `accountId` in monitor.config.json → `account_id`): survives anything that
  happens to the sites' accounts and zones; the monitor uses `*.workers.dev`, so it depends on no client zone or DNS.
- Neither covers a Cloudflare-wide outage. For that: the optional `HEARTBEAT_URL` (a dead-man's switch at a provider
  outside Cloudflare, e.g. healthchecks.io) is pinged every tick and alerts when pings stop.
