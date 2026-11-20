/**
 * Where the consent settings live and how pages learn about a change — the same mechanism as SEO & Analytics
 * (@wp2emdash/seo analytics/store.ts): the plugin's KV (`ctx.kv.set("settings", …)`), which EmDash 1.5 keeps as a row of
 * the D1 `options` table named `plugin:<pluginId>:<key>`. The site reads that one row by primary key on a route-cache
 * miss; saving purges the cached pages by the tags every page carries (`wp2emdash:analytics`, `emdash:settings`).
 *
 * The consent log is counts per day only (accepted / rejected / custom): no IP, no identifier, no user agent, no page.
 */
import { purgePages } from "@wp2emdash/seo/analytics/store";
import { CONSENT_PLUGIN } from "./meta.js";
import { type ConsentDefaults, type ConsentSettings, parseSettings } from "./settings.js";

export const KV_KEY = "settings";
export const OPTION_NAME = `plugin:${CONSENT_PLUGIN.id}:${KV_KEY}`;
/** Public plugin route the banner posts a choice to when the consent log is on. */
export const LOG_PATH = `/_emdash/api/plugins/${CONSENT_PLUGIN.id}/log`;
export { purgePages };

export interface D1Like {
	prepare(query: string): { bind(...values: unknown[]): { first<T>(): Promise<T | null> } };
}

/** undefined = never saved (the carried-over defaults apply); null = unreadable (the caller shows no banner change). */
export async function readStoredConsent(db: D1Like | undefined, d: ConsentDefaults = {}): Promise<ConsentSettings | undefined | null> {
	if (!db) return null;
	try {
		const row = await db.prepare("SELECT value FROM options WHERE name = ? LIMIT 1").bind(OPTION_NAME).first<{ value: string }>();
		if (!row) return undefined;
		return parseSettings(JSON.parse(row.value), d) ?? null;
	} catch {
		return null;
	}
}

// ── Consent log (counts only) ────────────────────────────────────────────────────────────────────────────────

export const CHOICES = ["accept", "reject", "custom"] as const;
export type Choice = (typeof CHOICES)[number];
export type DayCounts = Record<Choice, number>;
export const STATS_DAYS = 90;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const statsKey = (day: string) => `stats:${day}`;

export interface Kv {
	get<T>(k: string): Promise<T | null>;
	set(k: string, v: unknown): Promise<void>;
	delete?(k: string): Promise<boolean>;
	list?(prefix?: string): Promise<{ key: string; value: unknown }[]>;
}

const counts = (v: unknown): DayCounts => {
	const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
	return Object.fromEntries(CHOICES.map((c) => [c, Number.isInteger(o[c]) && (o[c] as number) >= 0 ? (o[c] as number) : 0])) as DayCounts;
};

/** One choice counted for its UTC day. Read-modify-write: counts under heavy concurrency are approximate. */
export async function countChoice(kv: Kv, choice: unknown, now = new Date()): Promise<boolean> {
	if (typeof choice !== "string" || !(CHOICES as readonly string[]).includes(choice)) return false;
	const day = now.toISOString().slice(0, 10);
	const c = counts(await kv.get(statsKey(day)));
	c[choice as Choice]++;
	await kv.set(statsKey(day), c);
	return true;
}

/** The last `days` days, oldest first (days without choices count 0). */
export async function readStats(kv: Kv, days = 30, now = new Date()): Promise<{ day: string; counts: DayCounts }[]> {
	const out: { day: string; counts: DayCounts }[] = [];
	for (let i = days - 1; i >= 0; i--) {
		const day = new Date(now.getTime() - i * 86_400_000).toISOString().slice(0, 10);
		out.push({ day, counts: counts(await kv.get(statsKey(day))) });
	}
	return out;
}

/** Removes counts older than STATS_DAYS (or all of them). */
export async function pruneStats(kv: Kv, now = new Date(), all = false): Promise<number> {
	if (!kv.list || !kv.delete) return 0;
	const cutoff = new Date(now.getTime() - STATS_DAYS * 86_400_000).toISOString().slice(0, 10);
	let n = 0;
	for (const { key } of await kv.list("stats:")) {
		const day = key.slice(6);
		if (all || !DAY.test(day) || day < cutoff) {
			await kv.delete(key);
			n++;
		}
	}
	return n;
}
