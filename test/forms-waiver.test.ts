/**
 * Waiver forms: radio choices, consent with links, text shown on the form, drawn/typed signatures — from the Fluent
 * Forms conversion through the endpoint, email delivery (attachments per provider), the outbox and the admin view.
 * Fixtures are synthetic (test/fixtures/fluent). Golden: UPDATE_GOLDEN=1 pnpm test.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deliver } from "../packages/forms/src/deliver.js";
import { inlineAttachments } from "../packages/forms/src/emdash-email.js";
import { createFormEndpoint } from "../packages/forms/src/endpoint.js";
import type { FormDefinition } from "../packages/forms/src/index.js";
import { flushOutbox, type KvLike, type Queued, summaryOf } from "../packages/forms/src/outbox.js";
import { message, overview, TABS } from "../packages/forms/src/plugin/views.js";
import { htmlToContent, htmlToParts, safeHref } from "../packages/forms/src/rich.js";
import { checkSignaturePng, checkTypedSignature } from "../packages/forms/src/signature.js";
import { applySensitivePolicy, fluentFormToDefinition, SIGNATURE_NOTICE } from "../src/scaffold/forms.js";
import { env } from "../test/stubs/cloudflare-workers.js";
import { runtime as emdashRuntime } from "../test/stubs/emdash-middleware.js";

const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "fluent", "waiver.json"), "utf8"));
const goldenPath = join(import.meta.dirname, "golden", "fluent", "waiver.json");

// A real 1×1 PNG, and PNGs with a forged IHDR (too wide) or a wrong signature.
const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const png = (mutate: (b: Buffer) => void) => {
	const b = Buffer.from(PNG_1x1, "base64");
	mutate(b);
	return b.toString("base64");
};
const DATA = (b64: string) => `data:image/png;base64,${b64}`;

describe("rich text: safe links only", () => {
	it("keeps http(s) and site-relative links, refuses the rest", () => {
		expect(safeHref("/terms/")).toBe("/terms/");
		expect(safeHref("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
		for (const bad of ["javascript:alert(1)", " JaVaScRiPt:x", "data:text/html,x", "//evil.example/x", "/\\evil", "mailto:a@b.co", "vbscript:x", "/a b"]) expect(safeHref(bad)).toBeUndefined();
	});
	it("turns HTML into text runs; unsafe links become text, scripts vanish", () => {
		const parts = htmlToParts('<p>Accept the <a href="/terms/">Terms</a> and <a href="javascript:alert(1)">Policy</a>.<script>alert(1)</script></p>');
		expect(parts).toEqual([{ text: "Accept the " }, { text: "Terms", href: "/terms/" }, { text: " and Policy." }]);
		expect(htmlToContent("<ul><li>One</li><li><p><b>Two</b></p></li></ul>After<hr><h3>Head &amp; more</h3><style>p{}</style>")).toEqual([
			{ kind: "li", parts: [{ text: "One" }] },
			{ kind: "li", parts: [{ text: "Two", strong: true }] },
			{ kind: "p", parts: [{ text: "After" }] },
			{ kind: "hr" },
			{ kind: "h", parts: [{ text: "Head & more" }] },
		]);
	});
});

describe("Fluent Forms waiver conversion", () => {
	const def = fluentFormToDefinition(fixture, false);
	it("matches the golden definition", () => {
		const got = `${JSON.stringify(def, null, 2)}\n`;
		if (process.env.UPDATE_GOLDEN === "1" || !existsSync(goldenPath)) writeFileSync(goldenPath, got);
		expect(got).toBe(readFileSync(goldenPath, "utf8"));
	});
	it("maps radio, consent with links, signature and the text shown, in field order", () => {
		expect(def.fields.map((f) => `${f.type}:${f.name}`)).toEqual(["text:first_name", "text:last_name", "email:email", "content:content-1", "content:content-2", "radio:input_radio", "consent:terms-n-condition", "signature:signature"]);
		const radio = def.fields.find((f) => f.type === "radio");
		expect(radio?.options).toHaveLength(2);
		expect(radio?.required).toBeUndefined();
		const consent = def.fields.find((f) => f.type === "consent");
		expect(consent).toMatchObject({ label: "Terms and Conditions", required: true });
		expect(consent?.labelParts?.filter((p) => p.href)).toEqual([{ text: "Terms", href: "/terms/" }]);
		expect(JSON.stringify(def)).not.toMatch(/javascript:|data:text|<script|onclick/);
		const terms = def.fields.find((f) => f.name === "content-1")?.content ?? [];
		expect(terms.map((b) => b.kind)).toEqual(["p", "hr", "li", "li", "p"]);
		expect(def.fields.find((f) => f.type === "signature")).toEqual({ name: "signature", label: "Signature", type: "signature", required: true });
		expect(def.notice).toBe(SIGNATURE_NOTICE);
		expect(def.warnings).toEqual([]);
		expect([def.submitLabel, def.afterSubmit]).toEqual(["Sign and Send", "hide"]);
	});
	it("a sensitive site's contact-only policy still withholds them (owner decides in kit.config)", () => {
		const out = applySensitivePolicy(fluentFormToDefinition(fixture, true), "contact-only", "Contact details only.");
		expect(out.fields.map((f) => f.type)).toEqual(["text", "text", "email"]);
		expect(out.withheld).toEqual(["Text", "Photos", "Photo Consent (Optional)", "Terms and Conditions", "Signature"]);
	});
});

describe("signature checks", () => {
	it("accepts a well-formed PNG within the caps", () => {
		expect(checkSignaturePng(DATA(PNG_1x1))).toMatchObject({ ok: true, width: 1, height: 1 });
	});
	it.each([
		["not a PNG data URL", "data:image/jpeg;base64,AAAA", "not-png-data-url"],
		["bad base64", DATA("@@@@"), "bad-base64"],
		["wrong signature bytes", DATA(png((b) => b.writeUInt8(0x00, 0))), "not-png"],
		["too wide", DATA(png((b) => b.writeUInt32BE(601, 16))), "bad-dimensions"],
		["over 150 KB", DATA("A".repeat(200_004)), "too-large"],
	])("refuses %s", (_name, value, reason) => {
		expect(checkSignaturePng(value)).toEqual({ ok: false, reason });
	});
	it("typed names", () => {
		expect(checkTypedSignature("Jane Example")).toBe(true);
		expect(checkTypedSignature("<b>x</b>")).toBe(false);
		expect(checkTypedSignature("1")).toBe(false);
	});
});

const waiver = (() => {
	const { warnings: _w, ...d } = fluentFormToDefinition(fixture, false);
	return d as FormDefinition;
})();
const POST = createFormEndpoint({ getForm: (id) => (id === waiver.id ? waiver : undefined) });
const submit = (fields: Record<string, string>) => {
	const body = new FormData();
	for (const [k, v] of Object.entries({ first_name: "Jane", last_name: "Example", email: "jane@example.com", "terms-n-condition": "yes", "cf-turnstile-response": "t", ...fields })) if (v !== "") body.set(k, v);
	const request = new Request(`https://studio.example/api/forms/${waiver.id}`, { method: "POST", body, headers: { accept: "application/json", referer: "https://studio.example/waiver/" } });
	return (POST as unknown as (ctx: unknown) => Promise<Response>)({ params: { id: waiver.id }, request, locals: {}, clientAddress: "203.0.113.1" });
};
const reset = (vars: Record<string, unknown>) => {
	for (const k of Object.keys(env)) delete env[k];
	Object.assign(env, { TURNSTILE_SECRET_KEY: "s", FORM_TO: "studio@example.com", FORM_FROM: "Site <noreply@example.com>", EMAIL_API_KEY: "k", ...vars });
};
const providerStub = () => vi.fn(async (url: string) => (String(url).includes("turnstile") ? new Response(JSON.stringify({ success: true })) : new Response("{}", { status: 201 })));

describe("waiver endpoint", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		emdashRuntime.email = null;
	});
	it("a drawn signature is emailed as signature.png with the answers, the time and the text agreed to; never logged", async () => {
		reset({});
		const fetch = providerStub();
		vi.stubGlobal("fetch", fetch);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const r = await submit({ signature: DATA(PNG_1x1), input_radio: "No, please do not use photos of me." });
		expect(r.status).toBe(200);
		const [, init] = fetch.mock.calls.find(([u]) => String(u).includes("brevo")) as unknown as [string, RequestInit];
		const body = JSON.parse(String(init.body));
		expect(body.attachment).toEqual([{ name: "signature.png", content: PNG_1x1 }]);
		expect(body.subject).toBe("Signed: Example Studio Waiver — Jane Example");
		expect(body.textContent).toMatch(/^Form: Example Studio Waiver\nSubmitted: \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);
		expect(body.textContent).toContain("Terms and Conditions: Accepted: “I have read and accept the terms above, as well as the Terms and Privacy Policy.”");
		expect(body.textContent).toContain("Signature: Signed (drawn signature attached as signature.png)");
		expect(body.textContent).toContain("Release of liability. I take part in classes at Example Studio at my own risk & I understand the activity is physical.");
		expect(body.textContent).toContain("studio rules (/studio-rules/)");
		expect(body.textContent).toMatch(/SHA-256 of the text shown: [0-9a-f]{64}/);
		expect(body.htmlContent).toContain('<a href="https://studio.example/terms/">Terms</a>');
		expect(body.htmlContent).not.toContain(PNG_1x1);
		const logged = JSON.stringify(log.mock.calls);
		expect(logged).not.toContain(PNG_1x1.slice(0, 20));
		expect(logged).not.toContain("Jane");
	});
	it("the same text gives the same SHA-256 (the record can be checked later)", async () => {
		const hashes: string[] = [];
		for (let i = 0; i < 2; i++) {
			reset({});
			const fetch = providerStub();
			vi.stubGlobal("fetch", fetch);
			await submit({ signature: DATA(PNG_1x1) });
			const [, init] = fetch.mock.calls.find(([u]) => String(u).includes("brevo")) as unknown as [string, RequestInit];
			hashes.push(/SHA-256 of the text shown: ([0-9a-f]{64})/.exec(JSON.parse(String(init.body)).textContent)?.[1] as string);
		}
		expect(hashes[0]).toBe(hashes[1]);
	});
	it("the typed name is the signature when nothing is drawn (keyboard and no-JS)", async () => {
		reset({});
		const fetch = providerStub();
		vi.stubGlobal("fetch", fetch);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		expect((await submit({ signature_typed: "Jane Q. Example" })).status).toBe(200);
		const body = JSON.parse(String((fetch.mock.calls.find(([u]) => String(u).includes("brevo")) as unknown as [string, RequestInit])[1].body));
		expect(body.attachment).toBeUndefined();
		expect(body.textContent).toContain("Signature: Signed by typing their name: Jane Q. Example");
		expect(JSON.stringify(log.mock.calls)).not.toContain("Jane Q.");
	});
	it.each([
		["a missing required signature", {}, "signature", /is required/],
		["a malformed data URL", { signature: "data:image/png;base64,not*base64" }, "signature", /could not be read/],
		["a non-PNG image", { signature: "data:image/svg+xml;base64,PHN2Zy8+" }, "signature", /could not be read/],
		["an oversize drawing", { signature: DATA("A".repeat(200_004)) }, "signature", /too large/],
		["a forged PNG size", { signature: DATA(png((b) => b.writeUInt32BE(5000, 20))) }, "signature", /could not be read/],
		["markup as a typed name", { signature_typed: "<img src=x>" }, "signature", /type your full name/],
		["the consent unchecked", { signature_typed: "Jane Example", "terms-n-condition": "" }, "terms-n-condition", /Please accept: Terms and Conditions/],
		["a radio value that is not an option", { signature_typed: "Jane Example", input_radio: "Maybe" }, "input_radio", /Choose one/],
	])("refuses %s (422) without sending or logging it", async (_n, fields, key, msg) => {
		reset({});
		const fetch = providerStub();
		vi.stubGlobal("fetch", fetch);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const r = await submit(fields as Record<string, string>);
		expect(r.status).toBe(422);
		const out = (await r.json()) as { errors: Record<string, string> };
		expect(out.errors[key]).toMatch(msg);
		expect(fetch.mock.calls.some(([u]) => String(u).includes("brevo"))).toBe(false);
		for (const v of Object.values(fields as Record<string, string>)) if (v) expect(JSON.stringify(log.mock.calls)).not.toContain(v.slice(0, 30));
	});
	it("EMAIL_PROVIDER=emdash: the signature is embedded in the HTML part (EmDash 1.5 has no attachments)", async () => {
		reset({ EMAIL_PROVIDER: "emdash" });
		const send = vi.fn(async () => {});
		emdashRuntime.email = { isAvailable: () => true, send };
		vi.stubGlobal("fetch", providerStub());
		expect((await submit({ signature: DATA(PNG_1x1) })).status).toBe(200);
		const [m] = send.mock.calls[0] as unknown as [{ html: string; text: string }];
		expect(m.html).toContain(`<img src="data:image/png;base64,${PNG_1x1}"`);
		expect(m.text).toContain("signature.png: shown as an image in the HTML version of this email.");
		expect(m).not.toHaveProperty("attachments");
	});
	it("kept in the outbox with its signature when email is not set up, then emailed with it by the cron", async () => {
		const kv = memoryKv();
		reset({ FORM_OUTBOX: kv, EMAIL_API_KEY: "" });
		vi.stubGlobal("fetch", providerStub());
		expect((await submit({ signature: DATA(PNG_1x1) })).status).toBe(200);
		const [key, entry] = [...kv.store.entries()].find(([k]) => k.startsWith("msg:")) as [string, { v: string; meta?: unknown }];
		expect(key).toMatch(/^msg:/);
		expect((JSON.parse(entry.v) as Queued).attachments).toEqual([{ filename: "signature.png", contentType: "image/png", content: PNG_1x1 }]);
		expect(entry.meta).toMatchObject({ files: 1 });
		Object.assign(env, { EMAIL_API_KEY: "k", EMAIL_PROVIDER: "postmark" });
		const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", fetch);
		vi.spyOn(console, "log").mockImplementation(() => {});
		expect(await flushOutbox(env as never)).toEqual({ sent: 1, left: 0 });
		const body = JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body));
		expect(body.Attachments).toEqual([{ Name: "signature.png", Content: PNG_1x1, ContentType: "image/png" }]);
	});
});

describe("attachments per provider", () => {
	afterEach(() => vi.unstubAllGlobals());
	const attachments = [{ filename: "signature.png", contentType: "image/png", content: PNG_1x1 }];
	const m = { from: { email: "noreply@example.com", name: "Site" }, to: ["studio@example.com"], subject: "S", text: "T", html: "<p>H</p>", attachments };
	it.each([
		["brevo", 201, (b: Record<string, unknown>) => expect(b.attachment).toEqual([{ name: "signature.png", content: PNG_1x1 }])],
		["resend", 200, (b: Record<string, unknown>) => expect(b.attachments).toEqual([{ filename: "signature.png", content: PNG_1x1 }])],
		["postmark", 200, (b: Record<string, unknown>) => expect(b.Attachments).toEqual([{ Name: "signature.png", Content: PNG_1x1, ContentType: "image/png" }])],
		["sendgrid", 202, (b: Record<string, unknown>) => expect(b.attachments).toEqual([{ content: PNG_1x1, filename: "signature.png", type: "image/png", disposition: "attachment" }])],
	])("%s: JSON attachment shape", async (provider, status, check) => {
		const fetch = vi.fn(async () => new Response("{}", { status }));
		vi.stubGlobal("fetch", fetch);
		expect(await deliver(provider, "k", m)).toEqual({ ok: true });
		check(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body)));
	});
	it("mailgun: multipart with an `attachment` file part", async () => {
		const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", fetch);
		expect(await deliver("mailgun", "k", m)).toEqual({ ok: true });
		const body = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData;
		expect(body).toBeInstanceOf(FormData);
		const file = body.get("attachment") as File;
		expect(file.name).toBe("signature.png");
		expect(file.type).toBe("image/png");
		expect(Buffer.from(await file.arrayBuffer()).toString("base64")).toBe(PNG_1x1);
		expect(body.get("subject")).toBe("S");
	});
	it("no attachments: payloads unchanged", async () => {
		const fetch = vi.fn(async () => new Response("{}", { status: 201 }));
		vi.stubGlobal("fetch", fetch);
		await deliver("brevo", "k", { ...m, attachments: [] });
		expect(JSON.parse(String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body))).not.toHaveProperty("attachment");
	});
	it("inline images only for checked PNGs", () => {
		expect(inlineAttachments({ text: "T", html: "<p>H</p>", attachments: [{ filename: "signature.png", contentType: "image/png", content: '"><script>' }] })).toEqual({ text: "T", html: "<p>H</p>" });
	});
});

describe("Form messages view", () => {
	const q: Queued = { form: "fluent-forms-7", at: "2026-11-19T10:00:00.000Z", attempts: 0, subject: "Signed: Waiver — Jane", text: "Signature: Signed (drawn signature attached as signature.png)", html: "", attachments: [{ filename: "signature.png", contentType: "image/png", content: PNG_1x1 }] };
	it("shows 'signature attached' and the image (a checked PNG data URL)", () => {
		const blocks = message("msg:2026-11-19T10:00:00.000Z:abcdef01", q, "ready");
		const json = JSON.stringify(blocks);
		expect(json).toContain("Signature attached (signature.png)");
		expect(blocks).toContainEqual({ type: "image", url: DATA(PNG_1x1), alt: "Signature sent with this form", title: "signature.png" });
	});
	it("never renders a stored attachment that is not a checked PNG", () => {
		const bad = { ...q, attachments: [{ filename: "signature.png", contentType: "image/png", content: 'x" onerror="alert(1)' }] };
		const blocks = message("msg:2026-11-19T10:00:00.000Z:abcdef01", bad, "ready");
		expect(blocks.some((b) => b.type === "image")).toBe(false);
		expect(JSON.stringify(blocks)).toContain("attached (not shown here)");
	});
	it("the inbox marks messages with a signature", () => {
		const blocks = overview({ status: "ready", items: [{ key: "msg:2026-11-19T10:00:00.000Z:abcdef01", s: summaryOf(q) }], more: false, counts: [], activity: [], days: 30, forms: [q.form], filter: {} }, TABS.inbox);
		expect(JSON.stringify(blocks)).toContain("Signed: Waiver — Jane · signature attached");
	});
});

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
			return { keys: [...store.entries()].filter(([k]) => k.startsWith(o?.prefix ?? "")).map(([name, e]) => ({ name, ...(e.meta ? { metadata: e.meta } : {}) })), list_complete: true };
		},
	};
}
