/**
 * Form outbox: when email cannot be sent (provider not configured, or it refuses), the message is kept in Workers KV
 * (binding FORM_OUTBOX) instead of being lost, and the Worker's cron retries it every few minutes; a message is
 * deleted as soon as it is emailed, or expires after the site's retention period. Only enabled when the owner chose it
 * (kit.config forms.outbox). Nothing here logs field values. Site admins manage the queue in the EmDash admin
 * (Plugins → Form messages, src/plugins/forms/); with Cloudflare access: `wrangler kv key list/get --binding FORM_OUTBOX`.
 *
 * Keys: `msg:<received ISO>:<8 hex>` (message; a short summary rides in the key's metadata so lists need no reads),
 * `stat:<day>:<outcome>:<form>` (a count per day — no visitor data), `cfg:recipients` (the recipients an admin set on
 * the Form messages page; the endpoint reads it too), plus the admin page's own `act:` and `dl:` keys.
 */
import { deliver, type Message, parseAddress } from "./deliver.js";
import { emdashEmailAvailable, sendViaEmDash } from "./emdash-email.js";

export interface KvLike {
	put(key: string, value: string, opts?: { expirationTtl?: number; metadata?: unknown }): Promise<void>;
	get(key: string): Promise<string | null>;
	delete(key: string): Promise<void>;
	list(opts?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ keys: { name: string; metadata?: unknown }[]; list_complete: boolean; cursor?: string }>;
}

export interface OutboxEnv {
	FORM_OUTBOX?: KvLike;
	FORM_OUTBOX_DAYS?: string;
	/** "1": keep every message, send none (the provider accepts mail but does not deliver it). */
	FORM_OUTBOX_HOLD?: string;
	EMAIL_PROVIDER?: string;
	EMAIL_API_KEY?: string;
	FORM_FROM?: string;
	FORM_TO?: string;
	MAILGUN_REGION?: string;
}

/** What is stored: the message without sender and recipients (those come from settings when it is sent). */
export interface Queued {
	form: string;
	/** When the visitor sent it. */
	at: string;
	attempts: number;
	replyTo?: { email: string; name?: string };
	subject: string;
	text: string;
	html: string;
	/** When an admin first opened it. */
	readAt?: string;
	/** Imported without email: kept for reference, never sent by the cron. */
	noEmail?: boolean;
	/** When it was stored, if not when it was sent (imports): the retention period counts from here. */
	storedAt?: string;
	source?: "form" | "import";
}

/** The summary kept in each message key's metadata (KV allows 1024 bytes). */
export interface Summary {
	form: string;
	at: string;
	subject?: string;
	from?: string;
	email?: string;
	read?: boolean;
	noEmail?: boolean;
}

const PREFIX = "msg:";
const STAT = "stat:";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KEY = /^msg:[0-9TZ:.-]+:[0-9a-f]{8}$/;
const DAY = 86_400;

export const retentionDays = (env: OutboxEnv) => Math.min(90, Math.max(1, Number(env.FORM_OUTBOX_DAYS) || 30));

const clip = (s: string | undefined, n: number) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);
export function summaryOf(q: Queued): Summary {
	return {
		form: q.form,
		at: q.at,
		subject: clip(q.subject, 140),
		...(q.replyTo?.name ? { from: clip(q.replyTo.name, 100) } : {}),
		...(q.replyTo?.email ? { email: clip(q.replyTo.email, 120) } : {}),
		...(q.readAt ? { read: true } : {}),
		...(q.noEmail ? { noEmail: true } : {}),
	};
}

/** Seconds left before the message's retention period ends (at least a minute, KV's minimum). */
function ttlLeft(env: OutboxEnv, q: Queued): number {
	const start = Date.parse(q.storedAt ?? q.at);
	const end = (Number.isNaN(start) ? Date.now() : start) + retentionDays(env) * DAY * 1000;
	return Math.max(60, Math.round((end - Date.now()) / 1000));
}

