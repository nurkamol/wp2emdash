# Performance package — verified facts and measurements (2026-11-20)

Checked against the installed **EmDash 1.5.0, Astro 7.4.12, @astrojs/cloudflare 14.4.8, Wrangler 4.163.0** (the
`STACK` versions; read in a kit site project's `node_modules`, never modified) and measured on the
the pilot Bricks site **staging** Worker (`<site>-staging.<subdomain>.workers.dev`, D1 + R2 in ENAM, D1 read replication
disabled). Runner: a laptop in Central Asia whose requests land at Cloudflare **ARN** (Stockholm) — far from the
database, close to the worst case the owner measured. Nothing was deployed to production.

## What the package does (kit default, `src/scaffold/perf.ts`)

| Part | Default | Opt-out (`sites/<slug>/kit.config.ts`) |
|---|---|---|
| Route caching (Workers cache, EmDash purge by tag) | on, `maxAge` 3600 s, `swr` 86400 s | `performance: { routeCache: false }` |
| Warm-up after every deploy (`scripts/warm.mjs`) | on (with the route cache) | `performance: { warmup: false }` |
| Responsive images through EmDash's `/_image` (Images binding) | on | `performance: { responsiveImages: false }` |
| Hashed brand files (WebP logo with size, small favicons), immutable fonts/brand (`public/_headers`) | always | — |
| Hero/background video deferred (poster first) | always (starter) | — |
| Announcement schedule checked in the browser, script allowed by CSP hash | always (starter) | — |
| Smart Placement | **off** (below) | `performance: { smartPlacement: true }` turns it on |
| Verify gates `route-cache`, `cached-ttfb` (≤ `gates.maxCachedTtfbMs`, 600), `payload` (≤ `gates.maxPayloadKb`, 1500) | on | thresholds in `gates` |

## Route caching — how it works in this stack

- `cacheCloudflare()` (`@astrojs/cloudflare/cache`) is a **CDN provider**: it only sets `Cloudflare-CDN-Cache-Control`
  and `Cache-Tag` (plus an `astro-path:<path>` tag, and `astro-version:<id>` when a `CF_VERSION_METADATA` binding
  exists). Purge = `cache.purge({ tags })` from `cloudflare:workers`. A hit never runs the Worker (no middleware, no
  CSP computation: the cached response carries the headers it was rendered with).
- The adapter adds `"cache": { "enabled": true }` to the flattened Wrangler config when a cache provider is set and
  stamps `Cloudflare-CDN-Cache-Control: no-store` on every response without cache intent (otherwise the Workers cache
  would keep any GET up to two hours). The kit writes `"cache": { "enabled": true, "cross_version_cache": false }`
  itself; Wrangler 4.163 accepts `cross_version_cache` (schema `CacheOptions`) and the key **is inherited** by
  `env.staging` (checked in `dist/server/wrangler.json` of a `CLOUDFLARE_ENV=staging` build).
- **cross_version_cache: off** (owner's lean, adopted). Cloudflare: "the cache key includes the Worker version by
  default". Every deploy therefore serves its own templates and starts cold; `scripts/warm.mjs` refills it (pages from
  the sitemap, then every `/_image` variant those pages use, max 400). Warm-up is appended to every package script that
  runs `wrangler deploy` / `wrangler versions deploy` (staging scripts → the staging address, others → the production
  domain once `production.live`, else its workers.dev address); it waits 5 s (`WARM_DELAY_MS`) for the version to
  propagate and always exits 0. Each Cloudflare location has its own lower tier: the runner warms the upper tier and
  its own location; other locations get an upper-tier hit (fast, no Worker) on their first request.
- **Route rules match by path, whatever the route** (`compileCacheRoutes` → regex on the pathname, Astro priority
  order). A catch-all (`/[...slug]`) would cache `/_emdash/*` and `/api/forms/*`, so the kit writes one rule per public
  page path from the IR (trailing slash covered by `trailingSlash: "ignore"`), `/sitemap.xml`,
  `/sitemap-[collection].xml` and `/_image`. Pages an editor adds later get the same lifetime from the page itself
  (`starter/src/utils/cache.ts` → `Astro.cache.set({ maxAge, swr, tags })` when no rule matched).
- **Tags:** EmDash purges `[collection, entryId]` on publish/unpublish/delete/restore/schedule (content routes),
  `emdash:settings` (settings), `emdash:menu:<name>` (menus and items), `emdash:widget-area:<name>`,
  `emdash:taxonomy:<name>` (`chrome-tags` module). Rules carry `pages`, `site_parts`, `popups` (so creating a missing
  footer/announcement/popup reaches every page); the page adds its own entry hint and the chrome hints.
  Consequence: publishing any page purges every page (`pages` tag) — intended (menus and listings show other pages),
  and only 1 purge call per save (Cloudflare purge limit 5/min, burst 25; a rate-limited purge fails silently).
- **Finding — chrome hints must be set in the PAGE frontmatter.** The starter's layout (`Base.astro`) called
  `Astro.cache.set(hint)` for settings/menus/footer/popups. Measured on staging: a menu label change and a site title
  change were **never** visible on cached pages (`age` kept growing for 60 s+), while page publishes purged at once.
  Astro applies cache headers when the page component returns its Response; a layout renders while the body streams,
  so its tags never reach `Cache-Tag`. Fix: `starter/src/utils/chrome.ts` loads the chrome in
  `pages/[...slug].astro` (in parallel with the page entry), sets the hints there and passes the data to `Base`.
  After the fix: menu change visible after **0.5 s**, settings change after **3.2 s**, page publish (SEO title) after
  **0.5 s**; each restore equally fast (`/_emdash/api` with the staging `EMDASH_TOKEN`; all values restored).
- **Excluded automatically (EmDash middleware):** responses for a signed-in user (`locals.user`) and responses with
  `Cache-Control: private|no-store` are `cache.set(false)`; 404 responses showed `cf-cache-status: BYPASS`. The
  starter additionally opts out: the 404 page and the not-found rewrite, the `/home` → `/` redirect, every redirect
  its middleware answers (www/http, legacy sitemap/upload/brand paths, `?p=` ids, trailing slash), and requests from
  an editor (session cookie, edit-mode cookie, `?_edit`, `?_preview`). The cache key includes the query string
  (measured), so `?_preview=` URLs never get the public copy.
- **`robots.txt` is not cacheable**: EmDash answers it with `Cache-Control: no-store` (→ BYPASS). It is one query
  (~120 ms render), so no rule is written for it.
- **Editors** see the cached public page (the cache ignores cookies; requests with `Authorization` bypass). EmDash's
  `toolbar: "client"` mode would show an Edit pill on cached pages, but its bootstrap is an inline script that the
  public CSP would have to hash per EmDash version; left at the default (`"server"`): editors edit in the admin.
- **Forms** render no per-visitor data (the Turnstile site key is a public constant per environment, submissions are
  POSTs to `/api/forms/<id>`, never cached). Analytics are decided by host (part of the cache key) and editors are
  never cached, so a cached page never carries an editor's variant.
- **Browser caching of HTML stays `no-cache`** (middleware sets it when absent): the route cache is what makes pages
  fast; EmDash can only purge that one.
- **Not used:** the object cache (KV) — off, as decided. D1 read replication is disabled on both the pilot Bricks site
  databases (`read_replication.mode: "disabled"`), so `session: "auto"` reads hit the primary and a purge never
  re-caches a lagging replica's copy. If a site enables replication, re-test edit visibility.
- Billing note (Cloudflare docs): with the Workers cache on, every request to the Worker is billed as a Workers
  request, including static-asset requests that are otherwise free; cache hits use no CPU time.

## Announcement bar and the CSP

- The old pre-paint inline script was blocked by the public CSP (no `'unsafe-inline'`), so the server dropped ended
  bars — which breaks once pages are cached. Now `starter/src/scripts/inline/announcement.js` is inlined verbatim
  (`?raw` import + `<script is:inline set:html>`), and the middleware adds `'sha256-…'` of the same text (computed once
  per isolate with `crypto.subtle`) to `script-src`. Measured: the header carries
  `sha256-r1KyLirZ4+o2xm4aRyB5x4HIHzGCTU1HlytsHY48BW8=`, which equals the SHA-256 of the file.
- Visibility is decided in the browser (dismissed version, `starts_at`, `ends_at`). The server leaves out a bar that
  has already ended, renders one that starts later with `hidden`, and shortens the page's cache lifetime to the next
  start/end (`maxAge` = seconds until then, `swr: 0`), so visitors without JavaScript see the change too.

## Hero / background video

- Before: `<video src autoplay preload="auto">` — the 5.6 MB MP4 was fetched before the load event on every device.
- Now: the section's picture is an `<Image priority>` (LCP, responsive srcset, `fetchpriority="high"`); the video has
  `data-src`, `preload="none"`, no `src`/`autoplay`/`poster`, sits invisible on top and fades in on `playing`.
  `scripts/site.ts` attaches it after `load` + `requestIdleCallback` (3 s timeout), never on screens < 768 px, with
  `Save-Data`, or under `prefers-reduced-motion` — the picture stays. A video without a picture (`data-always`) is
  attached everywhere (first frame only under reduced motion). The container stays `aria-hidden`.

## Images

- EmDash's `<Image>` optimises only absolute media URLs on hosts Astro authorises (`canOptimizeImage` checks that
  `getImage` rewrote the URL). The project had no `image.domains`, so every content image was the original file
  (a 2821×3000 PNG of 574 KB on the home page). The kit now authorises the site's own hosts (production domain ±www,
  staging and production workers.dev). EmDash's `/_image` endpoint matches the media **path** only and reads the
  bytes from R2 — it never fetches the `href` host.
