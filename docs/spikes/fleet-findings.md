# Fleet view and upgrade pull requests: findings

`wp2emdash fleet` / `fleet upgrade-prs` (src/commands/fleet.ts, src/commands/fleet-prs.ts, src/upgrade/ci-safety.ts).

## Which kit built a project

- Before this change nothing in a client project recorded the kit version. The `@wp2emdash/*` packages are copied
  into `packages/<name>/` with their own `package.json` (linked as `link:./packages/<name>`), so package versions
  could always be read; the kit version could not. `before.json` of an upgrade records the kit that *took the
  snapshot*, not the one that built the project.
- The scaffold now writes `.wp2emdash.json` (`{ kit, builtAt, packages }`) at the project root, next to
  `package.json`. The starter's `.gitignore` does not ignore it, so it is committed with the project. Projects
  built earlier show `unknown` until their next rebuild; `fleet upgrade-prs` treats unknown as behind.

## Last deploy (`--live`)

- `wrangler deployments list` takes `--json` ("Display output as JSON") and `--name` (Worker name), and lists the 10
  most recent deployments (Wrangler commands docs, checked 2026-11-22). The docs do not describe the JSON fields, so
  the parser is defensive: an array (or `{ deployments }`) of objects with `created_on` (or `createdOn`), `source`
  and `annotations["workers/message"]`; it sorts by date itself. `author_email` is never read into the output.
- The command runs in the project folder (`pnpm exec wrangler`) with `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`
  from `credentialsFor("production", …)` — the same resolution `provision` uses — and its output is scrubbed of
  `.env` values before an error is shown.

## Does a branch push deploy? (generated workflows)

- The scaffold's `.github/workflows/ci.yml` (src/scaffold/client-repo.ts) triggers on `pull_request`, `push` to
  `main` only, and `workflow_dispatch`. Deploy jobs:
  - staging (opt-in): `github.event_name == 'push'` (main only, by the trigger) or Run workflow with target staging;
  - production: Run workflow only, or (single environment, `ciDeploy: always`, or `prelaunch` before go-live) push
    to main.
- So a push of `wp2emdash/v<version>` fires no workflow, and a pull request from it runs only the `check` job
  (`pnpm check`, `pnpm build`). Tested for every variant in `test/fleet.test.ts`.
- Client repos may have taken the workflow over (marker line removed) or added workflows, so `upgrade-prs` reads
  every `.github/workflows/*.yml` of the actual project, before branching and again after the rebuild, and refuses
  when any job that looks like a deploy (wrangler deploy / versions deploy|upload / wrangler-action / `pnpm
  deploy…` / `emdash migrate` / a GitHub `environment:` / a reusable workflow) could run for the push or the PR.
  Job `if:` conditions are evaluated with `github.event_name`, `github.ref`, `github.head_ref`, `github.base_ref`
  known and `inputs.*` empty; anything else (vars, secrets) is unknown, and a job is only treated as safe when its
  condition is provably false.
