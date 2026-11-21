/**
 * Performance package for the generated project (kit.config `performance`, on by default). Verified against
 * EmDash 1.5.0, Astro 7.4.12, @astrojs/cloudflare 14.4.8, Wrangler 4.163 — docs/spikes/performance-findings.md.
 *
 * - Route caching: Astro's Cloudflare cache provider (Workers cache in front of the Worker: a hit never runs it) with
 *   one route rule per public page and the sitemaps. Tags are EmDash collection names ("pages",
 *   "site_parts", "popups"), so EmDash's purge on publish reaches them; the shared layout adds the chrome's tags
 *   (emdash:settings, emdash:menu:<name>) through cache hints. cross_version_cache off: a deploy serves new templates.
 * - Warm-up: deploy scripts request every sitemap URL once after `wrangler deploy` (scripts/warm.mjs).
 * - Responsive images: EmDash's /_image endpoint (Cloudflare Images binding) authorised for the site's own hosts,
 *   transformed variants kept in the route cache.
 * - Long browser caching for content-hashed fonts and brand files (public/_headers).
 * - Brand files: content-hashed copies, the logo as WebP sized for the header, small favicons (PNG kept).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";
import type { KitConfig } from "../config/schema.js";

export type PerfConfig = KitConfig["performance"];

export interface RouteRule {
	maxAge: number;
	swr: number;
	tags: string[];
}

/** Collections every page renders through the shared layout (footer and announcement site parts, popups). */
export const CHROME_TAGS = ["site_parts", "popups"] as const;

/**
 * Route rules: one per public page path (Astro matches rules by path; `trailingSlash: "ignore"` makes a rule cover
 * both URL styles), plus the sitemaps (robots.txt is not: EmDash answers it with no-store). Never a catch-all: a rule matches by path whatever the route,
 * so "/[...slug]" would also cache EmDash's admin and API (/_emdash) and the form endpoints (/api).
 */
export function routeRules(perf: PerfConfig, pagePaths: string[], contentTags: string[] = []): Record<string, RouteRule> {
	if (!perf.routeCache) return {};
	// Pages live long (pageMaxAge): every edit that shows on a page purges it. contentTags (posts, collections) because
	// footer widgets such as Recent posts show them on every page.
	const page = { maxAge: perf.pageMaxAge, swr: perf.swr, tags: ["pages", ...CHROME_TAGS, ...contentTags] };
	const rules: Record<string, RouteRule> = {};
	const norm = (p: string) => (p === "/" ? "/" : `/${p.replace(/^\/+|\/+$/g, "")}`);
	for (const p of [...new Set(pagePaths.map(norm))].sort()) {
		// A path segment that looks like a route parameter would be read as one: such a page uses the page default.
		if (/[[\]*]/.test(p) || /^\/(?:_|api\/|api$)/.test(p)) continue;
		rules[p] = page;
	}
	rules["/sitemap.xml"] = { maxAge: perf.maxAge, swr: perf.swr, tags: ["pages"] };
	// /llms.txt lists the pages and newest posts: it lives and is purged like them (settings: the site name and tagline).
	rules["/llms.txt"] = { maxAge: perf.pageMaxAge, swr: perf.swr, tags: ["pages", ...contentTags, "emdash:settings"] };
	rules["/sitemap-[collection].xml"] = { maxAge: perf.maxAge, swr: perf.swr, tags: ["pages"] };
	// The media sitemap (pictures and videos inside sections of pages, posts and collection entries).
	rules["/sitemap/media.xml"] = { maxAge: perf.maxAge, swr: perf.swr, tags: ["pages", ...contentTags] };
	// Transformed images (query = width/format): EmDash 1.5 does not purge them when an image is replaced in place,
	// so they live a day; a deploy (new Worker version) starts a fresh cache.
	if (perf.responsiveImages) rules["/_image"] = { maxAge: 86400, swr: 604800, tags: ["emdash:media"] };
	return rules;
}