- Transform: the adapter's default image service is `cloudflare-binding` (the `IMAGES` binding, added automatically).
  **No zone setting** (unlike `/cdn-cgi/image/`, which needs Transformations enabled on a zone and does not run on
  workers.dev). Cost: Cloudflare Images "unique transformations" — 5,000/month free per account, then $0.50/1,000; on
  the Free Images plan new transforms beyond that fail with error 9422. The starter middleware turns any 5xx from
  `/_image` into a 302 to the original file, so a spent quota degrades to full-size images, never broken ones.
  Variants are route-cached (`/_image` rule, 1 day + 7 days swr) — `/_image` responses keep `Cache-Control: public,
  max-age=0, must-revalidate` for browsers (EmDash), and a HIT measured 0.24 s vs 1.2 s for the transform.
- **Media files are not content-addressed**: "Replace original" (`/_emdash/api/media/:id/replace`) overwrites the
  same storage key and EmDash 1.5.0 does not purge any tag for it, so `/_emdash/api/media/file/*` keeps EmDash's
  `max-age=0, must-revalidate` (no long browser cache) and replaced images can show stale `/_image` variants for up to
  a day (or until a deploy). (The EmDash docs describe one-year media caching under `emdash:media:<key>` tags — not
  present in 1.5.0.)
