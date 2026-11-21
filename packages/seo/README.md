# @wp2emdash/seo (experimental) — SEO & Analytics

Version 0.3.0 adds **sharing text per page** and **archive SEO** (below), exports `/social` (read by the starter and
the kit's load) and declares `taxonomies:read`.

## Sharing text and archive SEO (0.3)

- **Per page** (KV `social:<collection>:<entryId>` = D1 row `plugin:site-seo:social:…`): Open Graph and X (Twitter) title,
  description and image. Carried from Yoast / Rank Math by the kit's load (admin route `seo-import`); edited in the page
  editor's SEO panel → **Social sharing** (contributors and up, as the panel). Images are addresses (https:// or a media
  library file address): Block Kit 1.5 renders no media picker.
- **Per term archive** (KV `term:<taxonomy>:<slug>`): SEO title (the whole `<title>`), meta description, noindex and the same
  sharing fields. Carried from Yoast `wpseo_taxonomy_meta` / Rank Math term meta; edited in the dashboard tab
  **Archives** (editors and admins; terms listed with `taxonomies:read`).
- **Rendering:** the `page:metadata` hook (priority 50, so before `@wp2emdash/og`'s cards; plugin tags are first-wins)
  prints only what is set. Twitter falls back to Open Graph; empty fields fall back to EmDash's own tags (the entry's SEO
  title, description and image, or the sharing card). Archives: og/twitter fall back to the archive's SEO title and
  description, plus `description` and `robots: noindex, follow`. The archive's `<title>` comes from the starter, which
  reads the same row (`readTermSeo`, one primary-key read per uncached render). The hook finds an archive's term from its
  address with the `archives` option (taxonomy + base; scaffold passes the blog and collection archives).
- **Saves** purge the cached pages (`purgePages`: tags `wp2emdash:analytics` and `emdash:settings`, which every page
  carries). A value saved in the admin is marked `editor`; load's import keeps it and reports it as "kept".

Version 0.2.1 exports `/site-checks` and `/plugin/collect` and lets the Visits query take a date range (used by
`@wp2emdash/health` for its monthly report).

