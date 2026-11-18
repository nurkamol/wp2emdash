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
