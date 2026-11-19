/**
 * Form messages: export and import files, the admin activity log, and one-time download links. Pure functions over the
 * outbox's KV binding, no EmDash imports (unit-tested in the kit).
 */
import { type Delivery, deliveryOf, type KvLike, type OutboxEnv, type Queued } from "../outbox.js";

// ── Export ────────────────────────────────────────────────────────────────────────────────────────────────────────

export type ExportFormat = "csv" | "json";
/** "Status" is the read state (as before 1.4); "Email status" is the delivery: Waiting, Emailed or Failed. */
export const EXPORT_COLUMNS = ["Received", "Form", "Name", "Email", "Subject", "Message", "Status", "Email attempts", "Email status", "Emailed at"] as const;
const DELIVERY_NAME: Record<Delivery, string> = { waiting: "Waiting", emailed: "Emailed", failed: "Failed" };

/** One row per message, in the export's column order. */
function row(q: Queued): string[] {
	const d = deliveryOf(q);
	return [q.at, q.form, q.replyTo?.name ?? "", q.replyTo?.email ?? "", q.subject, q.text, q.noEmail ? "Not to email" : q.readAt ? "Read" : "Unread", String(q.attempts), DELIVERY_NAME[d], d === "emailed" ? (q.emailedAt ?? "") : ""];
}

