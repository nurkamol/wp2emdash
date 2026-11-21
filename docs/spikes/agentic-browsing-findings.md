# Lighthouse "Agentic Browsing" (Lighthouse 13.6, PageSpeed Insights) — findings

Checked 2026-11-21 against Lighthouse 13.6.0 (source of `core/audits/agentic/*`, `third-party/ard`).

The category has seven audits; the WebMCP ones have weight 0, so the fraction shown (e.g. 3/4) counts four:
`agent-accessibility-tree`, `cumulative-layout-shift`, `llms-txt` and `ard-schema`.

- `ard-schema` (Agentic Resource Discovery, https://agenticresourcediscovery.org/spec/ v0.91) looks for an advertised
  manifest (robots.txt `Agentmap:`, `<link rel="ard">`, `Link: rel=ard`), then `/.well-known/ard.json`, then the legacy
  `ai-catalog` names. Only advertised locations count against the site: with none, a 4xx on the well-known path makes
  the audit "not applicable".
- The fetch has a **2 s timeout** (`fetcher.fetchResource`). A kit site's 404 for `/.well-known/ard.json` renders the
  full not-found page through the Worker (BYPASS, ~1.1–1.2 s from Central Asia, slower on a cold isolate); a timeout
  gives status `null`, which the audit scores 0 ("could not be loaded"). That was the failing audit on a live site.
- Fix in the kit: scaffold writes a static `public/.well-known/ard.json` (starter/src/utils/ard.ts), served by the
  asset layer before the Worker. Required per entry: `identifier` matching
  `urn:air:<publisher>[:<namespace>]:<name>`, `displayName`, `type`, exactly one of `url`/`data`; 2–5
  `representativeQueries` (otherwise a warning). Errors score 0, warnings 0.9 (still shown as passed), clean 1.
- Media types: only the ARD discovery types are clean; any other `application/*` type is an info note (no effect);
  `text/markdown` without `profile="urn:air:agent-skills"` is a warning. llms.txt is listed as `text/markdown`
  anyway (it is not an agent-skills file), so the audit scores 0.9 and passes.
