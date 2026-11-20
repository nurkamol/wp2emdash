/**
 * Form outbox: when email cannot be sent (provider not configured, or it refuses), the message is kept in Workers KV
 * (binding FORM_OUTBOX) instead of being lost, and the Worker's cron retries it every few minutes; a message is
 * deleted as soon as it is emailed, or expires after the site's retention period. Only enabled when the owner chose it
 * (kit.config forms.outbox). Nothing here logs field values.
 *
 * Keep sent (FORM_OUTBOX_KEEP_SENT="1", kit.config forms.outbox.keepSent, an owner decision): every accepted message is
 * stored, also once emailed, so Form messages is a full inbox. Each record has a delivery status:
 *   waiting — not sent yet (email not set up, or on hold)  → the cron sends it
 *   failed  — the provider refused it (attempts counted)    → the cron keeps retrying
 *   emailed — the provider accepted it (emailedAt, emailedTo, messageId when the provider returns one) → never resent
 *             by the cron; an admin can "Email again"
 * Without keep sent a message is deleted once emailed (as before). Either way the retention period ends every record.
 * Site admins manage the queue in the EmDash admin
 * (Plugins → Form messages, src/plugins/forms/); with Cloudflare access: `wrangler kv key list/get --binding FORM_OUTBOX`.
 *
 * Keys: `msg:<received ISO>:<8 hex>` (message; a short summary rides in the key's metadata so lists need no reads),
 * `stat:<day>:<outcome>:<form>` (a count per day — no visitor data), `cfg:recipients` (the recipients an admin set on
 * the Form messages page; the endpoint reads it too), plus the admin page's own `act:` and `dl:` keys.
 */
import { deliver, type Message, parseAddress } from "./deliver.js";
import { emdashEmailAvailable, sendViaEmDash } from "./emdash-email.js";
import type { Attachment } from "./signature.js";

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
	/** "1": keep every message, also once emailed (marked emailed), until the retention period ends — a full inbox. */
	FORM_OUTBOX_KEEP_SENT?: string;
	EMAIL_PROVIDER?: string;
	EMAIL_API_KEY?: string;
	FORM_FROM?: string;
	FORM_TO?: string;
	/**
	 * Single-environment sites (wp2emdash scaffold): the production host (without www.). A message sent from any other
	 * host — the workers.dev address before go-live, a Workers preview URL after it — is a test: it is marked `test`,
	 * emailed only to FORM_TEST_TO, and never to FORM_TO or the admin's recipients, also when the outbox sends it later.
	 * Unset (sites with a staging environment): every message is real, as before.
	 */
	FORM_LIVE_HOST?: string;
	/** Test recipients for test messages (kit.config email.stagingTo). Unset: test messages are kept unsent (outbox) or refused. */
	FORM_TEST_TO?: string;
	MAILGUN_REGION?: string;
}

/** Where a stored message is on its way to the recipients' mailboxes. */
export type Delivery = "waiting" | "emailed" | "failed";

/** What is stored: the message without sender (it comes from settings when it is sent). */
export interface Queued {
	form: string;
	/** When the visitor sent it. */
	at: string;
	attempts: number;
	replyTo?: { email: string; name?: string };
	subject: string;
	text: string;
	html: string;
	/** Files emailed with it (a signed form's signature.png), kept with the message until it is emailed or expires. */
	attachments?: Attachment[];
	/** When an admin first opened it. */
	readAt?: string;
	/** Imported without email: kept for reference, never sent by the cron. */
	noEmail?: boolean;
	/** When it was stored, if not when it was sent (imports): the retention period counts from here. */
	storedAt?: string;
	source?: "form" | "import";
	/** Delivery status (records written before forms 1.4 have none: waiting, or failed once an attempt failed). */
	status?: Delivery;
	/** When the provider accepted it (the last time, when an admin emailed it again). */
	emailedAt?: string;
	/** Who it was emailed to then (shown to admins on the message page only; logs carry a count). */
	emailedTo?: string[];
	/** The provider's message id, when its API returns one (Brevo, Resend, Postmark, SendGrid, Mailgun). */
	messageId?: string;
	/** Sent from a host other than FORM_LIVE_HOST (workers.dev before go-live, a preview URL): only ever emailed to FORM_TEST_TO. */
	test?: boolean;
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
	/** How many files are attached (a signature). */
	files?: number;
	status?: Delivery;
	/** Imports only: when it was stored (the retention period counts from here). */
	storedAt?: string;
	/** A test message (see Queued.test). */
	test?: boolean;
}

const PREFIX = "msg:";
const STAT = "stat:";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KEY = /^msg:[0-9TZ:.-]+:[0-9a-f]{8}$/;
const DAY = 86_400;

export const retentionDays = (env: OutboxEnv) => Math.min(90, Math.max(1, Number(env.FORM_OUTBOX_DAYS) || 30));

