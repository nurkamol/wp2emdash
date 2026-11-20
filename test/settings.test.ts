/**
 * EmDash's built-in Settings: what transform gathers from WordPress (ir/settings.json), what load writes (and keeps
 * when an editor changed it), and what the starter reads (settings first, site.config as fallback). Synthetic data.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { kitConfigSchema } from "../src/config/schema.js";
import { sitePaths } from "../src/core/paths.js";
import { runTransform } from "../src/phases/transform.js";
import { brandHashes } from "../src/scaffold/perf.js";
import { desiredSettings, planSettings, settingHash } from "../src/targets/emdash/settings.js";
import { buildSettings, type IrSettings, migrateRobotsTxt, phpDateToDateFns, socialNetworkOf, wpTimezone } from "../src/transform/settings.js";
import { brandMediaIds, brandMediaRows, type MediaRow, sameAsWithSocial, siteBrand, socialHref, socialHrefFor, verificationTags, withSocial } from "../starter/src/utils/settings.js";

const PROD = "https://studio.example";

describe("transform: settings from WordPress", () => {
	it("reads social profiles, the default sharing image and verification from a Rank Math settings export", () => {
		const s = buildSettings({
			options: {},
			rankMathExport: {
				general: { google_verify: "rm-google-123", bing_verify: '<meta name="msvalidate.01" content="RMBING456" />' },
				titles: { social_url_facebook: "https://www.facebook.com/studio", twitter_author_names: "@studiohq", social_additional_profiles: "https://www.instagram.com/studio/\nhttps://www.tiktok.com/@studio", open_graph_image_id: "77", open_graph_image: "https://old.example/wp-content/uploads/2024/01/share.jpg" },
				sitemap: {},
			},
			productionUrl: PROD,
			manifest: [{ id: 77, file: "2024/01/share.jpg" }],
		});
		expect(s.social).toEqual({ facebook: "https://www.facebook.com/studio", twitter: "https://x.com/studiohq", instagram: "https://www.instagram.com/studio/" });
		expect(s.sources["social.twitter"]).toBe("Rank Math settings export (twitter_author_names)");
		expect(s.seo.defaultOgImage).toEqual({ wpId: 77, kind: "image" });
		expect(s.seo.googleVerification).toBe("rm-google-123");
		expect(s.seo.bingVerification).toBe("RMBING456");
		expect(s.notCarried.join("\n")).toMatch(/tiktok\.com.*no field for this network/);
	});

	it("reads Yoast's wpseo_social and wpseo options (database dump), the audited head winning for verification", () => {
		const s = buildSettings({
			options: {},
			wpOptions: { wpseo_social: { facebook_site: "https://facebook.com/yoastsite", twitter_site: "yoasttw", linkedin_url: "https://www.linkedin.com/company/studio-co/", youtube_url: "https://www.youtube.com/@studio", other_social_urls: ["https://github.com/studio"], og_default_image: "https://old.example/wp-content/uploads/2023/05/default-1200x630.png" }, wpseo: { googleverify: "yoast-g", msverify: "YOASTB" } },
			verification: { "google-site-verification": "live-g", "p:domain_verify": "pin123" },
			productionUrl: PROD,
			manifest: [{ id: 9, file: "2023/05/default.png" }],
		});
		expect(s.social).toEqual({ facebook: "https://facebook.com/yoastsite", twitter: "https://x.com/yoasttw", linkedin: "https://www.linkedin.com/company/studio-co/", youtube: "https://www.youtube.com/@studio", github: "https://github.com/studio" });
		// The size variant maps to the library original.
		expect(s.seo.defaultOgImage).toEqual({ wpId: 9, kind: "image" });
		expect(s.seo.googleVerification).toBe("live-g");
		expect(s.sources["seo.googleVerification"]).toBe("audited page head (google-site-verification)");
		expect(s.seo.bingVerification).toBe("YOASTB");
		expect(s.notCarried.join("\n")).toMatch(/p:domain_verify/);
	});

	it("falls back to the home page's sameAs, then header/footer links; share links are not profiles", () => {
		const s = buildSettings({
			options: {},
			homeJsonLd: [{ "@graph": [{ "@type": "HealthClub", name: "Studio", sameAs: ["https://www.instagram.com/fromsameas/"] }] }],
			homeLinks: ["https://www.instagram.com/fromfooter/", "https://www.facebook.com/sharer/sharer.php?u=x", "https://www.facebook.com/fromfooter", "https://www.youtube.com/watch?v=abc"],
			productionUrl: PROD,
		});
		expect(s.social).toEqual({ instagram: "https://www.instagram.com/fromsameas/", facebook: "https://www.facebook.com/fromfooter" });
		expect(s.sources["social.instagram"]).toBe("home page structured data (sameAs)");
		expect(socialNetworkOf("https://twitter.com/intent/tweet?text=x")).toBeUndefined();
		expect(socialNetworkOf("https://www.linkedin.com/shareArticle?url=x")).toBeUndefined();
	});

	it("uses the og:image most audited pages share as the default sharing image (never a one-off)", () => {
		const shared = "https://old.example/wp-content/uploads/2022/02/og.jpg";
		expect(buildSettings({ options: {}, pageOgImages: [shared, shared, "https://old.example/wp-content/uploads/a.jpg", undefined], productionUrl: PROD }).seo.defaultOgImage).toEqual({ url: shared, kind: "image" });
		expect(buildSettings({ options: {}, pageOgImages: ["https://x.example/a.jpg", "https://x.example/b.jpg"], productionUrl: PROD }).seo.defaultOgImage).toBeUndefined();
	});

	it("carries reading settings: posts per page, the date format as date-fns tokens, the timezone", () => {
		const s = buildSettings({ options: { posts_per_page: "12", date_format: "F j, Y", timezone_string: "America/Chicago", site_icon: 41, custom_logo: 42 }, productionUrl: PROD });
		expect([s.postsPerPage, s.dateFormat, s.timezone]).toEqual([12, "MMMM d, yyyy", "America/Chicago"]);
		expect(s.favicon).toEqual({ wpId: 41, kind: "image" });
		expect(s.logo).toEqual({ wpId: 42, kind: "image" });
		expect(phpDateToDateFns("Y-m-d")).toBe("yyyy-MM-dd");
		expect(phpDateToDateFns("jS F Y")).toBe("do MMMM yyyy");
		expect(phpDateToDateFns("d/m/Y \\a\\t g:i a")).toBe("dd/MM/yyyy 'at' h:mm aaa");
		expect(phpDateToDateFns("B")).toBeUndefined();
		expect(wpTimezone("", "-5")).toBe("Etc/GMT+5");
		expect(wpTimezone("", "0")).toBe("UTC");
		expect(wpTimezone("", "5.5")).toBeUndefined();
		expect(wpTimezone("UTC+3", "")).toBe("Etc/GMT-3");
	});
});

describe("transform: robots.txt", () => {
	it("leaves a stock WordPress robots.txt to EmDash's generated default", () => {
		const wp = "User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\n\nSitemap: https://old.example/wp-sitemap.xml\n";
		const r = migrateRobotsTxt(wp, PROD);
		expect(r.robotsTxt).toBeUndefined();
		expect(r.dropped).toEqual(["Disallow: /wp-admin/", "Allow: /wp-admin/admin-ajax.php", "Sitemap: https://old.example/wp-sitemap.xml"]);
	});

	it("keeps the site's own rules, drops WordPress-only ones and points the sitemap at the new domain", () => {
		const txt = "# START YOAST BLOCK\nUser-agent: *\nDisallow: /wp-admin/\nDisallow: /private/\nDisallow: /?s=\nDisallow: /wp-content/plugins/\nCrawl-delay: 5\n\nUser-agent: GPTBot\nDisallow: /\n\nSitemap: https://old.example/sitemap_index.xml\n# END YOAST BLOCK";
		const r = migrateRobotsTxt(txt, `${PROD}/`);
		expect(r.robotsTxt).toBe(["User-agent: *", "Disallow: /private/", "Crawl-delay: 5", "Disallow: /_emdash/", "Allow: /_emdash/api/media/file/", "", "User-agent: GPTBot", "Disallow: /", "", `Sitemap: ${PROD}/sitemap.xml`, ""].join("\n"));
		expect(r.dropped).toContain("Disallow: /?s=");
		expect(r.dropped).toContain("Disallow: /wp-content/plugins/");
	});
});

describe("transform phase writes ir/settings.json and reports it", () => {
	const dir = mkdtempSync(join(tmpdir(), "wp2emdash-settings-"));
	afterAll(() => rmSync(dir, { recursive: true, force: true }));
	const paths = sitePaths("settings-fixture", dir);
	const write = (file: string, data: unknown) => {
		mkdirSync(join(file, ".."), { recursive: true });
		writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
	};
	write(join(paths.raw, "extract.json"), {});
	write(join(paths.raw, "exporter", "options.json"), { blogname: "Fixture Studio", timezone_string: "Europe/Berlin", date_format: "d.m.Y", posts_per_page: "6", site_icon: 5 });
	write(join(paths.raw, "rankmath-settings.json"), { general: { google_verify: "g-from-rm" }, titles: { social_url_facebook: "https://www.facebook.com/fixture" }, sitemap: {} });
	write(join(paths.snapshot, "discovery.json"), { robotsTxt: "User-agent: *\nDisallow: /members/\nDisallow: /wp-admin/\nSitemap: https://fixture.example/sitemap_index.xml\n" });
	write(join(paths.snapshot, "pages", "home.json"), { url: "https://fixture.example/", links: [{ href: "https://www.instagram.com/fixture/" }], seo: { jsonLd: [], og: {}, verification: { "msvalidate.01": "BINGLIVE" } } });
	const config = kitConfigSchema.parse({ slug: "settings-fixture", name: "Fixture", source: { url: "https://fixture.example" }, target: { productionUrl: "https://new.fixture.example" } });
	const run = runTransform({ config, paths, reporter: { runId: "t", emit: () => {} } });

	it("validates and carries every source", async () => {
		const checks = await run;
		expect(checks.find((c) => c.id === "ir-valid")).toMatchObject({ ok: true });
		const s = JSON.parse(readFileSync(join(paths.ir, "settings.json"), "utf8")) as IrSettings;
		expect(s).toMatchObject({ postsPerPage: 6, dateFormat: "dd.MM.yyyy", timezone: "Europe/Berlin", favicon: { wpId: 5 }, social: { facebook: "https://www.facebook.com/fixture", instagram: "https://www.instagram.com/fixture/" }, seo: { googleVerification: "g-from-rm", bingVerification: "BINGLIVE", titleSeparator: "-" } });
		expect(s.seo.robotsTxt).toContain("Disallow: /members/");
		expect(s.seo.robotsTxt).toContain("Sitemap: https://new.fixture.example/sitemap.xml");
		const report = readFileSync(join(paths.reports, "transform", "coverage.md"), "utf8");
		expect(report).toContain("## Site settings (Settings → General, Social Links, SEO)");
		expect(report).toMatch(/\| social\.instagram \| `https:\/\/www\.instagram\.com\/fixture\/` \| link on the live home page/);
	});
});

describe("load: settings payload and editor protection", () => {
	const ir: IrSettings = { version: 1, social: { facebook: "https://www.facebook.com/s" }, seo: { googleVerification: "g1", robotsTxt: "User-agent: *\nDisallow: /x/\n" }, timezone: "UTC", sources: {}, notCarried: [] };
	const desired = desiredSettings({ title: "Studio", tagline: "Move well" }, ir, { titleSeparator: "|", logo: { mediaId: "m-logo", alt: "Studio" } });

	it("builds flat paths and a nested payload; seo and social fields only", () => {
		expect(desired).toEqual({ title: "Studio", tagline: "Move well", logo: { mediaId: "m-logo", alt: "Studio" }, timezone: "UTC", "social.facebook": "https://www.facebook.com/s", "seo.titleSeparator": "|", "seo.googleVerification": "g1", "seo.robotsTxt": "User-agent: *\nDisallow: /x/\n" });
		const p = planSettings({ desired, current: { title: "My Site" } });
		expect(p.payload).toEqual({ title: "Studio", tagline: "Move well", logo: { mediaId: "m-logo", alt: "Studio" }, timezone: "UTC", social: { facebook: "https://www.facebook.com/s" }, seo: { titleSeparator: "|", googleVerification: "g1", robotsTxt: "User-agent: *\nDisallow: /x/\n" } });
		expect(p.written).toHaveLength(8);
		expect(Object.keys(p.record.written)).toHaveLength(8);
	});

	it("is idempotent: a second run against what it wrote sends nothing", () => {
		const first = planSettings({ desired, current: {} });
		// What GET /settings returns after the write: media resolved (url, size), robots.txt as stored.
		const current = { title: "Studio", tagline: "Move well", logo: { mediaId: "m-logo", alt: "Studio", url: "/_emdash/api/media/file/01.png", width: 200, height: 80 }, timezone: "UTC", social: { facebook: "https://www.facebook.com/s" }, seo: { titleSeparator: "|", googleVerification: "g1", robotsTxt: "User-agent: *\nDisallow: /x/" } };
		const second = planSettings({ desired, current, record: first.record });
		expect(second.payload).toEqual({});
		expect(second.unchanged).toHaveLength(8);
	});

	it("keeps a value an editor changed (or cleared) after the last load; --overwrite-settings replaces it", () => {
		const first = planSettings({ desired, current: {} });
		const current = { title: "Studio", tagline: "Move well", logo: { mediaId: "m-editor" }, timezone: "UTC", social: {}, seo: { titleSeparator: "|", googleVerification: "g1", robotsTxt: "User-agent: *\nDisallow: /x/" } };
		const kept = planSettings({ desired, current, record: first.record });
		expect(kept.kept.sort()).toEqual(["logo", "social.facebook"]);
		expect(kept.payload).toEqual({});
		// The record still holds what load wrote, so the next run keeps them too.
		expect(kept.record.written.logo).toBe(settingHash({ mediaId: "m-logo" }));
		const forced = planSettings({ desired, current, record: first.record, overwrite: true });
		expect(forced.payload).toEqual({ logo: { mediaId: "m-logo", alt: "Studio" }, social: { facebook: "https://www.facebook.com/s" } });
	});

	it("updates a value load owns when the WordPress source changed", () => {
		const first = planSettings({ desired, current: {} });
		const next = desiredSettings({ title: "Studio" }, { ...ir, timezone: "Europe/Paris" }, {});
		const p = planSettings({ desired: next, current: { title: "Studio", timezone: "UTC" }, record: first.record });
		expect(p.payload).toEqual({ timezone: "Europe/Paris" });
	});

	it("ignores a record from an earlier database (reset local site, re-provisioned target): a first load again", () => {
		const first = planSettings({ desired, current: {} });
		const p = planSettings({ desired, current: { title: "My Site", seo: { titleSeparator: "–" } }, record: first.record });
		expect(p.staleRecord).toBe(true);
		expect(p.kept).toEqual([]);
		expect(p.written).toHaveLength(8);
	});

	it("on a live production loaded before this record existed, values already there are an editor's", () => {
		const p = planSettings({ desired, current: { title: "Studio", social: { facebook: "https://www.facebook.com/new-page" } }, live: true });
		expect(p.kept).toEqual(["social.facebook"]);
		expect(p.payload).not.toHaveProperty("social");
		expect(p.payload).toHaveProperty("timezone", "UTC");
	});
});

describe("scaffold: brand file hashes for the starter", () => {
	it("records the sha1 of the original logo and favicon", () => {
		const pub = mkdtempSync(join(tmpdir(), "wp2emdash-brand-"));
		mkdirSync(join(pub, "brand"));
		writeFileSync(join(pub, "brand", "logo.png"), "logo-bytes");
		expect(brandHashes(pub, { logo: "/brand/logo.png", favicon: "/brand/missing.ico" })).toEqual({ brandSha1: { logo: createHash("sha1").update("logo-bytes").digest("hex") } });
		expect(brandHashes(pub, {})).toEqual({});
		rmSync(pub, { recursive: true, force: true });
	});
});

describe("starter: reads Settings, site.config as fallback", () => {
	const sha = "a".repeat(40);
	const cfg = { logo: { src: "/brand/h/logo.1234.webp", width: 155, height: 200 }, logoOnTop: { src: "/brand/h/logo-on-dark.5678.webp", width: 155, height: 200 }, icons: [{ rel: "icon", href: "/brand/h/favicon-32.ab.png", type: "image/png", sizes: "32x32" }, { rel: "apple-touch-icon", href: "/brand/h/apple-touch-icon.cd.png", type: "image/png", sizes: "180x180" }], logoHeight: 60, brandSha1: { logo: sha, favicon: "b".repeat(40) } };
	const media = (mediaId: string, extra: Record<string, unknown> = {}) => ({ mediaId, url: `/_emdash/api/media/file/${mediaId}.png`, contentType: "image/png", width: 400, height: 160, ...extra });

	it("without logo/favicon settings: the optimized brand files", () => {
		const b = siteBrand({}, cfg, []);
		expect(b).toMatchObject({ logo: cfg.logo, logoOnTop: cfg.logoOnTop, logoReplaced: false, faviconReplaced: false });
		expect(b.icons).toEqual(cfg.icons);
		expect(brandMediaIds({})).toEqual([]);
	});

	it("while the setting is the migrated file (same bytes, or load's converted copy): still the brand files", () => {
		const rows: MediaRow[] = [{ id: "L", content_hash: `sha1:${sha}`, filename: "studio-logo.png" }, { id: "F", content_hash: "sha1:zzz", filename: `wp2emdash-favicon-${"b".repeat(10)}.png` }];
		const b = siteBrand({ logo: media("L"), favicon: media("F") }, cfg, rows);
		expect(b).toMatchObject({ logo: cfg.logo, logoOnTop: cfg.logoOnTop, logoReplaced: false, faviconReplaced: false });
		expect(b.icons).toEqual(cfg.icons);
	});

	it("once an editor picks another logo and favicon: the media files, at the header's height, no light variant", () => {
		const b = siteBrand({ logo: media("NEW"), favicon: media("FAV", { width: 512, height: 512 }) }, cfg, [{ id: "NEW", content_hash: "sha1:other", filename: "new-logo.png" }]);
		expect(b.logo).toEqual({ src: "/_emdash/api/media/file/NEW.png", width: 150, height: 60 });
		expect(b.logoOnTop).toBeUndefined();
		// EmDash's head links the favicon itself; the home-screen icon comes from the same file when it is big enough.
		expect(b.icons).toEqual([{ rel: "apple-touch-icon", href: "/_emdash/api/media/file/FAV.png", type: "image/png" }]);
		expect(siteBrand({ favicon: media("FAV", { width: 32, height: 32 }) }, cfg, []).icons).toEqual([]);
	});

	it("reads the media rows in one query, and none without a setting", async () => {
		const queries: { q: string; v: unknown[] }[] = [];
		const db = { prepare: (q: string) => ({ bind: (...v: unknown[]) => ({ all: async <T>() => (queries.push({ q, v }), { results: [{ id: "L", content_hash: null, filename: "x" }] as T[] }) }) }) };
		expect(await brandMediaRows(db, brandMediaIds({ logo: media("L"), favicon: media("F") }))).toHaveLength(1);
		expect(queries).toEqual([{ q: "SELECT id, content_hash, filename FROM media WHERE id IN (?, ?)", v: ["L", "F"] }]);
		expect(await brandMediaRows(db, [])).toEqual([]);
		expect(queries).toHaveLength(1);
	});

	it("prints carried verification tags except those EmDash's head prints from Settings → SEO", () => {
		const carried = { "google-site-verification": "old-g", "msvalidate.01": "old-b", "p:domain_verify": "pin" };
		expect(verificationTags({ seo: { googleVerification: "new-g" } }, carried)).toEqual([["msvalidate.01", "old-b"], ["p:domain_verify", "pin"]]);
		expect(verificationTags({}, carried)).toHaveLength(3);
	});

	it("accepts handles or URLs in Social Links", () => {
		expect(socialHref("instagram", "@studio")).toBe("https://www.instagram.com/studio/");
		expect(socialHref("twitter", "studiohq")).toBe("https://x.com/studiohq");
		expect(socialHref("youtube", "UCabcdefghijklmnopqrstuv")).toBe("https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv");
		expect(socialHref("linkedin", "https://www.linkedin.com/company/studio/")).toBe("https://www.linkedin.com/company/studio/");
		expect(socialHref("facebook", "https://www.instagram.com/wrong")).toBeUndefined();
		expect(socialHref("facebook", "javascript:alert(1)")).toBeUndefined();
		expect(socialHrefFor("https://instagram.com/old", { social: { instagram: "new" } })).toBe("https://www.instagram.com/new/");
		expect(socialHrefFor("tel:+1", { social: { instagram: "new" } })).toBe("tel:+1");
	});

	const footer = [
		{
			_type: "section_columns",
			col_1_body: [
				{ _type: "block", _key: "b1", style: "normal", markDefs: [{ _type: "link", _key: "l1", href: "https://studio.example/contact/" }], children: [{ _type: "span", _key: "s1", text: "Contact us", marks: ["l1"] }, { _type: "span", _key: "s1b", text: " today", marks: [] }] },
			],
			col_2_body: [
				{ _type: "block", _key: "b2", style: "normal", markDefs: [{ _type: "link", _key: "i", href: "https://www.instagram.com/old/" }, { _type: "link", _key: "f", href: "https://facebook.com/old" }], children: [{ _type: "span", _key: "s2", text: "Instagram", marks: ["i"] }, { _type: "span", _key: "s3", text: "Facebook", marks: ["f"] }] },
			],
			col_2_social_icons: true,
		},
	];

	it("points the footer's social links at Settings, adds networks it lacks to the icon row, leaves the rest alone", () => {
		const before = JSON.stringify(footer);
		const out = withSocial(footer, { social: { instagram: "https://www.instagram.com/new/", youtube: "@studio" } });
		expect(JSON.stringify(footer)).toBe(before); // the cached entry is not mutated
		const row = out[0]?.col_2_body[0] as { markDefs: { href: string }[]; children: { text: string; marks: string[] }[] };
		expect(row.markDefs.map((d) => d.href)).toEqual(["https://www.instagram.com/new/", "https://facebook.com/old", "https://www.youtube.com/@studio"]);
		expect(row.children.map((c) => c.text)).toEqual(["Instagram", "Facebook", " ", "YouTube"]);
		expect(out[0]?.col_1_body).toEqual(footer[0]?.col_1_body);
		// Empty settings: the migrated footer as it is.
		expect(withSocial(footer, {})).toBe(footer);
	});

	it("feeds the business's sameAs from Settings", () => {
		expect(sameAsWithSocial(["https://www.instagram.com/old/", "https://www.yelp.com/biz/studio"], { social: { instagram: "new", facebook: "https://www.facebook.com/studio" } })).toEqual(["https://www.instagram.com/new/", "https://www.yelp.com/biz/studio", "https://www.facebook.com/studio"]);
	});
});
