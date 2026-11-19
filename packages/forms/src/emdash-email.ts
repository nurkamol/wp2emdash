/**
 * Delivery through EmDash's own email pipeline (EMAIL_PROVIDER=emdash): the provider the admin picked in
 * Settings → Email (built-in SMTP, `EMAIL_SMTP_*` vars, or an email provider plugin), with its sender address.
 *
 * EmDash 1.5 gives plugins `ctx.email` (capability `email:send`) and gives `locals.emdash.email` only to EmDash's own
 * routes and signed-in requests — an anonymous POST to a site route gets neither. Site code reaches the same pipeline
 * through `withEmDashRuntime()` from `emdash/middleware` (server-only, trusted: the documented way for endpoints, cron
 * and queue handlers; EmDash's AI Search endpoint does the same). It works with and without a request, so the form
 * endpoint and the outbox cron share it. Verified against emdash 1.5.0 — see the kit's docs/spikes/M7-findings.md.
 *
 * The message goes to `pipeline.send(message, source)`: email:beforeSend hooks, then the one selected email:deliver
 * provider, then email:afterSend hooks. Nothing here logs the message.
 */
import { FORMS_PLUGIN } from "./meta.js";
import { type Attachment, attachmentDataUrl } from "./signature.js";

/** For a pipeline without attachments: PNG attachments become images in the HTML part (only checked PNGs). */
export function inlineAttachments(m: { text: string; html: string; attachments?: Attachment[] }): { text: string; html: string } {
	const images = (m.attachments ?? []).map((a) => ({ a, url: attachmentDataUrl(a) })).filter((x): x is { a: Attachment; url: string } => !!x.url);
	if (!images.length) return { text: m.text, html: m.html };
	const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
	return {
		text: `${m.text}\n\n(${images.map((x) => x.a.filename).join(", ")}: shown as an image in the HTML version of this email.)`,
		html: `${m.html}${images.map((x) => `<p style="font:14px sans-serif"><strong>${esc(x.a.filename)}</strong><br><img src="${x.url}" alt="Signature" style="max-width:100%;border:1px solid #ddd;background:#fff"></p>`).join("")}`,
	};
}

/** EmDash's EmailMessage: one `to`, the rest as `cc`; reply-to is a bare address. */
export interface EmDashMessage {
	to: string;
	cc?: string[];
	replyTo?: string;
	subject: string;
	text: string;
	html?: string;
}

/** The part of EmDash's EmailPipeline this uses (runtime.email; null when EmDash has no pipeline). */
export interface EmDashPipeline {
	isAvailable(): boolean;
	send(message: EmDashMessage, source: string): Promise<void>;
}

type WithRuntime = <T>(run: (runtime: { email: EmDashPipeline | null }) => T | Promise<T>) => Promise<T>;

async function withRuntime(): Promise<WithRuntime | undefined> {
	try {
		return ((await import("emdash/middleware")) as unknown as { withEmDashRuntime: WithRuntime }).withEmDashRuntime;
	} catch {
		return undefined;
	}
}

/** Whether EmDash has an email provider selected (Settings → Email). False when EmDash is not reachable. */
export async function emdashEmailAvailable(): Promise<boolean> {
	const run = await withRuntime();
	if (!run) return false;
	try {
		return await run((rt) => !!rt.email?.isAvailable());
	} catch {
		return false;
	}
}

export type EmDashResult = { ok: true } | { ok: false; reason: string };

/**
 * Send through the pipeline, attributed to this plugin's id (what email:beforeSend/afterSend hooks see as `source`).
 * The first recipient is `to`, the others `cc` — EmDash's message has a single `to`.
 *
 * EmDash 1.5's EmailMessage has no attachments (`to`, `cc`, `replyTo`, `subject`, `text`, `html` only — checked in
 * emdash 1.5.0's types), so a signature PNG is embedded in the HTML part as a data-URI image instead, and the text
 * part says so. Some mail apps (Gmail among them) do not show data-URI images: see README.md → Signatures.
 */
export async function sendViaEmDash(to: string[], m: { replyTo?: string; subject: string; text: string; html: string; attachments?: Attachment[] }): Promise<EmDashResult> {
	const run = await withRuntime();
	if (!run) return { ok: false, reason: "emdash runtime unavailable" };
	const [first, ...rest] = to;
	if (!first) return { ok: false, reason: "no recipients" };
	const { text, html } = inlineAttachments(m);
	try {
		return await run(async (rt) => {
			if (!rt.email?.isAvailable()) return { ok: false, reason: "emdash email not configured" } as const;
			await rt.email.send({ to: first, ...(rest.length ? { cc: rest } : {}), ...(m.replyTo ? { replyTo: m.replyTo } : {}), subject: m.subject, text, html }, FORMS_PLUGIN.id);
			return { ok: true } as const;
		});
	} catch (err) {
		// The error's name only (EmailNotConfiguredError, a provider's error): messages can carry addresses.
		return { ok: false, reason: `emdash email: ${(err as Error)?.name ?? "Error"}` };
	}
}
