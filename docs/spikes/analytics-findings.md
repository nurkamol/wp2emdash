# Analytics in the SEO & Analytics suite — verified facts (2026-11-20)

Checked against the installed **EmDash 1.5.0, @emdash-cms/blocks 1.5.0, @emdash-cms/admin 1.5.0, Astro 7.4.12,
@astrojs/cloudflare 14.4.8, @cloudflare/workers-types 5.20261116.1** (read in a kit site project's `node_modules`,
never modified), Cloudflare/Google/Microsoft/Hotjar documentation, and a throwaway build of a generated project
(scratch copy, `pnpm install --offline` + `astro check` + `astro build`: 0 errors, build complete). Nothing was
deployed; no live site, DNS or production data was touched.

## Storage the site can read cheaply

- Plugin `ctx.kv` is the `options` table in D1: `createKVAccess(optionsRepo, plugin.id)` prefixes keys with
  `plugin:<pluginId>:` and `OptionsRepository.get` reads `SELECT value FROM options WHERE name = ?` (JSON value).
  (`emdash/src/plugins/context.ts`, `src/database/repositories/options.ts`, migration `001_initial` creates `options`
  with `name` as key.) The tracker settings are `ctx.kv` key `analytics` of the SEO plugin → row
  **`plugin:site-seo:analytics`**.
- The starter reads that row with the Worker's `DB` binding (`packages/seo/src/analytics/store.ts`,
  `readStoredAnalytics`) — the same direct-D1 pattern the middleware already uses for legacy upload paths. One
  primary-key read per **uncached** page render; the Analytics component and the middleware's CSP share one promise on
  `Astro.locals`. Cache hits never run the Worker (docs/spikes/performance-findings.md).
- Row missing (nobody opened the page yet) → the IDs carried over from WordPress (site.config.json `analytics`, the
  same list the plugin stores on first load). Row unreadable → nothing is loaded (a removed tracker must never come
  back through a failed read).
- No EmDash public API reads plugin options from site code in 1.5 (`locals` carries only `emdash` handlers and `user`).
  If EmDash changes the `plugin:<id>:<key>` naming, `OPTION_NAME` must follow (a test pins it).

## Purge on save

- EmDash purges through Astro's `cache.invalidate({ tags })` (`emdash/src/cache/route-cache.ts`). The Cloudflare cache
  provider's `invalidate()` is `(await import("cloudflare:workers")).cache.purge({ tags })`
  (`@astrojs/cloudflare/dist/cache/provider.js`). Plugin route contexts do **not** get Astro's `cache` (RouteContext:
  input, request, requestMeta, ui, user + PluginContext), so the plugin calls `cache.purge` from `cloudflare:workers`
  directly — the same call. workers-types: `CacheContext.purge(options: { tags?, pathPrefixes?, purgeEverything? }):
  Promise<{ success, errors }>`; a `success: false` result is reported as "could not refresh".
- Tags purged: `wp2emdash:analytics` (every page sets it next to its chrome hints in `utils/chrome.ts`; Astro's
  `cache.set()` accumulates tags — `astro/dist/core/cache/runtime/cache.js` adds to a Set) and `emdash:settings`
  (every page already carries it via `getSiteSettingsWithCacheHint`; settings purges were measured visible in 3.2 s on
  staging). One purge call per save (Cloudflare purge limit 5/min, burst 25).
- Not measured on staging in this change: the end-to-end "save → page updated" time. Expected equal to the settings
  purge measured earlier (same tag, same mechanism). Unit tests cover the purge call and its failure path.

## Block Kit (admin UI)

- Every view (Analytics tab for admins and editors, add/edit forms, Visits tab in data/setup/error states, Visits
  widget, editor-panel line, the whole dashboard with analytics) passes `validateBlocks` of
  `@emdash-cms/blocks@1.5.0` (run in a scratch script against the installed package).
- Table cells with `format: "element"` take button / link / menu (`TABLE_CELL_ELEMENT_TYPES`). `form_submit` carries
  the form's `block_id` (renderer `submit()`), used for the edited tracker's id (`an-edit:<id>`).
- Dashboard widgets: the admin sends `page_load` with `page: "widget:<widgetId>"` to the plugin's `admin` route
  (`@emdash-cms/admin` dist, "Renders a plugin's dashboard widget"), so one route serves both widgets. Widget sizes:
  `"full" | "half" | "third"`. Nav icon names resolve through `PLUGIN_NAV_ICON_MAP` (unknown → default icon).

## CSP host table (`packages/seo/src/analytics/csp.ts`)

