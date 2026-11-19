import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countMessage, enqueue, flushOutbox, isOutboxKey, type KvLike, readCounts } from "../packages/forms/src/outbox.js";
import { parseCsv, parseImport, toCsv, toQueued } from "../packages/forms/src/plugin/data.js";
import { createPlugin } from "../packages/forms/src/plugin/index.js";
import type { PluginResponse } from "../test/stubs/emdash.js";
import { env } from "../test/stubs/cloudflare-workers.js";

function memoryKv(): KvLike & { store: Map<string, { v: string; meta?: unknown }> } {
	const store = new Map<string, { v: string; meta?: unknown }>();
	return {
		store,
		async put(k, v, o) {
			store.set(k, { v, ...(o?.metadata ? { meta: o.metadata } : {}) });
		},
		async get(k) {
			return store.get(k)?.v ?? null;
		},
		async delete(k) {
			store.delete(k);
		},
		async list(o) {
			return {
				keys: [...store.entries()]
					.filter(([k]) => k.startsWith(o?.prefix ?? ""))
					.sort(([a], [b]) => (a < b ? -1 : 1))
					.map(([name, e]) => ({ name, ...(e.meta ? { metadata: e.meta } : {}) })),
				list_complete: true,
			};
		},
	};
}

type B = Record<string, any>;
type Res = { blocks: B[]; toast?: { message: string; type: string } };
type Route = { permission?: string; public?: boolean; response?: string; handler: (ctx: unknown) => Promise<unknown> };
const plugin = createPlugin() as unknown as { id: string; admin: { pages: { path: string }[]; widgets: { id: string }[] }; routes: { admin: Route; download: Route } };
const logs: unknown[] = [];
const ctx = (input: unknown, role = 50, extra: Record<string, unknown> = {}) => ({ input, request: new Request("https://site.example/_emdash/api/plugins/site-forms/admin"), user: { id: "u1", email: "owner@example.com", name: "Owner", role }, log: { info: (...a: unknown[]) => logs.push(a) }, ...extra });
const call = (input: unknown, role = 50) => plugin.routes.admin.handler(ctx(input, role)) as Promise<Res>;
const tab = (r: Res, i: number) => (r.blocks.find((b) => b.type === "tab")?.panels[i]?.blocks ?? []) as B[];
const inboxRows = (r: Res) => tab(r, 0).find((b) => b.type === "table")?.rows as B[];
const msg = (name: string, text = "Line one\nLine two") => ({ form: "contact", replyTo: { email: `${name.toLowerCase()}@example.com`, name }, subject: `New message from ${name}`, text, html: "<p>x</p>" });

let kv: ReturnType<typeof memoryKv>;
beforeEach(async () => {
	kv = memoryKv();
	for (const k of Object.keys(env)) delete env[k];
	Object.assign(env, { FORM_OUTBOX: kv, FORM_OUTBOX_HOLD: "1" });
	logs.length = 0;
	await enqueue(env, msg("Sam"));
	await new Promise((r) => setTimeout(r, 3));
	await enqueue(env, msg("Alex", "Please call me back"));
});
afterEach(() => vi.unstubAllGlobals());
const msgKeys = () => [...kv.store.keys()].filter((k) => k.startsWith("msg:"));

describe("form messages plugin: access", () => {
	it("declares a private admin route, a public token download, one page and one widget", () => {
		expect(plugin.id).toBe("site-forms");
		expect(plugin.routes.admin.permission).toBe("plugins:manage");
		expect(plugin.routes.admin.public).toBeUndefined();
		expect(plugin.routes.download).toMatchObject({ public: true, response: "raw" });
		expect(plugin.admin.pages.map((p) => p.path)).toEqual(["/messages"]);
		expect(plugin.admin.widgets.map((w) => w.id)).toEqual(["form-messages"]);
	});
	it("shows non-admins nothing", async () => {
		const r = await call({ type: "page_load", page: "/messages" }, 40);
		expect(JSON.stringify(r)).not.toContain("example.com");
		expect(r.blocks[0]).toMatchObject({ type: "banner", title: "Admins only" });
		const w = (await plugin.routes.admin.handler(ctx({ type: "page_load" }, 40, { ui: { surface: "dashboard-widget" } }))) as Res;
		expect(w.blocks).toEqual([]);
	});
});

