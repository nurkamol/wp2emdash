/**
 * The import itself, independent of the database driver (the plugin passes a store over EmDash's Kysely handle; tests
 * pass an in-memory one).
 *
 * Rules (mirroring EmDash's own `importCommentsFromPlugin`, plus checks it leaves out):
 * - Every row is written **pending**, whatever its WordPress status: making a comment public is EmDash's moderation's
 *   job (the kit calls `POST /_emdash/api/admin/comments/bulk` with `approve`, which also purges cached pages).
 * - Idempotent by id: the kit sends deterministic ids, a row that already exists is reported with its current status
 *   and never touched (an editor's moderation decision stays).
 * - The entry must exist in its collection and not be in the trash; a reply's parent must exist (already stored or
 *   earlier in the batch), belong to the same entry and be a top-level comment (EmDash nests one level).
 * - Dates are kept (`created_at` = `updated_at` = the WordPress date, as EmDash's importer does); IP hash, user agent
 *   and user id stay empty.
 * - Rejections carry a reason without personal data.
 */

export const MAX_BATCH = 50;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const SLUG = /^[a-z][a-z0-9_]*$/;
const MAX_TEXT = 65_535;

export interface ImportRow {
	id: string;
	wpId: number;
	collection: string;
	contentId: string;
	parentId: string | null;
	authorName: string;
	authorEmail: string;
	body: string;
	createdAt: string;
}

export interface StoredRow {
	id: string;
	collection: string;
	content_id: string;
	parent_id: string | null;
	author_name: string;
	author_email: string;
	author_user_id: null;
	body: string;
	status: "pending";
	ip_hash: null;
	user_agent: null;
	moderation_metadata: string;
	created_at: string;
	updated_at: string;
}

export interface ExistingRow {
	id: string;
	collection: string;
	contentId: string;
	parentId: string | null;
	status: string;
}

export interface CommentStore {
	/** Collection slugs the site has. */
	collections(): Promise<Set<string>>;
	/** Which of these entry ids exist in the collection (not in the trash). */
	contentIds(collection: string, ids: string[]): Promise<Set<string>>;
	/** Comments already stored, by id. */
	existing(ids: string[]): Promise<Map<string, ExistingRow>>;
	/** Insert rows; a row whose id exists is left alone. */
	insert(rows: StoredRow[]): Promise<void>;
}

export type Outcome = { id: string; outcome: "created" } | { id: string; outcome: "exists"; status: string } | { id: string; outcome: "rejected"; reason: string };

const str = (v: unknown, max = MAX_TEXT): string | undefined => (typeof v === "string" && v.length <= max ? v : undefined);

/** Check one row's shape; undefined + reason when it is not importable. */
export function parseRow(v: unknown): { row: ImportRow } | { id?: string; reason: string } {
	if (!v || typeof v !== "object") return { reason: "not an object" };
	const o = v as Record<string, unknown>;
	const id = str(o.id, 26);
	if (!id || !ULID.test(id)) return { reason: "id is not a ULID" };
	const bad = (reason: string) => ({ id, reason });
	if (typeof o.wpId !== "number" || !Number.isInteger(o.wpId) || o.wpId <= 0) return bad("wpId is not a positive integer");
	const collection = str(o.collection, 63);
	if (!collection || !SLUG.test(collection)) return bad("collection is not a collection slug");
	const contentId = str(o.contentId, 64);
	if (!contentId) return bad("contentId missing");
	const parentId = o.parentId === null || o.parentId === undefined ? null : str(o.parentId, 26);
	if (parentId === undefined || (parentId !== null && !ULID.test(parentId))) return bad("parentId is not a ULID");
	if (parentId === id) return bad("a comment cannot answer itself");
	const authorName = str(o.authorName, 1000)?.trim();
	if (!authorName) return bad("authorName empty");
	const authorEmail = str(o.authorEmail, 254);
	if (authorEmail === undefined) return bad("authorEmail is not a string of at most 254 characters");
	const body = str(o.body);
	if (!body?.trim()) return bad("body empty");
	const createdAt = str(o.createdAt, 40);
	if (!createdAt || Number.isNaN(Date.parse(createdAt))) return bad("createdAt is not a date");
	return { row: { id, wpId: o.wpId, collection, contentId, parentId, authorName, authorEmail, body, createdAt: new Date(createdAt).toISOString() } };
}

/** Import one batch (at most MAX_BATCH rows, oldest first so parents precede their replies). */
export async function importComments(store: CommentStore, input: unknown): Promise<{ results: Outcome[]; created: number } | { error: string }> {
	const list = (input as { comments?: unknown } | undefined)?.comments;
	if (!Array.isArray(list)) return { error: "expected { comments: [...] }" };
	if (list.length > MAX_BATCH) return { error: `at most ${MAX_BATCH} comments per request` };
	const parsed = list.map(parseRow);
	const rows = parsed.flatMap((p) => ("row" in p ? [p.row] : []));
	const known = await store.existing([...new Set(rows.flatMap((r) => [r.id, ...(r.parentId ? [r.parentId] : [])]))]);
	const collections = await store.collections();
	const entries = new Map<string, Set<string>>();
	for (const c of new Set(rows.map((r) => r.collection))) if (collections.has(c)) entries.set(c, await store.contentIds(c, [...new Set(rows.filter((r) => r.collection === c).map((r) => r.contentId))]));
	const accepted = new Map<string, ImportRow>();
	const results: Outcome[] = [];
	const insert: StoredRow[] = [];
	for (const p of parsed) {
		if (!("row" in p)) {
			results.push({ id: p.id ?? "", outcome: "rejected", reason: p.reason });
			continue;
		}
		const r = p.row;
		const have = known.get(r.id);
		if (have) {
			results.push({ id: r.id, outcome: "exists", status: have.status });
			continue;
		}
		const reject = (reason: string) => results.push({ id: r.id, outcome: "rejected", reason });
		if (!collections.has(r.collection)) {
			reject(`collection ${r.collection} does not exist`);
			continue;
		}
		if (!entries.get(r.collection)?.has(r.contentId)) {
			reject(`entry ${r.contentId} not found in ${r.collection}`);
			continue;
		}
		if (r.parentId) {
			const parent = known.get(r.parentId) ?? accepted.get(r.parentId);
			const pc = parent ? ("contentId" in parent ? { collection: parent.collection, contentId: parent.contentId, parentId: parent.parentId } : undefined) : undefined;
			if (!pc) {
				reject("parent comment not found");
				continue;
			}
			if (pc.collection !== r.collection || pc.contentId !== r.contentId) {
				reject("parent comment belongs to another entry");
				continue;
			}
			if (pc.parentId) {
				reject("parent comment is a reply (EmDash nests one level)");
				continue;
			}
		}
		accepted.set(r.id, r);
		insert.push({
			id: r.id,
			collection: r.collection,
			content_id: r.contentId,
			parent_id: r.parentId,
			author_name: r.authorName,
			author_email: r.authorEmail,
			author_user_id: null,
			body: r.body,
			status: "pending",
			ip_hash: null,
			user_agent: null,
			moderation_metadata: JSON.stringify({ importedFrom: "wordpress", wpCommentId: r.wpId }),
			created_at: r.createdAt,
			updated_at: r.createdAt,
		});
		results.push({ id: r.id, outcome: "created" });
	}
	if (insert.length) await store.insert(insert);
	return { results, created: insert.length };
}