async function store(env: OutboxEnv, key: string, q: Queued): Promise<void> {
	await env.FORM_OUTBOX?.put(key, JSON.stringify(q), { expirationTtl: ttlLeft(env, q), metadata: summaryOf(q) });
}

export async function enqueue(env: OutboxEnv, q: Omit<Queued, "at" | "attempts">): Promise<boolean> {
	if (!env.FORM_OUTBOX) return false;
	const at = new Date().toISOString();
	await store(env, `${PREFIX}${at}:${crypto.randomUUID().slice(0, 8)}`, { ...q, at, attempts: 0, source: "form" });
	return true;
}

/** Store a message from an import under a key derived from its content, so importing the same file twice adds nothing. */
export async function importQueued(env: OutboxEnv, q: Queued): Promise<"added" | "duplicate"> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode([q.at, q.form, q.replyTo?.email ?? "", q.subject, q.text].join("\u0000"))));
	const key = `${PREFIX}${q.at}:${[...digest.slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
	if (await env.FORM_OUTBOX?.get(key)) return "duplicate";
	await store(env, key, q);
	return "added";
}

// ── Recipients ────────────────────────────────────────────────────────────────────────────────────────────────────

export const MAX_RECIPIENTS = 10;
const RECIPIENTS_KEY = "cfg:recipients";
const ADDRESS = /^[^\s@<>,;"]{1,64}@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

/** Addresses typed by an admin (commas, semicolons, spaces or new lines between them): checked, de-duplicated, at most 10. */
export function parseRecipients(text: string): { list: string[]; errors: string[] } {
	const list: string[] = [];
	const errors: string[] = [];
	for (const raw of text.split(/[\s,;]+/)) {
		const a = raw.trim();
		if (!a) continue;
		if (a.length > 254 || !ADDRESS.test(a)) errors.push(`"${a.slice(0, 60)}" is not an email address.`);
		else if (!list.some((x) => x.toLowerCase() === a.toLowerCase())) list.push(a);
	}
	if (list.length > MAX_RECIPIENTS) errors.push(`At most ${MAX_RECIPIENTS} recipients (this has ${list.length}).`);
	return { list, errors };
}

/** The recipients an admin set on the Form messages page, if any (kept in the outbox's KV, without expiry). */
export async function readRecipientSetting(env: OutboxEnv): Promise<string[] | undefined> {
	const raw = await env.FORM_OUTBOX?.get(RECIPIENTS_KEY).catch(() => null);
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw) as unknown;
		const list = (Array.isArray(parsed) ? parsed : []).filter((x): x is string => typeof x === "string" && ADDRESS.test(x)).slice(0, MAX_RECIPIENTS);
		return list.length ? list : undefined;
	} catch {
		return undefined;
	}
}

/** Save the admin's recipients; an empty list removes the setting (FORM_TO applies again). */
export async function writeRecipientSetting(env: OutboxEnv, list: string[]): Promise<void> {
	if (!env.FORM_OUTBOX) return;
	if (list.length) await env.FORM_OUTBOX.put(RECIPIENTS_KEY, JSON.stringify(list.slice(0, MAX_RECIPIENTS)));
	else await env.FORM_OUTBOX.delete(RECIPIENTS_KEY);
}

/** Who form messages go to: the admin setting, else FORM_TO from wrangler.jsonc. */
export async function resolveRecipients(env: OutboxEnv): Promise<{ to: string[]; source: "admin" | "config" | "none" }> {
	const set = await readRecipientSetting(env);
	if (set) return { to: set, source: "admin" };
	const to = (env.FORM_TO ?? "").split(",").map((x) => x.trim()).filter((x) => EMAIL.test(x));
	return { to, source: to.length ? "config" : "none" };
}

// ── Sending ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** EMAIL_PROVIDER=emdash: send through EmDash's own pipeline (Settings → Email) instead of a provider API key. */
export const usesEmDashEmail = (env: OutboxEnv) => env.EMAIL_PROVIDER === "emdash";

/** Whether a message can be emailed to `to` right now (a provider is configured and there are recipients). */
export async function emailConfigured(env: OutboxEnv, to: string[]): Promise<boolean> {
	if (!to.length) return false;
	if (usesEmDashEmail(env)) return emdashEmailAvailable();
	return !!env.EMAIL_API_KEY && !!parseAddress(env.FORM_FROM);
}

export type OutboxStatus = "held" | "no-email" | "ready";

/** Why queued messages are not being emailed right now, if they are not. */
export async function outboxStatus(env: OutboxEnv): Promise<OutboxStatus> {
	if (env.FORM_OUTBOX_HOLD === "1") return "held";
	return (await emailConfigured(env, (await resolveRecipients(env)).to)) ? "ready" : "no-email";
}

/** A key the outbox wrote (anything else is refused, so the admin page cannot reach other keys). */
export const isOutboxKey = (key: unknown): key is string => typeof key === "string" && KEY.test(key);

/** Every waiting message's key and summary, oldest first, without reading the messages (older entries are read once). */
export async function listSummaries(env: OutboxEnv, limit = 1000): Promise<{ items: { key: string; s: Summary }[]; more: boolean }> {
	const kv = env.FORM_OUTBOX;
	if (!kv) return { items: [], more: false };
	const items: { key: string; s: Summary }[] = [];
	let cursor: string | undefined;
	do {
		const page = await kv.list({ prefix: PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
		for (const { name, metadata } of page.keys) {
			if (!isOutboxKey(name)) continue;
			if (items.length === limit) return { items, more: true };
			const m = metadata as Summary | undefined;
			if (m?.subject !== undefined) items.push({ key: name, s: m });
			else {
				const q = await readQueued(env, name);
				if (q) items.push({ key: name, s: summaryOf(q) });
			}
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	return { items, more: false };
}

/** The queued messages in full, oldest first, up to `limit`; `more` when there are others. */
export async function listQueued(env: OutboxEnv, limit = 100): Promise<{ items: { key: string; q: Queued }[]; more: boolean }> {
	const { items, more } = await listSummaries(env, limit);
	const full: { key: string; q: Queued }[] = [];
	for (const { key } of items) {
		const q = await readQueued(env, key);
		if (q) full.push({ key, q });
	}
	return { items: full, more };
}

export async function readQueued(env: OutboxEnv, key: string): Promise<Queued | undefined> {
	if (!env.FORM_OUTBOX || !isOutboxKey(key)) return undefined;
	const raw = await env.FORM_OUTBOX.get(key);
	if (!raw) return undefined;
	try {
		return JSON.parse(raw) as Queued;
	} catch {
		return undefined;
	}
}

/** Change a message's read state or email flag; its retention period is unchanged. */
export async function updateQueued(env: OutboxEnv, key: string, patch: { read?: boolean; noEmail?: boolean }): Promise<Queued | undefined> {
	const q = await readQueued(env, key);
	if (!q) return undefined;
	const next: Queued = { ...q };
	if (patch.read === true && !next.readAt) next.readAt = new Date().toISOString();
	if (patch.read === false) delete next.readAt;
	if (patch.noEmail !== undefined) {
		if (patch.noEmail) next.noEmail = true;
		else delete next.noEmail;
	}
	if (JSON.stringify(next) !== JSON.stringify(q)) await store(env, key, next);
	return next;
}

export async function deleteQueued(env: OutboxEnv, key: string): Promise<boolean> {
	if (!env.FORM_OUTBOX || !isOutboxKey(key)) return false;
	await env.FORM_OUTBOX.delete(key);
	return true;
}

/** Email one queued message now and delete it once the provider accepts it. */
export async function sendQueued(env: OutboxEnv, key: string): Promise<"sent" | "failed" | "held" | "no-email" | "missing"> {
	const status = await outboxStatus(env);
	if (status !== "ready") return status;
	const q = await readQueued(env, key);
	if (!q) return "missing";
	if (!(await sendOne(env, q, (await resolveRecipients(env)).to))) {
		await store(env, key, { ...q, attempts: q.attempts + 1 });
		return "failed";
	}
	await env.FORM_OUTBOX?.delete(key);
	return "sent";
}

async function sendOne(env: OutboxEnv, q: Queued, to: string[]): Promise<boolean> {
	const text = `${q.text}\n\n(Received ${q.at}; delivered late from the website's outbox.)`;
	const html = `${q.html}<p style="font:12px sans-serif;color:#666">Received ${q.at}; delivered late from the website's outbox.</p>`;
	if (usesEmDashEmail(env)) return (await sendViaEmDash(to, { ...(q.replyTo ? { replyTo: q.replyTo.email } : {}), subject: q.subject, text, html })).ok;
	const from = parseAddress(env.FORM_FROM);
	if (!from || !env.EMAIL_API_KEY) return false;
	const m: Message = { from, to, ...(q.replyTo ? { replyTo: q.replyTo } : {}), subject: q.subject, text, html };
	const r = await deliver(env.EMAIL_PROVIDER ?? "brevo", env.EMAIL_API_KEY, m, { ...(env.MAILGUN_REGION ? { region: env.MAILGUN_REGION } : {}) });
	return r.ok;
}

