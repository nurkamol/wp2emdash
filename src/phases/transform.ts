/**
 * Phase 3 — transform. raw/ (extract) → ir/ (Section IR, PLAN §2.1) + coverage report.
 * Pure function of raw/ + overrides.ts: reruns reproduce the same IR. Never hand-edit ir/.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { adaptBricks, bricksDesign, type BricksElement, bricksElements, bricksSite, isBricks, liveVariables, siteTemplates, templateElements, templateType } from "../adapters/bricks/index.js";
import { bricksEntranceAnimations, bricksHeaderLook, bricksLayout } from "../adapters/bricks/layout.js";
import { headerButtons, headerMenu, nestedNavItems } from "../adapters/bricks/menus.js";
import { readBricksOptions } from "../extract/bricks.js";
import { activeKit, adaptElementor, elementorDesign, elementorElements, elementorEntranceAnimations, elementorKit, isElementor, popupAutoOpen, siteTemplates as elementorSiteTemplates, templateType as elementorTemplateType } from "../adapters/elementor/index.js";
import { readElementorOptions } from "../extract/elementor.js";
import { adaptDivi, diviDesign, diviSite, isDivi, themeBuilderParts } from "../adapters/divi/index.js";
import { adaptDomFallback, type FallbackReason, fallbackReason, liveContentWords } from "../adapters/dom-fallback/index.js";
import { readDiviOptions } from "../extract/divi.js";
import type { FormDefinitionOut } from "../scaffold/forms.js";
import { adaptGutenberg } from "../adapters/gutenberg/index.js";
import { adaptWpbakery } from "../adapters/wpbakery/index.js";
import { loadOverrides } from "../config/overrides.js";
import { currentYear } from "../transform/year.js";
import type { GateCheck } from "../core/state.js";
import { Keys } from "../ir/portable-text.js";
import { applyBusinessOverride, businessFromJsonLd } from "../transform/business.js";
import { completeMarianaEmbeds, marianaTenant } from "../transform/embeds.js";
import { collectSnippets, completeProviderLoaders, providerLoaders, settleLoaders } from "../transform/snippets.js";
import { consentReport, planConsent } from "../transform/consent.js";
import { type Diagnostic, type IrEntry, IR_VERSION, type IrMenuItem, type IrPage, irPage, type IrPost, type IrSite, irSite, type MediaRef, type Section, type SectionType } from "../ir/schema.js";
import { conservation, irText, missingContext, sourceText } from "../transform/coverage.js";
import { buildSettings, irSettings, settingsReport } from "../transform/settings.js";
import { contentInventory, HANDLED_TYPES, INTERNAL_TAXONOMIES, INTERNAL_TYPES, inventoryDetail, inventoryReport } from "../transform/content-types.js";
import { type AnalyzeType, completeOptions, type ContentTypeDecision, type CptEntrySource, type CptPlan, cptReport, entryData, planCollections, proposal, type WpRestType } from "../transform/cpt.js";
import { fieldGroups } from "../transform/cpt-sources.js";
import { exporterFacts, extensionsOf, PRODUCT_TAXONOMIES, PRODUCT_TYPE, PRODUCTS_COLLECTION, type ProductPost, productFields, productMeta, type ShopFacts, shopDecisions, shopGate, shopReport, type WooPageRole, wooPageRole } from "../transform/shop.js";
import { fieldsForType } from "../transform/cpt-fields.js";
import { type CustomCss, customCssFromHtml, customCssReport, describeCss } from "../transform/custom-css.js";
import { baseOf, buildWpUrlPlan, type WpUrlInput, wpUrlsReport } from "../transform/wp-urls.js";
import { type CommentsPlan, type CommentTarget, commentsGate, commentsReport, discussionSettings, planComments, type WpComment } from "../transform/comments.js";
import { type BlogByline, blogIndexPath, type BlogPlan, blogReport, blogTaxonomies, bylineSlug, convertPostBody, feedSettings, permalinkPath, type WpTaxonomy, wpGmtToIso } from "../transform/blog.js";
import { applyMeasuredPadding } from "../transform/measured.js";
import { pageAttributes, pageAttributesReport, showsFeaturedImage } from "../transform/pages.js";
import { planSections, sectionsReport } from "../transform/sections.js";
import { SEO_TERMMETA_FILE, termSeoPlan, termSeoReport } from "../transform/term-meta.js";
import { entrySocial, resolveSeoVars, seoSeparator } from "../transform/social-seo.js";
import { inviteCounts, planInvites, usersDir, usersReport, type WpUser, WP_USERS_FILE, writeInvites } from "../transform/users.js";
import { type AnnouncementReport, transformReport } from "../transform/report.js";
import { shortcodeSummary, shortcodesReport } from "../transform/shortcodes.js";
import { loadSiteEnv } from "../extract/credentials.js";
import { decide, isPasswordFormHtml, PROTECTED_FILE, type ProtectedEntry, type ProtectedKind } from "../transform/protected.js";
import { announcementDoc, describeBar, detectAnnouncement } from "../transform/announcement.js";
import { emdashMenuNames, isMegaClass, megaItems, megaMenuIds, menusReport, ownClasses, type WpMenuItemRest } from "../transform/menus.js";
import { breadcrumbsOf, headerSearch, maintenancePlugin, notFoundContent, notFoundDoc, type SiteFeatures, siteFeaturesReport } from "../transform/site-features.js";
import type { FolderSource } from "../extract/media-folders.js";
import { folderInputs, mediaFoldersReport, planMediaFolders } from "../transform/media-folders.js";
import { planWidgets, type WpSidebar, type WpWidget, widgetsFromOptions, widgetsReport } from "../transform/widgets.js";
import type { BricksBox, RootVariables, ScreenshotResult } from "../audit/browser.js";
import type { ExporterPost, MediaEntry } from "./extract.js";
import type { PhaseContext } from "./index.js";

const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_]+/g, "-");
const readJson = <T>(file: string): T | undefined => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined);
const write = (file: string, data: unknown) => {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
};

export type Builder = IrPage["source"]["builder"];
export function detectBuilder(content: string, meta?: Record<string, unknown>): Builder {
	// Bricks keeps the page in post meta; post_content holds at most a fallback copy.
	if (isBricks(meta)) return "bricks";
	// Elementor keeps the page as a JSON tree in post meta; post_content is a plain fallback copy.
	if (isElementor(meta)) return "elementor";
	if (!content.trim()) return "empty";
	// Divi 4 shortcodes (`[et_pb_section]`) or Divi 5 blocks (`<!-- wp:divi/… -->`) in post_content.
	if (isDivi(content, meta)) return "divi";
	if (/\[vc_(row|column|section)\b/.test(content)) return "wpbakery";
	if (/<!--\s+wp:/.test(content)) return "gutenberg";
	return "classic";
}

interface MenuRaw {
	id?: number;
	name: string;
	locations: string[];
	items: { id: number; parent_id: number | null; sort_order: number; type: string; object: string; object_id: number; url: string; title: string; target: string; classes: string | string[] | null; description?: string; attr_title?: string }[];
}

export interface DocResult {
	file: string;
	doc: IrPage;
	published: boolean;
	conservation?: { ratio: number; sourceWords: number; missing: string[]; context: string[] };
}

export async function runTransform({ config, paths, reporter }: PhaseContext): Promise<GateCheck[]> {
	const checks: GateCheck[] = [];
	const check = (id: string, label: string, ok: boolean, detail?: string) => checks.push({ id, label, ok, ...(detail ? { detail } : {}) });
	const exp = join(paths.raw, "exporter");
	if (!existsSync(join(paths.raw, "extract.json"))) {
		check("extract-present", "Extract output present", false, "Run the extract phase first (raw/extract.json missing)");
		return checks;
	}
	const overrides = await loadOverrides(paths.overrides);
	const content = (type: string) => readJson<ExporterPost[]>(join(exp, "content", `${type}.json`)) ?? [];
	const options = readJson<Record<string, unknown>>(join(exp, "options.json")) ?? {};
	const menusRaw = readJson<MenuRaw[]>(join(exp, "menus.json")) ?? [];
	// Description, title attribute and classes per item from WordPress's REST API (extract: raw/menu-items.json).
	const menuItemsRest = new Map((readJson<WpMenuItemRest[]>(join(paths.raw, "menu-items.json")) ?? []).map((i) => [i.id, i]));
	const manifest = readJson<MediaEntry[]>(join(paths.raw, "media-manifest.json")) ?? [];
	// Section boxes from the audit screenshots: real padding per source row (desktop + phone).
	const shots = readJson<ScreenshotResult[]>(join(paths.snapshot, "screens.json")) ?? [];
	const boxesFor = (path: string) => {
		const at = (vp: string) => shots.find((x) => x.viewport === vp && (() => { try { return new URL(x.url).pathname === path; } catch { return false; } })())?.sections;
		return { desktop: at("desktop"), tablet: at("tablet"), mobile: at("mobile") };
	};
	// Bricks: every live element's measured box by page and position (gaps, widths, text sizes), from the same screenshots.
	const bricksBoxes = new Map<string, Partial<Record<"desktop" | "tablet" | "mobile", BricksBox>>>();
	for (const s of shots) {
		let path: string;
		try {
			path = new URL(s.url).pathname;
		} catch {
			continue;
		}
		for (const [key, b] of Object.entries(s.bricks ?? {})) {
			const vp = s.viewport as "desktop" | "tablet" | "mobile";
			const k = `${path} ${key}`;
			const e = bricksBoxes.get(k) ?? {};
			if (!e[vp]) e[vp] = b;
			bricksBoxes.set(k, e);
		}
	}
	let paddedEdges = 0;
	const pages = content("page");
	const posts = content("post");
	const popupsRaw = content("popup");
	const partialsRaw = content("salient_g_sections");
	const reusable = new Map(content("wp_block").map((b) => [b.id, b.content]));
	// Bricks: templates (header, footer, section, popup…; elements under the meta key of their type), and the options
	// the element settings refer to (palette, global classes, theme style, components, breakpoints).
	const bricksTemplatePosts = content("bricks_template");
	const bricksTemplates = new Map(bricksTemplatePosts.map((t) => [t.id, templateElements(t.meta, bricksElements)]));
	// The live site's design variables (audit): a CSS framework's tokens that Bricks settings name (Automatic.css).
	const bricks = bricksSite(readBricksOptions(paths.raw, options), liveVariables(readJson<RootVariables[]>(join(paths.snapshot, "css-variables.json"))));
	const bricksForms = new Map<string, FormDefinitionOut>();
	const bricksPopups = new Map(bricksTemplatePosts.filter((t) => t.status === "publish" && templateType(t.meta) === "popup").map((t) => [t.id, `bricks-${t.slug}`]));
	// Elementor: the library (Theme Builder parts, popups, saved templates, global widgets) and the active Kit (global
	// colours and fonts the element settings link to).
	const elementorLibrary = content("elementor_library");
	const elementorTrees = new Map(elementorLibrary.map((t) => [t.id, elementorElements(t.meta?._elementor_data) ?? []]));
	const elementorKitPost = activeKit(elementorLibrary, readElementorOptions(paths.raw, options).elementor_active_kit);
	const elementor = elementorKit(elementorKitPost?.meta?._elementor_page_settings);
	const elementorForms = new Map<string, FormDefinitionOut>();
	const elementorPopups = new Map(elementorLibrary.filter((t) => t.status === "publish" && elementorTemplateType(t.meta) === "popup").map((t) => [t.id, `elementor-${t.slug}`]));
	// Divi: theme options and global colours, Theme Builder templates and the header/body/footer layouts they point at.
	const divi = diviSite(readDiviOptions(paths.raw, options));
	const diviTemplates = content("et_template");
	const diviLayouts = new Map([...content("et_header_layout"), ...content("et_body_layout"), ...content("et_footer_layout")].map((l) => [l.id, l]));
	const diviForms = new Map<string, FormDefinitionOut>();
	// Block-library form blocks (Kadence, Spectra, CoBlocks) on Gutenberg pages.
	const blockForms = new Map<string, FormDefinitionOut>();
	// DOM fallback: builder/theme forms rebuilt from the live HTML, and why each page was rebuilt from it.
	const domForms = new Map<string, FormDefinitionOut>();
	const domReasons = new Map<string, FallbackReason>();
	const siteUrl = config.source.url.replace(/\/$/, "");
	const siteHosts = new Set([new URL(siteUrl).host, ...config.source.alternateHosts].map((h) => h.replace(/^www\./, "")));
	// Media library id of an upload URL (WordPress size variants and -scaled copies point at the original).
	const uploadKey = (u: string) => {
		try {
			return decodeURIComponent(new URL(u, siteUrl).pathname).replace(/^.*\/(?:wp-content\/uploads|storage)\//, "").replace(/-\d+x\d+(?=\.[a-z0-9]+$)/i, "").replace(/-scaled(?=\.[a-z0-9]+$)/i, "").toLowerCase();
		} catch {
			return "";
		}
	};
	const mediaByFile = new Map(manifest.filter((m) => m.id && m.file).map((m) => [(m.file as string).toLowerCase().replace(/-scaled(?=\.[a-z0-9]+$)/i, ""), m.id as number]));
	const mediaIdForUrl = (u: string) => (siteHosts.has(hostOf(u, siteUrl)) ? mediaByFile.get(uploadKey(u)) : undefined);
	const relHref = (url: string) => {
		if (url.startsWith("#")) return url;
		try {
			const u = new URL(url, siteUrl);
			if (siteHosts.has(u.host.replace(/^www\./, ""))) return `${u.pathname}${u.search}${u.hash}` || "/";
		} catch {}
		return url;
	};

	// ── Popups: which links/classes open them ──────────────────────────────────
	const popupEnabled = (p: ExporterPost) => p.status === "publish" && Number(p.meta.enabled ?? 1) === 1;
	const popupTriggers: { slug: string; selectors: string[] }[] = popupsRaw.filter(popupEnabled).map((p) => {
		const settings = (p.meta.popup_settings ?? {}) as { triggers?: { type: string; settings?: { extra_selectors?: string } }[] };
		const extra = (settings.triggers ?? []).flatMap((t) => (t.type === "click_open" ? (t.settings?.extra_selectors ?? "").split(",") : [])).map((s) => s.trim()).filter(Boolean);
		return { slug: p.slug, selectors: [...extra, `.popmake-${p.id}`, `#popmake-${p.id}`] };
	});
	const popupFor = ({ href, classes }: { href?: string; classes?: string }) => {
		const cls = (classes ?? "").split(/\s+/).filter(Boolean);
		const hash = href && /^#/.test(href) ? href : href?.includes("#") ? `#${href.split("#")[1]}` : undefined;
		for (const p of popupTriggers) {
			for (const sel of p.selectors) {
				if (sel.startsWith(".") && cls.includes(sel.slice(1))) return p.slug;
				if (sel.startsWith("#") && hash === sel && href?.startsWith("#")) return p.slug;
			}
		}
		return undefined;
	};

	/** A WordPress menu's items as a tree (links made site-relative, popup triggers resolved). */
	let megaIds: Set<number> | undefined;
	const menuTree = (m: MenuRaw): IrMenuItem[] => {
		// Max Mega Menu panels, from the live home page (the plugin keeps its settings in item meta the exporter does not read).
		megaIds ??= megaMenuIds(snapshotHtml.find((h) => h.name === "home")?.html ?? snapshotHtml[0]?.html);
		const build = (parent: number | null, depth: number): IrMenuItem[] =>
			m.items
				.filter((i) => (i.parent_id ?? 0) === (parent ?? 0))
				.sort((a, b) => a.sort_order - b.sort_order)
				.map((i) => {
					const rest = menuItemsRest.get(i.id);
					const classes = Array.isArray(i.classes) ? i.classes.join(" ") : (i.classes ?? "");
					const href = relHref(i.url);
					const popup = popupFor({ href, classes });
					const own = ownClasses(rest?.classes ?? i.classes);
					const titleAttr = (rest?.attr_title ?? i.attr_title ?? "").trim();
					const description = (rest?.description ?? i.description ?? "").trim();
					const mega = depth === 1 && (megaIds?.has(i.id) || isMegaClass(own));
					return { label: i.title, href, ...((rest?.target ?? i.target) === "_blank" ? { newTab: true } : {}), ...(popup ? { opensPopup: popup } : {}), ...(own.length ? { classes: own } : {}), ...(titleAttr ? { titleAttr } : {}), ...(description ? { description } : {}), ...(mega ? { mega: true } : {}), children: build(i.id, depth + 1) };
				});
		return build(null, 1);
	};

	// ── Routes ─────────────────────────────────────────────────────────────────
	const urls = readJson<{ path: string; wp?: { id: number } }[]>(join(paths.snapshot, "urls.json")) ?? [];
	const pathById = new Map(urls.filter((u) => u.wp).map((u) => [u.wp?.id as number, u.path]));
	const frontId = Number(options.page_on_front ?? 0);
	const byId = new Map(pages.map((p) => [p.id, p]));
	const routeOf = (p: ExporterPost): string => {
		if (p.id === frontId) return "/";
		const known = pathById.get(p.id);
		if (known) return overrides.routes[known] ?? known;
		const segs = [p.slug];
		let parent = p.parent ? byId.get(p.parent) : undefined;
		while (parent) {
			segs.unshift(parent.slug);
			parent = parent.parent ? byId.get(parent.parent) : undefined;
		}
		const path = `/${segs.join("/")}/`;
		return overrides.routes[path] ?? path;
	};

	// ── SEO from the audit snapshot (what the live site renders), Rank Math/Yoast as fallback ──
	const snapPages = new Map<number, { name: string; seo: Record<string, unknown> }>();
	const pagesDir = join(paths.snapshot, "pages");
	if (existsSync(pagesDir)) {
		for (const f of readdirSync(pagesDir).filter((x) => x.endsWith(".json"))) {
			const s = readJson<{ wpId?: number; seo?: Record<string, unknown> }>(join(pagesDir, f));
			if (s?.wpId) snapPages.set(s.wpId, { name: f.replace(/\.json$/, ""), seo: s.seo ?? {} });
		}
	}
	const siteTitle = String(options.blogname ?? config.name);
	// SEO plugin options from a database dump (import-options), else the Exporter's options: separator, term SEO.
	const seoOptions = { ...options, ...readJson<Record<string, unknown>>(join(paths.raw, "seo-options.json")) };
	const seoSep = seoSeparator({ rankMathTitles: seoOptions["rank-math-options-titles"], yoastTitles: seoOptions.wpseo_titles });
	const seoOf = (p: ExporterPost): IrPage["seo"] => {
		const live = snapPages.get(p.id)?.seo;
		const rm = p.rankmath ?? p.yoast ?? {};
		// Yoast %%title%% / Rank Math %title% variables (only where the live page did not show the result).
		const vars = (s: string | undefined) => resolveSeoVars(s, { siteName: siteTitle, sep: seoSep, title: p.title, ...(typeof options.blogdescription === "string" ? { tagline: options.blogdescription } : {}), ...(p.excerpt ? { excerpt: p.excerpt } : {}) });
		const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
		const title = str(live?.title) ?? vars(rm.title);
		const description = str(live?.description) ?? vars(rm.description);
		const canonical = str(live?.canonical) ?? str(rm.canonical_url);
		const robots = str(live?.robots) ?? str(rm.robots);
		const og = (live?.og ?? {}) as Record<string, string>;
		const jsonLd = Array.isArray(live?.jsonLdTypes) ? (live?.jsonLdTypes as string[]) : [];
		// Custom sharing text from Yoast / Rank Math post meta (src/transform/social-seo.ts). Its image becomes the page's
		// SEO image when the live page showed none; load stores the rest in the SEO plugin.
		const social = entrySocial(p, vars);
		const ogImage = og.image ?? og["og:image"] ?? social?.ogImage;
		return { ...(title ? { title } : {}), ...(description ? { description } : {}), ...(canonical ? { canonical } : {}), ...(robots ? { robots } : {}), ...(ogImage ? { ogImage } : {}), jsonLdTypes: jsonLd, ...(social ? { social } : {}) };
	};

	// ── Adapt every document ─────────────────────────────────────────────────
	rmSync(paths.ir, { recursive: true, force: true });
	// The live pages' raw HTML (audit): announcement bar, site-wide snippets, text conservation.
	const snapHtmlDir = join(paths.snapshot, "html");
	const snapshotHtml = existsSync(snapHtmlDir) ? readdirSync(snapHtmlDir).filter((f) => f.endsWith(".html")).sort().map((f) => ({ name: f.replace(/\.html$/, ""), html: readFileSync(join(snapHtmlDir, f), "utf8") })) : [];
	// Site-wide snippets (head / body-level code, Header Footer Code Manager export): classified once; provider
	// loaders are added to the embed sections that need them while adapting (src/transform/snippets.ts).
	const siteSnippets = collectSnippets({ pages: snapshotHtml, codeManager: readJson<unknown>(join(paths.raw, "code-snippets.json")), siteHosts: siteHostsOf(config), decisions: overrides.snippets });
	const loaders = providerLoaders(siteSnippets);
	const results: DocResult[] = [];
	const invalid: string[] = [];
	const notTransformed: string[] = [];
	const rowOverridesFor = (slug: string) => Object.fromEntries(Object.entries(overrides.elements).filter(([k]) => k.startsWith(`${slug}:`)).map(([k, v]) => [k.slice(slug.length + 1), v as SectionType | "drop"]));

	const permalink = (id: number) => {
		const p = byId.get(id) ?? posts.find((x) => x.id === id);
		return p ? routeOf(p) : pathById.get(id);
	};
	/** Mariana Tek tenant: kit.config.ts, else the loader snippet in the live pages (audit HTML snapshots). */
	let marianaTenantCache: string | null | undefined;
	const marianaTenantOfSite = (): string | undefined => {
		if (marianaTenantCache === undefined) {
			marianaTenantCache = config.embeds.marianatekTenant ?? null;
			const dir = join(paths.snapshot, "html");
			if (!marianaTenantCache && existsSync(dir)) for (const f of readdirSync(dir).filter((x) => x.endsWith(".html"))) if ((marianaTenantCache = marianaTenant(readFileSync(join(dir, f), "utf8")) ?? null)) break;
		}
		return marianaTenantCache ?? undefined;
	};
	/** The audit's saved HTML of a page or post (snapshot/html), when it has one. */
	const snapHtmlOf = (id: number) => {
		const snap = snapPages.get(id);
		const f = snap ? join(paths.snapshot, "html", `${snap.name}.html`) : undefined;
		return f && existsSync(f) ? readFileSync(f, "utf8") : undefined;
	};
	/**
	 * DOM fallback (src/adapters/dom-fallback): a classic/empty page that is really built with a builder without an
	 * adapter, or whose post_content is empty while the live page shows content. Never for pages an adapter handles,
	 * the posts page, the shop page or a password-protected page.
	 */
	const domFallbackFor = (p: ExporterPost, builder: Builder): { reason: FallbackReason; html?: string } | undefined => {
		if (builder !== "classic" && builder !== "empty") return undefined;
		if (p.id === Number(options.page_for_posts ?? 0) || p.id === Number(options.woocommerce_shop_page_id ?? 0)) return undefined;
		const html = snapHtmlOf(p.id);
		if (html && isPasswordFormHtml(html)) return undefined;
		const reason = fallbackReason(builder, p.content ?? "", p.meta, html ? { html, words: builder === "empty" ? liveContentWords(html, p.id) : 0 } : undefined);
		return reason ? { reason, ...(html ? { html } : {}) } : undefined;
	};
	/** `elements`: a Bricks template's element list (its meta key depends on the template type). */
	const adapt = (p: ExporterPost, kind: Exclude<IrPage["kind"], "entry">, elements?: BricksElement[], role?: "header" | "footer") => {
		let builder: Builder = elements ? "bricks" : detectBuilder(p.content ?? "", p.meta);
		const fallback = !elements && !role && (kind === "page" || kind === "post") ? domFallbackFor(p, builder) : undefined;
		if (fallback?.html) builder = "dom-fallback";
		const keys = new Keys(`${p.id.toString(36)}_`);
		const common = { kind, keys, popupFor, postCount: posts.filter((x) => x.status === "publish").length, rowOverrides: rowOverridesFor(p.slug) };
		let sections: Section[] = [];
		let diagnostics: Diagnostic[] = [];
		try {
			const r = builder === "dom-fallback" && fallback?.html ? adaptDomFallbackPost(p, common, { reason: fallback.reason, html: fallback.html }) : builder === "bricks" ? adaptBricksPost(p, common, elements) : builder === "elementor" ? adaptElementorPost(p, common, role) : builder === "divi" ? adaptDiviPost(p, common, role) : builder === "wpbakery" ? adaptWpbakery(p.content, common) : builder === "empty" ? { sections: [], diagnostics: [] } : adaptGutenbergPost(p, common);
			sections = r.sections;
			diagnostics = r.diagnostics;
		} catch (e) {
			diagnostics.push({ level: "error", code: "parse", message: `Adapter crashed: ${(e as Error).message}`, carriesContent: true });
		}
		if (fallback && !fallback.html) diagnostics.push({ level: "error", code: "unmapped", message: `Built with ${fallback.reason.builder} (${fallback.reason.why}), which has no adapter, and the audit saved no HTML of this page to rebuild it from: rerun audit with this page in the crawl, then transform`, path: "dom", carriesContent: true, tag: "dom-fallback" });
		const reviewed = builder === "dom-fallback" ? overrides.domFallbackReviewed[p.slug] : undefined;
		if (reviewed) for (const d of diagnostics) if (d.tag === "dom-fallback" && d.code === "flagged") Object.assign(d, { level: "info", message: `${d.message} — reviewed (overrides.ts domFallbackReviewed): ${reviewed}` });
		diagnostics.push(...completeMarianaEmbeds(sections, sections.some((s) => s.type === "embed" && s.fields.provider === "marianatek") ? marianaTenantOfSite() : undefined));
		for (const provider of new Set(completeProviderLoaders(sections, loaders))) diagnostics.push({ level: "info", code: "lossy", message: `${provider} embed got the site-wide loader script (it had none of its own)` });
		// legacy_html approved by overrides is downgraded to info.
		for (const s of sections) {
			if (s.type === "legacy_html" && overrides.approvedLegacy.includes(`${p.slug}:${s.sourceRef.path}`)) {
				diagnostics.push({ level: "info", code: "flagged", message: "legacy_html approved in overrides.ts", path: s.sourceRef.path });
			}
		}
		return { builder, sections, diagnostics };
	};
	function adaptBricksPost(p: ExporterPost, common: { kind: Exclude<IrPage["kind"], "entry">; keys: Keys; popupFor: typeof popupFor; postCount: number; rowOverrides: Record<string, SectionType | "drop"> }, elements?: BricksElement[]) {
		const r = adaptBricks(elements ?? bricksElements(p.meta?._bricks_page_content_2) ?? [], { ...common, template: (id) => bricksTemplates.get(id), site: bricks, postId: p.id, content: p.content ?? "", reusable: (id) => reusable.get(id), title: p.title, siteTitle, permalink, popupSlug: (id) => bricksPopups.get(id), measured: (key) => bricksBoxes.get(`${common.kind === "page" ? routeOf(p) : "/"} ${key}`), menuItems: (id) => { const m = menusRaw.find((x) => String(x.id) === id); return m ? menuTree(m) : undefined; } });
		for (const f of r.forms) bricksForms.set(f.id, f);
		return r;
	}

	function adaptElementorPost(p: ExporterPost, common: { kind: Exclude<IrPage["kind"], "entry">; keys: Keys; popupFor: typeof popupFor; postCount: number; rowOverrides: Record<string, SectionType | "drop"> }, role?: "header" | "footer") {
		const menuBy = (key: string) => menusRaw.find((m) => String(m.id) === key || m.name === key || slugify(m.name) === key);
		const r = adaptElementor(elementorElements(p.meta?._elementor_data) ?? [], { ...common, ...(role ? { role } : {}), template: (id) => elementorTrees.get(id), kit: elementor, postId: p.id, title: p.title, siteTitle, permalink, popupSlug: (id) => elementorPopups.get(id), menuItems: (key) => { const m = menuBy(key); return m ? menuTree(m) : undefined; } });
		for (const f of r.forms) elementorForms.set(f.id, f);
		return r;
	}

	function adaptDiviPost(p: ExporterPost, common: { kind: Exclude<IrPage["kind"], "entry">; keys: Keys; popupFor: typeof popupFor; postCount: number; rowOverrides: Record<string, SectionType | "drop"> }, role?: "header" | "footer") {
		const r = adaptDivi(p.content ?? "", { ...common, ...(role ? { role } : {}), site: divi, postId: p.id, title: p.title, siteTitle, menuItems: (id) => { const m = menusRaw.find((x) => String(x.id) === id); return m ? menuTree(m) : undefined; } });
		for (const f of r.forms) diviForms.set(f.id, f);
		return r;
	}

	/** A page of a builder without an adapter, rebuilt from the audit's saved HTML of it (flagged for review). */
	function adaptDomFallbackPost(p: ExporterPost, common: { kind: Exclude<IrPage["kind"], "entry">; keys: Keys; popupFor: typeof popupFor; postCount: number; rowOverrides: Record<string, SectionType | "drop"> }, fb: { reason: FallbackReason; html: string }) {
		const r = adaptDomFallback(fb.html, { ...common, postId: p.id, title: p.title, reason: fb.reason, mediaIdForUrl, relHref });
		for (const f of r.forms) domForms.set(f.id, f);
		domReasons.set(p.slug, fb.reason);
		return r;
	}

	/** `<taxonomy>:<term id>` → slug (category filters of latest-posts / query loop blocks). */
	const termSlugs = new Map((readJson<WpTaxonomy[]>(join(exp, "taxonomies.json")) ?? []).flatMap((t) => (t.terms ?? []).map((x) => [`${t.name}:${x.id}`, x.slug] as const)));
	/** Gutenberg / classic content; block-library form blocks (Kadence, Spectra, CoBlocks) bring their definitions. */
	function adaptGutenbergPost(p: ExporterPost, common: { kind: Exclude<IrPage["kind"], "entry">; keys: Keys; popupFor: typeof popupFor; postCount: number; rowOverrides: Record<string, SectionType | "drop"> }) {
		const r = adaptGutenberg(p.content, { ...common, reusable: (id) => reusable.get(id), postId: p.id, termSlug: (tax, id) => termSlugs.get(`${tax}:${id}`) });
		for (const f of r.forms ?? []) blockForms.set(f.id, f);
		// A latest-posts section lists the blog's posts: with no blog on the new site it would show nothing.
		const noBlog = config.blog === false || overrides.contentTypes.post?.as === "pages" || overrides.contentTypes.post?.as === "skip";
		if (noBlog) for (const s of r.sections.filter((x) => x.type === "posts_list")) r.diagnostics.push({ level: "error", code: "unmapped", message: "Latest-posts list, but the new site has no blog (kit.config blog: false or overrides.ts contentTypes.post): it would list nothing — remove the block or migrate the posts", path: s.sourceRef.path, carriesContent: true, tag: "posts_list" });
		return r;
	}

	reporter.emit({ type: "step:start", step: "Adapt content", total: pages.length + partialsRaw.length + popupsRaw.length + posts.length });
	let done = 0;
	const seoNorm = (p: string) => (p === "/" ? "/" : `/${p.replace(/^\/+|\/+$/g, "")}/`);
	const emit = (doc: IrPage, file: string, published: boolean) => {
		// SEO text the owner rewrote on purpose (overrides.ts seo): onto the page, so load writes it and a rerun keeps it.
		const seoOv = doc.route?.path ? overrides.seo[seoNorm(doc.route.path)] ?? overrides.seo[doc.route.path] : undefined;
		if (seoOv) {
			const socialOv = Object.fromEntries((["ogTitle", "ogDescription", "twitterTitle", "twitterDescription"] as const).filter((k) => seoOv[k]).map((k) => [k, seoOv[k] as string]));
			const social = Object.keys(socialOv).length ? { ...(doc.seo.social ?? {}), ...socialOv, source: "override" as const } : doc.seo.social;
			doc = { ...doc, seo: { ...doc.seo, ...(seoOv.title ? { title: seoOv.title } : {}), ...(seoOv.description ? { description: seoOv.description } : {}), ...(social ? { social } : {}) } };
		}
		const v = irPage.safeParse(doc);
		if (!v.success) invalid.push(`${file}: ${v.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
		write(join(paths.ir, file), v.success ? v.data : doc);
		results.push({ file, doc: v.success ? v.data : doc, published });
		reporter.emit({ type: "step:progress", step: "Adapt content", done: ++done, item: file });
	};

	// ── Password-protected and private content (src/transform/protected.ts) ───────────────────────────────────────
	const protectedRaw = new Map((readJson<ProtectedEntry[]>(join(paths.raw, PROTECTED_FILE)) ?? []).map((e) => [`${e.type}:${e.id}`, e]));
	const passwordFormOnLive = (id: number) => {
		const snap = snapPages.get(id);
		const f = snap ? join(paths.snapshot, "html", `${snap.name}.html`) : undefined;
		return !!f && existsSync(f) && isPasswordFormHtml(readFileSync(f, "utf8"));
	};
	const protectedKind = (p: ExporterPost): ProtectedKind | undefined => (p.status === "private" ? "private" : protectedRaw.has(`${p.post_type}:${p.id}`) || !!(p as { password?: unknown }).password || !!(p as { post_password?: unknown }).post_password || passwordFormOnLive(p.id) ? "password" : undefined);
	const protectedDocs: { slug: string; type: string; kind: ProtectedKind; as: ReturnType<typeof decide>; hash: boolean }[] = [];
	const accessOf = (p: ExporterPost, legacy?: { as: "draft" | "skip" | "publish" }, peek = false): IrPage["access"] | "skip" | undefined => {
		const kind = protectedKind(p);
		if (!kind) return undefined;
		const as = decide(kind, overrides.protectedContent, legacy);
		if (peek) return as === "skip" ? "skip" : { kind, as };
		protectedDocs.push({ slug: p.slug || String(p.id), type: p.post_type, kind, as, hash: !!protectedRaw.get(`${p.post_type}:${p.id}`)?.hash });
		return as === "skip" ? "skip" : { kind, as };
	};
	// WooCommerce catalogue mode (src/transform/shop.ts): the shop page is the products listing; cart, checkout and
	// my-account are not rebuilt (their addresses 301 to the listing: wpUrls `shop`).
	const wooPages = new Map<number, { role: WooPageRole; path: string }>();
	if (config.shop) for (const p of pages) {
		const role = wooPageRole(p, options);
		if (role) wooPages.set(p.id, { role, path: routeOf(p) });
	}
	for (const p of pages) {
		const woo = wooPages.get(p.id);
		if (woo) {
			notTransformed.push(woo.role === "shop" ? `page ${p.slug}: the WooCommerce shop page, rebuilt as the products listing at ${woo.path} (catalogue mode)` : `page ${p.slug}: WooCommerce ${woo.role === "myaccount" ? "my-account" : woo.role} page, not rebuilt in catalogue mode (${woo.path} answers 301 → the shop listing)`);
			continue;
		}
		const access = accessOf(p);
		if (access === "skip") {
			notTransformed.push(`page ${p.slug}: ${p.status === "private" ? "private" : "password-protected"}, skipped by decision (overrides.ts protectedContent)`);
			continue;
		}
		const { builder, sections, diagnostics } = adapt(p, "page");
		// Audit section boxes are paired by builder row; rows found in rendered HTML have no such pairing.
		if (builder !== "dom-fallback") paddedEdges += applyMeasuredPadding(sections, boxesFor(routeOf(p)), false);
		const template = typeof p.meta._wp_page_template === "string" && p.meta._wp_page_template !== "default" ? p.meta._wp_page_template : undefined;
		const parentPath = p.parent && byId.get(p.parent) ? routeOf(byId.get(p.parent) as ExporterPost) : undefined;
		// Order, parent and excerpt when the page has them (src/transform/pages.ts); a parent skipped by decision is not linked.
		const attrs = pageAttributes(p, (id) => !!byId.get(id) && accessOf(byId.get(id) as ExporterPost, undefined, true) !== "skip");
		emit(
			{ version: IR_VERSION, kind: "page", source: { wpId: p.id, type: p.post_type, status: p.status, slug: p.slug, builder, modifiedGmt: p.modified_gmt }, route: { path: routeOf(p), ...(parentPath ? { parentPath } : {}), ...(template ? { template } : {}), ...(p.id === frontId ? { isFrontPage: true } : {}) }, title: p.title, seo: seoOf(p), ...(p.featured_image?.id ? { featuredImage: { wpId: p.featured_image.id, kind: "image" as const } } : {}), sections, ...(access ? { access } : {}), ...(attrs ? { page: attrs } : {}), diagnostics },
			`pages/${p.slug}.json`,
			p.status === "publish" && access?.as !== "draft",
		);
	}
	// Post types decided "pages" (overrides.ts contentTypes): every entry becomes a page at its WordPress address.
	const asPages = (t: string) => overrides.contentTypes[t]?.as === "pages";
	const contentTypesOnDisk = existsSync(join(exp, "content")) ? readdirSync(join(exp, "content")).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort() : [];
	for (const t of contentTypesOnDisk.filter((x) => x !== "page" && asPages(x))) {
		for (const p of content(t)) {
			const { builder, sections, diagnostics } = adapt(p, "page");
			emit({ version: IR_VERSION, kind: "page", source: { wpId: p.id, type: p.post_type, status: p.status, slug: p.slug, builder, modifiedGmt: p.modified_gmt }, route: { path: routeOf(p) }, title: p.title, seo: seoOf(p), ...(p.featured_image?.id ? { featuredImage: { wpId: p.featured_image.id, kind: "image" as const } } : {}), sections, diagnostics }, `pages/${t}-${p.slug}.json`, p.status === "publish");
		}
	}
	// ── Blog: posts (Gutenberg/classic → Portable Text, builder posts keep sections), taxonomies, bylines ─────────────
	// On when WordPress has posts to migrate (or kit.config blog: true); never for a brochure site without posts.
	const discovery = readJson<Omit<NonNullable<WpUrlInput["discovery"]>, "authors"> & { items?: { type: string; link: string }[]; authors?: { id: number; slug: string; link: string; name?: string; description?: string; avatar?: string }[] }>(join(paths.snapshot, "discovery.json"));
	const postsDecided = asPages("post") || overrides.contentTypes.post?.as === "skip";
	const POST_STATUSES = new Set(["publish", "future", "draft", "pending", "private"]);
	const isProtected = (p: ExporterPost) => !!protectedKind(p);
	const skippedPost = (p: ExporterPost) => {
		const kind = protectedKind(p);
		return !!kind && decide(kind, overrides.protectedContent, overrides.protectedPosts) === "skip";
	};
	const blogPosts = postsDecided || config.blog === false ? [] : posts.filter((p) => POST_STATUSES.has(p.status) && !skippedPost(p));
	const blogOn = !postsDecided && config.blog !== false && (blogPosts.length > 0 || config.blog === true);
	const protectedPosts = blogOn ? posts.filter((p) => POST_STATUSES.has(p.status) && isProtected(p)) : [];
	const stickyIds = new Set((Array.isArray(options.sticky_posts) ? options.sticky_posts : typeof options.sticky_posts === "object" && options.sticky_posts ? Object.values(options.sticky_posts) : []).map(Number));
	const authorOf = (p: ExporterPost) => {
		const a = (p.author ?? {}) as { id?: number; display_name?: string };
		return typeof a.id === "number" ? { id: a.id, name: a.display_name ?? "" } : undefined;
	};
	const discoveredAuthors = new Map((discovery?.authors ?? []).map((a) => [a.id, a]));
	const blogBylines: BlogByline[] = [];
	if (blogOn && overrides.authors?.as !== "skip") {
		const used = new Set<string>();
		for (const p of blogPosts) {
			const a = authorOf(p);
			if (!a) continue;
			const known = blogBylines.find((b) => b.wpId === a.id);
			if (known) {
				known.posts++;
				continue;
			}
			const d = discoveredAuthors.get(a.id);
			let slug = bylineSlug(d?.slug ?? a.name);
			for (let i = 2; used.has(slug); i++) slug = `${bylineSlug(d?.slug ?? a.name)}-${i}`;
			used.add(slug);
			const path = d?.link ? (() => { try { return new URL(d.link).pathname; } catch { return undefined; } })() : undefined;
			// Only an avatar the site hosts itself (a local-avatar plugin); Gravatar images stay with Gravatar.
			const avatarUrl = d?.avatar && siteHosts.has(hostOf(d.avatar, siteUrl)) ? d.avatar : undefined;
			const avatarId = avatarUrl ? mediaIdForUrl(avatarUrl) : undefined;
			blogBylines.push({ slug, displayName: a.name || d?.name || slug, ...(d?.description ? { bio: d.description } : {}), ...(avatarId ? { avatar: { wpId: avatarId, kind: "image" as const, alt: a.name } } : avatarUrl ? { avatar: { url: avatarUrl, kind: "image" as const, alt: a.name } } : {}), wpId: a.id, ...(path ? { path } : {}), posts: 1 });
		}
	}
	const usedTaxonomies = new Set(blogPosts.flatMap((p) => Object.entries(p.taxonomies ?? {}).filter(([, t]) => t.length).map(([k]) => k)));
	const wpTaxonomies = readJson<WpTaxonomy[]>(join(exp, "taxonomies.json")) ?? [];
	const termBases = (tax: string) => baseOf((discovery?.terms ?? []).filter((t) => t.taxonomy === tax));
	const blogTax = blogOn ? blogTaxonomies({ taxonomies: wpTaxonomies, usedByPosts: usedTaxonomies, internal: INTERNAL_TAXONOMIES, bases: Object.fromEntries(wpTaxonomies.map((t) => [t.name, termBases(t.name)])) }) : { taxonomies: [], notMigrated: [] };
	for (const n of blogTax.notMigrated) notTransformed.push(`taxonomy ${n}`);
	const taxName = new Map(blogTax.taxonomies.map((t) => [t.wpName, t.name]));
	const trailingAlways = config.target.trailingSlash !== "never";
	const permalinkStructure = typeof options.permalink_structure === "string" ? options.permalink_structure : undefined;
	const postRoute = (p: ExporterPost) => {
		const known = pathById.get(p.id);
		if (known && p.status === "publish") return overrides.routes[known] ?? known;
		const cat = p.taxonomies?.category?.[0]?.slug;
		const author = authorOf(p);
		const path = permalinkPath(permalinkStructure, { id: p.id, slug: p.slug || `post-${p.id}`, ...(wpGmtToIso(p.date_gmt) ? { dateGmt: wpGmtToIso(p.date_gmt) as string } : {}), ...(cat ? { category: cat } : {}), ...(author ? { author: discoveredAuthors.get(author.id)?.slug ?? bylineSlug(author.name) } : {}) }, trailingAlways);
		return overrides.routes[path] ?? path;
	};
	for (const p of blogOn ? blogPosts : postsDecided ? [] : posts) {
		const builder = detectBuilder(p.content ?? "", p.meta);
		const isBuilder = builder === "wpbakery" || builder === "bricks" || builder === "elementor" || builder === "divi" || !!domFallbackFor(p, builder);
		if (!blogOn && !isBuilder) {
			notTransformed.push(`post ${p.slug}: ${builder} content: no posts collection (kit.config blog: false)`);
			continue;
		}
		const adapted = isBuilder ? adapt(p, "post") : undefined;
		const converted = !isBuilder && builder !== "empty" ? convertPostBody(p.content ?? "", builder === "gutenberg" ? "gutenberg" : "classic", { keyPrefix: `${p.id.toString(36)}_`, mediaIdForUrl, reusable: (id) => reusable.get(id) }) : undefined;
		const author = authorOf(p);
		const byline = author ? blogBylines.find((b) => b.wpId === author.id) : undefined;
		const format = p.taxonomies?.post_format?.[0]?.slug?.replace(/^post-format-/, "");
		const terms = Object.fromEntries(Object.entries(p.taxonomies ?? {}).flatMap(([wp, list]) => (taxName.get(wp) && list.length ? [[taxName.get(wp) as string, list.map((t) => t.slug)]] : [])));
		const excerpt = (p.excerpt ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
		const visibility = p.status === "private" ? "private" : isProtected(p) ? "password" : "public";
		const postAccess = visibility === "public" ? undefined : accessOf(p, overrides.protectedPosts);
		const doc: IrPage = {
			version: IR_VERSION,
			kind: "post",
			source: { wpId: p.id, type: "post", status: p.status, slug: p.slug || `post-${p.id}`, builder: adapted?.builder ?? builder, modifiedGmt: p.modified_gmt },
			route: { path: postRoute(p) },
			title: p.title,
			seo: seoOf(p),
			...(p.featured_image?.id ? { featuredImage: { wpId: p.featured_image.id, kind: "image" as const } } : {}),
			sections: adapted?.sections ?? [],
			...(blogOn
				? {
						post: {
							body: (converted?.body ?? []) as IrPost["body"],
							...(excerpt ? { excerpt } : {}),
							...(wpGmtToIso(p.date_gmt) ? { publishedAt: wpGmtToIso(p.date_gmt) } : {}),
							...(wpGmtToIso(p.modified_gmt) ? { modifiedAt: wpGmtToIso(p.modified_gmt) } : {}),
							...(stickyIds.has(p.id) ? { sticky: true } : {}),
							...(format ? { format } : {}),
							terms,
							bylines: byline ? [byline.slug] : [],
							visibility,
						},
					}
				: {}),
			...(postAccess && postAccess !== "skip" ? { access: postAccess } : {}),
			diagnostics: [...(adapted?.diagnostics ?? []), ...(converted?.diagnostics ?? [])],
		};
		emit(doc, `posts/${p.slug || `post-${p.id}`}.json`, p.status === "publish" && (visibility === "public" || (postAccess !== "skip" && postAccess?.as !== "draft")));
	}
	const blogPlan: BlogPlan | undefined = blogOn
		? {
				...blogIndexPath(options, new Map(results.filter((r) => r.doc.kind === "page" && r.doc.route).map((r) => [r.doc.source.wpId, (r.doc.route as { path: string }).path]))),
				perPage: Math.min(100, Math.max(1, Number(options.posts_per_page) || 10)),
				feed: feedSettings(options),
				permalink: permalinkStructure ?? "",
				taxonomies: blogTax.taxonomies,
				bylines: blogBylines,
				authorBase: baseOf(discovery?.authors ?? []) ?? "/author/",
			}
		: undefined;
	if (blogPlan) write(join(paths.ir, "blog.json"), blogPlan);
	// ── Custom post types: a collection per public type (or by decision), custom fields, entries ───────────────────────
	// ── WooCommerce (src/transform/shop.ts): facts for the gate and report; catalogue mode's listing, checkout, currency ──
	const products = content(PRODUCT_TYPE) as unknown as ProductPost[];
	const fingerprintSlugs = (readJson<{ plugins?: { slug: string }[] }>(join(paths.snapshot, "fingerprint.json"))?.plugins ?? []).map((p) => p.slug);
	const wooSite = products.length > 0 || fingerprintSlugs.includes("woocommerce");
	const auditShop = readJson<{ facts?: ShopFacts }>(join(paths.snapshot, "shop.json"))?.facts;
	const variationPosts = content("product_variation") as unknown as ProductPost[];
	const shopFacts: ShopFacts | undefined = wooSite
		? exporterFacts({
				products,
				variations: variationPosts,
				...(existsSync(join(exp, "content", "shop_coupon.json")) ? { coupons: content("shop_coupon").length } : auditShop?.coupons !== undefined ? { coupons: auditShop.coupons } : {}),
				...(() => {
					const c = config.shop?.currency ?? (typeof options.woocommerce_currency === "string" && /^[A-Z]{3}$/.test(options.woocommerce_currency) ? options.woocommerce_currency : undefined) ?? auditShop?.currency;
					return c ? { currency: c } : {};
				})(),
				plugins: extensionsOf(fingerprintSlugs),
			})
		: undefined;
	const shop = config.shop && shopFacts
		? (() => {
				const byParent = new Map<number, ProductPost[]>();
				for (const v of variationPosts) byParent.set(Number(v.parent), [...(byParent.get(Number(v.parent)) ?? []), v]);
				const shopPage = [...wooPages.values()].find((w) => w.role === "shop");
				const pubPagePaths = results.filter((r) => r.doc.kind === "page" && r.published && r.doc.route).map((r) => (r.doc.route as { path: string }).path);
				const contactPath = config.shop?.contactPath ?? pubPagePaths.find((x) => /^\/contact(?:-us)?\/?$/.test(x));
				const labels = new Map(wpTaxonomies.map((t) => [t.name, t.label_singular ?? t.label]));
				return {
					checkout: config.shop?.checkout ?? "external",
					path: shopPage?.path ?? "/shop/",
					currency: shopFacts.currency,
					contactPath,
					redirects: [...new Set([...[...wooPages.values()].filter((w) => w.role !== "shop").map((w) => w.path), "/cart/", "/checkout/", "/my-account/"])],
					variationsOf: (id: number) => byParent.get(id) ?? [],
					productContext: {
						...(shopFacts.currency ? { currency: shopFacts.currency } : {}),
						taxonomyLabel: (t: string) => labels.get(t),
						termName: (t: string, slug: string) => wpTaxonomies.find((x) => x.name === t)?.terms?.find((x) => x.slug === slug)?.name,
					},
				};
			})()
		: undefined;
	const cpt = buildCollections();
	function buildCollections() {
		const analyzeFull = readJson<{ post_types?: AnalyzeType[]; acf?: unknown }>(join(exp, "analyze.json")) ?? {};
		const restTypes = readJson<Record<string, WpRestType>>(join(exp, "types.json")) ?? {};
		const candidates = contentTypesOnDisk.filter((t) => t !== "page" && t !== "post" && !HANDLED_TYPES[t] && !INTERNAL_TYPES[t] && overrides.contentTypes[t]?.as !== "skip" && !asPages(t));
		const decisions: Record<string, ContentTypeDecision | undefined> = Object.fromEntries(candidates.map((t) => [t, overrides.contentTypes[t]]));
		// Catalogue mode: WooCommerce products are the kit's `products` collection with its own fields (src/transform/shop.ts).
		const shopOn = !!shop && candidates.includes(PRODUCT_TYPE);
		const productFieldsDecided = (overrides.contentTypes[PRODUCT_TYPE] as { fields?: Record<string, never> } | undefined)?.fields;
		if (shopOn) decisions[PRODUCT_TYPE] = { as: "collection", name: PRODUCTS_COLLECTION, reason: "WooCommerce catalogue mode (kit.config shop)", ...(productFieldsDecided ? { fields: productFieldsDecided } : {}) };
		const proposals = Object.fromEntries(candidates.map((t) => [t, proposal(t, (analyzeFull.post_types ?? []).find((a) => a.name === t))]));
		const empty = { plan: undefined, docs: [] as IrPage[], proposals, unknownMeta: [] as string[] };
		if (!candidates.length) return empty;
		const groups = fieldGroups({ raw: paths.raw, content: (t) => content(t), analyzeAcf: analyzeFull.acf });
		const typeOfIdMap = new Map<number, string>();
		for (const t of contentTypesOnDisk) for (const p of content(t)) typeOfIdMap.set(p.id, t);
		const entriesOf = new Map(candidates.map((t) => [t, content(t) as CptEntrySource[]]));
		const entryRoute = (p: CptEntrySource) => {
			const known = pathById.get(p.id);
			if (known && p.status === "publish") return overrides.routes[known] ?? known;
			const live = (() => {
				try {
					const u = new URL(p.permalink ?? "");
					return siteHosts.has(u.host.replace(/^www\./, "")) && !u.search ? u.pathname : undefined;
				} catch {
					return undefined;
				}
			})();
			if (live) return overrides.routes[live] ?? live;
			const siblings = entriesOf.get(p.post_type) ?? [];
			const segs = [p.slug || `${p.post_type}-${p.id}`];
			for (let q = p.parent ? siblings.find((x) => x.id === p.parent) : undefined, g = 0; q && g < 20; q = q.parent ? siblings.find((x) => x.id === q?.parent) : undefined, g++) segs.unshift(q.slug);
			const path = `/${p.post_type}/${segs.join("/")}/`;
			return overrides.routes[path] ?? path;
		};
		const plan = planCollections({
			types: candidates.map((t) => ({ name: t, entries: entriesOf.get(t) ?? [] })),
			analyze: analyzeFull.post_types ?? [],
			rest: restTypes,
			groups,
			decisions,
			taxonomies: wpTaxonomies,
			termBases: Object.fromEntries(wpTaxonomies.map((t) => [t.name, termBases(t.name)])),
			blogTaxonomies: taxName,
			routeOf: entryRoute,
			pagePaths: new Set(results.filter((r) => r.doc.kind === "page" && r.doc.route).map((r) => (r.doc.route as { path: string }).path)),
			siteHosts,
			perPage: Math.min(100, Math.max(1, Number(options.posts_per_page) || 10)),
			firstSortOrder: blogOn ? 3 : 2,
			builderOf: (p) => detectBuilder(p.content ?? "", p.meta),
			...(shopOn && shop ? { builtin: { [PRODUCT_TYPE]: { fields: productFields(), archive: shop.path, taxonomies: (wp: string) => PRODUCT_TAXONOMIES.has(wp), shop: { checkout: shop.checkout, ...(shop.currency ? { currency: shop.currency } : {}), ...(shop.contactPath ? { contactPath: shop.contactPath } : {}) } } } } : {}),
		});
		if (!plan.collections.length) return empty;
		const docs: IrPage[] = [];
		const cptBylines: CptPlan["bylines"] = [];
		for (const col of plan.collections) {
			const defs = new Map(fieldsForType(groups, col.type).fields.map((d) => [d.name, d]));
			const built: { p: ExporterPost; doc: IrPage }[] = [];
			for (const source of (entriesOf.get(col.type) ?? []).filter((e) => POST_STATUSES.has(e.status)) as unknown as ExporterPost[]) {
				// Products: WooCommerce's prices, gallery, attributes and variations as the collection's `woo:` fields.
				const product = col.shop && shop ? productMeta(source as unknown as ProductPost, shop.variationsOf(source.id), shop.productContext) : undefined;
				const p = product ? { ...source, meta: { ...source.meta, ...product.meta } } : source;
				const builder = detectBuilder(p.content ?? "", p.meta);
				const isBuilder = builder === "wpbakery" || builder === "bricks" || builder === "gutenberg" || builder === "divi";
				const adapted = isBuilder ? adapt(p, "page") : undefined;
				const converted = !isBuilder && builder !== "empty" ? convertPostBody(p.content ?? "", "classic", { keyPrefix: `${p.id.toString(36)}_b`, mediaIdForUrl, reusable: (id) => reusable.get(id) }) : undefined;
				const { entry, diagnostics } = entryData(p as unknown as CptEntrySource, col, {
					mediaIdForUrl,
					typeOfId: (id) => typeOfIdMap.get(id),
					html: (h, k) => convertPostBody(h, "classic", { keyPrefix: k, mediaIdForUrl, reusable: (id) => reusable.get(id) }),
				}, defs);
				// Links to the WordPress site in URL fields become site paths (the same pages on the new site).
				for (const f of col.fields) {
					const v = entry.fields[f.slug];
					if (f.type === "url" && typeof v === "string") entry.fields[f.slug] = relHref(v);
					if (f.type === "repeater" && Array.isArray(v)) for (const row of v as Record<string, unknown>[]) for (const sf of f.subFields ?? []) if (sf.type === "url" && typeof row[sf.slug] === "string") row[sf.slug] = relHref(row[sf.slug] as string);
				}
				if (col.core.bylines && overrides.authors?.as !== "skip") {
					const a = authorOf(p);
					const known = a ? (blogBylines.find((b) => b.wpId === a.id) ?? cptBylines.find((b) => b.wpId === a.id)) : undefined;
					if (a && known) {
						if (cptBylines.includes(known as never)) known.posts++;
						entry.bylines = [known.slug];
					} else if (a) {
						const used = new Set([...blogBylines, ...cptBylines].map((b) => b.slug));
						const d = discoveredAuthors.get(a.id);
						let slug = bylineSlug(d?.slug ?? a.name);
						for (let i = 2; used.has(slug); i++) slug = `${bylineSlug(d?.slug ?? a.name)}-${i}`;
						const path = d?.link ? (() => { try { return new URL(d.link).pathname; } catch { return undefined; } })() : undefined;
						cptBylines.push({ slug, displayName: a.name || d?.name || slug, ...(d?.description ? { bio: d.description } : {}), wpId: a.id, ...(path ? { path } : {}), posts: 1 });
						entry.bylines = [slug];
					}
				}
				const doc: IrPage = {
					version: IR_VERSION,
					kind: "entry",
					source: { wpId: p.id, type: p.post_type, status: p.status, slug: p.slug || `${p.post_type}-${p.id}`, builder, modifiedGmt: p.modified_gmt },
					...(col.routable ? { route: { path: entryRoute(p as unknown as CptEntrySource) } } : {}),
					title: p.title,
					seo: seoOf(p),
					...(p.featured_image?.id && col.core.featuredImage ? { featuredImage: { wpId: p.featured_image.id, kind: "image" as const } } : {}),
					sections: adapted?.sections ?? [],
					entry: { ...entry, body: (converted?.body ?? []) as IrEntry["body"] },
					diagnostics: [...(adapted?.diagnostics ?? []), ...(converted?.diagnostics ?? []), ...diagnostics, ...(product?.notes ?? []).map((m) => ({ level: "warn" as const, code: "lossy" as const, message: m, path: "shop" }))],
				};
				built.push({ p, doc });
			}
			completeOptions(col, built.map((b) => b.doc.entry as never));
			for (const { p, doc } of built) {
				emit(doc, `entries/${col.slug}/${doc.source.slug}.json`, p.status === "publish");
				docs.push(doc);
			}
		}
		plan.bylines = cptBylines;
		write(join(paths.ir, "collections.json"), plan);
		const unknownMeta = plan.collections.flatMap((c) => c.unknownMeta.filter((u) => !u.decided).map((u) => `${c.type}.${u.key} (${u.entries})`));
		return { plan, docs, proposals, unknownMeta };
	}
	const partials: IrSite["partials"] = [];
	for (const p of partialsRaw) {
		const { builder, sections, diagnostics } = adapt(p, "partial");
		const role = /footer/i.test(p.slug + p.title) ? "footer" : /header/i.test(p.slug + p.title) ? "header" : "other";
		if (role === "footer") paddedEdges += applyMeasuredPadding(sections, boxesFor("/"), true);
		if (role === "footer" && overrides.copyrightYear === "current") currentYear(sections);
		emit({ version: IR_VERSION, kind: "partial", source: { wpId: p.id, type: p.post_type, status: p.status, slug: p.slug, builder, modifiedGmt: p.modified_gmt }, title: p.title, seo: { jsonLdTypes: [] }, sections, diagnostics }, `partials/${p.slug}.json`, p.status === "publish");
		partials.push({ role, file: `partials/${p.slug}.json` });
	}
	// Bricks header and footer templates: the site-wide ones (condition "entire website", else front page) become site parts.
	const bricksParts = siteTemplates(bricksTemplatePosts.map((t) => ({ id: t.id, slug: t.slug, title: t.title, status: t.status, meta: t.meta })));
	let bricksHeaderSections: Section[] | undefined;
	for (const role of ["header", "footer"] as const) {
		const t = bricksParts[role];
		const p = t && bricksTemplatePosts.find((x) => x.id === t.id);
		if (!p) continue;
		const { sections, diagnostics } = adapt(p, "partial", bricksTemplates.get(p.id) ?? []);
		if (role === "header") bricksHeaderSections = sections;
		if (role === "footer") paddedEdges += applyMeasuredPadding(sections, boxesFor("/"), true);
		if (role === "footer" && overrides.copyrightYear === "current") currentYear(sections);
		emit({ version: IR_VERSION, kind: "partial", source: { wpId: p.id, type: p.post_type, status: p.status, slug: p.slug, builder: "bricks", modifiedGmt: p.modified_gmt }, title: p.title, seo: { jsonLdTypes: [] }, sections, diagnostics }, `partials/${p.slug}.json`, true);
		partials.push({ role, file: `partials/${p.slug}.json` });
	}
	// Elementor Theme Builder header and footer: the site-wide ones (condition "Entire Site", else the front page).
	const elementorParts = elementorSiteTemplates(elementorLibrary.map((t) => ({ id: t.id, slug: t.slug, title: t.title, status: t.status, meta: t.meta })));
	let elementorHeaderSections: Section[] | undefined;
	for (const role of ["header", "footer"] as const) {
		const p = elementorParts[role] && elementorLibrary.find((x) => x.id === elementorParts[role]?.id);
		if (!p) continue;
		const { sections, diagnostics } = adapt(p, "partial", undefined, role);
		if (role === "header") elementorHeaderSections = sections;
		if (role === "footer") paddedEdges += applyMeasuredPadding(sections, boxesFor("/"), true);
		if (role === "footer" && overrides.copyrightYear === "current") currentYear(sections);
		emit({ version: IR_VERSION, kind: "partial", source: { wpId: p.id, type: p.post_type, status: p.status, slug: p.slug, builder: "elementor", modifiedGmt: p.modified_gmt }, title: p.title, seo: { jsonLdTypes: [] }, sections, diagnostics }, `partials/${p.slug}.json`, true);
		partials.push({ role, file: `partials/${p.slug}.json` });
	}
	// Divi Theme Builder: the default website template's header and footer layouts become the site parts.
	const diviParts = themeBuilderParts(diviTemplates.map((t) => ({ id: t.id, slug: t.slug, title: t.title, status: t.status, meta: t.meta })));
	let diviHeaderSections: Section[] | undefined;
	for (const role of ["header", "footer"] as const) {
		const p = diviParts[role] ? diviLayouts.get(diviParts[role] as number) : undefined;
		if (diviParts[role] && !p) notTransformed.push(`Divi Theme Builder ${role} layout #${diviParts[role]} is not in the extract (et_${role}_layout posts missing?)`);
		if (!p) continue;
		const { sections, diagnostics } = adapt(p, "partial", undefined, role);
		if (role === "header") diviHeaderSections = sections;
		if (role === "footer") paddedEdges += applyMeasuredPadding(sections, boxesFor("/"), true);
		if (role === "footer" && overrides.copyrightYear === "current") currentYear(sections);
		emit({ version: IR_VERSION, kind: "partial", source: { wpId: p.id, type: p.post_type, status: p.status, slug: p.slug, builder: "divi", modifiedGmt: p.modified_gmt }, title: p.title, seo: { jsonLdTypes: [] }, sections, diagnostics }, `partials/${p.slug}.json`, true);
		partials.push({ role, file: `partials/${p.slug}.json` });
	}
	if (diviParts.body) notTransformed.push(`Divi Theme Builder body layout #${diviParts.body} (${diviLayouts.get(diviParts.body)?.slug ?? "not in the extract"}) wraps every page of the default template; pages keep their own content, the wrapper is not migrated`);
	for (const o of diviParts.others) notTransformed.push(`et_template ${o.post.slug || o.post.id} (${o.post.status}): applies to ${o.conditions}; only the default template's header and footer are migrated`);
	const diviLibrary = content("et_pb_layout").length;
	if (diviLibrary) notTransformed.push(`et_pb_layout (${diviLibrary}): Divi Library items; global modules are migrated from the copy saved in each page`);
	for (const o of elementorParts.others) notTransformed.push(`elementor_library ${o.post.slug} (${o.type}, ${o.post.status}): applies to ${o.conditions}; only the site-wide header and footer are migrated`);
	const canvas = pages.filter((p) => isElementor(p.meta) && /^elementor_(canvas|header_footer)$/.test(String(p.meta._wp_page_template ?? "")));
	if (canvas.length) notTransformed.push(`Elementor page templates without the theme header/footer (Canvas / Full Width) on: ${canvas.map((p) => `${p.slug} (${p.meta._wp_page_template})`).join(", ")} (the starter shows them; decide per page)`);
	// Announcement bar: rebuilt from the live pages' HTML (plugins such as Announcer keep it outside REST).
	const announcement = detectAnnouncement(snapshotHtml);
	const bar = announcement.best;
	const announcementReport: AnnouncementReport = { decision: overrides.announcement, all: announcement.all.map(describeBar), scriptOnly: announcement.scriptOnly };
	if (bar && overrides.announcement !== "drop" && (bar.confident || overrides.announcement === "keep")) {
		emit(announcementDoc(bar, new Keys("ann_"), relHref), "partials/announcement.json", true);
		partials.push({ role: "announcement", file: "partials/announcement.json" });
		announcementReport.rebuilt = describeBar(bar);
		// Report only (the IR keeps the source schedule): a window that already ended hides the bar on the new site too.
		const ends = bar.schedule?.to ? Date.parse(bar.schedule.to) : Number.NaN;
		if (ends < Date.now()) {
			const note = `The bar's schedule ended on ${bar.schedule?.to?.slice(0, 10)}: the starter hides it after that date, although the saved pages still carry it (check on the live site whether visitors see it). Clear or move "Hide after" in the admin to show it again.`;
			announcementReport.notes = [note];
			reporter.emit({ type: "log", level: "warn", message: note });
		}
	} else if (bar) {
		const why = overrides.announcement === "drop" ? "not rebuilt: overrides.announcement is \"drop\"" : `possible announcement bar, not rebuilt (${bar.plugin === "generic" ? "matched by class name only" : "on fewer than half of the saved pages"}); set announcement: "keep" in overrides.ts to rebuild it or "drop" to confirm`;
		notTransformed.push(`announcement bar ${describeBar(bar)} — ${why}`);
	}
	// The old 404 page (audit: snapshot/not-found.html), when it said more than the theme's stock wording: the site part
	// "not-found", shown by the starter's 404 page (src/transform/site-features.ts).
	const notFoundHtml = existsSync(join(paths.snapshot, "not-found.html")) ? readFileSync(join(paths.snapshot, "not-found.html"), "utf8") : undefined;
	const notFound = notFoundHtml ? notFoundContent(notFoundHtml, [...siteHosts]) : undefined;
	if (notFound?.customised) {
		emit(notFoundDoc(notFound, new Keys("nf_"), relHref), "partials/not-found.json", true);
		partials.push({ role: "other", file: "partials/not-found.json" });
	}
	for (const s of announcement.scriptOnly) notTransformed.push(`announcement bar: ${s} is loaded by a script, so its text is not in the saved HTML; check the live site and add it in the admin (Header & footer → announcement) if needed`);
	for (const o of bricksParts.others) notTransformed.push(`bricks_template ${o.post.slug} (${o.type}, ${o.post.status}): applies to ${o.conditions}; only the site-wide ${o.type} is migrated`);
	const offChrome = pages.filter((p) => isBricks(p.meta) && ["headerDisabled", "footerDisabled"].some((k) => (p.meta._bricks_page_settings as Record<string, unknown> | undefined)?.[k]));
	if (offChrome.length) notTransformed.push(`Bricks page settings hide the header or footer on: ${offChrome.map((p) => p.slug).join(", ")} (the starter shows them; decide per page)`);
	const popups: IrSite["popups"] = [];
	for (const p of popupsRaw) {
		if (!popupEnabled(p)) {
			notTransformed.push(`popup ${p.slug}: disabled in Popup Maker`);
			continue;
		}
		const { builder, sections, diagnostics } = adapt(p, "popup");
		const settings = (p.meta.popup_settings ?? {}) as { triggers?: { type: string; settings?: { delay?: number | string } }[]; size?: string };
		const auto = settings.triggers?.find((t) => t.type === "auto_open");
		const trig = popupTriggers.find((t) => t.slug === p.slug);
		emit(
			{ version: IR_VERSION, kind: "popup", source: { wpId: p.id, type: p.post_type, status: p.status, slug: p.slug, builder, modifiedGmt: p.modified_gmt }, title: p.title, seo: { jsonLdTypes: [] }, sections, diagnostics, popup: { selectors: trig?.selectors ?? [], ...(auto ? { autoOpen: { delayMs: Number(auto.settings?.delay ?? 0) } } : {}), ...(settings.size ? { size: settings.size } : {}) } },
			`popups/${p.slug}.json`,
			true,
		);
		popups.push({ slug: p.slug, file: `popups/${p.slug}.json` });
	}
	// Bricks popup templates: opened by a button's "show popup" interaction (the adapter sets opensPopup).
	for (const [id, slug] of bricksPopups) {
		const p = bricksTemplatePosts.find((x) => x.id === id) as ExporterPost;
		const { sections, diagnostics } = adapt(p, "popup", bricksTemplates.get(id) ?? []);
		emit({ version: IR_VERSION, kind: "popup", source: { wpId: p.id, type: p.post_type, status: p.status, slug, builder: "bricks", modifiedGmt: p.modified_gmt }, title: p.title, seo: { jsonLdTypes: [] }, sections, diagnostics, popup: { selectors: [] } }, `popups/${slug}.json`, true);
		popups.push({ slug, file: `popups/${slug}.json` });
	}
	// Elementor Pro popups: opened by links to them (popup action / dynamic tag), or on page load.
	for (const [id, slug] of elementorPopups) {
		const p = elementorLibrary.find((x) => x.id === id) as ExporterPost;
		const { sections, diagnostics } = adapt(p, "popup");
		const auto = popupAutoOpen(p.meta);
		emit({ version: IR_VERSION, kind: "popup", source: { wpId: p.id, type: p.post_type, status: p.status, slug, builder: "elementor", modifiedGmt: p.modified_gmt }, title: p.title, seo: { jsonLdTypes: [] }, sections, diagnostics, popup: { selectors: [], ...(auto ? { autoOpen: auto } : {}) } }, `popups/${slug}.json`, true);
		popups.push({ slug, file: `popups/${slug}.json` });
	}
	for (const t of ["popup_theme", "wp_navigation", "rank_math_schema", "wp_block"]) {
		const n = content(t).length;
		if (n) notTransformed.push(`${t} (${n}): ${t === "wp_block" ? "inlined where referenced" : t === "popup_theme" ? "styling, rebuilt from design capture" : t === "rank_math_schema" ? "JSON-LD regenerated by the starter" : "classic menus are used"}`);
	}
	reporter.emit({ type: "step:end", step: "Adapt content", ok: invalid.length === 0, detail: `${results.length} documents${paddedEdges ? `, ${paddedEdges} section edges with measured padding` : ""}` });

	// ── Site: identity, menus ──────────────────────────────────────────────────
	const menuRole = (locs: string[]): IrSite["menus"][number]["role"] => {
		const l = locs.join(" ");
		if (/off_canvas|primary|main|top_nav(?!_pull)|header/i.test(l)) return "primary";
		if (/pull_right|secondary|secondary_nav|top_bar/i.test(l)) return "secondary";
		if (/footer/i.test(l)) return "footer";
		return "other";
	};
	const menus: IrSite["menus"] = menusRaw.map((m) => ({ name: m.name, role: menuRole(m.locations), wpLocations: m.locations, items: menuTree(m) }));
	// Bricks has no menu locations: the site header template says which menu is the main one (a nav-menu element, or
	// a nav-nested element with its own links), and its buttons are the header's calls to action (secondary menu).
	const headerTpl = bricksParts.header && bricksTemplates.get(bricksParts.header.id);
	if (headerTpl) {
		const homeHtml = snapshotHtml.find((h) => h.name === "home")?.html ?? snapshotHtml[0]?.html;
		const at = homeHtml?.indexOf('id="brx-header"') ?? -1;
		const liveHeader = homeHtml && at >= 0 ? homeHtml.slice(at, homeHtml.indexOf("<main", at) > at ? homeHtml.indexOf("<main", at) : at + 200_000) : undefined;
		if (!menus.some((m) => m.role === "primary")) {
			const pick = headerMenu(menusRaw, headerTpl, liveHeader);
			const nested = pick.menu ? [] : nestedNavItems(headerTpl, (l) => {
				const o = (l && typeof l === "object" ? l : {}) as { type?: string; postId?: unknown; url?: string; newTab?: unknown };
				const id = Number(o.postId);
				const href = o.type === "internal" && id > 0 ? (permalink(id) ?? o.url) : o.url;
				return { ...(href ? { href: relHref(href) } : {}), ...(o.newTab === true || o.newTab === "true" ? { newTab: true } : {}) };
			});
			const chosen = pick.menu && menus.find((m) => m.name === pick.menu?.name);
			if (chosen) chosen.role = "primary";
			else if (nested.length) menus.push({ name: "header", role: "primary", wpLocations: [], items: nested });
			reporter.emit({ type: "log", level: chosen || nested.length ? "info" : "warn", message: `Bricks header menu: ${chosen ? `"${chosen.name}" from the ${pick.via}` : nested.length ? `${nested.length} links of the nav-nested element` : `none (${pick.via})`}` });
		}
		const buttons = headerButtons(bricksHeaderSections ?? []);
		if (buttons.length && !menus.some((m) => m.role === "secondary")) menus.push({ name: "header-buttons", role: "secondary", wpLocations: [], items: buttons });
	}
	// Elementor: the header template's nav-menu widget names the main menu (by slug); its buttons are the header's calls to action.
	const elementorHeader = elementorParts.header && elementorTrees.get(elementorParts.header.id);
	if (elementorHeader) {
		if (!menus.some((m) => m.role === "primary")) {
			const keys: string[] = [];
			const walk = (list: typeof elementorHeader) => {
				for (const e of list) {
					const menu = e.widgetType === "nav-menu" && !Array.isArray(e.settings) ? e.settings?.menu : undefined;
					if (typeof menu === "string") keys.push(menu);
					walk(e.elements ?? []);
				}
			};
			walk(elementorHeader);
			const chosen = keys.map((k) => menus.find((m, i) => String(menusRaw[i]?.id) === k || m.name === k || slugify(m.name) === k)).find(Boolean);
			if (chosen) chosen.role = "primary";
			reporter.emit({ type: "log", level: chosen ? "info" : "warn", message: `Elementor header menu: ${chosen ? `"${chosen.name}" from the header template's nav-menu widget` : `none found (${keys.length ? `menu ${keys.join(", ")} not in the extract` : "no nav-menu widget in the header template"})`}` });
		}
		const buttons = headerButtons(elementorHeaderSections ?? []);
		if (buttons.length && !menus.some((m) => m.role === "secondary")) menus.push({ name: "header-buttons", role: "secondary", wpLocations: [], items: buttons });
	}
	// Divi: the header layout's menu module names the main menu (by id); its buttons are the header's calls to action.
	const diviHeader = diviParts.header ? diviLayouts.get(diviParts.header) : undefined;
	if (diviHeader) {
		if (!menus.some((m) => m.role === "primary")) {
			const ids = [...(diviHeader.content ?? "").matchAll(/\[et_pb_(?:fullwidth_)?menu\b[^\]]*\bmenu_id="(\d+)"/g)].map((m) => m[1] as string);
			const chosen = ids.map((id) => menus.find((_, i) => String(menusRaw[i]?.id) === id)).find(Boolean);
			if (chosen) chosen.role = "primary";
			reporter.emit({ type: "log", level: chosen ? "info" : "warn", message: `Divi header menu: ${chosen ? `"${chosen.name}" from the header layout's menu module` : `none found (${ids.length ? `menu ${ids.join(", ")} not in the extract` : "no menu module in the header layout"})`}` });
		}
		const buttons = headerButtons(diviHeaderSections ?? []);
		if (buttons.length && !menus.some((m) => m.role === "secondary")) menus.push({ name: "header-buttons", role: "secondary", wpLocations: [], items: buttons });
	}
	const siteIconId = typeof options.site_icon === "number" && options.site_icon > 0 ? options.site_icon : undefined;
	// The business from the live home page's structured data (Rank Math/Yoast LocalBusiness/Organization).
	const homeSnap = existsSync(pagesDir) ? readdirSync(pagesDir).map((f) => readJson<{ url?: string; seo?: { jsonLd?: unknown[] } }>(join(pagesDir, f))).find((x) => { try { return !!x?.url && new URL(x.url).pathname === "/"; } catch { return false; } }) : undefined;
	// Owner corrections (overrides.ts business) on top: the JSON-LD and the footer contact block both read this.
	const business = applyBusinessOverride(businessFromJsonLd(homeSnap?.seo?.jsonLd ?? []), overrides.business, siteTitle);
	const site: IrSite = { version: IR_VERSION, title: siteTitle, ...(business ? { business } : {}), ...(typeof options.blogdescription === "string" && options.blogdescription ? { tagline: options.blogdescription } : {}), ...(frontId ? { frontPage: "/" } : {}), ...(siteIconId ? { siteIcon: { wpId: siteIconId, kind: "image" } } : {}), menus, partials, popups };
	const siteValid = irSite.safeParse(site);
	if (!siteValid.success) invalid.push(`site.json: ${siteValid.error.issues[0]?.message}`);
	write(join(paths.ir, "site.json"), site);
	// EmDash's built-in Settings (General, Social Links, SEO), prefilled by load (src/transform/settings.ts).
	const snapAll = existsSync(pagesDir) ? readdirSync(pagesDir).filter((f) => f.endsWith(".json")).map((f) => readJson<{ url?: string; links?: { href: string }[]; seo?: { og?: Record<string, string>; verification?: Record<string, string> } }>(join(pagesDir, f))) : [];
	const homeLinks = (snapAll.find((x) => { try { return !!x?.url && new URL(x.url).pathname === "/"; } catch { return false; } })?.links ?? []).map((l) => l.href);
	const settings = buildSettings({
		options,
		// Option rows from other raw files: a database dump (bricks-options.json, seo-options.json) may hold Rank Math / Yoast options.
		wpOptions: { ...options, ...readJson<Record<string, unknown>>(join(paths.raw, "bricks-options.json")), ...readJson<Record<string, unknown>>(join(paths.raw, "seo-options.json")) },
		rankMathExport: readJson<Record<string, unknown>>(join(paths.raw, "rankmath-settings.json")),
		homeJsonLd: homeSnap?.seo?.jsonLd ?? [],
		homeLinks,
		pageOgImages: snapAll.map((x) => x?.seo?.og?.["og:image"] ?? x?.seo?.og?.image),
		verification: Object.assign({}, ...snapAll.map((x) => x?.seo?.verification ?? {})),
		robotsTxt: readJson<{ robotsTxt?: string }>(join(paths.snapshot, "discovery.json"))?.robotsTxt,
		productionUrl: config.target.productionUrl,
		titleSeparator: /\s([-–—|·•])\s/.exec(results.find((r) => r.doc.route?.isFrontPage)?.doc.seo.title ?? "")?.[1] ?? "-",
		manifest,
	});
	const settingsValid = irSettings.safeParse(settings);
	if (!settingsValid.success) invalid.push(`settings.json: ${settingsValid.error.issues[0]?.path.join(".")} ${settingsValid.error.issues[0]?.message}`);
	write(join(paths.ir, "settings.json"), settings);
	// Bricks form definitions (recipients never copied), read by scaffold next to the Fluent Forms exports.
	for (const f of bricksForms.values()) write(join(paths.ir, "forms", `${f.id}.json`), f);
	for (const f of elementorForms.values()) write(join(paths.ir, "forms", `${f.id}.json`), f);
	for (const f of diviForms.values()) write(join(paths.ir, "forms", `${f.id}.json`), f);
	for (const f of blockForms.values()) write(join(paths.ir, "forms", `${f.id}.json`), f);
	for (const f of domForms.values()) write(join(paths.ir, "forms", `${f.id}.json`), f);
	// Divi theme options and global colours (for comparison with the design capture).
	if (results.some((r) => r.doc.source.builder === "divi")) write(join(paths.reports, "transform", "divi-design.json"), { optionsPresent: divi.present, ...diviDesign(divi), themeBuilder: { ...(diviParts.template ? { template: diviParts.template.id } : {}), ...(diviParts.header ? { header: diviParts.header } : {}), ...(diviParts.footer ? { footer: diviParts.footer } : {}), ...(diviParts.body ? { body: diviParts.body } : {}) } });
	// Elementor Kit design values (for comparison with the design capture) and the entrance animations count (motion).
	if (results.some((r) => r.doc.source.builder === "elementor")) write(join(paths.reports, "transform", "elementor-design.json"), { kitPresent: elementor.present, ...(elementorKitPost ? { kitPost: elementorKitPost.id } : {}), ...elementorDesign(elementor), entranceAnimations: elementorEntranceAnimations([...pages, ...elementorLibrary].map((p) => (isElementor(p.meta) ? elementorElements(p.meta?._elementor_data) : undefined))) });
	if (results.some((r) => r.doc.source.builder === "bricks")) write(join(paths.reports, "transform", "bricks-design.json"), { optionsPresent: bricks.present, ...bricksDesign(bricks), layout: bricksLayout(bricks, shots, readJson<Record<string, unknown>>(join(paths.raw, "acss-settings.json"))), header: bricksHeaderLook(bricksParts.header ? (bricksTemplates.get(bricksParts.header.id) ?? []) : [], bricks), entranceAnimations: bricksEntranceAnimations(pages.map((p) => bricksElements(p.meta?._bricks_page_content_2))) });
	check("ir-valid", "IR validates against the schema", invalid.length === 0, invalid.join("; ") || `${results.length} documents + site.json + settings.json`);

	// ── Unmapped content ───────────────────────────────────────────────────────
	const inScope = results.filter((r) => r.published);
	const blocking = inScope.flatMap((r) => r.doc.diagnostics.filter((d) => d.carriesContent && d.level === "error" && !(d.code === "flagged" && approvedLegacy(r, d.path))).map((d) => `${r.doc.source.slug}:${d.path ?? ""} ${d.message}`));
	function approvedLegacy(r: DocResult, path?: string) {
		return !!path && overrides.approvedLegacy.some((a) => a === `${r.doc.source.slug}:${path}` || (a.startsWith(`${r.doc.source.slug}:`) && path.startsWith(a.slice(r.doc.source.slug.length + 1))));
	}
	check("unmapped", "No unmapped content in published pages, footer and popups", blocking.length === 0, blocking.slice(0, 8).join(" · ") || "every content node mapped");

	const legacy = inScope.flatMap((r) => r.doc.sections.filter((s) => s.type === "legacy_html" && !overrides.approvedLegacy.includes(`${r.doc.source.slug}:${s.sourceRef.path}`)).map((s) => `${r.doc.source.slug}:${s.sourceRef.path}`));
	check("legacy-html", "No unapproved legacy_html sections", legacy.length === 0, legacy.join(", ") || undefined);

	// ── Pages rebuilt from rendered HTML (DOM fallback): visible until the owner reviewed each one ──
	const domPages = inScope.filter((r) => r.doc.source.builder === "dom-fallback");
	if (domPages.length) {
		const open = domPages.filter((r) => !overrides.domFallbackReviewed[r.doc.source.slug]);
		check("dom-fallback-reviewed", "Pages rebuilt from rendered HTML checked against the live page (overrides.ts domFallbackReviewed)", open.length === 0, open.length ? `${open.length} of ${domPages.length} page(s) rebuilt from the live HTML (no adapter for their builder), not yet reviewed: ${open.slice(0, 8).map((r) => `${r.doc.source.slug} (${domReasons.get(r.doc.source.slug)?.builder ?? "unknown"})`).join(", ")} — compare each with the live page (coverage report → Rebuilt from rendered HTML), fix rows with overrides.ts elements / approvedLegacy, then record domFallbackReviewed: { "<slug>": "<who checked it, when>" }` : `${domPages.length} page(s), all reviewed`);
	}

	// ── Media references resolve to the extract ────────────────────────────────
	const ids = new Set(manifest.filter((m) => m.id !== undefined && m.status !== "failed").map((m) => m.id as number));
	const urlsInManifest = new Set(manifest.map((m) => m.url));
	const missingMedia: string[] = [];
	const visitMedia = (v: unknown, where: string) => {
		if (!v || typeof v !== "object") return;
		if (Array.isArray(v)) return v.forEach((x) => visitMedia(x, where));
		const o = v as Record<string, unknown>;
		if (("wpId" in o || "url" in o) && "kind" in o && (o.kind === "image" || o.kind === "video" || o.kind === "file")) {
			const m = o as MediaRef;
			const ok = (m.wpId && ids.has(m.wpId)) || (m.url && (urlsInManifest.has(m.url) || !siteHosts.has(hostOf(m.url, siteUrl))));
			if (!ok) missingMedia.push(`${where}: ${m.wpId ? `#${m.wpId}` : m.url}`);
			return;
		}
		for (const x of Object.values(o)) visitMedia(x, where);
	};
	for (const r of inScope) visitMedia([r.doc.sections, r.doc.post?.body ?? [], r.doc.entry?.fields ?? {}, r.doc.entry?.body ?? []], r.doc.source.slug);
	check("media-refs", "Every media reference in published content resolves", missingMedia.length === 0, missingMedia.slice(0, 8).join(", ") || undefined);

	// ── Every image published content uses in WordPress is kept somewhere in the IR ──
	const refs = readJson<Record<string, { kind: string; value: string; via: string }[]>>(join(paths.raw, "refs.json")) ?? {};
	const lostImages: string[] = [];
	for (const r of inScope) {
		const key = `${r.doc.source.type}:${r.doc.source.wpId}:${r.doc.source.slug}`;
		const used = new Set<number>();
		const collect = (v: unknown) => {
			if (!v || typeof v !== "object") return;
			if (Array.isArray(v)) return v.forEach(collect);
			const o = v as Record<string, unknown>;
			if (typeof o.wpId === "number") used.add(o.wpId);
			for (const x of Object.values(o)) collect(x);
		};
		collect(r.doc.sections);
		collect(r.doc.featuredImage);
		collect(r.doc.post?.body);
		collect(r.doc.entry);
		for (const ref of refs[key] ?? []) {
			if (ref.kind !== "id" || !(ref.via.startsWith("content:") || ref.via === "featured_image")) continue;
			const id = Number(ref.value);
			if (ids.has(id) && !used.has(id)) lostImages.push(`${r.doc.source.slug}: #${id} (${ref.via.replace("content:", "")})`);
		}
	}
	check("images-kept", "Every image used by published content is in the IR", lostImages.length === 0, lostImages.slice(0, 10).join(", ") || undefined);

	// ── Internal links point at known pages, anchors, popups or files ───────────
	const routes = new Set(results.filter((r) => r.doc.route).map((r) => (r.doc.route as { path: string }).path));
	for (const u of urls) routes.add(u.path);
	const anchors = new Set(results.flatMap((r) => r.doc.sections.flatMap((s) => (s.anchorId ? [`${r.doc.route?.path ?? ""}#${s.anchorId}`, `#${s.anchorId}`] : []))));
	const popupHashes = new Set(popups.map((p) => `#${p.slug}`));
	const brokenLinks: string[] = [];
	const checkHref = (href: string, where: string) => {
		if (!href || /^(tel:|mailto:|sms:|javascript:)/i.test(href)) return;
		const rel = relHref(href);
		if (/^https?:\/\//i.test(rel)) return; // external
		if (rel === "#" || popupHashes.has(rel)) return;
		const [pathPart, hashPart] = rel.split("#");
		const p = pathPart ? normPath(pathPart, config.target.trailingSlash) : "";
		if (p && !routes.has(p) && !routes.has(p.replace(/\/$/, "")) && !routes.has(`${p}/`) && !/\.(pdf|jpe?g|png|webp|gif|svg|mp4|docx?|kml)$/i.test(p)) {
			brokenLinks.push(`${where} → ${href}`);
			return;
		}
		if (hashPart && p && !anchors.has(`${p}#${hashPart}`) && !anchors.has(`${p.replace(/\/$/, "")}/#${hashPart}`)) brokenLinks.push(`${where} → ${href} (anchor not found)`);
	};
	const visitLinks = (v: unknown, where: string) => {
		if (!v || typeof v !== "object") return;
		if (Array.isArray(v)) return v.forEach((x) => visitLinks(x, where));
		const o = v as Record<string, unknown>;
		if (typeof o.href === "string") checkHref(o.href, where);
		for (const [k, x] of Object.entries(o)) if (k !== "href") visitLinks(x, where);
	};
	for (const r of inScope) visitLinks([r.doc.sections, r.doc.post?.body ?? [], r.doc.entry?.fields ?? {}, r.doc.entry?.body ?? []], r.doc.source.slug);
	for (const m of menus) visitLinks(m.items, `menu ${m.name}`);
	check("links", "Internal links point at migrated pages, anchors, popups or files", brokenLinks.length === 0, brokenLinks.slice(0, 8).join("; ") || undefined);

	// ── Text conservation vs the live page HTML ─────────────────────────────────
	const formText = [...readFormText(join(paths.raw, "forms")), ...[...bricksForms.values(), ...diviForms.values(), ...blockForms.values(), ...domForms.values()].flatMap((f) => [f.submitLabel, ...f.fields.flatMap((x) => [x.label, ...(x.placeholder ? [x.placeholder] : []), ...(x.options ?? [])])])];
	const footerDocs = results.filter((r) => r.doc.kind === "partial" && r.published).map((r) => r.doc);
	const lowPages: string[] = [];
	for (const r of results.filter((x) => (x.doc.kind === "page" || x.doc.kind === "entry") && x.published && !x.doc.access)) {
		const snap = snapPages.get(r.doc.source.wpId);
		const htmlFile = snap ? join(paths.snapshot, "html", `${snap.name}.html`) : undefined;
		if (!htmlFile || !existsSync(htmlFile)) continue;
		const src = sourceText(readFileSync(htmlFile, "utf8"));
		// Entries: their title, excerpt, field values and body are page text too (the starter renders them).
		const entryText = r.doc.entry ? [r.doc.title, r.doc.entry.excerpt ?? "", entryWords(r.doc.entry)] : [];
		const c = conservation(src, irText([r.doc, ...footerDocs], menus.map((m) => m.items), [siteTitle, ...formText, ...entryText]));
		r.conservation = { ...c, context: missingContext(src, c.missing) };
		if (c.ratio < config.gates.textConservation) lowPages.push(`${r.doc.route?.path} ${(c.ratio * 100).toFixed(1)}%`);
	}
	const measured = results.filter((r) => r.conservation);
	check("text-conservation", `Live page text found in the IR ≥ ${(config.gates.textConservation * 100).toFixed(0)}%`, lowPages.length === 0 && measured.length > 0, lowPages.join(", ") || (measured.length ? `${measured.length} pages, lowest ${(Math.min(...measured.map((r) => r.conservation?.ratio ?? 1)) * 100).toFixed(1)}%` : "no audit HTML snapshots to compare against — run audit"));

	// ── Site-wide snippets ────────────────────────────────────────────────────────
	const embedProviders = new Set(results.flatMap((r) => r.doc.sections.flatMap((s) => (s.type === "embed" ? [s.fields.provider] : []))));
	settleLoaders(siteSnippets, embedProviders, overrides.snippets);
	write(join(paths.ir, "site-snippets.json"), siteSnippets);
	const undecided = siteSnippets.items.filter((s) => s.status === "decision");
	check("site-snippets", "Site-wide snippets carried, not needed, or decided", undecided.length === 0, undecided.length ? `${undecided.length} need a decision (coverage report → Site-wide snippets; overrides.ts snippets): ${undecided.slice(0, 5).map((s) => `${s.id} ${s.label}`).join("; ")}` : snapshotHtml.length ? `${siteSnippets.counts.carried} carried${siteSnippets.widgets.length ? ` (site widgets: ${siteSnippets.widgets.map((w) => w.provider).join(", ")})` : ""}, ${siteSnippets.counts["not-needed"]} not needed` : "no audit HTML snapshots — run audit");
	if (siteSnippets.widgets.length) reporter.emit({ type: "log", level: "info", message: `site widgets recognised: ${siteSnippets.widgets.map((w) => `${w.provider} ${w.id}`).join(", ")}` });
	// Consent banner on the old site (plugin or service) → what Privacy & consent starts with (src/transform/consent.ts).
	const consentPlan = planConsent(snapshotHtml, config.siteWidgets === false ? [] : Array.isArray(config.siteWidgets) ? config.siteWidgets : siteSnippets.widgets);
	write(join(paths.ir, "consent.json"), consentPlan);
	if (consentPlan.found.length) reporter.emit({ type: "log", level: "info", message: `consent banner on the old site: ${consentPlan.found.map((f) => f.name).join(", ")} → ${consentPlan.reason}` });

	// ── Content types, taxonomies, authors: everything the extract found is migrated or decided ──────────────
	const analyze = readJson<{ authors?: { display_name: string; post_count: number | string }[]; attachments?: { count: number } }>(join(exp, "analyze.json"));
	const builderPost = (p: ExporterPost) => ["wpbakery", "bricks", "elementor", "divi"].includes(detectBuilder(p.content ?? "", p.meta));
	const pathsOf = (links: string[]) => [...new Set(links.map((l) => { try { return new URL(l).pathname; } catch { return l; } }))];
	const inventory = contentInventory({
		types: contentTypesOnDisk.map((t) => ({ name: t, entries: content(t).map((p) => ({ status: p.status, handled: t === "post" ? builderPost(p) : false })) })),
		taxonomies: (readJson<{ name: string; terms?: { count: number }[] }[]>(join(exp, "taxonomies.json")) ?? []).map((x) => ({ name: x.name, terms: x.terms ?? [] })),
		authors: (analyze?.authors ?? []).map((a) => ({ name: a.display_name, posts: Number(a.post_count) || 0 })),
		samples: {
			types: Object.fromEntries([...new Set((discovery?.items ?? []).map((i) => i.type))].map((t) => [t, pathsOf((discovery?.items ?? []).filter((i) => i.type === t).map((i) => i.link))])),
			taxonomies: Object.fromEntries([...new Set((discovery?.terms ?? []).map((i) => i.taxonomy))].map((t) => [t, pathsOf((discovery?.terms ?? []).filter((i) => i.taxonomy === t).map((i) => i.link))])),
			authors: pathsOf((discovery?.authors ?? []).map((a) => a.link)),
		},
		attachments: analyze?.attachments?.count ?? manifest.filter((m) => m.inLibrary).length,
		overrides,
		...(blogPlan
			? {
					blog: {
						types: { post: `posts collection (${blogPosts.length} posts: Gutenberg/classic → Portable Text, builder posts keep their sections)` },
						taxonomies: Object.fromEntries(blogPlan.taxonomies.map((t) => [t.wpName, `blog taxonomy "${t.name}" (${t.terms.length} terms${t.hierarchical ? ", hierarchy kept" : ""}), archives at ${t.base}<slug>/`])),
						...(blogPlan.bylines.length ? { authors: `bylines (${blogPlan.bylines.length}), author archives at ${blogPlan.authorBase}<slug>/` } : {}),
					},
				}
			: {}),
		...(cpt.plan || Object.keys(cpt.proposals).length
			? {
					collections: {
						types: Object.fromEntries((cpt.plan?.collections ?? []).map((c) => [c.type, `collection "${c.slug}" (${c.fields.length} custom field${c.fields.length === 1 ? "" : "s"}${c.archive ? `, archive at ${c.archive}` : ""}${c.routable ? "" : ", no addresses"}): coverage report → Custom post types`])),
						taxonomies: Object.fromEntries([
							...(cpt.plan?.taxonomies ?? []).map((t) => [t.wpName, `taxonomy "${t.name}" of ${t.collections.join(", ")} (${t.terms.length} terms${t.hierarchical ? ", hierarchy kept" : ""}), archives at ${t.base}<slug>/`]),
							// Catalogue mode: product attributes are the products' attributes and variations fields, not archives.
							...(cpt.plan?.collections.some((c) => c.shop) ? wpTaxonomies.filter((t) => t.name.startsWith("pa_")).map((t) => [t.name, `product attribute: shown in the ${PRODUCTS_COLLECTION} collection's attributes and variations fields (no attribute archives)`]) : []),
						]),
						proposals: cpt.proposals,
					},
				}
			: {}),
	});
	check("content-types-handled", "Every post type, taxonomy in use and author with posts is migrated or decided", !inventory.some((r) => r.status === "undecided"), inventoryDetail(inventory));
	// Custom fields of migrated post types: every meta key is a mapped field, a decided one, or WordPress's own.
	if (cpt.plan) check("cpt-fields", "Every custom field of a migrated post type is mapped or decided (overrides.ts contentTypes.<type>.fields)", cpt.unknownMeta.length === 0, cpt.unknownMeta.length ? `${cpt.unknownMeta.length} meta key(s) without a field definition (coverage report → Custom post types): ${cpt.unknownMeta.slice(0, 6).join(", ")}${cpt.unknownMeta.length > 6 ? ", …" : ""}` : `${cpt.plan.collections.map((c) => `${c.slug}: ${c.fields.length} field(s)`).join(", ")}`);
	// Private and password-protected pages and posts: EmDash has no such status. Defaults: password → protect (the
	// WordPress password, hashed), private → draft; a "protect" item needs its password hash (or the .env fallback).
	for (const p of protectedPosts) if (!protectedDocs.some((d) => d.type === p.post_type && d.slug === (p.slug || String(p.id)))) protectedDocs.push({ slug: p.slug || String(p.id), type: p.post_type, kind: protectedKind(p) ?? "password", as: decide(protectedKind(p) ?? "password", overrides.protectedContent, overrides.protectedPosts), hash: !!protectedRaw.get(`${p.post_type}:${p.id}`)?.hash });
	if (protectedDocs.length) {
		const fallback = !!loadSiteEnv(paths.root).WP2EMDASH_PROTECTED_PASSWORD;
		const noPassword = protectedDocs.filter((d) => d.as === "protect" && !d.hash && !fallback);
		const by = (as: string) => protectedDocs.filter((d) => d.as === as);
		const decided = overrides.protectedPosts ? `protectedPosts: ${overrides.protectedPosts.as} (${overrides.protectedPosts.reason})` : overrides.protectedContent ? `overrides.ts protectedContent` : "defaults: password → protect, private → draft";
		check("protected-content", "Password-protected and private content carried by decision (overrides.ts protectedContent)", noPassword.length === 0, noPassword.length ? `${noPassword.length} protected item(s) without a readable WordPress password: ${noPassword.slice(0, 5).map((d) => `${d.type} ${d.slug}`).join(", ")} — give extract an editor's application password, set WP2EMDASH_PROTECTED_PASSWORD in sites/${config.slug}/.env (the owner's new password, hashed at load), or decide draft/skip/publish` : `${protectedDocs.length} item(s), ${decided}: ${["protect", "draft", "publish", "skip"].filter((a) => by(a).length).map((a) => `${a} ${by(a).length}`).join(", ")}`);
	}

	// ── Customizer Additional CSS: reported, carried only by decision ───────────────────────────────────────
	const customCss: CustomCss | undefined = readJson<CustomCss>(join(paths.raw, "custom-css.json")) ?? (() => {
		for (const h of snapshotHtml) {
			const css = customCssFromHtml(h.html);
			if (css) return { source: "live-html" as const, css };
		}
		return undefined;
	})();
	if (customCss?.css) {
		write(join(paths.ir, "custom-css.json"), { decision: overrides.customCss ?? null, css: customCss.css });
		const d = describeCss(customCss.css);
		check("custom-css", "Customizer Additional CSS carried or dropped by decision", !!overrides.customCss, overrides.customCss ? `${overrides.customCss}: ${(d.bytes / 1024).toFixed(1)} KB, ${d.selectors.length} selectors` : `${(d.bytes / 1024).toFixed(1)} KB, ${d.selectors.length} selectors (e.g. ${d.selectors.slice(0, 4).join(", ")}): decide in overrides.ts customCss "carry" | "drop" (coverage report → Additional CSS)`);
	}

	// ── Comments: approved WordPress comments → EmDash's comments table (src/transform/comments.ts) ──────────
	// Only when WordPress has comments: a site without any gets no ir/comments.json, report section or gate.
	const rawComments = readJson<WpComment[]>(join(exp, "comments.json")) ?? [];
	let commentsPlan: CommentsPlan | undefined;
	rmSync(join(paths.ir, "comments.json"), { force: true });
	if (rawComments.length) {
		const contentDir = join(exp, "content");
		const commentStatus = new Map<number, string>();
		for (const f of existsSync(contentDir) ? readdirSync(contentDir).filter((x) => x.endsWith(".json")) : []) for (const p of readJson<ExporterPost[]>(join(contentDir, f)) ?? []) if (typeof p.comment_status === "string") commentStatus.set(p.id, p.comment_status);
		const targets: CommentTarget[] = results.flatMap((r) => {
			const d = r.doc;
			const collection = d.kind === "entry" && d.entry ? d.entry.collection : d.kind === "post" && blogPlan && d.post ? "posts" : d.kind === "page" || d.kind === "post" ? "pages" : undefined;
			if (!collection) return [];
			const status = commentStatus.get(d.source.wpId);
			return [{ key: `${d.source.type}:${d.source.wpId}`, wpId: d.source.wpId, collection, slug: d.source.slug, ...(d.route?.path ? { path: d.route.path } : {}), published: r.published, ...(status ? { commentStatus: status } : {}) }];
		});
		const discussion = discussionSettings(readJson<Record<string, unknown>>(join(exp, "discussion.json")), readJson<Record<string, unknown>>(join(paths.raw, "discussion.json")));
		const planned = planComments({ comments: rawComments, targets, settings: discussion, ...(overrides.comments ? { decision: overrides.comments } : {}), sensitive: config.sensitiveData, site: new URL(config.source.url).host.replace(/^www\./, "") });
		commentsPlan = planned.plan;
		write(join(paths.ir, "comments.json"), { ...planned.plan, items: planned.items });
		const g = commentsGate(planned.plan);
		check("comments", "WordPress comments imported or decided; spam, pingbacks and pending ones accounted for", g.ok, g.detail);
	}

	// ── WordPress URLs with no page on the new site: one rule set for the middleware and verify ─────────────
	const pubPages =results.filter((r) => r.doc.kind === "page" && r.published && r.doc.route);
	// Published entries of routable collections are real addresses too (never matched by a rule, like pages).
	const pubEntries = results.filter((r) => r.doc.kind === "entry" && r.published && r.doc.route);
	const wpUrlPlan = buildWpUrlPlan({
		pages: [...pubPages, ...pubEntries].map((r) => (r.doc.route as { path: string }).path),
		routeById: new Map([...pubPages, ...pubEntries].map((r) => [r.doc.source.wpId, (r.doc.route as { path: string }).path])),
		publishedPosts: posts.filter((p) => p.status === "publish").length,
		...(Number(options.page_for_posts) > 0 ? { blogPageId: Number(options.page_for_posts) } : {}),
		...(discovery ? { discovery } : {}),
		overrides,
		...(commentsPlan?.migrate && commentsPlan.counts.imported ? { comments: true } : {}),
		trailingSlash: config.target.trailingSlash === "preserve" ? (pubPages.every((r) => r.doc.route?.path === "/" || r.doc.route?.path.endsWith("/")) ? "always" : "never") : config.target.trailingSlash,
		...(blogPlan
			? {
					blog: {
						index: blogPlan.index,
						archives: [...new Set([...blogPlan.taxonomies.map((t) => t.base), ...(blogPlan.bylines.length ? [blogPlan.authorBase] : [])])],
						posts: results.filter((r) => r.doc.kind === "post" && r.published && r.doc.route).map((r) => (r.doc.route as { path: string }).path),
						ids: Object.fromEntries([
							...blogPlan.taxonomies.flatMap((t) =>
								t.terms.map((term) => {
									const live = (discovery?.terms ?? []).find((d) => d.taxonomy === t.wpName && d.slug === term.slug);
									const path = live ? (() => { try { return new URL(live.link).pathname; } catch { return `${t.base}${term.slug}/`; } })() : `${t.base}${term.slug}/`;
									return t.wpName === "category" ? [`cat:${term.wpId}`, path] : t.wpName === "post_tag" ? [`tag:${term.slug}`, path] : [`${t.wpName}:${term.slug}`, path];
								}),
							),
							...blogPlan.bylines.map((b) => [`author:${b.wpId}`, b.path ?? `${blogPlan.authorBase}${b.slug}/`]),
						]),
					},
				}
			: {}),
	});
	// Catalogue mode: cart, checkout and my-account (and their sub-pages, `?add-to-cart=`) 301 to the products listing.
	const shopListed = !!shop && !!cpt.plan?.collections.some((c) => c.shop);
	if (shop && shopListed) wpUrlPlan.rules.shop = { paths: shop.redirects, to: shop.path };
	write(join(paths.ir, "wp-urls.json"), wpUrlPlan);
	rmSync(join(paths.ir, "shop.json"), { force: true });
	if (shopFacts) {
		const g = shopGate(shopFacts, config.shop);
		check("shop", "WooCommerce: catalogue mode decided by the owner (kit.config shop) and nothing it cannot carry", g.ok, g.detail);
		if (shop) {
			const missing = [shop.currency ? "" : "the currency (set kit.config shop.currency: WooCommerce's currency option was not in the export)", shop.checkout === "contact" && !shop.contactPath ? "the contact page (set kit.config shop.contactPath: no published page at /contact/ or /contact-us/)" : "", shopListed || !shopFacts.products ? "" : "the products collection (overrides.ts contentTypes.product skips it, or no product was extracted)"].filter(Boolean);
			check("shop-checkout", "Catalogue mode has what the product pages need (currency, Buy button target, listing)", missing.length === 0, missing.length ? `missing: ${missing.join("; ")}` : `${shop.path} lists ${shopFacts.products} product(s) in ${shop.currency}; Buy button: ${shop.checkout === "contact" ? `contact form at ${shop.contactPath}` : "each product's buy_url"}; ${shop.redirects.join(", ")} → 301 ${shop.path}`);
		}
		write(join(paths.ir, "shop.json"), { facts: shopFacts, decisions: shopDecisions(shopFacts, config.shop?.checkout), ...(shop ? { mode: "catalogue", checkout: shop.checkout, listing: shop.path, currency: shop.currency, ...(shop.contactPath ? { contactPath: shop.contactPath } : {}), redirects: shop.redirects } : {}) });
	}
	if (wpUrlPlan.feedPending) notTransformed.push("feeds: the site has published posts but no feed is generated yet; /feed/ redirects (coverage report → WordPress URLs)");

	// ── Widget areas and site features (src/transform/widgets.ts, site-features.ts) ─────────────────────────
	const menuNames = emdashMenuNames(site.menus);
	const wpSidebars = readJson<WpSidebar[]>(join(paths.raw, "widgets", "sidebars.json"));
	const widgetSource = wpSidebars ? { sidebars: wpSidebars, widgets: readJson<WpWidget[]>(join(paths.raw, "widgets", "widgets.json")) ?? [] } : widgetsFromOptions({ ...options, ...readJson<Record<string, unknown>>(join(paths.raw, "bricks-options.json")) });
	const widgetPlan = widgetSource ? planWidgets({ ...widgetSource, menuName: (id) => menuNames[menusRaw.findIndex((m) => m.id === id)], blog: !!blogPlan, pages: snapshotHtml.map((h) => h.html), mediaIdForUrl, decisions: overrides.widgets, postUrlTemplate: "/:slug" }) : undefined;
	rmSync(join(paths.ir, "widgets.json"), { force: true });
	if (widgetPlan && (widgetPlan.areas.some((a) => a.widgets.length) || widgetPlan.unknown.length)) {
		write(join(paths.ir, "widgets.json"), widgetPlan);
		check("widgets-handled", "Every widget is mapped to an EmDash widget or decided (overrides.ts widgets)", widgetPlan.unknown.length === 0, widgetPlan.unknown.length ? `${widgetPlan.unknown.length} widget(s) without a mapping (coverage report → Widgets): ${widgetPlan.unknown.slice(0, 6).map((u) => `${u.wpId} (${u.idBase})`).join(", ")}; overrides.ts widgets: { "<id>": "html" | "skip" }` : `${widgetPlan.areas.reduce((n, a) => n + a.widgets.length, 0)} widgets in ${widgetPlan.areas.filter((a) => a.widgets.length).length} area(s)`);
	}
	// Media folders (FileBird / Real Media Library from a dump, attachment taxonomies from REST) → ir/media-folders.json.
	const folderIn = folderInputs(readJson<{ sources?: FolderSource[] }>(join(paths.raw, "media-folders-dump.json")), readJson<{ sources?: FolderSource[] }>(join(paths.raw, "media-folders.json")), (readJson<{ plugins?: { slug: string }[] }>(join(paths.snapshot, "fingerprint.json"))?.plugins ?? []).map((p) => p.slug));
	const folderPlan = folderIn.sources.length || folderIn.unreachable.length ? planMediaFolders(folderIn.sources, folderIn.unreachable) : undefined;
	rmSync(join(paths.ir, "media-folders.json"), { force: true });
	if (folderPlan?.folders.length) write(join(paths.ir, "media-folders.json"), folderPlan);
	const crumbs = breadcrumbsOf(snapshotHtml);
	const maintenance = maintenancePlugin(readJson<{ plugins?: { slug: string }[] }>(join(paths.snapshot, "fingerprint.json"))?.plugins ?? [], snapshotHtml);
	const features: SiteFeatures = {
		headerSearch: headerSearch(snapshotHtml.find((h) => h.name === "home")?.html ?? snapshotHtml[0]?.html),
		...(crumbs ? { breadcrumbs: crumbs } : {}),
		notFound: notFound ? (notFound.customised ? "rebuilt" : "stock") : "not-audited",
		...(maintenance ? { maintenance } : {}),
	};
	write(join(paths.ir, "site-features.json"), features);
	if (features.maintenance) reporter.emit({ type: "log", level: "warn", message: `The old site had ${features.maintenance}: the new site's coming-soon mode stays off (Site health → Settings switches it on).` });
	for (const m of megaItems(site.menus)) notTransformed.push(`mega menu ${m}: partial — rebuilt as columns of links; images, widgets and custom HTML in the panel are not carried`);

	// ── Reusable blocks → EmDash sections (ir/sections.json; pages keep them inlined) ─────────────────────────────
	const sectionsPlan = planSections(content("wp_block"), { mediaIdForUrl, reusable: (id) => reusable.get(id) });
	if (sectionsPlan.sections.length || sectionsPlan.skipped.length) write(join(paths.ir, "sections.json"), sectionsPlan);

	// ── Term SEO (Yoast wpseo_taxonomy_meta, Rank Math term meta, both from a database dump; owner overrides by archive
	// path) → ir/term-seo.json, stored by load in the SEO plugin's archive store (src/transform/term-meta.ts) ─────────
	const archivedTaxonomies = [...(blogPlan?.taxonomies ?? []), ...(cpt.plan?.taxonomies ?? [])].filter((t, i, all) => all.findIndex((x) => x.name === t.name) === i);
	const rankMathTermMetaRaw = readJson<{ rankMath?: Record<string, Record<string, unknown>> }>(join(paths.raw, SEO_TERMMETA_FILE))?.rankMath;
	const termSeo = termSeoPlan({ yoast: seoOptions.wpseo_taxonomy_meta, ...(rankMathTermMetaRaw ? { rankMath: rankMathTermMetaRaw } : {}), taxonomies: archivedTaxonomies, siteName: siteTitle, sep: seoSep, ...(typeof options.blogdescription === "string" ? { tagline: options.blogdescription } : {}), overrides: overrides.seo });
	rmSync(join(paths.ir, "term-seo.json"), { force: true });
	if (termSeo.terms.length) write(join(paths.ir, "term-seo.json"), termSeo);
	const seoPluginSlugs = (readJson<{ plugins?: { slug: string }[] }>(join(paths.snapshot, "fingerprint.json"))?.plugins ?? []).map((p) => p.slug).join(" ");
	const termSeoDumpMissing = archivedTaxonomies.length && !rankMathTermMetaRaw && !seoOptions.wpseo_taxonomy_meta ? (/rank-?math/i.test(seoPluginSlugs) ? "Rank Math" : /yoast|wordpress-seo/i.test(seoPluginSlugs) ? "Yoast SEO" : undefined) : undefined;

	// ── Users → team invite list (names and e-mails only under sites/<slug>/users/; ir/users.json holds counts) ──────
	const wpUsers = readJson<WpUser[]>(join(usersDir(paths.root), WP_USERS_FILE));
	rmSync(join(paths.ir, "users.json"), { force: true });
	const userCounts = wpUsers ? inviteCounts(planInvites(wpUsers, overrides.users), overrides.users.roles) : undefined;
	if (wpUsers && userCounts) {
		writeInvites(paths.root, config.name, planInvites(wpUsers, overrides.users));
		write(join(paths.ir, "users.json"), userCounts);
	}

	// ── Report ─────────────────────────────────────────────────────────────────
	const reportDir = join(paths.reports, "transform");
	// Pages rebuilt from rendered HTML (DOM fallback): which, why, what came out, reviewed or not.
	const domDocs = results.filter((r) => r.doc.source.builder === "dom-fallback");
	const domFallback = domDocs.map((r) => ({ slug: r.doc.source.slug, path: r.doc.route?.path, builder: domReasons.get(r.doc.source.slug)?.builder ?? "unknown", why: domReasons.get(r.doc.source.slug)?.why ?? "", sections: r.doc.sections.length, legacy: r.doc.sections.filter((s) => s.type === "legacy_html").length, reviewed: overrides.domFallbackReviewed[r.doc.source.slug] ?? null }));
	const domReport = domFallback.length
		? ["", "## Rebuilt from rendered HTML (DOM fallback)", "", "No adapter knows these pages' builder, so they were rebuilt from the audit's saved HTML of the live page: compare each with the live page (sections, columns, backgrounds, pictures, forms), fix rows with `overrides.ts → elements` or `approvedLegacy`, then record the review in `overrides.ts → domFallbackReviewed`.", "", "| Page | Builder | Why | Sections | legacy_html | Reviewed |", "|---|---|---|---|---|---|", ...domFallback.map((d) => `| ${d.path ?? d.slug} | ${d.builder} | ${d.why.replace(/\|/g, "\\|")} | ${d.sections} | ${d.legacy || ""} | ${d.reviewed ? `✅ ${d.reviewed.replace(/\|/g, "\\|")}` : "⚠️ not yet"} |`)]
		: [];
	write(join(reportDir, "coverage.json"), {
		...(domFallback.length ? { domFallback } : {}),
		documents: results.map((r) => ({ file: r.file, published: r.published, builder: r.doc.source.builder, sections: r.doc.sections.map((s) => `${s.type}${s.variant ? `:${s.variant}` : ""}`), diagnostics: r.doc.diagnostics, conservation: r.conservation && { ratio: r.conservation.ratio, missing: r.conservation.missing } })),
		notTransformed,
		announcement: announcementReport,
		snippets: { counts: siteSnippets.counts, widgets: siteSnippets.widgets, items: siteSnippets.items.map(({ id, kind, status, label, note, where, pages }) => ({ id, kind, status, label, note, where, pages: pages.length })) },
		settings: { sources: settings.sources, notCarried: settings.notCarried },
		contentTypes: inventory,
		...(cpt.plan ? { collections: cpt.plan.collections.map((c) => ({ type: c.type, slug: c.slug, entries: c.entries, published: c.published, fields: c.fields.map((f) => ({ slug: f.slug, type: f.type, wp: `${f.wp.source}:${f.wp.type}`, ...(f.note ? { note: f.note } : {}) })), unknownMeta: c.unknownMeta, ...(c.archive ? { archive: c.archive } : {}) })) } : {}),
		...(commentsPlan ? { comments: { migrate: commentsPlan.migrate, ...commentsPlan.counts, collections: commentsPlan.collections.map((c) => ({ slug: c.slug, form: c.form, approved: c.approved, pending: c.pending })) } } : {}),
		...(blogPlan ? { blog: { index: blogPlan.index, posts: results.filter((r) => r.doc.kind === "post").length, published: results.filter((r) => r.doc.kind === "post" && r.published).length, taxonomies: blogPlan.taxonomies.map((t) => ({ name: t.name, terms: t.terms.length })), bylines: blogPlan.bylines.length, feed: blogPlan.feed, protectedPosts: protectedPosts.length } } : {}),
		...(customCss?.css ? { customCss: { decision: overrides.customCss ?? null, source: customCss.source, ...describeCss(customCss.css), ...(customCss.inactive ? { inactive: customCss.inactive } : {}) } } : {}),
		consent: { found: consentPlan.found, keptWidgets: consentPlan.keptWidgets, mode: config.consent === false ? "off" : (config.consent.mode ?? consentPlan.mode), reason: consentPlan.reason },
		wpUrls: { rules: wpUrlPlan.explain, attachments: Object.keys(wpUrlPlan.rules.attachments ?? {}).length, feedPending: wpUrlPlan.feedPending },
	});
	// Plugin/theme shortcodes met in content (registry src/adapters/shortcodes.ts): written only when there are any.
	const shortcodes = shortcodeSummary(results);
	rmSync(join(paths.ir, "shortcodes.json"), { force: true });
	if (shortcodes.used.length) write(join(paths.ir, "shortcodes.json"), shortcodes);
	writeFileSync(join(reportDir, "coverage.md"), transformReport(config.name, results, checks, notTransformed, site, announcementReport, siteSnippets, [...domReport, ...shortcodesReport(shortcodes), ...settingsReport(settings), ...inventoryReport(inventory), ...(blogPlan ? blogReport(blogPlan, results.filter((r) => r.doc.kind === "post").map((r) => r.doc), overrides.protectedPosts) : []), ...(cpt.plan ? cptReport(cpt.plan, cpt.docs) : []), ...(shopFacts ? ["", ...shopReport(shopFacts, config.shop, "## Shop (WooCommerce)")] : []), ...pageAttributesReport(results.filter((r) => r.doc.kind === "page").map((r) => r.doc), snapshotHtml.filter((h) => showsFeaturedImage(h.html)).length), ...sectionsReport(sectionsPlan), ...usersReport(userCounts), ...termSeoReport(termSeo, termSeoDumpMissing), ...customCssReport(customCss?.css ? customCss : undefined, overrides.customCss), ...(commentsPlan ? commentsReport(commentsPlan) : []), ...wpUrlsReport(wpUrlPlan), ...menusReport(site.menus), ...widgetsReport(widgetPlan), ...mediaFoldersReport(folderPlan), ...siteFeaturesReport(features), ...consentReport(consentPlan, config.consent === false ? false : config.consent.mode)]));
	reporter.emit({ type: "log", level: "info", message: `Report: ${join(reportDir, "coverage.md")}` });
	return checks;
}

/** Words of an entry's field values and body (text conservation): strings, Portable Text spans, repeater rows. */
function entryWords(e: IrEntry): string {
	const out: string[] = [];
	const walk = (v: unknown, key = "") => {
		if (typeof v === "string") {
			if (key !== "_type" && key !== "_key" && key !== "url" && key !== "style" && key !== "kind" && !/^https?:/.test(v)) out.push(v);
			return;
		}
		if (typeof v === "number" && key !== "wpId") out.push(String(v));
		if (Array.isArray(v)) return v.forEach((x) => walk(x, key));
		if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (k !== "_media" && k !== "markDefs") walk(x, k);
	};
	walk([e.fields, e.body]);
	return out.join("\n");
}

/** Hosts of the WordPress site: its files (theme, plugins, uploads) are WordPress assets, not site-wide snippets. */
function siteHostsOf(config: { source: { url: string; alternateHosts: string[] }; target: { productionUrl: string } }): string[] {
	const host = (u: string) => {
		try {
			return [new URL(u).host];
		} catch {
			return [];
		}
	};
	return [...new Set([...host(config.source.url), ...config.source.alternateHosts, ...host(config.target.productionUrl)])];
}

function hostOf(url: string, base: string): string {
	try {
		return new URL(url, base).host.replace(/^www\./, "");
	} catch {
		return "";
	}
}

function normPath(p: string, policy: "always" | "never" | "preserve"): string {
	let x = p.startsWith("/") ? p : `/${p}`;
	if (policy === "always" && !x.endsWith("/") && !/\.[a-z0-9]+$/i.test(x)) x += "/";
	return x;
}

/** Labels, placeholders and button text of extracted forms (they render on the page but live in the form definition). */
function readFormText(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	const visit = (v: unknown, key = "") => {
		if (Array.isArray(v)) return v.forEach((x) => visit(x, key));
		if (v && typeof v === "object") {
			for (const [k, x] of Object.entries(v)) if (!["notifications", "integrations", "conditional_logics", "validation_rules"].includes(k)) visit(x, k);
			return;
		}
		if (typeof v === "string" && /^(label|placeholder|admin_field_label|text|button_ui|help_message|value|title)$/.test(key) && v.length < 200) out.push(v);
		// Text shown inside the form (Fluent custom HTML, consent label): a waiver's terms are page text too.
		else if (typeof v === "string" && /^(html_codes|tnc_html|description|html|sign_instruction)$/.test(key)) out.push(v.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " "));
	};
	for (const provider of readdirSync(dir)) {
		for (const f of readdirSync(join(dir, provider))) {
			const j = JSON.parse(readFileSync(join(dir, provider, f), "utf8")) as { status?: string; form?: unknown };
			if (j.status && !/publish/.test(j.status)) continue;
			visit(j.form);
			// Forms from plugin exports carry a ready definition (fields, content blocks).
			visit((j as { definition?: unknown }).definition);
		}
	}
	return out;
}
