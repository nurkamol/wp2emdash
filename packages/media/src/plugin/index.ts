/**
 * Media Assistant — EmDash native plugin (Block Kit admin, no React bundle), loaded in the Worker from
 * `@wp2emdash/media/plugin`; register it with `mediaPlugin()` from `@wp2emdash/media` in astro.config.
 *
 * - `admin` route (permission `content:edit_any`: editors and admins; role checked again): the Media page and its
 *   dashboard widget. Settings and the AI licence are admins only. Every change to files (optimize, put an old file
 *   back, trash, delete for good) goes preview → one-time plan (10 minutes, same person) → confirm.
 * - `media:afterUpload` hook (capability `media:read`): when "queue new uploads" is on, JPEG/PNG/WebP uploads are
 *   queued for optimizing (EmDash's beforeUpload hook sees only the name, type and size — never the bytes).
 * - `cron` hook, task `hourly` at a minute fixed per site: rescans once a day (the counts Site health reads), deletes
 *   kept originals older than 30 days, and optimizes the upload queue when the Worker secret MEDIA_API_TOKEN (an
 *   EmDash API token with media write access) is set — otherwise the queue waits for an editor's click.
 *
 * Files are changed only through EmDash's own API as the person who confirmed (their session through the Worker's
 * SELF binding): Replace original, media folders, delete. Metadata (alt text, focal point) through the plugin media
 * API. The database is only read. Logs carry counts and reasons — never file contents.
 */
import { definePlugin } from "emdash";
import { AiLicenseError, aiAlt, altPrompt, type AiBinding, heuristicAlt, needsSuggestion, review, type Suggestion } from "../alt.js";
import { type Api, apiReplacer, deleteMedia, emdashApi, ensureFolder, moveToFolder } from "../api.js";
import { DEFAULT_AI_MODEL, limitsOf, type MediaLimits, type MediaOptions } from "../index.js";
import { MEDIA_PLUGIN } from "../meta.js";
import { BACKUP_DAYS, BACKUP_PREFIX, type Bucket, expiredBackups, type ImagesBinding, MAX_READ, type OptimizeDeps, optimizeOne, type OptimizeResult, planOptimize, REPLACEABLE, restoreOriginal } from "../optimize.js";
import { type D1Db, kb, type MediaRow, type Report, scan, summaryOf, type Summary, TRASH_FOLDER, trashable } from "../scan.js";
import { type AiState, getList, grantPlan, KEYS, type Kv, MAX_LOG, MAX_SUGGESTIONS, type OptimizedEntry, type Plan, type PlanKind, redeemPlan, type Settings, TRASH_DAYS, type TrashEntry } from "../store.js";
import { ADMIN_ROLE, confirmView, detail, EDITOR_ROLE, editorsOnly, FOCAL_VALUES, PAGE, type PageData, page, type TabKey, WIDGET, widget } from "./views.js";

const REPORT_FRESH_MS = 10 * 60_000;
const DAILY_MS = 20 * 3600_000;
const DAY = 86400_000;
const AI_BATCH = 10;
const HEURISTIC_BATCH = 30;
const OPTIMIZE_BATCH = 10;
const CRON_BATCH = 5;
export const TASK = "hourly";

interface WorkerEnv {
	DB?: D1Db;
	MEDIA?: Bucket;
	IMAGES?: ImagesBinding;
	AI?: AiBinding;
	SELF?: { fetch(r: Request): Promise<Response> };
	MEDIA_API_TOKEN?: string;
}
interface CronAccess {
	schedule(name: string, o: { schedule: string }): Promise<void>;
	list(): Promise<{ name: string; schedule: string }[]>;
}
interface MediaApi {
	readBytes?(id: string, o?: { maxBytes?: number }): Promise<{ bytes: Uint8Array; mimeType: string }>;
	updateMetadata?(id: string, patch: { alt?: string | null; focalX?: number | null; focalY?: number | null }): Promise<unknown>;
}
interface Ctx {
	input?: unknown;
	request?: Request;
	user?: { role: number; id?: string; email?: string; name?: string | null };
	ui?: { surface?: string };
	kv: Kv;
	cron?: CronAccess;
	media?: MediaApi;
	site?: { name?: string };
	log?: { info(m: string, d?: Record<string, unknown>): void; warn?(m: string, d?: Record<string, unknown>): void };
}
interface Interaction {
	type?: string;
	action_id?: string;
	value?: unknown;
	values?: Record<string, unknown>;
}
type Toast = { message: string; type: "success" | "error" | "info" };
type Out = { blocks: Record<string, unknown>[]; toast?: Toast };

