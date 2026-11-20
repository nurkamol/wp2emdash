/**
 * WordPress comments → EmDash's comments table (docs/spikes/comments-findings.md).
 *
 * Input: the Exporter's `/emdash/v1/comments` items (raw/exporter/comments.json: approved and pending comments of type
 * `comment`; the plugin leaves spam, trash, pingbacks and trackbacks in WordPress), the entries transform migrated, each
 * entry's `comment_status` and WordPress's discussion settings (raw/exporter/discussion.json from REST settings,
 * raw/discussion.json from a backup's SQL dump). Output: `ir/comments.json` — the plan (counts, settings per collection,
 * entries with comments or closed to new ones) and the comments to load, with deterministic EmDash ids.
 *
 * Personal data: author e-mail addresses travel to EmDash (it stores them for moderation and first-time-commenter
 * checks) but never into reports, logs or gate details — those carry counts only. IP addresses and user agents are
 * never read (the Exporter does not send them). Author URLs: EmDash 1.5 has no column for them (migration 028 dropped
 * it) and the Exporter does not send them; they are counted when a source has them, not carried.
 */
import { createHash } from "node:crypto";

/** One raw comment (Exporter shape; `type`, `author_url`, `content` appear in other sources and are handled too). */
export interface WpComment {
	id: number;
	post_id: number;
	parent_id?: number | null;
	author_name?: string;
	author_email?: string;
	author_url?: string;
	/** Plain text from the Exporter (wp_strip_all_tags); HTML from other sources is reduced the same way. */
	body?: string;
	content?: string;
	date_gmt?: string;
	status?: string;
	type?: string;
}

export type Moderation = "all" | "first_time" | "none";

/** WordPress discussion settings as far as they are known (null = not found in any source). */
export interface DiscussionSettings {
	defaultOpen: boolean | null;
	moderation: Moderation;
	closedAfterDays: number;
	registration: boolean;
	threadDepth: number | null;
	/** Where each value came from, for the report. */
	source: string;
}

/** The comments decision (overrides.ts `comments`). */
export interface CommentsDecision {
	migrate?: boolean;
	includePending?: boolean;
	form?: boolean;
	moderation?: Moderation;
	closedAfterDays?: number;
	reason?: string;
}

/** An entry that can carry comments: a migrated page, post or custom post type entry. */
export interface CommentTarget {
	key: string;
	wpId: number;
	collection: string;
	slug: string;
	path?: string;
	published: boolean;
	/** WordPress `comment_status` (undefined when the source did not send it). */
	commentStatus?: string;
}

export interface IrComment {
	wpId: number;
	/** Deterministic EmDash id (ULID: the comment's time + a hash of the site and WordPress id). */
	id: string;
	/** The entry: `<type>:<wpId>` as in load's id-map. */
	entry: string;
	collection: string;
	/** EmDash threads one level deep: the id of the top-level comment this one answers (deeper replies flattened). */
	parentId: string | null;
	parentWpId: number | null;
	authorName: string;
	authorEmail: string;
	body: string;
	createdAt: string;
	status: "approved" | "pending";
}

export type SkipReason = "pending" | "spam" | "trash" | "pingback" | "trackback" | "entry-not-migrated" | "empty" | "decision";

export interface CommentsPlan {
	/** Comments are imported (false: by decision, or a sensitive site still waiting for one). */
	migrate: boolean;
	/** migrate came from overrides.ts (with the owner's reason) rather than the default. */
	decided: boolean;
	reason?: string;
	/** A sensitive site (kit.config sensitiveData) with comments and no decision yet: the gate fails. */
	needsDecision: boolean;
	includePending: boolean;
	settings: DiscussionSettings;
	collections: { slug: string; form: boolean; moderation: Moderation; closedAfterDays: number; approved: number; pending: number; why: string }[];
	/** Entries with imported comments, and entries closed to new comments in a collection that takes them. */
	entries: { key: string; collection: string; slug: string; path?: string; approved: number; pending: number; closed: boolean }[];
	counts: { found: number; approved: number; pending: number; imported: number; skipped: Partial<Record<SkipReason, number>>; flattened: number; reparented: number; authorUrls: number };
}

