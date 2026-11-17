/**
 * reports/verify/index.html — the verify result as a self-contained page: gate summary, per-page
 * table, and old/new screenshots per viewport with a comparison slider and the pixel-diff image.
 * Images are referenced relatively (snapshot/screens and reports/verify/screens|diff), never inlined.
 */
import type { GateCheck } from "../core/state.js";
import type { VerifyResult } from "../phases/verify.js";

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const pct = (n: number | undefined) => (n === undefined ? "—" : `${(n * 100).toFixed(1)}%`);

export function verifyReport(siteName: string, v: VerifyResult, checks: GateCheck[], visualLimit: number): string {
	const passed = checks.filter((c) => c.ok).length;
	const ok = passed === checks.length;
	const vps = [...new Set(v.pages.flatMap((p) => Object.keys(p.visual)))];
	const rows = v.pages
		.map((p) => {
			const vis = vps.map((vp) => {
				const r = p.visual[vp];
				return `<td class="${r && r.ratio <= visualLimit ? "ok" : "bad"}">${r ? pct(r.ratio) : "—"}</td>`;
			});
			const seoBad = p.seo ? Object.entries(p.seo).filter(([, x]) => !x.ok).map(([k]) => k) : [];
			return `<tr><th scope="row"><a href="#p-${esc(p.name)}">${esc(p.path)}</a></th><td class="${p.status === 200 ? "ok" : "bad"}">${p.status}</td><td class="${(p.text?.recall ?? 0) >= 0.98 ? "ok" : "bad"}">${pct(p.text?.recall)}</td><td class="${p.headings?.ok ? "ok" : "bad"}">${p.headings?.ok ? "✓" : "✗"}</td><td class="${seoBad.length ? "bad" : "ok"}">${seoBad.length ? esc(seoBad.join(", ")) : "✓"}</td>${vis.join("")}<td class="${p.a11y?.serious.length ? "bad" : "ok"}">${p.a11y ? p.a11y.serious.length : "—"}</td><td>${p.perf?.lcpMs !== undefined ? `${p.perf.lcpMs} ms` : "—"}</td></tr>`;
		})
		.join("");

	const detail = v.pages
		.map((p) => {
			const shots = vps
				.map((vp) => {
					const r = p.visual[vp];
					if (!r) return "";
					const src = `../../snapshot/screens/${vp}/${p.name}.png`;
					const tgt = `screens/${vp}/${p.name}.png`;
					const diff = `diff/${vp}/${p.name}.png`;
					return `<figure class="cmp" data-vp="${esc(vp)}">
	<figcaption><b>${esc(vp)}</b> · difference ${pct(r.ratio)} over ${r.comparedHeight}px · height ${r.sourceHeight}px → ${r.targetHeight}px ${r.error ? `· <span class="badtext">${esc(r.error)}</span>` : ""}
		<span class="modes"><button type="button" data-mode="slider" aria-pressed="true">Slider</button><button type="button" data-mode="side">Side by side</button><button type="button" data-mode="diff">Diff</button></span></figcaption>
	<div class="stage mode-slider" style="--pos:50%">
		<div class="pane old"><span class="tag">WordPress</span><img loading="lazy" src="${src}" alt="WordPress ${esc(p.path)} ${esc(vp)}"></div>
		<div class="pane new"><span class="tag">EmDash</span><img loading="lazy" src="${tgt}" alt="EmDash ${esc(p.path)} ${esc(vp)}"></div>
		<div class="pane diffimg"><img loading="lazy" src="${diff}" alt="Pixel difference ${esc(p.path)} ${esc(vp)}"></div>
		<input class="range" type="range" min="0" max="100" value="50" aria-label="Reveal WordPress / EmDash">
	</div>
</figure>`;
				})
				.join("");
			const issues = [
				p.text && p.text.missing.length ? `<li>Words on WordPress not found on EmDash (${p.text.missing.length}): ${esc(p.text.missing.slice(0, 25).join(", "))}</li>` : "",
				p.headings && !p.headings.ok ? `<li>Headings: h1 “${esc(p.headings.h1Target ?? "—")}” vs “${esc(p.headings.h1Source ?? "—")}”${p.headings.missing.length ? `; missing: ${esc(p.headings.missing.join(" · "))}` : ""}</li>` : "",
				...(p.seo ? Object.entries(p.seo).filter(([, x]) => !x.ok).map(([k, x]) => `<li>SEO ${esc(k)}: ${esc(JSON.stringify(x))}</li>`) : []),
				p.missingExternal.length ? `<li>External links missing: ${esc(p.missingExternal.join(", "))}</li>` : "",
				p.imagesWithoutAlt.length ? `<li>${p.imagesWithoutAlt.length} image(s) without alt</li>` : "",
				...p.forms.filter((f) => !f.ok).map((f) => `<li>Form: ${esc(f.detail)}</li>`),
				...(p.a11y?.serious ?? []).map((a) => `<li>Accessibility (${esc(a.impact)}): ${esc(a.help)} — ${a.nodes} element(s) <code>${esc(a.id)}</code></li>`),
				p.perf ? `<li class="muted">Lab performance (mobile): TTFB ${p.perf.ttfbMs ?? "—"} ms · LCP ${p.perf.lcpMs ?? "—"} ms · CLS ${p.perf.cls ?? "—"} · ${p.perf.transferKb ?? "—"} KB</li>` : "",
			].filter(Boolean);
			const rel = (f: string) => f.slice(f.lastIndexOf("/reports/verify/") + "/reports/verify/".length);
			const sectionTables = Object.entries(p.sections ?? {})
				.map(([vp, list]) => {
					if (!list.length) return "";
					const sorted = [...list].sort((a, b) => b.ratio - a.ratio);
					return `<details class="sections"${sorted.some((x) => x.ratio > visualLimit) ? " open" : ""}><summary><b>${esc(vp)}</b> — ${list.length} sections, ${list.filter((x) => x.ratio <= visualLimit).length} within ${(visualLimit * 100).toFixed(0)}%</summary>
<table class="sec"><thead><tr><th scope="col">Section</th><th scope="col">Type</th><th scope="col">Difference</th><th scope="col">Height WP → EmDash</th><th scope="col">WordPress</th><th scope="col">EmDash</th><th scope="col">Diff</th></tr></thead><tbody>
${sorted
	.map((x) => `<tr><th scope="row">${esc(x.label)}</th><td>${esc(x.types.join(" + "))}</td><td class="${x.ratio <= visualLimit ? "ok" : "bad"}">${pct(x.ratio)}${x.note ? ` <small>${esc(x.note)}</small>` : ""}</td><td>${x.sourceHeight} → ${x.targetHeight}px</td>${x.files ? `<td><a href="${esc(rel(x.files.source))}"><img loading="lazy" src="${esc(rel(x.files.source))}" alt="WordPress ${esc(x.label)}"></a></td><td><a href="${esc(rel(x.files.target))}"><img loading="lazy" src="${esc(rel(x.files.target))}" alt="EmDash ${esc(x.label)}"></a></td><td><a href="${esc(rel(x.files.diff))}"><img loading="lazy" src="${esc(rel(x.files.diff))}" alt="Difference ${esc(x.label)}"></a></td>` : "<td></td><td></td><td></td>"}</tr>`)
	.join("")}
</tbody></table></details>`;
				})
				.join("");
			return `<section class="page" id="p-${esc(p.name)}"><h3>${esc(p.path)} <a class="ext" href="${esc(p.sourceUrl)}">WordPress ↗</a> <a class="ext" href="${esc(p.targetUrl)}">EmDash ↗</a></h3>${issues.length ? `<ul class="issues">${issues.join("")}</ul>` : `<p class="muted">No issues.</p>`}${sectionTables}${shots}</section>`;
		})
		.join("");

	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Verify report — ${esc(siteName)}</title>
<style>
:root { --bg:#f7f6f3; --surface:#fff; --text:#16181d; --muted:#626774; --line:#e5e2dc; --ok:#1f8a5b; --bad:#c2410c; --accent:#3b5bdb; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#0f1115; --surface:#171a22; --text:#eceef3; --muted:#9aa1b2; --line:#272b36; --ok:#4fd39a; --bad:#ff8a5c; --accent:#8aa4ff; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
.wrap { width:min(100% - 32px, 1280px); margin-inline:auto; padding:28px 0 64px; }
h1 { font-size:clamp(24px,3.4vw,34px); letter-spacing:-0.02em; margin:0 0 4px; }
.meta { color:var(--muted); margin:0 0 20px; }
.verdict { display:inline-block; padding:4px 12px; border-radius:999px; font-weight:600; font-size:14px; }
.verdict.ok { background:color-mix(in srgb,var(--ok) 15%,transparent); color:var(--ok); }
.verdict.bad { background:color-mix(in srgb,var(--bad) 15%,transparent); color:var(--bad); }
.checks { display:grid; gap:8px; grid-template-columns:repeat(auto-fill,minmax(320px,1fr)); margin:20px 0 32px; padding:0; list-style:none; }
.checks li { background:var(--surface); border:1px solid var(--line); border-radius:10px; padding:10px 14px; }
.checks b { display:block; }
.checks small { color:var(--muted); display:block; overflow-wrap:anywhere; }
.checks .i-ok b::before { content:"✓ "; color:var(--ok); }
.checks .i-bad b::before { content:"✗ "; color:var(--bad); }
.table-wrap { overflow-x:auto; border:1px solid var(--line); border-radius:12px; background:var(--surface); }
table { border-collapse:collapse; width:100%; min-width:760px; font-size:14px; }
th, td { padding:9px 12px; border-bottom:1px solid var(--line); text-align:left; white-space:nowrap; }
thead th { color:var(--muted); font-weight:600; font-size:12.5px; }
td.ok { color:var(--ok); } td.bad { color:var(--bad); font-weight:600; }
a { color:var(--accent); }
.page { margin-top:40px; padding-top:20px; border-top:1px solid var(--line); }
.page h3 { margin:0 0 8px; font-size:20px; }
.ext { font-size:13px; font-weight:400; margin-left:8px; }
.issues { margin:0 0 16px; padding-left:20px; }
.issues li { margin:3px 0; overflow-wrap:anywhere; }
.muted { color:var(--muted); }
.badtext { color:var(--bad); }
.cmp { margin:18px 0; background:var(--surface); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
.cmp figcaption { padding:10px 14px; font-size:13.5px; display:flex; flex-wrap:wrap; gap:8px; align-items:center; justify-content:space-between; border-bottom:1px solid var(--line); }
.modes button { font:inherit; font-size:12.5px; border:1px solid var(--line); background:transparent; color:var(--text); border-radius:999px; padding:3px 10px; cursor:pointer; }
.modes button[aria-pressed="true"] { background:var(--text); color:var(--bg); }
.stage { position:relative; max-height:80vh; overflow:auto; }
.pane img { display:block; width:100%; height:auto; }
.tag { position:absolute; top:8px; z-index:3; font-size:11px; font-weight:600; background:rgb(0 0 0 / .65); color:#fff; padding:2px 8px; border-radius:999px; }
.old .tag { left:8px; } .new .tag { right:8px; }
.mode-slider .old { position:relative; }
.mode-slider .new { position:absolute; inset:0 0 auto 0; clip-path:inset(0 0 0 var(--pos)); }
.mode-slider .diffimg, .mode-side .diffimg, .mode-diff .old, .mode-diff .new { display:none; }
.mode-side { display:grid; grid-template-columns:1fr 1fr; gap:2px; }
.mode-side .old, .mode-side .new { position:relative; }
.range { position:sticky; bottom:8px; left:0; width:calc(100% - 32px); margin:8px 16px; z-index:4; }
.mode-side .range, .mode-diff .range { display:none; }
.sections { margin:12px 0; background:var(--surface); border:1px solid var(--line); border-radius:12px; padding:10px 14px; }
.sections summary { cursor:pointer; }
table.sec { min-width:0; margin-top:8px; }
table.sec td, table.sec th { white-space:normal; vertical-align:top; }
table.sec img { display:block; width:160px; max-height:220px; object-fit:cover; object-position:top; border:1px solid var(--line); border-radius:6px; background:#fff; }
</style>
</head>
<body>
<div class="wrap">
	<h1>Verify — ${esc(siteName)}</h1>
	<p class="meta">WordPress (audit snapshot) vs ${esc(v.target)} · <a href="${esc(v.targetUrl)}">${esc(v.targetUrl)}</a> · ${esc(v.ranAt)}</p>
	<span class="verdict ${ok ? "ok" : "bad"}">${ok ? "Gate passed" : `Gate: ${passed}/${checks.length} checks passed`}</span>
	<ul class="checks">${checks.map((c) => `<li class="${c.ok ? "i-ok" : "i-bad"}"><b>${esc(c.label)}</b>${c.detail ? `<small>${esc(c.detail)}</small>` : ""}</li>`).join("")}</ul>
	<h2>Pages</h2>
	<div class="table-wrap"><table>
		<thead><tr><th scope="col">Page</th><th scope="col">HTTP</th><th scope="col">Text kept</th><th scope="col">Headings</th><th scope="col">SEO</th>${vps.map((vp) => `<th scope="col">Visual ${esc(vp)}</th>`).join("")}<th scope="col">A11y serious</th><th scope="col">LCP</th></tr></thead>
		<tbody>${rows}</tbody>
	</table></div>
	${v.menu ? `<h2>Burger menu</h2><p>${v.menu.itemsMissing.length ? `<span class="badtext">Missing items: ${esc(v.menu.itemsMissing.join(", "))}</span>` : "All menu items present."} ${v.menu.motion.ok ? "Timings within ±15%." : `<span class="badtext">${esc(v.menu.motion.diffs.join("; "))}</span>`}</p>` : ""}
	${detail}
</div>
<script>
document.querySelectorAll(".cmp").forEach(function (fig) {
	var stage = fig.querySelector(".stage"), range = fig.querySelector(".range");
	range.addEventListener("input", function () { stage.style.setProperty("--pos", range.value + "%"); });
	fig.querySelectorAll("[data-mode]").forEach(function (b) {
		b.addEventListener("click", function () {
			stage.className = "stage mode-" + b.dataset.mode;
			fig.querySelectorAll("[data-mode]").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
		});
	});
});
</script>
</body>
</html>
`;
}
