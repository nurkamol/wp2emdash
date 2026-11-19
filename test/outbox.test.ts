import { afterEach, describe, expect, it, vi } from "vitest";
import { enqueue, flushOutbox, type KvLike, outboxStatus, parseRecipients, resolveRecipients, writeRecipientSetting } from "../packages/forms/src/outbox.js";
import { runtime as emdashRuntime } from "./stubs/emdash-middleware.js";

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

describe("form outbox: recipients and EmDash email", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		emdashRuntime.email = null;
	});
	it("validates, de-duplicates and caps admin recipients", () => {
		expect(parseRecipients("a@example.com\nA@example.com, b@example.com; c@example.com")).toEqual({ list: ["a@example.com", "b@example.com", "c@example.com"], errors: [] });
		expect(parseRecipients("not-an-address, x@y").errors).toHaveLength(2);
		expect(parseRecipients('"Name" <a@example.com>').errors.length).toBeGreaterThan(0);
		const many = Array.from({ length: 11 }, (_, i) => `p${i}@example.com`).join("\n");
		expect(parseRecipients(many).errors).toEqual(["At most 10 recipients (this has 11)."]);
	});
	it("prefers the admin setting over FORM_TO, and falls back when it is cleared", async () => {
		const kv = memoryKv();
		const env = { FORM_OUTBOX: kv, FORM_TO: "default@example.com" };
		expect(await resolveRecipients(env)).toEqual({ to: ["default@example.com"], source: "config" });
		await writeRecipientSetting(env, ["office@example.com", "boss@example.com"]);
		expect(await resolveRecipients(env)).toEqual({ to: ["office@example.com", "boss@example.com"], source: "admin" });
		await writeRecipientSetting(env, []);
		expect(await resolveRecipients(env)).toEqual({ to: ["default@example.com"], source: "config" });
		expect(await resolveRecipients({})).toEqual({ to: [], source: "none" });
	});
	it("flushes to the admin's recipients", async () => {
		const kv = memoryKv();
		await enqueue({ FORM_OUTBOX: kv }, msg);
		await writeRecipientSetting({ FORM_OUTBOX: kv }, ["office@example.com"]);
		const fetch = vi.fn(async () => new Response("{}", { status: 201 }));
		vi.stubGlobal("fetch", fetch);
		expect(await flushOutbox({ FORM_OUTBOX: kv, FORM_TO: "default@example.com", FORM_FROM: "noreply@example.com", EMAIL_API_KEY: "k" })).toEqual({ sent: 1, left: 0 });
		expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body)).to).toEqual([{ email: "office@example.com" }]);
	});
	it("EMAIL_PROVIDER=emdash: waits while EmDash has no email provider, then sends through its pipeline", async () => {
		const kv = memoryKv();
		await enqueue({ FORM_OUTBOX: kv }, msg);
		const env = { FORM_OUTBOX: kv, EMAIL_PROVIDER: "emdash", FORM_TO: "a@example.com, b@example.com" };
		expect(await outboxStatus(env)).toBe("no-email");
		emdashRuntime.email = { isAvailable: () => false, send: vi.fn() };
		expect(await flushOutbox(env)).toEqual({ sent: 0, left: 1 });
		const send = vi.fn(async () => {});
		emdashRuntime.email = { isAvailable: () => true, send };
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		expect(await outboxStatus(env)).toBe("ready");
		expect(await flushOutbox(env)).toEqual({ sent: 1, left: 0 });
		expect(fetch).not.toHaveBeenCalled();
		const [message, source] = send.mock.calls[0] as unknown as [Record<string, unknown>, string];
		expect(source).toBe("site-forms");
		expect(message).toMatchObject({ to: "a@example.com", cc: ["b@example.com"], replyTo: "visitor@example.com", subject: "S" });
		expect(kv.store.size).toBe(0);
	});
	it("EMAIL_PROVIDER=emdash: keeps the message when the provider throws", async () => {
		const kv = memoryKv();
		await enqueue({ FORM_OUTBOX: kv }, msg);
		emdashRuntime.email = { isAvailable: () => true, send: vi.fn(async () => Promise.reject(new TypeError("smtp down"))) };
		expect(await flushOutbox({ FORM_OUTBOX: kv, EMAIL_PROVIDER: "emdash", FORM_TO: "a@example.com" })).toEqual({ sent: 0, left: 1 });
		expect(JSON.parse([...kv.store.values()][0]?.v ?? "{}").attempts).toBe(1);
	});
});
