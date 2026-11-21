/**
 * Site health — EmDash native plugin (Block Kit admin, no React bundle), loaded in the Worker from
 * `@wp2emdash/health/plugin`; register it with `healthPlugin()` from `@wp2emdash/health` in astro.config.
 *
 * - `cron` hook, task `tick` every 5 minutes (EmDash plugin cron, run by the Worker's scheduled handler through
 *   EmDash's `runScheduledTasks`): runs the checks that are due (schedule.ts), sends alerts, makes the monthly report.
 *   Scheduled on install/activate and re-checked whenever an admin opens the page.
 * - `admin` route (EmDash's default `plugins:manage`, admins only; checked again here): the Site health page and the
 *   dashboard widget; "Run checks now" (single flight, at most every 2 minutes), settings, reports.
 * - `report` route (public GET, raw): a report as a print-friendly HTML file, only for a random token an admin's
 *   "Download" created — once, within two minutes (a browser download cannot send EmDash's CSRF header).
 * - `heartbeat` route (public GET): when the checks last ran and the plugin version — nothing else — so the kit's
 *   verify can tell the checks are alive without an admin token.
 * - `csp` route (public POST, raw 204): Content-Security-Policy violation reports from visitors' browsers (both the
 *   legacy application/csp-report and the Reporting API's application/reports+json; body read as text, at most 8 KB).
 *   Only directive, blocked origin, page path and counts are kept (csp.ts); the 5-minute tick alerts on new ones.
 * - `status` route (private JSON, admins / API tokens with the admin scope): overall status and each check's status.
 *
 * Logs carry counts and reasons, never addresses, form contents or tokens.
 */
import { definePlugin, pluginResponse } from "emdash";
import { parseRecipients } from "@wp2emdash/forms/outbox";
import { purgePages, type PurgeApi } from "@wp2emdash/seo/analytics/store";
import { type MailEnv, mailReady, type PluginEmail, sendMail } from "../email.js";
import type { HealthOptions } from "../index.js";
import { HEALTH_PLUGIN } from "../meta.js";
import type { LinkJob } from "../checks/links.js";
import { renderReportHtml, type ReportData } from "../report.js";
import { adminUrl, alertRecipients, emailReport, type HealthEnv, makeReport, type RunDeps, runChecks, settingsOf, storeReport } from "../run.js";
import { TICK_SCHEDULE, TICK_TASK } from "../schedule.js";
import { parseRewarmSetting, REWARM_INTERVALS, REWARM_KEYS, type RewarmLast } from "../cache.js";
import { type Cwv, type DayRow, type Incident, KEYS, type Kv, type LinksResult, readState, type Settings, type Today } from "../store.js";
import { monthOf, previousMonth } from "../util.js";
import type { SecurityFacts } from "../checks/headers.js";
import { createLimiter, CSP_MAX_BYTES, type CspStore, parseCspBody, readCspStore, recordViolations, siteOrigins, violationOf } from "../csp.js";
import type { NotFoundSummary } from "../checks/notfound.js";
import { adminsOnly, type MaintenanceSetting, overallOf, PAGE, type PageData, page, reportView, TABS, WIDGET, widget } from "./views.js";

const ADMIN_ROLE = 50;
/** Per isolate: CSP reports processed per minute (csp.ts CSP_RATE). */
const cspAllowed = createLimiter();

