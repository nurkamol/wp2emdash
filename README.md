# wp2emdash

> Migrates WordPress sites to [EmDash](https://docs.emdashcms.com/) on Cloudflare Workers (D1 + R2) and proves the result with automated gates: content, URLs, SEO, design, forms and integrations.

**Status:** `init` → `verify` run end to end on a real Salient + WPBakery site: 0 unmapped content, 100% of page text carried over, a generated EmDash project loaded idempotently into local, staging and production (`workers.dev`), and a verify report comparing the live WordPress site with the migrated one section by section at phone, tablet and desktop widths. The cutover preflight is implemented; the traffic switch waits for the owner's approval — see [`docs/PLAN.md`](docs/PLAN.md) §13.

**Requires:** Node.js 24+ and pnpm. Generated sites run on Cloudflare Workers (Workers Paid plan — the EmDash Worker is above the free plan's 3 MB limit) with the latest Astro that EmDash supports.

## Quick start

```bash
pnpm install
cp .env.example .env       # Cloudflare token: see docs/cloudflare-api-token.md
pnpm wp2emdash doctor      # check prerequisites (verifies the token)
pnpm wp2emdash             # interactive wizard: create a site, run phases
```

Or without the wizard:

```bash
pnpm wp2emdash init --slug acme --name "Acme Clinic" --source https://acme.com --sensitive
# tick the (required) items in sites/acme/ACCESS.md
pnpm wp2emdash run acme init
pnpm wp2emdash status
```

## Pipeline

| Phase | Does | Status |
|---|---|---|
| `init` | Workspace, config, access & backup checklist | ✅ |
| `audit` | Crawl live site, snapshots, screenshots, design, menu motion, forms & integrations scan | ✅ |
| `extract` | EmDash Exporter API: raw content, meta, SEO, menus, forms, media download | ✅ |
| `transform` | WPBakery/Salient, Gutenberg, classic → section IR, coverage & text-conservation gate | ✅ |
| `scaffold` | EmDash project: section library, design tokens, header/menu motion, forms, analytics, seed; client README, docs and GitHub CI; builds + local preview | ✅ |
| `load` | Media, content, menus, settings and each page's sharing image into EmDash via its API; idempotent id-map | ✅ local, staging, production (`WP2EMDASH_LOAD_TARGET`) |
| `verify` | Old site vs staging or production, URL by URL: text, headings, SEO (incl. og:image, structured data, sitemap, old sitemap/upload URLs), links, forms, analytics, security, section-by-section visual diff, no sideways scroll, a11y, performance, menu motion; HTML report | ✅ · pilot: every check green except visual (sections still over 3% are being fixed or go to the owner) |
| `cutover` | Preflight (read-only: resources, secrets, Turnstile, zone and DNS record, runbook), then the owner-approved switch: Worker route, smoke, rollback | Preflight ✅ · switch M8 |

Each phase ends in a gate; the next phase won't run until it passes or is accepted with a recorded reason.

## Sharing cards (opt-in)

Every page can get its own branded sharing image (og:image): the site's logo, the page title and the site's colours
and fonts on a 1200×630 card, drawn in the Worker the first time it is asked for and stored in R2. Turn it on per site:

```ts
// sites/<slug>/kit.config.ts
og: { cards: true },
```

The next `scaffold` downloads TrueType copies of the site's fonts, takes the colours from the generated design tokens
and the logo from the brand files, adds the `@wp2emdash/og` package and its two renderer libraries (+1.1 MB gzip to
the Worker), and registers the plugin. After deploying, an admin chooses under **Plugins → Sharing images** whether
cards replace every page's image or only fill in where a page has none (the default), and can preview and redraw
them. Verify downloads every og:image and fails on any that does not load. Details:
[packages/og/README.md](packages/og/README.md).

## SEO panel in the page editor (opt-in)

```ts
// sites/<slug>/kit.config.ts
seo: { panel: true },
```

Adds an **SEO dashboard** (Plugins → SEO: site-wide scores, most common issues, every page with a link to fix it,
image descriptions written in one form, robots.txt / sitemap / indexing checks, a dashboard widget) and an **SEO**
panel to the page editor's sidebar: a score, the Google result preview, a plain-words checklist
(title and description length, duplicates across pages, one H1, heading order, text length, image alt text, links,
address, indexing, sharing image) and an optional focus keyword per page. "Check my unsaved changes" checks the
draft before saving. No effect on visitors; negligible Worker size. Details: [packages/seo/README.md](packages/seo/README.md).

## Docs

- [Plan](docs/PLAN.md)
- [M0 spike findings](docs/spikes/M0-findings.md) · [M3 extract findings](docs/spikes/M3-findings.md) · [M5 starter findings](docs/spikes/M5-findings.md) · [M6 load findings](docs/spikes/M6-findings.md) · [M7 forms, email, SEO, analytics, Salient layout measurements](docs/spikes/M7-findings.md)
- [Site workspaces](sites/README.md)
- [Staging and production setup](docs/staging-setup.md) — resources, build → migrate → deploy, first admin sign-in (passkeys), API token, production on `workers.dev`, troubleshooting
- [Cloudflare API tokens](docs/cloudflare-api-token.md) — the reusable build & staging token and the per-launch go-live token
- [`@wp2emdash/forms`](packages/forms/README.md) — the forms package every migrated site uses (endpoint, email, KV outbox, Form messages admin page); usable in any EmDash project
- [`@wp2emdash/seo`](packages/seo/README.md) — SEO panel in the page editor (score, Google preview, checklist, focus keyword); opt in with `seo: { panel: true }`
- [`@wp2emdash/og`](packages/og/README.md) — branded sharing cards (og:image) rendered in the Worker, per page; opt in with `og: { cards: true }` in a site's `kit.config.ts` (below)
- [Agent rules](CLAUDE.md)

Full GitHub docs (configuration reference, adapters, troubleshooting, …) are produced in milestone M8a.

## Privacy

Client workspaces (`sites/<slug>/`) never enter this repository: only `sites/README.md` is tracked. Credentials live in each workspace's `.env`. The kit only reads from WordPress (GET requests) and never reads form submissions.

## License

MIT — see [LICENSE](LICENSE).
