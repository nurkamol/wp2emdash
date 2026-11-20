# DOM-fallback findings (adapter built 2026-11-21)

The DOM-fallback adapter (`src/adapters/dom-fallback/`) rebuilds a page from the HTML the live site served, for every
builder or theme the kit has no adapter for (Avada/Fusion, Oxygen, Beaver Builder, Brizy, Thrive Architect, SiteOrigin,
Breakdance, Visual Composer, Flatsome UX Builder, Enfold, Cornerstone, theme markup…). Before it, such a page stopped
at transform (unmapped shortcodes) or came out empty (builders that keep the page in post meta).

**Nothing below was checked against a real site of any of these builders.** The fixtures (`test/fixtures/dom-fallback/`)
are hand-written pages in each builder's public markup style (class names as seen in their front-end output and docs),
for invented businesses on `.example` domains. **First task on the first such client:** run audit → extract → transform,
read the coverage report's "Rebuilt from rendered HTML" table, and compare every page with the live one.

## Where the HTML comes from

| Item | Fact | Confidence |
|---|---|---|
| Source | `snapshot/html/<page>.html`, written by the audit from the HTTP response body (`src/phases/audit.ts`), matched to the WordPress id through `snapshot/pages/<page>.json` `wpId` | high (kit code) |
| Rendered by | the server: what PHP printed. Content a script draws after load (JS sliders, lazy widgets, Revolution Slider layers, some Brizy/Thrive effects) is **not** in it | high |
| Pages without a snapshot | not rebuilt: the classic/empty handling stays and a blocking `unmapped` diagnostic (tag `dom-fallback`) asks for an audit that includes the page | high (kit code) |

## When a page goes to the fallback (`detect.ts`)

Only pages `detectBuilder` returns `classic` or `empty` for. WPBakery, Gutenberg blocks, Bricks, Elementor and Divi
pages are never touched. Never the posts page (`page_for_posts`), the WooCommerce shop page or a page whose snapshot
shows WordPress's password form.

