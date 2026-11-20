/**
 * Where the motion settings live and how pages learn about a change — the same mechanism as Privacy & consent and SEO &
 * Analytics: the plugin's KV (`ctx.kv.set("settings", …)`), which EmDash 1.5 keeps as a row of the D1 `options` table
 * named `plugin:<pluginId>:<key>` (createKVAccess in EmDash's plugin context). The site reads that one row by primary
 * key on a route-cache miss (starter utils/motion.ts, loaded with the chrome in the page frontmatter); saving purges the
 * cached pages by the tags every page carries (`wp2emdash:analytics`, `emdash:settings`).
 */
import { purgePages } from "@wp2emdash/seo/analytics/store";
import { MOTION_PLUGIN } from "./meta.js";
import { type MotionSettings, parseSettings } from "./settings.js";

export const KV_KEY = "settings";
export const OPTION_NAME = `plugin:${MOTION_PLUGIN.id}:${KV_KEY}`;
export { purgePages };

export interface D1Like {
	prepare(query: string): { bind(...values: unknown[]): { first<T>(): Promise<T | null> } };
}

export interface Kv {
	get<T>(k: string): Promise<T | null>;
	set(k: string, v: unknown): Promise<void>;
}

/** The saved settings; undefined when never saved, unreadable or damaged — the site then shows motion as built. */
export async function readStoredMotion(db: D1Like | undefined): Promise<MotionSettings | undefined> {
	if (!db) return undefined;
	try {
		const row = await db.prepare("SELECT value FROM options WHERE name = ? LIMIT 1").bind(OPTION_NAME).first<{ value: string }>();
		return row ? parseSettings(JSON.parse(row.value)) : undefined;
	} catch {
		return undefined;
	}
}
