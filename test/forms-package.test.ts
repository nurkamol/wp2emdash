import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFormEndpoint } from "../packages/forms/src/endpoint.js";
import { FORMS_PLUGIN, type FormDefinition, formsPlugin } from "../packages/forms/src/index.js";
import { type KvLike, writeRecipientSetting } from "../packages/forms/src/outbox.js";
import { createPlugin } from "../packages/forms/src/plugin/index.js";
import { env } from "../test/stubs/cloudflare-workers.js";
import { runtime as emdashRuntime } from "../test/stubs/emdash-middleware.js";

const pkg = JSON.parse(readFileSync(new URL("../packages/forms/package.json", import.meta.url), "utf8")) as { name: string; version: string; exports: Record<string, string> };
const form: FormDefinition = { id: "contact", title: "Contact", submitLabel: "Send", successMessage: "Thanks", fields: [{ name: "email", label: "Email", type: "email", required: true }] };
const POST = createFormEndpoint({ getForm: (id) => (id === "contact" ? form : undefined) });
const send = (id: string, fields: Record<string, string>) => {
	const body = new FormData();
	for (const [k, v] of Object.entries(fields)) body.set(k, v);
	const request = new Request(`https://site.example/api/forms/${id}`, { method: "POST", body, headers: { accept: "application/json" } });
	return (POST as unknown as (ctx: unknown) => Promise<Response>)({ params: { id }, request, locals: {}, clientAddress: "203.0.113.1" });
};

describe("@wp2emdash/forms package", () => {
	afterEach(() => vi.unstubAllGlobals());
	it("descriptor matches the Worker-side plugin and the package exports", () => {
		const d = formsPlugin();
		const p = createPlugin() as unknown as { id: string; version: string };
		expect([d.id, d.version]).toEqual([p.id, p.version]);
		expect(d).toMatchObject({ format: "native", entrypoint: `${pkg.name}/plugin` });
		expect(pkg.version).toBe(FORMS_PLUGIN.version);
		expect(Object.keys(pkg.exports)).toEqual([".", "./endpoint", "./outbox", "./deliver", "./plugin", "./types", "./rich", "./signature", "./signature-pad", "./logic", "./uploads"]);
	});
	it("endpoint: unknown form 404, honeypot answers success without sending", async () => {
		for (const k of Object.keys(env)) delete env[k];
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		expect((await send("nope", {})).status).toBe(404);
		const r = await send("contact", { _hp: "bot", email: "a@example.com" });
		expect(r.status).toBe(200);
		expect(fetch).not.toHaveBeenCalled();
	});
	it("endpoint: refuses without a passing Turnstile check", async () => {
		for (const k of Object.keys(env)) delete env[k];
		Object.assign(env, { TURNSTILE_SECRET_KEY: "s" });
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: false }))));
		expect((await send("contact", { email: "a@example.com", "cf-turnstile-response": "t" })).status).toBe(403);
	});
});

describe("@wp2emdash/forms endpoint: recipients and EmDash email", () => {
	const turnstilePass = () => vi.fn(async (url: string) => (String(url).includes("turnstile") ? new Response(JSON.stringify({ success: true })) : new Response("{}", { status: 201 })));
	const reset = (vars: Record<string, unknown>) => {
		for (const k of Object.keys(env)) delete env[k];
		Object.assign(env, { TURNSTILE_SECRET_KEY: "s", ...vars });
	};
	afterEach(() => {
		vi.unstubAllGlobals();
		emdashRuntime.email = null;
	});
	it("emails the admin's recipients instead of FORM_TO", async () => {
		const kv = memoryKv();
		await writeRecipientSetting({ FORM_OUTBOX: kv }, ["office@example.com"]);
		reset({ FORM_OUTBOX: kv, FORM_TO: "default@example.com", FORM_FROM: "noreply@example.com", EMAIL_API_KEY: "k" });
		const fetch = turnstilePass();
		vi.stubGlobal("fetch", fetch);
		expect((await send("contact", { email: "visitor@example.com", "cf-turnstile-response": "t" })).status).toBe(200);
		const brevo = fetch.mock.calls.find(([u]) => String(u).includes("brevo")) as unknown as [string, RequestInit];
		expect(JSON.parse(String(brevo[1].body)).to).toEqual([{ email: "office@example.com" }]);
	});
	it("EMAIL_PROVIDER=emdash sends through EmDash's pipeline with no API key or sender", async () => {
		reset({ EMAIL_PROVIDER: "emdash", FORM_TO: "a@example.com,b@example.com" });
		const send = vi.fn(async () => {});
		emdashRuntime.email = { isAvailable: () => true, send };
		const fetch = turnstilePass();
		vi.stubGlobal("fetch", fetch);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const r = await send_("visitor@example.com");
		const logged = JSON.stringify(log.mock.calls);
		log.mockRestore();
		expect(r.status).toBe(200);
		expect(fetch).toHaveBeenCalledOnce(); // Turnstile only
		const [message, source] = send.mock.calls[0] as unknown as [Record<string, unknown>, string];
		expect(source).toBe("site-forms");
		expect(message).toMatchObject({ to: "a@example.com", cc: ["b@example.com"], replyTo: "visitor@example.com", subject: "New website message" });
		expect(String(message.text)).toContain("Email: visitor@example.com");
		expect(logged).toContain('\\"via\\":\\"emdash\\"');
		expect(logged).not.toContain("visitor@example.com");
	});
	it("EMAIL_PROVIDER=emdash without an EmDash email provider: kept in the outbox, or 503 without one", async () => {
		const kv = memoryKv();
		reset({ EMAIL_PROVIDER: "emdash", FORM_TO: "a@example.com", FORM_OUTBOX: kv });
		emdashRuntime.email = { isAvailable: () => false, send: vi.fn() };
		vi.stubGlobal("fetch", turnstilePass());
		expect((await send_("visitor@example.com")).status).toBe(200);
		expect([...kv.store.keys()].filter((k) => k.startsWith("msg:"))).toHaveLength(1);
		reset({ EMAIL_PROVIDER: "emdash", FORM_TO: "a@example.com" });
		expect((await send_("visitor@example.com")).status).toBe(503);
	});
	it("EMAIL_PROVIDER=emdash: a provider failure keeps the message in the outbox", async () => {
		const kv = memoryKv();
		reset({ EMAIL_PROVIDER: "emdash", FORM_TO: "a@example.com", FORM_OUTBOX: kv });
		emdashRuntime.email = { isAvailable: () => true, send: vi.fn(async () => Promise.reject(new Error("smtp refused"))) };
		vi.stubGlobal("fetch", turnstilePass());
		expect((await send_("visitor@example.com")).status).toBe(200);
		expect([...kv.store.keys()].filter((k) => k.startsWith("msg:"))).toHaveLength(1);
	});
});

const send_ = (email: string) => send("contact", { email, "cf-turnstile-response": "t" });
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
			return { keys: [...store.keys()].filter((k) => k.startsWith(o?.prefix ?? "")).map((name) => ({ name })), list_complete: true };
		},
	};
}
