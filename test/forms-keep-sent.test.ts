/**
 * Forms 1.4 keep sent (FORM_OUTBOX_KEEP_SENT="1"): every accepted message is stored with a delivery status — emailed,
 * waiting or failed — so Form messages is a full inbox. Off: unchanged (only messages that could not be emailed are
 * kept, deleted once emailed). Synthetic data only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFormEndpoint } from "../packages/forms/src/endpoint.js";
import type { FormDefinition } from "../packages/forms/src/index.js";
import { enqueue, flushOutbox, type KvLike, listSummaries, type Queued, summaryOf } from "../packages/forms/src/outbox.js";
import { parseImport, toCsv, toJson, toQueued } from "../packages/forms/src/plugin/data.js";
import { createPlugin } from "../packages/forms/src/plugin/index.js";
import { message, type Overview, overview, TABS, widget } from "../packages/forms/src/plugin/views.js";
import { kitConfigSchema } from "../src/config/schema.js";
import { outboxVars } from "../src/phases/scaffold.js";
import { env } from "./stubs/cloudflare-workers.js";

function memoryKv(): KvLike & { store: Map<string, { v: string; meta?: unknown; ttl?: number }> } {
	const store = new Map<string, { v: string; meta?: unknown; ttl?: number }>();
	return {
		store,
		async put(k, v, o) {
			store.set(k, { v, ...(o?.metadata ? { meta: o.metadata } : {}), ...(o?.expirationTtl ? { ttl: o.expirationTtl } : {}) });
		},
		async get(k) {
			return store.get(k)?.v ?? null;
		},
		async delete(k) {
			store.delete(k);
		},
		async list(o) {
			const keys = [...store.entries()]
				.filter(([k]) => k.startsWith(o?.prefix ?? ""))
				.sort(([a], [b]) => (a < b ? -1 : 1))
				.map(([name, e]) => ({ name, ...(e.meta ? { metadata: e.meta } : {}) }));
			// Real KV pages: honour `limit` and `cursor` so paging code is exercised.
			const start = Number(o?.cursor ?? 0);
			const page = keys.slice(start, start + (o?.limit ?? 1000));
			const end = start + page.length;
			return { keys: page, list_complete: end >= keys.length, ...(end < keys.length ? { cursor: String(end) } : {}) };
		},
	};
}

const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const form: FormDefinition = { id: "contact", title: "Contact", submitLabel: "Send", successMessage: "Thanks", fields: [{ name: "name", label: "Name", type: "text" }, { name: "email", label: "Email", type: "email", required: true }, { name: "message", label: "Message", type: "textarea" }] };
const POST = createFormEndpoint({ getForm: (id) => (id === "contact" ? form : undefined) }) as unknown as (ctx: unknown) => Promise<Response>;
const submit = (fields: Record<string, string>) => {
	const body = new FormData();
	for (const [k, v] of Object.entries({ "cf-turnstile-response": "t", ...fields })) body.set(k, v);
	return POST({ params: { id: "contact" }, request: new Request("https://site.example/api/forms/contact", { method: "POST", body, headers: { accept: "application/json" } }), locals: {} });
};
/** Turnstile passes; the provider (Brevo) answers `status` with a message id. */
const provider = (status = 201) => vi.fn(async (url: string) => (String(url).includes("turnstile") ? new Response(JSON.stringify({ success: true })) : new Response(JSON.stringify({ messageId: "<m1@relay.example>" }), { status })));
const EMAIL = { EMAIL_API_KEY: "k", FORM_FROM: "Site <noreply@example.com>", FORM_TO: "office@example.com,boss@example.com" };

let kv: ReturnType<typeof memoryKv>;
const records = () => [...kv.store.entries()].filter(([k]) => k.startsWith("msg:")).map(([key, e]) => ({ key, q: JSON.parse(e.v) as Queued, meta: e.meta as Record<string, unknown> | undefined, ttl: e.ttl }));
const reset = (vars: Record<string, unknown> = {}) => {
	for (const k of Object.keys(env)) delete env[k];
	Object.assign(env, { TURNSTILE_SECRET_KEY: "s", FORM_OUTBOX: kv, ...vars });
};
let log: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
	kv = memoryKv();
	log = vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
	vi.unstubAllGlobals();
	log.mockRestore();
});

