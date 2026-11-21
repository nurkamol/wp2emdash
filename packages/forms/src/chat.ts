/**
 * Chat notifications for new form messages: Telegram (Bot API sendMessage), Slack (incoming webhook) and a generic
 * webhook (JSON POST — Discord, Google Chat, Microsoft Teams workflows, Make/Zapier/n8n, and through those WhatsApp).
 * Each notification carries a link to the message in Form messages (the admin inbox).
 *
 * Present on every site with the outbox, but nothing is sent until an admin turns a channel on (Form messages →
 * Settings) AND the channel's secret exists as a Worker secret:
 *   TELEGRAM_BOT_TOKEN · SLACK_WEBHOOK_URL · CHAT_WEBHOOK_URL   (`wrangler secret put <NAME>`; never in KV, code or logs)
 * The settings (which channels, the Telegram chat id — not a secret —, which forms, what is sent) live in the outbox's
 * KV under `cfg:chat`. FORM_CHAT="0" (kit.config forms.chat: false) removes the feature.
 *
 * What is sent:
 *   notice  — "notification only": the form's name, the time and the link. Nothing the visitor wrote.
 *   summary — (default) also the sender's name (when the form has a name field) and the first ~200 characters of the
 *             message box. Never email addresses, phone numbers, other fields or files.
 * On a site with sensitive data (FORM_SENSITIVE="1", kit.config sensitiveData, or a sensitive form) only `notice` is
 * possible, whatever the setting says: the visitor's text never leaves the site.
 *
 * Delivery never blocks or fails a form submission: the endpoint hands `notifyChat` to the Worker's waitUntil, and it
 * never throws. A channel that fails is kept as a small job in the same KV (`chat:<time>:<hex>`, a day at most) and
 * retried by the Worker's cron (the outbox's 5-minute cron) up to MAX_ATTEMPTS in all, then dropped quietly with a
 * count per day and channel (`chatfail:<day>:<channel>`) that Form messages → Settings and Site health show.
 * Logs carry channel names and counts only — never a token, a webhook URL, a chat id or anything a visitor wrote.
 */
import type { KvLike, OutboxEnv } from "./outbox.js";

export type Channel = "telegram" | "slack" | "webhook";
export const CHANNELS: readonly Channel[] = ["telegram", "slack", "webhook"];
/** The Worker secret each channel needs. */
export const CHANNEL_SECRET: Record<Channel, string> = { telegram: "TELEGRAM_BOT_TOKEN", slack: "SLACK_WEBHOOK_URL", webhook: "CHAT_WEBHOOK_URL" };
export const CHANNEL_NAME: Record<Channel, string> = { telegram: "Telegram", slack: "Slack", webhook: "Webhook" };

/** summary: form, time, name, message excerpt, link. notice: form, time, link — nothing the visitor wrote. */
export type ChatContent = "summary" | "notice";
/** The generic webhook's body: the full JSON event, `{ text }` (Google Chat, Mattermost, Rocket.Chat) or Discord's `{ content }`. */
export type WebhookFormat = "json" | "text" | "discord";
export const WEBHOOK_FORMATS: readonly WebhookFormat[] = ["json", "text", "discord"];

export interface ChatSettings {
	telegram: { on: boolean; chatId?: string };
	slack: { on: boolean };
	webhook: { on: boolean; format: WebhookFormat };
	/** Which forms notify: every form, or the ids picked. */
	forms: "all" | string[];
	content: ChatContent;
}

export interface ChatEnv extends OutboxEnv {
	TELEGRAM_BOT_TOKEN?: string;
	SLACK_WEBHOOK_URL?: string;
	CHAT_WEBHOOK_URL?: string;
	/** "0": no chat notifications on this site (kit.config forms.chat: false). */
	FORM_CHAT?: string;
	/** "1": the site handles sensitive data (kit.config sensitiveData) — notification only. */
	FORM_SENSITIVE?: string;
}

export const DEFAULT_CHAT: ChatSettings = { telegram: { on: false }, slack: { on: false }, webhook: { on: false, format: "json" }, forms: "all", content: "summary" };
export const MAX_ATTEMPTS = 5;
export const EXCERPT_CHARS = 200;
export const TEST_EVERY_SECONDS = 60;

