/**
 * Privacy & consent — EmDash native plugin (Block Kit admin, no React bundle), loaded in the Worker from
 * `@wp2emdash/consent/plugin`; register it with `consentPlugin()` from `@wp2emdash/consent` in astro.config.
 *
 * - `admin` route (EmDash's default `plugins:manage`, admins only; checked again here): the Privacy & consent page —
 *   settings form, category table, preview link, "Ask every visitor again", consent log counts. Every save purges the
 *   cached pages (the SEO & Analytics mechanism: `cache.purge({ tags })`).
 * - `log` route (public POST, JSON `{ choice }`, 64 bytes max): counts one banner choice for today when the consent
 *   log is on. Nothing else is read or kept: no IP, no identifier, no user agent, no page.
 *
 * The site reads the settings itself (one D1 row, starter utils/consent.ts) on a route-cache miss.
 */
import { definePlugin } from "emdash";
import { type PurgeApi, readStoredAnalytics } from "@wp2emdash/seo/analytics/store";
import { runtimeConfig, seedTrackers } from "@wp2emdash/seo/analytics/trackers";
import type { ConsentOptions } from "../index.js";
import { CONSENT_PLUGIN } from "../meta.js";
import { type ConsentSettings, defaultSettings, parseSettings, servicesOf, type Services, settingsFromForm } from "../settings.js";
import { countChoice, type D1Like, KV_KEY, type Kv, pruneStats, purgePages, readStats } from "../store.js";
import { adminsOnly, PAGE, type PageData, page } from "./views.js";

export const ADMIN_ROLE = 50;

interface Item {
	id: string;
	slug: string | null;
	status?: string;
	data: Record<string, unknown>;
}
export interface ConsentCtx {
	input?: unknown;
	request?: Request;
	user?: { role: number; name?: string | null; email?: string };
	kv: Kv;
	content?: { list(c: string, o?: { limit?: number; cursor?: string }): Promise<{ items: Item[]; cursor?: string; hasMore?: boolean }> };
	log?: { info(m: string, d?: Record<string, unknown>): void };
}
interface Interaction {
	type?: string;
	action_id?: string;
	value?: unknown;
	values?: Record<string, unknown>;
}
export interface WorkerBits {
	env: { DB?: D1Like };
	cache?: PurgeApi;
}
// Bindings exist only in the Worker: imported per call, not at module level (astro.config loads the descriptor in Node).
const workerBits = async (): Promise<WorkerBits> => {
	const m = (await import("cloudflare:workers")) as unknown as Partial<WorkerBits>;
	return { env: m.env ?? {}, ...(m.cache ? { cache: m.cache } : {}) };
};

/** The stored settings; on the very first load, the carried-over defaults (stored, so the site reads the same). */
export async function loadSettings(kv: Kv, o: ConsentOptions, now = new Date().toISOString()): Promise<ConsentSettings> {
	const stored = parseSettings(await kv.get<unknown>(KV_KEY), o.defaults);
	if (stored) return stored;
	const seeded = defaultSettings(o.defaults, now);
	await kv.set(KV_KEY, seeded);
	return seeded;
}

/** What the pages load, by category: SEO & Analytics' stored trackers (or the seed), and the site widgets. */
export async function siteServices(o: ConsentOptions, db: D1Like | undefined): Promise<Services> {
	if (!o.analytics) return servicesOf(undefined, o.widgets ?? []);
	const seed = seedTrackers(o.analytics.seed);
	const stored = o.analytics.admin ? await readStoredAnalytics(db) : undefined;
	const rc = stored ? runtimeConfig(stored.trackers) : stored === null ? undefined : runtimeConfig(seed);
	return servicesOf(rc, o.widgets ?? [], o.analytics.zoneBeacon);
}

const pathOf = (slug: string, style: ConsentOptions["trailingSlash"]) => (slug === "home" || slug === "" ? "/" : `/${slug.replace(/^\/+|\/+$/g, "")}${style === "always" ? "/" : ""}`);

