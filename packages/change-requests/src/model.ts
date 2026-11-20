/**
 * Change requests: the record, the status machine, who may do what, and input / attachment validation. Pure (no
 * EmDash, no Worker APIs) so tests and the kit read the same rules.
 *
 * Who may do what (docs: README.md → Permissions):
 * - Editors and admins create requests, see every request of the site, comment on open ones and add files to open ones.
 * - The agency (admins; with `agencyDomains`, only admins with an email at those domains) moves any request through
 *   the statuses, replies as the agency, and may comment on closed requests.
 * - The requester (client side) may withdraw their own open request (→ Declined, "withdrawn"), confirm it is done when
 *   it is In progress or Waiting for you (→ Done), and reopen their own Done request within 30 days (→ New). Other
 *   client-side people comment only: a request's status is the requester's and the agency's business.
 * - A client-side comment on a request that is "Waiting for you" moves it back to "In progress" (the agency's turn).
 */

export const STATUSES = ["new", "seen", "in_progress", "waiting", "done", "declined"] as const;
export type Status = (typeof STATUSES)[number];
export const STATUS_LABEL: Record<Status, string> = { new: "New", seen: "Seen", in_progress: "In progress", waiting: "Waiting for you", done: "Done", declined: "Declined" };
export const OPEN: ReadonlySet<Status> = new Set(["new", "seen", "in_progress", "waiting"]);
export const isOpen = (s: Status) => OPEN.has(s);

export type Priority = "normal" | "urgent";
export type Contact = "admin" | "email" | "phone";
export const CONTACT_LABEL: Record<Contact, string> = { admin: "Reply here in the admin", email: "Email me", phone: "Call me (the number you have for us)" };

export const LIMITS = { title: 120, description: 4000, section: 120, comment: 4000, attachments: 3, attachmentBytes: 5 * 1024 * 1024, filename: 100 } as const;
export const EDITOR_ROLE = 40;
export const ADMIN_ROLE = 50;
export const REOPEN_DAYS = 30;
const DAY = 86400_000;

export interface Person {
	id?: string;
	name: string;
	email?: string;
}

export interface Attachment {
	id: string;
	name: string;
	type: string;
	size: number;
	/** R2 key under backups/change-requests/ (never served publicly). */
	key: string;
	at: string;
	by: string;
}

export type EventKind = "created" | "comment" | "status" | "attachment";
export interface TimelineEvent {
	at: string;
	kind: EventKind;
	/** Display name of who did it, and whether they acted for the agency. */
	by: string;
	agency: boolean;
	text?: string;
	from?: Status;
	to?: Status;
	/** Status changes: "withdrawn" when the requester withdrew. */
	reason?: string;
}

export interface PageRef {
	collection: string;
	id: string;
	title: string;
}

export interface ChangeRequest {
	id: string;
	number: number;
	title: string;
	description: string;
	/** Null: anywhere on the site. */
	page: PageRef | null;
	section?: string;
	priority: Priority;
	contact: Contact;
	/** Email the requester when the status changes or the agency replies (opt-out). */
	notify: boolean;
	status: Status;
	createdAt: string;
	updatedAt: string;
	closedAt?: string;
	requester: Person;
	attachments: Attachment[];
	timeline: TimelineEvent[];
}

export interface Actor {
	role: number;
	id?: string;
	email?: string;
	name: string;
	agency: boolean;
}

/** Whether a signed-in person acts for the agency: an admin, and (if domains are set) with an email at one of them. */
export function isAgency(user: { role: number; email?: string | undefined }, domains: string[] = []): boolean {
	if (user.role < ADMIN_ROLE) return false;
	if (!domains.length) return true;
	const d = user.email?.split("@")[1]?.toLowerCase();
	return !!d && domains.some((x) => x.toLowerCase().replace(/^@/, "") === d);
}

