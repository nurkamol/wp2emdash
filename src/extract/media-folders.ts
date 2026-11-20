/**
 * Media folders from WordPress media-folder plugins (docs/spikes/media-folders-findings.md).
 *
 * Two ways in, both read-only and with no credential beyond what extract already uses:
 * - REST: taxonomies registered for attachments with `show_in_rest` (`/wp/v2/taxonomies?type=attachment`) — Enhanced
 *   Media Library (`media_category`), Folders by Premio (`media_folder`), HappyFiles (`happyfiles_category`) and any
 *   other attachment taxonomy — with their terms (hierarchy) and each attachment's term ids (`/wp/v2/media`).
 * - A database dump (import-options): FileBird (`fbv`, `fbv_attachment_folder`) and Real Media Library
 *   (`realmedialibrary`, `realmedialibrary_posts`), which keep folders in their own tables, out of REST.
 *
 * Only folder names, their parents and attachment ids are kept: nothing personal (no owners, no user ids).
 */
import { readTablesFromDump } from "./sql-options.js";

export interface RawFolder {
	id: number;
	name: string;
	/** 0 = top level. */
	parent: number;
}

/** One plugin's folders and which attachments sit in which folder. */
export interface FolderSource {
	/** Plugin label (FileBird, Real Media Library, Enhanced Media Library, …). */
	plugin: string;
	via: "rest" | "dump";
	/** Taxonomy slug (REST) or table (dump). */
	key: string;
	folders: RawFolder[];
	/** WordPress attachment id → folder ids (in the plugin's own order). */
	assignments: Record<string, number[]>;
}

/** Media-folder plugins by taxonomy slug (REST) — anything else registered for attachments is read too, labelled by its name. */
export const FOLDER_TAXONOMIES: Record<string, string> = {
	media_category: "Enhanced Media Library",
	media_folder: "Folders (Premio)",
	happyfiles_category: "HappyFiles",
	wf_attachment_folders: "Wicked Folders",
};

/** Plugin slugs (fingerprint) whose folders the kit reads, and where. Anything detected without data → reported. */
export const FOLDER_PLUGINS: Record<string, { name: string; via: string }> = {
	filebird: { name: "FileBird", via: "database dump (fbv tables)" },
	"filebird-pro": { name: "FileBird", via: "database dump (fbv tables)" },
	"real-media-library-lite": { name: "Real Media Library", via: "database dump (realmedialibrary tables)" },
	"real-media-library": { name: "Real Media Library", via: "database dump (realmedialibrary tables)" },
	"enhanced-media-library": { name: "Enhanced Media Library", via: "REST taxonomy media_category" },
	folders: { name: "Folders (Premio)", via: "REST taxonomy media_folder" },
	happyfiles: { name: "HappyFiles", via: "REST taxonomy happyfiles_category" },
	"happyfiles-pro": { name: "HappyFiles", via: "REST taxonomy happyfiles_category" },
	"wicked-folders": { name: "Wicked Folders", via: "REST taxonomy wf_attachment_folders" },
	"media-library-plus": { name: "Media Library Folders (Max Foundry)", via: "none (folders are real directories; not read)" },
	catfolders: { name: "CatFolders", via: "none (own tables; not read)" },
};

/** `/wp/v2/taxonomies?type=attachment` → the taxonomies to read (object keyed by slug, or an array). */
export function attachmentTaxonomies(body: unknown): { slug: string; name: string; restBase: string }[] {
	const list = Array.isArray(body) ? body : body && typeof body === "object" ? Object.values(body) : [];
	return (list as Record<string, unknown>[])
		.filter((t) => t && typeof t.slug === "string" && (!Array.isArray(t.types) || (t.types as unknown[]).includes("attachment")))
		.map((t) => ({ slug: String(t.slug), name: FOLDER_TAXONOMIES[String(t.slug)] ?? String(t.name ?? t.slug), restBase: String(t.rest_base || t.slug) }));
}

/** A taxonomy's terms (`/wp/v2/<rest_base>`) and media rows (`/wp/v2/media`, the term ids under `rest_base`) → a source. */
export function folderSourceFromRest(tax: { slug: string; name: string; restBase: string }, terms: { id: number; name: string; parent?: number }[], media: Record<string, unknown>[]): FolderSource {
	const known = new Set(terms.map((t) => t.id));
	const assignments: Record<string, number[]> = {};
	for (const m of media) {
		const ids = (Array.isArray(m[tax.restBase]) ? (m[tax.restBase] as unknown[]) : []).map(Number).filter((n) => known.has(n));
		if (ids.length && m.id != null) assignments[String(m.id)] = ids;
	}
	return { plugin: tax.name, via: "rest", key: tax.slug, folders: terms.map((t) => ({ id: t.id, name: decodeEntities(t.name), parent: Number(t.parent ?? 0) || 0 })), assignments };
}

/** Rows of the FileBird / Real Media Library tables (readTablesFromDump) → sources. */
export function folderSourcesFromTables(tables: Record<string, Record<string, string | null>[]>): FolderSource[] {
	const out: FolderSource[] = [];
	const num = (v: string | null | undefined) => Number.parseInt(String(v ?? "0"), 10) || 0;
	const group = (rows: Record<string, string | null>[], att: string, fid: string, order?: string) => {
		const a: Record<string, number[]> = {};
		const sorted = order ? [...rows].sort((x, y) => num(x[order]) - num(y[order])) : rows;
		for (const r of sorted) {
			const k = String(num(r[att]));
			if (k === "0" || !num(r[fid])) continue;
			if (!(a[k] ??= []).includes(num(r[fid]))) a[k].push(num(r[fid]));
		}
		return a;
	};
	if (tables.fbv?.length) {
		// FileBird: type 0 = folder (1 = a "collection" in some versions — kept, it holds attachments the same way).
		const folders = tables.fbv.filter((r) => r.name != null).map((r) => ({ id: num(r.id), name: decodeEntities(String(r.name)), parent: num(r.parent) }));
		out.push({ plugin: "FileBird", via: "dump", key: "fbv", folders, assignments: group(tables.fbv_attachment_folder ?? [], "attachment_id", "folder_id") });
	}
	if (tables.realmedialibrary?.length) {
		// Real Media Library: parent -1 = top level. Shortcuts (isShortcut ≠ 0) are the same file shown in another folder:
		// the real folder comes first.
		const folders = tables.realmedialibrary.filter((r) => r.name != null).map((r) => ({ id: num(r.id), name: decodeEntities(String(r.name)), parent: Math.max(0, num(r.parent)) }));
		const rows = [...(tables.realmedialibrary_posts ?? [])].sort((x, y) => num(x.isShortcut) - num(y.isShortcut));
		out.push({ plugin: "Real Media Library", via: "dump", key: "realmedialibrary", folders, assignments: group(rows, "attachment", "fid") });
	}
	return out;
}

export const FOLDER_TABLES = ["fbv", "fbv_attachment_folder", "realmedialibrary", "realmedialibrary_posts"];

/** FileBird and Real Media Library folders from a database dump (only their four tables are parsed). */
export async function folderSourcesFromDump(file: string): Promise<FolderSource[]> {
	return folderSourcesFromTables(await readTablesFromDump(file, FOLDER_TABLES));
}

function decodeEntities(s: string): string {
	return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/g, "'").replace(/&#8211;/g, "–").replace(/&#8217;/g, "’");
}