const SETTINGS_KEY = "cfg:chat";
const TEST_KEY = "cfg:chat-test";
const JOB = "chat:";
const JOB_KEY = /^chat:[0-9TZ:.-]+:[0-9a-f]{8}$/;
const FAIL = "chatfail:";
const DAY = 86_400;
/** Telegram chat ids: a number (negative for groups, -100… for channels) or a public channel's @username. */
const CHAT_ID = /^(-?\d{1,20}|@[A-Za-z][\w]{3,31})$/;
const FORM_ID = /^[\w-]{1,80}$/;

export const chatEnabled = (env: ChatEnv) => env.FORM_CHAT !== "0";
export const siteSensitive = (env: ChatEnv) => env.FORM_SENSITIVE === "1";
export const validChatId = (v: unknown): v is string => typeof v === "string" && CHAT_ID.test(v);

const httpsUrl = (v: string | undefined) => {
	if (!v) return false;
	try {
		return new URL(v).protocol === "https:";
	} catch {
		return false;
	}
};

/** Whether a channel's Worker secret is set and looks right (the value itself never leaves this module). */
export function secretSet(env: ChatEnv, ch: Channel): boolean {
	if (ch === "telegram") return /^\d{3,20}:[\w-]{20,100}$/.test(env.TELEGRAM_BOT_TOKEN ?? "");
	return httpsUrl(ch === "slack" ? env.SLACK_WEBHOOK_URL : env.CHAT_WEBHOOK_URL);
}

// ── Settings ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Stored settings (or anything else) as settings: unknown values fall back to the defaults (everything off). */
export function parseChatSettings(raw: unknown): ChatSettings {
	const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, any>;
	const forms = Array.isArray(o.forms) ? [...new Set(o.forms.filter((f: unknown): f is string => typeof f === "string" && FORM_ID.test(f)))].slice(0, 100) : "all";
	return {
		telegram: { on: o.telegram?.on === true, ...(validChatId(o.telegram?.chatId) ? { chatId: o.telegram.chatId as string } : {}) },
		slack: { on: o.slack?.on === true },
		webhook: { on: o.webhook?.on === true, format: WEBHOOK_FORMATS.includes(o.webhook?.format) ? (o.webhook.format as WebhookFormat) : "json" },
		forms,
		content: o.content === "notice" ? "notice" : "summary",
	};
}

export async function readChatSettings(env: ChatEnv): Promise<ChatSettings> {
	const raw = await env.FORM_OUTBOX?.get(SETTINGS_KEY).catch(() => null);
	if (!raw) return { ...DEFAULT_CHAT };
	try {
		return parseChatSettings(JSON.parse(raw));
	} catch {
		return { ...DEFAULT_CHAT };
	}
}

export async function writeChatSettings(env: ChatEnv, s: ChatSettings): Promise<void> {
	await env.FORM_OUTBOX?.put(SETTINGS_KEY, JSON.stringify(parseChatSettings(s)));
}

/**
 * The admin's Settings form → settings. A channel whose secret is missing cannot be turned on; a sensitive site keeps
 * notification only; Telegram needs a valid chat id. `forms`: the site's form ids (the picker's options).
 */
export function chatSettingsFromForm(v: Record<string, unknown>, o: { env: ChatEnv; forms: string[] }): { settings: ChatSettings; errors: string[] } {
	const errors: string[] = [];
	const on = (ch: Channel) => v[`${ch}_on`] === true && secretSet(o.env, ch);
	const chatId = typeof v.telegram_chat_id === "string" ? v.telegram_chat_id.trim() : "";
	if (chatId && !validChatId(chatId)) errors.push("The Telegram chat id is a number (groups start with -, channels with -100) or a public channel's @name.");
	if (on("telegram") && !validChatId(chatId)) errors.push("Telegram needs a chat id before it can be turned on.");
	const picked = (Array.isArray(v.forms_picked) ? v.forms_picked : []).filter((f): f is string => typeof f === "string" && o.forms.includes(f));
	const pick = v.forms_scope === "pick";
	if (pick && !picked.length) errors.push("Pick at least one form, or choose All forms.");
	const settings = parseChatSettings({
		telegram: { on: on("telegram") && validChatId(chatId), ...(validChatId(chatId) ? { chatId } : {}) },
		slack: { on: on("slack") },
		webhook: { on: on("webhook"), format: v.webhook_format },
		forms: pick ? picked : "all",
		content: siteSensitive(o.env) || v.content === "notice" ? "notice" : "summary",
	});
	return { settings, errors };
}

