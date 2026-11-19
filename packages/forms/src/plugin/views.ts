/**
 * Form messages: Block Kit views (plain JSON, shapes from @emdash-cms/blocks 1.5). Visitor text is only ever placed in
 * plain-text fields, which the admin renders escaped.
 */
import type { DayCount, outboxStatus, Queued, Summary } from "../outbox.js";
import type { Activity } from "./data.js";

export type Block = Record<string, unknown>;
type Status = ReturnType<typeof outboxStatus>;

export const PAGE = "/messages";
export const WIDGET = "form-messages";
export const TABS = { inbox: 0, insights: 1, transfer: 2, activity: 3 } as const;

export interface Filter {
	q?: string;
	form?: string;
	show?: "all" | "unread" | "read";
	sort?: { key: string; dir: "asc" | "desc" };
}

const STATUS: Record<Status, { title: string; description: string; variant: "default" | "alert" }> = {
	held: { title: "Email on hold", description: "New messages are kept here and none are emailed until a working email account is connected.", variant: "alert" },
	"no-email": { title: "Email is not set up", description: "New messages are kept here until the site can send email, then emailed automatically.", variant: "alert" },
	ready: { title: "Email is working", description: "Waiting messages are emailed automatically every 5 minutes. You can also email one now.", variant: "default" },
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const sender = (s: { from?: string; email?: string }) => (s.from && s.email ? `${s.from} <${s.email}>` : (s.from ?? s.email ?? "No reply address"));
const age = (iso: string) => {
	const h = Math.max(0, (Date.now() - Date.parse(iso)) / 3_600_000);
	return h < 1 ? "under an hour" : h < 48 ? plural(Math.floor(h), "hour") : plural(Math.floor(h / 24), "day");
};
export const longDate = (iso: string) => {
	const d = new Date(iso);
	return Number.isNaN(d.getTime()) ? iso : `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
};

export interface Overview {
	status: Status;
	items: { key: string; s: Summary }[];
	more: boolean;
	counts: DayCount[];
	activity: Activity[];
	days: number;
	forms: string[];
	filter: Filter;
	/** Keys matching a full-text search (message bodies), when one was asked. */
	matches?: Set<string>;
	download?: { url: string; name: string };
	importReport?: string[];
}

/** The inbox rows the filter shows, in display order. */
export function filtered(o: Overview) {
	const f = o.filter;
	let rows = o.items.filter(({ key, s }) => (!f.form || f.form === "all" || s.form === f.form) && (f.show === "unread" ? !s.read : f.show === "read" ? !!s.read : true) && (!o.matches || o.matches.has(key)));
	const dir = f.sort?.dir === "asc" ? 1 : -1;
	const by = f.sort?.key ?? "received";
	const val = (s: Summary) => (by === "from" ? sender(s).toLowerCase() : by === "subject" ? (s.subject ?? "").toLowerCase() : by === "form" ? s.form : by === "status" ? (s.read ? "1" : "0") : s.at);
	rows = [...rows].sort((a, b) => (val(a.s) < val(b.s) ? -dir : val(a.s) > val(b.s) ? dir : a.key < b.key ? -dir : a.key > b.key ? dir : 0));
	return rows;
}

function inbox(o: Overview): Block[] {
	const unread = o.items.filter((i) => !i.s.read).length;
	const oldest = o.items[0]?.s.at;
	const rows = filtered(o);
	const filtering = !!(o.filter.q || (o.filter.form && o.filter.form !== "all") || (o.filter.show && o.filter.show !== "all"));
	const ready = o.status === "ready";
	return [
		{ type: "banner", ...STATUS[o.status] },
		{
			type: "stats",
			items: [
				{ label: "Waiting", value: o.items.length + (o.more ? "+" : ""), description: "in the outbox" },
				{ label: "Unread", value: unread, ...(unread ? { trend: "up" } : {}) },
				{ label: "Oldest waiting", value: oldest ? age(oldest) : "—" },
				{ label: "Kept for", value: plural(o.days, "day"), description: "then deleted automatically" },
			],
		},
		{
			type: "form",
			block_id: "filter",
			fields: [
				{ type: "text_input", action_id: "q", label: "Search", placeholder: "Name, email, subject or message", ...(o.filter.q ? { initial_value: o.filter.q } : {}) },
				{ type: "select", action_id: "form", label: "Form", options: [{ label: "All forms", value: "all" }, ...o.forms.map((f) => ({ label: f, value: f }))], initial_value: o.filter.form ?? "all" },
				{ type: "select", action_id: "show", label: "Show", options: [{ label: "All messages", value: "all" }, { label: "Unread", value: "unread" }, { label: "Read", value: "read" }], initial_value: o.filter.show ?? "all" },
			],
			submit: { label: "Apply", action_id: "filter" },
		},
		...(filtering ? [{ type: "context", text: `${plural(rows.length, "message")} match. Clear the search and choose "All" to see everything.` }] : []),
		{
			type: "table",
			block_id: "messages",
			page_action_id: "sort",
			empty_text: filtering ? "No messages match." : "No messages are waiting. New ones appear here when email cannot be sent.",
			columns: [
				{ key: "status", label: "Status", format: "badge", sortable: true },
				{ key: "received", label: "Received", format: "relative_time", sortable: true },
				{ key: "from", label: "From", sortable: true },
				{ key: "subject", label: "Subject", sortable: true },
				{ key: "form", label: "Form", format: "code", sortable: true },
				{ key: "open", label: "", format: "element" },
			],
			rows: rows.map(({ key, s }) => ({ status: s.noEmail ? "Archived" : s.read ? "Read" : "New", received: s.at, from: sender(s), subject: s.subject ?? "", form: s.form, open: { type: "button", action_id: "open", label: "Open", value: key } })),
		},
		...(o.more ? [{ type: "context", text: "Only the oldest 1,000 messages are listed. Email or delete some to see the rest." }] : []),
		...(o.items.length
			? [
					{
						type: "actions",
						elements: [
							...(unread ? [{ type: "button", action_id: "read-all", label: `Mark ${plural(unread, "message")} as read`, style: "secondary" }] : []),
							...(ready ? [{ type: "button", action_id: "send-all", label: "Email all now", style: "primary", confirm: { title: "Email every waiting message?", text: `${plural(o.items.filter((i) => !i.s.noEmail).length, "message")} will be emailed to the site's recipients and then removed from the outbox.`, confirm: "Email them", deny: "Cancel" } }] : []),
							{ type: "button", action_id: "delete-all", label: filtering ? `Delete ${plural(rows.length, "shown message")}` : "Delete all", style: "danger", value: filtering ? { scope: "shown", filter: { q: o.filter.q, form: o.filter.form, show: o.filter.show } } : { scope: "all" }, confirm: { title: filtering ? "Delete the shown messages?" : "Delete every message?", text: `${plural(filtering ? rows.length : o.items.length, "message")} will be removed and cannot be recovered. Export them first if you need a copy.`, confirm: "Delete", deny: "Keep them", style: "danger" } },
						],
					},
				]
			: []),
	];
}

