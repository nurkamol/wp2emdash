/**
 * Form messages — an EmDash native plugin (Block Kit admin, no React bundle) for the form outbox (Workers KV, binding
 * FORM_OUTBOX): an inbox with search, filters, read state and bulk actions; insights from per-day counts; CSV/JSON
 * export through one-time download links; import of exported files; an activity log; a dashboard widget; and the
 * recipients setting (stored in the same KV, so the form endpoint reads it per request; it overrides FORM_TO). With
 * keep sent (FORM_OUTBOX_KEEP_SENT="1") the inbox holds every message with its delivery status (Emailed / Waiting /
 * Failed), filterable, and any message can be emailed again.
 *
 * Admins only. The `admin` route keeps EmDash's default plugin-route permission, `plugins:manage` (Admin role); EmDash
 * checks it and its CSRF header before the handler runs, and the handler checks the role again. The `download` route
 * is public by necessity (a browser download cannot send EmDash's header) and serves a file only for a random token
 * an admin's export created — once, within two minutes. Visitor text is shown as plain text. Logs and the activity
 * list hold actions and counts, never message content.
 *
 * This is the module EmDash loads in the Worker (descriptor entrypoint `@wp2emdash/forms/plugin`); register it with
 * `formsPlugin()` from `@wp2emdash/forms` in astro.config.
 */
import { definePlugin, pluginResponse } from "emdash";
import { deleteQueued, deliveryOf, importQueued, isOutboxKey, keepsSent, listSummaries, type OutboxEnv, outboxStatus, parseRecipients, type Queued, readCounts, readQueued, resolveRecipients, retentionDays, sendQueued, testRecipients, updateQueued, writeRecipientSetting } from "../outbox.js";
import { FORMS_PLUGIN } from "../meta.js";
import { exportFileName, grantDownload, logActivity, parseImport, readActivity, redeemDownload, toCsv, toJson, toQueued } from "./data.js";
import { adminsOnly, type Filter, filtered, message, overview, type Overview, PAGE, parseDelivery, TABS, toSend, WIDGET, widget } from "./views.js";

const ADMIN_ROLE = 50;

interface Interaction {
	type?: string;
	action_id?: string;
	value?: unknown;
	values?: Record<string, unknown>;
	page?: string;
}

// Bindings exist only in the Worker: imported per request, not at module level (astro.config loads the descriptor in Node).
const outboxEnv = async () => ((await import("cloudflare:workers")) as unknown as { env: OutboxEnv }).env;

async function build(env: OutboxEnv, filter: Filter = {}, extra: Partial<Overview> = {}): Promise<Overview> {
	const since = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
	// Keep sent: an inbox, so the newest messages are listed; otherwise the oldest (the queue drains oldest first).
	const keepSent = keepsSent(env);
	const [{ items, more }, counts, activity, status, recipients] = await Promise.all([listSummaries(env, 1000, { newest: keepSent }),readCounts(env, since), readActivity(env.FORM_OUTBOX), outboxStatus(env), resolveRecipients(env)]);
	let matches: Set<string> | undefined;
	const q = filter.q?.trim().toLowerCase();
	if (q) {
		// Summaries cover name, email and subject; the message body needs a read (bounded by the 1,000 listed).
		matches = new Set();
		for (const { key, s } of items) {
			if ([s.from, s.email, s.subject].some((v) => v?.toLowerCase().includes(q))) matches.add(key);
			else if ((await readQueued(env, key))?.text.toLowerCase().includes(q)) matches.add(key);
		}
	}
	const forms = [...new Set([...items.map((i) => i.s.form), ...counts.map((c) => c.form)])].sort();
	const configTo = (env.FORM_TO ?? "").split(",").map((x) => x.trim()).filter(Boolean);
	const test = env.FORM_LIVE_HOST ? { test: { host: env.FORM_LIVE_HOST, to: testRecipients(env) } } : {};
	return { status, items, more, counts, activity, days: retentionDays(env), forms, filter, recipients: { ...recipients, configTo, ...test }, provider: env.EMAIL_PROVIDER ?? "brevo", keepSent, ...(matches ? { matches } : {}), ...extra };
}

const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : undefined);
const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