/** Hosts EmDash's image endpoint may transform media for (its own media only: the endpoint never fetches them). */
export function imageHosts(urls: (string | undefined)[]): string[] {
	const hosts = new Set<string>();
	for (const u of urls) {
		if (!u || !URL.canParse(u)) continue;
		const h = new URL(u).hostname;
		hosts.add(h);
		if (!h.endsWith(".workers.dev") && h !== "localhost") hosts.add(h.startsWith("www.") ? h.slice(4) : `www.${h}`);
	}
	return [...hosts].sort();
}

/** Lines for astro.config.mjs: the import, and the `image`, `cache` and `routeRules` options. */
export function astroPerf(perf: PerfConfig, pagePaths: string[], hosts: string[], contentTags: string[] = []): { imports: string; options: string } {
	const image = `image: { layout: "constrained", responsiveStyles: true${perf.responsiveImages && hosts.length ? `, domains: ${JSON.stringify(hosts)}` : ""} },`;
	if (!perf.routeCache) return { imports: "", options: `\t${image}\n` };
	const rules = routeRules(perf, pagePaths, contentTags);
	const body = Object.entries(rules)
		.map(([k, v]) => `\t\t${JSON.stringify(k)}: ${JSON.stringify(v).replace(/"(\w+)":/g, "$1: ").replace(/,/g, ", ")},`)
		.join("\n");
	return {
		imports: '\nimport { cacheCloudflare } from "@astrojs/cloudflare/cache";',
		options: `\t${image}
	// Route caching (kit.config performance.routeCache): rendered pages are kept in Cloudflare's Workers cache; EmDash
	// purges them by tag when content, menus or settings change. One rule per page the migration knew; pages added
	// later get the same lifetime from src/utils/cache.ts.
	cache: { provider: cacheCloudflare() },
	routeRules: {
${body}
	},
`,
	};
}

/** wrangler.jsonc: the Workers cache (explicit, so Wrangler's flattened config is not left to the adapter) and placement. */
export function wranglerPerf(perf: PerfConfig): string {
	const lines: string[] = [];
	if (perf.routeCache) lines.push(`\t// Workers cache for route caching. cross_version_cache off: each deploy serves its own templates (warmed by scripts/warm.mjs).\n\t"cache": { "enabled": true, "cross_version_cache": false },`);
	if (perf.smartPlacement) lines.push(`\t"placement": { "mode": "smart" },`);
	return lines.length ? `${lines.join("\n")}\n` : "";
}

/** Site config the starter reads (src/utils/cache.ts): the default lifetime for pages added after the migration. */
export function perfSiteConfig(perf: PerfConfig): { routeCache?: { maxAge: number; swr: number; pageMaxAge: number }; prefetch?: false } {
	return { ...(perf.routeCache ? { routeCache: { maxAge: perf.maxAge, swr: perf.swr, pageMaxAge: perf.pageMaxAge } } : {}), ...(perf.prefetch ? {} : { prefetch: false as const }) };
}

/**
 * Re-warm from the Worker's cron (starter/src/utils/rewarm.ts): only once the site is live on its own domain (a
 * workers.dev Worker cannot request its own address) and with the route cache on.
 */
export function rewarmSiteConfig(perf: PerfConfig, production: { live: boolean; url?: string }): { rewarm?: { origin: string; everyMinutes: number } } {
	if (!perf.routeCache || !perf.rewarmMinutes || !production.live || !production.url || !URL.canParse(production.url)) return {};
	return { rewarm: { origin: new URL(production.url).origin, everyMinutes: perf.rewarmMinutes } };
}

/**
 * Deploy scripts with the warm-up appended: every script that runs `wrangler deploy` then requests the sitemap URLs
 * of the address it deployed to (staging scripts → the staging address, the others → production). A script whose
 * address is not known yet is left as it is.
 */