function lastDays(n: number): string[] {
	const out: string[] = [];
	for (let i = n - 1; i >= 0; i--) out.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10));
	return out;
}

function insights(o: Overview): Block[] {
	const days = lastDays(30);
	const total = (outcome?: string) => o.counts.filter((c) => !outcome || c.outcome === outcome).reduce((n, c) => n + c.count, 0);
	if (!o.counts.length)
		return [
			{ type: "empty", title: "No data yet", description: "Charts fill in as visitors send messages. Only a count per day and form is kept — nothing anyone wrote.", size: "base" },
		];
	const perDay = (outcome: string) => days.map((d) => [Date.parse(`${d}T12:00:00Z`), o.counts.filter((c) => c.day === d && c.outcome === outcome).reduce((n, c) => n + c.count, 0)] as [number, number]);
	const byDay = new Map<string, number>();
	for (const c of o.counts) byDay.set(c.day, (byDay.get(c.day) ?? 0) + c.count);
	const busiest = [...byDay.entries()].sort((a, b) => b[1] - a[1])[0];
	const last7 = o.counts.filter((c) => c.day >= (days[23] as string)).reduce((n, c) => n + c.count, 0);
	const forms = [...new Set(o.counts.map((c) => c.form))].sort();
	const first = [...o.counts].sort((a, b) => (a.day < b.day ? -1 : 1))[0]?.day;
	return [
		{
			type: "stats",
			items: [
				{ label: "Messages, 30 days", value: total() },
				{ label: "Last 7 days", value: last7 },
				{ label: "Emailed right away", value: total("emailed") },
				{ label: "Kept in the outbox", value: total("kept"), ...(total("kept") ? { description: "email was not available" } : {}) },
			],
		},
		{
			type: "chart",
			config: {
				chart_type: "timeseries",
				style: "bar",
				height: 280,
				x_axis_name: "Day",
				y_axis_name: "Messages",
				series: [
					{ name: "Emailed right away", data: perDay("emailed") },
					{ name: "Kept in the outbox", data: perDay("kept") },
				],
			},
		},
		...(forms.length > 1
			? [
					{
						type: "chart",
						config: {
							chart_type: "custom",
							height: 260,
							options: { tooltip: { trigger: "item" }, legend: { bottom: 0 }, series: [{ type: "pie", radius: ["45%", "70%"], data: forms.map((f) => ({ name: f, value: o.counts.filter((c) => c.form === f).reduce((n, c) => n + c.count, 0) })) }] },
						},
					},
				]
			: []),
		{
			type: "table",
			block_id: "by-form",
			page_action_id: "noop",
			columns: [
				{ key: "form", label: "Form", format: "code" },
				{ key: "total", label: "Messages, 30 days", format: "number" },
				{ key: "kept", label: "Kept", format: "number" },
				{ key: "waiting", label: "Waiting now", format: "number" },
			],
			rows: forms.map((f) => ({ form: f, total: o.counts.filter((c) => c.form === f).reduce((n, c) => n + c.count, 0), kept: o.counts.filter((c) => c.form === f && c.outcome === "kept").reduce((n, c) => n + c.count, 0), waiting: o.items.filter((i) => i.s.form === f).length })),
		},
		{ type: "context", text: `${busiest ? `Busiest day: ${busiest[0]} (${plural(busiest[1], "message")}). ` : ""}Counts only — nothing a visitor wrote is kept for these charts.${first ? ` Counting since ${first}.` : ""}` },
	];
}

