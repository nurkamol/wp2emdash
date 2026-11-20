/** Shared stand-ins for the @wp2emdash/health tests: EmDash plugin KV and the Workers KV of the form outbox. */
import type { Kv } from "../packages/health/src/store.js";

/** EmDash plugin KV stand-in, with the versioned compare-and-set the lock uses. */
export function memoryKv(): Kv & { store: Map<string, { v: unknown; rev: number }> } {
	const store = new Map<string, { v: unknown; rev: number }>();
	let rev = 0;
	const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
	return {
		store,
		async get<T>(k: string) {
			return (store.has(k) ? clone(store.get(k)?.v) : null) as T | null;
		},
		async set(k, v) {
			store.set(k, { v: clone(v), rev: ++rev });
		},
		async delete(k) {
			return store.delete(k);
		},
		async list(prefix = "") {
			return [...store.entries()].filter(([k]) => k.startsWith(prefix)).map(([key, e]) => ({ key, value: clone(e.v) }));
		},
		async getVersioned<T>(k: string) {
			const e = store.get(k);
			return e ? { value: clone(e.v) as T, revision: String(e.rev) } : null;
		},
		async compareAndSet(k, expected, v) {
			const e = store.get(k);
			if ((expected === null && e) || (expected !== null && (!e || String(e.rev) !== expected))) return { applied: false };
			store.set(k, { v: clone(v), rev: ++rev });
			return { applied: true, revision: String(rev) };
		},
	};
}

/** Workers KV stand-in for the form outbox (metadata on list). */
export function outboxKv() {
	const store = new Map<string, { v: string; meta?: unknown }>();
	return {
		store,
		async put(k: string, v: string, o?: { metadata?: unknown }) {
			store.set(k, { v, ...(o?.metadata ? { meta: o.metadata } : {}) });
		},
		async get(k: string) {
			return store.get(k)?.v ?? null;
		},
		async delete(k: string) {
			store.delete(k);
		},
		async list(o?: { prefix?: string }) {
			return { keys: [...store.entries()].filter(([k]) => k.startsWith(o?.prefix ?? "")).sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, e]) => ({ name, ...(e.meta ? { metadata: e.meta } : {}) })), list_complete: true };
		},
	};
}
