# Staging setup: from scaffold to a loaded staging site

The steps between `scaffold` (a project that builds locally) and `load` into staging. Most are run
once per site. Facts behind each step are in `docs/spikes/M6-findings.md`.

**Before you start:** Workers Paid plan on the Cloudflare account, the reusable build & staging token
in the kit `.env` ([cloudflare-api-token.md](cloudflare-api-token.md)) and `pnpm wp2emdash doctor` showing it *active*.

## 1. Create the staging resources (once per site)

Pick the location nearest the site's visitors **before** creating anything: Cloudflare fixes the
location of a D1 database and an R2 bucket when they are created, defaults to *your* region, and an R2
bucket name keeps its first location even after you delete and recreate it.

| Visitors | `--location` |
|---|---|
| US East / Canada East | `enam` |
| US West | `wnam` |
| Western Europe / UK | `weur` |
| Eastern Europe | `eeur` |
| Asia-Pacific | `apac` |
| Oceania | `oc` |

```bash
cd sites/<slug>/project
npx wrangler d1 create <slug>-staging-db --location enam
npx wrangler r2 bucket create <slug>-stg-media --location enam
```

Record the ids in `sites/<slug>/cloudflare.json` (the scaffold writes them into `wrangler.jsonc`):

```json
{
  "accountId": "<account id>",
  "staging": {
    "d1": { "name": "<slug>-staging-db", "id": "<database_id from the create output>", "location": "enam" },
    "r2": { "bucket": "<slug>-stg-media", "location": "enam" }
  }
}
```

Then rerun `pnpm wp2emdash run <slug> scaffold` so `wrangler.jsonc` picks them up.

## 2. Build, migrate, deploy

```bash
cd sites/<slug>/project
( set -a && . ../../../.env && set +a && pnpm deploy:staging )
```

`deploy:staging` runs, in this order:

1. `CLOUDFLARE_ENV=staging astro build` — the environment is chosen **at build time**; `wrangler deploy --env staging` after a normal build would deploy the production bindings.
2. `emdash migrate` — applies EmDash's database migrations to the staging D1 *before* the new code serves traffic. It asks you to confirm the target; check that it names `<slug>-staging-db`.
3. `wrangler deploy` — on the first deploy Wrangler also creates the session store (`<worker>-session`).
4. `emdash migrate --check` — must report nothing pending.

The subshell `( set -a && . ../../../.env … )` hands the Cloudflare token to these commands only;
`emdash migrate` does not read `.env` files itself.

The site is at `https://<worker>-staging.<your-subdomain>.workers.dev`. A brand-new `workers.dev`
address can take a minute or two to resolve.

## 3. First sign-in to the admin

Open `https://<staging-url>/_emdash/admin` — it redirects to `/_emdash/admin/setup`.

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

#### Other ways to sign in (optional)

| Method | How to enable |
|---|---|
| Magic link by email | Configure email in **Settings → Email** (the site's email provider, e.g. Brevo); users can then request a sign-in link by email |
| Google / GitHub / Microsoft | Create an OAuth app with that provider and set the Worker secrets `EMDASH_OAUTH_GOOGLE_CLIENT_ID` / `…_CLIENT_SECRET` (or `GITHUB` / `MICROSOFT`) with `wrangler secret put … --env staging` |
| Invites | From the admin's **Users** page, invite the client and their editors: each gets an invite link and creates their *own* passkey — never share the agency's |
| Recovery | From the **Users** page an admin can send a user a recovery link; needs email configured |

## 4. API token for the load phase

**Settings → API Tokens** (`/_emdash/admin/settings/api-tokens`) → create a token named e.g.
`wp2emdash load`, with an expiry, and these scopes:

| Scope | Why |
|---|---|
| `content:read`, `content:write` | Create, update and publish pages, footer, popups |
| `media:read`, `media:write` | Find existing media by hash, upload the rest |
| `schema:read` | Check the section library is present |
| `menus:manage` | Write the navigation menus |
| `settings:read`, `settings:manage` | Site title, tagline, title separator, staging flag |

It does not need `admin`, `schema:write` or the transfer scopes. Put it in the **site's** `.env`
(each site has its own EmDash):

```
# sites/<slug>/.env
EMDASH_TOKEN=<token>
```

and set the staging URL in `sites/<slug>/kit.config.ts` → `target.stagingUrl`.

## 5. Load into staging

```bash
WP2EMDASH_LOAD_TARGET=staging pnpm wp2emdash run <slug> load
```

The gate re-reads the staging site: counts, duplicates, WordPress leftovers, media integrity, and that
every published page renders. Rerunning is safe — it updates in place.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Every request returns **503**; logs say *"database migrations are required … migration lock has been held since …"* | A migration run (often the first request in `auto` mode) stopped before releasing its lock | `pnpm emdash migrate --status --wrangler-config wrangler.jsonc --wrangler-env staging` → note the lock id and target fingerprint → `pnpm emdash migrate --take-over-lock=<id> --expected-target-fingerprint=<fp> --wrangler-config wrangler.jsonc --wrangler-env staging` → `--check` → redeploy the same build. Run inside the `( set -a && . ../../../.env … )` subshell. |
| `emdash migrate`: *CLOUDFLARE_API_TOKEN is required for D1 migrations* | The token is in a `.env` file but not in the shell | Use the subshell shown in step 2 |
| Deploy shows `DB (<slug>-db)` instead of `<slug>-staging-db` | Built without `CLOUDFLARE_ENV=staging` | Use `pnpm deploy:staging`; always check the binding names Wrangler prints |
| Bucket or database is in the wrong region | Created without `--location` | Empty resources: delete the database and recreate it with `--location`; for R2 use a **new** bucket name |
| `curl: Could not resolve host` right after the first deploy | New `workers.dev` hostnames take a minute or two to propagate | Wait, or check with Cloudflare DNS over HTTPS |
| `/_emdash/setup` returns 404 | Wrong path | The setup is at `/_emdash/admin/setup` |
| Load fails with `INSUFFICIENT_SCOPE` | The API token lacks a scope | Create a token with the scopes in step 4 |