- Brand files: content-hashed copies under `/brand/h/` (immutable via `public/_headers`), the raster logo re-encoded
  as WebP at 2× the header logo height (Chromium canvas via Playwright, only when smaller — the pilot Bricks site: 31 KB PNG →
  14 KB WebP, 155×200), `width`/`height` on every logo `<img>`; favicon as a 32 px PNG (2 KB), a 192 px WebP (10 KB)
  and the original PNG as apple-touch fallback. AVIF: Chromium's canvas cannot encode it, so not produced. The
  original `/brand/logo.png` stays (sharing cards and old links). Fonts were already content-hashed (sha1 of the
  bytes) → `/fonts/*` immutable.

## Measurements (staging unless noted; runner → Cloudflare ARN)

| | Before | After |
|---|---|---|
| HTML TTFB, uncached render | 0.80–1.79 s (production, no route cache); 1.43 s staging MISS | 0.34–1.37 s (first hit after a purge or deploy, by page) |
| HTML TTFB, cached | — (rendered per request) | 78–83 ms on a warm connection, 0.24–0.26 s with a new TLS connection (curl); `cf-cache-status: HIT` on every page |
| Home page bytes until load, desktop | 6,728 KB (MP4 5,745 KB fetched before load) | 397 KB; video requested after load + idle |
| Home page bytes until load, phone (390 px) | 6,728 KB | 258 KB; no video at all |
| Lab LCP (Playwright, unthrottled) desktop / phone | 2,296 / 1,280 ms | 732 / 488 ms |
| `<img>` without width/height | 2 (logos) | 0 |
| Content image on the home page | 2821×3000 PNG, 574 KB | WebP srcset, 48–65 KB at the rendered size |
| Edit visible on a cached page | page publish: purged; menu/settings: never (before the chrome fix) | page 0.5 s, menu 0.5 s, settings 3.2 s |

