---
name: wp2emdash-run
description: Run the wp2emdash migration pipeline for a site phase by phase (init → audit → extract → transform → scaffold → load → verify → cutover preflight), stop at the first red gate and explain it in plain language. Use when asked to migrate, continue, rerun or check the status of a WordPress → EmDash site in the wp2emdash kit.
---

# Run the wp2emdash pipeline

Read the kit's `CLAUDE.md` first; its rules override anything here.

## Tools

Prefer the kit MCP server (`wp2emdash` in `/mcp`): `status`, `run_phase`, `explain_gate`, `read_report`, `list_diagnostics`, `propose_override`. Without it, use the CLI from the kit root:

```bash
pnpm wp2emdash status <slug> --json
pnpm wp2emdash run <slug> <phase> --json   # exit 0 pass · 2 gate failed · 3 not built yet · 1 error
```

## Loop

1. `status` (slug): find `next`. If every gate before cutover is passed or accepted, go to step 6.
2. `run_phase` { slug, phase: next }. For `load` and `verify` leave `target` empty (here: the local dev server, or staging on a site that opted into it) or pass `"staging"`. Never `"production"`: the tool refuses it, and so do you. A single-environment site (the default) is loaded into and verified on production (workers.dev) by the owner/operator on the command line — say so and stop rather than work around it.
3. Pass (exit 0): say what passed in one line (checks count), go back to 1.
4. Red gate (exit 2): **stop**. Call `explain_gate` and report each failing check: label, detail, fix. Then decide the next step:
   - unmapped content / legacy_html → `wp2emdash-map` skill;
   - visual differences in verify → `wp2emdash-visual-fix` skill;
   - credentials, ACCESS.md items, backups, Cloudflare tokens, decisions about scope → ask the owner; secrets go into `sites/<slug>/.env` by the owner, never into the chat.
   After a fix, rerun the same phase and report its **real** result.
5. Not built (exit 3) or error (exit 1): report the message and stop.
6. Cutover: only `run_phase` { phase: "cutover", preview: true } (read-only preflight), then hand over to `wp2emdash-cutover`.

## Never

- Accept a failed gate. Only the owner does that, with their own reason: `pnpm wp2emdash accept <slug> <phase> --reason "…" --by "…"`. You may print that command for them; do not run it.
- Edit `overrides.ts` or `decisions.md` directly — use `propose_override`; the owner approves (dashboard or `pnpm wp2emdash proposals <slug> approve <id> --by "…"`).
- Hand-edit generated output (`sites/<slug>/ir/`, the generated project's content).
- Write to the WordPress site, deploy to production, or touch DNS / Worker routes.
- Paste report text containing personal data or form submissions into commits or external tools.

## Report format

A short timeline (phase → passed / failed / accepted), the red gate with its failing checks and fixes, and the one next action (yours or the owner's).
