/**
 * Chat notifications for form messages (@wp2emdash/forms chat.ts): payload builders per channel, settings parsing, the
 * decision logic, retries through the cron, the never-block guarantee of the endpoint, the admin Settings section and
 * the notification's deep link. All data is synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formsCheck } from "../packages/health/src/checks/forms.js";
import { buildNote, type ChatEnv, type ChatSettings, channelsFor, chatSettingsFromForm, clean, DEFAULT_CHAT, flushChat, inboxLink, keyFromPage, MAX_ATTEMPTS, type Note, notifyChat, parseChatSettings, readChatFailures, readChatSettings, restrict, sendTestNotification, slackPayload, telegramPayload, webhookPayload, writeChatSettings } from "../packages/forms/src/chat.js";
import { createFormEndpoint } from "../packages/forms/src/endpoint.js";
import type { FormDefinition } from "../packages/forms/src/index.js";
import { formsPlugin } from "../packages/forms/src/index.js";
import { enqueueKey, type KvLike } from "../packages/forms/src/outbox.js";
import { createPlugin } from "../packages/forms/src/plugin/index.js";
import { kitConfigSchema } from "../src/config/schema.js";
import { workerVars } from "../src/phases/scaffold.js";
import { env, waited } from "./stubs/cloudflare-workers.js";

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
			return { keys: [...store.entries()].filter(([k]) => k.startsWith(o?.prefix ?? "")).sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, e]) => ({ name, ...(e.meta ? { metadata: e.meta } : {}) })), list_complete: true };
		},
	};
}

const TOKEN = ["123456789", "AAFakeTokenForTestsOnly_abcdefghij"].join(":") /* split: not a real token, keeps secret scanners quiet */;
const SLACK = "https://hooks.slack.example/services/T000/B000/XXXX";
const HOOK = "https://automation.example/hook/abc";
const ON: ChatSettings = { telegram: { on: true, chatId: "-1001234567890" }, slack: { on: true }, webhook: { on: true, format: "json" }, forms: "all", content: "summary" };
const field = (type: string) => ({ type });
const values = [
	{ field: field("text"), value: "Sam Visitor" },
	{ field: field("email"), value: "sam@example.com" },
	{ field: field("tel"), value: "+1 555 0100" },
	{ field: field("file"), value: "scan.pdf — download: https://site.example/api/forms/file?t=x" },
	{ field: field("textarea"), value: "Hello <b>there</b> & welcome.\n\n\nSecond line." },
];
const form = { id: "contact", title: "Contact <us>" };
const note = (s: ChatSettings = ON, e: ChatEnv = {}, f: { id: string; title: string; sensitive?: boolean } = form) => buildNote({ form: f, values, name: "Sam Visitor", at: new Date("2026-11-21T10:05:00Z"), link: "https://site.example/_emdash/admin/plugins/site-forms/messages/2026-11-21T10_05_00.000Z_abcd1234", kept: true, site: "site.example" }, s, e);
const everything = (n: Note) => JSON.stringify([telegramPayload(n, "1"), slackPayload(n), webhookPayload(n, "json"), webhookPayload(n, "text"), webhookPayload(n, "discord")]);

