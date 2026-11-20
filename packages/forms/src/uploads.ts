/**
 * File upload fields (type "file"): what a visitor attaches is checked, stored privately, and reaches the recipients as
 * a one-time download link in the email — never as an attachment (providers cap attachment size, and a link keeps the
 * file out of mailboxes once it expires).
 *
 * - Checks: size (field `maxMb`, default 10, hard cap 25), count (`maxFiles`, default 1, at most 5), extension (field
 *   `accept` ∩ UPLOAD_TYPES) and the file's first bytes (a `.pdf` must start with %PDF, a `.docx` is a ZIP…). The stored
 *   content type comes from the extension table, never from the visitor's browser.
 * - Storage: the site's R2 bucket (binding MEDIA) under `backups/form-uploads/<form>/<day>/<random>/<name>`. EmDash's
 *   public media route refuses every key under `backups/` (transfer/staging/keys.ts PRIVATE_STORAGE_PREFIXES, EmDash
 *   1.5; docs/spikes/change-requests-findings.md), so the files are never public.
 * - Download: `/api/forms/file?k=<key>&e=<expiry>&s=<HMAC-SHA256>` signed with the Worker secret FORM_FILE_SECRET. A GET
 *   shows a page with a Download button (mail scanners that open links do not spend the link); the POST checks the
 *   signature and expiry again, marks the file downloaded (`<key>.used`) and sends it as an attachment. One download per
 *   link: after that the link answers 410.
 * - Retention: `purgeUploads` (the Worker's cron) deletes files older than FORM_UPLOAD_DAYS (default: the outbox
 *   retention, else 30 days). The link expires at the same time.
 *
 * Nothing here logs file names or contents.
 */
import type { FormField } from "./types.js";

export const UPLOAD_PREFIX = "backups/form-uploads/";
export const UPLOAD_MAX_MB = 25;
export const UPLOAD_DEFAULT_MB = 10;
export const UPLOAD_MAX_FILES = 5;