const ULID = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A ULID whose time part is `ms` and whose other 80 bits come from `seed` (deterministic, sorts by time like EmDash's). */
export function deterministicUlid(ms: number, seed: string): string {
	let t = Math.max(0, Math.min(Math.floor(ms), 2 ** 48 - 1));
	let time = "";
	for (let i = 0; i < 10; i++) {
		time = ULID[t % 32] + time;
		t = Math.floor(t / 32);
	}
	const bytes = createHash("sha256").update(seed).digest().subarray(0, 10);
	let bits = 0n;
	for (const b of bytes) bits = (bits << 8n) | BigInt(b);
	let rand = "";
	for (let i = 0; i < 16; i++) {
		rand = ULID[Number(bits & 31n)] + rand;
		bits >>= 5n;
	}
	return time + rand;
}

/** The EmDash id of a WordPress comment on this site. */
export const commentId = (site: string, wpId: number, createdAt: string) => deterministicUlid(Date.parse(createdAt) || 0, `wp2emdash:comment:${site}:${wpId}`);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«", raquo: "»", copy: "©", reg: "®", trade: "™", euro: "€", pound: "£", deg: "°", times: "×" };
export function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
		if (e[0] === "#") {
			const n = e[1] === "x" || e[1] === "X" ? Number.parseInt(e.slice(2), 16) : Number.parseInt(e.slice(1), 10);
			return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
		}
		return ENTITIES[e.toLowerCase()] ?? m;
	});
}

/**
 * A comment body as EmDash stores and shows it: plain text (its comment list escapes the text, keeps line breaks and
 * turns URLs into nofollow links). Paragraphs and line breaks become new lines, a link keeps its address after the
 * text, list items get a bullet, every other tag is dropped and entities are decoded.
 */
