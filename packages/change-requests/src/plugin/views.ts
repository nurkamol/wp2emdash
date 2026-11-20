/**
 * Change requests: Block Kit views (plain JSON, shapes from @emdash-cms/blocks 1.5) — the page (list, form, one
 * request), the dashboard widget and the editor panel. Text from people is shown as plain text, never markup.
 */
import { PAGE } from "../meta.js";
import { type Actor, allowedMoves, ANYWHERE, canAttach, canComment, type ChangeRequest, CONTACT_LABEL, type Filter, isOpen, isRequester, latestChanges, LIMITS, moveLabel, type PageRef, STATUS_LABEL, STATUSES, type TimelineEvent } from "../model.js";

export type Block = Record<string, unknown>;
export type Notice = { title: string; description?: string; variant?: "default" | "alert" | "error" };

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const where = (r: ChangeRequest) => `${r.page ? r.page.title : "Anywhere"}${r.section ? ` — ${r.section}` : ""}`;
const badge = (r: ChangeRequest) => STATUS_LABEL[r.status];

export interface PageData {
	actor: Actor;
	list: ChangeRequest[];
	filtered: ChangeRequest[];
	filter: Filter;
	pages: PageRef[];
	sensitive: boolean;
	/** Absolute URL of the upload page (opens in a new tab). */
	attachUrl: string;
	delivery?: { email: string; webhook: string; log: { at: string; what: string; ok: boolean; reason?: string }[]; retentionMonths: number; agencyTo: number };
	notice?: Notice;
	/** Prefill the form after a validation error. */
	draft?: Record<string, unknown>;
}

export const TABS = { requests: 0, new: 1, delivery: 2 } as const;

function listTab(d: PageData): Block[] {
	const open = d.list.filter((r) => isOpen(r.status)).length;
	return [
		{
			type: "form",
			block_id: "filter",
			fields: [
				{ type: "select", action_id: "status", label: "Status", options: [{ label: "Open", value: "open" }, { label: "All", value: "all" }, ...STATUSES.map((s) => ({ label: STATUS_LABEL[s], value: s }))], initial_value: d.filter.status },
				{ type: "select", action_id: "priority", label: "Priority", options: [{ label: "Any", value: "any" }, { label: "Urgent", value: "urgent" }, { label: "Normal", value: "normal" }], initial_value: d.filter.priority },
				{ type: "checkbox", action_id: "mine", label: "Only mine", options: [{ label: "Only requests I sent", value: "mine" }], initial_value: d.filter.mine ? ["mine"] : [] },
			],
			submit: { label: "Filter", action_id: "filter" },
		},
		{
			type: "table",
			block_id: "requests",
			page_action_id: "noop",
			empty_text: d.list.length ? "No request matches this filter." : "No requests yet. Use “Request a change” to send the first one.",
			columns: [
				{ key: "n", label: "#" },
				{ key: "title", label: "Request" },
				{ key: "where", label: "Where" },
				{ key: "priority", label: "Priority", format: "badge" },
				{ key: "status", label: "Status", format: "badge" },
				{ key: "by", label: "From" },
				{ key: "updated", label: "Updated", format: "relative_time" },
				{ key: "open", label: "", format: "element" },
			],
			rows: d.filtered.slice(0, 100).map((r) => ({ n: `#${r.number}`, title: r.title, where: where(r), priority: r.priority === "urgent" ? "Urgent" : "Normal", status: badge(r), by: r.requester.name, updated: r.updatedAt, open: { type: "button", action_id: "open", label: "Open", value: r.id } })),
		},
		{ type: "context", text: `${plural(open, "open request")} · ${plural(d.list.length, "request")} in all. Closed requests are kept for ${d.delivery?.retentionMonths ?? 12} months.` },
	];
}

