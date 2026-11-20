/**
 * Site features the old theme showed around the content, read from the audited HTML: a search icon in the header, visible
 * breadcrumbs (Rank Math, Yoast, Breadcrumb NavXT, theme), a customised 404 page (audit fetches a known-missing address:
 * snapshot/not-found.html), and a maintenance / coming-soon plugin (reported only: the new site's coming-soon mode is
 * never switched on by the migration). Pure functions; transform writes the results (ir/site-features.json, the
 * `not-found` site part) and scaffold puts the switches into site.config.json.
 */
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { htmlToPortableText, type Keys } from "../ir/portable-text.js";
import { type Button, type Diagnostic, IR_VERSION, type IrPage } from "../ir/schema.js";

/** The header showed a search box or a search toggle. Salient prints its search markup on every page and says with `data-header-search` whether it is on. */
export function headerSearch(html: string | undefined): boolean {
	if (!html) return false;
	const salient = /<body\b[^>]*\bdata-header-search=["'](true|false)["']/i.exec(html);
	if (salient) return salient[1] === "true";
	const $ = cheerio.load(html);
	const header = $("header, #masthead, #brx-header, .elementor-location-header, #header, .site-header").first();
	if (!header.length) return false;
	return header.find('form[role="search"], input[name="s"], .brxe-search, .elementor-search-form, .ast-search-icon, .search-toggle, .header-search, .search-item, [class*="search-toggle"], a[href*="?s="], button[aria-label*="earch" i]').length > 0;
}

export interface BreadcrumbsFound {
	/** Which plugin printed them. */
	source: "rank-math" | "yoast" | "navxt" | "theme";
	/** Shown on pages / on posts (by the page's body class). */
	pages: boolean;
	posts: boolean;
	/** The first crumb's label ("Home"). */
	home?: string;
}

const CRUMBS: [BreadcrumbsFound["source"], string][] = [
	["rank-math", "nav.rank-math-breadcrumb, .rank-math-breadcrumb"],
	["yoast", "#breadcrumbs, .yoast-breadcrumbs, span[property='itemListElement'] a"],
	["navxt", ".breadcrumbs[typeof='BreadcrumbList'], .breadcrumb-navxt, .bcn-breadcrumbs"],
	["theme", "nav.breadcrumb, nav.breadcrumbs, .woocommerce-breadcrumb, nav[aria-label='Breadcrumb' i], nav[aria-label='Breadcrumbs' i], .brxe-breadcrumbs, .elementor-widget-breadcrumbs"],
];

/** Visible breadcrumbs on the audited pages (raw HTML), split by pages and posts. */
export function breadcrumbsOf(pages: { html: string }[]): BreadcrumbsFound | undefined {
	let source: BreadcrumbsFound["source"] | undefined;
	let onPages = false;
	let onPosts = false;
	let home: string | undefined;
	for (const p of pages) {
		const $ = cheerio.load(p.html);
		const body = $("body").attr("class") ?? "";
		const isPost = /\bsingle-post\b|\bpostid-\d+/.test(body);
		for (const [src, sel] of CRUMBS) {
			const el = $(sel).first();
			if (!el.length) continue;
			const first = el.find("a").first().text().replace(/\s+/g, " ").trim();
			if (!el.text().trim()) continue;
			source ??= src;
			home ??= first || undefined;
			if (isPost) onPosts = true;
			else onPages = true;
			break;
		}
	}
	return source ? { source, pages: onPages, posts: onPosts, ...(home ? { home: home.slice(0, 40) } : {}) } : undefined;
}

/** Maintenance / coming-soon plugins (fingerprint slugs) and their names. */
const MAINTENANCE: Record<string, string> = {
	"coming-soon": "SeedProd Coming Soon & Maintenance",
	"seedprod-coming-soon-pro-5": "SeedProd Pro",
	"seedprod-pro": "SeedProd Pro",
	seedprod: "SeedProd",
	"wp-maintenance-mode": "LightStart (WP Maintenance Mode)",
	lightstart: "LightStart",
	maintenance: "Maintenance (WebFactory)",
	"under-construction-page": "UnderConstructionPage",
	"cmp-coming-soon-maintenance": "CMP Coming Soon & Maintenance",
	"minimal-coming-soon-maintenance-mode": "Minimal Coming Soon",
	"coming-soon-page": "Coming Soon Page",
	"elementor-maintenance-mode": "Elementor maintenance mode",
};

/** A maintenance / coming-soon plugin on the old site (fingerprint slugs, or Elementor's maintenance template in the HTML). */
export function maintenancePlugin(plugins: { slug: string }[], pages: { html: string }[]): string | undefined {
	for (const p of plugins) if (MAINTENANCE[p.slug]) return MAINTENANCE[p.slug];
	if (pages.some((p) => /elementor-maintenance-mode|seedprod-coming-soon|id=["']wpmm-|class=["'][^"']*cmp-coming-soon/i.test(p.html))) return "maintenance page markup in the audited HTML";
	return undefined;
}

/** WordPress's and common themes' stock 404 wording: a 404 page saying only this was not customised. */
const STOCK_404 = [
	/^(?:error )?404$/,
	/^(?:oops!? )?(?:that )?page (?:can[’']?t|cannot|could not|couldn[’']?t) be found\.?$/,
	/^(?:error 404: )?page not found\.?$/,
	/^nothing (?:was )?found\.?$/,
	/^it (?:looks|seems) like nothing was found at this location\.?(?: maybe try (?:one of the links below or )?a search\??)?$/,
	/^maybe try (?:one of the links below or )?a search\??$/,
	/^(?:sorry,? )?(?:but )?the page you (?:were|are) (?:trying to view|looking for|requested) (?:does not|doesn[’']?t|could not be found|no longer) ?(?:exist|be found)?\.?$/,
	/^the page you requested could not be found\.?(?: try refining your search, or use the navigation above to locate the post\.?)?$/,
	/^back to (?:home|homepage|the home ?page)$/,
	/^(?:go )?(?:back )?home(?: ?page)?$/,
	/^search(?: for:?)?$/,
];
const isStock = (t: string) => STOCK_404.some((r) => r.test(t.toLowerCase().replace(/\s+/g, " ").replace(/[“”"]/g, "").trim()));

export interface NotFoundContent {
	heading?: string;
	/** Paragraph HTML (links kept). */
	paragraphs: string[];
	links: { label: string; href: string }[];
	/** Something besides the stock wording. */
	customised: boolean;
}

/** The content area of the old 404 page, without the site chrome (header, footer, navigation, search forms). */
export function notFoundContent(html: string, siteHosts: string[]): NotFoundContent {
	const $ = cheerio.load(html);
	$("script, style, noscript, template, svg, header, footer, nav, aside, form, #header-outer, #footer-outer, #search-outer, #slide-out-widget-area, #brx-header, #brx-footer, .elementor-location-header, .elementor-location-footer, .skip-link, .screen-reader-text, [role=dialog], [class*=cookie], [id*=cookie]").remove();
	const main = ["main", "#main", ".error-404", ".not-found", "#brx-content", "#content", "article", "body"].map((s) => $(s).first()).find((x) => x.length && x.text().trim()) ?? $("body");
	const heading = main.find("h1").first().text().replace(/\s+/g, " ").trim() || main.find("h2").first().text().replace(/\s+/g, " ").trim() || undefined;
	const paragraphs: string[] = [];
	main.find("p").each((_, el) => {
		const t = $(el).text().replace(/\s+/g, " ").trim();
		if (t && t.length < 800 && !isStock(t)) paragraphs.push($(el).html()?.trim() ?? "");
	});
	const internal = (href: string) => {
		if (href.startsWith("/") && !href.startsWith("//")) return href;
		try {
			const u = new URL(href);
			return siteHosts.includes(u.host.replace(/^www\./, "")) ? `${u.pathname}${u.search}` : undefined;
		} catch {
			return undefined;
		}
	};
	const links: NotFoundContent["links"] = [];
	main.find("a[href]").each((_, el) => {
		if ($(el).closest("p").length) return; // kept in the paragraph
		const href = internal($(el).attr("href") ?? "");
		const label = $(el).text().replace(/\s+/g, " ").trim();
		if (href && label && !links.some((l) => l.href === href) && links.length < 6) links.push({ label: label.slice(0, 60), href });
	});
	const words = [heading && !isStock(heading) ? heading : "", ...paragraphs.map((p) => p.replace(/<[^>]+>/g, " "))].join(" ").split(/\s+/).filter(Boolean).length;
	const customLinks = links.filter((l) => !isStock(l.label) && l.href !== "/");
	return { ...(heading ? { heading } : {}), paragraphs, links, customised: words >= 4 || customLinks.length > 0 };
}

/** The `not-found` site part (editable in the admin; the starter's 404 page shows it): one text section with the old wording and links. */
export function notFoundDoc(c: NotFoundContent, keys: Keys, relHref: (href: string) => string): IrPage {
	const diagnostics: Diagnostic[] = [];
	const html = [c.heading ? `<h1>${c.heading.replace(/</g, "&lt;")}</h1>` : "", ...c.paragraphs.map((p) => `<p>${p}</p>`)].join("");
	const pt = htmlToPortableText(html, keys);
	for (const l of pt.leftovers) diagnostics.push({ level: "warn", code: "lossy", message: `<${l.tag}> in the 404 page not kept`, path: "not-found" });
	const body = pt.blocks.map((b) => ({ ...b, markDefs: b.markDefs.map((d) => ({ ...d, href: relHref(d.href) })) }));
	const buttons: Button[] = c.links.slice(0, 3).map((l, i) => ({ label: l.label, href: relHref(l.href), style: i === 0 ? "primary" : "secondary" }));
	for (const l of c.links.slice(3)) diagnostics.push({ level: "warn", code: "lossy", message: `404 page link “${l.label}” (${l.href}) not kept: the section takes three buttons`, path: "not-found", carriesContent: true });
	diagnostics.push({ level: "info", code: "flagged", message: "404 page text rebuilt from the old site's 404 page (snapshot/not-found.html)", path: "not-found" });
	return {
		version: IR_VERSION,
		kind: "partial",
		source: { wpId: 0, type: "not-found", status: "publish", slug: "not-found", builder: "html" },
		title: "Page not found (404)",
		seo: { jsonLdTypes: [] },
		sections: [{ type: "rich_text", theme: { tone: "light" }, spacing: "spacious", sourceRef: { adapter: "html", path: "not-found", rawHash: createHash("sha1").update(html + JSON.stringify(c.links)).digest("hex").slice(0, 10) }, fields: { body, width: "normal", align: "left", buttons } }] as IrPage["sections"],
		diagnostics,
	};
}

/** What scaffold puts into site.config.json and the coverage report shows (ir/site-features.json). */
export interface SiteFeatures {
	/** The header showed search: the starter's header gets a search link to /search/. */
	headerSearch: boolean;
	breadcrumbs?: BreadcrumbsFound;
	/** The old 404 page: customised (rebuilt as the `not-found` site part), stock, or not audited. */
	notFound: "rebuilt" | "stock" | "not-audited";
	/** A maintenance / coming-soon plugin was active on the old site (reported; never switched on here). */
	maintenance?: string;
}

export function siteFeaturesReport(f: SiteFeatures): string[] {
	return [
		"",
		"## Site features",
		"",
		`- **Search:** the starter's search page at \`/search/\` (EmDash full-text search over pages, posts and collections); WordPress's \`/?s=\` and \`/search/<terms>/\` go there with the query.${f.headerSearch ? " The old header had a search icon: the new header links to the search page." : ""}`,
		`- **Breadcrumbs:** ${f.breadcrumbs ? `shown on the old site (${f.breadcrumbs.source}${f.breadcrumbs.pages ? ", pages" : ""}${f.breadcrumbs.posts ? ", posts" : ""}): the starter shows them, with matching BreadcrumbList structured data.` : "not shown on the old site (structured data only)."}`,
		`- **404 page:** ${f.notFound === "rebuilt" ? "the old 404 page had its own text: rebuilt as the site part “not-found” (Header & footer → not-found)." : f.notFound === "stock" ? "the old 404 page used the theme's stock wording: the starter's own 404 page." : "not audited (rerun audit to capture it)."}`,
		`- **Maintenance / coming-soon:** ${f.maintenance ? `the old site had ${f.maintenance}. The new site's coming-soon mode (Site health → Settings) stays off: switch it on there if the site should not be public yet.` : "no maintenance plugin found. The new site's coming-soon mode (Site health → Settings) is off."}`,
	];
}