export function withWarmup(scripts: Record<string, string>, urls: { staging?: string; production?: string }, perf: PerfConfig): Record<string, string> {
	if (!perf.warmup || !perf.routeCache) return scripts;
	return Object.fromEntries(
		Object.entries(scripts).map(([k, v]) => {
			const url = /staging/.test(k) ? urls.staging : urls.production;
			return [k, /\bwrangler (?:versions )?deploy\b/.test(v) && url && !v.includes("scripts/warm.mjs") ? `${v} && node scripts/warm.mjs ${url.replace(/\/$/, "")}` : v];
		}),
	);
}

/** public/_headers: content-hashed fonts and brand files never change under their name. /_astro/* is added by the adapter. */
export const HEADERS_FILE = `# Generated by wp2emdash scaffold. Files whose name is their content hash are cached by browsers for a year.
/fonts/*
  Cache-Control: public, max-age=31536000, immutable
/brand/h/*
  Cache-Control: public, max-age=31536000, immutable
`;

/** scripts/warm.mjs in the generated project. */
export const WARMUP_SCRIPT = `#!/usr/bin/env node
// Generated by wp2emdash scaffold. After a deploy, requests every URL in the site's sitemap once, then the responsive
// image variants those pages use (/_image), so the first visitors get cached pages and pictures: each deploy starts
// with an empty route cache (cross_version_cache off).
// Usage: node scripts/warm.mjs https://example.com   — never fails the deploy: problems are printed, exit code 0.
const base = (process.argv[2] ?? process.env.SITE_URL ?? "").replace(/\\/$/, "");
if (!/^https?:\\/\\//.test(base)) {
	console.log("warm-up skipped: no site address given");
	process.exit(0);
}
const origin = new URL(base).origin;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (url) => {
	const t = Date.now();
	try {
		const res = await fetch(url, { redirect: "manual", headers: { "user-agent": "site-warmup (+deploy)" } });
		const body = await res.text();
		return { url, status: res.status, cache: res.headers.get("cf-cache-status") ?? "-", ms: Date.now() - t, body };
	} catch (e) {
		return { url, status: 0, cache: "-", ms: Date.now() - t, body: "", error: String(e?.message ?? e) };
	}
};
const locs = (xml) => [...xml.matchAll(/<loc>\\s*([^<\\s]+)\\s*<\\/loc>/g)].map((m) => m[1].replace(/&amp;/g, "&"));
const local = (u) => {
	try {
		const x = new URL(u, origin);
		return \`\${origin}\${x.pathname}\${x.search}\`;
	} catch {
		return undefined;
	}
};
// The new version takes a few seconds to reach every Cloudflare location.
await sleep(Number(process.env.WARM_DELAY_MS ?? 5000));
const index = await get(\`\${origin}/sitemap.xml\`);
if (index.status !== 200) {
	console.log(\`warm-up: \${origin}/sitemap.xml answered \${index.status || index.error}; nothing warmed\`);
	process.exit(0);
}
const urls = new Set();
for (const loc of locs(index.body).map(local).filter(Boolean)) {
	if (/\\.xml$/.test(new URL(loc).pathname)) {
		const part = await get(loc);
		for (const u of locs(part.body).map(local).filter(Boolean)) urls.add(u);
	} else urls.add(loc);
}
const all = async (list) => {
	const out = [];
	for (let i = 0; i < list.length; i += 4) out.push(...(await Promise.all(list.slice(i, i + 4).map(get))));
	// A request that failed right after a deploy (new version still spreading, a DNS hiccup) is retried twice.
	for (let round = 1; round <= 2; round++) {
		const failed = out.map((r, i) => [r, i]).filter(([r]) => r.status !== 200 && !(r.status >= 300 && r.status < 400));
		if (!failed.length) break;
		await sleep(Number(process.env.WARM_RETRY_MS ?? 2000) * round);
		for (const [r, i] of failed) out[i] = await get(r.url);
	}
	return out;
};
const pages = await all([...urls]);
// Every /_image variant the pages reference (src and srcset), at most 400.
const images = new Set();
for (const p of pages)
	for (const m of p.body.matchAll(/(?:src|srcset)="([^"]+)"/g))
		for (const part of m[1].split(",")) {
			const u = part.trim().split(/\\s+/)[0]?.replace(/&amp;/g, "&");
			if (u?.startsWith("/_image?")) images.add(\`\${origin}\${u}\`);
		}
const pics = await all([...images].slice(0, 400));
const report = (label, results) => {
	const bad = results.filter((r) => r.status !== 200);
	const slowest = [...results].sort((a, b) => b.ms - a.ms)[0];
	console.log(\`warm-up: \${results.length} \${label} on \${origin}, \${results.length - bad.length} OK\${slowest ? \`, slowest \${slowest.ms} ms (\${new URL(slowest.url).pathname})\` : ""}\`);
	for (const r of bad.slice(0, 20)) console.log(\`  \${r.status || r.error} \${r.url}\`);
};
report("pages", pages);
if (pics.length) report("image variants", pics);
`;

