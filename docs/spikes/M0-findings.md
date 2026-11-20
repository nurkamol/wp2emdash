# M0 spike — findings

**Date:** 2026-11-17 · **EmDash:** 1.5.0 (`create-emdash` 1.5.0) · **Astro:** 7.4 · **Wrangler:** 4.163 · **Node:** 24.21
**Spike project:** `spikes/m0-site` (template `cloudflare:marketing`, gitignored)

Everything below was run against a local dev server (`astro dev`, local D1/R2 via workerd). Items needing a real Cloudflare deploy or a real WordPress site are marked **deferred**.

## Results per assumption (PLAN §12)

| # | Assumption | Result | Evidence / consequence |
|---|---|---|---|
| A1 | `blocks` field + `blockTypes` give a usable section editor | ✅ structurally | The `marketing` template already ships 11 versioned block types (`marketing_hero`, `_features`, `_faq`, `_pricing`, `_split`, `_text`…) on a `content` field of type `blocks` (`maxItems: 20`) with repeaters, image and Portable Text fields. **Starter = marketing template + our extra block types.** Visual check of the admin editor for each new type happens in M5. Raise `maxItems` (WPBakery pages can have > 20 rows). |
| A2 | Pages at root paths | ⚠️ partly | `src/pages/[slug].astro` serves `/{slug}` and `/{slug}/`. Slugs with `/` (`services/physical-therapy`) are **accepted and stored** but 404 because the route is single-segment. **Starter changes it to `[...slug].astro`.** Both `/x` and `/x/` return 200 → starter must enforce the source trailing-slash policy (redirect the other form). |
| A3 | Overlay can write blocks via CLI | ✅ | `emdash content create pages --file page.json --slug …` writes `content: [{_type,_version,_key,…}]`; renders immediately. `content update --rev` enforces optimistic concurrency (stale rev → "version conflict"). Updates to a published entry go live directly. |
| A4 | Media lookup for IR refs | ✅ | `emdash media upload` returns `id`, `storageKey`, `contentHash: "sha1:…"`; identical bytes dedupe to the same record. Image fields only need `{ "provider": "local", "id": "<mediaId>", "alt": "…" }` — the server fills width/height/mime/meta. Kit resolves WP attachment → download → sha1 → match `contentHash`, else upload. |
| A5 | Re-runnable overlay | ✅ by design | Upsert = `content get` (rev) + `content update --rev`; entries addressed by our `id-map.json`, not slug. |
| A6 | Redirect mechanism | ✅ with gaps | Native redirects: `POST /_emdash/api/redirects` `{source, destination, type}` (needs `redirects:manage`), Astro-style patterns `[param]`, `[...rest]` work; trailing slash normalised; hit counters + 404 log (`/_emdash/api/redirects/404s`); slug renames create auto redirects. **Gaps:** (1) query-string sources (`/?p=123`) are stored but never match; (2) paths with a file extension (`/wp-content/uploads/…jpg`) bypass the redirect layer; (3) destinations must be site-relative. **→ Kit adds a small middleware for `?p=`/`?page_id=`/`?cat=`, uploads URLs and external destinations; everything else goes into native redirects (editable by the client in admin).** |
| A7 | Exporter 1.2.0+ on a Salient site | ✅ (M3) | Pilot site: exporter 1.2.0 delivers raw WPBakery content, `_nectar_*` meta, Rank Math, menus with locations, options, media, and `salient_g_sections` on request. Salient Redux options are **not** included. See `M3-findings.md`. |
| A8 | Cache invalidation on publish | ✅ locally, ⏳ on Workers | Edit visible on next request in dev. Re-check route caching on a deployed Worker in M5. |
| A9 | Restorable snapshot | ✅ | `emdash site export -o file.emdash` → 20 files / 1.6 MB incl. media. Kit runs it before every load. |

## Other findings

