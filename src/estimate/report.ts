/**
 * Estimate reports: report.html (client-facing, printable, agency-branded), report.md (the same in Markdown) and
 * internal.md (effort breakdown with its basis, adapter status, plugin matrix, crawl facts, risks). Pure: an
 * Estimate in, strings out.
 */
import type { Integration } from "../audit/integrations.js";
import type { Estimate, Finding, FindingLevel } from "./types.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const range = (r: [number, number]) => (r[0] === r[1] ? `${r[0]}` : `${r[0]}–${r[1]}`);
const num = (n: number) => n.toLocaleString("en-US");
const money = (r: [number, number], currency?: string) => `${num(r[0])}–${num(r[1])}${currency ? ` ${currency}` : ""}`;
const day = (iso: string) => iso.slice(0, 10);

const LEVEL_LABEL: Record<FindingLevel, string> = { blocker: "Not included", decision: "Owner decision", complexity: "Extra care", info: "Good to know" };
const ACTION: Record<Integration["proposed"], string> = { keep: "Kept as is", rebuild: "Rebuilt on the new site", replace: "Replaced", drop: "Not needed after the move", decide: "To decide together" };
const VERDICT = { similar: "On par", slower: "Room to improve", unknown: "—" } as const;

/** Headline facts for both client reports. */
function facts(e: Estimate): { label: string; value: string }[] {
	const d = e.detections;
	const pages = d.types.find((t) => t.slug === "page")?.count;
	const posts = d.types.find((t) => t.slug === "post")?.count;
	const forms = d.integrations.filter((i) => i.kind === "form").length;
	const others = d.integrations.filter((i) => i.kind !== "form" && i.kind !== "font").length;
	return [
		{ label: "Platform", value: d.isWordPress ? `WordPress${d.wordpressVersion ? ` ${d.wordpressVersion}` : ""}` : "Not identified as WordPress" },
		{ label: "Built with", value: e.adapters.map((a) => a.label).join(", ") || "—" },
		{ label: "Pages", value: pages !== undefined ? num(pages) : `about ${num(d.urlGuess.pages)} (from the sitemap)` },
		{ label: "Blog posts", value: posts !== undefined ? num(posts) : d.urlGuess.posts ? `about ${num(d.urlGuess.posts)}` : "none found" },
		{ label: "Forms", value: String(forms) },
		{ label: "Other integrations", value: String(others) },
	];
}

/** Internal pointers (PLAN sections, kit.config keys) stay out of the client's copy. */
const plain = (s: string) => s.replace(/\s*\((?:docs\/)?PLAN[^)]*\)/g, "").replace(/\s*\(kit\.config[^)]*\)/g, "");
const clientFindings = (e: Estimate): Finding[] => e.findings.filter((f) => f.level !== "info" || ["booking", "rest-closed", "large-site"].includes(f.id)).map((f) => ({ ...f, what: plain(f.what), impact: plain(f.impact), handling: plain(f.handling) }));

function integrationRows(e: Estimate): { name: string; kind: string; action: string; note?: string }[] {
	return e.detections.integrations
		.filter((i) => i.kind !== "contact-link")
		.map((i) => ({ name: i.name, kind: i.kind.replace("-", " "), action: ACTION[i.proposed], ...(i.note && i.kind !== "form" ? { note: i.note.replace(/ — IDs: .*$/, "").replace(/^IDs: .*$/, "") } : {}) }));
}

// ---------------------------------------------------------------------------------------------------------------- MD

