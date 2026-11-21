/**
 * Multilingual sites (WPML, Polylang): src/transform/multilingual.ts, the transform phase on synthetic WPML and
 * Polylang sites (golden: test/golden/multilingual/<name>.json — regenerate after an intended change with
 * UPDATE_GOLDEN=1 pnpm test), the starter's routing / hreflang / switcher rules (starter/src/utils/i18n.ts, held to
 * the kit's copy), verify's hreflang checks, per-language menu names and the seed's language fields.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { importOptions } from "../src/commands/import-options.js";
import { kitConfigSchema } from "../src/config/schema.js";
import { sitePaths } from "../src/core/paths.js";
import type { IrPage, IrSite } from "../src/ir/schema.js";
import { runTransform } from "../src/phases/transform.js";
import { seedLanguages } from "../src/scaffold/seed.js";
import { emdashMenuNames } from "../src/transform/menus.js";
import { buildPlan, codesFor, entryLanguages, hreflangAlternates, inheritMenuRoles, langOfPath, localizeRoute, matchCode, menuLanguage, type MlDoc, type MlPlan, multilingualChecks, urlModeFromHreflang, urlModeFromOptions } from "../src/transform/multilingual.js";
import { hreflangParity, reciprocityProblems } from "../src/verify/hreflang.js";
import * as starter from "../starter/src/utils/i18n.js";

const fixtures = join(import.meta.dirname, "fixtures", "multilingual");
const golden = join(import.meta.dirname, "golden", "multilingual");
const update = process.env.UPDATE_GOLDEN === "1";

interface Fixture {
	probe: Record<string, unknown>;
	options: Record<string, unknown>;
	multilingual?: Record<string, unknown>;
	content: Record<string, { id: number; slug: string; title: string; text: string; parent?: number; locale?: string; translation_group?: number; taxonomies?: Record<string, unknown> }[]>;
	menus: unknown[];
	urls: { path: string; wp: { id: number } }[];
	snapshots: { name: string; wpId: number; url: string; hreflang: { lang: string; href: string }[] }[];
}

const put = (file: string, data: unknown) => {
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data));
};

/** A site workspace from a fixture: what extract and the audit would have written. */
function siteFrom(name: string, dir: string) {
	const fx = JSON.parse(readFileSync(join(fixtures, `${name}.json`), "utf8")) as Fixture;
	const paths = sitePaths(name, dir);
	const host = new URL(fx.snapshots[0]?.url ?? "https://example.test/").origin;
	put(join(paths.raw, "extract.json"), {});
	put(join(paths.raw, "exporter", "probe.json"), fx.probe);
	put(join(paths.raw, "exporter", "options.json"), fx.options);
	put(join(paths.raw, "exporter", "menus.json"), fx.menus);
	put(join(paths.raw, "exporter", "taxonomies.json"), []);
	put(join(paths.raw, "exporter", "analyze.json"), { authors: [], attachments: { count: 0 } });
	if (fx.multilingual) put(join(paths.raw, "multilingual.json"), fx.multilingual);
	for (const [type, list] of Object.entries(fx.content)) {
		put(
			join(paths.raw, "exporter", "content", `${type}.json`),
			list.map((e) => ({ id: e.id, post_type: type, status: "publish", slug: e.slug, title: e.title, content: `<!-- wp:paragraph --><p>${e.text}</p><!-- /wp:paragraph -->`, excerpt: "", date_gmt: "2024-05-10 09:00:00", modified_gmt: "2024-05-10 09:00:00", parent: e.parent ?? null, menu_order: 0, taxonomies: e.taxonomies ?? {}, meta: {}, ...(e.locale ? { locale: e.locale } : {}), ...(e.translation_group !== undefined ? { translation_group: e.translation_group } : {}) })),
		);
	}
	put(join(paths.snapshot, "urls.json"), fx.urls.map((u) => ({ url: `${host}${u.path}`, path: u.path, status: 200, kind: "page", wp: u.wp })));
	put(join(paths.snapshot, "discovery.json"), { items: [], terms: [], authors: [], media: [] });
	for (const s of fx.snapshots) put(join(paths.snapshot, "pages", `${s.name}.json`), { wpId: s.wpId, url: s.url, seo: { hreflang: s.hreflang } });
	const config = kitConfigSchema.parse({ slug: name, name, source: { url: host }, target: { productionUrl: host } });
	return { paths, config };
}

