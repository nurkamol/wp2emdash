# Gutenberg block-library findings (handlers built 2026-11-21)

`src/adapters/gutenberg/libraries.ts` maps the blocks of five Gutenberg block libraries onto the section library. The
handlers read only what `post_content` stores: the block name, its JSON attributes and the static HTML the block saves
(the libraries' public block format). No plugin code was read or copied.

**Nothing below was checked against a live install or a real site in this session.** The fixtures
(`test/fixtures/gutenberg/lib-*.html`) are hand-written synthetic pages (invented businesses on `.example` domains) in
the saved formats as known from the libraries' exports. Confidence is given per family; the first real site using one
of these libraries should confirm the *assumed* items and the visual result.

## How blocks are read

- **Layout** (`isLibRow`, `LIB_CONTAINERS`, `libColumnWidth`, `libStyle`): a row of columns becomes a row (top level) or
  a sub-row (nested); other wrappers are transparent. Container styling keeps only real colours (hex/rgb; palette slugs
  such as Kadence `palette3` are not resolved), background image (media id preferred), MP4 video, overlay, anchor and
  full width.
- **Static text blocks** (advanced heading, GenerateBlocks headline/text, Stackable heading/text/subtitle, Spectra
  blockquote/inline notice, CoBlocks alert/highlight/click-to-tweet): their saved HTML is the content.
- **Composite blocks**: read from attributes first, then from class names in the saved HTML.
- **Forms**: Kadence `kadence/form` (fields in attributes), Spectra `uagb/forms` + `uagb/forms-*` children, CoBlocks
  `coblocks/form` + `coblocks/field-*` children → form definitions `ir/forms/<kadence|spectra|coblocks>-<post>-<n>.json`.
  Labels come from attributes or the saved `<label>`; recipients (`email[].emailTo`, `afterSubmitToEmail`, `to`) are
  never copied (warning); hidden fields and non-email actions become warnings.
- **Unknown blocks** of these namespaces fall through to the adapter's default: text and inner blocks kept, reported as
  `unmapped` with the library name (gate-blocking when they carry text).
- A top-level block that yields an item collection (FAQ, tabs, testimonials, team, gallery, pricing, stats, form,
  embed, video, map) is a section of its own; a short heading run right before it becomes its title.

## Blocks per library

| Library | Layout | Content blocks mapped | Confidence |
|---|---|---|---|
| Kadence Blocks (`kadence/`) | `rowlayout` (`colLayout`: `equal`, `left-golden`, `right-golden`, `left-half`, `right-half`, `center-half`, `center-wide`, `row` = stacked; `firstColumnWidth` / `secondColumnWidth`; `bgColor`, `bgImg`, `bgImgID`) + `column` | `advancedheading`, `advancedbtn` (+ `singlebtn`; legacy `btns` attribute), `iconlist` + `listitem`, `infobox` (`kt-blocks-info-box-title` / `-text` / `-learnmore`, `link`, `mediaImage`), `tabs` (`titles[].text`) + `tab`, `accordion` + `pane` (`kt-blocks-accordion-title`), `testimonials` + `testimonial` (`content`, `name`, `occupation`, `url`, `id`; legacy `testimonials` attribute), `countup` (`end`, `prefix`, `suffix`, `title` / `kb-count-up-title`), `image`, `advancedgallery` (`ids`, `type`), `videopopup`, `googlemaps` (`location`), `form` (`fields[]`, `submit[].text`, `messages[].success`, `email[].emailTo`, `actions`); decorative `icon`, `single-icon`, `spacer`, `lottie`; `posts` listing; `table-of-contents` dynamic; `advanced-form` reported (form lives in a `kadence_form` post) | medium |
| Spectra / UAG (`uagb/`) | `container` (row when `directionDesktop: "row"` or children have `widthDesktop`; `backgroundColor`, `backgroundImageDesktop`), `columns` + `column` (`colWidth`) | `advanced-heading`, `buttons` + `buttons-child` (`label`, `link`, or the saved `<a>`), `marketing-button`, `icon-list` + `icon-list-child` (`label`), `info-box` (`infoBoxTitle`, `headingDesc`, `ctaText`, `ctaLink`, `iconImage`), `call-to-action` (`ctaTitle`, `description`, `ctaText`, `ctaLink`), `tabs` (`tabHeaders`) + `tabs-child`, `faq` + `faq-child` (`question`, `answer`), `testimonial` (`test_block[]`: `description`, `name`, `company`, `image`), `team` (`title`, `prefix`, `description`, `image`, social links), `counter` (`endNumber`, `numberPrefix`, `numberSuffix`, `heading`), `google-map` (`address`), `image`, `image-gallery` (`mediaGallery`), `forms` + `forms-*` (`formLabel`, `submitButtonText`, `successMessageText`, `afterSubmitToEmail`); decorative `separator`, `icon`, `lottie`; `post-grid` / `post-carousel` / `post-masonry` / `post-timeline` listings; `table-of-contents` dynamic | medium (form child attribute names vary by version: labels fall back to the saved label element) |
| GenerateBlocks (`generateblocks/`) | v1 `grid` + `container` (`sizing.width` or `width`; `backgroundColor`, `bgImage`), v2 `element` (row when `styles.display` is `grid` with ≥2 tracks, or `flex` not in a column), `loop-item` | v1 `headline`, `button-container` + `button`, `image`; v2 `text` (a `tagName: "a"` text is a button), `media`; `shape` decorative; `query-loop` / `query` / `looper` listings; `query-page-numbers`, `query-no-results` dynamic | medium (v2 styles object assumed) |
| Stackable v3 (`stackable/`) | `columns` + `column` (`columnWidth`), `feature-grid`, wrappers `hero`, `call-to-action`, `horizontal-scroller`, `carousel`, `notification`, `icon-label` | `heading`, `text`, `subtitle`, `icon-list`, `button-group` + `button` / `icon-button`, `image` (`imageId`), `count-up`, `video-popup` (`videoLink`), `map` (`address`), composites `card` / `icon-box` / `feature` / `image-box` / `number-box` → feature, `testimonial`, `team-member`, `pricing-box` (+ `price`), `accordion` (first column = question), `tabs` (`tab-labels.tabLabels[].label` + `tab-content` columns); decorative `icon`, `divider`, `spacer`, `separator`; `posts` listing; `table-of-contents` dynamic | medium; Stackable v2 (`ugb/` namespace) not handled |
| CoBlocks (`coblocks/`) | `row` + `column` (`width`), `hero` | `accordion` + `accordion-item` (`title`), `features` + `feature`, `services` + `service` (`imageId`, `imageUrl`), `pricing-table` + `pricing-table-item` (`__title`, `__amount`, `__currency`, `__features`), `alert`, `highlight`, `click-to-tweet`, `buttons`, `map` (`address`), `social-profiles`, `logos`, `gallery-*`, `form` + `field-*` (`label`, `required`, `options`; `to` = recipient; `field-submit-button.submitButtonText`); decorative `shape-divider`, `dynamic-separator`, `icon`; `posts` / `post-carousel` listings | medium |

Default success messages used when a form sets none: Kadence "Submission Success, Thanks for getting in touch!",
Spectra "The form has been submitted successfully!", CoBlocks "Your message was sent." (all *assumed*; the owner can
edit them in the admin).

## Not covered

- Otter (`themeisle-blocks/`) and Stackable v2 (`ugb/`): fall through to the default (text kept, reported).
- Blog posts: Gutenberg posts are converted by EmDash's Portable Text converter (`convertPostBody`), not by the page
  adapter, so library blocks inside posts are not mapped by these handlers.
- Palette colour slugs (`palette3`, `var(--ast-global-color-…)`) and per-device widths/padding are not resolved.
