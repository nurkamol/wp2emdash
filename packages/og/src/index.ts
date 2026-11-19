/**
 * @wp2emdash/og — branded sharing images for EmDash: a 1200×630 card (logo, site name, page title, brand colours and
 * fonts) rendered in the Worker with Satori + resvg (WebAssembly), cached in R2, and set as the page's og:image and
 * Twitter image by an EmDash plugin. This entry is safe to import from astro.config (Node): it only builds the
 * plugin descriptor. Experimental (0.x): enabled per site with `og: { cards: true }` in the kit config.
 */
export interface OgCardOptions {
	siteName: string;
	/** Shown on the card, e.g. "example.com". */
	domain: string;
	/** Site path of the logo (SVG or PNG), e.g. "/brand/logo.svg". */
	logo?: string;
	colors: { bg: string; text: string; accent: string; muted: string };
	/** Site paths of TrueType fonts (Satori reads TTF/OTF/WOFF, not WOFF2). */
	fonts: { display: string; body: string };
	displayWeight?: number;
}

export const OG_PLUGIN = { id: "site-og", version: "0.1.0" } as const;

/** The EmDash plugin descriptor for `emdash({ plugins: [ogPlugin({...})] })`. */
export function ogPlugin(options: OgCardOptions) {
	return { ...OG_PLUGIN, format: "native" as const, displayName: "Sharing images", description: "Branded og:image cards for every page", entrypoint: "@wp2emdash/og/plugin", options };
}
