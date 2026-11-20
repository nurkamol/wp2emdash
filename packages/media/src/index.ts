/**
 * @wp2emdash/media — Media Assistant for EmDash on Cloudflare Workers (experimental, 0.x). A PixelKraft in-house plugin,
 * on by default in every site the wp2emdash kit builds (`media: false` in kit.config.ts turns it off).
 *
 * Plugins → Media (editors and admins): media health (totals, oversized originals, missing alt text with where each
 * image is used, unused files, duplicates, formats, broken references), Optimize (resize + re-encode in place through
 * the Cloudflare Images binding, the old file kept 30 days), reviewed alt text suggestions (Workers AI when the site has
 * the binding and AI is on, else file names and page headings), a quick focal point, and a Trash with a 30-day undo.
 *
 * This entry is safe to import from astro.config (Node): it only builds the plugin descriptor. The Worker-side module
 * is `@wp2emdash/media/plugin`. Facts it relies on: the kit's docs/spikes/media-findings.md.
 */
import { MEDIA_PLUGIN } from "./meta.js";

export { MEDIA_PLUGIN };

export interface MediaLimits {
	/** Longest side (px) an image original should have. Default 2500. */
	maxDimension: number;
	/** Image files above this many bytes are "oversized". Default 500 KB. */
	maxImageBytes: number;
	/** Video files above this many bytes are "oversized". Default 10 MB. */
	maxVideoBytes: number;
	/** Re-encoding quality for JPEG and WebP (1–100). Default 82. */
	quality: number;
}

export const DEFAULT_LIMITS: MediaLimits = { maxDimension: 2500, maxImageBytes: 500 * 1024, maxVideoBytes: 10 * 1024 * 1024, quality: 82 };

export interface MediaOptions {
	productionUrl: string;
	siteName: string;
	/**
	 * Alt text suggestions from Workers AI (the Worker's `AI` binding; the kit adds it when kit.config media.aiAlt is on).
	 * Off by default on sites with sensitiveData: image bytes would go to a model. Admins can switch it on the page.
	 */
	aiAlt: boolean;
	/** The site handles sensitive data (kit.config sensitiveData): the page explains why AI starts off. */
	sensitive?: boolean;
	/** Workers AI vision model. Default "@cf/meta/llama-3.2-11b-vision-instruct". */
	aiModel?: string;
	/** Queue new uploads for optimizing (processed by an editor's click, or hourly with MEDIA_API_TOKEN). Default off. */
	autoOptimize?: boolean;
	limits?: Partial<MediaLimits>;
	/** Extra file-name patterns (regex source, case-insensitive) that are never offered for the trash. */
	protect?: string[];
}

export const DEFAULT_AI_MODEL = "@cf/meta/llama-3.2-11b-vision-instruct";

export function limitsOf(o: Pick<MediaOptions, "limits">): MediaLimits {
	return { ...DEFAULT_LIMITS, ...(o.limits ?? {}) };
}

/** The EmDash plugin descriptor for `emdash({ plugins: [mediaPlugin({...})] })`: adds Plugins → Media. */
export function mediaPlugin(options: MediaOptions) {
	return { ...MEDIA_PLUGIN, format: "native" as const, displayName: "Media Assistant", description: "Media health, optimizing originals, alt text suggestions, focal points and a 30-day media trash", entrypoint: "@wp2emdash/media/plugin", options };
}
