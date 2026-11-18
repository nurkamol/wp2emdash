/**
 * Form submissions: POST /api/forms/<form id>.
 *
 * Order: known form → honeypot → rate limit → Turnstile (fails closed) → validation against the form
 * definition (only its fields are read; anything else in the request is ignored) → email through the
 * site's provider. Nothing is stored. Field values never reach logs. A form generated for a site with
 * sensitive data only has the fields the owner approved (e.g. contact details), so that is all this can send.
 */
import { env } from "cloudflare:workers";
import type { APIRoute } from "astro";
import { deliver, parseAddress } from "../../../forms/deliver";
import { getForm, type FormField } from "../../../forms/index";

export const prerender = false;

interface Env {
	EMAIL_PROVIDER?: string;
	EMAIL_API_KEY?: string;
	FORM_FROM?: string;
	FORM_TO?: string;
	TURNSTILE_SECRET_KEY?: string;
	FORM_LIMITER?: { limit(o: { key: string }): Promise<{ success: boolean }> };
}

const MAX: Record<FormField["type"], number> = { text: 200, email: 254, tel: 40, number: 40, url: 500, date: 40, select: 200, checkbox: 10, textarea: 5000 };
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

export const POST: APIRoute = async ({ params, request }) => {
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
	for (const field of form.fields) {
		const raw = field.type === "checkbox" ? (data.get(field.name) ? "Yes" : "") : String(data.get(field.name) ?? "").trim();
		if (!raw) {
			if (field.required) errors[field.name] = `${field.label} is required.`;
			continue;
		}
		if (raw.length > (MAX[field.type] ?? 200)) errors[field.name] = `${field.label} is too long.`;
		else if (field.type === "email" && !EMAIL.test(raw)) errors[field.name] = `${field.label} is not a valid email address.`;
		else if (field.type === "tel" && !TEL.test(raw)) errors[field.name] = `${field.label} is not a valid phone number.`;
		else if (field.type === "select" && field.options?.length && !field.options.includes(raw)) errors[field.name] = `Choose one of the ${field.label} options.`;
		values.push({ field, value: raw });
	}
	if (Object.keys(errors).length) return fail(422, "Please check the highlighted fields.", "invalid", errors);

	const from = parseAddress(e.FORM_FROM);
	const to = (e.FORM_TO ?? "").split(",").map((x) => x.trim()).filter((x) => EMAIL.test(x));
	if (!e.EMAIL_API_KEY || !from || !to.length) return fail(503, "The form is not available right now. Please call or email us instead.", "email not configured");

	const replyEmail = values.find((v) => v.field.type === "email")?.value;
	const name = values.filter((v) => /name/i.test(v.field.name) || /name/.test(v.field.autocomplete ?? "")).map((v) => v.value).join(" ");
	const page = request.headers.get("referer") ?? "";
	const result = await deliver(e.EMAIL_PROVIDER ?? "brevo", e.EMAIL_API_KEY, {
		from,
		to,
		...(replyEmail ? { replyTo: { email: replyEmail, ...(name ? { name } : {}) } } : {}),
		subject: `New website message${name ? ` from ${name}` : ""} — ${form.title}`,
		text: [...values.map((v) => `${v.field.label}: ${v.value}`), "", page ? `Sent from ${page}` : ""].join("\n").trim(),
		html: `<table cellpadding="6" style="border-collapse:collapse;font:14px/1.5 sans-serif">${values.map((v) => `<tr><th align="left" valign="top">${esc(v.field.label)}</th><td>${esc(v.value).replace(/\n/g, "<br>")}</td></tr>`).join("")}</table>${page ? `<p style="font:12px sans-serif;color:#666">Sent from ${esc(page)}</p>` : ""}`,
	});
	if (!result.ok) return fail(502, "Your message could not be sent. Please call or email us instead.", result.reason);
	console.log(JSON.stringify({ form: form.id, outcome: "sent" }));
	return reply(request, 200, { ok: true, message: form.successMessage });
};
