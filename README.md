# wp2emdash

> Migrates WordPress sites to [EmDash](https://docs.emdashcms.com/) on Cloudflare Workers (D1 + R2) and proves the result with automated gates: content, URLs, SEO, design, forms and integrations.

**Status:** `init` → `verify` run end to end on a real Salient + WPBakery site: 0 unmapped content, 100% of page text carried over, a generated EmDash project loaded idempotently into local, staging and production (`workers.dev`), and a verify report comparing the live WordPress site with the migrated one section by section at phone, tablet and desktop widths. The cutover preflight is implemented and the traffic switch is a command (`wp2emdash golive`, owner-approved with `--yes`) — see [`docs/PLAN.md`](docs/PLAN.md) §13.

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
`WP2EMDASH_MODE=terminal` or `WP2EMDASH_MODE=web` skips the question. The dashboard reviews, approves and takes
secrets; creating a site, recording gates and the launch switch are done in the terminal.

Or without the wizard:

```bash
pnpm wp2emdash init --slug acme --name "Acme Clinic" --source https://acme.com --sensitive
# tick the (required) items in sites/acme/ACCESS.md
pnpm wp2emdash run acme init
pnpm wp2emdash status
pnpm wp2emdash ui          # local dashboard in the browser (--no-open to only print the URL)
```

## Commands

| Command | What it does |
|---|---|
| `wp2emdash` | Interactive wizard (terminal or web dashboard) |
| `wp2emdash init --slug … --name … --source …` | Create `sites/<slug>/` (`--from <slug>` to start from another site's settings) |
| `wp2emdash run <slug> <phase> [--json] [--preview]` | Run a phase; exit 0 pass · 2 gate failed · 3 not built yet · 1 error |
| `wp2emdash run <slug> load --force` | Load into a **live** production (after go-live): records a D1 Time Travel bookmark first and prints the restore command; refused without `--force` |
| `wp2emdash run <slug> load --overwrite-settings` | Also replace site settings (logo, favicon, social links, SEO) an editor changed in the admin since the last load; without it those are kept and reported |
| `wp2emdash accept <slug> <phase> --reason "…" --by "…"` | Record the owner's acceptance of a failed gate |
| `wp2emdash status [slug] [--json]` | Phase timeline |
| `wp2emdash doctor` | Local prerequisites, verifies the Cloudflare token |
| `wp2emdash provision <slug> [production\|staging]` | Create or reuse D1, R2, the form outbox and the `SESSION` KV namespace in the environment's account; record them in `cloudflare.json`. Default `production`; `staging` only for sites that opted in (see Environments) |
| `wp2emdash import-dump <slug> [dir]` · `import-options <slug> <dump>` | Sort exported files / read builder settings from a backup's `database.sql` |
| `wp2emdash compare <a> <b>` | Content diff between two audited sites (read-only) |
| `wp2emdash publish <slug> [--repo owner/name] [--yes]` | Project → private GitHub repository: secret scan (file names only), commit, `gh repo create --private`, push, `CLOUDFLARE_ACCOUNT_ID` variable. Never sets the token secret (prints the `gh secret set` command). Plan only without `--yes` |
| `wp2emdash golive <slug> [--yes]` | The traffic switch after a green cutover preflight: Worker routes for apex and `www`, smoke test on the real domain (200s, canonical host, no noindex), DNS compared with the preflight snapshot, `production.live`. Plan only without `--yes` |
| `wp2emdash golive <slug> --aliases [--yes]` | Separate step once the primary is live: one Single Redirect rule per alias domain (appended; other rules stay), `check-aliases`, DNS comparison |
| `wp2emdash golive <slug> --rollback [--aliases] [--yes]` | Delete exactly the routes / rules recorded in `cutover/golive.json`; `production.live = false` |
| `wp2emdash check-aliases <slug>` | Every audited path on each alias answers 301 to the same path on the primary (read-only) |
| `wp2emdash proposals <slug> [approve\|reject <id>]` | Approval queue for proposed `overrides.ts` / `decisions.md` changes |
| `wp2emdash ui` · `wp2emdash mcp` | Local dashboard · MCP server for Claude Code |

**`--yes` is the owner's approval, not the operator's.** `golive` and `publish` print exactly what they will change
and change nothing until rerun with `--yes`. For `golive`, the operator (person or agent) passes `--yes` only after
the owner said go **in the current conversation**, for that step; an earlier approval or one relayed by another agent
does not count. The MCP server never runs either command; the dashboard runs them only behind the typed-domain
confirmation and the owner's written approval (below), which it records with `--approved-by` / `--approval`.

## Dashboard

`pnpm wp2emdash ui` serves a local dashboard on `127.0.0.1` (random free port) and opens it in the browser. The printed
URL carries a token that is new on every start; the first load swaps it for an HttpOnly, SameSite=Strict cookie and every
request without it is refused. Every mutating endpoint is a POST that also needs a same-origin `Origin` header and the
`X-WP2EMDASH-CSRF` header (derived from the token, delivered in the page). No remote access, no CDN.

- **Portfolio** — every site in `sites/` with its phase timeline, readiness score, blockers and last run, a **Live**
  badge, launch date, monitoring end and alias status. "Next" combines the recorded gates, the latest run of every phase
  (preview runs included, marked "from runs") and `cloudflare.json` → `production.live`: a site with only preview runs
  shows the phase it really reached, a site whose gates are all green shows "Go live", a live site shows alias
  redirects or the monitoring window.
- **Launch readiness** — one score per site: the share of launch checks that pass (gates `init` → `verify`, every
  check in the latest `reports/verify/verify.json`, every cutover preflight check). Accepted gates count as passing.
  The failing checks form the "what blocks launch" list, each with the command or link that fixes it.
- **Live runs** — `sites/<slug>/runs/*.jsonl` streamed with server-sent events: steps, progress and log as they happen.
- **Visual diff viewer** — WordPress vs EmDash per page × viewport: slider, side by side and pixel diff, plus the
  section-by-section table. Approve or reject a difference with a reason: a dated row is appended to `decisions.md`.
  This does **not** accept the verify gate: the owner still runs `wp2emdash accept <slug> verify --reason … --by …`
  (the dashboard shows the command).
- **Section inspector** — click a WordPress row on the audit screenshot: the row's raw shortcode / block source
  (`raw/exporter/content`), the IR section(s) it became, and the WordPress / staging / difference crops from verify.
  "Change section type" and "drop row" create a **proposal** that patches `overrides.ts` → `elements` (never `ir/`).
- **Approval queue** — `sites/<slug>/proposals/*.json` (from Claude via `wp2emdash mcp`, or from the inspector), pending
  first, with the summary, file, the unified diff (shown as text) and the phase to rerun. Approve or reject with your
  name and an optional note: approve applies the diff (a patch that no longer applies is marked failed and nothing is
  written). After approving, the dashboard can start a **preview** run of `transform`, `scaffold` or `verify` (gate not
  recorded) and stream it; it never starts `load` or `cutover`. The command that records the gate is shown.
- **Secrets** — a form per site that writes one allow-listed key at a time to `sites/<slug>/.env` (migration key, app
  password, EmDash tokens and encryption keys, email key, production Turnstile/Cloudflare values, go-live token), with
  format checks where the format is known. Values are **write-only**: never returned, logged or streamed; the page shows
  only "set / not set" and a fingerprint (first 8 hex of the SHA-256). Other lines and comments are kept, the file stays
  mode 600, values with line breaks are refused. Reminds you to revoke the app password once extract has run.
- **Owner checklist** — `ACCESS.md` as sections with items, required markers and the generated "Plugin data" section.
  Read-only: ticking stays in the file.
- **Launch cockpit** — the last cutover preflight, the go-live prerequisites, the runbook and the commands, plus the
  owner-approved steps **Go live**, **Add alias redirects**, **Roll back** and **Roll back alias redirects**. "Show plan"
  runs `golive … --json` without `--yes` (what will change: routes, alias rules, Site URL, live flag; blockers). Each
  step needs the production domain typed exactly, the tick "The owner approved this in writing", the approval as
  written (who, when, where) and your name — checked again on the server. The approval is appended to `decisions.md`
  and recorded in `cutover/golive.json` → `approvals`; then `wp2emdash golive … --yes` runs as a child process and
  streams like a run. Also shown: recorded route / rule ids, the smoke result, the last DNS comparison, DNS snapshots,
  approvals and history.
- **Publish** — repository, CI runs (`gh run list`, when gh is available), a dry run (`publish --json`: the file list
  and the secret scan, file names only) and "Publish" (`publish --yes`) behind the same confirmation. It never sets the
  `CLOUDFLARE_API_TOKEN` secret: the `gh secret set` command is shown to run by hand.
- **Environment** — single environment or opt-in staging, workers.dev address, live domain and date, resources, last
  load, the `load --force` rule once live, the preview-URL flow and where form messages go.
- **Worker secrets** (Secrets tab, per environment) — for each runtime secret (`EMDASH_ENCRYPTION_KEY`,
  `EMAIL_API_KEY`, `TURNSTILE_SECRET_KEY`, anything in the project's `.dev.vars.example`): "saved locally" (which `.env`
  key, fingerprint) and "set on Worker" (Cloudflare API, names only). "Set on Worker" pipes the local value into
  `wrangler secret put` on stdin; on a live production it needs the typed domain. Operator credentials (build and
  go-live tokens, EmDash tokens, WordPress key) are local-only: presence, fingerprint, Cloudflare token-verify status
  and expiry, and the reminder to revoke the go-live token after the monitoring window.

Long-running actions run one at a time per site and are logged to `runs/<runId>.jsonl` (phase `golive`, `publish`,
`secret-put`, … — never a pipeline gate). What it writes: rows in `decisions.md` (visual decisions, approved proposals,
launch / publish approvals), `overrides.ts` (approved proposals only), new files in `proposals/`, keys in `.env`, and
what the owner-approved commands write themselves. Everything it returns passes through the site's secret scrubber (no
`.env` value leaves the server). It serves files only from `reports/` and `snapshot/screens/`, never changes DNS, and
never accepts a gate.

## Claude Code

The kit ships a stdio MCP server and four skills, so Claude Code can drive the pipeline while the owner keeps every
decision.

**MCP server** — `pnpm wp2emdash mcp`. Tools: `status`, `run_phase`, `read_report`, `list_diagnostics`, `explain_gate`,
`propose_override`. `run_phase` runs init → verify and any preview run; `load`/`verify` only against `local` or
`staging` (a single-environment site's default target, production, falls back to `local` there); `cutover` only as its
read-only preflight. Anything that would deploy to production or change DNS / Worker
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
| `transform` | WPBakery/Salient, Gutenberg, classic, Bricks 2.4–2.5 (elements, global classes, palette, components, header/footer/popup templates, forms; not yet measured on a live Bricks site) → section IR, coverage & text-conservation gate; announcement/top bars (Announcer, WPFront Notification Bar, Salient secondary header, Astra above-header; other bar-like rows reported for a decision) rebuilt from the live HTML as an editable site part above the header | ✅ |
| `scaffold` | EmDash project: section library, design tokens, header/menu motion, forms, analytics, seed; client README, docs and GitHub CI; builds + local preview | ✅ |
| `load` | Media, content, menus, settings and each page's sharing image into EmDash via its API; idempotent id-map. Default target: production (workers.dev) on a provisioned single-environment site, else local; after go-live only with `--force` + a D1 bookmark | ✅ local, staging, production (`WP2EMDASH_LOAD_TARGET`) |
| `verify` | Old site vs production (default, single environment) or staging, URL by URL: text, headings, SEO (incl. og:image, structured data, sitemap, old sitemap/upload URLs), links, forms, analytics, security, section-by-section visual diff, no sideways scroll, a11y, performance, menu motion; HTML report | ✅ · pilot: every check green except visual (sections still over 3% are being fixed or go to the owner) |
| `cutover` | Preflight (read-only: resources, secrets, Turnstile, go-live token separate and zone-scoped, zone and DNS record, alias domains, runbook), then the owner-approved switch with `wp2emdash golive`: Worker routes, smoke, `production.live`, rollback; alias domains → one Single Redirect rule each, `check-aliases` (README "Two sites, one domain") | Preflight ✅ · `golive` built and unit-tested (mocked Cloudflare), not yet run on a launch |

Each phase ends in a gate; the next phase won't run until it passes or is accepted with a recorded reason.

## Environments

**One Cloudflare environment per site by default: production**, deployed to its `workers.dev` address until go-live
(owner decision 2026-11-20). The client reviews the real site there; nothing public changes until `golive` adds the
Worker routes. Staging is opt-in. Details and commands: [docs/staging-setup.md](docs/staging-setup.md), docs/PLAN.md §7a.

| | Single environment (default) | Opt-in staging (`target.staging: true`) |
|---|---|---|
| Cloudflare | `<slug>` Worker, `<slug>-db`, `<slug>-media`, outbox + session KV | the same, plus `<slug>-staging` with its own D1/R2/KV/secrets |
| Before go-live | production on workers.dev: `noindex`, no analytics, form messages are tests | staging for review; production on workers.dev before the switch |
| `load` / `verify` default | production once provisioned (else local) | load: local; verify: staging |
| Form test messages | any host but the domain (workers.dev, preview URLs) → `email.stagingTo` only, `[Test]` subject, never the client, also from the outbox after launch | staging → `email.stagingTo` only |
| Client CI on push to `main` | deploys production until go-live (`target.ciDeploy`), manual after | deploys staging; production manual |
| After go-live | content edited in the admin; `load --force` takes a D1 Time Travel bookmark first; code changes via Workers preview URLs (`pnpm versions:upload` → `pnpm versions:deploy`) — previews share production's data, so code/layout review only | as before, plus staging |
| EmDash token | `EMDASH_TOKEN_PRODUCTION` (`EMDASH_TOKEN` accepted as an alias) | `EMDASH_TOKEN` = staging, `EMDASH_TOKEN_PRODUCTION` = production |

**Opt into staging** when the client signs off big changes on a copy of the data (redesigns, EmDash upgrades with
migrations), when the site takes bookings, payments or sensitive data (tests must not touch production records), or
when many editors share the admin. Sites that already had staging (a `target.stagingUrl`, or staging resources in
`cloudflare.json`) keep it unchanged; `target.staging: false` turns it off.

## Two sites, one domain

For a client with two near-identical WordPress installs on two domains (both indexed, each canonical to itself):
migrate one (the **primary**), merge what only the other has, then make the other domain (the **alias**) a
permanent, path-preserving 301 to the primary. Nothing below writes to either WordPress site or changes DNS.

1. **Pick the primary from data**: Search Console → Performance for both properties (clicks, impressions, which
   queries and pages rank) plus backlinks; the domain with more search equity, or the brand the owner keeps, wins.
   Record the choice in the primary's `decisions.md`.
2. **Workspaces**: the primary as usual (`init`), then the alias from it so both share the same settings:
   ```bash
   pnpm wp2emdash init --slug acme-old --name "Acme (old domain)" --source https://acme-old.com --from acme
   ```
   `--from` copies only `kit.config.ts` (slug, name, `source.url`, `target.productionUrl` replaced, `projectDir`
   and `stagingUrl` removed, a comment saying where it came from), `overrides.ts` and `decisions.md` (with a dated
   "started from" row). Never `.env`, `raw/`, `dump/`, `snapshot/`, `ir/`, `reports/`, `runs/`, `cutover/`,
   `cloudflare.json` or `state.json`. The wizard offers the same ("Start from: an existing site").
3. **Audit the alias, read-only**: `pnpm wp2emdash run acme-old init`, then `… run acme-old audit` (public pages only,
   no credentials). The alias workspace never goes past audit.
4. **Compare**: `pnpm wp2emdash compare acme acme-old` (read-only, no network) → `sites/acme-old/reports/compare/acme.md`
   and `.json`: pages only on one side; for matched paths, distinct-word similarity with a verdict (identical /
   minor ≥ 98% / differs), sentences and words found on one side only, title/description/canonical/H1, forms
   (provider, id, field types) and external links (booking, social, phone, email).
5. **Merge unique content into the primary**: pages or sections only on the alias go into the primary through
   `overrides.ts` / `decisions.md` and a rerun, or in the EmDash admin after load — never by hand-editing `ir/`.
   Record each choice (kept, merged, dropped) in `decisions.md`.
6. **Set the alias** in the primary's `kit.config.ts`:
   ```ts
   target: { productionUrl: "https://acme.com", aliasDomains: ["acme-old.com"] /* www. included */ },
   ```
7. **Preflight**: add the alias zone to the go-live token (Zone Read, DNS Read, Single Redirect Read; Single
   Redirect Edit on launch day — docs/cloudflare-api-token.md) and run `pnpm wp2emdash run acme cutover`. Per alias
   it checks the zone, snapshots DNS to `cutover/dns-before.acme-old.com.json` with mail records flagged (MX, SPF,
   DKIM, DMARC, autodiscover — they stay untouched), checks apex and www are proxied and lists existing redirect
   rules. `cutover/runbook.md` §4 has the exact calls.
8. **Go-live** (owner approval at each step): switch the primary first (`pnpm wp2emdash golive acme`, then `--yes`;
   §1 of the runbook) and verify it; then per alias create its one Single Redirect rule (apex + www →
   `https://acme.com` + same path, query kept, 301) — `pnpm wp2emdash golive acme --aliases`, then `--yes`, appends it
   to the zone's existing redirect rules and runs the check below and a DNS comparison — or by hand, and run
   ```bash
   pnpm wp2emdash check-aliases acme --paths-from acme-old    # every audited path, apex and www, no redirect followed
   ```
   which must show a 301 to the same path on the primary for every URL (it reports 200, 404, 302 and chains).
   Rollback: `pnpm wp2emdash golive acme --rollback --aliases --yes` (or delete that rule by id, runbook). No DNS record
   changes, so the alias domain's email is unaffected.
9. **Change of Address**: in the alias's Search Console property, Settings → Change of address → the primary; submit
   the primary's sitemap; update Google Business Profile, social profiles, booking and other third-party links.
   Keep the alias domain registered (auto-renew) and its redirect rule in place for good — at least 180 days.
10. **Monitor** for `target.cutover.monitorDays`: rerun `check-aliases`, watch both Search Console properties (the
    alias's pages drop out, the primary picks them up) and the primary's 404 log.

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

## One folder for everything

The fastest start: ask the owner (or do it yourself in WordPress admin) for every export in one folder,
`sites/<slug>/dump/` — inside the site workspace, so it is gitignored and never leaves your machine:

- the plugin exports the audit lists in `ACCESS.md` (forms, redirects, SEO settings)
- builder and theme settings (Bricks settings and theme styles, Salient options, Automatic.css settings)
- a full backup, unzipped, with its `database.sql` (and, for reference, plugins and themes — useful when a
  third-party element pack needs mapping)

Then run:

```bash
pnpm wp2emdash import-dump <slug>
```

It sorts every file by its content: plugin exports into `raw/plugin-exports/` (read by extract), builder settings into
`raw/`, and from the database dump only the allow-listed builder options (Bricks palette, global classes, theme styles,
components) with anything that looks like a credential left out. Every file is listed with what it was used for; files
it does not recognise are named, never guessed. Inside a backup, uploads, form uploads, plugins and caches are counted,
never opened — form entries are never read. With Claude Code (see below), the same folder is what the agent inspects to
map unknown elements: give it the plugin's source from the backup and the audit's screenshots, and it proposes the
handler with a fixture and a test. Delete the folder when the project ends.

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

## Form messages (outbox and inbox)

With `forms.outbox` in a site's `kit.config.ts`, messages that cannot be emailed are kept in Workers KV, retried by the
Worker's cron and shown to admins under **Plugins → Form messages** (inbox, insights, export/import, activity,
recipients). By default a message is deleted once emailed, so the inbox only ever shows what is still waiting. An owner
who wants to see every message there can opt in to a full inbox:

```ts
// sites/<slug>/kit.config.ts
forms: { outbox: { days: 30, keepSent: true } },   // → FORM_OUTBOX_KEEP_SENT="1" in both environments
```

Every message is then kept, marked **Emailed**, **Waiting** or **Failed**, until `days` ends — with a status filter,
"Email again", and the newest messages on the dashboard widget. This is a **data-retention decision**: what visitors
wrote stays in the site for the retention period even after it was emailed. Record it in the site's `decisions.md`;
on sites with `sensitiveData: true` leave it off unless the owner explicitly asks for an inbox. Details:
[`packages/forms/README.md`](packages/forms/README.md#configuration-wranglerjsonc-per-environment--environments-do-not-inherit).

## Sharing cards (on by default)

Every page can get its own branded sharing image (og:image): the site's logo, the page title and the site's colours
and fonts on a 1200×630 card, drawn in the Worker the first time it is asked for and stored in R2. It is on for every
site; to leave it out:

```ts
// sites/<slug>/kit.config.ts
og: { cards: false },
```

The next `scaffold` downloads TrueType copies of the site's fonts, takes the colours from the generated design tokens
and the logo from the brand files, adds the `@wp2emdash/og` package and its two renderer libraries (+1.1 MB gzip to
the Worker), and registers the plugin. After deploying, an admin chooses under **Plugins → Sharing images** whether
cards replace every page's image or only fill in where a page has none (the default), and can preview and redraw
them. Verify downloads every og:image and fails on any that does not load. Details:
[packages/og/README.md](packages/og/README.md).

## Site settings (EmDash's Settings screens)

EmDash's own **Settings → General, Social Links and SEO** come prefilled from the WordPress site, and the starter reads
them on every page, so editors change the logo, favicon, social profiles, verification tags, default social image and
robots.txt in the admin and the live site follows within seconds (the save purges cached pages):

| Setting | From WordPress | The starter |
|---|---|---|
| Logo, favicon | brand files captured from the live header (`public/brand`), else `custom_logo` / `site_icon` | header, menu sheet, structured data; favicon + apple-touch icon. While the setting is the migrated file, the optimized brand files stay (hashed WebP, sized favicons, light logo over the hero) |
| Posts per page, date format, timezone | `posts_per_page`, `date_format` (→ date-fns), `timezone_string` / `gmt_offset` | (EmDash's own use) |
| Social Links | Rank Math / Yoast social options, home-page JSON-LD `sameAs`, social links in the header/footer | footer social links/icons and the menu sheet's icons point at them; a network missing from the footer's icon row is added; JSON-LD `sameAs` |
| Default social image | Rank Math / Yoast default, else the og:image most pages share | og:image of pages without their own (EmDash's head) with its size |
| Google / Bing verification | audited page head, else the SEO plugin | printed by EmDash's head; `site.config.json` → `verification` is the fallback and keeps other services' tags |
| robots.txt | the live file's own rules (WordPress-only rules dropped, sitemap at the new domain); none → EmDash's default | served by EmDash |

Every value and its source is in the transform coverage report. `load` never overwrites a value an editor changed
after the previous load (`--overwrite-settings` does). Facts and limits: [settings findings](docs/spikes/settings-findings.md).

## SEO suite (on by default)

Technical SEO is part of every migration (titles, descriptions, canonicals, robots, sitemap, structured data, old
URLs redirected, analytics, verification tags — and verify checks all of it). On top of that, a site can get an SEO
toolkit for its editors, as the EmDash plugin `@wp2emdash/seo`, on for every site; to leave it out:

```ts
// sites/<slug>/kit.config.ts
seo: { panel: false },
```

| Part | Where | What it does |
|---|---|---|
| **SEO panel** | Page editor sidebar (contributors and up) | Score out of 100, Google result preview with cut-off warnings, plain-words checklist (title and description length, duplicates across pages, one H1, heading order, text length, image alt text, links, address, indexing, canonical, sharing image), focus keyword per page, "Check my unsaved changes". |
| **SEO dashboard** | Plugins → SEO, dashboard widget (editors and admins) | Average score and a score per page, the most common issues and where they are, every page with a link to fix it, every image without a description with a form that writes alt text to the media library, robots.txt / sitemap / indexability checks (environment-aware). |
| **Google Search Console** | SEO dashboard → Google | Connected once with a service account (key stored encrypted): clicks, impressions, click rate, position, daily chart, top searches and pages, sitemaps (submit), index status per page. Works before go-live. |
| **IndexNow** | SEO dashboard → IndexNow | After go-live, publishing a page notifies Bing, Yandex and the other IndexNow engines; key file at the domain root; notification log; notify-all button. |
| **Analytics** | SEO & Analytics → Analytics (changes: admins) | Tracking codes by ID only — GA4, Google tag, Google Ads, Tag Manager, Meta Pixel, Microsoft Clarity, Hotjar, Cloudflare Web Analytics — prefilled with everything the audit found on the old site (retired `UA-` listed, never loaded); on/off, edit, remove; conversion events as switches (form sent, phone/email, booking links, outbound) with no visitor data; consent mode (off; hook for a future banner); Google/Bing verification points to EmDash's Settings → SEO, other carried tags listed read-only. Saving purges cached pages: live within seconds. The site loads trackers on the production domain only, never for signed-in editors, and its CSP allows exactly the switched-on services (one host table, `packages/seo/src/analytics/csp.ts`). |
| **Visits** | SEO & Analytics → Visits, dashboard widget (admins), page editor | Cloudflare Web Analytics, last 7 days: visits, page views, daily chart, top pages, referrers; each page's views in its SEO box. Needs the Worker secret `CF_ANALYTICS_TOKEN` (Account Analytics: Read); the site tag is looked up at scaffold. |

No effect on visitors and negligible Worker size. The site checks call the Worker through a `SELF` service binding the
scaffold adds (a Worker fetching its own address would skip itself). Details: [packages/seo/README.md](packages/seo/README.md).

## Performance (on by default)

Every generated site ships a performance package (`src/scaffold/perf.ts`; facts and measurements in
[docs/spikes/performance-findings.md](docs/spikes/performance-findings.md)):

- **Route caching.** Rendered pages are kept in Cloudflare's Workers cache next to visitors (Astro route caching,
  `cacheCloudflare()`); a cached page answers like a static file (staging: 80 ms on a warm connection instead of
  0.8–1.8 s far from the database). One route rule per public page plus the sitemaps, tagged with EmDash collection
  names; the page also sets the tags of the chrome it shows (settings, menus, footer and announcement site parts,
  popups), so a publish or a menu/settings save purges the affected pages within seconds. 404s, redirects, signed-in
  editors and previews are never cached; browsers always revalidate HTML (`no-cache`).
- **Warm-up after deploy.** Each deploy starts with an empty cache (`cross_version_cache: false`: new templates at
  once); the deploy scripts and CI then run `scripts/warm.mjs`, which requests every sitemap URL and the image sizes
  those pages use.
- **Images.** Responsive `srcset`/`sizes` through EmDash's `/_image` endpoint (Cloudflare Images binding, no zone
  setting; a failed transform falls back to the original file), width/height on every image the starter renders,
  the logo as WebP sized for the header and small favicons, fonts and brand files cached by browsers for a year
  under content-hashed names.
- **Background video.** The picture paints first (LCP); the video is attached after load when the browser is idle,
  and not at all on phones (< 768 px), with Save-Data or reduced motion.
- **Announcement schedules** are checked in the browser (the inline script is allowed by its hash in the CSP, never
  `'unsafe-inline'`), and a cached page lives no longer than the bar's next start or end.
- **Verify** gates it on the deployed target: every page `cf-cache-status: HIT` on its second request, cached home
  page TTFB ≤ `gates.maxCachedTtfbMs` (600 ms, measured from the machine running verify — geography matters), home
  page ≤ `gates.maxPayloadKb` (1500 KB) until load with no video fetched.

Opt-outs, per site:

```ts
// sites/<slug>/kit.config.ts
performance: { routeCache: false },        // render every page per request (also turns off the warm-up)
performance: { responsiveImages: false },  // original image files only (no Images transformations)
performance: { warmup: false },            // no warm-up after deploy
performance: { maxAge: 600, swr: 3600 },   // shorter cache lifetime (seconds)
```

Smart Placement stays off (`performance: { smartPlacement: true }` to try it): see the findings for why.

## Docs

- [Plan](docs/PLAN.md)
- [M0 spike findings](docs/spikes/M0-findings.md) · [M3 extract findings](docs/spikes/M3-findings.md) · [M5 starter findings](docs/spikes/M5-findings.md) · [M6 load findings](docs/spikes/M6-findings.md) · [M7 forms, email, SEO, analytics, Salient layout measurements](docs/spikes/M7-findings.md) · [Announcement bar markup](docs/spikes/announcement-findings.md) · [M8 go-live findings (SESSION binding, go-live token)](docs/spikes/M8-findings.md) · [Analytics in the SEO suite (storage, purge, CSP hosts, GraphQL)](docs/spikes/analytics-findings.md) · [Site settings (schema, head tags, robots.txt, brand files)](docs/spikes/settings-findings.md)
- [Site workspaces](sites/README.md)
- [Environment setup](docs/staging-setup.md) — production on `workers.dev` (default) and opt-in staging: resources, build → migrate → deploy, first admin sign-in (passkeys), API token, CI, after go-live (`load --force`, preview URLs), troubleshooting
- [Single-environment findings](docs/spikes/single-env-findings.md) — D1 Time Travel and Workers preview URLs checked against Wrangler 4.163.0
- [Cloudflare API tokens](docs/cloudflare-api-token.md) — the reusable build token and the per-launch go-live token
- [`@wp2emdash/forms`](packages/forms/README.md) — the forms package every migrated site uses (endpoint, email, KV outbox, Form messages admin page); usable in any EmDash project
- [`@wp2emdash/seo`](packages/seo/README.md) — SEO & Analytics suite: editor panel, dashboard, Google Search Console, IndexNow, tracking codes, conversion events, consent mode, Visits; on by default (`seo: { panel: false }` turns it off; `analytics: false` carries and loads no trackers)
- [`@wp2emdash/og`](packages/og/README.md) — branded sharing cards (og:image) rendered in the Worker, per page; on by default (`og: { cards: false }` in a site's `kit.config.ts` turns them off)
- [Agent rules](CLAUDE.md)

Full GitHub docs (configuration reference, adapters, troubleshooting, …) are produced in milestone M8a.

## Privacy

Client workspaces (`sites/<slug>/`) never enter this repository: only `sites/README.md` is tracked. Credentials live in each workspace's `.env`. The kit only reads from WordPress (GET requests) and never reads form submissions.

## License

MIT — see [LICENSE](LICENSE).
