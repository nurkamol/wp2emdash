# Divi findings (adapter built 2026-11-21)

The Divi adapter (`src/adapters/divi/`) was built from the format Divi saves into `post_content` (Divi 4 shortcodes)
and into block comments (Divi 5), as known from Divi exports and Elegant Themes' public documentation. Divi is a
commercial theme: no Divi code was read or copied; only shortcode tags, attribute names and meta keys are used.

**Nothing below was checked against a live Divi install or a real export in this session.** No real Divi client site
exists yet, and the fixtures (`test/fixtures/divi/`) are hand-written synthetic content (an invented pottery studio on
`fernhill.example`). Each item carries a confidence level; **first task when the first Divi client arrives:** run audit
→ extract → transform on it, confirm every item marked *assumed*, and measure visual parity against the live site (as
for Salient and Bricks).

## Content format (Divi 4)

| Item | Value used by the adapter | Confidence |
|---|---|---|
| Where the page lives | `post_content`, as nested shortcodes; meta `_et_pb_use_builder` = `on` | high (visible in any Divi export) |
| Structure | `[et_pb_section]` → `[et_pb_row]` → `[et_pb_column type="1_2"]` → modules; specialty sections `specialty="on"` with `[et_pb_row_inner][et_pb_column_inner]` in a column; fullwidth sections `fullwidth="on"` holding `et_pb_fullwidth_*` modules | high |
| Column widths | `type` = `4_4`, `1_2`, `1_3`, `2_3`, `1_4`, `3_4`, `1_5`, `2_5`, `3_5`, `1_6`, `5_6`; row `column_structure="1_2,1_2"` | high |
| Common attributes | `admin_label`, `module_id` (CSS id), `module_class`, `_builder_version`, `global_colors_info`, `fb_built` | high |
| Hidden / disabled | `disabled_on="phone\|tablet\|desktop"` with `on`/`off` per device (order phone, tablet, desktop); `disabled="on"` | medium (order assumed from the builder's UI order) |
| Backgrounds | `background_color`, `use_background_color` (`off` = none), `background_image`, `parallax` (`on`), `background_video_mp4` / `_webm`, gradient `use_background_color_gradient="on"` with `background_color_gradient_stops="#a 0%\|#b 100%"` (4.16+) or `_start` / `_end` / `_direction` / `_type` (older) | medium (stops format assumed) |
| Padding | `custom_padding="top\|right\|bottom\|left\|linkedTB\|linkedLR"` (e.g. `80px\|\|80px\|\|false\|false`), plus `_tablet` / `_phone` variants (not read) | high |
| Text colour | module `background_layout="dark"` = light text for a dark background (Divi 4.x) | medium |
| Text alignment | module `text_orientation` (`left`, `center`, `right`, `justified`) | high |
| Full width row | row `make_fullwidth="on"` (older) or `width="100%"` / `max_width="100%"` | medium |
| Global colours | attribute value `gcid-<id>` (and `var(--gcid-<id>)`), definitions in option `et_global_data` → `global_colors` → `{ "gcid-<id>": { color, active } }` | **assumed** (storage option name not confirmed) |
| Dynamic content | `@ET-DC@<base64 JSON>@`, JSON `{ dynamic: true, content: "post_title" \| "site_title" \| "current_date" \| …, settings: { before, after, date_format, custom_date_format } }` | medium |
| Attribute JSON encoding | `%22` = `"`, `%91` = `[`, `%93` = `]`, `%92` = `\` (contact field options, presets) | medium |
| Code module content | line breaks saved as `<!-- [et_pb_line_break_holder] -->`, brackets as `&#91;` / `&#93;`, `<!-- [et_pb_br_holder] -->` = `<br />` | medium |
| Font icons | `font_icon="&#xe08d;\|\|divi\|\|400"` (Font Awesome: `\|\|fa\|\|900`), legacy `%%52%%` | medium |
| Global modules | `global_module="<et_pb_layout id>"`; the module's content is also saved in the page (the adapter uses that copy) | medium |

## Module fields read

| Module | Fields | Confidence |
|---|---|---|
| `et_pb_text` | enclosed HTML (wpautop applies) | high |
| `et_pb_image` / `et_pb_fullwidth_image` | `src`, `alt`, `title_text`, `url`, `show_in_lightbox` | high |
| `et_pb_button` | `button_text`, `button_url`, `url_new_window` (`on`) | high |
| `et_pb_cta` | `title`, enclosed text, `button_text`, `button_url`, `url_new_window` | high |
| `et_pb_blurb` | `title`, `url`, `image`, `alt`, `use_icon`, `font_icon`, enclosed text | high |
| `et_pb_slider` / `et_pb_fullwidth_slider` → `et_pb_slide` | `heading`, enclosed text, `button_text`, `button_link`, `background_image`, `image`, `image_alt` | high |
| `et_pb_fullwidth_header` | `title`, `subhead`, enclosed text, `button_one_text` / `_url`, `button_two_text` / `_url`, `background_image` (older `background_url`), `header_image_url`, `logo_image_url`, `header_fullscreen`, `scroll_down_icon` | medium |
| `et_pb_gallery` | `gallery_ids` (comma list), `fullwidth="on"` = slider | high |
| `et_pb_video`, `et_pb_video_slider_item` | `src` (YouTube/Vimeo URL or file), `src_webm`, `image_src` | high |
| `et_pb_testimonial` | `author`, `job_title`, `company_name`, `portrait_url`, enclosed quote | high |
| `et_pb_team_member` | `name`, `position`, `image_url`, `facebook_url`, `twitter_url`, `google_url`, `linkedin_url` (+ `instagram_url` assumed), enclosed bio | medium |
| `et_pb_pricing_tables` → `et_pb_pricing_table` | `title`, `subtitle`, `currency`, `sum`, `per`, `featured`, `button_text`, `button_url`; enclosed lines, leading `-` = excluded, `+` = included | medium |
| `et_pb_accordion` → `et_pb_accordion_item`, `et_pb_toggle` | `title`, enclosed text, `open` | high |
| `et_pb_tabs` → `et_pb_tab` | `title`, enclosed text | high |
| `et_pb_contact_form` → `et_pb_contact_field` | form: `title`, `email` (recipient), `success_message`, `submit_button_text`, `captcha`, `use_redirect`, `redirect_url`, `custom_message`; field: `field_id`, `field_title`, `field_type` (`input`, `email`, `text`, `checkbox`, `radio`, `select`), `required_mark` (default `on`), `fullwidth_field`, `checkbox_options` / `radio_options` / `select_options` (encoded JSON `[{value, checked, dragID}]`), `conditional_logic` | medium (defaults assumed) |
| `et_pb_code` / `et_pb_fullwidth_code` | enclosed HTML (decoded as above) | high |
| `et_pb_map` → `et_pb_map_pin` | `address`, `address_lat`, `address_lng`; pin `title`, `pin_address`, `pin_address_lat` / `_lng` | medium |
| `et_pb_social_media_follow` → `et_pb_social_media_follow_network` | `social_network`, `url`; enclosed text = the network slug | medium |
| `et_pb_number_counter`, `et_pb_circle_counter` | `title`, `number`, `percent_sign` (default `on`) | medium |
| `et_pb_counters` → `et_pb_counter` | `percent`, enclosed label | medium |
| `et_pb_menu` / `et_pb_fullwidth_menu` | `menu_id`, `logo` | medium |
| `et_pb_icon` | `font_icon` | medium |
| `et_pb_heading` (Divi 5 / newer 4.x) | `title`, `title_level` | **assumed** |

Reported, not mapped: `et_pb_blog`, `et_pb_portfolio`, `et_pb_filterable_portfolio`, `et_pb_fullwidth_portfolio`,
`et_pb_post_slider`, `et_pb_fullwidth_post_slider` (listings); `et_pb_search`, `et_pb_login`, `et_pb_sidebar`,
`et_pb_comments`, `et_pb_post_nav`, `et_pb_countdown_timer`, `et_pb_post_content`, `et_pb_shop`, `et_pb_wc_*`
(dynamic); `et_pb_signup` (email opt-in), `et_pb_audio` and third-party Divi modules (unmapped).

## Theme options and Theme Builder

| Item | Value used | Confidence |
|---|---|---|
| Theme options | option `et_divi` (array): `accent_color`, `font_color`, `header_color`, `link_color`, `body_font`, `heading_font`, `body_font_size`, `body_header_size`, `body_font_height`, `content_width`, `gutter_width`, `primary_nav_bg`, `footer_bg`, `all_buttons_*` | medium (Customizer setting names) |
| Neither option over REST | read from the exporter's options.json if present, else `raw/divi-options.json` (WP-CLI command in `src/extract/divi.ts`) | assumed (same as Elementor/Bricks options) |
| Theme Builder post types | `et_template` (one per template), `et_header_layout`, `et_body_layout`, `et_footer_layout` (content = Divi shortcodes, sections carry `theme_builder_area`), `et_theme_builder` (the set) | medium |
| Template meta | `_et_default` (`1` = default website template), `_et_enabled`, `_et_use_on` / `_et_exclude_from` (conditions such as `singular:post_type:page:all`, `homepage`), `_et_header_layout_id` / `_enabled`, `_et_body_layout_id` / `_enabled`, `_et_footer_layout_id` / `_enabled` | **assumed** (key names from exports; how the exporter returns multi-value meta is unknown, both arrays and strings are accepted) |
| Divi Library | `et_pb_layout` (saved layouts, global modules) | high |

## Divi 5 (best effort)

Divi 5 saves blocks in the `divi/` namespace (`divi/placeholder` wrapping `divi/section` → `divi/row` → `divi/column`
→ modules). Attributes are nested per field and breakpoint, e.g. `{"content":{"innerContent":{"desktop":{"value":"…"}}}}`,
`{"title":{"innerContent":{"desktop":{"value":"…"}}}}`, `{"button":{"innerContent":{"desktop":{"value":{"text","linkUrl","linkTarget"}}}}}`,
`{"image":{"innerContent":{"desktop":{"value":{"src","alt","id"}}}}}`, styling under `module.decoration` (background
`{ color, image: { url } }`) and `module.advanced` (`htmlAttributes.id`, column `type`). The reader (`divi5.ts`) flattens
desktop values onto the Divi 4 field names and reuses the same handlers; every Divi 5 page gets a `lossy` warning in the
coverage report. **All of this is assumed** from Divi 5's public beta format and must be checked on a real Divi 5 export.

## Open questions for the first real Divi site

- Does the exporter return `et_template` meta (and multi-value `_et_use_on`) and the Theme Builder layout post types?
- Where global colours live on that version (`et_global_data` vs inside `et_divi`), and whether presets
  (`et_divi_builder_global_presets_ng`) change module defaults that matter visually (they are not read).
- Responsive values (`*_tablet`, `*_phone`, `*_last_edited`) are ignored except for hiding: check spacing against the
  live site.
- Image links (`url` on `et_pb_image`) are reported because the section library's pictures carry no link.
