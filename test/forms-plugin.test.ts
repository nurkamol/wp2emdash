import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "../test/stubs/cloudflare-workers.js";
import { enqueue, isOutboxKey, type KvLike } from "../starter/src/forms/outbox.js";
import { createPlugin } from "../starter/src/plugins/forms/plugin.js";

function memoryKv(): KvLike & { store: Map<string, string> } {
	const store = new Map<string, string>();
	return {
		store,
		async put(k, v) {
			store.set(k, v);
		},
		async get(k) {
			return store.get(k) ?? null;
		},
		async delete(k) {
			store.delete(k);
		},
		async list(o) {
			return { keys: [...store.keys()].filter((k) => k.startsWith(o?.prefix ?? "")).sort().map((name) => ({ name })), list_complete: true };
		},
	};
}

type Res = { blocks: Record<string, any>[]; toast?: { message: string; type: string } };
const plugin = createPlugin() as unknown as { id: string; admin: { pages: { path: string }[] }; routes: { admin: { permission?: string; public?: boolean; handler: (ctx: unknown) => Promise<Res> } } };
const logs: unknown[] = [];
const call = (input: unknown, role = 50) => plugin.routes.admin.handler({ input, user: { id: "u1", role }, log: { info: (...a: unknown[]) => logs.push(a) } });
const msg = { form: "contact", replyTo: { email: "visitor@example.com", name: "Sam Visitor" }, subject: "New message", text: "Line one\nLine two", html: "<p>x</p>" };

describe("form messages admin page", () => {
	let kv: ReturnType<typeof memoryKv>;
	beforeEach(async () => {
		kv = memoryKv();
		for (const k of Object.keys(env)) delete env[k];
		Object.assign(env, { FORM_OUTBOX: kv, FORM_OUTBOX_HOLD: "1" });
		logs.length = 0;
		await enqueue(env, msg);
	});
	afterEach(() => vi.unstubAllGlobals());

	it("is a private admin route with one page", () => {
		expect(plugin.id).toBe("site-forms");
		expect(plugin.routes.admin.permission).toBe("plugins:manage");
		expect(plugin.routes.admin.public).toBeUndefined();
		expect(plugin.admin.pages.map((p) => p.path)).toEqual(["/messages"]);
	});
	it("refuses non-admins even if the route were reached", async () => {
		const r = await call({ type: "page_load", page: "/messages" }, 40);
		expect(JSON.stringify(r)).not.toContain("visitor@example.com");
		expect(r.blocks[0]).toMatchObject({ type: "banner", title: "Admins only" });
	});
	it("lists waiting messages with the hold status", async () => {
		const r = await call({ type: "page_load", page: "/messages" });
		expect(r.blocks.find((b) => b.type === "banner")).toMatchObject({ title: "On hold" });
		const table = r.blocks.find((b) => b.type === "table");
		expect(table?.rows).toHaveLength(1);
		expect(table?.rows[0]).toMatchObject({ from: "Sam Visitor <visitor@example.com>", subject: "New message" });
		expect(isOutboxKey(table?.rows[0].open.value)).toBe(true);
	});
	it("opens a message as plain-text lines and offers no send while held", async () => {
		const key = [...kv.store.keys()][0];
		const r = await call({ type: "block_action", action_id: "open", value: key });
		expect(r.blocks.filter((b) => b.type === "section").map((b) => b.text)).toEqual(["Line one", "Line two"]);
		const buttons = r.blocks.find((b) => b.type === "actions")?.elements.map((e: { action_id: string }) => e.action_id);
		expect(buttons).toEqual(["back", "delete"]);
		expect(JSON.stringify(logs)).not.toContain("visitor");
	});
	it("ignores keys the outbox did not write", async () => {
		const r = await call({ type: "block_action", action_id: "delete", value: "other:key" });
		expect(kv.store.size).toBe(1);
		expect(r.blocks.find((b) => b.type === "table")).toBeDefined();
	});
	it("deletes a message", async () => {
		const key = [...kv.store.keys()][0];
		const r = await call({ type: "block_action", action_id: "delete", value: key });
		expect(kv.store.size).toBe(0);
		expect(r.toast?.type).toBe("success");
	});
	it("emails a message now once email works, and removes it", async () => {
		Object.assign(env, { FORM_OUTBOX_HOLD: undefined, EMAIL_API_KEY: "k", FORM_FROM: "Site <noreply@example.com>", FORM_TO: "owner@example.com" });
		const fetch = vi.fn(async () => new Response("{}", { status: 201 }));
		vi.stubGlobal("fetch", fetch);
		const key = [...kv.store.keys()][0];
		const open = await call({ type: "block_action", action_id: "open", value: key });
		expect(open.blocks.find((b) => b.type === "actions")?.elements.map((e: { action_id: string }) => e.action_id)).toContain("send");
		const r = await call({ type: "block_action", action_id: "send", value: key });
		expect(fetch).toHaveBeenCalledOnce();
		expect(kv.store.size).toBe(0);
		expect(r.toast?.message).toBe("Message emailed.");
	});
	it("explains when the outbox is not set up", async () => {
		delete env.FORM_OUTBOX;
		const r = await call({ type: "page_load", page: "/messages" });
		expect(r.blocks.find((b) => b.type === "banner")?.title).toMatch(/not set up/);
	});
});