export function renderClientMarkdown(e: Estimate): string {
	const d = e.detections;
	const ef = e.effort;
	const out: string[] = [];
	out.push(`# Website migration estimate — ${d.host}`, "");
	out.push(`Prepared by ${e.agency.name} (${e.agency.url}) on ${day(e.generatedAt)}. Based on the public website only.`, "");
	out.push("## Summary", "");
	for (const f of facts(e)) out.push(`- **${f.label}:** ${f.value}`);
	out.push("", `**Project size:** ${ef.size} — estimated effort **${range(ef.total)} hours**${ef.cost ? `, indicative budget **${money(ef.cost, ef.currency)}**` : ""}.`);
	if (ef.excluded.length) out.push("", `Not included in this estimate: ${ef.excluded.join("; ")} (see below).`);
	out.push("", "## Speed today and after the move", "");
	out.push("| Measure | Your site today | Typical EmDash site | |", "|---|---|---|---|");
	for (const c of e.speed.comparisons) out.push(`| ${c.metric} | ${c.prospect} | ${c.emdash} | ${VERDICT[c.verdict]} |`);
	const lab = e.speed.lab;
	if (lab?.mobile || lab?.desktop) out.push("", `Google PageSpeed (home page): ${[lab.mobile ? `mobile ${lab.mobile.perf ?? "?"} / 100${lab.mobile.lcp ? `, LCP ${(lab.mobile.lcp / 1000).toFixed(1)} s` : ""}` : "", lab.desktop ? `desktop ${lab.desktop.perf ?? "?"} / 100` : ""].filter(Boolean).join("; ")}.`);
	const field = e.speed.field;
	if (field && !field.missing) out.push("", `Real Chrome visitors, last 28 days (75th percentile): ${[field.lcp !== undefined ? `LCP ${(field.lcp / 1000).toFixed(1)} s` : "", field.inp !== undefined ? `INP ${field.inp} ms` : "", field.cls !== undefined ? `CLS ${field.cls}` : ""].filter(Boolean).join(", ")}.`);
	out.push("");
	for (const n of e.speed.notes) out.push(`_${n}_`, "");
	const rows = integrationRows(e);
	if (rows.length) {
		out.push("## What happens to each part of the site", "", "| Item | Type | After the move |", "|---|---|---|");
		for (const r of rows) out.push(`| ${r.name} | ${r.kind} | ${r.action}${r.note ? ` — ${r.note}` : ""} |`);
		out.push("");
	}
	const fs = clientFindings(e);
	if (fs.length) {
		out.push("## Points to look at", "");
		for (const f of fs) out.push(`### ${f.title} (${LEVEL_LABEL[f.level]})`, "", `${f.what} ${f.impact}`, "", `**How we handle it:** ${f.handling}`, "");
	}
	out.push("## Effort", "", "| Work | Hours |", "|---|---|");
	for (const l of ef.lines) out.push(`| ${l.label} | ${range(l.hours)} |`);
	out.push(`| Contingency (${Math.round(ef.contingencyRate * 100)} %) | ${range(ef.contingency)} |`, `| **Total** | **${range(ef.total)}** |`, "");
	out.push("## Next steps", "", ...NEXT_STEPS.map((s, i) => `${i + 1}. ${s}`), "");
	out.push("---", "", `${e.agency.name} · ${e.agency.url}${e.agency.contact ? ` · ${e.agency.contact}` : ""}`, "", `_This estimate reads only what the website shows the public. A full audit with access confirms the scope before work starts._`, "");
	return out.join("\n");
}

const NEXT_STEPS = [
	"A short call to confirm goals, the decisions listed above and the launch date.",
	"Full audit with read-only access (an application password and the EmDash Exporter plugin): every page, form and setting is inventoried and the estimate is confirmed.",
	"Migration to a staging address you can review, with automated checks that every page, link, form and redirect matches the current site.",
	"Launch with your approval, then monitoring.",
];

// -------------------------------------------------------------------------------------------------------------- HTML