| Service | script-src | connect-src | frame-src | style/font |
|---|---|---|---|---|
| GA4 (G-), Tag Manager (GTM-) | www.googletagmanager.com | www.googletagmanager.com, *.googletagmanager.com, *.google-analytics.com, *.analytics.google.com, www.google.com | www.googletagmanager.com | — |
| Google tag (GT-) | as GA4 | GA4 + *.g.doubleclick.net, pagead2.googlesyndication.com (Google's "Ads-ready" set) | as GA4 | — |
| Google Ads (AW-) | www.googletagmanager.com, www.googleadservices.com, www.google.com | www.googletagmanager.com, www.googleadservices.com, googleads.g.doubleclick.net, pagead2.googlesyndication.com, www.google.com, ad.doubleclick.net | www.googletagmanager.com | — |
| Cloudflare Web Analytics (always) | static.cloudflareinsights.com | cloudflareinsights.com | — | — |
| Meta Pixel | connect.facebook.net | www.facebook.com, connect.facebook.net | — | — |
| Microsoft Clarity | *.clarity.ms | *.clarity.ms, c.bing.com | — | — |
| Hotjar | static.hotjar.com, script.hotjar.com | *.hotjar.com, *.hotjar.io, wss://*.hotjar.com | *.hotjar.com | *.hotjar.com |
| Universal Analytics (UA-) | retired: never loaded, no sources | | | |

Sources: Google — developers.google.com/tag-platform/security/guides/csp (script hosts are listed for
`script-src-elem`; the starter uses `script-src`, which covers elements). Google lists `*.google.<TLD>` country domains
for Ads; they cannot be enumerated, so only `www.google.com` is allowed — country-domain requests would be reported
by verify's CSP check. Clarity — learn.microsoft.com/clarity/setup-and-installation/clarity-csp (`*.clarity.ms`,
`c.bing.com`; a–z load-balanced subdomains). Hotjar — help.hotjar.com "Content Security Policies" (minimum script
hosts; its `'unsafe-inline'` is for the inline snippet, which the loader does not use). Meta publishes no CSP page:
hosts are those of its snippet (connect.facebook.net for fbevents.js and config, www.facebook.com/tr for events),
matching vendor guides. `img-src` is already `https:` in the starter.

## Cloudflare Web Analytics (Visits)

- GraphQL: `POST https://api.cloudflare.com/client/v4/graphql`, `viewer { accounts(filter: { accountTag }) {
  rumPageloadEventsAdaptiveGroups(limit, orderBy: [count_DESC | date_ASC], filter: { datetime_geq, datetime_lt,
  siteTag | requestHost }) { count sum { visits } dimensions { date | requestPath | refererHost } } } }`. Field names
  checked against two independent working public implementations (an account-level query filtered by `requestHost`,
  and one filtered by `siteTag` with `total`/`byDate`/`byReferer` aliases); Cloudflare's dataset list puts
  `rumPageloadEventsAdaptiveGroups` under Web Analytics (RUM). **Not run against the live API in this change**:
  schema introspection with the kit token was not permitted in this session. Token: custom, Account → Account
  Analytics → Read (the widget's setup text says so).
- One query (4 aliases: total, 10 days, 100 pages, 10 referrers) feeds the dashboard widget, the Visits tab and the
  editor panel's per-page views; cached 15 minutes in plugin KV (numbers, paths and referrer hosts only).
- Site lookup at scaffold: `GET /accounts/{account_id}/rum/site_info/list` (Cloudflare API reference: permission
  "Account Settings Read", which build token A has; fields `site_tag`, `site_token`, `auto_install`,
  `ruleset.zone_name`, `rules[].host`). Used read-only to prefill the site tag and to tell a zone-injected beacon
  (`auto_install: true` — keeps being injected after the move, so it is not loaded again) from one the old site added
  itself. **Not run live in this change** (no network calls to Cloudflare were made); unit-tested with a mocked fetch.

## Loader, events, consent

- `public/scripts/site-analytics.js` ports each vendor's standard snippet to external-file form (Google gtag/GTM,
  Cloudflare beacon, Meta base code without the `<noscript>` image, Clarity, Hotjar `hjid`/`hjsv: 6`), re-validates
  every ID, and has no inline code. Tested in a Node `vm` with a fake DOM.
- Conversion events: `window.siteAnalytics.track(kind, label)`; kinds `lead` (GA4 `generate_lead`, Meta `Lead`),
  `contact` (GA4 `contact`, Meta `Contact`), `booking` (GA4 `schedule`, Meta `Schedule`), `outbound` (GA4 `click` with
  `outbound: true`; off by default — GA4 enhanced measurement already counts outbound clicks). Labels reduced to
  `[a-z0-9._-]` (form id, "phone"/"email", a host). Google Ads conversions need a conversion label per action; not
  in scope (events reach AW- IDs as plain events).
- Consent mode (off by default): Google `consent default` all denied before config (Consent Mode v2 parameter names),
  Meta/Clarity/Hotjar start only after `siteAnalytics.grantConsent()`; Cloudflare's beacon is cookieless and always
  starts. No banner ships; region-specific defaults are out of scope.

## Unverified / open

- End-to-end on staging: save in the admin → purge → page shows the new list (expected seconds; not measured here).
- Visits GraphQL query and the RUM site lookup against Cloudflare's live API (mocked in tests only).
- Each vendor's script actually loading under the new CSP in a real browser for Meta, Clarity and Hotjar (verify's
  `analytics-runtime` check now expects fbevents.js / clarity.ms tag / hotjar script and reports CSP violations —
  run it after go-live).
