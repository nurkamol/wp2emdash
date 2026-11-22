/**
 * @wp2emdash/backups — Backups & Restore for EmDash on Cloudflare Workers (experimental, 0.x).
 *
 * A nightly, read-only export of the site's content (every collection, menus, settings, redirects, sections, widgets,
 * taxonomies, bylines, SEO and the media library's records, plus a manifest of the media files in R2) to the site's own
 * R2 bucket under `backups/<yyyy-mm-dd>/`, kept 30 daily + 12 monthly. A "Backups" admin page (admins only): list,
 * "Back up now", one-time download links, and restore of the site settings, the menus or a single entry from a chosen
 * backup with a preview of the changes — always after a fresh backup. Email alerts when the nightly backup fails twice
 * in a row, an optional off-site copy (any S3-compatible bucket), and a public heartbeat (time of the last backup) for
 * Site health and the kit's verify. A monthly restore test restores the newest backup into an empty scratch D1 database
 * (RESTORE_DRILL_DB; a dry run without it) and checks it. Full-site restore stays a guided CLI step (D1 Time Travel). Never in a backup:
 * users, passkeys, sessions, API/OAuth tokens, plugin data and secrets, form messages, comments.
 *
 * This entry is safe to import from astro.config (Node): it only builds the plugin descriptor. The Worker-side module
 * is `@wp2emdash/backups/plugin`. See README.md.
 */
import { BACKUPS_PLUGIN } from "./meta.js";

export { BACKUPS_PLUGIN };

export interface BackupsOptions {
	/** The production address, e.g. "https://example.com" (alert links, restore commands). */
	productionUrl: string;
	siteName: string;
	/** The domain serves this site (after go-live). Before that backups run, but failure alerts are not emailed. */
	live: boolean;
	/** Failure-alert recipients (kit.config backups.alertsTo → health.alertsTo → email.stagingTo). */
	alertsTo: string[];
	/** How many backups to keep: every backup of the last `daily` days + the first backup of each of the last `monthly` months. */
	retention?: { daily?: number; monthly?: number };
	/** UTC hour of the nightly backup (default: 01–03, fixed per site so sites in one account do not run at once). */
	hourUtc?: number;
	/** Worker binding names (the kit's defaults: MEDIA and DB). */
	bindings?: { bucket?: string; database?: string };
	/** The production D1 database name: shown in the full-site restore command (wrangler d1 time-travel restore <name>). */
	database?: string;
	/**
	 * Opt-in second copy of every backup to an S3-compatible bucket (another R2 account, AWS S3, Backblaze B2, …).
	 * Credentials are Worker secrets BACKUP_S3_ACCESS_KEY_ID / BACKUP_S3_SECRET_ACCESS_KEY, never options. The Worker
	 * only writes there (no deletes): set a lifecycle rule on that bucket for retention.
	 */
	offsite?: { endpoint: string; bucket: string; region?: string; prefix?: string };
	/**
	 * The restore test (default on; `false` turns it off): every `everyDays` days (30) the newest full backup is restored
	 * into an empty scratch D1 database (Worker binding `binding`, default RESTORE_DRILL_DB), checked against the backup's
	 * own counts, `mediaSample` media files (12) are checked in R2, and the scratch database is emptied again. Without
	 * the binding the backup is validated against the live schema without writing anything (dry run). Never on staging.
	 */
	restoreDrill?: false | { everyDays?: number; mediaSample?: number; tolerancePct?: number; hourUtc?: number; binding?: string };
	/** Footer line of alert emails, e.g. "Prepared by <your agency>". */
	footer?: string;
}

/** The EmDash plugin descriptor for `emdash({ plugins: [backupsPlugin({...})] })`: adds Plugins → Backups. */
export function backupsPlugin(options: BackupsOptions) {
	return { ...BACKUPS_PLUGIN, format: "native" as const, displayName: "Backups", description: "Nightly content backups to the site's storage, downloads, and restore of settings, menus or a single page", entrypoint: "@wp2emdash/backups/plugin", options };
}
