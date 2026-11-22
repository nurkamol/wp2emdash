/**
 * One cron tick (every 5 minutes): read the state, check every site's home page in parallel (the runtime keeps at most
 * 6 connections waiting for headers and queues the rest), run the daily expiry lookups due in this slot, turn
 * transitions into alerts, deliver them as one message, write the state if it changed (or once a day), ping the
 * optional heartbeat URL. Network and KV are injected, so the whole tick runs in tests without either.
 */
import { type AlertEvent, composeMessage, channels, deliverAll, dayOf, expiryEvents, incidentEvents, pickAlerts } from "./alerts.js";
import { probe, type CheckResult } from "./check.js";
import { dueForExpiry, expiryApplies, type ExpiryInfo, lookupExpiry } from "./expiry.js";
import { type IncidentEvent, step } from "./incident.js";
import { fingerprint, MAX_ATTEMPTS, type MonitorState, parseState, STATE_KEY } from "./state.js";
import type { Fetch, MonitorConfig, MonitorEnv } from "./types.js";

export interface TickDeps {
	config: MonitorConfig;
	env: MonitorEnv;
	fetch: Fetch;
	/** The cron's scheduledTime (ms). */
	scheduledTime: number;
	now?: () => number;
}

export interface TickResult {
	checked: number;
	failing: number;
	opened: number;
	closed: number;
	expiryLookups: number;
	/** Events delivered on at least one channel (0 when no channel is configured or all failed). */
	sent: number;
	held: number;
	delivered: string[];
	failedChannels: string[];
	wrote: boolean;
	state: MonitorState;
	results: Record<string, CheckResult>;
}

/** Keeps the last known date when a lookup fails; drops dates already past. Pure. */
export function mergeExpiry(prev: ExpiryInfo | undefined, fresh: ExpiryInfo, now: number): ExpiryInfo {
	const keep = (v: string | undefined) => (v && Date.parse(v) > now ? v : undefined);
	const cert = fresh.cert ?? keep(prev?.cert);
	const domain = fresh.domain ?? keep(prev?.domain);
	return { ...(cert ? { cert } : {}), ...(fresh.certError ? { certError: fresh.certError } : {}), ...(domain ? { domain } : {}), ...(fresh.domainError ? { domainError: fresh.domainError } : {}) };
}

const MONDAY = 1;
const SUMMARY_SLOT = 96; // 08:00 UTC

/** Weekly summary event (Mondays 08:00 UTC, when switched on). Pure. */
export function summaryEvent(config: MonitorConfig, state: MonitorState, scheduledTime: number): AlertEvent | undefined {
	if (!config.weeklySummary) return undefined;
	const d = new Date(scheduledTime);
	if (d.getUTCDay() !== MONDAY || d.getUTCHours() * 12 + Math.floor(d.getUTCMinutes() / 5) !== SUMMARY_SLOT) return undefined;
	const down = config.sites.filter((s) => state.sites[s.id]?.status === "down");
	return {
		key: `summary:${dayOf(scheduledTime)}`,
		kind: "summary",
		severity: "info",
		title: down.length ? `weekly summary: ${down.length} of ${config.sites.length} sites down` : `weekly summary: all ${config.sites.length} sites up`,
		lines: config.sites.map((s) => {
			const st = state.sites[s.id];
			const e = state.expiry[s.id];
			return `${s.id} — ${st?.status ?? "not checked yet"}${st && st.status !== "up" ? ` since ${st.since.slice(0, 16).replace("T", " ")} UTC (${st.reason ?? ""})` : ""}${e?.cert ? ` · certificate until ${e.cert.slice(0, 10)}` : ""}${e?.domain ? ` · domain until ${e.domain.slice(0, 10)}` : ""}`;
		}),
	};
}

