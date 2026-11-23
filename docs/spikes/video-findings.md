# Background videos: web sizes and edge cache (2026-11-24)

Code: `src/targets/emdash/video-sizes.ts` (kit), `starter/src/utils/video.ts` (Worker route), `starter/src/scripts/site.ts`.

## What was measured (two live sites, EmDash 1.6.0)

- EmDash's media route (`/_emdash/api/media/file/<key>`) serves a video as `cf-cache-status: BYPASS` on every request:
  players ask for byte ranges, EmDash reads those straight from R2 (`cache.set(false)` for ranges), and only
  `image/*` responses go into the route cache. Every first play read R2 from the database region (0.5–1.2 s to the
  first bytes from Europe). Browsers already cache it for a year (`immutable`).
- Performance reports count the hero video in the page weight even though it is attached after load (they wait for the
  network to go quiet): 5.87 MB of a 6.86 MB page.
- Re-encoding (H.264, no sound, ≤ 24 fps, `-movflags +faststart`): a 1080p 6.15 MB loop → 720p CRF 30 1.77 MB,
  480p CRF 30 0.93 MB; another 5.88 MB loop → 0.91 / 0.51 MB. Frames compared side by side: no visible difference
  behind an overlay. CRF 28 at 720p gave 2.20 MB for no visible gain.

## Cloudflare Cache API (developers.cloudflare.com/workers/runtime-apis/cache, read 2026-11-24)

- `cache.match` with a `Range` header against a stored 200 with `Content-Length` returns a 206.
- `cache.put` throws on a 206, so the whole file is stored from a separate full R2 read (known length).
- `If-None-Match` / `If-Modified-Since` on match give 304s. The cache is per data centre.
- Dashboard / Playground previews have no cache; versioned preview URLs are not mentioned (the route serves from R2
  when nothing is cached, so it works either way).

## Design

- Sizes live in the site's own media bucket at `_video/v1/<base>/<720|480>.mp4`, next to the upload, which is never
  changed. No database change, no new DNS name, nothing made public beyond what the media route already serves.
- `/_video/v1/<size>/<key>` is answered in `worker.ts` before Astro (no render, no database). A size not made yet
  falls back to the upload with `max-age=300` and is not stored, so the smaller file takes over within minutes.
- Made by `wp2emdash videos <slug> --yes` (Wrangler: `d1 execute` read-only list, `r2 object get/put`) and by the load
  phase when ffmpeg is installed. A video an editor uploads later is served at its uploaded size until the command
  runs again. Settings change → bump `v1` in both places.
- The page script attaches the video after load, when idle and only when its section is within 300 px of the screen;
  it pauses off screen. Phones that play video (`performance.phoneVideo`) get 480p.
- Rejected: an R2 custom domain (`cdn.<domain>`). It publishes the whole bucket, needs a DNS record per client and
  EmDash's own URLs would not use it; the Worker route gets the same edge cache without any of that.
