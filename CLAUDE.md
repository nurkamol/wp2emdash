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
pnpm test && pnpm typecheck   # run both before saying a change is done
```

## Pipeline

`init → audit → extract → transform → scaffold → load → verify → cutover`. A phase runs only when every earlier gate is `passed` or `accepted`. State lives in `sites/<slug>/state.json`; progress events in `sites/<slug>/runs/<runId>.jsonl`.

A phase runner (`src/phases/<id>.ts`) does its work, emits progress through `ctx.reporter`, and returns `GateCheck[]`. Gates are data, never prose: every check has an id, a label and a pass/fail.

## Never

- Commit anything from `sites/<slug>/` to the kit repo (client content, screenshots, exports, credentials). Only `sites/README.md` is tracked; fixtures in `test/fixtures` are synthetic.

- Write to the live WordPress site, its database or its DNS.
- Change production DNS, routes, or deploy to production without explicit owner approval in the current conversation.
- Put passwords, API keys, migration keys, tokens or form submissions in prompts, code, logs, commits or reports. Secrets live in `sites/<slug>/.env` (gitignored) or Wrangler secrets.
- Hand-edit generated output (`sites/<slug>/ir/`, imported content). Put the decision in `overrides.ts` or `decisions.md` and rerun, so a full rerun from raw exports reproduces the result.
- Silently drop source content. Unmapped nodes must appear in the coverage report.
- Route sensitive form data (health, legal, finance) into Workers, D1, email or analytics when `sensitiveData: true`.
- Accept a failed gate on the owner's behalf. Only `wp2emdash accept` with a reason the owner gave.

## Always

- Verify an EmDash/Cloudflare behaviour against the installed version (spike or docs) before code depends on it; record it in `docs/spikes/`.
- Add a fixture + golden test for every new adapter element handler (`test/fixtures`, `test/golden`).
- Rerun the affected gate after a change and report its real result.