/** Keep sent: every message stays (marked emailed) until the retention period ends. Needs the outbox binding. */
export const keepsSent = (env: OutboxEnv) => env.FORM_OUTBOX_KEEP_SENT === "1" && !!env.FORM_OUTBOX;

/** A record's delivery status; records from before forms 1.4 have none. */
export const deliveryOf = (q: { status?: Delivery; attempts?: number }): Delivery => q.status ?? ((q.attempts ?? 0) > 0 ? "failed" : "waiting");

/** Whether the retention period of a message received `at` (stored `storedAt`, for imports) has ended. */
export function expired(env: OutboxEnv, m: { at?: string; storedAt?: string }, now = Date.now()): boolean {
	const start = Date.parse(m.storedAt ?? m.at ?? "");
	return !Number.isNaN(start) && now >= start + retentionDays(env) * DAY * 1000;
}

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
		...(q.attachments?.length ? { files: q.attachments.length } : {}),
		status: deliveryOf(q),
		...(q.storedAt ? { storedAt: q.storedAt } : {}),
		...(q.test ? { test: true } : {}),
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

/** Store a new message from the form; `status` defaults to waiting (failed when an attempt already failed). */
export async function enqueue(env: OutboxEnv, q: Omit<Queued, "at" | "attempts"> & { attempts?: number }): Promise<boolean> {
	if (!env.FORM_OUTBOX) return false;
	const at = new Date().toISOString();
	const attempts = q.attempts ?? 0;
	await store(env, `${PREFIX}${at}:${crypto.randomUUID().slice(0, 8)}`, { ...q, at, attempts, status: q.status ?? (attempts > 0 ? "failed" : "waiting"), source: "form" });
	return true;
}

