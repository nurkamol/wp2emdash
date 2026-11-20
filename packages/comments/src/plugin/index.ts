/**
 * WordPress comments import — EmDash native plugin, loaded in the Worker from `@wp2emdash/comments/plugin`; register it
 * with `commentsPlugin()` from `@wp2emdash/comments` in astro.config.
 *
 * - `import` route (private: EmDash's default `plugins:manage`, so admins only; an API token needs the `admin` scope;
 *   a browser session needs EmDash's `X-EmDash-Request` header): writes a batch of migrated comments as **pending**
 *   (src/import.ts). Called by the kit's load phase only.
 * - `status` route (private): the plugin's id and version, so load can tell "not registered" from "failed".
 *
 * Database access: EmDash's own Kysely handle for the request (`getDb()` from `emdash/runtime`, the same handle EmDash's
 * template helpers use), so the writes go through the site's configured database (D1 with sessions on Workers, SQLite
 * locally). The comment object cache is invalidated after a write, as EmDash's importer does.
 *
 * Logs carry counts only — never names, addresses or comment text.
 */
import { definePlugin, invalidateCommentObjectCache } from "emdash";
import { getDb } from "emdash/runtime";
import { type CommentStore, type ExistingRow, importComments, type StoredRow } from "../import.js";
import { COMMENTS_PLUGIN } from "../meta.js";

const ADMIN_ROLE = 50;
/** D1 binds at most 100 parameters per statement. */
const IN_CHUNK = 90;
const INSERT_CHUNK = 6;

interface Ctx {
	input?: unknown;
	user?: { role: number };
	log?: { info(m: string, d?: Record<string, unknown>): void };
}

const chunks = <T>(list: T[], n: number): T[][] => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

type Db = any;

/** The store over EmDash's database handle. Table names come from validated slugs that exist in `_emdash_collections`. */
export function kyselyStore(db: Db): CommentStore {
	return {
		async collections() {
			const rows: { slug: string }[] = await db.selectFrom("_emdash_collections").select(["slug"]).execute();
			return new Set(rows.map((r) => r.slug));
		},
		async contentIds(collection, ids) {
			const out = new Set<string>();
			for (const part of chunks(ids, IN_CHUNK)) {
				const rows: { id: string }[] = await db.selectFrom(`ec_${collection}`).select(["id"]).where("id", "in", part).where("deleted_at", "is", null).execute();
				for (const r of rows) out.add(r.id);
			}
			return out;
		},
		async existing(ids) {
			const out = new Map<string, ExistingRow>();
			for (const part of chunks(ids, IN_CHUNK)) {
				const rows: { id: string; collection: string; content_id: string; parent_id: string | null; status: string }[] = await db.selectFrom("_emdash_comments").select(["id", "collection", "content_id", "parent_id", "status"]).where("id", "in", part).execute();
				for (const r of rows) out.set(r.id, { id: r.id, collection: r.collection, contentId: r.content_id, parentId: r.parent_id, status: r.status });
			}
			return out;
		},
		async insert(rows: StoredRow[]) {
			for (const part of chunks(rows, INSERT_CHUNK)) await db.insertInto("_emdash_comments").values(part).onConflict((oc: any) => oc.column("id").doNothing()).execute();
		},
	};
}

export function createPlugin() {
	return definePlugin({
		...COMMENTS_PLUGIN,
		capabilities: [],
		routes: {
			import: {
				permission: "plugins:manage",
				methods: ["POST"],
				handler: async (raw: unknown) => {
					const ctx = raw as Ctx;
					if ((ctx.user?.role ?? 0) < ADMIN_ROLE) return { error: "admins only" };
					const r = await importComments(kyselyStore(await getDb()), ctx.input);
					if ("error" in r) return r;
					if (r.created) invalidateCommentObjectCache();
					ctx.log?.info("comments import", { created: r.created, existing: r.results.filter((x) => x.outcome === "exists").length, rejected: r.results.filter((x) => x.outcome === "rejected").length });
					return r;
				},
			},
			status: {
				permission: "plugins:manage",
				handler: async () => ({ plugin: COMMENTS_PLUGIN.id, version: COMMENTS_PLUGIN.version }),
			},
		},
	});
}

export default createPlugin;
