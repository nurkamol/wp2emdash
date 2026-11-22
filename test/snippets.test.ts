/**
 * Site-wide snippets (src/transform/snippets.ts): synthetic theme HTML (two saved pages) + a Header Footer Code
 * Manager export → classification golden (test/golden/snippets/site-snippets.json). Regenerate after an intended
 * change with UPDATE_GOLDEN=1 pnpm test and review the diff.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { classifySnippet, collectSnippets, completeProviderLoaders, providerLoaders, settleLoaders, snippetsReport } from "../src/transform/snippets.js";
import type { Section } from "../src/ir/schema.js";

const fx = join(import.meta.dirname, "fixtures", "snippets");
const goldenFile = join(import.meta.dirname, "golden", "snippets", "site-snippets.json");
const pages = ["home", "about"].map((name) => ({ name, html: readFileSync(join(fx, `${name}.html`), "utf8") }));
const codeManager = JSON.parse(readFileSync(join(fx, "hfcm.json"), "utf8"));
const run = (decisions: Record<string, "drop" | "rebuilt"> = {}) => settleLoaders(collectSnippets({ pages, codeManager, siteHosts: ["fixture-studio.test"], decisions }), new Set(["marianatek"]), decisions);

describe("site-wide snippets", () => {
	it("matches the golden classification", () => {
		const r = run();
		if (process.env.UPDATE_GOLDEN === "1" || !existsSync(goldenFile)) {
			mkdirSync(join(goldenFile, ".."), { recursive: true });
			writeFileSync(goldenFile, `${JSON.stringify(r, null, 2)}\n`);
		}
		expect(JSON.parse(JSON.stringify(r))).toEqual(JSON.parse(readFileSync(goldenFile, "utf8")));
	});

	it("carries trackers, verification, widgets and the Mariana loader; drops WordPress internals; asks about the unknown", () => {
		const r = run();
		const by = (re: RegExp) => r.items.filter((s) => re.test(s.label));
		expect(by(/G-FIXTURE01/)[0]).toMatchObject({ kind: "tracker", status: "carried" });
		expect(by(/GTM-FIXT001/)[0]).toMatchObject({ kind: "tracker", status: "carried" });
		expect(by(/google-site-verification/)[0]).toMatchObject({ kind: "verification", status: "carried", note: "carried → Settings → SEO" });
		expect(by(/msvalidate/)[0]).toMatchObject({ kind: "verification", where: ["code manager: Bing verification (header)"] });
		const widgets = [
			{ provider: "elfsight", id: "01234567-89ab-cdef-0123-456789abcdef" },
			{ provider: "cookieyes", id: "0123456789abcdef01234567" },
			{ provider: "crisp", id: "01234567-89ab-cdef-0123-456789abcdef" },
			{ provider: "tawkto", id: "0123456789abcdef01234567/1abcdefgh" },
		];
		expect(r.widgets).toHaveLength(widgets.length);
		expect(r.widgets).toEqual(expect.arrayContaining(widgets));
		expect(r.items.find((s) => s.provider === "marianatek")).toMatchObject({ kind: "provider-loader", status: "carried" });
		for (const re of [/jquery\.min\.js/, /wp-embed/, /themes\/fixture\/style\.css/, /_wpemojiSettings|emoji/, /email-decode/, /meta generator/, /library cdnjs/]) expect(by(re)[0], String(re)).toMatchObject({ kind: "wordpress", status: "not-needed" });
		// Never carried automatically: unknown inline/external code, a child-theme script, legacy iubenda config, markup, unknown meta.
		const decide = r.items.filter((s) => s.status === "decision").map((s) => s.label);
		expect(decide.some((l) => l.includes("cdn.fixture-unknown-vendor.test"))).toBe(true);
		expect(decide.some((l) => l.includes("fixtureCounter"))).toBe(true);
		expect(decide.some((l) => l.includes("fixture-child"))).toBe(true);
		expect(decide.some((l) => l.startsWith("iubenda"))).toBe(true);
		expect(decide.some((l) => l.includes("promo-ribbon"))).toBe(true);
		expect(decide.some((l) => l.includes("fixture-custom-flag"))).toBe(true);
		// Page content (the embed in <main>) and switched-off code-manager snippets are not site-wide snippets.
		expect(r.items.some((s) => /iframe_api|old-pixel/.test(s.label + s.sample))).toBe(false);
		// Deduplicated across pages.
		expect(by(/G-FIXTURE01.*gtag\/js/).length).toBe(1);
		expect(by(/G-FIXTURE01.*gtag\/js/)[0]?.pages).toEqual(["home", "about"]);
	});

	it("applies overrides.ts decisions", () => {
		const first = run();
		const ids = first.items.filter((s) => s.status === "decision").map((s) => s.id);
		const decided = run(Object.fromEntries(ids.map((id, i) => [id, i % 2 ? "rebuilt" : "drop"])));
		expect(decided.counts.decision).toBe(0);
		expect(decided.items.filter((s) => ids.includes(s.id)).every((s) => /overrides\.ts snippets/.test(s.note))).toBe(true);
	});

	it("a provider loaded site-wide that no page embeds needs a decision", () => {
		const r = settleLoaders(collectSnippets({ pages, siteHosts: ["fixture-studio.test"] }), new Set());
		expect(r.items.find((s) => s.provider === "marianatek")?.status).toBe("decision");
	});

	it("adds a site-wide loader to embed sections without one", () => {
		const html = `<html><head></head><body><main></main><script src="https://widgets.mindbodyonline.com/javascripts/healcode.js"></script></body></html>`;
		const loaders = providerLoaders(collectSnippets({ pages: [{ name: "x", html }], siteHosts: ["fixture-studio.test"] }));
		const sections = [{ type: "embed", fields: { provider: "mindbody", html: '<healcode-widget data-type="schedules"></healcode-widget>' } }, { type: "embed", fields: { provider: "mindbody", html: '<script src="https://widgets.mindbodyonline.com/javascripts/healcode.js"></script><healcode-widget></healcode-widget>' } }] as unknown as Section[];
		expect(completeProviderLoaders(sections, loaders)).toEqual(["mindbody"]);
		expect((sections[0] as { fields: { html: string } }).fields.html).toContain('<script src="https://widgets.mindbodyonline.com/javascripts/healcode.js"></script>');
		expect((sections[1] as { fields: { html: string } }).fields.html.match(/<script/g)?.length).toBe(1);
	});

	it("reports decisions with a ready overrides.ts block", () => {
		const md = snippetsReport(run()).join("\n");
		expect(md).toContain("## Site-wide snippets");
		expect(md).toContain("### Needs a decision");
		expect(md).toMatch(/"sn-[0-9a-f]{8}": "drop"/);
	});

	it("a widget whose snippet has no readable ID is a decision, not carried", () => {
		const v = classifySnippet({ tag: "script", attrs: {}, body: "", html: '<script src="https://elfsightcdn.com/platform.js"></script>', url: new URL("https://elfsightcdn.com/platform.js") }, new Set(["fixture-studio.test"]));
		expect(v).toMatchObject({ kind: "widget", provider: "elfsight" });
		expect(v.widget).toBeUndefined();
	});
});

describe("WooCommerce and Elementor housekeeping code is not needed (WordPress e2e test)", () => {
	const hosts = new Set(["example.test"]);
	const v = (r: { attrs?: Record<string, string>; body: string }) => classifySnippet({ tag: "script", attrs: r.attrs ?? {}, body: r.body, html: "" }, hosts).kind;
	it("classifies variation templates, the no-JS swap and the lazy-load observer as WordPress code", () => {
		expect(v({ attrs: { type: "text/template", id: "tmpl-variation-template" }, body: "<div>{{{ data.variation.price_html }}}</div>" })).toBe("wordpress");
		expect(v({ attrs: { type: "text/template", id: "tmpl-unavailable-variation-template" }, body: "<p>Sorry</p>" })).toBe("wordpress");
		expect(v({ attrs: { id: "wc-no-js" }, body: "(function () { var c = document.body.className; c = c.replace(/woocommerce-no-js/, 'woocommerce-js'); document.body.className = c; })();" })).toBe("wordpress");
		expect(v({ body: "( () => { const lazyloadRunObserver = () => { const lazyloadBackgrounds = document.querySelectorAll( `.e-con.e-parent:not(.e-lazyloaded)` ); } } )();" })).toBe("wordpress");
		expect(v({ body: "window.myCustomWidget({ id: 42 });" })).toBe("unknown");
	});
});