export function newForm(d: Pick<PageData, "pages" | "sensitive" | "draft">): Block[] {
	const v = d.draft ?? {};
	return [
		{ type: "context", text: "Tell us what to change. One request per change works best. After sending, you can add up to 3 screenshots or PDF files, and follow the status here." },
		...(d.sensitive ? [{ type: "banner", title: "Please do not include personal information", description: "This site handles sensitive information. Describe the change without names, health, legal or financial details of clients or visitors.", variant: "alert" }] : []),
		{
			type: "form",
			block_id: "new",
			fields: [
				{ type: "text_input", action_id: "title", label: `Title (up to ${LIMITS.title} characters)`, placeholder: "e.g. Update the opening hours on the Contact page", initial_value: typeof v.title === "string" ? v.title : "" },
				{ type: "text_input", action_id: "description", label: `What should change? (up to ${LIMITS.description} characters)`, multiline: true, placeholder: "What is there now, what it should be, and anything we should know.", initial_value: typeof v.description === "string" ? v.description : "" },
				{ type: "combobox", action_id: "page", label: "Which page?", options: [{ label: "Anywhere on the site / not one page", value: ANYWHERE }, ...d.pages.map((p) => ({ label: p.title, value: `${p.collection}:${p.id}` }))], initial_value: typeof v.page === "string" ? v.page : ANYWHERE },
				{ type: "text_input", action_id: "section", label: "Which part of the page? (optional)", placeholder: "e.g. the price table, the footer, the second photo", initial_value: typeof v.section === "string" ? v.section : "" },
				{ type: "radio", action_id: "priority", label: "Priority", options: [{ label: "Normal", value: "normal" }, { label: "Urgent (something is wrong on the live site)", value: "urgent" }], initial_value: v.priority === "urgent" ? "urgent" : "normal" },
				{ type: "radio", action_id: "contact", label: "How should we get back to you?", options: (["admin", "email", "phone"] as const).map((c) => ({ label: CONTACT_LABEL[c], value: c })), initial_value: typeof v.contact === "string" ? v.contact : "admin" },
				{ type: "toggle", action_id: "notify", label: "Email me when the status changes or you reply", initial_value: v.notify !== false },
			],
			submit: { label: "Send request", action_id: "create" },
		},
	];
}

function deliveryTab(d: PageData): Block[] {
	const x = d.delivery;
	if (!x) return [];
	return [
		{
			type: "fields",
			fields: [
				{ label: "New-request emails to the agency", value: x.agencyTo ? `${plural(x.agencyTo, "address")}; ${x.email}` : "No agency address configured (kit.config changeRequests.agencyTo)" },
				{ label: "Emails to requesters", value: x.email },
				{ label: "Webhook", value: x.webhook },
				{ label: "Closed requests kept", value: `${x.retentionMonths} months, then deleted with their files` },
			],
		},
		{
			type: "table",
			block_id: "log",
			page_action_id: "noop",
			empty_text: "Nothing sent yet.",
			columns: [
				{ key: "at", label: "When", format: "relative_time" },
				{ key: "what", label: "What" },
				{ key: "result", label: "Result" },
			],
			rows: x.log.map((e) => ({ at: e.at, what: e.what, result: e.ok ? "Sent" : `Not sent: ${e.reason ?? "error"}` })),
		},
		{ type: "context", text: "Addresses and the webhook are set by your developer (kit.config changeRequests). Messages hold only the request itself and a link to it here." },
	];
}

export function page(d: PageData, tab: number = TABS.requests): Block[] {
	const open = d.list.filter((r) => isOpen(r.status)).length;
	return [
		{ type: "header", text: "Change requests" },
		...(d.notice ? [{ type: "banner", ...d.notice }] : []),
		{
			type: "tab",
			default_tab: tab,
			panels: [{ label: `Requests${open ? ` (${open} open)` : ""}`, blocks: listTab(d) }, { label: "Request a change", blocks: newForm(d) }, ...(d.actor.agency && d.delivery ? [{ label: "Delivery", blocks: deliveryTab(d) }] : [])],
		},
	];
}

const eventText = (e: TimelineEvent) => {
	if (e.kind === "created") return "Sent the request";
	if (e.kind === "attachment") return `Added a file: ${e.text ?? ""}`;
	if (e.kind === "status") return `${e.reason === "withdrawn" ? "Withdrew the request" : `Status: ${e.from ? STATUS_LABEL[e.from] : ""} → ${e.to ? STATUS_LABEL[e.to] : ""}`}${e.text ? ` — ${e.text}` : ""}`;
	return e.text ?? "";
};

