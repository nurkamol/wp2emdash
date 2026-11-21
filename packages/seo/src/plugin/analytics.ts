/**
 * Analytics inside the SEO & Analytics plugin: the stored settings (plugin KV, read by the site from D1 — see
 * analytics/store.ts), the admin actions (admins only, every save purges the cached pages) and the 7-day visits
 * (Cloudflare GraphQL, cached 15 minutes in plugin KV).
 */
import type { SeoPanelOptions } from "../index.js";
import { addTracker, type Change, editTracker, removeTracker, switchesFrom, toggleTracker } from "../analytics/edit.js";
import { KV_KEY, parseStored, type PurgeApi, type PurgeResult, purgePages, type StoredAnalytics } from "../analytics/store.js";
import { DEFAULT_EVENTS, seedTrackers, type Tracker } from "../analytics/trackers.js";
import { addView, editView, type VisitsState } from "../analytics/views.js";
import { fetchVisits, type Visits, VisitsError } from "../analytics/visits.js";
import type { SeoCtx } from "./collect.js";

type Block = Record<string, unknown>;
const VISITS_KEY = "visits:cache";
const VISITS_TTL = 15 * 60_000;
export const ADMIN_ROLE = 50;

export interface WorkerBits {
	env: { CF_ANALYTICS_TOKEN?: string; CF_ANALYTICS_ACCOUNT_ID?: string; CF_ANALYTICS_SITE_TAG?: string };
	cache?: PurgeApi;
}
/** Worker-only modules: imported per request, never at module level (astro.config loads the descriptor in Node). */
export const workerBits = async (): Promise<WorkerBits> => {
	const m = (await import("cloudflare:workers")) as unknown as Partial<WorkerBits>;
	return { env: m.env ?? {}, ...(m.cache ? { cache: m.cache } : {}) };
};

/** The stored settings; on the very first load, what was carried over from WordPress (stored, so the site reads the same). */
export async function loadAnalytics(ctx: Pick<SeoCtx, "kv">, o: SeoPanelOptions, now = new Date().toISOString()): Promise<StoredAnalytics> {
	const stored = parseStored(await ctx.kv.get<unknown>(KV_KEY));
	if (stored) return stored;
	const seeded: StoredAnalytics = { version: 1, trackers: seedTrackers(o.analytics?.seed, now), events: { ...DEFAULT_EVENTS }, consent: false, defer: true, updatedAt: now };
	await ctx.kv.set(KV_KEY, seeded);
	return seeded;
}

export async function visitsState(ctx: Pick<SeoCtx, "kv">, o: SeoPanelOptions, w: WorkerBits, fetchFn: typeof fetch, force = false): Promise<VisitsState> {
	const token = w.env.CF_ANALYTICS_TOKEN?.trim();
	const accountId = (w.env.CF_ANALYTICS_ACCOUNT_ID ?? o.analytics?.accountId ?? "").trim();
	const missing = [...(token ? [] : ["the CF_ANALYTICS_TOKEN secret"]), ...(/^[0-9a-f]{32}$/.test(accountId) ? [] : ["the Cloudflare account id"])];
	if (!token || missing.length) return { kind: "setup", missing };
	const cached = await ctx.kv.get<{ at: string; visits: Visits }>(VISITS_KEY);
	if (cached && !force && Date.now() - Date.parse(cached.at) < VISITS_TTL) return { kind: "data", visits: cached.visits, cachedAt: cached.at };
	try {
		const tag = (w.env.CF_ANALYTICS_SITE_TAG ?? o.analytics?.siteTag ?? "").trim();
		const visits = await fetchVisits({ token, accountId, host: new URL(o.productionUrl).host, ...(/^[0-9a-f]{32}$/.test(tag) ? { siteTag: tag } : {}) }, fetchFn);
		const at = new Date().toISOString();
		await ctx.kv.set(VISITS_KEY, { at, visits });
		return { kind: "data", visits, cachedAt: at };
	} catch (e) {
		return cached ? { kind: "data", visits: cached.visits, cachedAt: cached.at } : { kind: "error", message: e instanceof VisitsError ? e.message : "unexpected error." };
	}
}