| Evidence | Builder | Confidence |
|---|---|---|
| Post meta `_fl_builder_enabled` = 1 / `_fl_builder_data` | Beaver Builder | medium (meta keys from the plugin's public docs; exporter output unverified) |
| `ct_builder_shortcodes`, `_ct_builder_shortcodes`, `ct_builder_json`, `_ct_builder_json`, `_oxygen_data` | Oxygen (4 / 6) | medium / assumed (Oxygen 6 key) |
| `_breakdance_data`, `breakdance_data` | Breakdance | assumed |
| `brizy`, `brizy_post_uid` | Brizy | assumed |
| `tcb_editor_enabled` = 1, `tve_updated_post` | Thrive Architect | medium |
| `panels_data` | SiteOrigin Page Builder | high (well known) |
| `vcv-pageContent` | Visual Composer (standalone) | assumed |
| `_zionbuilder_page_status` = enabled, `_cornerstone_data`, `_themify_builder_settings_json`, `dslc_code` | Zion, Cornerstone, Themify, Live Composer | assumed |
| `fusion_builder_status` = active / `[fusion_…]` shortcodes | Avada | high (shortcodes), medium (meta) |
| `_aviaLayoutBuilder_active` = active / `[av_…]` | Enfold | medium |
| `[ux_…]` or `[section][row]` | Flatsome | high (shortcodes) |
| `[cs_…]`, `[x_…]`, `[themify_…]`, `[kc_…]`, `[mfn_…]`, `[mk_…]`, `[us_…]`, `[tatsu_…]`, `[qode_/edgtf_/eltd_/mkdf_/qodef_…]`, `[trx_…]` | Cornerstone, X, Themify, KingComposer, BeTheme, Jupiter, Impreza, Tatsu, Qode themes, ThemeREX | medium |
| Builder markup copied into post_content (`fl-row`, `panel-grid`, `thrv_wrapper`, `brz-`, `vce-row`, `ct-section`, `bde-`) | Beaver, SiteOrigin, Thrive, Brizy, Visual Composer, Oxygen, Breakdance | medium |
| ≥ 3 shortcodes neither the registry nor core knows, with < 20% of the text outside them | unknown | kit heuristic |
| Body class `fl-builder`, `siteorigin-panels`, `vcwb`, `brz`; `id="tve_editor"` | page-specific markers (any page) | medium |
| Body class `oxygen-body`, `breakdance`, `fusion-body`, `flatsome` | site-wide renderers: only explain an **empty** post_content | medium |
| Empty post_content and ≥ 15 words in the live page's main area | unknown (the theme or a builder renders it) | kit heuristic |

## What maps

Rows: top-level boxes of the content root (single-child wrappers stepped through; their inline backgrounds kept);
loose text split at the top heading level. Columns: 2–6 sibling boxes with column classes, inline `width: N%` /
`flex`, or a flex/grid/`row` parent. Then the shared recognisers (hero, media_text, columns, feature grid, FAQ, tabs,
testimonials, gallery, form, embed, video, map, legacy_html) — the same output shape as the other adapters.

| Source | Becomes |
|---|---|
| h1–h6, p, lists, blockquote, inline text in boxes | rich text (Portable Text via `htmlToPortableText`) |
| img / picture / figure (lazy `data-src`, `data-lazy-src`, `data-orig-src`, srcset) | image; `wp-image-N`, `data-id` or the upload URL (`mediaIdForUrl`, size variants stripped) → media library id; a link around it kept unless it points at the image file |
| `a` with a builder button class (`fusion-button`, `fl-button`, `ct-link-button`, `tcb-button-link`, `sowb-button`, `bde-button__button`, `button`…) or `role=button` | button; outline/ghost/secondary → secondary; site links → paths; popups resolved |
| iframe (lazy `data-src`) | embed registry: YouTube/Vimeo → video, Google Maps → map, providers → embed; else legacy_html |
| `<script>` of a known provider (Calendly…) + its empty mount element | embed |
| video | video section; muted autoplay loop without controls → the row's background video (+ poster) |
| form | plugin form by id (CF7 via `wpcf7-f<id>`, Gravity, WPForms, Ninja, Formidable, Forminator, WS Form, Fluent); builder/theme form → definition rebuilt from its fields (`ir/forms/html-<post>-<n>.json`, warning: recipients, success message and conditions are not in the HTML); search form left out; Mailchimp/HubSpot → embed registry or legacy_html |
| details/summary; `aria-controls` pairs or title + content/body/panel siblings inside an `accordion`/`toggle`/`faq` box | FAQ |
| `role=tab` + `role=tabpanel` (or `.nav-tabs` + `.tab-pane`) | tabs (pictures/forms inside a panel reported) |
| box with a `testimonial` class: quote + name (`cite`, `*name*`, `*author*`) + role + photo | testimonials |
| `gallery`/`image-grid` box, or a slider (`swiper`, `slick`, `owl`, `flexslider`…) holding only pictures | gallery (grid / carousel); slider clones removed |
| two or more `article.post` in a blog/posts box | `dynamic` (no posts) or `unmapped` (needs a posts-listing section) |
| inline `background-color` / `background` / `--…-background-color`, gradients, `background-image`, lazy `data-bg*`, an empty background layer child | section background; light text from an inline `color`, `dark`/`text-light` classes or a dark background |

## What does not map (and how it is reported)

| Case | Handling |
|---|---|
| Theme chrome: header, menus, footer, sidebar, cookie banners, popups/modals, title bar, breadcrumbs, comments, post navigation | removed; counted in one info note ("left out of the rebuilt page: …") |
| Elements hidden on desktop (`fl-visible-mobile`, `fusion-no-large-visibility`, `hide-for-large`, `hidden-desktop`, `d-lg-none`…, `display:none`, `hidden`) | not migrated; each listed as a warning with its text |
| Tables, unknown iframes, `object`/`embed`, audio | sanitised legacy_html (scripts, styles, `on*` handlers and `javascript:` links removed first); blocks the gate until approved |
| Dividers, icons, inline SVG, empty boxes/spacers | counted in the info note |
| A link around a whole box (card links) | text kept, link reported (info) |
| Literal shortcode text on the live page (`[ux_tide_table …]`) | kept as text, warning |
| CSS from stylesheets: backgrounds, spacing, fonts, column widths set by classes the kit does not know, grid/absolute layouts | **not carried**: the starter's defaults apply; this is why every page is gated for review |
| Audit section boxes (measured padding) | not applied: they are paired by builder row, which rendered HTML does not have |

## Review gate

- Every rebuilt page carries a `flagged` warning (tag `dom-fallback`): "Rebuilt from the live page's rendered HTML (…); check it visually".
- Transform gate `dom-fallback-reviewed` (only present when such pages exist) fails until `overrides.ts`
  `domFallbackReviewed: { "<slug>": "<who checked it, when>" }` holds a note for every published one; the warning then
  drops to info. legacy_html in those pages still needs `approvedLegacy` (gate `legacy-html`).
- Coverage report: section "Rebuilt from rendered HTML (DOM fallback)" (page, builder, evidence, sections, legacy_html
  count, reviewed); `coverage.json` → `domFallback`.
- IR: `source.builder = "dom-fallback"`, `sourceRef.adapter = "dom-fallback"`, row paths `dom[<n>]` (usable in
  `overrides.ts elements`), `sourceRef.row` = position of the box in the content root.

## Open questions for the first real site

1. Do the meta keys above appear in the Exporter's `meta` for these builders (some are private `_` keys)?
2. Does the audit's server HTML hold the builder content for each builder, or do some (Brizy, Thrive effects) draw it
   with scripts? If so, the audit could save the rendered DOM (Playwright already runs for screenshots).
3. Which stylesheet-only backgrounds matter most per builder (Beaver's `fl-node-*` rules, Oxygen's per-id CSS files)?
   A follow-up could read the page's own builder CSS file for `background-*` per node id.
4. Builder visibility classes beyond the list (per-breakpoint classes differ by version).
