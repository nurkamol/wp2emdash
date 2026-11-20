/**
 * Load's comments step (docs/spikes/comments-findings.md): ir/comments.json → the target's comments table.
 *
 * 1. Every comment not yet settled goes to the kit's import route (@wp2emdash/comments), 50 per request, oldest first.
 *    The route writes **pending** rows with the WordPress date and thread, keyed by a deterministic id.
 * 2. Comments approved in WordPress are then approved through EmDash's own bulk moderation route (100 per request),
 *    which also purges the cached pages of their entries.
 * 3. The id-map (`comments`: WordPress id → EmDash id, wanted status, settled) makes reruns idempotent: a settled
 *    comment is never sent again, so an editor's later moderation (spam, trash, delete) is kept.
 * 4. Read back: every comment on the target is listed by status; per entry, the imported comments must be there with
 *    their status, except those an editor changed after an earlier load (reported, not failed).
 *
 * Nothing here prints names, e-mail addresses or comment text: details are counts, entry keys and WordPress ids.
 */
import type { CommentsPlan, IrComment } from "../../transform/comments.js";
import type { EmDashApi } from "./api.js";

export interface CommentsFile extends CommentsPlan {
	items: IrComment[];
}

export interface CommentMapEntry {
	id: string;
	status: "approved" | "pending";
	/** The comment reached its wanted status on the target; never sent again. */
	done: boolean;
}

export type CommentsApi = Pick<EmDashApi, "commentsPluginStatus" | "importComments" | "moderateComments" | "commentIds">;

export interface CommentsLoadResult {
	ok: boolean;
	detail: string;
	created: number;
	existing: number;
	approved: number;
	editorChanged: number;
}

const chunks = <T>(list: T[], n: number): T[][] => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

export async function loadComments(api: CommentsApi, file: CommentsFile, entryId: (key: string) => string | undefined, map: Record<string, CommentMapEntry>, save: () => void): Promise<CommentsLoadResult> {
	const result: CommentsLoadResult = { ok: false, detail: "", created: 0, existing: 0, approved: 0, editorChanged: 0 };
	if (!file.migrate || !file.items.length) return { ...result, ok: true, detail: file.migrate ? "no comments to import" : "not migrated by decision" };
	try {
		await api.commentsPluginStatus();
	} catch (e) {
		const code = (e as { code?: string }).code;
		return { ...result, detail: code === "NOT_FOUND" ? "the import route (@wp2emdash/comments) is not on the target: rerun scaffold, then restart the dev server or deploy" : code === "INSUFFICIENT_SCOPE" ? "the API token needs the admin scope (plugin routes and comment moderation)" : (e as Error).message };
	}
	const errors: string[] = [];
	const doneBefore = new Set(Object.entries(map).filter(([, m]) => m.done).map(([wp]) => wp));
	const toSend = file.items.filter((c) => !doneBefore.has(String(c.wpId))).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.wpId - b.wpId);
	const rows = toSend.flatMap((c) => {
		const contentId = entryId(c.entry);
		if (!contentId) {
			errors.push(`#${c.wpId}: entry ${c.entry} not on the target`);
			return [];
		}
		return [{ c, row: { id: c.id, wpId: c.wpId, collection: c.collection, contentId, parentId: c.parentId, authorName: c.authorName, authorEmail: c.authorEmail, body: c.body, createdAt: c.createdAt } }];
	});
	const approve: { c: IrComment }[] = [];
	for (const batch of chunks(rows, 50)) {
		try {
			const r = await api.importComments(batch.map((b) => b.row));
			if (r.error) {
				errors.push(r.error);
				continue;
			}
			for (const o of r.results) {
				const b = batch.find((x) => x.row.id === o.id);
				if (!b) continue;
				const key = String(b.c.wpId);
				const known = map[key];
				if (o.outcome === "rejected") {
					errors.push(`#${b.c.wpId}: ${o.reason}`);
					continue;
				}
				if (o.outcome === "created") result.created++;
				else result.existing++;
				const pendingNow = o.outcome === "created" || o.status === "pending";
				// A row that was there before the id-map knew it (or that an earlier run left pending): approve it only
				// when this kit created it and never finished; otherwise it is an editor's to moderate.
				const ours = o.outcome === "created" || (known && !known.done);
				if (b.c.status === "approved" && pendingNow && ours) {
					map[key] = { id: b.c.id, status: "approved", done: false };
					approve.push(b);
				} else map[key] = { id: b.c.id, status: b.c.status, done: true };
			}
			save();
		} catch (e) {
			errors.push((e as Error).message);
		}
	}
	for (const batch of chunks(approve, 100)) {
		try {
			await api.moderateComments(batch.map((b) => b.c.id), "approve");
			for (const b of batch) map[String(b.c.wpId)] = { id: b.c.id, status: "approved", done: true };
			result.approved += batch.length;
			save();
		} catch (e) {
			errors.push(`approve: ${(e as Error).message}`);
		}
	}

	// ── Read back: per entry, the imported comments with their status ───────────────────────────────────────
	const onTarget = new Map<string, { contentId: string; status: string }>();
	try {
		for (const status of ["approved", "pending", "spam", "trash"] as const) for (const col of new Set(file.items.map((c) => c.collection))) for (const c of await api.commentIds(status, col)) onTarget.set(c.id, { contentId: c.contentId, status: c.status });
	} catch (e) {
		errors.push(`read back: ${(e as Error).message}`);
	}
	const wrong: string[] = [];
	const byEntry = new Map<string, { want: number; have: number }>();
	for (const c of file.items) {
		const e = byEntry.get(c.entry) ?? { want: 0, have: 0 };
		e.want++;
		const t = onTarget.get(c.id);
		const contentId = entryId(c.entry);
		if (t && t.status === c.status && t.contentId === contentId) e.have++;
		else if (doneBefore.has(String(c.wpId))) result.editorChanged++;
		else wrong.push(`#${c.wpId} on ${c.entry}: ${t ? (t.contentId !== contentId ? "on another entry" : `${t.status}, expected ${c.status}`) : "missing"}`);
		byEntry.set(c.entry, e);
	}
	result.ok = errors.length === 0 && wrong.length === 0;
	const approvedTotal = file.items.filter((c) => c.status === "approved").length;
	result.detail =
		[...errors.slice(0, 4), ...wrong.slice(0, 4)].join("; ") ||
		`${file.items.length} comments on ${byEntry.size} entr${byEntry.size === 1 ? "y" : "ies"} (${approvedTotal} approved${file.items.length - approvedTotal ? `, ${file.items.length - approvedTotal} pending` : ""}): ${result.created} written, ${result.existing} already there, ${result.approved} approved through EmDash's moderation${result.editorChanged ? `; ${result.editorChanged} changed by an editor since an earlier load (kept)` : ""}`;
	return result;
}
