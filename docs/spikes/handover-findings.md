# Handover pack: EmDash 1.5 sign-in, roles and admin names

Checked 2026-11-22 against the installed `emdash@1.5.0` (and its `@emdash-cms/auth`, `@emdash-cms/admin`) in the
M0 spike project, before `wp2emdash handover` (src/handover/) put any of it in front of a site owner.

## Sign-in methods

Routes under `emdash/dist/astro/routes/api/auth/`:

| Method | Route | When it works |
|---|---|---|
| **Passkey** ("Sign in with Passkey") | `passkey/options`, `passkey/verify`, `passkey/register/*` | Always: EmDash's default. No passwords anywhere in EmDash. |
| **Email link** ("Sign in with email link") | `magic-link/send`, `magic-link/verify` | Only when EmDash's email pipeline is available (`emdash.email.isAvailable()`): Settings → Email (SMTP) or an email provider plugin. Otherwise `send` answers `EMAIL_NOT_CONFIGURED` (503). The admin says the same: "Choose SMTP above or install an email provider plugin to enable email features like invitations, magic links, and password recovery." |
| GitHub / Google | `oauth/[provider]` (`VALID_PROVIDERS` = github, google) | Only with `EMDASH_OAUTH_GITHUB_CLIENT_ID/SECRET` or `EMDASH_OAUTH_GOOGLE_*` on the Worker. The kit sets none, so the handover pack never mentions them. |
| Invite | `invite/*` | An administrator invites a person (Users → Invite); the invite link opens passkey registration. EmDash emails it when email is set up, else the admin shows the link to pass on. |

- **Passkeys only work at the address where they were created** (WebAuthn binds them to the host). EmDash 1.5 adds
  `POST /_emdash/api/auth/handover`: a signed-in user gets a single-use, 5-minute sign-in link for the site's chosen
  address (Site URL), which opens Settings → Security ready to add a passkey there. Admin wording: "Passkeys only work
  at the address where they were created. Continue on <host> to sign in there without a passkey, then add one for that
  address." and, when the old address is gone, "Passkeys from another address don't work at <host>, so users sign in
  with an email link and add a new passkey."
  → The pack tells owners of sites that are not live yet that their passkey from the temporary workers.dev address
  will not work on the domain after launch (and the workers.dev address is switched off after go-live unless
  `target.keepWorkersDev`), so they sign in there with an email link or a new invite and add a passkey.
- Sessions: the kit's `sessions.days` (default 30, docs/spikes/sessions-findings.md) — the session is not sliding, so
  people sign in again after that many days.

## Roles

`@emdash-cms/auth` `Role` = SUBSCRIBER 10, CONTRIBUTOR 20, AUTHOR 30, EDITOR 40, ADMIN 50 (the kit's
`EMDASH_ROLES`, src/transform/users.ts). Admin labels (en locale): Administrator, Editor, Author, Contributor,
Subscriber.

Permissions (`@emdash-cms/auth` dist): `content:edit_any` / `publish_any`, `media:edit_any`, `menus:manage`,
`widgets:manage`, `sections:manage`, `comments:moderate` = EDITOR; `content:edit_own` / `publish_own` = AUTHOR;
`content:create` / `edit_own_drafts`, `media:upload` = CONTRIBUTOR; `settings:manage`, `users:invite` / `users:manage`,
`comments:delete` = ADMIN (`settings:read` = EDITOR). The kit's plugins open their admin pages to admins only (Form messages, Site health, Backups, Privacy &
consent, Sharing images, Motion) or to editors and admins (SEO, SEO fix-it, Media, Change requests) — each package's
README.

The pack shows role names and counts only (`ir/users.json`, counts per role written by transform); never names or
addresses from `sites/<slug>/users/invites.json`.

## Admin names used in the pack

From `@emdash-cms/admin` 1.5.0 `locales/en/messages.mjs`: Content, Pages, Media Library, Menus, Sections, Widgets,
Redirects, Comments, Users, Plugins, Settings, Security; in the editor: Add block, Drag to reorder, Insert a reusable
section, Preview draft, Publish, Schedule, Revisions. The admin lives at `/_emdash/admin`; the kit's plugin pages
are under Plugins (labels from each package's admin page title).

## Not verified here

- The exact text of the sign-in screen buttons in other locales (the pack is English).
- Whether a given site has Settings → Email configured: that lives in its D1 database, not in the kit's files, so the
  pack says "once email is set up in Settings → Email" unless kit.config uses EmDash's own email (`email.provider:
  "emdash"`), where it is set up as part of the launch.