// ── Brand files ─────────────────────────────────────────────────────────────

/** Intrinsic size of a PNG, GIF, JPEG, WebP or SVG file; undefined when it cannot be read. */
export function imageSize(buf: Buffer): { width: number; height: number } | undefined {
	if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
	if (buf.length >= 10 && buf.toString("ascii", 0, 3) === "GIF") return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
	if (buf.length >= 30 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
		const kind = buf.toString("ascii", 12, 16);
		if (kind === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
		if (kind === "VP8L") {
			const b = buf.readUInt32LE(21);
			return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 };
		}
		if (kind === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
	}
	if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
		let i = 2;
		while (i + 9 < buf.length) {
			if (buf[i] !== 0xff) return undefined;
			const marker = buf[i + 1] as number;
			const len = buf.readUInt16BE(i + 2);
			if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
			i += 2 + len;
		}
		return undefined;
	}
	const text = buf.subarray(0, 4096).toString("utf8");
	const svg = /<svg\b[^>]*>/i.exec(text)?.[0];
	if (svg) {
		const attr = (n: string) => Number.parseFloat(new RegExp(`\\s${n}="([\\d.]+)(?:px)?"`, "i").exec(svg)?.[1] ?? "");
		const w = attr("width");
		const h = attr("height");
		if (w > 0 && h > 0) return { width: Math.round(w), height: Math.round(h) };
		const vb = /viewBox="[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)"/i.exec(svg);
		if (vb) return { width: Math.round(Number(vb[1])), height: Math.round(Number(vb[2])) };
	}
	return undefined;
}

export interface BrandImage {
	src: string;
	/** 1x and 2x files for the header height (raster logos), so a phone never downloads more than it shows. */
	srcset?: string;
	width: number;
	height: number;
}
export interface BrandOut {
	logo?: BrandImage;
	logoOnTop?: BrandImage;
	icons: { rel: string; href: string; type: string; sizes?: string }[];
}

/** Raster encoder: Chromium's canvas (Playwright, already a kit dependency). Returns undefined when unavailable. */
export type Encoder = (src: Buffer, mime: string, out: { width: number; height: number; type: "image/webp" | "image/png"; quality?: number }[]) => Promise<(Buffer | undefined)[] | undefined>;

