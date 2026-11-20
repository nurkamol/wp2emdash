import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONSENT_BANNERS } from "../src/audit/consent-banners.js";

const root = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("captures see the page, not the consent banner", () => {
	it("targets the starter's real banner markup (class consent--bar/card, a reject button)", () => {
		const banner = read("starter/public/scripts/site-consent.js");
		expect(banner).toContain("class: `consent consent--${");
		expect(banner).toContain('btn("reject"');
		expect(CONSENT_BANNERS).toContain('div.consent[class*="consent--"]');
		expect(read("src/audit/browser.ts")).toContain("div.consent[class*='consent--'] [data-consent-reject]");
		// Menu capture hides banners before it looks for the burger (the banner's "Manage" button has aria-controls too).
		const menu = read("src/audit/interactions.ts");
		expect(menu.indexOf("CONSENT_BANNERS} { display: none")).toBeGreaterThan(-1);
		expect(menu.indexOf("CONSENT_BANNERS} { display: none")).toBeLessThan(menu.indexOf("const hit = await findToggle(page);"));
	});
});

describe("public CSP: no inline scripts", () => {
	it("generated astro.config never inlines a script (Astro inlines component scripts under 4 KB)", () => {
		expect(read("src/phases/scaffold.ts")).toContain("vite: { build: { assetsInlineLimit: 0 } },");
	});
	it("the comment form's script renders only where the form does", () => {
		const c = read("starter/src/components/comments/Comments.astro");
		expect(c).toContain("{form && <CommentsScript />}");
		expect(c).not.toMatch(/<script>\s*import "..\/..\/scripts\/comments";/);
		expect(read("starter/src/components/comments/CommentsScript.astro")).toContain('import "../../scripts/comments";');
	});
});

describe("verify: old-address judgement", () => {
	it("defines the collection archive paths before the judgement uses them (crashed with a TDZ error)", () => {
		const v = read("src/phases/verify.ts");
		expect(v.indexOf("const archivePaths =")).toBeGreaterThan(-1);
		expect(v.indexOf("const archivePaths =")).toBeLessThan(v.indexOf("archivePaths.length ? { realRoutes"));
	});
});