const CSS = `
:root{--ink:#16181d;--muted:#5b6170;--line:#e3e5ea;--soft:#f5f6f8;--accent:#2f5bea;--ok:#13795b;--warn:#a15c07;--bad:#b42318;color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#fff;color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:860px;margin:0 auto;padding:40px 16px 56px}
header{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;border-bottom:2px solid var(--ink);padding-bottom:16px;margin-bottom:28px;flex-wrap:wrap}
header h1{margin:0;font-size:26px;line-height:1.2;letter-spacing:-.01em}
header .host{color:var(--accent);word-break:break-all}
header .meta{color:var(--muted);font-size:13px;text-align:right}
h2{font-size:18px;margin:36px 0 12px;letter-spacing:-.005em}
h3{font-size:15px;margin:0 0 4px}
p{margin:0 0 10px}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin:0 0 16px;padding:0;list-style:none}
.facts li{background:var(--soft);border-radius:8px;padding:10px 12px}
.facts .k{display:block;color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
.facts .v{font-weight:600}
.headline{border:1px solid var(--line);border-left:4px solid var(--accent);border-radius:8px;padding:14px 16px;margin:8px 0 0}
.headline strong{font-size:17px}
.table{width:100%;overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:600}
td.num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}
tr.total td{font-weight:700;border-top:2px solid var(--ink);border-bottom:0}
.pill{display:inline-block;font-size:12px;border-radius:999px;padding:1px 9px;font-weight:600;white-space:nowrap}
.pill.similar{background:#e6f4ee;color:var(--ok)}.pill.slower{background:#fdf1e3;color:var(--warn)}.pill.unknown{background:var(--soft);color:var(--muted)}
.finding{border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin:0 0 10px;break-inside:avoid}
.finding .lvl{font-size:12px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.lvl.blocker{color:var(--bad)}.lvl.decision{color:var(--warn)}.lvl.complexity{color:var(--accent)}.lvl.info{color:var(--muted)}
.finding .how{color:var(--muted);margin:0}
.note{color:var(--muted);font-size:13px}
ol{padding-left:20px}
footer{margin-top:40px;padding-top:14px;border-top:1px solid var(--line);color:var(--muted);font-size:13px;display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap}
footer a{color:inherit}
@media print{main{padding:0;max-width:none}h2{break-after:avoid}table,.facts,.headline{break-inside:avoid}a{color:inherit;text-decoration:none}@page{margin:16mm}}
`;