function transfer(o: Overview): Block[] {
	return [
		{ type: "header", text: "Export" },
		{ type: "context", text: "Download the waiting messages as a spreadsheet (CSV) or as a backup file (JSON) to import later. The file contains visitors' names and contact details: keep it somewhere private and delete it when you no longer need it." },
		...(o.download
			? [
					{ type: "banner", title: "Your download is ready", description: "The link works once, for the next 2 minutes.", variant: "default" },
					{ type: "actions", elements: [{ type: "link", label: `Download ${o.download.name}`, target: { kind: "external", url: o.download.url }, appearance: "primary" }] },
				]
			: []),
		{
			type: "form",
			block_id: "export",
			fields: [
				{ type: "select", action_id: "format", label: "Format", options: [{ label: "Spreadsheet (CSV, opens in Excel or Google Sheets)", value: "csv" }, { label: "Backup (JSON, for importing)", value: "json" }], initial_value: "csv" },
				{ type: "select", action_id: "scope", label: "Messages", options: [{ label: `All waiting (${o.items.length})`, value: "all" }, { label: `Unread only (${o.items.filter((i) => !i.s.read).length})`, value: "unread" }], initial_value: "all" },
			],
			submit: { label: "Create download link", action_id: "export" },
		},
		{ type: "divider" },
		{ type: "header", text: "Import" },
		{ type: "context", text: "Paste a file exported from this page (CSV or JSON), for example to move messages from staging to the live site or to restore a backup. Messages already here are skipped, so importing the same file twice is safe. Up to 1,000 messages at a time." },
		...(o.importReport?.length ? [{ type: "accordion", label: "Import report", default_open: true, blocks: o.importReport.slice(0, 50).map((text) => ({ type: "context", text })) }] : []),
		{
			type: "form",
			block_id: "import",
			fields: [
				{ type: "text_input", action_id: "data", label: "Exported file contents", placeholder: "Open the exported file in a text editor, copy everything and paste it here", multiline: true },
				{ type: "toggle", action_id: "email", label: "Email imported messages", description: "Off: they are kept for reference and never emailed. On: they are emailed once email works, like new messages.", initial_value: false },
				{ type: "toggle", action_id: "read", label: "Mark them as read", initial_value: true },
			],
			submit: { label: "Import messages", action_id: "import" },
		},
	];
}

