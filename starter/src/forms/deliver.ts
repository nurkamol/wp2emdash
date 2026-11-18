/**
 * Email delivery for form submissions, over the provider's HTTP API (raw SMTP is not available from Workers).
 * Brevo is the default; the provider is chosen per site (EMAIL_PROVIDER). Field values are only ever placed in
 * the message body — never logged.
 */
export interface Message {
	from: { email: string; name?: string };
	to: string[];
	replyTo?: { email: string; name?: string };
	subject: string;
	text: string;
	html: string;
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
		body: JSON.stringify({ sender: m.from, to: m.to.map((email) => ({ email })), ...(m.replyTo ? { replyTo: m.replyTo } : {}), subject: m.subject, htmlContent: m.html, textContent: m.text }),
	});
	if (res.status === 201 || res.status === 202) return { ok: true };
	return { ok: false, status: res.status, reason: `brevo HTTP ${res.status}` };
}

export async function deliver(provider: string, apiKey: string, m: Message): Promise<DeliveryResult> {
	switch (provider) {
		case "brevo":
			return brevo(apiKey, m);
		default:
			return { ok: false, status: 501, reason: `email provider "${provider}" not implemented in this starter` };
	}
}
