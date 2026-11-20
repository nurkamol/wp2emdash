# Privacy & Consent — findings (2026-11-20)

`@wp2emdash/consent` 0.1: the built-in cookie banner, its admin page and how it drives the SEO & Analytics loader and
the site widgets. What was checked, against what, and what is not verified yet.

## Sources checked

| Fact | Source | Used for |
|---|---|---|
| Consent Mode v2 has four storage/consent types: `ad_storage`, `analytics_storage`, `ad_user_data`, `ad_personalization`. `gtag('consent','default',…)` must run before any command that sends measurement (`config`, `event`); `gtag('consent','update',…)` on the choice. `wait_for_update` exists for asynchronous banners. | developers.google.com/tag-platform/security/guides/consent (read 2026-11-20) | `site-analytics.js`: default all denied first in the dataLayer, `update` from the choice, `config` only after. |
| Basic vs advanced consent mode: with *advanced*, Google tags load before consent and send cookieless pings; with *basic*, tags are not loaded until consent. | Same page (links to the concepts page) | With the built-in banner the loader uses **basic** behaviour: gtag.js / gtm.js are not requested until analytics or marketing is allowed, so an opt-in visitor's browser sends nothing to Google before choosing. (The older `consent: true` switch for third-party banners keeps advanced behaviour, unchanged.) |
| Meta Pixel: `fbq('consent','revoke')` before `init` (on every page), `fbq('consent','grant')` once the visitor agrees. | developers.facebook.com/docs/meta-pixel/implementation/gdpr (read 2026-11-20) | fbevents.js is not loaded at all without marketing consent; when it is, `grant` is queued ahead of `init`; withdrawing sends `revoke`. |
| Microsoft Clarity ConsentV2: `clarity('consentv2', { ad_Storage: "granted"\|"denied", analytics_Storage: "granted"\|"denied" })`; `clarity('consent', false)` erases its cookies and ends the session. Clarity enforces consent signals for EEA/UK/CH traffic from 2025-10-31. | learn.microsoft.com/clarity/setup-and-installation/clarity-consent-api-v2 (updated 2025-12-05, read 2026-11-20) | Clarity loads only with analytics consent, then gets `consentv2`; withdrawal sends `consent false`. |
| Hotjar has no consent API. | Hotjar help centre (no consent call documented) | Hotjar loads only with analytics consent; withdrawing while it runs reloads the page without it. |
| Global Privacy Control: `navigator.globalPrivacyControl === true` in the browser (`Sec-GPC: 1` on requests). Treated as an opt-out of sale/sharing (CCPA/CPRA regulations; Colorado and others). | globalprivacycontrol.org spec | The banner keeps **marketing** off whenever GPC is on (checkbox locked, a note says why); analytics follow the mode. Read in the browser — reading `Sec-GPC` on the server would make the HTML differ per visitor. |
| `Astro.request.cf` is the Astro 6+ way to Cloudflare's request properties (`Astro.locals.runtime.cf` was removed). | `@astrojs/cloudflare` 14.1.7 source, `dist/utils/cf-helpers.js` (the getter throws "Use 'Astro.request.cf' instead") | `/_consent/region` reads `request.cf.country` / `request.cf.regionCode`, with the `CF-IPCountry` header as a fallback. |
| EmDash public plugin routes: POST allowed; the CSRF check passes with `X-EmDash-Request: 1` or a same-origin `Origin`; `request: { body: "json", maxBytes }` bounds the body; public responses get `Cache-Control: private, no-store` unless `cacheControl` is set (GET only). | emdash 1.5.0 source: `src/plugins/http-route-dispatch.ts`, `src/api/csrf.ts`, `src/plugins/route-wire.ts` | The consent log route (`POST /_emdash/api/plugins/privacy-consent/log`, 64-byte JSON body). |

## Region detection without breaking the route cache

Pages are rendered once and served from the route cache to everyone, so nothing in the HTML can depend on the
visitor. Design:

1. The HTML carries the same `<meta name="site-consent">` for everyone: mode, wording, categories, revision.
2. The visitor's choice lives only in their browser (`localStorage["site-consent"]` + first-party cookie
   `site_consent=1.<revision>.<flags>.<time>`, no identifier, 180 days). The server never reads it.
3. Mode **auto**, no stored choice: the banner script asks `GET /_consent/region` (`credentials: "omit"`,
   `cache: "no-store"`). The middleware answers before anything else — before host redirects, before the route cache
   (`context.cache.set(false)`) — with `{"strict": true|false}` and `Cache-Control: no-store, private`. The answer is
   kept in `sessionStorage` for the visit, so it is asked once per visit and never once a choice exists.
4. While the answer is pending, the state is "pending": nothing that stores data starts and no banner shows; a failed
   request counts as opt-in (fail closed).