export interface DetailData {
	actor: Actor;
	attachUrl: string;
	notice?: Notice;
	download?: { url: string; name: string };
	now?: number;
}

/** One request: details, files, timeline, the reply form and the moves this person may make. */
export function detail(r: ChangeRequest, d: DetailData): Block[] {
	const moves = allowedMoves(d.actor, r, d.now);
	const mine = isRequester(d.actor, r);
	const comment = canComment(d.actor, r);
	return [
		{ type: "header", text: `#${r.number} ${r.title}` },
		...(d.notice ? [{ type: "banner", ...d.notice }] : []),
		...(d.download ? [{ type: "banner", title: `Download ready: ${d.download.name}`, description: "The link works once, for 5 minutes.", variant: "default" }, { type: "actions", elements: [{ type: "link", label: `Download ${d.download.name}`, target: { kind: "external", url: d.download.url }, appearance: "primary" }] }] : []),
		{
			type: "fields",
			fields: [
				{ label: "Status", value: STATUS_LABEL[r.status] },
				{ label: "Priority", value: r.priority === "urgent" ? "Urgent" : "Normal" },
				{ label: "Where", value: where(r) },
				{ label: "From", value: r.requester.name },
				{ label: "Get back by", value: CONTACT_LABEL[r.contact] },
				{ label: "Sent", value: `${r.createdAt.slice(0, 16).replace("T", " ")} UTC` },
			],
		},
		{ type: "section", text: r.description },
		...(r.page ? [{ type: "actions", elements: [{ type: "link", label: `Open “${r.page.title}” in the editor`, target: { kind: "content", collection: r.page.collection, id: r.page.id }, appearance: "secondary" }] }] : []),
		{ type: "header", text: `Files (${r.attachments.length}/${LIMITS.attachments})` },
		{
			type: "table",
			block_id: "files",
			page_action_id: "noop",
			empty_text: "No files attached.",
			columns: [
				{ key: "name", label: "File" },
				{ key: "size", label: "Size" },
				{ key: "by", label: "Added by" },
				{ key: "get", label: "", format: "element" },
			],
			rows: r.attachments.map((a) => ({ name: a.name, size: kb(a.size), by: a.by, get: { type: "button", action_id: "download", label: "Download", value: `${r.id}|${a.id}` } })),
		},
		...(canAttach(d.actor, r) ? [{ type: "actions", elements: [{ type: "button", action_id: "attach", label: "Add screenshots or PDF files…", style: "secondary", value: r.id }] }] : []),
		{ type: "header", text: "Timeline" },
		{
			type: "table",
			block_id: "timeline",
			page_action_id: "noop",
			columns: [
				{ key: "at", label: "When", format: "relative_time" },
				{ key: "by", label: "Who" },
				{ key: "what", label: "What" },
			],
			rows: r.timeline.map((e) => ({ at: e.at, by: `${e.by}${e.agency ? " (agency)" : ""}`, what: eventText(e) })),
		},
		...(comment || moves.length
			? [
					{
						type: "form",
						block_id: "reply",
						fields: [
							...(comment ? [{ type: "text_input", action_id: "text", label: d.actor.agency ? "Reply (the client sees it here and by email if they asked)" : "Comment", multiline: true, initial_value: "" }] : []),
							...(moves.length ? [{ type: "select", action_id: "status", label: "Status", options: [{ label: `Keep: ${STATUS_LABEL[r.status]}`, value: "" }, ...moves.map((m) => ({ label: moveLabel(d.actor, m), value: m }))], initial_value: "" }] : []),
						],
						submit: { label: comment ? "Send" : "Change status", action_id: `reply:${r.id}` },
					},
				]
			: [{ type: "context", text: "This request is closed." }]),
		{
			type: "actions",
			elements: [
				{ type: "button", action_id: "back", label: "← All requests", style: "secondary" },
				...(mine ? [{ type: "button", action_id: r.notify ? "mute" : "unmute", label: r.notify ? "Stop update emails" : "Email me updates", style: "secondary", value: r.id }] : []),
			],
		},
	];
}

