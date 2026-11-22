/**
 * One run of the checks: what the cron tick (every 5 minutes) or "Run checks now" does. Plans the jobs that are due
 * (schedule.ts), runs them, updates the stored state, history and incidents, and sends the alerts this run allows.
 * Everything outside (KV, the Worker's own fetch, plain fetch, the environment, EmDash content and email) comes in
 * through `RunDeps`, so the whole run is unit-tested with mocks.
 */
import type { OutboxEnv } from "@wp2emdash/forms/outbox";
import type { D1Like } from "@wp2emdash/seo/analytics/store";
import { type AlertEvent, alertEvents, alertMail, type AlertLog, pickAlerts } from "./alerts.js";
import { analyticsCheck, expectedTrackers } from "./checks/analytics.js";
import { backupsCheck, readBackupBeat, readDrillSummary } from "./checks/backups.js";
import { compareMail, dnsCheck } from "./checks/dns.js";
import { mediaCheck, readMediaSummary } from "./checks/media.js";
import { NOTFOUND_WINDOW, notFoundCheck, readNotFound, summarizeNotFound } from "./checks/notfound.js";
import { formsCheck, readForms } from "./checks/forms.js";
import { homeIndexing, indexabilityCheck, parseSiteFiles, sitemapLocs, sitemapPaths } from "./checks/indexability.js";
import { linksCheck, type LinkJob, resultOf, startJob, stepJob, updateLedger } from "./checks/links.js";
import { fetchCrux, speedCheck } from "./checks/speed.js";
import { headersCheck, type SecurityFacts } from "./checks/headers.js";
import { readCertificates, sslCheck } from "./checks/ssl.js";
import { cspAlertEvents, type CspEntry, type CspStore, cspMonth, readCspStore, takeFresh } from "./csp.js";
import { applyProbes, countHome, pickPaths, uptimeCheck } from "./checks/uptime.js";
import { type MailEnv, type PluginEmail, sendMail } from "./email.js";
import type { HealthOptions } from "./index.js";
import { maintenanceActive, type MaintenanceSetting } from "./maintenance.js";
import { answered, type Fetcher, probe } from "./probe.js";
import { type Redirected, type RedirectsAccess, redirectSources, withoutRedirected } from "./redirects.js";
import { buildReport, type ReportData, reportMail } from "./report.js";
import { type ReportSources, reportSources } from "./sources.js";
import { parseSeoSummary, readSeoSummary, type SeoSummary } from "@wp2emdash/seo/summary";
import { type Improvement, improvements } from "./improve.js";
import { needsLook, readVisual } from "./checks/visual.js";
import type { NotFoundSummary } from "./checks/notfound.js";
import { EXTERNAL_SAMPLE, externalDue, LINK_BUDGET, LINK_CONCURRENCY, LOCK_MS, MANUAL_EVERY, planRun, reportDue } from "./schedule.js";
import { CHECK_IDS, type CheckId, type CheckState, type Cwv, type DayRow, type HealthState, type Incident, KEYS, type Kv, type LinkLedger, type LinksResult, MAX_REPORTS, pruneIncidents, readState, rollDay, type Settings, type Today, upsertDay } from "./store.js";
import { dayOf, median, monthOf, previousMonth } from "./util.js";

export interface HealthEnv extends OutboxEnv, MailEnv {
	DB?: D1Like;
	CRUX_API_KEY?: string;
	/** Google Cloud API key with the PageSpeed Insights API enabled (falls back to CRUX_API_KEY). */
	PAGESPEED_API_KEY?: string;
	CF_ZONE_READ_TOKEN?: string;
	CF_ANALYTICS_TOKEN?: string;
	CF_ANALYTICS_ACCOUNT_ID?: string;
	CF_ANALYTICS_SITE_TAG?: string;
}

export interface ContentLister {
	list(collection: string, o?: { limit?: number; cursor?: string; orderBy?: Record<string, "asc" | "desc"> }): Promise<{ items: { id: string; slug: string | null; status?: string; data: Record<string, unknown>; seo?: unknown; publishedAt?: string | null; updatedAt?: string; createdAt?: string }[]; cursor?: string; hasMore?: boolean }>;
}