export function actorOf(user: { role: number; id?: string; email?: string; name?: string | null } | undefined, domains: string[] = []): Actor {
	const u = user ?? { role: 0 };
	return { role: u.role, ...(u.id ? { id: u.id } : {}), ...(u.email ? { email: u.email } : {}), name: (u.name ?? "").trim() || u.email?.split("@")[0] || "Someone", agency: isAgency(u, domains) };
}

export const isRequester = (a: Actor, r: ChangeRequest) => !!((a.id && a.id === r.requester.id) || (!r.requester.id && a.email && a.email === r.requester.email));

/** Agency moves: any status to any other that makes sense; closed requests can be reopened (→ In progress). */
export const AGENCY_MOVES: Record<Status, Status[]> = {
	new: ["seen", "in_progress", "waiting", "done", "declined"],
	seen: ["in_progress", "waiting", "done", "declined"],
	in_progress: ["waiting", "done", "declined"],
	waiting: ["in_progress", "done", "declined"],
	done: ["in_progress"],
	declined: ["in_progress"],
};

/** The statuses this person may move this request to (empty: none). */
export function allowedMoves(a: Actor, r: ChangeRequest, now = Date.now()): Status[] {
	if (a.role < EDITOR_ROLE) return [];
	if (a.agency) return AGENCY_MOVES[r.status];
	if (!isRequester(a, r)) return [];
	if (r.status === "in_progress" || r.status === "waiting") return ["done", "declined"];
	if (isOpen(r.status)) return ["declined"];
	if (r.status === "done" && now - Date.parse(r.closedAt ?? r.updatedAt) <= REOPEN_DAYS * DAY) return ["new"];
	return [];
}

export const canComment = (a: Actor, r: ChangeRequest) => a.role >= EDITOR_ROLE && (isOpen(r.status) || a.agency);
export const canAttach = (a: Actor, r: ChangeRequest) => a.role >= EDITOR_ROLE && isOpen(r.status) && r.attachments.length < LIMITS.attachments;
export const canDownload = (a: Actor) => a.role >= EDITOR_ROLE;

/** Label of a move as a button ("Withdraw", "Mark done", "Reopen"…). */
export function moveLabel(a: Actor, to: Status): string {
	if (!a.agency) return to === "declined" ? "Withdraw this request" : to === "done" ? "Mark as done" : "Reopen";
	return { new: "Reopen", seen: "Mark seen", in_progress: "In progress", waiting: "Waiting for client", done: "Done", declined: "Decline" }[to];
}

export type MoveResult = { ok: true; request: ChangeRequest; from: Status } | { ok: false; reason: string };

/** Applies a status change (checked against `allowedMoves`). Returns a new record. */
export function move(r: ChangeRequest, a: Actor, to: Status, note: string | undefined, now = Date.now()): MoveResult {
	if (!STATUSES.includes(to)) return { ok: false, reason: "Unknown status." };
	if (!allowedMoves(a, r, now).includes(to)) return { ok: false, reason: `You cannot move this request to "${STATUS_LABEL[to]}".` };
	const at = new Date(now).toISOString();
	const text = cleanText(note ?? "", LIMITS.comment);
	const reason = !a.agency && to === "declined" ? "withdrawn" : undefined;
	const next: ChangeRequest = {
		...r,
		status: to,
		updatedAt: at,
		timeline: [...r.timeline, { at, kind: "status", by: a.name, agency: a.agency, from: r.status, to, ...(text ? { text } : {}), ...(reason ? { reason } : {}) }],
	};
	if (isOpen(to)) delete next.closedAt;
	else next.closedAt = at;
	return { ok: true, request: next, from: r.status };
}

export type CommentResult = { ok: true; request: ChangeRequest; moved?: { from: Status; to: Status } } | { ok: false; reason: string };