Version 0.2.0 adds Analytics to the suite: the admin page is **SEO & Analytics** (tabs Overview, Visits, Analytics,
Pages, Images, Site checks, Google, IndexNow) when the site carries analytics; without the `analytics` option it stays
the SEO dashboard of 0.1. Version 0.2.1: the ownership verification section points to EmDash's Settings → SEO, where
the Google and Bing tags now live (prefilled from the old site by the kit's load).

## Analytics (tab "Analytics"; changes by admins only)

- **Tracking codes by ID, never code:** Google Analytics 4 (`G-`), Google tag (`GT-`), Google Ads (`AW-`), Tag Manager
  (`GTM-`), Meta Pixel (digits), Microsoft Clarity (project ID), Hotjar (site ID), Cloudflare Web Analytics (beacon
  token). Strict per-service formats (`analytics/trackers.ts`); one Clarity / Hotjar / Cloudflare beacon on at a time;
  Universal Analytics (`UA-`) is listed when the old site had it, marked retired, never loaded.
- **Prefill:** the first load stores what scaffold carried over (`analytics.seed`): everything the audit found in the old
  pages' HTML (`analytics/detect.ts`), rows marked "from the old site". A Cloudflare beacon the old site's zone injected
  is not carried (Cloudflare keeps injecting it); scaffold asks Cloudflare (read-only) which it was.
- **Conversion events** (switches): form sent, phone/email links, booking links, outbound links (off by default). The
  starter's `scripts/site.ts` classifies clicks (`analytics/events.ts`) and reports successful form sends; the loader
  sends each switched-on kind to every tracker that understands it. Kind and a non-personal label only.
- **Consent mode** (off by default): Google starts with consent denied; Meta, Clarity and Hotjar wait for
  `window.siteAnalytics.grantConsent()` — the hook for a future cookie banner (none ships).
- **Status:** honest — "On" means the site asks browsers to load it; the tab explains how to check in each service and
  shows the kit's last `verify` browser check (dated) when one was recorded at scaffold time.
- **Ownership verification:** points to EmDash's Settings → SEO, where the Google and Bing tags are edited (prefilled by load);
  other carried-over tags (Pinterest, Meta, Yandex) are listed read-only.
- **Storage and freshness:** plugin KV key `analytics` = D1 `options` row `plugin:site-seo:analytics`, read by the
  starter (`analytics/store.ts`) once per uncached render; each save purges tags `wp2emdash:analytics` and
  `emdash:settings` through `cache.purge` from `cloudflare:workers`, so changes are live within seconds.
- **Security policy:** the starter's middleware allows exactly the switched-on services' hosts (`analytics/csp.ts`, one
  table shared with the tests). Trackers load on the production domain only and never for signed-in editors.

## Visits (tab "Visits", dashboard widget for admins, page editor)

Cloudflare Web Analytics for the last 7 days via the GraphQL API (`rumPageloadEventsAdaptiveGroups`): visits, page
views, daily chart, top pages, referrers; each page's own views at the top of its SEO panel. One query, cached 15
minutes. Needs the Worker secret `CF_ANALYTICS_TOKEN` (custom token: Account → Account Analytics → Read) and the account
id (scaffold passes it; `CF_ANALYTICS_ACCOUNT_ID` overrides); `CF_ANALYTICS_SITE_TAG` overrides the site tag scaffold
found. The token never appears in a view, a log or KV.

## Opt-out (kit.config)

- `seo: { panel: false }` — no plugin at all; the site loads exactly `analytics` from site.config.json (the package is
  still copied: the starter uses its tracker, CSP and event modules).
- `analytics: false` — no trackers carried or loaded; the suite has no Analytics or Visits tab.
- `analytics: { google: [...], gtm, meta: [...], clarity, hotjar, cloudflareToken }` — exactly these as the starting list.

Facts and sources: [docs/spikes/analytics-findings.md](../../docs/spikes/analytics-findings.md).

## SEO dashboard (Plugins → SEO, editors and admins)

- **Overview:** average score, pages checked, pages under 80, images without a description, a score bar per page and
  the most common issues with the pages they affect. The same checks as the page panel, so the numbers agree.
  **Pages that need more text:** published, indexable pages under 300 words (short-by-nature pages left out), fewest
  words first, with the words to add and an **Edit** link; hidden when there are none. Read from the same analysis.
- **Pages:** every published page with its score, what to improve, its focus keyword and an **Open** link to the editor.
- **Images:** every picture used on a page that has no description (alt text), with a field per image — **Save
  descriptions** writes them to the media library, so every page using the image gets it (capability
  `media:metadata:write`).
- **Site checks:** robots.txt (crawlable, names the sitemap), the sitemap (every published page listed), the home page
  (indexable, canonical on the production domain, structured data). On staging or workers.dev, blocking search engines
  is expected and shown as a note, not an error.
- **Dashboard widget:** average score, pages under 80, images to describe.

## Google Search Console (dashboard tab "Google")

Connected with a **service account** (no Google sign-in screen, works for any team member): the owner creates a
service account in Google Cloud with the Search Console API enabled, downloads its JSON key, adds the account's email
as a **Full** user of the Search Console property, and pastes the key into the dashboard. EmDash stores it encrypted
(`admin.settingsSchema` secret field, `EMDASH_ENCRYPTION_KEY`); it is never shown again or logged. The Worker signs
a JWT (RS256, WebCrypto) for an access token and shows, for the last 28 days Google has data for: clicks, impressions,
click rate, average position, a daily chart, top searches and top pages; the sitemaps Google knows (**Submit
sitemap**); and **Check index status** for up to 25 pages (URL Inspection API, 2,000/day/property). Data is cached
6 hours (**Refresh** to update). Works before go-live: Search Console reports on the domain, whatever serves it.

## IndexNow (dashboard tab "IndexNow")

Publishing a page tells Bing, Yandex, Seznam, Naver and the other IndexNow engines right away (Google does not use
IndexNow; it reads the sitemap). The key is derived from the production host and its file is written to
`public/<key>.txt`, so it sits at the domain root and covers every URL. Submissions start only when the site is live
on its domain (`production.live` in the kit's cloudflare.json, then re-scaffold and deploy); before that the domain
still serves the old site and the key could not be verified. The tab shows whether the key file is reachable, the last
20 notifications, and **Notify search engines about every page**.

## SEO panel in the page editor

An **SEO panel in the EmDash page editor** (sidebar, under EmDash's own SEO fields), for editors, authors and
contributors who may edit the page:

- **Score** out of 100 and what to improve, in plain words.
- **Google preview:** the address, the title as the layout renders it (page title + separator + site name) and the
  description, with "cut off" warnings at about 60 / 160 characters.
- **Checks:** SEO title length; meta description present and 120–160 characters; no other page with the same title or
  description; exactly one H1; no skipped heading levels; text length (below); alt text on every image (in the field or the
  media library); links to other pages; a short lowercase address; not hidden from search; canonical pointing to the
  page itself; a sharing image (or generated cards, `@wp2emdash/og`).
- **Focus keyword** per page (what people search for): checked in the title, description, H1, first 100 words and
  address, and how often it appears (about 0.5–3%).
- **Content checks** (the same signals outside audit tools flag), each with one next step:
  - **Text length:** under 150 words is a problem, under 300 a warning (`THIN_WORDS`, `VERY_THIN_WORDS`). Pages short
    by nature — slug (or its last segment) `contact`, `privacy`, `terms`, `legal`, `thank-you`, `cookies`, `404`… — are
    only noted, never scored.
  - **Repeated words:** the most frequent word (small English stop-word list skipped) above 4% of all words is a
    warning, as audits call it keyword stuffing. Under 80 words it says "too little text to judge"; a word of the focus
    keyword is left to the keyword check.
  - **Easy to read:** Flesch–Kincaid grade (vowel-group syllable estimate) of the body text; a warning above grade 12,
    a note otherwise. English only: `seoPlugin({ lang })` when set, else guessed from common English words; under 30
    words it is not judged.
  - Only warnings and problems count toward the score; the "fine" results are notes, so existing scores move only for
    pages that have one of these problems.
- **Check my unsaved changes:** analyses the editor's current title and sections before saving.

EmDash facts it relies on (1.5): `admin.editorPanels` with `draft.read` and the `admin.editor-draft:read` capability
(the draft comes with button presses, not on panel load); `content:read` for the saved page, its SEO fields and other
pages; `media:read` for alt text; route permission `content:read_drafts` (EmDash also checks the user may edit the
entry). The SEO fields live outside the entry, so unsaved edits to them are checked after saving.

Enabled per site with `seo: { panel: true }` in the kit config; the scaffold copies this package, links it and
registers `seoPlugin({ productionUrl, titleSeparator, collections, ogCards })` in astro.config.