// Bindings exist only in the Worker: imported per call (astro.config loads the descriptor in Node).
const workerEnv = async () => ((await import("cloudflare:workers")) as unknown as { env: WorkerEnv }).env;

const ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const idsOf = (v: unknown): string[] => [...new Set((Array.isArray(v) ? v : typeof v === "string" ? [v] : []).filter((x): x is string => typeof x === "string" && ID.test(x)))].slice(0, 50);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const monthOf = (t: number) => new Date(t).toISOString().slice(0, 7);

/** Minute of the hourly task, fixed per site so sites in one account spread out. */
export function cronSchedule(host: string): string {
	let h = 7;
	for (const c of host) h = (h * 31 + c.charCodeAt(0)) >>> 0;
	return `${h % 60} * * * *`;
}

export async function ensureCron(cron: CronAccess | undefined, o: MediaOptions): Promise<void> {
	if (!cron) return;
	const want = cronSchedule(new URL(o.productionUrl).host);
	if (!(await cron.list()).some((t) => t.name === TASK && t.schedule === want)) await cron.schedule(TASK, { schedule: want });
}

export async function settingsOf(kv: Kv, o: MediaOptions): Promise<{ aiAlt: boolean; autoOptimize: boolean; maxDimension: number }> {
	const s = (await kv.get<Settings>(KEYS.settings)) ?? {};
	return { aiAlt: s.aiAlt ?? o.aiAlt, autoOptimize: s.autoOptimize ?? !!o.autoOptimize, maxDimension: s.maxDimension ?? limitsOf(o).maxDimension };
}

async function limitsNow(kv: Kv, o: MediaOptions): Promise<MediaLimits> {
	return { ...limitsOf(o), maxDimension: (await settingsOf(kv, o)).maxDimension };
}

/** Scans (read-only), stores the report and the counts Site health reads, and reconciles the trash ledger. */
export async function rescan(kv: Kv, db: D1Db, o: MediaOptions, now = Date.now()): Promise<{ report: Report; media: MediaRow[] }> {
	const { media, report } = await scan(db, { limits: await limitsNow(kv, o), ...(o.protect ? { protect: o.protect } : {}), now });
	await kv.set(KEYS.report, report);
	await kv.set(KEYS.summary, summaryOf(report));
	// The trash ledger follows the folder: files someone moved out by hand leave it; files moved in by hand join it.
	const ledger = await getList<TrashEntry>(kv, KEYS.trash);
	const byId = new Map(media.map((m) => [m.id, m]));
	const next = ledger.filter((t) => report.trashed.includes(t.id));
	for (const id of report.trashed) {
		if (next.some((t) => t.id === id)) continue;
		const m = byId.get(id);
		if (m) next.push({ id, filename: m.filename, size: m.size, at: new Date(now).toISOString(), until: new Date(now + TRASH_DAYS * DAY).toISOString(), from: null });
	}
	if (JSON.stringify(next) !== JSON.stringify(ledger)) await kv.set(KEYS.trash, next);
	return { report, media };
}

function bindings(env: WorkerEnv) {
	return { images: !!env.IMAGES?.input, ai: !!env.AI?.run, self: !!env.SELF?.fetch, db: !!env.DB?.prepare, bucket: !!env.MEDIA?.put, token: !!env.MEDIA_API_TOKEN?.trim() };
}

async function purgeImages(log: Ctx["log"]): Promise<void> {
	// /_image variants are route-cached under the `emdash:media` tag (kit performance package); EmDash's replace route
	// purges nothing, so the plugin does — one call per action (Cloudflare purge limit 5/min).
	try {
		const w = (await import("cloudflare:workers")) as unknown as { cache?: { purge?(o: { tags: string[] }): Promise<unknown> } };
		if (typeof w.cache?.purge === "function") await w.cache.purge({ tags: ["emdash:media"] });
	} catch {
		log?.warn?.("media: cache purge failed");
	}
}

async function countTransforms(kv: Kv, n = 1): Promise<void> {
	const key = KEYS.transforms(monthOf(Date.now()));
	await kv.set(key, ((await kv.get<number>(key)) ?? 0) + n);
}

function optimizeDeps(ctx: Ctx, env: WorkerEnv, api: Api): OptimizeDeps | undefined {
	const readBytes = ctx.media?.readBytes;
	if (!env.IMAGES || !env.MEDIA || !readBytes) return undefined;
	return { readBytes: (id) => readBytes(id, { maxBytes: MAX_READ }), images: env.IMAGES, bucket: env.MEDIA, replacer: apiReplacer(api), now: Date.now(), counted: () => countTransforms(ctx.kv) };
}

