# P2 parity batch: users, term meta, page attributes, reusable blocks, embeds, fonts, sitemaps, form entries

**Date:** 2026-11-21 · **EmDash:** 1.5.0 (installed package source, read-only: `emdash/src`, `@emdash-cms/auth/dist`,
`@emdash-cms/admin/dist`) · Parity rows: `users`, `term-meta`, `menu-order`, `page-hierarchy`, `featured-image`,
`excerpt`, `reusable-blocks`, `embeds`, `fonts`, `sitemaps`, `form-entries` (`scripts/parity-gen.mjs`).

Everything below was read in the installed source or run against EmDash's own `validateSeed`; nothing here was run
against a deployed site or a real WordPress site (synthetic fixtures only).

## What was built

| Row | Where | What it does |
|---|---|---|
| users | `src/transform/users.ts`, `src/commands/invite.ts`, `src/phases/extract.ts` | Extract reads `GET /wp/v2/users?context=edit` (administrator's application password) and keeps id, name, e-mail, roles in `sites/<slug>/users/wordpress-users.json` (mode 0600). Transform maps administrator → ADMIN, editor → EDITOR, author → AUTHOR, contributor → CONTRIBUTOR (highest role wins), skips subscribers and unmapped plugin roles until `overrides.ts users.roles` decides, `users.skip` drops ids; writes `users/invites.json` + `users/invite-checklist.md` (0600). `ir/users.json`, the coverage report and the client go-live doc carry counts per role only. **Load invites nobody.** `wp2emdash invite <slug>` shows the plan; `--send` creates pending invites (owner's step). |
| term-meta | `src/transform/term-meta.ts`, `src/phases/load.ts`, `src/commands/import-options.ts` | Descriptions were already written at term creation (blog, CPT). Load now fills an empty description on an existing term and never replaces an editor's. Yoast `wpseo_taxonomy_meta` (database dump via `import-options`) is counted per taxonomy in the coverage report: not carried. **Superseded:** carried since @wp2emdash/seo 0.3 ([seo-social-findings.md](seo-social-findings.md)). |
| menu-order, page-hierarchy, featured-image, excerpt | `src/transform/pages.ts`, `src/scaffold/seed.ts`, `src/phases/load.ts` | IR `page: { menuOrder, parent: "page:<wpId>", excerpt }` only when set. `pages` gets `menu_order` (integer), `parent` (reference → pages), `excerpt` (text), `featured_image` (image) only for the attributes some page has; a site that never used them keeps `title` + `content`. Seed lists parents first; load creates missing fields on existing targets and writes the parent in the reference pass. The featured image is not rendered on pages (the coverage report says how many live pages printed `wp-post-image`). |
| reusable-blocks | `src/transform/sections.ts`, `src/targets/emdash/sections.ts` | Each published `wp_block` → `ir/sections.json` (Portable Text through EmDash's Gutenberg converter after the kit's shortcode pass, media marked) → seed `sections` / load `POST /_emdash/api/sections` with `source: "import"`, slug `wp-<slug>`. Reruns update sections the kit made; an editor's section with the same slug is left alone. Pages keep the block inlined as before. |
| embeds | `starter/src/utils/providers.ts`, `src/adapters/gutenberg/oembed.ts` | Registry +9: Dailymotion, TED, Twitch, Pinterest, Reddit, Bluesky, Mixcloud, Bandcamp, Apple Podcasts/Music. Gutenberg `core/embed` URLs of X/Twitter, TikTok, Instagram, Reddit, Pinterest, Dailymotion, TED, Spotify, Loom, Mixcloud become the provider's official markup (was: a bare link). |
| fonts | `src/scaffold/fonts.ts` `typekitKit`, `starter/src/utils/fonts.ts`, `starter/src/middleware.ts`, `starter/src/layouts/Base.astro` | The live site's Adobe Fonts CSS embed (`use.typekit.net/<id>.css`) is kept (`site.config.json fonts.typekitHref`), linked in the head; the CSP adds `https://use.typekit.net https://p.typekit.net` to style-src and `https://use.typekit.net` to font-src only then. A JavaScript kit embed is reported (scaffold log), not converted. |
| sitemaps | `src/phases/load.ts` `seoImageRef` | A page, post or entry without a usable og:image gets its featured image as the SEO image, which EmDash emits as `<image:image>` in its sitemap. |
| form-entries | `src/scaffold/client-repo.ts` `goLiveExtras` | Both go-live docs: "Form entries exported from WordPress by the owner" before the switch, and a reminder before WordPress hosting is retired. The kit never reads entries. |

## Verified against the installed EmDash 1.5.0

