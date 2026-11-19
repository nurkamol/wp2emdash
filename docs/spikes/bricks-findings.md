# Bricks findings (2026-11-19)

Read from the Bricks theme source, **2.4.6** (stable) and **2.5-beta**, on the maintainer's machine (commercial code: nothing copied into this repo; only setting keys, meta keys and structure are recorded here). Paths are relative to the theme folder `bricks/`. Not yet checked against a live Bricks client site or against what the EmDash exporter returns for Bricks meta (see "Open" at the end).

## Storage

| What | Where | Source |
|---|---|---|
| Page/post elements | post meta `_bricks_page_content_2` (array of elements) | `functions.php` `BRICKS_DB_PAGE_CONTENT`; `includes/database.php` `get_data()` |
| Editor mode | post meta `_bricks_editor_mode` (`bricks` / `wordpress`) | `functions.php` `BRICKS_DB_EDITOR_MODE` |
| Page settings | post meta `_bricks_page_settings` (`headerDisabled`, `footerDisabled`, …) | `includes/settings/settings-page.php`, `includes/database.php` |
| Templates | post type `bricks_template`; type in meta `_bricks_template_type`; settings (conditions) in `_bricks_template_settings` | `functions.php` `BRICKS_DB_TEMPLATE_*` |
| Template elements | header → `_bricks_page_header_2`, footer → `_bricks_page_footer_2`, every other type → `_bricks_page_content_2` | `includes/database.php` `get_bricks_data_key()`, `get_template_data()` |
| Template types | `header`, `footer`, `content` (single), `section`, `popup`, `archive`, `search`, `error`, `password_protection` (+ WooCommerce types) | `includes/setup.php` control options `templateTypes` |
| Template conditions | `_bricks_template_settings.templateConditions[]`: `{ main: any \| frontpage \| postType \| ids \| terms \| archiveType \| search \| error, postType[], ids[], exclude? }` | `includes/database.php` (scores per condition) |
| Colour palette | option `bricks_color_palette`: `[{ id, name, colors: [{ id, name, hex, rgb, raw, light, dark }] }]`; CSS var `--bricks-color-<colorId>` | `includes/assets.php` `generate_inline_css_color_vars()`, `generate_css_color()` |
| Global variables | option `bricks_global_variables`: `[{ id, name, value, category }]` (CSS `--<name>`) | `functions.php` |
| Global classes | option `bricks_global_classes`: `[{ id, name, settings: { …same keys as element settings… } }]`; elements list them in `settings._cssGlobalClasses: [id]` | `includes/elements/base.php` `get_element_global_classes()` |
| Theme styles | option `bricks_theme_styles`: `{ <styleId>: { label, settings: { conditions: { conditions: [{ main: any, … }] }, colors: { colorPrimary, … }, typography: { typographyBody, typographyHeadings, typographyHeadingH1…H6 }, section: { padding, … }, <element>: … } } }` | `includes/theme-styles.php`, `includes/theme-styles/controls/*.php` |
| Components (2.x) | option `bricks_components`: `[{ id, category, properties: [{ id, label, type, default, connections: { <elementId>: [settingKey] } }], elements: [ root (id = component id), … ] }]`; an instance on a page is `{ id, name: <root name>, cid: <componentId>, properties: { <propId>: value }, children }` | `includes/components.php`, `includes/helpers.php` (property application) |
| Breakpoints | option `bricks_breakpoints` (custom), default `desktop` 1279 (base), `tablet_portrait` 991, `mobile_landscape` 767, `mobile_portrait` 478. A small breakpoint can be the base (mobile-first). | `includes/breakpoints.php` |
| Element settings per breakpoint / state | key suffix: `_padding:mobile_portrait`, `_display:tablet_portrait`, `_background:hover` | `includes/breakpoints.php`, `includes/assets.php` |
| Other options | `bricks_global_settings`, `bricks_global_elements` (legacy), `bricks_global_queries`, 2.5: `bricks_global_filters` | `functions.php` |
| Interactions | element `settings._interactions: [{ id, trigger: click\|…, action: show\|…, target: popup\|…, templateId }]` | `includes/interactions.php` |