export interface RunDeps {
	kv: Kv;
	options: HealthOptions;
	env: HealthEnv;
	/** Requests to the site itself (the Worker's SELF binding, with the production URL). */
	self: Fetcher;
	/** Requests elsewhere: DNS over HTTPS, Cloudflare and Google APIs, the weekly sample of external links. */
	fetch: Fetcher;
	email?: PluginEmail;
	content?: ContentLister;
	media?: unknown;
	/** EmDash's redirects (`ctx.redirects`, capability redirects:write): redirected addresses leave the Missing pages list. */
	redirects?: RedirectsAccess;
	log?: { info(m: string, d?: Record<string, unknown>): void; warn?(m: string, d?: Record<string, unknown>): void };
	now: number;
}

export interface RunResult {
	ran: string[];
	skipped?: "locked" | "too-soon";
	alerts: { sent: number; held: number; notEmailed?: string };
	state: HealthState;
}

const iso = (t: number) => new Date(t).toISOString();

/** Single flight: one run at a time (atomic compare-and-set on the plugin KV; a crashed run frees it after LOCK_MS). */
export async function acquireLock(kv: Kv, now: number, key: string = KEYS.lock, ms = LOCK_MS): Promise<boolean> {
	const value = { until: iso(now + ms) };
	if (kv.getVersioned && kv.compareAndSet) {
		const cur = await kv.getVersioned<{ until: string }>(key);
		if (cur && Date.parse(cur.value.until) > now) return false;
		return (await kv.compareAndSet(key, cur ? cur.revision : null, value)).applied;
	}
	const cur = await kv.get<{ until: string }>(key);
	if (cur && Date.parse(cur.until) > now) return false;
	await kv.set(key, value);
	return true;
}
export const releaseLock = (kv: Kv, key: string = KEYS.lock) => kv.delete(key);

export const settingsOf = async (kv: Kv): Promise<Settings> => (await kv.get<Settings>(KEYS.settings)) ?? {};
export const alertRecipients = (s: Settings, o: HealthOptions) => (s.alertsTo?.length ? s.alertsTo : o.alertsTo);
export const reportRecipients = (s: Settings, o: HealthOptions) => [...new Set([...(s.reportTo?.length ? s.reportTo : o.reportTo), ...alertRecipients(s, o)].map((x) => x.toLowerCase()))];

/** Why nothing is emailed right now (undefined: emails go out). */
export function emailBlocked(o: HealthOptions, env: HealthEnv, s: Settings, kind: "alerts" | "report"): string | undefined {
	if (env.STAGING === "1") return "this is the staging site";
	if (!o.live) return "the site is not live yet (the domain still shows the old site)";
	if (kind === "alerts" && s.alerts === false) return "alerts are switched off";
	if (kind === "report" && (s.report === false || o.monthlyReport === false)) return "the monthly report is switched off";
	return undefined;
}

export const adminUrl = (o: HealthOptions) => `${o.productionUrl.replace(/\/$/, "")}/_emdash/admin/plugins/site-health/health`;

export async function runChecks(d: RunDeps, mode: { manual?: boolean } = {}): Promise<RunResult> {
	const { kv, options: o, env, now } = d;
	let state = await readState(kv);
	if (mode.manual && state.jobs.manual && now - Date.parse(state.jobs.manual) < MANUAL_EVERY) return { ran: [], skipped: "too-soon", alerts: { sent: 0, held: 0 }, state };
	if (!(await acquireLock(kv, now))) return { ran: [], skipped: "locked", alerts: { sent: 0, held: 0 }, state };
	try {
		state = await readState(kv);
		return await run(d, state, mode);
	} finally {
		await releaseLock(kv);
	}
}

