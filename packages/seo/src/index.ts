/**
 * @wp2emdash/seo — an SEO panel in the EmDash page editor (experimental, 0.x): Google result and social previews, an
 * on-page checklist with a score (title and description length, duplicates, one H1, heading order, length, alt text,
 * links, address, indexing, sharing image) and an optional focus keyword per page. Safe to import from astro.config.
 */
export interface SeoPanelOptions {
	/** The production address, e.g. "https://example.com" (the Google preview shows it, not staging). */
	productionUrl: string;
	/** Separator between page title and site name in <title>, as the layout builds it. */
	titleSeparator?: string;
	/** Collections that get the panel. */
	collections?: string[];
	/** Sharing cards (@wp2emdash/og) are on: a page without its own image still gets one. */
	ogCards?: boolean;
}

export const SEO_PLUGIN = { id: "site-seo", version: "0.1.0" } as const;

export function seoPlugin(options: SeoPanelOptions) {
	return { ...SEO_PLUGIN, format: "native" as const, displayName: "SEO", description: "SEO panel in the page editor", entrypoint: "@wp2emdash/seo/plugin", options };
}