describe("keep sent: the endpoint", () => {
	it("off: an emailed message is not stored (as before)", async () => {
		reset(EMAIL);
		vi.stubGlobal("fetch", provider());
		expect((await submit({ name: "Sam", email: "sam@example.com", message: "Hello" })).status).toBe(200);
		expect(records()).toEqual([]);
	});
	it("on: an emailed message is stored, marked emailed with when, to whom and the provider's id; logs carry a count", async () => {
		reset({ ...EMAIL, FORM_OUTBOX_KEEP_SENT: "1", FORM_OUTBOX_DAYS: "14" });
		vi.stubGlobal("fetch", provider());
		expect((await submit({ name: "Sam", email: "sam@example.com", message: "Hello" })).status).toBe(200);
		const [r] = records();
		expect(r?.q).toMatchObject({ form: "contact", status: "emailed", emailedTo: ["office@example.com", "boss@example.com"], messageId: "<m1@relay.example>", attempts: 0, replyTo: { email: "sam@example.com", name: "Sam" } });
		expect(Date.parse(r?.q.emailedAt ?? "")).not.toBeNaN();
		expect(r?.meta).toMatchObject({ status: "emailed", from: "Sam" });
		expect(r?.ttl).toBe(14 * 86_400);
		const logged = JSON.stringify(log.mock.calls);
		expect(logged).toContain('\\"recipients\\":2');
		expect(logged).not.toMatch(/sam@example|office@example|Hello/);
	});
	it("on: a provider refusal is stored as failed (one attempt); a hold as waiting", async () => {
		reset({ ...EMAIL, FORM_OUTBOX_KEEP_SENT: "1" });
		vi.stubGlobal("fetch", provider(401));
		await submit({ email: "a@example.com" });
		reset({ ...EMAIL, FORM_OUTBOX_KEEP_SENT: "1", FORM_OUTBOX_HOLD: "1" });
		await submit({ email: "b@example.com" });
		expect(records().map((r) => [r.q.replyTo?.email, r.q.status, r.q.attempts])).toEqual([
			["a@example.com", "failed", 1],
			["b@example.com", "waiting", 0],
		]);
	});
	it("on: a KV error after sending does not fail the visitor's request", async () => {
		reset({ ...EMAIL, FORM_OUTBOX_KEEP_SENT: "1" });
		kv.put = async () => Promise.reject(new Error("kv down"));
		vi.stubGlobal("fetch", provider());
		expect((await submit({ email: "a@example.com" })).status).toBe(200);
	});
	it("keeps a signed form's signature with the emailed record and shows it to admins", async () => {
		const signed: FormDefinition = { ...form, fields: [...form.fields, { name: "signature", label: "Signature", type: "signature", required: true }] };
		const post = createFormEndpoint({ getForm: () => signed }) as unknown as (ctx: unknown) => Promise<Response>;
		reset({ ...EMAIL, FORM_OUTBOX_KEEP_SENT: "1" });
		vi.stubGlobal("fetch", provider());
		const body = new FormData();
		for (const [k, v] of Object.entries({ "cf-turnstile-response": "t", email: "a@example.com", signature: `data:image/png;base64,${PNG_1x1}` })) body.set(k, v);
		expect((await post({ params: { id: "contact" }, request: new Request("https://site.example/api/forms/contact", { method: "POST", body, headers: { accept: "application/json" } }), locals: {} })).status).toBe(200);
		const [r] = records();
		expect(r?.q.attachments).toEqual([{ filename: "signature.png", contentType: "image/png", content: PNG_1x1 }]);
		expect(r?.meta).toMatchObject({ files: 1, status: "emailed" });
		expect(message(r?.key as string, r?.q as Queued, "ready")).toContainEqual(expect.objectContaining({ type: "image", url: `data:image/png;base64,${PNG_1x1}` }));
	});
});

