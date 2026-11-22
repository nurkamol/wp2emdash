# sites/

Local workspaces, one folder per WordPress site you migrate. **Nothing in here except this README is committed to the kit repository** (see `.gitignore`): a workspace holds client content, screenshots, exports and credentials.

Create one with the wizard (`pnpm wp2emdash`) or:

```bash
pnpm wp2emdash init --slug acme --name "Acme Clinic" --source https://www.example.com
```

A workspace looks like this:

| Path | What it is | Edited by |
|---|---|---|
| `kit.config.ts` | Site settings: source URL, target, viewports, gates, email provider | you |
| `ACCESS.md` | Access & safety checklist; required items gate the pipeline | the site owner |
| `overrides.ts` | Every mapping decision the pipeline can't infer, as data | you / Claude Code |
| `decisions.md` | Human log: accepted gates, approved differences, reasons | you |
| `.env` | Migration key / application password (never committed anywhere) | you |
| `state.json` | Phase and gate status | the kit |
| `snapshot/` | Audit baseline of the live site (pages, screenshots, design, menu motion) | the kit |
| `raw/` | Extracted WordPress content and media | the kit |
| `ir/` | Section IR — the migrated content, ready to load | the kit (never by hand) |
| `reports/` | Gate reports per phase | the kit |
| `handover/` | The owner's handover pack (`wp2emdash handover`): `handover.html`, `handover.md` | the kit |
| `project/` | The generated EmDash site — its own Git repository | the kit, then you |

To keep a client's workspace under version control, make it a private repository of its own (`cd sites/acme && git init`), separate from the kit.
