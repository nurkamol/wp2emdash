import { afterEach, describe, expect, it, vi } from "vitest";
import { enqueue, flushOutbox, type KvLike } from "../starter/src/forms/outbox.js";

function memoryKv(): KvLike & { store: Map<string, { v: string; ttl?: number }> } {
	const store = new Map<string, { v: string; ttl?: number }>();
	return {
		store,
		async put(k, v, o) {
			store.set(k, { v, ...(o?.expirationTtl ? { ttl: o.expirationTtl } : {}) });
		},
		async get(k) {
			return store.get(k)?.v ?? null;
		},
		async delete(k) {
			store.delete(k);
		},
		async list(o) {
			return { keys: [...store.keys()].filter((k) => k.startsWith(o?.prefix ?? "")).map((name) => ({ name })), list_complete: true };
		},
	};
}
const msg = { form: "f1", replyTo: { email: "visitor@example.com" }, subject: "S", text: "T", html: "<p>H</p>" };

describe("form outbox", () => {
	afterEach(() => vi.unstubAllGlobals());
	it("keeps a message with the site's retention", async () => {
		const kv = memoryKv();
		expect(await enqueue({ FORM_OUTBOX: kv, FORM_OUTBOX_DAYS: "30" }, msg)).toBe(true);
		const [entry] = [...kv.store.values()];
		expect(entry?.ttl).toBe(30 * 86_400);
		expect(JSON.parse(entry?.v ?? "{}")).toMatchObject({ form: "f1", attempts: 0 });
	});
	it("does nothing without the binding", async () => {
		expect(await enqueue({}, msg)).toBe(false);
	});
	it("waits while email is not configured, then sends and deletes", async () => {
		const kv = memoryKv();
		await enqueue({ FORM_OUTBOX: kv }, msg);
		expect(await flushOutbox({ FORM_OUTBOX: kv, FORM_TO: "owner@example.com" })).toEqual({ sent: 0, left: 1 });
		const fetch = vi.fn(async () => new Response("{}", { status: 201 }));
		vi.stubGlobal("fetch", fetch);
		expect(await flushOutbox({ FORM_OUTBOX: kv, FORM_TO: "owner@example.com", FORM_FROM: "Site <noreply@example.com>", EMAIL_API_KEY: "k" })).toEqual({ sent: 1, left: 0 });
		expect(kv.store.size).toBe(0);
	});
	it("keeps the message when the provider refuses", async () => {
		const kv = memoryKv();
		await enqueue({ FORM_OUTBOX: kv }, msg);
		vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
		expect(await flushOutbox({ FORM_OUTBOX: kv, FORM_TO: "owner@example.com", FORM_FROM: "noreply@example.com", EMAIL_API_KEY: "bad" })).toEqual({ sent: 0, left: 1 });
		expect(kv.store.size).toBe(1);
	});
	it("holds everything while FORM_OUTBOX_HOLD is set", async () => {
		const kv = memoryKv();
		await enqueue({ FORM_OUTBOX: kv }, msg);
		const fetch = vi.fn(async () => new Response("{}", { status: 201 }));
		vi.stubGlobal("fetch", fetch);
		expect(await flushOutbox({ FORM_OUTBOX: kv, FORM_OUTBOX_HOLD: "1", FORM_TO: "owner@example.com", FORM_FROM: "noreply@example.com", EMAIL_API_KEY: "k" })).toEqual({ sent: 0, left: 1 });
		expect(fetch).not.toHaveBeenCalled();
	});
});