/** What is sent: notification only on a sensitive site or form, else the admin's choice. */
export const contentMode = (s: ChatSettings, sensitive: boolean): ChatContent => (sensitive ? "notice" : s.content);

/** The channels a new message from `form` notifies: on, with its secret (and Telegram a chat id), for a form that notifies. */
export function channelsFor(s: ChatSettings, env: ChatEnv, form: string, o: { test?: boolean } = {}): Channel[] {
	if (!chatEnabled(env) || !env.FORM_OUTBOX || o.test) return [];
	if (s.forms !== "all" && !s.forms.includes(form)) return [];
	return CHANNELS.filter((ch) => s[ch].on && secretSet(env, ch) && (ch !== "telegram" || validChatId(s.telegram.chatId)));
}

// ── The notification ──────────────────────────────────────────────────────────────────────────────────────────────

/** What a notification says. In `notice` mode there is no name and no excerpt — they are never even built. */
export interface Note {
	form: string;
	formTitle: string;
	/** When the visitor sent it (ISO). */
	at: string;
	/** The message in Form messages (or the inbox, when the message is not kept there). */
	link: string;
	/** The link opens this message (it is kept in Form messages). */
	kept: boolean;
	mode: ChatContent;
	name?: string;
	excerpt?: string;
	/** The admin's "Send a test notification". */
	test?: boolean;
	/** The site's host, for the webhook event. */
	site?: string;
}

// Control characters (C0 except tab/newline, DEL, C1) and bidirectional overrides that could disguise text.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F‎‏‪-‮⁦-⁩]/g;

/** Strip control characters, collapse blank lines and spaces, and cut to `max` characters (with an ellipsis). */
export function clean(s: string, max: number, o: { lines?: boolean } = {}): string {
	let t = s.replace(/\r\n?/g, "\n").replace(CONTROL, "");
	t = o.lines ? t.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n") : t.replace(/\s+/g, " ").trim();
	const chars = [...t];
	return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : t;
}

/** The message box: the form's first multi-line field that was filled in. */
export function messageExcerpt(values: { field: { type: string }; value: string }[]): string | undefined {
	const v = values.find((x) => x.field.type === "textarea" && x.value.trim())?.value;
	return v ? clean(v, EXCERPT_CHARS, { lines: true }) : undefined;
}

/** Form messages in the admin: the message itself when it is kept, else the inbox. Keys map to a URL-safe path. */
export function inboxLink(origin: string, pluginId: string, key?: string): string {
	const path = key ? `/messages/${key.slice(4).replace(/:/g, "_")}` : "/messages";
	return new URL(`/_emdash/admin/plugins/${encodeURIComponent(pluginId)}${path}`, origin).toString();
}

/** The message key in a deep-link page path (`/messages/<time>_<hex>`), if it is one. */
export function keyFromPage(page: unknown): string | undefined {
	if (typeof page !== "string") return undefined;
	const m = /^\/messages\/([0-9T_.Z-]+_[0-9a-f]{8})\/?$/.exec(page);
	return m ? `msg:${(m[1] as string).replace(/_/g, ":")}` : undefined;
}

export function buildNote(i: { form: { id: string; title: string; sensitive?: boolean }; values: { field: { type: string }; value: string }[]; name?: string; at: Date; link: string; kept: boolean; site?: string }, s: ChatSettings, env: ChatEnv): Note {
	const mode = contentMode(s, siteSensitive(env) || !!i.form.sensitive);
	const base: Note = { form: i.form.id, formTitle: clean(i.form.title, 120) || i.form.id, at: i.at.toISOString(), link: i.link, kept: i.kept, mode, ...(i.site ? { site: i.site } : {}) };
	if (mode === "notice") return base;
	const name = i.name ? clean(i.name, 100) : "";
	const excerpt = messageExcerpt(i.values);
	return { ...base, ...(name ? { name } : {}), ...(excerpt ? { excerpt } : {}) };
}

/** A note as the current settings allow it: notification only drops the name and the excerpt (also for a retry). */
export function restrict(n: Note, mode: ChatContent): Note {
	if (mode === "summary" && n.mode === "summary") return n;
	const { name: _n, excerpt: _e, ...rest } = n;
	return { ...rest, mode: "notice" };
}

const when = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
const linkLabel = (n: Note) => (n.test ? "Open Form messages" : n.kept ? "Open the message" : "Open Form messages");
const headline = (n: Note, esc: (s: string) => string = (s) => s) => (n.test ? "Test notification: chat notifications work" : `New form message: ${esc(n.formTitle)}`);

