# SEO rules and the SEO audit scenario

Every site the kit builds follows the same on-page SEO rules, and verify checks them on every migrated page
(`seo-rules`). When an SEO audit of a live site comes back, its findings fall into four groups, each with one place to
handle it. Nothing is fixed by hand in the generated project or in `ir/`: a full rerun reproduces every fix.

## 1. Rules the kit applies to every page (nothing to decide)

| Rule | How | Where |
|---|---|---|
| Exactly one `<h1>` | Later `<h1>`s become `<h2>`; a page whose first heading is lower gets it as its `<h1>`; footer headings start at `<h2>` (a site part never holds the page's h1) | `starter/src/utils/outline.ts`, applied by the middleware (Cloudflare `HTMLRewriter`) to `<main>`, before the page is cached |
| No skipped heading levels | A heading more than one level below its parent moves up, with its siblings and children (h1 → h3 becomes h1 → h2) | same |
| Headings keep their look | A re-levelled heading gets its original level's class (`heading--h3`), which outranks the tag selector | `starter/src/styles/base.css` |
| A heading on every page | A page whose sections have no heading at all (a login or booking widget page) gets a visually hidden `<h1>` with its title | `starter/src/pages/[...slug].astro` (`hasHeading`) |
| Images sized for the screen | The logo ships as 1x and 2x WebP with `srcset`; content images use EmDash's image endpoint with `srcset` | `src/scaffold/perf.ts`, responsive images |
| A map for AI assistants | `/llms.txt` (llmstxt.org): name, tagline, public pages and newest posts with their descriptions; noindex and protected entries left out; route-cached and purged with the pages | `starter/src/pages/llms.txt.ts` |
| Indexable, canonical, sitemap, structured data | Carried from WordPress and checked by verify (`seo-*`, `sitemap`) | load, verify |

The footer has its own outline starting at `<h2>` (a footer `<h4>` after the page content was a skipped level on every page); the header and popups are left alone.

## 2. Text the owner rewrites (a decision in `overrides.ts`)

Titles and meta descriptions are the owner's words. When an audit flags one (too short, too long, missing), write the
new text in the site's `overrides.ts` with the reason, and a line in `decisions.md`:

```ts
seo: {
  "/account/": {
    title: "Member Login – Example Studio Houston",
    description: "Sign in to your account to book sessions, manage your membership and see your visits.",
    reason: "SEO audit 2026-11-20: title 12 characters, description 38",
  },
},
```

Transform writes it onto the page, load writes it to EmDash, and verify accepts it instead of reporting "not identical
to WordPress". On a live site apply it with the next load (or the same text in the admin's SEO panel; the override keeps
it on a rerun). Limits verify uses: titles 20–65 characters, descriptions 70–160 (`src/verify/seo-rules.ts`).

## 3. Content only the owner can write (reported, never invented)

- **Thin pages** (under ~300 words): the kit never adds copy. List the pages for the owner with what each could cover.
- **No links inside the content**: suggest links between related pages (services → booking, FAQ → contact); the owner
  adds them in the editor.

## 4. Zone and account settings (the owner's choice)

- **AI crawlers disallowed by robots.txt**: Cloudflare's managed robots.txt (zone → AI Crawl Control / "Block AI
  training bots"). It blocks AI *training* crawlers only; search and AI answers still reach the site. Leave it unless
  the owner wants their text used for training.
- Other hosts the audit finds (e.g. a `pay.` subdomain) belong to the owner's DNS: report, never change.

## The scenario, step by step

1. Run the audit on the live domain; save the report in `sites/<slug>/reports/seo/` (never committed).
2. Run `pnpm wp2emdash run <slug> verify` (or `--preview`): `seo-rules` lists what the kit's rules still catch.
3. Group the findings as above. Group 1 needs nothing (or a kit fix with a test, if a rule is missing). Group 2 goes in
   `overrides.ts seo`. Groups 3 and 4 go to the owner as a short list.
4. Rerun transform → scaffold, deploy (owner approval for production), rerun verify, and run the audit again.
