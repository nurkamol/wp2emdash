/**
 * Email delivery for form submissions, over the provider's HTTP API (raw SMTP is not available from Workers).
 * Brevo is the default; the provider is chosen per site (EMAIL_PROVIDER). Field values are only ever placed in
 * the message body — never logged.
 *
 * Attachments (a signed form's `signature.png`) go in each provider's own attachment field, base64 content:
 * Brevo `attachment[{ name, content }]`, Resend `attachments[{ filename, content }]`, Postmark
 * `Attachments[{ Name, Content, ContentType }]`, SendGrid `attachments[{ content, filename, type, disposition }]`,
 * Mailgun multipart `attachment` file parts. (Checked against each provider's API reference, 2026-11-19.)
 */
import type { Attachment } from "./signature.js";

export type { Attachment };

export interface Message {
	from: { email: string; name?: string };
	to: string[];
	replyTo?: { email: string; name?: string };
	subject: string;
	text: string;
	html: string;
	attachments?: Attachment[];
}

export type DeliveryResult = { ok: true } | { ok: false; status: number; reason: string };

/** "Website <noreply@client.com>" or "noreply@client.com" → { email, name }. */
export function parseAddress(value: string | undefined): { email: string; name?: string } | undefined {
	const v = (value ?? "").trim();
	const m = /^(.*)<([^<>\s]+@[^<>\s]+)>$/.exec(v);
	if (m) return { email: (m[2] as string).trim(), ...(m[1]?.trim() ? { name: m[1].trim().replace(/^"|"$/g, "") } : {}) };
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? { email: v } : undefined;
}

async function brevo(apiKey: string, m: Message): Promise<DeliveryResult> {
	// POST /v3/smtp/email, api-key header, 201 { messageId } (developers.brevo.com/reference/sendtransacemail).
	const res = await fetch("https://api.brevo.com/v3/smtp/email", {
		method: "POST",
		headers: { "api-key": apiKey, "content-type": "application/json", accept: "application/json" },
		body: JSON.stringify({ sender: m.from, to: m.to.map((email) => ({ email })), ...(m.replyTo ? { replyTo: m.replyTo } : {}), subject: m.subject, htmlContent: m.html, textContent: m.text, ...(m.attachments?.length ? { attachment: m.attachments.map((a) => ({ name: a.filename, content: a.content })) } : {}) }),
	});
	if (res.status === 201 || res.status === 202) return { ok: true };
	return { ok: false, status: res.status, reason: `brevo HTTP ${res.status}` };
}

const named = (a: { email: string; name?: string }) => (a.name ? `${a.name.replace(/[<>"]/g, "")} <${a.email}>` : a.email);
const result = (name: string, res: Response, okStatuses: number[]): DeliveryResult => (okStatuses.includes(res.status) ? { ok: true } : { ok: false, status: res.status, reason: `${name} HTTP ${res.status}` });

async function resend(apiKey: string, m: Message): Promise<DeliveryResult> {
	// POST /emails, Bearer key → 200 { id } (resend.com/docs/api-reference/emails/send-email).
	const res = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
		body: JSON.stringify({ from: named(m.from), to: m.to, ...(m.replyTo ? { reply_to: named(m.replyTo) } : {}), subject: m.subject, html: m.html, text: m.text, ...(m.attachments?.length ? { attachments: m.attachments.map((a) => ({ filename: a.filename, content: a.content })) } : {}) }),
	});
	return result("resend", res, [200]);
}

async function postmark(apiKey: string, m: Message): Promise<DeliveryResult> {
	// POST /email, X-Postmark-Server-Token → 200 (postmarkapp.com/developer/api/email-api).
	const res = await fetch("https://api.postmarkapp.com/email", {
		method: "POST",
		headers: { "x-postmark-server-token": apiKey, "content-type": "application/json", accept: "application/json" },
		body: JSON.stringify({ From: named(m.from), To: m.to.join(","), ...(m.replyTo ? { ReplyTo: named(m.replyTo) } : {}), Subject: m.subject, HtmlBody: m.html, TextBody: m.text, MessageStream: "outbound", ...(m.attachments?.length ? { Attachments: m.attachments.map((a) => ({ Name: a.filename, Content: a.content, ContentType: a.contentType })) } : {}) }),
	});
	return result("postmark", res, [200]);
}

async function sendgrid(apiKey: string, m: Message): Promise<DeliveryResult> {
	// POST /v3/mail/send, Bearer key → 202 (docs.sendgrid.com/api-reference/mail-send).
	const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
		method: "POST",
		headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
		body: JSON.stringify({ personalizations: [{ to: m.to.map((email) => ({ email })) }], from: m.from, ...(m.replyTo ? { reply_to: m.replyTo } : {}), subject: m.subject, content: [{ type: "text/plain", value: m.text }, { type: "text/html", value: m.html }], ...(m.attachments?.length ? { attachments: m.attachments.map((a) => ({ content: a.content, filename: a.filename, type: a.contentType, disposition: "attachment" })) } : {}) }),
	});
	return result("sendgrid", res, [202]);
}

async function mailgun(apiKey: string, m: Message, region?: string): Promise<DeliveryResult> {
	// POST /v3/<sending domain>/messages, basic auth api:<key>, form fields → 200 (documentation.mailgun.com). EU accounts: MAILGUN_REGION=eu.
	const domain = m.from.email.split("@")[1] as string;
	const fields: Record<string, string> = { from: named(m.from), to: m.to.join(","), subject: m.subject, text: m.text, html: m.html, ...(m.replyTo ? { "h:Reply-To": named(m.replyTo) } : {}) };
	let body: URLSearchParams | FormData = new URLSearchParams(fields);
	if (m.attachments?.length) {
		// Attachments need multipart/form-data: one `attachment` file part each.
		const form = new FormData();
		for (const [k, v] of Object.entries(fields)) form.append(k, v);
		for (const a of m.attachments) form.append("attachment", new Blob([Uint8Array.from(atob(a.content), (c) => c.charCodeAt(0))], { type: a.contentType }), a.filename);
		body = form;
	}
	const res = await fetch(`https://api${region === "eu" ? ".eu" : ""}.mailgun.net/v3/${encodeURIComponent(domain)}/messages`, { method: "POST", headers: { authorization: `Basic ${btoa(`api:${apiKey}`)}` }, body });
	return result("mailgun", res, [200]);
}

export async function deliver(provider: string, apiKey: string, m: Message, opts: { region?: string } = {}): Promise<DeliveryResult> {
	switch (provider) {
		case "brevo":
			return brevo(apiKey, m);
		case "resend":
			return resend(apiKey, m);
		case "postmark":
			return postmark(apiKey, m);
		case "sendgrid":
			return sendgrid(apiKey, m);
		case "mailgun":
			return mailgun(apiKey, m, opts.region);
		default:
			return { ok: false, status: 501, reason: `email provider "${provider}" not implemented in this starter` };
	}
}
