# wp2emdash starter

The project template `wp2emdash scaffold` copies into `sites/<slug>/project/`. Based on the EmDash
`cloudflare:marketing` template (MIT, © EmDash contributors): `src/live.config.ts`,
`tsconfig.json` and `pnpm-workspace.yaml` come from it unchanged; `src/worker.ts` adds the form outbox to its cron handler. Everything else is the kit's.

| Path | What |
|---|---|
| `src/components/sections/` | One component per section type in the library (`src/starter/library.ts` in the kit) |
| `src/components/Section.astro` | Shared section shell: tone, background image/video/colour, overlay, spacing, anchor |
| `src/components/SiteHeader.astro` | Header + burger menu; variant from `src/site.config.json`, motion from `styles/motion.css` |
| `src/components/Popups.astro` | Popups as native `<dialog>` |
| `src/layouts/Base.astro` | Page shell: head/SEO, header, footer (`site_parts/footer`), popups |
| `src/pages/[...slug].astro` | Every page at its original path; `home` is the front page |
| `src/scripts/site.ts` | Header scroll states, menu, popups, tabs, reveal, forms |
| `src/styles/base.css` | Structure only — values come from `tokens.css` + `motion.css` |
| `src/utils/` | Markdown subset, link and embed allowlists |

Generated per site (do not edit in the kit): `package.json`, `astro.config.mjs`, `wrangler.jsonc`,
`seed/seed.json`, `src/site.config.json`, `src/styles/tokens.css`, `src/styles/motion.css`, `src/forms/*.json`.
