/**
 * Form messages: Block Kit views (plain JSON, shapes from @emdash-cms/blocks 1.5). Visitor text is only ever placed in
 * plain-text fields, which the admin renders escaped.
 */
import { CHANNEL_NAME, CHANNEL_SECRET, CHANNELS, type Channel, type ChatSettings } from "../chat.js";
import { type CrmEnv, type CrmForm, type CrmSettings, fieldFits, formSetting, type LastError, NAMED_FIELDS, PROVIDER_NAME, PROVIDER_SECRET, PROVIDERS, type Provider, TARGET_LABEL, TARGETS, unavailable } from "../crm.js";
import { type DayCount, type Delivery, deliveryOf, MAX_RECIPIENTS, type OutboxStatus, type Queued, type Summary } from "../outbox.js";
import { attachmentDataUrl } from "../signature.js";
import type { Activity } from "./data.js";

export type Block = Record<string, unknown>;
type Status = OutboxStatus;

export const PAGE = "/messages";
export const WIDGET = "form-messages";
export const TABS = { inbox: 0, insights: 1, transfer: 2, activity: 3, settings: 4 } as const;

const PROVIDER_NAMES: Record<string, string> = { brevo: "Brevo", resend: "Resend", postmark: "Postmark", sendgrid: "SendGrid", mailgun: "Mailgun", emdash: "EmDash (Settings → Email)" };

export interface Filter {
	q?: string;
	form?: string;
	show?: "all" | "unread" | "read";
	/** Delivery status: waiting, emailed or failed. */
	delivery?: "all" | Delivery;
	sort?: { key: string; dir: "asc" | "desc" };
}

/** What the inbox shows for a message's delivery: its status, or "archived" for an import kept without email. */
export type Shown = Delivery | "archived";
export const shownDelivery = (s: Pick<Summary, "status" | "noEmail">): Shown => (s.status === "emailed" ? "emailed" : s.noEmail ? "archived" : deliveryOf(s));
const DELIVERY_LABEL: Record<Shown, string> = { emailed: "Emailed", waiting: "Waiting", failed: "Failed", archived: "Not to email" };
/** Messages the cron (or "Email all now") still has to send. */
export const toSend = <T extends { s: Summary }>(items: T[]) => items.filter((i) => ["waiting", "failed"].includes(shownDelivery(i.s)));
export const parseDelivery = (v: unknown): Filter["delivery"] => (v === "waiting" || v === "emailed" || v === "failed" ? v : "all");

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
	/** Who form messages go to, and whether that is the admin's setting or FORM_TO; `configTo` is FORM_TO itself. */
	recipients?: { to: string[]; source: "admin" | "config" | "none"; configTo: string[]; test?: { host: string; to: string[] } };
	/** EMAIL_PROVIDER. */
	provider?: string;
	recipientErrors?: string[];
	/** Keep sent (FORM_OUTBOX_KEEP_SENT): every message is kept, also once emailed — the page is a full inbox. */
	keepSent?: boolean;
	/** Chat notifications (chat.ts): the settings, which secrets exist (never their values), recent give-ups. */
	chat?: ChatView;
	chatErrors?: string[];
	/** CRM & mailing lists (crm.ts): settings, which secrets exist (never their values), failures and last errors. */
	crm?: CrmView;
	crmErrors?: string[];
}

export interface CrmView {
	/** false: FORM_CRM="0". */
	enabled: boolean;
	/** The site handles sensitive data: unavailable. */
	sensitive: boolean;
	settings: CrmSettings;
	secrets: Record<Provider, boolean>;
	/** Brevo would use the email key (EMAIL_API_KEY, EMAIL_PROVIDER=brevo). */
	brevoEmailKey: boolean;
	forms: (CrmForm & { title: string })[];
	/** Contacts given up on in the last 7 days, per provider. */
	failures: Record<Provider, number>;
	/** Each provider's last error, scrubbed of personal data. */
	lastErrors: Partial<Record<Provider, LastError>>;
	/** Contacts waiting for a retry. */
	pending: number;
	/** What the defaults depend on (pre-selected providers, sensitivity). */
	env: Pick<CrmEnv, "FORM_CRM_PRESELECT" | "FORM_SENSITIVE">;
}

