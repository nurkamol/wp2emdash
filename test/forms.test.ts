import { afterEach, describe, expect, it, vi } from "vitest";
import { applySensitivePolicy, type FormDefinitionOut, fluentFormToDefinition } from "../src/scaffold/forms.js";
import { deliver, parseAddress } from "../packages/forms/src/deliver.js";

const def = (sensitive: boolean): FormDefinitionOut => ({
	id: "fluent-forms-1",
	title: "Contact",
	submitLabel: "Send",
	successMessage: "Thanks",
	fields: [
		{ name: "first_name", label: "First Name", type: "text", required: true, autocomplete: "given-name" },
		{ name: "email", label: "Email", type: "email", required: true },
		{ name: "phone", label: "Phone", type: "tel" },
		{ name: "description", label: "Comment", type: "textarea" },
		{ name: "injury", label: "Injury", type: "text" },
	],
	...(sensitive ? { sensitive: true } : {}),
	warnings: [],
});

describe("sensitive form policy", () => {
	it("leaves non-sensitive forms alone", () => {
		expect(applySensitivePolicy(def(false), undefined, "n").fields).toHaveLength(5);
	});
	it("blocks a sensitive form until the owner chooses a policy", () => {
		expect(applySensitivePolicy(def(true), undefined, "n").warnings[0]).toMatch(/forms\.sensitive/);
	});
	it("contact-only keeps name, email and phone, reports the rest and adds the notice", () => {
		const out = applySensitivePolicy(def(true), "contact-only", "No health details, please.");
		expect(out.fields.map((f) => f.name)).toEqual(["first_name", "email", "phone"]);
		expect(out.withheld).toEqual(["Comment", "Injury"]);
		expect(out.notice).toBe("No health details, please.");
		expect(out.warnings).toEqual([]);
	});
});

describe("fluent forms confirmation", () => {
	it("keeps the success message and the hide-form behaviour", () => {
		const raw = { id: "9", title: "Contact", form: { form_fields: { fields: [{ element: "input_email", attributes: { name: "email" }, settings: { label: "Email" } }] } }, settings: { formSettings: [{ value: { confirmation: { messageToShow: "<p>Thanks!</p>", samePageFormBehavior: "hide_form" } } }] } };
		const def = fluentFormToDefinition(raw, false);
		expect([def.successMessage, def.afterSubmit]).toEqual(["Thanks!", "hide"]);
	});
});

describe("email delivery", () => {
	afterEach(() => vi.unstubAllGlobals());
	it("parses sender addresses", () => {
		expect(parseAddress("Website <noreply@example.com>")).toEqual({ email: "noreply@example.com", name: "Website" });
		expect(parseAddress("noreply@example.com")).toEqual({ email: "noreply@example.com" });
		expect(parseAddress("not an address")).toBeUndefined();
	});
	it("sends through Brevo's transactional API", async () => {
		const fetch = vi.fn(async () => new Response(JSON.stringify({ messageId: "<x@relay>" }), { status: 201 }));
		vi.stubGlobal("fetch", fetch);
		const r = await deliver("brevo", "key-123", { from: { email: "noreply@example.com", name: "Site" }, to: ["owner@example.com"], replyTo: { email: "visitor@example.com" }, subject: "S", text: "T", html: "<p>H</p>" });
		expect(r).toEqual({ ok: true });
		const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe("https://api.brevo.com/v3/smtp/email");
		expect((init.headers as Record<string, string>)["api-key"]).toBe("key-123");
		expect(JSON.parse(String(init.body))).toEqual({ sender: { email: "noreply@example.com", name: "Site" }, to: [{ email: "owner@example.com" }], replyTo: { email: "visitor@example.com" }, subject: "S", htmlContent: "<p>H</p>", textContent: "T" });
	});
	it.each([
		["resend", "https://api.resend.com/emails", 200, (h: Record<string, string>) => h.authorization === "Bearer k"],
		["postmark", "https://api.postmarkapp.com/email", 200, (h: Record<string, string>) => h["x-postmark-server-token"] === "k"],
		["sendgrid", "https://api.sendgrid.com/v3/mail/send", 202, (h: Record<string, string>) => h.authorization === "Bearer k"],
		["mailgun", "https://api.mailgun.net/v3/example.com/messages", 200, (h: Record<string, string>) => h.authorization === `Basic ${btoa("api:k")}`],
	])("sends through %s", async (provider, url, status, auth) => {
		const fetch = vi.fn(async () => new Response("{}", { status }));
		vi.stubGlobal("fetch", fetch);
		expect(await deliver(provider, "k", { from: { email: "noreply@example.com", name: "Site" }, to: ["owner@example.com"], subject: "S", text: "T", html: "<p>H</p>" })).toEqual({ ok: true });
		const [u, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
		expect(u).toBe(url);
		expect(auth(init.headers as Record<string, string>)).toBe(true);
	});
	it("reports a provider error without the message content", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
		expect(await deliver("brevo", "bad", { from: { email: "a@b.co" }, to: ["c@d.co"], subject: "secret subject", text: "secret", html: "secret" })).toEqual({ ok: false, status: 401, reason: "brevo HTTP 401" });
	});
});

describe("contact-and-message policy", () => {
	it("keeps contact fields and the first message box, withholds the rest, adds the notice", async () => {
		const { applySensitivePolicy } = await import("../src/scaffold/forms.js");
		const def = {
			id: "f",
			title: "Contact",
			submitLabel: "Send",
			successMessage: "Thanks",
			sensitive: true,
			warnings: [],
			fields: [
				{ name: "name", label: "Full Name", type: "text" as const },
				{ name: "email", label: "Email", type: "email" as const },
				{ name: "comment", label: "Comment", type: "textarea" as const },
				{ name: "notes", label: "Notes", type: "textarea" as const },
				{ name: "insurance", label: "Insurance", type: "select" as const, options: ["a", "b"] },
			],
		};
		const out = applySensitivePolicy(def, "contact-and-message", "No health details, please.");
		expect(out.fields.map((f) => f.name)).toEqual(["name", "email", "comment"]);
		expect(out.withheld).toEqual(["Notes", "Insurance"]);
		expect(out.notice).toBe("No health details, please.");
		expect(applySensitivePolicy(def, "contact-only", "n").fields.map((f) => f.name)).toEqual(["name", "email"]);
	});
});
