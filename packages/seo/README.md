# @wp2emdash/seo (experimental)

## SEO dashboard (Plugins → SEO, editors and admins)

- **Overview:** average score, pages checked, pages under 80, images without a description, a score bar per page and
  the most common issues with the pages they affect. The same checks as the page panel, so the numbers agree.
- **Pages:** every published page with its score, what to improve, its focus keyword and an **Open** link to the editor.
- **Images:** every picture used on a page that has no description (alt text), with a field per image — **Save
  descriptions** writes them to the media library, so every page using the image gets it (capability
  `media:metadata:write`).
- **Site checks:** robots.txt (crawlable, names the sitemap), the sitemap (every published page listed), the home page
  (indexable, canonical on the production domain, structured data). On staging or workers.dev, blocking search engines
  is expected and shown as a note, not an error.
- **Dashboard widget:** average score, pages under 80, images to describe.

## Google Search Console (dashboard tab "Google")

Connected with a **service account** (no Google sign-in screen, works for any team member): the owner creates a
service account in Google Cloud with the Search Console API enabled, downloads its JSON key, adds the account's email
as a **Full** user of the Search Console property, and pastes the key into the dashboard. EmDash stores it encrypted
(`admin.settingsSchema` secret field, `EMDASH_ENCRYPTION_KEY`); it is never shown again or logged. The Worker signs
a JWT (RS256, WebCrypto) for an access token and shows, for the last 28 days Google has data for: clicks, impressions,
click rate, average position, a daily chart, top searches and top pages; the sitemaps Google knows (**Submit
sitemap**); and **Check index status** for up to 25 pages (URL Inspection API, 2,000/day/property). Data is cached
6 hours (**Refresh** to update). Works before go-live: Search Console reports on the domain, whatever serves it.

## IndexNow (dashboard tab "IndexNow")

Publishing a page tells Bing, Yandex, Seznam, Naver and the other IndexNow engines right away (Google does not use
IndexNow; it reads the sitemap). The key is derived from the production host and its file is written to
`public/<key>.txt`, so it sits at the domain root and covers every URL. Submissions start only when the site is live
on its domain (`production.live` in the kit's cloudflare.json, then re-scaffold and deploy); before that the domain
still serves the old site and the key could not be verified. The tab shows whether the key file is reachable, the last
20 notifications, and **Notify search engines about every page**.

## SEO panel in the page editor

An **SEO panel in the EmDash page editor** (sidebar, under EmDash's own SEO fields), for editors, authors and
contributors who may edit the page:

- **Score** out of 100 and what to improve, in plain words.
- **Google preview:** the address, the title as the layout renders it (page title + separator + site name) and the
  description, with "cut off" warnings at about 60 / 160 characters.
- **Checks:** SEO title length; meta description present and 120–160 characters; no other page with the same title or
  description; exactly one H1; no skipped heading levels; 300+ words; alt text on every image (in the field or the
  media library); links to other pages; a short lowercase address; not hidden from search; canonical pointing to the
  page itself; a sharing image (or generated cards, `@wp2emdash/og`).
- **Focus keyword** per page (what people search for): checked in the title, description, H1, first 100 words and
  address, and how often it appears (about 0.5–3%).
- **Check my unsaved changes:** analyses the editor's current title and sections before saving.

EmDash facts it relies on (1.5): `admin.editorPanels` with `draft.read` and the `admin.editor-draft:read` capability
(the draft comes with button presses, not on panel load); `content:read` for the saved page, its SEO fields and other
pages; `media:read` for alt text; route permission `content:read_drafts` (EmDash also checks the user may edit the
entry). The SEO fields live outside the entry, so unsaved edits to them are checked after saving.

Enabled per site with `seo: { panel: true }` in the kit config; the scaffold copies this package, links it and
registers `seoPlugin({ productionUrl, titleSeparator, collections, ogCards })` in astro.config.
