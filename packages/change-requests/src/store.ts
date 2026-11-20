/**
 * What the plugin keeps in EmDash plugin KV (one D1 `options` row per key, JSON):
 * - `req:<id>`: each request (title, description, page, status, timeline, attachment names; the requester's name and
 *   email). These rows — and only these — go into the Backups plugin's nightly backups.
 * - `seq`: the last request number (#1, #2, …).
 * - `dl:<token>`: one-time download grants (5 minutes), `ticket:<user>`: which request the upload page opens with
 *   (30 minutes). Short-lived, never backed up.
 * - `log`: delivery results (email / webhook: ok or a reason — never addresses, content or secrets).
 */
import { type ChangeRequest, ID_PATTERN } from "./model.js";
import { REQUEST_PREFIX } from "./meta.js";

export interface Kv {
	get<T>(key: string): Promise<T | null>;
	set(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<boolean>;
	list?(prefix?: string): Promise<Array<{ key: string; value: unknown }>>;
	getVersioned?<T>(key: string): Promise<{ value: T; revision: string } | null>;
	compareAndSet?(key: string, expectedRevision: string | null, value: unknown): Promise<{ applied: true; revision: string } | { applied: false }>;
}

export const reqKey = (id: string) => `${REQUEST_PREFIX}${id}`;

export async function getRequest(kv: Kv, id: unknown): Promise<ChangeRequest | null> {
	if (typeof id !== "string" || !ID_PATTERN.test(id)) return null;
	return kv.get<ChangeRequest>(reqKey(id));
}

export const putRequest = (kv: Kv, r: ChangeRequest) => kv.set(reqKey(r.id), r);

export async function listRequests(kv: Kv): Promise<ChangeRequest[]> {
	return ((await kv.list?.(REQUEST_PREFIX)) ?? []).map((e) => e.value as ChangeRequest).filter((r) => r && typeof r.id === "string" && ID_PATTERN.test(r.id));
}

/** The next request number; compare-and-set where EmDash offers it, so two requests never share a number. */
export async function nextNumber(kv: Kv, list?: ChangeRequest[]): Promise<number> {
	const floor = Math.max(0, ...(list ?? []).map((r) => r.number || 0));
	if (kv.getVersioned && kv.compareAndSet) {
		for (let i = 0; i < 5; i++) {
			const cur = await kv.getVersioned<number>("seq");
			const n = Math.max(cur?.value ?? 0, floor) + 1;
			if ((await kv.compareAndSet("seq", cur?.revision ?? null, n)).applied) return n;
		}
	}
	const n = Math.max((await kv.get<number>("seq")) ?? 0, floor) + 1;
	await kv.set("seq", n);
	return n;
}

export type GrantKind = "dl" | "ticket";

/** One-time grants: a random 192-bit token with an expiry; expired ones are removed when a new one is made. */
export async function grant<T extends object>(kv: Kv, kind: "dl", value: T, ms: number, now = Date.now()): Promise<string> {
	const token = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
	for (const { key, value: v } of (await kv.list?.(`${kind}:`)) ?? []) if (!(Date.parse((v as { until?: string })?.until ?? "") >= now)) await kv.delete(key);
	await kv.set(`${kind}:${token}`, { ...value, until: new Date(now + ms).toISOString() });
	return token;
}

/** Redeems a grant once (removed whether or not it is still valid). */
export async function redeem<T>(kv: Kv, kind: "dl", token: unknown, now = Date.now()): Promise<T | undefined> {
	if (typeof token !== "string" || !/^[0-9a-f]{48}$/.test(token)) return undefined;
	const g = await kv.get<T & { until: string }>(`${kind}:${token}`);
	if (!g) return undefined;
	await kv.delete(`${kind}:${token}`);
	return Date.parse(g.until) >= now ? g : undefined;
}

const userKey = (user: string) => user.replace(/[^\w@.-]/g, "").slice(0, 80);

/** The request the upload page should open with, for this person (30 minutes). */
export async function setTicket(kv: Kv, user: string, request: string, now = Date.now()): Promise<void> {
	await kv.set(`ticket:${userKey(user)}`, { request, until: new Date(now + 30 * 60_000).toISOString() });
}
export async function getTicket(kv: Kv, user: string, now = Date.now()): Promise<string | undefined> {
	const t = await kv.get<{ request: string; until: string }>(`ticket:${userKey(user)}`);
	return t && Date.parse(t.until) >= now ? t.request : undefined;
}

export interface DeliveryLog {
	at: string;
	what: string;
	ok: boolean;
	reason?: string;
}
export async function logDelivery(kv: Kv, e: DeliveryLog): Promise<void> {
	const log = (await kv.get<DeliveryLog[]>("log")) ?? [];
	await kv.set("log", [e, ...log].slice(0, 30));
}
