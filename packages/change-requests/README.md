# @wp2emdash/change-requests (experimental) — Change requests

A built-in wp2emdash plugin for EmDash sites on Cloudflare Workers, on by default in every site the wp2emdash kit
builds (`changeRequests: false` in `kit.config.ts` turns it off). Editors and admins.

Clients ask the agency for changes from inside their admin instead of email or WhatsApp, and see the status.

## What it does

**Plugins → Change requests** (tabs Requests, Request a change, and Delivery for the agency):

- **Request a change**: title (120 characters), description (plain text, 4,000 characters), page picker (the site's
  pages, or *Anywhere on the site*) and an optional "which part of the page", priority (normal / urgent), how to get
  back (in the admin, email, phone — no phone number is stored), and "email me updates" (on by default).
- **Files**: up to 3 per request, PNG / JPEG / GIF / WebP / PDF, 5 MB each, recognised by their first bytes (a renamed
  HTML or SVG file is refused). Stored in the site's R2 bucket under `backups/change-requests/<request>/`, a prefix
  EmDash's public media route never serves. Downloads are **one-time links** (random 192-bit token, 5 minutes, used
  once) that only a signed-in editor or admin can create; always served as a download. The upload page (`/attach`)
  takes chosen files or a pasted screenshot.
- **Requests list**: every request of the site for every editor, with status, priority and "only mine" filters;
  urgent open requests first. `/requests/<id>` opens one request (emails link there).
- **One request**: details, files, timeline (created, comments, status changes, files — who and when, "(agency)"
  marked), a reply / comment box with the status moves this person may make, and "Stop update emails" for the
  requester.
- **Editor panel** "Request a change" on pages (and posts on blog sites): the open requests for this page and a short
  form with the page already chosen.
- **Dashboard widget**: open, urgent and "waiting for you" counts and the latest status changes.

### Statuses and permissions

`New → Seen → In progress → Waiting for you → Done / Declined`

| Who | May |
|---|---|
| Editors and admins | send requests, see all of the site's requests, comment on open requests, add files to open requests (3 per request in all), download files |
| The agency (admins; with `agencyDomains`, only admins with an email at those domains) | every status move (New/Seen/In progress/Waiting → any later one; Done/Declined → In progress), reply as the agency, comment on closed requests. Opening a New request marks it Seen. |
| The requester (client side) | withdraw their own open request (→ Declined, "withdrawn"), mark it Done when it is In progress or Waiting for you, reopen it within 30 days after Done (→ New) |
| Other client-side editors | comment only — a request's status is the requester's and the agency's business |
| Authors, contributors, subscribers | nothing (the routes need `content:edit_any`; the role is checked again) |

A client-side comment on a request that is *Waiting for you* moves it back to *In progress*.

## Emails

Sent the way the site's forms send them (`EMAIL_PROVIDER` + `EMAIL_API_KEY` + `FORM_FROM`, or `EMAIL_PROVIDER=emdash`
for EmDash's own email settings); never from a staging Worker.

- **New or reopened request** → the agency (`agencyTo`, kit.config `changeRequests.agencyTo`, default
  `email.stagingTo`), with a link to the request in the admin. When the client chose "Email me", Reply-To is the
  client, so the agency can answer by email too (such replies are not recorded on the request).
- **Status change** (except to *Seen*) and **agency reply** → the requester, unless they switched update emails off.
- **Client-side comment** → the agency.

Messages hold only that request (number, title, description, page, priority, status, the comment that came with it)
and its link — never other requests, form messages, attachment contents or download links.

## Webhook (optional)

kit.config `changeRequests.webhook` (https) + the Worker secret `CHANGE_REQUESTS_WEBHOOK_SECRET` (at least 16
characters; without it nothing is sent, never unsigned). Never from staging. Events `request.created`,
`request.reopened`, `request.status_changed`, `request.commented`, POSTed as JSON:

```json
{
  "event": "request.status_changed",
  "at": "2026-11-20T12:00:00.000Z",
  "site": { "name": "Acme", "url": "https://acme.example" },
  "request": {
    "id": "0123456789abcdef", "number": 7, "title": "Update the opening hours",
    "description": "Saturday is now 9–13.", "status": "waiting", "statusLabel": "Waiting for you",
    "priority": "normal", "page": { "title": "Contact", "collection": "pages", "id": "01J…" }, "section": null,
    "requester": { "name": "Jane" }, "contact": "email",
    "createdAt": "…", "updatedAt": "…",
    "attachments": [{ "name": "shot.png", "type": "image/png", "size": 48213 }],
    "url": "https://acme.example/_emdash/admin/plugins/change-requests/requests/0123456789abcdef"
  },
  "change": { "by": "Dev", "agency": true, "from": "in_progress", "to": "waiting", "comment": "Which Saturday?" }
}
```

Headers: `X-Change-Request-Timestamp: <unix seconds>` and `X-Change-Request-Signature: sha256=<hex>` =
HMAC-SHA256(secret, `<timestamp>.<raw body>`). Verify the signature and reject old timestamps (e.g. > 5 minutes).
The requester's email address is never in the payload. For ClickUp / Linear / Slack, point a Zapier or Make "catch
hook" at it (they cannot verify the HMAC themselves; use their secret URL, and keep the URL itself private).

## Privacy and retention

Requests are the client's site content. Stored per request: what was asked, the timeline, attachment names, the
requester's display name and email (for update emails). Nothing else personal. Closed (Done / Declined) requests are
deleted with their files **12 months** after closing (`retentionMonths`), by a daily task; open requests are kept.
On `sensitiveData` sites the form asks people to leave out personal details of clients or visitors.

**Backups**: the request rows (`plugin:change-requests:req:*` in D1 `options`) are in the Backups plugin's nightly
backups (an explicit allowlist entry; the plugin's other rows — one-time links, the delivery log — and every other
`plugin:*` row stay out). Attachments stay in R2 (Backups never copies files; `backups/` is not in its media
manifest). Restoring requests from a backup file is not a button: D1 Time Travel restores everything, including them.

## Register

```js
// astro.config.mjs (the kit's scaffold writes this)
import { changeRequestsPlugin } from "@wp2emdash/change-requests";
emdash({ plugins: [changeRequestsPlugin({ productionUrl: "https://example.com", siteName: "Example", agencyTo: ["team@agency.example"], collections: ["pages"] })] });
```

Needs the `MEDIA` (R2) binding EmDash already uses, the Worker's cron trigger (daily retention), `react` (already in
every kit site — the admin bundles the upload page), and for email the site's email settings. Optional Worker secret
`CHANGE_REQUESTS_WEBHOOK_SECRET`.

Facts and limits: the kit's `docs/spikes/change-requests-findings.md`.
