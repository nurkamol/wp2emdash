import type { GateCheck } from "../core/state.js";
import type { IrSite } from "../ir/schema.js";
import type { DocResult } from "../phases/transform.js";

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** reports/transform/coverage.md — per document: sections, conservation, diagnostics. */
export function transformReport(siteName: string, results: DocResult[], checks: GateCheck[], notTransformed: string[], site: IrSite): string {
	const L: string[] = [];
	const ok = checks.every((c) => c.ok);
	L.push(`# Transform — ${siteName}`, "", `**Gate: ${ok ? "PASSED" : "FAILED"}**`, "", "| | Check | Detail |", "|---|---|---|");
	for (const c of checks) L.push(`| ${c.ok ? "✅" : "❌"} | ${c.label} | ${esc(c.detail ?? "")} |`);

	L.push("", "## Documents", "", "| Document | Status | Builder | Sections | Text kept | Issues |", "|---|---|---|---|---|---|");
	for (const r of results) {
		const errs = r.doc.diagnostics.filter((d) => d.level === "error").length;
		const warns = r.doc.diagnostics.filter((d) => d.level === "warn").length;
		const counts = new Map<string, number>();
		for (const s of r.doc.sections) counts.set(s.type, (counts.get(s.type) ?? 0) + 1);
		L.push(`| ${r.doc.route?.path ?? r.file} | ${r.doc.source.status} | ${r.doc.source.builder} | ${[...counts].map(([t, n]) => (n > 1 ? `${t}×${n}` : t)).join(", ") || "—"} | ${r.conservation ? `${(r.conservation.ratio * 100).toFixed(1)}%` : "—"} | ${errs ? `❌ ${errs}` : ""}${warns ? ` ⚠️ ${warns}` : ""} |`);
	}

	// Site-wide unmapped table.
	const unmapped = new Map<string, { n: number; where: Set<string>; content: boolean }>();
	for (const r of results) {
		for (const d of r.doc.diagnostics.filter((x) => x.code === "unmapped" || x.code === "dynamic")) {
			const k = d.tag ?? d.message;
			const e = unmapped.get(k) ?? { n: 0, where: new Set(), content: false };
			e.n++;
			e.where.add(r.doc.source.slug);
			e.content ||= !!d.carriesContent;
			unmapped.set(k, e);
		}
	}
	if (unmapped.size) {
		L.push("", "## Unmapped elements (site-wide)", "", "| Element | Count | Carries content | Where |", "|---|---|---|---|");
		for (const [k, e] of [...unmapped].sort((a, b) => b[1].n - a[1].n)) L.push(`| ${esc(k)} | ${e.n} | ${e.content ? "yes" : "no"} | ${[...e.where].join(", ")} |`);
		L.push("", "Fix: add an element handler (with a fixture + golden test), or map the row in `overrides.ts → elements`, then rerun transform.");
	}

	L.push("", "## Section map", "");
	for (const r of results) {
		L.push(`### ${r.doc.title || r.doc.source.slug} — \`${r.file}\`${r.published ? "" : ` (${r.doc.source.status}, not gated)`}`, "");
		r.doc.sections.forEach((s, i) => {
			const extra = [s.theme.tone === "dark" ? "dark" : "", s.theme.background?.video ? "bg video" : s.theme.background?.image ? "bg image" : s.theme.background?.color ? `bg ${s.theme.background.color}` : "", s.anchorId ? `#${s.anchorId}` : "", s.fullHeight ? "full height" : ""].filter(Boolean).join(", ");
			L.push(`${i + 1}. **${s.type}**${s.variant ? ` (${s.variant})` : ""}${extra ? ` — ${extra}` : ""} · \`${s.sourceRef.path}\``);
		});
		const notable = r.doc.diagnostics.filter((d) => d.level !== "info");
		if (notable.length) {
			L.push("");
			for (const d of notable) L.push(`- ${d.level === "error" ? "❌" : "⚠️"} ${d.code}: ${esc(d.message)}${d.path ? ` · \`${d.path}\`` : ""}`);
		}
		const info = r.doc.diagnostics.filter((d) => d.level === "info");
		if (info.length) {
			const byMsg = new Map<string, number>();
			for (const d of info) byMsg.set(d.message, (byMsg.get(d.message) ?? 0) + 1);
			L.push("", `<details><summary>${info.length} info</summary>`, "");
			for (const [m, n] of byMsg) L.push(`- ${esc(m)}${n > 1 ? ` (×${n})` : ""}`);
			L.push("", "</details>");
		}
		if (r.conservation && r.conservation.missing.length) {
			L.push("", `Words on the live page not found in the IR (${r.conservation.missing.length}): ${r.conservation.missing.slice(0, 30).join(", ")}`);
			for (const c of r.conservation.context) L.push(`  - ${esc(c)}`);
		}
		L.push("");
	}

	L.push("## Menus", "");
	for (const m of site.menus) {
		L.push(`- **${m.name}** (${m.role}): ${m.items.map((i) => `${i.label}${i.opensPopup ? ` [opens popup ${i.opensPopup}]` : ""}${i.children.length ? ` › ${i.children.map((c) => c.label).join(", ")}` : ""}`).join(" · ")}`);
	}
	if (notTransformed.length) {
		L.push("", "## Not transformed (by design)", "");
		for (const n of notTransformed) L.push(`- ${n}`);
	}
	L.push("");
	return L.join("\n");
}
