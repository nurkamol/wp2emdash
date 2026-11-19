/**
 * Form submissions endpoint. A site serves it from an Astro route, e.g. `src/pages/api/forms/[id].ts`:
 *
 *   import { createFormEndpoint } from "@wp2emdash/forms/endpoint";
 *   import { getForm } from "../../../forms";
 *   export const prerender = false;
 *   export const POST = createFormEndpoint({ getForm });
 *
 *
 * Order: known form → honeypot → rate limit → Turnstile (fails closed) → validation against the form
 * definition (only its fields are read; anything else in the request is ignored) → email to the recipients (set by an
 * admin on the Form messages page, else FORM_TO) through the site's provider: an API key from Wrangler secrets (Brevo,
 * Resend, Postmark, SendGrid or Mailgun), or EMAIL_PROVIDER=emdash for EmDash's own pipeline (Settings → Email, reached
 * through `withEmDashRuntime`; see emdash-email.ts). Nothing is stored unless the owner enabled the outbox (then only
 * until it is emailed or the retention period ends — or, with keep sent (FORM_OUTBOX_KEEP_SENT="1"), every message,
 * marked emailed once delivered, until the retention period ends); with the outbox, a count per day and form is kept
 * for the admin's charts.
 * Field values never reach logs — signatures included: a drawn signature (checked PNG) is emailed as an attachment
 * (inline for EMAIL_PROVIDER=emdash), and the email records the submission time and the exact text the visitor was
 * shown (terms, consent) with its SHA-256 (buildEmail). A form generated for a site with
 * sensitive data only has the fields the owner approved (e.g. contact details), so that is all this can send.
 */
import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { deliver, parseAddress } from "./deliver.js";
import { sendViaEmDash } from "./emdash-email.js";
import { countMessage, emailConfigured, enqueue, keepsSent, type OutboxEnv, resolveRecipients, usesEmDashEmail } from "./outbox.js";
import { contentToHtml, contentToText, partsToHtml, partsToText } from "./rich.js";
import { type Attachment, checkSignaturePng, checkTypedSignature, typedName } from "./signature.js";
import type { FormDefinition, FormField } from "./types.js";

interface Env extends OutboxEnv {
	EMAIL_PROVIDER?: string;
	EMAIL_API_KEY?: string;
	MAILGUN_REGION?: string;
	FORM_FROM?: string;
	FORM_TO?: string;
	TURNSTILE_SECRET_KEY?: string;
	FORM_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
}

const MAX: Record<FormField["type"], number> = { text: 200, email: 254, tel: 40, number: 40, url: 500, date: 40, select: 500, radio: 500, checkbox: 10, consent: 10, textarea: 5000, signature: 200, content: 0 };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TEL = /^[+()\-.\s\d]{5,40}$/;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

