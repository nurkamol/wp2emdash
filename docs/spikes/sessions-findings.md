# Sign-in sessions: Workers KV → R2

Verified 2026-11-20 against the installed packages of a generated project (Astro 7.4.12, @astrojs/cloudflare 14.4.8,
unstorage 1.17.6, Wrangler 4.163.0, EmDash 1.5.0), by reading their `dist/` sources and by building and running a
throwaway copy of that project (`astro build`, then `wrangler dev --local`). Nothing was deployed; Cloudflare was only
read (one `GET …/lifecycle` and `GET …/domains/managed` on an existing bucket with the kit token).

## The problem

Editors on a live site intermittently got **"Error — Not authenticated"** in the EmDash admin; **Retry** often landed
on the sign-in page — the session was gone.

## How EmDash finds the signed-in user

- EmDash keeps only `{ id }` under the Astro session key `user` (`session.set("user", { id })` in
  `astro/routes/api/auth/passkey/verify.mjs`, `magic-link/verify.mjs`, `oauth/…/callback.mjs`, `invite/complete.mjs`…).
- Every request resolves it with `resolveSessionUser` (`dist/session-user-*.mjs`): `session.get("user")` raced against
  a **3 s fail-closed timeout**; a missing value or a stalled read = anonymous (401 on the admin API → "Not
  authenticated").
- EmDash sets no session `ttl` and no cookie options: the cookie is Astro's default `astro-session` (httpOnly,
  sameSite lax, secure in production, path /, no maxAge → a browser-session cookie).

## (a) The KV driver, and why it logs people out

- With no `session.driver`, `@astrojs/cloudflare` (`dist/index.js`, `astro:config:setup`) sets
  `sessionDrivers.cloudflareKVBinding({ binding: "SESSION" })` — unstorage `drivers/cloudflare-kv-binding.mjs`.
- Its `getItem` is `binding.get(key)` — **no `cacheTtl`**, so Workers KV's default edge cache (60 s) applies, to
  misses too. KV is eventually consistent: a key written in one location can be missing in another for up to ~60 s,
  and a "not found" read is cached there.
- Astro's session runtime (`astro/dist/core/session/runtime.js`, `#ensureData`) turns a miss into a **new session**:
  when the cookie's id has no stored value it generates a fresh `crypto.randomUUID()` and, if anything is written,
  sends a new cookie. So one stale/negative KV read does not just fail one request — it can replace the editor's
  session id, and the old, valid session is never read again. That matches "Not authenticated" → Retry → sign-in.

## (b) The R2 driver

- `sessionDrivers.cloudflareR2Binding(opts)` → unstorage `drivers/cloudflare-r2-binding.mjs`, options
  `{ binding?: string | R2Bucket; base?: string }`. `getItem` = `binding.get(key)` → `.text()`, `setItem` =
  `binding.put(key, value)`, `removeItem` = `binding.delete(key)`. Keys are the bare session UUIDs (no `base` set).
- **Binding lookup in workerd.** With a string, unstorage's `getBinding` reads `globalThis[name] ||
  globalThis.__env__[name]` (`drivers/utils/cloudflare.mjs`). A module Worker has no bindings on `globalThis`, and
  nothing in Astro/the adapter/EmDash sets `__env__` (grepped): **a bare `{ binding: "SESSIONS" }` fails at runtime**.
- What makes it work: on every request the adapter calls `injectSessionBinding(manifest, env)` (`dist/utils/cf.js`),
  which sets `sessionConfig.options.binding = env[sessionKVBindingName]` when that binding exists — for any driver.
  `sessionKVBindingName` is an adapter option (default `"SESSION"`, passed to the runtime through the
  `virtual:astro-cloudflare:config` module). So the config must be:

  ```js
  import { defineConfig, sessionDrivers } from "astro/config";
  adapter: cloudflare({ sessionKVBindingName: "SESSIONS" }),
  session: { driver: sessionDrivers.cloudflareR2Binding({ binding: "SESSIONS" }), ttl: 2592000 },
  ```

  (The option name says KV; it only names the binding injected as the driver's `binding`.)
- Trap: had the R2 binding been named `SESSIONS` **without** `sessionKVBindingName`, while the old `SESSION` KV binding
  stayed in wrangler.jsonc, the adapter would inject the **KV namespace** into the R2 driver (`r2.text is not a
  function` on read). With `sessionKVBindingName: "SESSIONS"` a leftover `SESSION` KV binding is simply ignored; the
  kit removes it anyway in R2 mode.
- R2 is strongly consistent (read-after-write, list-after-write) and has no negative-lookup cache.

## (c) Expiry

- Astro stores the expiry **in the value**: `session.set(key, value, { ttl })` with `ttl ?? config.ttl` keeps
  `{ data, expires }` per key; `#ensureData` drops expired keys on read. Persist is `storage.setItem(id, serialized)`
  **without a driver TTL** — on KV too (KV session entries never expired either).
