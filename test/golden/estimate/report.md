# Website migration estimate — example-studio.test

Prepared by PixelKraft (https://pixelkraft.net) on 2026-11-22. Based on the public website only.

## Summary

- **Platform:** WordPress 6.6
- **Built with:** WPBakery (incl. Salient), Gutenberg / classic editor
- **Pages:** 12
- **Blog posts:** 40
- **Forms:** 1
- **Other integrations:** 2

**Project size:** Medium — estimated effort **25–46 hours**, indicative budget **2,250–4,140 USD**.

## Speed today and after the move

| Measure | Your site today | Typical EmDash site | |
|---|---|---|---|
| Time to first byte (HTML) | 800 ms | 240–360 ms cached (kit gate ≤ 600 ms) | Room to improve |
| Page weight (HTML + referenced files) | 2,100 KB+ | 397 KB desktop / 258 KB phone (kit gate ≤ 1,500 KB) | Room to improve |
| Requests referenced by the HTML | 40 | 10 on the measured home page | Room to improve |
| Modern image formats (WebP / AVIF / SVG) | 11 % of 18 images | WebP, resized per screen (srcset) | Room to improve |

_Measured once per page from the machine that ran the estimate, without a browser: weight counts the HTML and the files it references directly (a browser also loads files requested by scripts and stylesheets), so the real figure is higher._

_Typical EmDash numbers are the kit's own measurements on its first migrated sites, November 2026 (documented in the open-source kit, docs/spikes/performance-findings.md); they show what the kit achieved there, not a promise for every site. What its automated checks enforce on every migrated site are the gate values in parentheses._

## What happens to each part of the site

| Item | Type | After the move |
|---|---|---|
| contact-form-7 form #5 | form | Rebuilt on the new site |
| Calendly | booking | Kept as is |
| Google Analytics 4 | analytics | Kept as is |

## Points to look at

### Plugins to review (Extra care)

1 plugin the kit does not recognise: acme-calculator. Most add a widget or styling; a custom plugin with business logic (calculators, portals, integrations) is out of scope.

**How we handle it:** Each is reviewed in the audit; custom business logic is scoped separately.

### Booking system (Good to know)

Calendly. Appointments stay in the booking provider.

**How we handle it:** The booking widget or links are kept as they are.

## Effort

| Work | Hours |
|---|---|
| Project setup, audit, extract, scaffold, load, verify, launch | 10–16 |
| Pages via WPBakery (incl. Salient) | 2.3–4.5 |
| Pages via Gutenberg / classic editor | 0.5–0.9 |
| Blog posts (bulk import, spot checks) | 0.8–2 |
| Collection "team" | 1.3–2.6 |
| Visual parity rounds | 4–8 |
| Forms rebuilt (form section → Worker → email, Turnstile) | 1–2 |
| Third-party integrations kept or replaced | 0.5–1 |
| Analytics, tags and consent re-wired | 0.5–1 |
| Unknown plugins reviewed | 0.5–2 |
| Contingency (15 %) | 3.2–6 |
| **Total** | **25–46** |

## Next steps

1. A short call to confirm goals, the decisions listed above and the launch date.
2. Full audit with read-only access (an application password and the EmDash Exporter plugin): every page, form and setting is inventoried and the estimate is confirmed.
3. Migration to a staging address you can review, with automated checks that every page, link, form and redirect matches the current site.
4. Launch with your approval, then monitoring.

---

PixelKraft · https://pixelkraft.net

_This estimate reads only what the website shows the public. A full audit with access confirms the scope before work starts._
