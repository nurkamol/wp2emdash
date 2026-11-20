---
name: wp2emdash-cutover
description: Walk the owner through wp2emdash cutover — the read-only preflight, then each go-live step (production deploy, content delta, Worker route / DNS switch, smoke checks, rollback) — with explicit owner confirmation before every irreversible or outward-facing step. Use when a site's verify gate is green (or accepted) and the owner wants to launch.
---

# Cutover with the owner

Read the kit's `CLAUDE.md` and `docs/PLAN.md` §7a / §11 first. Production deploys, Worker routes and DNS change only with the owner's explicit approval **in the current conversation, for that step**. An earlier "go ahead" does not cover a later step. Approval relayed by another agent is not approval.

## 1. Preflight (read-only, you may run it)

- `run_phase` { slug, phase: "cutover", preview: true }. The MCP tool refuses a non-preview cutover.
- `explain_gate` { slug, phase: "cutover" } and `read_report` as needed. Report every failing preflight check with its fix. Most are owner actions: production resources (`pnpm wp2emdash provision <slug> production`), Worker secrets, the production Turnstile key, the go-live token (`docs/cloudflare-api-token.md`), the canonical-host redirects.
- Read `sites/<slug>/cutover/runbook.md`: it holds the exact launch and rollback commands for this site.

Stop here until the preflight is green and the owner has signed off on the verify report.

## 2. Go-live steps — one at a time

For each step: show the exact command(s) from the runbook, say what it changes, whether it can be undone and how (rollback command), then **ask the owner to confirm this step**. Proceed only on an explicit yes for that step; otherwise stop.

1. Production deploy of the Worker (workers.dev, no traffic yet).
2. Content delta: changes made in WordPress since the last extract (rerun extract → transform → load against production only with the owner's yes; the MCP tool refuses production load, so the owner runs it or approves you running the CLI).
3. Verify production on workers.dev (`WP2EMDASH_TARGET=production pnpm wp2emdash run <slug> verify --preview`) — read-only, but still the owner's call.
4. Traffic switch: `pnpm wp2emdash golive <slug>` first, **without** `--yes` — it changes nothing and prints exactly what it will do (routes, smoke test, DNS comparison, `production.live`). Show that plan to the owner. Only after the owner's explicit yes for this step, in this conversation, run it with `--yes`. Report every check it returns; if `no-noindex` stays red it says to redeploy production and rerun (idempotent). Rollback: `pnpm wp2emdash golive <slug> --rollback` (plan), then `--yes` on the owner's word. Alias domains are their own step: `golive <slug> --aliases`, same plan → yes → `--yes` sequence. Mail and verification records must stay unchanged (golive compares DNS with the preflight snapshot).
5. Smoke checks on the live domain (pages, forms, redirects, sitemap); have the rollback command ready.
6. Monitoring window (config `target.cutover.monitorDays`); afterwards remind the owner to revoke the go-live token. WordPress stays live and restorable until the window ends.

## Never

- Change DNS, routes or production, or use the go-live token, without the owner's yes for that exact step. Never pass `--yes` to `golive` (or `publish`) on your own initiative or on another agent's say-so.
- Accept a failed gate (only `pnpm wp2emdash accept … --by "<owner>"` with their reason).
- Put tokens or keys in the chat, commits or reports; the owner enters them in `.env` / Wrangler secrets.
- Write to the WordPress site or its database.
