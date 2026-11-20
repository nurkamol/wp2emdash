/**
 * Notifications: emails (the way the site's forms, Site health and Backups send them — @wp2emdash/forms `deliver`
 * over the provider's HTTP API with EMAIL_PROVIDER / EMAIL_API_KEY / FORM_FROM, or with EMAIL_PROVIDER=emdash EmDash's
 * own email settings through the plugin's `ctx.email`) and the optional webhook to the agency's tracker.
 *
 * What a message holds: the request itself (number, title, description, page, section, priority, status, the
 * comment that came with the change) and a link to it in the admin. Never other requests, never the site's form
 * messages, never attachment contents or links (downloads need a signed-in editor). Never from a staging Worker.
 * Results carry a reason, never an address, a key or content.
 */
import { deliver, parseAddress } from "@wp2emdash/forms/deliver";
import { CONTACT_LABEL, type ChangeRequest, STATUS_LABEL, type Status } from "./model.js";

export interface MailEnv {
	EMAIL_PROVIDER?: string;
	EMAIL_API_KEY?: string;
	FORM_FROM?: string;
	MAILGUN_REGION?: string;
	STAGING?: string;
}
export interface PluginEmail {
	send(message: { to: string; cc?: string[]; replyTo?: string; subject: string; text: string; html?: string }): Promise<void>;
}
export interface Mail {
	subject: string;
	text: string;
	html: string;
	replyTo?: string;
}
export type SendResult = { ok: true } | { ok: false; reason: string };

export function mailReady(env: MailEnv, pluginEmail: PluginEmail | undefined): SendResult {
	if (env.STAGING === "1") return { ok: false, reason: "staging never emails" };
	if (env.EMAIL_PROVIDER === "emdash") return pluginEmail ? { ok: true } : { ok: false, reason: "EmDash email is not set up (Settings → Email)" };
	if (!env.EMAIL_API_KEY) return { ok: false, reason: "the email key (EMAIL_API_KEY) is not set" };
	if (!parseAddress(env.FORM_FROM)) return { ok: false, reason: "no sender address (FORM_FROM)" };
	return { ok: true };
}