export const chromiumEncoder: Encoder = async (src, mime, outs) => {
	try {
		const { chromium } = await import("playwright");
		const browser = await chromium.launch({ args: ["--no-proxy-server"] });
		try {
			const page = await browser.newPage();
			const data = `data:${mime};base64,${src.toString("base64")}`;
			const res = await page.evaluate(
				async ({ data, outs }) => {
					const img = new Image();
					img.src = data;
					await img.decode();
					return outs.map((o) => {
						const c = document.createElement("canvas");
						c.width = o.width;
						c.height = o.height;
						const ctx = c.getContext("2d") as CanvasRenderingContext2D;
						ctx.imageSmoothingQuality = "high";
						ctx.drawImage(img, 0, 0, o.width, o.height);
						const url = c.toDataURL(o.type, o.quality);
						// A browser that cannot encode the type falls back to PNG: report it as not made.
						return url.startsWith(`data:${o.type}`) ? url.slice(url.indexOf(",") + 1) : null;
					});
				},
				{ data, outs },
			);
			return res.map((b) => (b ? Buffer.from(b, "base64") : undefined));
		} finally {
			await browser.close();
		}
	} catch {
		return undefined;
	}
};

const MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

/**
 * Content-hashed brand files under public/brand/h/ (cached for a year by public/_headers), with their intrinsic size
 * for width/height attributes. Raster logos become WebP at twice the header's logo height (when smaller than the
 * original); the favicon becomes a 32px PNG, a 192px WebP and a 180px apple-touch PNG (each only when smaller than
 * the original, which is kept as the fallback). The original files stay where
 * they were (/brand/logo.png: sharing cards and old links use them). Without an encoder the originals are copied.
 */
export async function optimizeBrand(publicDir: string, brand: { logo?: string; logoOnTop?: string; favicon?: string }, logoHeight: number, encode: Encoder = chromiumEncoder): Promise<BrandOut> {
	const outDir = join(publicDir, "brand", "h");
	rmSync(outDir, { recursive: true, force: true });
	const out: BrandOut = { icons: [] };
	const local = (p?: string) => (p?.startsWith("/brand/") && existsSync(join(publicDir, p)) ? join(publicDir, p) : undefined);
	const put = (name: string, ext: string, data: Buffer): string => {
		mkdirSync(outDir, { recursive: true });
		const file = `${name}.${createHash("sha256").update(data).digest("hex").slice(0, 10)}${ext}`;
		writeFileSync(join(outDir, file), data);
		return `/brand/h/${file}`;
	};
	const logo = async (p: string | undefined, name: string): Promise<BrandImage | undefined> => {
		const file = local(p);
		if (!file) return undefined;
		const buf = readFileSync(file);
		const size = imageSize(buf);
		if (!size) return undefined;
		const ext = extname(file).toLowerCase();
		const h = Math.min(size.height, Math.max(1, Math.round(logoHeight * 2)));
		const w = Math.max(1, Math.round((size.width * h) / size.height));
		if (ext !== ".svg" && ext !== ".gif") {
			// 2x for sharp screens, 1x (the header height itself) for the rest: `srcset` lets the browser pick.
			const h1 = Math.max(1, Math.round(h / 2));
			const w1 = Math.max(1, Math.round((size.width * h1) / size.height));
			const want = h1 < h ? [{ width: w, height: h, type: "image/webp" as const, quality: 0.9 }, { width: w1, height: h1, type: "image/webp" as const, quality: 0.9 }] : [{ width: w, height: h, type: "image/webp" as const, quality: 0.9 }];
			const [webp, webp1] = (await encode(buf, MIME[ext] ?? "image/png", want)) ?? [];
			if (webp && webp.length < buf.length) {
				const src = put(name, ".webp", webp);
				return { src, ...(webp1 ? { srcset: `${put(`${name}-1x`, ".webp", webp1)} 1x, ${src} 2x` } : {}), width: w, height: h };
			}
		}
		return { src: put(name, ext, buf), width: size.width, height: size.height };
	};
	const l = await logo(brand.logo, "logo");
	if (l) out.logo = l;
	const top = await logo(brand.logoOnTop, "logo-on-dark");
	if (top) out.logoOnTop = top;
	const fav = local(brand.favicon);
	if (fav) {
		const buf = readFileSync(fav);
		const ext = extname(fav).toLowerCase();
		const size = imageSize(buf);
		const square = !!size && size.width === size.height && size.width >= 192;
		const made = square && ext !== ".svg" && ext !== ".ico" ? await encode(buf, MIME[ext] ?? "image/png", [{ width: 32, height: 32, type: "image/png" }, { width: 192, height: 192, type: "image/webp", quality: 0.9 }, { width: 180, height: 180, type: "image/png" }]) : undefined;
		const [s32, s192, s180] = made ?? [];
		// Browsers fetch one icon (the tab's 32px); the larger ones only where they are smaller than the original.
		const original = () => put("favicon", ext, buf);
		if (s32) out.icons.push({ rel: "icon", href: put("favicon-32", ".png", s32), type: "image/png", sizes: "32x32" });
		if (s32 && s192 && s192.length < buf.length) out.icons.push({ rel: "icon", href: put("favicon-192", ".webp", s192), type: "image/webp", sizes: "192x192" });
		else out.icons.push({ rel: "icon", href: original(), type: MIME[ext] ?? "image/png", ...(size ? { sizes: `${size.width}x${size.height}` } : {}) });
		if (s180 && s180.length < buf.length) out.icons.push({ rel: "apple-touch-icon", href: put("apple-touch-icon", ".png", s180), type: "image/png", sizes: "180x180" });
		else if (square && ext === ".png") out.icons.push({ rel: "apple-touch-icon", href: original(), type: "image/png" });
	}
	return out;
}

