# Form leads to a CRM / mailing list — findings

Date: 2026-11-22. Package: `@wp2emdash/forms` 1.11.0 (`packages/forms/src/crm.ts`). Provider request shapes come from
their public API references (read 2026-11-22, links below); **no provider was called with credentials** — the tests
use a fake `fetch`. Runtime facts reuse those already verified for chat notifications
(`chat-notifications-findings.md` C1–C6: `waitUntil` from `cloudflare:workers`, native-plugin descriptor options,
Block Kit `checkbox` / `select` / `toggle` form elements, Worker secrets as plain strings, `redirect: "manual"`,
`AbortSignal.timeout`). Live checks still open are listed at the end.

## Providers

### Brevo — contacts

- `POST https://api.brevo.com/v3/contacts`, header `api-key: <key>`, JSON. Source:
  https://developers.brevo.com/reference/createcontact
- Body used: `{ email, updateEnabled: true, attributes?, listIds? }`. `updateEnabled: true` updates an existing contact
  in the same call (create-or-update). Attribute keys are upper case and **must already exist** in the account; values
  of the wrong type are ignored. Default attributes are `FIRSTNAME`, `LASTNAME`, `SMS` in English accounts — accounts in
  other languages can have other names (e.g. `PRENOM` / `NOM`), hence editable names in Settings.
- `SMS` must carry the country code (`+91…`, `0091…`, `91…`); the kit only sends it when the number normalises to
  `+<7–15 digits>`, so a local number does not make the whole call fail.
- Answers 201 (created, `{ id }`) or 204 (updated); errors `{ code, message }` (e.g. `invalid_parameter`,
  `duplicate_parameter`), 400 / 401 / 425.
