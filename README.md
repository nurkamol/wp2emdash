# wp2emdash

> Migrates WordPress sites to [EmDash](https://docs.emdashcms.com/) on Cloudflare Workers (D1 + R2) and proves the result with automated gates: content, URLs, SEO, design, forms and integrations.

**Status:** `init` → `scaffold` work end to end on a real Salient + WPBakery site: 0 unmapped content, 100% of page text carried over, and a generated EmDash project that builds and previews locally. `load`, `verify` and `cutover` are next — see [`docs/PLAN.md`](docs/PLAN.md) §13.

**Requires:** Node.js 24+ and pnpm. Generated sites run on Cloudflare Workers (Workers Paid plan — the EmDash Worker is above the free plan's 3 MB limit) with the latest Astro that EmDash supports.

## Quick start

```bash
pnpm install
pnpm wp2emdash doctor      # check prerequisites
pnpm wp2emdash             # interactive wizard: create a site, run phases
```

Or without the wizard:

```bash
pnpm wp2emdash init --slug acme --name "Acme Clinic" --source https://acme.com --sensitive
# tick the (required) items in sites/acme/ACCESS.md
pnpm wp2emdash run acme init
pnpm wp2emdash status
```

## Pipeline

| Phase | Does | Status |
|---|---|---|
| `init` | Workspace, config, access & backup checklist | ✅ |
| `audit` | Crawl live site, snapshots, screenshots, design, menu motion, forms & integrations scan | ✅ |
| `extract` | EmDash Exporter API: raw content, meta, SEO, menus, forms, media download | ✅ |
| `transform` | WPBakery/Salient, Gutenberg, classic → section IR, coverage & text-conservation gate | ✅ |
| `scaffold` | EmDash project: section library, design tokens, header/menu motion, forms, seed; builds + local preview | ✅ |
| `load` | Official importer + section overlay into staging | M6 |
| `verify` | Old site vs staging, URL by URL | M7 |
| `cutover` | Preflight, delta, deploy, smoke, rollback | M8 |

Each phase ends in a gate; the next phase won't run until it passes or is accepted with a recorded reason.

## Docs

- [Plan](docs/PLAN.md)
- [M0 spike findings](docs/spikes/M0-findings.md) · [M3 extract findings](docs/spikes/M3-findings.md) · [M5 starter findings](docs/spikes/M5-findings.md)
- [Site workspaces](sites/README.md)
- [Agent rules](CLAUDE.md)

Full GitHub docs (configuration reference, adapters, troubleshooting, …) are produced in milestone M8a.

## Privacy

Client workspaces (`sites/<slug>/`) never enter this repository: only `sites/README.md` is tracked. Credentials live in each workspace's `.env`. The kit only reads from WordPress (GET requests) and never reads form submissions.

## License

MIT — see [LICENSE](LICENSE).
