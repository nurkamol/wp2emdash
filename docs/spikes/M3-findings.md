# M3 — extract findings

**Date:** 2026-11-17 · **Pilot site:** WordPress 6.9, Salient child theme, WPBakery, Rank Math, Fluent Forms, Popup Maker · **EmDash Exporter:** 1.2.0

## Migration key

- Format: `em1.` + base64url(JSON `{ v: 1, url, user, pass }`), where `pass` is a WordPress application password. EmDash 1.5 has no special handling for it; it is plain Basic auth (`user:pass`) against the exporter API.
- The exporter's admin page (Tools → EmDash Migration) runs site checks (pretty permalinks, application passwords, REST reachable, Authorization header, publicly reachable) and lists what the official importer brings over. It lists **"WPBakery layouts — builder pages arrive as plain content"** as *not included*, which is why the kit has its own adapters (PLAN §6).
- Revoking the key on that screen revokes the application password: access ends immediately.

## What the exporter returns (verified)

| Endpoint | Result on the pilot | Notes |
|---|---|---|
| `probe` (public) | version, WP version, `rankmath: true`, media count | Lists only post types with an admin UI. |
| `analyze` | totals by status per type (incl. private), authors | Author objects include email → the kit strips them. |
| `content?post_type=…&status=any` | Raw `[vc_row …]` shortcodes intact, every meta key (`_nectar_*`, `_wpb_vc_js_status`, `rank_math_*`), `rankmath` object, taxonomies | **Also works for types the probe doesn't list:** `salient_g_sections` (global footer), `wp_navigation`. |
| `menus` | Each menu with its theme locations (`off_canvas_nav`, `top_nav_pull_right`) | Items: id, parent_id, sort_order, type, object, object_id, url, title, target, classes. |
| `options` | blogname, front page id, permalink structure, site icon | Includes `admin_email` → stripped. No theme options. |
| `media` | Library items with URL, alt, size | URLs use `/wp-content/uploads/` even when a security plugin (WP Ghost) serves uploads from another path; the kit tries both. |

## Not available over REST

- **Salient Redux options** (colours, typography, header layout, social links): not in `options`, not in `wp/v2/settings`. The audit's design capture is the source; an optional manual export (`raw/salient-options.json`) gives exact values.
- **Rank Math redirections:** `rankmath/v1` exposes `updateRedirection` (write) but no list route. Manual export to `raw/redirects.csv`, or `redirects.source: "none"` in overrides.
- **Fluent Forms** definitions *are* available: `fluentform/v1/forms`, `/forms/{id}` (`form_fields` is a JSON string), `/settings/{id}?meta_key=notifications|formSettings|confirmation`, `/integrations/{id}/form-integrations`. Submission routes exist too; the kit never calls them.
- **Popup Maker:** popups arrive as the `popup` post type; `popup_settings` meta holds triggers (`click_open` with `extra_selectors`, `auto_open` with delay) and `enabled`. Links open a popup through those selectors or a `popmake-<id>` class.

## Data-quality patterns seen on the pilot

- Leftover theme-demo pages (private) referencing attachment IDs that no longer exist → reported, not blocking (unpublished).
- Hero background video hosted on an external CDN, not in the media library → listed for a copy-to-R2 vs hotlink decision.
- Unpublished demo forms next to the live one.

## Transform (M4) on the pilot

10 published pages, footer global section and 1 enabled popup → 0 unmapped content nodes, 100% of live-page words found in the IR, every image and internal link accounted for; reruns produce byte-identical IR.