async function recordOptimized(kv: Kv, results: OptimizeResult[], now: number): Promise<void> {
	const done = results.filter((r): r is Extract<OptimizeResult, { status: "done" }> => r.status === "done");
	if (!done.length) return;
	const log = await getList<OptimizedEntry>(kv, KEYS.optimized);
	const until = new Date(now + BACKUP_DAYS * DAY).toISOString();
	await kv.set(KEYS.optimized, [...done.map((r) => ({ id: r.id, filename: r.filename, at: new Date(now).toISOString(), before: r.before, after: r.after, width: r.width, height: r.height, backup: r.backup, until })), ...log].slice(0, MAX_LOG));
	const queue = await getList<string>(kv, KEYS.queue);
	const left = queue.filter((id) => !done.some((r) => r.id === id));
	if (left.length !== queue.length) await kv.set(KEYS.queue, left);
}

/** Runs a batch of optimizations (sequential: each holds one image in memory). */
export async function optimizeBatch(d: OptimizeDeps, kv: Kv, media: MediaRow[], ids: string[], L: MediaLimits): Promise<OptimizeResult[]> {
	const out: OptimizeResult[] = [];
	for (const id of ids) {
		const m = media.find((x) => x.id === id);
		out.push(m ? await optimizeOne(d, m, L) : { id, filename: id, status: "skipped", reason: "The file no longer exists." });
	}
	await recordOptimized(kv, out, d.now);
	return out;
}

const resultText = (rs: OptimizeResult[]) => {
	const done = rs.filter((r) => r.status === "done") as Extract<OptimizeResult, { status: "done" }>[];
	const saved = done.reduce((n, r) => n + (r.before - r.after), 0);
	return { done: done.length, saved, problems: rs.filter((r) => r.status !== "done").map((r) => `${r.filename}: ${(r as { reason: string }).reason}`) };
};

/** One suggestion batch: AI when on and available, else file names and headings. Never writes alt text. */
export async function suggestBatch(ctx: Ctx, env: WorkerEnv, o: MediaOptions, report: Report, aiOn: boolean): Promise<{ added: number; ai: number; licence?: boolean }> {
	const pending = await getList<Suggestion>(ctx.kv, KEYS.suggestions);
	const rejected = await getList<string>(ctx.kv, KEYS.rejected);
	const useAi = aiOn && !!env.AI && !!ctx.media?.readBytes && !(await ctx.kv.get<AiState>(KEYS.ai))?.needsAgreement;
	const todo = needsSuggestion(report.missingAlt, pending, rejected, useAi ? AI_BATCH : HEURISTIC_BATCH);
	const added: Suggestion[] = [];
	let aiCount = 0;
	let licence = false;
	const at = new Date().toISOString();
	for (const x of todo) {
		const used = x.refs.filter((r) => r.kind !== "revision").map((r) => r.label);
		let text: string | undefined;
		let source: Suggestion["source"] = "filename";
		if (useAi && !licence && env.AI && ctx.media?.readBytes && (x.m.size ?? 0) <= MAX_READ) {
			try {
				const { bytes } = await ctx.media.readBytes(x.m.id, { maxBytes: MAX_READ });
				text = await aiAlt(env.AI, env.IMAGES, o.aiModel ?? DEFAULT_AI_MODEL, bytes, altPrompt(o.siteName, used.map((u) => u.replace(/^[^:]+:\s*/, ""))));
				if (env.IMAGES) await countTransforms(ctx.kv);
				if (text) {
					source = "ai";
					aiCount++;
				}
			} catch (e) {
				if (e instanceof AiLicenseError) {
					licence = true;
					await ctx.kv.set(KEYS.ai, { ...((await ctx.kv.get<AiState>(KEYS.ai)) ?? {}), needsAgreement: true } satisfies AiState);
				} else ctx.log?.warn?.("media: AI suggestion failed", { reason: e instanceof Error ? e.message.slice(0, 120) : "unknown" });
			}
		}
		if (!text) {
			const h = heuristicAlt(x.m.filename, x.refs);
			if (h) ({ text, source } = h);
		}
		if (text) added.push({ id: x.m.id, filename: x.m.filename, text, source, at, used });
	}
	if (added.length) await ctx.kv.set(KEYS.suggestions, [...pending, ...added].slice(0, MAX_SUGGESTIONS));
	return { added: added.length, ai: aiCount, ...(licence ? { licence } : {}) };
}

