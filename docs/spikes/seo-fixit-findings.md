# SEO fix-it — findings

**Date:** 2026-11-22 · **EmDash:** 1.5.0 (read from `spikes/m0-site/node_modules/emdash/dist`) · **@wp2emdash/seo:** 0.6.0

AI drafts of missing meta descriptions, focus keywords and (optionally) SEO titles, reviewed and approved by an editor
on the SEO plugin's new admin page `/seo-fixit`. Nothing below was run on a deployed Worker (see "Not verified").

## How plugins write SEO fields (EmDash 1.5)

- `ContentAccess.update(collection, id, data)` exists only with the **`content:write`** capability
  (`createContentAccessWithWrite`, `context-*.mjs`). `data.seo` is a reserved key (`ContentWriteInput`):
  `splitSeoFromInput` separates it, and `SeoRepository.upsert` writes the `_emdash_seo` row in the same transaction.
  Only the SEO keys present are overwritten (`ContentItemSeoInput`: all optional). Passing `seo` for a collection
  without SEO enabled throws.
- **An SEO-only update creates no revision and no draft.** With no field keys, `update` does not call
  `updateDraftAware` (which is what stages drafts in revisions); it only re-reads the item and upserts `_emdash_seo`.
  The REST handler (`handleContentUpdate`) does the same for the editor's SEO panel: `_emdash_seo` is not versioned.
  → **On a published page an approved description or title is live at once.** The review copy says so, and the
  "Approve all shown" confirm dialog repeats it. The page content is never touched.
- The focus keyword is not an EmDash field: it is the SEO panel's plugin KV key `kw:<collection>:<id>`; approval writes
  the same key.
- `content.get` / `content.list` return the content row: for a collection with revisions that is the **published**
  data; unsaved or draft changes live in `revisions` (`updateDraftAware`), so the text sent to the model is what
  visitors see. Fix-it only drafts entries with `status === "published"` and not `seo.noIndex`. Drafts, scheduled and
  trashed entries are never sent (tested with a draft entry whose text must not reach the fake model).
- Approval re-reads the entry and refuses when it is no longer published, or when the description, SEO title or
  keyword changed since the draft (no silent overwrite).
- Roles: the `admin` route keeps `permission: "content:edit_any"` (editors 40 and admins 50 — who can edit any page's
  SEO fields today); the fix-it handler checks `role >= 40` again.
- Cache: one `purgePages` (tags `wp2emdash:analytics`, `emdash:settings`, carried by every page) per approval action
  that wrote a description or title; keyword-only approvals change nothing visitors see and purge nothing.
- Block Kit 1.5 (`@emdash-cms/blocks`): a `form` has one submit; `form_submit` carries `block_id`. Each suggestion is
  its own form (`block_id: fx:<collection>:<id>`, submit "Approve") plus a Discard button (`value` = id). "Approve all
  shown" is a button: it approves the drafted values (edits typed into boxes are not sent with a button press).

## Workers AI model (checked 2026-11-22)

developers.cloudflare.com/workers-ai/models lists 41 text generation models; none is marked recommended.
JSON mode (`response_format: { type: "json_schema", json_schema }`) is documented for `@cf/meta/llama-3.3-70b-instruct-fp8-fast`,
`llama-3-8b-instruct`, `llama-3.1-8b-instruct`, `hermes-2-pro-mistral-7b`, `deepseek-coder-6.7b`, `deepseek-r1-distill-qwen-32b`.

| Model | Input / output per M tokens (neurons) | Notes |
|---|---|---|
| **`@cf/meta/llama-3.3-70b-instruct-fp8-fast`** (chosen) | 26,668 / 204,805 | JSON mode listed, multilingual, no reasoning tokens, `{ response }` output |
| `@cf/google/gemma-4-26b-a4b-it` | 9,091 / 27,273 | cheaper, but reasoning model with OpenAI-style output; JSON schema support not documented |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | 24,545 / 77,273 | JSON mode not listed |
| `@cf/mistralai/mistral-small-3.1-24b-instruct` | 31,876 / 50,488 | JSON mode not listed |
| `@cf/meta/llama-3.1-8b-instruct-fp8` | 13,778 / 26,128 | weaker in non-English text |

