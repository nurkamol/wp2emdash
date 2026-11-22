# Internal estimate — example-studio.test

Generated 2026-11-22T10:00:00.000Z by wp2emdash 0.0.0-test. Public pages only; not for the client.

## Effort breakdown

| Line | Hours | Basis |
|---|---|---|
| Project setup, audit, extract, scaffold, load, verify, launch | 10–16 | fixed per project |
| Pages via WPBakery (incl. Salient) | 2.3–4.5 | 9 page(s) × 0.25–0.5 h (75 % of the sample) |
| Pages via Gutenberg / classic editor | 0.5–0.9 | 3 page(s) × 0.15–0.3 h (25 % of the sample) |
| Blog posts (bulk import, spot checks) | 0.8–2 | 40 post(s) × 0.02–0.05 h |
| Collection "team" | 1.3–2.6 | 1 collection (1–2 h) + 6 entries × 0.05–0.1 h |
| Visual parity rounds | 4–8 | main adapter: WPBakery (incl. Salient) |
| Forms rebuilt (form section → Worker → email, Turnstile) | 1–2 | 1 distinct form(s) × 1–2 h |
| Third-party integrations kept or replaced | 0.5–1 | 1 × 0.5–1 h: Calendly |
| Analytics, tags and consent re-wired | 0.5–1 | SEO & Analytics settings + consent banner |
| Unknown plugins reviewed | 0.5–2 | 1 × 0.5–2 h |
| Subtotal | 21.4–40 | |
| Contingency | 3.2–6 | 15 % (rules.effort.contingency) |
| **Total** | **25–46** | size Medium |

Rate 90 USD/h → 2,250–4,140 USD.

Rules: `src/estimate/rules.ts` (override with `--rules <file.json>`).

## Adapters

| Adapter | Share of sample | Proven | Status | Source |
|---|---|---|---|---|
| WPBakery (incl. Salient) | 75 % | yes | Proven: the pilot WPBakery/Salient site went through every phase and verify | docs/PLAN.md §6, §13 (M4–M8) |
| Gutenberg / classic editor | 25 % | yes | Proven for core blocks and classic content on real sites; block libraries (Kadence, Spectra, GenerateBlocks, Stackable, CoBlocks) fixture-only | docs/PLAN.md §7, docs/spikes/gutenberg-libraries-findings.md |

## Risks and decisions

- **[complexity] Plugins to review** — 1 plugin the kit does not recognise: acme-calculator. Most add a widget or styling; a custom plugin with business logic (calculators, portals, integrations) is out of scope. _Kit:_ Each is reviewed in the audit; custom business logic is scoped separately (PLAN §9). (docs/PLAN.md §9)
- **[info] Booking system** — Calendly. Appointments stay in the booking provider. _Kit:_ The booking widget or links are kept as they are.

## Plugins seen

| Plugin | Evidence | Kit action | Replacement |
|---|---|---|---|
| WPBakery (Salient bundled) (`js_composer_salient`) | assets | adapter | WPBakery adapter → section blocks |
| Contact Form 7 (`contact-form-7`) | assets, rest | rebuild | form section → Worker → email provider |
| acme-calculator (`acme-calculator`) | assets | review | Unknown plugin — review what it does on the site |

## Integrations

| Name | Kind | Proposed | Pages | Note |
|---|---|---|---|---|
| contact-form-7 form #5 | form | rebuild | 1 |  |
| Calendly | booking | keep | 2 |  |
| Google Analytics 4 | analytics | keep | 4 |  |

## Content and crawl

- Origin: https://example-studio.test (home HTTP 200); theme: salient; WordPress 6.6
- REST API: public — page 12, post 40, team 6, media 120, terms 9
- URLs found: 70 (guess: 20 pages, 40 posts, 10 archives); sitemaps read: 2
- robots.txt: present; URLs skipped by robots rules: 1
- Sample (4): / 200 [wpbakery+salient], /about/ 200 [wpbakery+salient+gutenberg], /blog/hello/ 200 [gutenberg], /contact/ 200 [wpbakery]

## Speed (per page)

| Page | Status | TTFB | HTML | Weight* | Requests | Images |
|---|---|---|---|---|---|---|
| / | 200 | 900 ms | 80 KB | 2400 KB | 42 | jpg 6, png 2, webp 1 |
| /about/ | 200 | 700 ms | 80 KB | 1800 KB | 38 | jpg 6, png 2, webp 1 |

*HTML + referenced files with a known size; files loaded by scripts or stylesheets are not counted.

## Assumptions

- Counts come from the public REST API where it answers, else from sitemap/link URLs.
- Builders are detected from rendered HTML of the sampled pages; rarely used builders on unsampled pages may be missed.
- Plugins are seen only when they load assets or expose a REST namespace; admin-only plugins are invisible here.
- The full audit (`wp2emdash init` + `run <slug> audit`) replaces every figure here with measured ones.