export const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
/** Slack mrkdwn: &, < and > are the only characters Slack asks to escape (they make links and mentions). */
export const escapeSlack = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] as string);
/** Discord markdown: escaped so visitor text cannot make links, headings, quotes or formatting. */
export const escapeDiscord = (s: string) => s.replace(/([\\`*_~|[\]()<>#])/g, "\\$1");

/** Plain text (the generic webhook's `text`, Google Chat…). */
export function plainText(n: Note): string {
	const lines = [headline(n), `Received: ${when(n.at)}`];
	if (n.test) lines[1] = `Sent: ${when(n.at)}`;
	if (n.name) lines.push(`From: ${n.name}`);
	if (n.excerpt) lines.push(n.excerpt);
	if (!n.kept && !n.test) lines.push("(Emailed to the site's recipients; not kept in Form messages.)");
	lines.push(`${linkLabel(n)}: ${n.link}`);
	return lines.join("\n");
}

/** Telegram sendMessage body (parse_mode HTML: only &, < and > are escaped; Telegram's limit is 4096 characters). */
export function telegramPayload(n: Note, chatId: string): { chat_id: string; text: string; parse_mode: "HTML"; link_preview_options: { is_disabled: true } } {
	const lines = [`<b>${headline(n, escapeHtml)}</b>`, `${n.test ? "Sent" : "Received"}: ${when(n.at)}`];
	if (n.name) lines.push(`From: ${escapeHtml(n.name)}`);
	if (n.excerpt) lines.push(`<blockquote>${escapeHtml(n.excerpt)}</blockquote>`);
	if (!n.kept && !n.test) lines.push("<i>Emailed to the site's recipients; not kept in Form messages.</i>");
	lines.push(`<a href="${escapeHtml(n.link)}">${linkLabel(n)}</a>`);
	return { chat_id: chatId, text: lines.join("\n").slice(0, 4096), parse_mode: "HTML", link_preview_options: { is_disabled: true } };
}

/** Slack incoming webhook body (mrkdwn text; previews off). */
export function slackPayload(n: Note): { text: string; unfurl_links: false; unfurl_media: false } {
	const lines = [`*${headline(n, escapeSlack)}*`, `${n.test ? "Sent" : "Received"}: ${when(n.at)}`];
	if (n.name) lines.push(`From: ${escapeSlack(n.name)}`);
	if (n.excerpt) lines.push(n.excerpt.split("\n").map((l) => `>${escapeSlack(l)}`).join("\n"));
	if (!n.kept && !n.test) lines.push("_Emailed to the site's recipients; not kept in Form messages._");
	lines.push(`<${n.link}|${linkLabel(n)}>`);
	return { text: lines.join("\n"), unfurl_links: false, unfurl_media: false };
}

/** The generic webhook's JSON event (format "json"). Contains exactly what the chat apps get. */
export interface ChatEvent {
	event: "form_message" | "test";
	text: string;
	site?: string;
	form: { id: string; title: string };
	receivedAt: string;
	link: string;
	/** "summary" or "notice" (notification only: no name, no excerpt). */
	content: ChatContent;
	name?: string;
	excerpt?: string;
	/** The message is kept in Form messages (the link opens it). */
	kept: boolean;
}

export function webhookPayload(n: Note, format: WebhookFormat): Record<string, unknown> {
	const text = plainText(n);
	if (format === "text") return { text };
	if (format === "discord") {
		const lines = [`**${headline(n, escapeDiscord)}**`, `${n.test ? "Sent" : "Received"}: ${when(n.at)}`];
		if (n.name) lines.push(`From: ${escapeDiscord(n.name)}`);
		if (n.excerpt) lines.push(escapeDiscord(n.excerpt));
		if (!n.kept && !n.test) lines.push("_Emailed to the site's recipients; not kept in Form messages._");
		lines.push(`[${linkLabel(n)}](<${n.link}>)`);
		// No pings: a visitor's "@everyone" stays text.
		return { content: lines.join("\n").slice(0, 2000), allowed_mentions: { parse: [] } };
	}
	const ev: ChatEvent = { event: n.test ? "test" : "form_message", text, ...(n.site ? { site: n.site } : {}), form: { id: n.form, title: n.formTitle }, receivedAt: n.at, link: n.link, content: n.mode, ...(n.name ? { name: n.name } : {}), ...(n.excerpt ? { excerpt: n.excerpt } : {}), kept: n.kept };
	return ev as unknown as Record<string, unknown>;
}

// ── Sending ───────────────────────────────────────────────────────────────────────────────────────────────────────

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
const TIMEOUT_MS = 8000;

/** Send one channel. True when the service accepted it. Never throws, never logs the URL, token or text. */
export async function sendChannel(env: ChatEnv, s: ChatSettings, ch: Channel, n: Note, f: Fetch = (u, i) => fetch(u, i)): Promise<boolean> {
	if (!secretSet(env, ch)) return false;
	let url: string;
	let body: unknown;
	if (ch === "telegram") {
		if (!validChatId(s.telegram.chatId)) return false;
		url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
		body = telegramPayload(n, s.telegram.chatId);
	} else if (ch === "slack") {
		url = env.SLACK_WEBHOOK_URL as string;
		body = slackPayload(n);
	} else {
		url = env.CHAT_WEBHOOK_URL as string;
		body = webhookPayload(n, s.webhook.format);
	}
	try {
		const signal = typeof AbortSignal !== "undefined" && "timeout" in AbortSignal ? AbortSignal.timeout(TIMEOUT_MS) : undefined;
		const res = await f(url, { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: JSON.stringify(body), redirect: "manual", ...(signal ? { signal } : {}) });
		await res.body?.cancel().catch(() => {});
		return res.ok;
	} catch {
		return false;
	}
}

/** Send to every channel; returns those that failed. */
async function sendAll(env: ChatEnv, s: ChatSettings, channels: Channel[], n: Note, f?: Fetch): Promise<Channel[]> {
	const results = await Promise.all(channels.map(async (ch) => [ch, await sendChannel(env, s, ch, n, f)] as const));
	return results.filter(([, ok]) => !ok).map(([ch]) => ch);
}

interface Job {
	note: Note;
	channels: Channel[];
	attempts: number;
}

async function countFailure(kv: KvLike, ch: Channel, now = Date.now()): Promise<void> {
	const key = `${FAIL}${new Date(now).toISOString().slice(0, 10)}:${ch}`;
	const n = Number(await kv.get(key)) || 0;
	await kv.put(key, String(n + 1), { expirationTtl: 30 * DAY });
}

/** A failed channel: kept for the cron to retry, or — after the last attempt — counted and dropped. */
async function keepForRetry(kv: KvLike, job: Job): Promise<void> {
	if (job.attempts >= MAX_ATTEMPTS) {
		for (const ch of job.channels) await countFailure(kv, ch);
		return;
	}
	const at = new Date().toISOString();
	await kv.put(`${JOB}${at}:${crypto.randomUUID().slice(0, 8)}`, JSON.stringify(job), { expirationTtl: DAY });
}

export interface NewMessage {
	form: { id: string; title: string; sensitive?: boolean };
	values: { field: { type: string }; value: string }[];
	name?: string;
	at: Date;
	/** The request's origin (the link points at this site's admin). */
	origin: string;
	pluginId: string;
	/** The message's key when it is kept in Form messages. */
	key?: string;
	/** A test message (FORM_LIVE_HOST): never announced. */
	test?: boolean;
}

/**
 * Announce a new form message on the chat channels that are on. Meant for waitUntil: never throws, and the caller has
 * already answered the visitor. Returns the channels tried (for tests and logs).
 */
export async function notifyChat(env: ChatEnv, m: NewMessage, f?: Fetch): Promise<{ sent: Channel[]; failed: Channel[] }> {
	try {
		if (!chatEnabled(env) || !env.FORM_OUTBOX || m.test) return { sent: [], failed: [] };
		const s = await readChatSettings(env);
		const channels = channelsFor(s, env, m.form.id, m);
		if (!channels.length) return { sent: [], failed: [] };
		const note = buildNote({ form: m.form, values: m.values, ...(m.name ? { name: m.name } : {}), at: m.at, link: inboxLink(m.origin, m.pluginId, m.key), kept: !!m.key, site: new URL(m.origin).host }, s, env);
		const failed = await sendAll(env, s, channels, note, f);
		if (failed.length) await keepForRetry(env.FORM_OUTBOX, { note, channels: failed, attempts: 1 }).catch(() => {});
		const sent = channels.filter((c) => !failed.includes(c));
		console.log(JSON.stringify({ form: m.form.id, chat: { sent, ...(failed.length ? { retry: failed } : {}) } }));
		return { sent, failed };
	} catch {
		return { sent: [], failed: [] };
	}
}

/**
 * Cron: retry the notifications that failed. A channel turned off (or whose secret was removed) since is dropped; the
 * current content setting applies (notification only drops the name and excerpt). Counts only in the log.
 */
export async function flushChat(env: ChatEnv, f?: Fetch): Promise<{ sent: number; retry: number; dropped: number }> {
	const kv = env.FORM_OUTBOX;
	if (!kv) return { sent: 0, retry: 0, dropped: 0 };
	const keys: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await kv.list({ prefix: JOB, limit: 1000, ...(cursor ? { cursor } : {}) });
		keys.push(...page.keys.map((k) => k.name).filter((k) => JOB_KEY.test(k)));
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	if (!keys.length) return { sent: 0, retry: 0, dropped: 0 };
	const s = await readChatSettings(env);
	let sent = 0;
	let retry = 0;
	let dropped = 0;
	for (const key of keys) {
		const raw = await kv.get(key);
		await kv.delete(key);
		if (!raw) continue;
		let job: Job;
		try {
			job = JSON.parse(raw) as Job;
		} catch {
			continue;
		}
		const live = chatEnabled(env) ? channelsFor(s, env, job.note.form) : [];
		const channels = (job.channels ?? []).filter((c) => live.includes(c));
		dropped += (job.channels ?? []).length - channels.length;
		if (!channels.length) continue;
		const note = restrict(job.note, contentMode(s, siteSensitive(env) || job.note.mode === "notice"));
		const failed = await sendAll(env, s, channels, note, f);
		sent += channels.length - failed.length;
		if (failed.length) {
			retry += failed.length;
			await keepForRetry(kv, { note, channels: failed, attempts: (job.attempts ?? 1) + 1 });
		}
	}
	if (sent || retry || dropped) console.log(JSON.stringify({ chat: { sent, retry, ...(dropped ? { dropped } : {}) } }));
	return { sent, retry, dropped };
}

/** Notifications given up on (after every retry), per channel, since `sinceDay` (YYYY-MM-DD). */
export async function readChatFailures(env: ChatEnv, sinceDay: string): Promise<Record<Channel, number>> {
	const out: Record<Channel, number> = { telegram: 0, slack: 0, webhook: 0 };
	const kv = env.FORM_OUTBOX;
	if (!kv) return out;
	let cursor: string | undefined;
	do {
		const page = await kv.list({ prefix: FAIL, limit: 1000, ...(cursor ? { cursor } : {}) });
		for (const { name } of page.keys) {
			const m = /^chatfail:(\d{4}-\d{2}-\d{2}):(telegram|slack|webhook)$/.exec(name);
			if (!m || (m[1] as string) < sinceDay) continue;
			out[m[2] as Channel] += Number(await kv.get(name)) || 0;
		}
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	return out;
}

/**
 * The admin's "Send a test notification": to every channel that is on and ready, at most once a minute per site. A
 * test carries no visitor data.
 */
export async function sendTestNotification(env: ChatEnv, o: { origin: string; pluginId: string; now?: number }, f?: Fetch): Promise<{ result: "sent"; sent: Channel[]; failed: Channel[] } | { result: "limited"; seconds: number } | { result: "none" }> {
	const kv = env.FORM_OUTBOX;
	const s = await readChatSettings(env);
	const channels = kv && chatEnabled(env) ? CHANNELS.filter((ch) => s[ch].on && secretSet(env, ch) && (ch !== "telegram" || validChatId(s.telegram.chatId))) : [];
	if (!kv || !channels.length) return { result: "none" };
	const now = o.now ?? Date.now();
	const last = Date.parse((await kv.get(TEST_KEY).catch(() => null)) ?? "");
	if (!Number.isNaN(last) && now - last < TEST_EVERY_SECONDS * 1000) return { result: "limited", seconds: Math.ceil((TEST_EVERY_SECONDS * 1000 - (now - last)) / 1000) };
	await kv.put(TEST_KEY, new Date(now).toISOString(), { expirationTtl: TEST_EVERY_SECONDS });
	const note: Note = { form: "test", formTitle: "Test", at: new Date(now).toISOString(), link: inboxLink(o.origin, o.pluginId), kept: false, mode: "notice", test: true, site: new URL(o.origin).host };
	const failed = await sendAll(env, s, channels, note, f);
	return { result: "sent", sent: channels.filter((c) => !failed.includes(c)), failed };
}
