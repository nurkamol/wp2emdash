/**
 * Backups: Block Kit views (plain JSON, shapes from @emdash-cms/blocks 1.5, as Site health and Form messages use them).
 * Admins only. Plain words; times in UTC.
 */
import { MAX_RECIPIENTS } from "@wp2emdash/forms/outbox";
import type { BackupCounts, BackupEntry, KitMarker, Trigger } from "../format.js";
import type { Plan } from "../restore.js";
import type { RunStatus } from "../schedule.js";
import type { AlertSettings } from "../store.js";
import { formatBytes, plural, shortTime } from "../util.js";

export type Block = Record<string, unknown>;
export const PAGE = "/backups";
export const TABS = { backups: 0, restore: 1, fullSite: 2, settings: 3 } as const;

export const KIND: Record<Trigger, string> = { nightly: "Nightly", manual: "Back up now", "pre-restore": "Before a restore", "pre-delete": "Before a delete" };

/** "12 pages, 3 posts · 2 menus · settings · 54 media files" */
export function included(c: BackupCounts, trigger: Trigger): string {
	const entries = Object.entries(c.entries).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${n === 1 ? k.replace(/s$/, "") : k}`);
	if (trigger === "pre-delete") return entries.length ? `${entries.join(", ")} (just before it was deleted)` : "one entry";
	const parts = [entries.join(", ") || "no entries", ...(c.menus ? [plural(c.menus, "menu")] : []), ...(c.settings ? ["settings"] : []), ...(c.redirects ? [plural(c.redirects, "redirect")] : []), ...(c.sections ? [plural(c.sections, "section")] : []), ...(c.media || c.mediaFiles ? [`${plural(c.mediaFiles, "media file")} listed`] : [])];
	return parts.join(" · ");
}

export interface PageData {
	entries: BackupEntry[];
	status: RunStatus;
	settings: AlertSettings;
	defaults: { alertsTo: string[] };
	hourUtc: number;
	retention: { daily: number; monthly: number };
	offsite: "off" | "on" | "missing-secrets";
	email: { ready: boolean; reason?: string };
	live: boolean;
	staging: boolean;
	storage: boolean;
	selfBinding: boolean;
	database?: string;
	markers: (KitMarker & { key: string })[];
	download?: { url: string; id: string };
	errors?: string[];
}

function statusBanner(d: PageData): Block {
	const s = d.status;
	if (!d.storage) return { type: "banner", title: "Backups cannot run", description: "This Worker has no media bucket binding. Ask your developer to rerun the kit's scaffold and deploy.", variant: "error" };
	if (s.failures >= 2) return { type: "banner", title: "Backups are failing", description: `The last ${plural(s.failures, "attempt")} failed${s.lastError ? ` (${s.lastError})` : ""}. Earlier backups are still here; it is retried every hour.`, variant: "error" };
	if (s.failures === 1) return { type: "banner", title: "The last backup attempt failed", description: `${s.lastError ?? "Unknown reason"}. It is retried within the hour.`, variant: "alert" };
	if (!s.lastSuccessAt) return { type: "banner", title: "No backup yet", description: `The first nightly backup runs at about ${String(d.hourUtc).padStart(2, "0")}:00 UTC, or use Back up now.`, variant: "default" };
	const age = Date.now() - Date.parse(s.lastSuccessAt);
	return age > 36 * 3_600_000 ? { type: "banner", title: "The last backup is more than a day old", description: `Last backup ${shortTime(s.lastSuccessAt)}. Check that the site's scheduled tasks run (Site health), or use Back up now.`, variant: "alert" } : { type: "banner", title: "Backed up", description: `Last backup ${shortTime(s.lastSuccessAt)}. A new one is made every night at about ${String(d.hourUtc).padStart(2, "0")}:00 UTC.`, variant: "default" };
}

