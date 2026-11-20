# WordPress URLs with no page on the new site, content inventory, Additional CSS

**Date:** 2026-11-20 · **EmDash:** 1.5.0 · **Astro:** 7.4.12 (installed in the pilot project) · Parity backlog items 2, 3, 7 (sites without a blog), 9 and the Customizer CSS finding (`docs/parity/wp-to-emdash.md`).

## What was built

| Piece | Where | What it does |
|---|---|---|
| Rule set | `starter/src/utils/wp-urls.ts` (`matchWpUrl`), decided in `src/transform/wp-urls.ts` (`buildWpUrlPlan`) | Feeds, comment feeds, search, category/tag/author/date archives, attachment pages, pagination and the query forms (`?s=`, `?feed=`, `?cat=`, `?tag=`, `?author=`, `?attachment_id=`, `?m=`, unknown `?p=`/`?page_id=`) → one 301 or a 410. Written to `ir/wp-urls.json` and coverage.md ("WordPress URLs"); scaffold copies it into `site.config.json → wpUrls`; the starter middleware applies it. |
| `urls-accounted` (verify) | `src/verify/urls-accounted.ts` | Every audited URL, every REST-discovered entry/term/author/attachment page, the upload files the old pages used, and WordPress's own forms of them must answer 200, one 301/308 to a 200, or 404/410 by decision. Same `matchWpUrl` as the middleware. |
| `content-types-handled` (transform) | `src/transform/content-types.ts` | Every non-empty post type, every taxonomy with terms in use and the authors with published posts: migrated, internal (configuration), or decided in `overrides.ts` (`contentTypes`, `taxonomies`, `authors`, each with a reason). |
| `custom-css` (transform) | `src/transform/custom-css.ts`, extract `readCustomCss` | Additional CSS read from the live pages (`<style id="wp-custom-css">`), else the exporter's `custom_css` post; size, selectors, media queries, upload and external URLs in the report; carried only with `customCss: "carry"`. |

## Defaults (per site, from what the audit and extract found)

| Rule | Brochure site (no blog page) | Site with a blog page (`page_for_posts` migrated) |
|---|---|---|
| `/feed/`, `/?feed=rss2`, `/wp-rss2.php` | 301 → `/` | 301 → the blog page |
| `/comments/feed/`, `?feed=comments-rss2` | 410 | 410 |
| `/<page>/feed/` | 301 → the page | 301 → the page |
| `/?s=`, `/search/<q>/` | 301 → `/` (→ `/search/?q=` when a `/search/` page exists) | same |
| `/category/…`, `/tag/…`, `?cat=`, `?tag=` | 410 | 301 → the blog page |
| `/author/…`, `?author=` | 301 → `/` | 301 → the blog page |
| `/2024/`, `/2024/05/`, `?m=` | 410 | 301 → the blog page |
| attachment pages, `?attachment_id=` | parent page if migrated → the file if it is in the media library (looked up like an old upload URL) → `/` | same |
| `/page/2/`, `/<page>/page/2/` | 301 → the first page | same |
| unknown `?p=` / `?page_id=` | 404 (WordPress answers 404 too) | same |

Archive bases come from the live term/author links (`/topics/` instead of `/category/` is detected). A migrated page always wins over a rule. `overrides.ts → wpUrls` sets any rule to a path, `"home"` or `"gone"`. A site with published posts gets the feed redirect plus a flag (`feedPending`, coverage note) until the blog milestone generates a real feed.

## Feeds: 301 to a page, or 410? (SEO reasoning)

Who requests `/feed/`: feed readers and aggregators (subscriptions), crawlers that found it in every page's `<link rel="alternate" type="application/rss+xml">` (both real sites printed the post feed and the comments feed on every page), and the occasional backlink.

- **Search engines.** Google does not index RSS documents as pages; it uses feeds for discovery, like sitemaps. Neither a 301 nor a 410 on `/feed/` loses rankings. A 301 to the home page is at worst treated as a soft 404 (Search Central: redirects of removed content to an unrelated page), which has the same effect as a 410: the URL drops out. A 410 is processed a little faster than a 404 but both are final.
- **Links.** A 301 keeps whatever link value an external link to `/feed/` carries and lands a human on a working page; a 410 does neither.
- **Feed readers.** A 410 is the documented "unsubscribe" signal (most readers stop polling). A 301 to an HTML page makes a reader report a broken feed and keep polling until the user removes it. For a site that has posts, a 301 to an HTML page is wrong in the long run: subscribers expect a feed, so the blog milestone must answer `/feed/` with RSS (the coverage report flags it).

**Decision.** The **site feed** (`/feed/`, `?feed=rss2`) → **301** to the home page (or the blog page): no ranking risk, keeps any link value, lands humans somewhere useful, and the address stays valid for the day a real feed exists (switching a 301 to a 200 later is free; un-gone-ing a 410 is not, since readers have unsubscribed and crawlers stopped asking). **Comment feeds** (`/comments/feed/`, `?feed=comments-rss2`) → **410**: comments are not migrated, there is no equivalent resource, and readers should unsubscribe. A page's own comment feed (`/<page>/feed/`) → 301 to the page (it is a property of that page). Archive feeds follow their archive's rule.

## Verified

- **Astro 7.4.12 middleware can rewrite:** `MiddlewareNext = (rewritePayload?: string | URL | Request) => Promise<Response>` (installed `astro/dist/types/public/common.d.ts`). The middleware renders the starter's 404 page with `next("/404")` and answers 410/404 with it.
- **Bundled CSS position:** the compiled pilot layout emits `${renderHead($$result)}</head><body…>` (built `dist/server` chunk), so Astro's stylesheet links are the last thing in `<head>`. A `<link rel="stylesheet">` placed first in `<body>` therefore comes after them in the cascade: the carried Additional CSS overrides the starter's rules at equal specificity, and it is a file (`public/styles/custom-<hash>.css`), not inline CSS. `style-src 'self'` allows it.
- **Real sites (transform --preview on copies of the two site workspaces, 2026-11-20):** both pass `content-types-handled` (types: page, popup, popup_theme, salient_g_sections, wp_navigation / page, bricks_template, wp_navigation; 0 posts, 0 terms in use, authors with 0 posts), no Additional CSS on either site (no `wp-custom-css` style in the saved pages), brochure defaults for the rules. `urls-accounted` lists 109 / 85 URLs; besides feeds, search and attachment pages, both sites' `locations.kml` (Rank Math Local SEO, non-HTML) has no home on the new site yet and will fail the check until it is regenerated or recorded in `overrides.ts → gone`.

## Not verified yet

- **HEAD on the Worker.** `urls-accounted` sends HEAD first and repeats with GET whenever HEAD does not answer 200/301/308/410, so a route that does not support HEAD costs one extra request rather than a false failure. Not yet run against a deployed site.
- **Exporter and `custom_css`.** Whether the EmDash Exporter's `content` endpoint returns the non-public `custom_css` type was not exercised (both sites have none). The live pages are the primary source anyway; a refused request is treated as "none".
- **The middleware rules end to end.** Unit-tested (`test/wp-urls.test.ts`: the matcher, defaults, and verify's judgement against a simulated site that answers like the middleware); not yet built and deployed on a site, so the 410 response through `next("/404")` and the media-library lookup for attachment files are unexercised on workerd.
