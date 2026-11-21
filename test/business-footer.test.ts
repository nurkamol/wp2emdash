import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { overridesSchema } from "../src/config/overrides.js";
import { kitConfigSchema } from "../src/config/schema.js";
import { businessFooter } from "../src/scaffold/business.js";
import { applyBusinessOverride } from "../src/transform/business.js";
import { addressLines, type Business, footerShowsContact, formatOpeningHours, hasContact, mapHref, openingHoursLines, showsHours, telHref } from "../starter/src/utils/business.js";

const starter = (p: string) => readFileSync(join(import.meta.dirname, "..", "starter", "src", p), "utf8");
const acme: Business = {
	type: "HealthClub",
	name: "Acme Studio",
	telephone: "+1 (555) 010-0100",
	address: { streetAddress: "1 Main St", addressLocality: "Springfield", addressRegion: "IL", postalCode: "62701", addressCountry: "US" },
	openingHours: ["Mo-Fr 06:00-21:00", "Sa 08:00-12:00"],
};

describe("opening hours formatter", () => {
	it("turns schema.org day codes and times into readable lines", () => {
		expect(formatOpeningHours("Mo-Fr 06:00-21:00")).toEqual(["Mon–Fri 6:00 AM–9:00 PM"]);
		expect(formatOpeningHours("Mo,We,Fr 09:00-12:00,13:00-17:30")).toEqual(["Mon, Wed, Fri 9:00 AM–12:00 PM, 1:00 PM–5:30 PM"]);
		expect(formatOpeningHours("Monday,Tuesday 09:00-17:00")).toEqual(["Mon, Tue 9:00 AM–5:00 PM"]);
		expect(formatOpeningHours("Sa 08:00-12:00 Su 10:00-14:00")).toEqual(["Sat 8:00 AM–12:00 PM", "Sun 10:00 AM–2:00 PM"]);
		expect(formatOpeningHours("Mo-Su")).toEqual(["Every day"]);
		expect(formatOpeningHours("Mo,Tu,We,Th,Fr,Sa,Su 09:00-17:00")).toEqual(["Every day 9:00 AM–5:00 PM"]);
		expect(formatOpeningHours("Mo,Tu,We,Th,Fr 09:00-17:00")).toEqual(["Mon–Fri 9:00 AM–5:00 PM"]);
		expect(formatOpeningHours("Mo,Tu,Th,Fr,Sa 09:00-17:00")).toEqual(["Mon, Tue, Thu–Sat 9:00 AM–5:00 PM"]);
		expect(formatOpeningHours("Fr-Mo 09:00-17:00")).toEqual(["Fri–Mon 9:00 AM–5:00 PM"]);
		expect(formatOpeningHours("Mo-Su", "de")[0]).toContain("–");
	});
	it("follows the site's language", () => {
		expect(formatOpeningHours("Mo-Fr 06:00-21:00", "en-GB")).toEqual(["Mon–Fri 6:00–21:00"]);
	});
	it("shows what it cannot read as written, never drops it", () => {
		expect(formatOpeningHours("By appointment")).toEqual(["By appointment"]);
		expect(openingHoursLines(["Mo-Fr 06:00-21:00", "Holidays closed"])).toEqual(["Mon–Fri 6:00 AM–9:00 PM", "Holidays closed"]);
	});
	it("hours only for LocalBusiness types, as in the JSON-LD", () => {
		expect(showsHours(acme)).toBe(true);
		expect(showsHours({ ...acme, type: "Organization" })).toBe(false);
		expect(starter("components/StructuredData.astro")).toContain("...(showsHours(b) ? { openingHours: b.openingHours } : {}),");
	});
});

