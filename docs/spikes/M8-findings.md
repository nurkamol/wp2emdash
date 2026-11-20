# M8 findings — go-live tooling

Verified 2026-11-20 against @astrojs/cloudflare 14.4.8, @cloudflare/vite-plugin 1.70.0, wrangler 4.163.0 (the versions
the scaffold pins), on a throwaway copy of a generated project. Nothing was deployed.

## Astro sessions: the `SESSION` KV binding

**What went wrong on a real launch.** The first `wrangler deploy` of a new production Worker failed with Cloudflare
error 10001 *after* Wrangler had auto-provisioned the `SESSION` namespace. Every retry then failed with 10014
"namespace already exists" until the orphan `<worker>-session` namespace was deleted by hand.

**Why the binding is auto-provisioned.**

- `@astrojs/cloudflare` enables sessions with the Cloudflare KV driver whenever the Astro config sets no session driver
  (`dist/index.js`: *Enabling sessions with Cloudflare KV with the "SESSION" KV binding*).
- Its config customizer (`dist/wrangler.js`, `cloudflareConfigCustomizer`) adds `kv_namespaces: [{ binding: "SESSION" }]`
  — no id — **only when the environment's own `kv_namespaces` has no `SESSION` entry** (`hasSessionBinding`). The
  customizer result is merged with `defu`, which concatenates arrays: our `FORM_OUTBOX` stays, the bare `SESSION` is
  added in front of it.
- The vite plugin reads `wrangler.jsonc` with `CLOUDFLARE_ENV` applied (`readWorkerConfigFromFile(path, env)`), so the
  check runs against `env.staging.kv_namespaces` for a staging build (KV bindings are not inherited by environments).
- Wrangler's provisioning (`collectPendingResources`, `KVHandler.isFullySpecified() = !!binding.id`) creates a
  namespace for a KV binding without an id, named `${scriptName}-${binding.toLowerCase().replaceAll("_", "-")}` —
  `<worker>-session`, `<worker>-staging-session`. A later deploy of a Worker that already has the binding
  inherits it (`canInherit`), which is why existing sites kept working.

**Checked.** `cloudflareConfigCustomizer({ needsSessionKVBinding: true })` returns `kv_namespaces: undefined` for a
config that has `{ binding: "SESSION", id }` and `[{ binding: "SESSION" }]` for one without. A full `astro build` of a
generated project with an explicit `SESSION` id at the top level and in `env.staging` produced
`dist/server/wrangler.json` with exactly `[FORM_OUTBOX(id), SESSION(id)]` for both `CLOUDFLARE_ENV=staging` and the
default (production) build — no bare binding, so nothing is left for Wrangler to provision.

**What the kit does.** `wp2emdash provision <slug> <env>` creates or reuses a KV namespace titled `<worker>-session`
(the title Wrangler would use, so a namespace an earlier deploy already created is found and reused) and records it in
`cloudflare.json` → `<env>.session`. Scaffold writes `{ "binding": "SESSION", "id": … }` next to `FORM_OUTBOX` at the top
level and in `env.staging`, and warns when an environment with a database has no session namespace recorded.

## Go-live token

On the pilot launch the token supplied as the go-live token was the build token itself, and it could read every zone of
every account it belonged to. The cutover preflight now fails `golive-token-separate` when `CLOUDFLARE_GOLIVE_TOKEN`
equals a build token (compared by SHA-256, never printed) and `golive-token-scope` when `GET /zones` (paginated, 50 per
page) returns any zone besides the primary and the alias domains.

## Running isolates keep an old setting

After production's EmDash `staging` setting was cleared, pages kept `noindex` until the Worker was redeployed: running
isolates cache settings. `wp2emdash golive` therefore retries its smoke test (default 4 × 20 s) and, if noindex
persists, tells the operator to redeploy production and rerun it (routes already in place are kept).
