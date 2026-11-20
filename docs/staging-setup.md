# Environment setup: production on workers.dev, and opt-in staging

The steps between `scaffold` (a project that builds locally) and a loaded site on Cloudflare. Most are run once per
site. Facts behind each step: `docs/spikes/M6-findings.md`, `docs/spikes/single-env-findings.md`.

**One environment by default** (owner decision 2026-11-20, docs/PLAN.md §7a): each site gets **production** only. It
answers on its `workers.dev` address until go-live (unlisted, `noindex`, analytics off, form messages are tests), so
the client reviews the real thing, and the switch-over only adds Worker routes. **Staging is opt-in** (§8 below).

**Before you start:** Workers Paid plan on the Cloudflare account, the reusable build token in the kit `.env`
([cloudflare-api-token.md](cloudflare-api-token.md)) and `pnpm wp2emdash doctor` showing it *active*.

| | Single environment (default) | Opt-in staging |
|---|---|---|
| Config | nothing (or `target.staging: false`) | `target.staging: true` (or `{ enabled: true, protection, host }`); existing sites with `target.stagingUrl` or staging in `cloudflare.json` keep it |
| `provision` | `provision <slug>` → production | also `provision <slug> staging` |
| `wrangler.jsonc` | production only, `workers_dev` + `preview_urls` on | production + `env.staging` |
| Scripts | `deploy:production`, `ci:deploy:production`, `versions:upload`, `versions:deploy` | `deploy:staging`, `ci:deploy:staging`, `deploy:production`, `ci:deploy:production` |
| Client CI on push to `main` | deploys production **before go-live only** (`target.ciDeploy`) | deploys staging |
| Forms | messages from any host but the domain are tests → `email.stagingTo` only | staging → `email.stagingTo` only |
| `load` / `verify` default | production once provisioned, else local | load: local; verify: staging |
| EmDash token | `EMDASH_TOKEN_PRODUCTION` (or `EMDASH_TOKEN`) | staging `EMDASH_TOKEN`, production `EMDASH_TOKEN_PRODUCTION` |
| Review of code changes after launch | Workers preview URLs (§7) | staging, or preview URLs |

## 1. Create the production resources (once per site)

Pick the location nearest the site's visitors **before** creating anything: Cloudflare fixes the location of a D1
database and an R2 bucket when they are created, defaults to *your* region, and an R2 bucket name keeps its first
location even after you delete and recreate it.

| Visitors | `--location` |
|---|---|
| US East / Canada East | `enam` |
| US West | `wnam` |
| Western Europe / UK | `weur` |
| Eastern Europe | `eeur` |
| Asia-Pacific | `apac` |
| Oceania | `oc` |

```bash
pnpm wp2emdash provision <slug> --location enam      # production (the default environment)
```

