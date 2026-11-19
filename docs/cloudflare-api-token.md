# Cloudflare API tokens for wp2emdash

The kit and the EmDash CLI talk to Cloudflare with API tokens. `wrangler login` (OAuth) is enough to
deploy by hand, but `emdash migrate` — which applies EmDash's database migrations to D1 and releases a
stuck migration lock — **only** accepts an API token, and CI needs one too.

Use **two tokens**, not one:

| Token | Lifetime | Scope | Used for |
|---|---|---|---|
| **A — build & staging** | reusable across every project | your Cloudflare account, no zone access | create D1/R2/KV, migrate, deploy staging and production Workers, Worker secrets, Turnstile, staging login wall, logs |
| **B — go-live** | one per launch, short expiry | only the client's zone | Worker route switch, rollback, DNS checks, optional Custom Domain |

Splitting them keeps the reusable token away from DNS: a leaked token A can't touch any client's
domain, email records (MX, SPF, DKIM) or other zones.

Permission names below are as shown in the dashboard's custom-token form (*Edit*; the API reference
calls the same level *Write*), checked against Cloudflare's permission reference on 2026-11-17.

## Token A — build & staging (reusable)

Dashboard → **My Profile → API Tokens → Create Token → Create Custom Token**. Name it e.g.
`wp2emdash build & staging`.

### Permissions

| Group | Permission | Access | Why | Phase |
|---|---|---|---|---|
| Account | Account Settings | Read | Resolve the account for Wrangler and `emdash migrate` | scaffold, load |
| Account | Workers Scripts | Edit | Deploy staging and production Workers; set Worker secrets (email provider key, encryption key) | load, cutover |
| Account | Workers KV Storage | Edit | The `SESSION` namespace Wrangler provisions on first deploy | load |
| Account | Workers R2 Storage | Edit | Create the media buckets (with the right location) | load |
| Account | D1 | Edit | Create databases; `emdash migrate` (apply, check, release a stuck lock); backups before each load | load, cutover |
| Account | Workers Tail | Read | Live logs while verifying (`wrangler tail`) | verify |
| Account | Turnstile | Edit | Create the bot-protection widget for the site's forms | load |
| Account | Access: Apps and Policies | Edit | Put staging behind a login wall (`target.staging.protection: "access"`) | load |
| Account | Account Analytics | Read | Post-launch monitoring: requests, errors, cache | cutover (monitor) |
| User | User Details | Read | `wrangler whoami` | all |
| User | Memberships | Read | List the accounts the token can use | all |

**Account Resources:** Include → *your account only* (not "All accounts").
**Zone Resources:** none — token A never needs a zone.
**Client IP Address Filtering:** optional; add your office/CI IPs if they are fixed.
**TTL:** 6–12 months, then rotate (see below).

### Optional additions — only if a project needs them

| Permission | Access | Add when |
|---|---|---|
| Access: Organizations, Identity Providers, and Groups | Read | Staging access policies use identity-provider groups instead of an email list |
| Email Routing Addresses / Email Routing Rules | Edit | The site's form email provider is `cloudflare-email` |

### Not needed

