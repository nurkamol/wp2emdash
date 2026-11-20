/**
 * Verify: the Site health plugin (@wp2emdash/health) is registered on the target and its checks are running. Reads the
 * plugin's `status` route with the target's EmDash API token when that token has the `admin` scope (EmDash requires it
 * for private plugin routes), else its public `heartbeat` route (plugin id, version and the time of the last run —
 * nothing else). On a live site the last run must be recent: the checks run every 5 minutes from the Worker's cron.
 */
export const HEALTH_ID = "site-health";
/** A run older than this on a live site means the cron is not running the checks. */
export const STALE_MS = 30 * 60_000;

export interface HealthProbe {
	ok: boolean;
	detail: string;
	lastRunAt?: string;
	overall?: string;
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export async function healthHeartbeat(base: string, o: { fetch: Fetch; token?: string; live: boolean; now?: number }): Promise<HealthProbe> {
	const now = o.now ?? Date.now();
	const api = `${base.replace(/\/$/, "")}/_emdash/api/plugins/${HEALTH_ID}`;
	let data: { lastRunAt?: string | null; overall?: string; version?: string } | undefined;
	let via = "heartbeat";
	if (o.token) {
		try {
			const res = await o.fetch(`${api}/status`, { method: "POST", headers: { authorization: `Bearer ${o.token}`, "content-type": "application/json" }, body: "{}" });
			if (res.ok) {
				data = ((await res.json()) as { data?: typeof data }).data;
				via = "status";
			} else await res.body?.cancel();
		} catch {}
	}
	if (!data) {
		let res: Response;
		try {
			res = await o.fetch(`${api}/heartbeat`);
		} catch (e) {
			return { ok: false, detail: `heartbeat not reachable (${(e as Error).message})` };
		}
		if (res.status === 404) return { ok: false, detail: "plugin not registered on the target (404): deploy the scaffolded project" };
		if (!res.ok) return { ok: false, detail: `heartbeat answered HTTP ${res.status}` };
		data = ((await res.json().catch(() => ({}))) as { data?: typeof data }).data;
	}
	const last = data?.lastRunAt ?? undefined;
	const age = last ? now - Date.parse(last) : Number.POSITIVE_INFINITY;
	const ago = Number.isFinite(age) ? `${Math.round(age / 60_000)} min ago` : "never";
	const base_ = { ...(last ? { lastRunAt: last } : {}), ...(data?.overall ? { overall: data.overall } : {}) };
	const what = `last run ${ago}${data?.overall ? `, overall ${data.overall}` : ""} (${via}${data?.version ? `, v${data.version}` : ""})`;
	if (!o.live) return { ok: true, detail: `registered; ${what}. Not live yet: recency not gated.`, ...base_ };
	if (age > STALE_MS) return { ok: false, detail: `registered, but ${what}: the checks are not running (cron trigger, SELF binding or plugin cron task). Open Plugins → Site health once to reschedule.`, ...base_ };
	return { ok: true, detail: `registered; ${what}`, ...base_ };
}