export interface ChatView {
	/** false: FORM_CHAT="0" — the feature is off for this site. */
	enabled: boolean;
	settings: ChatSettings;
	secrets: Record<Channel, boolean>;
	/** The site handles sensitive data: notification only. */
	sensitive: boolean;
	/** The site's forms for the picker (id and title). */
	forms: { id: string; title: string }[];
	/** Notifications given up on in the last 7 days, per channel. */
	failures: Record<Channel, number>;
}

/** The inbox rows the filter shows, in display order. */
export function filtered(o: Overview) {
	const f = o.filter;
	let rows = o.items.filter(({ key, s }) => (!f.form || f.form === "all" || s.form === f.form) && (f.show === "unread" ? !s.read : f.show === "read" ? !!s.read : true) && (!f.delivery || f.delivery === "all" || shownDelivery(s) === f.delivery) && (!o.matches || o.matches.has(key)));
	const dir = f.sort?.dir === "asc" ? 1 : -1;
	const by = f.sort?.key ?? "received";
	const val = (s: Summary) => (by === "from" ? sender(s).toLowerCase() : by === "subject" ? (s.subject ?? "").toLowerCase() : by === "form" ? s.form : by === "status" ? (s.read ? "1" : "0") : by === "delivery" ? shownDelivery(s) : s.at);
	rows = [...rows].sort((a, b) => (val(a.s) < val(b.s) ? -dir : val(a.s) > val(b.s) ? dir : a.key < b.key ? -dir : a.key > b.key ? dir : 0));
	return rows;
}