None of these options are exposed over REST by WordPress or Bricks (Bricks' own REST namespace `bricks/v1` serves the builder: templates, remote library, query pages).

## Shared element settings (`includes/elements/base.php`, layout elements in `container.php`)

`_cssId`, `_cssClasses`, `_cssGlobalClasses`, `_hidden._cssClasses` (classes Bricks adds itself, e.g. `tab-menu`), `_background` (`color`, `image` `{id,url,size,filename,full,external?,useDynamicData?}`, `videoUrl`, `attachment`, `size`, `position`), `_gradient` (`applyTo` background\|overlay\|text, `gradientType`, `angle`, `colors[{color, stop}]`), `_padding`/`_margin` (`{top,right,bottom,left}`, unitless = px, may be `var(--x)` or `clamp()`), `_typography` (`color`, `text-align`, `font-*`), `_width`, `_widthMax`, `_height`, `_heightMin`, `_display`, `_direction`, `_columnGap`, `_rowGap`, `_gap`, `_justifyContent`, `_alignItems`, `_gridTemplateColumns`, `_gridGap`, `_conditions` (element conditions), `_interactions`, `_motionBackgroundParallax`. Query loops: `hasLoop: true` + `query: { objectType, post_type[], … }` on container/block/div.

Colours: a colour value is `{ hex, rgb, raw, id, name }`; with an `id` Bricks prints `var(--bricks-color-<id>)`; `raw` can be any CSS (`var(--x)`). Element ID styles beat class styles, so element settings win over global class settings.

Editor HTML (`text`, accordion/tab content, icon-box content, alert) goes through `Helpers::parse_editor_content()`: wpautop + shortcode_unautop + do_shortcode (`includes/helpers.php`).

## Elements (2.4.6 = 2.5 unless noted; `includes/elements/<name>.php`)

| Element | Content settings | Adapter |
|---|---|---|
| section, container, block, div | layout keys above; `container` has `link`, `tag` | structure; row when `_direction: row` or grid with ≥2 tracks |
| heading | `text`, `tag` (default h3), `link` | rich text (+ link) |
| text-basic | `text`, `tag` (default div), `link` | paragraph |
| text | `text` (editor) | rich text (autop) |
| text-link | `text`, `link`, `icon` | link button |
| button | `text`, `link`, `style` (primary, secondary, light, dark, muted, info, success, warning, danger), `size` (sm, md, lg, xl), `outline`, `circle`, `icon` | button (outline/secondary/light/muted/dark → secondary; lg/xl → large) |
| link control | `{ type: internal\|external\|taxonomy\|media\|lightboxImage\|lightboxVideo\|meta, postId, url, newTab, rel, … }` | internal → migrated path |
| icon | `icon` `{ library, icon }` or `{ library: svg, svg }`, `isAccordionIcon` | icon (accordion icons skipped) |
| icon-box | `icon`, `content` (editor), `link` | feature card |
| image | `image`, `altText`, `caption` (none\|attachment\|custom) + `captionCustom`, `link` (lightbox\|attachment\|media\|url) + `url` | media (+ link, custom caption) |
| image-gallery | `items: { images: [image], size, useDynamicData }`, `layout` (grid, masonry, metro) | gallery |
| carousel | `type` (media\|posts), `items` (as gallery), `query`; 2.5 adds `lightboxId` | gallery carousel / dynamic |
| video | `videoType` (youtube, vimeo, media, file, meta), `youTubeId`, `vimeoId`, `media`, `fileUrl`, `previewImage` + `previewImageCustom`, `videoPoster` | video |
| list | `items[{ title, meta, description, link, icon, highlight }]` | bullet list |
| accordion | `accordions[{ title, subtitle, content, anchorId }]`, `faqSchema` | FAQ |
| accordion-nested | children: item blocks → [title block (heading + icon `isAccordionIcon`), content block] | FAQ (answers are text) |
| tabs | `tabs[{ title, content, icon }]` | tabs |
| tabs-nested | children: block `_hidden._cssClasses: tab-menu` (div `tab-title` per tab) + block `tab-content` (block `tab-pane` per tab); 2.5 adds `accordionLayoutAtBreakpoint` | tabs |
| slider | `items[{ title, titleTag, content, buttonText, buttonLink, background }]` | carousel gallery or cards |
| slider-nested | children: one block per slide; 2.5 adds playback/auto-scroll options | carousel gallery or cards |
| testimonials | `items[{ content, name, title, image }]` | testimonials |
| team-members | `items[{ image, title, subtitle, description }]` | team |
| pricing-tables | `pricingTables[{ title, subtitle, pricePrefix, price, priceSuffix, priceMeta, priceOriginal, features (one per line), buttonText, buttonLink, additionalInfo, ribbonText, showUnder (tab-1\|tab-2) }]`, `tabs`, `tab1Label`, `tab2Label` | pricing |
| counter | `countFrom`, `countTo`, `prefix`, `suffix` (no label setting) | stat; the short text right after it is its label |
| progress-bar | `bars[{ title, percentage }]` | stats (%) |
| social-icons | `icons[{ icon, label, link }]` | links |
| map | `addresses[{ address, latitude, longitude, info* }]`, legacy `address` | map (Google embed, first address) |
| map-leaflet | `markers[{ coordinates "lat, lng", label, popupText }]`, `center` | map (OpenStreetMap embed, first marker) |
| form | `fields[{ id, type (email, text, textarea, richtext, tel, number, url, image, gallery, checkbox, select, radio, file, datepicker, password, rememberme, html, hidden), label, placeholder, value, name, required, options (one per line), valueLabelOptions, width (%), isHoneypot, autocomplete }]`, `submitButtonText` (default "Send"), `actions` (default `[email]`; also redirect, mailchimp, sendgrid, webhook, login, registration, lost-password, reset-password, create-post, update-post, save-submission, custom), `successMessage` (default "Message successfully sent. We will get back to you as soon as possible."), `emailTo` (admin_email\|custom) + `emailToCustom`, `emailBcc`, `fromEmail`, `replyToEmail`. Field input name: `name` or `form-field-<id>`. 2.5 adds field `description`, `time24hr`, `noCalendar`. | form section + definition; recipients never copied |
| code | `code`, `executeCode`, `cssCode`, `javascriptCode`, `parseDynamicData` | embed / legacy (PHP, JS flagged) |
| html | `html` | embed / legacy |
| shortcode | `shortcode` | form plugin shortcode → form; else embed / legacy |
| template | `template` (post id) | inlined |
| alert | `content` (editor), `type` | text |
| animated-typing | `prefix`, `strings[{ text }]`, `suffix`, `tag` | first phrase |
| svg | `source` (file\|code\|iconSet\|dynamicData), `file`, `iconSet`, `code` | file → media, icon set → icon, inline → decorative |
| file | `file`, `external`, `downloadButtonText` | download link |
| post-title | — | the page title |
| nav-menu, nav-nested, dropdown, offcanvas, toggle, logo, search, breadcrumbs, sidebar, post-* , pagination, related-posts, back-to-top, filter-* | site chrome / query | reported `dynamic` |
| posts, `hasLoop` containers | `query` | reported `dynamic` (error when the site has entries) |
| divider, lottie (2.5) | — | dropped (decorative), reported |
| countdown, rating, pie-chart, audio, wordpress, … | — | `unmapped` |

## 2.4.6 → 2.5-beta differences that matter

- **New elements:** `lottie` (animation), `filter-geolocation`. No element was renamed or removed, and no content setting key was renamed or removed (diffed the `set_controls()` keys of every element file). Added keys: base `_columns` + `_columnGap` (CSS multi-column text on non-layout elements; reported as lossy), form `autofocusField` + description styling, tabs-nested `accordionLayoutAtBreakpoint`, slider-nested `autoScroll*` / `playbackControl*`, carousel `lightboxId`, nav-menu/dropdown `megaMenuAlignment`/`megaMenuWidth`, map/map-leaflet query-sync and marker-cluster options, search overlay options, filter-* definition/hierarchy options (filter-select drops its `choices*` styling keys).
- **Form:** fields gain `description` (help text under the field), datepicker `time24hr` / `noCalendar`; autofocus handling. The adapter reports a description as a form warning (no field for it yet).
- **tabs-nested:** `accordionLayoutAtBreakpoint` (tabs become an accordion on small screens); titles may also render inside `.tab-content`. Storage unchanged.
- **slider-nested:** playback control and auto-scroll options. **carousel:** `lightboxId` grouping. **map-leaflet:** can sync markers with a query loop (2.5); the adapter reads static `markers` only. Display only otherwise.
- **Image control:** 2.5 centralises background images (`includes/background-images.php`); `external` (image by URL) is honoured for backgrounds too. The adapter reads `external` as a URL.
- **New storage, not read:** drafts / site versions (`includes/drafts.php`: tables `{prefix}bricks_versions`, `{prefix}bricks_version_items`; the published page stays in `_bricks_page_content_2`, so the extract reads the live version), `bricks_global_filters` option (query filters), `bricks_builder_variable_renames` (builder bookkeeping).
- No meta key, template type, breakpoint key or element name changed between the two.

## Open (needs a real Bricks client site)

- What the EmDash exporter returns for Bricks meta: unserialized arrays (assumed) or PHP-serialized strings (reported as unreadable today); whether it returns `bricks_template` header/footer meta.
- Whether the exporter can include `bricks_*` options in options.json; until then `raw/bricks-options.json` (WP-CLI export) is needed for palette, classes, theme style and components.
- Spacing and layout measured against the live site (container widths, default gaps), as for Salient.
- Page-specific headers/footers (conditions other than "entire website"), and `headerDisabled`/`footerDisabled` pages.
- Legacy global elements (`bricks_global_elements`, element `global` key) are not resolved; components are.
- Popup templates' own trigger settings (page load, scroll, exit intent) are not read; only button interactions open them.