/** A spreadsheet would run a cell that starts like a formula: such cells get a leading apostrophe (OWASP CSV injection). */
const FORMULA = /^[=+\-@\t\r]/;
const cell = (v: string) => `"${(FORMULA.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;

export function toCsv(messages: Queued[]): string {
	// BOM: Excel opens UTF-8 CSV correctly only with it. CRLF: RFC 4180.
	return `﻿${[EXPORT_COLUMNS.map(cell).join(","), ...messages.map((q) => row(q).map(cell).join(","))].join("\r\n")}\r\n`;
}

export function toJson(messages: Queued[], site?: string): string {
	return `${JSON.stringify(
		{
			format: "form-messages",
			version: 1,
			exportedAt: new Date().toISOString(),
			...(site ? { site } : {}),
			messages: messages.map((q) => ({ received: q.at, form: q.form, name: q.replyTo?.name ?? null, email: q.replyTo?.email ?? null, subject: q.subject, message: q.text, read: !!q.readAt, emailAttempts: q.attempts, emailStatus: deliveryOf(q), emailedAt: deliveryOf(q) === "emailed" ? (q.emailedAt ?? null) : null })),
		},
		null,
		2,
	)}\n`;
}

export const exportFileName = (format: ExportFormat) => `form-messages-${new Date().toISOString().slice(0, 10)}.${format}`;

// ── Import ────────────────────────────────────────────────────────────────────────────────────────────────────────

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const LIMITS = { rows: 1000, subject: 300, message: 20_000, name: 200, email: 254, form: 80 };
export interface ImportRow {
	received: string;
	form: string;
	name?: string;
	email?: string;
	subject: string;
	message: string;
	read: boolean;
	/** From an export of a keep-sent inbox: emailed before (with when), so it is never emailed again by the cron. */
	emailed?: boolean;
	emailedAt?: string;
}
export interface Parsed {
	rows: ImportRow[];
	errors: string[];
}

/** RFC 4180 CSV (quoted fields, doubled quotes, CRLF or LF). */
export function parseCsv(text: string): string[][] {
	const out: string[][] = [];
	let rowCells: string[] = [];
	let field = "";
	let quoted = false;
	const s = text.replace(/^﻿/, "");
	for (let i = 0; i < s.length; i++) {
		const c = s[i] as string;
		if (quoted) {
			if (c === '"' && s[i + 1] === '"') {
				field += '"';
				i++;
			} else if (c === '"') quoted = false;
			else field += c;
		} else if (c === '"' && field === "") quoted = true;
		else if (c === ",") {
			rowCells.push(field);
			field = "";
		} else if (c === "\n" || c === "\r") {
			if (c === "\r" && s[i + 1] === "\n") i++;
			rowCells.push(field);
			field = "";
			if (rowCells.some((x) => x !== "")) out.push(rowCells);
			rowCells = [];
		} else field += c;
	}
	rowCells.push(field);
	if (rowCells.some((x) => x !== "")) out.push(rowCells);
	return out;
}

const unguard = (v: string) => (/^'[=+\-@\t\r]/.test(v) ? v.slice(1) : v);
const ALIASES: Record<Exclude<keyof ImportRow, "emailed"> | "status" | "emailStatus", string[]> = {
	emailStatus: ["email status", "emailstatus", "delivery"],
	emailedAt: ["emailed at", "emailedat"],
	received: ["received", "at", "date", "submitted", "created"],
	form: ["form"],
	name: ["name", "full name"],
	email: ["email", "e-mail", "reply to"],
	subject: ["subject"],
	message: ["message", "text", "body"],
	read: ["read"],
	status: ["status"],
};

function normalise(raw: Record<string, unknown>, line: number, errors: string[]): ImportRow | undefined {
	const get = (k: keyof typeof ALIASES) => {
		for (const [key, v] of Object.entries(raw)) if (ALIASES[k].includes(key.trim().toLowerCase())) return typeof v === "string" ? unguard(v.trim()) : v;
		return undefined;
	};
	const received = String(get("received") ?? "");
	const at = Date.parse(received);
	if (Number.isNaN(at)) return void errors.push(`Row ${line}: the received date is missing or not a date.`);
	if (at > Date.now() + 86_400_000) return void errors.push(`Row ${line}: the received date is in the future.`);
	const message = String(get("message") ?? "");
	if (!message) return void errors.push(`Row ${line}: the message is empty.`);
	const email = String(get("email") ?? "");
	if (email && !EMAIL.test(email)) return void errors.push(`Row ${line}: "${email.slice(0, 60)}" is not an email address.`);
	const form = String(get("form") || "imported");
	if (!/^[\w-]{1,80}$/.test(form)) return void errors.push(`Row ${line}: the form id may only use letters, digits, - and _.`);
	const name = String(get("name") ?? "");
	const status = String(get("status") ?? "").toLowerCase();
	const readValue = get("read");
	const sizes: [string, string, number][] = [["subject", String(get("subject") ?? ""), LIMITS.subject], ["message", message, LIMITS.message], ["name", name, LIMITS.name], ["email", email, LIMITS.email]];
	for (const [label, v, max] of sizes) if (v.length > max) return void errors.push(`Row ${line}: the ${label} is longer than ${max} characters.`);
	// Delivery: only "emailed" is carried over (with its time, when it is a date); waiting or failed arrive as waiting.
	const emailed = String(get("emailStatus") ?? "").toLowerCase() === "emailed";
	const emailedAt = Date.parse(String(get("emailedAt") ?? ""));
	return {
		...(emailed ? { emailed: true, ...(Number.isNaN(emailedAt) ? {} : { emailedAt: new Date(emailedAt).toISOString() }) } : {}),
		received: new Date(at).toISOString(),
		form,
		...(name ? { name } : {}),
		...(email ? { email } : {}),
		subject: String(get("subject") || `Website message${name ? ` from ${name}` : ""}`),
		message,
		read: readValue === true || readValue === "true" || status === "read" || status === "not to email",
	};
}

/** A file exported from this page (CSV or JSON), or any CSV with the same column names. */
export function parseImport(text: string): Parsed {
	const errors: string[] = [];
	const trimmed = text.trim();
	if (!trimmed) return { rows: [], errors: ["Paste the contents of an exported file first."] };
	let records: Record<string, unknown>[] = [];
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			const data = JSON.parse(trimmed) as unknown;
			const list = Array.isArray(data) ? data : (data as { messages?: unknown }).messages;
			if (!Array.isArray(list)) return { rows: [], errors: ["The JSON has no list of messages."] };
			records = list.filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null);
		} catch {
			return { rows: [], errors: ["The text looks like JSON but cannot be read. Paste the whole file."] };
		}
	} else {
		const [header, ...lines] = parseCsv(trimmed);
		if (!header) return { rows: [], errors: ["The CSV is empty."] };
		records = lines.map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i] ?? ""])));
	}
	if (records.length > LIMITS.rows) return { rows: [], errors: [`Import at most ${LIMITS.rows} messages at a time (this has ${records.length}).`] };
	const rows = records.flatMap((r, i) => normalise(r, i + 2 - (trimmed.startsWith("{") || trimmed.startsWith("[") ? 1 : 0), errors) ?? []);
	return { rows, errors };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** An import row as a stored message. The email body is rebuilt from the text: imported HTML is never trusted. */
export function toQueued(r: ImportRow, opts: { email: boolean; markRead: boolean }): Queued {
	const now = new Date().toISOString();
	return {
		form: r.form,
		at: r.received,
		attempts: 0,
		...(r.email ? { replyTo: { email: r.email, ...(r.name ? { name: r.name } : {}) } } : {}),
		subject: r.subject,
		text: r.message,
		html: `<div style="font:14px/1.5 sans-serif">${esc(r.message).replace(/\n/g, "<br>")}</div>`,
		...(r.read || opts.markRead ? { readAt: now } : {}),
		...(opts.email ? {} : { noEmail: true }),
		storedAt: now,
		source: "import",
		...(r.emailed ? { status: "emailed" as const, ...(r.emailedAt ? { emailedAt: r.emailedAt } : {}) } : { status: "waiting" as const }),
	};
}

// ── Activity log ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface Activity {
	at: string;
	who: string;
	action: string;
	count?: number;
}
const ACT = "act:";

/** What an admin did on the page: the action and a count, never message content. Kept 180 days. */
export async function logActivity(kv: KvLike | undefined, who: string, action: string, count?: number): Promise<void> {
	if (!kv) return;
	const at = new Date().toISOString();
	await kv.put(`${ACT}${at}:${crypto.randomUUID().slice(0, 6)}`, JSON.stringify({ at, who: who.slice(0, 120), action, ...(count !== undefined ? { count } : {}) } satisfies Activity), { expirationTtl: 180 * 86_400 });
}

/** The latest entries, newest first. */
export async function readActivity(kv: KvLike | undefined, limit = 50): Promise<Activity[]> {
	if (!kv) return [];
	const names: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await kv.list({ prefix: ACT, limit: 1000, ...(cursor ? { cursor } : {}) });
		names.push(...page.keys.map((k) => k.name));
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	const out: Activity[] = [];
	for (const name of names.slice(-limit).reverse()) {
		const raw = await kv.get(name);
		if (!raw) continue;
		try {
			out.push(JSON.parse(raw) as Activity);
		} catch {}
	}
	return out;
}

// ── One-time download links ───────────────────────────────────────────────────────────────────────────────────────

export interface DownloadGrant {
	format: ExportFormat;
	scope: "all" | "unread";
	who: string;
}
const DL = "dl:";
export const DOWNLOAD_SECONDS = 120;

/** A random token an admin's export creates; the public download route accepts it once, for two minutes. */
export async function grantDownload(env: OutboxEnv, grant: DownloadGrant): Promise<string> {
	const bytes = crypto.getRandomValues(new Uint8Array(24));
	const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
	await env.FORM_OUTBOX?.put(`${DL}${token}`, JSON.stringify(grant), { expirationTtl: DOWNLOAD_SECONDS });
	return token;
}

export async function redeemDownload(env: OutboxEnv, token: unknown): Promise<DownloadGrant | undefined> {
	if (typeof token !== "string" || !/^[0-9a-f]{48}$/.test(token) || !env.FORM_OUTBOX) return undefined;
	const raw = await env.FORM_OUTBOX.get(`${DL}${token}`);
	if (!raw) return undefined;
	await env.FORM_OUTBOX.delete(`${DL}${token}`);
	return JSON.parse(raw) as DownloadGrant;
}
