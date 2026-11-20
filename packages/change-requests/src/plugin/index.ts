/**
 * Change requests — EmDash native plugin, loaded in the Worker from `@wp2emdash/change-requests/plugin`; register it
 * with `changeRequestsPlugin()` from `@wp2emdash/change-requests` in astro.config.
 *
 * - `admin` route (permission `content:edit_any`: editors and admins; role checked again): Plugins → Change requests
 *   (list with filters, "Request a change", one request with its files, timeline, reply form and status moves; the
 *   Delivery tab for the agency) and the dashboard widget. `/requests/<id>` deep-links one request (emails link there).
 * - `panel` route: the "Request a change" editor panel on pages (the page is chosen for you).
 * - `uploads` (JSON) and `upload` (raw bytes, at most 5 MB) routes, private: the upload page (`/attach`, the plugin's
 *   only React part — Block Kit has no file input). Files are checked by their first bytes and stored in the site's R2
 *   bucket under `backups/change-requests/<request>/`, a prefix EmDash's public media route never serves.
 * - `file` route (public GET, raw): one attachment, only for a random one-time token an editor's "Download" created
 *   (5 minutes; a browser download cannot send EmDash's CSRF header). Always served as a download.
 * - `cron` hook, task `daily`: deletes closed requests older than the retention (12 months by default) with their
 *   files, and expired download grants.
 *
 * Emails and the webhook hold only the request itself (README.md → Privacy); logs carry ids, counts and reasons.
 */
import { definePlugin, pluginResponse } from "emdash";
import { CR_PLUGIN, PAGE, ATTACH_PAGE, WEBHOOK_SECRET } from "../meta.js";
import { DEFAULT_RETENTION_MONTHS, type ChangeRequestsOptions } from "../index.js";
import { type Actor, actorOf, applyFilter, attachmentKey, canAttach, canDownload, type ChangeRequest, checkAttachment, comment, DEFAULT_FILTER, EDITOR_ROLE, expired, type Filter, filterOf, ID_PATTERN, isAttachmentKey, isOpen, isRequester, LIMITS, move, newRequest, type PageRef, randomId, STATUS_LABEL, type Status, STATUSES, validateNew } from "../model.js";
import { commentMail, type MailEnv, mailReady, newRequestMail, type PluginEmail, sendMail, sendWebhook, statusMail, type WebhookEvent, webhookPayload, webhookReady } from "../notify.js";
import { getRequest, getTicket, grant, type Kv, listRequests, logDelivery, nextNumber, putRequest, redeem, reqKey, setTicket, type DeliveryLog } from "../store.js";
import { attachView, detail, editorsOnly, type Notice, page, type PageData, panel, TABS, widget } from "./views.js";

const DOWNLOAD_MS = 5 * 60_000;
export const TASK = "daily";