- **Dev automation:** `POST /_emdash/api/setup/dev-bypass` (dev only) applies the seed and creates `dev@emdash.local` admin; `GET /_emdash/api/auth/dev-bypass` gives a session cookie for REST calls. CLI auto-authenticates against localhost (`Auth: dev-bypass`). Remote targets need `emdash login` or `EMDASH_TOKEN` (service token). → kit local pipeline is fully scriptable; remote staging needs a token step in `ACCESS.md`.
- **Official WP importer on WPBakery = shortcode soup.** `emdash import wordpress sample.xml --prepare` then `--execute` turned a WPBakery page into Portable Text paragraphs whose text is literally `[vc_row full_width="stretch_row" bg_image="55"][vc_column width="1/2"][vc_column_text]`. Confirms the WPBakery adapter is mandatory.
- **Official importer on Gutenberg is decent:** `core/cover` → `{_type:"cover", backgroundImage, overlayOpacity, content}`, `core/columns` → `{_type:"columns", columns:[{_type:"column", content}]}`, dynamic blocks → `{_type:"htmlBlock", html:"<!-- wp:latest-posts /-->", originalBlockName}`. Our Gutenberg adapter maps layout-level blocks to sections and leaves prose to this converter.
- **Importer redirect map is wrong for our routing:** `_redirects.json` maps `https://example.com/bakery/` → `/pages/bakery`. Kit generates its own redirect map.
- **`migration-config.json`** from `--prepare` lists collections, meta keys with samples and skip lists — useful input for the audit's plugin/field matrix.
- **Built-in sitemap issues:** lists `/home` instead of `/`, and nested slugs as `/services%2Fphysical-therapy`. → starter overrides the pages sitemap (or fixes the URL pattern); verify gate checks sitemap = indexable URL set.
- **Template ships agent skills** (`building-emdash-site`, `creating-plugins`, `emdash-cli` in `.claude/skills` + `.agents/skills`) and `.mcp.json` pointing at `https://docs.emdashcms.com/mcp`. Starter keeps them and adds the WordPress porting skills.
- **Design tokens:** template uses `src/styles/tokens.css` (defaults, `@layer base`) + `src/styles/theme.css` (unlayered overrides, `light-dark()` colours). Kit writes per-site values into `theme.css` only.
- **Deploy script:** `"deploy": "astro build && wrangler deploy"`; bindings `DB` (D1) and `MEDIA` (R2) in `wrangler.jsonc`, a `* * * * *` cron for maintenance; `.env` holds `EMDASH_ENCRYPTION_KEY`.

## Plan changes

1. Starter = `npm create emdash@latest -- --template cloudflare:marketing` + kit overlay (extra block types, `[...slug].astro`, trailing-slash + query/uploads redirect middleware, sitemap fix, theme.css generation).
2. Redirects: native EmDash redirects for path rules; kit middleware only for the three gaps above.
3. Media: sha1 matching against `contentHash`.
4. Overlay uses CLI `content create/update --file` locally and the same commands with `EMDASH_TOKEN` remotely.

## Addendum — EmDash Exporter plugin API (read from `emdash/src/import/sources/wordpress-plugin.ts`)