/** The record once the provider accepted it: emailed, when, to whom and the provider's id (if it gave one). */
export function markEmailed(q: Queued, to: string[], id?: string, at = new Date().toISOString()): Queued {
	const { messageId: _old, ...rest } = q;
	return { ...rest, status: "emailed", emailedAt: at, emailedTo: to.slice(0, MAX_RECIPIENTS), ...(id ? { messageId: id } : {}) };
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

// ── Test messages (single-environment sites) ────────────────────────────────────────────────────────────────────

const bareHost = (h: string) => h.trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");

/**
 * Whether a request is a test: FORM_LIVE_HOST is set and the request's host is not it (www. ignored). Before go-live
 * the domain is not routed to the Worker, so every message is a test; after it, only workers.dev and preview URLs are.
 */
export function isTestRequest(env: OutboxEnv, url: string): boolean {
	if (!env.FORM_LIVE_HOST) return false;
	try {
		return bareHost(new URL(url).hostname) !== bareHost(env.FORM_LIVE_HOST);
	} catch {
		return true;
	}
}

/** The test inbox (FORM_TEST_TO). Test messages go here and nowhere else. */
export function testRecipients(env: OutboxEnv): string[] {
	return (env.FORM_TEST_TO ?? "").split(",").map((x) => x.trim()).filter((x) => EMAIL.test(x)).slice(0, MAX_RECIPIENTS);
}

/** Recipients for one message: a test message only ever goes to the test inbox. */
export async function recipientsFor(env: OutboxEnv, m: { test?: boolean }): Promise<string[]> {
	return m.test ? testRecipients(env) : (await resolveRecipients(env)).to;
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

/**
 * Stored messages' keys and summaries, oldest first, without reading the messages (entries without a summary are read
 * once). Up to `limit`: the oldest (default — the outbox drains oldest first) or, with `newest`, the most recent (keep
 * sent: an inbox shows what came in last); `more` when others were left out.
 */
export async function listSummaries(env: OutboxEnv, limit = 1000, opts: { newest?: boolean } = {}): Promise<{ items: { key: string; s: Summary }[]; more: boolean }> {
	const kv = env.FORM_OUTBOX;
	if (!kv) return { items: [], more: false };
	let found: { name: string; metadata?: unknown }[] = [];
	let more = false;
	let cursor: string | undefined;
	do {
		const page = await kv.list({ prefix: PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
		found.push(...page.keys.filter((k) => isOutboxKey(k.name)));
		if (found.length > limit) {
			more = true;
			if (!opts.newest) {
				found = found.slice(0, limit);
				break;
			}
			found = found.slice(-limit);
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	const items: { key: string; s: Summary }[] = [];
	for (const { name, metadata } of found) {
		const m = metadata as Summary | undefined;
		if (m?.subject !== undefined) items.push({ key: name, s: m });
		else {
			const q = await readQueued(env, name);
			if (q) items.push({ key: name, s: summaryOf(q) });
		}
	}
	return { items, more };
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

/**
 * Email one stored message now (an admin's "Email it now" / "Email again"). Once the provider accepts it, it is marked
 * emailed (keep sent) or deleted. A refusal counts an attempt: a message not emailed yet becomes failed, one emailed
 * before stays emailed.
 */
export async function sendQueued(env: OutboxEnv, key: string): Promise<"sent" | "failed" | "held" | "no-email" | "missing"> {
	const status = await outboxStatus(env);
	if (status === "held") return status;
	const q = await readQueued(env, key);
	if (!q) return status === "ready" ? "missing" : status;
	// A test message only ever goes to the test inbox, whoever presses the button.
	const to = await recipientsFor(env, q);
	if (!(await emailConfigured(env, to))) return "no-email";
	const again = deliveryOf(q) === "emailed";
	const r = await sendOne(env, q, to, again ? "again" : "late");
	if (!r.ok) {
		await store(env, key, { ...q, attempts: q.attempts + 1, status: again ? "emailed" : "failed" });
		return "failed";
	}
	if (keepsSent(env)) await store(env, key, markEmailed(q, to, r.id));
	else await env.FORM_OUTBOX?.delete(key);
	return "sent";
}

async function sendOne(env: OutboxEnv, q: Queued, to: string[], why: "late" | "again"): Promise<{ ok: boolean; id?: string }> {
	const note = why === "again" ? `Received ${q.at}; sent again from the website's form messages.` : `Received ${q.at}; delivered late from the website's outbox.`;
	const text = `${q.text}\n\n(${note})`;
	const html = `${q.html}<p style="font:12px sans-serif;color:#666">${note}</p>`;
	const files = q.attachments?.length ? { attachments: q.attachments } : {};
	if (usesEmDashEmail(env)) return { ok: (await sendViaEmDash(to, { ...(q.replyTo ? { replyTo: q.replyTo.email } : {}), subject: q.subject, text, html, ...files })).ok };
	const from = parseAddress(env.FORM_FROM);
	if (!from || !env.EMAIL_API_KEY) return { ok: false };
	const m: Message = { from, to, ...(q.replyTo ? { replyTo: q.replyTo } : {}), subject: q.subject, text, html, ...files };
	const r = await deliver(env.EMAIL_PROVIDER ?? "brevo", env.EMAIL_API_KEY, m, { ...(env.MAILGUN_REGION ? { region: env.MAILGUN_REGION } : {}) });
	return r.ok ? { ok: true, ...(r.id ? { id: r.id } : {}) } : { ok: false };
}

/**
 * Cron: delete messages whose retention period has ended (KV's own expiry does this too; this also applies a shortened
 * FORM_OUTBOX_DAYS to messages stored earlier), then email every waiting or failed message — never an emailed one, nor
 * one imported without email. Once emailed: marked emailed with keep sent, else deleted. Returns counts only.
 */
export async function flushOutbox(env: OutboxEnv): Promise<{ sent: number; left: number; expired?: number }> {
	const kv = env.FORM_OUTBOX;
	if (!kv) return { sent: 0, left: 0 };
	const ready = (await outboxStatus(env)) === "ready";
	const to = ready ? (await resolveRecipients(env)).to : [];
	// Test messages (sent from workers.dev or a preview URL): only to the test inbox — also after go-live.
	const testTo = env.FORM_OUTBOX_HOLD === "1" ? [] : testRecipients(env);
	const testReady = testTo.length > 0 && (await emailConfigured(env, testTo));
	const keep = keepsSent(env);
	let sent = 0;
	let left = 0;
	let gone = 0;
	let cursor: string | undefined;
	do {
		const page = await kv.list({ prefix: PREFIX, limit: 100, ...(cursor ? { cursor } : {}) });
		for (const { name, metadata } of page.keys) {
			if (!isOutboxKey(name)) continue;
			const m = metadata as Summary | undefined;
			// The summary (metadata) answers without a read; records without one are read once.
			let q = m?.at ? undefined : await readQueued(env, name);
			if (!m?.at && !q) continue;
			if (expired(env, m?.at ? m : (q as Queued))) {
				await kv.delete(name);
				gone++;
				continue;
			}
			if ((m ?? q)?.noEmail || deliveryOf(m ?? (q as Queued)) === "emailed") continue;
			// The summary carries the test flag; a record without a summary is read above.
			if (!((m ?? q)?.test ? testReady : ready)) {
				left++;
				continue;
			}
			q ??= await readQueued(env, name);
			if (!q || q.noEmail || deliveryOf(q) === "emailed") continue;
			const dest = q.test ? testTo : to;
			if (!dest.length) {
				left++;
				continue;
			}
			const r = await sendOne(env, q, dest, "late");
			if (r.ok) {
				if (keep) await store(env, name, markEmailed(q, dest, r.id));
				else await kv.delete(name);
				sent++;
			} else {
				await store(env, name, { ...q, attempts: q.attempts + 1, status: "failed" });
				left++;
			}
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	if (sent || left || gone) console.log(JSON.stringify({ outbox: { sent, left, ...(gone ? { expired: gone } : {}), ...(sent ? { recipients: to.length } : {}) } }));
	return { sent, left, ...(gone ? { expired: gone } : {}) };
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
