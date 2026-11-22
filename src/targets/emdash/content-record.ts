/**
 * What load wrote to each EmDash entry, so a later load can tell an editor's change in the EmDash admin from its own
 * (load/content.<target>.json). Recorded per WordPress entry (`<type>:<wpId>`): the EmDash entry id, its `version` and
 * `updatedAt` after load's last write, and the WordPress side it came from (modified date, raw export hash from
 * raw/manifest.json).
 *
 * EmDash 1.5 (docs/spikes/content-changes-findings.md): every write to an entry row — save, draft revision, publish,
 * unpublish, schedule — sets `version = version + 1` and a new `updated_at`; both are on every item of
 * GET /_emdash/api/content/<collection> (ContentItem.version / updatedAt). The `_rev` token is base64("version:updatedAt").
 *
 * On the next load an entry is:
 * - new        no record (first load, or adopted): written.
 * - unchanged  same version and updatedAt as recorded: written (WordPress changes flow in).
 * - edited     changed in the admin, unchanged in WordPress: kept (nothing new to bring); --overwrite-edited replaces it.
 * - conflict   changed in the admin and in WordPress: kept and reported; --overwrite-edited replaces it with WordPress.
 */
export interface ContentRecordEntry {
	collection: string;
	id: string;
	version?: number;
	updatedAt?: string;
	/** WordPress modified date (GMT) of what was loaded. */
	wpModified?: string;
	/** raw/manifest.json rawHash of what was loaded. */
	wpHash?: string;
	loadedAt: string;
}
export interface ContentRecord {
	version: 1;
	entries: Record<string, ContentRecordEntry>;
}

export type EditState = "new" | "unchanged" | "edited" | "conflict";

export function emptyRecord(): ContentRecord {
	return { version: 1, entries: {} };
}

/** Changed in the EmDash admin since load wrote it: its version or updatedAt moved on (same entry id). */
export function editedInAdmin(rec: ContentRecordEntry | undefined, current: { id: string; version?: number; updatedAt?: string } | undefined): boolean {
	if (!rec || !current || rec.id !== current.id) return false;
	if (rec.version === undefined && rec.updatedAt === undefined) return false;
	if (rec.version !== undefined && current.version !== undefined && rec.version !== current.version) return true;
	return rec.updatedAt !== undefined && current.updatedAt !== undefined && rec.updatedAt !== current.updatedAt;
}

/** Changed in WordPress since that load: its raw export hash (when both known), else its modified date. */
export function changedInWordPress(rec: ContentRecordEntry | undefined, wp: { modified?: string; hash?: string }): boolean {
	if (!rec) return false;
	if (rec.wpHash && wp.hash) return rec.wpHash !== wp.hash;
	if (rec.wpModified && wp.modified) return rec.wpModified !== wp.modified;
	return false;
}

export function editState(rec: ContentRecordEntry | undefined, current: { id: string; version?: number; updatedAt?: string } | undefined, wp: { modified?: string; hash?: string }): EditState {
	if (!rec || !current || rec.id !== current.id) return "new";
	if (!editedInAdmin(rec, current)) return "unchanged";
	return changedInWordPress(rec, wp) ? "conflict" : "edited";
}

/**
 * The record after a load: each entry load wrote, as the target shows it now (read back after every write of the run).
 * Entries in `keep` (left as the editor had them, or whose write failed) keep their previous record, so they stay
 * flagged on the next load.
 */
export function updateRecord(record: ContentRecord, written: { key: string; collection: string; id: string; item?: { version?: number; updatedAt?: string }; wpModified?: string; wpHash?: string }[], keep: Set<string>, now = new Date().toISOString()): ContentRecord {
	const entries = { ...record.entries };
	for (const w of written) {
		if (keep.has(w.key) || !w.item) continue;
		entries[w.key] = { collection: w.collection, id: w.id, ...(w.item.version !== undefined ? { version: w.item.version } : {}), ...(w.item.updatedAt ? { updatedAt: w.item.updatedAt } : {}), ...(w.wpModified ? { wpModified: w.wpModified } : {}), ...(w.wpHash ? { wpHash: w.wpHash } : {}), loadedAt: now };
	}
	return { version: 1, entries };
}

/** What load does with an entry: write it, or keep the editor's version (unless overwrite). */
export function shouldWrite(state: EditState, overwrite: boolean): boolean {
	return overwrite || state === "new" || state === "unchanged";
}
