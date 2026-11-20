/**
 * Media folders on the EmDash target (EmDash 1.5 `/_emdash/api/media/folders`, flat; docs/spikes/media-folders-findings.md).
 *
 * - Folders: created by name when missing; one with the same name (trim + NFKC + lowercase, EmDash's own key) is
 *   reused. An editor's folders are never renamed or deleted.
 * - New uploads carry `folderId` (load passes `folderFor(wpId)` to the upload).
 * - Items already on the target (an earlier load, or deduplicated by content) are filed with `PUT /media/{id}` only
 *   while they are still in the Main library: an item an editor filed somewhere is never moved.
 */
import { folderKey, type MediaFolderPlan } from "../../transform/media-folders.js";
import { type EmDashApi, EmDashHttpError } from "./api.js";

export interface FolderResult {
	created: number;
	reused: number;
	filed: number;
	/** Already in the planned folder. */
	inPlace: number;
	/** In another folder (an editor's choice): left alone. */
	kept: number;
	errors: string[];
}

/** Make sure every planned folder exists; returns folder key → id. */
export async function ensureMediaFolders(api: EmDashApi, plan: MediaFolderPlan, result: FolderResult): Promise<Map<string, string>> {
	const ids = new Map<string, string>();
	for (const f of await api.mediaFolders()) if (!ids.has(folderKey(f.name))) ids.set(folderKey(f.name), f.id);
	for (const name of plan.folders) {
		const k = folderKey(name);
		if (ids.has(k)) {
			result.reused++;
			continue;
		}
		try {
			const made = await api.createMediaFolder(name);
			ids.set(k, made.id);
			result.created++;
		} catch (e) {
			// Created meanwhile (or listed under a cursor we missed): look it up once more.
			if (e instanceof EmDashHttpError && e.status === 409) {
				const again = (await api.mediaFolders()).find((f) => folderKey(f.name) === k);
				if (again) {
					ids.set(k, again.id);
					result.reused++;
					continue;
				}
			}
			result.errors.push(`folder "${name}": ${(e as Error).message}`);
		}
	}
	return ids;
}

/**
 * File media already on the target: for each planned attachment whose EmDash item is known (`mediaIdOf`) and still
 * unfiled (`currentFolder` null), set the folder. Each EmDash item is handled once (the first attachment wins).
 */
export async function fileUnfiledMedia(api: EmDashApi, plan: MediaFolderPlan, folders: Map<string, string>, mediaIdOf: (wpId: string) => string | undefined, currentFolder: Map<string, string | null>, result: FolderResult): Promise<void> {
	const done = new Set<string>();
	for (const [wpId, name] of Object.entries(plan.assignments)) {
		const id = mediaIdOf(wpId);
		const folderId = folders.get(folderKey(name));
		if (!id || !folderId || done.has(id)) continue;
		done.add(id);
		if (!currentFolder.has(id)) continue; // not on the target (upload failed): the media check reports it
		const now = currentFolder.get(id) ?? null;
		if (now === folderId) {
			result.inPlace++;
			continue;
		}
		if (now !== null) {
			result.kept++;
			continue;
		}
		try {
			await api.mediaSetFolder(id, folderId);
			currentFolder.set(id, folderId);
			result.filed++;
		} catch (e) {
			result.errors.push(`media ${id} → "${name}": ${(e as Error).message}`);
		}
	}
}

export function folderSummary(r: FolderResult, plan: MediaFolderPlan): string {
	return `${plan.folders.length} folder(s) (${r.created} created, ${r.reused} already there); ${Object.keys(plan.assignments).length} file(s) planned: ${r.filed} filed now, ${r.inPlace} already in place${r.kept ? `, ${r.kept} left where an editor filed them` : ""}`;
}
