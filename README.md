# wp2emdash

> Migrates WordPress sites to [EmDash](https://docs.emdashcms.com/) on Cloudflare Workers (D1 + R2) and proves the result with automated gates: content, URLs, SEO, design, forms and integrations.

**Status:** `init` → `verify` run end to end on a real Salient + WPBakery site: 0 unmapped content, 100% of page text carried over, a generated EmDash project loaded idempotently into local, staging and production (`workers.dev`), and a verify report comparing the live WordPress site with the migrated one section by section at phone, tablet and desktop widths. The cutover preflight is implemented; the traffic switch waits for the owner's approval — see [`docs/PLAN.md`](docs/PLAN.md) §13.

**Requires:** Node.js 24+ and pnpm. Generated sites run on Cloudflare Workers (Workers Paid plan — the EmDash Worker is above the free plan's 3 MB limit) with the latest Astro that EmDash supports.

## Quick start

```bash
pnpm install
cp .env.example .env       # Cloudflare token: see docs/cloudflare-api-token.md
pnpm wp2emdash doctor      # check prerequisites (verifies the token)
pnpm wp2emdash             # asks how you want to work: Terminal or Web dashboard
```

**Terminal or web.** The first question is how you want to work: **Terminal** (guided steps: create a site, run
each phase, accept gates) or **Web dashboard** (opens in the browser: every site, launch readiness, live runs and
the visual review). The choice is remembered on this machine (`.wp2emdash.local.json`, not committed);
`WP2EMDASH_MODE=terminal` or `WP2EMDASH_MODE=web` skips the question. In v1 the dashboard reads and reviews;
creating a site and running phases are done in the terminal.

Or without the wizard:

```bash
pnpm wp2emdash init --slug acme --name "Acme Clinic" --source https://acme.com --sensitive
# tick the (required) items in sites/acme/ACCESS.md
pnpm wp2emdash run acme init
pnpm wp2emdash status
pnpm wp2emdash ui          # local dashboard in the browser (--no-open to only print the URL)
```

## Dashboard

`pnpm wp2emdash ui` serves a local dashboard on `127.0.0.1` (random free port) and opens it in the browser. The printed
URL carries a token that is new on every start; the first load swaps it for an HttpOnly, SameSite=Strict cookie and every
request without it is refused. No remote access, no CDN, no Cloudflare calls.

- **Portfolio** — every site in `sites/` with its phase timeline, next gate, readiness score, blockers and last run.
- **Launch readiness** — one score per site: the share of launch checks that pass (gates `init` → `verify`, every
  check in the latest `reports/verify/verify.json`, every cutover preflight check). Accepted gates count as passing.
  The failing checks form the "what blocks launch" list, each with the command or link that fixes it.
- **Live runs** — `sites/<slug>/runs/*.jsonl` streamed with server-sent events: steps, progress and log as they happen.
- **Visual diff viewer** — WordPress vs EmDash per page × viewport: slider, side by side and pixel diff, plus the
  section-by-section table. Approve or reject a difference with a reason: a dated row is appended to `decisions.md`.
  This does **not** accept the verify gate: the owner still runs `wp2emdash accept <slug> verify --reason … --by …`
  (the dashboard shows the command).

Read-only otherwise: it serves only images from the site's `reports/` and `snapshot/screens/`, never runs phases and
never writes `.env`.

## Claude Code

The kit ships a stdio MCP server and four skills, so Claude Code can drive the pipeline while the owner keeps every
decision.

**MCP server** — `pnpm wp2emdash mcp`. Tools: `status`, `run_phase`, `read_report`, `list_diagnostics`, `explain_gate`,
`propose_override`. `run_phase` runs init → verify and any preview run; `load`/`verify` only against `local` or
`staging`; `cutover` only as its read-only preflight. Anything that would deploy to production or change DNS / Worker
routes is refused. Results never include `.env` contents, and values from the kit and site `.env` are scrubbed out.

Register it:

- **In the kit:** the checked-in `.mcp.json` registers it as a project server. Claude Code asks you to approve it the
  first time.
- **From anywhere** (e.g. a site's own repo):
  `claude mcp add wp2emdash -- pnpm --silent --dir /path/to/wp-to-emdash-kit wp2emdash mcp`
  (keep `--silent`, because stdout is the protocol channel).

**Approval queue** — `propose_override` never edits a file. It writes `sites/<slug>/proposals/<id>.json` (a unified
diff for `overrides.ts` or `decisions.md`, checked to apply cleanly). The owner decides:

```bash
pnpm wp2emdash proposals <slug>                       # pending proposals (--all for decided ones, --json)
pnpm wp2emdash proposals <slug> approve <id> --by "…" # applies the patch, prints the rerun command
pnpm wp2emdash proposals <slug> reject <id> --by "…" --note "…"
```

**Skills** (in `skills/`): `wp2emdash-run` (phase by phase, stop and explain red gates), `wp2emdash-map` (coverage
items → adapter handler + fixture, or an override proposal), `wp2emdash-visual-fix` (red visual sections → measured
cause → fix → new numbers), `wp2emdash-cutover` (preflight and go-live with the owner's confirmation at every
irreversible step). Install them for yourself or for a project:

```bash
cp -R skills/wp2emdash-* ~/.claude/skills/              # every project
cp -R skills/wp2emdash-* <project>/.claude/skills/      # one project (e.g. a site repo)
```

Claude never accepts a gate (only `wp2emdash accept` with the owner's reason) and never writes `overrides.ts` /
`decisions.md` directly.

## Pipeline

| Phase | Does | Status |
|---|---|---|
| `init` | Workspace, config, access & backup checklist | ✅ |
| `audit` | Crawl live site, snapshots, screenshots, design, menu motion, forms & integrations scan | ✅ |
| `extract` | EmDash Exporter API: raw content, meta, SEO, menus, forms, media download | ✅ |
| `transform` | WPBakery/Salient, Gutenberg, classic, Bricks 2.4–2.5 (elements, global classes, palette, components, header/footer/popup templates, forms; not yet measured on a live Bricks site) → section IR, coverage & text-conservation gate | ✅ |
| `scaffold` | EmDash project: section library, design tokens, header/menu motion, forms, analytics, seed; client README, docs and GitHub CI; builds + local preview | ✅ |
| `load` | Media, content, menus, settings and each page's sharing image into EmDash via its API; idempotent id-map | ✅ local, staging, production (`WP2EMDASH_LOAD_TARGET`) |
| `verify` | Old site vs staging or production, URL by URL: text, headings, SEO (incl. og:image, structured data, sitemap, old sitemap/upload URLs), links, forms, analytics, security, section-by-section visual diff, no sideways scroll, a11y, performance, menu motion; HTML report | ✅ · pilot: every check green except visual (sections still over 3% are being fixed or go to the owner) |
| `cutover` | Preflight (read-only: resources, secrets, Turnstile, zone and DNS record, runbook), then the owner-approved switch: Worker route, smoke, rollback | Preflight ✅ · switch M8 |

Each phase ends in a gate; the next phase won't run until it passes or is accepted with a recorded reason.

## Where each site lives

`sites/<slug>/` holds the kit's working data for a client: config, `.env`, raw exports, audit snapshots, IR, reports
(all gitignored). The deployable project — the client's own repository — is generated in `sites/<slug>/project` by
default. To keep it with the client's other files instead, set `projectDir` in `sites/<slug>/kit.config.ts`:

```ts
projectDir: "~/Projects/Acme/emdash", // a plain string: ~ = home, relative = from sites/<slug>
```

Every phase then reads and writes the project there; `pnpm wp2emdash status` shows the path. Scaffold refuses to
write into a folder that already holds something other than this kit's project. To move an existing project: move
the folder, set `projectDir`, run `pnpm install` in it once (pnpm's helper scripts keep absolute paths).

## Plugin data (forms and redirects)

The REST API does not expose most plugins' settings. After the audit, `ACCESS.md` gets a **Plugin data** section
listing, for every forms or redirects plugin it found, the exact export steps in WordPress admin. The owner exports;
the files go in `sites/<slug>/raw/plugin-exports/` (any file name). `extract` recognises each file by its content:

| Plugin | Export | Becomes |
|---|---|---|
| Fluent Forms | read over REST automatically; Tools → Export Forms as a fallback | site form |
| Gravity Forms | Forms → Import/Export → Export Forms (.json) | site form |
| WPForms | WPForms → Tools → Export → Form Exports (.json) | site form |
| Contact Form 7 | Tools → Export → Contact Forms (.xml) | site form |
| Redirection | Tools → Redirection → Import/Export → Everything, JSON | EmDash redirects |
| Rank Math | Redirections → Export (.htaccess or Nginx) | EmDash redirects |
| Yoast SEO Premium | Redirects → Export (.csv); any `from,to,code` CSV works too | EmDash redirects |

Forms keep their fields, labels, required flags, options, button text and success message. Notification recipients
stay in `raw/` and are set in the site's admin (Form messages → Settings), never written into the project. `load`
imports the redirects into EmDash (group `wordpress`, so a rerun updates them and never touches redirects added in the
admin). Rules EmDash cannot hold (conditional rules, complex regular expressions, redirects to another site) are
listed in `raw/redirects.json` → `unconverted` and fail the extract gate until handled or accepted: nothing is dropped
silently. Ninja Forms and Formidable exports are flagged for a rebuild by hand.

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

## SEO suite (opt-in)

Technical SEO is part of every migration (titles, descriptions, canonicals, robots, sitemap, structured data, old
URLs redirected, analytics, verification tags — and verify checks all of it). On top of that, a site can get an SEO
toolkit for its editors, as the EmDash plugin `@wp2emdash/seo`:

```ts
// sites/<slug>/kit.config.ts
seo: { panel: true },
```

| Part | Where | What it does |
|---|---|---|
| **SEO panel** | Page editor sidebar (contributors and up) | Score out of 100, Google result preview with cut-off warnings, plain-words checklist (title and description length, duplicates across pages, one H1, heading order, text length, image alt text, links, address, indexing, canonical, sharing image), focus keyword per page, "Check my unsaved changes". |
| **SEO dashboard** | Plugins → SEO, dashboard widget (editors and admins) | Average score and a score per page, the most common issues and where they are, every page with a link to fix it, every image without a description with a form that writes alt text to the media library, robots.txt / sitemap / indexability checks (environment-aware). |
| **Google Search Console** | SEO dashboard → Google | Connected once with a service account (key stored encrypted): clicks, impressions, click rate, position, daily chart, top searches and pages, sitemaps (submit), index status per page. Works before go-live. |
| **IndexNow** | SEO dashboard → IndexNow | After go-live, publishing a page notifies Bing, Yandex and the other IndexNow engines; key file at the domain root; notification log; notify-all button. |

No effect on visitors and negligible Worker size. The site checks call the Worker through a `SELF` service binding the
scaffold adds (a Worker fetching its own address would skip itself). Details: [packages/seo/README.md](packages/seo/README.md).

## Docs

- [Plan](docs/PLAN.md)
- [M0 spike findings](docs/spikes/M0-findings.md) · [M3 extract findings](docs/spikes/M3-findings.md) · [M5 starter findings](docs/spikes/M5-findings.md) · [M6 load findings](docs/spikes/M6-findings.md) · [M7 forms, email, SEO, analytics, Salient layout measurements](docs/spikes/M7-findings.md)
- [Site workspaces](sites/README.md)
- [Staging and production setup](docs/staging-setup.md) — resources, build → migrate → deploy, first admin sign-in (passkeys), API token, production on `workers.dev`, troubleshooting
- [Cloudflare API tokens](docs/cloudflare-api-token.md) — the reusable build & staging token and the per-launch go-live token
- [`@wp2emdash/forms`](packages/forms/README.md) — the forms package every migrated site uses (endpoint, email, KV outbox, Form messages admin page); usable in any EmDash project
- [`@wp2emdash/seo`](packages/seo/README.md) — SEO suite: editor panel, SEO dashboard, Google Search Console, IndexNow; opt in with `seo: { panel: true }` (above)
- [`@wp2emdash/og`](packages/og/README.md) — branded sharing cards (og:image) rendered in the Worker, per page; opt in with `og: { cards: true }` in a site's `kit.config.ts` (below)
- [Agent rules](CLAUDE.md)

Full GitHub docs (configuration reference, adapters, troubleshooting, …) are produced in milestone M8a.

## Privacy

Client workspaces (`sites/<slug>/`) never enter this repository: only `sites/README.md` is tracked. Credentials live in each workspace's `.env`. The kit only reads from WordPress (GET requests) and never reads form submissions.

## License

MIT — see [LICENSE](LICENSE).
