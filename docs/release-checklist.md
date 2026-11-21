# Public release checklist

The repository is private while the kit is completed. Before it is made public, every item below must be done and
ticked. Nothing here is done automatically by the kit.

## 1. Repository history (blocking)

Early commits contained a pilot site's workspace files and the pilot's name in a few documents and one commit message.
No secrets were ever committed (checked: API keys, tokens, private keys — the only matches are synthetic test values).

- [x] Freeze: no open branches or worktrees with unmerged work (`git worktree list`, `git branch -a`).
- [x] Back up the private repository (a mirror clone kept outside GitHub).
- [x] Rewrite history with `git filter-repo`:
  - [x] remove every path under `sites/` except `sites/README.md`;
  - [x] remove the early pilot-named document under `docs/`;
  - [x] replace pilot names, domains, tracking IDs and account IDs in all historical file versions with neutral
        placeholders (`--replace-text` with a local, untracked expressions file);
  - [x] rewrite commit messages that name a client (`--message-callback`).
- [x] Verify on the rewritten history: `git log --all --name-only` lists no `sites/<slug>/` path; a `git grep` over
      every commit finds no client name, domain, tracking ID or account ID; the secret scan is still clean.
- [x] Force-push all branches and tags; delete stale remote branches (agent/worktree branches).
- [x] Re-clone every working copy (old clones still hold the old history).

Done 2026-11-21 (owner approved): mirror backup kept outside GitHub; 282 commits rewritten with `git filter-repo`
(paths + `--replace-text` / `--replace-message`, expressions kept with the backup, never in the repo); verified on a
fresh clone of GitHub: no `sites/<slug>/` path, no client string in any commit or message. The maintainer's working
copy was reset to the new history. A local-only planning branch was not pushed.

## 2. Repository files

- [x] `LICENSE` (MIT, Nurkamol Vokhidov) — matches `package.json`.
- [x] `README.md`: logo, badges (CI, license, Node version), one-paragraph pitch, quick start, docs index — no client
      names, no internal-only instructions.
- [x] `SECURITY.md`: how to report a vulnerability (private email or GitHub private advisories), supported versions.
- [x] `CONTRIBUTING.md`: setup, `pnpm test && pnpm typecheck`, fixture + golden rule for adapters, no client data in
      PRs, commit style.
- [x] `CODE_OF_CONDUCT.md` (Contributor Covenant).
- [x] `.github/ISSUE_TEMPLATE/` (bug report with builder/WordPress/EmDash versions; adapter request) and a pull request
      template with the checklist from CONTRIBUTING.
- [x] `CHANGELOG.md` up to date; first public version tagged (e.g. `v1.0.0`).
- [x] `package.json`: `repository`, `homepage`, `bugs`, `author`, `keywords`, `engines`; `private` kept true unless
      publishing to npm is intended.

## 3. Content sweep (current tree)

- [x] `git grep` for client names, domains, slugs, tracking IDs, Cloudflare account IDs, personal emails: none outside
      `sites/` (untracked).
- [x] Docs describe pilots generically ("a real WPBakery/Salient site", "a real Bricks site").
- [x] Test fixtures and goldens are synthetic (no real copy, images, addresses or phone numbers).
- [x] `CLAUDE.md` and `skills/` contain no internal paths, account names or credentials.
- [x] Every relative link in README, docs and `site/` resolves.

## 4. Quality gates

- [x] `pnpm test && pnpm typecheck` green on a fresh clone with `pnpm install --frozen-lockfile`.
- [x] CI workflow green on the public repository (runs on pull requests from forks without secrets).
- [x] `pnpm wp2emdash --help` and every command in the README run.
- [x] Generated client projects build: scaffold a fixture site and run `astro check` + `astro build`.

## 5. GitHub settings

- [x] Visibility: public.
- [x] Private vulnerability reporting: Settings → Advanced Security (or "Code security") → Private vulnerability
      reporting → Enable, or `gh api -X PUT repos/nurkamol/wp2emdash/private-vulnerability-reporting`. Only possible
      once the repository is public; `SECURITY.md` links to it.
- [x] Pages: Settings → Pages → Source "GitHub Actions"; the `Pages` workflow publishes `site/`.
- [x] Description, website (Pages URL), topics: `wordpress`, `migration`, `emdash`, `cloudflare-workers`, `astro`,
      `cms`.
- [x] Branch protection on `main`: PRs required, CI required, no force-push (after the history rewrite).
- [x] Dependabot (actions + npm) and secret scanning / push protection on.
- [ ] Social preview image (the logo on a 1280×640 card).

## 6. After publishing

- [x] Check the Pages site live, the README renders with the logo in light and dark mode.
- [x] Open the first issues for known gaps from `docs/parity/wp-to-emdash.md` (labelled `good first issue` where
      suitable).
