/** Changes to the tracker list and switches from the admin page: pure functions (unit-tested), no EmDash imports. */
import { ADDABLE_TYPES, EVENT_KINDS, type EventSettings, isTrackerType, listProblems, normalizeId, SPECS, type Tracker } from "./trackers.js";

export type Change = { ok: true; trackers: Tracker[]; message: string } | { ok: false; errors: string[] };

const MAX = 30;

export function addTracker(list: Tracker[], values: Record<string, unknown>, o: { id: string; now: string }): Change {
	const type = values.type;
	if (!isTrackerType(type) || !(ADDABLE_TYPES as readonly string[]).includes(type)) return { ok: false, errors: [type === "ua" ? (SPECS.ua.retired as string) : "Choose a service."] };
	const n = normalizeId(type, values.value);
	if (!n.ok) return { ok: false, errors: [n.error] };
	if (list.length >= MAX) return { ok: false, errors: [`At most ${MAX} tracking codes.`] };
	const next = [...list, { id: o.id, type, value: n.value, enabled: values.enabled !== false, addedAt: o.now, origin: "admin" as const }];
	const problems = listProblems(next);
	if (problems.length) return { ok: false, errors: problems };
	return { ok: true, trackers: next, message: `${SPECS[type].name} ${n.value} added${values.enabled === false ? " (off)" : ""}.` };
}

export function editTracker(list: Tracker[], id: string, values: Record<string, unknown>): Change {
	const t = list.find((x) => x.id === id);
	if (!t) return { ok: false, errors: ["That tracking code is no longer in the list."] };
	const n = normalizeId(t.type, values.value);
	if (!n.ok) return { ok: false, errors: [n.error] };
	const next = list.map((x) => (x.id === id ? { ...x, value: n.value, enabled: values.enabled !== false && !SPECS[x.type].retired } : x));
	const problems = listProblems(next);
	if (problems.length) return { ok: false, errors: problems };
	return { ok: true, trackers: next, message: `${SPECS[t.type].name} ${n.value} saved.` };
}

export function toggleTracker(list: Tracker[], id: string): Change {
	const t = list.find((x) => x.id === id);
	if (!t) return { ok: false, errors: ["That tracking code is no longer in the list."] };
	const next = list.map((x) => (x.id === id ? { ...x, enabled: !x.enabled } : x));
	const problems = listProblems(next);
	if (problems.length) return { ok: false, errors: problems };
	return { ok: true, trackers: next, message: `${SPECS[t.type].name} ${t.value} turned ${t.enabled ? "off" : "on"}.` };
}

export function removeTracker(list: Tracker[], id: string): Change {
	const t = list.find((x) => x.id === id);
	if (!t) return { ok: false, errors: ["That tracking code is no longer in the list."] };
	return { ok: true, trackers: list.filter((x) => x.id !== id), message: `${SPECS[t.type].name} ${t.value} removed.` };
}

/** The conversion-event and consent switches from their form (toggles: missing = off, as Block Kit sends them). */
export function switchesFrom(values: Record<string, unknown>): { events: EventSettings; consent: boolean } {
	return { events: Object.fromEntries(EVENT_KINDS.map((k) => [k, values[`event:${k}`] === true])) as EventSettings, consent: values.consent === true };
}