/** Adds a comment; a client-side comment on "Waiting for you" hands the request back to the agency (→ In progress). */
export function comment(r: ChangeRequest, a: Actor, raw: string, now = Date.now()): CommentResult {
	if (!canComment(a, r)) return { ok: false, reason: isOpen(r.status) ? "Only editors and admins can comment." : "This request is closed. Reopen it to continue." };
	const text = cleanText(raw, LIMITS.comment);
	if (!text) return { ok: false, reason: "Write a comment first." };
	const at = new Date(now).toISOString();
	const timeline: TimelineEvent[] = [...r.timeline, { at, kind: "comment", by: a.name, agency: a.agency, text }];
	if (!a.agency && r.status === "waiting") {
		timeline.push({ at, kind: "status", by: a.name, agency: false, from: "waiting", to: "in_progress" });
		return { ok: true, request: { ...r, status: "in_progress", updatedAt: at, timeline }, moved: { from: "waiting", to: "in_progress" } };
	}
	return { ok: true, request: { ...r, updatedAt: at, timeline } };
}

/** Plain text: control characters removed (newlines kept), trimmed, length-limited. */
export function cleanText(s: unknown, max: number): string {
	if (typeof s !== "string") return "";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
	return s.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, max);
}
const oneLine = (s: unknown, max: number) => cleanText(s, max * 2).replace(/\s+/g, " ").trim().slice(0, max);

export const ANYWHERE = "anywhere";

export interface NewRequestInput {
	title: string;
	description: string;
	page: PageRef | null;
	section?: string;
	priority: Priority;
	contact: Contact;
	notify: boolean;
}

/** Validates the "Request a change" form. `pages` is the picker's list (`collection:id` → title). */
export function validateNew(values: Record<string, unknown>, pages: PageRef[]): { ok: true; value: NewRequestInput } | { ok: false; errors: string[] } {
	const errors: string[] = [];
	const title = oneLine(values.title, LIMITS.title);
	const description = cleanText(values.description, LIMITS.description);
	if (!title) errors.push("Give the request a short title.");
	if (!description) errors.push("Describe the change.");
	if (typeof values.description === "string" && values.description.trim().length > LIMITS.description) errors.push(`The description is longer than ${LIMITS.description} characters; it was cut. Shorten it or split the request.`);
	const pick = typeof values.page === "string" ? values.page : ANYWHERE;
	let page: PageRef | null = null;
	if (pick && pick !== ANYWHERE) {
		const [collection, id] = pick.split(":");
		const found = pages.find((p) => p.collection === collection && p.id === id);
		if (!found) errors.push("Choose a page from the list, or Anywhere on the site.");
		else page = found;
	}
	const section = oneLine(values.section, LIMITS.section);
	const priority: Priority = values.priority === "urgent" ? "urgent" : "normal";
	const contact: Contact = values.contact === "email" || values.contact === "phone" ? values.contact : "admin";
	if (errors.length) return { ok: false, errors };
	return { ok: true, value: { title, description, page, ...(section ? { section } : {}), priority, contact, notify: values.notify !== false } };
}

export function newRequest(input: NewRequestInput, a: Actor, o: { id: string; number: number; now?: number }): ChangeRequest {
	const at = new Date(o.now ?? Date.now()).toISOString();
	return {
		id: o.id,
		number: o.number,
		...input,
		status: "new",
		createdAt: at,
		updatedAt: at,
		requester: { ...(a.id ? { id: a.id } : {}), name: a.name, ...(a.email ? { email: a.email } : {}) },
		attachments: [],
		timeline: [{ at, kind: "created", by: a.name, agency: a.agency }],
	};
}