function backupsTab(d: PageData): Block[] {
	const full = d.entries.filter((e) => e.trigger !== "pre-delete");
	return [
		statusBanner(d),
		...(d.download ? [{ type: "banner", title: `Backup ${d.download.id} ready to download`, description: "The link below works once, for two minutes. The file is compressed JSON (.json.gz): content, menus and settings — never passwords, sign-in data or form messages.", variant: "default" }, { type: "actions", elements: [{ type: "link", label: "Download the backup", target: { kind: "external", url: d.download.url }, appearance: "primary" }] }] : []),
		{
			type: "stats",
			items: [
				{ label: "Last backup", value: d.status.lastSuccessAt ? shortTime(d.status.lastSuccessAt) : "—" },
				{ label: "Backups kept", value: full.length },
				{ label: "Storage used", value: formatBytes(d.entries.reduce((n, e) => n + e.bytes, 0)) },
				{ label: "Off-site copy", value: d.offsite === "on" ? "On" : d.offsite === "missing-secrets" ? "Keys missing" : "Off" },
			],
		},
		{ type: "actions", elements: [{ type: "button", action_id: "backup-now", label: "Back up now", style: "primary" }] },
		{
			type: "table",
			block_id: "backups",
			page_action_id: "noop",
			empty_text: "No backup yet.",
			columns: [
				{ key: "at", label: "When", format: "relative_time" },
				{ key: "kind", label: "Kind", format: "badge" },
				{ key: "size", label: "Size" },
				{ key: "what", label: "What's in it" },
				{ key: "download", label: "", format: "element" },
				{ key: "restore", label: "", format: "element" },
			],
			rows: d.entries.slice(0, 200).map((e) => ({
				at: e.at,
				kind: KIND[e.trigger],
				size: formatBytes(e.bytes),
				what: `${included(e.counts, e.trigger)}${e.offsite === "ok" ? " · copied off-site" : e.offsite === "failed" ? " · off-site copy failed" : ""}${e.by ? ` · by ${e.by}` : ""}`,
				download: { type: "button", action_id: "download", label: "Download", value: e.id },
				restore: { type: "button", action_id: "restore-pick", label: "Restore…", value: e.id },
			})),
		},
		{ type: "context", text: `Kept: every backup of the last ${d.retention.daily} days and the first backup of each of the last ${d.retention.monthly} months. Backups live in this site's own storage (Cloudflare R2), are never public, and hold the content, menus, settings, redirects, sections and the media library's records with a list of the media files — never passwords, sign-in data, API keys or form messages.` },
	];
}

function restoreTab(d: PageData): Block[] {
	return [
		{ type: "context", text: "Restore the site settings, the menus or a single page from any backup: choose Restore… next to a backup in the Backups tab. You see every change before anything is written, and a fresh backup is always taken first, so a restore can itself be undone." },
		...(!d.selfBinding ? [{ type: "banner", title: "Restoring is not available", description: "This Worker has no SELF service binding in wrangler.jsonc. Ask your developer to rerun the kit's scaffold and deploy.", variant: "error" }] : []),
		{ type: "fields", fields: [
			{ label: "Settings", value: "Site title, tagline, logo, favicon, date and time format, social links, SEO defaults. Never the site address." },
			{ label: "Menus", value: "Every menu as it was: items come back, items added since are removed." },
			{ label: "One page", value: "Its text, images, sections, address and SEO fields — published again if it was published. Also brings a page back from the trash, or re-creates one deleted for good." },
			{ label: "The whole site", value: "See the Full site tab: done by your developer in one step, from the command line." },
		] },
	];
}