/** 32 URL-safe random characters (the starter's middleware accepts 20–64 of [A-Za-z0-9_-]). */
export function previewKey(): string {
	const b = crypto.getRandomValues(new Uint8Array(24));
	return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const DOWNLOAD_MS = 2 * 60_000;
const TEST_EVERY = 10 * 60_000;
/** "Refresh all pages now" at most every 5 minutes (one purge, one refill per cron tick). */
const REFRESH_EVERY = 5 * 60_000;

interface WorkerEnv extends HealthEnv {
	SELF?: { fetch(r: Request): Promise<Response> };
}
interface CronAccess {
	schedule(name: string, o: { schedule: string }): Promise<void>;
	list(): Promise<{ name: string; schedule: string }[]>;
}
interface Ctx {
	input?: unknown;
	request?: Request;
	user?: { role: number; name?: string | null; email?: string; id?: string };
	ui?: { surface?: string };
	kv: Kv;
	cron?: CronAccess;
	email?: PluginEmail;
	content?: RunDeps["content"];
	media?: unknown;
	log?: { info(m: string, d?: Record<string, unknown>): void; warn?(m: string, d?: Record<string, unknown>): void };
}
interface Interaction {
	type?: string;
	action_id?: string;
	value?: unknown;
	values?: Record<string, unknown>;
}

// Bindings exist only in the Worker: imported per call, not at module level (astro.config loads the descriptor in Node).
const workerEnv = async () => ((await import("cloudflare:workers")) as unknown as { env: WorkerEnv }).env;

/** The `tick` task, every 5 minutes; (re)scheduled when missing or changed. */
export async function ensureCron(cron: CronAccess | undefined): Promise<void> {
	if (!cron) return;
	const tasks = await cron.list();
	if (!tasks.some((t) => t.name === TICK_TASK && t.schedule === TICK_SCHEDULE)) await cron.schedule(TICK_TASK, { schedule: TICK_SCHEDULE });
}

function deps(ctx: Ctx, env: WorkerEnv, o: HealthOptions): RunDeps | undefined {
	const self = env.SELF;
	if (!self) return undefined;
	return {
		kv: ctx.kv,
		options: o,
		env,
		self: (url, init) => self.fetch(new Request(url, init)),
		// workerd: a global fetch kept as a property and called as a method throws "Illegal invocation" — wrap it.
		fetch: (url, init) => fetch(url, init),
		...(ctx.email ? { email: ctx.email } : {}),
		...(ctx.content ? { content: ctx.content } : {}),
		...(ctx.media ? { media: ctx.media } : {}),
		...(ctx.log ? { log: ctx.log } : {}),
		now: Date.now(),
	};
}

async function pageData(ctx: Ctx, env: WorkerEnv, o: HealthOptions, extra: Partial<PageData> = {}): Promise<PageData> {
	const kv = ctx.kv;
	const [state, today, history, incidents, links, job, cwv, reports, settings, notFound, maintenance, csp, security] = await Promise.all([readState(kv), kv.get<Today>(KEYS.today), kv.get<DayRow[]>(KEYS.history), kv.get<Incident[]>(KEYS.incidents), kv.get<LinksResult>(KEYS.links), kv.get<LinkJob>(KEYS.linkJob), kv.get<Cwv>(KEYS.cwv), kv.get<{ month: string; at: string }[]>(KEYS.reports), settingsOf(kv), kv.get<NotFoundSummary>(KEYS.notFound), kv.get<MaintenanceSetting>(KEYS.maintenance), kv.get<CspStore>(KEYS.csp), kv.get<SecurityFacts>(KEYS.security)]);
	const ready = mailReady(env as MailEnv, ctx.email);
	const cache = o.rewarm
		? await (async () => {
				const [setting, last, request] = await Promise.all([kv.get<unknown>(REWARM_KEYS.setting), kv.get<RewarmLast>(REWARM_KEYS.last), kv.get<{ at: string }>(REWARM_KEYS.request)]);
				return { available: o.rewarm?.available ?? false, defaultMinutes: o.rewarm?.everyMinutes ?? 15, setting: parseRewarmSetting(setting ?? null, o.rewarm?.everyMinutes ?? 15), last: last ?? null, ...(request?.at ? { requestedAt: request.at } : {}) };
			})()
		: undefined;
	return {
		state,
		today: today && today.d === new Date().toISOString().slice(0, 10) ? today : null,
		history: history ?? [],
		incidents: incidents ?? [],
		links,
		...(job ? { linkJob: { pages: job.pages.length, done: job.pi } } : {}),
		cwv,
		reports: reports ?? [],
		settings,
		defaults: { alertsTo: o.alertsTo, reportTo: o.reportTo },
		email: { ready: ready.ok, ...(ready.ok ? {} : { reason: ready.reason }), provider: env.EMAIL_PROVIDER === "emdash" ? "EmDash email settings" : (env.EMAIL_PROVIDER ?? "brevo") },
		live: o.live,
		staging: env.STAGING === "1",
		secrets: { crux: !!env.CRUX_API_KEY?.trim(), zone: !!env.CF_ZONE_READ_TOKEN?.trim(), analytics: !!env.CF_ANALYTICS_TOKEN?.trim() },
		selfBinding: !!env.SELF,
		productionUrl: o.productionUrl,
		...(cache ? { cache } : {}),
		siteOrigin: ctx.request?.url && URL.canParse(ctx.request.url) ? new URL(ctx.request.url).origin : o.productionUrl,
		notFound,
		maintenance,
		csp: readCspStore(csp),
		cspBuild: o.cspReports !== false,
		security,
		...extra,
	};
}

/** "2026-12-01 09:00" (UTC) or an ISO time → ISO; empty → undefined; anything else → an error. */
export function parseUntil(v: unknown): { until?: string; error?: string } {
	const s = typeof v === "string" ? v.trim() : "";
	if (!s) return {};
	const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?(?::\d{2}(?:\.\d+)?)?(?:Z| ?UTC)?$/i.exec(s);
	const t = m ? Date.parse(`${m[1]}T${m[2] ?? "00:00"}:00Z`) : Number.NaN;
	return Number.isNaN(t) ? { error: "Expected back: write the date as YYYY-MM-DD HH:MM (UTC), or leave it empty." } : { until: new Date(t).toISOString() };
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

async function grantDownload(kv: Kv, month: string): Promise<string> {
	const token = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => b.toString(16).padStart(2, "0")).join("");
	// Plugin KV has no expiry: stale grants are removed whenever a new one is made.
	for (const { key, value } of (await kv.list?.("dl:")) ?? []) if (Date.parse((value as { until?: string })?.until ?? "") < Date.now()) await kv.delete(key);
	await kv.set(KEYS.download(token), { month, until: new Date(Date.now() + DOWNLOAD_MS).toISOString() });
	return token;
}

async function redeemDownload(kv: Kv, token: unknown): Promise<string | undefined> {
	if (typeof token !== "string" || !/^[0-9a-f]{48}$/.test(token)) return undefined;
	const g = await kv.get<{ month: string; until: string }>(KEYS.download(token));
	if (!g) return undefined;
	await kv.delete(KEYS.download(token));
	return Date.parse(g.until) >= Date.now() && MONTH.test(g.month) ? g.month : undefined;
}

export function createPlugin(options: HealthOptions) {
	const o = options;
	const tick = async (ctx: Ctx) => {
		const env = await workerEnv();
		const d = deps(ctx, env, o);
		if (!d) {
			ctx.log?.warn?.("health: no SELF service binding; checks skipped");
			return;
		}
		const r = await runChecks(d);
		if (r.ran.length) ctx.log?.info("health run", { ran: r.ran.join(","), alertsSent: r.alerts.sent, ...(r.skipped ? { skipped: r.skipped } : {}) });
	};
	return definePlugin({
		...HEALTH_PLUGIN,
		capabilities: ["content:read", "media:read", "email:send"],
		hooks: {
			"plugin:install": async (_event: unknown, ctx: unknown) => ensureCron((ctx as Ctx).cron),
			"plugin:activate": async (_event: unknown, ctx: unknown) => ensureCron((ctx as Ctx).cron),
			// A run stays far below this (schedule.ts: ≤ 3 + 5 + 12 requests, 8 s time limit each, 3 at a time).
			cron: { timeout: 25_000, handler: async (event: { name: string }, ctx: unknown) => (event.name === TICK_TASK ? tick(ctx as Ctx) : undefined) },
		},
		admin: {
			pages: [{ path: PAGE, label: "Site health", icon: "heartbeat" }],
			widgets: [{ id: WIDGET, title: "Site health", size: "third" }],
		},
		routes: {
			admin: {
				permission: "plugins:manage",
				handler: async (raw: unknown) => {
					const ctx = raw as Ctx;
					const isWidget = ctx.ui?.surface === "dashboard-widget";
					if ((ctx.user?.role ?? 0) < ADMIN_ROLE) return { blocks: isWidget ? [] : adminsOnly };
					const env = await workerEnv();
					if (isWidget) {
						const [state, today, incidents, notFound, maintenance] = await Promise.all([readState(ctx.kv), ctx.kv.get<Today>(KEYS.today), ctx.kv.get<Incident[]>(KEYS.incidents), ctx.kv.get<NotFoundSummary>(KEYS.notFound), ctx.kv.get<MaintenanceSetting>(KEYS.maintenance)]);
						return { blocks: widget({ state, today: today && today.d === new Date().toISOString().slice(0, 10) ? today : null, incidents: incidents ?? [], notFound, maintenance }) };
					}
					await ensureCron(ctx.cron).catch(() => {});
					const i = (ctx.input ?? {}) as Interaction;
					const act = i.action_id ?? "";
					const show = async (tab: number = TABS.overview, extra: Partial<PageData> = {}) => page(await pageData(ctx, env, o, extra), tab);
					const month = typeof i.value === "string" && MONTH.test(i.value) ? i.value : undefined;

					if (i.type === "block_action" && act === "run-now") {
						const d = deps(ctx, env, o);
						if (!d) return { blocks: await show(), toast: { message: "Checks cannot reach the site: the Worker has no SELF binding.", type: "error" } };
						const r = await runChecks(d, { manual: true });
						const message = r.skipped === "locked" ? "Checks are running already; refresh in a minute." : r.skipped === "too-soon" ? "Checks ran less than 2 minutes ago." : `Checks done: ${r.ran.length} run${r.state.checks.links && r.ran.includes("links") ? "; the link check continues in the background" : ""}.`;
						return { blocks: await show(), toast: { message, type: r.skipped ? "info" : "success" } };
					}
					if (i.type === "form_submit" && act === "save-settings") {
						const v = i.values ?? {};
						const a = parseRecipients(typeof v.alertsTo === "string" ? v.alertsTo.slice(0, 4000) : "");
						const r = parseRecipients(typeof v.reportTo === "string" ? v.reportTo.slice(0, 4000) : "");
						const errors = [...a.errors, ...r.errors];
						if (errors.length) return { blocks: await show(TABS.settings, { errors }), toast: { message: "Not saved. See the errors.", type: "error" } };
						const next: Settings = { ...(a.list.length ? { alertsTo: a.list } : {}), ...(r.list.length ? { reportTo: r.list } : {}), alerts: v.alerts !== false, report: v.report !== false };
						await ctx.kv.set(KEYS.settings, next);
						// Counts only: never the addresses.
						ctx.log?.info("health settings saved", { alerts: next.alerts, report: next.report, alertRecipients: a.list.length, reportRecipients: r.list.length });
						return { blocks: await show(TABS.settings), toast: { message: "Settings saved.", type: "success" } };
					}
					if (i.type === "form_submit" && act === "save-maintenance") {
						const v = i.values ?? {};
						const until = parseUntil(v.until);
						if (until.error) return { blocks: await show(TABS.settings, { errors: [until.error] }), toast: { message: "Not saved. See the errors.", type: "error" } };
						const text = (x: unknown, max: number) => (typeof x === "string" && x.trim() ? x.trim().slice(0, max) : undefined);
						const heading = text(v.heading, 120);
						const message = text(v.message, 1000);
						const prev = await ctx.kv.get<MaintenanceSetting>(KEYS.maintenance);
						const next: MaintenanceSetting = { on: v.on === true, ...(heading ? { heading } : {}), ...(message ? { message } : {}), ...(until.until ? { until: until.until } : {}), at: new Date().toISOString(), ...(prev?.previewKey ? { previewKey: prev.previewKey } : {}) };
						await ctx.kv.set(KEYS.maintenance, next);
						// Cached pages never reach the middleware: purge them, or visitors keep the public copy for the page lifetime.
						const purged = await purgePages(((await import("cloudflare:workers")) as unknown as { cache?: PurgeApi }).cache);
						ctx.log?.info("health coming-soon mode saved", { on: next.on, purge: purged });
						return { blocks: await show(TABS.settings), toast: { message: next.on ? "Coming-soon mode is on: visitors see the holding page within a minute." : "Coming-soon mode is off: the site is public again within a minute.", type: "success" } };
					}
					if (i.type === "form_submit" && act === "save-cache" && o.rewarm) {
						const v = i.values ?? {};
						const minutes = Number(v.everyMinutes);
						const next = { on: v.on === true, everyMinutes: (REWARM_INTERVALS as readonly number[]).includes(minutes) ? minutes : o.rewarm.everyMinutes, at: new Date().toISOString(), ...(ctx.user?.name ? { by: ctx.user.name } : {}) };
						await ctx.kv.set(REWARM_KEYS.setting, next);
						ctx.log?.info("health page cache refill saved", { on: next.on, everyMinutes: next.everyMinutes });
						return { blocks: await show(TABS.speed), toast: { message: next.on ? `Saved: pages are refilled every ${next.everyMinutes} minutes.` : "Saved: refilling is off.", type: "success" } };
					}
					if (i.type === "block_action" && act === "cache-refresh" && o.rewarm) {
						const asked = await ctx.kv.get<{ at: string }>(REWARM_KEYS.request);
						if (asked?.at && Date.now() - Date.parse(asked.at) < REFRESH_EVERY) return { blocks: await show(TABS.speed), toast: { message: "A refresh is already on its way: pages are built again within 5 minutes.", type: "info" } };
						const purged = await purgePages(((await import("cloudflare:workers")) as unknown as { cache?: PurgeApi }).cache);
						await ctx.kv.set(REWARM_KEYS.request, { at: new Date().toISOString() });
						ctx.log?.info("health page cache refresh asked", { purge: purged });
						return { blocks: await show(TABS.speed), toast: { message: "All pages cleared: they are built again within 5 minutes.", type: "success" } };
					}
					if (i.type === "form_submit" && act === "save-csp") {
						const on = (i.values ?? {}).on !== false;
						const cur = readCspStore(await ctx.kv.get(KEYS.csp));
						const { off: _off, ...rest } = cur;
						await ctx.kv.set(KEYS.csp, on ? rest : { ...rest, off: true });
						ctx.log?.info("health csp reports saved", { on });
						return { blocks: await show(TABS.security), toast: { message: on ? "Saved: blocked-content reports are kept and new blocked scripts are emailed." : "Saved: reports are no longer kept and nothing is emailed about them.", type: "success" } };
					}
					if (i.type === "block_action" && act === "csp-clear") {
						const cur = readCspStore(await ctx.kv.get(KEYS.csp));
						await ctx.kv.set(KEYS.csp, { ...cur, items: [] });
						ctx.log?.info("health csp reports cleared", { entries: cur.items.length });
						return { blocks: await show(TABS.security), toast: { message: "Cleared. A source that is blocked again appears here as new (and is emailed once).", type: "success" } };
					}
					if (i.type === "block_action" && act === "preview-new") {
						const prev = (await ctx.kv.get<MaintenanceSetting>(KEYS.maintenance)) ?? { on: false };
						await ctx.kv.set(KEYS.maintenance, { ...prev, previewKey: previewKey() });
						ctx.log?.info("health coming-soon preview link replaced", { on: prev.on });
						return { blocks: await show(TABS.settings), toast: { message: prev.previewKey ? "New preview link: the old one no longer works." : "Preview link created.", type: "success" } };
					}
					if (i.type === "block_action" && act === "test-email") {
						const state = await readState(ctx.kv);
						if (state.jobs.test && Date.now() - Date.parse(state.jobs.test) < TEST_EVERY) return { blocks: await show(TABS.settings), toast: { message: "A test email was sent less than 10 minutes ago.", type: "info" } };
						const to = alertRecipients(await settingsOf(ctx.kv), o);
						const r = await sendMail(env, ctx.email, to, { subject: `${o.siteName}: test email from Site health`, text: `This is a test email from Site health on ${o.productionUrl}.\nAlerts and reports reach this address.\n\n${adminUrl(o)}\n\n${o.brand.footer}\n`, html: `<p>This is a test email from Site health on ${o.productionUrl.replace(/[<>&"]/g, "")}.</p><p>Alerts and reports reach this address.</p><p style="color:#667085;font-size:12px">${o.brand.footer.replace(/[<>&]/g, "")}</p>` });
						await ctx.kv.set(KEYS.state, { ...state, jobs: { ...state.jobs, test: new Date().toISOString() } });
						return { blocks: await show(TABS.settings), toast: r.ok ? { message: `Test email sent to ${to.length} recipient${to.length === 1 ? "" : "s"}.`, type: "success" } : { message: `Not sent: ${r.reason}.`, type: "error" } };
					}
					if (i.type === "block_action" && act === "report-prepare") {
						const d = deps(ctx, env, o);
						if (!d) return { blocks: await show(TABS.reports), toast: { message: "Not available: the Worker has no SELF binding.", type: "error" } };
						const data = await makeReport(d, previousMonth(monthOf(Date.now())));
						await storeReport(ctx.kv, data);
						return { blocks: reportView(data, true), toast: { message: "Report prepared (not emailed).", type: "success" } };
					}
					if (i.type === "block_action" && act === "report-view" && month) {
						const data = await ctx.kv.get<ReportData>(KEYS.report(month));
						return data ? { blocks: reportView(data, true) } : { blocks: await show(TABS.reports), toast: { message: "That report is no longer kept.", type: "info" } };
					}
					if (i.type === "block_action" && act === "report-download" && month) {
						if (!(await ctx.kv.get(KEYS.report(month)))) return { blocks: await show(TABS.reports), toast: { message: "That report is no longer kept.", type: "info" } };
						const token = await grantDownload(ctx.kv, month);
						const url = new URL(`/_emdash/api/plugins/${HEALTH_PLUGIN.id}/report?token=${token}`, ctx.request?.url ?? o.productionUrl).toString();
						return { blocks: await show(TABS.reports, { download: { url, month } }) };
					}
					if (i.type === "block_action" && act === "report-send" && month) {
						const data = await ctx.kv.get<ReportData>(KEYS.report(month));
						const d = deps(ctx, env, o);
						if (!data || !d) return { blocks: await show(TABS.reports), toast: { message: "That report is no longer kept.", type: "info" } };
						const ok = await emailReport(d, data, true);
						return { blocks: reportView(data, true), toast: ok ? { message: "Report emailed.", type: "success" } : { message: "Not emailed: email is not available right now (see Settings).", type: "error" } };
					}
					const tab = act === "back" ? TABS.reports : TABS.overview;
					return { blocks: await show(tab) };
				},
			},
			report: {
				public: true,
				methods: ["GET"],
				request: { body: "none" },
				response: "raw",
				handler: async (raw: unknown) => {
					const ctx = raw as Ctx;
					const q = (ctx.input ?? {}) as Record<string, unknown>;
					const month = await redeemDownload(ctx.kv, Array.isArray(q.token) ? q.token[0] : q.token);
					const data = month ? await ctx.kv.get<ReportData>(KEYS.report(month)) : null;
					if (!data) return pluginResponse({ status: 410, headers: { "content-type": "text/plain; charset=utf-8" }, body: { kind: "text", value: "This download link has expired or was already used. Create a new one in the admin: Site health → Reports." } });
					const slug = o.siteName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "site";
					return pluginResponse({ status: 200, headers: { "content-type": "text/html; charset=utf-8", "content-disposition": `attachment; filename="${slug}-report-${data.month}.html"` }, body: { kind: "text", value: renderReportHtml(data, o.brand) } });
				},
			},
			csp: {
				public: true,
				methods: ["POST"],
				// Read as text whatever the content type (application/csp-report, application/reports+json); EmDash
				// answers 413 above maxBytes before the handler runs (docs/spikes/csp-reports-findings.md).
				request: { body: "text", maxBytes: CSP_MAX_BYTES },
				response: "raw",
				handler: async (raw: unknown) => {
					const ctx = raw as Ctx;
					const done = pluginResponse({ status: 204 });
					try {
						if (!cspAllowed(Date.now())) return done;
						const req = ctx.request;
						// A signed-in browser (editors get no report endpoint in their CSP; this catches stale pages).
						if (/(?:^|;\s*)astro-session=/.test(req?.headers.get("cookie") ?? "")) return done;
						const reports = parseCspBody(typeof ctx.input === "string" ? ctx.input : "", req?.headers.get("content-type") ?? "");
						if (!reports.length) return done;
						const origins = siteOrigins(req?.url, o.productionUrl);
						const list = reports.flatMap((r) => violationOf(r, origins) ?? []);
						if (list.length) await recordViolations(ctx.kv, list, Date.now());
					} catch {
						// A report is never worth an error page: drop it.
					}
					return done;
				},
			},
			heartbeat: {
				public: true,
				methods: ["GET"],
				request: { body: "none" },
				handler: async (raw: unknown) => {
					const s = await readState((raw as Ctx).kv);
					return { plugin: HEALTH_PLUGIN.id, version: HEALTH_PLUGIN.version, lastRunAt: s.lastRunAt ?? null };
				},
			},
			status: {
				permission: "plugins:manage",
				handler: async (raw: unknown) => {
					const ctx = raw as Ctx;
					if ((ctx.user?.role ?? ADMIN_ROLE) < ADMIN_ROLE) return { error: "admins only" };
					const s = await readState(ctx.kv);
					return { plugin: HEALTH_PLUGIN.id, version: HEALTH_PLUGIN.version, lastRunAt: s.lastRunAt ?? null, overall: overallOf(s), checks: Object.fromEntries(Object.entries(s.checks).map(([k, c]) => [k, { status: c?.status, at: c?.at }])) };
				},
			},
		},
	});
}

export default createPlugin;
