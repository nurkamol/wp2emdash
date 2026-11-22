/**
 * What the plugin keeps in its EmDash plugin KV (D1 `options` rows `plugin:site-backups:<key>`): the list of backups
 * (the files themselves are in R2), the run status, the single-flight lock, alert settings, one-time download grants and
 * restore previews. No content, no personal data beyond the admin's display name on a manual backup.
 */
import type { BackupEntry } from "./format.js";
import type { RunStatus } from "./schedule.js";

export interface Kv {
	get<T>(key: string): Promise<T | null>;
	set(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<boolean>;
	list?(prefix?: string): Promise<Array<{ key: string; value: unknown }>>;
	getVersioned?<T>(key: string): Promise<{ value: T; revision: string } | null>;
	compareAndSet?(key: string, expectedRevision: string | null, value: unknown): Promise<{ applied: true; revision: string } | { applied: false }>;
}

export const KEYS = {
	index: "index",
	status: "status",
	lock: "lock",
	settings: "settings",
	download: (token: string) => `dl:${token}`,
	plan: (token: string) => `plan:${token}`,
	/** The restore test: the last result, a run in progress, a pending "Run restore test now" (drill.ts). */
	drill: "drill",
	/** The restore test's own single-flight lock (a backup and a restore test may overlap: the test only reads R2). */
	drillLock: "drill-lock",
} as const;

export interface AlertSettings {
	alertsTo?: string[];
	alerts?: boolean;
}

export const readStatus = async (kv: Kv): Promise<RunStatus> => ({ failures: 0, ...((await kv.get<RunStatus>(KEYS.status)) ?? {}) });
export const readIndex = async (kv: Kv): Promise<BackupEntry[]> => (await kv.get<BackupEntry[]>(KEYS.index)) ?? [];

/** Read-modify-write of the backup list with compare-and-set (the nightly run and a delete hook can overlap). */
export async function updateIndex(kv: Kv, fn: (list: BackupEntry[]) => BackupEntry[]): Promise<BackupEntry[]> {
	const sort = (l: BackupEntry[]) => [...l].sort((a, b) => (a.at < b.at ? 1 : -1));
	if (kv.getVersioned && kv.compareAndSet) {
		for (let i = 0; i < 5; i++) {
			const cur = await kv.getVersioned<BackupEntry[]>(KEYS.index);
			const next = sort(fn(cur?.value ?? []));
			if ((await kv.compareAndSet(KEYS.index, cur ? cur.revision : null, next)).applied) return next;
		}
	}
	const next = sort(fn(await readIndex(kv)));
	await kv.set(KEYS.index, next);
	return next;
}

/** Single flight: one backup or restore at a time (atomic compare-and-set; a crashed run frees it after `ms`). */
export async function acquireLock(kv: Kv, now: number, ms: number, what: string, key: string = KEYS.lock): Promise<boolean> {
	const value = { until: new Date(now + ms).toISOString(), what };
	if (kv.getVersioned && kv.compareAndSet) {
		const cur = await kv.getVersioned<{ until: string }>(key);
		if (cur && Date.parse(cur.value.until) > now) return false;
		return (await kv.compareAndSet(key, cur ? cur.revision : null, value)).applied;
	}
	const cur = await kv.get<{ until: string }>(key);
	if (cur && Date.parse(cur.until) > now) return false;
	await kv.set(key, value);
	return true;
}
export const releaseLock = (kv: Kv, key: string = KEYS.lock) => kv.delete(key);

/** One-time grants (downloads, restore previews): random token, expiry; stale ones are removed when a new one is made. */
export async function grant<T extends object>(kv: Kv, kind: "dl" | "plan", value: T, ms: number, now = Date.now()): Promise<string> {
	const token = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
	for (const { key, value: v } of (await kv.list?.(`${kind}:`)) ?? []) if (!(Date.parse((v as { until?: string })?.until ?? "") >= now)) await kv.delete(key);
	await kv.set(`${kind}:${token}`, { ...value, until: new Date(now + ms).toISOString() });
	return token;
}

/** Redeems a grant once (removed whether or not it is still valid). */
export async function redeem<T>(kv: Kv, kind: "dl" | "plan", token: unknown, now = Date.now()): Promise<T | undefined> {
	if (typeof token !== "string" || !/^[0-9a-f]{48}$/.test(token)) return undefined;
	const g = await kv.get<T & { until: string }>(`${kind}:${token}`);
	if (!g) return undefined;
	await kv.delete(`${kind}:${token}`);
	return Date.parse(g.until) >= now ? g : undefined;
}
