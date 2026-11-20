# Provider registry — hosts and snippet forms (checked 2026-11-20)

The registry (`starter/src/utils/providers.ts`) marks each entry `source: "verified"` (hosts taken from the provider's
own CSP / allowlist page) or `"snippet"` (derived from the provider's official embed snippet). Every entry has a sample
in `test/providers.test.ts`: the sample must be detected as that provider, and every URL it loads must be covered by the
provider's hosts (embed allowlist) and CSP sources.

How hosts become CSP: each registry domain `d` allows `https://d` and `https://*.d` in `script-src`, `frame-src` and
`connect-src`; `csp` adds exact extras (wss, style, font, media). `img-src` is already `https:` in the starter, so image
hosts are not listed. Embed providers are allowed on every page (an embed an editor adds later must work); site widget
providers only when the site switches the widget on (`siteWidgets`).

## Site widgets (loaded by ID)

| Provider | Snippet form (ID) | Hosts in the registry | Status | Source |
|---|---|---|---|---|
| Intercom | `widget.intercom.io/widget/{app_id}`, `intercomSettings.app_id` | intercom.io, intercomcdn.com; connect `*.intercom-messenger.com` (+wss), `wss://nexus-websocket-a/b.intercom.io`, uploads.intercomusercontent.com; frame intercom-sheets.com, www.intercom-reporting.com; font js/fonts.intercomcdn.com; media js/downloads.intercomcdn.com | verified (US region; EU/AU workspaces use regional hosts and `api_base` — not carried, loader uses the US `api-iam` base) | https://www.intercom.com/help/en/articles/3894-configuring-your-content-security-policy-csp |
| HubSpot tracking code & chat | `js.hs-scripts.com/{portalId}.js` (`#hs-script-loader`) | hs-scripts.com, hs-analytics.net, usemessages.com, hubspot.com, hubapi.com; hs-banner.com, hscollectedforms.net (seen in the loader, not on HubSpot's page) | verified (core list); EU1 portals load from `js-eu1.hs-scripts.com` — the loader uses `js.hs-scripts.com`: **unverified for EU portals** | https://knowledge.hubspot.com/domains-and-urls/ssl-and-domain-security-in-hubspot |
| Crisp | `window.CRISP_WEBSITE_ID="{uuid}"` + `client.crisp.chat/l.js` | crisp.chat; connect `wss://client.relay.crisp.chat`, `wss://stream.relay.crisp.chat`; style/font client.crisp.chat | verified | https://docs.crisp.chat/guides/others/whitelisting-our-systems/crisp-domain-names/ |
| Tawk.to | `embed.tawk.to/{propertyId}/{widgetId}` | tawk.to (`*.tawk.to` everywhere), `wss://*.tawk.to` | partial: the help article lists `*.tawk.to` for every directive; extra CDN/font hosts on that page could not be read | https://help.tawk.to/article/why-are-images-not-showing-up-in-the-widget |
| CookieYes | `cdn-cookieyes.com/client_data/{key}/script.js` | cdn-cookieyes.com, cookieyes.com | verified | https://www.cookieyes.com/documentation/content-security-policy/ |
| Cookiebot | `consent.cookiebot.com/uc.js` + `data-cbid="{uuid}"` | cookiebot.com, cookiebot.eu | partial (script/frame/connect verified; Cookiebot recommends a nonce + strict-dynamic, not used) | https://support.cookiebot.com/hc/en-us/articles/360018907220 |
| Termly | `app.termly.io/resource-blocker/{uuid}` | termly.io (covers app., us./eu.consent.api.) | verified | https://support.termly.io/hc/en-us/articles/42349363599249 |
| iubenda | `embeds.iubenda.com/widgets/{uuid}.js` | iubenda.com | partial: the CSP guide uses `*.iubenda.com`; the legacy inline `_iub.csConfiguration` + `iubenda_cs.js` form is **not** carried (needs code → a decision) | https://www.iubenda.com/en/help/12260-how-to-configure-content-security-policy-to-allow-iubenda-scripts-to-execute |
| Elfsight | `elfsightcdn.com/platform.js` + `<div class="elfsight-app-{uuid}">` | elfsight.com, elfsightcdn.com | **unverified** (no CSP page; from the snippet). Widgets that show other sites' media (Instagram, YouTube) may need more frame hosts | official install snippet |
| Trustindex | `cdn.trustindex.io/loader.js?{id}` | trustindex.io; style cdn.trustindex.io | **unverified** (from the snippet) | official install snippet |

Loader behaviour (`starter/public/scripts/site-widgets.js`): consent tools are dynamic, deferred scripts, so their
*auto-blocking* modes (Cookiebot `data-blockingmode="auto"`, Termly `autoBlock=on`) are not switched on — they would not
block anything loaded before them. CookieYes (`cookieyes_consent_update`, `detail.accepted` includes `analytics`) and
Cookiebot (`CookiebotOnAccept` + `Cookiebot.consent.statistics`) call `window.siteAnalytics.grantConsent()` (SEO &
Analytics consent mode). Event names are from the vendors' developer docs as known on 2026-11-20 — **not tested in a
browser against a live account**.

## Content embeds

| Provider | Snippet form | Hosts | Status |
|---|---|---|---|
| Google Calendar | `<iframe src="https://calendar.google.com/calendar/embed?src=…">` | calendar.google.com | snippet |
| Google Forms | `<iframe src="https://docs.google.com/forms/d/e/{id}/viewform?embedded=true">` | docs.google.com | snippet |
| Wistia | `fast.wistia.com/embed/medias/{id}.jsonp` + `E-v1.js`, `<wistia-player>`, iframe `fast.wistia.net/embed/iframe/{id}` | wistia.com, wistia.net; media `*.wistia.com`, `*.wistia.net` | snippet (unverified CSP) |
| Loom | `<iframe src="https://www.loom.com/embed/{id}">` | loom.com | snippet |
| TikTok | `<blockquote class="tiktok-embed">` + `www.tiktok.com/embed.js` | tiktok.com (+ img `*.tiktokcdn.com`) | snippet (unverified) |
| Facebook page / video | `www.facebook.com/plugins/page.php` / `video.php` iframe, or `connect.facebook.net/{locale}/sdk.js` + `.fb-page` | facebook.com, connect.facebook.net | snippet |
| X (Twitter) | `.twitter-tweet` / `.twitter-timeline` + `platform.twitter.com/widgets.js` | platform.twitter.com, syndication.twitter.com | snippet (unverified; timelines restricted since 2023) |
| Vagaro | `www.vagaro.com/resources/WidgetEmbeddedLoader/{id}` | vagaro.com | **unverified** |
| Glofox | `app.glofox.com/portal/#/branch/{id}/…` iframe | glofox.com | **unverified** |
| Zenoti | `{tenant}.zenoti.com/webstoreNew/…` iframe | zenoti.com | **unverified** |
| Square Appointments | `app.squareup.com/appointments/buyer/widget/{id}/{loc}.js`, `book.squareup.com`, `square.site` | squareup.com, square.site | **unverified** |
| Booksy | `booksy.com/widget/code.js?id=…` | booksy.com | **unverified** |
| Fresha | `www.fresha.com/a/…` / `book-now` link or iframe | fresha.com | **unverified** |
| OpenTable | `www.opentable.com/widget/reservation/loader?rid=…` | opentable.com, otstatic.com | **unverified** |
| Resy | `widgets.resy.com/embed.js` + `resyWidget.addButton(…)` (inline call: the inline part is removed by the embed allowlist → a button must be rebuilt) | resy.com | **unverified** |
| Tock | `www.exploretock.com/tock.js` + `#Tock_widget_container` (inline `tock('init', …)` is removed by the allowlist) | exploretock.com | **unverified** |
| Arketa | `app.arketa.co/iframe/{slug}/schedule` | arketa.co | **unverified** |
| ClassPass | script/iframe on classpass.com (exact paths not confirmed) | classpass.com | **unverified** |

Before a gate depends on one of the **unverified** booking hosts, open a live page that uses it, record the network
log's script/frame/XHR hosts here, and adjust the entry.

## Known gaps

- Mailchimp's classic embedded form loads `mc-validate.js` from `s3.amazonaws.com` (a shared bucket host; not
  allowed) and posts to `list-manage.com` (the starter's `form-action 'self'` and the embed allowlist, which strips
  `<form>`, block it). Mailchimp forms need a rebuild as a site form or an iframe.
- Embeds whose official snippet needs an inline call (Resy, Tock, Calendly badge, iubenda legacy) keep only their
  external scripts; the inline part is removed by design (no inline JS in content).
- Site-wide snippets are read from the saved HTML: a widget injected only by another script after load (e.g. by GTM)
  is not seen. GTM-injected tags stay inside the GTM container, which SEO & Analytics carries.
