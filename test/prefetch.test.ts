import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HEADERS_FILE } from "../src/scaffold/perf.js";
import { prefetchable, SKIP_LINKS, SPECULATION_RULES_PATH, slowConnection, speculationRules } from "../starter/src/utils/prefetch.js";

const here = { origin: "https://acme.example", pathname: "/about-us/", search: "" };

describe("page preloading (hover / focus / touch)", () => {
	it("preloads the site's own pages, without the hash", () => {
		expect(prefetchable("/classes/", here)).toBe("https://acme.example/classes/");
		expect(prefetchable("https://acme.example/blog/page/2/#top", here)).toBe("https://acme.example/blog/page/2/");
		expect(prefetchable("contact/", here)).toBe("https://acme.example/about-us/contact/");
		expect(prefetchable("/old-page.html", here)).toBe("https://acme.example/old-page.html");
	});
	it("never preloads files, other sites, admin/API/form endpoints, feeds, previews, searches or the current page", () => {
		for (const h of ["/wp-content/uploads/2024/menu.pdf", "/files/price-list.pdf", "/_emdash/api/media/file/abc", "/_emdash/admin", "/api/forms/contact", "/_image?url=x", "/feed/", "/category/news/feed/", "https://other.example/x/", "mailto:a@acme.example", "tel:+15550100", "/about-us/", "/about-us/#team", "/?s=yoga", "/search/?q=yoga", "/x/?_preview=1", "/logo.svg"]) expect(prefetchable(h, here), h).toBeUndefined();
	});
	it("stays off on data saver and 2G", () => {
		expect(slowConnection({ saveData: true })).toBe(true);
		expect(slowConnection({ effectiveType: "slow-2g" })).toBe(true);
		expect(slowConnection({ effectiveType: "2g" })).toBe(true);
		expect(slowConnection({ effectiveType: "4g" })).toBe(false);
		expect(slowConnection(undefined)).toBe(false);
	});
});

/**
 * Speculation Rules (Chrome/Edge): public/speculation-rules.json, read by the browser from the middleware's
 * Speculation-Rules header. Its URL patterns are checked with Node's URLPattern against prefetchable(), the
 * fallback's rule, so both paths skip the same addresses. Browser behaviour: docs/spikes/performance-findings.md.
 */
type Cond = { and?: Cond[]; not?: Cond; href_matches?: Record<string, string>; selector_matches?: string };
const ROOT = join(import.meta.dirname, "..");
const RULES_URL = `${here.origin}${SPECULATION_RULES_PATH}`;
const URLPatternCtor = (globalThis as unknown as { URLPattern: new (init: Record<string, string>) => { test(u: string): boolean } }).URLPattern;
/** Evaluates a `where` condition for a link; selector_matches is decided by the caller. */
function matches(c: Cond, href: string, selector = false): boolean {
	if (c.and) return c.and.every((x) => matches(x, href, selector));
	if (c.not) return !matches(c.not, href, selector);
	if (c.href_matches) return new URLPatternCtor({ ...c.href_matches, baseURL: RULES_URL }).test(href);
	if (c.selector_matches) return selector;
	throw new Error(`unknown condition ${JSON.stringify(c)}`);
}

describe("speculation rules (Chrome / Edge page preloading)", () => {
	const rules = speculationRules();
	const rule = rules.prefetch[0] as { source: string; eagerness: string; where: Cond };
	it("public/speculation-rules.json is speculationRules(): document rules, moderate, prefetch only", () => {
		expect(JSON.parse(readFileSync(join(ROOT, "starter", "public", "speculation-rules.json"), "utf8"))).toEqual(rules);
		expect(Object.keys(rules)).toEqual(["prefetch"]);
		expect(rules.prefetch).toHaveLength(1);
		expect(rule.source).toBe("document");
		expect(rule.eagerness).toBe("moderate");
	});
	it("matches exactly the links prefetchable() accepts", () => {
		const links = ["/classes/", "/", "/blog/page/2/#top", "/old-page.html", "/Old.HTM", "/about-us/team", "/?x=1", "/emdash/", "/apis/", "/feeds/", "/x/?page=2&sort=a", "/wp-content/uploads/2024/menu.pdf", "/files/price-list.pdf", "/_emdash/api/media/file/abc", "/_emdash", "/_emdash/admin", "/_astro/a.js", "/api/forms/contact", "/api", "/_image?url=x", "/feed", "/feed/", "/category/news/feed/", "/wp-admin/", "/wp-login.php", "https://other.example/x/", "http://acme.example:8080/x/", "/?s=yoga", "/search/?q=yoga", "/x/?_preview=1", "/x/?a=1&_edit=2", "/logo.svg", "/doc.PDF"];
		const other = { ...here, pathname: "/somewhere-else/" };
		for (const l of links) {
			const href = new URL(l, `${here.origin}/`).href;
			expect(matches(rule.where, href), l).toBe(prefetchable(href, other) !== undefined);
		}
	});
	it("never matches links that open elsewhere, downloads or data-prefetch=\"false\"", () => {
		expect(matches(rule.where, `${here.origin}/classes/`, true)).toBe(false);
		expect(SKIP_LINKS).toBe('[target="_blank"], [download], [data-prefetch="false"]');
	});
	it("_headers serves the file with the content type browsers require", () => {
		expect(HEADERS_FILE).toContain(`${SPECULATION_RULES_PATH}\n  Content-Type: application/speculationrules+json`);
	});
	it("middleware sends the header only on visitors' HTML pages, appended, and not when preloading is off", () => {
		const mw = readFileSync(join(ROOT, "starter", "src", "middleware.ts"), "utf8");
		expect(mw).toContain('const prefetchOn = (site as { prefetch?: boolean }).prefetch !== false;');
		expect(mw).toContain('if (html && prefetchOn && !isEditor(context.cookies, context.url)) headers.append("Speculation-Rules", `"${SPECULATION_RULES_PATH}"`);');
		// The coming-soon page (503) is answered before it; sitemaps and /_emdash return before it too.
		expect(mw.indexOf("status: 503")).toBeLessThan(mw.indexOf('headers.append("Speculation-Rules"'));
		expect(mw.indexOf('context.url.pathname.startsWith("/_emdash") || context.url.pathname === "/_image") return response;')).toBeLessThan(mw.indexOf('headers.append("Speculation-Rules"'));
		expect(mw).not.toContain('headers.set("Speculation-Rules"');
	});
	it("site.ts keeps <link rel=prefetch> only for browsers without speculation rules", () => {
		const site = readFileSync(join(ROOT, "starter", "src", "scripts", "site.ts"), "utf8");
		expect(site).toContain('if (document.documentElement.dataset.prefetch !== "off" && !(HTMLScriptElement as { supports?: (type: string) => boolean }).supports?.("speculationrules")) {');
	});
});