describe("keep sent: the cron", () => {
	const msg = (email: string) => ({ form: "contact", replyTo: { email }, subject: "S", text: "T", html: "<p>T</p>" });
	it("on: sends waiting and failed messages once, marks them emailed and keeps them", async () => {
		const base = { FORM_OUTBOX: kv, ...EMAIL, FORM_OUTBOX_KEEP_SENT: "1" };
		await enqueue(base, msg("a@example.com"));
		await enqueue(base, { ...msg("b@example.com"), attempts: 1 });
		await enqueue(base, { ...msg("c@example.com"), status: "emailed", emailedAt: "2026-01-01T00:00:00.000Z", emailedTo: ["office@example.com"] });
		const fetch = provider(201);
		vi.stubGlobal("fetch", fetch);
		expect(await flushOutbox(base)).toEqual({ sent: 2, left: 0 });
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(records().map((r) => [r.q.replyTo?.email, r.q.status, r.meta?.status])).toEqual([
			["a@example.com", "emailed", "emailed"],
			["b@example.com", "emailed", "emailed"],
			["c@example.com", "emailed", "emailed"],
		]);
		expect(records()[0]?.q).toMatchObject({ emailedTo: ["office@example.com", "boss@example.com"], messageId: "<m1@relay.example>" });
		expect(await flushOutbox(base)).toEqual({ sent: 0, left: 0 });
		expect(fetch).toHaveBeenCalledTimes(2);
	});
	it("off: deletes once emailed, and never resends a message already marked emailed", async () => {
		const base = { FORM_OUTBOX: kv, ...EMAIL };
		await enqueue(base, msg("a@example.com"));
		await enqueue(base, { ...msg("c@example.com"), status: "emailed" });
		const fetch = provider(201);
		vi.stubGlobal("fetch", fetch);
		expect(await flushOutbox(base)).toEqual({ sent: 1, left: 0 });
		expect(records().map((r) => r.q.replyTo?.email)).toEqual(["c@example.com"]);
	});
	it("a refusal marks it failed and it is retried", async () => {
		const base = { FORM_OUTBOX: kv, ...EMAIL, FORM_OUTBOX_KEEP_SENT: "1" };
		await enqueue(base, msg("a@example.com"));
		vi.stubGlobal("fetch", provider(500));
		expect(await flushOutbox(base)).toEqual({ sent: 0, left: 1 });
		expect(records()[0]?.q).toMatchObject({ status: "failed", attempts: 1 });
		expect(records()[0]?.meta).toMatchObject({ status: "failed" });
		vi.stubGlobal("fetch", provider(201));
		expect(await flushOutbox(base)).toEqual({ sent: 1, left: 0 });
		expect(records()[0]?.q).toMatchObject({ status: "emailed", attempts: 1 });
	});
	it("retention: deletes every record past FORM_OUTBOX_DAYS (emailed or not); an import counts from when it was stored", async () => {
		const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
		const put = async (key: string, q: Queued) => kv.put(key, JSON.stringify(q), { metadata: summaryOf(q) });
		await put(`msg:${old}:aaaaaaa1`, { ...msg("old-sent@example.com"), at: old, attempts: 0, status: "emailed" });
		await put(`msg:${old}:aaaaaaa2`, { ...msg("old-waiting@example.com"), at: old, attempts: 0, status: "waiting" });
		await put(`msg:${old}:aaaaaaa3`, { ...msg("old-import@example.com"), at: old, attempts: 0, status: "waiting", noEmail: true, source: "import", storedAt: new Date().toISOString() });
		await enqueue({ FORM_OUTBOX: kv }, msg("new@example.com"));
		expect(await flushOutbox({ FORM_OUTBOX: kv, FORM_OUTBOX_DAYS: "30", FORM_OUTBOX_KEEP_SENT: "1" })).toEqual({ sent: 0, left: 1, expired: 2 });
		expect(records().map((r) => r.q.replyTo?.email)).toEqual(["old-import@example.com", "new@example.com"]);
	});
	it("pages through many messages; the inbox lists the newest 1,000 with keep sent, the oldest without", async () => {
		for (let i = 0; i < 1005; i++) {
			const at = new Date(Date.UTC(2026, 10, 1, 0, 0, i)).toISOString();
			const q: Queued = { ...msg(`p${i}@example.com`), at, attempts: 0, status: "emailed" };
			await kv.put(`msg:${at}:${i.toString(16).padStart(8, "0")}`, JSON.stringify(q), { metadata: summaryOf(q) });
		}
		const newest = await listSummaries({ FORM_OUTBOX: kv }, 1000, { newest: true });
		expect([newest.more, newest.items.length, newest.items.at(-1)?.s.email, newest.items[0]?.s.email]).toEqual([true, 1000, "p1004@example.com", "p5@example.com"]);
		const oldest = await listSummaries({ FORM_OUTBOX: kv }, 1000);
		expect([oldest.more, oldest.items.length, oldest.items[0]?.s.email]).toEqual([true, 1000, "p0@example.com"]);
	});
});

