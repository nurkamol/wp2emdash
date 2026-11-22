import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initSite } from "../src/commands/init.js";
import { assertStagingScript, defaultRunScript, latestUpgradeDir, productionDeployCommand, upgrade, upgradeAddresses } from "../src/commands/upgrade.js";
import { sitePaths } from "../src/core/paths.js";
import { newState, writeState } from "../src/core/state.js";
import { upgradeVerifyTool } from "../src/mcp/tools.js";
import { compareSnapshots, fontFamiliesFromCss, htmlToSnapshot, normalizeAsset, normalizeText, type SiteSnapshot, sitemapLocs } from "../src/upgrade/snapshot.js";

// Synthetic pages only (no client content).
interface PageOpts {
	title?: string;
	h1?: string;
	body?: string;
	year?: number;
	cssHash?: string;
	jsQuery?: string;
	links?: number;
	lang?: string;
	nonce?: string;
}
function page(o: PageOpts = {}): string {
	const links = Array.from({ length: o.links ?? 2 }, (_, i) => `<a href="/l${i}/">Link ${i}</a>`).join(" ");
	return `<!doctype html><html lang="${o.lang ?? "en"}"><head><title>${o.title ?? "Home - Acme"}</title><meta name="description" content="Acme does things.">
<link rel="stylesheet" href="/_astro/Layout.${o.cssHash ?? "DkPz3Q1a"}.css"><link rel="alternate" hreflang="en" href="/"><link rel="alternate" hreflang="fr" href="/fr/">
<script type="module" src="/_astro/page.js${o.jsQuery ?? "?v=1"}"></script><script nonce="${o.nonce ?? "abc123"}">window.x=1</script>
<style>@font-face{font-family:"Body Sans";src:url(/f/a.woff2)}</style></head>
<body><header>${links}</header><main><h1>${o.h1 ?? "Welcome"}</h1><p>${o.body ?? "We build sturdy things for people."}</p><img src="/a.webp" alt=""><form><input name="n"></form></main>
<footer>© ${o.year ?? 2025} Acme · Built with wp2emdash 1.4.0</footer></body></html>`;
}

describe("page snapshot (HTML → structure)", () => {
	it("extracts title, description, h1, lang, hreflang, text, counts, assets and fonts", () => {
		const s = htmlToSnapshot(page(), "https://acme.example/about/?x=1");
		expect(s.path).toBe("/about/?x=1");
		expect(s).toMatchObject({ status: 200, title: "Home - Acme", description: "Acme does things.", h1: ["Welcome"], lang: "en", hreflang: 2, links: 2, images: 1, forms: 1 });
		expect(s.stylesheets).toEqual(["/_astro/Layout.HASH.css"]);
		expect(s.scripts).toEqual(["/_astro/page.js"]);
		expect(s.fonts).toEqual(["body sans"]);
		expect(s.text).toContain("We build sturdy things for people.");
		expect(s.text).toContain("© YEAR Acme");
		expect(s.text).toContain("wp2emdash VERSION");
		expect(s.text).not.toContain("window.x");
		expect(s.text).not.toContain("font-family");
		expect(s.words).toBeGreaterThan(5);
		expect(s.textHash).toMatch(/^[0-9a-f]{16}$/);
	});

	it("separates words across block elements and reads linked CSS and Google Fonts", () => {
		const s = htmlToSnapshot(`<html><head><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&amp;family=Lora+Serif&display=swap"></head><body><p>One</p><p>Two</p></body></html>`, "https://a.example/", 200, ["@font-face{font-family:'Show Serif';src:url(x)}"]);
		expect(s.text).toBe("One Two");
		expect(s.fonts).toEqual(["inter", "lora serif", "show serif"]);
		expect(s.stylesheets).toEqual(["fonts.googleapis.com/css2"]);
	});

	it("normalises rebuild noise", () => {
		expect(normalizeAsset("/_astro/index.B1x2_y3Z.css?v=2", "https://a.example/")).toBe("/_astro/index.HASH.css");
		expect(normalizeAsset("/js/chunk-4f9a1b2c.js", "https://a.example/")).toBe("/js/chunk.HASH.js");
		expect(normalizeAsset("/css/site.min.css?ver=6.4", "https://a.example/")).toBe("/css/site.min.css");
		expect(normalizeAsset("https://cdn.example/x.js", "https://a.example/")).toBe("cdn.example/x.js");
		expect(normalizeText("Copyright 2019–2025 Acme  ")).toBe("Copyright YEAR Acme");
		expect(fontFamiliesFromCss("@font-face{font-family: Body;src:x}@font-face{font-family:'Body'}")).toEqual(["body"]);
		expect(sitemapLocs("<urlset><url><loc> https://a.example/?a=1&amp;b=2 </loc></url><url><loc><![CDATA[https://a.example/b/]]></loc></url></urlset>")).toEqual(["https://a.example/?a=1&b=2", "https://a.example/b/"]);
	});
});