export function createPlugin() {
	return definePlugin({
		...FORMS_PLUGIN,
		admin: {
			pages: [{ path: PAGE, label: "Form messages", icon: "envelope" }],
			widgets: [{ id: WIDGET, title: "Form messages", size: "third" }],
		},
		routes: {
			admin: {
				permission: "plugins:manage",
				// Imports arrive in the request body.
				request: { body: "json", maxBytes: 4 * 1024 * 1024 },
				handler: async (ctx) => {
					const isWidget = ctx.ui?.surface === "dashboard-widget";
					if ((ctx.user?.role ?? 0) < ADMIN_ROLE) return { blocks: isWidget ? [] : adminsOnly };
					const env = await outboxEnv();
					if (!env.FORM_OUTBOX) return { blocks: [{ type: "header", text: "Form messages" }, { type: "banner", title: "The form outbox is not set up on this site", description: "Messages are emailed directly and nothing is kept.", variant: "default" }] };
					const who = ctx.user?.name || ctx.user?.email || ctx.user?.id || "admin";
					const kv = env.FORM_OUTBOX;
					const i = (ctx.input ?? {}) as Interaction;
					if (isWidget) {
						const since = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
						const keepSent = keepsSent(env);
						const [{ items }, counts] = await Promise.all([listSummaries(env, 1000, { newest: keepSent }), readCounts(env, since)]);
						return { blocks: widget({ items, counts, status: await outboxStatus(env), keepSent }) };
					}
					const key = isOutboxKey(i.value) ? i.value : undefined;
					const act = i.action_id;
					const page = async (filter: Filter = {}, tab: number = TABS.inbox, extra: Partial<Overview> = {}) => overview(await build(env, filter, extra), tab);

					if (i.type === "block_action" && key) {
						if (act === "open") {
							const q = await updateQueued(env, key, { read: true });
							if (!q) return { blocks: await page(), toast: { message: "That message is no longer waiting.", type: "info" } };
							await logActivity(kv, who, "Opened a message", 1);
							return { blocks: message(key, q, await outboxStatus(env)) };
						}
						if (act === "unread") {
							await updateQueued(env, key, { read: false });
							return { blocks: await page(), toast: { message: "Marked as unread.", type: "success" } };
						}
						if (act === "delete") {
							await deleteQueued(env, key);
							await logActivity(kv, who, "Deleted a message", 1);
							return { blocks: await page(), toast: { message: "Message deleted.", type: "success" } };
						}
						if (act === "send") {
							// "Email it now" for a waiting or failed message; "Email again" (confirmed in the view) for an emailed one.
							const before = await readQueued(env, key);
							const again = !!before && deliveryOf(before) === "emailed";
							const r = await sendQueued(env, key);
							await logActivity(kv, who, r === "sent" ? (again ? "Emailed a message again" : "Emailed a message") : "Tried to email a message", 1);
							if (r === "sent") {
								// Keep sent: the message stays, now marked emailed — show it; otherwise it left the outbox.
								const kept = keepsSent(env) ? await readQueued(env, key) : undefined;
								return { blocks: kept ? message(key, kept, await outboxStatus(env)) : await page(), toast: { message: again ? "Message emailed again." : "Message emailed.", type: "success" } };
							}
							const q = await readQueued(env, key);
							const text = r === "failed" ? `The email provider refused it; it stays here${again ? "" : " and is retried automatically"}.` : r === "missing" ? "That message is no longer here." : "Email is not available right now.";
							return { blocks: q ? message(key, q, await outboxStatus(env)) : await page(), toast: { message: text, type: "error" } };
						}
					}

					if (i.type === "block_action" && act === "sort") {
						const sort = (i.value as { sort?: { key?: unknown; dir?: unknown } } | undefined)?.sort;
						const k = str(sort?.key, 20);
						return { blocks: await page(k ? { sort: { key: k, dir: sort?.dir === "asc" ? "asc" : "desc" } } : {}) };
					}

					if (i.type === "block_action" && (act === "read-all" || act === "send-all" || act === "delete-all")) {
						const { items } = await listSummaries(env);
						if (act === "read-all") {
							const unread = items.filter((m) => !m.s.read);
							for (const m of unread) await updateQueued(env, m.key, { read: true });
							await logActivity(kv, who, "Marked all as read", unread.length);
							return { blocks: await page(), toast: { message: `${plural(unread.length, "message")} marked as read.`, type: "success" } };
						}
						if (act === "send-all") {
							let sent = 0;
							let failed = 0;
							// Waiting and failed messages only: never one already emailed (keep sent) or imported without email.
							for (const m of toSend(items)) {
								const r = await sendQueued(env, m.key);
								if (r === "sent") sent++;
								else if (r === "failed") failed++;
								else break;
							}
							await logActivity(kv, who, "Emailed all waiting messages", sent);
							return { blocks: await page(), toast: { message: failed ? `${plural(sent, "message")} emailed; ${failed} refused by the provider and kept.` : `${plural(sent, "message")} emailed.`, type: failed ? "error" : "success" } };
						}
						// delete-all: everything, or exactly the rows the search showed (the button carries that filter).
						const choice = (i.value ?? {}) as { scope?: unknown; filter?: Record<string, unknown> };
						let doomed = items;
						if (choice.scope === "shown") {
							const f = choice.filter ?? {};
							const filter: Filter = { ...(str(f.q, 120) ? { q: str(f.q, 120) } : {}), form: str(f.form, 80) ?? "all", show: f.show === "unread" || f.show === "read" ? f.show : "all", delivery: parseDelivery(f.delivery) };
							doomed = filtered(await build(env, filter));
						} else if (choice.scope !== "all") return { blocks: await page() };
						for (const m of doomed) await deleteQueued(env, m.key);
						await logActivity(kv, who, choice.scope === "shown" ? "Deleted the shown messages" : "Deleted all messages", doomed.length);
						return { blocks: await page(), toast: { message: `${plural(doomed.length, "message")} deleted.`, type: "success" } };
					}

					if (i.type === "form_submit" && act === "filter") {
						const v = i.values ?? {};
						const show = v.show === "unread" || v.show === "read" ? v.show : "all";
						return { blocks: await page({ ...(str(v.q, 120) ? { q: str(v.q, 120) } : {}), form: str(v.form, 80) ?? "all", show, delivery: parseDelivery(v.delivery) }) };
					}

					if (i.type === "form_submit" && act === "recipients") {
						// Who form messages are emailed to (endpoint, cron and "Email it now"). Empty: back to FORM_TO.
						const v = i.values ?? {};
						const { list, errors } = parseRecipients(typeof v.to === "string" ? v.to.slice(0, 4000) : "");
						if (errors.length) return { blocks: await page({}, TABS.settings, { recipientErrors: errors }), toast: { message: "Recipients not saved. See the errors.", type: "error" } };
						await writeRecipientSetting(env, list);
						// The log records who changed it and how many addresses — never the addresses.
						await logActivity(kv, who, list.length ? "Changed the form recipients" : "Reset the form recipients to the site default", list.length);
						return { blocks: await page({}, TABS.settings), toast: { message: list.length ? `Form messages now go to ${plural(list.length, "recipient")}.` : "Recipients reset to the site default.", type: "success" } };
					}

					if (i.type === "form_submit" && act === "export") {
						const v = i.values ?? {};
						const format = v.format === "json" ? "json" : "csv";
						const scope = v.scope === "unread" ? "unread" : "all";
						const token = await grantDownload(env, { format, scope, who });
						const url = new URL(`/_emdash/api/plugins/${FORMS_PLUGIN.id}/download?token=${token}`, ctx.request.url).toString();
						return { blocks: await page({}, TABS.transfer, { download: { url, name: exportFileName(format) } }) };
					}

					if (i.type === "form_submit" && act === "import") {
						const v = i.values ?? {};
						const { rows, errors } = parseImport(typeof v.data === "string" ? v.data : "");
						let added = 0;
						let duplicates = 0;
						for (const r of rows) {
							if ((await importQueued(env, toQueued(r, { email: v.email === true, markRead: v.read !== false }))) === "added") added++;
							else duplicates++;
						}
						if (rows.length) await logActivity(kv, who, "Imported messages", added);
						const report = [`${plural(added, "message")} imported${duplicates ? `, ${duplicates} already here (skipped)` : ""}${errors.length ? `, ${plural(errors.length, "row")} not imported:` : "."}`, ...errors];
						return { blocks: await page({}, TABS.transfer, { importReport: report }), toast: { message: added ? `${plural(added, "message")} imported.` : rows.length ? "Nothing new to import." : "Nothing imported. See the report.", type: added ? "success" : errors.length ? "error" : "info" } };
					}

					return { blocks: await page() };
				},
			},
			download: {
				public: true,
				methods: ["GET"],
				request: { body: "none" },
				response: "raw",
				handler: async (ctx) => {
					const env = await outboxEnv();
					const query = (ctx.input ?? {}) as Record<string, unknown>;
					const grant = await redeemDownload(env, Array.isArray(query.token) ? query.token[0] : query.token);
					if (!grant) return pluginResponse({ status: 410, headers: { "content-type": "text/plain; charset=utf-8" }, body: { kind: "text", value: "This download link has expired or was already used. Create a new one in the admin: Form messages → Import & export." } });
					const { items } = await listSummaries(env, 1000, { newest: keepsSent(env) });
					const messages: Queued[] = [];
					for (const { key, s } of items) {
						if (grant.scope === "unread" && s.read) continue;
						const q = await readQueued(env, key);
						if (q) messages.push(q);
					}
					messages.sort((a, b) => (a.at < b.at ? 1 : -1));
					await logActivity(env.FORM_OUTBOX, grant.who, `Exported messages (${grant.format.toUpperCase()})`, messages.length);
					const body = grant.format === "json" ? toJson(messages) : toCsv(messages);
					return pluginResponse({
						status: 200,
						headers: { "content-type": grant.format === "json" ? "application/json; charset=utf-8" : "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${exportFileName(grant.format)}"` },
						body: { kind: "text", value: body },
					});
				},
			},
		},
	});
}

export default createPlugin;