/** Cron: try to email every queued message (except those imported without email); returns counts only. */
export async function flushOutbox(env: OutboxEnv): Promise<{ sent: number; left: number }> {
	const kv = env.FORM_OUTBOX;
	if (!kv) return { sent: 0, left: 0 };
	const ready = (await outboxStatus(env)) === "ready";
	const to = ready ? (await resolveRecipients(env)).to : [];
	let sent = 0;
	let left = 0;
	let cursor: string | undefined;
	do {
		const page = await kv.list({ prefix: PREFIX, limit: 100, ...(cursor ? { cursor } : {}) });
		for (const { name, metadata } of page.keys) {
			if ((metadata as Summary | undefined)?.noEmail) continue;
			if (!ready) {
				left++;
				continue;
			}
			const raw = await kv.get(name);
			if (!raw) continue;
			const q = JSON.parse(raw) as Queued;
			if (q.noEmail) continue;
			if (await sendOne(env, q, to)) {
				await kv.delete(name);
				sent++;
			} else {
				await store(env, name, { ...q, attempts: q.attempts + 1 });
				left++;
			}
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	if (sent || left) console.log(JSON.stringify({ outbox: { sent, left } }));
	return { sent, left };
}

/**
 * Count a form message for the admin's charts: one number per day, outcome and form — nothing a visitor wrote.
 * Kept 400 days. Best effort (a lost increment under concurrent sends only makes a chart a little low).
 */
export async function countMessage(env: OutboxEnv, form: string, outcome: "emailed" | "kept"): Promise<void> {
	const kv = env.FORM_OUTBOX;
	if (!kv || !/^[\w-]{1,80}$/.test(form)) return;
	const key = `${STAT}${new Date().toISOString().slice(0, 10)}:${outcome}:${form}`;
	const n = Number(await kv.get(key)) || 0;
	await kv.put(key, String(n + 1), { expirationTtl: 400 * DAY });
}

export interface DayCount {
	day: string;
	outcome: "emailed" | "kept";
	form: string;
	count: number;
}

/** Daily counts since `sinceDay` (YYYY-MM-DD). */
export async function readCounts(env: OutboxEnv, sinceDay: string): Promise<DayCount[]> {
	const kv = env.FORM_OUTBOX;
	if (!kv) return [];
	const out: DayCount[] = [];
	let cursor: string | undefined;
	do {
		const page = await kv.list({ prefix: STAT, limit: 1000, ...(cursor ? { cursor } : {}) });
		for (const { name } of page.keys) {
			const m = /^stat:(\d{4}-\d{2}-\d{2}):(emailed|kept):([\w-]+)$/.exec(name);
			if (!m || (m[1] as string) < sinceDay) continue;
			out.push({ day: m[1] as string, outcome: m[2] as "emailed" | "kept", form: m[3] as string, count: Number(await kv.get(name)) || 0 });
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	return out;
}