async function policyPages(ctx: ConsentCtx, o: ConsentOptions): Promise<{ label: string; path: string }[]> {
	if (!ctx.content) return [];
	const out: { label: string; path: string }[] = [];
	let cursor: string | undefined;
	try {
		do {
			const r = await ctx.content.list("pages", { limit: 100, ...(cursor ? { cursor } : {}) });
			for (const i of r.items) if (i.slug && (i.status === undefined || i.status === "published")) out.push({ label: String(i.data.title ?? i.slug).slice(0, 80), path: pathOf(i.slug, o.trailingSlash) });
			cursor = r.hasMore !== false && r.cursor && out.length < 500 ? r.cursor : undefined;
		} while (cursor);
	} catch {}
	// Privacy and legal pages first.
	return out.sort((a, b) => Number(/privac|cookie|datenschutz|legal/i.test(b.label + b.path)) - Number(/privac|cookie|datenschutz|legal/i.test(a.label + a.path)) || a.label.localeCompare(b.label));
}

function purgeNote(r: string): string {
	if (r === "purged") return " Live pages update within a few seconds.";
	if (r === "no-cache") return "";
	return " Cached pages could not be refreshed right now: they show the change within the hour, or after the next deploy.";
}

export type AdminResult = { blocks: Record<string, unknown>[]; toast?: { message: string; type: "success" | "error" | "info" } };

/** The admin route, with the Worker bits passed in (tests give stand-ins). */
export async function adminRoute(ctx: ConsentCtx, o: ConsentOptions, w: WorkerBits): Promise<AdminResult> {
	if ((ctx.user?.role ?? 0) < ADMIN_ROLE) return { blocks: adminsOnly };
	const i = (ctx.input ?? {}) as Interaction;
	const act = i.action_id ?? "";
	let settings = await loadSettings(ctx.kv, o);
	const [services, pages] = await Promise.all([siteServices(o, w.env.DB), policyPages(ctx, o)]);
	const previewUrl = new URL("/?consent-preview=1", ctx.request?.url ?? o.productionUrl).toString();
	const show = async (extra: Partial<PageData> = {}) => page({ settings, services, pages, keptTools: o.keptTools ?? [], ...(o.oldSite ? { oldSite: o.oldSite } : {}), previewUrl, ...(settings.stats ? { stats: await readStats(ctx.kv) } : {}), ...extra });
	const save = async (next: ConsentSettings, message: string): Promise<AdminResult> => {
		settings = { ...next, updatedAt: new Date().toISOString(), updatedBy: (ctx.user?.name || ctx.user?.email || "an admin").slice(0, 80) };
		await ctx.kv.set(KV_KEY, settings);
		const purged = await purgePages(w.cache);
		ctx.log?.info("consent settings saved", { mode: settings.mode, revision: settings.revision, stats: settings.stats, purge: purged });
		return { blocks: await show(), toast: { message: `${message}${purgeNote(purged)}`, type: purged === "failed" ? "info" : "success" } };
	};

	if (i.type === "form_submit" && act === "save") {
		const values = i.values ?? {};
		const r = settingsFromForm(settings, values, pages.map((p) => p.path));
		if (!r.ok) return { blocks: await show({ errors: r.errors, values }), toast: { message: "Not saved. See the message on the page.", type: "error" } };
		return save(r.settings, "Privacy & consent saved.");
	}
	if (i.type === "block_action" && act === "ask-again") return save({ ...settings, revision: settings.revision + 1 }, "Every visitor is asked again from their next page.");
	if (i.type === "block_action" && act === "stats-clear") {
		const n = await pruneStats(ctx.kv, new Date(), true);
		return { blocks: await show(), toast: { message: `Consent log cleared (${n} day${n === 1 ? "" : "s"}).`, type: "success" } };
	}
	return { blocks: await show() };
}

export function createPlugin(options: ConsentOptions) {
	const o = options;
	return definePlugin({
		...CONSENT_PLUGIN,
		capabilities: ["content:read"],
		admin: { pages: [{ path: PAGE, label: "Privacy & consent", icon: "shield-check" }] },
		routes: {
			admin: {
				permission: "plugins:manage",
				handler: async (raw: unknown) => adminRoute(raw as ConsentCtx, o, await workerBits()),
			},
			log: {
				public: true,
				methods: ["POST"],
				request: { body: "json", maxBytes: 64 },
				handler: async (raw: unknown) => {
					const ctx = raw as ConsentCtx;
					const s = parseSettings(await ctx.kv.get<unknown>(KV_KEY), o.defaults);
					if (!s?.stats) return { counted: false };
					const choice = ctx.input && typeof ctx.input === "object" ? (ctx.input as { choice?: unknown }).choice : undefined;
					return { counted: await countChoice(ctx.kv, choice) };
				},
			},
		},
	});
}

export default createPlugin;
