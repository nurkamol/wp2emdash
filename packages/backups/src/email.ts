/**
 * Failure alerts, sent the way the site's forms and Site health send email (@wp2emdash/forms `deliver`): the provider's
 * HTTP API (EMAIL_PROVIDER + the EMAIL_API_KEY secret, sender FORM_FROM), or with EMAIL_PROVIDER=emdash EmDash's own
 * email settings through the plugin's `ctx.email`. Never from a staging Worker; results carry a reason, never an
 * address or a key.
 */
import { deliver, parseAddress } from "@wp2emdash/forms/deliver";
import { esc } from "./util.js";

export interface MailEnv {
	EMAIL_PROVIDER?: string;
	EMAIL_API_KEY?: string;
	FORM_FROM?: string;
	MAILGUN_REGION?: string;
	STAGING?: string;
}
export interface PluginEmail {
	send(message: { to: string; cc?: string[]; subject: string; text: string; html?: string }): Promise<void>;
}
export interface Mail {
	subject: string;
	text: string;
	html: string;
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
			await (pluginEmail as PluginEmail).send({ to: first, ...(rest.length ? { cc: rest } : {}), subject: m.subject, text: m.text, html: m.html });
			return { ok: true };
		}
		const r = await deliver(env.EMAIL_PROVIDER ?? "brevo", env.EMAIL_API_KEY as string, { from: parseAddress(env.FORM_FROM) as { email: string; name?: string }, to, subject: m.subject, text: m.text, html: m.html }, env.MAILGUN_REGION ? { region: env.MAILGUN_REGION } : {});
		return r.ok ? { ok: true } : { ok: false, reason: r.reason };
	} catch (e) {
		return { ok: false, reason: `email error (${(e as Error)?.name ?? "Error"})` };
	}
}

/** The alert email: plain words, the admin link, the footer. `lines` never hold content or secrets. */
export function alertMail(o: { siteName: string; subject: string; lines: string[]; adminUrl: string; footer: string; recovery?: boolean }): Mail {
	const colour = o.recovery ? "#067647" : "#b42318";
	const text = [...o.lines, "", `Backups: ${o.adminUrl}`, "", o.footer].join("\n");
	const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f4;font:15px/1.5 -apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#1a1a1a"><table role="presentation" width="100%" style="max-width:600px;margin:0 auto;background:#fff;border-radius:8px;border-top:4px solid ${colour}"><tr><td style="padding:24px"><p style="margin:0 0 4px;font-size:13px;color:#667085">${esc(o.siteName)} · Backups</p><h1 style="margin:0 0 16px;font-size:20px;color:${colour}">${esc(o.subject.replace(`${o.siteName}: `, ""))}</h1>${o.lines.map((l) => `<p style="margin:0 0 10px">${esc(l)}</p>`).join("")}<p style="margin:20px 0"><a href="${esc(o.adminUrl)}" style="display:inline-block;padding:10px 16px;background:#1a1a1a;color:#fff;text-decoration:none;border-radius:6px">Open Backups</a></p></td></tr><tr><td style="padding:12px 24px;border-top:1px solid #eee;font-size:12px;color:#667085">${esc(o.footer)}</td></tr></table></body></html>`;
	return { subject: o.subject, text, html };
}
