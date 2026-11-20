# Motion (`@wp2emdash/motion`) — verified facts and open points (2026-11-21)

Checked against the installed **EmDash 1.5.0, @emdash-cms/blocks 1.5.0, @emdash-cms/admin 1.5.0, Astro 7.4.12,
@astrojs/compiler-rs 0.5.3** (library code in a kit site project's `node_modules`, read only; no client content) and
current browser documentation. Nothing was deployed; nothing has been tried in a real browser on a staging site yet.

## EmDash plugin admin (what the plugin relies on)

| Fact | Source | Used for |
|---|---|---|
| `ctx.kv.set(key)` writes the D1 `options` row `plugin:<pluginId>:<key>` (`createKVAccess`, prefix `plugin:${pluginId}:`). | `emdash/dist/context-*.mjs` | Settings in `plugin:motion:settings`, read by the site by primary key (same as consent). |
| A route without `permission` defaults to `plugins:manage`. | `emdash/dist/http-route-dispatch-*.mjs` (`routeMeta.permission ?? "plugins:manage"`) | Admin route; the role is checked again (≥ 50). |
| Block Kit `form` has **one** submit (`submit: { label, action_id }`); a `button` inside a form dispatches a `block_action` **without** the form values. | `@emdash-cms/blocks` `FormBlock` type and `FormBlockComponent` | "Preview only" is a toggle in the form: Save with it on returns a preview link and stores nothing. |
| Form fields take `condition: { field, eq \| neq }`, evaluated live in the browser; the submitted `values` hold only fields with an initial or changed value. | same | Preloader options appear only with the preloader on, duration only with transitions on; `settingsFromForm` keeps unsent fields. |
| Plugin page icons: kebab names resolve to Phosphor exports (`toPhosphorIconName`), a short map first. | `@emdash-cms/admin/dist/index.js` (`PLUGIN_NAV_ICON_MAP`) | Icon `sparkle` → Phosphor `Sparkle`. |
| EmDash's visual-editing toolbar (signed-in editors only) calls `document.startViewTransition` around reloads. | `emdash/src/visual-editing/toolbar.ts` | Harmless with our CSS (same-document transitions of the root); public pages never load the toolbar. EmDash itself adds no `@view-transition`. |

## Page output with everything off — byte-identical

- The layout adds motion only through six expressions: `{...motion.attrs}` on `<html>`, the stylesheet link, the two
  script variants, the View Transitions `<style>`, and the preloader overlay; `motion-calm` now reads `motion.calm`.
- Astro 7's default `compressHTML` is `"jsx"` (`@astrojs/vite-plugin-astro` defaults), passed to the compiler as
  `compact`. With it, whitespace around an expression on its own line is removed, so a falsy expression leaves no bytes.
  The runtime renders `false`/`undefined` children as nothing (`renderChild`), an `undefined` attribute as nothing
  (`addAttribute`) and `spreadAttributes({})` as `""`.
- One-off check: old and new `Base.astro` compiled with `@astrojs/compiler-rs` (`compact: "jsx"`); after removing those
  six expressions the generated templates are **identical** character for character, and `motion.calm` equals the old
  `site.motion === "calm"` whenever nothing is saved (unit test). Unit tests also pin that `pageMotion` returns no
  attributes, no files, no rule and no overlay for undefined or default settings.
- Not byte-relevant but worth knowing: `scripts/site.ts` gained two checks (entrance off, parallax off), so the bundled
  `/_astro/*.js` file name changes on the next build, as with any starter script change.

## Caching and CSP

- Settings render into the cached HTML; every page carries `wp2emdash:analytics` / `emdash:settings`, so `purgePages`
  on save reaches every page (performance-findings: settings purge seen after ~3 s). Toast: "within a few seconds (on
  their next page)"; a failed purge says "within the hour, or after the next deploy".
- The settings row is read in `loadChrome()` (page frontmatter, in parallel with the other chrome reads) only when
  `site.config.json motionPanel` is true: one extra primary-key query per uncached render; cached hits run nothing.
- Preview (`?motion-preview=<code>`): the code is strictly parsed (enums and fixed number sets; anything else is
  ignored), honoured only for signed-in editors (`isEditor`: session cookie — their pages are never cached), and the
  middleware calls `cache.set(false)` for any URL with the parameter. The cache key includes the query string anyway.
