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
- **EmDash's email pipeline** (Settings → Email: built-in SMTP over `node:net`/`node:tls`, or `EMAIL_SMTP_*` vars) enables invites, magic links and password recovery. Its API is `locals.emdash.email` (`isAvailable()`, `send({ to, cc, replyTo, subject, text, html }, source)`), **but only on EmDash's own routes, authenticated requests and a fixed list (`/sitemap.xml`, `/robots.txt`)**: anonymous requests to site routes get a slim `locals.emdash` without `email` (middleware fast path, `PUBLIC_RUNTIME_ROUTES`). Verified on staging: the form endpoint fell back to the provider API (`via: brevo`). The supported way for public code to send is an EmDash plugin with a public API route and the `email:send` capability (`ctx.email`) — kit backlog: a forms plugin (also lets the owner edit recipients in the admin). Done differently in Forms 1.2 (below): `withEmDashRuntime` reaches the pipeline from the site route itself.

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

## Salient fancy list, large button, team cards (measured on a live Salient site at 390/768/1440, animations off)

- **`fancy-ul icon_type="standard_dot"`:** the `ul` has no indent and a 30 px bottom margin. Each `li` has `padding-left: 30px` and a 4 px dot about 2 px in from the left, centred on the first line. The wrapper's element-spacing margin (5 px) collapses into the list's 30 px, so a `nectar_btn` right under it sits 30 px below. The IR marks the column `list: "dots"`; other icon types keep plain bullets.
- **`nectar_btn size="large"`:** 14 px text, line height 20 px, padding 15 px 35 px, tracking 0.1 em (50 px tall). The IR has `size: "large"` and `textSize: 14`.
- **Heading in its own inner row above a section** (`split_line_heading`): the gap is the inner row's bottom padding (% of the content width) + the heading's 7 px bottom margin. The IR keeps `headGap: "7%"` and the starter CSS adds the 7 px: EmDash 1.5 treats *any* change to a field's validation pattern as breaking (`compareBlockFields`: only removing a pattern is compatible), so widening `head_gap` would need a new block-type version.
- **`team_member`:** each card has a 7 px top margin. The role (`h5`, 13 px) is 13 px tall with 5 px under it. The mini bio has 10 px of space under it. The arrow sits 20 px below that. Each builder row of members (`vc_row_inner`) has a 24 px bottom margin. When columns stack, the 80 px `column_margin` separates members only *within* a row; between rows the gap is 24 px (+ the card's 7 px). On desktop the rows are 24 px apart.

## Salient image + text row spacing and type (measured on a live Salient site at 390/768/1440, animations off)

- **Split heading `font_line_height`** applies at every width; its `font_size` in `vw` only on desktop (below it the theme's heading size is used). **`max_width="85%"`** caps the heading's measure at every width (IR `headingWidth`).
- **Inner-row paddings** are a share of the column's content width at every width: the picture column's `bottom_padding_tablet` is the space under the picture once columns stack (IR `stackSpace`); the next inner row's `top_padding` is the space under a heading row without a bottom padding (`headGap`), above the centred quote (`quoteGap`) and above the second picture (`media2Gap`). CSS margins in % reproduce them.
- **Eyebrow:** an `h5` alone in the inner row above the heading is the theme's h5 line height tall (13 px × 1.923 = 25 px); that row's `bottom_padding` (px) is the space under it (IR `eyebrowGap`). The generated tokens carry `--eyebrow-leading`.
- **Split-heading paragraph** (`font_style="p"`): `font_size` on desktop, `font_size_tablet` below (bare numbers are px), `font_line_height` everywhere (IR `bodySize`, `bodySizeSmall`, `bodyLeading`).
- **Centred quote** (`font_style="i"`): same size rule (`quoteSize`, `quoteSizeSmall`), `max_width` share of the column (`quoteWidth`). The vertical-line divider above it is 34 px with 25 px above and below.

## Salient element spacing, card columns, image cards, gutter (measured on a live Salient site at 390/768/1440, animations off, 2026-11-20)

- **Default element spacing** (`column_element_spacing="default"` or absent): `.wpb_wrapper > div { margin-bottom: 24px }`, so a text block has 24 px under it. An inline-block `nectar_btn` after it adds its `margin_top` (24 + 40 = 64 px). A px spacing replaces the 24 (5 px → 45). **Only the column's own elements** get its spacing: a button inside an inner row is spaced by the inner column; the outer column's spacing sits under the whole inner row (an outer 10 px was being added to an inner 5 px: 55 instead of 45; 30 + 40 = 70 instead of 64).
- **Stacked image + text with `column_reverse`:** the picture comes first on tablets and phones; the text column's first inner row's `top_padding_tablet` (8 % of the column) is the space under the picture (28 px at 390). IR `stackSpace` falls back to it when the picture column has no bottom padding.
- **Advanced column padding** `right_padding_desktop="7vw"` (`column_padding_type="advanced"`): the text measure is the column minus 7vw at ≥1000 px (519 px at 1440, not the starter's 32rem cap). IR `textEnd` now takes vw.
- **Text block design options** `padding-right: 10%` on every paragraph block: the paragraphs are 10 % narrower (309 of 343 px at 390). IR `bodyEnd`.
- **Split heading opening an image + text column** (rendered as the section heading): the space under it is the IR `headingGap` (37 px = its 7 px margin + 30 px element spacing); the starter applied it only to a heading inside the text, so the text sat 13 px high.
- **`padding-N-percent` columns are not N % below 1000 px** — the theme writes its own values per page: N = 3 → 3vw on phones (≤690), 18 px on tablets, `(100vw − 180px) × 3 %` on desktop (capped at 1425 px); N = 5 → 6vw / 36 px / `(100vw − 180px) × 5 %`. In an edge-to-edge row (`full_width_content`): N = 5 → 5vw on desktop, 6vw below 1000 px; N = 1 → 1vw below 1000 px. Only these measured values are in the adapter's table (`SALIENT_PAD_SMALL`); other N keep the desktop share.
- **Card columns** (background + radius/shadow, `nectar_icon` + `h5` title + `h5` link): the icon sits right on the title (no gap), the title `h5` has a 7 px bottom margin, stacked columns are 25 px apart (`.col { margin-bottom: 25px }` ≤999 px).
- **Image cards between spacers** (spacer / inner row with split heading + `nectar_cta` / spacer): the column's element spacing (5 px) is under the first spacer and under the inner row (150 + 5 + 82 + 5 + 150 at 390); the split heading `h2` keeps the theme's h2 line height (1.2) and its 7 px margin; the CTA link is the body line height (28 px); the heading's `font_size="3vw"` applies on desktop only.
- **wptexturize:** WordPress shows text through `wptexturize`, so the live page has `–` for ` - `, `’` for `'` and curly double quotes; the export has the raw characters. Different glyph widths moved line breaks. The WPBakery adapter now applies the default prose rules to shortcode body text (not attributes, tags, or code/pre).
- **Page gutter on phones:** 6 % of the width on tablets (46 px at 768) and on phones (23.4 px at 390). The audit stores whole pixels (23), which put the starter's phone gutter 0.4 px off and moved line breaks near the edge; when the phone capture is the tablet's share within that rounding, the generated tokens use the share on phones too.
- **Not changed (by design):** the form's sensitive-data notice and the Turnstile widget add ~150 px to the contact row on phones; the primary button text is dark on the accent (the source's white text is 1.9:1, raised to AA by the token generator).

## Form messages admin page — an EmDash native plugin (verified 2026-11-19, emdash 1.5.0, local dev)

- **Registration:** `emdash({ plugins: [{ id, version, format: "native", entrypoint }] })`. The entrypoint is imported by Vite into a generated module (`virtual-modules`: `import { createPlugin } from "<entrypoint>"`), so an absolute file path inside the site works, and so does a package specifier (the kit ships the plugin as `@wp2emdash/forms/plugin`, linked into each site with `link:./packages/forms`; Vite compiles its TypeScript source because the linked path is outside `node_modules`). `createPlugin()` must be a named export.
- **Admin page without React:** `definePlugin({ admin: { pages: [{ path, label, icon }] }, routes: { admin: { handler } } })` and no `admin.entry` → the manifest marks the plugin `adminMode: "blocks"`; the page lives at `/_emdash/admin/plugins/<id><path>` and the admin POSTs Block Kit interactions (`page_load`, `block_action` with `action_id`/`value`, `form_submit`) to `/_emdash/api/plugins/<id>/admin`. The handler returns `{ blocks, toast? }`. Block and element shapes: `@emdash-cms/blocks` `validation-*.d.ts`. Text in `section`/`fields` renders as escaped plain text (no markdown; newlines collapse). Icons: a short map plus any Phosphor name (`envelope`).
- **Access:** a private route's `permission` defaults to `plugins:manage`, which only the Admin role (50) has (`@emdash-cms/auth`). EmDash checks it before the handler, and also requires the `X-EmDash-Request: 1` header (`CSRF_REJECTED` without it; `UNAUTHORIZED` signed out). `ctx.user` carries `id` and `role`. The admin sidebar shows plugin pages to every signed-in role (no `minRole` on plugin pages), so the handler shows "Admins only" with no data to other roles.
- **Bindings:** a native plugin runs in the site's Worker; KV is reached with `await import("cloudflare:workers")` inside the handler (astro.config loads the descriptor in Node, where that module does not exist).
- **File downloads from a plugin:** a route with `response: "raw"` returns `pluginResponse({ status, headers, body: { kind: "text", value } })` (from `emdash`); EmDash keeps only safe headers (`content-type`, `content-disposition`, …), refuses script/HTML-like types, adds `content-security-policy: sandbox` and `nosniff`, max 8 MiB. Private routes need the `X-EmDash-Request` header, which a browser download cannot send, so the export is a `public` GET route that serves a file only for a random token the admin route stored in KV (single use, 2-minute TTL); Block Kit `link` with `target.kind: "external"` opens it in a new tab.
- **Dashboard widgets and tabs:** `admin.widgets: [{ id, title, size }]` with no React entry renders through the same `admin` route; `ctx.ui.surface` is `"dashboard-widget"` there and `"admin-page"` on the page. `tab` panels are rendered client-side from one response (switching tabs does not call the route). `chart` takes `timeseries` (`style: "bar"`) or `custom` ECharts options. Request bodies default to 1 MiB; `request: { body: "json", maxBytes }` raises it (imports).
- **Verify capture: a photo missing from a screenshot** (seen intermittently on one page, never reproduced on demand: the image served 200 to 30 parallel requests, and lazy images loaded under 8× CPU throttling). The capture now leaves no gap for any cause: after the scroll pass every lazy image is switched to eager; a failed image is requested up to three more times (cache-busted); every image is decoded (`img.decode()`) before the full-page screenshot; a page with an image still missing is reloaded and settled once more, and if it still has one the visual check names it ("images missing in the capture (rerun)") instead of counting it as a layout difference. Two consecutive production runs after the change: identical numbers, no incomplete captures.

## Bricks adapter (2026-11-19, not yet verified on a live site)

- Built from Bricks' documented data model: page content in post meta `_bricks_page_content_2` (flat element list), templates as `bricks_template` posts, `_bricks_editor_mode` = `wordpress` when a page is edited with the block editor instead. The EmDash Exporter returns underscore meta (Salient's `_nectar_*` came through on the pilot), so the list should arrive with the post; whether it comes unserialized (array/object) or as text is unconfirmed — the adapter reads arrays, index-keyed objects and JSON text, and reports PHP-serialized text instead of guessing.
- Shared recogniser fix found by the Bricks fixtures: a row whose main collection has no intro field (gallery, tabs, testimonials, stats, video, map, embed, marquee, legacy) used to lose the row's other text; it now becomes a text section before the collection. No pilot output changed.
- **og:image before go-live** (found with a link-preview check on the workers.dev address): EmDash's `<EmDashHead>` overlays the page entry's SEO panel image onto the page context and makes it absolute with `page.siteUrl` (`resolveSeoPanelPage` → `buildSeoImageUrl`); that value wins over the template's `seo.ogImage`. With `siteUrl` = the production domain, every preview of a workers.dev or staging address pointed at the production domain, which still serves WordPress (404). The starter now passes the serving origin as `siteUrl` whenever the page is not served from the production domain (canonical and og:url are absolute and stay on production; on the production domain nothing changes), and adds `og:image:width/height/type` from EmDash's media table. Verify now fetches every og:image (200 + `image/*`).

## Sharing cards in the Worker (2026-11-19, spike then @wp2emdash/og 0.1, experimental)

- Workers cannot compile WebAssembly from bytes at runtime, so Satori's default build (Yoga as inline wasm) fails; `@cf-wasm/satori` / `@cf-wasm/resvg` import `.wasm` files as modules (`workerd` export condition), which the Astro Cloudflare build emits as `compiled-wasm` (yoga 70 KiB, resvg 2.4 MiB). Pilot Worker: 5.19 → 6.30 MB gzip (limit 10).
- Local workerd timings: layout 7–44 ms, raster 26–70 ms, PNG 39–54 KB; fetching fonts dominated (150–870 ms) — the plugin reads them from the site's own static files through the `ASSETS` binding (the Cloudflare adapter adds it) and caches per isolate; cards are stored in R2.
- Satori reads TTF/OTF/WOFF, not WOFF2: scaffold downloads TTF copies from Google Fonts css2 (a plain request gets TrueType).
- `page:metadata` needs no capability for native plugins (`HOOK_REQUIRED_CAPABILITY` has no entry); its contributions come before EmDash's base tags and win. A raw plugin route may return `{ kind: "bytes" }` with `image/png`; `cacheControl` applies to public GET routes. A `link:`ed package does not get its own dependencies installed: the renderer packages go into the site's package.json.

## Editor panels (2026-11-19, @wp2emdash/seo 0.1)

- `admin.editorPanels: [{ id, title, route, collections, order, draft: { read: { fields } } }]` renders a collapsible Block Kit panel at the bottom of the entry editor's sidebar; it calls its route only when opened, with `{ type: "panel_load" }` (no draft). Button and form interactions carry `input.draft` (`fields`, `fieldDefinitions`, identity, base revision) when the plugin has `admin.editor-draft:read` and the panel narrows `draft.read` (an explicit `collections` list is required). `ctx.ui.entry` gives collection, id, locale, version. Endpoint: `POST /_emdash/api/content/<collection>/<id>/plugin-extensions/<pluginId>/panel/<panelId>`; EmDash checks the route permission and that the user may edit the entry (own/any).
- The SEO panel fields (`ContentItem.seo`) are not entry fields, so a draft snapshot never includes them; `ctx.content.get` returns the saved ones. The sidebar is ~340 px: Block Kit tables overflow there, wrapping `section` lines and an `accordion` read well.
- **SEO dashboard (same plugin):** `ctx.content.list` returns `{ items, cursor, hasMore }`; `ctx.media.updateMetadata(id, { alt })` with `media:metadata:write` changes the library item's alt (verified locally, then reverted). Media ids found in section JSON include videos: filter by `mimeType` before asking for alt text. A native plugin's Block Kit chart accepts raw ECharts options (horizontal bar per page).
- **A Worker cannot fetch its own address:** a subrequest to the Worker's own hostname bypasses the Worker and goes to the origin — on workers.dev there is none (404 for every path), on a routed domain it would be the old origin (WordPress before decommissioning). The SEO dashboard's site checks go through a service binding to the Worker itself (`"services": [{ "binding": "SELF", "service": "<worker name>" }]`, per environment); `astro dev` resolves it too.
- **Search Console from the Worker (2026-11-19):** a service account JWT (RS256) signed with WebCrypto (`importKey("pkcs8")`, `RSASSA-PKCS1-v1_5`) is accepted by `oauth2.googleapis.com/token` (verified against Google: a well-formed key for a nonexistent account gets `invalid_grant: account not found`, i.e. the assertion itself parsed). Plugin secret settings: `admin.settingsSchema` fields of `type: "secret"` are encrypted by `ctx.settings.set` and decrypted by `get`; the generated settings endpoint reports only `secretsSet`. **workerd:** a global `fetch` stored as an object property and called as `this.fetcher(...)` throws "Illegal invocation" (Node allows it) — wrap it (`(i, o) => fetch(i, o)`).
- **IndexNow:** the key file's location limits which URLs it may submit (`/<key>.txt` at the root covers the whole host); `api.indexnow.org` answers 200/202 on success, 403 when the key file is not found on the host, 422 for URLs of another host.

## Forms 1.2: EmDash email pipeline and admin recipients (2026-11-19, emdash 1.5.0)

Read from the installed `emdash@1.5.0` (`node_modules/emdash/dist`) of the pilot project; not yet sent end-to-end on staging.

- **Plugin API:** `PluginContext.email?: EmailAccess` (`types-*.d.mts`: `send(message: EmailMessage): Promise<void>`; `EmailMessage = { to: string; cc?: string[]; replyTo?: string; subject: string; text: string; html?: string }`). `PluginContextFactory.createContext` (`context-*.mjs`) sets `ctx.email` only when the plugin declares the **`email:send`** capability **and** `emailPipeline.isAvailable()`; it calls `pipeline.send(message, pluginId)`. Related capabilities (`manifest-schema-*.mjs`): `hooks.email-transport:register` (register the exclusive `email:deliver` hook = be a provider; legacy `email:provide`), `hooks.email-events:register` (`email:beforeSend` / `email:afterSend`; legacy `email:intercept`).
- **Pipeline** (`EmailPipeline` in `emdash-runtime-*.mjs`): validates the message (`to` a single string, `text` and `subject` required, `cc` string array, `replyTo` string), runs `email:beforeSend` (may rewrite or cancel — returns silently when cancelled), then the one selected `email:deliver` provider, then `email:afterSend` (fire-and-forget). Source `"system"` (auth mail) skips before/after hooks; plugin mail goes through them, so any installed hook plugin sees the form contents. A re-entrant send throws `EmailRecursionError`.
- **No provider:** `isAvailable()` is `getExclusiveSelection("email:deliver") !== undefined`. Without a selection `send` throws `EmailNotConfiguredError` ("No email provider is configured…") and `ctx.email` is `undefined`. Providers EmDash registers itself: the built-in SMTP provider (`email-smtp-*.mjs`, settings from the database, password encrypted with `EMDASH_ENCRYPTION_KEY`; selected automatically when `EMAIL_SMTP_*` env is configured, otherwise a manual choice in Settings → Email) and, only under `import.meta.env.DEV`, a console provider that prints recipients, subject and the first 200 characters of the text to the terminal (`email-console-*.mjs`). A provider error is logged by EmDash as `[email:deliver] Provider "<id>" failed to send email to "<to>"` — EmDash itself logs the recipient address (not the content).
- **From a plain Astro route:** anonymous requests get a slim `locals.emdash` without `email` (see above). `emdash/middleware` exports **`withEmDashRuntime(run)`** (`astro/middleware.d.mts`: `(runtime: EmDashRuntime) => T`), documented for queue consumers, `scheduled()` and other request-free code — "server-only and fully trusted… same trust level as plugin cron"; inside a request it reuses the cached runtime with an event-scoped db. `EmDashRuntime.email: EmailPipeline | null` (`config-*.d.mts`). EmDash uses it the same way itself: `@emdash-cms/cloudflare/worker` (`import("emdash/middleware")` for `runScheduledTasks`/`withEmDashRuntime`) and the AI Search snippet endpoint (`plugins/ai-search.mjs`, an Astro endpoint calling `withEmDashRuntime`). No capability check applies on this path (it is not a plugin context); the forms package passes source `site-forms` (its plugin id) so hooks attribute the mail correctly.
- **Kit result (`@wp2emdash/forms` 1.2.0):** `EMAIL_PROVIDER=emdash` → endpoint and outbox cron send via `withEmDashRuntime(rt => rt.email.send(msg, "site-forms"))` (first recipient `to`, rest `cc`, reply-to the visitor's bare address); no provider selected → kept in the outbox (or 503 without one); provider error → outbox. Admin recipients are a KV key in `FORM_OUTBOX` (`cfg:recipients`), because the endpoint reads that binding directly per request; plugin `ctx.kv` lives in the D1 options table, which a site route could only reach through EmDash internals.

## Redirects API (emdash 1.5.0, verified 2026-11-19 from the installed source)

- `POST /_emdash/api/redirects` (`redirects:manage`), body `CreateRedirectBody` (`redirects-*.mjs`): `source` and
  `destination` are **paths** (must start with `/`, no `//`, no CR/LF, no `..`), so redirects to another site cannot be
  stored; `type` 301/302/307/308 or terminal 410/451 (destination empty); `enabled`; `groupName`.
- Patterns use Astro route syntax only (`patterns-*.mjs`): `[param]`, `[...rest]`, compiled to safe regexes; no
  user regex. The kit converts `^/x/(.*)$ → /y/$1` into `/x/[...path] → /y/[...path]` and reports any other regex.
- Creating a source that exists returns `CONFLICT`; loops are refused (`wouldCreateLoop`). `GET /redirects` is
  cursor-paged (`limit` ≤ 100, `nextCursor`), `PUT /redirects/{id}` updates (`UpdateRedirectBody`).
- Kit result: extract reads plugin exports from `raw/plugin-exports/` (`src/extract/plugin-exports.ts`), load syncs
  `raw/redirects.json` with `groupName: "wordpress"` (created / updated / unchanged; admin-made redirects are kept).


## Sandboxed plugins and the Mail API plugin (verified 2026-11-19)

**Sandbox on Cloudflare (emdash 1.5.0, @emdash-cms/cloudflare):** `sandbox()` returns the runner only when the
environment's wrangler config has a Worker Loader binding named `LOADER` (`worker_loaders`; Workers Paid); otherwise it
warns "Sandboxed plugins are disabled". A runner turns on the hosted registry (admin installs) unless `registry: false`.
Plugins can be declared in `astro.config.mjs` → `emdash({ sandboxed: [descriptor], sandboxRunner: sandbox() })` from
npm, pinned — the kit's `sandboxedPlugins` (kit.config.ts) does this per environment and keeps the registry off.

**`@devbitme/emdash-plugin-apimail` 0.3.1 (reviewed from the npm tarball, MIT, no runtime dependencies):**
- Capabilities: `network:request` limited to the providers' API hosts (api.brevo.com, Mailgun, Mailjet, Maileroo,
  Postmark, Mandrill, Resend, SendGrid, MailerSend, Scaleway) and `hooks.email-transport:register`.
- API keys: EmDash secret settings (encrypted with `EMDASH_ENCRYPTION_KEY`). Requests time out after 10 s.
- History (plugin storage `messages`): status, recipient, provider message id, attempts; the body only for non-system
  email and only when "keep email content" is on, AES-GCM-encrypted with a content key. Sign-in/invite email bodies are
  never stored. Retention 30 days by default (1–3650). Queue: 24 h for ordinary email, 15 min for sign-in email.
- Logging: no `console.*`; the plugin log records recipient address and provider error, never content.
- Needs a cron for the retry queue (the kit's Worker runs `*/5 * * * *` with EmDash's scheduled handler).
- For sensitive sites: use it for EmDash's own email (sign-in, invites); keep website forms on `@wp2emdash/forms`
  direct delivery, and turn "keep email content" off.

## Forms 1.3: signatures, attachments, rich consent (verified 2026-11-19, emdash 1.5.0 from the installed source)

- **EmDash email has no attachments.** `EmailMessage` in emdash 1.5.0 (`dist/types-*.d.mts`) is `to`, `cc`, `replyTo`,
  `subject`, `text`, `html` — nothing else. With `EMAIL_PROVIDER=emdash` a signature PNG is embedded in the HTML part
  as a `data:image/png;base64,` `<img>`; the text part says so. Gmail (web and apps) and some Outlook builds do not show
  data-URI images, so a site that takes signed waivers should use an API provider (attachment) — see the forms README.
- **Provider attachment fields** (each provider's API reference, 2026-11-19): Brevo `attachment: [{ name, content }]`
  (base64; png allowed); Resend `attachments: [{ filename, content }]` (base64 string; type derived from the filename);
  Postmark `Attachments: [{ Name, Content, ContentType }]`; SendGrid `attachments: [{ content, filename, type,
  disposition }]`; Mailgun `attachment` file parts, which require `multipart/form-data`. Not yet sent end-to-end.
- **Block Kit image in the admin.** `@emdash-cms/blocks` 1.5 `image` block = `{ url, alt, title? }`, rendered as
  `<img src={url}>` by React. The image-host policy (`allowedImageHosts`, https or root-relative only) is applied to
  sandboxed and marketplace plugins only (`getSandboxedAdminDefinition`); a native plugin's blocks are not filtered.
  EmDash's admin CSP has `img-src 'self' https: data: blob:`, so a `data:image/png` URL renders. The Form messages page
  only uses one after re-checking it is a PNG within the caps.
- **Fluent Forms elements** (from a real export): radio `input_radio` (`settings.advanced_options[].label/value`),
  terms `terms_and_condition` (`settings.tnc_html`, `admin_field_label`, `attributes.name` `terms-n-condition`),
  GDPR `gdpr_agreement`, signature add-on `signature` (`settings.label`, `sign_*` pad styling, `validation_rules`),
  `custom_html` (`settings.html_codes`), `section_break` (`settings.label`, `description`).
