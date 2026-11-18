/**
 * Form outbox: when email cannot be sent (provider not configured, or it refuses), the message is kept in Workers KV
 * (binding FORM_OUTBOX) instead of being lost, and the Worker's cron retries it every few minutes; a message is
 * deleted as soon as it is emailed, or expires after the site's retention period. Only enabled when the owner chose it
 * (kit.config forms.outbox). Nothing here logs field values; reading the queue is for the site owner
 * (`wrangler kv key list/get --binding FORM_OUTBOX`).
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

/** Cron: try to email every queued message; returns counts only. */
export async function flushOutbox(env: OutboxEnv): Promise<{ sent: number; left: number }> {
	const kv = env.FORM_OUTBOX;
	const from = parseAddress(env.FORM_FROM);
	const to = (env.FORM_TO ?? "").split(",").map((x) => x.trim()).filter((x) => EMAIL.test(x));
	if (!kv) return { sent: 0, left: 0 };
	const held = env.FORM_OUTBOX_HOLD === "1";
	let sent = 0;
	let left = 0;
	let cursor: string | undefined;
	do {
		const page = await kv.list({ prefix: PREFIX, limit: 100, ...(cursor ? { cursor } : {}) });
		for (const { name } of page.keys) {
			if (held || !env.EMAIL_API_KEY || !from || !to.length) {
				left++;
				continue;
			}
			const raw = await kv.get(name);
			if (!raw) continue;
			const q = JSON.parse(raw) as Queued;
			const m: Message = { from, to, ...(q.replyTo ? { replyTo: q.replyTo } : {}), subject: q.subject, text: `${q.text}\n\n(Received ${q.at}; delivered late from the website's outbox.)`, html: `${q.html}<p style="font:12px sans-serif;color:#666">Received ${q.at}; delivered late from the website's outbox.</p>` };
			const r = await deliver(env.EMAIL_PROVIDER ?? "brevo", env.EMAIL_API_KEY, m, { ...(env.MAILGUN_REGION ? { region: env.MAILGUN_REGION } : {}) });
			if (r.ok) {
				await kv.delete(name);
				sent++;
			} else left++;
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	if (sent || left) console.log(JSON.stringify({ outbox: { sent, left } }));
	return { sent, left };
}