/** After "Add files…": the upload page opens in a new tab with this request chosen. */
export function attachView(r: ChangeRequest, url: string): Block[] {
	return [
		{ type: "header", text: `Add files to #${r.number} ${r.title}` },
		{ type: "context", text: `Up to ${LIMITS.attachments} files per request (${r.attachments.length} so far): PNG, JPEG, GIF, WebP or PDF, up to ${LIMITS.attachmentBytes / 1024 / 1024} MB each. They are stored privately: only signed-in editors and admins can download them. Screenshots can be pasted on the upload page.` },
		{ type: "actions", elements: [{ type: "link", label: "Open the upload page", target: { kind: "external", url }, appearance: "primary" }, { type: "button", action_id: "open", label: "Back to the request", style: "secondary", value: r.id }] },
	];
}

export function widget(list: ChangeRequest[]): Block[] {
	const open = list.filter((r) => isOpen(r.status));
	const changes = latestChanges(list, 5);
	return [
		{ type: "stats", items: [{ label: "Open requests", value: open.length }, { label: "Urgent", value: open.filter((r) => r.priority === "urgent").length }, { label: "Waiting for you", value: open.filter((r) => r.status === "waiting").length }] },
		...(changes.length
			? [
					{
						type: "table",
						block_id: "latest",
						page_action_id: "noop",
						columns: [
							{ key: "req", label: "Request" },
							{ key: "what", label: "Now" },
							{ key: "at", label: "", format: "relative_time" },
						],
						rows: changes.map(({ request, event }) => ({ req: `#${request.number} ${request.title}`.slice(0, 60), what: event.kind === "created" ? "Sent" : event.to ? STATUS_LABEL[event.to] : "", at: event.at })),
					},
				]
			: [{ type: "context", text: "No requests yet." }]),
		{ type: "actions", elements: [{ type: "link", label: "Change requests", target: { kind: "plugin-page", path: PAGE }, appearance: "secondary" }] },
	];
}

/** The editor panel: this page's open requests and a short form with the page chosen. */
export function panel(o: { here: ChangeRequest[]; title: string; sensitive: boolean; sent?: ChangeRequest; attachUrl: string; errors?: string[] }): Block[] {
	return [
		...(o.sent ? [{ type: "banner", title: `Sent as #${o.sent.number}`, description: "Follow it under Plugins → Change requests.", variant: "default" }, { type: "actions", elements: [{ type: "link", label: "Add screenshots…", target: { kind: "external", url: o.attachUrl }, appearance: "secondary" }] }] : []),
		...(o.errors?.length ? [{ type: "banner", title: "Not sent", description: o.errors.join(" "), variant: "error" }] : []),
		...(o.here.length ? [{ type: "context", text: `Open requests for this page: ${o.here.map((r) => `#${r.number} ${r.title} (${STATUS_LABEL[r.status]})`).join("; ")}` }] : [{ type: "context", text: "Something to change on this page? Ask your agency here." }]),
		...(o.sensitive ? [{ type: "context", text: "Please leave out personal information about clients or visitors." }] : []),
		{
			type: "form",
			block_id: "panel",
			fields: [
				{ type: "text_input", action_id: "title", label: "Title", placeholder: `e.g. Change the photo on “${o.title}”` },
				{ type: "text_input", action_id: "description", label: "What should change?", multiline: true },
				{ type: "text_input", action_id: "section", label: "Which part? (optional)" },
				{ type: "toggle", action_id: "urgent", label: "Urgent", initial_value: false },
			],
			submit: { label: "Request this change", action_id: "panel-create" },
		},
		{ type: "actions", elements: [{ type: "link", label: "All change requests", target: { kind: "plugin-page", path: PAGE }, appearance: "secondary" }] },
	];
}

export const editorsOnly: Block[] = [{ type: "banner", title: "Editors and admins only", description: "Ask a site admin for access to Change requests.", variant: "error" }];
