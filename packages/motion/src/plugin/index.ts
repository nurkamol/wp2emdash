/**
 * Motion — EmDash native plugin (Block Kit admin, no React bundle), loaded in the Worker from
 * `@wp2emdash/motion/plugin`; register it with `motionPlugin()` from `@wp2emdash/motion` in astro.config.
 *
 * `admin` route (EmDash's default `plugins:manage`, admins only; checked again here): the Motion page — settings form,
 * speed note, preview links, "Turn all motion off". Every save purges the cached pages (the SEO & Analytics mechanism:
 * `cache.purge({ tags })`); "Preview only" stores nothing and returns a link with the typed settings
 * (`/?motion-preview=…`, honoured for signed-in editors only and never cached).
 *
 * The site reads the settings itself (one D1 row, starter utils/motion.ts) on a route-cache miss.
 */
import { definePlugin } from "emdash";
import type { PurgeApi } from "@wp2emdash/seo/analytics/store";
import type { MotionOptions } from "../index.js";
import { MOTION_PLUGIN } from "../meta.js";
import { defaultSettings, encodePreview, type MotionSettings, parseSettings, PREVIEW_PARAM, settingsFromForm } from "../settings.js";
import { KV_KEY, type Kv, purgePages } from "../store.js";
import { adminsOnly, PAGE, type PageData, page } from "./views.js";

export const ADMIN_ROLE = 50;

export interface MotionCtx {
	input?: unknown;
	request?: Request;
	user?: { role: number; name?: string | null; email?: string };
	kv: Kv;
	log?: { info(m: string, d?: Record<string, unknown>): void };
}
interface Interaction {
	type?: string;
	action_id?: string;
	values?: Record<string, unknown>;
}
export interface WorkerBits {
	cache?: PurgeApi;
}
// Bindings exist only in the Worker: imported per call, not at module level (astro.config loads the descriptor in Node).
const workerBits = async (): Promise<WorkerBits> => {
	const m = (await import("cloudflare:workers")) as unknown as Partial<WorkerBits>;
	return m.cache ? { cache: m.cache } : {};
};

/** The stored settings, or the defaults (nothing is written until an admin saves: the site then behaves as built). */
export async function loadSettings(kv: Kv): Promise<MotionSettings> {
	return parseSettings(await kv.get<unknown>(KV_KEY)) ?? defaultSettings();
}

export function previewLink(s: MotionSettings, base: string): string {
	const u = new URL("/", base);
	u.searchParams.set(PREVIEW_PARAM, encodePreview(s));
	return u.toString();
}

function purgeNote(r: string): string {
	if (r === "purged") return " Visitors see it within a few seconds (on their next page).";
	if (r === "no-cache") return " Visitors see it on their next page.";
	return " Cached pages could not be refreshed right now: visitors see the change within the hour, or after the next deploy.";
}

export type AdminResult = { blocks: Record<string, unknown>[]; toast?: { message: string; type: "success" | "error" | "info" } };

/** The admin route, with the Worker bits passed in (tests give stand-ins). */
export async function adminRoute(ctx: MotionCtx, o: MotionOptions, w: WorkerBits): Promise<AdminResult> {
	if ((ctx.user?.role ?? 0) < ADMIN_ROLE) return { blocks: adminsOnly };
	const i = (ctx.input ?? {}) as Interaction;
	const act = i.action_id ?? "";
	let settings = await loadSettings(ctx.kv);
	const base = ctx.request?.url ?? o.productionUrl;
	const show = (extra: Partial<PageData> = {}) => page({ settings, siteEntrance: o.siteEntrance, savedUrl: previewLink(settings, base), ...extra });
	const save = async (next: MotionSettings, message: string): Promise<AdminResult> => {
		settings = { ...next, updatedAt: new Date().toISOString(), updatedBy: (ctx.user?.name || ctx.user?.email || "an admin").slice(0, 80) };
		await ctx.kv.set(KV_KEY, settings);
		const purged = await purgePages(w.cache);
		ctx.log?.info("motion settings saved", { preloader: settings.preloader, transition: settings.transition, entrance: settings.entrance, purge: purged });
		return { blocks: show(), toast: { message: `${message}${purgeNote(purged)}`, type: purged === "failed" ? "info" : "success" } };
	};

	if (i.type === "form_submit" && act === "save") {
		const values = i.values ?? {};
		const r = settingsFromForm(settings, values);
		if (!r.ok) return { blocks: show({ errors: r.errors }), toast: { message: "Not saved. See the message on the page.", type: "error" } };
		if (values.previewOnly === true) return { blocks: show({ draft: r.settings, previewUrl: previewLink(r.settings, base) }), toast: { message: "Preview ready below. Nothing was published.", type: "info" } };
		return save(r.settings, "Motion saved.");
	}
	if (i.type === "block_action" && act === "reset") return save({ ...defaultSettings(), updatedAt: settings.updatedAt }, "All motion off.");
	return { blocks: show() };
}

export function createPlugin(options: MotionOptions) {
	const o = options;
	return definePlugin({
		...MOTION_PLUGIN,
		capabilities: [],
		admin: { pages: [{ path: PAGE, label: "Motion", icon: "sparkle" }] },
		routes: {
			admin: {
				permission: "plugins:manage",
				handler: async (raw: unknown) => adminRoute(raw as MotionCtx, o, await workerBits()),
			},
		},
	});
}

export default createPlugin;