async function run(d: RunDeps, state: HealthState, mode: { manual?: boolean }): Promise<RunResult> {
	const { kv, options: o, env, now } = d;
	const at = iso(now);
	const before = structuredClone(state.checks);
	const origin = new URL(o.productionUrl).origin;
	const host = new URL(o.productionUrl).host;
	const ran: string[] = [];
	const checks: Partial<Record<CheckId, CheckState>> = { ...state.checks };
	const jobs = { ...state.jobs };

	// Day rollover: yesterday's samples become a history row (with how each check ended the day).
	const statusLetters = CHECK_IDS.map((id) => (checks[id]?.status ?? "unknown")[0]).join("");
	let { history, today } = rollDay((await kv.get<DayRow[]>(KEYS.history)) ?? [], await kv.get<Today>(KEYS.today), now, { s: statusLetters });
	let incidents = (await kv.get<Incident[]>(KEYS.incidents)) ?? [];
	const reports = (await kv.get<{ month: string }[]>(KEYS.reports)) ?? [];
	let linkJob = await kv.get<LinkJob>(KEYS.linkJob);
	const lastMonth = previousMonth(monthOf(now));
	const plan = planRun(now, state, { host, linkJobActive: !!linkJob, reportDue: reportDue(now, reports.map((r) => r.month), lastMonth), manual: !!mode.manual });

	// Coming-soon mode (Settings): visitors get the holding page (503) on purpose, so the checks that request the site
	// pause instead of reporting the site down (no incidents, no alerts); the others run as usual. Same rule as the
	// middleware: the switch, or now inside the schedule.
	const paused = maintenanceActive(await kv.get<MaintenanceSetting>(KEYS.maintenance), now);
	const pausedState = (): CheckState => ({ status: "off", summary: "Paused: coming-soon mode is on (visitors see the holding page). Switch it off or change its schedule in Settings.", at });

	// ── Uptime (every run): home + one sitemap page (+ retries). The home page's HTML feeds the other light checks.
	const { paths, cursor } = pickPaths(state.uptime, state.sitemap?.paths ?? []);
	const probes = paused ? [] : await Promise.all(paths.map(async (path) => ({ path, probe: await probe(d.self, `${origin}${path}`, { body: path === "/" }) })));
	const home = probes[0]?.probe ?? { url: `${origin}/`, status: 0, ms: 0 };
	const change = paused ? { uptime: state.uptime, opened: [] as Incident[], closed: [] as Incident[] } : applyProbes(state.uptime, probes, cursor, now);
	state.uptime = change.uptime;
	if (!paused) today = countHome(today, home);
	checks.uptime = paused ? pausedState() : uptimeCheck(state.uptime, today, home, at);
	incidents = mergeIncidents(incidents, change.opened, change.closed, now);
	ran.push("uptime");
	if (paused) {
		checks.indexability = pausedState();
		checks.analytics = pausedState();
		checks.links = pausedState();
	}

	// ── Search engines (hourly): robots.txt, the sitemap (its pages also drive the uptime rotation and link check).
	if (plan.light.includes("index") && !paused) {
		const [robots, sitemap] = await Promise.all([probe(d.self, `${origin}/robots.txt`, { body: true }), probe(d.self, `${origin}/sitemap.xml`, { body: true })]);
		let locs = sitemap.status === 200 ? sitemapLocs(sitemap.html ?? "") : [];
		if (/<sitemapindex/i.test(sitemap.html ?? "")) {
			const children = await Promise.all(sitemapPaths(locs, o.productionUrl, 3).map((p) => probe(d.self, `${origin}${p}`, { body: true })));
			locs = [...new Set(children.flatMap((c) => (c.status === 200 ? sitemapLocs(c.html ?? "") : [])))];
		}
		if (sitemap.status === 200) state.sitemap = { at, paths: sitemapPaths(locs, o.productionUrl) };
		checks.indexability = indexabilityCheck(home.status === 200 ? homeIndexing(home, o.productionUrl) : undefined, parseSiteFiles(robots, sitemap.status, locs), home.status, at);
		jobs.index = at;
		ran.push("index");
	}

	// ── Analytics tags (hourly), from this run's home page.
	if (plan.light.includes("analytics") && !paused) {
		const expected = o.analytics ? await expectedTrackers(o.analytics, env.DB) : undefined;
		checks.analytics = analyticsCheck(expected, home.status === 200 ? (home.html ?? "") : undefined, at, { zoneBeacon: !!o.analytics?.zoneBeacon });
		jobs.analytics = at;
		ran.push("analytics");
	}

	// ── Backups (hourly): the backups plugin's heartbeat, through the Worker itself.
	if (plan.light.includes("backups")) {
		checks.backups = backupsCheck(!!o.backups, o.backups ? await readBackupBeat(d.self, origin) : undefined, at, now, o.backups ? await readDrillSummary(env.DB) : undefined);
		jobs.backups = at;
		ran.push("backups");
	}

	// ── Media (hourly): the Media Assistant's scan counts (one D1 read).
	if (plan.light.includes("media")) {
		checks.media = mediaCheck(!!o.media, o.media ? await readMediaSummary(env.DB) : undefined, at, now);
		jobs.media = at;
		ran.push("media");
	}

	// ── Missing pages (hourly): EmDash's 404 log, the last 7 days, with redirect suggestions from the sitemap (one D1 read).
	if (plan.light.includes("notfound")) {
		const rows = await readNotFound(env.DB, iso(now - NOTFOUND_WINDOW));
		// An address that redirects now stays in EmDash's 404 log (last seen within the week): leave it out — the ones made
		// on the Missing pages tab, and any redirect source in Redirects.
		const redirected = Object.keys((await kv.get<Redirected>(KEYS.redirected)) ?? {});
		const sources = d.redirects ? await redirectSources(d.redirects).catch(() => [] as string[]) : [];
		const summary = rows ? summarizeNotFound(withoutRedirected({ at, top: rows, probes: 0 }, [...redirected, ...sources]).top, state.sitemap?.paths ?? [], at) : undefined;
		if (summary) await kv.set(KEYS.notFound, summary);
		checks.notfound = notFoundCheck(summary, at);
		jobs.notfound = at;
		ran.push("notfound");
	}

	// ── Security headers (hourly), from this run's home page (what the middleware sends visitors).
	if (plan.light.includes("headers")) {
		if (paused) checks.security = pausedState();
		else if (home.status === 200) {
			const facts: SecurityFacts = { at, status: home.status, headers: home.headers ?? {} };
			await kv.set(KEYS.security, facts);
			checks.security = headersCheck(facts, at, { reports: o.cspReports !== false });
		} else checks.security = headersCheck({ at, status: home.status, headers: {} }, at, { reports: o.cspReports !== false });
		jobs.headers = at;
		ran.push("headers");
	}

	// ── Form outbox (every 15 minutes): counts and email status only.
	if (plan.light.includes("forms")) {
		const f = await readForms(env, { emdashEmail: !!d.email, now }).catch(() => undefined);
		if (f) {
			const lastEmailedDay = [f.lastEmailedDay, state.forms?.lastEmailedDay].filter(Boolean).sort().at(-1);
			state.forms = { waiting: f.waiting, failed: f.failed, ...(lastEmailedDay ? { lastEmailedDay } : {}) };
			checks.forms = formsCheck(f, at, now, lastEmailedDay);
		} else checks.forms = { status: "unknown", summary: "The form outbox could not be read this time.", at };
		jobs.forms = at;
		ran.push("forms");
	}

	// ── Heavy jobs: at most one per tick (all of the daily ones on "Run checks now").
	let freshLinks: { url: string; status: number; on: string[] }[] = [];
	const heavy = mode.manual ? (["dns", "ssl", "speed", "links"] as const) : plan.heavy ? [plan.heavy] : [];
	for (const job of heavy) {
		if (job === "links" && paused) {
			jobs.links = at;
			continue;
		}
		if (job === "links") {
			if (!linkJob && (plan.startLinks || mode.manual)) {
				const withExternal = o.externalLinks !== false && externalDue(state, now);
				linkJob = startJob(state.sitemap?.paths.length ? state.sitemap.paths : ["/"], o.productionUrl, withExternal, now);
			}
			if (!linkJob) continue;
			const step = await stepJob(linkJob, { self: d.self, external: d.fetch, productionUrl: o.productionUrl, budget: LINK_BUDGET, concurrency: LINK_CONCURRENCY, sample: EXTERNAL_SAMPLE, now });
			if (step.done) {
				const result = resultOf(step.job, o.productionUrl, now);
				const { ledger, fresh } = updateLedger((await kv.get<LinkLedger>(KEYS.ledger)) ?? {}, result, now, step.job.withExternal);
				freshLinks = fresh;
				await kv.set(KEYS.links, result);
				await kv.set(KEYS.ledger, ledger);
				await kv.delete(KEYS.linkJob);
				linkJob = null;
				history = upsertDay(history, dayOf(now), { broken: result.broken.filter((b) => !b.external).length });
				if (step.job.withExternal) jobs.external = at;
				checks.links = linksCheck(result, undefined, at);
			} else {
				await kv.set(KEYS.linkJob, step.job);
				linkJob = step.job;
				checks.links = linksCheck(await kv.get<LinksResult>(KEYS.links), { pages: step.job.pages.length, done: step.job.pi }, at);
			}
			jobs.links = at;
			ran.push("links");
		} else if (job === "dns") {
			checks.dns = dnsCheck(o.mail, o.mail?.records.length ? await compareMail(o.mail, d.fetch) : undefined, at);
			jobs.dns = at;
			ran.push("dns");
		} else if (job === "ssl") {
			const token = env.CF_ZONE_READ_TOKEN?.trim();
			checks.ssl = sslCheck(token ? await readCertificates(host, token, d.fetch) : undefined, o.productionUrl.startsWith("https:") && answered(home), at, now);
			jobs.ssl = at;
			ran.push("ssl");
		} else if (job === "speed") {
			const cwv: Cwv = await fetchCrux(origin, env.CRUX_API_KEY?.trim() || undefined, d.fetch, now);
			await kv.set(KEYS.cwv, cwv);
			if (!cwv.missing) history = upsertDay(history, dayOf(now), { ...(cwv.lcp !== undefined ? { lcp: cwv.lcp } : {}), ...(cwv.inp !== undefined ? { inp: cwv.inp } : {}), ...(cwv.cls !== undefined ? { cls: cwv.cls } : {}) });
			checks.speed = speedCheck(median(today.ttfb), cwv, at);
			jobs.speed = at;
			ran.push("speed");
		} else if (job === "report") {
			await kv.set(KEYS.history, history);
			await kv.set(KEYS.incidents, incidents);
			const data = await makeReport(d, lastMonth);
			await storeReport(kv, data);
			const sent = await emailReport(d, data);
			if (sent) state.reportSent = lastMonth;
			jobs.report = at;
			ran.push("report");
		}
	}
	if (!checks.links && !linkJob && !paused) checks.links = linksCheck(await kv.get<LinksResult>(KEYS.links), undefined, at);
	if (!checks.dns) checks.dns = dnsCheck(o.mail, undefined, at);
	if (!checks.ssl) checks.ssl = env.CF_ZONE_READ_TOKEN ? { status: "unknown", summary: "Not checked yet: the certificate is read once a day.", at } : sslCheck(undefined, answered(home), at, now);
	if (!checks.speed && today.ttfb.length) checks.speed = speedCheck(median(today.ttfb), await kv.get<Cwv>(KEYS.cwv), at);

	// ── Alerts.
	const events = [...alertEvents({ siteName: o.siteName, before, after: checks, opened: change.opened, closed: change.closed, freshLinks }), ...cspAlertEvents(await takeCspFresh(kv), o.siteName)];
	const alerts = await deliverAlerts(d, events);

	state = { ...state, v: 1, lastRunAt: at, checks, jobs: { ...jobs, ...(mode.manual ? { manual: at } : {}), run: at } };
	await kv.set(KEYS.state, state);
	await kv.set(KEYS.today, today);
	await kv.set(KEYS.history, history);
	await kv.set(KEYS.incidents, incidents);
	return { ran, alerts, state };
}

