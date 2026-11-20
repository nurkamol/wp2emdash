/**
 * Performance package (src/scaffold/perf.ts, src/verify/perf.ts, starter): route rules, warm-up script, CSP hash of
 * the inline announcement script, deferred background video, brand files, verify helpers. Synthetic data only.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { kitConfigSchema } from "../src/config/schema.js";
import { astroPerf, HEADERS_FILE, imageHosts, imageSize, optimizeBrand, perfSite, routeRules, WARMUP_SCRIPT, withWarmup, wranglerPerf, writePerfFiles } from "../src/scaffold/perf.js";
import { cacheMisses, median, probeCache } from "../src/verify/perf.js";
import { type ClientRepoInput, clientRepoFiles } from "../src/scaffold/client-repo.js";

const starter = (f: string) => readFileSync(join(import.meta.dirname, "..", "starter", "src", f), "utf8");
const perf = (over: Record<string, unknown> = {}) => kitConfigSchema.parse({ slug: "fixture", name: "Fixture", source: { url: "https://fixture.example" }, target: { kind: "emdash", productionUrl: "https://fixture.example" }, performance: over }).performance;
const tmp = mkdtempSync(join(tmpdir(), "wp2emdash-perf-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("route caching config", () => {
	it("is on by default with an hour's lifetime and a day of stale-while-revalidate", () => {
		expect(perf()).toEqual({ routeCache: true, maxAge: 3600, swr: 86400, responsiveImages: true, warmup: true, smartPlacement: false, phoneVideo: false });
	});

	it("has one rule per public page plus the sitemaps and image variants, tagged with EmDash collection names", () => {
		const rules = routeRules(perf(), ["/", "/about-us/", "services/physical-therapy", "/about-us"]);
		expect(Object.keys(rules)).toEqual(["/", "/about-us", "/services/physical-therapy", "/sitemap.xml", "/sitemap-[collection].xml", "/_image"]);
		expect(rules["/"]).toEqual({ maxAge: 3600, swr: 86400, tags: ["pages", "site_parts", "popups"] });
		expect(rules["/sitemap.xml"]?.tags).toEqual(["pages"]);
		expect(rules["/_image"]).toEqual({ maxAge: 86400, swr: 604800, tags: ["emdash:media"] });
	});

	it("never catches EmDash's admin/API, the form endpoints or route parameters", () => {
		const rules = routeRules(perf(), ["/_emdash/admin", "/api/forms/x", "/[...slug]", "/a/*"]);
		expect(Object.keys(rules).some((k) => /^\/(?:_emdash|api)|\[\.\.\.|\*/.test(k))).toBe(false);
		expect(Object.keys(routeRules(perf({ responsiveImages: false }), ["/"]))).not.toContain("/_image");
	});

	it("writes the provider, the rules and the image hosts into astro.config.mjs; nothing when turned off", () => {
		const a = astroPerf(perf(), ["/", "/faq/"], imageHosts(["https://fixture.example", "https://fixture-staging.acct.workers.dev", undefined]));
		expect(a.imports).toBe('\nimport { cacheCloudflare } from "@astrojs/cloudflare/cache";');
		expect(a.options).toContain("cache: { provider: cacheCloudflare() },");
		expect(a.options).toContain('"/faq": {maxAge: 3600, swr: 86400, tags: ["pages", "site_parts", "popups"]},');
		expect(a.options).toContain('domains: ["fixture-staging.acct.workers.dev","fixture.example","www.fixture.example"]');
		const off = astroPerf(perf({ routeCache: false, responsiveImages: false }), ["/"], ["fixture.example"]);
		expect(off.imports).toBe("");
		expect(off.options).toBe('\timage: { layout: "constrained", responsiveStyles: true },\n');
	});

	it("enables the Workers cache without cross-version reuse; Smart Placement only on request", () => {
		expect(wranglerPerf(perf())).toContain('"cache": { "enabled": true, "cross_version_cache": false },');
		expect(wranglerPerf(perf())).not.toContain("placement");
		expect(wranglerPerf(perf({ smartPlacement: true }))).toContain('"placement": { "mode": "smart" },');
		expect(wranglerPerf(perf({ routeCache: false }))).toBe("");
	});
});