describe("form messages plugin: inbox", () => {
	it("lists messages newest first with status badges and the hold banner", async () => {
		const r = await call({ type: "page_load", page: "/messages" });
		expect(tab(r, 0).find((b) => b.type === "banner")).toMatchObject({ title: "Email on hold" });
		expect(inboxRows(r).map((x) => [x.status, x.from])).toEqual([
			["New", "Alex <alex@example.com>"],
			["New", "Sam <sam@example.com>"],
		]);
		expect(isOutboxKey(inboxRows(r)[0]?.open.value)).toBe(true);
	});
	it("opens a message as plain-text lines, marks it read, and logs no content", async () => {
		const key = msgKeys()[0];
		const r = await call({ type: "block_action", action_id: "open", value: key });
		expect(r.blocks.filter((b) => b.type === "section").map((b) => b.text)).toEqual(["Line one", "Line two"]);
		expect(r.blocks.find((b) => b.type === "actions")?.elements.map((e: B) => e.action_id ?? e.type)).toEqual(["back", "unread", "link", "delete"]);
		expect(inboxRows(await call({ type: "page_load" })).find((x) => x.open.value === key)?.status).toBe("Read");
		const activity = [...kv.store.entries()].filter(([k]) => k.startsWith("act:")).map(([, e]) => e.v);
		expect(activity.join()).toContain("Opened a message");
		expect(JSON.stringify([logs, activity])).not.toMatch(/Line one|sam@example/);
	});
	it("searches message bodies and filters by read state", async () => {
		const r = await call({ type: "form_submit", action_id: "filter", values: { q: "call me", form: "all", show: "all" } });
		expect(inboxRows(r).map((x) => x.from)).toEqual(["Alex <alex@example.com>"]);
		const unread = await call({ type: "form_submit", action_id: "filter", values: { q: "", form: "all", show: "read" } });
		expect(inboxRows(unread)).toEqual([]);
	});
	it("sorts by a column", async () => {
		const r = await call({ type: "block_action", action_id: "sort", value: { sort: { key: "from", dir: "asc" } } });
		expect(inboxRows(r).map((x) => x.from.split(" ")[0])).toEqual(["Alex", "Sam"]);
	});
	it("deletes only the messages a search shows", async () => {
		await call({ type: "block_action", action_id: "delete-all", value: { scope: "shown", filter: { q: "call me", form: "all", show: "all" } } });
		expect(msgKeys()).toHaveLength(1);
		await call({ type: "block_action", action_id: "delete-all", value: { scope: "all" } });
		expect(msgKeys()).toHaveLength(0);
	});
	it("ignores keys the outbox did not write", async () => {
		await call({ type: "block_action", action_id: "delete", value: "other:key" });
		expect(msgKeys()).toHaveLength(2);
	});
	it("emails one now once email works, and removes it", async () => {
		Object.assign(env, { FORM_OUTBOX_HOLD: undefined, EMAIL_API_KEY: "k", FORM_FROM: "Site <noreply@example.com>", FORM_TO: "owner@example.com" });
		const fetch = vi.fn(async () => new Response("{}", { status: 201 }));
		vi.stubGlobal("fetch", fetch);
		const key = msgKeys()[0];
		const r = await call({ type: "block_action", action_id: "send", value: key });
		expect(fetch).toHaveBeenCalledOnce();
		expect(msgKeys()).toHaveLength(1);
		expect(r.toast?.message).toBe("Message emailed.");
	});
});

