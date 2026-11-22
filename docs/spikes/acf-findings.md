# Advanced Custom Fields: storage formats and full coverage

**Date:** 2026-11-22 · **Sources read:** Advanced Custom Fields 6.8.12 (free, `downloads.wordpress.org/plugin/advanced-custom-fields.6.8.12.zip`, sha256 `90c26bf11d8cccb68de485a0a91272db71dab4e9bf05bfb3c0f42caa109b49a7`) and Secure Custom Fields 6.9.10 (the wordpress.org fork of ACF that includes the former Pro fields: repeater, flexible content, gallery, clone, options pages; `secure-custom-fields.6.9.10.zip`, sha256 `59544690a84ed09c18a0b0425fa6ffa08a58d47bd4337ab0ccc36b518a5e4937`). Both from the plugin source, read-only, outside the repo. ACF Pro's own zip is not public; its storage code is the same lineage as SCF's (SCF forked ACF Pro 6.3), so the formats below hold for Pro sites too. Builds on `cpt-findings.md` (CPT mapper, EmDash 1.5.0 field types).

## Storage (verified in the plugin source)

| What | Where it is stored | Source |
|---|---|---|
| Any field | post meta `<name>` = value, `_<name>` = field key (hidden reference) | `acf-meta-functions.php` `acf_get_metadata()` (`"{$prefix}{$name}"`, `_` prefix for the hidden one) |
| Options page | `wp_options` `<post_id>_<name>`; the default options page's post id is `options` → `options_<name>` (and `_options_<name>` = key) | `acf_get_metadata()`: `get_option( "{$prefix}{$id}_{$name}" )` for type `option` |
| Repeater | `<name>` = row count; each sub-field `<name>_<i>_<sub>` (rows 0…n-1, nested repeaters recurse) | `class-acf-field-repeater.php` (`"{$field['name']}_{$i}_{$sub_field['name']}"`, `update_value` returns the count) |
| Flexible content | `<name>` = serialized list of the rows' layout names, in order; each sub-field `<name>_<i>_<sub>` | `class-acf-field-flexible-content.php` `update_value()` (`$new_value[] = $row['acf_fc_layout']`), `update_row()` |
| Flexible content: disabled / renamed rows | `_<name>_layout_meta` = `{ disabled: [row indexes], renamed: { i: label } }`; disabled rows are skipped by `load_value()` on the front end | same file, `get_disabled_layouts()`, `should_disable_layout()` |
| Flexible content definition | field setting `layouts` (keyed by layout key: `key`, `name`, `label`, `display`, `min`, `max`); in an export file each layout also has `sub_fields`; as `acf-field` posts the sub-fields are child posts of the flexible field with setting `parent_layout` = layout key (a sub-field without it belongs to the first layout) | same file, lines around `parent_layout` |
| Group | `<name>` = "" (`update_value` returns null); each sub-field `<name>_<sub>` | `class-acf-field-group.php` (`$field['name'] . '_' . $sub_field['_name']`) |
| Clone | seamless clone without prefix: sub-fields under their own names; with `prefix_name`: `<clone>_<sub>` | `class-acf-field-clone.php` |
| Gallery | serialized list of attachment ids as strings | `class-acf-field-gallery.php` `update_value()` (`array_map( 'strval', … )`) |
| Relationship; post object (multiple) | serialized list of post ids as strings; post object (single): the id | `class-acf-field-relationship.php`, `class-acf-field-post_object.php` |
| Link | serialized `{ title, url, target }`; "" when the URL is empty | `class-acf-field-link.php` `update_value()` |
| True / false | `1` / `0` | `class-acf-field-true_false.php` |
| Checkbox; select (multiple) | serialized list of values | `class-acf-field-checkbox.php`, `class-acf-field-select.php` |
| Date picker | `Ymd` (whatever the display/return format) | `class-acf-field-date_picker.php` (hidden input `Ymd`; "ACF stores date_picker internally as 'Ymd'") |
| Date time picker | `Y-m-d H:i:s` | `class-acf-field-date_time_picker.php` |
| Time picker | `H:i:s` | `class-acf-field-time_picker.php` ("stored H:i:s") |
| Image, file | attachment id | `class-acf-field-image.php`, `class-acf-field-file.php` |
| Icon picker (6.3+) | `{ type, value }` | `class-acf-field-icon_picker.php` |