function reply(request: Request, status: number, body: { ok: boolean; message: string; errors?: Record<string, string> }): Response {
	// Without JavaScript the browser posted the form itself: send it back to the page.
	if (!(request.headers.get("accept") ?? "").includes("application/json")) {
		const back = request.headers.get("referer");
		if (back) {
			const url = new URL(back);
			url.searchParams.set("form", body.ok ? "sent" : "error");
			return Response.redirect(url.toString(), 303);
		}
	}
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

async function turnstileOk(secret: string, token: string, ip: string | null): Promise<boolean> {
	if (!token || token.length > 2048) return false;
	const body = new URLSearchParams({ secret, response: token, ...(ip ? { remoteip: ip } : {}) });
	const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
	const out = (await res.json().catch(() => ({}))) as { success?: boolean };
	return out.success === true;
}

export interface FormEndpointOptions {
	/** Look up a form by the id in the URL (`/api/forms/<id>`); unknown ids answer 404. */
	getForm(id: string | undefined): FormDefinition | undefined;
}

export const createFormEndpoint = ({ getForm }: FormEndpointOptions): APIRoute => async ({ params, request }) => {
	const e = env as unknown as Env;
	const form = getForm(params.id);
	if (!form) return reply(request, 404, { ok: false, message: "This form does not exist." });
	let data: FormData;
	try {
		data = await request.formData();
	} catch {
		return reply(request, 400, { ok: false, message: "The form could not be read. Please try again." });
	}
	const fail = (status: number, message: string, reason: string, errors?: Record<string, string>) => {
		console.log(JSON.stringify({ form: form.id, outcome: "rejected", reason }));
		return reply(request, status, { ok: false, message, ...(errors ? { errors } : {}) });
	};

	// Honeypot: bots fill the hidden field; answer as if sent so they learn nothing.
	if (String(data.get("_hp") ?? "")) return reply(request, 200, { ok: true, message: form.successMessage });

	const ip = request.headers.get("cf-connecting-ip");
	if (e.FORM_LIMITER) {
		const { success } = await e.FORM_LIMITER.limit({ key: `${form.id}:${ip ?? "unknown"}` });
		if (!success) return fail(429, "Too many messages in a short time. Please wait a minute and try again.", "rate-limited");
	}

	if (!e.TURNSTILE_SECRET_KEY) return fail(503, "The form is not available right now. Please call or email us instead.", "turnstile not configured");
	if (!(await turnstileOk(e.TURNSTILE_SECRET_KEY, String(data.get("cf-turnstile-response") ?? ""), ip))) return fail(403, "Please confirm you are not a robot and send the form again.", "turnstile failed");

	// Validation: only the definition's fields are read.
	const values: { field: FormField; value: string }[] = [];
	const errors: Record<string, string> = {};
	const attachments: Attachment[] = [];
	for (const field of form.fields) {
		if (field.type === "content") continue; // text shown on the form, not an input
		if (field.type === "signature") {
			// A drawn signature (PNG data URL) or a typed name; never logged, only emailed (and kept by the outbox).
			const drawn = String(data.get(field.name) ?? "");
			const typed = String(data.get(typedName(field.name)) ?? "").trim();
			if (drawn) {
				const sig = checkSignaturePng(drawn);
				if (!sig.ok) {
					errors[field.name] = sig.reason === "too-large" ? `${field.label}: the drawing is too large. Please clear it and sign again.` : `${field.label} could not be read. Please clear it and sign again, or type your full name.`;
					continue;
				}
				const filename = attachments.length ? `signature-${attachments.length + 1}.png` : "signature.png";
				attachments.push({ filename, contentType: "image/png", content: sig.base64 });
				values.push({ field, value: `Signed (drawn signature attached as ${filename})` });
			} else if (typed) {
				if (!checkTypedSignature(typed)) errors[field.name] = `${field.label}: type your full name.`;
				else values.push({ field, value: `Signed by typing their name: ${typed}` });
			} else if (field.required) errors[field.name] = `${field.label} is required. Sign in the box or type your full name.`;
			continue;
		}
		const raw = field.type === "checkbox" || field.type === "consent" ? (data.get(field.name) ? "Yes" : "") : String(data.get(field.name) ?? "").trim();
		if (!raw) {
			if (field.required) errors[field.name] = field.type === "consent" ? `Please accept: ${field.label}.` : `${field.label} is required.`;
			continue;
		}
		if (raw.length > (MAX[field.type] ?? 200)) errors[field.name] = `${field.label} is too long.`;
		else if (field.type === "email" && !EMAIL.test(raw)) errors[field.name] = `${field.label} is not a valid email address.`;
		else if (field.type === "tel" && !TEL.test(raw)) errors[field.name] = `${field.label} is not a valid phone number.`;
		else if ((field.type === "select" || field.type === "radio") && field.options?.length && !field.options.includes(raw)) errors[field.name] = `Choose one of the ${field.label} options.`;
		values.push({ field, value: field.type === "consent" ? `Accepted: “${partsToText(field.labelParts) || field.label}”` : raw });
	}
	if (Object.keys(errors).length) return fail(422, "Please check the highlighted fields.", "invalid", errors);

	const viaEmDash = usesEmDashEmail(e);
	const provider = viaEmDash ? "emdash" : (e.EMAIL_PROVIDER ?? "brevo");
	const { to } = await resolveRecipients(e);
	const emailReady = await emailConfigured(e, to);
	if (!emailReady && !e.FORM_OUTBOX) return fail(503, "The form is not available right now. Please call or email us instead.", "email not configured");

	const replyEmail = values.find((v) => v.field.type === "email")?.value;
	const name = values.filter((v) => /name/i.test(v.field.name) || /name/.test(v.field.autocomplete ?? "")).map((v) => v.value).join(" ");
	const page = request.headers.get("referer") ?? "";
	const { subject, text, html } = await buildEmail(form, values, { page, origin: new URL(request.url).origin, at: new Date(), name });
	const files = attachments.length ? { attachments } : {};
	// Kept for later delivery when email is not set up or the provider refuses (outbox, owner opt-in): the visitor's
	// message is not lost, and the cron emails it once delivery works.
	const record = { form: form.id, ...(replyEmail ? { replyTo: { email: replyEmail, ...(name ? { name } : {}) } } : {}), subject, text, html, ...files };
	// `failed`: the provider refused it (one attempt made), else waiting (not tried: on hold or email not set up).
	const keep = async (reason: string, failed = false) => {
		try {
			if (await enqueue(e, { ...record, ...(failed ? { attempts: 1, status: "failed" as const } : {}) })) {
				console.log(JSON.stringify({ form: form.id, outcome: "queued", reason }));
				await countMessage(e, form.id, "kept").catch(() => {});
				return reply(request, 200, { ok: true, message: form.successMessage });
			}
		} catch (err) {
			return fail(502, "Your message could not be sent. Please call or email us instead.", `outbox: ${(err as Error).name}`);
		}
		return undefined;
	};
	if (e.FORM_OUTBOX_HOLD === "1" && e.FORM_OUTBOX) return (await keep("held")) ?? fail(502, "Your message could not be sent. Please call or email us instead.", "outbox unavailable");
	if (!emailReady) return (await keep("email not configured")) ?? fail(503, "The form is not available right now. Please call or email us instead.", "email not configured");
	// Sender: FORM_FROM for an API provider; EmDash's Settings → Email for the emdash pipeline (it has its own sender).
	const result = viaEmDash
		? await sendViaEmDash(to, { ...(replyEmail ? { replyTo: replyEmail } : {}), subject, text, html, ...files })
		: await deliver(provider, e.EMAIL_API_KEY as string, { from: parseAddress(e.FORM_FROM) as { email: string; name?: string }, to, ...(replyEmail ? { replyTo: { email: replyEmail, ...(name ? { name } : {}) } } : {}), subject, text, html, ...files }, { ...(e.MAILGUN_REGION ? { region: e.MAILGUN_REGION } : {}) });
	if (!result.ok) return (await keep(result.reason, true)) ?? fail(502, "Your message could not be sent. Please call or email us instead.", result.reason);
	// Keep sent (owner opt-in): the emailed message stays in Form messages, marked emailed, until the retention period
	// ends. Best effort — the visitor's message is already delivered, so a KV error does not fail the request.
	let kept = false;
	if (keepsSent(e)) {
		const id = "id" in result && typeof result.id === "string" ? result.id : undefined;
		kept = await enqueue(e, { ...record, status: "emailed", emailedAt: new Date().toISOString(), emailedTo: to, ...(id ? { messageId: id } : {}) }).catch(() => false);
	}
	console.log(JSON.stringify({ form: form.id, outcome: "sent", via: provider, recipients: to.length, ...(keepsSent(e) ? { kept } : {}) }));
	await countMessage(e, form.id, "emailed").catch(() => {});
	return reply(request, 200, { ok: true, message: form.successMessage });
};

/**
 * The email: every answer, when it was submitted, and — for a form with terms, consent or a signature — the exact
 * text the visitor was shown and agreed to, with its SHA-256, so the email is a complete record on its own.
 */
export async function buildEmail(form: FormDefinition, values: { field: FormField; value: string }[], ctx: { page?: string; origin?: string; at: Date; name?: string }): Promise<{ subject: string; text: string; html: string }> {
	const signed = values.some((v) => v.field.type === "signature");
	const subject = signed ? `Signed: ${form.title}${ctx.name ? ` — ${ctx.name}` : ""}` : `New website message${ctx.name ? ` from ${ctx.name}` : ""}`;
	const submitted = `${ctx.at.toISOString().slice(0, 19).replace("T", " ")} UTC`;
	const shown = form.fields.filter((f) => f.type === "content" || f.type === "consent" || f.type === "signature");
	const shownText = shown
		.map((f) => (f.type === "content" ? contentToText(f.content, { links: true }) : f.type === "consent" ? `[${f.required ? "required" : "optional"} checkbox] ${partsToText(f.labelParts, { links: true }) || f.label}` : `[signature] ${f.label}`))
		.filter(Boolean)
		.join("\n");
	const hasRecord = form.fields.some((f) => f.type === "content" || f.type === "consent") || signed;
	const digest = hasRecord ? [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(shownText)))].map((b) => b.toString(16).padStart(2, "0")).join("") : "";
	const text = [
		`Form: ${form.title}`,
		`Submitted: ${submitted}`,
		"",
		...values.map((v) => `${v.field.label}: ${v.value}`),
		...(hasRecord ? ["", "— Text shown on the form —", shownText, `(SHA-256 of the text shown: ${digest})`] : []),
		"",
		ctx.page ? `Sent from ${ctx.page}` : "",
	]
		.join("\n")
		.trim();
	const shownHtml = shown
		.map((f) => (f.type === "content" ? contentToHtml(f.content, ctx.origin) : f.type === "consent" ? `<p>[${f.required ? "required" : "optional"} checkbox] ${partsToHtml(f.labelParts, ctx.origin) || esc(f.label)}</p>` : ""))
		.join("");
	const html = `<p style="font:14px/1.5 sans-serif;margin:0 0 8px"><strong>${esc(form.title)}</strong><br>Submitted ${esc(submitted)}</p><table cellpadding="6" style="border-collapse:collapse;font:14px/1.5 sans-serif">${values.map((v) => `<tr><th align="left" valign="top">${esc(v.field.label)}</th><td>${esc(v.value).replace(/\n/g, "<br>")}</td></tr>`).join("")}</table>${hasRecord ? `<div style="font:13px/1.5 sans-serif;color:#333;border-top:1px solid #ddd;margin-top:16px;padding-top:8px"><p><strong>Text shown on the form</strong></p>${shownHtml}<p style="font-size:12px;color:#666">SHA-256 of the text shown: ${digest}</p></div>` : ""}${ctx.page ? `<p style="font:12px sans-serif;color:#666">Sent from ${esc(ctx.page)}</p>` : ""}`;
	return { subject, text, html };
}
