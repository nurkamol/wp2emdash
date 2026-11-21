/**
 * The PageSpeed lab test run: weekly, or soon after an admin's "Run PageSpeed test now". It runs from the cron tick,
 * AFTER the checks (their lock released), because a Lighthouse run takes 10–60 s: a scheduled event may run for up
 * to 15 minutes of wall time and waiting on fetch costs no CPU time, while an admin request's `waitUntil` only lasts
 * 30 s after the response (developers.cloudflare.com/workers/platform/limits). The admin button therefore only
 * stores a request; the next tick (within 5 minutes) runs it, and the page reads the stored result.
 *
 * Mobile and desktop run in parallel (2 subrequests, 90 s limit each). Production only: a staging Worker tests
 * nothing (it would spend the same key's quota on the same domain). Before go-live the domain still shows the old
 * site: runs are kept and marked, and no alert is emailed (as every other alert).
 */
import { labAlertEvents } from "./alerts.js";
import { addRuns, fetchPsi, LAB_EVERY, LAB_LOCK_MS, LAB_RETRY, labDrop, labDue, labKey, type LabRequest, type LabRun, type LabStore, readLab, STRATEGIES, type Strategy } from "./checks/lab.js";
import { acquireLock, deliverAlerts, releaseLock, type RunDeps } from "./run.js";
import { KEYS } from "./store.js";

export interface LabResult {
	ran: boolean;
	why?: "not-due" | "staging" | "no-key" | "locked";
	runs?: LabRun[];
	missing?: Partial<Record<Strategy, string>>;
	alerts?: { sent: number; held: number; notEmailed?: string };
}

export async function runLab(d: RunDeps): Promise<LabResult> {
	const { kv, env, options: o, now } = d;
	if (env.STAGING === "1") return { ran: false, why: "staging" };
	const [stored, request] = await Promise.all([kv.get<LabStore>(KEYS.lab), kv.get<LabRequest>(KEYS.labRequest)]);
	const store = readLab(stored);
	const due = labDue(store, request, now);
	if (!due) return { ran: false, why: "not-due" };
	const key = labKey(env);
	if (!key) {
		// Nothing to call: the Speed tab shows how to add a key. A request is closed so the page stops saying "asked for".
		if (request && !request.done) await kv.set(KEYS.labRequest, { ...request, done: new Date(now).toISOString() });
		return { ran: false, why: "no-key" };
	}
	if (!(await acquireLock(kv, now, KEYS.labLock, LAB_LOCK_MS))) return { ran: false, why: "locked" };
	try {
		const home = `${new URL(o.productionUrl).origin}/`;
		const results = await Promise.all(STRATEGIES.map((s) => fetchPsi(home, s, key, d.fetch, now, { pre: !o.live })));
		const fresh = results.filter((r): r is LabRun => !("missing" in r));
		const missing: Partial<Record<Strategy, string>> = {};
		results.forEach((r, i) => {
			if ("missing" in r) missing[STRATEGIES[i] as Strategy] = r.missing;
		});
		const at = new Date(now).toISOString();
		const before = store.runs;
		const next: LabStore = { v: 1, runs: addRuns(before, fresh, now), last: { at, ...(Object.keys(missing).length ? { missing } : {}) }, next: new Date(now + (fresh.length ? LAB_EVERY : LAB_RETRY)).toISOString() };
		await kv.set(KEYS.lab, next);
		// Close the request only if no newer one arrived meanwhile.
		const latest = await kv.get<LabRequest>(KEYS.labRequest);
		if (latest && !latest.done && (!request || latest.at === request.at)) await kv.set(KEYS.labRequest, { ...latest, done: at });
		const alerts = await deliverAlerts(d, labAlertEvents(o.siteName, labDrop(before, fresh)));
		// Scores and reasons only: never the key or the URL with it.
		d.log?.info("health pagespeed", { trigger: due, runs: fresh.length, ...Object.fromEntries(fresh.map((r) => [`${r.strategy}Perf`, r.perf ?? null])), ...(Object.keys(missing).length ? { missing: Object.values(missing).join(",") } : {}) });
		return { ran: true, runs: fresh, missing, alerts };
	} finally {
		await releaseLock(kv, KEYS.labLock);
	}
}