`get_fields()` (the Exporter's `acf` object) returns formatted values: dates in the field's return format ("10/01/2025"), images as arrays (the Exporter reduces them to `{type, id, url, alt}`), relationship posts as ids (Exporter), flexible rows as objects with `acf_fc_layout` and sub-field names.

## What the kit does with them

| ACF | Before | Now |
|---|---|---|
| Flexible content (CPT entries) | one JSON field | rows whose layout maps to a kit section become the entry's sections (`content` blocks field, added to the collection when needed); other rows stay in the JSON field; coverage report "ACF flexible content" |
| Flexible content (pages) | not read | rows → the page's sections; when every row maps the page is built from them (no DOM fallback); an unmapped row blocks the `unmapped` gate unless the page is rebuilt from its rendered HTML (then the rows are reported as shown there) |
| Flexible content (posts) | not read | reported (warn): posts keep Portable Text bodies |
| Layout → section | — | by name and label (`layoutType`: faq, testimonials, team, stats, logo strip, gallery, video, map, steps, tabs, hero, CTA, feature grid, media + text, rich text), else by what the row holds; sub-fields by role (title, subtitle, rich text, textarea, images, gallery, link, button text + URL, repeater rows as items, Google map address, oEmbed/video URL); `overrides.ts acfLayouts: { <layout>: "<section type>" \| "skip" }` |
| Disabled flexible rows | — | left out (hidden on the live site), counted in a diagnostic |
| Link | JSON | `url` field + `<name>_label` string (target not kept) |
| Repeater with link / group sub-fields | JSON | flat EmDash repeater: link → `<sub>` url + `<sub>_label`; group → `<group>_<sub>` |
| Repeater values | `get_fields()` when present | the stored rows win when the meta has them (display-formatted dates in rows) |
| Repeater/flexible row meta without describable rows | silently "covered" | reported as unknown meta (gate `cpt-fields`) unless the definition describes the rows or the entry's `acf` object carries them |
| ACF on pages and posts | not read | location rules `page_template`, `page_type`, `page_parent`, `page` → pages; `post_template`, `post_category`, `post_format` → posts; values other than flexible content are listed (coverage "ACF fields on pages and posts") and a per-page diagnostic (info when the page was rebuilt from its HTML, warn otherwise) |
| Options pages | not read | groups with `options_page ==` are recognised; `import-options` / `import-dump` read `options_*` rows from a database backup into `raw/acf-options.json` (credential-like names and password fields never); transform writes `ir/acf-options.json` and the coverage section "ACF options pages" (values, or how to get them) |

## Verified in tests (synthetic fixture `test/fixtures/acf/site.json`, generated by `test/fixtures/acf/generate.mjs`)

- `acf-field` posts with PHP-serialized settings, a flexible field with seven layouts and `parent_layout` sub-fields (repeaters inside layouts), a front-page location rule.
- Home page values in post meta only: the serialized layout list, one disabled row (`_page_sections_layout_meta`), link sub-fields as array and as serialized string → hero, media + text (image left from a select), feature grid (repeater with icon and link), FAQ, testimonials; built without DOM fallback.
- About page with `get_fields()` values: a text layout → rich text; a layout with only a relationship and a select → unmapped (gate red), `acfLayouts: { latest_work: "skip" }` → green.
- `project` CPT from an export file: repeater with date, link and group sub-fields (stored rows win over display-formatted `get_fields()` dates), group, link, select, checkbox (serialized), true/false, date time, time, file, post object → `pages`, relationship; flexible content → gallery, rich text, map sections + an undescribed layout kept in the JSON field; seed `content` blocks.
- Options page: values from `raw/acf-options.json` (repeater rows rebuilt from `options_<name>_<i>_<sub>`), a password field never carried, undescribed `options_*` rows listed; `import-options` on a synthetic dump drops `options_maps_api_key` and `options_smtp_password`.

## Not verified yet

- **A real ACF site** (only the synthetic fixture and the plugin source). The Exporter's `acf` object for flexible content was read from its PHP source in `cpt-findings.md`; whether it includes disabled rows in REST context was not checked (the kit reads flexible rows from meta when present, so disabled rows are left out either way).
- **ACF Pro's zip itself** (not public): formats taken from SCF 6.9.10, which forked Pro.
- **Custom options page post ids** (`acf_add_options_page( [ 'post_id' => 'theme' ] )` → `theme_<name>`): only the default `options_` prefix is read.
- Seamless clones and ACF Blocks (`acf/*` Gutenberg blocks with data in block attributes) are not mapped beyond what the CPT mapper already did (clone with known sub-fields → group).
- The rendered look of ACF-built sections against the live theme (verify compares the page as a whole; ACF sections carry no row index).
