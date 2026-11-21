/**
 * /.well-known/ard.json — Agentic Resource Discovery manifest (https://agenticresourcediscovery.org/spec/, v0.91):
 * tells AI agents and registries which machine-readable resources the site publishes. Lighthouse 13.6+ checks it in
 * its "Agentic Browsing" category (audit `ard-schema`). Without the file the audit should be "not applicable", but a
 * 404 that renders the site's not-found page can miss Lighthouse's 2-second fetch limit and fail it; a static file is
 * served by Cloudflare's asset layer before the Worker and always loads.
 *
 * Written into public/.well-known/ard.json by scaffold (the name and address change only on a rerun). Entries are
 * the site's own discovery files: /llms.txt (page map for AI assistants) and /sitemap.xml. Every entry carries the
 * fields the ARD conformance check requires (URN identifier anchored at the site's host, displayName, type, url) and
 * 2–5 representativeQueries. No imports: this file loads in Node (scaffold, kit tests).
 */

export interface ArdEntry {
	identifier: string;
	displayName: string;
	type: string;
	url: string;
	description: string;
	representativeQueries: string[];
	tags: string[];
}

/** RFC 8141 URN form the ARD conformance check expects: urn:air:<publisher>[:<namespace>]:<name>. */
export const ARD_URN = /^urn:air:([a-zA-Z0-9.-]+)(?::([a-zA-Z0-9._:-]+))?:([a-zA-Z0-9._-]+)$/;

const clean = (s: string) => s.replace(/\s+/g, " ").trim();

export function ardManifest(site: { name: string; productionUrl: string; tagline?: string }): { entries: ArdEntry[] } {
	const origin = new URL(site.productionUrl).origin;
	const publisher = new URL(origin).hostname.replace(/^www\./, "");
	const name = clean(site.name) || publisher;
	const about = site.tagline ? ` ${clean(site.tagline)}.`.replace(/\.\.$/, ".") : "";
	return {
		entries: [
			{
				identifier: `urn:air:${publisher}:site:llms`,
				displayName: `${name} — page map for AI assistants`,
				type: "text/markdown",
				url: `${origin}/llms.txt`,
				description: `Markdown list of ${name}'s public pages with short descriptions (llms.txt).${about}`,
				representativeQueries: [`What does ${name} offer?`, `Which pages are on the ${name} website?`, `How do I contact ${name}?`],
				tags: ["llms.txt", "website"],
			},
			{
				identifier: `urn:air:${publisher}:site:sitemap`,
				displayName: `${name} — sitemap`,
				type: "application/xml",
				url: `${origin}/sitemap.xml`,
				description: `XML sitemap of every public page on ${name}'s website.`,
				representativeQueries: [`List all pages on the ${name} website`, `When was the ${name} website last updated?`],
				tags: ["sitemap", "website"],
			},
		],
	};
}
