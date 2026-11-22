/**
 * CRM / mailing-list sync for form messages (@wp2emdash/forms crm.ts): field mapping, consent rules, provider request
 * builders (no network: fake fetch), retries with backoff through the cron, the sensitive-data refusal (settings, new
 * messages, retries), the admin Settings section and the scaffold wiring. All data is synthetic.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { autoMap, BACKOFF_MINUTES, brevoRequest, buildContact, type Contact, type CrmEnv, type CrmForm, type CrmSettings, crmSecretSet, crmSettingsFromForm, defaultCrm, e164, flushCrm, hubspotCreate, hubspotUpdate, MAX_ATTEMPTS, mailchimpRequest, mailchimpServer, md5, parseCrmSettings, providersFor, readCrmSettings, readCrmStatus, scrub, sendToProvider, syncCrm, writeCrmSettings } from "../packages/forms/src/crm.js";
import { createFormEndpoint } from "../packages/forms/src/endpoint.js";
import { type FormDefinition, formsPlugin, pluginForm } from "../packages/forms/src/index.js";
import type { KvLike } from "../packages/forms/src/outbox.js";
import { createPlugin } from "../packages/forms/src/plugin/index.js";
import { kitConfigSchema } from "../src/config/schema.js";
import { workerVars } from "../src/phases/scaffold.js";
import { env, waited } from "./stubs/cloudflare-workers.js";

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
			return { keys: [...store.entries()].filter(([k]) => k.startsWith(o?.prefix ?? "")).sort(([a], [b]) => (a < b ? -1 : 1)).map(([name, e]) => ({ name, ...(e.meta ? { metadata: e.meta } : {}) })), list_complete: true };
		},
	};
}

// Split so secret scanners stay quiet: none of these is a real credential.
const BREVO = ["xkeysib", "0000000000000000fake-test-key"].join("-");
const HUBSPOT = ["pat", "na1", "00000000-0000-0000-0000-000000000000"].join("-");
const MAILCHIMP = `${"0".repeat(32)}-us21`;
const KEYS: CrmEnv = { BREVO_API_KEY: BREVO, HUBSPOT_TOKEN: HUBSPOT, MAILCHIMP_API_KEY: MAILCHIMP };

const contactForm: CrmForm & FormDefinition = {
	id: "contact",
	title: "Contact",
	submitLabel: "Send",
	successMessage: "Thanks",
	fields: [
		{ name: "your-name", label: "Your name", type: "text", autocomplete: "name" },
		{ name: "your-email", label: "Email", type: "email", required: true },
		{ name: "phone", label: "Phone", type: "tel" },
		{ name: "company", label: "Company", type: "text" },
		{ name: "notes", label: "Notes (internal)", type: "text" },
		{ name: "message", label: "Message", type: "textarea" },
		{ name: "terms", label: "I accept the terms", type: "consent", required: true },
		{ name: "newsletter", label: "Send me the newsletter", type: "checkbox" },
	],
};
const field = (name: string) => contactForm.fields.find((f) => f.name === name) as { name: string; type: string };
const values = (o: { newsletter?: boolean } = {}) => [
	{ field: field("your-name"), value: "Sam Q Visitor" },
	{ field: field("your-email"), value: "sam@example.com" },
	{ field: field("phone"), value: "+1 (555) 010-0199" },
	{ field: field("company"), value: "Acme Widgets" },
	{ field: field("notes"), value: "private note: allergic to cats" },
	{ field: field("message"), value: "Please call me back." },
	{ field: field("terms"), value: "Accepted: “I accept the terms”" },
	...(o.newsletter ? [{ field: field("newsletter"), value: "Yes" }] : []),
];
const ALL_ON: CrmSettings = parseCrmSettings({ brevo: { on: true, listId: 7 }, hubspot: { on: true, consentProperty: "newsletter_opt_in" }, mailchimp: { on: true, audienceId: "a1b2c3d4e5", doubleOptIn: false, unconsented: "skip" }, forms: { contact: { providers: ["brevo", "hubspot", "mailchimp"], map: autoMap(contactForm) } } });

describe("crm: mapping", () => {
	it("auto-maps from names, labels and autocomplete; a terms checkbox is never an opt-in", () => {
		expect(autoMap(contactForm)).toEqual({ email: "your-email", fullName: "your-name", phone: "phone", company: "company", message: "message", consent: "newsletter" });
		expect(autoMap({ fields: [{ name: "first_name", label: "First name", type: "text" }, { name: "last_name", label: "Last name", type: "text" }, { name: "email", label: "E-mail", type: "email" }, { name: "gdpr", label: "I agree to the privacy policy", type: "consent" }] })).toEqual({ email: "email", firstName: "first_name", lastName: "last_name" });
	});
	it("builds the contact from mapped fields only, splitting a full name; no email, no contact", () => {
		const c = buildContact(autoMap(contactForm), values()) as Contact;
		expect(c).toEqual({ email: "sam@example.com", firstName: "Sam", lastName: "Q Visitor", phone: "+1 (555) 010-0199", company: "Acme Widgets", message: "Please call me back.", consent: false });
		expect(JSON.stringify(c)).not.toContain("allergic");
		expect(buildContact({ email: "your-email" }, values())).toEqual({ email: "sam@example.com" });
		expect(buildContact({ fullName: "your-name" }, values())).toBeUndefined();
		expect(buildContact(autoMap(contactForm), values({ newsletter: true }))?.consent).toBe(true);
	});
	it("phones for Brevo's SMS attribute need a country code", () => {
		expect(e164("+1 (555) 010-0199")).toBe("+15550100199");
		expect(e164("0044 20 7946 0000")).toBe("+442079460000");
		expect(e164("555 0100")).toBeUndefined();
	});
});

describe("crm: provider requests (no network)", () => {
	const c = buildContact(autoMap(contactForm), values()) as Contact;
	const opted = { ...c, consent: true };
	it("Brevo: create-or-update by email; the list only with a ticked opt-in", () => {
		const r = brevoRequest(c, ALL_ON, BREVO);
		expect(r).toMatchObject({ url: "https://api.brevo.com/v3/contacts", method: "POST", headers: { "api-key": BREVO } });
		expect(r.body).toEqual({ email: "sam@example.com", updateEnabled: true, attributes: { FIRSTNAME: "Sam", LASTNAME: "Q Visitor", SMS: "+15550100199" } });
		expect(brevoRequest(opted, ALL_ON, BREVO).body.listIds).toEqual([7]);
		// No opt-in field mapped: never a list.
		expect(brevoRequest({ email: "sam@example.com" }, ALL_ON, BREVO).body).toEqual({ email: "sam@example.com", updateEnabled: true });
	});
	it("HubSpot: create with default properties, update by email on conflict; consent property only when ticked", () => {
		const r = hubspotCreate(c, ALL_ON, HUBSPOT);
		expect(r).toMatchObject({ url: "https://api.hubapi.com/crm/v3/objects/contacts", method: "POST", headers: { authorization: `Bearer ${HUBSPOT}` } });
		expect(r.body).toEqual({ properties: { email: "sam@example.com", firstname: "Sam", lastname: "Q Visitor", phone: "+1 (555) 010-0199", company: "Acme Widgets", message: "Please call me back." } });
		const u = hubspotUpdate(opted, ALL_ON, HUBSPOT);
		expect(u).toMatchObject({ url: "https://api.hubapi.com/crm/v3/objects/contacts/sam%40example.com?idProperty=email", method: "PATCH" });
		expect(u.body.properties).toMatchObject({ newsletter_opt_in: "true" });
		expect(u.body.properties).not.toHaveProperty("email");
	});
	it("Mailchimp: MD5 member hash, data center from the key; consent decides the status", () => {
		expect(md5("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
		expect(md5("sam@example.com")).toBe("e179e95c00e7718ab4a23840f992ea63");
		expect(md5("a".repeat(120))).toBe("5f61c0ccad4cac44c75ff505e1f1e537");
		expect(mailchimpServer({ MAILCHIMP_API_KEY: MAILCHIMP })).toBe("us21");
		expect(mailchimpServer({ MAILCHIMP_API_KEY: MAILCHIMP, MAILCHIMP_SERVER_PREFIX: "us6" })).toBe("us6");
		// No tick: skipped by default…
		expect(mailchimpRequest(c, ALL_ON, MAILCHIMP, "us21")).toBeUndefined();
		// …or a transactional contact (an existing member keeps its status: no `status`).
		const tx = mailchimpRequest(c, parseCrmSettings({ ...ALL_ON, mailchimp: { ...ALL_ON.mailchimp, unconsented: "transactional" } }), MAILCHIMP, "us21");
		expect(tx?.body).toEqual({ email_address: "sam@example.com", status_if_new: "transactional", merge_fields: { FNAME: "Sam", LNAME: "Q Visitor", PHONE: "+1 (555) 010-0199" } });
		const sub = mailchimpRequest(opted, ALL_ON, MAILCHIMP, "us21");
		expect(sub).toMatchObject({ url: "https://us21.api.mailchimp.com/3.0/lists/a1b2c3d4e5/members/e179e95c00e7718ab4a23840f992ea63", method: "PUT", body: { status_if_new: "subscribed", status: "subscribed" } });
		expect(sub?.headers.authorization).toBe(`Basic ${btoa(`wp2emdash:${MAILCHIMP}`)}`);
		expect(mailchimpRequest(opted, parseCrmSettings({ ...ALL_ON, mailchimp: { ...ALL_ON.mailchimp, doubleOptIn: true } }), MAILCHIMP, "us21")?.body).toMatchObject({ status_if_new: "pending", status: "pending" });
	});
	it("secrets: checked for shape; Brevo falls back to the Brevo email key", () => {
		expect(crmSecretSet(KEYS, "hubspot")).toBe(true);
		expect(crmSecretSet({ HUBSPOT_TOKEN: "nope" }, "hubspot")).toBe(false);
		expect(crmSecretSet({ EMAIL_PROVIDER: "brevo", EMAIL_API_KEY: BREVO }, "brevo")).toBe(true);
		expect(crmSecretSet({ EMAIL_PROVIDER: "resend", EMAIL_API_KEY: BREVO }, "brevo")).toBe(false);
	});
	it("HubSpot 409 → PATCH by email; provider errors are scrubbed of personal data", async () => {
		const f = vi.fn(async (_u: string, i: RequestInit) => (i.method === "POST" ? new Response(JSON.stringify({ category: "CONFLICT", message: "Contact already exists. Existing ID: 123" }), { status: 409 }) : new Response("{}", { status: 200 })));
		expect(await sendToProvider(KEYS, ALL_ON, "hubspot", c, f)).toEqual({ ok: true });
		expect(f.mock.calls.map(([, i]) => i.method)).toEqual(["POST", "PATCH"]);
		const bad = vi.fn(async () => new Response(JSON.stringify({ code: "invalid_parameter", message: "Invalid phone +1 (555) 010-0199 for sam@example.com (Sam Visitor) at Acme Widgets" }), { status: 400 }));
		const r = await sendToProvider(KEYS, ALL_ON, "brevo", c, bad);
		expect(r).toMatchObject({ ok: false, retry: false, status: 400 });
		const text = (r as { error: string }).error;
		expect(text).toMatch(/^invalid_parameter: Invalid phone/);
		for (const pii of ["sam@", "example.com", "555", "Sam", "Visitor", "Acme"]) expect(text).not.toContain(pii);
		expect(scrub("Member jane@other.example exists, ref 4401 2345 6789")).toBe("Member [email] exists, ref [number]");
	});
});

describe("crm: delivery, retries and backoff", () => {
	let kv: ReturnType<typeof memoryKv>;
	let e: CrmEnv;
	const t0 = Date.parse("2026-11-22T10:00:00Z");
	beforeEach(async () => {
		kv = memoryKv();
		e = { ...KEYS, FORM_OUTBOX: kv };
		await writeCrmSettings(e, ALL_ON);
		vi.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		vi.useRealTimers();
	});
	const ok = () => vi.fn(async (_u: string, _i: RequestInit) => new Response("{}", { status: 200 }));

	it("sends the mapped fields to each provider picked for the form (Mailchimp skipped without a tick); logs counts only", async () => {
		const f = ok();
		expect(await syncCrm(e, { form: contactForm, values: values() }, f)).toEqual({ sent: ["brevo", "hubspot", "mailchimp"], retry: [], failed: [] });
		expect(f.mock.calls.map(([u]) => new URL(u).host)).toEqual(["api.brevo.com", "api.hubapi.com"]);
		const bodies = f.mock.calls.map(([, i]) => String(i.body)).join("\n");
		expect(bodies).not.toContain("allergic");
		expect(bodies).not.toContain("terms");
		const logs = JSON.stringify((console.log as unknown as { mock: { calls: unknown[][] } }).mock.calls);
		for (const pii of ["sam@example.com", "Sam", "Acme", "call me", BREVO]) expect(logs).not.toContain(pii);
	});
	it("refuses on sensitive sites and forms, for test messages and on staging — nothing is fetched or stored", async () => {
		const f = ok();
		for (const [env2, form] of [[{ ...e, FORM_SENSITIVE: "1" }, contactForm], [e, { ...contactForm, sensitive: true }], [{ ...e, FORM_CRM: "0" }, contactForm], [{ ...e, STAGING: "1" }, contactForm]] as const) expect(await syncCrm(env2, { form, values: values() }, f)).toEqual({ sent: [], retry: [], failed: [] });
		expect(await syncCrm(e, { form: contactForm, values: values(), test: true }, f)).toEqual({ sent: [], retry: [], failed: [] });
		expect(f).not.toHaveBeenCalled();
		expect([...kv.store.keys()].filter((k) => k.startsWith("crm:"))).toEqual([]);
		expect(providersFor(ALL_ON, { ...e, FORM_SENSITIVE: "1" }, contactForm)).toEqual([]);
	});
	it("a temporary failure is kept (mapped contact only, two days at most) and retried with backoff until it passes", async () => {
		vi.useFakeTimers({ now: t0, toFake: ["Date"] });
		const down = vi.fn(async (u: string) => (u.includes("brevo") ? new Response("busy", { status: 503 }) : new Response("{}")));
		expect(await syncCrm(e, { form: contactForm, values: values() }, down)).toMatchObject({ retry: ["brevo"] });
		const [key, job] = [...kv.store.entries()].find(([k]) => k.startsWith("crm:")) as [string, { v: string; ttl?: number }];
		expect(job.ttl).toBe(2 * 86_400);
		const stored = JSON.parse(job.v);
		expect(stored).toMatchObject({ form: "contact", providers: ["brevo"], attempts: 1, next: new Date(t0 + BACKOFF_MINUTES[0] * 60_000).toISOString() });
		expect(job.v).not.toContain("allergic");
		// Not due yet: left alone.
		const f = ok();
		expect(await flushCrm(e, f, t0 + 60_000)).toMatchObject({ waiting: 1, sent: 0 });
		expect(kv.store.has(key)).toBe(true);
		expect(await flushCrm(e, f, t0 + 6 * 60_000)).toMatchObject({ sent: 1, waiting: 0 });
		expect(f).toHaveBeenCalledOnce();
		expect([...kv.store.keys()].filter((k) => k.startsWith("crm:"))).toEqual([]);
	});
	it("after the last attempt it is counted and the scrubbed error kept for Settings", async () => {
		let now = t0;
		vi.useFakeTimers({ now, toFake: ["Date"] });
		const down = vi.fn(async () => new Response(JSON.stringify({ code: "server_error", message: "try later" }), { status: 500 }));
		await writeCrmSettings(e, parseCrmSettings({ ...ALL_ON, forms: { contact: { providers: ["brevo"], map: autoMap(contactForm) } } }));
		await syncCrm(e, { form: contactForm, values: values() }, down);
		for (let i = 2; i <= MAX_ATTEMPTS; i++) {
			now += 13 * 3_600_000;
			vi.setSystemTime(now);
			await flushCrm(e, down, now);
		}
		expect(down).toHaveBeenCalledTimes(MAX_ATTEMPTS);
		const status = await readCrmStatus(e, "2026-11-01");
		expect(status).toMatchObject({ failures: { brevo: 1, hubspot: 0, mailchimp: 0 }, pending: 0, lastErrors: { brevo: { form: "contact", status: 500, text: "server_error: try later" } } });
	});
	it("a permanent error is not retried; a provider turned off or a site turned sensitive drops waiting retries", async () => {
		const refused = vi.fn(async () => new Response(JSON.stringify({ title: "Invalid Resource", detail: "sam@example.com looks fake" }), { status: 400 }));
		await writeCrmSettings(e, parseCrmSettings({ ...ALL_ON, mailchimp: { ...ALL_ON.mailchimp, unconsented: "transactional" }, forms: { contact: { providers: ["mailchimp"], map: autoMap(contactForm) } } }));
		expect(await syncCrm(e, { form: contactForm, values: values() }, refused)).toMatchObject({ failed: ["mailchimp"], retry: [] });
		expect((await readCrmStatus(e, "2026-01-01")).lastErrors.mailchimp?.text).toBe("Invalid Resource: […] looks fake");
		await writeCrmSettings(e, ALL_ON);
		const busy = vi.fn(async () => new Response("", { status: 429 }));
		await syncCrm(e, { form: contactForm, values: values() }, busy);
		expect((await readCrmStatus(e, "2026-01-01")).pending).toBe(1);
		const f = ok();
		expect(await flushCrm({ ...e, FORM_SENSITIVE: "1" }, f)).toMatchObject({ dropped: 2, sent: 0 });
		expect(f).not.toHaveBeenCalled();
		expect((await readCrmStatus(e, "2026-01-01")).pending).toBe(0);
	});
});

describe("crm: settings validation", () => {
	const forms: CrmForm[] = [contactForm, { id: "intake", title: "Health intake", sensitive: true, fields: [{ name: "email", type: "email" }] }];
	const base = { crm_brevo_on: true, crm_hubspot_on: true, crm_mailchimp_on: true, crm_mailchimp_audience: "a1b2c3d4e5", crm_form_contact_providers: ["brevo", "hubspot"], crm_form_contact_email: "your-email", crm_form_contact_consent: "newsletter" };
	it("only providers with a secret can be on; the mapping is stored as chosen", () => {
		const { settings, errors } = crmSettingsFromForm(base, { env: { BREVO_API_KEY: BREVO }, forms });
		expect(errors).toEqual([]);
		expect([settings.brevo.on, settings.hubspot.on, settings.mailchimp.on]).toEqual([true, false, false]);
		expect(settings.forms.contact).toEqual({ providers: ["brevo"], map: { email: "your-email", consent: "newsletter" } });
	});
	it("refuses bad ids, names, unfit fields and a form without its email field", () => {
		const { errors } = crmSettingsFromForm({ ...base, crm_brevo_list: "seven", crm_mailchimp_audience: "", crm_hubspot_name_company: "Company Name", crm_form_contact_email: "", crm_form_contact_phone: "terms" }, { env: KEYS, forms });
		expect(errors.join("\n")).toMatch(/Brevo list id is a whole number/);
		expect(errors.join("\n")).toMatch(/Mailchimp needs an audience id/);
		expect(errors.join("\n")).toMatch(/HubSpot company: "Company Name" is not a HubSpot property/);
		expect(errors.join("\n")).toMatch(/"terms" cannot be sent as phone/);
		expect(errors.join("\n")).toMatch(/choose the email field/);
	});
	it("server side: a sensitive form or site cannot be switched on, whatever the request says", () => {
		const form = crmSettingsFromForm({ ...base, crm_form_intake_providers: ["brevo"], crm_form_intake_email: "email" }, { env: KEYS, forms });
		expect(form.errors).toEqual(["Health intake: This form handles sensitive information, so its messages are never sent to a CRM or mailing list."]);
		expect(form.settings.forms.intake).toEqual({ providers: [], map: {} });
		const site = crmSettingsFromForm(base, { env: { ...KEYS, FORM_SENSITIVE: "1" }, forms });
		expect(site.errors[0]).toMatch(/sensitive information/);
		expect([site.settings.brevo.on, site.settings.hubspot.on, site.settings.mailchimp.on]).toEqual([false, false, false]);
	});
	it("defaults: everything off; kit.config pre-selection switches providers on for every form (never on sensitive sites)", async () => {
		expect(defaultCrm()).toMatchObject({ brevo: { on: false }, hubspot: { on: false }, mailchimp: { on: false }, forms: {} });
		const pre: CrmEnv = { ...KEYS, FORM_OUTBOX: memoryKv(), FORM_CRM_PRESELECT: "brevo,hubspot,nope", FORM_CRM_BREVO_LIST: "3" };
		const s = await readCrmSettings(pre);
		expect(s).toMatchObject({ brevo: { on: true, listId: 3 }, hubspot: { on: true }, mailchimp: { on: false } });
		expect(providersFor(s, pre, contactForm)).toEqual(["brevo", "hubspot"]);
		expect(providersFor(await readCrmSettings({ ...pre, FORM_SENSITIVE: "1" }), { ...pre, FORM_SENSITIVE: "1" }, contactForm)).toEqual([]);
	});
});

describe("crm: Form messages → Settings", () => {
	type B = Record<string, any>;
	type Res = { blocks: B[]; toast?: { message: string; type: string } };
	const plugin = createPlugin(formsPlugin({ forms: [pluginForm(contactForm), pluginForm({ id: "intake", title: "Health intake", sensitive: true, fields: [{ name: "email", label: "Email", type: "email" }] })] }).options) as unknown as { routes: { admin: { handler: (ctx: unknown) => Promise<unknown> } } };
	const call = (input: unknown) => plugin.routes.admin.handler({ input, request: new Request("https://site.example/_emdash/api/plugins/site-forms/admin"), user: { id: "u1", email: "owner@example.com", name: "Owner", role: 50 }, log: { info: () => {} } }) as Promise<Res>;
	const crmBlocks = (r: Res) => {
		const blocks = (r.blocks.find((b) => b.type === "tab")?.panels[4]?.blocks ?? []) as B[];
		return blocks.slice(blocks.findIndex((b) => b.type === "header" && b.text === "CRM & mailing lists"));
	};
	let kv: ReturnType<typeof memoryKv>;
	beforeEach(() => {
		kv = memoryKv();
		for (const k of Object.keys(env)) delete env[k];
		Object.assign(env, { FORM_OUTBOX: kv, FORM_OUTBOX_HOLD: "1" });
	});

	it("without secrets: no switches, how to set each secret", async () => {
		const c = crmBlocks(await call({ type: "page_load", page: "/messages" }));
		expect(c.find((b) => b.type === "form")).toBeUndefined();
		const hints = c.filter((b) => b.type === "context").map((b) => b.text).join("\n");
		for (const s of ["BREVO_API_KEY", "HUBSPOT_TOKEN", "MAILCHIMP_API_KEY"]) expect(hints).toContain(`wrangler secret put ${s}`);
		expect(hints).toContain("Health intake (intake): not available.");
	});
	it("with a secret: switch, auto-mapped fields per form; saving stores cfg:crm; the activity log has no ids", async () => {
		Object.assign(env, { HUBSPOT_TOKEN: HUBSPOT });
		const form = crmBlocks(await call({ type: "page_load", page: "/messages" })).find((b) => b.type === "form") as B;
		const ids = form.fields.map((f: B) => f.action_id);
		expect(ids).toContain("crm_hubspot_on");
		expect(ids).toContain("crm_form_contact_email");
		expect(ids.some((id: string) => id.startsWith("crm_form_intake"))).toBe(false);
		expect(form.fields.find((f: B) => f.action_id === "crm_form_contact_consent")?.initial_value).toBe("newsletter");
		// The consent target only offers checkboxes; email only email fields.
		expect(form.fields.find((f: B) => f.action_id === "crm_form_contact_email")?.options.map((o: B) => o.value)).toEqual(["", "your-email"]);
		const saved = await call({ type: "form_submit", action_id: "crm", values: { crm_hubspot_on: true, crm_hubspot_consent: "newsletter_opt_in", crm_form_contact_providers: ["hubspot"], crm_form_contact_email: "your-email", crm_form_contact_fullName: "your-name" } });
		expect(saved.toast).toEqual({ message: "CRM sync on: HubSpot.", type: "success" });
		expect(await readCrmSettings(env as CrmEnv)).toMatchObject({ hubspot: { on: true, consentProperty: "newsletter_opt_in" }, forms: { contact: { providers: ["hubspot"], map: { email: "your-email", fullName: "your-name" } } } });
		expect(JSON.stringify([...kv.store.entries()].filter(([k]) => k.startsWith("act:")))).not.toContain("newsletter_opt_in");
	});
	it("a crafted request for a sensitive form is refused and nothing is saved", async () => {
		Object.assign(env, { HUBSPOT_TOKEN: HUBSPOT });
		const r = await call({ type: "form_submit", action_id: "crm", values: { crm_hubspot_on: true, crm_form_intake_providers: ["hubspot"], crm_form_intake_email: "email" } });
		expect(r.toast?.type).toBe("error");
		expect(kv.store.has("cfg:crm")).toBe(false);
	});
	it("sensitive sites: unavailable with the reason, no form", async () => {
		Object.assign(env, { HUBSPOT_TOKEN: HUBSPOT, FORM_SENSITIVE: "1" });
		const c = crmBlocks(await call({ type: "page_load", page: "/messages" }));
		expect(c.map((b) => b.type)).toEqual(["header", "banner"]);
		expect(c[1]).toMatchObject({ title: "Not available on this site" });
		expect(c[1]?.description).toMatch(/health, legal or financial/);
	});
	it("shows the last error and lets an admin clear it", async () => {
		Object.assign(env, { BREVO_API_KEY: BREVO });
		await kv.put("crmerr:brevo", JSON.stringify({ at: "2026-11-22T10:00:00Z", form: "contact", status: 401, text: "unauthorized: Key not found" }));
		const c = crmBlocks(await call({ type: "page_load", page: "/messages" }));
		expect(c.find((b) => b.type === "banner" && b.title === "Brevo: last error")?.description).toContain("HTTP 401: unauthorized: Key not found");
		await call({ type: "block_action", action_id: "crm-clear", value: "brevo" });
		expect(kv.store.has("crmerr:brevo")).toBe(false);
	});
});

describe("crm: the form endpoint never waits for a provider", () => {
	const POST = createFormEndpoint({ getForm: (id) => (id === "contact" ? contactForm : undefined) });
	const submit = (extra: Record<string, string> = {}) => {
		const body = new FormData();
		for (const [k, v] of Object.entries({ "your-name": "Sam Visitor", "your-email": "sam@example.com", notes: "private note", message: "Hello", terms: "on", "cf-turnstile-response": "t", ...extra })) body.set(k, v);
		const request = new Request("https://site.example/api/forms/contact", { method: "POST", body, headers: { accept: "application/json" } });
		return (POST as unknown as (ctx: unknown) => Promise<Response>)({ params: { id: "contact" }, request, locals: {}, clientAddress: "203.0.113.1" });
	};
	let kv: ReturnType<typeof memoryKv>;
	beforeEach(async () => {
		kv = memoryKv();
		for (const k of Object.keys(env)) delete env[k];
		Object.assign(env, { TURNSTILE_SECRET_KEY: "s", FORM_OUTBOX: kv, EMAIL_API_KEY: "k", FORM_FROM: "noreply@site.example", FORM_TO: "office@site.example", HUBSPOT_TOKEN: HUBSPOT });
		await writeCrmSettings(env, parseCrmSettings({ hubspot: { on: true }, forms: { contact: { providers: ["hubspot"], map: { email: "your-email", fullName: "your-name", consent: "newsletter" } } } }));
		waited.length = 0;
		vi.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});
	const fetchWith = (hubspot: () => Promise<Response>) => vi.fn((url: string, _i?: RequestInit) => (String(url).includes("turnstile") ? Promise.resolve(new Response(JSON.stringify({ success: true }))) : String(url).includes("hubapi") ? hubspot() : Promise.resolve(new Response("{}", { status: 201 }))));

	it("answers while HubSpot hangs; the background job sends only the mapped fields", async () => {
		vi.stubGlobal("fetch", fetchWith(() => new Promise<Response>(() => {})));
		expect((await submit()).status).toBe(200);
		expect(waited).toHaveLength(1);
		const f = fetchWith(async () => new Response("{}", { status: 201 }));
		vi.stubGlobal("fetch", f);
		waited.length = 0;
		expect((await submit()).status).toBe(200);
		await Promise.all(waited);
		const call = f.mock.calls.find(([u]) => String(u).includes("hubapi"));
		expect(JSON.parse(String(call?.[1]?.body))).toEqual({ properties: { email: "sam@example.com", firstname: "Sam", lastname: "Visitor" } });
	});
	it("a sensitive form never reaches the provider, even with settings that name it", async () => {
		const POSTS = createFormEndpoint({ getForm: () => ({ ...contactForm, sensitive: true }) });
		const f = fetchWith(async () => new Response("{}", { status: 201 }));
		vi.stubGlobal("fetch", f);
		const body = new FormData();
		for (const [k, v] of Object.entries({ "your-email": "sam@example.com", terms: "on", "cf-turnstile-response": "t" })) body.set(k, v);
		await (POSTS as unknown as (ctx: unknown) => Promise<Response>)({ params: { id: "contact" }, request: new Request("https://site.example/api/forms/contact", { method: "POST", body, headers: { accept: "application/json" } }), locals: {}, clientAddress: "203.0.113.1" });
		await Promise.all(waited);
		expect(f.mock.calls.some(([u]) => String(u).includes("hubapi"))).toBe(false);
	});
});

describe("crm: scaffold wiring", () => {
	const cfg = (forms: Record<string, unknown>, extra: Record<string, unknown> = {}) => kitConfigSchema.parse({ slug: "acme", name: "Acme", source: { url: "https://acme.example" }, target: { productionUrl: "https://site.example" }, email: { from: "Acme <noreply@site.example>", to: ["office@site.example"] }, forms, ...extra });
	const vars = (c: ReturnType<typeof cfg>, sensitiveData = false) => workerVars({ ...c, sensitiveData }, { staging: false, productionHost: "site.example" }).production;
	it("present and off by default; pre-selection and ids as vars; false removes it; never pre-selected on sensitive sites", () => {
		expect(cfg({}).forms.crm).toEqual({ providers: [] });
		const def = vars(cfg({}));
		expect(Object.keys(def).filter((k) => k.startsWith("FORM_CRM"))).toEqual([]);
		expect(vars(cfg({ crm: false }))).toMatchObject({ FORM_CRM: "0" });
		expect(vars(cfg({ crm: { providers: ["brevo", "mailchimp"], brevoListId: 4, mailchimpAudienceId: "a1b2c3d4e5" } }))).toMatchObject({ FORM_CRM_PRESELECT: "brevo,mailchimp", FORM_CRM_BREVO_LIST: "4", FORM_CRM_MAILCHIMP_AUDIENCE: "a1b2c3d4e5" });
		expect(vars(cfg({ crm: { providers: ["brevo"] } }), true)).not.toHaveProperty("FORM_CRM_PRESELECT");
		expect(() => cfg({ crm: { providers: ["salesforce"] } })).toThrow();
	});
	it("the descriptor carries field names and types (never values), checkbox groups apart", () => {
		const d = pluginForm({ ...contactForm, fields: [...contactForm.fields, { name: "topics", label: "Topics", type: "checkbox", options: ["A", "B"] }, { name: "doc", label: "Document", type: "file" }] });
		expect(d.fields?.map((f) => `${f.name}:${f.type}`)).toEqual(["your-name:text", "your-email:email", "phone:tel", "company:text", "notes:text", "message:textarea", "terms:consent", "newsletter:checkbox", "topics:checkbox-group"]);
	});
});