export function commentBody(raw: string): string {
	let s = raw.replace(/\r\n?/g, "\n");
	s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
	s = s.replace(/<a\b[^>]*?href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_m, _q: string, href: string, text: string) => {
		const t = decodeEntities(text.replace(/<[^>]+>/g, "")).trim();
		const h = decodeEntities(href).trim();
		return !t || t === h || !/^(https?:|mailto:)/i.test(h) ? t || h : `${t} (${h})`;
	});
	s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<li\b[^>]*>/gi, "\n• ").replace(/<\/(p|div|blockquote|h[1-6]|ul|ol|pre)>/gi, "\n\n");
	s = s.replace(/<[^>]+>/g, "");
	s = decodeEntities(s);
	return s
		.split("\n")
		.map((l) => l.replace(/[ \t ]+/g, " ").trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** ISO 8601 UTC from the Exporter's `date_gmt` ("2024-05-10T09:00:00Z") or WordPress's "Y-m-d H:i:s". */
function isoDate(d: string | undefined): string | undefined {
	if (!d || /^0000-00-00/.test(d)) return undefined;
	const v = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(d) ? `${d.replace(" ", "T")}Z` : d;
	const t = Date.parse(v);
	return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

const flag = (v: unknown) => v === true || v === 1 || v === "1" || v === "open";

/**
 * Discussion settings from what extract and import-options found (REST settings: `default_comment_status`; a backup's
 * options: the rest). WordPress's own defaults where nothing was found.
 */
export function discussionSettings(rest: Record<string, unknown> | undefined, dump: Record<string, unknown> | undefined): DiscussionSettings {
	const o = { ...(rest ?? {}), ...(dump ?? {}) };
	const has = (k: string) => o[k] !== undefined && o[k] !== null && o[k] !== "";
	const moderation: Moderation = has("comment_moderation") || has("comment_previously_approved") ? (flag(o.comment_moderation) ? "all" : flag(o.comment_previously_approved ?? "1") ? "first_time" : "none") : "first_time";
	const days = Number(o.close_comments_days_old ?? 14);
	const closedAfterDays = has("close_comments_for_old_posts") && flag(o.close_comments_for_old_posts) ? (Number.isFinite(days) && days > 0 ? Math.round(days) : 14) : 0;
	const depth = Number(o.thread_comments_depth);
	const sources = [rest && Object.keys(rest).length ? "REST settings" : "", dump && Object.keys(dump).length ? "backup options" : ""].filter(Boolean);
	return {
		defaultOpen: has("default_comment_status") ? o.default_comment_status === "open" : null,
		moderation,
		closedAfterDays,
		registration: flag(o.comment_registration),
		threadDepth: has("thread_comments") ? (flag(o.thread_comments) ? (Number.isFinite(depth) && depth > 0 ? depth : 5) : 1) : null,
		source: sources.length ? sources.join(" + ") : "WordPress defaults (no discussion settings found)",
	};
}

export interface PlanInput {
	comments: WpComment[];
	targets: CommentTarget[];
	settings: DiscussionSettings;
	decision?: CommentsDecision;
	sensitive: boolean;
	/** Host of the WordPress site: part of every comment's id. */
	site: string;
}

/** Plan the import: which comments go where, threading flattened to EmDash's one level, settings per collection. */
export function planComments(i: PlanInput): { plan: CommentsPlan; items: IrComment[] } {
	const d = i.decision ?? {};
	const decided = d.migrate !== undefined;
	const needsDecision = i.sensitive && !decided && i.comments.length > 0;
	const migrate = decided ? !!d.migrate : !i.sensitive;
	const includePending = !!d.includePending;
	const byPost = new Map(i.targets.map((t) => [t.wpId, t]));
	const skipped: Partial<Record<SkipReason, number>> = {};
	const skip = (r: SkipReason) => (skipped[r] = (skipped[r] ?? 0) + 1);
	const counts = { found: i.comments.length, approved: 0, pending: 0, imported: 0, skipped, flattened: 0, reparented: 0, authorUrls: 0 };

	// Parents before children: WordPress comment ids grow with time.
	const sorted = [...i.comments].sort((a, b) => a.id - b.id);
	const kept = new Map<number, IrComment>();
	for (const c of sorted) {
		if (c.author_url && c.author_url.trim()) counts.authorUrls++;
		const type = (c.type ?? "comment").toLowerCase();
		if (type === "pingback" || type === "trackback") {
			skip(type);
			continue;
		}
		const status = (c.status ?? "approved").toLowerCase();
		const approved = status === "approved" || status === "approve" || status === "1";
		const pending = status === "pending" || status === "hold" || status === "unapproved" || status === "0";
		if (approved) counts.approved++;
		else if (pending) counts.pending++;
		if (!approved && !pending) {
			skip(status === "trash" || status === "post-trashed" ? "trash" : "spam");
			continue;
		}
		if (pending && !includePending) {
			skip("pending");
			continue;
		}
		if (!migrate) {
			skip("decision");
			continue;
		}
		const target = byPost.get(c.post_id);
		if (!target) {
			skip("entry-not-migrated");
			continue;
		}
		const body = commentBody(String(c.body ?? c.content ?? ""));
		if (!body) {
			skip("empty");
			continue;
		}
		const createdAt = isoDate(c.date_gmt) ?? "1970-01-01T00:00:00.000Z";
		// EmDash nests replies one level: a reply joins the thread of its top-level comment. A reply whose parent is not
		// imported (pending, spam, another entry) becomes a top-level comment.
		let parent = c.parent_id ? kept.get(c.parent_id) : undefined;
		if (c.parent_id && (!parent || parent.entry !== target.key)) {
			parent = undefined;
			counts.reparented++;
		}
		if (parent?.parentId) counts.flattened++;
		const root = parent?.parentWpId ? kept.get(parent.parentWpId) : parent;
		const item: IrComment = {
			wpId: c.id,
			id: commentId(i.site, c.id, createdAt),
			entry: target.key,
			collection: target.collection,
			parentId: root?.id ?? null,
			parentWpId: root?.wpId ?? null,
			authorName: decodeEntities(String(c.author_name ?? "")).trim() || "Anonymous",
			authorEmail: String(c.author_email ?? "").trim(),
			body,
			createdAt,
			status: approved ? "approved" : "pending",
		};
		kept.set(c.id, item);
	}
	const items = [...kept.values()];
	counts.imported = items.length;

	// Settings per collection: the comment list shows imported comments wherever they are; the form (EmDash's
	// commentsEnabled) only where WordPress took new comments, never on a sensitive site unless decided, never when
	// WordPress required registered users (EmDash cannot: its commenters are visitors).
	const s = i.settings;
	const moderation = d.moderation ?? s.moderation;
	const closedAfterDays = d.closedAfterDays ?? s.closedAfterDays;
	const cols = [...new Set([...items.map((c) => c.collection), ...i.targets.filter((t) => t.commentStatus === "open" && t.published).map((t) => t.collection)])].sort();
	const collections = cols.map((slug) => {
		const mine = items.filter((c) => c.collection === slug);
		const open = i.targets.some((t) => t.collection === slug && t.published && (t.commentStatus === "open" || (t.commentStatus === undefined && s.defaultOpen === true)));
		const formWhy =
			d.form === false ? "off by decision" : i.sensitive && d.form !== true ? "off: sensitive site (overrides.ts comments.form)" : s.registration && d.form !== true ? "off: WordPress required registered users" : d.form === true ? "on by decision" : open ? "on: WordPress took comments" : "off: comments were closed in WordPress";
		return { slug, form: formWhy.startsWith("on"), moderation, closedAfterDays, approved: mine.filter((c) => c.status === "approved").length, pending: mine.filter((c) => c.status === "pending").length, why: formWhy };
	});
	const formOn = new Set(collections.filter((c) => c.form).map((c) => c.slug));
	const entries = i.targets
		.map((t) => {
			const mine = items.filter((c) => c.entry === t.key);
			return { key: t.key, collection: t.collection, slug: t.slug, ...(t.path ? { path: t.path } : {}), approved: mine.filter((c) => c.status === "approved").length, pending: mine.filter((c) => c.status === "pending").length, closed: formOn.has(t.collection) && t.commentStatus === "closed" };
		})
		.filter((e) => e.approved || e.pending || e.closed)
		.sort((a, b) => a.key.localeCompare(b.key));
	return {
		plan: { migrate, decided, ...(d.reason ? { reason: d.reason } : {}), needsDecision, includePending, settings: s, collections, entries, counts },
		items,
	};
}

/** site.config.json `comments` for the starter: where the list and form appear. */
export function starterCommentsConfig(plan: CommentsPlan): { collections: Record<string, { form: boolean; closedAfterDays?: number }> } {
	return { collections: Object.fromEntries(plan.collections.map((c) => [c.slug, { form: c.form, ...(c.form && c.closedAfterDays ? { closedAfterDays: c.closedAfterDays } : {}) }])) };
}

const SKIP_LABEL: Record<SkipReason, string> = {
	pending: "pending (awaiting moderation in WordPress; overrides.ts comments.includePending imports them as pending)",
	spam: "spam",
	trash: "trash",
	pingback: "pingbacks",
	trackback: "trackbacks",
	"entry-not-migrated": "on entries that are not migrated (attachments, skipped types, missing entries)",
	empty: "empty after removing markup",
	decision: "not migrated by decision",
};

/** The gate detail: counts only. */
export function commentsGate(plan: CommentsPlan): { ok: boolean; detail: string } {
	const c = plan.counts;
	const skipped = Object.entries(c.skipped).map(([k, n]) => `${n} ${k}`).join(", ");
	if (plan.needsDecision) return { ok: false, detail: `${c.approved} approved comment(s) on a sensitive site: decide overrides.ts comments.migrate (true | false) with the owner's reason; the comment form stays off unless comments.form is true` };
	if (!plan.migrate) return { ok: true, detail: `not migrated by decision${plan.reason ? ` (${plan.reason})` : ""}: ${c.found} comment(s) stay in WordPress (export them before it is switched off)` };
	return { ok: true, detail: `${c.imported} of ${c.found} comment(s) to import on ${plan.entries.filter((e) => e.approved || e.pending).length} entr${plan.entries.length === 1 ? "y" : "ies"}${skipped ? `; left out: ${skipped}` : ""}${c.flattened ? `; ${c.flattened} deeper replies joined their thread` : ""}` };
}

/** Coverage report section (counts only: never names, addresses or comment text). */
export function commentsReport(plan: CommentsPlan): string[] {
	const c = plan.counts;
	const L = ["", "## Comments", ""];
	L.push(plan.needsDecision ? "❌ **Sensitive site: decide whether comments are migrated** (overrides.ts `comments: { migrate: true | false, reason }`)." : plan.migrate ? `Imported into EmDash's comments (moderation in the admin → Comments)${plan.decided && plan.reason ? `, by decision: ${plan.reason}` : ""}.` : `Not migrated, by decision${plan.reason ? `: ${plan.reason}` : ""}.`, "");
	L.push("| Comments | Count |", "|---|---|", `| Found (approved + pending, from the Exporter) | ${c.found} |`, `| Approved | ${c.approved} |`, `| Pending | ${c.pending} |`, `| To import | ${c.imported} |`);
	for (const [k, n] of Object.entries(c.skipped)) L.push(`| Left out: ${SKIP_LABEL[k as SkipReason]} | ${n} |`);
	if (c.flattened) L.push(`| Replies deeper than one level (joined their top-level thread: EmDash nests one level) | ${c.flattened} |`);
	if (c.reparented) L.push(`| Replies whose parent is not imported (shown as top-level comments) | ${c.reparented} |`);
	if (c.authorUrls) L.push(`| Author websites (not carried: EmDash 1.5 has no author URL) | ${c.authorUrls} |`);
	L.push("", "Spam, trash, pingbacks and trackbacks stay in WordPress (the Exporter sends approved and pending comments only). Author websites, IP addresses and user agents are not carried. Comment feeds (`/comments/feed/`) answer 410.", "");
	const s = plan.settings;
	L.push(`Discussion settings (${s.source}): new comments ${s.defaultOpen === null ? "open/closed not known" : s.defaultOpen ? "open" : "closed"} by default · moderation ${s.moderation} · ${s.closedAfterDays ? `closed after ${s.closedAfterDays} days` : "never closed automatically"}${s.threadDepth ? ` · threads ${s.threadDepth} deep in WordPress` : ""}${s.registration ? " · registered users only" : ""}.`, "");
	if (plan.collections.length) {
		L.push("| Collection | Approved | Pending | Comment form | Moderation | Closes after |", "|---|---|---|---|---|---|");
		for (const col of plan.collections) L.push(`| ${col.slug} | ${col.approved} | ${col.pending} | ${col.why} | ${col.moderation} | ${col.closedAfterDays ? `${col.closedAfterDays} days` : "never"} |`);
	}
	const closed = plan.entries.filter((e) => e.closed).length;
	if (closed) L.push("", `${closed} entr${closed === 1 ? "y is" : "ies are"} closed to new comments (WordPress comment status "closed"): the field "Comments closed" is ticked; their comments still show.`);
	return L;
}
