# @wp2emdash/motion (experimental) — Motion

A PixelKraft plugin for EmDash sites on Cloudflare Workers. The panel is on by default in every site the wp2emdash
kit builds (`motionPanel: false` in `kit.config.ts` removes it); **every motion option in it starts off**. Admins only.

## What it does

**Plugins → Motion** lets the site owner switch on and tune motion on the public site:

| Option | Default | How |
|---|---|---|
| First-visit preloader (logo) | off | The site's logo on a token colour (page background, surface, text, accent) while the first page of a browser session loads; minimum 0–800 ms; hard cap 1.2 s (CSS and script); never for bots, prerender, hidden tabs or reduced motion; fixed overlay, no layout shift, never takes clicks. |
| Page transitions | off | Fade or fade-and-slide-up, 150 / 250 / 400 / 600 ms, with cross-document View Transitions (`@view-transition { navigation: auto }` + `::view-transition-old/new(root)`). No router, no script; Chrome/Edge 126+, Safari 18.2+. |
| Element entrance animations | as the site was built | Off / calm / standard: the starter's reveal (`[data-reveal]`, `html.motion-calm`). "As built" follows kit.config `motion`. |
| Hover lift | off | Cards and buttons rise slightly (mouse only). |
| Smooth scrolling | off | `scroll-behavior: smooth` for anchor links. |
| Image fade-in | off | Lazy images still loading fade in. |
| Parallax and drifting columns | as built | The old site's `[data-parallax]` / `[data-drift]`; switch off to keep them still. |
| Scroll progress bar | off | A thin bar along the top (scroll-driven animation, no script). |

`prefers-reduced-motion` is always respected (no switch). The page shows how many KB the switched-on options add,
**Preview only** returns a link (`/?motion-preview=…`) that shows the unsaved settings to signed-in editors (never
cached), and **Turn all motion off** resets. Saving purges the cached pages.

## Register

```js
// astro.config.mjs (the kit's scaffold writes this)
import { motionPlugin } from "@wp2emdash/motion";
emdash({ plugins: [motionPlugin({ productionUrl: "https://example.com", siteName: "Example", siteEntrance: "standard" })] });
```

The site side lives in the kit's starter: `src/utils/motion.ts` (reads the settings row with the chrome,
`src/utils/chrome.ts`), `src/layouts/Base.astro` (attributes, files, overlay), `public/styles/site-motion.css`,
`public/scripts/site-motion.js`, `src/scripts/site.ts` (entrance and parallax off) and `src/middleware.ts` (preview
never cached). With everything off the page is byte-identical to a site without the panel.

## Storage

Plugin KV `settings` (D1 `options` row `plugin:motion:settings`), read by the site by primary key on a route-cache
miss. Facts, sources and what is verified: `docs/spikes/motion-findings.md`.