/** Emails the alert events this run allows (gating, one per issue per day, MAX_PER_DAY); logs counts only. */
export async function deliverAlerts(d: RunDeps, events: AlertEvent[]): Promise<RunResult["alerts"]> {
	const { kv, options: o, env, now } = d;
	if (!events.length) return { sent: 0, held: 0 };
	const settings = await settingsOf(kv);
	const blocked = emailBlocked(o, env, settings, "alerts");
	if (blocked) return { sent: 0, held: events.length, notEmailed: blocked };
	const picked = pickAlerts(events, (await kv.get<AlertLog>(KEYS.alerts)) ?? {}, now);
	await kv.set(KEYS.alerts, picked.log);
	const to = alertRecipients(settings, o);
	let sent = 0;
	let failed: string | undefined;
	for (const e of picked.send) {
		const r = await sendMail(env, d.email, to, alertMail(e, { siteName: o.siteName, adminUrl: adminUrl(o), footer: o.brand.footer, ...(o.brand.colors?.accent ? { accent: o.brand.colors.accent } : {}) }));
		if (r.ok) sent++;
		else failed = r.reason;
	}
	// Counts and reasons only: no addresses, no content.
	d.log?.info("health alerts", { events: events.length, sent, held: picked.held.length, ...(failed ? { failed } : {}) });
	return { sent, held: picked.held.length, ...(failed ? { notEmailed: failed } : {}) };
}