type B = Record<string, any>;
type Res = { blocks: B[]; toast?: { message: string; type: string } };
const plugin = createPlugin() as unknown as { routes: { admin: { handler: (ctx: unknown) => Promise<unknown> } } };
const ctx = (input: unknown, extra: Record<string, unknown> = {}) => ({ input, request: new Request("https://site.example/_emdash/api/plugins/site-forms/admin"), user: { id: "u1", name: "Owner", role: 50 }, log: { info: () => {} }, ...extra });
const call = (input: unknown) => plugin.routes.admin.handler(ctx(input)) as Promise<Res>;
const inbox = (r: Res) => (r.blocks.find((b) => b.type === "tab")?.panels[TABS.inbox]?.blocks ?? []) as B[];
const rowsOf = (r: Res) => inbox(r).find((b) => b.type === "table")?.rows as B[];
const statLabels = (r: Res) => inbox(r).find((b) => b.type === "stats")?.items.map((i: B) => i.label);

describe("keep sent: Form messages", () => {
	const seed = async () => {
		const base = { FORM_OUTBOX: kv };
		await enqueue(base, { form: "contact", replyTo: { email: "w@example.com", name: "Wendy" }, subject: "Waiting one", text: "W", html: "" });
		await new Promise((r) => setTimeout(r, 2));
		await enqueue(base, { form: "contact", replyTo: { email: "f@example.com", name: "Fred" }, subject: "Failed one", text: "F", html: "", attempts: 2 });
		await new Promise((r) => setTimeout(r, 2));
		await enqueue(base, { form: "contact", replyTo: { email: "e@example.com", name: "Emma" }, subject: "Emailed one", text: "E", html: "", status: "emailed", emailedAt: "2026-11-18T09:00:00.000Z", emailedTo: ["office@example.com"], messageId: "<id-1>" });
	};
	it("lists every message with an Email badge, inbox stat cards and the keep-sent note", async () => {
		reset({ FORM_OUTBOX_KEEP_SENT: "1", FORM_OUTBOX_HOLD: "1" });
		await seed();
		const r = await call({ type: "page_load" });
		expect(rowsOf(r).map((x) => [x.from.split(" ")[0], x.delivery])).toEqual([
			["Emma", "Emailed"],
			["Fred", "Failed"],
			["Wendy", "Waiting"],
		]);
		expect(statLabels(r)).toEqual(["In inbox", "Waiting", "Unread", "Kept for"]);
		expect(inbox(r).find((b) => b.type === "stats")?.items[1]).toMatchObject({ value: 2, description: "1 refused by the email provider" });
		expect(JSON.stringify(inbox(r))).toContain("also after it is emailed");
	});
	it("filters by delivery status, together with the read filter", async () => {
		reset({ FORM_OUTBOX_KEEP_SENT: "1" });
		await seed();
		const by = async (delivery: string, show = "all") => rowsOf(await call({ type: "form_submit", action_id: "filter", values: { q: "", form: "all", show, delivery } })).map((x) => x.from.split(" ")[0]);
		expect(await by("emailed")).toEqual(["Emma"]);
		expect(await by("waiting")).toEqual(["Wendy"]);
		expect(await by("failed")).toEqual(["Fred"]);
		expect(await by("all")).toHaveLength(3);
		expect(await by("emailed", "read")).toEqual([]);
		const form = inbox(await call({ type: "page_load" })).find((b) => b.type === "form");
		expect(form?.fields.map((f: B) => f.action_id)).toEqual(["q", "form", "show", "delivery"]);
	});
	it("deletes only the shown messages of a status filter", async () => {
		reset({ FORM_OUTBOX_KEEP_SENT: "1" });
		await seed();
		await call({ type: "block_action", action_id: "delete-all", value: { scope: "shown", filter: { form: "all", show: "all", delivery: "emailed" } } });
		expect(records().map((r) => r.q.subject)).toEqual(["Waiting one", "Failed one"]);
	});
	it("empty states match the mode", async () => {
		reset({ FORM_OUTBOX_KEEP_SENT: "1" });
		expect(inbox(await call({ type: "page_load" })).find((b) => b.type === "table")?.empty_text).toBe("No messages yet. Every message sent through the site's forms appears here.");
		reset({});
		const off = await call({ type: "page_load" });
		expect(inbox(off).find((b) => b.type === "table")?.empty_text).toMatch(/^No messages are waiting/);
		expect(statLabels(off)).toEqual(["Waiting", "Unread", "Oldest waiting", "Kept for"]);
	});
	it("the message view says when and to whom it was emailed, and 'Email again' asks first", async () => {
		reset({ FORM_OUTBOX_KEEP_SENT: "1", ...EMAIL });
		await seed();
		const key = records().find((r) => r.q.status === "emailed")?.key;
		const view = await call({ type: "block_action", action_id: "open", value: key });
		const fields = view.blocks.find((b) => b.type === "fields")?.fields as B[];
		expect(fields).toContainEqual({ label: "Delivery", value: "Emailed 2026-11-18 09:00 UTC" });
		expect(fields).toContainEqual({ label: "Emailed to", value: "office@example.com" });
		expect(fields).toContainEqual({ label: "Provider message id", value: "<id-1>" });
		const again = view.blocks.find((b) => b.type === "actions")?.elements.find((e: B) => e.action_id === "send");
		expect(again).toMatchObject({ label: "Email again", confirm: { title: "Email this message again?" } });
		const waitingKey = records().find((r) => r.q.status === "waiting")?.key;
		const waiting = await call({ type: "block_action", action_id: "open", value: waitingKey });
		expect(waiting.blocks.find((b) => b.type === "actions")?.elements.find((e: B) => e.action_id === "send")).toMatchObject({ label: "Email it now" });
		expect(waiting.blocks.find((b) => b.type === "actions")?.elements.find((e: B) => e.action_id === "send")?.confirm).toBeUndefined();
	});
	it("'Email again' resends an emailed message, keeps it, and updates when and to whom", async () => {
		reset({ FORM_OUTBOX_KEEP_SENT: "1", ...EMAIL });
		await seed();
		const key = records().find((r) => r.q.status === "emailed")?.key;
		const fetch = provider(201);
		vi.stubGlobal("fetch", fetch);
		const r = await call({ type: "block_action", action_id: "send", value: key });
		expect(r.toast?.message).toBe("Message emailed again.");
		const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
		expect(body.textContent).toContain("sent again from the website's form messages");
		const q = records().find((x) => x.key === key)?.q;
		expect(q).toMatchObject({ status: "emailed", emailedTo: ["office@example.com", "boss@example.com"], messageId: "<m1@relay.example>" });
		expect(q?.emailedAt).not.toBe("2026-11-18T09:00:00.000Z");
		expect(r.blocks.find((b) => b.type === "fields")?.fields).toContainEqual({ label: "Emailed to", value: "office@example.com, boss@example.com" });
		const activity = [...kv.store.entries()].filter(([k]) => k.startsWith("act:")).map(([, e]) => JSON.parse(e.v).action);
		expect(activity).toContain("Emailed a message again");
		expect(JSON.stringify(log.mock.calls)).not.toMatch(/office@|boss@/);
	});
	it("'Email all now' sends only waiting and failed messages", async () => {
		reset({ FORM_OUTBOX_KEEP_SENT: "1", ...EMAIL });
		await seed();
		const page = await call({ type: "page_load" });
		expect(inbox(page).find((b) => b.type === "actions")?.elements.find((e: B) => e.action_id === "send-all")?.label).toBe("Email 2 waiting messages now");
		const fetch = provider(201);
		vi.stubGlobal("fetch", fetch);
		const r = await call({ type: "block_action", action_id: "send-all" });
		expect(r.toast?.message).toBe("2 messages emailed.");
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(records().map((x) => x.q.status)).toEqual(["emailed", "emailed", "emailed"]);
	});
	it("without keep sent, 'Email it now' still removes the message once emailed", async () => {
		reset(EMAIL);
		await seed();
		const key = records().find((r) => r.q.status === "waiting")?.key;
		vi.stubGlobal("fetch", provider(201));
		const r = await call({ type: "block_action", action_id: "send", value: key });
		expect(r.toast?.message).toBe("Message emailed.");
		expect(records().some((x) => x.key === key)).toBe(false);
	});
	it("the dashboard widget shows the newest messages with keep sent, counts only without", async () => {
		reset({ FORM_OUTBOX_KEEP_SENT: "1" });
		await seed();
		const w = (await plugin.routes.admin.handler(ctx({ type: "page_load" }, { ui: { surface: "dashboard-widget" } }))) as Res;
		expect(w.blocks[0]?.items.map((x: B) => [x.label, x.value])).toEqual([
			["In inbox", 3],
			["Unread", 3],
			["Last 7 days", 0],
		]);
		expect(w.blocks.find((b) => b.type === "table")?.rows.map((x: B) => [x.from, x.delivery])).toEqual([
			["Emma <e@example.com> · new", "Emailed"],
			["Fred <f@example.com> · new", "Failed"],
			["Wendy <w@example.com> · new", "Waiting"],
		]);
		reset({});
		const off = (await plugin.routes.admin.handler(ctx({ type: "page_load" }, { ui: { surface: "dashboard-widget" } }))) as Res;
		expect(off.blocks.some((b) => b.type === "table")).toBe(false);
	});
	it("insights keep counting from stats; 'Waiting now' counts only messages still to be sent", () => {
		const items = [
			{ key: "msg:2026-11-19T10:00:00.000Z:00000001", s: { form: "contact", at: "2026-11-19T10:00:00.000Z", subject: "a", status: "emailed" as const } },
			{ key: "msg:2026-11-19T10:00:01.000Z:00000002", s: { form: "contact", at: "2026-11-19T10:00:01.000Z", subject: "b", status: "waiting" as const } },
		];
		const day = new Date().toISOString().slice(0, 10);
		const o: Overview = { status: "ready", items, more: false, counts: [{ day, outcome: "emailed", form: "contact", count: 1 }, { day, outcome: "kept", form: "contact", count: 1 }], activity: [], days: 30, forms: ["contact"], filter: {}, keepSent: true };
		const tab = (overview(o, TABS.insights).find((b) => b.type === "tab") as B).panels[TABS.insights].blocks as B[];
		expect(tab.find((b) => b.type === "stats")?.items.map((i: B) => [i.label, i.value])).toEqual([
			["Messages, 30 days", 2],
			["Last 7 days", 2],
			["Emailed right away", 1],
			["Kept in the outbox", 1],
		]);
		expect(tab.find((b) => b.type === "table" && b.block_id === "by-form")?.rows[0]).toMatchObject({ waiting: 1 });
		expect(widget({ ...o, status: "held" })[1]).toMatchObject({ type: "context", text: "Email on hold" });
	});
});

