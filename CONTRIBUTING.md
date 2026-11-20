# Contributing to wp2emdash

Thanks for helping. Bug reports, fixtures from real-world WordPress markup (anonymised) and new builder adapters are
the most useful contributions.

## Setup

```bash
git clone https://github.com/nurkamol/wp2emdash && cd wp2emdash
pnpm install          # Node 24+, pnpm 11
pnpm wp2emdash doctor # checks the toolchain
pnpm test && pnpm typecheck
```

`docs/PLAN.md` is the source of truth for scope, phases, gates and the section library. Check
`docs/spikes/M0-findings.md` before assuming how an EmDash API behaves, and record anything new you verify there.

## Rules

- **No client data, ever.** Nothing from `sites/<slug>/` (exports, screenshots, content, credentials, form messages)
  goes into a commit, issue or pull request. Fixtures in `test/fixtures` are synthetic: replace names, addresses,
  emails, phone numbers and images.
- **Every new adapter element handler gets a fixture and a golden test** (`test/fixtures`, `test/golden`).
- **Gates are data.** A phase returns `GateCheck[]` with an id, a label and pass/fail — never prose.
- **Never drop content silently.** Anything the kit does not carry must show up in the coverage report.
- **Generated output is not hand-edited.** Decisions go in `overrides.ts` / `decisions.md`, so a rerun from the raw
  exports reproduces the result.
- Run `pnpm test && pnpm typecheck` before opening a pull request, and rerun the gate your change affects.

## Pull requests

- One topic per pull request, with a short description of what changed and how you verified it.
- Commit messages: an imperative summary line (`Elementor: carry icon lists`), details in the body when useful.
- Update `CHANGELOG.md` under *Unreleased*, and the parity rows in `scripts/parity-gen.mjs` when a WordPress feature
  changes status (`node scripts/parity-gen.mjs` regenerates `docs/parity/`).

## Adapter requests

Open an issue with the *Builder adapter request* template: the builder and version, and anonymised sample markup or a
public demo page.