/**
 * CSP violations not alerted yet (every tick, one KV read): their flag is cleared with compare-and-set BEFORE any
 * email, so a violation never alerts twice; when a report arrived in between, they wait for the next tick. With the
 * admin switch off nothing alerts. Before go-live or on staging the events are held like every other alert.
 */
export async function takeCspFresh(kv: Kv): Promise<CspEntry[]> {
	if (kv.getVersioned && kv.compareAndSet) {
		const cur = await kv.getVersioned<CspStore>(KEYS.csp);
		if (!cur) return [];
		const { fresh, store } = takeFresh(readCspStore(cur.value));
		if (!fresh.length) return [];
		const r = await kv.compareAndSet(KEYS.csp, cur.revision, store);
		return r.applied && !store.off ? fresh : [];
	}
	const stored = await kv.get<CspStore>(KEYS.csp);
	if (!stored) return [];
	const { fresh, store } = takeFresh(readCspStore(stored));
	if (!fresh.length) return [];
	await kv.set(KEYS.csp, store);
	return store.off ? [] : fresh;
}

/** Opens new incidents and closes ended ones (by id); keeps 90 days. Pure. */
export function mergeIncidents(list: Incident[], opened: Incident[], closed: Incident[], now: number): Incident[] {
	const ended = new Map(closed.map((c) => [c.id, c]));
	const out = list.map((i) => (ended.has(i.id) && !i.endedAt ? { ...i, endedAt: ended.get(i.id)?.endedAt as string } : i));
	for (const c of closed) if (!out.some((i) => i.id === c.id)) out.push(c);
	return pruneIncidents([...opened, ...out], now);
}