describe("chat payloads", () => {
	it("summary: form, time, name, the start of the message box and the link — never contact details or files", () => {
		const n = note();
		expect(n).toMatchObject({ mode: "summary", name: "Sam Visitor", excerpt: "Hello <b>there</b> & welcome.\nSecond line." });
		const all = everything(n);
		for (const secret of ["sam@example.com", "555 0100", "scan.pdf", "api/forms/file"]) expect(all).not.toContain(secret);
	});
	it("notification only, and on sensitive sites or forms whatever the setting: nothing the visitor wrote", () => {
		for (const n of [note({ ...ON, content: "notice" }), note(ON, { FORM_SENSITIVE: "1" }), note(ON, {}, { ...form, sensitive: true })]) {
			expect(n.mode).toBe("notice");
			expect(n.name).toBeUndefined();
			expect(n.excerpt).toBeUndefined();
			const all = everything(n);
			for (const visitor of ["Sam", "Hello", "there", "sam@example.com"]) expect(all).not.toContain(visitor);
			expect(all).toContain("site-forms/messages/");
		}
		// A retry kept from before the admin switched to notification only drops the visitor's text too.
		expect(restrict(note(), "notice")).not.toHaveProperty("excerpt");
	});
	it("Telegram: HTML parse mode with &, < and > escaped, link previews off", () => {
		const p = telegramPayload(note(), "-1001234567890");
		expect(p).toMatchObject({ chat_id: "-1001234567890", parse_mode: "HTML", link_preview_options: { is_disabled: true } });
		expect(p.text).toContain("<b>New form message: Contact &lt;us&gt;</b>");
		expect(p.text).toContain("<blockquote>Hello &lt;b&gt;there&lt;/b&gt; &amp; welcome.\nSecond line.</blockquote>");
		expect(p.text).toContain('<a href="https://site.example/_emdash/admin/plugins/site-forms/messages/2026-11-21T10_05_00.000Z_abcd1234">Open the message</a>');
		expect(p.text).not.toContain("<b>there");
	});
	it("Slack: mrkdwn with &, < and > escaped (no injected links or mentions), previews off", () => {
		const n = { ...note(), name: "<!channel> <https://evil.example|click>" };
		const p = slackPayload(n);
		expect(p).toMatchObject({ unfurl_links: false, unfurl_media: false });
		expect(p.text).toContain("From: &lt;!channel&gt; &lt;https://evil.example|click&gt;");
		expect(p.text).toContain(">Hello &lt;b&gt;there&lt;/b&gt; &amp; welcome.\n>Second line.");
		expect(p.text).toContain("|Open the message>");
	});
	it("generic webhook: a JSON event, { text } or Discord { content } without pings or visitor markdown", () => {
		const ev = webhookPayload(note(), "json");
		expect(ev).toMatchObject({ event: "form_message", site: "site.example", form: { id: "contact", title: "Contact <us>" }, receivedAt: "2026-11-21T10:05:00.000Z", content: "summary", name: "Sam Visitor", kept: true });
		expect(String(ev.text)).toContain("Open the message: https://site.example/");
		expect(Object.keys(webhookPayload(note(), "text"))).toEqual(["text"]);
		const d = webhookPayload({ ...note(), excerpt: "@everyone [win](https://evil.example) **now**" }, "discord");
		expect(d.allowed_mentions).toEqual({ parse: [] });
		expect(String(d.content)).toContain("@everyone \\[win\\]\\(https://evil.example\\) \\*\\*now\\*\\*");
	});
	it("strips control characters and bidi overrides, collapses blank lines, truncates to about 200 characters", () => {
		expect(clean("a\u0000b\u0007c‮d⁦e\u009Bf", 50)).toBe("abcdef");
		expect(clean("  one \n\n\n two  ", 50, { lines: true })).toBe("one\ntwo");
		const long = note(ON, {}, form);
		expect(long.excerpt?.length).toBeLessThanOrEqual(200);
		const n = buildNote({ form, values: [{ field: field("textarea"), value: "x".repeat(5000) }], at: new Date(), link: "https://s.example/", kept: false }, ON, {});
		expect([...(n.excerpt ?? "")].length).toBe(200);
		expect(n.excerpt?.endsWith("…")).toBe(true);
		expect(n.name).toBeUndefined(); // no name field: no "From"
		expect(webhookPayload(n, "text").text).toContain("not kept in Form messages");
	});
});