- Consent: `listIds` only with a ticked opt-in. Without a list the contact exists but is in no campaign list.
  `emailBlacklisted` is never sent (it would overwrite an existing subscriber's state). Brevo's double opt-in endpoint
  (`/contacts/doubleOptinConfirmation`) needs a DOI template and redirect URL — not used; noted as a limitation.
- Key reuse: Brevo v3 API keys are not scoped, so the transactional email key (`EMAIL_API_KEY`, `EMAIL_PROVIDER=brevo`)
  can create contacts. The kit uses it only when `BREVO_API_KEY` is unset, sends it only to `api.brevo.com`, and Settings
  says which key is in use. A separate `BREVO_API_KEY` (e.g. a different Brevo account for marketing) wins.

### HubSpot — contacts (CRM v3)

- Chosen over the Forms submission API: the Forms API needs a HubSpot form created per site form with matching field
  names and a portal id + form GUID per form (the unauthenticated endpoint) or the `forms` scope; the contacts API needs
  one scope and no per-form setup in HubSpot.
- Auth: `Authorization: Bearer <private app token>` (`pat-<region>-<uuid>`). Scope: `crm.objects.contacts.write` (the
  documented scope for contact writes; the reference page's scope section was collapsed when read — **confirm with a real
  private app**, live check 3).
- Create: `POST https://api.hubapi.com/crm/v3/objects/contacts`, `{ properties: { email, firstname, lastname, phone,
  company, message } }` — all default contact properties. An existing email answers **409 Conflict**.
- Update: `PATCH https://api.hubapi.com/crm/v3/objects/contacts/<email>?idProperty=email`, `{ properties }`.
- Not used: `POST /crm/v3/objects/contacts/batch/upsert` with `idProperty: "email"` — one call, but community reports
  (2024–2025) of 400 "non-unique property" on some portals, and partial upserts are documented as unsupported with
  email as `idProperty`. Create → 409 → PATCH is two documented calls with the same scope.
- Errors: `{ status, message, correlationId, category, errors?[] }`; the kit keeps `category: message`, scrubbed.
  Sources: https://developers.hubspot.com/docs/api-reference/crm-contacts-v3/guide,
  https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/contacts/batch/upsert-contacts.md
- Consent: HubSpot marketing subscriptions live in the communication preferences API (separate scope) — not touched.
  With a ticked opt-in the kit sets a property the admin names (e.g. a custom single checkbox `newsletter_opt_in`) to
  `"true"`; a HubSpot workflow can subscribe from there.

### Mailchimp — audience members (Marketing API 3.0)

- `PUT https://<dc>.api.mailchimp.com/3.0/lists/<list_id>/members/<subscriber_hash>` (add or update). Source:
  https://mailchimp.com/developer/marketing/api/list-members/add-or-update-list-member/
- `subscriber_hash` = MD5 of the lower-case email. Workers' Web Crypto has no MD5, so `crm.ts` has a small MD5
  (checked against Node's `crypto` in the tests: empty string, an address, a 120-byte input).
- Auth: HTTP Basic with any user name and the API key as password (quick start: `--user "anystring:${apikey}"`); the
  reference also accepts `Bearer <key>`. The data center is the key's suffix (`…-us21`), the documented convention for
  API keys (the docs' examples use `api.mailchimp.com`; account calls go to `<dc>.api.mailchimp.com`).
  `MAILCHIMP_SERVER_PREFIX` overrides it.
- Body: `{ email_address, status_if_new, status?, merge_fields? }`. Statuses: `subscribed`, `unsubscribed`, `cleaned`,
  `pending`, `transactional`.
  - Ticked opt-in: `status_if_new` and `status` = `subscribed`, or `pending` with double opt-in (Mailchimp emails a
    confirmation; default on).
  - No tick / no opt-in field: skipped (default), or `status_if_new: "transactional"` without `status`, so an existing
    member keeps whatever status they have. Never `subscribed` without a tick.
- `merge_fields` keys are merge tags (default audience: `FNAME`, `LNAME`, `PHONE`, `ADDRESS`, `BIRTHDAY`). An unknown
  merge tag answers 400, so names are editable and empty means "not sent".
- Errors are problem JSON `{ type, title, status, detail, instance }` (per Mailchimp's errors guide; the member page shows
  only the 200 schema); the kit keeps `title: detail`, scrubbed.

## Design notes

- Settings in the outbox KV under `cfg:crm` (like `cfg:chat`); without `FORM_OUTBOX` there is no Form messages page and
  no sync. The plugin descriptor now carries each form's mappable fields (name, label, type — never values) and its
  `sensitive` flag (`pluginForm()`), so Settings can offer a mapping per form.
- Retries: own job prefix `crm:` in the same KV and the same 5-minute cron (`flushCrm` next to `flushChat`), with
  backoff via a `next` timestamp in the job (5 min, 15 min, 1 h, 4 h, 12 h; 6 attempts). Jobs hold the mapped contact
  only, TTL `min(2 days, retention)`. Temporary = network / timeout / 408 / 425 / 429 / 5xx; other 4xx are permanent
  (retrying a bad key or a bad merge field cannot help) and go straight to the failure count and last error.
- Error text: provider wording kept so an admin can act ("unauthorized: Key not found", "Invalid Resource: …"), with
  the contact's values (and each word of a name / company), any email address and digit runs of 7+ replaced; 300
  characters at most.
- Sensitive refusal is checked three times: saving settings (`crmSettingsFromForm`), a new message (`syncCrm`) and each
  retry (`flushCrm`). A form that becomes sensitive in a redeploy keeps at most two days of retries only if an admin had
  explicitly picked providers for it — saving Settings afterwards clears them; a site that becomes sensitive drops all.

## Needs a live check (deployed site, real accounts)

1. Brevo: a contact created, then updated on a second message; with a list id and a ticked opt-in the contact joins
   the list; a local phone number is left out, an international one lands in `SMS`. Also with the email key reused.
2. Brevo in a non-English account: attribute names (`PRENOM` / `NOM`) set in Settings work.
3. HubSpot: a private app with only `crm.objects.contacts.write` creates a contact; a second message hits 409 and the
   PATCH by email updates it; the named opt-in property is set.
4. Mailchimp: key suffix → data center; ticked opt-in with double opt-in → `pending` + confirmation email; without
   double opt-in → `subscribed`; "transactional" → a transactional contact; an existing unsubscribed member stays
   unsubscribed without a tick.
5. A wrong key per provider: Settings shows the last error (401) with no visitor data, the message itself is emailed
   and kept as usual.
