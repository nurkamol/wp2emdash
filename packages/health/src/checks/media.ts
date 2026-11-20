/**
 * Media: the counts the Media Assistant (@wp2emdash/media) keeps from its daily scan — images on pages without alt
 * text, oversized originals, broken image references — read from that plugin's KV row in D1 (`options`,
 * `plugin:media-assistant:summary`, one SELECT). Hourly; no request, no public route. Never alerts: it is a to-do list,
 * not an outage.
 */
import type { D1Like } from "@wp2emdash/seo/analytics/store";
import type { CheckState } from "../store.js";
import { DAY, shortTime } from "../util.js";

export const MEDIA_SUMMARY_OPTION = "plugin:media-assistant:summary";

export interface MediaSummary {
	at: string;
	missingAltUsed: number;
	oversized: number;
	broken: number;
	unused?: number;
}

export async function readMediaSummary(db: D1Like | undefined): Promise<MediaSummary | null | undefined> {
	const prep = db?.prepare("SELECT value FROM options WHERE name = ? LIMIT 1") as unknown as { bind?(...v: unknown[]): { all?<T>(): Promise<{ results?: T[] }> } } | undefined;
	const stmt = prep?.bind?.(MEDIA_SUMMARY_OPTION);
	if (!stmt?.all) return undefined;
	try {
		const row = ((await stmt.all<{ value: string }>()).results ?? [])[0];
		return row ? (JSON.parse(row.value) as MediaSummary) : null;
	} catch {
		return undefined;
	}
}

const n = (x: number, one: string, many = `${one}s`) => `${x} ${x === 1 ? one : many}`;

export function mediaCheck(on: boolean, s: MediaSummary | null | undefined, at: string, now = Date.now()): CheckState {
	if (!on) return { status: "off", summary: "The Media Assistant is off for this site (kit.config media: false).", at };
	if (s === undefined) return { status: "unknown", summary: "The media counts could not be read.", at };
	if (s === null) return { status: "unknown", summary: "The media library has not been scanned yet: open Plugins → Media.", at };
	const detail = [`Scanned ${shortTime(s.at)}.`];
	if (now - Date.parse(s.at) > 3 * DAY) detail.push("The daily scan has not run for 3 days.");
	if (s.broken) return { status: "fail", summary: `${n(s.broken, "place")} on the site point at a picture that no longer exists. See Plugins → Media → Broken.`, at, detail };
	const todo = [s.missingAltUsed ? `${n(s.missingAltUsed, "image")} on pages without alt text` : "", s.oversized ? `${n(s.oversized, "oversized original")}` : ""].filter(Boolean);
	if (todo.length) return { status: "warn", summary: `${todo.join(", ")}. See Plugins → Media.`, at, detail };
	return { status: "ok", summary: "Every image on the pages has alt text and no original is oversized.", at, detail };
}