/** What may be uploaded at all: extension → content type and a first-bytes test. */
export const UPLOAD_TYPES: Record<string, { type: string; test: (b: Uint8Array) => boolean }> = {
	pdf: { type: "application/pdf", test: (b) => starts(b, [0x25, 0x50, 0x44, 0x46]) },
	png: { type: "image/png", test: (b) => starts(b, [0x89, 0x50, 0x4e, 0x47]) },
	jpg: { type: "image/jpeg", test: (b) => starts(b, [0xff, 0xd8, 0xff]) },
	jpeg: { type: "image/jpeg", test: (b) => starts(b, [0xff, 0xd8, 0xff]) },
	gif: { type: "image/gif", test: (b) => starts(b, [0x47, 0x49, 0x46, 0x38]) },
	webp: { type: "image/webp", test: (b) => starts(b, [0x52, 0x49, 0x46, 0x46]) && ascii(b, 8, 4) === "WEBP" },
	heic: { type: "image/heic", test: (b) => ascii(b, 4, 4) === "ftyp" && /^(heic|heix|mif1|msf1|hevc)$/.test(ascii(b, 8, 4)) },
	doc: { type: "application/msword", test: (b) => starts(b, OLE) },
	xls: { type: "application/vnd.ms-excel", test: (b) => starts(b, OLE) },
	docx: { type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", test: (b) => starts(b, ZIP) },
	xlsx: { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", test: (b) => starts(b, ZIP) },
	pptx: { type: "application/vnd.openxmlformats-officedocument.presentationml.presentation", test: (b) => starts(b, ZIP) },
	odt: { type: "application/vnd.oasis.opendocument.text", test: (b) => starts(b, ZIP) },
	ods: { type: "application/vnd.oasis.opendocument.spreadsheet", test: (b) => starts(b, ZIP) },
	zip: { type: "application/zip", test: (b) => starts(b, ZIP) },
	txt: { type: "text/plain", test: (b) => !b.subarray(0, 4096).includes(0) },
	csv: { type: "text/csv", test: (b) => !b.subarray(0, 4096).includes(0) },
	rtf: { type: "application/rtf", test: (b) => ascii(b, 0, 5) === "{\\rtf" },
};
/** Allowed when a field names none: documents and pictures (no archives). */
export const DEFAULT_ACCEPT = ["pdf", "jpg", "jpeg", "png", "gif", "webp", "heic", "doc", "docx", "xls", "xlsx", "odt", "ods", "txt", "csv", "rtf"];
const OLE = [0xd0, 0xcf, 0x11, 0xe0];
const ZIP = [0x50, 0x4b, 0x03, 0x04];
function starts(b: Uint8Array, sig: number[]): boolean {
	return sig.every((x, i) => b[i] === x);
}
function ascii(b: Uint8Array, at: number, n: number): string {
	return String.fromCharCode(...b.subarray(at, at + n));
}

/** The extensions a field takes (its own list, limited to UPLOAD_TYPES; default DEFAULT_ACCEPT). */
export function acceptedOf(field: Pick<FormField, "accept">): string[] {
	const own = (field.accept ?? []).map((x) => x.toLowerCase().replace(/^\./, "")).filter((x) => x in UPLOAD_TYPES);
	return own.length ? [...new Set(own)] : DEFAULT_ACCEPT;
}
export const maxMbOf = (field: Pick<FormField, "maxMb">) => Math.min(UPLOAD_MAX_MB, Math.max(1, field.maxMb ?? UPLOAD_DEFAULT_MB));
export const maxFilesOf = (field: Pick<FormField, "maxFiles">) => Math.min(UPLOAD_MAX_FILES, Math.max(1, field.maxFiles ?? 1));

/** A file name safe for a storage key and a Content-Disposition header: letters, digits, dot, dash, underscore, space. */
export function safeName(name: string, ext: string): string {
	const base = (name.split(/[\\/]/).pop() ?? "").replace(/\.[^.]*$/, "").replace(/^\.+/, "").normalize("NFKD").replace(/[^\w .-]+/g, "").replace(/\s+/g, " ").trim().slice(0, 80) || "file";
	return `${base}.${ext}`;
}

export type UploadCheck = { ok: true; name: string; ext: string; type: string; bytes: Uint8Array } | { ok: false; reason: string };

/** Check one uploaded file against a field's limits. */
export async function checkUpload(file: { name: string; size: number; arrayBuffer(): Promise<ArrayBuffer> }, field: FormField): Promise<UploadCheck> {
	const ext = (/\.([a-z0-9]{2,5})$/i.exec(file.name)?.[1] ?? "").toLowerCase();
	const accepted = acceptedOf(field);
	if (!ext || !accepted.includes(ext)) return { ok: false, reason: `${field.label}: only ${accepted.map((x) => x.toUpperCase()).join(", ")} files can be sent.` };
	const max = maxMbOf(field);
	if (file.size > max * 1024 * 1024) return { ok: false, reason: `${field.label}: the file is larger than ${max} MB.` };
	if (!file.size) return { ok: false, reason: `${field.label}: the file is empty.` };
	const bytes = new Uint8Array(await file.arrayBuffer());
	const t = UPLOAD_TYPES[ext];
	if (!t?.test(bytes)) return { ok: false, reason: `${field.label}: the file is not a real ${ext.toUpperCase()} file.` };
	return { ok: true, name: safeName(file.name, ext), ext, type: t.type, bytes };
}

export interface UploadBucket {
	put(key: string, value: Uint8Array | string, opts?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
	get(key: string): Promise<{ body: ReadableStream; httpMetadata?: { contentType?: string }; size: number; uploaded?: Date } | null>;
	head(key: string): Promise<{ size: number; uploaded?: Date } | null>;
	delete(keys: string | string[]): Promise<void>;
	list(opts?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ objects: { key: string; uploaded: Date }[]; truncated: boolean; cursor?: string }>;
}

export interface UploadEnv {
	MEDIA?: UploadBucket;
	FORM_FILE_SECRET?: string;
	FORM_UPLOAD_DAYS?: string;
	FORM_OUTBOX_DAYS?: string;
}

/** Days a file (and its link) is kept. */
export function uploadDays(env: UploadEnv): number {
	const n = Number(env.FORM_UPLOAD_DAYS ?? env.FORM_OUTBOX_DAYS ?? 30);
	return Number.isFinite(n) ? Math.min(90, Math.max(1, Math.round(n))) : 30;
}
export const uploadsReady = (env: UploadEnv) => !!env.MEDIA && !!env.FORM_FILE_SECRET && env.FORM_FILE_SECRET.length >= 16;

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const rand = (n: number) => hex(crypto.getRandomValues(new Uint8Array(n)).buffer as ArrayBuffer);

export const KEY_PATTERN = /^backups\/form-uploads\/[\w-]{1,80}\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{16}\/[\w .-]{1,90}$/;
export const isUploadKey = (k: string) => KEY_PATTERN.test(k) && !k.includes("..");

export async function sign(secret: string, key: string, exp: number): Promise<string> {
	const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return hex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${key}\n${exp}`)));
}
/** Constant-time comparison of two hex strings. */
export function sameHex(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let d = 0;
	for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return d === 0;
}

export interface StoredUpload {
	name: string;
	bytes: number;
	url: string;
	expires: string;
}

/** Store a checked file and return its one-time link (absolute, on `origin`). */
export async function storeUpload(env: UploadEnv, formId: string, file: Extract<UploadCheck, { ok: true }>, origin: string, now = new Date()): Promise<StoredUpload> {
	if (!uploadsReady(env)) throw new Error("uploads not configured");
	const form = formId.replace(/[^\w-]/g, "-").slice(0, 80);
	const key = `${UPLOAD_PREFIX}${form}/${now.toISOString().slice(0, 10)}/${rand(8)}/${file.name}`;
	await (env.MEDIA as UploadBucket).put(key, file.bytes, { httpMetadata: { contentType: file.type }, customMetadata: { form, plugin: "wp2emdash-forms" } });
	const exp = Math.floor(now.getTime() / 1000) + uploadDays(env) * 86_400;
	const s = await sign(env.FORM_FILE_SECRET as string, key, exp);
	const url = `${origin}/api/forms/file?${new URLSearchParams({ k: key, e: String(exp), s })}`;
	return { name: file.name, bytes: file.bytes.byteLength, url, expires: new Date(exp * 1000).toISOString().slice(0, 10) };
}

export const sizeText = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
/** The line the email shows for a stored file. */
export const uploadLine = (u: StoredUpload) => `${u.name} (${sizeText(u.bytes)}) — download once, until ${u.expires}: ${u.url}`;

type Verified = { ok: true; key: string } | { ok: false; status: number; message: string };
async function verify(env: UploadEnv, q: URLSearchParams, now: number): Promise<Verified> {
	const key = q.get("k") ?? "";
	const exp = Number(q.get("e") ?? "");
	const s = q.get("s") ?? "";
	if (!uploadsReady(env)) return { ok: false, status: 503, message: "Downloads are not available." };
	if (!isUploadKey(key) || !Number.isInteger(exp) || !/^[0-9a-f]{64}$/.test(s) || !sameHex(s, await sign(env.FORM_FILE_SECRET as string, key, exp))) return { ok: false, status: 404, message: "This download link is not valid." };
	if (exp * 1000 < now) return { ok: false, status: 410, message: "This download link has expired." };
	if (await (env.MEDIA as UploadBucket).head(`${key}.used`)) return { ok: false, status: 410, message: "This file was already downloaded with this link." };
	return { ok: true, key };
}

const page = (status: number, body: string) =>
	new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>Download</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#111}button{font:inherit;padding:.6rem 1.2rem;cursor:pointer}</style></head><body>${body}</body></html>`, {
		status,
		headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", "x-robots-tag": "noindex, nofollow", "referrer-policy": "no-referrer" },
	});
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/**
 * GET: a page with one Download button (posts the same query); POST: the file, once. Serve it from an Astro route,
 * e.g. `src/pages/api/forms/file.ts`: `export const GET = …; export const POST = …` from `createDownloadHandlers(env)`.
 */
export function createDownloadHandlers(getEnv: () => UploadEnv) {
	return {
		GET: async ({ request }: { request: Request }) => {
			const url = new URL(request.url);
			const v = await verify(getEnv(), url.searchParams, Date.now());
			if (!v.ok) return page(v.status, `<p>${esc(v.message)}</p>`);
			const name = v.key.split("/").pop() as string;
			return page(200, `<h1 style="font-size:1.25rem">${esc(name)}</h1><p>This link works once: the file is sent when you press Download.</p><form method="post" action="${esc(`${url.pathname}${url.search}`)}"><button type="submit">Download</button></form>`);
		},
		POST: async ({ request }: { request: Request }) => {
			const env = getEnv();
			const v = await verify(env, new URL(request.url).searchParams, Date.now());
			if (!v.ok) return page(v.status, `<p>${esc(v.message)}</p>`);
			const bucket = env.MEDIA as UploadBucket;
			const obj = await bucket.get(v.key);
			if (!obj) return page(410, "<p>This file is no longer kept.</p>");
			await bucket.put(`${v.key}.used`, new Date().toISOString(), { customMetadata: { plugin: "wp2emdash-forms" } });
			const name = v.key.split("/").pop() as string;
			return new Response(obj.body, {
				status: 200,
				headers: {
					"content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
					"content-disposition": `attachment; filename="${name.replace(/"/g, "")}"`,
					"cache-control": "private, no-store",
					"x-content-type-options": "nosniff",
					"content-security-policy": "sandbox; default-src 'none'",
					"x-robots-tag": "noindex, nofollow",
				},
			});
		},
	};
}

/** The cron: delete stored files (and their used markers) older than the retention period. Returns how many were deleted. */
export async function purgeUploads(env: UploadEnv, now = Date.now()): Promise<number> {
	if (!env.MEDIA) return 0;
	const cutoff = now - uploadDays(env) * 86_400_000;
	let cursor: string | undefined;
	let deleted = 0;
	for (let i = 0; i < 50; i++) {
		const page = await env.MEDIA.list({ prefix: UPLOAD_PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
		const old = page.objects.filter((o) => o.uploaded.getTime() < cutoff).map((o) => o.key);
		if (old.length) {
			await env.MEDIA.delete(old);
			deleted += old.length;
		}
		if (!page.truncated) break;
		cursor = page.cursor;
	}
	return deleted;
}
