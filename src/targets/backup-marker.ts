/**
 * Backup markers: before the kit changes a live site (load --force into live production, golive), it records the moment
 * in the site's own R2 bucket under `backups/markers/` — reason, time, and the D1 Time Travel bookmark when it took one,
 * with the command to go back. The Backups admin page (@wp2emdash/backups) lists them under "Full site".
 *
 * Written with Cloudflare's R2 object API (`PUT /accounts/:account/r2/buckets/:bucket/objects/:key`, the call
 * `wrangler r2 object put` makes — wrangler 4.163.0, docs/spikes/backup-findings.md) with the build token (token A has
 * Workers R2 Storage Edit). Best effort: a marker that cannot be written never blocks the change (the D1 bookmark is
 * the safety net; the marker only makes it visible in the admin).
 */
import { MARKER_PREFIX, type KitMarker } from "../../packages/backups/src/format.js";

const API = "https://api.cloudflare.com/client/v4";

/** `backups/markers/<20261120T081500Z>-<reason-slug>.json` */
export function markerKey(at: Date, reason: string): string {
	const stamp = at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
	const slug = reason.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "change";
	return `${MARKER_PREFIX}${stamp}-${slug}.json`;
}

export async function writeBackupMarker(o: { token: string; accountId: string; bucket: string; marker: KitMarker }, fetcher: typeof fetch = fetch): Promise<{ key: string } | { error: string }> {
	const key = markerKey(new Date(o.marker.at), o.marker.reason);
	try {
		const res = await fetcher(`${API}/accounts/${o.accountId}/r2/buckets/${encodeURIComponent(o.bucket)}/objects/${key.split("/").map(encodeURIComponent).join("/")}`, { method: "PUT", headers: { authorization: `Bearer ${o.token}`, "content-type": "application/json" }, body: JSON.stringify(o.marker) });
		if (!res.ok) {
			const j = (await res.json().catch(() => ({}))) as { errors?: { message: string }[] };
			return { error: j.errors?.map((e) => e.message).join("; ") || `HTTP ${res.status}` };
		}
		await res.body?.cancel();
		return { key };
	} catch (e) {
		return { error: (e as Error).message };
	}
}