export function renderClientHtml(e: Estimate): string {
	const d = e.detections;
	const ef = e.effort;
	const a = e.agency;
	const row = (cells: string[], cls = "") => `<tr${cls ? ` class="${cls}"` : ""}>${cells.join("")}</tr>`;
	const lab = e.speed.lab;
	const field = e.speed.field;
	const parts: string[] = [];
	parts.push(`<header><div><h1>Website migration estimate<br><span class="host">${esc(d.host)}</span></h1></div><div class="meta">Prepared by <strong>${esc(a.name)}</strong><br>${esc(day(e.generatedAt))}</div></header>`);
	parts.push(`<section><h2>Summary</h2><ul class="facts">${facts(e)
		.map((f) => `<li><span class="k">${esc(f.label)}</span><span class="v">${esc(f.value)}</span></li>`)
		.join("")}</ul><div class="headline"><strong>${esc(ef.size)} project — ${esc(range(ef.total))} hours</strong>${ef.cost ? `<br>Indicative budget: <strong>${esc(money(ef.cost, ef.currency))}</strong>` : ""}${ef.excluded.length ? `<p class="note" style="margin:6px 0 0">Not included: ${esc(ef.excluded.join("; "))}.</p>` : ""}</div></section>`);
	parts.push(
		`<section><h2>Speed today and after the move</h2><div class="table"><table><thead><tr><th>Measure</th><th>Your site today</th><th>Typical EmDash site</th><th></th></tr></thead><tbody>${e.speed.comparisons
			.map((c) => row([`<td>${esc(c.metric)}</td>`, `<td>${esc(c.prospect)}</td>`, `<td>${esc(c.emdash)}</td>`, `<td><span class="pill ${c.verdict}">${VERDICT[c.verdict]}</span></td>`]))
			.join("")}</tbody></table></div>${lab?.mobile || lab?.desktop ? `<p>Google PageSpeed, home page: ${lab.mobile ? `mobile <strong>${lab.mobile.perf ?? "?"}</strong>/100${lab.mobile.lcp ? ` (LCP ${(lab.mobile.lcp / 1000).toFixed(1)} s)` : ""}` : ""}${lab.mobile && lab.desktop ? " · " : ""}${lab.desktop ? `desktop <strong>${lab.desktop.perf ?? "?"}</strong>/100` : ""}</p>` : ""}${field && !field.missing ? `<p>Real Chrome visitors, last 28 days (75th percentile): ${esc([field.lcp !== undefined ? `LCP ${(field.lcp / 1000).toFixed(1)} s` : "", field.inp !== undefined ? `INP ${field.inp} ms` : "", field.cls !== undefined ? `CLS ${field.cls}` : ""].filter(Boolean).join(", "))}</p>` : ""}${e.speed.notes.map((n) => `<p class="note">${esc(n)}</p>`).join("")}</section>`,
	);
	const rows = integrationRows(e);
	if (rows.length) parts.push(`<section><h2>What happens to each part of the site</h2><div class="table"><table><thead><tr><th>Item</th><th>Type</th><th>After the move</th></tr></thead><tbody>${rows.map((r) => row([`<td>${esc(r.name)}</td>`, `<td>${esc(r.kind)}</td>`, `<td>${esc(r.action)}${r.note ? `<br><span class="note">${esc(r.note)}</span>` : ""}</td>`])).join("")}</tbody></table></div></section>`);
	const fs = clientFindings(e);
	if (fs.length) parts.push(`<section><h2>Points to look at</h2>${fs.map((f: Finding) => `<div class="finding"><span class="lvl ${f.level}">${LEVEL_LABEL[f.level]}</span><h3>${esc(f.title)}</h3><p>${esc(f.what)} ${esc(f.impact)}</p><p class="how"><strong>How we handle it:</strong> ${esc(f.handling)}</p></div>`).join("")}</section>`);
	parts.push(
		`<section><h2>Effort</h2><div class="table"><table><thead><tr><th>Work</th><th style="text-align:right">Hours</th></tr></thead><tbody>${ef.lines.map((l) => row([`<td>${esc(l.label)}</td>`, `<td class="num">${esc(range(l.hours))}</td>`])).join("")}${row([`<td>Contingency (${Math.round(ef.contingencyRate * 100)} %)</td>`, `<td class="num">${esc(range(ef.contingency))}</td>`])}${row([`<td>Total</td>`, `<td class="num">${esc(range(ef.total))}</td>`], "total")}</tbody></table></div></section>`,
	);
	parts.push(`<section><h2>Next steps</h2><ol>${NEXT_STEPS.map((s) => `<li>${esc(s)}</li>`).join("")}</ol></section>`);
	parts.push(`<footer><span>Prepared by <a href="${esc(a.url)}">${esc(a.name)}</a>${a.contact ? ` · ${esc(a.contact)}` : ""}</span><span>Based on the public website only; a full audit with access confirms the scope.</span></footer>`);
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Migration estimate — ${esc(d.host)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
${parts.join("\n")}
</main>
</body>
</html>
`;
}

// ---------------------------------------------------------------------------------------------------------- internal

export function renderInternal(e: Estimate): string {
	const d = e.detections;
	const ef = e.effort;
	const out: string[] = [];
	out.push(`# Internal estimate — ${d.host}`, "", `Generated ${e.generatedAt} by wp2emdash ${e.kit}. Public pages only; not for the client.`, "");
	out.push("## Effort breakdown", "", "| Line | Hours | Basis |", "|---|---|---|");
	for (const l of ef.lines) out.push(`| ${l.label} | ${range(l.hours)} | ${l.basis} |`);
	out.push(`| Subtotal | ${range(ef.subtotal)} | |`, `| Contingency | ${range(ef.contingency)} | ${Math.round(ef.contingencyRate * 100)} % (rules.effort.contingency) |`, `| **Total** | **${range(ef.total)}** | size ${ef.size} |`);
	if (ef.cost) out.push("", `Rate ${num(ef.rate as number)}${ef.currency ? ` ${ef.currency}` : ""}/h → ${money(ef.cost, ef.currency)}.`);
	if (ef.excluded.length) out.push("", `**Excluded (scope separately):** ${ef.excluded.join("; ")}.`);
	out.push("", "Rules: `src/estimate/rules.ts` (override with `--rules <file.json>`).", "");
	out.push("## Adapters", "", "| Adapter | Share of sample | Proven | Status | Source |", "|---|---|---|---|---|");
	for (const a of e.adapters) out.push(`| ${a.label} | ${Math.round(a.share * 100)} % | ${a.proven ? "yes" : "no (fixtures only)"} | ${a.status} | ${a.ref} |`);
	out.push("", "## Risks and decisions", "");
	if (!e.findings.length) out.push("None detected from the public pages.");
	for (const f of e.findings) out.push(`- **[${f.level}] ${f.title}** — ${f.what} ${f.impact} _Kit:_ ${f.handling}${f.ref ? ` (${f.ref})` : ""}`);
	out.push("", "## Plugins seen", "");
	if (d.plugins.length) {
		out.push("| Plugin | Evidence | Kit action | Replacement |", "|---|---|---|---|");
		for (const p of d.plugins) out.push(`| ${p.name} (\`${p.slug}\`) | ${p.evidence.join(", ")} | ${p.action} | ${p.replacement} |`);
	} else out.push("No plugin assets or REST namespaces seen.");
	out.push("", "## Integrations", "");
	if (d.integrations.length) {
		out.push("| Name | Kind | Proposed | Pages | Note |", "|---|---|---|---|---|");
		for (const i of d.integrations) out.push(`| ${i.name} | ${i.kind} | ${i.proposed} | ${i.pageCount} | ${(i.note ?? "").replace(/\|/g, "/")} |`);
	} else out.push("None seen in the sample.");
	out.push("", "## Content and crawl", "");
	out.push(`- Origin: ${d.origin} (home HTTP ${d.homeStatus}); theme: ${d.theme ?? "?"}; WordPress ${d.wordpressVersion ?? "version hidden"}`);
	out.push(`- REST API: ${d.restAvailable ? `public — ${d.types.map((t) => `${t.slug} ${t.count}`).join(", ") || "no public types"}${d.media !== undefined ? `, media ${d.media}` : ""}, terms ${d.terms}` : "not public (counts guessed from URLs)"}`);
	out.push(`- URLs found: ${d.discovered}${d.discoveredCapped ? "+ (capped)" : ""} (guess: ${d.urlGuess.pages} pages, ${d.urlGuess.posts} posts, ${d.urlGuess.archives} archives); sitemaps read: ${d.sitemaps}`);
	out.push(`- robots.txt: ${d.robots.present ? "present" : "none"}${d.robots.crawlDelay !== undefined ? `, Crawl-delay ${d.robots.crawlDelay}s` : ""}; URLs skipped by robots rules: ${d.robots.blocked}`);
	out.push(`- Sample (${d.sample.length}): ${d.sample.map((s) => `${new URL(s.url).pathname} ${s.status}${s.builders.length ? ` [${s.builders.join("+")}]` : ""}`).join(", ")}`);
	if (d.shop) out.push(`- Shop (Store API): ${d.shop.products} products, types ${JSON.stringify(d.shop.types)}, variations ${d.shop.variations}${d.shop.currency ? `, ${d.shop.currency}` : ""}`);
	if (d.multilingual.plugin || d.multilingual.languages.length) out.push(`- Languages: ${d.multilingual.plugin ?? "hreflang"} ${d.multilingual.languages.join(", ")}`);
	out.push("", "## Speed (per page)", "", "| Page | Status | TTFB | HTML | Weight* | Requests | Images |", "|---|---|---|---|---|---|---|");
	for (const p of e.speed.pages) out.push(`| ${new URL(p.url).pathname} | ${p.status || p.error} | ${p.ttfbMs ?? "?"} ms | ${p.htmlKb ?? "?"} KB${p.compression ? ` (${p.compression})` : ""} | ${p.weightKb ?? "?"} KB | ${p.requests} | ${Object.entries(p.imageFormats).map(([f, n]) => `${f} ${n}`).join(", ") || "—"} |`);
	out.push("", "*HTML + referenced files with a known size; files loaded by scripts or stylesheets are not counted.", "");
	if (e.speed.lab?.missing) out.push(`PageSpeed: no result (${e.speed.lab.missing}).`, "");
	if (e.speed.field?.missing) out.push(`CrUX: no data (${e.speed.field.missing}).`, "");
	out.push("## Assumptions", "", "- Counts come from the public REST API where it answers, else from sitemap/link URLs.", "- Builders are detected from rendered HTML of the sampled pages; rarely used builders on unsampled pages may be missed.", "- Plugins are seen only when they load assets or expose a REST namespace; admin-only plugins are invisible here.", "- The full audit (`wp2emdash init` + `run <slug> audit`) replaces every figure here with measured ones.", "");
	return out.join("\n");
}