describe("phone, address and map", () => {
	it("normalises the phone for tel: and keeps a leading +", () => {
		expect(telHref("+1 (555) 010-0100")).toBe("tel:+15550100100");
		expect(telHref("555.010.0100 ext. 12")).toBe("tel:5550100100");
		expect(telHref("call us")).toBeUndefined();
		expect(telHref(undefined)).toBeUndefined();
	});
	it("writes the address as lines (country codes left out) and links a map search", () => {
		expect(addressLines(acme.address)).toEqual(["1 Main St", "Springfield, IL 62701"]);
		expect(addressLines({ streetAddress: "1 Main St", addressCountry: "United States" })).toEqual(["1 Main St", "United States"]);
		expect(mapHref(acme)).toBe("https://www.google.com/maps/search/?api=1&query=1%20Main%20St%2C%20Springfield%2C%20IL%2062701");
		expect(mapHref({ ...acme, hasMap: "https://maps.example/acme" })).toBe("https://maps.example/acme");
		expect(mapHref({ hasMap: "javascript:alert(1)" })).toBeUndefined();
	});
	it("needs an address or a phone", () => {
		expect(hasContact(acme)).toBe(true);
		expect(hasContact({ type: "Organization", name: "Acme", telephone: "555 0100" })).toBe(true);
		expect(hasContact({ type: "Organization", name: "Acme", email: "hi@acme.example" })).toBe(false);
		expect(hasContact(undefined)).toBe(false);
	});
});

describe("footer contact block decision (scaffold)", () => {
	it("is on by default in kit.config", () => {
		const cfg = kitConfigSchema.parse({ slug: "acme", name: "Acme", source: { url: "https://acme.example" }, target: { productionUrl: "https://acme.example" } });
		expect(cfg.business).toEqual({ footer: true });
		expect(kitConfigSchema.parse({ slug: "acme", name: "Acme", source: { url: "https://acme.example" }, target: { productionUrl: "https://acme.example" }, business: { footer: false } }).business.footer).toBe(false);
	});
	it("shows the block when the footer has neither the street address nor the phone", () => {
		expect(businessFooter(true, acme, JSON.stringify([{ type: "rich_text", html: "<p>© 2026 Acme Studio</p>" }]))).toEqual({ show: true });
	});
	it("leaves it out when the footer already shows the street (abbreviations and line breaks allowed)", () => {
		expect(footerShowsContact(acme, JSON.stringify([{ html: "<p>1 Main Street<br>\nSpringfield</p>" }]))).toBe(true);
		expect(footerShowsContact(acme, JSON.stringify({ text: "Visit us at 1\nMain St" }))).toBe(true);
		expect(businessFooter(true, acme, "<p>1 Main St, Springfield</p>")).toEqual({ show: false, why: "footer-has-it" });
	});
	it("leaves it out when the footer already shows the phone, in any format or as a tel: link", () => {
		expect(footerShowsContact(acme, '<a href="tel:+15550100100">Call</a>')).toBe(true);
		expect(footerShowsContact(acme, "Call 555-010-0100 today")).toBe(true);
		expect(footerShowsContact(acme, "Call 555-010-0199 today")).toBe(false);
		expect(footerShowsContact(acme, "© 2026 · 11 Main St")).toBe(false);
	});
	it("off, or nothing to show: no block", () => {
		expect(businessFooter(false, acme, "")).toEqual({ show: false, why: "off" });
		expect(businessFooter(true, { type: "Organization", name: "Acme" }, "")).toEqual({ show: false, why: "no-contact" });
		expect(businessFooter(true, undefined, "")).toEqual({ show: false, why: "no-contact" });
	});
});

describe("owner corrections (overrides.ts business)", () => {
	it("merges address fields, replaces the others, removes empty ones", () => {
		const o = overridesSchema.parse({ business: { telephone: "+1 555 010 0199", address: { streetAddress: "2 Oak Ave" }, hasMap: "", reason: "moved in 2026" } }).business;
		expect(applyBusinessOverride({ ...acme, hasMap: "https://maps.example/old" }, o, "Acme")).toEqual({ ...acme, telephone: "+1 555 010 0199", address: { ...acme.address, streetAddress: "2 Oak Ave" } });
	});
	it("starts a business when the live site published none", () => {
		const o = overridesSchema.parse({ business: { telephone: "555 0100", reason: "owner asked" } }).business;
		expect(applyBusinessOverride(undefined, o, "Acme Studio")).toEqual({ type: "LocalBusiness", name: "Acme Studio", telephone: "555 0100" });
		expect(applyBusinessOverride(acme, undefined, "Acme")).toBe(acme);
	});
	it("requires the owner's reason", () => {
		expect(overridesSchema.safeParse({ business: { telephone: "555" } }).success).toBe(false);
	});
});

