---
name: wp2emdash-map
description: Resolve unmapped or lossy content from the wp2emdash transform coverage report — add a generic adapter element handler (with fixture and golden test) or propose a per-site override through the approval queue — then rerun transform. Use when the transform gate fails on unmapped content, legacy_html sections, lost images or low text conservation.
---

# Map unmapped content

Read the kit's `CLAUDE.md` first. Content is never dropped silently: every node either maps to a section, is dropped as decorative by an explicit decision, or stays in the coverage report.

## 1. Collect

- `list_diagnostics` { slug, publishedOnly: true } — blocking items (content-carrying errors in published pages) come first. Each item has `file` (IR document), `path` (row path), `code`, `message`, `tag`, `builder` and `overrideKey` (`<docSlug>:<path>`).
- `read_report` { slug, report: "transform/coverage.md" } for the page context and missing text.
- Source snippet: the raw builder markup under `sites/<slug>/raw/` for that document and path (read locally; do not paste client content into commits). Screenshot crops: `wp2emdash ui` (visual viewer) or `sites/<slug>/snapshot/screens/`.

Group items by element family (same `tag` / shortcode / block name). One family = one decision.

## 2. Decide per family

**Generic** (the element is part of the builder — a WPBakery shortcode, Gutenberg core block, Bricks element — and other sites will have it):
1. Add or extend the handler in `src/adapters/<builder>/` mapping it to an existing section type from the section library (`src/starter/library.ts`, docs/PLAN.md section library). New section types are a kit decision; ask first.
2. Add a synthetic fixture in `test/fixtures/<builder>/` (no client content) and its golden output in `test/golden/<builder>/`; extend `test/adapters.golden.test.ts` if needed.
3. `pnpm test && pnpm typecheck`.

**Site-specific** (one odd row, a decorative spacer, a page that should keep its raw HTML):
- `propose_override` with a unified diff against the site's current `overrides.ts` (read it first with your Read tool; paths in the diff relative to `sites/<slug>/`):
  - `elements["<docSlug>:<path>"] = "<section type>"` or `"drop"` (decorative only — never drop content);
  - `approvedLegacy: ["<docSlug>:<path>"]` only when the owner wants it shipped as raw HTML;
  - `routes`, `media.external` for link / media items.
- Set `rerun: "transform"`. Add a short `decisions.md` proposal with the reason when the owner should see it in the log.
- Tell the owner the proposal id; it is applied only when they approve (dashboard or `pnpm wp2emdash proposals <slug> approve <id> --by "…"`).

Subagents only for parallel work: one per element family, each with the family's items and the relevant adapter file.

## 3. Rerun and report

After handler changes (or once the owner approved the proposal): `run_phase` { slug, phase: "transform" } and report the real gate result: blocking count before → after, checks still failing (`explain_gate`). Never accept the gate yourself.