function fullSiteTab(d: PageData): Block[] {
	const db = d.database ?? "<database>";
	const latest = d.entries.find((e) => e.trigger !== "pre-delete");
	return [
		{ type: "banner", title: "Restoring the whole site is a developer step", description: "It puts every page, menu and setting back to one moment in a single transaction (Cloudflare D1 Time Travel, any minute of the last 30 days). A browser button cannot do that safely: restoring table by table could stop halfway or overwrite edits made meanwhile.", variant: "default" },
		{ type: "header", text: "For your developer" },
		{ type: "fields", fields: [
			{ label: "1. Take a backup now", value: "Back up now (Backups tab), so the current state can be compared or brought back." },
			{ label: "2. Restore the database", value: `In the site's project folder, with the Cloudflare build token set: npx wrangler d1 time-travel restore ${db} --timestamp=<the backup's time, e.g. ${latest?.at ?? "2026-11-20T02:13:00.000Z"}>` },
			{ label: "3. Older than 30 days", value: "Time Travel covers 30 days. From an older backup, settings, menus and pages can still be restored here one at a time; rebuilding a whole database from a backup file is a manual developer task (the file holds every row of every table it lists). Media files are never touched by a restore: they stay in storage." },
			{ label: "4. Check", value: "Open the site and the admin; purge the cache from the developer's deploy script if pages look old." },
		] },
		...(d.markers.length
			? [
					{ type: "header", text: "Changes made by the agency's tools" },
					{ type: "context", text: "Before the developer tools reload content into this live site or switch the domain over, they record the moment here (with a Time Travel bookmark when they could take one)." },
					{
						type: "table",
						block_id: "markers",
						page_action_id: "noop",
						columns: [
							{ key: "at", label: "When", format: "relative_time" },
							{ key: "reason", label: "What" },
							{ key: "restore", label: "To go back to just before it" },
						],
						rows: d.markers.slice(0, 50).map((m) => ({ at: m.at, reason: m.reason, restore: m.d1?.restore ?? `npx wrangler d1 time-travel restore ${m.d1?.database ?? db} --timestamp=${m.at}` })),
					},
				]
			: []),
	];
}

function settingsTab(d: PageData): Block[] {
	const s = d.settings;
	return [
		...(d.errors?.length ? [{ type: "banner", title: "Not saved", description: d.errors.slice(0, 10).join(" "), variant: "error" }] : []),
		{ type: "header", text: "Failure alerts" },
		{ type: "context", text: `An email goes out when the nightly backup fails twice in a row (once a day at most), and one when it works again. Up to ${MAX_RECIPIENTS} addresses, one per line; leave empty for the default.` },
		{
			type: "form",
			block_id: "settings",
			fields: [
				{ type: "text_input", action_id: "alertsTo", label: "Alert recipients", placeholder: d.defaults.alertsTo.join("\n") || "team@example.com", multiline: true, ...(s.alertsTo?.length ? { initial_value: s.alertsTo.join("\n") } : {}) },
				{ type: "toggle", action_id: "alerts", label: "Email alerts", initial_value: s.alerts !== false },
			],
			submit: { label: "Save", action_id: "save-settings" },
		},
		{ type: "context", text: d.staging ? "This is the staging site: it never emails." : !d.live ? "The site is not live yet: alerts start once the domain shows this site." : d.email.ready ? "Email works through the same service as the website's forms." : `Email is not available right now: ${d.email.reason}.` },
		{ type: "header", text: "Off-site copy" },
		{ type: "context", text: d.offsite === "on" ? "Every backup is also copied to a second storage account. Copies there are never deleted by the site: that storage's own rules keep or remove them." : d.offsite === "missing-secrets" ? "An off-site copy is set up, but its access keys (Worker secrets BACKUP_S3_ACCESS_KEY_ID and BACKUP_S3_SECRET_ACCESS_KEY) are missing: ask your developer." : "Off. Your developer can add a second copy in another storage account (kit.config backups.offsite)." },
	];
}

export function page(d: PageData, tab: number = TABS.backups): Block[] {
	return [
		{ type: "header", text: "Backups" },
		{
			type: "tab",
			default_tab: tab,
			panels: [
				{ label: "Backups", blocks: backupsTab(d) },
				{ label: "Restore", blocks: restoreTab(d) },
				{ label: "Full site", blocks: fullSiteTab(d) },
				{ label: "Settings", blocks: settingsTab(d) },
			],
		},
	];
}

