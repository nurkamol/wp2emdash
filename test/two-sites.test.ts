/**
 * Two sites, one domain: `init --from`, `compare`, `target.aliasDomains` (preflight, runbook, post-switch check).
 * All data synthetic; Cloudflare and HTTP are fetch stubs — nothing leaves the machine.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PageSnapshot } from "../src/audit/page.js";
import { checkAliases } from "../src/commands/check-aliases.js";
import { initSite } from "../src/commands/init.js";
import { compareCommand, compareSites, matchKey, readSitePages, similarity } from "../src/compare/sites.js";
import { loadConfig } from "../src/config/load.js";
import { kitConfigSchema } from "../src/config/schema.js";
import { aliasPreflight, aliasRunbook, checkAliasRedirects, isMailRecord, judgeRedirect, primaryHost, redirectRule } from "../src/cutover/aliases.js";
import { runbook } from "../src/phases/cutover.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "wp2e-two-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const answers = (slug: string, url: string) => ({ slug, name: `Studio ${slug}`, sourceUrl: url, productionUrl: url, sensitiveData: false });

describe("init --from", () => {
	it("copies config (rewritten), overrides and decisions; nothing else", async () => {
		initSite(answers("studio-a", "https://studio-a.test"), dir);
		const a = join(dir, "studio-a");
		// The first site has grown: project dir, staging URL, overrides, a decision, and client data that must stay put.
		const cfg = readFileSync(join(a, "kit.config.ts"), "utf8")
			.replace('slug: "studio-a",', 'slug: "studio-a",\n\tprojectDir: "~/Projects/StudioA/emdash",')
			.replace('productionUrl: "https://studio-a.test",', 'productionUrl: "https://studio-a.test",\n\t\tstagingUrl: "https://studio-a.example.workers.dev",')
			.replace("// maskSelectors", 'viewports: [{ name: "phone", width: 390, height: 844 }],\n\t\tmaskSelectors: [".slider"],\n\t\t// maskSelectors');
		writeFileSync(join(a, "kit.config.ts"), cfg);
		writeFileSync(join(a, "overrides.ts"), 'export default { routes: { "/old/": "/new/" }, elements: {}, integrations: {}, media: { external: {} }, redirects: { source: "none" }, approvedLegacy: [] };\n');
		writeFileSync(join(a, "decisions.md"), `${readFileSync(join(a, "decisions.md"), "utf8")}| 2026-11-01 | audit | Hide slider | decorative | owner |\n`);
		for (const d of ["raw", "snapshot/pages", "ir", "reports", "runs", "dump", "cutover"]) mkdirSync(join(a, d), { recursive: true });
		writeFileSync(join(a, ".env"), "CLOUDFLARE_GOLIVE_TOKEN=synthetic\n");
		writeFileSync(join(a, "cloudflare.json"), "{}\n");
		writeFileSync(join(a, "raw", "export.xml"), "<rss/>");
		writeFileSync(join(a, "snapshot", "pages", "home.json"), "{}");
		writeFileSync(join(a, "dump", "db.sql"), "--");

		const res = initSite({ ...answers("studio-b", "https://studio-b.test"), name: "Studio B" }, dir, "studio-a");
		const b = join(dir, "studio-b");
		const text = readFileSync(join(b, "kit.config.ts"), "utf8");
		expect(text).toMatch(/^\/\/ Started from sites\/studio-a\/kit\.config\.ts on \d{4}-\d{2}-\d{2}/);
		expect(text).toContain('slug: "studio-b"');
		expect(text).toContain('name: "Studio B"');
		expect(text).toContain('url: "https://studio-b.test"');
		expect(text).toContain('productionUrl: "https://studio-b.test"');
		expect(text).not.toMatch(/^\s*projectDir:/m);
		expect(text).not.toMatch(/^\s*stagingUrl:/m);
		expect(text).toContain('maskSelectors: [".slider"]');
		const loaded = await loadConfig(join(b, "kit.config.ts"));
		expect(loaded.slug).toBe("studio-b");
		expect(loaded.audit.viewports[0]?.name).toBe("phone"); // nested `name:` untouched
		expect(loaded.projectDir).toBeUndefined();
		expect(readFileSync(join(b, "overrides.ts"), "utf8")).toContain('"/old/": "/new/"');
		const decisions = readFileSync(join(b, "decisions.md"), "utf8");
		expect(decisions).toContain("# Decisions — Studio B");
		expect(decisions).toContain("Hide slider");
		expect(decisions).toMatch(/\| \d{4}-\d{2}-\d{2} \| init \| Started from studio-a/);
		for (const never of [".env", "cloudflare.json", "raw/export.xml", "snapshot/pages/home.json", "dump", "cutover", "ir/x", "reports/x", "runs/x"]) expect(existsSync(join(b, never)), never).toBe(false);
		expect(JSON.parse(readFileSync(join(b, "state.json"), "utf8")).slug).toBe("studio-b");
		expect(res.created.some((f) => f.endsWith("ACCESS.md"))).toBe(true);
	});

	it("refuses an unknown or identical source and creates nothing", () => {
		expect(() => initSite(answers("studio-c", "https://c.test"), dir, "nope")).toThrow(/No site "nope"/);
		expect(existsSync(join(dir, "studio-c"))).toBe(false);
		initSite(answers("studio-a", "https://a.test"), dir);
		expect(() => initSite(answers("studio-a2", "https://a2.test"), dir, "studio-a2")).toThrow(/another site/);
	});
});

// ── compare ─────────────────────────────────────────────────────────────────

function snap(url: string, o: { title?: string; h1?: string; text: string; forms?: PageSnapshot["forms"]; links?: PageSnapshot["links"] }): PageSnapshot {
	return {
		url,
		finalUrl: url,
		status: 200,
		redirects: [],
		contentType: "text/html",
		ms: 1,
		seo: { title: o.title ?? "Studio", description: "Yoga classes", canonical: url, og: {}, twitter: {}, jsonLdTypes: [], jsonLd: [], hreflang: [] },
		headings: [{ level: 1, text: o.h1 ?? "Welcome" }],
		text: o.text,
		textHash: "x",
		wordCount: o.text.split(" ").length,
		links: o.links ?? [],
		images: [],
		backgroundImages: [],
		forms: o.forms ?? [],
		iframes: [],
		scripts: [],
		stylesheets: [],
		bodyClasses: [],
		builders: [],
		shortcodeLeftovers: [],
		trackingIds: [],
	};
}

function writeSite(slug: string, pages: { name: string; snap: PageSnapshot; html: string }[]) {
	const root = join(dir, slug);
	mkdirSync(join(root, "snapshot", "pages"), { recursive: true });
	mkdirSync(join(root, "snapshot", "html"), { recursive: true });
	writeFileSync(join(root, "kit.config.ts"), "export default {};\n");
	for (const p of pages) {
		writeFileSync(join(root, "snapshot", "pages", `${p.name}.json`), JSON.stringify(p.snap));
		writeFileSync(join(root, "snapshot", "html", `${p.name}.html`), p.html);
	}
	writeFileSync(join(root, "snapshot", "urls.json"), JSON.stringify(pages.map((p) => ({ url: p.snap.url, path: new URL(p.snap.url).pathname, status: 200, kind: "page" }))));
}

const body = (s: string) => `<html><body><header class="site-header">Menu Home About</header><main><p>${s}</p></main><footer>Footer</footer></body></html>`;
const ABOUT = "Our studio opened in 2015. We teach small classes for every level. Book your first class today and bring a friend.";
const booking = (href: string) => ({ href, text: "Book", internal: false });

describe("compare", () => {
	it("normalises paths for matching", () => {
		expect(matchKey("https://a.test/About/")).toBe("/about");
		expect(matchKey("https://www.b.test/about")).toBe("/about");
		expect(matchKey("https://a.test/")).toBe("/");
		expect(matchKey("https://a.test/?page_id=2&b=1")).toBe("/?b=1&page_id=2");
		expect(similarity(["a", "b"], ["a", "b"])).toBe(1);
		expect(similarity(["a", "b"], ["a", "c"])).toBeCloseTo(1 / 3);
	});

	it("reports pages on one side, similarity, sentences, meta, forms and booking links", () => {
		const form = (provider: string, types: string[]) => ({ id: `${provider}:1`, provider, providerFormId: "1", fields: types.map((t, i) => ({ name: `f${i}`, type: t, required: false })), hasCaptcha: [], inPopup: false });
		writeSite("site-a", [
			{ name: "home", snap: snap("https://a.test/", { text: "Welcome" }), html: body("Welcome to the studio, a calm place for yoga in the city.") },
			{ name: "about", snap: snap("https://a.test/about/", { text: ABOUT, links: [booking("https://studio.marianaiframes.com/schedule"), { href: "https://b.test/contact/", text: "c", internal: false }] }), html: body(ABOUT) },
			{ name: "contact", snap: snap("https://a.test/contact/", { text: "Contact", forms: [form("fluent-forms", ["text", "email", "textarea"])] }), html: body("Write to us and we answer within a day.") },
			{ name: "retreats", snap: snap("https://a.test/retreats/", { title: "Retreats", text: "Retreats" }), html: body("Retreats in the mountains every summer.") },
		]);
		writeSite("site-b", [
			{ name: "home", snap: snap("https://www.b.test/", { text: "Welcome" }), html: body("Welcome to the studio, a calm place for yoga in the city.") },
			{ name: "about", snap: snap("https://www.b.test/about", { text: ABOUT, h1: "About us", links: [booking("https://calendly.com/studio-b/intro"), { href: "https://a.test/contact/", text: "c", internal: false }] }), html: body(`${ABOUT} Prenatal yoga runs on Saturdays with a certified teacher.`) },
			{ name: "contact", snap: snap("https://www.b.test/contact/", { text: "Contact", forms: [form("fluent-forms", ["text", "email"])] }), html: body("Write to us and we answer within a day.") },
			{ name: "kids", snap: snap("https://www.b.test/kids/", { title: "Kids yoga", text: "Kids" }), html: body("Kids yoga after school.") },
		]);
		const r = compareCommand("site-a", "site-b", dir);
		const c = r.comparison;
		expect(c.a.host).toBe("a.test");
		expect(c.b.host).toBe("www.b.test");
		expect(c.onlyA.map((p) => p.path)).toEqual(["/retreats"]);
		expect(c.onlyB.map((p) => p.path)).toEqual(["/kids"]);
		expect(c.summary).toMatchObject({ matched: 3, identical: 1, onlyA: 1, onlyB: 1 });
		const home = c.pages.find((p) => p.path === "/");
		expect(home?.verdict).toBe("identical");
		const about = c.pages.find((p) => p.path === "/about");
		expect(about?.verdict).toBe("differs");
		expect(about?.similarity).toBeLessThan(0.98);
		expect(about?.sentencesOnlyB).toEqual(["Prenatal yoga runs on Saturdays with a certified teacher."]);
		expect(about?.wordsOnlyB).toContain("prenatal");
		expect(about?.meta.h1).toEqual({ a: "Welcome", b: "About us" });
		expect(about?.meta.canonical).toBeUndefined(); // each domain canonical to itself = same path
		// Links to either compared domain are internal; the booking providers differ.
		expect(about?.links.onlyA).toEqual([{ href: "https://studio.marianaiframes.com/schedule", kind: "booking" }]);
		expect(about?.links.onlyB).toEqual([{ href: "https://calendly.com/studio-b/intro", kind: "booking" }]);
		const contact = c.pages.find((p) => p.path === "/contact");
		expect(contact?.similarity).toBe(1);
		expect(contact?.verdict).toBe("minor");
		expect(contact?.forms.onlyA).toEqual(["fluent-forms#1 [text, email, textarea]"]);
		// Header/footer chrome is not page content.
		expect(readSitePages(join(dir, "site-a", "snapshot"))[0]?.text).not.toMatch(/Menu Home/);
		expect(existsSync(join(dir, "site-b", "reports", "compare", "site-a.md"))).toBe(true);
		const md = readFileSync(r.md, "utf8");
		expect(md).toContain("## Pages only on A");
		expect(md).toContain("`/retreats`");
		expect(md).toContain("Prenatal yoga runs on Saturdays");
		expect(JSON.parse(readFileSync(r.json, "utf8")).summary.matched).toBe(3);
	});

	it("needs both audit snapshots", () => {
		writeSite("site-a", [{ name: "home", snap: snap("https://a.test/", { text: "x" }), html: body("x") }]);
		mkdirSync(join(dir, "site-b"), { recursive: true });
		expect(() => compareCommand("site-a", "site-b", dir)).toThrow(/No audit snapshot for "site-b"/);
	});

	it("minor below 100% but at least 98%", () => {
		const words = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
		const page = (u: string, t: string) => ({ path: matchKey(u), snap: snap(u, { text: t }), text: t });
		const c = compareSites("a", [page("https://a.test/x", words)], "b", [page("https://b.test/x", `${words} extra`)], "a.test", "b.test");
		expect(c.pages[0]?.verdict).toBe("minor");
	});
});

// ── alias domains ───────────────────────────────────────────────────────────

describe("aliasDomains schema", () => {
	const base = { slug: "s", name: "S", source: { url: "https://primary.test" }, target: { productionUrl: "https://primary.test" } };
	it("normalises to apex hostnames, defaults to none", () => {
		expect(kitConfigSchema.parse(base).target.aliasDomains).toEqual([]);
		expect(kitConfigSchema.parse({ ...base, target: { ...base.target, aliasDomains: ["www.Alias.test", "https://other.test/"] } }).target.aliasDomains).toEqual(["alias.test", "other.test"]);
		expect(kitConfigSchema.safeParse({ ...base, target: { ...base.target, aliasDomains: ["not a host"] } }).success).toBe(false);
	});
});

type Route = (url: string, init?: RequestInit) => { status?: number; body?: unknown; headers?: Record<string, string> } | undefined;
function stubFetch(route: Route) {
	const calls: { url: string; method: string }[] = [];
	const f = async (url: string, init?: RequestInit) => {
		calls.push({ url, method: init?.method ?? "GET" });
		const r = route(url, init);
		if (!r) return new Response(JSON.stringify({ success: false, errors: [{ message: "not found" }] }), { status: 404 });
		return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers ?? {} });
	};
	return { f, calls };
}

const ZONE_RECORDS = [
	{ id: "1", type: "A", name: "alias.test", content: "203.0.113.10", proxied: true, ttl: 1 },
	{ id: "2", type: "CNAME", name: "www.alias.test", content: "alias.test", proxied: false, ttl: 1 },
	{ id: "3", type: "MX", name: "alias.test", content: "alias-test.mail.protection.outlook.com", priority: 0, ttl: 3600 },
	{ id: "4", type: "TXT", name: "alias.test", content: "v=spf1 include:spf.protection.outlook.com -all", ttl: 3600 },
	{ id: "5", type: "CNAME", name: "selector1._domainkey.alias.test", content: "selector1-alias-test._domainkey.tenant.onmicrosoft.com", ttl: 3600 },
	{ id: "6", type: "TXT", name: "_dmarc.alias.test", content: "v=DMARC1; p=quarantine", ttl: 3600 },
	{ id: "7", type: "CNAME", name: "autodiscover.alias.test", content: "autodiscover.outlook.com", ttl: 3600 },
	{ id: "8", type: "TXT", name: "alias.test", content: "google-site-verification=abc", ttl: 3600 },
];

describe("alias preflight (mocked Cloudflare API)", () => {
	it("reads the zone, snapshots DNS with mail flagged, flags grey-cloud www, lists redirect rules — GET only", async () => {
		const { f, calls } = stubFetch((url) => {
			if (url.includes("/zones?name=alias.test")) return { body: { success: true, result: [{ id: "zA", status: "active", name: "alias.test" }] } };
			if (url.endsWith("/zones/zA/dns_records?per_page=500")) return { body: { success: true, result: ZONE_RECORDS } };
			if (url.endsWith("/zones/zA/rulesets/phases/http_request_dynamic_redirect/entrypoint")) return { body: { success: true, result: { id: "rs1", rules: [{ id: "r0", description: "old promo", expression: 'http.request.uri.path eq "/promo"', enabled: true }] } } };
			return undefined;
		});
		const out = join(dir, "cutover");
		const { checks, plan } = await aliasPreflight("alias.test", { token: "t", primary: "primary.test", outDir: out, fetch: f });
		expect(calls.every((c) => c.method === "GET")).toBe(true);
		const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
		expect(byId["alias-zone:alias.test"]?.ok).toBe(true);
		expect(byId["alias-dns-proxied:alias.test"]?.ok).toBe(false);
		expect(byId["alias-dns-proxied:alias.test"]?.detail).toContain("www.alias.test CNAME");
		expect(byId["alias-dns-snapshot:alias.test"]?.detail).toMatch(/5 mail-related \(MX, SPF, DKIM, DMARC, autodiscover\)/);
		expect(byId["alias-redirect-rules:alias.test"]?.detail).toContain("old promo");
		expect(plan).toMatchObject({ zoneId: "zA", rulesetId: "rs1", rulesetKnown: true, unproxied: ["www.alias.test CNAME"], missingWeb: [], mailRecords: 5 });
		const snapFile = JSON.parse(readFileSync(join(out, "dns-before.alias.test.json"), "utf8"));
		expect(snapFile.records.filter((r: { mail?: boolean }) => r.mail)).toHaveLength(5);
		expect(snapFile.records.find((r: { content: string }) => r.content.startsWith("google-site"))?.mail).toBeUndefined();
	});

	it("missing zone / missing records / no redirect ruleset yet", async () => {
		const none = stubFetch((url) => (url.includes("/zones?name=") ? { body: { success: true, result: [] } } : undefined));
		const r1 = await aliasPreflight("gone.test", { token: "t", primary: "primary.test", outDir: dir, fetch: none.f });
		expect(r1.checks).toHaveLength(1);
		expect(r1.checks[0]?.ok).toBe(false);
		expect(r1.checks[0]?.detail).toMatch(/Zone Resources/);

		const bare = stubFetch((url) => {
			if (url.includes("/zones?name=")) return { body: { success: true, result: [{ id: "zB", status: "active", name: "alias.test" }] } };
			if (url.includes("/dns_records")) return { body: { success: true, result: ZONE_RECORDS.filter((r) => r.type === "MX") } };
			return undefined; // entry point: 404 = no redirect rules yet
		});
		const r2 = await aliasPreflight("alias.test", { token: "t", primary: "primary.test", outDir: dir, fetch: bare.f });
		expect(r2.plan.missingWeb).toEqual(["alias.test", "www.alias.test"]);
		expect(r2.plan.rulesetKnown).toBe(true);
		expect(r2.plan.rulesetId).toBeUndefined();
		expect(r2.checks.find((c) => c.id.startsWith("alias-redirect-rules"))?.detail).toBe("none yet");
	});

	it("refuses the primary domain as its own alias", async () => {
		const { f, calls } = stubFetch(() => undefined);
		const r = await aliasPreflight("primary.test", { token: "t", primary: "www.primary.test", outDir: dir, fetch: f });
		expect(r.checks[0]?.ok).toBe(false);
		expect(calls).toHaveLength(0);
	});

	it("flags mail and Microsoft 365 records", () => {
		expect(isMailRecord({ type: "CNAME", name: "lyncdiscover.alias.test", content: "webdir.online.lync.com" }, "alias.test")).toBe(true);
		expect(isMailRecord({ type: "A", name: "www.alias.test", content: "203.0.113.1" }, "alias.test")).toBe(false);
	});
});

describe("alias runbook", () => {
	const plan = { alias: "alias.test", zoneId: "zA", rulesetId: "rs1", rulesetKnown: true, existingRules: [], missingWeb: [], unproxied: [], mailRecords: 5 };
	it("one Single Redirect rule: apex + www, same path on the primary, query kept, 301", () => {
		const rule = redirectRule("alias.test", "primary.test");
		expect(rule.expression).toBe('(http.host in {"alias.test" "www.alias.test"})');
		expect(rule.action).toBe("redirect");
		expect(rule.action_parameters).toEqual({ from_value: { status_code: 301, target_url: { expression: 'concat("https://primary.test", http.request.uri.path)' }, preserve_query_string: true } });
	});
	it("adds to the existing ruleset, verifies with curl, rolls back by rule id, never touches DNS", () => {
		const md = aliasRunbook([plan], "primary.test");
		expect(md).toContain("ALIAS_ZONE=zA");
		expect(md).toContain("RULESET=rs1");
		expect(md).toContain("/zones/$ALIAS_ZONE/rulesets/$RULESET/rules");
		expect(md).not.toContain("-X PUT");
		expect(md).toContain(String.raw`"target_url":{"expression":"concat(\"https://primary.test\", http.request.uri.path)"}`);
		expect(md).toContain(String.raw`"expression":"(http.host in {\"alias.test\" \"www.alias.test\"})"`);
		expect(md).toContain('"preserve_query_string":true');
		expect(md).toContain('"status_code":301');
		expect(md).toContain('-w "%{http_code} %{redirect_url}\\n"');
		expect(md).toContain("-X DELETE \"https://api.cloudflare.com/client/v4/zones/$ALIAS_ZONE/rulesets/$RULESET/rules/$RULE_ID\"");
		expect(md).toContain("Change of address");
		expect(md).toContain("https://primary.test/sitemap.xml");
		expect(md).toContain("Google Business Profile");
		expect(md).toMatch(/registered with auto-renew/);
		expect(md).not.toMatch(/dns_records/);
		expect(md).not.toMatch(/workers\/routes/);
	});
	it("creates the entry point when none exists, and explains a proxied placeholder without doing it", () => {
		const md = aliasRunbook([{ ...plan, rulesetId: undefined, missingWeb: ["www.alias.test"] }], "primary.test");
		expect(md).toContain("-X PUT \"https://api.cloudflare.com/client/v4/zones/$ALIAS_ZONE/rulesets/phases/http_request_dynamic_redirect/entrypoint\"");
		expect(md).toContain("192.0.2.1");
		expect(md).toMatch(/kit never adds it/);
		expect(md).not.toMatch(/dns_records/);
	});
	it("is part of the cutover runbook when aliases are configured", () => {
		const md = runbook({ domain: "primary.test", worker: "w", zoneId: "z", apexFirst: true, aliases: [plan], primary: "primary.test" });
		expect(md).toContain("## 4. Alias domains → primary.test");
		expect(md).not.toMatch(/dns_records/);
		expect(runbook({ domain: "primary.test", worker: "w", apexFirst: true })).not.toContain("Alias domains");
	});
	it("redirects to the canonical host", () => {
		expect(primaryHost("https://primary.test", "www")).toBe("www.primary.test");
		expect(primaryHost("https://www.primary.test/", "apex")).toBe("primary.test");
	});
});

describe("alias redirect check (mocked HTTP)", () => {
	it("passes only a 301 to the same path on the primary", () => {
		expect(judgeRedirect("https://alias.test/about/?a=1", 301, "https://primary.test/about/?a=1", "primary.test", ["alias.test"]).ok).toBe(true);
		expect(judgeRedirect("https://alias.test/about/", 302, "https://primary.test/about/", "primary.test", ["alias.test"]).problem).toMatch(/not permanent/);
		expect(judgeRedirect("https://alias.test/about/", 200, undefined, "primary.test", ["alias.test"]).problem).toMatch(/serves content/);
		expect(judgeRedirect("https://alias.test/about/", 404, undefined, "primary.test", ["alias.test"]).problem).toMatch(/404/);
		expect(judgeRedirect("https://www.alias.test/about/", 301, "https://alias.test/about/", "primary.test", ["alias.test"]).problem).toMatch(/chain/);
		expect(judgeRedirect("https://alias.test/about/", 301, "https://primary.test/", "primary.test", ["alias.test"]).problem).toMatch(/another path/);
	});

	it("checks every audited path on apex and www without following redirects, and writes a report", async () => {
		const root = join(dir, "primary");
		mkdirSync(join(root, "snapshot"), { recursive: true });
		writeFileSync(join(root, "kit.config.ts"), `export default { slug: "primary", name: "P", source: { url: "https://primary.test" }, target: { productionUrl: "https://primary.test", aliasDomains: ["alias.test"] } };\n`);
		writeFileSync(join(root, "snapshot", "urls.json"), JSON.stringify([{ path: "/", status: 200, kind: "page" }, { path: "/about/", status: 200, kind: "page" }, { path: "/old", status: 301, kind: "redirect" }]));
		mkdirSync(join(dir, "alias-site", "snapshot"), { recursive: true });
		writeFileSync(join(dir, "alias-site", "snapshot", "urls.json"), JSON.stringify([{ path: "/kids/", status: 200, kind: "page" }]));
		const seen: RequestInit[] = [];
		const { f, calls } = stubFetch((url, init) => {
			seen.push(init ?? {});
			const u = new URL(url);
			if (u.hostname === "www.alias.test" && u.pathname === "/kids/") return { status: 200 };
			return { status: 301, headers: { location: `https://primary.test${u.pathname}${u.search}` } };
		});
		const r = await checkAliases("primary", { sitesDir: dir, pathsFrom: ["alias-site"], fetch: f });
		expect(calls.map((c) => c.url).sort()).toEqual(["https://alias.test/", "https://alias.test/about/", "https://alias.test/kids/", "https://www.alias.test/", "https://www.alias.test/about/", "https://www.alias.test/kids/"]);
		expect(seen.every((i) => i.redirect === "manual")).toBe(true);
		expect(r.result.ok).toBe(false);
		expect(r.result.failures.map((x) => x.url)).toEqual(["https://www.alias.test/kids/"]);
		expect(r.result.byHost["alias.test"]).toEqual({ checked: 3, ok: 3 });
		expect(readFileSync(r.md, "utf8")).toContain("200: serves content");
	});

	it("an empty check is not a pass", async () => {
		const { f } = stubFetch(() => undefined);
		expect((await checkAliasRedirects({ aliases: ["alias.test"], primary: "primary.test", paths: [], fetch: f })).ok).toBe(false);
	});
});
