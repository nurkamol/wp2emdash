import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFormEndpoint } from "../packages/forms/src/endpoint.js";
import { FORMS_PLUGIN, type FormDefinition, formsPlugin } from "../packages/forms/src/index.js";
import { createPlugin } from "../packages/forms/src/plugin/index.js";
import { env } from "../test/stubs/cloudflare-workers.js";

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
		expect(Object.keys(pkg.exports)).toEqual([".", "./endpoint", "./outbox", "./deliver", "./plugin", "./types"]);
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