const site = (label: string, pages: [string, string, number?][], origin = "https://acme.example"): SiteSnapshot => ({ origin, label, takenAt: "2026-11-22T00:00:00Z", pages: pages.map(([p, html, status]) => htmlToSnapshot(html, origin + p, status ?? 200)), sitemap: { status: 200, urls: pages.length } });

describe("compareSnapshots", () => {
	it("identical pages compare identical", () => {
		const a = site("before", [["/", page()], ["/about/", page({ title: "About" })]]);
		const c = compareSnapshots(a, site("after", [["/", page()], ["/about/", page({ title: "About" })]], "https://acme-staging.workers.dev"));
		expect(c.identical).toBe(true);
		expect(c.pagesWithDifferences).toBe(0);
		expect(c.pagesWithNotices).toBe(0);
	});

	it("ignores expected noise: asset hashes, cache-busting, copyright year, kit version, nonces", () => {
		const a = site("before", [["/", page()]]);
		const b = site("after", [["/", page({ cssHash: "Zq9Xw2Lm", jsQuery: "?v=2", year: 2026, nonce: "zzz999" }).replace("wp2emdash 1.4.0", "wp2emdash 1.5.0")]]);
		const c = compareSnapshots(a, b);
		expect(c.identical).toBe(true);
		expect(c.pages[0]?.notices).toEqual([]);
	});

	it("reports changed text, title, h1, lang and link counts with an excerpt", () => {
		const a = site("before", [["/", page()]]);
		const b = site("after", [["/", page({ body: "We build flimsy things for people.", title: "Home", h1: "Hello", lang: "fr", links: 3 })]]);
		const c = compareSnapshots(a, b);
		expect(c.identical).toBe(false);
		const fields = c.pages[0]?.differences.map((d) => d.field);
		expect(fields).toEqual(["title", "h1", "lang", "text", "links"]);
		expect(c.pages[0]?.differences.find((d) => d.field === "text")?.detail).toMatch(/sturdy.*flimsy/);
	});

	it("a page missing or answering differently is a difference; a new page is a notice", () => {
		const a = site("before", [["/", page()], ["/gone/", page()], ["/moved/", page()]]);
		const b = site("after", [["/", page()], ["/moved/", "", 404], ["/new/", page()]]);
		const c = compareSnapshots(a, b);
		expect(c.pagesWithDifferences).toBe(2);
		expect(c.pages.find((p) => p.path === "/gone/")?.differences[0]?.field).toBe("missing");
		expect(c.pages.find((p) => p.path === "/moved/")?.differences[0]).toMatchObject({ field: "status", before: 200, after: 404 });
		expect(c.pages.find((p) => p.path === "/new/")?.notices[0]?.field).toBe("new");
	});

	it("a renamed bundle is a notice; a lost font or all stylesheets gone is a difference", () => {
		const a = site("before", [["/", page()]]);
		const renamed = compareSnapshots(a, site("after", [["/", page().replace("Layout.", "Base.")]]));
		expect(renamed.identical).toBe(true);
		expect(renamed.pages[0]?.notices[0]?.field).toBe("stylesheets");
		const lost = compareSnapshots(a, site("after", [["/", page().replace(/<style>.*?<\/style>/, "").replace(/<link rel="stylesheet"[^>]*>/, "")]]));
		expect(lost.pages[0]?.differences.map((d) => d.field)).toEqual(["stylesheets", "fonts"]);
	});
});

// ── command flow: local servers stand in for production and staging; scaffold and the staging deploy are fakes ──

