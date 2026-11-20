---
name: wp2emdash-visual-fix
description: Fix a red visual section from the wp2emdash verify report — find why the migrated EmDash section differs from the WordPress original by measuring both in a headless browser, fix it through kit rules (adapter or starter CSS with a fixture) or a proposed override, rerun the affected phases and report the new numbers. Use when the verify gate's "visual" check fails.
---

# Fix a visual difference

Read the kit's `CLAUDE.md` first. Fixes go into the kit (adapters, starter components/CSS) or into proposals for `overrides.ts` / `decisions.md` — never into generated output (`ir/`, the generated project's content).

## 1. Pick the section

- `explain_gate` { slug, phase: "verify" } → the `visual` check's detail lists the worst sections: `<path> <viewport> <label> (<section types>) <ratio>%`.
- `read_report` { slug, report: "verify/verify.json" } → per page: `visual[viewport]` (whole-page ratio) and `sections[viewport]` (paired sections with ratio, types, crop files). Crops and diffs are under `reports/verify/sections/` and `reports/verify/diff/`; view them in `wp2emdash ui` (visual viewer).
- Work on one page × viewport × section at a time, worst first. One subagent per red page when there are many.

## 2. Find the cause — measure, don't guess

Measure source (live WordPress URL, read-only GETs) and target (local dev server or staging) at the same viewport with Playwright (installed in the kit), the way `src/verify/browser.ts` does: same viewport width, fonts loaded, animations settled. For the section's elements compare computed styles and boxes: font family/size/line-height/weight, letter-spacing, colors, padding/margin, gap, max-width, image aspect ratio and object-fit, background position/size, column widths and breakpoints. Write the throwaway script in your scratchpad, not the repo.

Typical causes and where they are fixed:
- Wrong section type or variant chosen → adapter (`src/adapters/<builder>/`) + fixture/golden test, or `propose_override` on `elements` for a one-off.
- Spacing / type scale / breakpoint off for every site → starter section component or CSS (`starter/src/components`, `starter/src/styles`) + a test where one exists (`test/sections.test.ts`, `test/button-layout.test.ts`).
- Site tokens (colors, fonts) → transform / scaffold token extraction, not hand-tuned CSS in the generated project.
- Content difference (missing image, text) → it is not visual: go to `wp2emdash-map`.
- A difference the owner is happy with → they approve it in the dashboard (writes `decisions.md`). You do not approve it.

## 3. Rerun and report

Rerun only what the fix affects: adapter change → `transform`, `scaffold`, `load`, `verify`; starter change → `scaffold`, `load`, `verify`; override → per the proposal's `rerun` after approval. Use `run_phase` (load/verify target local, or staging on a site that opted into it; never production). Run `pnpm test && pnpm typecheck` for kit changes.

Report the section's ratio before → after for every viewport, any other section that got worse, and the verify gate's real result. Never accept the gate.
