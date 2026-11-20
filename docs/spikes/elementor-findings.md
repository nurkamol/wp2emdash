# Elementor findings (adapter built 2026-11-21)

The Elementor adapter (`src/adapters/elementor/`) was built from Elementor's public developer documentation and the
control registrations in the open-source plugin (GPL, `github.com/elementor/elementor`, `main` branch, read
2026-11-21). Only data keys, meta keys and structure are recorded here; no plugin code is copied into the kit. Elementor
Pro is not open source on GitHub: Pro widget keys below come from Elementor's documentation, exported template JSON
conventions and the widgets' panel labels, and are marked **unverified** until a real Pro site confirms them.

No real Elementor client site exists yet. All fixtures (`test/fixtures/elementor/`) are hand-written synthetic JSON in
the documented format. **First task when the first Elementor client arrives:** run audit → extract → transform on it,
check every "unverified" and "open" item below, and measure visual parity against the live site (as for Salient
and Bricks).

## Verified from documentation and the open-source plugin

| Fact | Value | Source |
|---|---|---|
| Page data storage | Post meta, private custom field; JSON | developers.elementor.com/docs/data-structure/ |
| Meta key constants | `_elementor_data` (elements), `_elementor_edit_mode` (built with Elementor), `_elementor_template_type` (document type), `_elementor_page_settings` (page settings), `_elementor_element_cache`; `_elementor_version` also read/written | `core/base/document.php` constants `ELEMENTOR_DATA_META_KEY`, `BUILT_WITH_ELEMENTOR_META_KEY`, `TYPE_META_KEY`, `PAGE_META_KEY`, `CACHE_META_KEY` |
| Edit mode value | the string `builder` (not a boolean, "for rollback compatibility") | `core/base/document.php` `set_is_built_with_elementor()` |
| How `_elementor_data` is saved | `wp_slash( wp_json_encode( $data ) )` via `update_metadata` → `get_post_meta` returns **JSON text**; read back with `json_decode( $meta, true )` | `core/base/document.php` `save_elements()`, `get_json_meta()` |
| Element shape | `{ id, elType, isInner, settings, elements }`; widgets add `widgetType` (`heading`, `image`, `button`…); empty `settings` appears as `[]` | developers.elementor.com/docs/data-structure/general-elements |
| Element types | `section` / `column` (legacy), `container` (Flexbox Containers; nested containers in `elements`), `widget` | same |
| Template export JSON | top-level `title`, `type`, `version`, `page_settings`, `content`; document types include `header`, `footer`, `error-404`, `popup`, `page`, `post`; structure version 0.4 | developers.elementor.com/docs/data-structure/general-structure |
| Responsive values | base key = desktop; `_tablet`, `_mobile` suffixes; custom breakpoints follow the same pattern (`_widescreen`, `_laptop`); a device not set inherits the larger one at runtime | developers.elementor.com/docs/data-structure/responsive-data |
| Slider value | `{ unit, size, sizes: [] }` | same |
| Dimensions value | `{ unit, top, right, bottom, left, isLinked }`, sides as strings | same |
| Global references | `settings.__globals__ = { <control>: "globals/<colors\|typography>?id=<id>" }` (`primary`, or a generated id such as `8e2c1a4` for custom colours) | developers.elementor.com/docs/data-structure/global-styles |
| Where globals live | the active Kit (a special post holding the site design system) | same |
| Kit global colours | `system_colors` (fixed four: `primary` #6EC1E4, `secondary` #54595F, `text` #7A7A7A, `accent` #61CE70) and `custom_colors`, items `{ _id, title, color }` | `core/kits/documents/tabs/global-colors.php` |
| Kit global fonts | `system_typography` (`primary`, `secondary`, `text`, `accent`) and `custom_typography`, items `{ _id, title, typography_typography: custom, typography_font_family, typography_font_weight, typography_font_size, typography_line_height, typography_letter_spacing, typography_word_spacing, typography_text_transform, typography_font_style, typography_text_decoration }` | `core/kits/documents/tabs/global-typography.php` |
| Theme Builder condition groups | `general` (label "Entire Site"), `archive`, `singular` | developers.elementor.com/docs/theme-conditions/condition-group-type |
| counter | `starting_number`, `ending_number`, `prefix`, `suffix`, `duration`, `thousand_separator`, `title`, `title_tag` | `includes/widgets/counter.php` |
| video | `video_type` (`youtube`, `vimeo`, `dailymotion`, `videopress`, `hosted`), `youtube_url`, `vimeo_url`, `dailymotion_url`, `hosted_url` (media `{ url, id }`), `insert_url` (`yes`) + `external_url` (`{ url }`), `show_image_overlay` (`yes`) + `image_overlay` | `includes/widgets/video.php` |
| icon-list | `view`, `icon_list[{ text, selected_icon { value, library }, link { url } }]` | `includes/widgets/icon-list.php` |
| testimonial | `testimonial_content`, `testimonial_image`, `testimonial_name`, `testimonial_job`, `link`, `testimonial_alignment` | `includes/widgets/testimonial.php` |
| progress | `title`, `percent` (slider, %), `inner_text`, `progress_type` | `includes/widgets/progress.php` |
| icon-box | `selected_icon`, `view`, `title_text`, `description_text`, `link`, `title_size` (default h3), `position` | `includes/widgets/icon-box.php` |
| accordion | `tabs[{ tab_title, tab_content }]`, `title_html_tag`, `selected_icon`; legacy since 3.15 (replaced by `nested-accordion`, hidden from the panel when containers are on) | `includes/widgets/accordion.php` |
| image-carousel | `carousel` (gallery `[{ id, url }]`), `link_to`, `caption_type` | `includes/widgets/image-carousel.php` |
| social-icons | `social_icon_list[{ social_icon { value, library }, link }]`, `shape` | `includes/widgets/social-icons.php` |
| image | `image` (`{ url, id }`), `image_size`, `caption_source` (`none`/`attachment`/`custom`), `caption`, `link_to` (`none`/`file`/`custom`), `link` | `includes/widgets/image.php` |

## Taken from documentation conventions, not checked against source (verify on the first site)

- Free widgets not opened in source this time: `heading` (`title`, `header_size` default h2, `link`, `align`),
  `text-editor` (`editor`, `drop_cap`), `button` (`text`, `link`, `size`, `button_type`), `icon` (`selected_icon`,
  `link`), `image-box` (`image`, `title_text`, `description_text`, `link`), `toggle` and `tabs` (`tabs[{ tab_title,
  tab_content }]`), `image-gallery` (`wp_gallery`), `google_maps` (`address`), `html` (`html`), `shortcode`
  (`shortcode`), `alert` (`alert_title`, `alert_description`), `star-rating` (`rating`, `rating_scale`, `title`),
  `audio` (`link`), `menu-anchor` (`anchor`), `nested-accordion` (`items[{ item_title }]` + one child container per
  item), `nested-tabs` (`tabs[{ tab_title }]` + one child container per tab), `nested-carousel` (child containers).
- Layout settings: section `layout` (`boxed`/`full_width`), `stretch_section`, `gap` (`no`…), `height` (`full`,
  `min-height` + `custom_height`), `content_position`; column `_column_size` / `_inline_size`; container
  `content_width` (`boxed`/`full`), `flex_direction`, `flex_justify_content`, `flex_gap`, `min_height`, `width`,
  `container_type` (`flex`/`grid`) + `grid_columns_grid`; background group `background_background`
  (`classic`/`gradient`/`video`/`slideshow`), `background_color`, `background_image`, `background_attachment`,
  `background_color_b`, `background_color_stop`, `background_color_b_stop`, `background_gradient_type`,
  `background_gradient_angle`, `background_video_link`, `background_video_fallback`, `background_slideshow_gallery`;
  overlay `background_overlay_*` + `background_overlay_opacity`; `padding`; section typography `color_text`,
  `heading_color`, `text_align`; Advanced `_element_id`, `hide_desktop` / `hide_tablet` / `hide_mobile`
  (`hidden-desktop`…), entrance animation `animation` (sections/columns/containers) and `_animation` (widgets),
  display conditions `e_display_conditions`.
- Kit page settings beyond the global colours/fonts: `body_typography_*`, `body_color`, `h1_typography_*`…`h6_*`,
  `h1_color`…, `container_width`, `viewport_tablet`, `viewport_mobile`; option `elementor_active_kit` (which Kit is
  active) and Kit posts as `elementor_library` with `_elementor_template_type` = `kit`.
- Dynamic tags: `settings.__dynamic__ = { <control>: '[elementor-tag id="…" name="post-title" settings="<url-encoded
  JSON>"]' }`; names used: `post-title`, `site-title`, `page-title`, `current-date-time`, `internal-url`, `popup`,
  `post-featured-image`, `acf-*`.
- Global widgets: `{ elType: widget, widgetType: "global", templateID }` pointing at an `elementor_library` post of
  type `widget` whose `_elementor_data` holds the widget; the `template` widget embeds a saved template by
  `template_id`.

### Elementor Pro (unverified until a Pro site)

| Widget | Keys the adapter reads |
|---|---|
| form | `form_name`, `form_fields[{ custom_id, field_type (text, email, textarea, url, tel, radio, select, checkbox, acceptance, number, date, time, upload, password, html, hidden, recaptcha, recaptcha_v3, honeypot, step), field_label, placeholder, required, field_options ("label\|value" per line), width }]`, `button_text`, `submit_actions`, `email_to` (only to warn; never copied), `success_message` |
| nav-menu | `menu` (menu slug) |
| posts / archive-posts / portfolio / loop-grid / loop-carousel | `posts_post_type` (reported only) |
| slides | `slides[{ heading, description, button_text, link, background_image }]` |
| price-table | `heading`, `sub_heading`, `currency_symbol` (`dollar`, `euro`, …, `custom` + `currency_symbol_custom`), `price`, `period`, `features_list[{ item_text }]`, `button_text`, `link`, `show_ribbon`, `ribbon_title`, `sale` + `original_price`, `footer_additional_info` |
| price-list | `price_list[{ title, item_description, price, image, link }]` |
| call-to-action | `title`, `title_tag`, `description`, `button`, `link`, `bg_image`, `graphic_element` (`image`/`icon`) + `graphic_image` / `selected_icon`, `ribbon_title` |
| flip-box | `title_text_a`, `description_text_a`, `title_text_b`, `description_text_b`, `button_text`, `link`, `selected_icon`, `image` |
| gallery | `gallery_type` (`single`/`multiple`), `gallery`, `galleries[{ gallery_title, multiple_gallery }]`, `gallery_layout` (`grid`/`justified`/`masonry`) |
| media-carousel | `slides[{ type (image/video), image, video }]` |
| testimonial-carousel / reviews | `slides[{ content, name, title, image, rating }]` |
| animated-headline | `headline_style` (`rotate`/highlight), `before_text`, `highlighted_text`, `rotating_text` (one per line), `after_text`, `tag`, `link` |
| blockquote | `blockquote_content`, `author_name` |
| theme-site-logo, theme-post-title, theme-post-content, … | Theme Builder widgets (title filled, the rest reported as dynamic) |
| Theme Builder conditions | post meta `_elementor_conditions`: array of strings `include/general`, `include/singular/front_page`, `exclude/singular/page/<id>` (format seen in third-party docs; official docs describe the groups, not the storage) |
| Popups | template type `popup`; triggers in `_elementor_popup_display_settings.triggers` (`page_load`: `yes` + `page_load_delay` seconds; click, scroll, exit intent not read); opened by links `#elementor-action:action=popup:open&settings=<base64 {"id":"<popup id>","toggle":false}>` (URL-encoded in the link control) or the `popup` dynamic tag (`settings.popup` = id) |

## Mapping summary

Mapped / partial / reported, per widget: see PLAN §7b-2 and the coverage table in the adapter commit message.

## Open (needs a real Elementor client site)

- What the EmDash exporter returns for `_elementor_data`: the JSON text (expected; the adapter parses it and also
  accepts a decoded array or a still-slashed string) and whether it serves `elementor_library` posts (added to
  EXTRA_TYPES; if it refuses the type, Theme Builder parts, popups, global widgets and the Kit are missing — the extract
  note says so).
- Whether options.json can include `elementor_active_kit` (else the oldest published Kit is used, or
  `raw/elementor-options.json` from `ELEMENTOR_OPTIONS_WP_CLI`).
- The Pro widget keys above; popup triggers other than page load; popup display conditions.
- Visual parity: Elementor's default section/column padding (columns add 10px widget padding), boxed width (Kit
  `container_width`, 1140px default), default column gap, typography from the Kit vs the design capture. Elementor rows
  have no live-box measurement yet (Bricks has `bricksMeasure`); the audit already pairs `.elementor-top-section,
  .e-con.e-parent` sections for measured padding.
- Custom breakpoints beyond tablet/mobile (`_laptop`, `_widescreen`, `_tablet_extra`, `_mobile_extra`) are ignored
  (desktop, tablet and mobile values are read).
- Kit typography is reported in `reports/transform/elementor-design.json`, not yet turned into design tokens (the
  design capture of the live site is the token source, as for Bricks).