It creates (or reuses) the database `<slug>-db`, the bucket `<slug>-media`, the form outbox (sites that keep one) and
the private bucket `<slug>-sessions` for sign-in sessions (with a lifecycle rule deleting sessions after
`sessions.days`, default 30; never public), and records them, the account and the workers.dev address in
`sites/<slug>/cloudflare.json`. Scaffold binds every one of them explicitly, so the first `wrangler deploy` provisions
nothing on its own (docs/spikes/M8-findings.md, docs/spikes/sessions-findings.md). With `sessions: "kv"` the sessions
store is the `SESSION` KV namespace (`<slug>-session`) instead. If the client's domain is in their own Cloudflare account,
production must run there (Worker routes only reach a Worker in the zone's account): see *Client-owned Cloudflare
accounts* in `cloudflare-api-token.md`.

Then rerun `pnpm wp2emdash run <slug> scaffold` so `wrangler.jsonc` picks the ids up.

## 2. Build, migrate, deploy

```bash
cd sites/<slug>/project            # or the projectDir
( set -a && . ../../../.env && set +a && pnpm deploy:production )
```

`deploy:production` runs, in this order:

1. `astro build`.
2. `emdash migrate` — applies EmDash's database migrations *before* the new code serves traffic. It asks you to confirm the target; check that it names `<slug>-db`.
3. `wrangler deploy`.
4. `emdash migrate --check` — must report nothing pending.

With `projectDir` set (the project lives outside the kit), `cd` there and load the kit's file by its full path
instead: `( set -a && . ~/path/to/wp-to-emdash-kit/.env && set +a && pnpm deploy:production )`. The subshell hands the
Cloudflare token to these commands only; `emdash migrate` does not read `.env` files itself.

The site is at `https://<slug>.<your-subdomain>.workers.dev`. A brand-new `workers.dev` address can take a minute or
two to resolve. Before go-live it is production in every respect except that nothing public points at it: the
middleware marks every host but the production domain `noindex`, analytics only load on the domain, and every form
message sent there is a test (§5).

Worker secrets, once: `npx wrangler secret put EMAIL_API_KEY`, `EMDASH_ENCRYPTION_KEY` (from
`npx emdash secrets generate`, piped with `printf %s`), and `TURNSTILE_SECRET_KEY` for the production widget. Create
**one** Turnstile widget with two hostnames — the production domain and the account's `<subdomain>.workers.dev` — so
forms work before and after go-live; put its site key in `forms.turnstileSiteKey` and rerun scaffold. Until then the
production forms refuse messages.

## 3. First sign-in to the admin

Open `https://<site-url>/_emdash/admin` — it redirects to `/_emdash/admin/setup`.

### Step 1 — Site

| Field | What to enter |
|---|---|
| Site title | The client's site name (prefilled from WordPress) |
| Tagline | The WordPress tagline, or leave it **empty** — the grey text is only a placeholder |
| How do you want to start? | **Empty site** |

Why *Empty site*: it creates the site's structure (section types, pages / site parts / popups
collections, menus) without content. The `load` phase then brings the real pages and uploads every
image from the WordPress export.

- *Sample content* would import the preview copy of the pages with images downloaded from the live
  WordPress site — the load would then find duplicates.
- *Import an existing EmDash site* is for moving an existing EmDash site (`.emdash` package), not for WordPress.

### Step 2 — Account

Your name and email. This first account is the administrator.

### Step 3 — Sign in: passkeys, not passwords

EmDash has **no password login**. The first account signs in with a **passkey**: a key stored on
your device or in your password manager, unlocked with Touch ID, Face ID, a PIN or your device
password. EmDash never sees that PIN or biometric.

1. Click **Create passkey**.
2. Choose where to save it:
   - **iCloud Keychain** (Touch ID on a Mac) — syncs to your Apple devices.
   - **1Password / Bitwarden / Dashlane** — choose it in the prompt; a passkey in a *shared vault* lets
     your team use the same agency admin login.
   - **Phone** — "Use a phone or tablet" shows a QR code; the passkey lives on the phone.
3. Confirm with Touch ID or your device password. You are signed in.

**Add a second passkey right away** (Settings → Security → Passkeys) on another device or in your
password manager, so losing one device does not lock you out.

**Passkeys belong to one domain.** A passkey made on the workers.dev address only works there. After the switch to
the real domain, sign in there with a magic link and add a new passkey in **Settings → Security**
(`https://<domain>/_emdash/admin/settings/security`); `golive` reminds you. Keep or delete the workers.dev one.

#### Other ways to sign in (optional)

