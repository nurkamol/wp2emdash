/**
 * Media Assistant: Block Kit views (plain JSON, shapes from @emdash-cms/blocks 1.5). Editors and admins; Settings is
 * admins only. Every action that changes or removes a file goes through a confirmation view first (a one-time plan
 * the server checks), and its final button carries a confirm dialog as well.
 */
import type { Suggestion } from "../alt.js";
import { planOptimize } from "../optimize.js";
import { type BrokenRef, isUsed, type Item, kb, type MediaRow, type Ref, type Report, TRASH_FOLDER, typeOf } from "../scan.js";
import type { AiState, OptimizedEntry, TrashEntry } from "../store.js";
import type { MediaLimits } from "../index.js";

export type Block = Record<string, unknown>;

export const PAGE = "/media";
export const WIDGET = "media-health";
export const TABS = { overview: 0, optimize: 1, alt: 2, unused: 3, duplicates: 4, broken: 5, trash: 6, settings: 7 } as const;
export type TabKey = keyof typeof TABS;
export const EDITOR_ROLE = 40;
export const ADMIN_ROLE = 50;
/** Rows shown per list (the rest after these are dealt with). */
export const SHOW = 50;

export interface PageData {
	report: Report | null;
	isAdmin: boolean;
	limits: MediaLimits;
	suggestions: Suggestion[];
	trash: TrashEntry[];
	optimized: OptimizedEntry[];
	queue: string[];
	settings: { aiAlt: boolean; autoOptimize: boolean; maxDimension: number };
	env: { images: boolean; ai: boolean; self: boolean; db: boolean; bucket: boolean; token: boolean };
	transforms: number;
	ai: AiState;
	sensitive: boolean;
	aiModel: string;
	notice?: { title: string; description?: string; variant?: "default" | "alert" | "error" };
	now?: number;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const where = (refs: Ref[], n = 3) => {
	const live = refs.filter((r) => r.kind !== "revision");
	if (!live.length) return refs.length ? "Only older versions of pages" : "Not used";
	return `${live.slice(0, n).map((r) => r.label).join("; ")}${live.length > n ? ` (+${live.length - n} more)` : ""}`;
};
const dims = (m: MediaRow) => (m.width && m.height ? `${m.width}×${m.height}` : "—");
const fileUrl = (m: Pick<MediaRow, "storageKey">) => `/_emdash/api/media/file/${m.storageKey}`;
const detailBtn = (m: MediaRow) => ({ type: "button", action_id: "detail", label: "Details", value: m.id });

function overview(d: PageData): Block[] {
	const r = d.report;
	if (!r) return [{ type: "empty", title: "No scan yet", description: "The library is scanned when this page opens and once a day.", size: "base", actions: [{ type: "button", action_id: "rescan", label: "Scan now", style: "primary" }] }];
	const t = r.totals.byType;
	const usedNoAlt = r.missingAlt.filter((x) => isUsed(x.refs)).length;
	return [
		...(!r.complete ? [{ type: "banner", title: "Usage scan incomplete", description: "The database has more rows than one scan reads, so no file is called unused. Ask your developer.", variant: "alert" }] : []),
		{
			type: "stats",
			items: [
				{ label: "Files", value: r.totals.files, description: kb(r.totals.bytes) },
				{ label: "Oversized originals", value: r.oversized.length, ...(r.oversized.length ? { trend: "down" } : {}) },
				{ label: "Images without alt text", value: r.missingAlt.length, description: `${usedNoAlt} on pages`, ...(usedNoAlt ? { trend: "down" } : {}) },
				{ label: "Unused files", value: r.unused.filter((u) => !u.protected).length },
			],
		},
		{
			type: "table",
			block_id: "types",
			page_action_id: "noop",
			columns: [
				{ key: "type", label: "Type" },
				{ key: "files", label: "Files", format: "number" },
				{ key: "size", label: "Size" },
			],
			rows: (Object.keys(t) as (keyof typeof t)[]).filter((k) => t[k].files).map((k) => ({ type: { image: "Images", video: "Videos", audio: "Audio", document: "PDF documents", other: "Other files" }[k], files: t[k].files, size: kb(t[k].bytes) })),
		},
		{
			type: "fields",
			fields: [
				{ label: "Duplicates", value: r.duplicates.length ? `${plural(r.duplicates.length, "file")} uploaded more than once` : "None" },
				{ label: "Formats to change", value: r.formats.length ? plural(r.formats.length, "file") : "None" },
				{ label: "Broken references", value: r.broken.length ? `${plural(r.broken.length, "place")} point at a file that no longer exists` : "None" },
				{ label: "In the trash", value: d.trash.length ? plural(d.trash.length, "file") : "Empty" },
			],
		},
		{ type: "context", text: `Scanned ${r.at.slice(0, 16).replace("T", " ")} UTC. "Used" means a page, a setting, a menu, a widget or another part of the site names the file. Visitors get resized WebP/AVIF copies of images automatically; the original still matters for upload size, downloads and when the free image quota is used up.` },
		{ type: "actions", elements: [{ type: "button", action_id: "rescan", label: "Scan again", style: "secondary" }] },
		...(d.queue.length ? [{ type: "banner", title: `${plural(d.queue.length, "new upload")} waiting to be optimized`, description: d.env.token ? "They are optimized within the hour." : "Optimize them now from the Optimize tab.", variant: "default" }] : []),
	];
}

function optimizeTab(d: PageData): Block[] {
	const r = d.report;
	if (!r) return [];
	const cant = !d.env.images ? "The Worker has no Images binding (IMAGES), so files cannot be optimized here." : !d.env.self ? "The Worker has no SELF binding, so the new file cannot be handed to EmDash." : !d.env.bucket ? "The Worker has no MEDIA bucket binding for the 30-day copy of the old file." : undefined;
	const rows = [...r.oversized, ...r.formats.filter((f) => !r.oversized.some((o) => o.m.id === f.m.id))].slice(0, SHOW);
	const queued = d.queue.length ? [{ type: "actions", elements: [{ type: "button", action_id: "optimize-queue", label: `Optimize ${plural(d.queue.length, "new upload")}`, style: "primary" }] }] : [];
	return [
		{ type: "context", text: `Optimize makes a smaller original in place: images wider or taller than ${d.limits.maxDimension} px are resized, JPEG and WebP re-encoded at quality ${d.limits.quality}. The file keeps its address, so every page keeps showing it. The old file is kept 30 days and can be put back below. A new format (PNG → JPEG) is not possible in place: upload a new file for that.` },
		...(cant ? [{ type: "banner", title: "Optimize is not available", description: cant, variant: "alert" }] : []),
		...queued,
		{
			type: "table",
			block_id: "oversized",
			page_action_id: "noop",
			empty_text: "No oversized originals.",
			columns: [
				{ key: "file", label: "File" },
				{ key: "size", label: "Size" },
				{ key: "dims", label: "Pixels" },
				{ key: "issue", label: "Why" },
				{ key: "plan", label: "Optimize would" },
				{ key: "used", label: "Used on" },
				{ key: "act", label: "", format: "element" },
				{ key: "more", label: "", format: "element" },
			],
			rows: rows.map((x) => {
				const p = planOptimize(x.m, d.limits);
				return { file: x.m.filename, size: kb(x.m.size), dims: dims(x.m), issue: "reasons" in x ? (x as { reasons: string[] }).reasons.join("; ") : (x as { text: string }).text, plan: p.ok ? p.why : p.reason, used: where(x.refs), act: p.ok && !cant ? { type: "button", action_id: "optimize-preview", label: "Optimize", value: [x.m.id] } : { type: "button", action_id: "noop", label: "—", value: "" }, more: detailBtn(x.m) };
			}),
		},
		...(!cant && rows.some((x) => planOptimize(x.m, d.limits).ok) ? [{ type: "actions", elements: [{ type: "button", action_id: "optimize-preview", label: "Optimize all listed (up to 10)", style: "primary", value: rows.filter((x) => planOptimize(x.m, d.limits).ok).slice(0, 10).map((x) => x.m.id) }] }] : []),
		{ type: "context", text: `Image transformations this month: ${d.transforms} (Cloudflare gives 5,000 a month free per account, shared with the resized copies visitors get).` },
		{ type: "header", text: "Recently optimized" },
		{
			type: "table",
			block_id: "optimized",
			page_action_id: "noop",
			empty_text: "Nothing optimized yet.",
			columns: [
				{ key: "file", label: "File" },
				{ key: "at", label: "When", format: "relative_time" },
				{ key: "saved", label: "Size" },
				{ key: "until", label: "Old file kept until" },
				{ key: "act", label: "", format: "element" },
			],
			rows: d.optimized.slice(0, 30).map((o) => ({ file: o.filename, at: o.at, saved: `${kb(o.before)} → ${kb(o.after)}`, until: o.restored ? `Put back ${o.restored.slice(0, 10)}` : o.until.slice(0, 10), act: o.restored || Date.parse(o.until) < (d.now ?? Date.now()) ? { type: "button", action_id: "noop", label: "—", value: "" } : { type: "button", action_id: "restore-preview", label: "Put the old file back", value: o.id } })),
		},
	];
}

function altTab(d: PageData): Block[] {
	const r = d.report;
	if (!r) return [];
	const aiOn = d.settings.aiAlt && d.env.ai;
	const aiNote = !d.env.ai ? "Suggestions come from file names and the heading above each image (this site has no Workers AI binding)." : !d.settings.aiAlt ? d.sensitive ? "AI suggestions are off: this site handles sensitive information, and they would send each picture to a Cloudflare AI model. An admin can switch them on in Settings; until then suggestions come from file names and headings." : "AI suggestions are off (Settings); suggestions come from file names and headings." : d.ai.needsAgreement ? "The AI model needs its licence accepted once (an admin, in Settings). Until then suggestions come from file names and headings." : `Suggestions come from Workers AI (${d.aiModel}); the picture is sent as a small copy, never stored there.`;
	const s = d.suggestions.slice(0, 25);
	return [
		{ type: "context", text: "Alt text describes a picture for people who cannot see it and for search engines. It is saved in the media library, so every page using the image gets it. Suggestions are only suggestions: nothing is saved until you mark it reviewed." },
		{ type: "context", text: aiNote },
		{
			type: "table",
			block_id: "missing",
			page_action_id: "noop",
			empty_text: "Every image has alt text.",
			columns: [
				{ key: "file", label: "Image" },
				{ key: "used", label: "Used on" },
				{ key: "more", label: "", format: "element" },
			],
			rows: r.missingAlt.slice(0, SHOW).map((x) => ({ file: x.m.filename, used: where(x.refs), more: detailBtn(x.m) })),
		},
		...(r.missingAlt.length ? [{ type: "actions", elements: [{ type: "button", action_id: "suggest", label: aiOn && !d.ai.needsAgreement ? "Suggest descriptions (AI, 10 at a time)" : "Suggest descriptions (30 at a time)", style: "primary" }] }] : []),
		...(s.length
			? [
					{ type: "header", text: `Review suggestions (${d.suggestions.length})` },
					{ type: "context", text: "Edit the text if needed, then choose Save or Reject for each one. \"Save reviewed\" saves only the ones marked Save; the rest stay here." },
					{
						type: "form",
						block_id: "review",
						fields: s.flatMap((x) => [
							{ type: "text_input", action_id: `text:${x.id}`, label: `${x.filename} — ${x.used.slice(0, 2).join("; ") || "not used yet"} (${x.source === "ai" ? "AI" : x.source === "filename" ? "from the file name" : "from the page heading: describe the picture"})`, initial_value: x.text },
							{ type: "select", action_id: `do:${x.id}`, label: "Decision", options: [{ label: "Not reviewed yet", value: "later" }, { label: "Save this description", value: "save" }, { label: "Reject", value: "reject" }], initial_value: "later" },
						]),
						submit: { label: "Save reviewed", action_id: "review" },
					},
				]
			: []),
	];
}

function unusedTab(d: PageData): Block[] {
	const r = d.report;
	if (!r) return [];
	if (!r.complete) return [{ type: "banner", title: "Not available", description: "The usage scan was incomplete, so no file is called unused.", variant: "alert" }];
	const list = r.unused.slice(0, SHOW);
	const free = list.filter((u) => !u.protected);
	return [
		{ type: "context", text: `Files nothing on the site names: no page (published, draft or in the trash), setting, menu, widget, section or plugin. Moving one to the trash puts it in the "${TRASH_FOLDER}" media folder for 30 days — undo any time; nothing is deleted now. Brand files and uploads from the last day are never offered.` },
		{
			type: "table",
			block_id: "unused",
			page_action_id: "noop",
			empty_text: "No unused files.",
			columns: [
				{ key: "file", label: "File" },
				{ key: "size", label: "Size" },
				{ key: "uploaded", label: "Uploaded", format: "relative_time" },
				{ key: "note", label: "Note" },
				{ key: "act", label: "", format: "element" },
			],
			rows: list.map((u) => ({ file: u.m.filename, size: kb(u.m.size), uploaded: u.m.createdAt, note: u.protected ?? (u.historyOnly ? "Named only by older versions of a page" : ""), act: u.protected ? detailBtn(u.m) : { type: "button", action_id: "trash-preview", label: "Move to trash…", value: [u.m.id] } })),
		},
		...(free.length
			? [
					{
						type: "form",
						block_id: "pick",
						fields: [{ type: "checkbox", action_id: "ids", label: "Choose files to move to the trash", options: free.map((u) => ({ label: `${u.m.filename} (${kb(u.m.size)})`, value: u.m.id })) }],
						submit: { label: "Review the chosen files…", action_id: "trash-preview" },
					},
				]
			: []),
		...(r.unused.length > SHOW ? [{ type: "context", text: `${r.unused.length - SHOW} more after these.` }] : []),
	];
}

function duplicatesTab(d: PageData): Block[] {
	const r = d.report;
	if (!r) return [];
	return [
		{ type: "context", text: "The same file uploaded more than once (identical content). Keep the one the pages use; unused copies also appear under Unused." },
		{
			type: "table",
			block_id: "dups",
			page_action_id: "noop",
			empty_text: "No duplicates.",
			columns: [
				{ key: "file", label: "File" },
				{ key: "copies", label: "Copies" },
				{ key: "used", label: "Used" },
			],
			rows: r.duplicates.slice(0, SHOW).map((g) => ({ file: g.items[0]?.m.filename ?? "", copies: g.items.length, used: g.items.map((i: Item) => `${i.m.filename}: ${isUsed(i.refs) ? where(i.refs, 1) : "not used"}`).join(" · ") })),
		},
	];
}

function brokenTab(d: PageData): Block[] {
	const r = d.report;
	if (!r) return [];
	return [
		{ type: "context", text: "Places that point at a media file that no longer exists: the picture is missing on the page. Open the page and choose the image again." },
		{
			type: "table",
			block_id: "broken",
			page_action_id: "noop",
			empty_text: "No broken references.",
			columns: [
				{ key: "where", label: "Where" },
				{ key: "missing", label: "Missing file", format: "code" },
				{ key: "open", label: "", format: "element" },
			],
			rows: r.broken.slice(0, SHOW).map((b: BrokenRef) => ({ where: b.label, missing: b.missing, open: b.collection && b.entryId ? { type: "link", label: "Open", target: { kind: "content", collection: b.collection, id: b.entryId } } : { type: "button", action_id: "noop", label: "—", value: "" } })),
		},
	];
}

function trashTab(d: PageData): Block[] {
	const now = d.now ?? Date.now();
	const expired = d.trash.filter((t) => Date.parse(t.until) <= now);
	return [
		{ type: "context", text: `Files moved to the trash stay in the "${TRASH_FOLDER}" media folder for 30 days. Put one back any time. After 30 days you may delete them for good (a copy is still kept for another 30 days for your developer). Nothing is deleted automatically.` },
		{
			type: "table",
			block_id: "trash",
			page_action_id: "noop",
			empty_text: "The trash is empty.",
			columns: [
				{ key: "file", label: "File" },
				{ key: "size", label: "Size" },
				{ key: "at", label: "Moved", format: "relative_time" },
				{ key: "until", label: "Undo until" },
				{ key: "act", label: "", format: "element" },
			],
			rows: d.trash.map((t) => ({ file: t.filename, size: kb(t.size), at: t.at, until: t.until.slice(0, 10), act: { type: "button", action_id: "untrash", label: "Put back", value: t.id } })),
		},
		...(expired.length ? [{ type: "actions", elements: [{ type: "button", action_id: "delete-preview", label: `Review ${plural(expired.length, "file")} older than 30 days for deletion…`, style: "danger", value: expired.map((t) => t.id) }] }] : []),
	];
}

function settingsTab(d: PageData): Block[] {
	if (!d.isAdmin) return [{ type: "context", text: "Settings are for admins." }];
	return [
		...(d.sensitive ? [{ type: "banner", title: "This site handles sensitive information", description: "AI alt text suggestions send each picture (a small copy) to a Cloudflare Workers AI model. They start off on such sites; switch them on only if the pictures show nothing sensitive.", variant: "alert" }] : []),
		{
			type: "form",
			block_id: "settings",
			fields: [
				{ type: "toggle", action_id: "aiAlt", label: "AI alt text suggestions (Workers AI)", description: d.env.ai ? "Each suggestion is reviewed by a person before it is saved." : "This Worker has no AI binding: set media.aiAlt in kit.config and redeploy.", initial_value: d.settings.aiAlt },
				{ type: "toggle", action_id: "autoOptimize", label: "Queue new uploads for optimizing", description: d.env.token ? "Optimized within the hour (MEDIA_API_TOKEN is set)." : "Editors optimize the queue with one click on the Optimize tab.", initial_value: d.settings.autoOptimize },
				{ type: "number_input", action_id: "maxDimension", label: "Longest side of an image original (px)", initial_value: d.settings.maxDimension, min: 1200, max: 6000 },
			],
			submit: { label: "Save", action_id: "save-settings" },
		},
		...(d.env.ai && d.ai.needsAgreement ? [{ type: "banner", title: "The AI model needs its licence accepted", description: `${d.aiModel} is Meta Llama 3.2: Cloudflare asks each account to accept the Meta Llama 3.2 Community License and Acceptable Use Policy once.`, variant: "alert" }, { type: "actions", elements: [{ type: "button", action_id: "ai-agree", label: "Accept the licence for this Cloudflare account", style: "secondary", confirm: { title: "Accept the Meta Llama 3.2 licence?", text: "This accepts the Meta Llama 3.2 Community License and Acceptable Use Policy for the site's Cloudflare account (llama.com/llama3_2/license).", confirm: "Accept", deny: "Cancel" } }] }] : []),
		{
			type: "fields",
			fields: [
				{ label: "Images binding (optimize)", value: d.env.images ? "Available" : "Missing" },
				{ label: "Workers AI binding", value: d.env.ai ? "Available" : "Not set up" },
				{ label: "SELF binding (EmDash API)", value: d.env.self ? "Available" : "Missing" },
				{ label: "MEDIA bucket (old files)", value: d.env.bucket ? "Available" : "Missing" },
				{ label: "MEDIA_API_TOKEN (hourly optimizing)", value: d.env.token ? "Set" : "Not set (optional)" },
			],
		},
	];
}

export function page(d: PageData, tab: TabKey = "overview"): Block[] {
	const r = d.report;
	const n = (x: number | undefined) => (x ? ` (${x})` : "");
	return [
		{ type: "header", text: "Media" },
		...(d.notice ? [{ type: "banner", ...d.notice }] : []),
		{
			type: "tab",
			default_tab: TABS[tab],
			panels: [
				{ label: "Overview", blocks: overview(d) },
				{ label: `Optimize${n(r?.oversized.length)}`, blocks: optimizeTab(d) },
				{ label: `Alt text${n(r?.missingAlt.length)}`, blocks: altTab(d) },
				{ label: `Unused${n(r?.unused.filter((u) => !u.protected).length)}`, blocks: unusedTab(d) },
				{ label: `Duplicates${n(r?.duplicates.length)}`, blocks: duplicatesTab(d) },
				{ label: `Broken${n(r?.broken.length)}`, blocks: brokenTab(d) },
				{ label: `Trash${n(d.trash.length)}`, blocks: trashTab(d) },
				...(d.isAdmin ? [{ label: "Settings", blocks: settingsTab(d) }] : []),
			],
		},
	];
}

const FOCAL: { label: string; value: string; x: number; y: number }[] = [
	["Top left", 0.15, 0.15],
	["Top", 0.5, 0.15],
	["Top right", 0.85, 0.15],
	["Left", 0.15, 0.5],
	["Centre", 0.5, 0.5],
	["Right", 0.85, 0.5],
	["Bottom left", 0.15, 0.85],
	["Bottom", 0.5, 0.85],
	["Bottom right", 0.85, 0.85],
].map(([label, x, y]) => ({ label: label as string, value: `${x},${y}`, x: x as number, y: y as number }));

export const focalValue = (x: number | null | undefined, y: number | null | undefined) => {
	if (x === null || x === undefined || y === null || y === undefined) return "";
	return FOCAL.reduce((best, f) => (Math.hypot(f.x - x, f.y - y) < Math.hypot(best.x - x, best.y - y) ? f : best), FOCAL[4] as (typeof FOCAL)[number]).value;
};
export const FOCAL_VALUES = new Set(FOCAL.map((f) => f.value));

/** One file: preview, where it is used, alt text, focal point, optimize. */
export function detail(m: MediaRow, refs: Ref[], d: Pick<PageData, "limits" | "optimized" | "env" | "now">): Block[] {
	const image = typeOf(m.mimeType) === "image" && m.mimeType !== "image/svg+xml";
	const p = planOptimize(m, d.limits);
	const last = d.optimized.find((o) => o.id === m.id && !o.restored && Date.parse(o.until) > (d.now ?? Date.now()));
	return [
		{ type: "header", text: m.filename },
		...(image ? [{ type: "image", url: fileUrl(m), alt: m.alt ?? "", title: m.filename }] : []),
		{ type: "fields", fields: [{ label: "Size", value: kb(m.size) }, { label: "Pixels", value: dims(m) }, { label: "Type", value: m.mimeType }, { label: "Uploaded", value: m.createdAt.slice(0, 10) }, { label: "Alt text", value: m.alt?.trim() || "None" }] },
		{
			type: "table",
			block_id: "where",
			page_action_id: "noop",
			empty_text: "Nothing on the site names this file.",
			columns: [
				{ key: "where", label: "Used on" },
				{ key: "section", label: "Section" },
				{ key: "open", label: "", format: "element" },
			],
			rows: refs.slice(0, 30).map((r) => ({ where: r.label, section: r.heading ?? "", open: r.collection && r.entryId && r.kind !== "revision" ? { type: "link", label: "Open", target: { kind: "content", collection: r.collection, id: r.entryId } } : { type: "button", action_id: "noop", label: "—", value: "" } })),
		},
		...(image
			? [
					{
						type: "form",
						block_id: "file",
						fields: [
							{ type: "text_input", action_id: "alt", label: "Alt text (what the picture shows)", initial_value: m.alt ?? "", placeholder: "e.g. Reformer machines in the bright main studio" },
							{ type: "radio", action_id: "focal", label: "Focal point — the part that stays in view when the picture is cropped", options: [{ label: "Not set", value: "" }, ...FOCAL.map((f) => ({ label: f.label, value: f.value }))], initial_value: focalValue(m.focalX, m.focalY) },
						],
						submit: { label: "Save", action_id: `save-file:${m.id}` },
					},
				]
			: []),
		{
			type: "actions",
			elements: [
				{ type: "button", action_id: "back", label: "← Back", style: "secondary" },
				...(p.ok && d.env.images && d.env.self && d.env.bucket ? [{ type: "button", action_id: "optimize-preview", label: `Optimize (${p.why})`, style: "primary", value: [m.id] }] : []),
				...(last ? [{ type: "button", action_id: "restore-preview", label: "Put the old file back", style: "secondary", value: m.id }] : []),
			],
		},
		...(!p.ok && image ? [{ type: "context", text: `Optimize: ${p.reason}` }] : []),
	];
}

/** The confirmation view: what will happen to which files, and one button (with a confirm dialog) carrying the plan. */
export function confirmView(kind: "optimize" | "trash" | "delete" | "restore-original", token: string, rows: { file: string; detail: string }[], refused: string[]): Block[] {
	const T = {
		optimize: { title: "Optimize these files?", text: "Each file is replaced by a smaller version in place (same address). The old file is kept for 30 days and can be put back.", button: "Optimize", style: "primary" },
		trash: { title: "Move these files to the trash?", text: `They move to the "${TRASH_FOLDER}" media folder. Put them back any time within 30 days; nothing is deleted now.`, button: "Move to trash", style: "danger" },
		delete: { title: "Delete these files for good?", text: "They have been in the trash for 30 days and nothing on the site uses them. They disappear from the media library; your developer keeps a copy for another 30 days.", button: "Delete for good", style: "danger" },
		"restore-original": { title: "Put the old file back?", text: "The optimized file is replaced by the original kept from before.", button: "Put it back", style: "primary" },
	}[kind];
	return [
		{ type: "header", text: T.title },
		{ type: "context", text: T.text },
		{ type: "table", block_id: "plan", page_action_id: "noop", columns: [{ key: "file", label: "File" }, { key: "detail", label: "What happens" }], rows },
		...(refused.length ? [{ type: "banner", title: "Left out", description: refused.slice(0, 20).join(" "), variant: "alert" }] : []),
		{
			type: "actions",
			elements: [
				{ type: "button", action_id: "back", label: "Cancel", style: "secondary" },
				...(rows.length ? [{ type: "button", action_id: `${kind}-run`, label: `${T.button} (${rows.length})`, style: T.style, value: token, confirm: { title: T.title, text: T.text, confirm: T.button, deny: "Cancel", ...(T.style === "danger" ? { style: "danger" } : {}) } }] : []),
			],
		},
		{ type: "context", text: "This confirmation is valid for 10 minutes." },
	];
}

export function widget(s: { missingAltUsed: number; oversized: number; unused: number; broken: number } | null): Block[] {
	if (!s) return [{ type: "context", text: "Media not scanned yet." }, { type: "actions", elements: [{ type: "link", label: "Open Media", target: { kind: "plugin-page", path: PAGE }, appearance: "secondary" }] }];
	return [
		{ type: "stats", items: [{ label: "Images without alt text", value: s.missingAltUsed }, { label: "Oversized", value: s.oversized }, { label: "Unused", value: s.unused }] },
		...(s.broken ? [{ type: "banner", title: `${plural(s.broken, "broken image reference")}`, variant: "alert" }] : []),
		{ type: "actions", elements: [{ type: "link", label: "Open Media", target: { kind: "plugin-page", path: PAGE }, appearance: "secondary" }] },
	];
}

export const editorsOnly: Block[] = [{ type: "banner", title: "Editors and admins only", description: "Ask a site admin for access to Media.", variant: "error" }];
