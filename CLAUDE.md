# wp2emdash — agent rules

Open-source kit that migrates WordPress sites to EmDash (Astro on Cloudflare Workers + D1 + R2) and proves the result with automated gates.

- Plan: `docs/PLAN.md` (source of truth for scope, phases, gates, section library)
- Verified EmDash facts: `docs/spikes/M0-findings.md` — check here before assuming any EmDash API
- Current EmDash docs: https://docs.emdashcms.com/llms.txt (or the `emdash-docs` MCP in generated projects)

## Commands

```bash
pnpm wp2emdash            # interactive wizard
pnpm wp2emdash status     # phase timeline for all sites (--json for machines)
pnpm wp2emdash run <slug> <phase> [--json]   # exit 0 pass · 2 gate failed · 3 not built yet · 1 error
pnpm wp2emdash accept <slug> <phase> --reason "…" --by "…"
pnpm wp2emdash doctor
pnpm wp2emdash changes <slug> [--json]   # what changed in WordPress between the last two extracts (new/edited/moved/deleted, menus, media, forms); deletions reported, never applied
pnpm wp2emdash run <slug> load --overwrite-edited   # also replace entries edited in the EmDash admin since the last load (default: kept; also changed in WordPress = conflict, gate fails)
pnpm wp2emdash estimate <url> [--rate <n>] [--lab] [--json]   # sales estimate from a prospect's public site → estimates/<host>-<date>/ (gitignored)
pnpm wp2emdash fleet [--live] [--json]     # every site: versions built with vs current kit, last change, upgrade check, owner to-dos
pnpm wp2emdash handover <slug> [--out <dir>] [--json]   # client handover pack (handover.html + .md) from the site's config and IR → sites/<slug>/handover/ (never into the kit repo)
pnpm wp2emdash fleet upgrade-prs           # dry run; --apply commits a wp2emdash/v<version> branch per client project, --open also pushes it + opens the PR (never main; refuses if CI would deploy the branch)
pnpm wp2emdash upgrade <slug> [--deploy-staging] [--preview]   # delivered site → current kit: snapshot live pages, rerun scaffold, compare; prints (never runs) the production deploy; then --verify
pnpm wp2emdash run <slug> load      # single environment (default): production on workers.dev once provisioned, else local; live production needs --force (D1 bookmark first)
WP2EMDASH_LOAD_TARGET=staging pnpm wp2emdash run <slug> load   # sites that opted into staging (target.staging: true)
pnpm wp2emdash sync-staging <slug> [--yes]   # staging sites: production content → staging (production read-only; allowlisted tables; never users/sessions/tokens/form data); dry run without --yes, staging D1 bookmark first
pnpm wp2emdash upgrade <slug> --deploy-staging --sync-staging --yes   # sync staging first, then the staging upgrade check
pnpm wp2emdash upgrade <slug> --prepare-db --yes   # EmDash version change: D1 bookmark, then the new version's database changes alone (live site keeps running); then versions:upload → --verify <preview-url> → versions:deploy → --verify → --after-release --yes (docs/spikes/emdash-upgrade-findings.md)
pnpm test && pnpm typecheck   # run both before saying a change is done
pnpm privacy                  # public repo: no client names/domains/emails (patterns from local sites/, .privacy-patterns, CI secret PRIVACY_PATTERNS); pre-commit hook: git config core.hooksPath .githooks
```

## Pipeline

`init → audit → extract → transform → scaffold → load → verify → cutover`. A phase runs only when every earlier gate is `passed` or `accepted`. State lives in `sites/<slug>/state.json`; progress events in `sites/<slug>/runs/<runId>.jsonl`.

A phase runner (`src/phases/<id>.ts`) does its work, emits progress through `ctx.reporter`, and returns `GateCheck[]`. Gates are data, never prose: every check has an id, a label and a pass/fail.

## Never

- Commit anything from `sites/<slug>/` to the kit repo (client content, screenshots, exports, credentials). Only `sites/README.md` is tracked; fixtures in `test/fixtures` are synthetic.

- Write to the live WordPress site, its database or its DNS.
- Change production DNS, routes, or deploy to production without explicit owner approval in the current conversation.
- Put passwords, API keys, migration keys, tokens or form submissions in prompts, code, logs, commits or reports. Secrets live in the kit `.env` (shared, e.g. the Cloudflare token — `docs/cloudflare-api-token.md`), `sites/<slug>/.env` (per site, wins) or Wrangler secrets. All gitignored.
- Use the go-live token (zone DNS/routes) for anything but cutover, or keep it after the monitoring window.
- Hand-edit generated output (`sites/<slug>/ir/`, imported content). Put the decision in `overrides.ts` or `decisions.md` and rerun, so a full rerun from raw exports reproduces the result.
- Silently drop source content. Unmapped nodes must appear in the coverage report.
- Route sensitive form data (health, legal, finance) into Workers, D1, email or analytics when `sensitiveData: true`.
- Accept a failed gate on the owner's behalf. Only `wp2emdash accept` with a reason the owner gave.

## Always

- Verify an EmDash/Cloudflare behaviour against the installed version (spike or docs) before code depends on it; record it in `docs/spikes/`.
- Add a fixture + golden test for every new adapter element handler (`test/fixtures`, `test/golden`).
- Rerun the affected gate after a change and report its real result.