Cloudflare Images (the Worker's `IMAGES` binding works without token access), Pages, Workers AI,
Zone and DNS permissions (those belong to token B).

## Token B — go-live (per launch)

Create it when a site is ready to launch, scoped to that client's zone only, with an expiry a few
weeks out. Name it e.g. `wp2emdash go-live <domain>`.

| Group | Permission | Access | Why |
|---|---|---|---|
| Zone | Zone | Read | Read the zone and its settings during preflight |
| Zone | DNS | Read | Preflight: record MX, SPF, DKIM, DMARC and verification TXT so cutover can prove they stayed unchanged |
| Zone | Workers Routes | Edit | Route-first cutover: add the Worker routes for the apex and `www`; rollback = delete them |
| Zone | DNS | Edit | **Only** for the optional final step (Worker Custom Domain replaces the WordPress record after the monitoring window). Leave it out until then. |

**Zone Resources:** Include → Specific zone → the client's domain. Revoke the token after the
monitoring window (`target.cutover.monitorDays`).

**Where it goes:** the site's own `.env` (never the kit-level one, so it can only ever touch that client):

```bash
# sites/<slug>/.env
CLOUDFLARE_GOLIVE_TOKEN=<token B>
```

`pnpm wp2emdash run <slug> cutover` (the read-only preflight) uses it to read the zone, record its DNS and check that
no Worker route is in the way.

## Where the token goes

```bash
cp .env.example .env          # kit root, gitignored
# CLOUDFLARE_API_TOKEN=<token A>
# CLOUDFLARE_ACCOUNT_ID=<account id from the dashboard sidebar or `npx wrangler whoami`>
pnpm wp2emdash doctor         # verifies the token with Cloudflare; never prints it
```

- The kit reads the kit-level `.env` for every site; `sites/<slug>/.env` can override a value for one
  site (e.g. a client's own Cloudflare account). Both files are gitignored.
- When the kit runs `emdash migrate` or `wrangler`, it passes these variables to that process only —
  `emdash migrate` does not read `.env` files by itself.
- Never paste a token into a chat, issue, commit, log or screenshot. If one is exposed, roll it in the
  dashboard (API Tokens → ⋯ → Roll) and update `.env`.

## Rotating

1. Dashboard → API Tokens → the token → **Roll** (the old value stops working immediately).
2. Paste the new value into the kit `.env`.
3. `pnpm wp2emdash doctor` → *Cloudflare API token: active*.

## Client-owned Cloudflare accounts

**Worker routes only reach a Worker in the domain's own account.** If the client's domain is in their
Cloudflare account, production has to run there too (the cutover preflight checks this: `same-account`).
Staging can stay in your account.

1. The client's account needs **Workers Paid** (Workers & Pages → Plans). The zone itself can stay on Free.
2. Create token A **in the client's account** (Account Resources: that account only) and token B
   scoped to their zone.
3. In `sites/<slug>/.env`, with the environment suffix so staging keeps using your kit-level token:

   ```bash
   CLOUDFLARE_API_TOKEN_PRODUCTION=<token A, client account>
   CLOUDFLARE_ACCOUNT_ID_PRODUCTION=<client account id>
   CLOUDFLARE_GOLIVE_TOKEN=<token B>
   ```

4. `pnpm wp2emdash provision <slug> production` creates the D1 database, R2 bucket and form outbox there
   (same names, same location), records them in `cloudflare.json` → `production`, and keeps the old
   production entries under `production.previous` (it never deletes anything; remove the old resources
   by hand after the monitoring window).
5. `pnpm wp2emdash run <slug> scaffold`, then deploy with the production pair:

   ```bash
   cd sites/<slug>/project
   ( set -a && . ../.env && set +a && CLOUDFLARE_API_TOKEN=$CLOUDFLARE_API_TOKEN_PRODUCTION \
     CLOUDFLARE_ACCOUNT_ID=$CLOUDFLARE_ACCOUNT_ID_PRODUCTION pnpm deploy:production )
   ```

   Set the Worker secrets again there (`wrangler secret put`, same pair), sign in once at the new
   workers.dev `/_emdash/admin`, create `EMDASH_TOKEN_PRODUCTION`, then load and verify (staging-setup.md §7).
   For GitHub deploys, put token A and the account id on the repository's **production environment**
   (environment secrets/variables override repository ones), not the repository level.

If the whole site (staging included) lives in the client's account, put the plain `CLOUDFLARE_API_TOKEN` /
`CLOUDFLARE_ACCOUNT_ID` in `sites/<slug>/.env` instead: they override the kit-level pair for that site only.

Never give a token "All accounts" or "All zones" when you are a member of several client accounts: a
mistake with it can reach every other client.
