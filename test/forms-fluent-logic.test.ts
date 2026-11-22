/**
 * Fluent Forms conditional logic on a checkbox group: "=" means "this option is ticked" (among others), and "any" over
 * several options of one group is "one of them is ticked". Carried as showIf, enforced by the endpoint (required only
 * while shown, value dropped when hidden). Fixture is synthetic (test/fixtures/fluent). Golden: UPDATE_GOLDEN=1 pnpm test.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFormEndpoint } from "../packages/forms/src/endpoint.js";
import type { FormDefinition } from "../packages/forms/src/index.js";
import { fluentFormToDefinition } from "../src/scaffold/forms.js";
import { env } from "./stubs/cloudflare-workers.js";

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "fluent", "conditional-other.json"), "utf8"));
const goldenPath = join(import.meta.dirname, "golden", "fluent", "conditional-other.json");

describe("Fluent conditional logic on a checkbox group", () => {
	const def = fluentFormToDefinition(fixture, false);
	it("matches the golden definition", () => {
		const got = `${JSON.stringify(def, null, 2)}\n`;
		if (process.env.UPDATE_GOLDEN === "1" || !existsSync(goldenPath)) writeFileSync(goldenPath, got);
		expect(got).toBe(readFileSync(goldenPath, "utf8"));
	});
	it("keeps the name parts and carries both rules (nothing reported as not carried)", () => {
		expect(def.fields.map((f) => `${f.type}:${f.name}`)).toEqual(["text:first_name", "text:middle_name", "text:last_name", "email:email", "checkbox:checkbox", "text:input_text", "checkbox:checkbox_1"]);
		expect(def.fields.find((f) => f.name === "middle_name")).toMatchObject({ autocomplete: "additional-name" });
		expect(def.fields.find((f) => f.name === "middle_name")?.required).toBeUndefined();
		// The rule compares Fluent's option value ("Other"); the rebuilt form submits the label.
		expect(def.fields.find((f) => f.name === "input_text")).toMatchObject({ required: true, showIf: { field: "checkbox", equals: ["Something else (tell us)"] } });
		expect(def.fields.find((f) => f.name === "checkbox_1")?.showIf).toEqual({ field: "checkbox", equals: ["Mat basics", "Reformer flow", "Barre fusion", "Prenatal"] });
		expect(def.notes ?? []).toEqual([]);
		expect(def.warnings).toEqual([]);
	});
	it("contains / doNotContains on a group are membership; names[part] resolves; a rule on the field itself is reported", () => {
		const raw = structuredClone(fixture);
		const fields = raw.form.form_fields.fields;
		fields[3].settings.conditional_logics.conditions = [{ field: "checkbox", value: "Other", operator: "contains" }];
		fields[4].settings.conditional_logics = { status: true, type: "all", conditions: [{ field: "checkbox", value: "Prenatal", operator: "doNotContains" }] };
		fields[1].settings.conditional_logics = { status: true, type: "any", conditions: [{ field: "names[first_name]", value: "x", operator: "!=" }] };
		fields[2].settings.conditional_logics = { status: true, type: "any", conditions: [{ field: "checkbox", value: "Other", operator: "=" }] };
		const d = fluentFormToDefinition(raw, false);
		expect(d.fields.find((f) => f.name === "input_text")?.showIf).toEqual({ field: "checkbox", equals: ["Something else (tell us)"] });
		expect(d.fields.find((f) => f.name === "checkbox_1")?.showIf).toEqual({ field: "checkbox", equals: ["Prenatal"], not: true });
		expect(d.fields.find((f) => f.name === "email")?.showIf).toEqual({ field: "first_name", equals: ["x"], not: true });
		expect(d.fields.find((f) => f.name === "checkbox")?.showIf).toBeUndefined();
		expect(d.notes).toEqual(["“Which classes interest you?”: conditional logic not carried (it depends on the field itself); the field is always shown"]);
	});
	it("ticking several options together is still reported when the rule needs all of them", () => {
		const raw = structuredClone(fixture);
		raw.form.form_fields.fields[4].settings.conditional_logics.type = "all";
		const d = fluentFormToDefinition(raw, false);
		expect(d.fields.find((f) => f.name === "checkbox_1")?.showIf).toBeUndefined();
		expect(d.notes?.[0]).toMatch(/^“Preferred times”: conditional logic not carried \(a combination the rebuilt form cannot express/);
	});
});

describe("the endpoint enforces the converted rules", () => {
	const form = { ...fluentFormToDefinition(fixture, false), id: "interest" } as FormDefinition;
	const POST = createFormEndpoint({ getForm: (id) => (id === "interest" ? form : undefined) }) as unknown as (ctx: unknown) => Promise<Response>;
	const submit = (fields: [string, string][]) => {
		const body = new FormData();
		for (const [k, v] of [["cf-turnstile-response", "t"], ["first_name", "Ada"], ["last_name", "Lane"], ["email", "a@b.example"], ...fields] as [string, string][]) body.append(k, v);
		return POST({ params: { id: "interest" }, request: new Request("https://site.example/api/forms/interest", { method: "POST", body, headers: { accept: "application/json" } }), locals: {} });
	};
	let sent: string[];
	let log: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		sent = [];
		for (const k of Object.keys(env)) delete env[k];
		Object.assign(env, { TURNSTILE_SECRET_KEY: "s", EMAIL_API_KEY: "k", FORM_FROM: "noreply@site.example", FORM_TO: "office@site.example" });
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				if (String(url).includes("turnstile")) return new Response(JSON.stringify({ success: true }));
				sent.push(JSON.parse(String(init?.body)).textContent);
				return new Response(JSON.stringify({ messageId: "m" }), { status: 201 });
			}),
		);
		log = vi.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		log.mockRestore();
	});

	it("the required text field is required only while 'something else' is ticked, among other options", async () => {
		expect((await submit([["checkbox", "Mat basics"]])).status).toBe(200);
		const r = await submit([["checkbox", "Mat basics"], ["checkbox", "Something else (tell us)"]]);
		expect(r.status).toBe(422);
		expect(((await r.json()) as { errors: Record<string, string> }).errors).toEqual({ input_text: "What else would you like to try? is required." });
		expect((await submit([["checkbox", "Something else (tell us)"], ["input_text", "Aerial yoga"]])).status).toBe(200);
		expect(sent.at(-1)).toMatch(/Aerial yoga/);
	});
	it("hidden fields' values are dropped (no JS: every field was shown and filled in)", async () => {
		expect((await submit([["checkbox", "Mat basics"], ["input_text", "hidden text value"], ["checkbox_1", "Mornings"]])).status).toBe(200);
		expect(sent.at(-1)).not.toMatch(/hidden text value/);
		expect(sent.at(-1)).toMatch(/Mornings/);
		// Only "something else" ticked: the times group (any of the four classes) is hidden, its answer dropped.
		expect((await submit([["checkbox", "Something else (tell us)"], ["input_text", "Aerial yoga"], ["checkbox_1", "Evenings"]])).status).toBe(200);
		expect(sent.at(-1)).not.toMatch(/Evenings/);
	});
});