describe("form messages plugin: export and import", () => {
	it("exports through a one-time link", async () => {
		const r = await call({ type: "form_submit", action_id: "export", values: { format: "csv", scope: "all" } });
		const link = tab(r, 2).find((b) => b.type === "actions")?.elements[0];
		expect(link.target.url).toMatch(/^https:\/\/site\.example\/_emdash\/api\/plugins\/site-forms\/download\?token=[0-9a-f]{48}$/);
		const token = new URL(link.target.url).searchParams.get("token");
		const file = (await plugin.routes.download.handler({ input: { token } })) as PluginResponse;
		expect(file.status).toBe(200);
		expect(Object.fromEntries(file.headers)["content-disposition"]).toMatch(/attachment; filename="form-messages-\d{4}-\d{2}-\d{2}\.csv"/);
		expect(file.body?.value).toContain('"Received","Form","Name","Email"');
		expect(((await plugin.routes.download.handler({ input: { token } })) as PluginResponse).status).toBe(410);
	});
	it("guards spreadsheet formulas and round-trips through import", () => {
		const q = toQueued({ received: "2026-11-01T10:00:00.000Z", form: "contact", name: "=HYPERLINK()", email: "a@example.com", subject: "Hi, \"there\"", message: "one\ntwo", read: false }, { email: false, markRead: false });
		const csv = toCsv([q]);
		expect(csv).toContain(`"'=HYPERLINK()"`);
		const [, cells] = parseCsv(csv);
		expect(cells?.[4]).toBe('Hi, "there"');
		const { rows, errors } = parseImport(csv);
		expect(errors).toEqual([]);
		expect(rows[0]).toMatchObject({ name: "=HYPERLINK()", subject: 'Hi, "there"', message: "one\ntwo" });
	});
	it("imports pasted JSON, skips duplicates, reports bad rows, never emails unless asked, and rebuilds HTML", async () => {
		const data = JSON.stringify({ messages: [{ received: "2026-11-01T10:00:00Z", form: "contact", name: "Jo", email: "jo@example.com", subject: "Hello", message: "<script>x</script>" }, { received: "not a date", message: "x" }] });
		const r = await call({ type: "form_submit", action_id: "import", values: { data, email: false, read: true } });
		expect(r.toast?.message).toBe("1 message imported.");
		expect(tab(r, 2).find((b) => b.type === "accordion")?.blocks.map((b: B) => b.text).join(" ")).toMatch(/Row 2: the received date/);
		const stored = msgKeys().map((k) => JSON.parse(kv.store.get(k)?.v ?? "{}")).find((q) => q.source === "import");
		expect(stored).toMatchObject({ noEmail: true, html: '<div style="font:14px/1.5 sans-serif">&#60;script&#62;x&#60;/script&#62;</div>' });
		const again = await call({ type: "form_submit", action_id: "import", values: { data, email: false, read: true } });
		expect(again.toast?.message).toBe("Nothing new to import.");
		Object.assign(env, { FORM_OUTBOX_HOLD: undefined, EMAIL_API_KEY: "k", FORM_FROM: "noreply@example.com", FORM_TO: "owner@example.com" });
		vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 201 })));
		expect(await flushOutbox(env)).toEqual({ sent: 2, left: 0 });
		expect(msgKeys()).toHaveLength(1);
	});
});

describe("form messages plugin: insights and widget", () => {
	it("charts per-day counts and fills the widget", async () => {
		await countMessage(env, "contact", "emailed");
		await countMessage(env, "contact", "emailed");
		await countMessage(env, "contact", "kept");
		expect((await readCounts(env, "2000-01-01")).reduce((n, c) => n + c.count, 0)).toBe(3);
		const r = await call({ type: "page_load" });
		const chart = tab(r, 1).find((b) => b.type === "chart");
		expect(chart?.config.series.map((s: B) => s.data.at(-1)[1])).toEqual([2, 1]);
		const w = (await plugin.routes.admin.handler(ctx({ type: "page_load" }, 50, { ui: { surface: "dashboard-widget" } }))) as Res;
		expect(w.blocks[0]?.items.map((x: B) => x.value)).toEqual([2, 2, 3]);
	});
	it("explains when the outbox is not set up", async () => {
		delete env.FORM_OUTBOX;
		const r = await call({ type: "page_load" });
		expect(r.blocks.find((b) => b.type === "banner")?.title).toMatch(/not set up/);
	});
});
