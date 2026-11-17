import type { GateCheck } from "../core/state.js";
import type { ExtractSummary } from "../phases/extract.js";

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

/** Human report for reports/extract/extract.md. Contains no credentials, emails or submissions. */
export function extractReport(siteName: string, s: ExtractSummary, checks: GateCheck[]): string {
	const L: string[] = [];
	const ok = checks.every((c) => c.ok);
	L.push(`# Extract — ${siteName}`, "");
	L.push(`${s.extractedAt} · EmDash Exporter v${s.exporter.version} · WordPress ${s.exporter.wordpress} · credentials: ${s.credentialSource}`, "");
	L.push(`**Gate: ${ok ? "PASSED" : "FAILED"}**`, "");
	L.push("| | Check | Detail |", "|---|---|---|");
	for (const c of checks) L.push(`| ${c.ok ? "✅" : "❌"} | ${c.label} | ${(c.detail ?? "").replace(/\|/g, "\\|")} |`);

	L.push("", "## Content", "", "| Type | Fetched | Exporter total | By status | Last modified (GMT) |", "|---|---|---|---|---|");
	for (const t of s.types) L.push(`| ${t.name} | ${t.fetched} | ${t.expected ?? "—"} | ${Object.entries(t.byStatus).map(([k, v]) => `${k} ${v}`).join(", ")} | ${t.latestModifiedGmt ?? ""} |`);

	L.push("", "## Menus", "");
	for (const m of s.menus) L.push(`- **${m.name}** — ${m.items} items → ${m.locations.join(", ") || "no theme location"}`);
	if (!s.menus.length) L.push("- none");

	L.push("", "## Forms (definitions only — submissions are never read)", "", "| Provider | ID | Title | Status | Fields | Notifications |", "|---|---|---|---|---|---|");
	for (const f of s.forms) L.push(`| ${f.provider} | ${f.id} | ${f.title} | ${f.status} | ${f.fields} | ${f.ok ? f.notifications : `❌ ${f.error ?? ""}`} |`);
	if (!s.forms.length) L.push("| — | | | | | |");

	L.push("", "## Media", "");
	L.push(`- Library: ${s.media.library} items; ${s.media.downloaded} downloaded, ${s.media.cached} already cached, ${s.media.failed} failed (${mb(s.media.bytes)} in raw/media/)`);
	L.push(`- Uploads referenced in content but missing from the library: ${s.media.unlisted} (downloaded too)`);
	L.push(`- Distinct library items referenced by content/meta: ${s.refs.ids}`);
	if (s.refs.unresolvedIds.length) {
		L.push("", "### Unresolved attachment IDs", "");
		for (const u of s.refs.unresolvedIds) L.push(`- #${u.id} — ${u.posts.join(", ")}`);
	}
	if (s.refs.externalMedia.length) {
		L.push("", "### Media hosted outside WordPress", "", "| URL | HTTP | Used in |", "|---|---|---|");
		for (const e of s.refs.externalMedia) L.push(`| ${e.url} | ${e.status || "error"} | ${e.posts.join(", ")} |`);
	}
	if (s.refs.brokenUploads.length) {
		L.push("", "### Already broken on the live site", "", "| URL | HTTP | Used in |", "|---|---|---|");
		for (const e of s.refs.brokenUploads) L.push(`| ${e.url} | ${e.status || "error"} | ${e.posts.join(", ")} |`);
	}

	if (s.auditCrossCheck.privateNotInAudit.length || s.auditCrossCheck.missingFromExtract.length) {
		L.push("", "## Audit cross-check", "");
		if (s.auditCrossCheck.missingFromExtract.length) L.push(`- ❌ Found by the audit but not extracted: ${s.auditCrossCheck.missingFromExtract.join(", ")}`);
		if (s.auditCrossCheck.privateNotInAudit.length) L.push(`- Not public (imported unpublished): ${s.auditCrossCheck.privateNotInAudit.join(", ")}`);
	}

	if (s.notes.length) {
		L.push("", "## Needs a decision or a manual step", "");
		for (const n of s.notes) L.push(`- ${n}`);
	}
	L.push("");
	return L.join("\n");
}
