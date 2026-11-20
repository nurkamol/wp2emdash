# Public release checklist

The repository is private while the kit is completed. Before it is made public, every item below must be done and
ticked. Nothing here is done automatically by the kit.

## 1. Repository history (blocking)

Early commits contained a pilot site's workspace files and the pilot's name in a few documents and one commit message.
No secrets were ever committed (checked: API keys, tokens, private keys — the only matches are synthetic test values).

- [ ] Freeze: no open branches or worktrees with unmerged work (`git worktree list`, `git branch -a`).
- [ ] Back up the private repository (a mirror clone kept outside GitHub).
- [ ] Rewrite history with `git filter-repo`:
  - [ ] remove every path under `sites/` except `sites/README.md`;
  - [ ] remove the early pilot-named document under `docs/`;
  - [ ] replace pilot names, domains, tracking IDs and account IDs in all historical file versions with neutral
        placeholders (`--replace-text` with a local, untracked expressions file);
  - [ ] rewrite commit messages that name a client (`--message-callback`).
- [ ] Verify on the rewritten history: `git log --all --name-only` lists no `sites/<slug>/` path; a `git grep` over
      every commit finds no client name, domain, tracking ID or account ID; the secret scan is still clean.
- [ ] Force-push all branches and tags; delete stale remote branches (agent/worktree branches).
- [ ] Re-clone every working copy (old clones still hold the old history).

## 2. Repository files

- [x] `LICENSE` (MIT, Nurkamol Vokhidov) — matches `package.json`.
- [ ] `README.md`: logo, badges (CI, license, Node version), one-paragraph pitch, quick start, docs index — no client
      names, no internal-only instructions.
- [x] `SECURITY.md`: how to report a vulnerability (private email or GitHub private advisories), supported versions.
- [x] `CONTRIBUTING.md`: setup, `pnpm test && pnpm typecheck`, fixture + golden rule for adapters, no client data in
      PRs, commit style.
- [x] `CODE_OF_CONDUCT.md` (Contributor Covenant).
- [x] `.github/ISSUE_TEMPLATE/` (bug report with builder/WordPress/EmDash versions; adapter request) and a pull request
      template with the checklist from CONTRIBUTING.
- [ ] `CHANGELOG.md` up to date; first public version tagged (e.g. `v1.0.0`).
- [x] `package.json`: `repository`, `homepage`, `bugs`, `author`, `keywords`, `engines`; `private` kept true unless
      publishing to npm is intended.

## 3. Content sweep (current tree)

- [ ] `git grep` for client names, domains, slugs, tracking IDs, Cloudflare account IDs, personal emails: none outside
      `sites/` (untracked).
- [ ] Docs describe pilots generically ("a real WPBakery/Salient site", "a real Bricks site").
- [ ] Test fixtures and goldens are synthetic (no real copy, images, addresses or phone numbers).
- [ ] `CLAUDE.md` and `skills/` contain no internal paths, account names or credentials.
- [ ] Every relative link in README, docs and `site/` resolves.

## 4. Quality gates

- [ ] `pnpm test && pnpm typecheck` green on a fresh clone with `pnpm install --frozen-lockfile`.
- [ ] CI workflow green on the public repository (runs on pull requests from forks without secrets).
- [ ] `pnpm wp2emdash --help` and every command in the README run.
- [ ] Generated client projects build: scaffold a fixture site and run `astro check` + `astro build`.

## 5. GitHub settings

- [ ] Visibility: public.
- [ ] Pages: Settings → Pages → Source "GitHub Actions"; the `Pages` workflow publishes `site/`.
- [ ] Description, website (Pages URL), topics: `wordpress`, `migration`, `emdash`, `cloudflare-workers`, `astro`,
      `cms`.
- [ ] Branch protection on `main`: PRs required, CI required, no force-push (after the history rewrite).
- [ ] Dependabot (actions + npm) and secret scanning / push protection on.
- [ ] Social preview image (the logo on a 1280×640 card).

## 6. After publishing

- [ ] Check the Pages site live, the README renders with the logo in light and dark mode.
- [ ] Open the first issues for known gaps from `docs/parity/wp-to-emdash.md` (labelled `good first issue` where
      suitable).
