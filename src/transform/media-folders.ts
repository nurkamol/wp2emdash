/**
 * Folder plan for EmDash's media library (ir/media-folders.json). EmDash 1.5 folders are flat (`media_folders`: id,
 * name; names unique by trim + NFKC + lowercase, 1–200 characters): a WordPress folder tree becomes names such as
 * "Parent / Child". Each attachment goes to one folder; one in several folders (a second plugin, a shortcut, a second
 * term) takes the first by plugin order and is counted.
 */
import { FOLDER_PLUGINS, type FolderSource, type RawFolder } from "../extract/media-folders.js";

export const FOLDER_NAME_MAX = 200;
export const folderKey = (name: string) => name.trim().normalize("NFKC").toLowerCase();

export interface MediaFolderPlan {
	/** Folder names to have on the target, sorted. */
	folders: string[];
	/** WordPress attachment id → folder name. */
	assignments: Record<string, string>;
	sources: { plugin: string; via: "rest" | "dump"; key: string; folders: number; assigned: number }[];
	/** Attachments in more than one folder (first kept). */
	multiple: number;
	/** Distinct WordPress folders that came out with the same name (merged into one). */
	merged: number;
	/** Names shortened to EmDash's limit. */
	truncated: number;
	/** Folders whose parent is missing (kept at the top level). */
	orphans: number;
	/** Plugins detected whose folders could not be read (not guessed). */
	unreachable: { plugin: string; why: string }[];
}

export function planMediaFolders(sources: FolderSource[], unreachable: { plugin: string; why: string }[] = []): MediaFolderPlan {
	const names = new Map<string, string>(); // key → display name (first seen)
	const assignments: Record<string, string> = {};
	let multiple = 0;
	let merged = 0;
	let truncated = 0;
	let orphans = 0;
	const out: MediaFolderPlan["sources"] = [];
	for (const src of sources) {
		const byId = new Map(src.folders.map((f) => [f.id, f]));
		orphans += src.folders.filter((f) => f.parent && !byId.has(f.parent)).length;
		// Untruncated full paths; a parent's part is spelled as its folder was first named (FileBird "Photos" and Real
		// Media Library "photos" are one folder, and its children read "Photos / …").
		const full = new Map<number, string>();
		const shown = new Map<number, string>();
		const fullPath = (id: number, seen: Set<number> = new Set()): string => {
			const cached = full.get(id);
			if (cached !== undefined) return cached;
			const f = byId.get(id) as RawFolder;
			seen.add(id);
			const own = f.name.replace(/\s+/g, " ").trim() || `Folder ${f.id}`;
			const parent = f.parent && byId.has(f.parent) && !seen.has(f.parent) ? fullPath(f.parent, seen) : undefined;
			const value = parent ? `${names.get(folderKey(parent)) ?? parent} / ${own}` : own;
			full.set(id, value);
			if (value.length <= FOLDER_NAME_MAX && !names.has(folderKey(value))) names.set(folderKey(value), value);
			return value;
		};
		const path = (id: number): string => {
			const cached = shown.get(id);
			if (cached !== undefined) return cached;
			let name = fullPath(id);
			if (name.length > FOLDER_NAME_MAX) {
				name = `${name.slice(0, FOLDER_NAME_MAX - 1).trimEnd()}…`;
				truncated++;
			}
			shown.set(id, name);
			return name;
		};
		const local = new Map<string, number>(); // key → first folder id in this source
		for (const f of src.folders) {
			const name = path(f.id);
			const k = folderKey(name);
			if (local.has(k) && local.get(k) !== f.id) merged++;
			else local.set(k, f.id);
			if (!names.has(k)) names.set(k, name);
		}
		let assigned = 0;
		for (const [att, ids] of Object.entries(src.assignments)) {
			const first = ids.find((id) => byId.has(id));
			if (first === undefined) continue;
			assigned++;
			if (assignments[att] !== undefined || ids.filter((id) => byId.has(id)).length > 1) multiple++;
			if (assignments[att] === undefined) assignments[att] = names.get(folderKey(path(first))) as string;
		}
		out.push({ plugin: src.plugin, via: src.via, key: src.key, folders: src.folders.length, assigned });
	}
	const sorted = Object.fromEntries(Object.entries(assignments).sort(([a], [b]) => Number(a) - Number(b)));
	return { folders: [...names.values()].sort((a, b) => a.localeCompare(b, "en")), assignments: sorted, sources: out, multiple, merged, truncated, orphans, unreachable };
}

/** Coverage report section "Media folders" (counts only). */
export function mediaFoldersReport(plan: MediaFolderPlan | undefined): string[] {
	if (!plan || (!plan.sources.length && !plan.unreachable.length)) return [];
	const L = ["", "## Media folders", "", "EmDash's media library has flat folders: a WordPress folder tree becomes names like “Parent / Child”. Load creates the missing folders (an editor's folders with the same name are reused, never renamed or deleted) and files each item that is still in the Main library."];
	if (plan.sources.length) {
		L.push("", "| Plugin | Read from | Folders | Files in a folder |", "|---|---|---|---|");
		for (const s of plan.sources) L.push(`| ${s.plugin} | ${s.via === "rest" ? `REST \`${s.key}\`` : `database dump (\`${s.key}\`)`} | ${s.folders} | ${s.assigned} |`);
		L.push("", `${plan.folders.length} folder(s) on EmDash, ${Object.keys(plan.assignments).length} file(s) filed.`);
	}
	const notes = [
		plan.multiple ? `${plan.multiple} file(s) were in more than one folder: each goes to the first (plugin order).` : "",
		plan.merged ? `${plan.merged} folder(s) had the same full name as another and were merged.` : "",
		plan.truncated ? `${plan.truncated} name(s) shortened to ${FOLDER_NAME_MAX} characters.` : "",
		plan.orphans ? `${plan.orphans} folder(s) pointed at a missing parent and start at the top level.` : "",
	].filter(Boolean);
	if (notes.length) L.push("", ...notes.map((n) => `- ${n}`));
	if (plan.unreachable.length) L.push("", "Not read (folders left out, not guessed):", "", ...plan.unreachable.map((u) => `- ${u.plugin}: ${u.why}`));
	return L;
}

/**
 * Sources in plugin order (a database dump's FileBird / Real Media Library first, then REST taxonomies) and the
 * media-folder plugins the audit saw whose folders were not found in either (reported, never guessed).
 */
export function folderInputs(dump: { sources?: FolderSource[] } | undefined, rest: { sources?: FolderSource[] } | undefined, pluginSlugs: string[]): { sources: FolderSource[]; unreachable: { plugin: string; why: string }[] } {
	const sources = [...(dump?.sources ?? []), ...(rest?.sources ?? [])];
	const have = new Set(sources.map((s) => s.plugin));
	const unreachable = new Map<string, string>();
	for (const slug of pluginSlugs) {
		const p = FOLDER_PLUGINS[slug];
		if (!p || have.has(p.name)) continue;
		unreachable.set(p.name, p.via.startsWith("none") ? p.via.replace(/^none \((.*)\)$/, "$1") : `active, but no folders found — needs the ${p.via}${p.via.startsWith("database") ? " (put a backup's database.sql in dump/ and run import-dump)" : ""}`);
	}
	return { sources, unreachable: [...unreachable].map(([plugin, why]) => ({ plugin, why })) };
}