| Method | How to enable |
|---|---|
| Magic link by email | Configure email in **Settings → Email** (the site's email provider, e.g. Brevo); users can then request a sign-in link by email |
| Google / GitHub / Microsoft | Create an OAuth app with that provider and set the Worker secrets `EMDASH_OAUTH_GOOGLE_CLIENT_ID` / `…_CLIENT_SECRET` (or `GITHUB` / `MICROSOFT`) with `wrangler secret put …` (add `--env staging` for opt-in staging) |
| Invites | From the admin's **Users** page, invite the client and their editors: each gets an invite link and creates their *own* passkey — never share the agency's |
| Recovery | From the **Users** page an admin can send a user a recovery link; needs email configured |

## 4. API token for the load phase

**Settings → API Tokens** (`/_emdash/admin/settings/api-tokens`) → create a token named e.g.
`wp2emdash load`, with an expiry, and these scopes:

| Scope | Why |
|---|---|
| `content:read`, `content:write` | Create, update and publish pages, footer, popups; widget areas (classic-theme sites) |
| `media:read`, `media:write` | Find existing media by hash, upload the rest |
| `schema:read`, `schema:write` | Check the section library and update it on the site when the kit's section types gain fields |
| `menus:manage` | Write the navigation menus |
| `settings:read`, `settings:manage` | Site title, tagline, title separator, staging flag, Site URL |

It does not need the transfer scopes. It needs `admin` for the site search (EmDash 1.5 switches full-text search on
through `/_emdash/api/search/enable` and reads `/search/stats`, both admin only: load's `search` check says so) and for a
site with a blog (bylines live under `/_emdash/api/admin/bylines`; the `bylines` check says so). A site set up from the
seed already has search on for its pages; the check then only reads the stats.
`content:write` also covers taxonomies and terms, and publishing posts with their WordPress date works because the
token's owner is an admin (`publishedAt` is checked against the role, not a scope; docs/spikes/blog-findings.md). Put it in the **site's** `.env` (each site has its own EmDash):

```
# sites/<slug>/.env
EMDASH_TOKEN_PRODUCTION=<token>     # single environment: EMDASH_TOKEN=<token> works too
```

With opt-in staging, `EMDASH_TOKEN` is the **staging** site's token and production needs `EMDASH_TOKEN_PRODUCTION`.

## 5. Load and verify

```bash
pnpm wp2emdash run <slug> load      # single environment: production on workers.dev (once provisioned)
pnpm wp2emdash run <slug> verify
```

A single-environment site loads into and verifies production by default once `provision` recorded it (before that:
the local dev server). `WP2EMDASH_LOAD_TARGET=local|staging|production` (load) and `WP2EMDASH_TARGET=…` (verify)
choose explicitly. The gate re-reads the target: counts, duplicates, WordPress leftovers, media integrity, and that
every published page renders. Rerunning is safe — it updates in place. Load sets EmDash's Site URL to the address the
site answers on (workers.dev now, the domain after go-live) and clears the `staging` flag on production.

**Form messages before go-live are tests.** Production carries `FORM_LIVE_HOST` (the domain) and `FORM_TEST_TO`
(`email.stagingTo`). A message sent from any other host — the workers.dev address now, a preview URL later — is emailed
only to the test inbox with `[Test]` in the subject, never to `email.to` or the recipients set in Form messages, and the
outbox never sends it anywhere else, also after launch. Without `email.stagingTo`, test messages are kept in the outbox
unsent (or refused without an outbox). Once the domain points at the Worker, its messages are real at once: nothing
has to be redeployed.

## 6. Deploys from GitHub (client repository)

The scaffold writes `.github/workflows/ci.yml` into the project: check and build on every push and pull request; the
production job runs from *Run workflow* and — **before go-live only** — on every push to `main` (only the workers.dev
address changes then). After go-live (rerun scaffold after `golive`) production deploys are manual, because each one
reaches visitors immediately; `target.ciDeploy: "always"` or `"manual"` overrides the default `"prelaunch"`.

In CI, `emdash migrate` cannot ask for confirmation, so the deploy pins the target:

```bash
cd sites/<slug>/project
( set -a && . ../../../.env && set +a && npx emdash migrate --status --wrangler-config wrangler.jsonc ) | grep "Target fingerprint"
```

Add it to `cloudflare.json` as `production.d1.fingerprint` (not a secret: it identifies the database) and rerun
scaffold. That adds `pnpm ci:deploy:production` (`--expected-target-fingerprint=…`, which fails on any other
database) and turns the push deploy on. Until then a push does not deploy.

In the GitHub repository: secret `CLOUDFLARE_API_TOKEN` (the build token, never the go-live DNS token), variable
`CLOUDFLARE_ACCOUNT_ID` (deploy jobs are skipped until it is set); environment `production` (deployment branch `main`;
after go-live, required reviewer: the owner).

`pnpm wp2emdash publish <slug>` does the repository part: it refuses while a local secret file (`.env`, `.dev.vars`,
`*.db`) or a credential-like value would be committed (file names only), then `git init`, commit,
`gh repo create --private` (default name: the production domain; `--repo owner/name` to choose), push, and the
`CLOUDFLARE_ACCOUNT_ID` variable. It prints the plan and changes nothing without `--yes`, and it never sets the token
secret: run the printed `gh secret set CLOUDFLARE_API_TOKEN` yourself with a build-only token (no zone permissions).
On an existing repository it only commits and pushes.
The client project's `docs/deployment.md` repeats this for whoever maintains the site.

## 7. Go-live, and after it

The traffic switch is `pnpm wp2emdash golive <slug>` (plan only; `--yes` after the owner's go-ahead): it creates the
routes, smoke-tests the domain and sets `production.live: true` in `cloudflare.json` — load and verify then use the real
domain and expect it indexable with analytics loading. Rerun scaffold and deploy production afterwards: IndexNow turns
live, the client docs say "live", and the client CI stops deploying on push.

From then on **content lives in production** and is edited in the admin:

- `load` into a live production refuses without `--force`. With it, the kit first records a D1 Time Travel bookmark
  (`sites/<slug>/load/d1-bookmarks.jsonl`) and prints the restore command; it writes nothing if no bookmark can be
  taken.

  ```bash
  pnpm wp2emdash run <slug> load --force
  # to undo, in the project:  npx wrangler d1 time-travel restore <slug>-db --bookmark=<bookmark>
  ```

  Time Travel covers the database only (R2 files are not versioned; load only adds media).
- **Code changes are reviewed on a preview URL** before they reach visitors:

  ```bash
  ( set -a && . ../../../.env && set +a && pnpm versions:upload )   # new version, no traffic; prints its preview URL
  # review https://<8 chars of the version id>-<slug>.<subdomain>.workers.dev on desktop and phone, then
  ( set -a && . ../../../.env && set +a && pnpm versions:deploy <version-id>@100% --yes )
  ```

  `versions:upload` accepts `--preview-alias <name>` for a stable link. A preview shares production's D1, R2, KV and
  secrets: it is for code and layout review only — edits made through a preview's admin are real, form messages from
  it are tests, and a change that needs a database migration (an EmDash upgrade) is not previewable this way: check it
  locally, then `pnpm deploy:production` (or opt into staging). `npx wrangler rollback` returns to the previous version.
- **Moving a live site's sign-in sessions from KV to R2** (sites provisioned before 2026-11-20 keep KV until then; the
  scaffold warning says so): tell the editors first — the deploy **signs everyone out once**, sessions do not move.
  `pnpm wp2emdash provision <slug>` (creates `<slug>-sessions` and its lifecycle rule, records it), rerun scaffold,
  check the diff (`astro.config.mjs`: `cloudflareR2Binding` and `sessionKVBindingName: "SESSIONS"`; `wrangler.jsonc`:
  `SESSIONS` bucket, no `SESSION` KV), then `pnpm deploy:production` with the owner's approval. Sign in once and check
  the bucket holds an object. The old `<slug>-session` KV namespace stays, unbound, for a switch back (`sessions:
  "kv"`); delete it in the dashboard once the site has run on R2 for a while. `npx wrangler rollback` to a version from
  before the switch goes back to the KV sessions (sign-ins made on R2 are not seen there).

## 8. Opt-in staging

A second Worker (`<slug>-staging`) with its own D1, R2, KV and secrets. Opt in when:

- **Client sign-off on big changes** after launch (redesigns, new sections, EmDash upgrades with migrations) on a copy
  of the data, without touching what visitors see;
- **Bookings, payments or sensitive data**, where a test must never create or change production records;
- **Many editors**, where experiments in a shared admin would be seen (and published) by everyone.

How:

1. `target.staging: true` in `kit.config.ts` (or `{ enabled: true, protection: "access" | "noindex", host: "staging.example.com" }`).
2. `pnpm wp2emdash provision <slug> staging --location <loc>` → `<slug>-staging-db`, `<slug>-stg-media`, outbox, `<slug>-staging-sessions`.
3. Rerun scaffold: `wrangler.jsonc` gets `env.staging` (`STAGING=1`, form email only to `email.stagingTo` — or held in
   the outbox without it — and Cloudflare's always-pass Turnstile test keys), package.json the `deploy:staging` scripts.
4. `( set -a && . ../../../.env && set +a && pnpm deploy:staging )` — `CLOUDFLARE_ENV=staging astro build` (the
   environment is chosen **at build time**: `wrangler deploy --env staging` after a normal build would deploy the
   production bindings), `emdash migrate … --wrangler-env staging` (check it names `<slug>-staging-db`),
   `wrangler deploy`, `emdash migrate --check`.
5. First sign-in (§3) and an API token (§4) in the staging admin → `EMDASH_TOKEN` in the site's `.env`;
   `target.stagingUrl` (or the address provision recorded).
6. `WP2EMDASH_LOAD_TARGET=staging pnpm wp2emdash run <slug> load`; verify defaults to staging.
7. CI: record `staging.d1.fingerprint` (`npx emdash migrate --status --wrangler-config wrangler.jsonc --wrangler-env staging`),
   rerun scaffold; staging then deploys on every push to `main`, production only by hand. GitHub environments
   `staging` and `production`.
8. Protection (`target.staging.protection`, a record of the decision — the kit does not configure Access): `access` =
   a Cloudflare Access login wall in front of the staging host, set up by hand in Zero Trust → Access → Applications
   (load and verify do not send Access credentials yet: give the kit's runs a bypass policy or run them before the wall
   goes up); `noindex` = the middleware's `X-Robots-Tag` only, which every non-production host gets anyway.

Sites that already ran staging before 2026-11-20 (a `target.stagingUrl`, or staging resources in `cloudflare.json`)
keep it with no config change; `target.staging: false` turns it off.

## Troubleshooting

Commands below are for production; add `--wrangler-env staging` (emdash) or `--env staging` (wrangler) for opt-in staging.

| Symptom | Cause | Fix |
|---|---|---|
| Every request returns **503**; logs say *"database migrations are required … migration lock has been held since …"* | A migration run (often the first request in `auto` mode) stopped before releasing its lock | `pnpm emdash migrate --status --wrangler-config wrangler.jsonc` → note the lock id and target fingerprint → `pnpm emdash migrate --take-over-lock=<id> --expected-target-fingerprint=<fp> --wrangler-config wrangler.jsonc` → `--check` → redeploy the same build. Run inside the `( set -a && . ../../../.env … )` subshell. |
| `emdash migrate`: *CLOUDFLARE_API_TOKEN is required for D1 migrations* | The token is in a `.env` file but not in the shell | Use the subshell shown in step 2 |
| Staging deploy shows `DB (<slug>-db)` instead of `<slug>-staging-db` | Built without `CLOUDFLARE_ENV=staging` | Use `pnpm deploy:staging`; always check the binding names Wrangler prints |
| `provision <slug> staging` says staging is opt-in | The site has one environment | Set `target.staging: true` first (§8) — or keep one environment |
| `load` says *Production is live* | Reloading a launched site overwrites admin edits | Rerun with `--force` (a Time Travel bookmark is recorded first), or edit in the admin instead |
| Bucket or database is in the wrong region | Created without `--location` | Empty resources: delete the database and recreate it with `--location`; for R2 use a **new** bucket name |
| `curl: Could not resolve host` / load fails with `ENOTFOUND` after the first deploy | New `workers.dev` hostnames can stay unresolvable for a while in local, router or ISP DNS caches, and even public resolvers can flap (SERVFAIL *No Reachable Authority*) | The loader falls back to Cloudflare DNS over HTTPS automatically. If that also fails, pin the Worker's addresses: get them with `curl -H 'accept: application/dns-json' 'https://cloudflare-dns.com/dns-query?name=<host>&type=A'` and add `"worker": { "addresses": ["<ip>", "<ip>"] }` under `production` (or `staging`) in `sites/<slug>/cloudflare.json` (TLS still checks the real hostname). Flushing the Mac's DNS cache needs a real terminal: `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`. |
| verify: `page.goto: net::ERR_TUNNEL_CONNECTION_FAILED` while `curl --resolve` to the pinned address works | The machine routes the browser through a proxy auto-config (VPN or a tailnet DNS such as `100.100.100.100`) that cannot resolve the new host; the pinned addresses do not reach Chromium behind that proxy | Flush the DNS cache (above) and retry once `curl https://<host>/` answers 200, or switch the VPN off for the run. Meanwhile, verify against a local load (`WP2EMDASH_LOAD_TARGET=local` load, then `WP2EMDASH_TARGET=local` verify) to check layout changes. |
| `/_emdash/setup` returns 404 | Wrong path | The setup is at `/_emdash/admin/setup` |
| Load fails with `INSUFFICIENT_SCOPE` | The API token lacks a scope | Create a token with the scopes in step 4 |
| Admin shows **"Error — Not authenticated"** at random; Retry often lands on the sign-in page (editors signed out) | Sign-in sessions on Workers KV (the Cloudflare adapter's default, or `sessions: "kv"`): KV is eventually consistent and caches reads at the edge (misses too, 60 s), and Astro replaces a session id it cannot find with a new one | Move sessions to R2 (the kit default): `pnpm wp2emdash provision <slug>` (creates `<slug>-sessions` + its lifecycle rule), rerun scaffold (check `astro.config.mjs` has `cloudflareR2Binding` and `wrangler.jsonc` a `SESSIONS` bucket and no `SESSION` KV), deploy. **Everyone is signed out once** and signs in again. Scaffold warns while a bucket is missing (it stays on KV until every environment has one). docs/spikes/sessions-findings.md |
| First deploy fails (10001), then every retry fails with `10014` "namespace already exists" | Wrangler auto-provisioned the `SESSION` KV namespace before the deploy failed, leaving `<worker>-session` behind (sites with `sessions: "kv"`, or before their sessions bucket exists) | `pnpm wp2emdash provision <slug> [staging]` (R2 sessions: creates the sessions bucket, after which no SESSION KV binding is needed; `"kv"`: reuses that namespace by title and records it), rerun scaffold so `wrangler.jsonc` binds it, deploy again |
| A form test on workers.dev did not reach the client | By design: messages from any host but the domain are tests | They go to `email.stagingTo` only; test the client's inbox from the domain after go-live |
| `versions:upload` prints no *Version Preview URL* | Preview URLs off for the Worker | Check `"preview_urls": true` in `wrangler.jsonc` (scaffold writes it for single-environment sites) and deploy once with it |
| A setting changed in the admin or through the API (Settings → Email, Site URL, the staging flag) still behaves as before on some requests, e.g. "Email is not configured" right after saving SMTP | Running Worker isolates cache site settings and the email provider choice | Redeploy (`pnpm deploy:<env>` in the project, or `wrangler deploy`): new isolates read the saved settings |
| After a magic-link sign-in the browser lands on the workers.dev address | EmDash builds sign-in links from **Site URL**; without it, from the address recorded at first setup (workers.dev) | `load` sets Site URL to the address the site answers on, and `golive` sets the real domain after the switch; by hand: admin → Settings → Site URL, then redeploy |
| "Email is not configured. Magic link authentication requires an email provider." | EmDash's own email (sign-in links, invites, password resets) has no provider; form email is separate | Admin → Settings → Email: SMTP with the site's provider (Brevo: `smtp-relay.brevo.com`, 587, STARTTLS, the Brevo SMTP login and SMTP key), sender on the authenticated domain; then redeploy |
| Sign-in email arrives late, or its link starts with a tracking domain (Brevo: `…sendibt*.com/tr/cl/…`) | The provider's click/open tracking rewrites links, so one-time sign-in tokens pass through its redirect; delivery can lag a few minutes | Turn tracking off for transactional mail (Brevo: Transactional → Settings → Tracking: click and open tracking off). The sign-in page always says "sent" — 3 requests per 5 minutes per address, so wait before retrying |