function inbox(o: Overview): Block[] {
	const unread = o.items.filter((i) => !i.s.read).length;
	const pending = toSend(o.items);
	const failed = pending.filter((i) => shownDelivery(i.s) === "failed").length;
	const oldest = (o.keepSent ? pending : o.items)[0]?.s.at;
	const rows = filtered(o);
	const filtering = !!(o.filter.q || (o.filter.form && o.filter.form !== "all") || (o.filter.show && o.filter.show !== "all") || (o.filter.delivery && o.filter.delivery !== "all"));
	const ready = o.status === "ready";
	const kept = { label: "Kept for", value: plural(o.days, "day"), description: "then deleted automatically" };
	return [
		{ type: "banner", ...STATUS[o.status] },
		{
			type: "stats",
			items: o.keepSent
				? [
						{ label: "In inbox", value: o.items.length + (o.more ? "+" : ""), description: "emailed or not" },
						{ label: "Waiting", value: pending.length, description: failed ? `${failed} refused by the email provider` : "to be emailed", ...(failed ? { trend: "down" } : {}) },
						{ label: "Unread", value: unread, ...(unread ? { trend: "up" } : {}) },
						kept,
					]
				: [
						{ label: "Waiting", value: o.items.length + (o.more ? "+" : ""), description: "in the outbox" },
						{ label: "Unread", value: unread, ...(unread ? { trend: "up" } : {}) },
						{ label: "Oldest waiting", value: oldest ? age(oldest) : "—" },
						kept,
					],
		},
		...(o.keepSent ? [{ type: "context", text: `Every message sent through the site's forms is kept here for ${plural(o.days, "day")}, also after it is emailed, then deleted automatically.` }] : []),
		{
			type: "form",
			block_id: "filter",
			fields: [
				{ type: "text_input", action_id: "q", label: "Search", placeholder: "Name, email, subject or message", ...(o.filter.q ? { initial_value: o.filter.q } : {}) },
				{ type: "select", action_id: "form", label: "Form", options: [{ label: "All forms", value: "all" }, ...o.forms.map((f) => ({ label: f, value: f }))], initial_value: o.filter.form ?? "all" },
				{ type: "select", action_id: "show", label: "Show", options: [{ label: "All messages", value: "all" }, { label: "Unread", value: "unread" }, { label: "Read", value: "read" }], initial_value: o.filter.show ?? "all" },
				{ type: "select", action_id: "delivery", label: "Email", options: [{ label: "All", value: "all" }, { label: "Waiting", value: "waiting" }, { label: "Emailed", value: "emailed" }, { label: "Failed", value: "failed" }], initial_value: o.filter.delivery ?? "all" },
			],
			submit: { label: "Apply", action_id: "filter" },
		},
		...(filtering ? [{ type: "context", text: `${plural(rows.length, "message")} match. Clear the search and choose "All" to see everything.` }] : []),
		{
			type: "table",
			block_id: "messages",
			page_action_id: "sort",
			empty_text: filtering ? "No messages match." : o.keepSent ? "No messages yet. Every message sent through the site's forms appears here." : "No messages are waiting. New ones appear here when email cannot be sent.",
			columns: [
				{ key: "status", label: "Status", format: "badge", sortable: true },
				{ key: "delivery", label: "Email", format: "badge", sortable: true },
				{ key: "received", label: "Received", format: "relative_time", sortable: true },
				{ key: "from", label: "From", sortable: true },
				{ key: "subject", label: "Subject", sortable: true },
				{ key: "form", label: "Form", format: "code", sortable: true },
				{ key: "open", label: "", format: "element" },
			],
			rows: rows.map(({ key, s }) => ({ status: s.noEmail ? "Archived" : s.read ? "Read" : "New", delivery: DELIVERY_LABEL[shownDelivery(s)], received: s.at, from: sender(s), subject: `${s.subject ?? ""}${s.files ? " · signature attached" : ""}`, form: s.form, open: { type: "button", action_id: "open", label: "Open", value: key } })),
		},
		...(o.more ? [{ type: "context", text: o.keepSent ? "Only the newest 1,000 messages are listed. Older ones are kept until their retention period ends." : "Only the oldest 1,000 messages are listed. Email or delete some to see the rest." }] : []),
		...(o.items.length
			? [
					{
						type: "actions",
						elements: [
							...(unread ? [{ type: "button", action_id: "read-all", label: `Mark ${plural(unread, "message")} as read`, style: "secondary" }] : []),
							...(ready && pending.length ? [{ type: "button", action_id: "send-all", label: o.keepSent ? `Email ${plural(pending.length, "waiting message")} now` : "Email all now", style: "primary", confirm: { title: "Email every waiting message?", text: `${plural(pending.length, "message")} will be emailed to the site's recipients and then ${o.keepSent ? "kept here, marked Emailed" : "removed from the outbox"}.`, confirm: "Email them", deny: "Cancel" } }] : []),
							{ type: "button", action_id: "delete-all", label: filtering ? `Delete ${plural(rows.length, "shown message")}` : "Delete all", style: "danger", value: filtering ? { scope: "shown", filter: { q: o.filter.q, form: o.filter.form, show: o.filter.show, delivery: o.filter.delivery } } : { scope: "all" }, confirm: { title: filtering ? "Delete the shown messages?" : "Delete every message?", text: `${plural(filtering ? rows.length : o.items.length, "message")} will be removed and cannot be recovered. Export them first if you need a copy.`, confirm: "Delete", deny: "Keep them", style: "danger" } },
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
				// "kept" counts messages that could not be emailed at once (also with keep sent, where every message is kept).
				{ label: "Kept in the outbox", value: total("kept"), ...(total("kept") ? { description: o.keepSent ? "not emailed right away" : "email was not available" } : {}) },
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
			rows: forms.map((f) => ({ form: f, total: o.counts.filter((c) => c.form === f).reduce((n, c) => n + c.count, 0), kept: o.counts.filter((c) => c.form === f && c.outcome === "kept").reduce((n, c) => n + c.count, 0), waiting: toSend(o.items).filter((i) => i.s.form === f).length })),
		},
		{ type: "context", text: `${busiest ? `Busiest day: ${busiest[0]} (${plural(busiest[1], "message")}). ` : ""}Counts only — nothing a visitor wrote is kept for these charts.${first ? ` Counting since ${first}.` : ""}` },
	];
}

function transfer(o: Overview): Block[] {
	return [
		{ type: "header", text: "Export" },
		{ type: "context", text: `Download the ${o.keepSent ? "messages in the inbox (with whether and when each was emailed)" : "waiting messages"} as a spreadsheet (CSV) or as a backup file (JSON) to import later. The file contains visitors' names and contact details: keep it somewhere private and delete it when you no longer need it.` },
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
				{ type: "select", action_id: "scope", label: "Messages", options: [{ label: `${o.keepSent ? "All" : "All waiting"} (${o.items.length})`, value: "all" }, { label: `Unread only (${o.items.filter((i) => !i.s.read).length})`, value: "unread" }], initial_value: "all" },
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
				{ key: "count", label: "Count", format: "number" },
			],
			rows: o.activity.map((a) => ({ at: a.at, who: a.who, action: a.action, count: a.count ?? "" })),
		},
		{ type: "context", text: "Kept for 180 days. Records who did what and how many messages (or recipients) it touched — never message content or addresses." },
	];
}

function settings(o: Overview): Block[] {
	const r = o.recipients ?? { to: [], source: "none" as const, configTo: [] };
	const provider = PROVIDER_NAMES[o.provider ?? "brevo"] ?? o.provider ?? "Brevo";
	const where = r.source === "admin" ? "set on this page" : r.source === "config" ? "the site default (FORM_TO in the site's configuration)" : "none set";
	return [
		{ type: "header", text: "Recipients" },
		{ type: "context", text: `Form messages are emailed to these addresses — new ones right away, waiting ones when they are sent from the outbox. Up to ${MAX_RECIPIENTS} addresses, one per line. Leave empty to use the site default${r.configTo.length ? ` (${r.configTo.join(", ")})` : " (none is set)"}.` },
		...(r.source === "none" ? [{ type: "banner", title: "No recipients", description: "Form messages cannot be emailed until at least one recipient is set. They are kept in the outbox meanwhile.", variant: "alert" }] : []),
		...(o.recipientErrors?.length ? [{ type: "banner", title: "Not saved", description: o.recipientErrors.slice(0, 10).join(" "), variant: "error" }] : []),
		{
			type: "form",
			block_id: "recipients",
			fields: [{ type: "text_input", action_id: "to", label: "Send form messages to", placeholder: "office@example.com", multiline: true, ...(r.source === "admin" ? { initial_value: r.to.join("\n") } : {}) }],
			submit: { label: "Save recipients", action_id: "recipients" },
		},
		{
			type: "fields",
			fields: [
				{ label: "Now sending to", value: r.to.length ? r.to.join(", ") : "Nobody" },
				{ label: "From", value: where },
				{ label: "Email service", value: provider },
			],
		},
		...(r.test ? [{ type: "context", text: `These recipients get messages sent from ${r.test.host}. Messages sent from any other address (the site's workers.dev address before launch, preview links) are tests: they go only to ${r.test.to.length ? r.test.to.join(", ") : "the test inbox (none set: they are kept here unsent)"}.` }] : []),
		{ type: "context", text: o.provider === "emdash" ? "Email goes through EmDash's own email settings (Settings → Email), with the sender address set there." : "The email service, its key and the sender address are set in the site's configuration by your developer." },
		...(o.chat ? chatSettings(o.chat, o.chatErrors) : []),
		...(o.crm ? crmSettingsView(o.crm, o.crmErrors) : []),
	];
}

const PROVIDER_HELP: Record<Provider, string> = {
	brevo: "adds or updates a Brevo contact; with a ticked opt-in also to the list you name",
	hubspot: "creates or updates a HubSpot contact (private app token with the scope crm.objects.contacts.write)",
	mailchimp: "adds or updates a member of a Mailchimp audience; subscribed only with a ticked opt-in",
};
const NAME_LABEL: Record<Provider, string> = { brevo: "attribute", hubspot: "property", mailchimp: "merge tag" };

/** Settings → CRM & mailing lists: per provider on/off (only when its secret exists), ids and names, per form providers and mapping. */
export function crmSettingsView(c: CrmView, errors?: string[]): Block[] {
	const head: Block[] = [{ type: "divider" }, { type: "header", text: "CRM & mailing lists" }];
	const why = unavailable({ ...(c.enabled ? {} : { FORM_CRM: "0" }), ...(c.sensitive ? { FORM_SENSITIVE: "1" } : {}) });
	if (why) return [...head, ...(c.sensitive ? [{ type: "banner", title: "Not available on this site", description: why, variant: "default" }] : [{ type: "context", text: `${why} Ask your developer.` }])];
	const s = c.settings;
	const missing = PROVIDERS.filter((p) => !c.secrets[p]);
	const available = PROVIDERS.filter((p) => c.secrets[p]);
	const fields: Block[] = [];
	for (const p of available) {
		fields.push({ type: "toggle", action_id: `crm_${p}_on`, label: PROVIDER_NAME[p], description: PROVIDER_HELP[p], initial_value: s[p].on });
		if (p === "brevo") fields.push({ type: "text_input", action_id: "crm_brevo_list", label: "Brevo list id for opt-ins (optional)", placeholder: "7", ...(s.brevo.listId ? { initial_value: String(s.brevo.listId) } : {}) });
		if (p === "mailchimp") {
			fields.push({ type: "text_input", action_id: "crm_mailchimp_audience", label: "Mailchimp audience id", placeholder: "a1b2c3d4e5", ...(s.mailchimp.audienceId ? { initial_value: s.mailchimp.audienceId } : {}) });
			fields.push({ type: "toggle", action_id: "crm_mailchimp_double", label: "Double opt-in", description: "Mailchimp emails a confirmation link first (status pending); recommended in the EU", initial_value: s.mailchimp.doubleOptIn });
			fields.push({ type: "select", action_id: "crm_mailchimp_unconsented", label: "Without a ticked opt-in", options: [{ label: "Do not add to Mailchimp", value: "skip" }, { label: "Add as a transactional contact (never subscribed)", value: "transactional" }], initial_value: s.mailchimp.unconsented });
		}
		if (p === "hubspot") fields.push({ type: "text_input", action_id: "crm_hubspot_consent", label: "HubSpot property set to true on a ticked opt-in (optional)", placeholder: "newsletter_opt_in", ...(s.hubspot.consentProperty ? { initial_value: s.hubspot.consentProperty } : {}) });
		for (const n of NAMED_FIELDS) fields.push({ type: "text_input", action_id: `crm_${p}_name_${n}`, label: `${PROVIDER_NAME[p]} ${NAME_LABEL[p]} for ${TARGET_LABEL[n].toLowerCase()} (empty: not sent)`, ...(s[p].names[n] ? { initial_value: s[p].names[n] } : {}) });
	}
	const formsBlocks: Block[] = [];
	for (const f of c.forms) {
		const label = f.title && f.title !== f.id ? `${f.title} (${f.id})` : f.id;
		const no = unavailable(c.env, f);
		if (no) {
			formsBlocks.push({ type: "context", text: `${label}: not available. ${no}` });
			continue;
		}
		if (!f.fields.length) continue;
		const cur = formSetting(s, c.env, f);
		const on = available.filter((p) => s[p].on);
		if (on.length) fields.push({ type: "checkbox", action_id: `crm_form_${f.id}_providers`, label: `${label}: send to`, options: on.map((p) => ({ label: PROVIDER_NAME[p], value: p })), initial_value: cur.providers.filter((p) => on.includes(p)) });
		for (const t of TARGETS) {
			const options = f.fields.filter((x) => fieldFits(t, x)).map((x) => ({ label: `${x.label} (${x.name})`, value: x.name }));
			if (!options.length) continue;
			fields.push({ type: "select", action_id: `crm_form_${f.id}_${t}`, label: `${label}: ${TARGET_LABEL[t]}`, options: [{ label: "Not sent", value: "" }, ...options], initial_value: cur.map[t] ?? "" });
		}
	}
	const failed = PROVIDERS.filter((p) => c.failures[p] > 0);
	const errorBlocks: Block[] = PROVIDERS.flatMap((p) => {
		const e = c.lastErrors[p];
		if (!e) return [];
		return [
			{ type: "banner", title: `${PROVIDER_NAME[p]}: last error`, description: `${longDate(e.at)}${e.form ? `, form ${e.form}` : ""}${e.status ? `, HTTP ${e.status}` : ""}: ${e.text}`, variant: "alert" },
			{ type: "actions", elements: [{ type: "button", action_id: "crm-clear", label: `Clear the ${PROVIDER_NAME[p]} error`, style: "secondary", value: p }] },
		];
	});
	return [
		...head,
		{ type: "context", text: "Send new form messages to a CRM or mailing list as well as by email: only the fields you map below (email, name, phone, company, message) — never the whole message, files or signatures. A contact is subscribed to marketing only when the form has an opt-in checkbox mapped and the visitor ticked it; otherwise it is added as a contact only. Sending never delays or blocks a visitor's form; a temporary failure is retried for up to a day." },
		...missing.map((p) => ({ type: "context", text: `${PROVIDER_NAME[p]} (${PROVIDER_HELP[p]}): not available yet — set the secret ${PROVIDER_SECRET[p]} with \`wrangler secret put ${PROVIDER_SECRET[p]}\` (your developer does this once), then turn it on here.` })),
		...(c.brevoEmailKey && c.secrets.brevo ? [{ type: "context", text: "Brevo uses the site's email key (EMAIL_API_KEY). Set BREVO_API_KEY to use another Brevo account or key." }] : []),
		...(errors?.length ? [{ type: "banner", title: "Not saved", description: errors.slice(0, 10).join(" "), variant: "error" }] : []),
		...formsBlocks,
		...(available.length ? [{ type: "form", block_id: "crm", fields, submit: { label: "Save CRM settings", action_id: "crm" } }] : []),
		{ type: "fields", fields: [...PROVIDERS.map((p) => ({ label: PROVIDER_NAME[p], value: !c.secrets[p] ? "Secret not set" : s[p].on ? "On" : "Off" })), { label: "Waiting for a retry", value: String(c.pending) }] },
		...(failed.length ? [{ type: "banner", title: "Some contacts could not be sent", description: `In the last 7 days: ${failed.map((p) => `${PROVIDER_NAME[p]} ${plural(c.failures[p], "contact")}`).join(", ")}. The messages themselves are in the inbox and were emailed as usual.`, variant: "alert" }] : []),
		...errorBlocks,
	];
}

const CHANNEL_HELP: Record<Channel, string> = {
	telegram: "a Telegram bot posts to a chat, group or channel",
	slack: "an incoming webhook posts to a Slack channel",
	webhook: "a JSON POST to any address: Discord, Google Chat, Microsoft Teams workflows, Make, Zapier or n8n (and through those WhatsApp)",
};

/** Settings → Chat notifications: per channel on/off (only when its secret exists), Telegram chat id, forms, content. */
export function chatSettings(c: ChatView, errors?: string[]): Block[] {
	const head: Block[] = [{ type: "divider" }, { type: "header", text: "Chat notifications" }];
	if (!c.enabled) return [...head, { type: "context", text: "Chat notifications are turned off for this site in its configuration (ask your developer)." }];
	const s = c.settings;
	const ready = (ch: Channel) => c.secrets[ch] && (ch !== "telegram" || !!s.telegram.chatId);
	const live = CHANNELS.filter((ch) => s[ch].on && ready(ch));
	const missing = CHANNELS.filter((ch) => !c.secrets[ch]);
	const failed = CHANNELS.filter((ch) => c.failures[ch] > 0);
	const fields: Block[] = [];
	if (c.secrets.telegram) {
		fields.push({ type: "toggle", action_id: "telegram_on", label: "Telegram", description: CHANNEL_HELP.telegram, initial_value: s.telegram.on });
		fields.push({ type: "text_input", action_id: "telegram_chat_id", label: "Telegram chat id", placeholder: "-1001234567890", ...(s.telegram.chatId ? { initial_value: s.telegram.chatId } : {}) });
	}
	if (c.secrets.slack) fields.push({ type: "toggle", action_id: "slack_on", label: "Slack", description: CHANNEL_HELP.slack, initial_value: s.slack.on });
	if (c.secrets.webhook) {
		fields.push({ type: "toggle", action_id: "webhook_on", label: "Webhook", description: CHANNEL_HELP.webhook, initial_value: s.webhook.on });
		fields.push({ type: "select", action_id: "webhook_format", label: "Webhook format", options: [{ label: "JSON event (Make, Zapier, n8n, Teams workflows)", value: "json" }, { label: "Text only — { text } (Google Chat, Mattermost)", value: "text" }, { label: "Discord", value: "discord" }], initial_value: s.webhook.format });
	}
	if (!c.sensitive)
		fields.push({
			type: "radio",
			action_id: "content",
			label: "What is sent",
			options: [
				{ label: "Summary: form, time, the sender's name and the start of the message (about 200 characters) — never email addresses, phone numbers or files", value: "summary" },
				{ label: "Notification only: form, time and the link — nothing the visitor wrote", value: "notice" },
			],
			initial_value: s.content,
		});
	const formIds = c.forms.map((f) => f.id);
	if (formIds.length > 1 || (s.forms !== "all" && s.forms.length)) {
		fields.push({ type: "select", action_id: "forms_scope", label: "Which forms notify", options: [{ label: "All forms", value: "all" }, { label: "Only the forms ticked below", value: "pick" }], initial_value: s.forms === "all" ? "all" : "pick" });
		fields.push({ type: "checkbox", action_id: "forms_picked", label: "Forms", options: c.forms.map((f) => ({ label: f.title && f.title !== f.id ? `${f.title} (${f.id})` : f.id, value: f.id })), initial_value: s.forms === "all" ? [] : s.forms });
	}
	return [
		...head,
		{ type: "context", text: "Get a message in a chat app when someone sends a form, with a link to it here. Nothing is sent until a channel is turned on. Sending never delays or blocks a visitor's form; a failed notification is retried a few times, then dropped (the email and this inbox are unaffected)." },
		...(c.sensitive ? [{ type: "banner", title: "Notification only", description: "This site handles sensitive information: a notification says only which form was used, when, and links here. Nothing a visitor wrote leaves the site.", variant: "default" }] : []),
		...missing.map((ch) => ({ type: "context", text: `${CHANNEL_NAME[ch]} (${CHANNEL_HELP[ch]}): not available yet — set the secret ${CHANNEL_SECRET[ch]} with \`wrangler secret put ${CHANNEL_SECRET[ch]}\` (your developer does this once), then turn it on here.` })),
		...(errors?.length ? [{ type: "banner", title: "Not saved", description: errors.slice(0, 10).join(" "), variant: "error" }] : []),
		...(missing.length < CHANNELS.length ? [{ type: "form", block_id: "chat", fields, submit: { label: "Save chat notifications", action_id: "chat" } }] : []),
		{
			type: "fields",
			fields: CHANNELS.map((ch) => ({ label: CHANNEL_NAME[ch], value: !c.secrets[ch] ? "Secret not set" : s[ch].on ? (ready(ch) ? "On" : "On, but the chat id is missing") : "Off" })),
		},
		...(failed.length ? [{ type: "banner", title: "Some notifications could not be delivered", description: `In the last 7 days, after several tries: ${failed.map((ch) => `${CHANNEL_NAME[ch]} ${plural(c.failures[ch], "notification")}`).join(", ")}. Check the channel's secret and settings, then send a test.`, variant: "alert" }] : []),
		...(live.length ? [{ type: "actions", elements: [{ type: "button", action_id: "chat-test", label: "Send a test notification", style: "secondary" }] }, { type: "context", text: "Sends a short test (no visitor data) to every channel that is on. At most once a minute." }] : []),
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
				{ label: "Settings", blocks: settings(o) },
			],
		},
	];
}

