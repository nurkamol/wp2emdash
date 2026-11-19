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
| icon | `icon` `{ library, icon }` or `{ library: svg, svg }`, `isAccordionIcon`, `link` | icon (accordion icons skipped); with a link → a link named after the icon |
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
| code | `code`, `executeCode`, `cssCode`, `javascriptCode`, `parseDynamicData`. With `executeCode` Bricks evaluates `code` as a PHP template (editor mode `application/x-httpd-php-open`: HTML outside `<?php ?>` is output as is; `includes/elements/code.php`) | known widget markup without PHP (e.g. Mariana Tek `data-mariana-integrations`) → embed; anything else with `executeCode` → legacy, blocked, the diagnostic says whether it is real PHP or what static HTML/CSS/JS it outputs; JS flagged |
| html | `html` | embed / legacy |
| shortcode | `shortcode` | form plugin shortcode → form; else embed / legacy |
| template | `template` (post id) | inlined |
| alert | `content` (editor), `type` | text |
| animated-typing | `prefix`, `strings[{ text }]`, `suffix`, `tag` | first phrase |
| svg | `source` (file\|code\|iconSet\|dynamicData), `file`, `iconSet`, `code` | file → media, icon set → icon, inline → decorative |
| file | `file`, `external`, `downloadButtonText` | download link |
| post-title | — | the page title |
| post-content | `dataSource` (templates only: `editor` default = the_content, `bricks` = the post's Bricks data) | on a page: the page's own post_content through the Gutenberg adapter (blocks, classic + wpautop, shortcodes → forms) at the element's place; in a template / `bricks` source: `dynamic` |
| `{post_content}` tag (text-basic, text) | `includes/integrations/dynamic-data/providers/provider-wp.php` `get_the_content()`: `apply_filters('the_content', …)` | same as post-content when the text is only the tag |
| logo | `logo` (image), `logoInverse`, `logoDark`, `logoText` (alt, or the text logo without an image; dynamic data allowed), `logoUrl` (default `home_url()`), `logoHeight`, `logoWidth` (`includes/elements/logo.php`) | picture linking home (reaches the header/footer partial; the starter's header still draws its logo from the design capture); text logo → link |
| nav-menu, nav-nested, dropdown, offcanvas, toggle, search, breadcrumbs, sidebar, post-* (other), pagination, related-posts, back-to-top, filter-* | site chrome / query | reported `dynamic`; the header's nav-menu / nav-nested → primary menu, a known nav-menu elsewhere → its links (see "Header menus" below) |
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

## Verified on a real Bricks site (2026-11-19)

- EmDash Exporter **1.2.0** returns `_bricks_page_content_2` **unserialized**: an array of elements with
  `id, name, parent, children, settings` (first element `section`), alongside `_bricks_editor_mode` and
  `_bricks_template_type` in `meta`. The adapter reads it as is — the "PHP-serialized meta" fallback is not needed
  with this exporter version.
- Typical stack seen on a client Bricks site: Bricks + BricksExtras + NextBricks (third-party element packs, mapped
  per element as they come up) + Automatic.css (design variables; not read by the kit yet) + Fluent Forms + Rank Math.
- **Legal pages written in the WordPress editor:** a Bricks layout (post-title + container) shows the page's
  Gutenberg content through a `text-basic` whose text is `{post_content}` (not a post-content element). The waiver
  page's content is a `wp:shortcode` block `[fluentform id="…"]`. Both are now adapted in place.
- **Orphan elements:** an element whose `parent` id is not in the list is never rendered — `includes/frontend.php`
  `render_data()` only starts from elements with an empty `parent`. Seen on a real page (a stale `{post_content}`
  copy); the adapter skips orphans with an info diagnostic instead of treating them as top level (which duplicated text).
- **Code elements used for a booking widget:** `executeCode` on, content only `<div data-mariana-integrations="/…">`
  (Mariana Tek web integrations). The loader is a site-wide snippet (Header Footer Code Manager) that adds
  `https://<tenant>.marianaiframes.com/polyfills` and `/js`. Kept as an `embed` (provider `marianatek`); transform
  appends the two scripts with the tenant from the markup, `embeds.marianatekTenant` in kit.config.ts, or the loader
  in the live HTML snapshots. Starter allowlist: `*.marianaiframes.com`.

### Third-party elements (settings keys from each plugin's `set_controls()`; NextBricks 3.0.1, BricksExtras)

| Element (`name`) | Plugin file | Content keys | IR (effect not reproduced → `lossy`) |
|---|---|---|---|
| `blade-title` | nextbricks `elements/bc_blade_title.php` | `inner_title` (textarea), `tag` (h1–h6, p, span, custom + `customTag`; default h3), `link` | heading/paragraph; sliced reveal animation |
| `next_blur_reveal` | nextbricks `elements/next_blur_reveal.php` | same as blade-title | heading/paragraph; blur reveal |
| `swap-hover` | nextbricks `elements/bc_swap_title.php` | `inner_title`, `swap_title` (shown on hover), `tag`, `link` | heading with `inner_title`; warns with the swap text |
| `underlined-hover` | nextbricks `elements/bc_underline_title.php` | `inner_title`, `tag`, `link`, optional left/right icons | with a link → text link; else text; underline animation |
| `ripple_button_v2`, `ripple_button_v3` | nextbricks `elements/next_ripple_button_v2.php`, `…_v3.php` | `topRippleInnerTitle` (shown), `bottomRippleInnerTitle` (slides in on hover), `link`, `tag` (div/span/button) | button with the top label; warns with the hover label when it differs |
| `neumorphicbutton` | nextbricks `elements/bc_neumorphic_button.php` | `inner_title`, `link`, `tag`, icons | button; soft-shadow style |
| `imagereveal` | nextbricks `elements/bc_image_reveal.php` | `image` (image control, `useDynamicData`), `alt`, `height`, animation keys | image; reveal animation |
| `spotlight` | nextbricks `elements/bc_spotlight.php` | nestable (`$nestable = true`), layout keys, `mode` | its children's content; cursor spotlight background |
| `xfluentform` | bricksextras `components/classes/x-fluent-form.php` | `fluentFormSelect` (form id, control default `1`), or `formSource` + `fluentFormID` (may be dynamic data); the rest is styling | form section `fluent-forms#<id>`; dynamic id → error |
| Placeholders | — | the NextBricks title/button elements render "Next Bricks" when `inner_title` is empty | reported, not migrated |

## Verify on the first real Bricks site (old live site vs staging, 2026-11-20)

### Header menus

- Bricks themes register no menu locations: the exporter's `menus.json` lists every menu with `locations: []`. The
  header template places a `nav-menu` element whose `menu` setting is the WordPress menu's term id (a string). On the
  site, the desktop nav-menu named menu `18`, which is not among the site's menus (`id` 4 and 5 in menus.json), yet
  the live header printed `<ul id="menu-main" class="bricks-nav-menu">` (the offcanvas nav-menu names `4` = "main").
  WordPress prints a menu's slug as the list id (`menu-<slug>`, another copy on the page `menu-<slug>-1`), so the
  saved live HTML (audit snapshot) is the reliable evidence of which menu a header shows; the element id comes second.
- `nav-nested` (Bricks 1.8+) holds its own links: `text-link` items and `dropdown` items (`text`, optional `link`;
  their content holds more text-links); toggles and logos inside are chrome.
- Header calls to action are content elements of the header template (`button`, NextBricks `ripple_button_v3` with
  `topRippleInnerTitle` / `bottomRippleInnerTitle`), often twice: once in the bar, once in the offcanvas panel. The
  live panel's links read "Contact Us Reach Out" (both ripple labels are in the DOM).
- EmDash 1.5.0 menu items (`node_modules/emdash/dist/menu-*.mjs` `rowToMenuItem`; seed `SeedMenuItem`) carry
  `titleAttr` and `cssClasses`, and `getMenu()` returns both. The kit marks a header button with `cssClasses: "button"`
  (the starter's header already drew those as buttons) and stores its hover label in `titleAttr`.
- Kit: `src/adapters/bricks/menus.ts` (`headerMenu`, `nestedNavItems`, `headerButtons`); transform assigns the primary
  menu (and a secondary menu from the buttons) when no menu has that role yet.

### Footer

- The footer template used no nav-menu: links were NextBricks `underlined-hover` elements, social links were single
  `icon` elements with a `link` (`fab fa-instagram`, `fab fa-tiktok`), and the credit line was a `heading` (custom tag
  `span`) holding two links. The icon handler now keeps a linked icon as a link named after the icon; a nav-menu whose
  menu is known keeps its items as text links; a heading with links stays in the body (the section heading field is
  plain text and lost the designer credit link).

### Visual comparison

- Bricks renders `main#brx-content` and `footer#brx-footer`; every top-level element of the page/template is one direct
  child with a `brxe-<name>` class, in element-list order (sections, but also top-level blocks/containers and custom
  tags: the header section uses `customTag: header`). The kit pairs a migrated section with the live box by that
  index (`sourceRef.row`), hidden elements included (they are in the DOM with zero height).

### Other findings

- A Fluent date field with `is_time_enabled` (`date_format` `m/d/Y h:i K`) is a text input with `data-type-datepicker`
  on the live page; a Fluent checkbox list is one input per option (`name="checkbox[]"`). The forms package drew a
  single checkbox for a list (options lost) and a date-only input; Forms 1.5.0 draws a checkbox group and a
  date-and-time input.
- Rank Math custom titles may leave out the site name ("Member Login" on the Account page); the starter added
  " – Site" to every title. Now an SEO title different from the page title is printed as written.
- The design capture keeps the computed `font-family` with the browser's quotes (`"Pinyon Script"`): the token CSS
  became `""Pinyon Script""` and the Google Fonts request asked for `family=%22Pinyon+Script%22` (HTTP 400), so the
  site had no web font and a failing render-blocking stylesheet. Names are now unquoted. Google's css2 API answers 200
  for a single-weight family asked for 300–700 + italics as long as one requested style exists.
- Contact cards are `block`s with `tag: a` and a `link` (tel:, mailto:, a maps link) around an icon and a
  text-basic: the adapter kept the text and dropped the link. A linked block/div/container now gives its text the
  link (text that has no link of its own), reported `lossy` (the whole card is no longer one link).
- The verify text check counted the live Bricks header (`#brx-header`, not in the chrome list) but not the starter's
  header: every page "missed" the menu words. `#brx-header` and `.brx-popup` are chrome now, as for other themes;
  menus are compared by the menu check.
- The owner moved production to another domain mid-migration (the old domain redirects at go-live). Canonicals the
  live site printed on the old domain are now written on the production domain at load (same path).
- An SVG drawn to a PNG at 4× (capped at 3000px) made the footer logo a 574 KB PNG; the cap is now 1200px. The old
  `/wp-content/uploads/…/logo.svg` address redirects to the drawn `logo.png`.
