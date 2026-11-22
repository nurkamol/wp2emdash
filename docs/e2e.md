# WordPress end-to-end test

Most adapters and features are proven on synthetic fixtures (`test/fixtures`). This test runs the kit against a
**real WordPress** — real plugin output, real REST answers, real rendered pages — so Elementor, WooCommerce catalogue
mode, Polylang and the form plugins are checked against what those plugins actually produce, and a plugin release that
changes its output shows up before a client site does.

It runs in GitHub Actions (manually and nightly, never on push) and on any machine with Docker.

## What it does

1. **WordPress in Docker** (`e2e/wordpress/docker-compose.yml`): `wordpress:7.1.5-php8.3-apache`, `mariadb:11.8.9`
   (database on tmpfs) and `wordpress:cli-2.12.0-php8.3` for the seed. Port `127.0.0.1:8080` only. Every image tag is
   pinned and must match `e2e/lib/versions.ts` (a unit test checks it).
2. **Pinned plugins and theme** (`e2e/lib/versions.ts`, each by version **and sha256**): Twenty Twenty-One 2.9,
   WooCommerce 11.3.1, Elementor 4.4.1, Polylang 3.9.2, Contact Form 7 6.2.5, Fluent Forms 6.2.17 and the EmDash
   Exporter 1.2.0 (GitHub release; it is not on wordpress.org). The zips are downloaded on the host and cached.
3. **Synthetic content** (`e2e/lib/plan.ts` → `seed-plan.json` → `e2e/wordpress/seed-languages.php` + `seed.php`): a
   made-up pottery studio. 10 pages (5 Elementor — containers and legacy sections, heading, text, buttons, image,
   icon boxes, testimonial, counter, gallery, icon list, image box, accordion, toggle, tabs, social icons, a shortcode
   widget —, 5 Gutenberg), 7 posts with categories, tags and featured images, primary/footer menus per language,
   6 products (4 simple, 2 variable with 5 variations, 3 on sale, 3 categories), a Fluent Forms form (contact page, EN
   and FR) and a Contact Form 7 form (Elementor shortcode widget), custom logo and site icon. Polylang: English default
   without a prefix, French under `/fr/`, translated pairs (home, about, contact, two posts), products translatable.
   Images are solid-colour PNGs generated locally. Nothing is client data.