/** Where the message is on its way to the recipients, in words. */
function deliveryText(q: Queued, status: Status): string {
	const d = deliveryOf(q);
	if (d === "emailed") return `Emailed${q.emailedAt ? ` ${longDate(q.emailedAt)}` : ""}`;
	if (q.noEmail) return "Not to email (imported for reference)";
	const when = status === "ready" ? "retried automatically every 5 minutes" : status === "held" ? "email is on hold" : "email is not set up";
	return d === "failed" ? `Failed: the email provider refused it (${plural(q.attempts, "attempt")}); ${when}` : `Waiting to be emailed (${when})`;
}

export function message(key: string, q: Queued, status: Status): Block[] {
	const lines = q.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 300);
	// Any message can be emailed (again) once email works; one emailed before, or imported without email, asks first.
	const canEmail = status === "ready";
	const emailed = deliveryOf(q) === "emailed";
	const resend = emailed || !!q.noEmail;
	return [
		{ type: "header", text: q.subject },
		{ type: "context", text: `Received ${longDate(q.at)} · form ${q.form}${q.source === "import" ? " · imported" : ""}` },
		...(q.noEmail ? [{ type: "banner", title: "Kept for reference", description: "Imported without email: this message is never emailed automatically.", variant: "default" }] : []),
		...(q.test ? [{ type: "banner", title: "Test message", description: "Sent from the site's workers.dev address or a preview link, not from the live domain: it is only ever emailed to the test inbox, never to the site's recipients.", variant: "default" }] : []),
		{
			type: "fields",
			fields: [
				{ label: "Name", value: q.replyTo?.name ?? "—" },
				{ label: "Email", value: q.replyTo?.email ?? "—" },
				{ label: "Status", value: q.readAt ? `Read ${longDate(q.readAt)}` : "New" },
				{ label: "Delivery", value: deliveryText(q, status) },
				// Admins see who it went to (they see the message itself); logs only ever carry a count.
				...(emailed && q.emailedTo?.length ? [{ label: "Emailed to", value: q.emailedTo.join(", ") }] : []),
				...(emailed && q.messageId ? [{ label: "Provider message id", value: q.messageId }] : []),
				{ label: "Email attempts", value: String(q.attempts) },
				...(q.attachments?.length ? [{ label: "Signature", value: `Signature attached (${q.attachments.map((a) => a.filename).join(", ")})` }] : []),
			],
		},
		{ type: "divider" },
		...lines.map((text) => ({ type: "section", text })),
		// The signature image, for admins (this page is admins only). Only a PNG that still passes the endpoint's checks is
		// shown, as a data URL in an <img> (EmDash's admin CSP allows data: images; React escapes the attribute).
		...(q.attachments ?? []).flatMap((a): Block[] => {
			const url = attachmentDataUrl(a);
			return url ? [{ type: "image", url, alt: "Signature sent with this form", title: a.filename }] : [{ type: "context", text: `${a.filename}: attached (not shown here).` }];
		}),
		{ type: "divider" },
		{
			type: "actions",
			elements: [
				{ type: "button", action_id: "back", label: "← Back to inbox", style: "secondary" },
				{ type: "button", action_id: "unread", label: "Mark as unread", style: "secondary", value: key },
				...(canEmail
					? [
							resend
								? { type: "button", action_id: "send", label: "Email again", style: "secondary", value: key, confirm: { title: "Email this message again?", text: emailed ? `It was emailed${q.emailedAt ? ` ${longDate(q.emailedAt)}` : ""}. It is sent again to the site's current recipients.` : "It was imported to be kept for reference. It is emailed to the site's current recipients.", confirm: "Email it", deny: "Cancel" } }
								: { type: "button", action_id: "send", label: "Email it now", style: "primary", value: key },
						]
					: []),
				...(q.replyTo?.email ? [{ type: "link", label: "Reply by email", target: { kind: "external", url: `mailto:${encodeURIComponent(q.replyTo.email)}?subject=${encodeURIComponent(`Re: ${q.subject}`)}` }, appearance: "secondary" }] : []),
				{ type: "button", action_id: "delete", label: "Delete", style: "danger", value: key, confirm: { title: "Delete this message?", text: "It is removed from Form messages and cannot be recovered.", confirm: "Delete", deny: "Keep it", style: "danger" } },
			],
		},
	];
}

