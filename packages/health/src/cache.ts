/**
 * Page cache refill ("re-warm"): the Site health page's side (Speed tab). The generated site's Worker cron does the
 * refill (starter/src/worker.ts + starter/src/utils/rewarm.ts, which keeps its own copy of these rows and the setting
 * parser because Site health can be switched off; test/cache-refill.test.ts keeps the two in step).
 *
 * - The admin's choice lives in the plugin's KV (`options` row `plugin:site-health:rewarm`): on/off and how often.
 *   Absent: the kit's default (on, every `performance.rewarmMinutes`).
 * - "Refresh all pages now" purges the cached pages and leaves a request row; the next cron tick (within 5 minutes)
 *   refills them, even when the scheduled refill is off.
 * - Each run writes its result (`plugin:site-health:rewarm:last`): counts and each page's state, shown on the Speed tab.
 * - Never while coming-soon mode is on (the holding page must not be what the run sees).
 */

export const REWARM_KEYS = { setting: "rewarm", request: "rewarm:request", last: "rewarm:last" } as const;
export const PREFIX = "plugin:site-health:";
/** The same rows as EmDash `options` names (the Worker reads and writes them with D1). */
export const REWARM_OPTIONS = { setting: `${PREFIX}${REWARM_KEYS.setting}`, request: `${PREFIX}${REWARM_KEYS.request}`, last: `${PREFIX}${REWARM_KEYS.last}`, maintenance: `${PREFIX}maintenance` } as const;

export const REWARM_INTERVALS = [15, 30, 60] as const;

export interface RewarmSetting {
	on: boolean;
	everyMinutes: number;
	at?: string;
	by?: string;
}

export interface RewarmPage {
	path: string;
	state: "cached" | "rendered" | "failed";
	status: number;
}

export interface RewarmLast {
	at: string;
	trigger: "schedule" | "manual";
	pages: number;
	rendered: number;
	failed: number;
	ms: number;
	list: RewarmPage[];
}

/** The stored setting (a JSON string from D1, or the parsed value from the plugin KV), else the default. */
export function parseRewarmSetting(raw: unknown, defaultMinutes: number): RewarmSetting {
	const fallback: RewarmSetting = { on: defaultMinutes > 0, everyMinutes: defaultMinutes > 0 ? defaultMinutes : 15 };
	let v: unknown = raw;
	if (typeof raw === "string") {
		try {
			v = JSON.parse(raw);
		} catch {
			return fallback;
		}
	}
	if (!v || typeof v !== "object") return fallback;
	const o = v as Record<string, unknown>;
	const minutes = Number(o.everyMinutes);
	return {
		on: o.on === true,
		everyMinutes: Number.isInteger(minutes) && minutes >= 5 ? minutes : fallback.everyMinutes,
		...(typeof o.at === "string" ? { at: o.at } : {}),
		...(typeof o.by === "string" ? { by: o.by } : {}),
	};
}
