# WebMCP (Lighthouse 13.6 Agentic Browsing → WebMCP group) — findings

Checked 2026-11-22 against Lighthouse 13.6.0 (source of `core/audits/webmcp-*.js`, `core/gather/gatherers/webmcp*.js`,
`inputs.js`), Chrome for Testing 159.0.8154.6 (Playwright's Chromium) and https://developer.chrome.com/docs/ai/webmcp
(+ its Declarative API page and the W3C webmachinelearning/webmcp declarative explainer). See also
`agentic-browsing-findings.md`: the three WebMCP audits have **weight 0** in the Agentic Browsing category, so they
never change its fraction; they show as passed / not applicable.

## What Lighthouse checks

- **Gate for all three:** `WebMCP.isSupported` = the CDP command `WebMCP.enable` exists **and** `navigator.modelContext`
  or `document.modelContext` is defined in the page. In a stock Chrome (no flag, no origin trial token) neither is
  there, so all three are **not applicable whatever the page does**. PageSpeed Insights' Chrome decides this, not us.
- `webmcp-form-coverage` (informative; `Inputs` + `WebMCP` artifacts): for every `<form>` on the page, reads the
  attributes `toolname` and `tooldescription` (`inputs.js`: `formEl.getAttribute('toolname')`). A form with neither is
  listed as "missing annotations" (score stays 1). No forms → not applicable. Every form annotated → shown as a
  binary **pass**. Only attributes count here: an imperatively registered tool does not cover a form.
- `webmcp-registered-tools` (informative): lists the tools from CDP `WebMCP.toolsAdded` — declarative (has a
  `backendNodeId`, the form) and imperative (`registerTool`, with stack trace). Warns above 40 tools.
- `webmcp-schema-validity` (scored): Chrome's own issues from `Audits.issueAdded` (`GenericIssue`):
  errors `FormModelContextMissingToolName`, `FormModelContextMissingToolDescription`,
  `FormModelContextRequiredParameterMissingName`; warnings `FormModelContextParameterMissingTitleAndDescription`,
  `FormModelContextParameterMissingName`. Any error → 0, only warnings → 0.5, none → 1. No tools and no issues → N/A.

## The declarative attributes (no JavaScript)

- `<form toolname="…" tooldescription="…">` registers the form as a tool; removing either unregisters it.
- `toolparamdescription` on a control → that property's `description`. Fallbacks (verified): the associated
  `<label>`'s text (including an `aria-hidden` " *" — so we set the attribute explicitly), then `aria-description`.
  `title`, `aria-label` and a fieldset's attributes are not used.
- `toolautosubmit` (boolean): the agent submits the form itself. Without it the browser fills the form, focuses
  Submit and the user submits. `SubmitEvent.agentInvoked` / `respondWith(promise)` exist for JS handlers (not used).
- `:tool-form-active` / `:tool-submit-active` pseudo-classes style the form while an agent holds it.
- Imperative API (Chrome 159, `document.modelContext`): `registerTool`, `getTools`, `executeTool(tool, object)`,
  `when`, events `toolchange` / `toolactivated` / `toolcancel`. Not needed: declarative covers our forms.

## What Chrome 159 builds from a form (verified with CDP `WebMCP.toolsAdded`)

- Property name = control `name`. `required` → `required[]`. `type=number` → number (`multipleOf: 1`), `date` →
  `format: date`, `datetime-local` → a regex put in `format`, checkbox → boolean, `<select>` → `enum` + `anyOf`
  (`const` = value, `title` = text; the empty "Choose…" placeholder is included, also when `disabled`/`hidden`).
- Radio group → string `enum`; checkbox group (same name) → array of `enum`, `uniqueItems`.
- **Radio and checkbox groups get no description from anything** (`toolparamdescription` on every/first/last option,
  `aria-description`, `aria-label`, `title`, fieldset/radiogroup attributes): Chrome raises the
  `ParameterMissingTitleAndDescription` warning → `webmcp-schema-validity` scores **0.5** for such a form. A group
  with a single option takes that option's label. The kit still writes `toolparamdescription` on each option (per the
  docs, for when Chrome reads it) and names the groups in the tool description.
- Left out: `type=hidden` (so Turnstile's `cf-turnstile-response`), `type=file` (feature WebMCPDeclarativeFileInput
  off), `disabled`, `readonly`. **Included:** `hidden`/`inert`/`display:none`/`aria-hidden` text inputs — i.e. the
  kit's honeypots (`_hp`, comments' `website_url`). An agent filling those gets the message dropped as spam, so they
  carry `toolparamdescription="Anti-spam check: always leave this empty."`. Making them `readonly` would hide them
  but lets keyboard-driven bots skip them too, so the honeypot is unchanged.
- Executing the tool (`executeTool`) filled the fields, left the honeypot empty, matched `:tool-form-active` and sent
  **no request**: the promise waits for the visitor to submit.

## Browser support / flags

- Chrome origin trial from **Chrome 149** (docs); local testing: `chrome://flags/#enable-webmcp-testing`. On the
  command line `--enable-features=WebMCP` (or `--enable-blink-features=WebMCP`,
  `--enable-experimental-web-platform-features`) exposes `document.modelContext` on secure origins (http://localhost
  counts; `data:` URLs do not). `navigator.modelContext` stayed undefined in 159.
- Permissions policy `tools` (default `self`): cross-origin iframes need `allow="tools"`.
- Other browsers ignore the attributes (unknown attributes on `<form>`/`<input>`; no CSP impact, no script).

## Kit decisions

- Declarative only; no JavaScript, nothing inline (CSP unchanged). `@wp2emdash/forms/webmcp` builds the attributes
  from the form definition: `toolname` = form id lowercased to `[a-z0-9_]` (stable across reruns; `form_` prefix when
  it starts with a digit), `tooldescription` = title + submit label + choice-field names + "files only by the visitor",
  `toolparamdescription` = the field label (trailing `*`/`:` removed) + when a conditional field applies.
- No `toolautosubmit` on site forms and comments: the visitor reviews and presses Submit, so Turnstile, the honeypot,
  rate limits and consent run exactly as for a person. An agent cannot pass Turnstile for the visitor; with the
  visitor submitting, it does not need to. Site search has `toolautosubmit` (GET, no side effects).
- Sensitive: forms with `sensitive: true` (every form of a `sensitiveData` site) and the comment form on a sensitive
  site (`FORM_SENSITIVE="1"`) get no annotations — an agent would copy health/legal/financial details from its own
  context into the form, which those sites should not invite. They show in `webmcp-form-coverage` as unannotated
  (informative, score unchanged). Search stays (public content only).
- Switch: kit.config `forms.webmcp` (default `true`); `false` → Worker var `FORM_WEBMCP="0"` → no attributes anywhere.

## Verified result (local fixture rendered with the kit's helpers, Lighthouse 13.6.0 CLI, Chrome for Testing 159)

`--chrome-flags="--headless=new --enable-features=WebMCP"`, `--only-audits=webmcp-*`:

| Page | form-coverage | registered-tools | schema-validity |
|---|---|---|---|
| contact form (text, email, tel, select, datetime, textarea, consent) + search | pass (binary 1) | 2 declarative tools | **1** |
| same + one radio group | pass (binary 1) | 2 declarative tools | 0.5 (radio description warning, Chrome limitation) |
| no flag | N/A | N/A | N/A |
