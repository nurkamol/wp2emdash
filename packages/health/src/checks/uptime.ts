/**
 * Uptime: every tick the home page and one page of the sitemap (rotating), plus any page that failed last time. A page
 * fails when it gives no answer within the time limit or answers 4xx/5xx. Two failures in a row open an incident (the
 * home page: "Down"; another page: "Page error"); the first good answer closes it (recovery). Pure functions.
 */
import { answered, type Probe } from "../probe.js";
import type { CheckState, HealthState, Incident, OpenIncident, Today } from "../store.js";
import { duration, plural } from "../util.js";

export const FAILS_FOR_INCIDENT = 2;
const MAX_PER_TICK = 3;

type Uptime = HealthState["uptime"];

/** Paths to probe this tick: home, then open incidents and retries, then the next sitemap page. */
export function pickPaths(u: Uptime, sitemap: string[]): { paths: string[]; cursor: number } {
	const out = ["/"];
	for (const p of [...Object.keys(u.open), ...u.retry]) if (!out.includes(p) && out.length < MAX_PER_TICK) out.push(p);
	const pool = sitemap.filter((p) => p !== "/");
	let cursor = u.cursor;
	if (out.length < MAX_PER_TICK && pool.length) {
		const p = pool[cursor % pool.length] as string;
		cursor = (cursor + 1) % pool.length;
		if (!out.includes(p)) out.push(p);
	}
	return { paths: out, cursor };
}

export interface UptimeChange {
	uptime: Uptime;
	opened: Incident[];
	closed: Incident[];
}

/** Applies this tick's probes: counts consecutive failures, opens and closes incidents. Pure. */
export function applyProbes(u: Uptime, probes: { path: string; probe: Probe }[], cursor: number, now: number): UptimeChange {
	const at = new Date(now).toISOString();
	const fails = { ...u.fails };
	const open = { ...u.open };
	const retry: string[] = [];
	const opened: Incident[] = [];
	const closed: Incident[] = [];
	for (const { path, probe } of probes) {
		if (answered(probe)) {
			delete fails[path];
			const o = open[path];
			if (o) {
				delete open[path];
				closed.push({ ...incidentOf(o), endedAt: at, detail: `${o.path} answered again (HTTP ${probe.status}) after ${duration(now - Date.parse(o.startedAt))}` });
			}
			continue;
		}
		fails[path] = (fails[path] ?? 0) + 1;
		if (fails[path] >= FAILS_FOR_INCIDENT && !open[path]) {
			const o: OpenIncident = { id: `${path === "/" ? "down" : "page"}-${now.toString(36)}-${opened.length}`, path, startedAt: at, status: probe.status };
			open[path] = o;
			opened.push(incidentOf(o, probe));
		} else if (path !== "/" && !open[path]) retry.push(path);
	}
	return { uptime: { fails, open, cursor, retry: retry.slice(0, MAX_PER_TICK - 1) }, opened, closed };
}

const what = (status: number, error?: string) => (status ? `HTTP ${status}` : (error ?? "no answer"));

export function incidentOf(o: OpenIncident, p?: Probe): Incident {
	const home = o.path === "/";
	return { id: o.id, kind: home ? "down" : "page", title: home ? "Site down: the home page does not answer" : `Page error on ${o.path}`, startedAt: o.startedAt, detail: `${o.path}: ${what(o.status, p?.error)}, ${FAILS_FOR_INCIDENT} checks in a row` };
}

/** Adds the home-page probe to today's counters. Pure. */
export function countHome(today: Today, home: Probe): Today {
	const ok = answered(home);
	return { ...today, probes: today.probes + 1, fails: today.fails + (ok ? 0 : 1), ttfb: ok ? [...today.ttfb, home.ms].slice(-300) : today.ttfb };
}

export function uptimeCheck(u: Uptime, today: Today, home: Probe, at: string): CheckState {
	const pct = today.probes ? `${(((today.probes - today.fails) / today.probes) * 100).toFixed(today.fails ? 2 : 0)}%` : "—";
	const day = `Today: the home page answered ${today.probes - today.fails} of ${plural(today.probes, "check")} (${pct}).`;
	const down = u.open["/"];
	const pages = Object.values(u.open).filter((o) => o.path !== "/");
	if (down) return { status: "fail", summary: `The site is down since ${down.startedAt.slice(11, 16)} UTC (${what(down.status)}).`, at, detail: [day] };
	if (pages.length) return { status: "warn", summary: `${plural(pages.length, "page")} not answering: ${pages.map((p) => p.path).slice(0, 3).join(", ")}.`, at, detail: [day] };
	if (!answered(home)) return { status: "warn", summary: `The home page did not answer once (${what(home.status, home.error)}); checking again in 5 minutes.`, at, detail: [day] };
	return { status: "ok", summary: `Up. The home page answered in ${home.ms} ms.`, at, detail: [day] };
}