export function createPlugin(options: MediaOptions) {
	const o = options;
	const hourly = async (ctx: Ctx) => {
		const env = await workerEnv();
		const now = Date.now();
		if (env.DB) {
			const r = await ctx.kv.get<Report>(KEYS.report);
			if (!r || now - Date.parse(r.at) > DAILY_MS) await rescan(ctx.kv, env.DB, o, now);
		}
		// Kept originals (and copies of deleted files) older than 30 days.
		if (env.MEDIA?.list) {
			const listed = await env.MEDIA.list({ prefix: BACKUP_PREFIX, limit: 1000, include: ["customMetadata"] });
			const old = expiredBackups(listed.objects, now);
			if (old.length) await env.MEDIA.delete(old);
		}
		// The upload queue, when an API token lets the task act through EmDash.
		const s = await settingsOf(ctx.kv, o);
		const queue = await getList<string>(ctx.kv, KEYS.queue);
		const token = env.MEDIA_API_TOKEN?.trim();
		if (s.autoOptimize && queue.length && token && env.SELF && env.DB) {
			const self = env.SELF;
			const api = emdashApi({ self: (r) => self.fetch(r), origin: new URL(o.productionUrl).origin, authorization: `Bearer ${token}` });
			const d = optimizeDeps(ctx, env, api);
			if (d) {
				const { media } = await rescan(ctx.kv, env.DB, o, now);
				const rs = await optimizeBatch(d, ctx.kv, media, queue.slice(0, CRON_BATCH), await limitsNow(ctx.kv, o));
				// Files that cannot be optimized leave the queue too.
				await ctx.kv.set(KEYS.queue, (await getList<string>(ctx.kv, KEYS.queue)).filter((id) => !rs.some((r) => r.id === id)));
				if (rs.some((r) => r.status === "done")) await purgeImages(ctx.log);
				ctx.log?.info("media: queue optimized", { done: rs.filter((r) => r.status === "done").length, skipped: rs.filter((r) => r.status !== "done").length });
			}
		}
	};

	return definePlugin({
		...MEDIA_PLUGIN,
		capabilities: ["media:read", "media:bytes:read", "media:metadata:write"],
		hooks: {
			"plugin:install": async (_event: unknown, ctx: unknown) => ensureCron((ctx as Ctx).cron, o),
			"plugin:activate": async (_event: unknown, ctx: unknown) => ensureCron((ctx as Ctx).cron, o),
			// Bytes are not available here; the upload is queued and optimized later (an editor's click or the hourly task).
			"media:afterUpload": async (event: unknown, raw: unknown) => {
				const ctx = raw as Ctx;
				const m = (event as { media?: { id?: string; mimeType?: string } }).media;
				if (!m?.id || !ID.test(m.id) || !(REPLACEABLE as readonly string[]).includes(m.mimeType ?? "")) return;
				if (!(await settingsOf(ctx.kv, o)).autoOptimize) return;
				const q = await getList<string>(ctx.kv, KEYS.queue);
				if (!q.includes(m.id)) await ctx.kv.set(KEYS.queue, [...q, m.id].slice(-200));
			},
			cron: { timeout: 25_000, handler: async (event: { name: string }, ctx: unknown) => (event.name === TASK ? hourly(ctx as Ctx) : undefined) },
		},
		admin: {
			pages: [{ path: PAGE, label: "Media", icon: "image" }],
			widgets: [{ id: WIDGET, title: "Media", size: "third" }],
		},
		routes: {
			admin: {
				permission: "content:edit_any",
				handler: async (raw: unknown) => handle(raw as Ctx, o),
			},
		},
	});
}

