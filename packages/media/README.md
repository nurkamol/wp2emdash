# @wp2emdash/media (experimental) — Media Assistant

An in-house PixelKraft plugin for EmDash sites on Cloudflare Workers, on by default in every site the wp2emdash kit
builds (`media: false` in `kit.config.ts` turns it off). Editors and admins.

## What it does

**Plugins → Media** (tabs Overview, Optimize, Alt text, Unused, Duplicates, Broken, Trash, Settings for admins):

- **Media health**: files and size by type; oversized originals (> 2500 px or > 500 KB images, > 10 MB videos);
  images without alt text and where each is used; unused files; duplicates (same content hash); formats (large PNG
  photos, SVG, BMP/TIFF/HEIC, large GIFs); broken references (pages pointing at a file that no longer exists). Usage
  comes from a read-only scan of the D1 database (every place that names a file) — see `src/scan.ts`.
- **Optimize** (per file or up to 10 at a time): resize to the longest side and re-encode at quality 82 with the
  Cloudflare Images binding, replace the file in place through EmDash's own "Replace original" (same id and address),
  keep the old file 30 days in R2 (`backups/media-originals/`), put the focal point back, purge the `emdash:media`
  route cache. **Put the old file back** within 30 days. Same type only (EmDash replaces JPEG/PNG/WebP with the same
  type); a new format is reported, not done.
- **Alt text suggestions**: Workers AI (`@cf/meta/llama-3.2-11b-vision-instruct`, a 512 px copy) when the Worker has
  the `AI` binding and AI is on, else the file name and the heading above the image. Each suggestion is edited and
  marked Save / Reject by a person; **Save reviewed** writes only those. Off by default on `sensitiveData` sites.
- **Focal point**: nine positions on a file's Details view (Block Kit has no click-on-image picker).
- **Trash**: unused files (never brand files, settings files or uploads from the last 24 hours) move to the media
  folder "Trash (Media Assistant)"; **Put back** any time; after 30 days an editor may delete them for good (checked
  again; one more copy kept 30 days). Nothing is deleted automatically.
- **Queue new uploads** (Settings, default off): the `media:afterUpload` hook queues JPEG/PNG/WebP uploads; an editor
  optimizes them with one click, or the hourly task does it when the Worker secret `MEDIA_API_TOKEN` is set.
- **Site health** gets a **Media** check (images on pages without alt text, oversized originals, broken references —
  from this plugin's daily counts; never an alert).

Every change to a file goes preview → a one-time plan (10 minutes, same person) → a button with a confirm dialog.

## Register

```js
// astro.config.mjs (the kit's scaffold writes this)
import { mediaPlugin } from "@wp2emdash/media";
emdash({ plugins: [mediaPlugin({ productionUrl: "https://example.com", siteName: "Example", aiAlt: true })] });
```

Needs, in `wrangler.jsonc`: `DB` (D1), `MEDIA` (R2), a service binding of the Worker to itself
(`"services": [{ "binding": "SELF", "service": "<worker name>" }]`), the `IMAGES` binding (added by
`@astrojs/cloudflare`), and for AI `"ai": { "binding": "AI" }` (also in `env.staging`: not inherited). Optional Worker
secret `MEDIA_API_TOKEN`: an EmDash API token (Settings → API tokens) with media write access, for hourly optimizing
of the upload queue.

## Privacy and security

The database is only read. Files change only through EmDash's REST API as the person who confirmed (EmDash checks
their permissions). AI suggestions send a small copy of the picture and the site name / page titles to Workers AI, and
the Meta licence is accepted only by an admin's click. Logs carry counts and reasons. No public routes.

Facts and limits: the kit's `docs/spikes/media-findings.md`.
