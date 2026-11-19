# @wp2emdash/seo (experimental)

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