- **Field types for pages** (`schema/types.ts`): `integer`, `text`, `image`, `reference` exist; `RESERVED_FIELD_SLUGS` is
  `id slug status author_id primary_byline_id created_at updated_at published_at scheduled_at deleted_at version
  live_revision_id draft_revision_id terms bylines byline` — `menu_order`, `parent`, `excerpt`, `featured_image` are free
  (the CPT mapper already used them; self-referencing references verified in `cpt-findings.md`).
- **Seed** (`emdash/seed` `validateSeed`): the fixture's pages seed with the four fields, parents first and
  `parent: "$ref:about"` → `{"valid":true,"errors":[],"warnings":[]}`; the reusable-blocks seed with three `sections`
  (`source: "import"`, an image with `asset.url`) → valid. `SeedSection` = slug, title, description, keywords, content
  (Portable Text), source `theme | user | import`; `applySeed` updates or skips an existing slug (`seed/apply.ts`).
- **Sections** (`database/migrations/011_sections.ts`, `api/handlers/sections.ts`, `api/schemas/sections.ts`,
  `astro/routes/api/sections/*`): table `_emdash_sections` (slug unique `/^[a-z0-9-]+$/`, title, description, keywords,
  content = Portable Text JSON, source). `POST /sections` (409 `CONFLICT` on an existing slug), `GET|PUT|DELETE
  /sections/{slug}`; permission `sections:manage` = EDITOR, token scope `content:write` (`astro/middleware/auth.ts`
  SCOPE_RULES). In the admin (`@emdash-cms/admin` `PortableTextEditor`), the `/section` slash command opens
  `SectionPickerModal` and inserts **a copy** of the section's Portable Text (`handleSectionSelect` →
  `portableTextToProsemirror`): sections are a library, not synced blocks. Pages built from the kit's `blocks` field do
  not use that editor at the page level; whether the picker shows inside a block type's rich-text sub-field was not
  checked.
- **Invites** (`astro/routes/api/auth/invite/index.ts`, `@emdash-cms/auth` `createInvite`/`createInviteToken`):
  `POST /_emdash/api/auth/invite { email, role }`, caller must be an ADMIN user (role ≥ 50); a token falls under the
  fail-closed `admin` scope (no SCOPE_RULES entry). With an e-mail provider EmDash sends the invite; without one it
  answers `{ success, message, inviteUrl }` — a sign-up credential, which the kit does not store or print. An address
  that already has an account → `USER_EXISTS` (409). A pending invite does not block a new one (a new token each
  time), so the owner can re-invite from the admin. Roles: SUBSCRIBER 10, CONTRIBUTOR 20, AUTHOR 30, EDITOR 40,
  ADMIN 50 (`@emdash-cms/auth` `Role`).
- **Terms** (`api/schemas/taxonomies.ts`, `astro/routes/api/taxonomies/[name]/terms/[slug].ts`): `createTermBody` and
  `updateTermBody` carry `description`; `PUT /taxonomies/{name}/terms/{slug}` updates it. No SEO columns on terms
  (`006_taxonomy_defs`, `045_taxonomy_parent_group`); `_emdash_seo` (018) is per content entry only.
- **Sitemaps** (`astro/routes/sitemap-[collection].xml.ts`, `api/handlers/seo.ts`): each entry's stored SEO image
  (`_emdash_seo.seo_image`) is emitted as `<image:image><image:loc>` (urlset declares `xmlns:image`). One image per
  entry; no video sitemap. The starter's sitemap rewrite touches `<loc>` only (`<image:loc>` is left as it is).

## Verified elsewhere

- WordPress REST `GET /wp/v2/users?context=edit` returns `email` and `roles` only to users with `list_users`
  (administrators) — WordPress core behaviour; extract treats a refusal as "no list" (note in the extract report).
- WordPress prints the featured image with the class `wp-post-image` (`the_post_thumbnail()`), which the transform
  counts in the audit's saved pages.
- Provider embed URLs: the shapes used by each provider's own embed code (iframe hosts, `widgets.js`/`embed.js`
  loaders) — host lists are "snippet" sources in the registry, like the earlier embed providers.

## Not verified

- **Nothing here ran end to end on a local or deployed EmDash** (no `astro dev` run in this batch): the API calls
  follow the routes and schemas above. The invite flow, section creation over the API and term description updates
  were exercised with fakes only.
- **Typekit CSS embed**: the `p.typekit.net` page-view import and the font hosts come from Adobe's documented embed;
  not observed on a live kit in this batch. The JavaScript embed is not converted.
- **Rank Math term SEO**: stored in term meta, which neither the Exporter nor REST serve; not counted. (Since @wp2emdash/seo 0.3 read from a database dump's `<prefix>termmeta` and carried: [seo-social-findings.md](seo-social-findings.md).)
- **Starter rendering**: the featured image on pages is carried, not rendered; no child-page listing section uses
  `menu_order`/`parent` yet (the admin shows the fields; URLs were already kept).
