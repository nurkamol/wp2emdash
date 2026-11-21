# Gutenberg core: file, audio, latest posts, query loop — verified facts (2026-11-21)

Read in the installed **EmDash 1.5.0** source (`spikes/m0-site/node_modules/emdash`, never modified). Block formats from
WordPress core's saved markup (block.json attributes of `core/file`, `core/audio`, `core/latest-posts`, `core/query`,
`core/post-template`); fixtures are hand-written in that format, no client data.

## EmDash behaviour the kit relies on

| What | Where | Used by |
|---|---|---|
| `<Media>` draws `<audio controls preload="metadata">` for a local item whose `mimeType` starts with `audio/` (`<video>` for `video/`, `<img>` otherwise) and spreads the remaining props (`autoplay`, `loop`) onto the element | `src/components/EmDashMedia.astro` | starter `sections/Audio.astro` |
| A stored media value `{ provider: "local", id }` is completed from the media item (mimeType, filename, storageKey) when read | `src/media/normalize.ts` (`needsFileInfo` → provider `get`) | load writes only the id, as for video |
| The global upload allowlist takes `audio/*` (no file field needed) | `src/api/handlers/media-allowlist.ts` | load uploads `.mp3/.m4a/.wav/.ogg/.oga/.opus/.aac/.flac` (`DOC_MIME`) |
| `getEmDashCollection("posts", { where: { category: [slugs] }, orderBy: { published_at: "desc" }, limit })` | `query.ts` (docs/spikes/blog-findings.md) | starter `sections/PostsList.astro` via `listPosts` |
| Pages carry the `posts` cache tag on blog sites, purged on any post publish | starter `utils/cache.ts` (blog-findings) | a page with a posts list refreshes when a post is published |

## Mapping

- `core/file` → a paragraph linking the file name to the **file** (never the attachment page `textLinkHref`, which does
  not exist after the move; reported) + a `Download` button when the block shows one. Both hrefs point at the upload, so
  load's linked-files pass (`uploadLinks`, gate `documents`) uploads it and rewrites them. The PDF preview
  (`displayPreview`) is reported, not rebuilt.
- `core/audio` → section `audio` (`audio` media ref kind `file`: the attachment id when the block has one, else the
  `src`; external sources follow `overrides.media.external` like videos), caption, `autoplay`/`loop`. `preload` and other
  attributes are reported.
- `core/latest-posts` → section `posts_list`: `postsToShow` (≤ 50), `categories` (ids → slugs from
  `raw/exporter/taxonomies.json`), `displayPostContent`/`displayPostDate`/`displayFeaturedImage`/`displayAuthor`
  (WordPress defaults: all off), `postLayout: grid` + `columns`. Order other than newest first, author filter, full post
  text, excerpt length and image size are reported.
- `core/query` with `postType: post` → section `posts_list`: `perPage`, `taxQuery.category`, the parts its
  `core/post-template` contains (featured image, date, author, excerpt), grid `columnCount`. Offset, order, author,
  search, exclude, sticky, parents, formats, tag filters, pagination, no-results text and other post-template blocks are
  reported; blocks around the template (a heading) are kept. Other post types → `unmapped` error.
- A site without published posts drops the list (`dynamic`, info, as builder post grids); a site whose blog is off
  (`kit.config blog: false`, or posts decided as pages/skip) gets an `unmapped` error from transform.
- At the top level each audio player and posts list is a section of its own; the heading that ends the text before it
  becomes its title (so text between two players is never merged away).