- Public CSP: `script-src` has no `'unsafe-inline'` (only the announcement hash): the motion script is a file
  (`<script src>`), `INLINE_SCRIPTS` is unchanged. `style-src` has `'unsafe-inline'` (sections use style attributes),
  so the 81-byte `<style>` with the View Transitions opt-in is allowed. It is written into the page because the opt-in
  must be conditional (the shared stylesheet also serves hover lift etc.) and the brief allows one stylesheet only.

## View Transitions (cross-document)

- `@view-transition { navigation: auto; }` must be in **both** documents; same origin only, no cross-origin redirects;
  navigation types `push`, `replace` (user-initiated) and `traverse` — not reload (MDN `@view-transition`).
- Support: Chrome/Edge 126+, Safari 18.2+; Firefox no (Chrome for Developers, "Cross-document view transitions").
  Other browsers navigate as before — progressive enhancement, no router, no script.
- Chrome skips the transition when the navigation takes more than ~4 s (`TimeoutError`). The pseudo-elements are styled
  by the **new** page's CSS; the custom property `--motion-vt` on `:root` is inherited by `::view-transition-*(root)`.
- The opt-in sits inside `@media (prefers-reduced-motion: no-preference)` (a conditional group rule); the stylesheet
  also sets `animation: none` on all view-transition pseudo-elements under `reduce`, and the starter's global reduced-
  motion rule shortens every animation. Nesting `@view-transition` in `@media` is the documented web.dev pattern but was
  **not** checked in a browser here.

## Preloader

- Decided before the first paint by `site-motion.js` loaded **without** `defer` in `<head>` (only when the preloader is
  on; otherwise the same file loads with `defer`, or not at all). It adds `html.motion-preloading` only when: not seen
  this browser session (`sessionStorage` `motion:preloaded`; storage blocked → no preloader), no reduced motion, not
  `navigator.webdriver`, not a bot/Lighthouse/headless user agent, not `document.prerendering`, not a hidden tab.
  Preview ignores the session flag and does not set it.
- Cap: CSS `animation: motion-pre-out 0.25s ease-out 0.95s forwards` (gone by 1.2 s from when the class is set, even if
  the script stalls) and a script timer at 1.2 s from navigation start; it hides earlier at `load` but not before the
  chosen minimum (0–800 ms). Unit-tested with a fake clock.
- No layout shift: the overlay is `position: fixed` with `pointer-events: none`, `aria-hidden`, and has the `hidden`
  attribute so it stays invisible if the stylesheet fails; the logo `<img>` has width/height.
- The verify phase's Playwright browser reports `navigator.webdriver`, so captures and visual diffs never include it.

## Other options

- Entrances: "as built" = kit.config `motion` (`calm` → `html.motion-calm`, else the standard reveal). "Off" sets
  `data-motion-entrance="off"` and `site.ts` skips the reveal (no `js-reveal`, nothing hidden).
- Parallax/drift: "as built" by default (existing sites keep it); off sets `data-motion-parallax="off"` and `site.ts`
  leaves `[data-parallax]`/`[data-drift]` still — the same state as under reduced motion.
- Hover lift uses `translate` (composes with the entrance `transform`) and `:not(#\#)` to outrank the calm entrance
  rules' transitions; mouse only (`hover: hover`).
- Progress bar: `animation-timeline: scroll(root block)` on `:root::after`; browsers without scroll-driven animations
  (Firefox stable, older Safari) show no bar — no script fallback, by design (speed).
- Image fade-in: only `main img[loading=lazy]` not yet complete when the script runs; the LCP image (eager) is never
  touched.

## Sizes (test-enforced)

`site-motion.css` 4,807 bytes (1,640 gzipped; budget 5 KB / 2 KB), `site-motion.js` 2,571 bytes (1,123 gzipped;
budget 3 KB / 1.5 KB). The panel's speed note uses these numbers; a test fails if a file changes without them.

## Unverified / open

- Not run in a browser yet: View Transitions look and timing, the preloader in Chrome/Safari (first visit, second page,
  back/forward cache), hover lift on calm sites, the progress bar, image fade-in.
- Whether the preloader's logo can become the LCP element on very light pages (LCP ignores occlusion); expected not,
  as page content is usually larger. Check `performance` gate numbers on a staging site with the preloader on.
- The sync script adds one same-origin request before first paint while the preloader is on (in parallel with the
  render-blocking stylesheet); `/scripts/*` are revalidated by browsers (no immutable caching).