4. **The kit** (`e2e/run.ts pipeline`): a site workspace in a **temporary** sites folder (never `sites/`), configured
   as an operator would (`shop: catalogue / contact`, the CF7 file from *Tools → Export* in `raw/plugin-exports/`, the
   Elementor options from WP-CLI, a WordPress application password in the site's `.env`), then
   `init → audit → extract → transform → scaffold` (install, `astro check`, `astro build`, `wrangler deploy --dry-run`),
   then the generated project's **local dev server** (`astro dev`, local D1/R2 under `.wrangler/`) for `load` and
   `verify`, and finally the rendered pages are fetched.
5. **Assertions** (`e2e/lib/assertions.ts`) on top of the gates: every seeded address has an IR document; the products
   became a shop collection with their variations and the shop facts are right; Elementor pages were adapted with no
   unmapped content; both form plugins became form sections with generated definitions; Polylang's plan, prefixes and
   translation groups; a built project without a Cloudflare account id; and after load, French pages with
   `lang="fr"`, reciprocal `hreflang` + `x-default` and the language switcher, product pages and `/shop/`.

A failed gate does not stop the run: the later phases run with `--preview` (not recorded) so one run shows every
problem. **No gate is ever accepted.**

## It cannot deploy

- The workflow has `permissions: contents: read`, passes no secrets and sets no `CLOUDFLARE_*` / `EMDASH_TOKEN*`
  variable; `api.cloudflare.com` is blackholed in `/etc/hosts` for the job.
- `e2e/run.sh` and `e2e/run.ts` refuse to start when such a variable is set, blank any such key from the kit `.env`
  for the e2e site (a maintainer's machine), and pin `load`/`verify` to the local target with
  `WP2EMDASH_NO_PRODUCTION=1`. The site has no `cloudflare.json`, so there is no remote target to resolve to.
- The e2e config switches off the two features that add the Workers AI binding (SEO panel, Media AI alt text):
  that binding is remote-only and needs a Cloudflare account. `E2E_FULL_DEFAULTS=1` keeps every default.

## Run it

GitHub: **Actions → E2E WordPress → Run workflow** (option: stop after scaffold). It also runs nightly at 03:17 UTC.

Locally (Docker with Compose v2, Node 24, pnpm; the first run downloads about 60 MB of zips and the images):

```bash
pnpm install
pnpm exec playwright install chromium   # the audit takes screenshots
e2e/run.sh                              # full run (≈ 15–25 min)
e2e/run.sh --skip-load                  # stop after scaffold
e2e/run.sh --keep                       # leave WordPress up at http://localhost:8080 afterwards
```

Exit codes: `0` passed · `2` a required gate or assertion failed · `1` setup failed (Docker, download, checksum, seed).
Environment: `E2E_WP_PORT` (8080), `E2E_OUT` (report folder), `E2E_CACHE_DIR` (zip cache, `~/.cache/wp2emdash-e2e`),
`E2E_SITES_DIR` (keep the kit workspace there instead of a deleted temp folder), `E2E_DEV_PORT` (4399),
`E2E_KEEP_SCREENS=1` (copy screenshots and visual diffs into the report), `E2E_FULL_DEFAULTS=1`.

With `--keep`, inspect WordPress with WP-CLI:
`docker compose -f e2e/wordpress/docker-compose.yml --profile tools run --rm wpcli wp post list --post_type=page`.

## Read the results

The workflow uploads the artifact **e2e-wordpress-report** (14 days) and writes `report.md` as the job summary.

| File | What it is |
|---|---|
| `report.md` / `report.json` | Verdict and why, each phase (recorded / preview / skipped) with its failed checks, every assertion, known failures, every gate check, versions |
| `logs/seed.log`, `seed-summary.txt` | The seed's output; every post with its language and URL, menus, plugin versions |
| `logs/docker.log` | WordPress and MariaDB container logs (PHP warnings, fatal errors) |
| `logs/dev-server.log` | `astro dev` output for load/verify |
| `site/reports/<phase>/` | The kit's own phase reports (coverage, extract, verify…) |
| `site/runs/*.jsonl` | Progress events of each phase run |
| `site/ir/`, `site/snapshot/`, `site/raw/…` | Transform output, audit snapshot (HTML, page JSON), extract summaries and form definitions |
| `project/` | The generated project's `wrangler.jsonc`, `astro.config.mjs`, `seed/seed.json`, `src/forms/` |
| `rendered/` | The pages fetched from the dev server after load |

The throwaway application password is scrubbed from every text file; `.env` files are never copied.

Where to start: *Why it failed* lists the first real cause first; reasons marked "preview, after an earlier failure"
are usually consequences. A setup failure has a short `report.md` with the tail of the seed log.

## When it fails

- **A kit bug** (a gate or assertion the seeded site should pass): fix it with a fixture and test as usual; the e2e run
  is the proof.
- **A plugin changed its output**: update the adapter, or pin the previous version in `e2e/lib/versions.ts` while
  you do.
- **Expected for now**: add `"<phase>:<checkId>": "<reason, date>"` to `knownFailures` in `e2e/expectations.json`.
  Keep the list short; entries that stop failing are reported as stale. `allowedElementorDiagnostics` takes
  `"<slug>:<code>[:<tag>]"`.
- `load` and `verify` are optional (reported, not failing) until they pass in CI; then move them to `requiredPhases`
  and the `html-*` assertions to `requiredAssertions`. Several verify checks compare against a stock WordPress theme on
  `localhost` (visual diff, performance) and are expected to need `knownFailures` entries.

## Bumping versions

Change version, URL and sha256 together in `e2e/lib/versions.ts` (`shasum -a 256 <zip>`), images in both
`docker-compose.yml` and `IMAGES`, then run the workflow by hand. Requirements to watch: WooCommerce and Contact
Form 7 set minimum WordPress and PHP versions.

## Verified without Docker

`test/e2e-wordpress.test.ts` (part of `pnpm test`): the plan is deterministic and consistent; every key the PHP seed
reads exists in the plan; the kit's Elementor adapter maps every seeded Elementor page without an error; images,
zip caching and checksum refusal; compose images match the pins; the workflow's triggers and its no-deploy guarantees;
the e2e site loads as a valid config and passes the init gate; the phase loop, verdict, assertions (against a fake
migrated site), report and artifact scrubbing. The PHP seed, the plugins' behaviour and the full pipeline run only
where Docker is available.