- Cost per page: ≈ 900 input tokens (rules + ≤ 3,000 characters of text) + ≈ 120 output ≈ **55 neurons**.
  Free allocation: 10,000 neurons/day (reset 00:00 UTC). Default cap **100 drafts per UTC day** (≈ 5,500 neurons),
  leaving room for the Media Assistant's alt text; option `fixit.dailyLimit`. Batches of 10 per admin action, 3 calls
  at a time. The Media Assistant has no AI queue for cron (per-action batches only), so fix-it has none either.
- The model can be changed (`fixit.model`); the parser also reads a JSON string, fenced JSON and OpenAI-style
  `choices`. When JSON mode fails ("JSON Mode couldn't be met") the call is retried once without it.
- A licence refusal (Meta models may require `{ prompt: "agree" }` once per account, as Llama 3.2 Vision does for
  alt text) is remembered and shown; the plugin never accepts a licence itself. Whether 3.3 needs it: not verified.

## Validation

Every answer is cleaned before an editor sees it (`fixit.ts`, unit-tested): plain one line (no quotes around it, emoji,
markdown, label prefixes); phone numbers (≥ 7 digits), prices, emails and links whose digits / text are not in the page
are removed; "award-winning", "top-rated", "#1"… removed when the page does not say them, "best", "guaranteed",
"certified"… flagged in a note. Description 120–160 characters (longer: cut at a sentence ≥ 120, else a word;
70–119 kept with a note; shorter dropped). Keyword 2–4 words that occur as whole words in the page text (else
shortened to a sub-phrase that does, else dropped). Title ≤ 60 (cut at a separator, else dropped). Language: the site's
`lang` option (scaffold passes `siteConfig.lang`), else the entry locale, else "the language of the page text".

## Storage (plugin KV)

`fixit:pending` ≤ 200 suggestions, each dropped after 30 days, when the page is gone or unpublished, or when its fields
were filled in another way; page title, slug, current and suggested SEO values, notes — **never the page text**.
`fixit:discarded` ≤ 200 ids for 30 days (not re-drafted). `fixit:usage` `{ day, drafts }`. `fixit:ai` licence state.
`fixit:prefs` the "also titles" switch.

## Binding

`"ai": { "binding": "AI" }` (not inherited by named environments). Scaffold now adds it when the SEO panel is on and the
site is not `sensitiveData` (or, as before, when Media AI alt text is on). Fix-it sends only published public text, but
on sensitive sites no AI binding is added by default: the page explains how to add it. Without the binding the page
still lists pages and lets editors approve or discard existing suggestions.

## Not verified

- On a deployed Worker or local dev: a second admin page of one plugin (`/seo-fixit`) and its `page_load` (the Block
  Kit types say `page` carries the page path), real Workers AI answers and their quality per language, actual neuron
  use, whether Llama 3.3 needs a licence acceptance, `content.update` with `content:write` for a native plugin, the purge.

## First live run (2026-11-22, a live client site)

- `content.list`, Workers AI (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`, no licence prompt) and the KV writes worked on a deployed Worker: one batch drafted 6 suggestions (6 of 100 daily drafts); 5 pages under 40 words were skipped as designed. Nothing approved.
- Quality: focus keywords were sensible for content pages (short service and location phrases), but legal pages got "privacy policy" / "terms and conditions". Since then no focus keyword is drafted for slugs starting with privacy/terms/cookie(s)/disclaimer/waiver/imprint/impressum/legal/gdpr/accessibility-statement (`LEGAL_SLUG`); a description still is.
- Sites with `sensitiveData: true` have no AI binding (by design); the page explains how to add it.