describe("chat settings and the decision", () => {
	const secrets: ChatEnv = { FORM_OUTBOX: memoryKv(), TELEGRAM_BOT_TOKEN: TOKEN, SLACK_WEBHOOK_URL: SLACK, CHAT_WEBHOOK_URL: HOOK };
	it("parses anything into safe defaults (everything off)", () => {
		expect(parseChatSettings(undefined)).toEqual(DEFAULT_CHAT);
		expect(parseChatSettings({ telegram: { on: "yes", chatId: "not an id" }, slack: { on: 1 }, webhook: { on: true, format: "xml" }, forms: ["ok", "bad id!", 3], content: "everything" })).toEqual({ telegram: { on: false }, slack: { on: false }, webhook: { on: true, format: "json" }, forms: ["ok"], content: "summary" });
	});
	it("the admin form: a channel without its secret cannot be on; Telegram needs a chat id; sensitive sites keep notification only", () => {
		const v = { telegram_on: true, telegram_chat_id: "-1001234567890", slack_on: true, webhook_on: true, webhook_format: "discord", content: "summary", forms_scope: "all" };
		expect(chatSettingsFromForm(v, { env: secrets, forms: ["contact"] })).toEqual({ settings: { ...ON, webhook: { on: true, format: "discord" } }, errors: [] });
		const noSecrets = chatSettingsFromForm(v, { env: { FORM_OUTBOX: memoryKv() }, forms: [] }).settings;
		expect([noSecrets.telegram.on, noSecrets.slack.on, noSecrets.webhook.on]).toEqual([false, false, false]);
		expect(chatSettingsFromForm({ ...v, telegram_chat_id: "" }, { env: secrets, forms: [] }).errors).toEqual(["Telegram needs a chat id before it can be turned on."]);
		expect(chatSettingsFromForm({ ...v, telegram_chat_id: "chat 1" }, { env: secrets, forms: [] }).errors[0]).toMatch(/chat id is a number/);
		expect(chatSettingsFromForm(v, { env: { ...secrets, FORM_SENSITIVE: "1" }, forms: [] }).settings.content).toBe("notice");
		expect(chatSettingsFromForm({ ...v, forms_scope: "pick", forms_picked: ["contact", "unknown"] }, { env: secrets, forms: ["contact", "quote"] }).settings.forms).toEqual(["contact"]);
		expect(chatSettingsFromForm({ ...v, forms_scope: "pick", forms_picked: [] }, { env: secrets, forms: ["contact"] }).errors).toEqual(["Pick at least one form, or choose All forms."]);
	});
	it("which channels: on, with a secret that looks right, for a form that notifies; never for test messages or with FORM_CHAT=0", () => {
		expect(channelsFor(ON, secrets, "contact")).toEqual(["telegram", "slack", "webhook"]);
		expect(channelsFor({ ...ON, forms: ["quote"] }, secrets, "contact")).toEqual([]);
		expect(channelsFor({ ...ON, forms: ["quote", "contact"] }, secrets, "contact")).toHaveLength(3);
		expect(channelsFor(ON, secrets, "contact", { test: true })).toEqual([]);
		expect(channelsFor(ON, { ...secrets, FORM_CHAT: "0" }, "contact")).toEqual([]);
		expect(channelsFor(ON, { ...secrets, FORM_OUTBOX: undefined }, "contact")).toEqual([]);
		expect(channelsFor(ON, { ...secrets, TELEGRAM_BOT_TOKEN: "nope", SLACK_WEBHOOK_URL: "http://insecure.example/x" }, "contact")).toEqual(["webhook"]);
		expect(channelsFor({ ...ON, telegram: { on: true } }, secrets, "contact")).toEqual(["slack", "webhook"]);
		expect(channelsFor(DEFAULT_CHAT, secrets, "contact")).toEqual([]);
	});
	it("deep links: a message key maps to a URL-safe admin path and back", () => {
		const key = "msg:2026-11-21T10:05:00.000Z:abcd1234";
		const url = inboxLink("https://site.example", "site-forms", key);
		expect(url).toBe("https://site.example/_emdash/admin/plugins/site-forms/messages/2026-11-21T10_05_00.000Z_abcd1234");
		expect(keyFromPage(new URL(url).pathname.replace("/_emdash/admin/plugins/site-forms", ""))).toBe(key);
		expect(inboxLink("https://site.example", "site-forms")).toBe("https://site.example/_emdash/admin/plugins/site-forms/messages");
		for (const bad of ["/messages", "/messages/../x", "/messages/2026_zzzz", 3]) expect(keyFromPage(bad)).toBeUndefined();
	});
});

