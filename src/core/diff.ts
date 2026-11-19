/**
 * A small, dependency-free unified-diff parser and applier (no shelling out to `patch` or `git apply`).
 * Strict by design: every context and removed line must match exactly; a hunk may only move (offset), never fuzz.
 * Used by the approval queue (src/core/proposals.ts) to apply a proposed change to overrides.ts / decisions.md.
 */

export interface HunkLine {
	op: " " | "-" | "+";
	text: string;
}

export interface Hunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: HunkLine[];
	/** "\ No newline at end of file" after the hunk's last old-side / new-side line. */
	oldNoEol?: boolean;
	newNoEol?: boolean;
}

export interface FilePatch {
	/** Path from the `---` header with any `a/` prefix removed; "/dev/null" for a new file. */
	oldPath: string;
	/** Path from the `+++` header with any `b/` prefix removed; "/dev/null" for a deleted file. */
	newPath: string;
	hunks: Hunk[];
}

export class PatchError extends Error {}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function headerPath(line: string, marker: "---" | "+++"): string {
	// "--- a/overrides.ts\t2026-11-19 10:00:00" → "overrides.ts"
	let p = line.slice(marker.length).trim().split("\t")[0]?.trim() ?? "";
	if (p.startsWith('"') && p.endsWith('"')) p = p.slice(1, -1);
	if (p === "/dev/null") return p;
	if ((marker === "---" && p.startsWith("a/")) || (marker === "+++" && p.startsWith("b/"))) p = p.slice(2);
	return p;
}

/** Parses a unified diff (one or more files). Throws PatchError on malformed input or hunk counts that don't add up. */
export function parseUnifiedDiff(patch: string): FilePatch[] {
	const lines = patch.replace(/\r\n/g, "\n").split("\n");
	if (lines.at(-1) === "") lines.pop();
	const files: FilePatch[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] as string;
		if (!line.startsWith("--- ")) {
			i++; // preamble: "diff --git", "index …", free text
			continue;
		}
		const next = lines[i + 1];
		if (next === undefined || !next.startsWith("+++ ")) throw new PatchError(`line ${i + 2}: expected "+++ " after "--- "`);
		const file: FilePatch = { oldPath: headerPath(line, "---"), newPath: headerPath(next, "+++"), hunks: [] };
		i += 2;
		while (i < lines.length && (lines[i] as string).startsWith("@@")) {
			const m = HUNK_RE.exec(lines[i] as string);
			if (!m) throw new PatchError(`line ${i + 1}: malformed hunk header`);
			const hunk: Hunk = { oldStart: Number(m[1]), oldLines: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newLines: m[4] === undefined ? 1 : Number(m[4]), lines: [] };
			i++;
			let oldSeen = 0;
			let newSeen = 0;
			while (i < lines.length && (oldSeen < hunk.oldLines || newSeen < hunk.newLines || (lines[i] as string).startsWith("\\"))) {
				const l = lines[i] as string;
				if (l.startsWith("\\")) {
					const prev = hunk.lines.at(-1);
					if (!prev) throw new PatchError(`line ${i + 1}: "\\ No newline" marker without a preceding line`);
					if (prev.op !== "+") hunk.oldNoEol = true;
					if (prev.op !== "-") hunk.newNoEol = true;
					i++;
					continue;
				}
				// An empty line inside a hunk is an empty context line whose leading space was stripped by an editor.
				const op = (l === "" ? " " : l[0]) as string;
				if (op !== " " && op !== "-" && op !== "+") throw new PatchError(`line ${i + 1}: unexpected "${l.slice(0, 20)}" inside a hunk`);
				hunk.lines.push({ op, text: l.slice(1) });
				if (op !== "+") oldSeen++;
				if (op !== "-") newSeen++;
				i++;
			}
			if (oldSeen !== hunk.oldLines || newSeen !== hunk.newLines) {
				throw new PatchError(`hunk @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@: has ${oldSeen} old / ${newSeen} new lines`);
			}
			file.hunks.push(hunk);
		}
		if (!file.hunks.length) throw new PatchError(`${file.newPath}: no hunks`);
		files.push(file);
	}
	if (!files.length) throw new PatchError("no file headers (--- / +++) found");
	return files;
}

/**
 * Applies the hunks to `original` (pass "" for a new file). Each hunk's old side must match exactly; it is looked
 * for at its stated line first, then at the nearest offset after the previous hunk. Throws PatchError if not.
 */
export function applyHunks(original: string, hunks: Hunk[]): string {
	const hadEol = original === "" || original.endsWith("\n");
	const src = original === "" ? [] : (hadEol ? original.slice(0, -1) : original).split("\n");
	const out: string[] = [];
	let cursor = 0; // next unconsumed line of src
	let delta = 0;
	let endEol = hadEol;
	for (const [n, h] of hunks.entries()) {
		const old = h.lines.filter((l) => l.op !== "+").map((l) => l.text);
		const repl = h.lines.filter((l) => l.op !== "-").map((l) => l.text);
		const base = h.oldLines === 0 ? h.oldStart : h.oldStart - 1;
		const want = Math.max(cursor, base + delta);
		const matchesAt = (at: number) => at >= cursor && at + old.length <= src.length && old.every((t, k) => src[at + k] === t);
		let at = -1;
		for (let d = 0; d <= src.length; d++) {
			if (matchesAt(want - d)) {
				at = want - d;
				break;
			}
			if (matchesAt(want + d)) {
				at = want + d;
				break;
			}
		}
		if (at < 0) throw new PatchError(`hunk ${n + 1} (@@ -${h.oldStart},${h.oldLines} @@) does not apply: the file has changed`);
		out.push(...src.slice(cursor, at), ...repl);
		cursor = at + old.length;
		delta = at - base;
		if (cursor === src.length) {
			if (h.oldNoEol === true && hadEol) throw new PatchError(`hunk ${n + 1}: expects no newline at end of file`);
			endEol = !h.newNoEol;
		}
	}
	out.push(...src.slice(cursor));
	if (!out.length) return "";
	return out.join("\n") + (endEol ? "\n" : "");
}
