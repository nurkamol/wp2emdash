# @wp2emdash/og (experimental)

Branded sharing images for EmDash sites on Cloudflare Workers. Every page gets a 1200×630 card — logo, page title,
optional line above it and the site's domain, in the site's own colours and fonts — used as `og:image` and the
Twitter image.

- **Rendered in the Worker** with Satori (layout → SVG) and resvg (SVG → PNG), both WebAssembly modules imported at
  build time (`@cf-wasm/satori`, `@cf-wasm/resvg`, MPL-2.0). Measured: layout + raster 35–110 ms per card; +1.1 MB
  to the Worker (gzip).
- **Rendered once:** stored in R2 (`og-cards/<signature>.png`, the site's `MEDIA` bucket) and served with
  `Cache-Control: public, max-age=31536000, immutable`. The link changes whenever the card's settings change.
- **Signed links:** the public card route renders only links the site issued (HMAC, secret in the plugin's KV), so
  nobody can make cards with their own text on a client's domain.
- **Head tags** through EmDash's `page:metadata` hook (plugin tags win over EmDash's): og:image, size, type, alt,
  `twitter:card`, `twitter:image`. Pages with their own sharing image keep it by default (their size, type and alt are
  added); "Every page" replaces them with cards.
- **Admin page** (Plugins → Sharing images, admins only): on/off, which pages, the line above the title, the domain,
  a live preview, "Redraw all cards".

## Wire-up (the kit does this when `og: { cards: true }` is in the site's kit.config)

- `package.json`: `"@wp2emdash/og": "link:./packages/og"`, `"@cf-wasm/satori": "0.4.2"`, `"@cf-wasm/resvg": "0.4.0"`.
- `public/fonts/og-display.ttf`, `og-body.ttf` (Satori reads TTF/OTF/WOFF, not WOFF2).
- `astro.config.mjs`: `emdash({ …, plugins: [ogPlugin({ siteName, domain, logo, colors, fonts, displayWeight })] })`.
- `src/site.config.json`: `"ogCards": true` (the layout then leaves every og:image tag to the plugin).

Not yet: a photo background variant (Satori needs PNG/JPEG; media is WebP), per-page title overrides, other layouts.
