/**
 * Per-site incident state machine. up → (1 failed check) suspect → (2nd failed check in a row) down: incident opened,
 * one alert. down → (first good check) up: incident closed, one recovery alert. suspect → (good check) up: a blip,
 * no alert. Repeated failures while down change nothing (so nothing is written to KV). Pure.
 */

export const FAILS_FOR_INCIDENT = 2;

export type SiteStatus = "up" | "suspect" | "down";

export interface SiteState {
	status: SiteStatus;
	/** When the current status began (ISO). For "suspect"/"down": the first failed check. */
	since: string;
	/** Failed checks in a row (capped at FAILS_FOR_INCIDENT). */
	fails: number;
	/** Reason of the check that set this status. */
	reason?: string;
	/** Open incident id (status "down"). */
	incident?: string;
}

export interface IncidentEvent {
	type: "open" | "close";
	site: string;
	incident: string;
	/** First failed check (ISO). */
	startedAt: string;
	/** open: when the incident was confirmed; close: when the site answered again. */
	at: string;
	reason: string;
	/** close: how long the site was down. */
	durationMs?: number;
}

export interface Transition {
	next: SiteState;
	/** The stored state differs (KV must be written). */
	changed: boolean;
	event?: IncidentEvent;
}

export function step(prev: SiteState | undefined, r: { ok: boolean; reason: string }, now: number, site: string): Transition {
	const at = new Date(now).toISOString();
	if (!prev) {
		const next: SiteState = r.ok ? { status: "up", since: at, fails: 0 } : { status: "suspect", since: at, fails: 1, reason: r.reason };
		return { next, changed: true };
	}
	if (r.ok) {
		if (prev.status === "up") return { next: prev, changed: false };
		const next: SiteState = { status: "up", since: at, fails: 0 };
		if (prev.status === "suspect") return { next, changed: true };
		const startedAt = prev.since;
		return { next, changed: true, event: { type: "close", site, incident: prev.incident ?? `${site}-${Date.parse(startedAt).toString(36)}`, startedAt, at, reason: r.reason, durationMs: now - Date.parse(startedAt) } };
	}
	if (prev.status === "down") return { next: prev, changed: false };
	const fails = Math.min(prev.status === "suspect" ? prev.fails + 1 : 1, FAILS_FOR_INCIDENT);
	if (fails < FAILS_FOR_INCIDENT) return { next: { status: "suspect", since: prev.status === "suspect" ? prev.since : at, fails, reason: r.reason }, changed: true };
	const since = prev.status === "suspect" ? prev.since : at;
	const incident = `${site}-${Date.parse(since).toString(36)}`;
	return { next: { status: "down", since, fails, reason: r.reason, incident }, changed: true, event: { type: "open", site, incident, startedAt: since, at, reason: r.reason } };
}