The exporter exposes a read-only JSON API the kit can call directly (not only through EmDash's importer):

| Endpoint | Auth | Returns |
|---|---|---|
| `GET /wp-json/emdash/v1/probe` | none | exporter version, WP version, capabilities (`acf`, `yoast`, `rankmath`, app passwords), post types + counts, media count, i18n (WPML/Polylang) |
| `GET …/analyze` | Basic (app password) | per post type: totals by status, supports, taxonomies, **custom fields with inferred types and samples**; taxonomies; authors; attachments by mime; ACF groups + fields |
| `GET …/content?post_type=&status=any&per_page=100&page=` | Basic | **raw `content` (shortcodes intact)**, all `meta`, `acf`, `yoast`, `rankmath`, taxonomies, featured image, parent, menu_order, locale/translation group, dates |
| `GET …/media?per_page=&page=` | Basic | id, url, filename, mime, title, alt, caption, description, width, height, filesize |
| `GET …/taxonomies`, `…/menus`, `…/options`, `…/comments` | Basic | terms, menus with items, site identity options (title, tagline, logo, favicon…), comments |

Falls back to `?rest_route=/emdash/v1/<path>` when pretty permalinks are off. Auth header: `Authorization: Basic base64(user:app-password)`.

**Decision:** the extract phase (M3) uses this API as the **primary** source (raw WPBakery shortcodes + `_wpb_shortcodes_custom_css` + Salient `_nectar_*` meta + Rank Math in one pass, as JSON), WXR as fallback/cross-check. Theme options not covered by `options` (Salient Redux `salient_redux`) still need a separate read-only step — to be checked in M3.

**Pilot site, before install (2026-11-17):** exporter not installed (`probe` → 404). REST namespaces reveal: Fluent Forms, FluentSMTP, Rank Math, Popup Maker, Google Site Kit, Wordfence, FileBird, WebP Converter, `spc/v1` (page cache), WP Abilities. The audit uses `/wp-json/` namespaces as a plugin fingerprint.

## Addendum — EmDash project size (measured 2026-11-17, marketing template, EmDash 1.5)

| What | Size | Why | Deployed / downloaded by visitors? |
|---|---|---|---|
| `node_modules` | 1.1 GB | Dev tooling: **two copies of workerd** (local Cloudflare runtime, ≈144 MB each, pinned by different packages), admin UI dependencies (echarts 61 MB, Phosphor icons 57 MB, date-fns 26 MB, base-ui 20 MB), TypeScript, sharp, rolldown, wrangler | No — local only; pnpm hard-links packages across projects |
| Worker bundle | 20 MB raw / **5.45 MB gzip** | The whole CMS runs inside the site's Worker: admin API, auth, importer, site transfer, plugin runner, MCP server — and **36 admin-UI translation files = 8.3 MB (41%)** | Deployed, never sent to visitors. Exceeds Workers Free (3 MB gzip) → Workers Paid required (10 MB limit) |
| `mcp: false`, `registry: false` | −170 KB gzip (→ 5.28 MB) | Removes MCP endpoint and registry client | Not enough to fit the free plan; not worth losing MCP |
| `dist/client` | 19 MB, of which ≈14 MB JS | Admin React app (`/_emdash/admin`) | Only editors load it; public pages ship Astro HTML/CSS + small islands |

Trimming admin locales with a build plugin could bring the Worker near 3 MB, but it patches EmDash internals and breaks on upgrades — rejected. Workers Paid is also needed for CPU time (Free allows 10 ms per request; SSR + D1 needs more).

## Addendum — runtime versions (2026-11-17)

- Workers do not run Node.js. They run workerd (V8 isolates); `nodejs_compat` provides `node:*` modules (Buffer, crypto, streams, AsyncLocalStorage…). The spike uses `compatibility_date: "2026-02-24"` + `nodejs_compat`; scaffold will set the date to the day the project is generated.
- Build/dev tooling: Node 24.21 (spike). EmDash 1.5 declares `engines.node >=22.16`; the kit standardises on Node 24 (`.nvmrc`, `engines`).
- Astro: npm latest 7.4.12; EmDash 1.5 peer range `astro >=6.0.0-beta.0`, `@astrojs/react >=5`. The spike ran on Astro 7.4 → latest Astro is supported.

## Taxonomy term list is a tree (2026-11-21)

`GET /_emdash/api/taxonomies/{name}/terms` in EmDash 1.5 returns a nested tree (`children`) when the taxonomy is hierarchical, a flat list otherwise (`handleTermList` → `buildTree`). Code that looks terms up by slug must flatten it first (`flattenTerms` in `src/targets/emdash/api.ts`).