async function handle(ctx: Ctx, o: MediaOptions): Promise<Out> {
	const role = ctx.user?.role ?? 0;
	const isWidget = ctx.ui?.surface === "dashboard-widget";
	if (role < EDITOR_ROLE) return { blocks: isWidget ? [] : editorsOnly };
	if (isWidget) return { blocks: widget(await ctx.kv.get<Summary>(KEYS.summary)) };
	const env = await workerEnv();
	const kv = ctx.kv;
	const isAdmin = role >= ADMIN_ROLE;
	await ensureCron(ctx.cron, o).catch(() => {});
	const i = (ctx.input ?? {}) as Interaction;
	const act = i.action_id ?? "";
	const user = ctx.user?.id ?? ctx.user?.email;
	const db = env.DB;
	if (!db) return { blocks: [{ type: "header", text: "Media" }, { type: "banner", title: "Not available", description: "The Worker has no DB binding.", variant: "error" }] };

	let media: MediaRow[] | undefined;
	const fresh = async () => {
		const r = await rescan(kv, db, o);
		media = r.media;
		return r.report;
	};
	const current = async (force = false): Promise<Report> => {
		const r = await kv.get<Report>(KEYS.report);
		if (!force && r && Date.now() - Date.parse(r.at) < REPORT_FRESH_MS) return r;
		return fresh();
	};
	const library = async () => media ?? (await rescan(kv, db, o)).media;
	const api = (): Api | undefined => {
		const self = env.SELF;
		if (!self || !ctx.request) return undefined;
		return emdashApi({ self: (r) => self.fetch(r), origin: new URL(ctx.request.url).origin, cookie: ctx.request.headers.get("cookie"), authorization: ctx.request.headers.get("authorization") });
	};
	const show = async (tab: TabKey = "overview", notice?: PageData["notice"], toast?: Toast, force = false): Promise<Out> => {
		const report = await current(force);
		const s = await settingsOf(kv, o);
		const data: PageData = {
			report,
			isAdmin,
			limits: { ...limitsOf(o), maxDimension: s.maxDimension },
			suggestions: await getList<Suggestion>(kv, KEYS.suggestions),
			trash: await getList<TrashEntry>(kv, KEYS.trash),
			optimized: await getList<OptimizedEntry>(kv, KEYS.optimized),
			queue: await getList<string>(kv, KEYS.queue),
			settings: s,
			env: bindings(env),
			transforms: (await kv.get<number>(KEYS.transforms(monthOf(Date.now())))) ?? 0,
			ai: (await kv.get<AiState>(KEYS.ai)) ?? {},
			sensitive: !!o.sensitive,
			aiModel: o.aiModel ?? DEFAULT_AI_MODEL,
			...(notice ? { notice } : {}),
		};
		return { blocks: page(data, tab), ...(toast ? { toast } : {}) };
	};
	const confirmFor = async (kind: PlanKind, rows: { id: string; file: string; detail: string }[], refused: string[], keys?: Record<string, string>): Promise<Out> => {
		const token = rows.length ? await grantPlan(kv, { kind, ids: rows.map((r) => r.id), ...(keys ? { keys } : {}), ...(user ? { user } : {}) }) : "";
		return { blocks: confirmView(kind, token, rows.map(({ file, detail: d }) => ({ file, detail: d })), refused) };
	};
	const redeem = async (kind: PlanKind): Promise<Plan | undefined> => redeemPlan(kv, i.value, kind, user);
	const expiredPlan = (tab: TabKey) => show(tab, undefined, { message: "That confirmation expired or was already used. Start again.", type: "info" });

	// ── Navigation
	if (act === "rescan") return show("overview", undefined, { message: "Media scanned.", type: "success" }, true);
	if (act === "detail") {
		const id = idsOf(i.value)[0];
		const report = await current();
		const m = id ? (await library()).find((x) => x.id === id) : undefined;
		if (!m) return show("overview", undefined, { message: "That file no longer exists.", type: "info" });
		const refs = report.uses[m.id] ?? [];
		return { blocks: detail(m, refs, { limits: await limitsNow(kv, o), optimized: await getList<OptimizedEntry>(kv, KEYS.optimized), env: bindings(env) }) };
	}

	// ── One file: alt text and focal point (plugin media API).
	if (i.type === "form_submit" && act.startsWith("save-file:")) {
		const id = act.slice(10);
		const v = i.values ?? {};
		if (!ID.test(id) || !ctx.media?.updateMetadata) return show("overview", undefined, { message: "Not saved.", type: "error" });
		const patch: { alt?: string | null; focalX?: number | null; focalY?: number | null } = {};
		if (typeof v.alt === "string") patch.alt = v.alt.replace(/\s+/g, " ").trim().slice(0, 300) || null;
		if (typeof v.focal === "string" && (v.focal === "" || FOCAL_VALUES.has(v.focal))) {
			const [x, y] = v.focal ? v.focal.split(",").map(Number) : [null, null];
			patch.focalX = x ?? null;
			patch.focalY = y ?? null;
		}
		if (!Object.keys(patch).length) return show("alt", undefined, { message: "Nothing to save.", type: "info" });
		try {
			await ctx.media.updateMetadata(id, patch);
		} catch {
			return show("overview", undefined, { message: "Not saved: the file is not ready or no longer exists.", type: "error" });
		}
		await fresh();
		return show("alt", undefined, { message: "Saved.", type: "success" });
	}

	// ── Alt text suggestions (never saved without review).
	if (act === "suggest") {
		const report = await current();
		const s = await settingsOf(kv, o);
		const r = await suggestBatch(ctx, env, o, report, s.aiAlt);
		ctx.log?.info("media: suggestions", { added: r.added, ai: r.ai });
		return show("alt", r.licence ? { title: "The AI model needs its licence accepted", description: isAdmin ? "Accept it in Settings; until then suggestions come from file names and headings." : "Ask an admin to accept it in Settings; until then suggestions come from file names and headings.", variant: "alert" } : undefined, { message: r.added ? `${plural(r.added, "suggestion")} ready to review${r.ai ? ` (${r.ai} from AI)` : ""}.` : "No suggestion found: describe these images yourself (Details).", type: r.added ? "success" : "info" });
	}
	if (i.type === "form_submit" && act === "review") {
		const pending = await getList<Suggestion>(kv, KEYS.suggestions);
		const r = review(pending, i.values ?? {});
		let saved = 0;
		const failed: string[] = [];
		for (const s of r.saved) {
			try {
				if (!ctx.media?.updateMetadata) throw new Error("no metadata access");
				await ctx.media.updateMetadata(s.id, { alt: s.text });
				saved++;
			} catch {
				failed.push(s.id);
			}
		}
		const kept = [...r.kept, ...pending.filter((p) => failed.includes(p.id))];
		await kv.set(KEYS.suggestions, kept);
		if (r.rejected.length) await kv.set(KEYS.rejected, [...(await getList<string>(kv, KEYS.rejected)), ...r.rejected].slice(-1000));
		if (saved) await fresh();
		ctx.log?.info("media: alt review", { saved, rejected: r.rejected.length, kept: kept.length });
		return show("alt", r.errors.length || failed.length ? { title: "Some were not saved", description: [...r.errors, ...(failed.length ? [`${plural(failed.length, "file")} could not be updated.`] : [])].join(" "), variant: "alert" } : undefined, { message: `${plural(saved, "description")} saved${r.rejected.length ? `, ${r.rejected.length} rejected` : ""}.`, type: saved ? "success" : "info" });
	}

	// ── Optimize: preview → confirm → run.
	if (act === "optimize-preview" || act === "optimize-queue") {
		const lib = await library();
		const L = await limitsNow(kv, o);
		const ids = act === "optimize-queue" ? (await getList<string>(kv, KEYS.queue)).slice(0, OPTIMIZE_BATCH) : idsOf(i.value).slice(0, OPTIMIZE_BATCH);
		const rows: { id: string; file: string; detail: string }[] = [];
		const refused: string[] = [];
		for (const id of ids) {
			const m = lib.find((x) => x.id === id);
			const p = m ? planOptimize(m, L) : undefined;
			if (m && p?.ok) rows.push({ id, file: m.filename, detail: `${kb(m.size)}, ${p.why}; old file kept 30 days` });
			else refused.push(`${m?.filename ?? id}: ${p && !p.ok ? p.reason : "no longer exists"}`);
		}
		if (act === "optimize-queue" && refused.length) {
			const q = await getList<string>(kv, KEYS.queue);
			await kv.set(KEYS.queue, q.filter((id) => rows.some((r) => r.id === id) || !ids.includes(id)));
		}
		return confirmFor("optimize", rows, refused);
	}
	if (act === "optimize-run") {
		const plan = await redeem("optimize");
		if (!plan) return expiredPlan("optimize");
		const a = api();
		const d = a ? optimizeDeps(ctx, env, a) : undefined;
		if (!d) return show("optimize", undefined, { message: "Optimize is not available (Images, SELF or MEDIA binding missing).", type: "error" });
		const rs = await optimizeBatch(d, kv, await library(), plan.ids, await limitsNow(kv, o));
		const t = resultText(rs);
		if (t.done) await purgeImages(ctx.log);
		ctx.log?.info("media: optimized", { done: t.done, saved: t.saved, problems: t.problems.length });
		await fresh();
		return show("optimize", t.problems.length ? { title: `${plural(t.problems.length, "file")} not optimized`, description: t.problems.join(" "), variant: "alert" } : undefined, { message: t.done ? `${plural(t.done, "file")} optimized, ${kb(t.saved)} saved.` : "Nothing optimized.", type: t.done ? "success" : "info" });
	}
	if (act === "restore-preview") {
		const id = idsOf(i.value)[0];
		const entry = (await getList<OptimizedEntry>(kv, KEYS.optimized)).find((x) => x.id === id && !x.restored && Date.parse(x.until) > Date.now());
		if (!id || !entry) return show("optimize", undefined, { message: "No kept original for that file.", type: "info" });
		return confirmFor("restore-original", [{ id, file: entry.filename, detail: `${kb(entry.after)} now → the original (${kb(entry.before)}) from ${entry.at.slice(0, 10)}` }], [], { [id]: entry.backup });
	}
	if (act === "restore-original-run") {
		const plan = await redeem("restore-original");
		if (!plan) return expiredPlan("optimize");
		const a = api();
		if (!a || !env.MEDIA) return show("optimize", undefined, { message: "Not available (SELF or MEDIA binding missing).", type: "error" });
		const lib = await library();
		const problems: string[] = [];
		let ok = 0;
		const log = await getList<OptimizedEntry>(kv, KEYS.optimized);
		for (const id of plan.ids) {
			const m = lib.find((x) => x.id === id);
			const key = plan.keys?.[id];
			const r = m && key ? await restoreOriginal({ bucket: env.MEDIA, replacer: apiReplacer(a) }, key, m) : { ok: false as const, reason: "The file no longer exists." };
			if (r.ok) {
				ok++;
				const e = log.find((x) => x.id === id && x.backup === key);
				if (e) e.restored = new Date().toISOString();
			} else problems.push(`${m?.filename ?? id}: ${r.reason}`);
		}
		await kv.set(KEYS.optimized, log);
		if (ok) await purgeImages(ctx.log);
		await fresh();
		return show("optimize", problems.length ? { title: "Not put back", description: problems.join(" "), variant: "alert" } : undefined, { message: ok ? "The old file is back." : "Nothing changed.", type: ok ? "success" : "info" });
	}

	// ── Trash: preview → confirm → move to the trash folder (30-day undo). Put back is direct.
	if (act === "trash-preview") {
		const ids = idsOf(i.type === "form_submit" ? i.values?.ids : i.value);
		if (!ids.length) return show("unused", undefined, { message: "Choose at least one file.", type: "info" });
		const report = await current(true);
		const lib = await library();
		const rows: { id: string; file: string; detail: string }[] = [];
		const refused: string[] = [];
		for (const id of ids) {
			const u = report.unused.find((x) => x.m.id === id);
			const ok = trashable(report, id);
			if (ok.ok && u) rows.push({ id, file: u.m.filename, detail: `${kb(u.m.size)}; to "${TRASH_FOLDER}" until ${new Date(Date.now() + TRASH_DAYS * DAY).toISOString().slice(0, 10)}` });
			else refused.push(`${lib.find((m) => m.id === id)?.filename ?? id}: not moved — ${ok.ok ? "not found" : ok.reason}.`);
		}
		return confirmFor("trash", rows, refused);
	}
	if (act === "trash-run") {
		const plan = await redeem("trash");
		if (!plan) return expiredPlan("unused");
		const a = api();
		if (!a) return show("unused", undefined, { message: "Not available: the Worker has no SELF binding.", type: "error" });
		// Checked again against a fresh scan: something may have started using a file since the preview.
		const report = await fresh();
		const lib = await library();
		let folder: string;
		try {
			folder = await ensureFolder(a, TRASH_FOLDER);
		} catch (e) {
			return show("unused", undefined, { message: `The trash folder could not be made: ${e instanceof Error ? e.message : "error"}.`, type: "error" });
		}
		const ledger = await getList<TrashEntry>(kv, KEYS.trash);
		const now = Date.now();
		let moved = 0;
		const problems: string[] = [];
		for (const id of plan.ids) {
			const m = lib.find((x) => x.id === id);
			const ok = trashable(report, id);
			if (!m || !ok.ok) {
				problems.push(`${m?.filename ?? id}: ${ok.ok ? "no longer exists" : ok.reason}.`);
				continue;
			}
			try {
				await moveToFolder(a, id, folder);
				ledger.push({ id, filename: m.filename, size: m.size, at: new Date(now).toISOString(), until: new Date(now + TRASH_DAYS * DAY).toISOString(), from: m.folderId, ...(ctx.user?.name ? { by: ctx.user.name } : {}) });
				moved++;
			} catch (e) {
				problems.push(`${m.filename}: ${e instanceof Error ? e.message : "error"}.`);
			}
		}
		await kv.set(KEYS.trash, ledger.filter((t, n) => ledger.findIndex((x) => x.id === t.id) === n));
		await fresh();
		ctx.log?.info("media: trashed", { moved, problems: problems.length });
		return show("trash", problems.length ? { title: "Some files were not moved", description: problems.join(" "), variant: "alert" } : undefined, { message: `${plural(moved, "file")} moved to the trash. Put them back any time within 30 days.`, type: moved ? "success" : "info" });
	}
	if (act === "untrash") {
		const id = idsOf(i.value)[0];
		const ledger = await getList<TrashEntry>(kv, KEYS.trash);
		const t = ledger.find((x) => x.id === id);
		const a = api();
		if (!t || !a) return show("trash", undefined, { message: t ? "Not available: the Worker has no SELF binding." : "That file is not in the trash.", type: "info" });
		try {
			await moveToFolder(a, t.id, t.from);
		} catch (e) {
			return show("trash", undefined, { message: `Not put back: ${e instanceof Error ? e.message : "error"}.`, type: "error" });
		}
		await kv.set(KEYS.trash, ledger.filter((x) => x.id !== t.id));
		await fresh();
		return show("trash", undefined, { message: `${t.filename} is back in the media library.`, type: "success" });
	}
	if (act === "delete-preview") {
		const ids = idsOf(i.value);
		const ledger = await getList<TrashEntry>(kv, KEYS.trash);
		const report = await current(true);
		const rows: { id: string; file: string; detail: string }[] = [];
		const refused: string[] = [];
		for (const id of ids) {
			const t = ledger.find((x) => x.id === id);
			if (!t) continue;
			const why = Date.parse(t.until) > Date.now() ? `in the trash until ${t.until.slice(0, 10)}` : !report.trashed.includes(id) ? "no longer in the trash folder" : report.trashedInUse.includes(id) ? "something on the site uses it again — put it back" : undefined;
			if (why) refused.push(`${t.filename}: ${why}.`);
			else rows.push({ id, file: t.filename, detail: `${kb(t.size)}; in the trash since ${t.at.slice(0, 10)}` });
		}
		return confirmFor("delete", rows, refused);
	}
	if (act === "delete-run") {
		const plan = await redeem("delete");
		if (!plan) return expiredPlan("trash");
		const a = api();
		if (!a || !env.MEDIA || !ctx.media?.readBytes) return show("trash", undefined, { message: "Not available (SELF or MEDIA binding missing).", type: "error" });
		const report = await fresh();
		const ledger = await getList<TrashEntry>(kv, KEYS.trash);
		const now = Date.now();
		let deleted = 0;
		const problems: string[] = [];
		for (const id of plan.ids) {
			const t = ledger.find((x) => x.id === id);
			if (!t || Date.parse(t.until) > now || !report.trashed.includes(id) || report.trashedInUse.includes(id)) {
				problems.push(`${t?.filename ?? id}: no longer qualifies.`);
				continue;
			}
			try {
				// A last copy for the developer (30 days, private prefix) before EmDash deletes the file and its storage.
				const { bytes, mimeType } = await ctx.media.readBytes(id, { maxBytes: MAX_READ });
				await env.MEDIA.put(`${BACKUP_PREFIX}${id}/deleted-${new Date(now).toISOString().replace(/[:.]/g, "-")}-${t.filename.replace(/[^\w.-]+/g, "-").slice(-80)}`, bytes, { httpMetadata: { contentType: mimeType }, customMetadata: { mediaId: id, filename: t.filename.slice(0, 200), deleted: "1", until: new Date(now + BACKUP_DAYS * DAY).toISOString() } });
			} catch {
				problems.push(`${t.filename}: no copy could be kept (larger than 16 MB or unreadable), so it was not deleted.`);
				continue;
			}
			try {
				await deleteMedia(a, id);
				deleted++;
				ledger.splice(ledger.indexOf(t), 1);
			} catch (e) {
				problems.push(`${t.filename}: ${e instanceof Error ? e.message : "error"}.`);
			}
		}
		await kv.set(KEYS.trash, ledger);
		await fresh();
		ctx.log?.info("media: deleted", { deleted, problems: problems.length });
		return show("trash", problems.length ? { title: "Some files were not deleted", description: problems.join(" "), variant: "alert" } : undefined, { message: `${plural(deleted, "file")} deleted for good.`, type: deleted ? "success" : "info" });
	}

	// ── Settings and the AI licence (admins).
	if (i.type === "form_submit" && act === "save-settings") {
		if (!isAdmin) return show("overview", undefined, { message: "Settings are for admins.", type: "error" });
		const v = i.values ?? {};
		const dim = Number(v.maxDimension);
		const next: Settings = { aiAlt: v.aiAlt === true, autoOptimize: v.autoOptimize === true, ...(Number.isInteger(dim) && dim >= 1200 && dim <= 6000 ? { maxDimension: dim } : {}) };
		await kv.set(KEYS.settings, next);
		ctx.log?.info("media: settings saved", { aiAlt: next.aiAlt, autoOptimize: next.autoOptimize });
		return show("settings", undefined, { message: "Settings saved.", type: "success" }, true);
	}
	if (act === "ai-agree") {
		if (!isAdmin || !env.AI) return show("settings", undefined, { message: "Admins only, on a Worker with the AI binding.", type: "error" });
		try {
			await env.AI.run(o.aiModel ?? DEFAULT_AI_MODEL, { prompt: "agree" });
		} catch {}
		await kv.set(KEYS.ai, { needsAgreement: false, agreedAt: new Date().toISOString() } satisfies AiState);
		ctx.log?.info("media: AI licence accepted by an admin");
		return show("settings", undefined, { message: "Licence accepted. Suggestions can use AI now.", type: "success" });
	}

	return show("overview");
}

export default createPlugin;
