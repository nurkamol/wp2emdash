# @wp2emdash/consent (experimental) — Privacy & Consent

A PixelKraft plugin for EmDash sites on Cloudflare Workers, on by default in every site the wp2emdash kit
builds (`consent: false` in `kit.config.ts` turns it off). Admins only.

## What it does

- **A built-in cookie banner** (the starter's `components/Consent.astro` + `public/scripts/site-consent.js`): a bottom
  bar or corner card with **Accept all**, **Reject non-essential** and **Choose** (necessary — always on; analytics;
  marketing; preferences). Accessible: a non-modal dialog first in the tab order after "Skip to content", labelled and
  described, native checkboxes with descriptions, 44 px buttons, Accept and Reject styled the same, colours from the
  site's text/background tokens, Escape never decides. **Cookie settings** is added to the footer (or any element with
  `data-consent-open` opens it); focus goes to the banner's title and back on close.
- **Modes**: *off*, *notice* (US style: on until the visitor opts out), *opt-in* (EU/UK style: nothing that stores data
  before consent), *auto* (default: opt-in for EU/EEA, UK, Switzerland, Québec and unknown; notice elsewhere — asked
  from the uncached `/_consent/region`).
- **Trackers follow the choice** (the SEO & Analytics loader, `site-analytics.js`): Google Consent Mode v2 default
  denied before anything is queued, `update` on the choice, Google scripts loaded only once allowed; Meta Pixel only
  with marketing consent (`fbq('consent','grant')` before `init`, `revoke` on withdrawal); Clarity (`consentv2`) and
  Hotjar only with analytics consent; chat and review widgets with preferences. Cloudflare Web Analytics (cookieless)
  always runs. **Global Privacy Control** keeps marketing off.
- **The choice stays in the visitor's browser** (`localStorage` + first-party cookie `site_consent`: version, revision,
  three flags, time — no identifier; 180 days). Pages stay one cached HTML for everyone.
- **Plugins → Privacy & consent**: mode, position, wording (plain text, length-limited), privacy policy page (picked
  from the pages), category descriptions, which services fall in which category (from SEO & Analytics and the site
  widgets), the footer link switch, **Preview the banner**, **Ask every visitor again** (revision + 1) and an optional
  **consent log** — counts per day of accepted / rejected / chosen, no IP, no identifier, kept 90 days. Saving purges
  the cached pages.
- **Third-party consent tools** kept from the old site (CookieYes, Cookiebot, Termly, iubenda as site widgets): the
  built-in banner starts off; choosing a mode switches to it and the old tool stops loading.

## Register

```js
// astro.config.mjs (the kit's scaffold writes this)
import { consentPlugin } from "@wp2emdash/consent";
emdash({ plugins: [consentPlugin({ productionUrl: "https://example.com", siteName: "Example", defaults: { mode: "auto" } })] });
```

The site side lives in the kit's starter: `src/utils/consent.ts` (reads the settings row), `src/components/Consent.astro`,
`public/scripts/site-consent.js`, and `/_consent/region` in `src/middleware.ts`. Imports `@wp2emdash/seo` (tracker
types, analytics settings, the page purge).

## Storage

Plugin KV `settings` (D1 `options` row `plugin:privacy-consent:settings`), read by the site by primary key on a
route-cache miss; `stats:<YYYY-MM-DD>` counts. Facts, sources and what is verified: `docs/spikes/consent-findings.md`.