describe("chat delivery: retries and give-ups", () => {
	let kv: ReturnType<typeof memoryKv>;
	let e: ChatEnv;
	beforeEach(async () => {
		kv = memoryKv();
		e = { FORM_OUTBOX: kv, TELEGRAM_BOT_TOKEN: TOKEN, SLACK_WEBHOOK_URL: SLACK };
		await writeChatSettings(e, ON);
		vi.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(() => vi.restoreAllMocks());
	const msg = { form, values, name: "Sam Visitor", at: new Date(), origin: "https://site.example", pluginId: "site-forms", key: "msg:2026-11-21T10:05:00.000Z:abcd1234" };
	const jobs = () => [...kv.store.keys()].filter((k) => k.startsWith("chat:"));

	it("sends now; a failed channel becomes a job for the cron, which retries it and finally gives up with a count", async () => {
		const f = vi.fn(async (url: string) => new Response("{}", { status: url.includes("telegram") ? 200 : 500 }));
		expect(await notifyChat(e, msg, f)).toEqual({ sent: ["telegram"], failed: ["slack"] });
		expect(f).toHaveBeenCalledTimes(2);
		expect(f.mock.calls.find(([u]) => u.includes("api.telegram.org/bot123456789:"))?.[0]).toMatch(/\/sendMessage$/);
		expect(jobs()).toHaveLength(1);
		for (let i = 2; i < MAX_ATTEMPTS; i++) expect(await flushChat(e, f)).toEqual({ sent: 0, retry: 1, dropped: 0 });
		expect(jobs()).toHaveLength(1);
		await flushChat(e, f); // the last attempt
		expect(jobs()).toHaveLength(0);
		expect(await readChatFailures(e, "2000-01-01")).toEqual({ telegram: 0, slack: 1, webhook: 0 });
		expect(f.mock.calls.filter(([u]) => u.includes("telegram"))).toHaveLength(1); // the channel that worked is never resent
	});
	it("a retry succeeds; a channel turned off meanwhile is dropped", async () => {
		const failing = vi.fn(async () => new Response("", { status: 502 }));
		await notifyChat(e, msg, failing);
		expect(jobs()).toHaveLength(1);
		const ok = vi.fn(async () => new Response("{}"));
		expect(await flushChat(e, ok)).toEqual({ sent: 2, retry: 0, dropped: 0 });
		await notifyChat(e, msg, failing);
		await writeChatSettings(e, { ...ON, slack: { on: false } });
		expect(await flushChat(e, ok)).toEqual({ sent: 1, retry: 0, dropped: 1 });
		expect(jobs()).toHaveLength(0);
	});
	it("never throws: a network error, a broken KV or a thrown fetch are swallowed", async () => {
		const thrown = vi.fn(async () => {
			throw new TypeError("network down");
		});
		await expect(notifyChat(e, msg, thrown)).resolves.toEqual({ sent: [], failed: ["telegram", "slack"] });
		const broken: ChatEnv = { ...e, FORM_OUTBOX: { ...kv, get: async () => Promise.reject(new Error("kv")), put: async () => Promise.reject(new Error("kv")) } };
		await expect(notifyChat(broken, msg, thrown)).resolves.toEqual({ sent: [], failed: [] });
	});
	it("logs channel names and counts only — never the token, a webhook URL, the chat id or visitor text", async () => {
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await notifyChat(e, msg, vi.fn(async () => new Response("", { status: 500 })));
		await flushChat(e, vi.fn(async () => new Response("", { status: 500 })));
		const logged = JSON.stringify(log.mock.calls);
		for (const s of [TOKEN, SLACK, "-1001234567890", "Sam", "Hello"]) expect(logged).not.toContain(s);
		expect(logged).toContain("slack");
	});
	it("the test notification: no visitor data, at most once a minute", async () => {
		const f = vi.fn(async (_u: string, _i: RequestInit) => new Response("{}"));
		const now = Date.parse("2026-11-21T10:00:00Z");
		expect(await sendTestNotification(e, { origin: "https://site.example", pluginId: "site-forms", now }, f)).toEqual({ result: "sent", sent: ["telegram", "slack"], failed: [] });
		expect(String(f.mock.calls[0]?.[1].body)).toContain("Test notification");
		expect(await sendTestNotification(e, { origin: "https://site.example", pluginId: "site-forms", now: now + 20_000 }, f)).toEqual({ result: "limited", seconds: 40 });
		await writeChatSettings(e, DEFAULT_CHAT);
		expect(await sendTestNotification(e, { origin: "https://site.example", pluginId: "site-forms", now: now + 120_000 }, f)).toEqual({ result: "none" });
	});
});

describe("chat: the form endpoint never waits for or fails on a notification", () => {
	const contact: FormDefinition = { id: "contact", title: "Contact", submitLabel: "Send", successMessage: "Thanks", fields: [{ name: "name", label: "Name", type: "text" }, { name: "email", label: "Email", type: "email", required: true }, { name: "message", label: "Message", type: "textarea" }] };
	const POST = createFormEndpoint({ getForm: (id) => (id === "contact" ? contact : undefined) });
	const submit = () => {
		const body = new FormData();
		for (const [k, v] of Object.entries({ name: "Sam", email: "sam@example.com", message: "Please call me", "cf-turnstile-response": "t" })) body.set(k, v);
		const request = new Request("https://site.example/api/forms/contact", { method: "POST", body, headers: { accept: "application/json" } });
		return (POST as unknown as (ctx: unknown) => Promise<Response>)({ params: { id: "contact" }, request, locals: {}, clientAddress: "203.0.113.1" });
	};
	let kv: ReturnType<typeof memoryKv>;
	beforeEach(async () => {
		kv = memoryKv();
		for (const k of Object.keys(env)) delete env[k];
		Object.assign(env, { TURNSTILE_SECRET_KEY: "s", FORM_OUTBOX: kv, FORM_OUTBOX_KEEP_SENT: "1", EMAIL_API_KEY: "k", FORM_FROM: "noreply@site.example", FORM_TO: "office@site.example", TELEGRAM_BOT_TOKEN: TOKEN });
		await writeChatSettings(env, { ...ON, slack: { on: false }, webhook: { on: false, format: "json" } });
		waited.length = 0;
		vi.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});
	const fetchWith = (telegram: () => Promise<Response>) => vi.fn((url: string) => (String(url).includes("turnstile") ? Promise.resolve(new Response(JSON.stringify({ success: true }))) : String(url).includes("telegram") ? telegram() : Promise.resolve(new Response("{}", { status: 201 }))));

	it("answers the visitor while Telegram hangs: the notification runs in waitUntil", async () => {
		vi.stubGlobal("fetch", fetchWith(() => new Promise<Response>(() => {})));
		const r = await submit();
		expect(r.status).toBe(200);
		expect(waited).toHaveLength(1);
	});
	it("a failing chat service still answers 200, and the notification links to the kept message", async () => {
		const f = fetchWith(() => Promise.reject(new TypeError("down")));
		vi.stubGlobal("fetch", f);
		expect((await submit()).status).toBe(200);
		await Promise.all(waited);
		const job = [...kv.store.entries()].find(([k]) => k.startsWith("chat:"));
		const stored = JSON.parse(job?.[1].v ?? "{}") as { note: Note; channels: string[]; attempts: number };
		expect(stored).toMatchObject({ channels: ["telegram"], attempts: 1, note: { form: "contact", name: "Sam", excerpt: "Please call me", kept: true } });
		const msgKey = [...kv.store.keys()].find((k) => k.startsWith("msg:")) as string;
		expect(keyFromPage(new URL(stored.note.link).pathname.replace("/_emdash/admin/plugins/site-forms", ""))).toBe(msgKey);
		expect(JSON.stringify(stored)).not.toContain("sam@example.com");
	});
	it("test messages (FORM_LIVE_HOST set, another host) are never announced", async () => {
		Object.assign(env, { FORM_LIVE_HOST: "live.example", FORM_TEST_TO: "dev@agency.example" });
		const f = fetchWith(async () => new Response("{}"));
		vi.stubGlobal("fetch", f);
		expect((await submit()).status).toBe(200);
		await Promise.all(waited);
		expect(f.mock.calls.some(([u]) => String(u).includes("telegram"))).toBe(false);
	});
});

describe("chat: Form messages → Settings", () => {
	type B = Record<string, any>;
	type Res = { blocks: B[]; toast?: { message: string; type: string } };
	const plugin = createPlugin({ forms: [{ id: "contact", title: "Contact" }, { id: "quote", title: "Get a quote" }] }) as unknown as { routes: { admin: { handler: (ctx: unknown) => Promise<unknown> } } };
	const call = (input: unknown, role = 50) => plugin.routes.admin.handler({ input, request: new Request("https://site.example/_emdash/api/plugins/site-forms/admin"), user: { id: "u1", email: "owner@example.com", name: "Owner", role }, log: { info: () => {} } }) as Promise<Res>;
	const chatBlocks = (r: Res) => {
		const blocks = (r.blocks.find((b) => b.type === "tab")?.panels[4]?.blocks ?? []) as B[];
		return blocks.slice(blocks.findIndex((b) => b.type === "header" && b.text === "Chat notifications"));
	};
	let kv: ReturnType<typeof memoryKv>;
	beforeEach(() => {
		kv = memoryKv();
		for (const k of Object.keys(env)) delete env[k];
		Object.assign(env, { FORM_OUTBOX: kv, FORM_OUTBOX_HOLD: "1" });
	});
	afterEach(() => vi.unstubAllGlobals());

	it("without secrets: no switches, and how to set each secret", async () => {
		const c = chatBlocks(await call({ type: "page_load", page: "/messages" }));
		expect(c.find((b) => b.type === "form")).toBeUndefined();
		const hints = c.filter((b) => b.type === "context").map((b) => b.text).join("\n");
		for (const s of ["TELEGRAM_BOT_TOKEN", "SLACK_WEBHOOK_URL", "CHAT_WEBHOOK_URL"]) expect(hints).toContain(`wrangler secret put ${s}`);
		expect(c.find((b) => b.type === "fields")?.fields.map((f: B) => f.value)).toEqual(["Secret not set", "Secret not set", "Secret not set"]);
		expect(c.some((b) => b.type === "actions")).toBe(false);
	});
	it("with a secret: switch, chat id, content and the form picker; saving stores cfg:chat; the test button sends", async () => {
		Object.assign(env, { TELEGRAM_BOT_TOKEN: TOKEN });
		const first = chatBlocks(await call({ type: "page_load", page: "/messages" }));
		const ids = first.find((b) => b.type === "form")?.fields.map((f: B) => f.action_id);
		expect(ids).toEqual(["telegram_on", "telegram_chat_id", "content", "forms_scope", "forms_picked"]);
		const saved = await call({ type: "form_submit", action_id: "chat", values: { telegram_on: true, telegram_chat_id: "-1001234567890", content: "notice", forms_scope: "pick", forms_picked: ["quote"] } });
		expect(saved.toast).toEqual({ message: "Chat notifications on: Telegram.", type: "success" });
		expect(await readChatSettings(env as ChatEnv)).toMatchObject({ telegram: { on: true, chatId: "-1001234567890" }, content: "notice", forms: ["quote"] });
		const f = vi.fn(async () => new Response("{}"));
		vi.stubGlobal("fetch", f);
		const t = await call({ type: "block_action", action_id: "chat-test" });
		expect(t.toast).toEqual({ message: "Test sent to Telegram.", type: "success" });
		expect((await call({ type: "block_action", action_id: "chat-test" })).toast?.message).toMatch(/Try again in/);
		expect(f).toHaveBeenCalledOnce();
		// The activity log records the change, never the chat id.
		expect(JSON.stringify([...kv.store.entries()].filter(([k]) => k.startsWith("act:")))).not.toContain("-1001234567890");
	});
	it("sensitive sites: no content choice, a notification-only banner", async () => {
		Object.assign(env, { TELEGRAM_BOT_TOKEN: TOKEN, FORM_SENSITIVE: "1" });
		const c = chatBlocks(await call({ type: "page_load", page: "/messages" }));
		expect(c.find((b) => b.type === "banner")?.title).toBe("Notification only");
		expect(c.find((b) => b.type === "form")?.fields.some((f: B) => f.action_id === "content")).toBe(false);
	});
	it("FORM_CHAT=0: the section says it is off", async () => {
		Object.assign(env, { FORM_CHAT: "0", TELEGRAM_BOT_TOKEN: TOKEN });
		const c = chatBlocks(await call({ type: "page_load", page: "/messages" }));
		expect(c.map((b) => b.type)).toEqual(["header", "context"]);
	});
	it("a notification's link opens the message on page load (marked read); a gone message says so", async () => {
		const key = (await enqueueKey(env, { form: "contact", replyTo: { email: "sam@example.com", name: "Sam" }, subject: "New website message from Sam", text: "Hello", html: "" })) as string;
		const page = new URL(inboxLink("https://site.example", "site-forms", key)).pathname.replace("/_emdash/admin/plugins/site-forms", "");
		const r = await call({ type: "page_load", page });
		expect(r.blocks[0]).toEqual({ type: "header", text: "New website message from Sam" });
		expect(JSON.parse(kv.store.get(key)?.v ?? "{}").readAt).toBeDefined();
		kv.store.delete(key);
		expect((await call({ type: "page_load", page })).toast?.message).toMatch(/no longer here/);
	});
	it("descriptor: the site's forms ride in the plugin options", () => {
		expect(formsPlugin({ forms: [{ id: "contact", title: "Contact" }] })).toMatchObject({ options: { forms: [{ id: "contact", title: "Contact" }] } });
		expect(formsPlugin()).not.toHaveProperty("options");
	});
});

describe("chat: kit wiring and Site health", () => {
	const config = (extra: Record<string, unknown> = {}) => kitConfigSchema.parse({ slug: "acme", name: "Acme", source: { url: "https://acme.example" }, target: { productionUrl: "https://acme.example" }, email: { from: "Acme <noreply@acme.example>", to: ["owner@acme.example"] }, forms: { outbox: { days: 30 } }, ...extra });
	it("worker vars: FORM_SENSITIVE on sensitiveData sites, FORM_CHAT=0 when forms.chat is false, nothing by default", () => {
		const plain = workerVars(config(), { staging: false, productionHost: "acme.example" }).production;
		expect(plain).not.toHaveProperty("FORM_CHAT");
		expect(plain).not.toHaveProperty("FORM_SENSITIVE");
		expect(workerVars(config({ sensitiveData: true, forms: { sensitive: "contact-only", outbox: { days: 30 } } }), { staging: false, productionHost: "acme.example" }).production.FORM_SENSITIVE).toBe("1");
		expect(workerVars(config({ forms: { chat: false, outbox: { days: 30 } } }), { staging: true, productionHost: "acme.example" }).staging.FORM_CHAT).toBe("0");
	});
	it("Site health: chat give-ups turn an ok forms check into a warning with a line", () => {
		const ok = formsCheck({ outbox: true, status: "ready", waiting: 0, failed: 0, week: 3, chatFailed: 2 }, "t");
		expect(ok.status).toBe("warn");
		expect(ok.detail?.at(-1)).toMatch(/2 chat notifications could not be delivered/);
		expect(formsCheck({ outbox: true, status: "no-email", waiting: 2, failed: 0, week: 2, chatFailed: 1 }, "t").status).toBe("fail");
		expect(formsCheck({ outbox: true, status: "ready", waiting: 0, failed: 0, week: 3 }, "t").status).toBe("ok");
	});
});
