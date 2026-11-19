import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initSite } from "../src/commands/init.js";
import { applyHunks, parseUnifiedDiff, PatchError } from "../src/core/diff.js";
import { sitePaths } from "../src/core/paths.js";
import { applyProposal, approveProposal, createProposal, isProposalId, listProposals, newProposalId, proposalsDir, readProposal, rejectProposal, rerunCommand } from "../src/core/proposals.js";

const BASE = "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10\n";

describe("unified diff applier", () => {
	it("applies a single hunk", () => {
		const patch = "--- a/f.txt\n+++ b/f.txt\n@@ -2,3 +2,3 @@\n line 2\n-line 3\n+line three\n line 4\n";
		const [f] = parseUnifiedDiff(patch);
		expect(f?.oldPath).toBe("f.txt");
		expect(f?.newPath).toBe("f.txt");
		expect(applyHunks(BASE, f?.hunks ?? [])).toBe(BASE.replace("line 3\n", "line three\n"));
	});

	it("applies several hunks, insertions and deletions, and tolerates a moved hunk (offset, no fuzz)", () => {
		const patch = ["--- a/f.txt", "+++ b/f.txt", "@@ -1,2 +1,3 @@", " line 1", "+inserted", " line 2", "@@ -8,3 +9,2 @@", " line 8", "-line 9", " line 10", ""].join("\n");
		const out = applyHunks(BASE, parseUnifiedDiff(patch)[0]?.hunks ?? []);
		expect(out).toBe("line 1\ninserted\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 10\n");
		// Two extra lines at the top: the second hunk is found 2 lines further down.
		const shifted = `extra a\nextra b\n${BASE}`;
		expect(applyHunks(shifted, parseUnifiedDiff(patch)[0]?.hunks ?? [])).toBe(`extra a\nextra b\n${out}`);
	});

	it("refuses a hunk whose context no longer matches", () => {
		const patch = "--- a/f.txt\n+++ b/f.txt\n@@ -2,3 +2,3 @@\n line 2\n-line 3\n+line three\n line 4\n";
		expect(() => applyHunks(BASE.replace("line 3", "changed"), parseUnifiedDiff(patch)[0]?.hunks ?? [])).toThrow(PatchError);
	});

	it("creates a file from /dev/null and handles 'No newline at end of file'", () => {
		const create = "--- /dev/null\n+++ b/new.md\n@@ -0,0 +1,2 @@\n+# Title\n+body\n";
		const [f] = parseUnifiedDiff(create);
		expect(f?.oldPath).toBe("/dev/null");
		expect(applyHunks("", f?.hunks ?? [])).toBe("# Title\nbody\n");
		const noEol = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n";
		expect(applyHunks("a", parseUnifiedDiff(noEol)[0]?.hunks ?? [])).toBe("b\n");
		const toNoEol = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n";
		expect(applyHunks("a\n", parseUnifiedDiff(toNoEol)[0]?.hunks ?? [])).toBe("b");
	});

	it("rejects malformed patches", () => {
		expect(() => parseUnifiedDiff("just text")).toThrow(/no file headers/);
		expect(() => parseUnifiedDiff("--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n a\n")).toThrow(/old/);
		expect(() => parseUnifiedDiff("--- a/x\n+++ b/x\n@@ nonsense @@\n")).toThrow(/malformed/);
		expect(() => parseUnifiedDiff("--- a/x\n@@ -1 +1 @@\n")).toThrow(/\+\+\+/);
	});
});

