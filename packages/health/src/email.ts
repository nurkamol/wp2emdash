/**
 * Sending alerts and reports the way the site's forms send email (@wp2emdash/forms): the provider's HTTP API
 * (EMAIL_PROVIDER + the EMAIL_API_KEY secret, sender FORM_FROM) through that package's `deliver`, or — with
 * EMAIL_PROVIDER=emdash — EmDash's own email pipeline (Settings → Email), here the plugin's `ctx.email` (capability
 * `email:send`; undefined while EmDash has no email provider). Nothing here logs addresses or content: the result is
 * ok, or a short reason without either.
 */
import { deliver, parseAddress } from "@wp2emdash/forms/deliver";
import type { Mail } from "./alerts.js";

export interface MailEnv {
	EMAIL_PROVIDER?: string;
	EMAIL_API_KEY?: string;
	FORM_FROM?: string;
	MAILGUN_REGION?: string;
	/** Opt-in staging Worker: never emails anyone. */
	STAGING?: string;
}

/** EmDash's EmailAccess (ctx.email). */
export interface PluginEmail {
	send(message: { to: string; cc?: string[]; subject: string; text: string; html?: string }): Promise<void>;
}

export type SendResult = { ok: true } | { ok: false; reason: string };

/** Whether this site can send email at all right now, and why not. */
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
