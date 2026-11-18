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
- **EmDash's email pipeline** (Settings → Email: built-in SMTP over `node:net`/`node:tls`, or `EMAIL_SMTP_*` vars) enables invites, magic links and password recovery. Its API is `locals.emdash.email` (`isAvailable()`, `send({ to, cc, replyTo, subject, text, html }, source)`), **but only on EmDash's own routes, authenticated requests and a fixed list (`/sitemap.xml`, `/robots.txt`)**: anonymous requests to site routes get a slim `locals.emdash` without `email` (middleware fast path, `PUBLIC_RUNTIME_ROUTES`). Verified on staging: the form endpoint fell back to the provider API (`via: brevo`). The supported way for public code to send is an EmDash plugin with a public API route and the `email:send` capability (`ctx.email`) — kit backlog: a forms plugin (also lets the owner edit recipients in the admin).

## SEO image and old addresses (verified 2026-11-18, emdash 1.5.0)

- **Page SEO image:** `seo.image` on a content item becomes `og:image` / `twitter:image`, and `twitter:card` switches to `summary_large_image` (`page/seo-contributions.ts`). `buildSeoImageUrl` turns a bare media *id* into `/_emdash/api/media/file/<id>`, which answers 404: files are served by **storage key** (`<key>.<ext>`, the `url` the media upload returns). The load phase stores that root-relative file path. EmDash's head has no `og:locale`; the starter adds the source's.
- **Old upload URLs:** native redirects skip paths with a file extension (M0 A6), so the starter middleware answers `/wp-content/uploads/YYYY/MM/<file>` (and the `/storage/` alias, resized `-WxH` / `-scaled` copies) with a 301 to the library file, looked up by original `filename` in EmDash's `media` table (`filename`, `storage_key`, migration 001). WordPress sitemap addresses (`sitemap_index.xml`, `*-sitemap.xml`, `wp-sitemap*.xml`) 301 to `/sitemap.xml`. Verify gate `legacy-urls`.

## Analytics (2026-11-18)

- **Carried over by id, not by script:** the audit collects tracking ids from every page's HTML (`GT-`, `G-`, `AW-`, `GTM-`; `UA-` is retired). Unless `kit.config` sets `analytics` (or `false`), scaffold writes them to `site.config.json`; `components/Analytics.astro` loads the Google tag and the Tag Manager container from a bundled script (no inline script, so the CSP stays strict; Google's and Cloudflare's hosts are added to it only when configured).
- **Production only:** loaded when the request host is the production host, never in `astro dev`, never for signed-in editors (cookie `astro-session`, edit/preview links — same test as the CSP). Matches WordPress Site Kit's "exclude logged-in users". Verify gate `analytics`: every source id carried; staging/local must not load them; production must.
- **Cloudflare Web Analytics** on a proxied zone is injected at the edge (absent from the HTML a non-browser client gets). It is not added in code by default (double counting); `analytics.cloudflareToken` adds it explicitly when the zone does not inject it. Check after cutover.
- **Ownership tags** (`google-site-verification`, Bing, Pinterest, Facebook, Yandex meta) are carried into `site.config.json` → `verification` and rendered in the head. DNS TXT verification needs the DNS records kept at cutover.

## More email providers (2026-11-18)

Form delivery also supports Resend (`POST api.resend.com/emails`, Bearer, 200), Postmark (`POST api.postmarkapp.com/email`, `X-Postmark-Server-Token`, 200), SendGrid (`POST api.sendgrid.com/v3/mail/send`, Bearer, 202) and Mailgun (`POST api[.eu].mailgun.net/v3/<sender domain>/messages`, basic `api:<key>`, form fields, 200; `MAILGUN_REGION=eu` var for EU accounts). Request shapes follow each provider's API reference; unit-tested with a mocked fetch, not yet sent end-to-end. SES, Google Workspace, Microsoft 365 and Cloudflare Email answer 501 "not implemented" until a site needs them.

## Form outbox in Workers KV (2026-11-18)

- Owner opt-in (`forms.outbox`): when email is not configured or the provider refuses, the endpoint stores the composed message (reply-to, subject, text, html — no sender/recipients) in KV binding `FORM_OUTBOX` with `expirationTtl` = days, and answers the visitor with the normal success message. `src/worker.ts` wraps EmDash's `createScheduledHandler()` and flushes the queue from the existing `*/5` cron (`import { env } from "cloudflare:workers"`), deleting each message once delivered.
- `forms.outbox.hold` (var `FORM_OUTBOX_HOLD=1`) keeps every message and sends none: for a provider that answers 201 but never delivers (the pilot's Brevo account). Released by `hold: false` + a working key.
- Adding `kv_namespaces` to `wrangler.jsonc` keeps the adapter's auto-provisioned `SESSION` binding (checked in `dist/server/wrangler.json`). Verified on staging: a test submission was queued with a 30-day expiry, then deleted.

## Salient column parallax, element spacing, form fields (measured on a live Salient site)

- **Column `parallax_bg="true"`, speed `fast`:** the background layer is the box height + 0.2 × viewport height tall, starts 0.2 × viewport height above the box, and is translated `0.2 × (viewport height − box top)` px (box top in viewport coordinates), with `scale(1.005)`. Same rule at 390, 768 and 1440 px. Other speeds (`very_subtle`, …) are not measured yet and stay static. The starter reproduces it in `site.ts` (`[data-parallax]`), off under reduced motion.
- **Divider spacer heights:** `custom_height_phone` is its own size (≤690 px) when it differs from `custom_height_tablet`; the IR keeps `phone` next to `small`.
- **`column_element_spacing="Npx"`:** a bottom margin on every element but the last. A block element's top margin (`nectar_cta`) collapses into it; an inline-block `nectar_btn` adds to it (40 + 5 = 45 px).
- **Heading alone in the first inner row:** the gap under it is its text block's custom `margin-bottom` + 10 px (every inner row but the last has a 10 px bottom margin).
- **Form fields:** the audit measures the first content form's text field (background, border, radius, height, font size, padding, label visibility) on a page picked for having a non-search, non-popup form. Phones keep inputs at ≥16 px so iOS does not zoom on focus.
- **Sideways scroll:** verify screenshots are clipped to the viewport width, so overflow was invisible to the visual gate; `no-sideways-scroll` now fails any page whose document is wider than the screen.