describe("proposals (approval queue)", () => {
	let dir: string;
	const slug = "acme";
	let overrides: string;
	const elementsPatch = (from = "\telements: {},") =>
		["--- a/overrides.ts", "+++ b/overrides.ts", "@@ -7,3 +7,3 @@", "\t/** \"<slug>:<row path>\" from reports/transform/coverage.md → section type, or \"drop\" for decorative rows. */", `-${from}`, '+\telements: { "home:row-3": "drop" },', "\t/** Integration id (reports/audit/integrations.md) → keep | rebuild | replace | drop. */", ""]
			.map((l, i) => (i >= 3 && l.startsWith("\t") ? ` ${l}` : l))
			.join("\n");

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "wp2emdash-proposals-"));
		initSite({ slug, name: "Acme", sourceUrl: "https://acme.example", productionUrl: "https://acme.example", sensitiveData: false }, dir);
		overrides = sitePaths(slug, dir).overrides;
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("ids follow p-<yyyymmdd>-<6 hex>", () => {
		const id = newProposalId(new Date("2026-11-19T10:00:00Z"));
		expect(id).toMatch(/^p-20261119-[0-9a-f]{6}$/);
		expect(isProposalId(id)).toBe(true);
		expect(isProposalId("../etc/passwd")).toBe(false);
	});

	it("creates a pending proposal (dry run only), lists and reads it", () => {
		const before = readFileSync(overrides, "utf8");
		const p = createProposal(slug, { summary: "Drop the decorative divider on home", file: "overrides.ts", patch: elementsPatch(), rerun: "transform" }, { sitesDir: dir });
		expect(p).toMatchObject({ by: "claude", status: "pending", file: "overrides.ts", rerun: "transform" });
		expect(readFileSync(overrides, "utf8")).toBe(before);
		expect(existsSync(join(proposalsDir(slug, dir), `${p.id}.json`))).toBe(true);
		const onDisk = JSON.parse(readFileSync(join(proposalsDir(slug, dir), `${p.id}.json`), "utf8"));
		expect(Object.keys(onDisk).sort()).toEqual(["by", "createdAt", "file", "id", "patch", "rerun", "status", "summary"]);
		expect(listProposals(slug, { sitesDir: dir }).map((x) => x.id)).toEqual([p.id]);
		expect(listProposals(slug, { sitesDir: dir, status: "approved" })).toEqual([]);
		expect(readProposal(slug, p.id, { sitesDir: dir })).toEqual(p);
	});

	it("refuses a patch that does not apply, touches another file, or deletes the file", () => {
		expect(() => createProposal(slug, { summary: "x", file: "overrides.ts", patch: elementsPatch("\telements: { nope: 1 },") }, { sitesDir: dir })).toThrow(/does not apply/);
		expect(() => createProposal(slug, { summary: "x", file: "decisions.md", patch: elementsPatch() }, { sitesDir: dir })).toThrow(/may only change decisions.md/);
		const escape = elementsPatch().replace(/a\/overrides\.ts/, "a/../../etc/passwd").replace(/b\/overrides\.ts/, "b/../../etc/passwd");
		expect(() => createProposal(slug, { summary: "x", file: "overrides.ts", patch: escape }, { sitesDir: dir })).toThrow(/may only change/);
		expect(() => createProposal(slug, { summary: "x", file: "overrides.ts", patch: "--- a/overrides.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-/**\n" }, { sitesDir: dir })).toThrow(/deleting/);
		expect(listProposals(slug, { sitesDir: dir })).toEqual([]);
	});

	it("approveProposal refuses a change that would stop overrides.ts from loading, and applies a valid one", async () => {
		const before = readFileSync(overrides, "utf8");
		const bad = createProposal(slug, { summary: "Unknown type", file: "overrides.ts", patch: elementsPatch().replace('"home:row-3": "drop"', '"home:row-3": "not_a_section_type"'), rerun: "transform" }, { sitesDir: dir });
		const f = await approveProposal(slug, bad.id, "Owner", { sitesDir: dir });
		expect(f.status).toBe("failed");
		expect(f.note).toMatch(/would no longer load/);
		expect(readFileSync(overrides, "utf8")).toBe(before);
		const good = createProposal(slug, { summary: "Drop divider", file: "overrides.ts", patch: elementsPatch(), rerun: "transform" }, { sitesDir: dir });
		expect((await approveProposal(slug, good.id, "Owner", { sitesDir: dir })).status).toBe("approved");
		expect(readFileSync(overrides, "utf8")).toContain('"home:row-3": "drop"');
	});

	it("approve applies the patch, records who decided and gives the rerun command", () => {
		const p = createProposal(slug, { summary: "Drop divider", file: "overrides.ts", patch: elementsPatch(), rerun: "transform" }, { sitesDir: dir });
		const a = applyProposal(slug, p.id, "Owner Name", { sitesDir: dir, note: "ok" });
		expect(a).toMatchObject({ status: "approved", decidedBy: "Owner Name", note: "ok" });
		expect(a.decidedAt).toBeTruthy();
		expect(readFileSync(overrides, "utf8")).toContain('elements: { "home:row-3": "drop" },');
		expect(rerunCommand(slug, a)).toBe("pnpm wp2emdash run acme transform");
		// Decided proposals cannot be decided again.
		expect(() => applyProposal(slug, p.id, "Owner Name", { sitesDir: dir })).toThrow(/already approved/);
		expect(() => rejectProposal(slug, p.id, "Owner Name", { sitesDir: dir })).toThrow(/already approved/);
	});

	it("approve of a conflicting patch leaves the file alone and marks the proposal failed", () => {
		const p = createProposal(slug, { summary: "Drop divider", file: "overrides.ts", patch: elementsPatch(), rerun: "transform" }, { sitesDir: dir });
		const changed = readFileSync(overrides, "utf8").replace("\telements: {},", '\telements: { "about:row-1": "hero" },');
		writeFileSync(overrides, changed);
		const f = applyProposal(slug, p.id, "Owner Name", { sitesDir: dir });
		expect(f.status).toBe("failed");
		expect(f.note).toMatch(/patch did not apply/);
		expect(readFileSync(overrides, "utf8")).toBe(changed);
		expect(rerunCommand(slug, f)).toBeUndefined();
	});

	it("reject never touches the file; decidedBy is required; unknown ids are refused", () => {
		const before = readFileSync(overrides, "utf8");
		const p = createProposal(slug, { summary: "Drop divider", file: "overrides.ts", patch: elementsPatch() }, { sitesDir: dir });
		expect(() => rejectProposal(slug, p.id, "  ", { sitesDir: dir })).toThrow(/decidedBy/);
		const r = rejectProposal(slug, p.id, "Owner Name", { sitesDir: dir, note: "keep the divider" });
		expect(r).toMatchObject({ status: "rejected", decidedBy: "Owner Name", note: "keep the divider", rerun: null });
		expect(readFileSync(overrides, "utf8")).toBe(before);
		expect(() => applyProposal(slug, "p-20261119-abcdef", "Owner", { sitesDir: dir })).toThrow(/No proposal/);
		expect(() => applyProposal(slug, "../../state", "Owner", { sitesDir: dir })).toThrow(/Not a proposal id/);
	});

	it("appends a decisions.md row", () => {
		const text = readFileSync(sitePaths(slug, dir).decisions, "utf8");
		const lines = text.replace(/\n$/, "").split("\n");
		const n = lines.length;
		const patch = ["--- a/decisions.md", "+++ b/decisions.md", `@@ -${n},1 +${n},2 @@`, ` ${lines[n - 1]}`, "+| 2026-11-19 | transform | Drop home divider | decorative only | Owner |", ""].join("\n");
		const p = createProposal(slug, { summary: "Record the divider decision", file: "decisions.md", patch }, { sitesDir: dir });
		expect(applyProposal(slug, p.id, "Owner", { sitesDir: dir }).status).toBe("approved");
		expect(readFileSync(sitePaths(slug, dir).decisions, "utf8")).toBe(`${text}| 2026-11-19 | transform | Drop home divider | decorative only | Owner |\n`);
	});
});