describe("warm-up after deploy", () => {
	const scripts = { build: "astro build", "deploy:staging": "astro build && wrangler deploy && emdash migrate --check", "deploy:production": "astro build && wrangler deploy", "versions:upload": "astro build && wrangler versions upload", "versions:deploy": "wrangler versions deploy" };

	it("runs scripts/warm.mjs after every deploy, against the address that deploy serves", () => {
		const w = withWarmup(scripts, { staging: "https://s.acct.workers.dev/", production: "https://fixture.example" }, perf());
		expect(w["deploy:staging"]).toBe("astro build && wrangler deploy && emdash migrate --check && node scripts/warm.mjs https://s.acct.workers.dev");
		expect(w["deploy:production"]).toBe("astro build && wrangler deploy && node scripts/warm.mjs https://fixture.example");
		expect(w["versions:deploy"]).toBe("wrangler versions deploy && node scripts/warm.mjs https://fixture.example");
		expect(w["versions:upload"]).toBe(scripts["versions:upload"]);
		expect(w.build).toBe("astro build");
		expect(withWarmup(w, { production: "https://fixture.example" }, perf())["deploy:production"]?.match(/warm\.mjs/g)).toHaveLength(1);
		expect(withWarmup(scripts, { staging: "https://s.acct.workers.dev" }, perf())["deploy:production"]).toBe(scripts["deploy:production"]);
		expect(withWarmup(scripts, { production: "https://fixture.example" }, perf({ warmup: false }))).toEqual(scripts);
	});

	it("requests every sitemap URL and the /_image variants those pages use, and never fails the deploy", async () => {
		const hits: string[] = [];
		const server = createServer((req, res) => {
			hits.push(req.url ?? "");
			const host = `http://${req.headers.host}`;
			if (req.url === "/sitemap.xml") return res.end(`<sitemapindex><sitemap><loc>${host}/sitemap-pages.xml</loc></sitemap></sitemapindex>`);
			if (req.url === "/sitemap-pages.xml") return res.end(`<urlset><url><loc>${host}/</loc></url><url><loc>${host}/about-us/</loc></url><url><loc>https://elsewhere.example/x/</loc></url></urlset>`);
			if (req.url === "/") return res.end(`<img src="/_image?href=a&amp;w=640" srcset="/_image?href=a&amp;w=640 640w, /_image?href=a&amp;w=1280 1280w"><img src="/brand/h/logo.webp">`);
			if (req.url?.startsWith("/_image") || req.url === "/about-us/") return res.end("ok");
			res.statusCode = 404;
			res.end();
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const port = (server.address() as { port: number }).port;
		const file = join(tmp, "warm.mjs");
		writeFileSync(file, WARMUP_SCRIPT);
		const run = (arg: string) =>
			new Promise<{ code: number | null; out: string }>((resolve) => {
				const p = spawn(process.execPath, [file, arg], { env: { ...process.env, WARM_DELAY_MS: "0", WARM_RETRY_MS: "0" } });
				let out = "";
				p.stdout.on("data", (b: Buffer) => (out += b));
				p.on("close", (code: number | null) => resolve({ code, out }));
			});
		const r = await run(`http://127.0.0.1:${port}/`);
		server.close();
		expect(r.code).toBe(0);
		expect(r.out).toMatch(/warm-up: 3 pages on http:\/\/127\.0\.0\.1:\d+, 2 OK/);
		expect(r.out).toMatch(/warm-up: 2 image variants .* 2 OK/);
		// The foreign sitemap entry is requested on the site's own origin (never another host).
		expect(hits).toContain("/x/");
		expect(hits).toEqual(expect.arrayContaining(["/sitemap.xml", "/sitemap-pages.xml", "/", "/about-us/", "/_image?href=a&w=640", "/_image?href=a&w=1280"]));
		expect((await run("")).out).toContain("warm-up skipped");
	});

	it("is valid JavaScript", () => {
		const file = join(tmp, "check.mjs");
		writeFileSync(file, WARMUP_SCRIPT);
		expect(spawnSync(process.execPath, ["--check", file]).status).toBe(0);
	});

	it("writes scripts/warm.mjs and public/_headers; removes the script when the package is off", () => {
		const project = join(tmp, "project");
		mkdirSync(join(project, "public"), { recursive: true });
		writePerfFiles(project, perf());
		expect(readFileSync(join(project, "scripts", "warm.mjs"), "utf8")).toBe(WARMUP_SCRIPT);
		expect(readFileSync(join(project, "public", "_headers"), "utf8")).toBe(HEADERS_FILE);
		writePerfFiles(project, perf({ routeCache: false }));
		expect(existsSync(join(project, "scripts"))).toBe(false);
	});
});

describe("browser caching of hashed files", () => {
	it("marks fonts (content-hashed names) and hashed brand files immutable, nothing else", () => {
		expect(HEADERS_FILE).toContain("/fonts/*\n  Cache-Control: public, max-age=31536000, immutable");
		expect(HEADERS_FILE).toContain("/brand/h/*\n  Cache-Control: public, max-age=31536000, immutable");
		expect(HEADERS_FILE).not.toMatch(/^\/brand\/\*$/m);
	});
});

describe("brand files", () => {
	const png = (w: number, h: number) => {
		const b = Buffer.alloc(33);
		b.writeUInt32BE(0x89504e47, 0);
		b.writeUInt32BE(0x0d0a1a0a, 4);
		b.writeUInt32BE(13, 8);
		b.write("IHDR", 12, "ascii");
		b.writeUInt32BE(w, 16);
		b.writeUInt32BE(h, 20);
		return Buffer.concat([b, Buffer.alloc(4000)]);
	};

	it("reads the intrinsic size of PNG, GIF, JPEG, WebP and SVG files", () => {
		expect(imageSize(png(586, 754))).toEqual({ width: 586, height: 754 });
		const gif = Buffer.from("GIF89a\x10\x00\x20\x00", "latin1");
		expect(imageSize(gif)).toEqual({ width: 16, height: 32 });
		const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x02, 0x58, 0, 0, 0, 0, 0]);
		expect(imageSize(jpeg)).toEqual({ width: 600, height: 300 });
		const webp = Buffer.alloc(30);
		webp.write("RIFF", 0, "ascii");
		webp.write("WEBP", 8, "ascii");
		webp.write("VP8X", 12, "ascii");
		webp.writeUIntLE(199, 24, 3);
		webp.writeUIntLE(99, 27, 3);
		expect(imageSize(webp)).toEqual({ width: 200, height: 100 });
		expect(imageSize(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"></svg>'))).toEqual({ width: 120, height: 40 });
		expect(imageSize(Buffer.from('<svg width="64px" height="32px"></svg>'))).toEqual({ width: 64, height: 32 });
		expect(imageSize(Buffer.from("not an image"))).toBeUndefined();
	});

	it("writes content-hashed files with their size: the logo as WebP at twice the header height, small favicons", async () => {
		const pub = join(tmp, "public");
		mkdirSync(join(pub, "brand"), { recursive: true });
		writeFileSync(join(pub, "brand", "logo.png"), png(586, 754));
		writeFileSync(join(pub, "brand", "favicon.png"), png(512, 512));
		writeFileSync(join(pub, "brand", "logo-on-dark.svg"), '<svg viewBox="0 0 300 100"></svg>');
		const calls: string[] = [];
		const encode = async (_src: Buffer, mime: string, outs: { width: number; height: number; type: string }[]) => {
			calls.push(`${mime} → ${outs.map((o) => `${o.width}x${o.height} ${o.type}`).join(", ")}`);
			return outs.map((o) => Buffer.alloc(o.width === 192 ? 9000 : 100, o.width));
		};
		const out = await perfSite(pub, perf(), { logo: "/brand/logo.png", logoOnTop: "/brand/logo-on-dark.svg", favicon: "/brand/favicon.png" }, 56, encode);
		expect(calls[0]).toBe("image/png → 87x112 image/webp");
		expect(out.header.logoImg).toMatchObject({ width: 87, height: 112 });
		expect(out.header.logoImg?.src).toMatch(/^\/brand\/h\/logo\.[0-9a-f]{10}\.webp$/);
		// SVG: copied as it is (hashed name), its own size.
		expect(out.header.logoOnTopImg).toMatchObject({ width: 300, height: 100 });
		expect(out.header.logoOnTopImg?.src).toMatch(/^\/brand\/h\/logo-on-dark\.[0-9a-f]{10}\.svg$/);
		// 192px WebP is larger than the (synthetic) original: the original is kept instead.
		expect((out.site.icons ?? []).map((i) => `${i.rel} ${i.type} ${i.sizes ?? ""}`)).toEqual(["icon image/png 32x32", "icon image/png 512x512", "apple-touch-icon image/png 180x180"]);
		expect(out.site.routeCache).toEqual({ maxAge: 3600, swr: 86400 });
		for (const f of readdirSync(join(pub, "brand", "h"))) expect(f).toMatch(/^[\w-]+\.[0-9a-f]{10}\.\w+$/);
		// Without an encoder (no Chromium) the originals are copied under hashed names, with their size.
		const plain = await perfSite(pub, perf({ routeCache: false }), { logo: "/brand/logo.png" }, 56, async () => undefined);
		expect(plain.header.logoImg).toMatchObject({ width: 586, height: 754 });
		expect(plain.header.logoImg?.src).toMatch(/\.png$/);
		expect(plain.site).toEqual({});
	});

	it("the header renders the logo with its width and height; the layout links the sized favicons", () => {
		const h = starter("components/SiteHeader.astro");
		// The layout's brand (Settings → General, site.config as fallback: utils/settings.ts) wins; site.config otherwise.
		expect(h).toContain("const logo = brand ? brand.logo : (h.logoImg ?? (h.logo ? { src: h.logo } : undefined));");
		expect(h).toContain('<img {...logo} alt="" class="logo logo--default" decoding="async" />');
		expect(h).toContain('<img {...logo} alt="" loading="lazy" decoding="async" />');
		const base = starter("layouts/Base.astro");
		expect(base).toContain("{brand.icons.map((i) => <link rel={i.rel} href={i.href} type={i.type || undefined} sizes={i.sizes} />)}");
		expect(base).toContain("logo: header.logoImg ?? { src: header.logo as string }");
	});
});

describe("starter: route cache, CSP, announcement schedule, background video", () => {
	it("allows exactly the announcement's inline script by its SHA-256 hash, never 'unsafe-inline' for visitors", () => {
		const mw = starter("middleware.ts");
		expect(mw).toContain('import announcementScript from "./scripts/inline/announcement.js?raw";');
		expect(mw).toContain("const INLINE_SCRIPTS = [announcementScript];");
		expect(mw).toContain(`\${editor ? " 'unsafe-inline'" : \` \${hashes}\`}`);
		// The browser hashes the script element's text exactly as Astro emits it (set:html, verbatim).
		const text = starter("scripts/inline/announcement.js");
		const hash = createHash("sha256").update(text).digest("base64");
		expect(hash).toMatch(/^[A-Za-z0-9+/]{43}=$/);
		expect(starter("components/Announcement.astro")).toContain("<script is:inline set:html={announcementScript} />");
	});

	it("decides the announcement schedule in the browser and limits the cached page's life to the next change", () => {
		const js = starter("scripts/inline/announcement.js");
		expect(js).toContain("var on = !off && !(b.dataset.from && now < +b.dataset.from) && !(b.dataset.to && now > +b.dataset.to);");
		expect(js).toContain('r.classList.toggle("has-announcement", on);');
		const chrome = starter("utils/chrome.ts");
		expect(chrome).toContain("!((at(b.ends_at) ?? Infinity) < now)");
		expect(chrome).toContain("if (seconds < maxAge) cache.set({ maxAge: seconds, swr: 0 });");
		const base = starter("layouts/Base.astro");
		expect(base).toContain('"has-announcement": !!announcement && !announcementLater');
		expect(base).not.toContain("Astro.cache");
		expect(starter("components/Announcement.astro")).toContain("hidden={hidden}");
	});

	it("sets every route-cache tag in the page's frontmatter (a layout renders after the headers are sent)", () => {
		const slug = starter("pages/[...slug].astro");
		expect(slug).toContain('await Promise.all([getEmDashEntry("pages", slug), loadChrome()])');
		expect(slug).toContain("cachePage(Astro.cache);\ncacheChrome(Astro.cache, chrome);");
		expect(slug).toContain("<Base chrome={chrome}");
		const chrome = starter("utils/chrome.ts");
		for (const call of ["getSiteSettingsWithCacheHint()", 'getMenuWithCacheHint("primary")', 'getMenuWithCacheHint("secondary")', 'getEmDashEntry("site_parts", "footer")', 'getEmDashCollection("popups", { status: "published" })', 'getEmDashEntry("site_parts", "announcement")']) expect(chrome).toContain(call);
		expect(chrome).toContain("for (const r of Object.values(chrome)) cache.set(r.cacheHint);");
	});

	it("keeps 404s, redirects and editors out of the route cache; sends HTML no-cache to browsers", () => {
		expect(starter("pages/404.astro")).toContain("noCache(Astro.cache);");
		const slug = starter("pages/[...slug].astro");
		expect(slug.indexOf("noCache(Astro.cache);")).toBeLessThan(slug.indexOf('Astro.rewrite("/404")'));
		expect(slug).toContain("cachePage(Astro.cache);");
		const mw = starter("middleware.ts");
		expect(mw).toContain("if (context.cache?.enabled) context.cache.set(false);\n\t\treturn context.redirect(to, status);");
		expect(mw.match(/return context\.redirect\(/g)).toHaveLength(1);
		expect(mw).toContain("if (isEditor(context.cookies, context.url) && context.cache?.enabled) context.cache.set(false);");
		expect(mw).toContain('if (html && !headers.has("cache-control")) headers.set("Cache-Control", "no-cache");');
		expect(mw).toContain('if (context.url.pathname === "/_image" && response.status >= 500) {');
		const cache = starter("utils/cache.ts");
		expect(cache).toContain('cache.set({ maxAge: rc.maxAge, swr: rc.swr, tags: ["pages", "site_parts", "popups"] });');
	});

	it("paints the background picture first and attaches the video only after load, idle, on wide screens", () => {
		const s = starter("components/Section.astro");
		expect(s).toContain('{v.bg_image && <Image image={v.bg_image} class="section__bg-media" sizes="100vw" priority={type === "hero" || v._lead === true} />}');
		const video = /<video [^>]*\/>/.exec(s)?.[0] ?? "";
		expect(video).toContain('preload="none"');
		expect(video).toContain("data-src={videoSrc}");
		expect(video).not.toMatch(/\ssrc=|autoplay|poster=/);
		const js = starter("scripts/site.ts");
		expect(js).toContain('window.matchMedia("(max-width: 767.98px)").matches');
		expect(js).toContain("connection?: { saveData?: boolean }");
		expect(js).toContain("if (!src || (!always && (reduce || saveData || small))) continue;");
		expect(js).toContain('window.requestIdleCallback(attach, { timeout: 3000 })');
		expect(js).toContain('window.addEventListener("load", idle, { once: true });');
		expect(starter("styles/base.css")).toContain(".section__bg-video { opacity: 0;");
	});
});

describe("verify: route cache and payload checks", () => {
	it("probes a page twice and reports pages whose second request was not a HIT", async () => {
		const seen: string[] = [];
		const fake = async (url: string) => {
			seen.push(url);
			const n = seen.filter((u) => u === url).length;
			return new Response("x", { status: 200, headers: { "cf-cache-status": url.endsWith("/cold/") ? "MISS" : n === 1 ? "MISS" : "HIT" } });
		};
		const a = await probeCache(fake, "https://s.example", "/", 2);
		const b = await probeCache(fake, "https://s.example", "/cold/", 2);
		expect(a.cache).toEqual(["MISS", "HIT"]);
		expect(a.ttfbMs).toHaveLength(2);
		expect(cacheMisses([a, b])).toEqual(["/cold/ MISS→MISS"]);
		expect(median([300, 100, 200])).toBe(200);
	});

	it("gates on a cached TTFB and a home-page payload budget by default", () => {
		const g = kitConfigSchema.parse({ slug: "fixture", name: "Fixture", source: { url: "https://fixture.example" }, target: { kind: "emdash", productionUrl: "https://fixture.example" } }).gates;
		expect(g.maxCachedTtfbMs).toBe(600);
		expect(g.maxPayloadKb).toBe(1500);
	});
});

describe("client docs", () => {
	const input = (o: Partial<ClientRepoInput> = {}): ClientRepoInput => ({ name: "Example", slug: "example", sourceUrl: "https://example.com", productionUrl: "https://example.com", workerName: "example", productionReady: false, sections: [], forms: [], email: { provider: "brevo", to: [] }, turnstileProduction: false, sensitiveData: false, stack: {}, ...o });

	it("tell editors changes appear within seconds and what to do when a page looks stale (both environment layouts)", () => {
		for (const stagingUrl of [undefined, "https://example-staging.acme.workers.dev"]) {
			const f = clientRepoFiles(input({ routeCache: true, ...(stagingUrl ? { stagingUrl } : {}) }));
			expect(f["docs/editor-guide.md"]).toContain("**Changes appear within seconds** after you publish");
			expect(f["docs/deployment.md"]).toContain("## Speed: the page cache");
			expect(f["docs/deployment.md"]).toContain("5. **Warm-up** — `node scripts/warm.mjs <address>`");
			expect(f["docs/deployment.md"]).toContain("redeploy (Actions → CI → Run workflow), which clears the whole cache");
		}
		const off = clientRepoFiles(input());
		expect(off["docs/deployment.md"]).not.toContain("page cache");
		expect(off["docs/editor-guide.md"]).not.toContain("within seconds");
	});
});