- Stored object, read back from local R2: `[["Map",1,2],"probe",{"data":3,"expires":5},{"at":4},1795198962822,1797790962823]`
  (expires = set time + 2 592 000 s).
- R2 has no TTL: without a lifecycle rule session objects (one per sign-in, also abandoned ones) pile up. The kit sets a
  **bucket lifecycle rule** deleting objects `days` after their last write, and Astro's `ttl` = the same `days`. The
  object is written at or after the moment `user` was set, so the rule never deletes a session before its ttl. The
  session is not sliding: EmDash writes `user` only at sign-in, so editors sign in again after `days` days (default 30).
  Lifecycle deletion is asynchronous (can lag ~a day); the ttl in the value is what actually ends the session.
- Lifecycle API (from `wrangler r2 bucket lifecycle add` in Wrangler 4.163 and a read-only GET on a real bucket):
  `GET|PUT /accounts/{id}/r2/buckets/{bucket}/lifecycle`, body `{ rules: [...] }`; PUT **replaces the whole set**.
  New buckets carry `{"id":"Default Multipart Abort Rule","enabled":true,"conditions":{},
  "abortMultipartUploadsTransition":{"condition":{"type":"Age","maxAge":604800}}}`. An expiry rule is
  `{ id, enabled: true, conditions: {}, deleteObjectsTransition: { condition: { type: "Age", maxAge: <seconds> } } }`.
  The kit reads the rules, replaces only its own (`wp2emdash-sessions-expire`) and keeps the rest — as Wrangler does.
- Privacy: a new bucket is private (`GET …/domains/managed` → `enabled: false`). Provision switches r2.dev access off
  if it was on and refuses a bucket with a custom domain.

## (d) The adapter stops adding the SESSION KV binding

`usesCloudflareKVSessionDriver(session)` is true only for the KV driver's entrypoint; `cloudflareConfigCustomizer({
needsSessionKVBinding })` then adds no `kv_namespaces: [{ binding: "SESSION" }]`. Build check: `dist/server/wrangler.json`
had `kv_namespaces: [FORM_OUTBOX]` and `r2_buckets: [MEDIA, SESSIONS]` — no bare SESSION for Wrangler to auto-provision
(the M8 orphan-namespace problem cannot come back in R2 mode). The built manifest carried
`"sessionConfig":{"driver":"unstorage/drivers/cloudflare-r2-binding","options":{"binding":"SESSIONS"},"ttl":2592000}`
and `sessionKVBindingName = "SESSIONS"`.

## (e) Runtime check (local workerd)

`wrangler dev --local` on the built copy, with a probe route doing `session.set("probe", …)` / `session.get("probe")`:
the first request set the cookie `astro-session=<uuid>`; a second request with only the cookie read the value back
from storage; the local `studio-a-sessions` bucket held one object keyed by that uuid; the KV list had only
`FORM_OUTBOX`. Not checked: a deployed Worker (real R2 latency, multi-location), a real EmDash passkey sign-in on R2.

## What the kit does

- `kit.config` `sessions`: `"r2"` (default) | `"kv"` | `{ store, days }` (days 1–365, default 30).
- `wp2emdash provision <slug> [env]` (R2): creates/reuses the private bucket `<worker>-sessions` in the media bucket's
  location, sets the lifecycle rule, keeps it private, records `<env>.sessions = { bucket, location, days }` in
  cloudflare.json. No new SESSION KV namespace; an existing one stays recorded (for a switch back). `"kv"`: as before.
- Scaffold: R2 only when **every** environment the build serves has its bucket recorded (one astro.config serves all
  environments; a build without the binding could sign nobody in). Then astro.config gets the lines above and
  wrangler.jsonc gets `{ "binding": "SESSIONS", "bucket_name": … }` per environment and no SESSION KV binding.
  Otherwise KV exactly as before, with a warning naming the provision command.

## Switching a live site

Sessions do not move between stores: after the deploy that switches, **everyone is signed out once** and signs in
again. The old `<worker>-session` KV namespace is no longer bound; nothing deletes it. Keep it until the switch has
been watched for a while (a switch back = `sessions: "kv"`, scaffold, deploy — which signs everyone out once more),
then delete it in the dashboard (Workers KV) — never part of the kit's commands.
