# M7 findings — form endpoint

Verified 2026-11-18 against astro 7.4.12, @astrojs/cloudflare 14.4.8, emdash 1.5.0, wrangler 4.163.0, and the providers' current docs.

## Runtime

- **Bindings and secrets in Astro routes:** `import { env } from "cloudflare:workers"` (the adapter itself reads its env this way, `dist/fetch.js`; the starter's middleware already does). An endpoint under `src/pages/api/` with `export const prerender = false` runs in the Worker.
- **Wrangler vars and bindings are not inherited by environments.** `vars` and `ratelimits` are written for production and again for `env.staging`.
- **Rate limiting binding:** `ratelimits: [{ name, namespace_id, simple: { limit, period } }]`, period 10 or 60 s (wrangler 4.163 schema); `env.FORM_LIMITER.limit({ key })` → `{ success }`. Works under `astro dev` (6th request in a minute answered 429 with limit 5). Namespace ids are account-wide integers; the scaffold derives them from the Worker name.
- **`.dev.vars`** is read by `astro dev` (Turnstile test keys in it made the endpoint pass locally).

## Turnstile (developers.cloudflare.com/turnstile)

- Siteverify: `POST https://challenges.cloudflare.com/turnstile/v0/siteverify`, form-encoded or JSON, `secret`, `response`, optional `remoteip`, `idempotency_key`; response `success`, `error-codes`, `hostname`, `action`.
- Tokens: at most 2048 characters, valid 300 s, single use (`timeout-or-duplicate`) — the client resets the widget after every attempt.
- Test keys: site `1x00000000000000000000AA`, secret `1x0000000000000000000000000000000AA` (always pass; accept only the dummy token `XXXX.DUMMY.TOKEN.XXXX`). Used on staging and in `.dev.vars`; production needs a real widget (site key in `kit.config` `forms.turnstileSiteKey`, secret as the Wrangler secret `TURNSTILE_SECRET_KEY`).

## Brevo (developers.brevo.com/reference/sendtransacemail)

- `POST https://api.brevo.com/v3/smtp/email`, header `api-key`, JSON `sender {email,name}`, `to [{email}]`, `replyTo`, `subject`, `htmlContent`, `textContent`; `201 { messageId }` (`202` when scheduled).
- The sender must be a sender or domain verified in the Brevo account.

## Sensitive data

- A site with `sensitiveData: true` cannot scaffold a form until the owner sets `forms.sensitive` (gate `forms`). `contact-only` keeps email, phone and name fields; the rest are listed in the scaffold log as not collected. The endpoint reads only the definition's fields, stores nothing, and logs only `{ form, outcome, reason }`.

## EmDash secrets

- **`EMDASH_ENCRYPTION_KEY` must exist on every deployed Worker** before the admin can store SMTP credentials (Settings → Email fails with "EMDASH_ENCRYPTION_KEY is required to store SMTP credentials securely"). Generate with `emdash secrets generate` (prints the key on stdout, guidance on stderr), keep a copy per environment in the site's `.env` (losing it makes stored secrets unreadable), set it with `wrangler secret put EMDASH_ENCRYPTION_KEY --env <env>`. Kit gap: the staging/production setup step should do this automatically.
- **EmDash's email pipeline** (Settings → Email: built-in SMTP over `node:net`/`node:tls`, or `EMAIL_SMTP_*` vars) is reachable from site routes as `locals.emdash.email` (`isAvailable()`, `send({ to, cc, replyTo, subject, text, html }, source)`). The form endpoint prefers it, so the owner can change email settings without a deploy; it also enables invites, magic links and password recovery.