export function widget(o: Pick<Overview, "items" | "counts" | "status" | "keepSent">): Block[] {
	const since = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
	const last7 = o.counts.filter((c) => c.day >= since).reduce((n, c) => n + c.count, 0);
	const unread = o.items.filter((i) => !i.s.read).length;
	const pending = toSend(o.items).length;
	// Keep sent: the newest few messages (items are oldest first). Names and subjects only; the page has the rest.
	const recent = o.keepSent ? o.items.slice(-5).reverse() : [];
	return [
		{ type: "stats", items: o.keepSent ? [{ label: "In inbox", value: o.items.length }, { label: "Unread", value: unread }, { label: "Last 7 days", value: last7 }] : [{ label: "Waiting", value: o.items.length }, { label: "Unread", value: unread }, { label: "Last 7 days", value: last7 }] },
		...(o.status !== "ready" && (o.keepSent ? pending : o.items.length) ? [{ type: "context", text: STATUS[o.status].title }] : []),
		...(recent.length
			? [
					{
						type: "table",
						block_id: "recent",
						page_action_id: "noop",
						columns: [
							{ key: "received", label: "Received", format: "relative_time" },
							{ key: "from", label: "From" },
							{ key: "delivery", label: "Email", format: "badge" },
						],
						rows: recent.map(({ s }) => ({ received: s.at, from: `${sender(s)}${s.read ? "" : " · new"}`, delivery: DELIVERY_LABEL[shownDelivery(s)] })),
					},
				]
			: []),
		{ type: "actions", elements: [{ type: "link", label: "Open form messages", target: { kind: "plugin-page", path: PAGE }, appearance: "secondary" }] },
	];
}

export const adminsOnly: Block[] = [{ type: "banner", title: "Admins only", description: "Ask a site admin for access to form messages.", variant: "error" }];