// ── Attachments ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Accepted files, recognised by their first bytes (the browser's declared type is not trusted). */
export const ATTACHMENT_TYPES: { type: string; ext: string; test: (b: Uint8Array) => boolean }[] = [
	{ type: "image/png", ext: "png", test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a },
	{ type: "image/jpeg", ext: "jpg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
	{ type: "image/gif", ext: "gif", test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
	{ type: "image/webp", ext: "webp", test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50 },
	{ type: "application/pdf", ext: "pdf", test: (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 && b[4] === 0x2d },
];

/** A safe file name: letters, digits, dot, dash, underscore and spaces; the extension follows the real type. */
export function safeFilename(name: unknown, ext: string): string {
	const base = (typeof name === "string" ? name : "")
		.split(/[/\\]/)
		.pop()
		?.replace(/\.[a-z0-9]{1,5}$/i, "")
		.normalize("NFKD")
		.replace(/[^\w .-]+/g, "")
		.replace(/\s+/g, " ")
		.replace(/^[.\s-]+/, "")
		.trim()
		.slice(0, LIMITS.filename - ext.length - 1);
	return `${base || "attachment"}.${ext}`;
}

export type AttachmentCheck = { ok: true; type: string; name: string } | { ok: false; reason: string };

export function checkAttachment(name: unknown, bytes: Uint8Array): AttachmentCheck {
	if (!bytes.byteLength) return { ok: false, reason: "The file is empty." };
	if (bytes.byteLength > LIMITS.attachmentBytes) return { ok: false, reason: `The file is larger than ${LIMITS.attachmentBytes / 1024 / 1024} MB.` };
	const t = ATTACHMENT_TYPES.find((x) => x.test(bytes));
	if (!t) return { ok: false, reason: "Only pictures (PNG, JPEG, GIF, WebP) and PDF files can be attached." };
	return { ok: true, type: t.type, name: safeFilename(name, t.ext) };
}

export const attachmentKey = (requestId: string, attachmentId: string, name: string) => `backups/change-requests/${requestId}/${attachmentId}-${name}`;
export const isAttachmentKey = (k: string) => /^backups\/change-requests\/[0-9a-f]{16}\/[0-9a-f]{16}-[\w .-]{1,100}$/.test(k) && !k.includes("..");

// ── Retention ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Closed requests older than `months` (by when they were closed). Open requests are never removed. */
export function expired(list: ChangeRequest[], months: number, now = Date.now()): ChangeRequest[] {
	const cutoff = new Date(now);
	cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
	return list.filter((r) => !isOpen(r.status) && Date.parse(r.closedAt ?? r.updatedAt) < cutoff.getTime());
}

// ── Lists ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface Filter {
	status: "open" | "all" | Status;
	priority: "any" | Priority;
	mine: boolean;
}
export const DEFAULT_FILTER: Filter = { status: "open", priority: "any", mine: false };

export function filterOf(v: Record<string, unknown> | undefined): Filter {
	const s = v?.status;
	return {
		status: s === "all" || (typeof s === "string" && (STATUSES as readonly string[]).includes(s)) ? (s as Filter["status"]) : "open",
		priority: v?.priority === "urgent" || v?.priority === "normal" ? v.priority : "any",
		mine: v?.mine === true || (Array.isArray(v?.mine) && v.mine.includes("mine")),
	};
}

/** Filtered and sorted: urgent open first, then the most recently changed. */
export function applyFilter(list: ChangeRequest[], f: Filter, a: Actor): ChangeRequest[] {
	return list
		.filter((r) => (f.status === "open" ? isOpen(r.status) : f.status === "all" ? true : r.status === f.status))
		.filter((r) => f.priority === "any" || r.priority === f.priority)
		.filter((r) => !f.mine || isRequester(a, r))
		.sort((x, y) => Number(isOpen(y.status) && y.priority === "urgent") - Number(isOpen(x.status) && x.priority === "urgent") || (x.updatedAt < y.updatedAt ? 1 : x.updatedAt > y.updatedAt ? -1 : 0));
}

/** The latest status changes across requests (for the dashboard widget). */
export function latestChanges(list: ChangeRequest[], n = 5): { request: ChangeRequest; event: TimelineEvent }[] {
	return list
		.flatMap((request) => request.timeline.filter((e) => e.kind === "status" || e.kind === "created").map((event) => ({ request, event })))
		.sort((a, b) => (a.event.at < b.event.at ? 1 : -1))
		.slice(0, n);
}

export const randomId = () => [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, "0")).join("");
export const ID_PATTERN = /^[0-9a-f]{16}$/;
