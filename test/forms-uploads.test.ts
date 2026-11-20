/**
 * @wp2emdash/forms 1.7: file upload fields (checks, private R2 storage, one-time signed download, retention),
 * conditional fields and steps on the endpoint.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFormEndpoint } from "../packages/forms/src/endpoint.js";
import type { FormDefinition } from "../packages/forms/src/index.js";
import { stepsOf, visibility } from "../packages/forms/src/logic.js";
import { checkUpload, createDownloadHandlers, isUploadKey, purgeUploads, safeName, type UploadBucket, uploadDays } from "../packages/forms/src/uploads.js";
import { env } from "./stubs/cloudflare-workers.js";

function memoryBucket(): UploadBucket & { store: Map<string, { body: Uint8Array; type?: string; uploaded: Date }> } {
	const store = new Map<string, { body: Uint8Array; type?: string; uploaded: Date }>();
	return {
		store,
		async put(key, value, o) {
			store.set(key, { body: typeof value === "string" ? new TextEncoder().encode(value) : value, ...(o?.httpMetadata?.contentType ? { type: o.httpMetadata.contentType } : {}), uploaded: new Date() });
		},
		async get(key) {
			const e = store.get(key);
			return e ? { body: new Blob([e.body as BlobPart]).stream(), httpMetadata: { ...(e.type ? { contentType: e.type } : {}) }, size: e.body.byteLength, uploaded: e.uploaded } : null;
		},
		async head(key) {
			const e = store.get(key);
			return e ? { size: e.body.byteLength, uploaded: e.uploaded } : null;
		},
		async delete(keys) {
			for (const k of [keys].flat()) store.delete(k);
		},
		async list(o) {
			return { objects: [...store.entries()].filter(([k]) => k.startsWith(o?.prefix ?? "")).map(([key, e]) => ({ key, uploaded: e.uploaded })), truncated: false };
		},
	};
}

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a]);
const pdfFile = (name = "plan.pdf", bytes = PDF) => new File([bytes as BlobPart], name, { type: "application/pdf" });

describe("upload checks", () => {
	const field = { name: "cv", label: "CV", type: "file" as const, accept: ["pdf"], maxMb: 1 };
	it("accepts a real PDF and names it safely", async () => {
		const c = await checkUpload(pdfFile("Mÿ plán (final).pdf"), field);
		expect(c).toMatchObject({ ok: true, ext: "pdf", type: "application/pdf", name: "My plan final.pdf" });
	});
	it("refuses a wrong extension, a fake PDF, an empty or too large file", async () => {
		expect(await checkUpload(pdfFile("x.exe"), field)).toMatchObject({ ok: false, reason: expect.stringMatching(/only PDF/) });
		expect(await checkUpload(pdfFile("x.pdf", new TextEncoder().encode("<html>")), field)).toMatchObject({ ok: false, reason: expect.stringMatching(/not a real PDF/) });
		expect(await checkUpload(pdfFile("x.pdf", new Uint8Array()), field)).toMatchObject({ ok: false, reason: expect.stringMatching(/empty/) });
		const big = new Uint8Array(1024 * 1024 + 10);
		big.set(PDF);
		expect(await checkUpload(pdfFile("x.pdf", big), field)).toMatchObject({ ok: false, reason: expect.stringMatching(/larger than 1 MB/) });
	});
	it("a field's own list can only narrow the built-in allowlist", async () => {
		expect(await checkUpload(pdfFile("x.exe"), { ...field, accept: ["exe", "pdf"] })).toMatchObject({ ok: false });
		expect(safeName("../../etc/passwd", "pdf")).toBe("passwd.pdf");
		expect(safeName("..\\x\\.htaccess", "txt")).toBe("file.txt");
	});
});

describe("conditional fields and steps", () => {
	const fields = [
		{ name: "kind", label: "Kind", type: "radio" as const, options: ["Adult", "Child"] },
		{ name: "guardian", label: "Guardian", type: "text" as const, required: true, showIf: { field: "kind", equals: ["child"] } },
		{ name: "school", label: "School", type: "text" as const, showIf: { field: "guardian", equals: ["x"], not: true } },
		{ name: "loop", label: "Loop", type: "text" as const, showIf: { field: "loop", equals: ["a"] } },
	];
	it("a field is visible when its controller is visible and matches (case-insensitive); loops are hidden", () => {
		const v = visibility(fields, (f) => ({ kind: ["Adult"], guardian: [""], school: [""], loop: ["a"] })[f.name] ?? []);
		// The controller of "school" is hidden: its value counts as empty, so "not x" holds.
		expect(Object.fromEntries(v)).toEqual({ kind: true, guardian: false, school: true, loop: false });
		const w = visibility(fields, (f) => ({ kind: ["Child"], guardian: ["Ann"] })[f.name] ?? [""]);
		expect(w.get("guardian")).toBe(true);
		expect(w.get("school")).toBe(true);
	});
	it("groups fields by step", () => {
		expect(stepsOf([{ name: "a", label: "", type: "text" }, { name: "b", label: "", type: "text", step: 1 }, { name: "c", label: "", type: "text" }], 2).map((g) => g.map((f) => f.name))).toEqual([["a"], ["b", "c"]]);
	});
});

describe("the endpoint with files and conditions", () => {
	const form: FormDefinition = {
		id: "apply",
		title: "Apply",
		submitLabel: "Send",
		successMessage: "Thanks",
		fields: [
			{ name: "email", label: "Email", type: "email", required: true },
			{ name: "kind", label: "Kind", type: "radio", options: ["Adult", "Child"] },
			{ name: "guardian", label: "Guardian", type: "text", required: true, showIf: { field: "kind", equals: ["Child"] }, step: 1 },
			{ name: "cv", label: "CV", type: "file", accept: ["pdf"], maxMb: 2, step: 1 },
		],
		steps: [{ title: "You" }, { title: "More" }],
	};
	const POST = createFormEndpoint({ getForm: (id) => (id === "apply" ? form : undefined) }) as unknown as (ctx: unknown) => Promise<Response>;
	const submit = (fields: Record<string, string | File>) => {
		const body = new FormData();
		for (const [k, v] of Object.entries({ "cf-turnstile-response": "t", ...fields })) body.set(k, v);
		return POST({ params: { id: "apply" }, request: new Request("https://site.example/api/forms/apply", { method: "POST", body, headers: { accept: "application/json" } }), locals: {} });
	};
	let bucket: ReturnType<typeof memoryBucket>;
	let sent: { text: string }[];
	let log: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		bucket = memoryBucket();
		sent = [];
		for (const k of Object.keys(env)) delete env[k];
		Object.assign(env, { TURNSTILE_SECRET_KEY: "s", EMAIL_API_KEY: "k", FORM_FROM: "noreply@site.example", FORM_TO: "office@site.example", MEDIA: bucket, FORM_FILE_SECRET: "0123456789abcdef0123" });
		vi.stubGlobal(
			"fetch",
			vi.fn(async (url: string, init?: RequestInit) => {
				if (String(url).includes("turnstile")) return new Response(JSON.stringify({ success: true }));
				sent.push({ text: JSON.parse(String(init?.body)).textContent });
				return new Response(JSON.stringify({ messageId: "m" }), { status: 201 });
			}),
		);
		log = vi.spyOn(console, "log").mockImplementation(() => {});
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		log.mockRestore();
	});

	it("a hidden required field does not block; a shown one does", async () => {
		expect((await submit({ email: "a@b.example", kind: "Adult" })).status).toBe(200);
		const r = await submit({ email: "a@b.example", kind: "Child" });
		expect(r.status).toBe(422);
		expect(((await r.json()) as { errors: Record<string, string> }).errors).toEqual({ guardian: "Guardian is required." });
	});
	it("a hidden field's value is not sent on", async () => {
		await submit({ email: "a@b.example", kind: "Adult", guardian: "should not appear" });
		expect(sent[0]?.text).not.toMatch(/should not appear/);
	});
	it("stores the file privately and emails a one-time link instead of the file", async () => {
		const r = await submit({ email: "a@b.example", kind: "Adult", cv: pdfFile() });
		expect(r.status).toBe(200);
		const keys = [...bucket.store.keys()];
		expect(keys).toHaveLength(1);
		expect(keys[0]).toMatch(/^backups\/form-uploads\/apply\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{16}\/plan\.pdf$/);
		expect(isUploadKey(keys[0] as string)).toBe(true);
		expect(bucket.store.get(keys[0] as string)?.type).toBe("application/pdf");
		const link = /https:\/\/site\.example\/api\/forms\/file\?[^\s]+/.exec(sent[0]?.text ?? "")?.[0] as string;
		expect(sent[0]?.text).toMatch(/CV: plan\.pdf \(1 KB\) — download once, until \d{4}-\d{2}-\d{2}: https/);

		const { GET, POST: DOWNLOAD } = createDownloadHandlers(() => env as never);
		const page = await GET({ request: new Request(link) });
		expect(page.status).toBe(200);
		expect(page.headers.get("cache-control")).toBe("private, no-store");
		expect(await page.text()).toMatch(/<button type="submit">Download<\/button>/);
		const file = await DOWNLOAD({ request: new Request(link, { method: "POST" }) });
		expect(file.status).toBe(200);
		expect(file.headers.get("content-disposition")).toBe('attachment; filename="plan.pdf"');
		expect(new Uint8Array(await file.arrayBuffer())).toEqual(PDF);
		// Once only.
		expect((await DOWNLOAD({ request: new Request(link, { method: "POST" }) })).status).toBe(410);
		// A tampered link is refused.
		expect((await GET({ request: new Request(link.replace(/s=[0-9a-f]{4}/, "s=0000")) })).status).toBe(404);
	});
	it("refuses files when uploads are not configured, and bad files, before anything is stored", async () => {
		delete env.FORM_FILE_SECRET;
		const r = await submit({ email: "a@b.example", cv: pdfFile() });
		expect(r.status).toBe(422);
		expect(((await r.json()) as { errors: Record<string, string> }).errors.cv).toMatch(/cannot be sent right now/);
		env.FORM_FILE_SECRET = "0123456789abcdef0123";
		const bad = await submit({ email: "a@b.example", cv: pdfFile("cv.pdf", new TextEncoder().encode("MZ fake")) });
		expect(bad.status).toBe(422);
		expect(bucket.store.size).toBe(0);
	});
	it("an expired link answers 410; retention purges old files", async () => {
		await submit({ email: "a@b.example", cv: pdfFile() });
		const { GET } = createDownloadHandlers(() => env as never);
		const link = new URL(/https:\/\/site\.example\/api\/forms\/file\?[^\s]+/.exec(sent[0]?.text ?? "")?.[0] as string);
		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + 31 * 86_400_000);
		expect((await GET({ request: new Request(link) })).status).toBe(410);
		expect(await purgeUploads(env as never)).toBe(1);
		vi.useRealTimers();
		expect(bucket.store.size).toBe(0);
		expect(uploadDays({ FORM_UPLOAD_DAYS: "7" })).toBe(7);
		expect(uploadDays({ FORM_OUTBOX_DAYS: "500" })).toBe(90);
	});
});