Rejected alternatives: a response header set by middleware on the HTML (cached HTML would carry the first visitor's
country to everyone); `Vary: CF-IPCountry` (Cloudflare's cache ignores most `Vary` values, and per-country copies would
multiply cache entries); Google's `region` parameter on `consent default` (covers Google only, not Meta/Clarity/Hotjar
or the banner itself).

Opt-in regions (`packages/consent/src/region.ts`): EU-27, Iceland, Liechtenstein, Norway, United Kingdom, Switzerland,
and Québec (`CA` + `regionCode` `QC`, Law 25). Unknown, `XX` and `T1` (Tor) get opt-in.

## Modes and the default

| Mode | Before a choice | Banner |
|---|---|---|
| off | as before the plugin (trackers load; a kept third-party tool handles consent) | none |
| notice | analytics, marketing (unless GPC) and preferences on | information banner, opt-out |
| opt-in | nothing that stores data; Cloudflare Web Analytics (cookieless) only | Accept all / Reject non-essential / Choose |
| auto (default) | opt-in rules for EU/EEA/UK/CH/Québec and unknown, notice elsewhere | as per region |

**Default "auto"** for new sites: the clients are mostly US small businesses, for whom it is a light notice that does
not block their analytics, while EU/UK visitors — who exist on almost every site — get the opt-in their law requires,
without anyone having to decide per site. It falls back to opt-in when unsure. Exceptions prefilled by the migration:
a consent service kept as a site widget (CookieYes, Cookiebot, Termly, iubenda) → **off** (one banner, not two); a
WordPress consent plugin with a known mode (Complianz opt-in/opt-out, Borlabs and Real Cookie Banner → opt-in, Cookie
Notice without a reject button → notice) → that mode, with the old banner's wording when it is in the saved HTML.
`kit.config.ts` `consent: { mode }` wins; `consent: false` removes it.

## Categories

| Category | Services | Google Consent Mode |
|---|---|---|
| Necessary (always on) | this choice; Cloudflare Web Analytics (cookieless) | — |
| Analytics | Google Analytics 4 / Google tag, Tag Manager, Microsoft Clarity, Hotjar | `analytics_storage` |
| Marketing | Google Ads, Meta Pixel | `ad_storage`, `ad_user_data`, `ad_personalization` |
| Preferences | chat (Tawk.to, Crisp, Intercom, HubSpot chat), review widgets (Elfsight, Trustindex) | — |

Videos, maps and booking widgets inside pages are **not** gated by the banner (they are page content). Listed as a known
limit; a click-to-load placeholder for embeds is a possible follow-up.

## Withdrawal

Changing the choice sends the consent APIs (`update` denied, `fbq revoke`, `clarity consent false`) and deletes the
trackers' first-party cookies on the site's domains (`_ga*`, `_gid`, `_gat*`, `_gcl_*`, `_fbp`, `_fbc`, `_clck`,
`_clsk`, `_hj*`, `_uet*`). Hotjar and chat/review widgets have no consent API: when one already runs on the page, the
page reloads without it.

## Verified

- Unit (node:vm with a small DOM, `test/consent.test.ts`): state machine, storage format and expiry, revision bump,
  GPC, region fetch / caching / failure, Consent Mode call order (default → update → config → gtag.js), Meta
  `grant` before `init`, Clarity `consentv2`, withdrawal, widgets gating, consent log, admin validation, migration
  detection, scaffold wiring, cache safety (static: nothing visitor-specific in rendering), no inline script.
- Real browser (Chromium via Playwright, `test/consent-browser.test.ts`) against a local page with the starter's real
  scripts and CSS: opt-in → **zero** tracker requests before interaction, gtag.js, fbevents.js and the Clarity tag
  after "Accept all" (the same `consentRun` verify uses); notice → reported as "not applicable", never as passed; axe
  (verify's `accessibility()`, WCAG 2.1 AA tags) with the banner open: no serious/critical issue; the choices panel
  too; keyboard order skip link → banner; focus to the title when reopened from "Cookie settings", back on Escape.

## Not verified yet

- A generated project with the plugin: `astro check`, `astro build` and `wrangler deploy --dry-run` were not run in
  this change (no site was scaffolded); the starter files are type-checked only through the kit's tests.
- `/_consent/region` on a deployed Worker (`request.cf.country` from a real request), and the route-cache bypass of
  that path on Cloudflare.
- The consent log route on a deployed EmDash (public POST through the real dispatcher).
- Each provider honouring the signals server-side (Google's consent-mode diagnostics, Meta Events Manager, Clarity
  consent status) — only the calls on the page are checked.
- Verify's `consent-runtime` against a live site (it runs only when `production.live`); from a US machine an "auto"
  site shows the notice style and the check reports "not applicable".
