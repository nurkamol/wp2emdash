# wp2emdash docs

Everything written about the kit, in one list. Start with the [project README](../README.md) for the overview and
the commands; come here for the details. Spike findings record what was checked against the installed EmDash,
Astro, Wrangler and Cloudflare versions before code depended on it — check them before assuming an EmDash API.

## Plan and reference

| Doc | What it covers |
|---|---|
| [PLAN.md](PLAN.md) | Source of truth for scope, architecture, phases, gates, the section library, adapters, the in-house plugins, safety rules, milestones and current status (§13) |
| [WordPress → EmDash parity](parity/wp-to-emdash.md) | 110-feature matrix: where each WordPress feature lives in EmDash 1.5, what the kit does with it, the gap and its priority ([JSON](parity/wp-to-emdash.json), same data) |
| [Environment setup](staging-setup.md) | Production on `workers.dev` (the default) and opt-in staging: resources, build → migrate → deploy, first admin sign-in (passkeys), load token, client CI, go-live and after it, troubleshooting |
| [Cloudflare API tokens](cloudflare-api-token.md) | The reusable build token (kit `.env`) and the separate, zone-scoped go-live token used only at cutover; permission sets and where each token goes |
| [Site workspaces](../sites/README.md) | What lives in `sites/<slug>/` and why none of it is ever committed |
| [Changelog](../CHANGELOG.md) | What changed, by day and milestone |
| [Agent rules](../CLAUDE.md) | Binding rules for anyone (person or agent) working in the kit |

## Packages (each ships with every migrated site unless turned off)

| Package | What it covers |
|---|---|
| [`@wp2emdash/forms`](../packages/forms/README.md) | Form endpoint (Turnstile, rate limit, validation, sensitive-data policy), email providers, the KV outbox and the Form messages admin page |
| [`@wp2emdash/og`](../packages/og/README.md) | Sharing images: a branded og:image per page, drawn in the Worker and stored in R2 |
| [`@wp2emdash/seo`](../packages/seo/README.md) | SEO & Analytics: editor panel, SEO dashboard, Search Console, IndexNow, tracking codes, conversion events, Visits |
| [`@wp2emdash/health`](../packages/health/README.md) | Site health & monthly report: scheduled checks, alerts, a branded monthly report |
| [`@wp2emdash/backups`](../packages/backups/README.md) | Backups & restore: nightly content backups to R2, downloads, restore of settings, menus or one page |
| [`@wp2emdash/consent`](../packages/consent/README.md) | Privacy & consent: the built-in cookie banner, Consent Mode v2, consent log |
| [`@wp2emdash/media`](../packages/media/README.md) | Media assistant: media health, in-place optimizing, reviewed AI alt text, focal points, media trash |
| [`@wp2emdash/change-requests`](../packages/change-requests/README.md) | Change requests: the client asks the agency for changes inside the admin and follows their status |

## Spike findings (verified facts)

### Milestones

| Doc | What it covers |
|---|---|
| [M0 — spike](spikes/M0-findings.md) | The plan's assumptions (PLAN §12) checked on a throwaway EmDash 1.5 project; the Exporter plugin API, project size and runtime versions |
| [M3 — extract](spikes/M3-findings.md) | EmDash Exporter on a real WPBakery/Salient site: migration key, endpoints, what the export does and does not contain |
| [M5 — starter & scaffold](spikes/M5-findings.md) | EmDash facts the starter project depends on (verified in the installed source), the pilot result and known gaps |
| [M6 — load](spikes/M6-findings.md) | The EmDash REST API the loader uses, its behaviour, and what the first staging deploy and load taught |
| [M7 — forms, email, SEO, layout](spikes/M7-findings.md) | Form endpoint runtime, email providers and EmDash's email pipeline, encryption keys, SEO/analytics and measured Salient layout rules |
| [M8 — go-live](spikes/M8-findings.md) | Explicit `SESSION` binding, the go-live token, and running isolates that keep an old setting after the switch |

### Features

| Doc | What it covers |
|---|---|
| [Announcement bars](spikes/announcement-findings.md) | Markup the top-bar detection relies on (Announcer, WPFront, Salient, Astra) |
| [Analytics](spikes/analytics-findings.md) | Tracking codes in the SEO & Analytics suite: storage, purge, CSP hosts, Cloudflare Web Analytics GraphQL |
| [Backups & restore](spikes/backup-findings.md) | What a nightly backup holds and leaves out, why a plugin rather than EmDash's own backups, restore limits |
| [Blog](spikes/blog-findings.md) | Posts, dates, permalinks, taxonomies, guest bylines, archives and RSS feeds against EmDash 1.5 |
| [Bricks](spikes/bricks-findings.md) | Bricks 2.4.6/2.5 storage and elements from the theme source, and the visual parity rounds on a real Bricks site |
| [Change requests](spikes/change-requests-findings.md) | Plugin storage, private uploads, roles, email and webhook design |
| [Privacy & consent](spikes/consent-findings.md) | Banner modes, regions, Consent Mode v2, Meta/Clarity/Hotjar consent, GPC, caching |
| [Custom post types & fields](spikes/cpt-findings.md) | CPTs → EmDash collections; ACF, Meta Box and Pods field mapping |
| [Site health](spikes/health-findings.md) | Cron design, check limits, alerts and the monthly report |
| [Media assistant](spikes/media-findings.md) | Media scan, Images binding optimizing, Workers AI alt text, trash |
| [Performance](spikes/performance-findings.md) | Route cache, warm-up, responsive images, deferred video, with staging measurements; why Smart Placement stays off |
| [Provider registry](spikes/providers-findings.md) | Hosts and snippet forms of the 46 known widget providers; site widgets |
| [Sign-in sessions](spikes/sessions-findings.md) | Why Workers KV sessions logged editors out at random, and the move to R2 |
| [Site settings](spikes/settings-findings.md) | EmDash's Settings schema, head tags, robots.txt and brand files, prefilled from WordPress |
| [Single environment](spikes/single-env-findings.md) | Production-only by default: D1 Time Travel and Workers preview URLs checked against Wrangler 4.163 |
| [WordPress URLs](spikes/wp-urls-findings.md) | Feeds, search, archives, attachment pages and query URLs with no new page; content inventory; Additional CSS |
