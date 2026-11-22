/**
 * Backups & Restore (@wp2emdash/backups, on by default): the plugin options scaffold writes into astro.config —
 * retention, the nightly hour, failure-alert recipients (kit.config backups.alertsTo → health.alertsTo →
 * email.stagingTo), the production D1 name for the full-site restore command, and the optional off-site bucket
 * (endpoint, bucket, region, prefix — never its keys: those are Worker secrets), and the monthly restore test.
 */
import type { BackupsOptions } from "../../packages/backups/src/index.js";
import type { KitConfig } from "../config/schema.js";

/** The restore test's scratch D1 binding (packages/backups/src/drill.ts DRILL_BINDING). */
export const RESTORE_DRILL_BINDING = "RESTORE_DRILL_DB";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const valid = (list: string[]) => [...new Set(list.map((x) => x.trim()).filter((x) => EMAIL.test(x)))];

export interface BackupsInputs {
	config: Pick<KitConfig, "name" | "email" | "health" | "backups">;
	productionUrl: string;
	live: boolean;
	/** The production D1 database name (cloudflare.json), for the restore command shown on the page. */
	database?: string;
	footer?: string;
}

export function backupsOptions(i: BackupsInputs): BackupsOptions | undefined {
	const b = i.config.backups;
	if (b === false) return undefined;
	const healthTo = i.config.health === false ? undefined : i.config.health.alertsTo;
	return {
		productionUrl: i.productionUrl,
		siteName: i.config.name,
		live: i.live,
		alertsTo: valid(b.alertsTo ?? healthTo ?? i.config.email.stagingTo),
		retention: { daily: b.retention.daily, monthly: b.retention.monthly },
		...(b.hourUtc !== undefined ? { hourUtc: b.hourUtc } : {}),
		bindings: { bucket: "MEDIA", database: "DB" },
		...(i.database ? { database: i.database } : {}),
		...(b.offsite ? { offsite: { endpoint: b.offsite.endpoint, bucket: b.offsite.bucket, region: b.offsite.region, ...(b.offsite.prefix ? { prefix: b.offsite.prefix } : {}) } } : {}),
		// The restore test: the scratch database binding exists only once provision recorded it (else a dry run).
		restoreDrill: b.restoreDrill === false ? false : { everyDays: b.restoreDrill.everyDays, mediaSample: b.restoreDrill.mediaSample, tolerancePct: b.restoreDrill.tolerancePct, binding: RESTORE_DRILL_BINDING },
		footer: i.footer ?? (i.config.health === false ? "Backups & Restore" : i.config.health.brand),
	};
}