export async function runTick(d: TickDeps): Promise<TickResult> {
	const now = d.now ?? Date.now;
	const { config, env } = d;
	const prev = parseState(await d.env.MONITOR_KV.get(STATE_KEY));
	const before = fingerprint(prev);
	const state: MonitorState = structuredClone(prev);

	// Forget sites no longer configured.
	const ids = new Set(config.sites.map((s) => s.id));
	for (const id of Object.keys(state.sites)) if (!ids.has(id)) delete state.sites[id];
	for (const id of Object.keys(state.expiry)) if (!ids.has(id)) delete state.expiry[id];

	// 1. Home pages, in parallel.
	const checks = await Promise.all(config.sites.map((s) => probe(s, { fetch: d.fetch, timeoutMs: config.timeoutMs, now })));
	const results: Record<string, CheckResult> = {};
	const transitions: IncidentEvent[] = [];
	const t = now();
	config.sites.forEach((s, i) => {
		const r = checks[i] as CheckResult;
		results[s.id] = r;
		const tr = step(state.sites[s.id], r, t, s.id);
		state.sites[s.id] = tr.next;
		if (tr.event) transitions.push(tr.event);
	});
	const events: AlertEvent[] = incidentEvents(transitions, config.sites);

	// 2. Daily certificate / domain expiry for the sites whose slot this is.
	const due = dueForExpiry(config.sites.length, d.scheduledTime).map((i) => config.sites[i]).filter((s) => s && expiryApplies(s));
	for (const s of due) {
		if (!s) continue;
		const info = mergeExpiry(state.expiry[s.id], await lookupExpiry(s, { fetch: d.fetch, now: t, ...(env.CERTSPOTTER_API_KEY ? { certspotterKey: env.CERTSPOTTER_API_KEY } : {}) }), t);
		state.expiry[s.id] = info;
		events.push(...expiryEvents(s, info, t, config.expiryWarnDays));
	}

	// 3. Weekly summary (off by default).
	const summary = summaryEvent(config, state, d.scheduledTime);
	if (summary) events.push(summary);

	// 4. Alerts: queued retries first, then this tick's; one message for all.
	const retry = state.pending;
	state.pending = [];
	const all = [...retry.map((p) => p.event), ...events];
	const picked = pickAlerts(all, state.alerts, t, config.maxAlertsPerDay);
	state.alerts = picked.log;
	let delivered: string[] = [];
	let failedChannels: string[] = [];
	if (picked.send.length && channels(config, env).length) {
		const r = await deliverAll(composeMessage(picked.send, config.label ? { label: config.label } : {}), config, env, d.fetch);
		delivered = r.ok;
		failedChannels = r.failed;
		if (!r.ok.length) {
			// Nothing got through: un-record the keys and retry next tick (MAX_ATTEMPTS in all).
			state.alerts = { ...picked.log, count: Math.max(0, picked.log.count - 1), sent: Object.fromEntries(Object.entries(picked.log.sent).filter(([k]) => !picked.send.some((e) => e.key === k))) };
			const attempts = (k: string) => retry.find((p) => p.event.key === k)?.attempts ?? 0;
			state.pending = picked.send.map((event) => ({ event, attempts: attempts(event.key) + 1 })).filter((p) => p.attempts < MAX_ATTEMPTS);
		}
	}
	if (failedChannels.length) state.lastDeliveryFailed = failedChannels;
	else if (delivered.length) delete state.lastDeliveryFailed;

	// 5. Write only on change, or once a day.
	const today = dayOf(t);
	const heartbeatDue = state.heartbeat !== today;
	state.heartbeat = today;
	let wrote = false;
	if (heartbeatDue || fingerprint(state) !== before) {
		state.writtenAt = new Date(t).toISOString();
		await env.MONITOR_KV.put(STATE_KEY, JSON.stringify(state));
		wrote = true;
	}

	// 6. Dead-man's switch.
	if (env.HEARTBEAT_URL && /^https:\/\//.test(env.HEARTBEAT_URL)) {
		try {
			const r = await d.fetch(env.HEARTBEAT_URL, { method: "GET", redirect: "follow" });
			await r.body?.cancel().catch(() => {});
		} catch {}
	}

	return {
		checked: checks.length,
		failing: checks.filter((c) => !c.ok).length,
		opened: transitions.filter((e) => e.type === "open").length,
		closed: transitions.filter((e) => e.type === "close").length,
		expiryLookups: due.length,
		sent: delivered.length ? picked.send.length : 0,
		held: picked.held.length,
		delivered,
		failedChannels,
		wrote,
		state,
		results,
	};
}