## Smart Placement

**Off — not shown to help.** Measured on staging with uncached renders (a fresh query string per request, 7 pages,
one request every 1.5 s, ~25 per minute), same runner:

| | Median TTFB per minute | Worker time (`mw` server-timing) median | Where it ran (`cf-placement`) |
|---|---|---|---|
| `placement: { mode: "smart" }`, 11 minutes | 583–616 ms (875 ms in minute 0) | 246–273 ms | `local-FRA`, `local-WAW`, `remote-WAW` — never moved to North America |
| No placement (same build), 6 minutes | 588–639 ms | 249–265 ms | — |

Smart Placement kept the Worker in Europe (its analysis never chose the database's region), so uncached renders
were no faster; for this site's real visitors (Houston) the Worker already runs next to the ENAM database, and
cached pages do not run the Worker at all. The staging Worker had been left with placement from an earlier manual
experiment (`cf-placement: local-FRA` on the first measurement); the kit's deploy removes it. A site whose visitors
are far from its database and whose pages are mostly uncached could try `performance: { smartPlacement: true }` and
compare with the same method (`cf-placement`, `server-timing`).

## Verify on staging (preview run, 2026-11-20)

`WP2EMDASH_TARGET=staging wp2emdash run <slug> verify --preview`: the new gates pass — `route-cache` (11 pages
HIT on the second request), `cached-ttfb` 244 ms, `payload` 397 KB in 10 requests; `a11y` and `performance` (worst
lab LCP 592 ms) pass. `visual` fails as before (it was accepted at 24 sections over: third-party embeds), now 26:
the home page's mobile hero is 56% different because phones now keep the hero picture instead of playing the
background video — an intended change the owner has to accept (or set the video section's picture to a frame that
matches the video's first frame).

## Unverified / open

- A GTmetrix/Lighthouse run against staging was not possible here (no Lighthouse installed); the payload and LCP
  numbers above come from Playwright/CDP on an unthrottled connection.
- Purge propagation was measured from one location; Cloudflare documents purge as global.
- Production is unchanged: it still renders every page until the next production deploy (owner approval).

## Page lifetime and preloading (2026-11-21)

Measured on a live single-environment site (one location, two requests per page): cached HTML 0.25–0.36 s TTFB;
`MISS`/`EXPIRED` 2.4–2.9 s. `age` topped out near 3,500 s: with `maxAge` 3600 each page expired hourly per Cloudflare
location. Stale-while-revalidate works (staging, same day: `cf-cache-status: UPDATING` at age 7,766 s, 0.27 s, then
`HIT`), so a copy is served fast for `maxAge` + `swr` (25 h). The slow responses were copies older than that
(`EXPIRED`, rendered synchronously) or never cached at that location (`MISS`): on a low-traffic site a page can go
unvisited at a location for more than a day. A 7-day `pageMaxAge` keeps pages servable for 8 days; a `MISS` (never
cached, or evicted by Cloudflare) still renders once — preloading moves that render before the click.

- **Pages now live 7 days** (`performance.pageMaxAge` 604800). Safe because every edit that shows on a page purges it:
  content publish/unpublish/schedule (EmDash, incl. the scheduled-publish sweep, which purges incrementally), menus,
  settings, widget areas, taxonomies (chrome hints set in the page frontmatter), comment moderation (EmDash's
  moderation routes), SEO & Analytics and consent saves (`purgePages`), and — fixed now — the coming-soon switch.
  Pages also carry `posts` and the collections' tags, since footer widgets (Recent posts) show them.
- **Posts, archives and collection entries keep `maxAge` 3600:** EmDash 1.5's byline routes only call
  `invalidateBylineCache()` (object cache), never an edge purge, so a byline edit would otherwise show for days.
- **Coming-soon race:** the middleware cached the switch for 30 s per isolate; after a purge a stale isolate could
  re-cache the public page for the whole page lifetime. `MAINTENANCE_TTL_MS` is now 0 (one D1 row per rendered request;
  cached hits never run it).
- **404s stay uncached on purpose:** Site health's Missing pages reads EmDash's 404 log, which a cached 404 never reaches.
- **Preloading:** own ~30-line script (`starter/src/utils/prefetch.ts` + `site.ts`), not Astro's `prefetchAll`, which
  would also fetch PDFs and other files on hover. Hover (65 ms), focus and touchstart; same-origin pages only; skips
  files, `/_emdash`, `/api`, `/_image`, `/wp-content`, feeds, previews, searches, `target=_blank`, `download`, data saver
  and 2G; at most 20 per page. `<link rel=prefetch>` where supported, else a low-priority `fetch` (Safari), which still
  renders an uncached page at the edge before the click.

## Re-warm after edits, inline-script lint (2026-11-21)

- **Why:** measured on the live single-environment site, pages an edit had purged stayed `MISS` (1.7–2.0 s TTFB) until
  a visitor rendered them, while untouched pages were `HIT` (0.25 s). The deploy warm-up does not run after edits.
- **Re-warm** (`performance.rewarmMinutes`, default 15; 0 off): once `production.live`, the Worker's existing 5-minute
  cron (`starter/src/worker.ts`) requests every sitemap page (max 120 per run, 4 at a time) from the live origin on the
  tick that starts each window. A cached page is a hit (the Worker does not run); a purged one renders once there. Never
  on workers.dev (a Worker cannot fetch its own workers.dev address). Cloudflare documents same-zone fetches to a Custom
  Domain as succeeding subrequests; a Worker fetching **its own** Custom Domain is not documented. **Confirmed live
  2026-11-21** (single-environment site on its Custom Domain, `wrangler tail`): the 10:45 UTC run logged
  `rewarm: 11 pages, 8 rendered, 0 failed` (the cron's location had not been warmed by the deploy runner) and each
  request reached the Worker with the `site-rewarm` user agent; the 11:00 run logged `11 pages, 0 rendered, 0 failed`
  (every page a cache hit, the Worker not run). Self-fetch goes through the Workers cache and fills it.
- **Inline-script lint** (scaffold gate `csp-inline`, `src/scaffold/csp-lint.ts`): the public CSP allows inline scripts
  only by hash, and an inline script reached the live site once (a component script under 4 KB that Astro inlined),
  caught only by verify after the deploy. The lint fails scaffold when `assetsInlineLimit` is not 0, or a component has
  `<script is:inline>` code, `define:vars`, `set:html` not from `scripts/inline/`, or an `on*=` handler.

## Speculation Rules for page preloading (2026-11-22)

- **Why:** a live Playwright run showed the hover `<link rel=prefetch>` firing, but the click fetched the page again
  (navigation `transferSize` > 0): pages carry `Cache-Control: no-cache`, so the browser revalidates the prefetched copy.
- **Local test** (throwaway, not committed): Node http server, two pages with `Cache-Control: no-cache`, the starter's
  CSP shape (`default-src 'self'; script-src 'self'`) and `Speculation-Rules: "/cdn-cgi/speculation",
  "/speculation-rules.json"` (the rules file from `speculationRules()`), driven by Playwright Chromium 159.0.8154.6,
  **headless** (headless honours header-delivered rules). Hover a link 600 ms, click:
  - Rules header: `deliveryType: "navigational-prefetch"`, server saw `GET /two/` **once** (`Sec-Purpose: prefetch`), no
    request at click. `transferSize` 700 / `encodedBodySize` 400: the entry reports the prefetch's bytes, so
    `transferSize` is not 0 — check `deliveryType` or the server log, not `transferSize`.
  - Hover only 260 ms and 100 ms: still `navigational-prefetch` (moderate also starts on pointerdown; the click uses the
    in-flight prefetch).
  - No header: `deliveryType: ""`, one normal request at click.
  - `<link rel=prefetch>` on hover (today's script): `GET /two/` with `Sec-Purpose: prefetch`, then **again** at click,
    `deliveryType: ""`, `transferSize` 730 — reproduces the live finding.
  - Rules file served as `application/json`: ignored, no prefetch. The content type must be
    `application/speculationrules+json` → `public/_headers` sets it (Cloudflare static assets: `_headers` overrides the
    default Content-Type; it does not apply to Worker responses).
  - CSP `default-src 'none'; script-src 'none'`: rules still fetched and used. Chromium applies no CSP directive to a
    header-delivered rule set (only inline rules need `'inline-speculation-rules'`), so the hash-only `script-src` is
    untouched. Same-origin anyway.
  - Exclusions held in the browser: `/doc.pdf`, `?s=`, `target=_blank`, `data-prefetch="false"`, `/_emdash/admin` were
    hovered 400 ms each and never requested; `/old.html` was prefetched.
  - The rules file is requested once per page view (revalidated); tiny.
- **URL patterns:** objects starting at `pathname` inherit protocol/host/port from the rules file URL (same-origin only)
  and leave search/hash as wildcards. A string pattern or an object starting at `search` would inherit the pathname.
  URLPattern regex groups may not contain capturing groups (`(?:…)` inside only). Node 24's `URLPattern` agrees with
  Chromium; `test/prefetch.test.ts` checks the rules against `prefetchable()` with it.
- **Built:** `starter/public/speculation-rules.json` (= `speculationRules()` in `starter/src/utils/prefetch.ts`, document
  rules, `moderate`, prefetch only — never prerender, which runs page scripts, booking widgets, analytics). The middleware
  appends `Speculation-Rules: "/speculation-rules.json"` on HTML responses when `prefetch` is on, never for editors;
  coming-soon 503s and non-HTML responses never get it. Appended, so Cloudflare Speed Brain's own rule set is kept.
  `site.ts` keeps the hover `<link rel=prefetch>` only where `HTMLScriptElement.supports("speculationrules")` is false
  (Safari, Firefox), so Chrome/Edge do not fetch twice. Signed-in editors in Chrome/Edge get no preloading (their pages
  bypass the cache anyway).
- **Not yet checked live:** a Cloudflare deploy (`_headers` Content-Type on the real asset, a cached page's header).

## Google Fonts dynamic addresses and the deploy check (2026-11-22)

- **Root cause of a build without its body font:** fonts.googleapis.com/css2 answers the same request with one of two
  stylesheets. Usually each face's `src` is `https://fonts.gstatic.com/s/<font>/<v>/<hash>.woff2`; in about one answer in
  ten (4 of 40 requests measured, same URL and user agent) some families come as
  `https://fonts.gstatic.com/l/font?kit=…&skey=…&v=…` with `format('woff2')` and no extension. The self-hosting step
  matched only `….woff2)` and skipped the other faces silently, so the family was missing from fonts.css and the site
  shipped with a fallback font. Both forms serve woff2 bytes (`wOF2` magic). Fix (src/scaffold/fonts.ts): take the URL
  from `url(…) format('woff2')`, check the `wOF2` signature, fail (keep the Google link) on anything unreadable, and
  scaffold refuses a self-hosted set that misses a family of the Google Fonts link (warns, keeps the link, saves
  Google's answer to reports/scaffold/google-fonts-answer.css).
- **Deploy check** (src/scaffold/deploy-check.ts → scripts/deploy-check.mjs, after the warm-up): sitemap pages answer,
  `<title>`/`<main>`/footer present, home stylesheets and scripts load, the `fetchpriority=high` picture loads, and
  every family in site.config `fonts.body`/`fonts.display` is an `@font-face` in the home page's CSS (or a Google Fonts
  / Typekit link). On a failure: `wrangler deployments list --json` → the newest version other than the current one →
  `wrangler rollback <id> -y -m …`, exit 1. Run in the project right after `wrangler deploy`, so Wrangler resolves the
  same Worker (staging builds via .wrangler/deploy/config.json → dist/server/wrangler.json). Wrangler 4.163.0:
  `rollback [version-id] -y -m <message>`. Measured on live sites: Priority Pilates 11 pages, M Wellness staging 10
  pages, both pass; a booking-widget page (heading + script embed) counts as content.