// ── Monthly report ──────────────────────────────────────────────────────────────────────────────────────────

export async function makeReport(d: RunDeps, month: string, sources?: ReportSources): Promise<ReportData> {
	const { seoSummary, ...s } = sources ?? (await reportSources(d, month));
	// The report's SEO analysis, kept for the admin's "What to improve" until the SEO suite writes a newer one.
	if (seoSummary) await d.kv.set(KEYS.seoSummary, seoSummary);
	const before = await d.kv.get<ReportData>(KEYS.report(previousMonth(month)));
	const forms = s.forms && "total" in s.forms ? { total: s.forms.total, ...(before?.forms ? { previous: before.forms.total } : {}) } : undefined;
	const improve = await currentImprovements(d, { ...(seoSummary ? { seo: seoSummary } : {}), ...(forms ? { forms } : {}) });
	return buildReport({ month, site: { name: d.options.siteName, url: d.options.productionUrl }, history: (await d.kv.get<DayRow[]>(KEYS.history)) ?? [], incidents: (await d.kv.get<Incident[]>(KEYS.incidents)) ?? [], cwv: await d.kv.get<Cwv>(KEYS.cwv), ledger: (await d.kv.get<LinkLedger>(KEYS.ledger)) ?? {}, ...(d.options.cspReports !== false ? { csp: cspMonth(readCspStore(await d.kv.get(KEYS.csp)), month) } : {}), ...s, improve, now: d.now });
}