describe("keep sent: export and import carry the delivery status", () => {
	const emailed: Queued = { form: "contact", at: "2026-11-01T10:00:00.000Z", attempts: 0, replyTo: { email: "a@example.com", name: "A" }, subject: "S", text: "T", html: "", status: "emailed", emailedAt: "2026-11-01T10:00:02.000Z", emailedTo: ["office@example.com"] };
	const failed: Queued = { form: "contact", at: "2026-11-02T10:00:00.000Z", attempts: 3, subject: "S2", text: "T2", html: "" };
	it("CSV and JSON include the email status and when it was emailed (not the recipients)", () => {
		const csv = toCsv([emailed, failed]);
		expect(csv).toContain('"Email attempts","Email status","Emailed at"');
		expect(csv).toContain('"Emailed","2026-11-01T10:00:02.000Z"');
		expect(csv).toContain('"Failed",""');
		const json = JSON.parse(toJson([emailed, failed]));
		expect(json.messages.map((m: B) => [m.emailStatus, m.emailedAt])).toEqual([
			["emailed", "2026-11-01T10:00:02.000Z"],
			["failed", null],
		]);
		expect(csv + JSON.stringify(json)).not.toContain("office@example.com");
	});
	it("an import keeps 'emailed' (never sent again by the cron); other statuses arrive as waiting", () => {
		for (const file of [toCsv([emailed, failed]), toJson([emailed, failed])]) {
			const { rows, errors } = parseImport(file);
			expect(errors).toEqual([]);
			const [a, b] = rows.map((r) => toQueued(r, { email: true, markRead: false }));
			expect(a).toMatchObject({ status: "emailed", emailedAt: "2026-11-01T10:00:02.000Z", source: "import" });
			expect(b).toMatchObject({ status: "waiting", attempts: 0 });
		}
	});
});

describe("keep sent: configuration", () => {
	const base = { slug: "s", name: "Fixture", source: { url: "https://fixture.example" }, target: { productionUrl: "https://fixture.example" } };
	it("defaults to off; on becomes FORM_OUTBOX_KEEP_SENT=1", () => {
		expect(kitConfigSchema.parse({ ...base, forms: { outbox: {} } }).forms.outbox?.keepSent).toBe(false);
		const on = kitConfigSchema.parse({ ...base, forms: { outbox: { days: 60, keepSent: true } } }).forms.outbox;
		expect(outboxVars(on)).toEqual({ FORM_OUTBOX_DAYS: "60", FORM_OUTBOX_KEEP_SENT: "1" });
		expect(outboxVars({ days: 30, hold: true, keepSent: false })).toEqual({ FORM_OUTBOX_DAYS: "30", FORM_OUTBOX_HOLD: "1" });
		expect(outboxVars(undefined)).toEqual({});
	});
});
