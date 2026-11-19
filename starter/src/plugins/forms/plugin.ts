/**
 * "Form messages" admin page: an EmDash native plugin (Block Kit, no React bundle) that shows the messages waiting in
 * the form outbox (Workers KV, binding FORM_OUTBOX) and lets a site admin read, email or delete one.
 *
 * Admins only: the page's route keeps EmDash's default plugin-route permission, `plugins:manage`, which only the Admin
 * role has; EmDash checks it (and its CSRF header) before the handler runs, and the handler checks the role again.
 * Visitor text is shown as plain text (Block Kit escapes it). Logs record the action, a count and the admin's user id,
 * never what a visitor wrote. Registered in astro.config.mjs when the owner enabled the outbox (kit.config forms.outbox).
 */
import { definePlugin } from "emdash";
import { deleteQueued, isOutboxKey, listQueued, type OutboxEnv, outboxStatus, type Queued, readQueued, sendQueued } from "../../forms/outbox.js";

export const FORMS_PLUGIN = { id: "site-forms", version: "1.0.0" } as const;
const ADMIN_ROLE = 50;
const LIST_LIMIT = 100;

type Block = Record<string, unknown>;
interface Interaction {
	type?: string;
	action_id?: string;
	value?: unknown;
}

const STATUS_TEXT: Record<ReturnType<typeof outboxStatus>, { title: string; description: string; variant: "default" | "alert" }> = {
	held: { title: "On hold", description: "Messages are kept and none are emailed until a working email account is connected.", variant: "alert" },
	"no-email": { title: "Email is not set up", description: "Messages are kept until the site can send email, then sent automatically.", variant: "alert" },
	ready: { title: "Email is working", description: "Waiting messages are emailed automatically every 5 minutes; you can also send one now.", variant: "default" },
};

const from = (q: Queued) => (q.replyTo ? (q.replyTo.name ? `${q.replyTo.name} <${q.replyTo.email}>` : q.replyTo.email) : "(no reply address)");
const when = (iso: string) => {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : d.toUTCString();
};

async function listView(env: OutboxEnv): Promise<Block[]> {
	const status = outboxStatus(env);
	const { items, more } = await listQueued(env, LIST_LIMIT);
	const days = Math.min(90, Math.max(1, Number(env.FORM_OUTBOX_DAYS) || 30));
	return [
		{ type: "header", text: "Form messages" },
		{ type: "banner", ...STATUS_TEXT[status] },
		{ type: "stats", items: [{ label: "Waiting", value: items.length + (more ? "+" : "") }] },
		{
			type: "table",
			block_id: "messages",
			page_action_id: "refresh",
			empty_text: "No messages are waiting.",
			columns: [
				{ key: "received", label: "Received", format: "relative_time" },
				{ key: "from", label: "From" },
				{ key: "subject", label: "Subject" },
				{ key: "open", label: "", format: "element" },
			],
			rows: items.map(({ key, q }) => ({ received: q.at, from: from(q), subject: q.subject, open: { type: "button", action_id: "open", label: "Read", value: key } })),
		},
		...(more ? [{ type: "context", text: `Showing the oldest ${LIST_LIMIT}. Send or delete some to see the rest.` }] : []),
		{ type: "context", text: `Messages are deleted automatically ${days} days after they arrive, or as soon as they are emailed. Only admins can see this page.` },
	];
}

function messageView(key: string, q: Queued, env: OutboxEnv): Block[] {
	const ready = outboxStatus(env) === "ready";
	const lines = q.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 200);
	return [
		{ type: "header", text: q.subject },
		{
			type: "fields",
			fields: [
				{ label: "Received", value: when(q.at) },
				{ label: "From", value: from(q) },
				{ label: "Form", value: q.form },
				{ label: "Email attempts", value: String(q.attempts) },
			],
		},
		{ type: "divider" },
		...lines.map((text) => ({ type: "section", text })),
		{ type: "divider" },
		{
			type: "actions",
			elements: [
				{ type: "button", action_id: "back", label: "Back to the list", style: "secondary" },
				...(ready ? [{ type: "button", action_id: "send", label: "Email it now", style: "primary", value: key }] : []),
				{ type: "button", action_id: "delete", label: "Delete", style: "danger", value: key, confirm: { title: "Delete this message?", text: "It is removed from the outbox and cannot be recovered.", confirm: "Delete", deny: "Keep it", style: "danger" } },
			],
		},
	];
}

export function createPlugin() {
	return definePlugin({
		...FORMS_PLUGIN,
		admin: { pages: [{ path: "/messages", label: "Form messages", icon: "envelope" }] },
		routes: {
			admin: {
				permission: "plugins:manage",
				handler: async (ctx) => {
					if ((ctx.user?.role ?? 0) < ADMIN_ROLE) return { blocks: [{ type: "banner", title: "Admins only", variant: "error" }] };
					// Bindings exist only in the Worker: imported here, not at module level (astro.config loads this file in Node).
					const { env } = (await import("cloudflare:workers")) as unknown as { env: OutboxEnv };
					if (!env.FORM_OUTBOX) return { blocks: [{ type: "header", text: "Form messages" }, { type: "banner", title: "The form outbox is not set up on this site", variant: "default" }] };
					const i = (ctx.input ?? {}) as Interaction;
					const key = isOutboxKey(i.value) ? i.value : undefined;
					const who = ctx.user?.id;
					if (i.type === "block_action" && key && i.action_id === "open") {
						const q = await readQueued(env, key);
						if (q) {
							ctx.log.info("form message opened", { user: who });
							return { blocks: messageView(key, q, env) };
						}
						return { blocks: await listView(env), toast: { message: "That message is no longer waiting.", type: "info" } };
					}
					if (i.type === "block_action" && key && i.action_id === "delete") {
						await deleteQueued(env, key);
						ctx.log.info("form message deleted", { user: who });
						return { blocks: await listView(env), toast: { message: "Message deleted.", type: "success" } };
					}
					if (i.type === "block_action" && key && i.action_id === "send") {
						const r = await sendQueued(env, key);
						ctx.log.info("form message sent from admin", { user: who, outcome: r });
						if (r === "sent") return { blocks: await listView(env), toast: { message: "Message emailed.", type: "success" } };
						const q = await readQueued(env, key);
						const message = r === "failed" ? "The email provider refused it; it stays in the outbox." : r === "missing" ? "That message is no longer waiting." : "Email is not available right now.";
						return { blocks: q ? messageView(key, q, env) : await listView(env), toast: { message, type: "error" } };
					}
					return { blocks: await listView(env) };
				},
			},
		},
	});
}

export default createPlugin;