// ── What to improve ─────────────────────────────────────────────────────────────────────────────────────────

/** The newest SEO summary: this run's, else the SEO suite's own (written when its dashboard opens) or the last report's. */
export async function latestSeoSummary(d: Pick<RunDeps, "kv" | "env">, fresh?: SeoSummary): Promise<SeoSummary | undefined> {
	if (fresh) return fresh;
	const [own, kept] = await Promise.all([readSeoSummary(d.env.DB), d.kv.get<unknown>(KEYS.seoSummary)]);
	return [own ?? undefined, parseSeoSummary(kept)].filter((x): x is SeoSummary => !!x).sort((a, b) => (a.at < b.at ? 1 : -1))[0];
}

/**
 * "What to improve" from what the checks, the visual check and the other plugins keep (improve.ts): a few KV reads and at most two D1
 * reads, no request. Plugins this site does not run (HealthOptions seo / media / backups / formsOutbox) are skipped.
 */
export async function currentImprovements(d: Pick<RunDeps, "kv" | "options" | "env">, o: { seo?: SeoSummary; forms?: { total: number; previous?: number } } = {}): Promise<Improvement[]> {
	const opt = d.options;
	const [state, notFound, cwv, media, seo, visualRaw] = await Promise.all([readState(d.kv), d.kv.get<NotFoundSummary>(KEYS.notFound), d.kv.get<Cwv>(KEYS.cwv), opt.media ? readMediaSummary(d.env.DB) : undefined, opt.seo ? latestSeoSummary(d, o.seo) : undefined, opt.visualPages === 0 ? null : d.kv.get<unknown>(KEYS.visual)]);
	const look = needsLook(readVisual(visualRaw).runs.at(-1));
	return improvements({ ...(opt.backups && state.checks.backups ? { backups: state.checks.backups } : {}), media: media ?? null, seo: seo ?? null, notFound, cwv, ...(opt.formsOutbox && o.forms ? { forms: o.forms } : {}), visual: { problems: look.problems.map((p) => p.path), changes: look.changes.map((p) => p.path) } });
}

/** Form message counts of the last stored report and of the month before it (counts only), for the admin's list. */
export async function reportFormsTrend(kv: Kv): Promise<{ total: number; previous?: number } | undefined> {
	const last = ((await kv.get<{ month: string }[]>(KEYS.reports)) ?? [])[0];
	const r = last ? await kv.get<ReportData>(KEYS.report(last.month)) : null;
	if (!r?.forms) return undefined;
	const before = await kv.get<ReportData>(KEYS.report(previousMonth(r.month)));
	return { total: r.forms.total, ...(before?.forms ? { previous: before.forms.total } : {}) };
}

export async function storeReport(kv: Kv, data: ReportData): Promise<void> {
	const index = ((await kv.get<{ month: string; at: string }[]>(KEYS.reports)) ?? []).filter((r) => r.month !== data.month);
	index.push({ month: data.month, at: data.generatedAt });
	index.sort((a, b) => (a.month < b.month ? 1 : -1));
	for (const old of index.slice(MAX_REPORTS)) await kv.delete(KEYS.report(old.month));
	await kv.set(KEYS.report(data.month), data);
	await kv.set(KEYS.reports, index.slice(0, MAX_REPORTS));
}

/** Emails a stored report to the client contacts and the agency, when allowed. Returns whether it went out. */
export async function emailReport(d: RunDeps, data: ReportData, force = false): Promise<boolean> {
	const settings = await settingsOf(d.kv);
	const blocked = force ? (d.env.STAGING === "1" ? "this is the staging site" : undefined) : emailBlocked(d.options, d.env, settings, "report");
	if (blocked) {
		d.log?.info("health report not emailed", { month: data.month, why: blocked });
		return false;
	}
	const to = reportRecipients(settings, d.options);
	const r = await sendMail(d.env, d.email, to, reportMail(data, d.options));
	d.log?.info("health report", { month: data.month, recipients: to.length, ok: r.ok, ...(r.ok ? {} : { why: r.reason }) });
	return r.ok;
}
