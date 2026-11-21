# Chat notifications for form messages — findings

Date: 2026-11-21. Package: `@wp2emdash/forms` (`packages/forms/src/chat.ts`). Checked against the installed EmDash
1.5.0 packages (`spikes/m0-site/node_modules`: `emdash`, `@emdash-cms/admin`, `@emdash-cms/blocks` 1.5.0) and
`@cloudflare/workers-types` 5.20261116.1 (the version the scaffold pins). Source reading only — **not yet run on a
deployed site**; the live checks are listed at the end.

## Facts relied on

| # | Fact | Evidence |
|---|---|---|
| C1 | `cloudflare:workers` exports `waitUntil(promise)`: background work after the response, outside a request's `ctx`. The form endpoint (an Astro route) uses it to send notifications after answering the visitor. | `@cloudflare/workers-types` 5.20261116.1 `index.d.ts`: `declare namespace CloudflareWorkersModule { … export function waitUntil(promise: Promise<unknown>): void; … }` and `declare module "cloudflare:workers" { export = CloudflareWorkersModule; }`. EmDash 1.5.0 itself does the same under the Cloudflare adapter: `dist/virtual-modules-*.mjs` generates `export { waitUntil } from "cloudflare:workers";` (its `after()` helper). The endpoint falls back to letting the promise run when `waitUntil` is missing. |
| C2 | A plugin admin page URL can carry a sub-path: the admin route is `/plugins/$pluginId/$` and the page path sent to the plugin is `"/" + _splat`. For a native (Block Kit) plugin without a React page, `SandboxedPluginPage` posts `{ type: "page_load", page }` to the plugin's `admin` route with that path. Nothing on the way checks the path against the declared pages. | `@emdash-cms/admin` 1.5.0 `dist/index.js`: `pluginRoute` (`path: "/plugins/$pluginId/$"`), `PluginPage()` (`const pagePath = "/" + (_splat \|\| "")`), `SandboxedPluginPage` (`sendInteraction({ type: "page_load", page }, true)`); `resolvePluginLinkTarget` builds `/_emdash/admin/plugins/<id><path>`. So a notification links to `/_emdash/admin/plugins/site-forms/messages/<time>_<hex>` and the plugin opens that message on `page_load`. The key is mapped to URL-safe characters only (`msg:` dropped, `:` → `_`) so no percent-decoding question arises. |
| C3 | Block Kit 1.5 has `checkbox` (options, `initial_value: string[]`, value = the ticked values) and `radio` form elements; a `form` block seeds its submitted values with every field's `initial_value`, so untouched toggles and selects arrive with their shown value. | `@emdash-cms/blocks` 1.5.0 `validation-*.d.ts` (`CheckboxElement`, `RadioElement`), `dist/index.js` `CheckboxElementComponent` (`onChange(action_id, newValues)` with an array) and the form block (`for (const field of fields) if ("initial_value" in field && field.initial_value !== void 0) values[field.action_id] = field.initial_value;`). |
| C4 | A native plugin descriptor's `options` reach `createPlugin(options)` in the Worker. Used to pass the site's form ids and titles for the "Which forms notify" picker. | Same mechanism as `@wp2emdash/health` (`healthPlugin(options)` → `createPlugin(options)`), recorded in `health-findings.md`. |
| C5 | Worker secrets are plain strings on `env` (`TELEGRAM_BOT_TOKEN`, `SLACK_WEBHOOK_URL`, `CHAT_WEBHOOK_URL`); the admin page only reports whether each is set (and looks right), never its value. | As for `EMAIL_API_KEY` / `FORM_FILE_SECRET` (M7, forms 1.7). |
| C6 | Sending uses `fetch` with `redirect: "manual"` (a redirect counts as a failure, so a token or webhook URL is never re-sent elsewhere) and `AbortSignal.timeout(8000)`, both available in Workers; the code skips the timeout where `AbortSignal.timeout` is missing. | Workers runtime APIs (fetch `redirect` "follow"/"manual"; `AbortSignal.timeout`). |

## Third-party APIs (from their public docs, not called from the kit's tests)

- **Telegram Bot API** `POST https://api.telegram.org/bot<token>/sendMessage`, JSON `{ chat_id, text, parse_mode: "HTML",
  link_preview_options: { is_disabled: true } }`; HTML mode needs only `&`, `<`, `>` escaped (and `"` inside an `href`);
  supported tags include `<b>`, `<i>`, `<a href>`, `<blockquote>`; text limit 4096. Answers `{ ok: true }` / HTTP 200.
  Chat ids: users positive, groups negative, channels `-100…`, or a public channel's `@username`.
- **Slack incoming webhooks**: `POST` JSON `{ text, unfurl_links, unfurl_media }`, mrkdwn; Slack asks for `&`, `<`, `>`
  to be escaped as `&amp;` `&lt;` `&gt;` (this is what stops injected `<url|text>` links and `<!channel>` mentions).
  Answers `200 ok`.
- **Discord webhooks**: `{ content, allowed_mentions: { parse: [] } }` (no pings), content limit 2000.
- **Google Chat webhooks**: `{ text }`; unknown fields are rejected, hence the separate "Text only" format.
- **WhatsApp**: the WhatsApp Business Platform (Cloud API, also behind Twilio) needs a Meta Business account, a
  registered number and approved templates for business-initiated messages, and is billed per conversation — no free
  official route, so it is reached through the generic webhook and an automation tool (README → WhatsApp).

## Design notes

- Settings live in the outbox's KV (`cfg:chat`), like the recipients setting: the endpoint reads them per message.
  Without `FORM_OUTBOX` there is no Form messages page, so no settings and no notifications.
- Retries reuse the outbox's mechanism: the same KV (`chat:<time>:<hex>` jobs, TTL 1 day) and the same 5-minute cron
  (`flushChat` next to `flushOutbox` in `starter/src/worker.ts`). 5 attempts in all, then a per-day, per-channel count
  (`chatfail:`) that Settings and Site health read.
- Test messages (`FORM_LIVE_HOST`) never notify: before go-live every message is a test, and the chat goes to the
  client's people, the same reason test emails go only to `FORM_TEST_TO`. The admin's test button covers setup.

## Needs a live check (deployed site)

1. `waitUntil` from `cloudflare:workers` in the built Astro endpoint: a submission with Telegram on answers at once and
   the Telegram message arrives (C1).
2. Clicking a notification's link while signed out → EmDash login → back to the message; signed in → the message page
   opens and is marked read; the sidebar still shows Form messages (C2).
3. Settings: toggles, the chat id field, the radio and the form checkboxes save and reload as shown (C3).
4. Each channel once with a real secret: Telegram (group and channel ids), Slack, Discord, Google Chat ("Text only"),
   a Make/Zapier/n8n catch hook (JSON event).
5. A deliberately wrong secret: the test button reports the failure; a real message's notification is retried by the
   cron and, after 5 attempts, counted in Settings and Site health.