/** Writes scripts/warm.mjs and public/_headers into the project (removed when the package is turned off). */
export function writePerfFiles(project: string, perf: PerfConfig): void {
	const warm = join(project, "scripts", "warm.mjs");
	if (perf.routeCache && perf.warmup) {
		mkdirSync(join(project, "scripts"), { recursive: true });
		writeFileSync(warm, WARMUP_SCRIPT);
	} else rmSync(warm, { force: true });
	writeFileSync(join(project, "public", "_headers"), HEADERS_FILE);
	if (existsSync(join(project, "scripts")) && readdirSync(join(project, "scripts")).length === 0) rmSync(join(project, "scripts"), { recursive: true });
}

/**
 * site.config.json `brandSha1`: the sha1 of the original logo and favicon files. Load sets them as EmDash's logo and
 * favicon settings; the starter compares the setting's media (content hash, or a `wp2emdash-<name>-<sha1:10>` file
 * name when load had to convert it) with these to keep serving the optimized brand files until an editor picks
 * another image (starter/src/utils/settings.ts).
 */
export function brandHashes(publicDir: string, brand: { logo?: string; favicon?: string }): { brandSha1?: { logo?: string; favicon?: string } } {
	const out: { logo?: string; favicon?: string } = {};
	for (const k of ["logo", "favicon"] as const) {
		const p = brand[k];
		if (p?.startsWith("/brand/") && existsSync(join(publicDir, p))) out[k] = createHash("sha1").update(readFileSync(join(publicDir, p))).digest("hex");
	}
	return Object.keys(out).length ? { brandSha1: out } : {};
}

/**
 * Site config additions (src/site.config.json): route-cache defaults, the header's hashed logo files with their size,
 * and the favicon links. Called by the scaffold phase once the brand files are in public/brand.
 */
export async function perfSite(publicDir: string, perf: PerfConfig, brand: { logo?: string; logoOnTop?: string; favicon?: string }, logoHeight: number, encode: Encoder = chromiumEncoder) {
	const b = await optimizeBrand(publicDir, brand, logoHeight, encode);
	return {
		site: { ...perfSiteConfig(perf), ...(b.icons.length ? { icons: b.icons } : {}) },
		header: { ...(b.logo ? { logoImg: b.logo } : {}), ...(b.logoOnTop ? { logoOnTopImg: b.logoOnTop } : {}) },
	};
}