interface FakeSite {
	pages: Record<string, string>;
	status: Record<string, number>;
	hits: string[];
}
const servers: Server[] = [];
async function serve(s: FakeSite): Promise<string> {
	const server = createServer((req, res) => {
		const u = req.url ?? "/";
		s.hits.push(u);
		const host = `http://${req.headers.host}`;
		if (u === "/sitemap.xml") return res.writeHead(200, { "content-type": "application/xml" }).end(`<sitemapindex><sitemap><loc>${host}/sitemap-0.xml</loc></sitemap></sitemapindex>`);
		// Sitemaps list the production domain (as they do on staging): rebased onto the address being checked.
		if (u === "/sitemap-0.xml") return res.writeHead(200, { "content-type": "application/xml" }).end(`<urlset>${Object.keys(s.pages).map((p) => `<url><loc>https://acme.example${p}</loc></url>`).join("")}</urlset>`);
		if (u.endsWith(".css")) return res.writeHead(200, { "content-type": "text/css" }).end("@font-face{font-family:'Show Serif';src:url(/b.woff2)}");
		const html = s.pages[u];
		if (html === undefined) return res.writeHead(404, { "content-type": "text/html" }).end("<title>Not found</title>");
		res.writeHead(s.status[u] ?? 200, { "content-type": "text/html; charset=utf-8" }).end(html);
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	servers.push(server);
	return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("wp2emdash upgrade", () => {
	let dir: string;
	let sites: string;
	const slug = "acme";
	let prod: FakeSite;
	let stg: FakeSite;
	let prodUrl: string;
	let stgUrl: string;
	const scaffoldRuns: string[] = [];
	const scripts: { script: string; cwd: string; env: Record<string, string> }[] = [];
	let t = 0;
	const now = () => new Date(Date.UTC(2026, 10, 22, 10, 0, t++));
	const okScaffold = async (s: string) => {
		scaffoldRuns.push(s);
		return { ok: true, runId: "run-1", checks: [{ id: "build", label: "Build", ok: true }] };
	};

	beforeEach(async () => {
		dir = mkdtempSync(join(tmpdir(), "wp2emdash-upgrade-"));
		sites = join(dir, "sites");
		initSite({ slug, name: "Acme", sourceUrl: "https://acme.example", productionUrl: "https://acme.example", sensitiveData: false }, sites);
		const html = { "/": page(), "/about/": page({ title: "About - Acme", h1: "About" }) };
		prod = { pages: { ...html }, status: {}, hits: [] };
		stg = { pages: { ...html }, status: {}, hits: [] };
		prodUrl = await serve(prod);
		stgUrl = await serve(stg);
		scaffoldRuns.length = 0;
		scripts.length = 0;
	});
	afterEach(() => {
		for (const s of servers.splice(0)) s.close();
		rmSync(dir, { recursive: true, force: true });
	});

	const paths = () => sitePaths(slug, sites);
	const writeCf = (cf: unknown) => writeFileSync(join(paths().root, "cloudflare.json"), JSON.stringify(cf));
	const writeProject = (s: Record<string, string>) => {
		mkdirSync(paths().project, { recursive: true });
		writeFileSync(join(paths().project, "package.json"), JSON.stringify({ scripts: s }));
	};

	it("resolves the live address like the deploy scripts do", () => {
		const config = { target: { productionUrl: "https://acme.example" } };
		expect(upgradeAddresses(config, { production: { worker: { url: "https://acme.x.workers.dev/" } } })).toMatchObject({ production: "https://acme.x.workers.dev", hasStaging: false, live: false });
		expect(upgradeAddresses(config, { production: { live: true, worker: { url: "https://acme.x.workers.dev" } }, staging: { worker: { url: "https://s.workers.dev" } } })).toMatchObject({ production: "https://acme.example", staging: "https://s.workers.dev", hasStaging: true, live: true });
		expect(upgradeAddresses(config, {}).production).toBeUndefined();
	});

	it("single environment: snapshots production, reruns scaffold, deploys nothing and prints the production command", async () => {
		writeCf({ production: { d1: { id: "d" }, worker: { url: prodUrl } } });
		writeProject({ "deploy:production": "x", "ci:deploy:production": "y" });
		const r = await upgrade(slug, { sitesDir: sites }, { runScaffold: okScaffold, runScript: async (script, cwd, env) => (scripts.push({ script, cwd, env }), { code: 0, out: "" }), now });
		expect(r.exitCode).toBe(0);
		expect(scaffoldRuns).toEqual([slug]);
		expect(scripts).toEqual([]);
		const before = JSON.parse(readFileSync(join(paths().root, r.before?.file ?? ""), "utf8")) as SiteSnapshot;
		expect(before.pages.map((p) => p.path).sort()).toEqual(["/", "/about/"]);
		expect(before.pages.find((p) => p.path === "/about/")?.fonts).toEqual(["body sans", "show serif"]);
		expect(r.next.join("\n")).toContain(`cd ${paths().project} && pnpm run ci:deploy:production`);
		expect(r.next.join("\n")).toContain("--verify");
		expect(prod.hits.every((h) => !h.includes("deploy"))).toBe(true);
	});

	it("stops with exit 2 when the scaffold gate fails", async () => {
		writeCf({ production: { d1: { id: "d" }, worker: { url: prodUrl } } });
		const r = await upgrade(slug, { sitesDir: sites }, { runScaffold: async () => ({ ok: false, runId: "r", checks: [{ id: "build", label: "Build", ok: false }] }), now });
		expect(r.exitCode).toBe(2);
		expect(r.scaffold?.failing.map((c) => c.id)).toEqual(["build"]);
		expect(existsSync(join(paths().root, r.before?.file ?? "x"))).toBe(true);
	});

	it("errors (exit 1) without a production address or when production does not answer", async () => {
		await expect(upgrade(slug, { sitesDir: sites }, { runScaffold: okScaffold, now })).rejects.toThrow(/No production address/);
		writeCf({ production: { d1: { id: "d" }, worker: { url: "http://127.0.0.1:1" } } });
		const r = await upgrade(slug, { sitesDir: sites }, { runScaffold: okScaffold, now, fetcher: (async () => { throw new Error("refused"); }) as typeof fetch });
		expect(r.exitCode).toBe(1);
		expect(scaffoldRuns).toEqual([]);
	});

	it("opt-in staging: deploys staging only with --deploy-staging, then compares it with before", async () => {
		writeCf({ production: { d1: { id: "d" }, worker: { url: prodUrl } }, staging: { d1: { id: "s" }, worker: { url: stgUrl } } });
		writeProject({ "ci:deploy:staging": "x", "ci:deploy:production": "y" });
		const runScript = async (script: string, cwd: string, env: Record<string, string>) => {
			scripts.push({ script, cwd, env });
			stg.pages["/"] = page({ cssHash: "NewHash9", year: 2026 }); // the "deploy": rebuilt assets only
			return { code: 0, out: "deployed" };
		};
		const skipped = await upgrade(slug, { sitesDir: sites }, { runScaffold: okScaffold, runScript, now });
		expect(skipped.exitCode).toBe(0);
		expect(skipped.stagingDeploy).toEqual({ ran: false, reason: "--deploy-staging not given" });
		expect(scripts).toEqual([]);

		const r = await upgrade(slug, { sitesDir: sites, deployStaging: true }, { runScaffold: okScaffold, runScript, now });
		expect(scripts.map((s) => s.script)).toEqual(["ci:deploy:staging"]);
		expect(scripts[0]?.cwd).toBe(paths().project);
		expect(r.exitCode).toBe(0);
		expect(r.comparisons[0]).toMatchObject({ label: "staging", identical: true, pagesCompared: 2 });
		expect(readFileSync(join(paths().root, r.comparisons[0]?.md ?? ""), "utf8")).toMatch(/identical/);
		expect(r.next.join("\n")).toContain("pnpm run ci:deploy:production");

		// Staging lost a page: exit 2, and the production command is not offered as the next step.
		const losesPage = async (script: string, cwd: string, env: Record<string, string>) => {
			delete stg.pages["/about/"]; // the upgrade's deploy broke a page staging had before
			return runScript(script, cwd, env);
		};
		const bad = await upgrade(slug, { sitesDir: sites, deployStaging: true }, { runScaffold: okScaffold, runScript: losesPage, now });
		expect(bad.exitCode).toBe(2);
		expect(bad.comparisons[0]?.pagesWithDifferences).toBe(1);
		expect(bad.next.join("\n")).not.toContain("ci:deploy:production");
	});

	it("a failed staging deploy is an error and is logged without secrets", async () => {
		writeCf({ production: { d1: { id: "d" }, worker: { url: prodUrl } }, staging: { d1: { id: "s" }, worker: { url: stgUrl } } });
		writeFileSync(join(paths().root, ".env"), "CLOUDFLARE_API_TOKEN=secret-token-value-123\n");
		writeProject({ "ci:deploy:staging": "x" });
		const r = await upgrade(slug, { sitesDir: sites, deployStaging: true }, { runScaffold: okScaffold, runScript: async (script, cwd, env) => (scripts.push({ script, cwd, env }), { code: 1, out: `boom ${env.CLOUDFLARE_API_TOKEN}` }), now });
		expect(r.exitCode).toBe(1);
		expect(scripts[0]?.env.CLOUDFLARE_API_TOKEN).toBe("secret-token-value-123");
		const log = readFileSync(join(paths().root, r.dir, "staging-deploy.log"), "utf8");
		expect(log).toContain("boom");
		expect(log).not.toContain("secret-token-value-123");
		expect(JSON.stringify(r)).not.toContain("secret-token-value-123");
	});

	it("checks the earlier gates before snapshotting; --preview rebuilds without them", async () => {
		writeCf({ production: { d1: { id: "d" }, worker: { url: prodUrl } } });
		writeState(paths().state, newState(slug));
		const r = await upgrade(slug, { sitesDir: sites }, { now });
		expect(r.exitCode).toBe(1);
		expect(r.next.join("\n")).toContain("--preview");
		expect(prod.hits).toEqual([]);
		expect(existsSync(join(paths().reports, "upgrade"))).toBe(false);
	});

	it("never runs a production deploy script", async () => {
		expect(() => assertStagingScript("ci:deploy:production")).toThrow(/Refused/);
		expect(() => assertStagingScript("deploy:production")).toThrow(/Refused/);
		await expect(defaultRunScript("ci:deploy:production", dir, {})).rejects.toThrow(/Refused/);
		expect(productionDeployCommand(join(dir, "none"))).toMatch(/pnpm run deploy:production$/);
	});

	it("--verify compares production now with the latest before.json", async () => {
		writeCf({ production: { d1: { id: "d" }, worker: { url: prodUrl } } });
		await expect(upgrade(slug, { sitesDir: sites, verify: "production" }, { now })).rejects.toThrow(/No before snapshot/);
		await upgrade(slug, { sitesDir: sites }, { runScaffold: okScaffold, now });
		const dirAfter = latestUpgradeDir(paths().reports);
		expect(dirAfter).toBeDefined();

		// The owner deployed: assets renamed and the year moved on → identical.
		prod.pages["/"] = page({ cssHash: "Prod2026", jsQuery: "?v=9", year: 2026 });
		const ok = await upgrade(slug, { sitesDir: sites, verify: "production" }, { now });
		expect(ok.exitCode).toBe(0);
		expect(ok.mode).toBe("verify");
		expect(existsSync(join(paths().root, ok.dir, "after-production.json"))).toBe(true);
		expect(existsSync(join(paths().root, ok.dir, "compare-production.md"))).toBe(true);

		// Text changed on /about/ → exit 2 with the page listed.
		prod.pages["/about/"] = page({ title: "About - Acme", h1: "About", body: "Something else entirely." });
		const bad = await upgrade(slug, { sitesDir: sites, verify: "production" }, { now });
		expect(bad.exitCode).toBe(2);
		const c = JSON.parse(readFileSync(join(paths().root, bad.comparisons[0]?.json ?? ""), "utf8"));
		expect(c.pages.find((p: { path: string }) => p.path === "/about/").differences.map((d: { field: string }) => d.field)).toContain("text");
		expect(readFileSync(join(paths().root, bad.comparisons[0]?.md ?? ""), "utf8")).toMatch(/\| \/about\/ \| text \|/);

		// Any URL (e.g. a Workers version preview) compares too.
		const preview = await upgrade(slug, { sitesDir: sites, verify: stgUrl }, { now });
		expect(preview.exitCode).toBe(0);
		expect(preview.comparisons[0]?.label).toMatch(/^url-127\.0\.0\.1/);
		await expect(upgrade(slug, { sitesDir: sites, verify: "staging" }, { now })).rejects.toThrow(/no staging/);
		await expect(upgrade(slug, { sitesDir: sites, verify: "ftp://x" }, { now })).rejects.toThrow(/http/);
	});

	it("MCP upgrade_verify: read-only comparison, no rebuild", async () => {
		writeCf({ production: { d1: { id: "d" }, worker: { url: prodUrl } } });
		await upgrade(slug, { sitesDir: sites }, { runScaffold: okScaffold, now });
		const r = await upgradeVerifyTool({ slug }, { sitesDir: sites, kitRoot: join(dir, "kit") });
		expect(r.exitCode).toBe(0);
		expect(r.scaffold).toBeUndefined();
		await expect(upgradeVerifyTool({ slug: "nope" }, { sitesDir: sites, kitRoot: join(dir, "kit") })).rejects.toThrow(/No site/);
	});
});