const listJson = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? listJson(join(dir, d.name)) : d.name.endsWith(".json") ? [join(dir, d.name)] : [])) : []);

describe("transform phase on multilingual sites (golden)", () => {
	const dir = mkdtempSync(join(tmpdir(), "wp2e-ml-"));
	for (const name of ["wpml", "polylang"]) {
		it(`${name}: languages, routes, translation groups, menus, gates and report`, async () => {
			const { paths, config } = siteFrom(name, dir);
			const checks = await runTransform({ config, paths, reporter: { runId: "t", emit: () => {} } });
			const site = JSON.parse(readFileSync(join(paths.ir, "site.json"), "utf8")) as IrSite;
			const docs = listJson(paths.ir)
				.filter((f) => /\/(pages|posts|partials)\//.test(f))
				.map((f) => ({ file: relative(paths.ir, f), doc: JSON.parse(readFileSync(f, "utf8")) as IrPage }))
				.sort((a, b) => a.file.localeCompare(b.file))
				.map(({ file, doc }) => ({ file, kind: doc.kind, path: doc.route?.path ?? null, i18n: doc.i18n ?? null, title: doc.title }));
			const report = readFileSync(join(paths.reports, "transform", "coverage.md"), "utf8");
			const section = report.slice(report.indexOf("## Languages"), report.indexOf("\n## ", report.indexOf("## Languages") + 5) > 0 ? report.indexOf("\n## ", report.indexOf("## Languages") + 5) : undefined).trim();
			const out = {
				i18n: site.i18n,
				docs,
				menus: site.menus.map((m, i) => ({ name: m.name, role: m.role, lang: m.lang ?? null, emdash: emdashMenuNames(site.menus)[i], items: m.items.map((x) => x.href) })),
				partials: site.partials,
				checks: checks.filter((c) => c.id.startsWith("languages")),
				report: section.split("\n"),
			};
			const file = join(golden, `${name}.json`);
			if (update || !existsSync(file)) writeFileSync(file, `${JSON.stringify(out, null, "\t")}\n`);
			expect(out).toEqual(JSON.parse(readFileSync(file, "utf8")));
			// Every language gate green on a supported directory-mode site.
			for (const c of out.checks) expect(c.ok, `${c.id}: ${c.detail}`).toBe(true);
		});
	}
});

const dirPlan = (over: Partial<MlPlan> = {}): MlPlan => ({
	plugin: "wpml",
	defaultLang: "en",
	languages: [
		{ code: "en", prefix: "", hreflang: "en", label: "English", default: true },
		{ code: "fr", prefix: "fr", hreflang: "fr", label: "Français", default: false },
		{ code: "pt-br", prefix: "br", hreflang: "pt-BR", label: "Português (Brasil)", default: false },
	],
	urlMode: "directory",
	defaultPrefixed: false,
	modeSource: "options",
	supported: true,
	problems: [],
	...over,
});

describe("language plan", () => {
	const post = (id: number, extra: Record<string, unknown> = {}) => ({ id, post_type: "page", slug: `p${id}`, status: "publish", ...extra });

	it("reads the URL mode from WPML's and Polylang's settings", () => {
		expect(urlModeFromOptions("wpml", { icl_sitepress_settings: { language_negotiation_type: 1, default_language: "en", urls: { directory_for_default_language: 0 } } })).toEqual({ mode: "directory", defaultPrefixed: false, defaultLang: "en" });
		expect(urlModeFromOptions("wpml", { icl_sitepress_settings: { language_negotiation_type: "1", urls: { directory_for_default_language: "1" } } })).toEqual({ mode: "directory", defaultPrefixed: true });
		expect(urlModeFromOptions("wpml", { icl_sitepress_settings: { language_negotiation_type: 2, language_domains: { fr: "fr.example.test" } } })?.mode).toBe("subdomain");
		expect(urlModeFromOptions("wpml", { icl_sitepress_settings: { language_negotiation_type: 2, language_domains: { fr: "example.fr" } } })?.mode).toBe("domain");
		expect(urlModeFromOptions("wpml", { icl_sitepress_settings: { language_negotiation_type: 3 } })?.mode).toBe("query");
		expect(urlModeFromOptions("polylang", { polylang: { force_lang: 1, hide_default: 1, default_lang: "fr" } })).toEqual({ mode: "directory", defaultPrefixed: false, defaultLang: "fr" });
		expect(urlModeFromOptions("polylang", { polylang: { force_lang: 1, hide_default: 0 } })?.defaultPrefixed).toBe(true);
		expect(urlModeFromOptions("polylang", { polylang: { force_lang: 0 } })?.mode).toBe("content");
		expect(urlModeFromOptions("polylang", { polylang: { force_lang: 2 } })?.mode).toBe("subdomain");
		expect(urlModeFromOptions("polylang", { polylang: { force_lang: 3 } })?.mode).toBe("domain");
		expect(urlModeFromOptions("wpml", {})).toBeUndefined();
	});

	it("infers the URL mode from the live hreflang links", () => {
		const page = (hreflang: { lang: string; href: string }[]) => [{ url: "https://example.test/about/", hreflang }];
		expect(urlModeFromHreflang(page([{ lang: "en", href: "https://example.test/about/" }, { lang: "fr-FR", href: "https://example.test/fr/a-propos/" }]), ["en", "fr"], "en")).toEqual({ mode: "directory", defaultPrefixed: false });
		expect(urlModeFromHreflang(page([{ lang: "en", href: "https://example.test/en/about/" }, { lang: "fr", href: "https://example.test/fr/a-propos/" }]), ["en", "fr"], "en")).toEqual({ mode: "directory", defaultPrefixed: true });
		expect(urlModeFromHreflang(page([{ lang: "fr", href: "https://fr.example.test/a-propos/" }]), ["en", "fr"], "en")?.mode).toBe("subdomain");
		expect(urlModeFromHreflang(page([{ lang: "fr", href: "https://exemple.fr/a-propos/" }]), ["en", "fr"], "en")?.mode).toBe("domain");
		expect(urlModeFromHreflang(page([{ lang: "fr", href: "https://example.test/about/?lang=fr" }]), ["en", "fr"], "en")?.mode).toBe("query");
		expect(urlModeFromHreflang([], ["en"], "en")).toBeUndefined();
	});

	it("matches locales and hreflang values to the site's language codes", () => {
		expect(matchCode("fr-FR", ["en", "fr"])).toBe("fr");
		expect(matchCode("pt_BR", ["pt-br", "pt-pt"])).toBe("pt-br");
		expect(matchCode("pt", ["pt-br", "pt-pt"])).toBeUndefined();
		expect([...codesFor(["en_US", "fr_FR", "pt_BR", "pt_PT"])]).toEqual([["en-us", "en"], ["fr-fr", "fr"], ["pt-br", "pt-br"], ["pt-pt", "pt-pt"]]);
	});

	it("takes each entry's language from the exporter, else Polylang's taxonomies, else WPML's table", () => {
		const codeOf = (l: string) => l.slice(0, 2).toLowerCase();
		const langs = entryLanguages(
			[post(1, { locale: "fr-FR", translation_group: 7 }), post(2, { taxonomies: { language: [{ id: 1, name: "English", slug: "en" }], post_translations: [{ id: 9, name: "pll_x", slug: "pll_x" }] } }), post(3), post(4)],
			{ wpml: [{ element_id: 3, element_type: "post_page", trid: 55, language_code: "de" }] },
			codeOf,
		);
		expect(Object.fromEntries(langs)).toEqual({ 1: { lang: "fr", group: "g-7" }, 2: { lang: "en", group: "pll-pll_x" }, 3: { lang: "de", group: "trid-55" }, 4: { group: "page-4" } });
	});

	it("is undefined on a single-language site", () => {
		expect(buildPlan({ raw: {}, posts: [post(1)] })).toBeUndefined();
	});

	it("stops for a decision on subdomains, domains, ?lang= and a prefixed default language", () => {
		const posts = [post(1, { locale: "en" }), post(2, { locale: "fr" })];
		const plan = (settings: Record<string, unknown>) => buildPlan({ raw: { probe: { plugin: "wpml", default_locale: "en" }, options: { icl_sitepress_settings: settings } }, posts })?.plan;
		expect(plan({ language_negotiation_type: 1 })).toMatchObject({ supported: true, urlMode: "directory", problems: [] });
		for (const [settings, mode] of [[{ language_negotiation_type: 2, language_domains: { fr: "fr.example.test" } }, "subdomain"], [{ language_negotiation_type: 2, language_domains: { fr: "example.fr" } }, "domain"], [{ language_negotiation_type: 3 }, "query"]] as const) {
			const p = plan(settings);
			expect(p?.urlMode).toBe(mode);
			expect(p?.supported).toBe(false);
			expect(p?.problems.join(" ")).toMatch(/owner decision/);
		}
		const prefixed = plan({ language_negotiation_type: 1, urls: { directory_for_default_language: 1 } });
		expect(prefixed).toMatchObject({ supported: false, defaultPrefixed: true });
		expect(prefixed?.languages.find((l) => l.code === "en")?.prefix).toBe("en");
		// No settings, no hreflang, no audited translation: unknown, reported.
		expect(buildPlan({ raw: { probe: { plugin: "polylang" } }, posts })?.plan).toMatchObject({ urlMode: "unknown", supported: false });
		// Polylang "language from the content": no prefix anywhere, the paths are unique — migrated as is.
		expect(buildPlan({ raw: { options: { polylang: { force_lang: 0, default_lang: "en" } } }, posts })?.plan).toMatchObject({ urlMode: "content", supported: true });
	});

	it("takes the language directory from the audited paths when it differs from the code", () => {
		const posts = [post(1, { locale: "en" }), post(2, { locale: "pt-BR" }), post(3, { locale: "pt-BR" })];
		const plan = buildPlan({ raw: { probe: { plugin: "wpml", default_locale: "en" }, options: { icl_sitepress_settings: { language_negotiation_type: 1 } } }, posts, pathById: new Map([[2, "/br/"], [3, "/br/sobre/"]]) })?.plan;
		expect(plan?.languages.map((l) => [l.code, l.prefix])).toEqual([["en", ""], ["pt", "br"]]);
	});
});

describe("routes, hreflang and the language switcher", () => {
	const plan = dirPlan();
	const cfg: starter.I18nConfig = { defaultLang: plan.defaultLang, languages: plan.languages.map(({ code, prefix, hreflang, label }) => ({ code, prefix, hreflang, label })) };

	it("puts a translation in its language directory (once), never the default language", () => {
		expect(localizeRoute("/about/", "fr", plan)).toBe("/fr/about/");
		expect(localizeRoute("/fr/a-propos/", "fr", plan)).toBe("/fr/a-propos/");
		expect(localizeRoute("/", "fr", plan)).toBe("/fr/");
		expect(localizeRoute("/about/", "en", plan)).toBe("/about/");
		expect(localizeRoute("/sobre/", "pt-br", plan)).toBe("/br/sobre/");
		expect(localizeRoute("/about/", undefined, plan)).toBe("/about/");
		expect(localizeRoute("/about/", "fr", dirPlan({ urlMode: "content" }))).toBe("/about/");
		expect(localizeRoute("/about/", "fr", dirPlan({ supported: false }))).toBe("/about/");
	});

	it("reads a path's language from its first segment only (kit and starter agree)", () => {
		for (const [path, lang] of [["/fr/a-propos/", "fr"], ["/fr/", "fr"], ["/about/", "en"], ["/", "en"], ["/menu/fr/", "en"], ["/br/sobre/", "pt-br"], ["/france/", "en"]] as const) {
			expect(langOfPath(path, plan)).toBe(lang);
			expect(starter.langOfPath(path, cfg).code).toBe(lang);
		}
	});

	it("maps entry slugs to paths (front page and language homes)", () => {
		expect(starter.pathOfSlug("home")).toBe("/");
		expect(starter.pathOfSlug("fr")).toBe("/fr/");
		expect(starter.pathOfSlug("fr/a-propos")).toBe("/fr/a-propos/");
		expect(starter.pathOfSlug("fr/a-propos", "never")).toBe("/fr/a-propos");
		expect(starter.homeOf(cfg.languages[1] as starter.I18nLanguage)).toBe("/fr/");
		expect(starter.homeOf(cfg.languages[0] as starter.I18nLanguage)).toBe("/");
	});

	it("announces self, every translation and x-default on the default language — the same in kit and starter", () => {
		const translations = [{ lang: "fr", slug: "fr/a-propos" }, { lang: "en", slug: "about" }];
		const want = [{ hreflang: "en", href: "https://example.test/about/" }, { hreflang: "fr", href: "https://example.test/fr/a-propos/" }, { hreflang: "x-default", href: "https://example.test/about/" }];
		expect(starter.hreflangAlternates(translations, cfg, "https://example.test")).toEqual(want);
		expect(hreflangAlternates(translations.map((t) => ({ lang: t.lang, path: starter.pathOfSlug(t.slug) })), plan, "https://example.test")).toEqual(want);
		// The live site's hreflang value (pt-BR), not the code.
		expect(starter.hreflangAlternates([{ lang: "en", slug: "home" }, { lang: "pt-br", slug: "br" }], cfg, "https://example.test").map((a) => a.hreflang)).toEqual(["en", "pt-BR", "x-default"]);
		// No default-language version: no x-default. A page alone: no set at all.
		expect(starter.hreflangAlternates([{ lang: "fr", slug: "fr/x" }, { lang: "pt-br", slug: "br/x" }], cfg, "https://example.test").map((a) => a.hreflang)).toEqual(["fr", "pt-BR"]);
		expect(starter.hreflangAlternates([{ lang: "en", slug: "contact" }], cfg, "https://example.test")).toEqual([]);
		expect(hreflangAlternates([{ lang: "en", path: "/contact/" }], plan, "https://example.test")).toEqual([]);
	});

	it("produces reciprocal alternates for every page of a group", () => {
		const group = [{ lang: "en", slug: "about" }, { lang: "fr", slug: "fr/a-propos" }, { lang: "pt-br", slug: "br/sobre" }];
		const pages = group.map((g) => ({ path: starter.pathOfSlug(g.slug), hreflang: starter.hreflangAlternates(group, cfg, "https://example.test").map((a) => ({ lang: a.hreflang, href: a.href })) }));
		expect(reciprocityProblems(pages)).toEqual([]);
	});

	it("links the switcher to the page's translation, else to the language's home", () => {
		const fr = cfg.languages[1] as starter.I18nLanguage;
		expect(starter.switcherLinks(fr, [{ lang: "en", slug: "about" }, { lang: "fr", slug: "fr/a-propos" }], cfg)).toEqual([
			{ code: "en", label: "English", hreflang: "en", href: "/about/", current: false, home: false },
			{ code: "fr", label: "Français", hreflang: "fr", href: "/fr/a-propos/", current: true, home: false },
			{ code: "pt-br", label: "Português (Brasil)", hreflang: "pt-BR", href: "/br/", current: false, home: true },
		]);
		expect(starter.switcherLinks(cfg.languages[0] as starter.I18nLanguage, [], cfg, "never").map((l) => l.href)).toEqual(["/", "/fr", "/br"]);
	});

	it("picks the language's own menu name", () => {
		expect(starter.menuNameFor("primary", cfg.languages[0] as starter.I18nLanguage, cfg)).toBe("primary");
		expect(starter.menuNameFor("primary", cfg.languages[1] as starter.I18nLanguage, cfg)).toBe("primary-fr");
	});
});

describe("menus per language", () => {
	it("names a translated menu after its role plus the language", () => {
		const m = (name: string, role: IrSite["menus"][number]["role"], lang?: string) => ({ name, role, wpLocations: [], items: [], ...(lang ? { lang } : {}) });
		expect(emdashMenuNames([m("Main", "primary"), m("Principal", "primary", "fr"), m("Footer", "footer"), m("Pied", "footer", "fr"), m("Extra", "other", "fr"), m("Haupt", "primary", "de")])).toEqual(["primary", "primary-fr", "footer", "footer-fr", "extra-fr", "primary-de"]);
		// Single-language sites: unchanged.
		expect(emdashMenuNames([m("Main", "primary"), m("Other", "primary")])).toEqual(["primary", "other"]);
	});

	it("finds a menu's language and inherits the role of its default-language twin", () => {
		const plan = dirPlan();
		expect(menuLanguage({ locations: ["primary___fr"], items: [] }, plan)).toBe("fr");
		expect(menuLanguage({ id: 7, locations: [], items: [] }, plan, [{ element_id: 7, element_type: "tax_nav_menu", trid: 1, language_code: "fr" }])).toBe("fr");
		expect(menuLanguage({ locations: [], items: [{ url: "https://example.test/fr/a/" }, { url: "/fr/b/" }, { url: "/c/" }] }, plan, [], new Set(["example.test"]))).toBe("fr");
		expect(menuLanguage({ locations: ["primary"], items: [{ url: "/about/" }] }, plan)).toBe("en");
		const menus = inheritMenuRoles(
			[
				{ id: 1, role: "primary", wpLocations: ["primary"] },
				{ id: 2, role: "other", lang: "fr", wpLocations: [] },
				{ id: 3, role: "other", lang: "de", wpLocations: [] },
				{ id: 4, role: "other", lang: "it", wpLocations: [] },
				{ id: 5, role: "other", lang: "it", wpLocations: [] },
			],
			[{ element_id: 1, element_type: "tax_nav_menu", trid: 9, language_code: "en" }, { element_id: 2, element_type: "tax_nav_menu", trid: 9, language_code: "fr" }],
		);
		expect(menus.map((x) => x.role)).toEqual(["primary", "primary", "primary", "other", "other"]);
	});
});

describe("language gates", () => {
	const doc = (o: Partial<MlDoc>): MlDoc => ({ kind: "page", wpId: 1, type: "page", path: "/", published: true, lang: "en", group: "g1", ...o });

	it("pass on a clean site and name what is wrong otherwise", () => {
		const ok = multilingualChecks(dirPlan(), [doc({}), doc({ wpId: 2, path: "/fr/", lang: "fr" })]);
		expect(ok.map((c) => [c.id, c.ok])).toEqual([["languages-url-mode", true], ["languages-assigned", true], ["languages-groups", true], ["languages-routes", true]]);
		const bad = multilingualChecks(dirPlan(), [doc({}), doc({ wpId: 2, path: "/fr/", lang: "fr" }), doc({ wpId: 3, path: "/x/", lang: undefined, group: "g3" }), doc({ wpId: 4, path: "/a/", group: "g1" }), doc({ wpId: 5, path: "/b/", lang: "fr", group: "g5" })]);
		expect(bad.find((c) => c.id === "languages-assigned")).toMatchObject({ ok: false, detail: expect.stringContaining("page#3 /x/") });
		expect(bad.find((c) => c.id === "languages-groups")).toMatchObject({ ok: false, detail: expect.stringContaining("g1:") });
		expect(bad.find((c) => c.id === "languages-routes")).toMatchObject({ ok: false, detail: "/b/ is fr" });
		const unsupported = multilingualChecks(dirPlan({ supported: false, urlMode: "query", problems: ["language in the query string"] }), [doc({})]);
		expect(unsupported.find((c) => c.id === "languages-url-mode")).toMatchObject({ ok: false, detail: expect.stringContaining("query string") });
		expect(unsupported.some((c) => c.id === "languages-routes")).toBe(false);
		// An entry of a post type the plugin does not translate has no language: reported, not a gate failure.
		expect(multilingualChecks(dirPlan(), [doc({}), doc({ kind: "entry", type: "team", wpId: 9, path: "/team/ana/", lang: undefined, group: "team-9" })]).find((c) => c.id === "languages-assigned")?.ok).toBe(true);
	});
});

describe("verify: hreflang", () => {
	it("finds alternates that do not point back, and differences from the live page", () => {
		const a = { path: "/about/", hreflang: [{ lang: "en", href: "https://x.test/about/" }, { lang: "fr", href: "https://x.test/fr/a-propos/" }] };
		const b = { path: "/fr/a-propos/", hreflang: [{ lang: "fr", href: "https://x.test/fr/a-propos/" }] };
		expect(reciprocityProblems([a, b])).toEqual(["/about/ → /fr/a-propos/: /fr/a-propos/ does not link back"]);
		expect(reciprocityProblems([a])).toEqual(["/about/ → /fr/a-propos/: alternate not checked (not among the verified pages)"]);
		expect(reciprocityProblems([{ path: "/x/", hreflang: [{ lang: "fr", href: "/fr/x/" }] }, { path: "/fr/x/", hreflang: [{ lang: "fr", href: "/fr/x/" }, { lang: "en", href: "/x/" }] }])).toContain("/x/: no self-referencing hreflang");
		// Live (WordPress host) vs migrated (staging host): compared as paths.
		expect(hreflangParity([{ lang: "en", href: "https://old.test/about/" }, { lang: "fr", href: "https://old.test/fr/a-propos/" }, { lang: "x-default", href: "https://old.test/about/" }], [{ lang: "en", href: "https://new.test/about/" }, { lang: "fr", href: "https://new.test/fr/a-propos/" }, { lang: "x-default", href: "https://new.test/about/" }])).toEqual([]);
		expect(hreflangParity([{ lang: "fr", href: "https://old.test/fr/a-propos/" }], [{ lang: "fr", href: "https://new.test/fr/about/" }, { lang: "de", href: "/de/" }])).toEqual(["fr: /fr/about/ instead of /fr/a-propos/", "extra de → /de/"]);
	});
});

describe("database dump → raw/multilingual.json (import-options)", () => {
	it("keeps WPML's URL settings (site key dropped) and its translations table, nothing else", async () => {
		const dir = mkdtempSync(join(tmpdir(), "wp2e-ml-dump-"));
		const paths = sitePaths("dump", dir);
		mkdirSync(paths.raw, { recursive: true });
		await importOptions("dump", join(fixtures, "database.sql"), dir);
		const text = readFileSync(join(paths.raw, "multilingual.json"), "utf8");
		const raw = JSON.parse(text);
		expect(raw.options.icl_sitepress_settings).toEqual({ default_language: "en", language_negotiation_type: 1, urls: { directory_for_default_language: 0 } });
		expect(raw.wpml).toEqual([
			{ element_id: "3", element_type: "post_page", trid: "20", language_code: "en", source_language_code: null },
			{ element_id: "13", element_type: "post_page", trid: "20", language_code: "fr", source_language_code: "en" },
			{ element_id: "2", element_type: "tax_nav_menu", trid: "900", language_code: "fr", source_language_code: "en" },
		]);
		expect(text).not.toMatch(/SECRET|not-read|Atelier/);
		expect(urlModeFromOptions("wpml", raw.options)).toEqual({ mode: "directory", defaultPrefixed: false, defaultLang: "en" });
	});
});

describe("seed: language fields", () => {
	it("adds lang and translation_group to tagged collections and their entries", () => {
		const page = (path: string, lang: string, group: string) => ({ kind: "page", route: { path }, source: { slug: path, wpId: 1 }, i18n: { lang, group } }) as unknown as IrPage;
		const seed = { collections: [{ slug: "pages", fields: [{ slug: "title" }] }, { slug: "site_parts", fields: [{ slug: "title" }] }], content: { pages: [{ slug: "home", data: { title: "Home" } }, { slug: "fr", data: { title: "Accueil" } }, { slug: "contact", data: { title: "Contact" } }] } };
		seedLanguages(seed, [page("/", "en", "g1"), page("/fr/", "fr", "g1")]);
		expect(seed.collections[0]?.fields.map((f) => f.slug)).toEqual(["title", "lang", "translation_group"]);
		expect(seed.collections[1]?.fields.map((f) => f.slug)).toEqual(["title"]);
		expect(seed.content.pages.map((e) => e.data)).toEqual([{ title: "Home", lang: "en", translation_group: "g1" }, { title: "Accueil", lang: "fr", translation_group: "g1" }, { title: "Contact" }]);
	});
});

describe("starter wiring", () => {
	const read = (f: string) => readFileSync(join(import.meta.dirname, "..", "starter", "src", f), "utf8");
	it("prints <html lang>, hreflang links and the switcher; menus and blog listings per language", () => {
		const base = read("layouts/Base.astro");
		expect(base).toContain("<html lang={langs?.lang.hreflang ?? site.lang}");
		expect(base).toContain('{langs?.alternates.map((a) => <link rel="alternate" hreflang={a.hreflang} href={a.href} />)}');
		expect(base).toContain("<SiteHeader languages={langs?.switcher ?? []}");
		expect(read("components/SiteHeader.astro")).toContain("<LanguageSwitcher links={languages} />");
		expect(read("utils/chrome.ts")).toContain('menuFor("primary", pathname)');
		expect(read("utils/blog-data.ts")).toContain("lang: defaultLang");
		expect(read("pages/[...slug].astro").match(/group: data\.translation_group, lang: data\.lang/g)).toHaveLength(3);
		const sw = read("components/LanguageSwitcher.astro");
		expect(sw).toContain('aria-current={l.current ? "true" : undefined}');
		expect(sw).not.toContain("<script");
	});
});