function purgeNote(r: PurgeResult): string {
	if (r === "purged") return " Live pages update within a few seconds.";
	if (r === "no-cache") return "";
	return " Cached pages could not be refreshed right now: they show the change within the hour, or after the next deploy.";
}

export type Toast = { message: string; type: "success" | "error" | "info" };
export type ActionResult = { view: Block[]; toast?: Toast } | { stored: StoredAnalytics; toast?: Toast; errors?: string[] };

interface Interaction {
	type?: string;
	action_id?: string;
	block_id?: string;
	value?: unknown;
	values?: Record<string, unknown>;
}

/**
 * An `an-*` action from the Analytics tab. Returns either a view to show instead of the dashboard (the add / edit
 * forms, or a form again with its errors) or the new settings to show the Analytics tab with.
 */
export async function analyticsAction(ctx: SeoCtx & { user?: { role: number; name?: string | null; email?: string } }, stored: StoredAnalytics, i: Interaction, w: WorkerBits): Promise<ActionResult> {
	if ((ctx.user?.role ?? 0) < ADMIN_ROLE) return { stored, toast: { message: "Only administrators can change tracking codes.", type: "error" } };
	const act = i.action_id ?? "";
	const v = i.values ?? {};
	const byId = (id: unknown): Tracker | undefined => (typeof id === "string" ? stored.trackers.find((t) => t.id === id) : undefined);
	const save = async (next: StoredAnalytics, message: string): Promise<ActionResult> => {
		const who = (ctx.user?.name || ctx.user?.email || "an admin").slice(0, 80);
		const s: StoredAnalytics = { ...next, updatedAt: new Date().toISOString(), updatedBy: who };
		await ctx.kv.set(KV_KEY, s);
		const purged = await purgePages(w.cache);
		ctx.log?.info("analytics settings saved", { trackers: s.trackers.length, on: s.trackers.filter((t) => t.enabled).length, purge: purged });
		return { stored: s, toast: { message: `${message}${purgeNote(purged)}`, type: purged === "failed" ? "info" : "success" } };
	};
	const commit = (c: Change, onError: (errors: string[]) => ActionResult) => (c.ok ? save({ ...stored, trackers: c.trackers }, c.message) : Promise.resolve(onError(c.errors)));
	const formError = (view: Block[]): ActionResult => ({ view, toast: { message: "Not saved. See the message on the page.", type: "error" } });

	if (act === "an-add") return { view: addView() };
	if (act === "an-cancel") return { stored };
	if (act === "an-edit") {
		const t = byId(i.value);
		return t ? { view: editView(t) } : { stored, toast: { message: "That tracking code is no longer in the list.", type: "info" } };
	}
	if (act === "an-toggle" && typeof i.value === "string") return commit(toggleTracker(stored.trackers, i.value), (errors) => ({ stored, errors, toast: { message: "Not saved.", type: "error" } }));
	if (act === "an-remove" && typeof i.value === "string") return commit(removeTracker(stored.trackers, i.value), (errors) => ({ stored, errors }));
	if (act === "an-add-save") {
		const id = `t${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
		const str = (x: unknown) => (typeof x === "string" ? x.slice(0, 120) : undefined);
		return commit(addTracker(stored.trackers, v, { id, now: new Date().toISOString() }), (errors) => formError(addView(errors, { type: str(v.type), value: str(v.value), enabled: v.enabled })));
	}
	if (act === "an-edit-save") {
		const id = /^an-edit:([\w-]{1,80})$/.exec(i.block_id ?? "")?.[1];
		const t = byId(id);
		if (!t || !id) return { stored, toast: { message: "That tracking code is no longer in the list.", type: "info" } };
		return commit(editTracker(stored.trackers, id, v), (errors) => formError(editView({ ...t, ...(typeof v.value === "string" ? { value: v.value.slice(0, 200) } : {}) }, errors)));
	}
	if (act === "an-switches") {
		const sw = switchesFrom(v);
		return save({ ...stored, ...sw }, `Switches saved (consent mode ${sw.consent ? "on" : "off"}; tracking loads ${sw.defer ? "after the page has drawn" : "at once"}).`);
	}
	return { stored };
}