/** Choosing what to restore from one backup. */
export function chooser(e: BackupEntry, list: { collection: string; id: string; title: string; slug: string; status: string; trashed: boolean }[]): Block[] {
	const full = e.trigger !== "pre-delete";
	return [
		{ type: "header", text: `Restore from ${KIND[e.trigger].toLowerCase()} backup, ${shortTime(e.at)}` },
		{ type: "context", text: "Choose what to restore. The next screen shows every change; nothing is written until you confirm, and a fresh backup is taken first." },
		{
			type: "actions",
			elements: [
				{ type: "button", action_id: "back", label: "← Back", style: "secondary" },
				...(full ? [{ type: "button", action_id: "preview-settings", label: "Settings…", style: "secondary", value: e.id }, { type: "button", action_id: "preview-menus", label: "Menus…", style: "secondary", value: e.id }] : []),
			],
		},
		{
			type: "table",
			block_id: "entries",
			page_action_id: "noop",
			empty_text: "No entries in this backup.",
			columns: [
				{ key: "title", label: "Page or entry" },
				{ key: "collection", label: "Type" },
				{ key: "status", label: "Status then", format: "badge" },
				{ key: "slug", label: "Address" },
				{ key: "preview", label: "", format: "element" },
			],
			rows: list.slice(0, 500).map((x) => ({ title: x.title, collection: x.collection, status: x.trashed ? "In the trash" : x.status === "published" ? "Published" : x.status === "scheduled" ? "Scheduled" : "Draft", slug: x.slug ? `/${x.slug}` : "—", preview: { type: "button", action_id: "preview-entry", label: "Restore this…", value: `${e.id}|${x.collection}|${x.id}` } })),
		},
		...(list.length > 500 ? [{ type: "context", text: `Showing 500 of ${list.length} entries (most recently changed first).` }] : []),
	];
}

/** The preview: every change, then Restore (with a confirmation) or Back. */
export function preview(p: Plan, token: string | undefined, e: BackupEntry): Block[] {
	const what = p.kind === "settings" ? "the site settings" : p.kind === "menus" ? "the menus" : `"${p.title}"`;
	return [
		{ type: "header", text: `Restore ${what}` },
		{ type: "context", text: `From the ${KIND[e.trigger].toLowerCase()} backup of ${shortTime(e.at)}. Nothing has changed yet.` },
		...(p.changes.length
			? [
					{
						type: "table",
						block_id: "changes",
						page_action_id: "noop",
						columns: [
							{ key: "what", label: "What" },
							{ key: "now", label: "Now" },
							{ key: "backup", label: "After the restore" },
						],
						rows: p.changes.slice(0, 300).map((c) => ({ what: c.what, now: c.now, backup: c.backup })),
					},
				]
			: [{ type: "banner", title: "Nothing to restore", description: `${what[0]?.toUpperCase()}${what.slice(1)} already match${p.kind === "entry" ? "es" : ""} this backup.`, variant: "default" }]),
		...p.notes.slice(0, 20).map((n) => ({ type: "context", text: n })),
		{
			type: "actions",
			elements: [
				{ type: "button", action_id: "restore-pick", label: "← Back", style: "secondary", value: e.id },
				...(p.changes.length && token ? [{ type: "button", action_id: "restore-confirm", label: `Restore ${p.kind === "entry" ? "this page" : p.kind}`, style: "danger", value: token, confirm: { title: `Restore ${what}?`, text: `${plural(p.changes.length, "change")} as shown. A fresh backup is taken first, so this can be undone the same way.`, confirm: "Restore", deny: "Cancel", style: "danger" } }] : []),
			],
		},
	];
}

export const adminsOnly: Block[] = [{ type: "banner", title: "Admins only", description: "Ask a site admin for access to Backups.", variant: "error" }];
