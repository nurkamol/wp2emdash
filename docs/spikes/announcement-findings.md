# Announcement bar — markup the detection relies on

Verified 2026-11-19. Client text is never copied here; fixtures in `test/fixtures/announcement/` are synthetic.

## Announcer (WordPress plugin, `announcer/public`, assets `?ver=6.2`) — verified on a real Bricks site's saved HTML

- Bars are **not** in the REST API (custom post type not exposed) and are printed by the plugin **at the end of `<body>`** (`wp_footer`), after the theme's footer; the plugin's script (`announcer/public/js/script.js`) moves them to the top. So detection is by class, never by position in the document.
- Structure:
  ```html
  <div class="ancr-group ancr-pos-top ancr-sticky">
    <div id="ancr-<postId>" class="ancr ancr-wrap ancr-lo-same_row ancr-align-center ancr-has-close-btn" data-props="{…json…}">
      <a href="#" class="ancr-close-btn ancr-close" title="Close"><svg aria-hidden="true">…</svg></a>
      <div class="ancr-container">
        <div class="ancr-content"><div class="ancr-inner"><p>…message with <strong>/<a>…</p></div></div>
        <div class="ancr-btn-wrap"><a href="…" target="_self" class="ancr-btn ancr-btn-primary">…</a></div>
      </div>
    </div>
    <style> #ancr-<id>{ background:#…;color:#… !important; } #ancr-<id> .ancr-btn-primary{ background:#…;color:#… !important; } #ancr-<id> .ancr-btn-secondary{…} #ancr-<id> .ancr-content a{color:…} </style>
  </div>
  ```
- `data-props` (HTML-escaped JSON) keys seen: `status`, `display` (`schedule` → `schedule_from`/`schedule_to` as Unix seconds), `show_on` (`page_open`), `show_after_duration`, `show_after_scroll`, `open_animation`, `position` (`top`), `sticky` (`yes`), `layout` (`same_row`; `ticker` exists), `container_width`, `ticker_speed`, `close_btn` (`yes`), `close_animation`, `close_content_click`, `auto_close`, `keep_closed` (`no` = shows again on the next page), `closed_duration`, `devices` (`all`), `id`.
- The bar was in the saved HTML of every page (12/12) although its `schedule_to` was in the past at capture time: the server prints it regardless; whether visitors see it is decided after load. The kit keeps the schedule and the starter applies it in the browser; the transform report warns when the window has ended.
- Colours come from the per-bar `<style>` block (ids are stable: `#ancr-<postId>`), not from `style=""` attributes.

## WPFront Notification Bar — from the plugin's documented output (not yet seen on a client site)

`#wpfront-notification-bar-spacer.wpfront-fixed-position` › `#wpfront-notification-bar.wpfront-notification-bar.wpfront-fixed.top|bottom` › `.wpfront-close` + `table` › `.wpfront-message` and `a.wpfront-button`. Colours in an inline `<style>`: `#wpfront-notification-bar { background: <solid>; background: linear-gradient(…) }`, `#wpfront-notification-bar div.wpfront-message { color }`, `#wpfront-notification-bar a.wpfront-button { background; color }`. The first solid colour of a gradient is used. Buttons that run `onclick` scripts are reported, not rebuilt.

## Theme top bars — from the themes' markup (not yet seen on a client site)

- **Salient**: `#header-outer #header-secondary-outer` holds the secondary menu (migrated as the `secondary` menu) and the optional header text `.nectar-center-text`; only that text becomes the bar. `#header-outer` is header chrome for text conservation, so the source side does not count it.
- **Astra** (header builder): `.ast-above-header-wrap › .ast-above-header-bar` with an HTML element `.ast-header-html-N .ast-builder-html-element`; menus and social icons in that row are ignored.

## Generic rule (reported, never rebuilt automatically)

`[class|id *= announcement | topbar | top-bar | notice-bar | promo-bar | notification-bar | sticky-bar]` that appears before `<main>` (or the first `h1`), is not inside `main/article/footer/nav/form/dialog`, is the outermost match, and has 3–300 characters of text once menus, buttons and close controls are removed. It goes to the coverage report with its text; `overrides.announcement: "keep"` rebuilds it, `"drop"` confirms leaving it out.

## Script-only bars

Hello Bar (`my.hellobar.com`) and OptinMonster floating bars (`a.omappapi.com`) inject their markup after load, so the saved HTML has no text. They are named in the coverage report; the owner re-enters the message in the admin if it should stay.

## EmDash side

- Stored as the site part `announcement` (collection `site_parts`, created/updated by `load` like the footer, id-map key `announcement:<postId>`), one block `section_announcement` (fields in `src/starter/library.ts`). `load` syncs the block type like every other block type (`createBlockType`/`updateBlockType`).
- **Open:** whether EmDash enforces a `blocks` field's `allowedTypes` on write is not documented (the guide only describes the editor's block picker). A target set up before this change has `site_parts.content.allowedTypes` without `section_announcement`; if `load` reports a validation error for `site_parts/announcement`, add the type to that field in the admin (or re-run setup on a fresh local target). To be checked on the next local load.