export async function sendMail(env: MailEnv, pluginEmail: PluginEmail | undefined, to: string[], m: Mail): Promise<SendResult> {
	const ready = mailReady(env, pluginEmail);
	if (!ready.ok) return ready;
	const [first, ...rest] = to;
	if (!first) return { ok: false, reason: "no recipients" };
	try {
		if (env.EMAIL_PROVIDER === "emdash") {
			await (pluginEmail as PluginEmail).send({ to: first, ...(rest.length ? { cc: rest } : {}), ...(m.replyTo ? { replyTo: m.replyTo } : {}), subject: m.subject, text: m.text, html: m.html });
			return { ok: true };
		}
		const r = await deliver(env.EMAIL_PROVIDER ?? "brevo", env.EMAIL_API_KEY as string, { from: parseAddress(env.FORM_FROM) as { email: string; name?: string }, to, ...(m.replyTo ? { replyTo: { email: m.replyTo } } : {}), subject: m.subject, text: m.text, html: m.html }, env.MAILGUN_REGION ? { region: env.MAILGUN_REGION } : {});
		return r.ok ? { ok: true } : { ok: false, reason: r.reason };
	} catch (e) {
		return { ok: false, reason: `email error (${(e as Error)?.name ?? "Error"})` };
	}
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const where = (r: ChangeRequest) => `${r.page ? r.page.title : "Anywhere on the site"}${r.section ? ` — ${r.section}` : ""}`;

function layout(o: { siteName: string; heading: string; rows: [string, string][]; body?: string; quote?: { by: string; text: string }; link: string; button: string; footer: string; accent: string }): string {
	const rows = o.rows.map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#667085;white-space:nowrap;vertical-align:top">${esc(k)}</td><td style="padding:4px 0">${esc(v)}</td></tr>`).join("");
	const para = (s: string) => esc(s).replace(/\n/g, "<br>");
	return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f4;font:15px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a"><table role="presentation" width="100%" style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;border-top:4px solid ${o.accent}"><tr><td style="padding:24px"><p style="margin:0 0 4px;font-size:13px;color:#667085">${esc(o.siteName)} · Change requests</p><h1 style="margin:0 0 16px;font-size:20px">${esc(o.heading)}</h1><table role="presentation" style="font-size:14px;margin:0 0 16px">${rows}</table>${o.body ? `<p style="margin:0 0 16px;padding:12px;background:#f6f6f4;border-radius:6px">${para(o.body)}</p>` : ""}${o.quote ? `<p style="margin:0 0 4px;font-size:13px;color:#667085">${esc(o.quote.by)} wrote:</p><p style="margin:0 0 16px;padding:12px;border-left:3px solid ${o.accent}">${para(o.quote.text)}</p>` : ""}<p style="margin:20px 0"><a href="${esc(o.link)}" style="display:inline-block;padding:10px 16px;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:6px">${esc(o.button)}</a></p></td></tr><tr><td style="padding:12px 24px;border-top:1px solid #eee;font-size:12px;color:#667085">${esc(o.footer)}</td></tr></table></body></html>`;
}

/** To the agency: a new (or reopened) request. Reply-to is the requester when they asked to be emailed. */
export function newRequestMail(r: ChangeRequest, o: { siteName: string; link: string; footer: string; reopened?: boolean }): Mail {
	const head = `${r.priority === "urgent" ? "URGENT · " : ""}#${r.number} ${r.title}`;
	const rows: [string, string][] = [
		["Where", where(r)],
		["Priority", r.priority === "urgent" ? "Urgent" : "Normal"],
		["From", r.requester.name],
		["Contact", CONTACT_LABEL[r.contact]],
	];
	const text = [`${o.reopened ? "Reopened" : "New"} change request on ${o.siteName}: #${r.number} ${r.title}`, "", ...rows.map(([k, v]) => `${k}: ${v}`), "", r.description, "", `Open it in the admin: ${o.link}`, "(Files the client attaches are in the admin, never in this email.)", "", o.footer].join("\n");
	return {
		subject: `${o.siteName}: ${o.reopened ? "reopened" : "new"} change request ${head}`,
		text,
		html: layout({ siteName: o.siteName, heading: `${o.reopened ? "Reopened" : "New"} request ${head}`, rows, body: r.description, link: o.link, button: "Open the request", footer: o.footer, accent: r.priority === "urgent" ? "#b42318" : "#1a1a1a" }),
		...(r.contact === "email" && r.requester.email ? { replyTo: r.requester.email } : {}),
	};
}

/** To the requester: their request's status changed (with the note that came with it). */
export function statusMail(r: ChangeRequest, o: { siteName: string; link: string; footer: string; from: Status; by: string; note?: string }): Mail {
	const rows: [string, string][] = [
		["Status", `${STATUS_LABEL[o.from]} → ${STATUS_LABEL[r.status]}`],
		["Where", where(r)],
	];
	const ask = r.status === "waiting" ? "We need something from you to continue — see the request." : r.status === "done" ? "If something is not right, reopen it within 30 days from the request page." : "";
	const text = [`Your change request #${r.number} "${r.title}" is now: ${STATUS_LABEL[r.status]}.`, ...(ask ? ["", ask] : []), ...(o.note ? ["", `${o.by} wrote:`, o.note] : []), "", `Open it: ${o.link}`, "", "You get these emails because you asked for updates on this request; switch them off on the request page.", o.footer].join("\n");
	return { subject: `${o.siteName}: #${r.number} ${r.title} — ${STATUS_LABEL[r.status]}`, text, html: layout({ siteName: o.siteName, heading: `#${r.number} ${r.title}: ${STATUS_LABEL[r.status]}`, rows, ...(ask ? { body: ask } : {}), ...(o.note ? { quote: { by: o.by, text: o.note } } : {}), link: o.link, button: "Open the request", footer: `${o.footer} · You asked for updates on this request; switch them off on the request page.`, accent: r.status === "done" ? "#067647" : r.status === "waiting" ? "#b54708" : "#1a1a1a" }) };
}

/** A comment: to the requester (agency replied) or to the agency (the client side wrote). */
export function commentMail(r: ChangeRequest, o: { siteName: string; link: string; footer: string; by: string; text: string; toAgency: boolean }): Mail {
	const rows: [string, string][] = [
		["Request", `#${r.number} ${r.title}`],
		["Status", STATUS_LABEL[r.status]],
	];
	const intro = o.toAgency ? `${o.by} commented on change request #${r.number} "${r.title}".` : `${o.by} replied to your change request #${r.number} "${r.title}".`;
	const text = [intro, "", o.text, "", `Open it: ${o.link}`, "", o.footer].join("\n");
	return { subject: `${o.siteName}: ${o.toAgency ? "comment on" : "reply to"} #${r.number} ${r.title}`, text, html: layout({ siteName: o.siteName, heading: intro, rows, quote: { by: o.by, text: o.text }, link: o.link, button: "Open the request", footer: o.footer, accent: "#1a1a1a" }), ...(o.toAgency && r.contact === "email" && r.requester.email ? { replyTo: r.requester.email } : {}) };
}

// ── Webhook ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type WebhookEvent = "request.created" | "request.reopened" | "request.status_changed" | "request.commented";

/**
 * The webhook body (documented in README.md → Webhook). The request itself, its admin link and what happened —
 * requester by name only (no email address), attachments by name, type and size only.
 */
export function webhookPayload(event: WebhookEvent, r: ChangeRequest, o: { siteName: string; siteUrl: string; link: string; at: string; by: string; agency: boolean; from?: Status; comment?: string }) {
	return {
		event,
		at: o.at,
		site: { name: o.siteName, url: o.siteUrl },
		request: {
			id: r.id,
			number: r.number,
			title: r.title,
			description: r.description,
			status: r.status,
			statusLabel: STATUS_LABEL[r.status],
			priority: r.priority,
			page: r.page ? { title: r.page.title, collection: r.page.collection, id: r.page.id } : null,
			section: r.section ?? null,
			requester: { name: r.requester.name },
			contact: r.contact,
			createdAt: r.createdAt,
			updatedAt: r.updatedAt,
			attachments: r.attachments.map((a) => ({ name: a.name, type: a.type, size: a.size })),
			url: o.link,
		},
		change: { by: o.by, agency: o.agency, ...(o.from ? { from: o.from, to: r.status } : {}), ...(o.comment ? { comment: o.comment } : {}) },
	};
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

/** HMAC-SHA256 of `<timestamp>.<body>` with the Worker secret, hex — the `X-Change-Request-Signature: sha256=<hex>` header. */
export async function signWebhook(secret: string, timestamp: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	return hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`)));
}

export type WebhookReady = { ok: true; url: string; secret: string } | { ok: false; reason: string };

export function webhookReady(url: string | undefined, env: { STAGING?: string; [k: string]: unknown }, secretName: string): WebhookReady {
	if (!url) return { ok: false, reason: "not configured" };
	if (env.STAGING === "1") return { ok: false, reason: "staging never calls the webhook" };
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return { ok: false, reason: "the webhook address is not a URL" };
	}
	if (u.protocol !== "https:") return { ok: false, reason: "the webhook address must be https" };
	const secret = env[secretName];
	if (typeof secret !== "string" || secret.trim().length < 16) return { ok: false, reason: `the Worker secret ${secretName} is not set (at least 16 characters); nothing is sent unsigned` };
	return { ok: true, url: u.toString(), secret: secret.trim() };
}

export async function sendWebhook(ready: Extract<WebhookReady, { ok: true }>, payload: unknown, o: { fetch: (url: string, init: RequestInit) => Promise<Response>; now?: number }): Promise<SendResult> {
	const body = JSON.stringify(payload);
	const timestamp = String(Math.floor((o.now ?? Date.now()) / 1000));
	try {
		const signature = await signWebhook(ready.secret, timestamp, body);
		const res = await o.fetch(ready.url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "wp2emdash-change-requests/0.1", "x-change-request-timestamp": timestamp, "x-change-request-signature": `sha256=${signature}` }, body, signal: AbortSignal.timeout(8000) });
		return res.ok ? { ok: true } : { ok: false, reason: `webhook HTTP ${res.status}` };
	} catch (e) {
		return { ok: false, reason: `webhook error (${(e as Error)?.name ?? "Error"})` };
	}
}
