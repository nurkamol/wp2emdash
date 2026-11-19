/**
 * Form outbox: when email cannot be sent (provider not configured, or it refuses), the message is kept in Workers KV
 * (binding FORM_OUTBOX) instead of being lost, and the Worker's cron retries it every few minutes; a message is
 * deleted as soon as it is emailed, or expires after the site's retention period. Only enabled when the owner chose it
 * (kit.config forms.outbox). Nothing here logs field values. Site admins read the queue in the EmDash admin
 * (Plugins → Form messages, src/plugins/forms/plugin.ts); with Cloudflare access: `wrangler kv key list/get --binding FORM_OUTBOX`.
 */
import { deliver, type Message, parseAddress } from "./deliver.js";

export interface KvLike {
	put(key: string, value: string, opts?: { expirationTtl?: number; metadata?: unknown }): Promise<void>;
	get(key: string): Promise<string | null>;
	delete(key: string): Promise<void>;
	list(opts?: { prefix?: string; cursor?: string; limit?: number }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
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
	at: string;
	attempts: number;
	replyTo?: { email: string; name?: string };
	subject: string;
	text: string;
	html: string;
}

const PREFIX = "msg:";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function enqueue(env: OutboxEnv, q: Omit<Queued, "at" | "attempts">): Promise<boolean> {
	if (!env.FORM_OUTBOX) return false;
	const days = Math.min(90, Math.max(1, Number(env.FORM_OUTBOX_DAYS) || 30));
	const at = new Date().toISOString();
	const key = `${PREFIX}${at}:${crypto.randomUUID().slice(0, 8)}`;
	await env.FORM_OUTBOX.put(key, JSON.stringify({ ...q, at, attempts: 0 } satisfies Queued), { expirationTtl: days * 86_400, metadata: { form: q.form, at } });
	return true;
}

/** Why queued messages are not being emailed right now, if they are not. */
export function outboxStatus(env: OutboxEnv): "held" | "no-email" | "ready" {
	if (env.FORM_OUTBOX_HOLD === "1") return "held";
	return env.EMAIL_API_KEY && parseAddress(env.FORM_FROM) && recipients(env).length ? "ready" : "no-email";
}

const recipients = (env: OutboxEnv) => (env.FORM_TO ?? "").split(",").map((x) => x.trim()).filter((x) => EMAIL.test(x));
const KEY = /^msg:[0-9TZ:.-]+:[0-9a-f]{8}$/;

/** A key the outbox wrote (anything else is refused, so the admin page cannot reach other keys). */
export const isOutboxKey = (key: unknown): key is string => typeof key === "string" && KEY.test(key);

/** The queued messages, oldest first, up to `limit`; `more` when there are others. */
export async function listQueued(env: OutboxEnv, limit = 100): Promise<{ items: { key: string; q: Queued }[]; more: boolean }> {
	const kv = env.FORM_OUTBOX;
	if (!kv) return { items: [], more: false };
	const items: { key: string; q: Queued }[] = [];
	let cursor: string | undefined;
	do {
		const page = await kv.list({ prefix: PREFIX, limit: 100, ...(cursor ? { cursor } : {}) });
		for (const { name } of page.keys) {
			if (items.length === limit) return { items, more: true };
			const q = await readQueued(env, name);
			if (q) items.push({ key: name, q });
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	return { items, more: false };
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

export async function deleteQueued(env: OutboxEnv, key: string): Promise<boolean> {
	if (!env.FORM_OUTBOX || !isOutboxKey(key)) return false;
	await env.FORM_OUTBOX.delete(key);
	return true;
}

/** Email one queued message now and delete it once the provider accepts it. */
export async function sendQueued(env: OutboxEnv, key: string): Promise<"sent" | "failed" | "held" | "no-email" | "missing"> {
	const status = outboxStatus(env);
	if (status !== "ready") return status;
	const q = await readQueued(env, key);
	if (!q) return "missing";
	if (!(await sendOne(env, q))) return "failed";
	await env.FORM_OUTBOX?.delete(key);
	return "sent";
}

async function sendOne(env: OutboxEnv, q: Queued): Promise<boolean> {
	const from = parseAddress(env.FORM_FROM);
	if (!from || !env.EMAIL_API_KEY) return false;
	const m: Message = { from, to: recipients(env), ...(q.replyTo ? { replyTo: q.replyTo } : {}), subject: q.subject, text: `${q.text}\n\n(Received ${q.at}; delivered late from the website's outbox.)`, html: `${q.html}<p style="font:12px sans-serif;color:#666">Received ${q.at}; delivered late from the website's outbox.</p>` };
	const r = await deliver(env.EMAIL_PROVIDER ?? "brevo", env.EMAIL_API_KEY, m, { ...(env.MAILGUN_REGION ? { region: env.MAILGUN_REGION } : {}) });
	return r.ok;
}

/** Cron: try to email every queued message; returns counts only. */
export async function flushOutbox(env: OutboxEnv): Promise<{ sent: number; left: number }> {
	const kv = env.FORM_OUTBOX;
	if (!kv) return { sent: 0, left: 0 };
	const ready = outboxStatus(env) === "ready";
	let sent = 0;
	let left = 0;
	let cursor: string | undefined;
	do {
		const page = await kv.list({ prefix: PREFIX, limit: 100, ...(cursor ? { cursor } : {}) });
		for (const { name } of page.keys) {
			if (!ready) {
				left++;
				continue;
			}
			const raw = await kv.get(name);
			if (!raw) continue;
			if (await sendOne(env, JSON.parse(raw) as Queued)) {
				await kv.delete(name);
				sent++;
			} else left++;
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	if (sent || left) console.log(JSON.stringify({ outbox: { sent, left } }));
	return { sent, left };
}
