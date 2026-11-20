/**
 * Font hosts the Content-Security-Policy allows beyond the site and Google Fonts. Adobe Fonts (Typekit): the project's
 * stylesheet and font files come from use.typekit.net; the stylesheet imports Adobe's page-view counter from
 * p.typekit.net (part of the licence). Only when site.config.json keeps a project (`fonts.typekitHref`). Pure: tested in
 * Node (test/fonts.test.ts).
 */
export const TYPEKIT_CSP = { style: ["https://use.typekit.net", "https://p.typekit.net"], font: ["https://use.typekit.net"] } as const;

export function fontCsp(fonts: { typekitHref?: string } | undefined): { style: string[]; font: string[] } {
	return fonts?.typekitHref ? { style: [...TYPEKIT_CSP.style], font: [...TYPEKIT_CSP.font] } : { style: [], font: [] };
}