export interface Bucket {
	put(key: string, value: Uint8Array, o?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
	get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
	delete(keys: string | string[]): Promise<void>;
}
export interface WorkerEnv extends MailEnv {
	MEDIA?: Bucket;
	[binding: string]: unknown;
}
interface CronAccess {
	schedule(name: string, o: { schedule: string }): Promise<void>;
	list(): Promise<{ name: string; schedule: string }[]>;
}
interface ContentApi {
	get(collection: string, id: string): Promise<{ id: string; slug: string | null; status: string; data: Record<string, unknown> } | null>;
	list(collection: string, o?: { limit?: number; cursor?: string }): Promise<{ items: { id: string; slug: string | null; status: string; data: Record<string, unknown> }[]; cursor?: string; hasMore?: boolean }>;
}
export interface Ctx {
	input?: unknown;
	request?: Request;
	user?: { role: number; id?: string; email?: string; name?: string | null };
	ui?: { surface?: string; entry?: { collection: string; id: string } };
	kv: Kv;
	cron?: CronAccess;
	email?: PluginEmail;
	content?: ContentApi;
	log?: { info(m: string, d?: Record<string, unknown>): void; warn?(m: string, d?: Record<string, unknown>): void };
}
interface Interaction {
	type?: string;
	action_id?: string;
	value?: unknown;
	values?: Record<string, unknown>;
	page?: string;
}
type Toast = { message: string; type: "success" | "error" | "info" };
type Out = { blocks: Record<string, unknown>[]; toast?: Toast };
export interface Deps {
	env: WorkerEnv;
	fetch: (url: string, init: RequestInit) => Promise<Response>;
	now: () => number;
}

// Bindings exist only in the Worker: imported per call (astro.config loads the descriptor in Node).
const workerEnv = async () => ((await import("cloudflare:workers")) as unknown as { env: WorkerEnv }).env;
const defaultDeps = async (): Promise<Deps> => ({ env: await workerEnv(), fetch: (url, init) => fetch(url, init), now: () => Date.now() });

/** Daily task at a time fixed per site (03:00–05:59 UTC) so sites in one account spread out. */
export function cronSchedule(host: string): string {
	let h = 11;
	for (const c of host) h = (h * 31 + c.charCodeAt(0)) >>> 0;
	return `${h % 60} ${3 + (h % 3)} * * *`;
}

export async function ensureCron(cron: CronAccess | undefined, o: ChangeRequestsOptions): Promise<void> {
	if (!cron) return;
	const want = cronSchedule(new URL(o.productionUrl).host);
	if (!(await cron.list()).some((t) => t.name === TASK && t.schedule === want)) await cron.schedule(TASK, { schedule: want });
}

const originOf = (ctx: Ctx, o: ChangeRequestsOptions) => {
	try {
		return new URL(ctx.request?.url ?? o.productionUrl).origin;
	} catch {
		return new URL(o.productionUrl).origin;
	}
};
export const requestLink = (origin: string, id: string) => `${origin}/_emdash/admin/plugins/${CR_PLUGIN.id}${PAGE}/${id}`;
export const attachLink = (origin: string) => `${origin}/_emdash/admin/plugins/${CR_PLUGIN.id}${ATTACH_PAGE}`;
const userKey = (a: Actor) => a.id ?? a.email ?? "anon";

/** Read-modify-write of one request, with compare-and-set where EmDash offers it (two editors at once never lose a change). */
export async function updateRequest<T>(kv: Kv, id: string, fn: (r: ChangeRequest) => { request: ChangeRequest; result: T } | { error: string }): Promise<{ request: ChangeRequest; result: T } | { error: string }> {
	for (let i = 0; i < 4; i++) {
		const versioned = kv.getVersioned ? await kv.getVersioned<ChangeRequest>(reqKey(id)) : null;
		const cur = versioned?.value ?? (await getRequest(kv, id));
		if (!cur) return { error: "That request no longer exists." };
		const out = fn(cur);
		if ("error" in out) return out;
		if (versioned && kv.compareAndSet) {
			if ((await kv.compareAndSet(reqKey(id), versioned.revision, out.request)).applied) return out;
			continue;
		}
		await putRequest(kv, out.request);
		return out;
	}
	return { error: "Someone else changed this request at the same time. Try again." };
}

// ── Notifications ────────────────────────────────────────────────────────────────────────────────────────────────

export type Happening = { kind: "created" | "reopened" } | { kind: "status"; from: Status; note?: string } | { kind: "comment"; text: string };

/** Emails and the webhook after a change. Each result is logged (ok / reason), never an address or content. */
export async function notify(ctx: Ctx, d: Deps, o: ChangeRequestsOptions, r: ChangeRequest, a: Actor, h: Happening, origin: string): Promise<DeliveryLog[]> {
	const link = requestLink(origin, r.id);
	const footer = o.footer ?? o.siteName;
	const at = new Date(d.now()).toISOString();
	const out: DeliveryLog[] = [];
	const mail = async (what: string, to: string[], m: Parameters<typeof sendMail>[3]) => {
		if (!to.length) return;
		const res = await sendMail(d.env, ctx.email, to, m);
		out.push({ at, what, ok: res.ok, ...(res.ok ? {} : { reason: res.reason }) });
	};
	const toRequester = r.notify && !!r.requester.email && !isRequester(a, r) ? [r.requester.email as string] : [];
	if (h.kind === "created" || h.kind === "reopened") await mail(`Email to the agency: ${h.kind === "created" ? "new" : "reopened"} request #${r.number}`, o.agencyTo, newRequestMail(r, { siteName: o.siteName, link, footer, reopened: h.kind === "reopened" }));
	else if (h.kind === "status" && r.status !== "seen") await mail(`Email to the requester: #${r.number} is ${STATUS_LABEL[r.status]}`, toRequester, statusMail(r, { siteName: o.siteName, link, footer, from: h.from, by: a.name, ...(h.note ? { note: h.note } : {}) }));
	else if (h.kind === "comment") {
		if (a.agency) await mail(`Email to the requester: reply on #${r.number}`, toRequester, commentMail(r, { siteName: o.siteName, link, footer, by: a.name, text: h.text, toAgency: false }));
		else await mail(`Email to the agency: comment on #${r.number}`, o.agencyTo, commentMail(r, { siteName: o.siteName, link, footer, by: a.name, text: h.text, toAgency: true }));
	}
	const hook = webhookReady(o.webhook, d.env, WEBHOOK_SECRET);
	if (hook.ok) {
		const event: WebhookEvent = h.kind === "created" ? "request.created" : h.kind === "reopened" ? "request.reopened" : h.kind === "status" ? "request.status_changed" : "request.commented";
		const res = await sendWebhook(hook, webhookPayload(event, r, { siteName: o.siteName, siteUrl: o.productionUrl, link, at, by: a.name, agency: a.agency, ...(h.kind === "status" ? { from: h.from } : {}), ...(h.kind === "comment" ? { comment: h.text } : h.kind === "status" && h.note ? { comment: h.note } : {}) }), { fetch: d.fetch, now: d.now() });
		out.push({ at, what: `Webhook: ${event} #${r.number}`, ok: res.ok, ...(res.ok ? {} : { reason: res.reason }) });
	}
	for (const e of out) await logDelivery(ctx.kv, e);
	if (out.some((e) => !e.ok)) ctx.log?.warn?.("change-requests: delivery problem", { request: r.id, failed: out.filter((e) => !e.ok).map((e) => e.reason) });
	return out;
}

// ── Pages the picker offers ──────────────────────────────────────────────────────────────────────────────────────

export async function pagesFor(ctx: Ctx, collections: string[], max = 200): Promise<PageRef[]> {
	const out: PageRef[] = [];
	if (!ctx.content) return out;
	for (const c of collections) {
		let cursor: string | undefined;
		try {
			do {
				const res = await ctx.content.list(c, { limit: 100, ...(cursor ? { cursor } : {}) });
				for (const it of res.items) {
					const t = typeof it.data.title === "string" && it.data.title.trim() ? it.data.title.trim() : (it.slug ?? it.id);
					out.push({ collection: c, id: it.id, title: `${t.slice(0, 100)}${it.status === "draft" ? " (draft)" : ""}${collections.length > 1 && c !== "pages" ? ` · ${c}` : ""}` });
				}
				cursor = res.hasMore ? res.cursor : undefined;
			} while (cursor && out.length < max);
		} catch {
			ctx.log?.warn?.("change-requests: could not list a collection", { collection: c });
		}
	}
	return out.slice(0, max).sort((x, y) => x.title.localeCompare(y.title));
}

// ── The plugin ───────────────────────────────────────────────────────────────────────────────────────────────────

export function createPlugin(options: ChangeRequestsOptions, depsFor: () => Promise<Deps> = defaultDeps) {
	const o = options;
	const collections = o.collections?.length ? o.collections : ["pages"];
	const domains = o.agencyDomains ?? [];

	const daily = async (ctx: Ctx) => {
		const d = await depsFor();
		const list = await listRequests(ctx.kv);
		const old = expired(list, o.retentionMonths ?? DEFAULT_RETENTION_MONTHS, d.now());
		for (const r of old) {
			const keys = r.attachments.map((a) => a.key).filter(isAttachmentKey);
			if (keys.length && d.env.MEDIA) await d.env.MEDIA.delete(keys);
			await ctx.kv.delete(reqKey(r.id));
		}
		for (const { key, value } of (await ctx.kv.list?.("dl:")) ?? []) if (!(Date.parse((value as { until?: string })?.until ?? "") >= d.now())) await ctx.kv.delete(key);
		if (old.length) ctx.log?.info("change-requests: retention", { deleted: old.length });
	};

	return definePlugin({
		...CR_PLUGIN,
		capabilities: ["content:read", "email:send"],
		hooks: {
			"plugin:install": async (_event: unknown, ctx: unknown) => ensureCron((ctx as Ctx).cron, o),
			"plugin:activate": async (_event: unknown, ctx: unknown) => ensureCron((ctx as Ctx).cron, o),
			cron: { timeout: 25_000, handler: async (event: { name: string }, ctx: unknown) => (event.name === TASK ? daily(ctx as Ctx) : undefined) },
		},
		admin: {
			pages: [{ path: PAGE, label: "Change requests", icon: "list" }],
			widgets: [{ id: "change-requests", title: "Change requests", size: "third" }],
			editorPanels: [{ id: "change-request", title: "Request a change", route: "panel", collections, order: 90 }],
		},
		routes: {
			admin: { permission: "content:edit_any", handler: async (raw: unknown) => handleAdmin(raw as Ctx, o, await depsFor(), domains, collections) },
			panel: { permission: "content:edit_any", handler: async (raw: unknown) => handlePanel(raw as Ctx, o, await depsFor(), domains) },
			uploads: {
				permission: "content:edit_any",
				handler: async (raw: unknown) => {
					const ctx = raw as Ctx;
					const a = actorOf(ctx.user, domains);
					if (a.role < EDITOR_ROLE) return { requests: [], selected: null };
					const list = (await listRequests(ctx.kv)).filter((r) => canAttach(a, r)).sort((x, y) => (x.updatedAt < y.updatedAt ? 1 : -1));
					const ticket = await getTicket(ctx.kv, userKey(a));
					const selected = list.find((r) => r.id === ticket)?.id ?? list.find((r) => isRequester(a, r))?.id ?? null;
					return { requests: list.slice(0, 50).map((r) => ({ id: r.id, number: r.number, title: r.title, attachments: r.attachments.length })), selected, max: LIMITS.attachments, maxBytes: LIMITS.attachmentBytes, back: `/_emdash/admin/plugins/${CR_PLUGIN.id}${PAGE}` };
				},
			},
			upload: {
				permission: "content:edit_any",
				methods: ["POST"],
				request: { body: "bytes", maxBytes: LIMITS.attachmentBytes },
				handler: async (raw: unknown) => handleUpload(raw as Ctx, o, await depsFor(), domains),
			},
			file: {
				public: true,
				methods: ["GET"],
				request: { body: "none" },
				response: "raw",
				handler: async (raw: unknown) => {
					const ctx = raw as Ctx;
					const { env, now } = await depsFor();
					const q = (ctx.input ?? {}) as Record<string, unknown>;
					const g = await redeem<{ request: string; att: string }>(ctx.kv, "dl", Array.isArray(q.token) ? q.token[0] : q.token, now());
					const gone = () => pluginResponse({ status: 410, headers: { "content-type": "text/plain; charset=utf-8" }, body: { kind: "text", value: "This download link has expired or was already used. Download the file again from the admin: Plugins → Change requests." } });
					if (!g) return gone();
					const r = await getRequest(ctx.kv, g.request);
					const att = r?.attachments.find((x) => x.id === g.att);
					const obj = att && isAttachmentKey(att.key) && env.MEDIA ? await env.MEDIA.get(att.key) : null;
					if (!att || !obj) return gone();
					return pluginResponse({ status: 200, headers: { "content-type": att.type, "content-disposition": `attachment; filename="${att.name.replace(/"/g, "")}"`, "cache-control": "private, no-store" }, body: { kind: "bytes", value: new Uint8Array(await obj.arrayBuffer()) } });
				},
			},
		},
	});
}

export default createPlugin;

// ── Upload ───────────────────────────────────────────────────────────────────────────────────────────────────────

export async function handleUpload(ctx: Ctx, o: ChangeRequestsOptions, d: Deps, domains: string[]): Promise<{ ok: boolean; message: string; attachments?: number }> {
	const a = actorOf(ctx.user, domains);
	if (a.role < EDITOR_ROLE) return { ok: false, message: "Editors and admins only." };
	const url = new URL(ctx.request?.url ?? o.productionUrl);
	const id = url.searchParams.get("request") ?? "";
	const bytes = ctx.input instanceof Uint8Array ? ctx.input : new Uint8Array();
	const check = checkAttachment(url.searchParams.get("name") ?? "", bytes);
	if (!check.ok) return { ok: false, message: check.reason };
	if (!d.env.MEDIA) return { ok: false, message: "The site has no file storage (MEDIA binding)." };
	const r = await getRequest(ctx.kv, id);
	if (!r) return { ok: false, message: "That request no longer exists." };
	if (!canAttach(a, r)) return { ok: false, message: isOpen(r.status) ? `This request has ${LIMITS.attachments} files already.` : "This request is closed." };
	const attId = randomId();
	const key = attachmentKey(r.id, attId, check.name);
	await d.env.MEDIA.put(key, bytes, { httpMetadata: { contentType: check.type }, customMetadata: { request: r.id, plugin: CR_PLUGIN.id } });
	const at = new Date(d.now()).toISOString();
	const res = await updateRequest(ctx.kv, r.id, (cur) => {
		if (!canAttach(a, cur)) return { error: `This request has ${LIMITS.attachments} files already.` };
		return { request: { ...cur, updatedAt: at, attachments: [...cur.attachments, { id: attId, name: check.name, type: check.type, size: bytes.byteLength, key, at, by: a.name }], timeline: [...cur.timeline, { at, kind: "attachment", by: a.name, agency: a.agency, text: check.name }] }, result: null };
	});
	if ("error" in res) {
		await d.env.MEDIA.delete(key).catch(() => {});
		return { ok: false, message: res.error };
	}
	ctx.log?.info("change-requests: file added", { request: r.id, bytes: bytes.byteLength, type: check.type });
	return { ok: true, message: `${check.name} added to #${r.number}.`, attachments: res.request.attachments.length };
}

// ── Admin page and widget ────────────────────────────────────────────────────────────────────────────────────────

async function handleAdmin(ctx: Ctx, o: ChangeRequestsOptions, d: Deps, domains: string[], collections: string[]): Promise<Out> {
	const a = actorOf(ctx.user, domains);
	const isWidget = ctx.ui?.surface === "dashboard-widget";
	if (a.role < EDITOR_ROLE) return { blocks: isWidget ? [] : editorsOnly };
	const kv = ctx.kv;
	if (isWidget) return { blocks: widget(await listRequests(kv)) };
	await ensureCron(ctx.cron, o).catch(() => {});
	const i = (ctx.input ?? {}) as Interaction;
	const act = i.action_id ?? "";
	const origin = originOf(ctx, o);
	const attachUrl = attachLink(origin);

	const show = async (tab: number = TABS.requests, extra: { notice?: Notice; filter?: Filter; draft?: Record<string, unknown>; toast?: Toast } = {}): Promise<Out> => {
		const list = await listRequests(kv);
		const filter = extra.filter ?? DEFAULT_FILTER;
		const data: PageData = {
			actor: a,
			list,
			filtered: applyFilter(list, filter, a),
			filter,
			// The form tab needs the page list (switching tabs happens in the browser, without a request).
			pages: await pagesFor(ctx, collections),
			sensitive: !!o.sensitive,
			attachUrl,
			...(a.agency ? { delivery: deliveryOf(d, o, ctx, (await kv.get<DeliveryLog[]>("log")) ?? []) } : {}),
			...(extra.notice ? { notice: extra.notice } : {}),
			...(extra.draft ? { draft: extra.draft } : {}),
		};
		return { blocks: page(data, tab), ...(extra.toast ? { toast: extra.toast } : {}) };
	};
	const open = async (id: string, extra: { notice?: Notice; download?: { url: string; name: string }; toast?: Toast } = {}): Promise<Out> => {
		let r = await getRequest(kv, id);
		if (!r) return show(TABS.requests, { toast: { message: "That request no longer exists (closed requests are deleted after the retention period).", type: "info" } });
		// The agency opening a new request marks it Seen.
		if (a.agency && r.status === "new") {
			const res = await updateRequest<Status>(kv, r.id, (cur) => {
				const m = move(cur, a, "seen", undefined, d.now());
				return m.ok ? { request: m.request, result: m.from } : { error: m.reason };
			});
			if (!("error" in res)) {
				r = res.request;
				await notify(ctx, d, o, r, a, { kind: "status", from: res.result }, origin);
			}
		}
		return { blocks: detail(r, { actor: a, attachUrl, now: d.now(), ...(extra.notice ? { notice: extra.notice } : {}), ...(extra.download ? { download: extra.download } : {}) }), ...(extra.toast ? { toast: extra.toast } : {}) };
	};

	// Deep link: /requests/<id>
	const deep = /^\/requests\/([0-9a-f]{16})\/?$/.exec(i.page ?? "");
	if ((i.type === "page_load" || !i.type) && deep?.[1]) return open(deep[1]);

	if (act === "open" && typeof i.value === "string") return open(i.value);
	if (act === "back") return show();
	if (i.type === "form_submit" && act === "filter") return show(TABS.requests, { filter: filterOf(i.values) });

	if (i.type === "form_submit" && act === "create") {
		const v = i.values ?? {};
		const pages = await pagesFor(ctx, collections);
		const res = validateNew(v, pages);
		if (!res.ok) return show(TABS.new, { draft: v, notice: { title: "Not sent yet", description: res.errors.join(" "), variant: "error" } });
		const list = await listRequests(kv);
		const r = newRequest(res.value, a, { id: randomId(), number: await nextNumber(kv, list), now: d.now() });
		await putRequest(kv, r);
		await setTicket(kv, userKey(a), r.id, d.now());
		ctx.log?.info("change-requests: created", { request: r.id, number: r.number, priority: r.priority });
		await notify(ctx, d, o, r, a, { kind: "created" }, origin);
		return { blocks: [...detail(r, { actor: a, attachUrl, now: d.now(), notice: { title: `Request #${r.number} sent`, description: "Your agency has been told. Add screenshots or PDF files below if they help.", variant: "default" } })], toast: { message: `Request #${r.number} sent.`, type: "success" } };
	}

	if (i.type === "form_submit" && act.startsWith("reply:")) {
		const id = act.slice(6);
		const v = i.values ?? {};
		const text = typeof v.text === "string" ? v.text : "";
		const to = typeof v.status === "string" && (STATUSES as readonly string[]).includes(v.status) ? (v.status as Status) : undefined;
		if (!text.trim() && !to) return open(id, { toast: { message: "Write a comment or choose a status.", type: "info" } });
		const res = await updateRequest<Happening>(kv, id, (cur) => {
			let r = cur;
			let said = "";
			const doMove = () => {
				if (!to) return undefined;
				const m = move(r, a, to, undefined, d.now());
				if (!m.ok) return m.reason;
				r = m.request;
				return undefined;
			};
			const doComment = () => {
				if (!text.trim()) return undefined;
				const c = comment(r, a, text, d.now());
				if (!c.ok) return c.reason;
				r = c.request;
				said = r.timeline.filter((e) => e.kind === "comment").at(-1)?.text ?? "";
				return undefined;
			};
			// Closing: the comment goes in while the request is still open. Opening or moving on: the status first.
			const closing = to === "done" || to === "declined";
			const err = closing ? (doComment() ?? doMove()) : (doMove() ?? doComment());
			if (err) return { error: err };
			// One notification per save: a status change carries its comment as the note.
			const h: Happening = to === "new" ? { kind: "reopened" } : to ? { kind: "status", from: cur.status, ...(said ? { note: said } : {}) } : { kind: "comment", text: said };
			return { request: r, result: h };
		});
		if ("error" in res) return open(id, { notice: { title: "Not saved", description: res.error, variant: "error" } });
		await notify(ctx, d, o, res.request, a, res.result, origin);
		ctx.log?.info("change-requests: updated", { request: id, status: res.request.status, comment: !!text.trim() });
		return open(id, { toast: { message: to ? `Status: ${STATUS_LABEL[res.request.status]}.` : "Comment added.", type: "success" } });
	}

	if (act === "mute" || act === "unmute") {
		const id = typeof i.value === "string" ? i.value : "";
		const res = await updateRequest(kv, id, (cur) => (isRequester(a, cur) ? { request: { ...cur, notify: act === "unmute" }, result: null } : { error: "Only the person who sent the request can change its emails." }));
		return open(id, "error" in res ? { notice: { title: "Not changed", description: res.error, variant: "error" } } : { toast: { message: act === "mute" ? "No more update emails for this request." : "You will get update emails for this request.", type: "success" } });
	}

	if (act === "attach") {
		const r = await getRequest(kv, i.value);
		if (!r) return show();
		if (!canAttach(a, r)) return open(r.id, { toast: { message: isOpen(r.status) ? `This request has ${LIMITS.attachments} files already.` : "This request is closed.", type: "info" } });
		await setTicket(kv, userKey(a), r.id, d.now());
		return { blocks: attachView(r, attachUrl) };
	}

	if (act === "download") {
		const [rid = "", att = ""] = typeof i.value === "string" ? i.value.split("|") : [];
		const r = await getRequest(kv, rid);
		const file = r?.attachments.find((x) => x.id === att && ID_PATTERN.test(att));
		if (!r || !file || !canDownload(a)) return show(TABS.requests, { toast: { message: "That file is no longer kept.", type: "info" } });
		const token = await grant(kv, "dl", { request: r.id, att: file.id }, DOWNLOAD_MS, d.now());
		ctx.log?.info("change-requests: download link", { request: r.id });
		return open(r.id, { download: { url: `${origin}/_emdash/api/plugins/${CR_PLUGIN.id}/file?token=${token}`, name: file.name } });
	}

	return show();
}

function deliveryOf(d: Deps, o: ChangeRequestsOptions, ctx: Ctx, log: DeliveryLog[]): NonNullable<PageData["delivery"]> {
	const mail = mailReady(d.env, ctx.email);
	const hook = webhookReady(o.webhook, d.env, WEBHOOK_SECRET);
	return {
		email: mail.ok ? "Ready" : `Off: ${mail.reason}`,
		webhook: hook.ok ? `On (${new URL(hook.url).host}, signed)` : o.webhook ? `Off: ${hook.reason}` : "Not configured",
		log,
		retentionMonths: o.retentionMonths ?? DEFAULT_RETENTION_MONTHS,
		agencyTo: o.agencyTo.length,
	};
}

// ── Editor panel ─────────────────────────────────────────────────────────────────────────────────────────────────

async function handlePanel(ctx: Ctx, o: ChangeRequestsOptions, d: Deps, domains: string[]): Promise<Out> {
	const a = actorOf(ctx.user, domains);
	const entry = ctx.ui?.entry;
	if (a.role < EDITOR_ROLE) return { blocks: [{ type: "context", text: "Editors and admins can ask the agency for changes here." }] };
	if (!entry) return { blocks: [{ type: "context", text: "Save the page once to request a change on it." }] };
	const item = await ctx.content?.get(entry.collection, entry.id).catch(() => null);
	const title = item ? (typeof item.data.title === "string" && item.data.title.trim() ? item.data.title.trim() : (item.slug ?? item.id)).slice(0, 100) : "This page";
	const ref: PageRef = { collection: entry.collection, id: entry.id, title };
	const here = async () => (await listRequests(ctx.kv)).filter((r) => isOpen(r.status) && r.page?.collection === entry.collection && r.page.id === entry.id);
	const i = (ctx.input ?? {}) as Interaction;
	const origin = originOf(ctx, o);
	if (i.type === "form_submit" && i.action_id === "panel-create") {
		const v = i.values ?? {};
		const res = validateNew({ ...v, page: `${ref.collection}:${ref.id}`, priority: v.urgent === true ? "urgent" : "normal", contact: "admin", notify: true }, [ref]);
		if (!res.ok) return { blocks: panel({ here: await here(), title, sensitive: !!o.sensitive, attachUrl: attachLink(origin), errors: res.errors }) };
		const r = newRequest(res.value, a, { id: randomId(), number: await nextNumber(ctx.kv, await listRequests(ctx.kv)), now: d.now() });
		await putRequest(ctx.kv, r);
		await setTicket(ctx.kv, userKey(a), r.id, d.now());
		ctx.log?.info("change-requests: created (panel)", { request: r.id, number: r.number });
		await notify(ctx, d, o, r, a, { kind: "created" }, origin);
		return { blocks: panel({ here: await here(), title, sensitive: !!o.sensitive, sent: r, attachUrl: attachLink(origin) }), toast: { message: `Request #${r.number} sent.`, type: "success" } };
	}
	return { blocks: panel({ here: await here(), title, sensitive: !!o.sensitive, attachUrl: attachLink(origin) }) };
}
