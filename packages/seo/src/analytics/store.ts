/**
 * Where the tracker list lives and how pages learn about a change.
 *
 * Storage: the SEO plugin's KV (`ctx.kv.set("analytics", …)`). In EmDash 1.5 plugin KV is a row of the `options`
 * table in D1, named `plugin:<pluginId>:<key>` with the value as JSON (emdash/src/plugins/context.ts createKVAccess →
 * OptionsRepository). The site reads that one row by primary key with the Worker's `DB` binding — once per page
 * render, which only happens on a route-cache miss (a cache hit never runs the Worker).
 *
 * Freshness: saving purges the route cache by tag (`cache.purge({ tags })` from `cloudflare:workers` — exactly what
 * the Astro Cloudflare cache provider's `invalidate()` does for EmDash). Every page carries CACHE_TAG (set with the
 * chrome hints in the page frontmatter) and `emdash:settings` (site settings are part of every page's chrome).
 */
import { SEO_PLUGIN } from "../meta.js";
import { type EventSettings, parseEvents, parseTrackers, type Tracker } from "./trackers.js";

export const KV_KEY = "analytics";
/** The options-table row behind `ctx.kv` key KV_KEY (EmDash 1.5: `plugin:<id>:<key>`). */
export const OPTION_NAME = `plugin:${SEO_PLUGIN.id}:${KV_KEY}`;
export const CACHE_TAG = "wp2emdash:analytics";
export const PURGE_TAGS = [CACHE_TAG, "emdash:settings"];

export interface StoredAnalytics {
	version: 1;
	trackers: Tracker[];
	events: EventSettings;
	/** Consent mode (off by default): Google starts denied; Meta, Clarity and Hotjar wait for consent. */
	consent: boolean;
	updatedAt: string;
	/** Who saved last (name or email of the admin); absent for the first-load prefill. */
	updatedBy?: string;
}

/** A stored value read back, validated; undefined when it is not a usable record. */
export function parseStored(v: unknown): StoredAnalytics | undefined {
	const trackers = parseTrackers(v);
	if (!trackers || !v || typeof v !== "object") return undefined;
	const o = v as Record<string, unknown>;
	return { version: 1, trackers, events: parseEvents(o.events), consent: o.consent === true, updatedAt: typeof o.updatedAt === "string" ? o.updatedAt.slice(0, 40) : "", ...(typeof o.updatedBy === "string" ? { updatedBy: o.updatedBy.slice(0, 80) } : {}) };
}

export interface D1Like {
	prepare(query: string): { bind(...values: unknown[]): { first<T>(): Promise<T | null> } };
}

/**
 * The saved settings, read straight from D1. `undefined` = never saved (nobody opened the page yet: the site uses the
 * IDs carried over from WordPress). `null` = could not be read: the caller loads nothing rather than guessing (a
 * removed tracker must not come back because of a failed read).
 */
export async function readStoredAnalytics(db: D1Like | undefined): Promise<StoredAnalytics | undefined | null> {
	if (!db) return null;
	try {
		const row = await db.prepare("SELECT value FROM options WHERE name = ? LIMIT 1").bind(OPTION_NAME).first<{ value: string }>();
		if (!row) return undefined;
		return parseStored(JSON.parse(row.value)) ?? null;
	} catch {
		return null;
	}
}

export interface PurgeApi {
	purge(options: { tags: string[] }): Promise<{ success: boolean; errors?: { code: number; message: string }[] } | undefined | void>;
}
export type PurgeResult = "purged" | "no-cache" | "failed";

/** Purges every page that shows analytics. Never throws: the save already happened. */
export async function purgePages(api: PurgeApi | undefined): Promise<PurgeResult> {
	if (!api || typeof api.purge !== "function") return "no-cache";
	try {
		const r = await api.purge({ tags: PURGE_TAGS });
		return r && r.success === false ? "failed" : "purged";
	} catch {
		return "failed";
	}
}
