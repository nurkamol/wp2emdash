/**
 * Phase 3 — transform. raw/ (extract) → ir/ (Section IR, PLAN §2.1) + coverage report.
 * Pure function of raw/ + overrides.ts: reruns reproduce the same IR. Never hand-edit ir/.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { adaptBricks, bricksDesign, type BricksElement, bricksElements, bricksSite, isBricks, liveVariables, siteTemplates, templateElements, templateType } from "../adapters/bricks/index.js";
import { headerButtons, headerMenu, nestedNavItems } from "../adapters/bricks/menus.js";
import { readBricksOptions } from "../extract/bricks.js";
import type { FormDefinitionOut } from "../scaffold/forms.js";
import { adaptGutenberg } from "../adapters/gutenberg/index.js";
import { adaptWpbakery } from "../adapters/wpbakery/index.js";
import { loadOverrides } from "../config/overrides.js";
import type { GateCheck } from "../core/state.js";
import { Keys } from "../ir/portable-text.js";
import { businessFromJsonLd } from "../transform/business.js";
import { completeMarianaEmbeds, marianaTenant } from "../transform/embeds.js";
import { type Diagnostic, IR_VERSION, type IrMenuItem, type IrPage, irPage, type IrSite, irSite, type MediaRef, type Section, type SectionType } from "../ir/schema.js";
import { conservation, irText, missingContext, sourceText } from "../transform/coverage.js";
import { applyMeasuredPadding } from "../transform/measured.js";
import { type AnnouncementReport, transformReport } from "../transform/report.js";
import { announcementDoc, describeBar, detectAnnouncement } from "../transform/announcement.js";
import type { BricksBox, RootVariables, ScreenshotResult } from "../audit/browser.js";
import type { ExporterPost, MediaEntry } from "./extract.js";
import type { PhaseContext } from "./index.js";

const readJson = <T>(file: string): T | undefined => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as T) : undefined);
const write = (file: string, data: unknown) => {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
};

export type Builder = IrPage["source"]["builder"];
export function detectBuilder(content: string, meta?: Record<string, unknown>): Builder {
	// Bricks keeps the page in post meta; post_content holds at most a fallback copy.
	if (isBricks(meta)) return "bricks";
	if (!content.trim()) return "empty";
	if (/\[vc_(row|column|section)\b/.test(content)) return "wpbakery";
	if (/<!--\s+wp:/.test(content)) return "gutenberg";
	return "classic";
}

interface MenuRaw {
	id?: number;
	name: string;
	locations: string[];
	items: { id: number; parent_id: number | null; sort_order: number; type: string; object: string; object_id: number; url: string; title: string; target: string; classes: string | string[] | null }[];
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
	const manifest = readJson<MediaEntry[]>(join(paths.raw, "media-manifest.json")) ?? [];
	// Section boxes from the audit screenshots: real padding per source row (desktop + phone).
	const shots = readJson<ScreenshotResult[]>(join(paths.snapshot, "screens.json")) ?? [];
	const boxesFor = (path: string) => {
		const at = (vp: string) => shots.find((x) => x.viewport === vp && (() => { try { return new URL(x.url).pathname === path; } catch { return false; } })())?.sections;
		return { desktop: at("desktop"), tablet: at("tablet"), mobile: at("mobile") };
	};
	// Bricks: every live element's measured box by its id (gaps, widths, text sizes), from the same screenshots.
	const bricksBoxes = new Map<string, Partial<Record<"desktop" | "tablet" | "mobile", BricksBox>>>();
	for (const s of shots)
		for (const [id, b] of Object.entries(s.bricks ?? {})) {
			const vp = s.viewport as "desktop" | "tablet" | "mobile";
			const e = bricksBoxes.get(id) ?? {};
			if (!e[vp]) e[vp] = b;
			bricksBoxes.set(id, e);
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
	const siteUrl = config.source.url.replace(/\/$/, "");
	const siteHosts = new Set([new URL(siteUrl).host, ...config.source.alternateHosts].map((h) => h.replace(/^www\./, "")));
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
	const menuTree = (m: MenuRaw): IrMenuItem[] => {
		const build = (parent: number | null): IrMenuItem[] =>
			m.items
				.filter((i) => (i.parent_id ?? 0) === (parent ?? 0))
				.sort((a, b) => a.sort_order - b.sort_order)
				.map((i) => {
					const classes = Array.isArray(i.classes) ? i.classes.join(" ") : (i.classes ?? "");
					const href = relHref(i.url);
					const popup = popupFor({ href, classes });
					return { label: i.title, href, ...(i.target === "_blank" ? { newTab: true } : {}), ...(popup ? { opensPopup: popup } : {}), children: build(i.id) };
				});
		return build(null);
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
	const seoOf = (p: ExporterPost): IrPage["seo"] => {
		const live = snapPages.get(p.id)?.seo;
		const rm = p.rankmath ?? p.yoast ?? {};
		const vars = (s: string | undefined) => s?.replace(/%sep%/g, "-").replace(/%sitename%/g, siteTitle).replace(/%title%/g, p.title).replace(/\s+/g, " ").trim();
		const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
		const title = str(live?.title) ?? vars(rm.title);
		const description = str(live?.description) ?? vars(rm.description);
		const canonical = str(live?.canonical) ?? str(rm.canonical_url);
		const robots = str(live?.robots) ?? str(rm.robots);
		const og = (live?.og ?? {}) as Record<string, string>;
		const jsonLd = Array.isArray(live?.jsonLdTypes) ? (live?.jsonLdTypes as string[]) : [];
		return { ...(title ? { title } : {}), ...(description ? { description } : {}), ...(canonical ? { canonical } : {}), ...(robots ? { robots } : {}), ...(og.image || og["og:image"] ? { ogImage: og.image ?? og["og:image"] } : {}), jsonLdTypes: jsonLd };
	};

	// ── Adapt every document ─────────────────────────────────────────────────
	rmSync(paths.ir, { recursive: true, force: true });
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
	/** `elements`: a Bricks template's element list (its meta key depends on the template type). */
	const adapt = (p: ExporterPost, kind: IrPage["kind"], elements?: BricksElement[]) => {
		const builder: Builder = elements ? "bricks" : detectBuilder(p.content ?? "", p.meta);
		const keys = new Keys(`${p.id.toString(36)}_`);
		const common = { kind, keys, popupFor, postCount: posts.filter((x) => x.status === "publish").length, rowOverrides: rowOverridesFor(p.slug) };
		let sections: Section[] = [];
		let diagnostics: Diagnostic[] = [];
		try {
			const r = builder === "bricks" ? adaptBricksPost(p, common, elements) : builder === "wpbakery" ? adaptWpbakery(p.content, common) : builder === "empty" ? { sections: [], diagnostics: [] } : adaptGutenberg(p.content, { ...common, reusable: (id) => reusable.get(id) });
			sections = r.sections;
			diagnostics = r.diagnostics;
		} catch (e) {
			diagnostics.push({ level: "error", code: "parse", message: `Adapter crashed: ${(e as Error).message}`, carriesContent: true });
		}
		diagnostics.push(...completeMarianaEmbeds(sections, sections.some((s) => s.type === "embed" && s.fields.provider === "marianatek") ? marianaTenantOfSite() : undefined));
		// legacy_html approved by overrides is downgraded to info.
		for (const s of sections) {
			if (s.type === "legacy_html" && overrides.approvedLegacy.includes(`${p.slug}:${s.sourceRef.path}`)) {
				diagnostics.push({ level: "info", code: "flagged", message: "legacy_html approved in overrides.ts", path: s.sourceRef.path });
			}
		}
		return { builder, sections, diagnostics };
	};
	function adaptBricksPost(p: ExporterPost, common: { kind: IrPage["kind"]; keys: Keys; popupFor: typeof popupFor; postCount: number; rowOverrides: Record<string, SectionType | "drop"> }, elements?: BricksElement[]) {
		const r = adaptBricks(elements ?? bricksElements(p.meta?._bricks_page_content_2) ?? [], { ...common, template: (id) => bricksTemplates.get(id), site: bricks, postId: p.id, content: p.content ?? "", reusable: (id) => reusable.get(id), title: p.title, siteTitle, permalink, popupSlug: (id) => bricksPopups.get(id), measured: (id) => bricksBoxes.get(id), menuItems: (id) => { const m = menusRaw.find((x) => String(x.id) === id); return m ? menuTree(m) : undefined; } });
		for (const f of r.forms) bricksForms.set(f.id, f);
		return r;
	}

	reporter.emit({ type: "step:start", step: "Adapt content", total: pages.length + partialsRaw.length + popupsRaw.length + posts.length });
	let done = 0;
	const emit = (doc: IrPage, file: string, published: boolean) => {
		const v = irPage.safeParse(doc);
		if (!v.success) invalid.push(`${file}: ${v.error.issues.slice(0, 3).map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
		write(join(paths.ir, file), v.success ? v.data : doc);
		results.push({ file, doc: v.success ? v.data : doc, published });
		reporter.emit({ type: "step:progress", step: "Adapt content", done: ++done, item: file });
	};

	for (const p of pages) {
		const { builder, sections, diagnostics } = adapt(p, "page");
		paddedEdges += applyMeasuredPadding(sections, boxesFor(routeOf(p)), false);
		const template = typeof p.meta._wp_page_template === "string" && p.meta._wp_page_template !== "default" ? p.meta._wp_page_template : undefined;
		const parentPath = p.parent && byId.get(p.parent) ? routeOf(byId.get(p.parent) as ExporterPost) : undefined;
		emit(
			{ version: IR_VERSION, kind: "page", source: { wpId: p.id, type: p.post_type, status: p.status, slug: p.slug, builder, modifiedGmt: p.modified_gmt }, route: { path: routeOf(p), ...(parentPath ? { parentPath } : {}), ...(template ? { template } : {}), ...(p.id === frontId ? { isFrontPage: true } : {}) }, title: p.title, seo: seoOf(p), ...(p.featured_image?.id ? { featuredImage: { wpId: p.featured_image.id, kind: "image" as const } } : {}), sections, diagnostics },
			`pages/${p.slug}.json`,
			p.status === "publish",
		);
	}
	for (const p of posts) {
		const builder = detectBuilder(p.content ?? "", p.meta);
		if (builder !== "wpbakery" && builder !== "bricks") {
			notTransformed.push(`post ${p.slug}: ${builder} content imported as Portable Text by the EmDash importer`);
			continue;
		}
		const { sections, diagnostics } = adapt(p, "post");
		emit({ version: IR_VERSION, kind: "post", source: { wpId: p.id, type: "post", status: p.status, slug: p.slug, builder, modifiedGmt: p.modified_gmt }, route: { path: routeOf(p) }, title: p.title, seo: seoOf(p), sections, diagnostics }, `posts/${p.slug}.json`, p.status === "publish");
	}
	const partials: IrSite["partials"] = [];
	for (const p of partialsRaw) {
		const { builder, sections, diagnostics } = adapt(p, "partial");
		const role = /footer/i.test(p.slug + p.title) ? "footer" : /header/i.test(p.slug + p.title) ? "header" : "other";
		if (role === "footer") paddedEdges += applyMeasuredPadding(sections, boxesFor("/"), true);
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
		emit({ version: IR_VERSION, kind: "partial", source: { wpId: p.id, type: p.post_type, status: p.status, slug: p.slug, builder: "bricks", modifiedGmt: p.modified_gmt }, title: p.title, seo: { jsonLdTypes: [] }, sections, diagnostics }, `partials/${p.slug}.json`, true);
		partials.push({ role, file: `partials/${p.slug}.json` });
	}
	// Announcement bar: rebuilt from the live pages' HTML (plugins such as Announcer keep it outside REST).
	const snapHtmlDir = join(paths.snapshot, "html");
	const snapshotHtml = existsSync(snapHtmlDir) ? readdirSync(snapHtmlDir).filter((f) => f.endsWith(".html")).sort().map((f) => ({ name: f.replace(/\.html$/, ""), html: readFileSync(join(snapHtmlDir, f), "utf8") })) : [];
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
	const siteIconId = typeof options.site_icon === "number" && options.site_icon > 0 ? options.site_icon : undefined;
	// The business from the live home page's structured data (Rank Math/Yoast LocalBusiness/Organization).
	const homeSnap = existsSync(pagesDir) ? readdirSync(pagesDir).map((f) => readJson<{ url?: string; seo?: { jsonLd?: unknown[] } }>(join(pagesDir, f))).find((x) => { try { return !!x?.url && new URL(x.url).pathname === "/"; } catch { return false; } }) : undefined;
	const business = businessFromJsonLd(homeSnap?.seo?.jsonLd ?? []);
	const site: IrSite = { version: IR_VERSION, title: siteTitle, ...(business ? { business } : {}), ...(typeof options.blogdescription === "string" && options.blogdescription ? { tagline: options.blogdescription } : {}), ...(frontId ? { frontPage: "/" } : {}), ...(siteIconId ? { siteIcon: { wpId: siteIconId, kind: "image" } } : {}), menus, partials, popups };
	const siteValid = irSite.safeParse(site);
	if (!siteValid.success) invalid.push(`site.json: ${siteValid.error.issues[0]?.message}`);
	write(join(paths.ir, "site.json"), site);
	// Bricks form definitions (recipients never copied), read by scaffold next to the Fluent Forms exports.
	for (const f of bricksForms.values()) write(join(paths.ir, "forms", `${f.id}.json`), f);
	if (results.some((r) => r.doc.source.builder === "bricks")) write(join(paths.reports, "transform", "bricks-design.json"), { optionsPresent: bricks.present, ...bricksDesign(bricks) });
	check("ir-valid", "IR validates against the schema", invalid.length === 0, invalid.join("; ") || `${results.length} documents + site.json`);

	// ── Unmapped content ───────────────────────────────────────────────────────
	const inScope = results.filter((r) => r.published);
	const blocking = inScope.flatMap((r) => r.doc.diagnostics.filter((d) => d.carriesContent && d.level === "error" && !(d.code === "flagged" && approvedLegacy(r, d.path))).map((d) => `${r.doc.source.slug}:${d.path ?? ""} ${d.message}`));
	function approvedLegacy(r: DocResult, path?: string) {
		return !!path && overrides.approvedLegacy.some((a) => a === `${r.doc.source.slug}:${path}` || (a.startsWith(`${r.doc.source.slug}:`) && path.startsWith(a.slice(r.doc.source.slug.length + 1))));
	}
	check("unmapped", "No unmapped content in published pages, footer and popups", blocking.length === 0, blocking.slice(0, 8).join(" · ") || "every content node mapped");

	const legacy = inScope.flatMap((r) => r.doc.sections.filter((s) => s.type === "legacy_html" && !overrides.approvedLegacy.includes(`${r.doc.source.slug}:${s.sourceRef.path}`)).map((s) => `${r.doc.source.slug}:${s.sourceRef.path}`));
	check("legacy-html", "No unapproved legacy_html sections", legacy.length === 0, legacy.join(", ") || undefined);

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
	for (const r of inScope) visitMedia(r.doc.sections, r.doc.source.slug);
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
	for (const r of inScope) visitLinks(r.doc.sections, r.doc.source.slug);
	for (const m of menus) visitLinks(m.items, `menu ${m.name}`);
	check("links", "Internal links point at migrated pages, anchors, popups or files", brokenLinks.length === 0, brokenLinks.slice(0, 8).join("; ") || undefined);

	// ── Text conservation vs the live page HTML ─────────────────────────────────
	const formText = [...readFormText(join(paths.raw, "forms")), ...[...bricksForms.values()].flatMap((f) => [f.submitLabel, ...f.fields.flatMap((x) => [x.label, ...(x.placeholder ? [x.placeholder] : []), ...(x.options ?? [])])])];
	const footerDocs = results.filter((r) => r.doc.kind === "partial" && r.published).map((r) => r.doc);
	const lowPages: string[] = [];
	for (const r of results.filter((x) => x.doc.kind === "page" && x.published)) {
		const snap = snapPages.get(r.doc.source.wpId);
		const htmlFile = snap ? join(paths.snapshot, "html", `${snap.name}.html`) : undefined;
		if (!htmlFile || !existsSync(htmlFile)) continue;
		const src = sourceText(readFileSync(htmlFile, "utf8"));
		const c = conservation(src, irText([r.doc, ...footerDocs], menus.map((m) => m.items), [siteTitle, ...formText]));
		r.conservation = { ...c, context: missingContext(src, c.missing) };
		if (c.ratio < config.gates.textConservation) lowPages.push(`${r.doc.route?.path} ${(c.ratio * 100).toFixed(1)}%`);
	}
	const measured = results.filter((r) => r.conservation);
	check("text-conservation", `Live page text found in the IR ≥ ${(config.gates.textConservation * 100).toFixed(0)}%`, lowPages.length === 0 && measured.length > 0, lowPages.join(", ") || (measured.length ? `${measured.length} pages, lowest ${(Math.min(...measured.map((r) => r.conservation?.ratio ?? 1)) * 100).toFixed(1)}%` : "no audit HTML snapshots to compare against — run audit"));

	// ── Report ─────────────────────────────────────────────────────────────────
	const reportDir = join(paths.reports, "transform");
	write(join(reportDir, "coverage.json"), {
		documents: results.map((r) => ({ file: r.file, published: r.published, builder: r.doc.source.builder, sections: r.doc.sections.map((s) => `${s.type}${s.variant ? `:${s.variant}` : ""}`), diagnostics: r.doc.diagnostics, conservation: r.conservation && { ratio: r.conservation.ratio, missing: r.conservation.missing } })),
		notTransformed,
		announcement: announcementReport,
	});
	writeFileSync(join(reportDir, "coverage.md"), transformReport(config.name, results, checks, notTransformed, site, announcementReport));
	reporter.emit({ type: "log", level: "info", message: `Report: ${join(reportDir, "coverage.md")}` });
	return checks;
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
