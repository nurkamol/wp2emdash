/**
 * D1 Time Travel bookmark before a write to a live production database (load --force after go-live).
 *
 * Time Travel keeps every D1 database restorable to any minute of the last 30 days (Workers Paid; 7 on Free) with no
 * setup; a bookmark names one point. The kit asks the API for the current bookmark — the same call
 * `wrangler d1 time-travel info <db>` makes (GET /accounts/:account/d1/database/:id/time_travel/bookmark, verified
 * against wrangler 4.163.0: docs/spikes/single-env-findings.md) — records it, and prints the restore command. R2 media
 * is NOT covered (load only adds media, deduplicated by sha1; it never deletes or replaces a stored file).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { credentialsFor } from "../commands/provision.js";

const API = "https://api.cloudflare.com/client/v4";

export interface D1Bookmark {
	at: string;
	database: string;
	databaseId: string;
	bookmark: string;
	reason: string;
}

export async function d1Bookmark(o: { token: string; accountId: string; databaseId: string }, fetcher: typeof fetch = fetch): Promise<{ bookmark: string } | { error: string }> {
	try {
		const res = await fetcher(`${API}/accounts/${o.accountId}/d1/database/${o.databaseId}/time_travel/bookmark`, { headers: { authorization: `Bearer ${o.token}` } });
		const j = (await res.json().catch(() => ({}))) as { success?: boolean; result?: { bookmark?: string }; errors?: { message: string }[] };
		if (!res.ok || j.success === false || !j.result?.bookmark) return { error: j.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}` };
		return { bookmark: j.result.bookmark };
	} catch (e) {
		return { error: (e as Error).message };
	}
}

/** Run in the project directory (wrangler.jsonc names the database), with the build token in the environment. */
export const restoreCommand = (database: string, bookmark: string) => `npx wrangler d1 time-travel restore ${database} --bookmark=${bookmark}`;

/** Append to sites/<slug>/load/d1-bookmarks.jsonl (newest last). */
export function recordBookmark(file: string, b: D1Bookmark): void {
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, `${JSON.stringify(b)}\n`);
}

/**
 * Before load writes to production after go-live: refuse without --force (edits made in the admin since launch would be
 * overwritten); with --force, take and record a Time Travel bookmark first, and refuse when none can be taken.
 */
export async function guardLiveProductionWrite(
	o: { live: boolean; force: boolean; slug: string; cf: { accountId?: string; production?: { accountId?: string; d1?: { name?: string; id?: string } } }; vars: Record<string, string | undefined>; bookmarksFile: string; now?: () => Date },
	fetcher: typeof fetch = fetch,
): Promise<{ ok: true; bookmark?: D1Bookmark; restore?: string } | { ok: false; detail: string }> {
	if (!o.live) return { ok: true };
	if (!o.force)
		return {
			ok: false,
			detail: `Production is live: a reload overwrites content edited in the admin since launch. Rerun with --force (WP2EMDASH_LOAD_TARGET=production pnpm wp2emdash run ${o.slug} load --force); a D1 Time Travel bookmark is recorded first so the database can be restored.`,
		};
	const db = o.cf.production?.d1;
	if (!db?.id || !db.name) return { ok: false, detail: "No production D1 recorded in cloudflare.json: cannot take a Time Travel bookmark, so nothing is written" };
	const { token, accountId } = credentialsFor("production", o.vars, o.cf as never);
	if (!token || !accountId) return { ok: false, detail: "CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID (or *_PRODUCTION) missing: cannot take a Time Travel bookmark, so nothing is written" };
	const r = await d1Bookmark({ token, accountId, databaseId: db.id }, fetcher);
	if ("error" in r) return { ok: false, detail: `Time Travel bookmark failed (${r.error}): nothing is written. The token needs D1 Edit (docs/cloudflare-api-token.md).` };
	const b: D1Bookmark = { at: (o.now ?? (() => new Date()))().toISOString(), database: db.name, databaseId: db.id, bookmark: r.bookmark, reason: "load --force into live production" };
	recordBookmark(o.bookmarksFile, b);
	return { ok: true, bookmark: b, restore: restoreCommand(db.name, r.bookmark) };
}