function activity(o: Overview): Block[] {
	return [
		{
			type: "table",
			block_id: "activity",
			page_action_id: "noop",
			empty_text: "Nothing yet. Opening, emailing, deleting, exporting and importing messages is recorded here.",
			columns: [
				{ key: "at", label: "When", format: "relative_time" },
				{ key: "who", label: "Admin" },
				{ key: "action", label: "What" },
				{ key: "count", label: "Messages", format: "number" },
			],
			rows: o.activity.map((a) => ({ at: a.at, who: a.who, action: a.action, count: a.count ?? "" })),
		},
		{ type: "context", text: "Kept for 180 days. Records who did what and how many messages it touched — never message content." },
	];
}

export function overview(o: Overview, tab: number = TABS.inbox): Block[] {
	return [
		{ type: "header", text: "Form messages" },
		{
			type: "tab",
			default_tab: tab,
			panels: [
				{ label: `Inbox${o.items.length ? ` (${o.items.length})` : ""}`, blocks: inbox(o) },
				{ label: "Insights", blocks: insights(o) },
				{ label: "Import & export", blocks: transfer(o) },
				{ label: "Activity", blocks: activity(o) },
			],
		},
	];
}

export function message(key: string, q: Queued, status: Status): Block[] {
	const lines = q.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 300);
	const canEmail = status === "ready" && !q.noEmail;
	return [
		{ type: "header", text: q.subject },
		{ type: "context", text: `Received ${longDate(q.at)} · form ${q.form}${q.source === "import" ? " · imported" : ""}` },
		...(q.noEmail ? [{ type: "banner", title: "Kept for reference", description: "Imported without email: this message is never emailed automatically.", variant: "default" }] : []),
		{
			type: "fields",
			fields: [
				{ label: "Name", value: q.replyTo?.name ?? "—" },
				{ label: "Email", value: q.replyTo?.email ?? "—" },
				{ label: "Status", value: q.readAt ? `Read ${longDate(q.readAt)}` : "New" },
				{ label: "Email attempts", value: String(q.attempts) },
			],
		},
		{ type: "divider" },
		...lines.map((text) => ({ type: "section", text })),
		{ type: "divider" },
		{
			type: "actions",
			elements: [
				{ type: "button", action_id: "back", label: "← Back to inbox", style: "secondary" },
				{ type: "button", action_id: "unread", label: "Mark as unread", style: "secondary", value: key },
				...(canEmail ? [{ type: "button", action_id: "send", label: "Email it now", style: "primary", value: key }] : []),
				...(q.replyTo?.email ? [{ type: "link", label: "Reply by email", target: { kind: "external", url: `mailto:${encodeURIComponent(q.replyTo.email)}?subject=${encodeURIComponent(`Re: ${q.subject}`)}` }, appearance: "secondary" }] : []),
				{ type: "button", action_id: "delete", label: "Delete", style: "danger", value: key, confirm: { title: "Delete this message?", text: "It is removed from the outbox and cannot be recovered.", confirm: "Delete", deny: "Keep it", style: "danger" } },
			],
		},
	];
}

export function widget(o: Pick<Overview, "items" | "counts" | "status">): Block[] {
	const since = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
	const last7 = o.counts.filter((c) => c.day >= since).reduce((n, c) => n + c.count, 0);
	const unread = o.items.filter((i) => !i.s.read).length;
	return [
		{ type: "stats", items: [{ label: "Waiting", value: o.items.length }, { label: "Unread", value: unread }, { label: "Last 7 days", value: last7 }] },
		...(o.status !== "ready" && o.items.length ? [{ type: "context", text: STATUS[o.status].title }] : []),
		{ type: "actions", elements: [{ type: "link", label: "Open form messages", target: { kind: "plugin-page", path: PAGE }, appearance: "secondary" }] },
	];
}

export const adminsOnly: Block[] = [{ type: "banner", title: "Admins only", description: "Ask a site admin for access to form messages.", variant: "error" }];
