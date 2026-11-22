# Verify against a real WordPress (2026-11-22, WordPress end-to-end test)

The nightly **E2E WordPress** workflow (docs/e2e.md) migrates a synthetic pottery studio — Twenty Twenty-One 2.9,
Elementor 4.4.1, WooCommerce 11.3.1 (catalogue mode), Polylang 3.9.2 (English unprefixed, French under `/fr/`),
Contact Form 7, Fluent Forms — and runs `verify` against the generated project's local dev server
(`http://localhost:4399`, EmDash 1.5.0, Astro 7.4.12). Run 45007819630 passed init → load and every assertion;
`verify` failed 13 checks. Each one, what it was and what changed:

| Check | Cause | Kit bug or verify bug | Change |
|---|---|---|---|
| `hreflang` | Polylang prints no `x-default`; the starter adds one on the default-language version (Google's recommendation, and the e2e assertion `html-hreflang` requires it). Parity reported it as "extra". | verify | `hreflangParity` accepts an added `x-default` that points at one of the page's own alternates. |
| `content` | (1) `sourceText` only appended a space after block elements: `<span>Contact us</span><div><label>Your name` read "usyour", `<strong>Robin Example</strong><span>Member…` read "examplemember". (2) Twenty Twenty-One's post meta ("Published … By … Categorized as … Tagged") and post navigation counted as content. (3) WooCommerce's listing buttons ("Add to cart", "Select options"). (4) `/shop/` heading "Products" and "From $30.00" for the WooCommerce range "$30.00 – $45.00". | verify (1–3), kit (4) | Block elements get a space on both sides; `.posted-on`, `.byline`, `.cat-links`, `.tags-links`, `.comments-link`, `.edit-link`, `nav.post-navigation` and `a.add_to_cart_button` joined `CHROME`. The listing heading comes from the page at the archive's address; variable products show their range. A space between a testimonial's name and role. |
| `headings` | Theme chrome headings (the header's site title is an `h1` on the front page; "Leave a comment"; WooCommerce's "Description", "Reviews", "Related products") were compared. And real losses: the theme's page title (`h1.entry-title` "About") was not migrated, so `/about/`'s h1 became "Our kiln"; `/shop/`'s h1 "Shop" became "Products". | verify + kit | Headings are read from the HTML with `CHROME` removed (`contentHeadings`). The theme's page title is kept as the page's first section (src/transform/page-title.ts). |
| `seo-title` | `/shop/` titled "Products – …" (the collection label). | kit | Products listing heading and description from the shop page. |
| `seo-description` | The live pages had no meta description (no SEO plugin); the new site writes the excerpt or the tagline. "Identical" failed on an addition. | verify | A description the live page did not have may be added; one it had must stay word for word. |
| `links-internal` | `/fr/` (404) linked from the logo and the switcher on every French page: Polylang served the French front page at `/fr/accueil/`. | kit | Language home pages (`i18n.languages[].home`), `/fr/` → 301 home. |
| `links-external` | `https://wordpress.org/` — the theme's "Proudly powered by WordPress" credit. | verify | `isWordPressCredit`: the home page of wordpress.org / wordpress.com / woocommerce.com is not expected; deeper links still are. |
| `forms-fields` | The comment form, WooCommerce's add-to-cart / variation / sorting forms and the review form were compared as migrated forms. The audit already classifies them (`NON_CONTENT_FORMS`). | verify | Only `isContentForm` forms are compared. |
| `urls-accounted` | French category / tag / author / date archives (in the sitemap) answered 404 on the new site. | kit | Per-language archives and feeds (docs/spikes/multilingual-findings.md); date archives under a language → its home. |
| `feeds` | Verify expected `/feed/` to hold every language's posts; WordPress (Polylang) and the starter list the default language's there. The French archives' feeds answered 410. | verify + kit | Feeds expected per language (`/fr/feed/`, `/fr/category/…/feed/`); the starter serves them. |
| `no-sideways-scroll` | `/enquiry/` +39px on phones: the heading "Private commissions" at display size — `.form-layout` was `display: grid` with an implicit `auto` column that grew to the word. Product pages +3/+24px: the options table did the same in `.product-details .container`. | kit | `grid-template-columns: minmax(0, 1fr)` on both, headings `overflow-wrap: break-word`. The gate now names the element that sticks out. |
| `a11y` | `color-contrast` on every page: the footer search button, white on the accent `#61ce70` (Elementor's default accent; 1.98:1). The content buttons were already raised to AA (`readableOn`); `--color-accent-contrast` was not. | kit | `--color-accent-contrast` goes through `readableOn` too. The gate now names the element, colours and ratio. |
| `visual` | 89 section × viewport pairs over 3%. Not an artifact of localhost: the section library does not reproduce Twenty Twenty-One's page layout or Elementor's default kit (Roboto, the default global colours — headings in "Primary" `#6EC1E4` —, gallery columns and gaps, the 1140px container). | kit (design fidelity) | **Not fixed here.** Dated known failure `verify:visual` in e2e/expectations.json. |

Checks that already passed and still do: `urls`, `languages-urls`, `seo-rules`, `seo-canonical`, `seo-robots`,
`seo-jsonld`, `seo-og`, `images-alt`, `forms-submit`, `security-headers` (local: HSTS and CSP are not expected from
`astro dev`), `sitemap`, `analytics`, `legacy-urls`, `posts`, `entries`, `wp-endpoints`, `performance`, `payload`, `menu`.

## Not weakened for client sites

Every verify change makes the comparison look at the same thing on both sides; none raises a threshold or skips a
check. Client sites keep failing for a lost description, a lost external link (other than WordPress's own credit),
a lost content form, a missing hreflang alternate or an `x-default` pointing elsewhere, and lost headings or text
inside the content.

## visual: what a fix needs

What the diff crops (artifact `site/reports/verify/sections/`) show, not yet investigated further:
- Headings: Elementor renders them in Roboto 600 in its default "Primary" colour (light blue); the migrated headings
  are dark, in the system font at a light weight. The seeded site never customised Elementor's kit, so its global
  colours and fonts are Elementor's built-in defaults — likely not read by the kit when the kit post has none.
- Layout: the gallery spans the content width with no gaps on WordPress, three narrower cards with gaps on the new
  site; content width and the hero's image/text order on tablets differ.
- Gutenberg pages and products are compared as whole pages (no section boxes), so Twenty Twenty-One's own layout
  (entry header band, footer widgets) weighs fully there.
