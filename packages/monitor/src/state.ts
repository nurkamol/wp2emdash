/**
 * The monitor's whole state is ONE KV value (key `state`), read once per tick and written at most once per tick — only
 * when something changed (a site's status, an expiry date, an alert sent or queued) or once a day as a heartbeat.
 *
 * KV budget (free plan: 100,000 reads and 1,000 writes a day): reads = 288 ticks + status page views; writes ≤ 288
 * by construction (one put per tick at most), in practice 1 heartbeat + 2 per blip (suspect, back up) + 3 per
 * incident (suspect, down, up) + expiry changes (renewals, warnings): a handful a day.
 */
import { type AlertEvent, type AlertLog, emptyLog } from "./alerts.js";
import type { ExpiryInfo } from "./expiry.js";
import type { SiteState } from "./incident.js";

export const STATE_KEY = "state";

export interface PendingAlert {
	event: AlertEvent;
	attempts: number;
}

export interface MonitorState {
	v: 1;
	sites: Record<string, SiteState>;
	expiry: Record<string, ExpiryInfo>;
	alerts: AlertLog;
	/** Events no channel could deliver: retried next tick, MAX_ATTEMPTS in all. */
	pending: PendingAlert[];
	/** UTC day of the last heartbeat write. */
	heartbeat: string;
	/** When the state was last written (ISO). */
	writtenAt?: string;
	/** Channels that failed at the last delivery (names only). */
	lastDeliveryFailed?: string[];
}

export const MAX_ATTEMPTS = 3;

export const emptyState = (): MonitorState => ({ v: 1, sites: {}, expiry: {}, alerts: emptyLog(), pending: [], heartbeat: "" });

/** Stored text → state; anything unreadable starts fresh (sites then begin as up/suspect on this tick). */
export function parseState(raw: string | null): MonitorState {
	if (!raw) return emptyState();
	try {
		const o = JSON.parse(raw) as Partial<MonitorState>;
		if (o?.v !== 1) return emptyState();
		return {
			v: 1,
			sites: o.sites && typeof o.sites === "object" ? o.sites : {},
			expiry: o.expiry && typeof o.expiry === "object" ? o.expiry : {},
			alerts: o.alerts && typeof o.alerts === "object" && o.alerts.sent ? o.alerts : emptyLog(),
			pending: Array.isArray(o.pending) ? o.pending : [],
			heartbeat: typeof o.heartbeat === "string" ? o.heartbeat : "",
			...(o.writtenAt ? { writtenAt: o.writtenAt } : {}),
			...(o.lastDeliveryFailed?.length ? { lastDeliveryFailed: o.lastDeliveryFailed } : {}),
		};
	} catch {
		return emptyState();
	}
}

/** Canonical text without the write timestamp, to compare states. */
export const fingerprint = (s: MonitorState) => JSON.stringify({ ...s, writtenAt: undefined });
