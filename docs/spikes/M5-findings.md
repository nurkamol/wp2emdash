# M5 — starter & scaffold findings

**Date:** 2026-11-17 · **EmDash** 1.5.0 · **Astro** 7.4.12 (latest) · **@astrojs/cloudflare** 14.4.8 · **Wrangler** 4.163 · **Node** 24

## EmDash facts the starter depends on (verified in the installed source)

| Fact | Where | Consequence |
|---|---|---|
| Block field types: `string text url number integer boolean datetime select multiSelect portableText image file repeater` | `schema/block-types.ts` | Sections get rich text (`portableText`) at the top level. |
| **Repeater sub-fields:** only `string text url number integer boolean datetime select image`, and only the keys `slug label type required options` — no rich text, no nested repeaters, no defaults/patterns/descriptions | `schema/types.ts`, `block-type-contract.ts` | Rich text inside list items (FAQ answers, bios, card bodies) is stored as `text` with a Markdown subset, rendered by the starter's `utils/md.ts` (escaped). |
| Block fields have no `description` key | `BlockFieldDefinition` | Help text lives in labels; the library keeps descriptions as docs only. |
| **Block values are strict:** unknown keys → `SchemaError: Unrecognized key` and the whole seed fails | `schema/block-values.ts` | `conformToBlockType()` keeps only defined fields and valid select options and reports what it drops. |
| `validateSeed()` runs `validateBlockFields()` for every block type | `seed/validate.ts` | The kit validates `seed.json` with EmDash's own validator in the scaffold gate. |
| Seed content can reference media as `{ "$media": { url, alt, filename } }`; setup downloads and uploads it (local R2 in dev) | `seed/types.ts`, dev log | Local preview uses the live WordPress media URLs (hidden upload paths rewritten). Load (M6) uploads from `raw/media/` instead. |
| Seed content entries have no SEO fields | `SeedContentEntry` | SEO titles/descriptions are written by load (M6) via the API. |
| `settings.staging: true` → `noindex` until go-live | `settings/types.ts` | Seeded as staging; cutover flips it. |
| Dev setup: `POST /_emdash/api/setup/dev-bypass` (header `X-EmDash-Request: 1`) applies `package.json → emdash.seed` incl. content | `routes/api/setup/dev-bypass.ts` | One request gives a local preview of the migrated site. |
| **Astro `trailingSlash: "always"` breaks EmDash:** its injected routes (`/_emdash/api/...`) stop matching (typegen and setup return 404) | dev log | Projects use `trailingSlash: "ignore"`; the WordPress URL style is enforced for page paths in `src/middleware.ts` (one 301, `/404` and files exempt). |
| `getMenuWithCacheHint(name)` items: `label url target cssClasses children` | `menus/types.ts` | Popup triggers in menus use a `popup-<slug>` class. |
| `Image` (`emdash/ui`) takes the image value; `Media` renders video values with normal video attributes | `components/EmDashImage.astro`, `EmDashMedia.astro` | Background video sections use `Media` with `autoplay muted loop playsinline`. |

## Pilot result

`wp2emdash run <pilot> scaffold` → gate passed: 12 section types used, all with block types and components; 1 live form generated; logo, light logo and favicon copied into `public/brand`; install OK; seed valid; build OK; Worker **19.3 MB raw / 5.16 MB gzip** (`mcp: false`).

Local preview (`pnpm dev` + dev-bypass): all 10 published pages return 200, `/about-us` → `/about-us/` (301), unknown paths 404, no browser console errors. Header: transparent over the hero video, cream when scrolled, logo swap, hide on scroll down; menu: fullscreen-split with the measured overlay/icon/item timings.

## Known gaps (tracked)

- Icon fonts (Iconsmind, Linecons, Font Awesome) → SVG mapping table not built yet: icons render as accent dots.
- Form submission endpoint (`/api/forms/<id>` → email provider, Turnstile, sensitive-data rules) — M6.
- Visual tuning (title row alignment, small `h5`-sized labels) is left to the M7 visual-diff gate, not tuned by eye.
- Self-hosted fonts: Google Fonts link for now; self-hosting is a later option.
