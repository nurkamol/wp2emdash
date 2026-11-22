/**
 * Media Assistant (@wp2emdash/media, on by default): the plugin options scaffold writes into astro.config, and whether
 * the Worker gets the Workers AI binding (only when AI alt text is on — off by default on sensitive sites).
 */
import type { MediaOptions } from "../../packages/media/src/index.js";
import type { KitConfig } from "../config/schema.js";

export interface MediaInputs {
	config: Pick<KitConfig, "name" | "media" | "sensitiveData">;
	productionUrl: string;
}

export function mediaOptions(i: MediaInputs): MediaOptions | undefined {
	const m = i.config.media;
	if (m === false) return undefined;
	const aiAlt = m.aiAlt ?? !i.config.sensitiveData;
	return {
		productionUrl: i.productionUrl,
		siteName: i.config.name,
		aiAlt,
		...(i.config.sensitiveData ? { sensitive: true } : {}),
		...(m.autoOptimize ? { autoOptimize: true } : {}),
		...(m.maxDimension !== 2500 ? { limits: { maxDimension: m.maxDimension } } : {}),
		...(m.protect.length ? { protect: m.protect } : {}),
	};
}

/** The Worker needs `"ai": { "binding": "AI" }` (wrangler.jsonc; not inherited by named environments). */
export const mediaNeedsAi = (o: MediaOptions | undefined) => !!o?.aiAlt;

/**
 * Whether the Worker gets the Workers AI binding: Media's AI alt text, or SEO fix-it (SEO panel on). Fix-it sends only
 * published page text, but on sensitiveData sites the binding is left out so no AI feature is reachable by default;
 * the fix-it page then explains how to add it.
 */
export const workerNeedsAi = (media: MediaOptions | undefined, seoPanel: boolean, sensitiveData: boolean | undefined) => mediaNeedsAi(media) || (seoPanel && !sensitiveData);