describe("footer contact block rendering contract", () => {
	const c = starter("components/BusinessInfo.astro");
	it("is in the footer, before the credit, and reads the same business as the JSON-LD", () => {
		const base = starter("layouts/Base.astro");
		const footer = base.slice(base.indexOf('<footer class="site-footer">'), base.indexOf("</footer>"));
		expect(footer).toContain("<BusinessInfo />}");
		expect(footer.indexOf("<BusinessInfo />")).toBeLessThan(footer.indexOf("siteCredit &&"));
		expect(c).toContain("sc.businessFooter ? sc.structuredData?.business : undefined");
		expect(starter("components/StructuredData.astro")).toContain("structuredData?: { business?: Business");
	});
	it("uses <address>, a tel: link with the phone as written, a mailto only for an email, and an external map link", () => {
		expect(c).toContain('<address class="business-info__nap">');
		expect(c).toContain("{tel && <a href={tel} class=\"business-info__phone\">{b.telephone}</a>}");
		expect(c).toContain("{email && <a href={`mailto:${email}`}");
		expect(c).toContain('<a href={map} target="_blank" rel="noopener"');
		expect(c).toContain("const show = hasContact(b);");
	});
	it("is styled in the footer's own colours", () => {
		expect(starter("styles/base.css")).toMatch(/\.business-info a \{ color: inherit;/);
	});
});

describe("admin switch (SEO & Analytics → Site checks)", () => {
	it("stores and reads the switch; a missing or broken row keeps the block on", async () => {
		const { BUSINESS_OPTION, businessFooterBlocks, parseBusiness, readBusinessFooter } = await import("../packages/seo/src/business.js");
		const db = (value: string | null, fail = false) => ({
			prepare: (q: string) => ({ bind: (n: string) => ({ first: async <T,>() => { if (fail) throw new Error("x"); expect(q).toContain("FROM options"); expect(n).toBe(BUSINESS_OPTION); return (value === null ? null : { value }) as T; } }) }),
		});
		expect(await readBusinessFooter(undefined)).toBe(true);
		expect(await readBusinessFooter(db(null))).toBe(true);
		expect(await readBusinessFooter(db("{bad", false))).toBe(true);
		expect(await readBusinessFooter(db(null, true))).toBe(true);
		expect(await readBusinessFooter(db(JSON.stringify({ footer: false })))).toBe(false);
		expect(await readBusinessFooter(db(JSON.stringify({ footer: true })))).toBe(true);
		expect(parseBusiness({ footer: "no" })).toBeUndefined();
		const admin = JSON.stringify(businessFooterBlocks({ on: false, admin: true }));
		expect(admin).toContain('"action_id":"biz-footer"');
		expect(admin).toContain('"initial_value":false');
		expect(JSON.stringify(businessFooterBlocks({ on: true, admin: false }))).toContain("Only administrators");
	});
	it("the layout renders the block only when the chrome says so, and the SEO admin handles the save", () => {
		expect(starter("layouts/Base.astro")).toContain("{chrome.businessFooter && <BusinessInfo />}");
		const chrome = starter("utils/chrome.ts");
		expect(chrome).toContain("businessFooterOn ? readBusinessFooter(");
		const plugin = readFileSync(join(import.meta.dirname, "..", "packages/seo/src/plugin/index.ts"), "utf8");
		expect(plugin).toContain('i.action_id === "biz-footer"');
		expect(plugin).toContain("ADMIN_ROLE) bizToast");
		expect(plugin).toContain("purgePages((await workerBits()).cache)");
	});
});
