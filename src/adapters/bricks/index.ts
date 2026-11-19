/**
 * Bricks Builder adapter (Bricks 2.4.6 stable, 2.5 beta). Bricks stores a page as a flat list of elements in post
 * meta `_bricks_page_content_2` (`{ id, name, parent, children[], settings, label?, cid?, properties? }`; `parent` 0
 * for top-level elements), not in post_content. Header and footer templates keep theirs in `_bricks_page_header_2` /
 * `_bricks_page_footer_2` (site.ts).
 *
 * Elements → tree → rows (a top-level `section`/`container`; a row-direction or multi-track grid container's
 * structural children are the columns; nested rows become sub-rows) → the shared section recognisers, like the
 * WPBakery and Gutenberg adapters. Styling (element settings merged with its global classes; colours resolved
 * through the palette and global variables; padding per breakpoint) maps onto the WPBakery-style row attributes the
 * recognisers read. Components and section templates are inlined. Unknown elements are reported as unmapped, never
 * dropped silently. Verified facts: docs/spikes/bricks-findings.md.
 */
import type { Diagnostic, IrMenuItem, PtBlock, Section, SectionType } from "../../ir/schema.js";
import type { Keys } from "../../ir/portable-text.js";
import type { BricksBox } from "../../audit/browser.js";
import type { FormDefinitionOut } from "../../scaffold/forms.js";
import { fluid } from "../../scaffold/generate.js";
import { type Col, type Fragment, type HandlerCtx, mediaFrom } from "../wpbakery/elements.js";
import { mergeRich, recognise, type Row, splitRow } from "../wpbakery/index.js";
import { DECORATIVE, DYNAMIC, dynamicListing, type Env, HANDLERS, isFilter, linkOf, mediaOf, navMenuLinks, plain } from "./elements.js";
import { atBreakpoint, type BricksSite, cssPx, effectiveSettings, emptySite, obj, pxOf, resolveColour, screens, str } from "./site.js";

export { bricksSite, type BricksSite, siteTemplates, templateElements, templateType, bricksDesign, BRICKS_OPTIONS, liveVariables } from "./site.js";
export { bricksFormToDefinition } from "./forms.js";

export interface BricksElement {
	id: string;
	name: string;
	parent: string | number;
	children?: string[];
	settings?: Record<string, unknown>;
	label?: string;
	/** Component instance: the component id (`bricks_components`), and its property values. */
	cid?: string;
	properties?: Record<string, unknown>;
}

export interface BricksOptions {
	kind: "page" | "post" | "partial" | "popup";
	keys: Keys;
	popupFor: HandlerCtx["popupFor"];
	postCount: number;
	/** A Bricks template's elements by post id (the `template` element embeds one). */
	template?: (id: number) => BricksElement[] | undefined;
	rowOverrides?: Record<string, SectionType | "drop">;
	/** Palette, global classes, theme style, components, breakpoints (WordPress options). */
	site?: BricksSite;
	/** The post the elements belong to (form ids are `<post>-<element>`). */
	postId?: number;
	/** The post's own post_content (Gutenberg/classic): what a post-content element or `{post_content}` shows. */
	content?: string;
	/** Reusable block / synced pattern by id (inside the post content). */
	reusable?: (id: number) => string | undefined;
	/** Page title and site title, for `{post_title}` / `{site_title}` and the post-title element. */
	title?: string;
	siteTitle?: string;
	/** Internal link (`{ type: internal, postId }`) → the migrated path. */
	permalink?: (postId: number) => string | undefined;
	/** Bricks popup template id → the IR popup slug (buttons whose interaction shows a popup). */
	popupSlug?: (templateId: number) => string | undefined;
	/**
	 * The live element's measured box per viewport (audit screenshots), by its position on the page: `c:<top-level
	 * index>/<child index>/…` (content) or `f:…` (footer template). Real gaps, widths and text sizes.
	 */
	measured?: (key: string) => Partial<Record<"desktop" | "tablet" | "mobile", BricksBox>> | undefined;
	/** A WordPress menu by id (a nav-menu element's `menu` setting) → its top-level items (links). */
	menuItems?: (menuId: string) => IrMenuItem[] | undefined;
}

export interface BricksResult {
	sections: Section[];
	diagnostics: Diagnostic[];
	/** Form definitions of the form elements on the page (written to ir/forms by transform). */
	forms: FormDefinitionOut[];
}

/** Structural elements: they hold other elements and carry layout, not content. */
const STRUCTURE = new Set(["section", "container", "block", "div"]);

const isRoot = (p: string | number | null | undefined) => p === 0 || p === "0" || p === "" || p === null || p === undefined;

/**
 * Read the meta value: an element array, an object keyed by index (PHP arrays that lost their order), or JSON text.
 * A PHP-serialized string is not decoded here (the exporter returns unserialized meta); it is reported instead.
 */
export function bricksElements(meta: unknown): BricksElement[] | undefined {
	let v = meta;
	if (typeof v === "string") {
		const t = v.trim();
		if (!t.startsWith("[") && !t.startsWith("{")) return undefined;
		try {
			v = JSON.parse(t);
		} catch {
			return undefined;
		}
	}
	const list = Array.isArray(v) ? v : obj(v) ? Object.values(v as object) : undefined;
	if (!list) return undefined;
	const els = list.filter((e): e is BricksElement => !!obj(e) && typeof (e as BricksElement).id === "string" && typeof (e as BricksElement).name === "string");
	return els.length ? els : undefined;
}

/** True when the post is edited with Bricks (its element list is set and the editor mode is not WordPress). */
export function isBricks(meta: Record<string, unknown> | undefined): boolean {
	if (!meta) return false;
	const mode = str(meta._bricks_editor_mode);
	return mode !== "wordpress" && !!bricksElements(meta._bricks_page_content_2);
}

/** Number of tracks in a grid-template-columns value (`1fr 2fr`, `repeat(3, 1fr)`, `repeat(auto-fit, minmax(…))`). */
export function gridTracks(v: unknown): number[] | undefined {
	const t = str(v)?.trim();
	if (!t) return undefined;
	const rep = /^repeat\(\s*(\d+)\s*,\s*([^)]+)\)$/.exec(t);
	if (rep) return Array.from({ length: Number(rep[1]) }, () => Number.parseFloat(rep[2] as string) || 1);
	if (/auto-(fit|fill)/.test(t)) return undefined;
	const parts = t.split(/\s+(?![^(]*\))/).filter(Boolean);
	return parts.map((p) => (/fr$/.test(p) ? Number.parseFloat(p) || 1 : 1));
}

const FRACTIONS: [number, string][] = [[1 / 6, "1/6"], [1 / 4, "1/4"], [1 / 3, "1/3"], [1 / 2, "1/2"], [2 / 3, "2/3"], [3 / 4, "3/4"]];
const fraction = (f: number) => FRACTIONS.find(([v]) => Math.abs(v - f) < 0.02)?.[1];

export function adaptBricks(elements: BricksElement[], opts: BricksOptions): BricksResult {
	const site = opts.site ?? emptySite();
	const { desktop, tablet, phone } = screens(site);
	/** The screen width the kit measures a breakpoint at (verify viewports: 1440 / 768 / 390). */
	const widthOf = (bp: string) => (bp === phone ? 390 : bp === tablet ? 768 : 1440);
	const diagnostics: Diagnostic[] = [];
	const diag = (d: Diagnostic) => diagnostics.push(d);
	const forms = new Map<string, FormDefinitionOut>();
	const ctxFor = (path: string): HandlerCtx => ({ keys: opts.keys, path, diag, popupFor: opts.popupFor, postCount: opts.postCount, children: () => [] });
	const all: BricksElement[] = [...elements];
	const byId = new Map(all.map((e) => [e.id, e]));
	/** Element id → the post whose element list holds it (templates). */
	const sourceOf = new Map<string, number>();
	/** Slot element (inside a component) → the component instance whose children fill it. */
	const slotOf = new Map<string, BricksElement>();
	const effCache = new Map<BricksElement, Record<string, unknown>>();
	const eff = (e: BricksElement) => {
		let s = effCache.get(e);
		if (!s) effCache.set(e, (s = effectiveSettings(e, site)));
		return s;
	};
	let currentSource: number | undefined;

	// Children in the order the parent lists them; elements a parent does not list follow in document order.
	const childrenOf = (e: BricksElement): BricksElement[] => {
		const listed = (e.children ?? []).flatMap((id) => byId.get(String(id)) ?? []);
		const extra = all.filter((x) => String(x.parent) === e.id && !listed.includes(x));
		return [...listed, ...extra];
	};
	const pathOf = (e: BricksElement) => `${e.name}#${e.id}`;

	/** Copy another element list (template, component) into this tree under an id prefix; returns its roots. */
	const grafted = new Map<string, BricksElement[]>();
	function graft(els: BricksElement[], prefix: string, source?: number): BricksElement[] {
		const done = grafted.get(prefix);
		if (done) return done;
		// The roots hang off a parent id that no element has, so no existing element lists them as extra children.
		const parent = `${prefix}~^`;
		const ids = new Set(els.map((x) => x.id));
		const out = els.map((x) => ({ ...x, id: `${prefix}~${x.id}`, parent: isRoot(x.parent) || !ids.has(String(x.parent)) ? parent : `${prefix}~${x.parent}`, children: (x.children ?? []).map((c) => `${prefix}~${c}`), settings: { ...(x.settings ?? {}) } }));
		for (const x of out) {
			all.push(x);
			byId.set(x.id, x);
			if (source !== undefined) sourceOf.set(x.id, source);
		}
		const roots = out.filter((x) => x.parent === parent);
		grafted.set(prefix, roots);
		return roots;
	}

	const openTemplates = new Set<number>();
	/** A `template` element → the template's top-level elements, grafted in place. */
	function templateRoots(e: BricksElement, path: string): BricksElement[] | undefined {
		const id = Number(e.settings?.template);
		const els = Number.isInteger(id) && id > 0 && !openTemplates.has(id) ? opts.template?.(id) : undefined;
		if (!els) {
			diag({ level: "error", code: "unmapped", message: `[template] ${id || "?"} could not be loaded${openTemplates.has(id) ? " (it embeds itself)" : ""}`, path, carriesContent: true, tag: e.name });
			return undefined;
		}
		return graft(els, `${e.id}t${id}`, id);
	}

	/** A component instance → the component's root element (grafted, property values applied). */
	function componentRoot(e: BricksElement, path: string): BricksElement | undefined {
		const comp = site.components.get(String(e.cid));
		if (!comp?.elements.length) {
			diag({ level: "error", code: "unmapped", message: `Bricks component ${e.cid} not found (bricks_components option missing from the extract?)`, path, carriesContent: true, tag: e.name });
			return undefined;
		}
		const els = comp.elements.map((x) => ({ ...x, settings: { ...(x.settings ?? {}) } }));
		// Instance values (else the property default) go to the connected element settings (includes/helpers.php).
		for (const p of comp.properties) {
			const v = e.properties?.[p.id] ?? p.default;
			if (v === undefined || v === "" || v === null) continue;
			for (const [elId, keys] of Object.entries(p.connections)) {
				const target = els.find((x) => x.id === elId);
				if (target) for (const k of keys) (target.settings as Record<string, unknown>)[k] = v;
			}
		}
		const rootIdx = els.findIndex((x) => x.id === comp.id || isRoot(x.parent));
		const roots = graft(els, e.id, sourceOf.get(e.id) ?? currentSource);
		for (const x of all) if (x.name === "slot" && x.id.startsWith(`${e.id}~`)) slotOf.set(x.id, e);
		const root = roots.find((x) => x.id === `${e.id}~${els[rootIdx]?.id}`) ?? roots[0];
		// The instance keeps its own id and class settings on top of the component root's.
		if (root) root.settings = { ...root.settings, ...(e.settings ?? {}) };
		return root;
	}

	/** Hidden at the widest breakpoint: not migrated (a phone-only duplicate is common), reported. */
	function hidden(e: BricksElement, path: string, report = true): boolean {
		const s = eff(e);
		// "Hide element on frontend" (Bricks 1.9+ `_hideElementFrontend`): Bricks does not render it on the live site.
		if (s._hideElementFrontend === true || s._hideElementFrontend === "true") {
			if (report) diag({ level: "warn", code: "lossy", message: `[${e.name}] is hidden on the live site (Bricks "Hide element on frontend"); not migrated`, path, tag: e.name });
			return true;
		}
		if (atBreakpoint(s, "_display", desktop, site) !== "none") return false;
		if (!report) return true;
		const shownSmall = site.breakpoints.some((b) => b.key !== desktop && atBreakpoint(s, "_display", b.key, site) !== "none");
		diag({ level: "warn", code: "lossy", message: `[${e.name}] hidden on desktop${shownSmall ? " (shown on smaller screens: usually a phone-only copy)" : ""}; not migrated`, path, tag: e.name });
		return true;
	}

	const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
	/** A counter's label is the short text right after it (Bricks counters have no label setting). */
	function labelStats(frags: Fragment[]): Fragment[] {
		const out: Fragment[] = [];
		for (let i = 0; i < frags.length; i++) {
			const f = frags[i] as Fragment;
			const next = frags[i + 1];
			if (f.kind === "stat" && !f.item.label && next?.kind === "rich" && next.blocks[0] && words(plain(next.blocks[0])) <= 8) {
				out.push({ ...f, item: { ...f.item, label: plain(next.blocks[0]) } });
				if (next.blocks.length > 1) out.push({ ...next, blocks: next.blocks.slice(1) });
				i++;
				continue;
			}
			out.push(f);
		}
		return out;
	}

	function isRowBox(e: BricksElement): boolean {
		const s = eff(e);
		const dir = str(atBreakpoint(s, "_direction", desktop, site));
		if (dir === "row" || dir === "row-reverse") return true;
		return str(atBreakpoint(s, "_display", desktop, site)) === "grid" && (gridTracks(atBreakpoint(s, "_gridTemplateColumns", desktop, site))?.length ?? 0) >= 2;
	}

	let rowTracks: number | undefined;
	function columnsOfBox(box: BricksElement, path: string): Col[] {
		const s = eff(box);
		const tracks = str(atBreakpoint(s, "_display", desktop, site)) === "grid" ? gridTracks(atBreakpoint(s, "_gridTemplateColumns", desktop, site)) : undefined;
		const kids = childrenOf(box);
		if (tracks && tracks.length >= 2 && kids.length > tracks.length) rowTracks = tracks.length;
		const total = tracks?.reduce((a, b) => a + b, 0) ?? 0;
		return kids.map((k, i) => {
			const c = column(k, `${path}/${pathOf(k)}`);
			const t = tracks && kids.length === tracks.length ? fraction((tracks[i] as number) / total) : undefined;
			return t && !c.width ? { ...c, width: t } : c;
		});
	}

	function fragments(e: BricksElement, path: string): Fragment[] {
		if (hidden(e, path)) return [];
		if (e.cid) {
			const root = componentRoot(e, path);
			return root ? fragments(root, `${path}/component#${e.cid}`) : [];
		}
		if (e.name === "template") {
			const id = Number(e.settings?.template);
			const roots = templateRoots(e, path);
			if (!roots) return [];
			openTemplates.add(id);
			const prev = currentSource;
			currentSource = id;
			const out = mergeRich(roots.flatMap((x) => fragments(x, `${path}/template#${id}/${pathOf(x)}`)));
			currentSource = prev;
			openTemplates.delete(id);
			return out;
		}
		if (e.name === "slot") {
			const inst = slotOf.get(e.id);
			return inst ? mergeRich(childrenOf(inst).flatMap((c) => fragments(c, `${path}/${pathOf(c)}`))) : [];
		}
		if (e.name === "posts") return dynamicListing(e, e.settings?.query, path, env, "posts element");
		if (STRUCTURE.has(e.name)) {
			if (e.settings?.hasLoop) return dynamicListing(e, e.settings.query, path, env);
			if (e.settings?._conditions) diag({ level: "info", code: "flagged", message: `[${e.name}] has display conditions in Bricks; its content is migrated unconditionally`, path, tag: e.name });
			const kids = childrenOf(e);
			if (kids.length >= 2 && kids.every((k) => STRUCTURE.has(k.name) || !!k.cid) && isRowBox(e)) return [{ kind: "subrow", columns: columnsOfBox(e, path) }];
			const inner = labelStats(mergeRich(kids.flatMap((c) => fragments(c, `${path}/${pathOf(c)}`))));
			const row = linkRow(e, inner);
			if (row) return row;
			return e.settings?.link ? linkedBox(e, inner, path) : inner;
		}
		if (e.settings?._conditions) diag({ level: "info", code: "flagged", message: `[${e.name}] has display conditions in Bricks; migrated unconditionally`, path, tag: e.name });
		if (str(eff(e)._columns)) diag({ level: "info", code: "lossy", message: `[${e.name}] CSS columns (${str(eff(e)._columns)}, Bricks 2.5) not reproduced; text kept in one column`, path, tag: e.name });
		return leaf(e, path);
	}

	/**
	 * A row box (flex row) whose children are only text links (NextBricks underlined-hover, text-link, linked icons): one
	 * line of links, in place, instead of separate link buttons (a footer's legal links, social links).
	 */
	function linkRow(e: BricksElement, frags: Fragment[]): Fragment[] | undefined {
		if (frags.length < 2 || !isRowBox(e) || !frags.every((f) => f.kind === "button" && f.button.style === "link" && !f.button.opensPopup && f.button.href !== "#")) return undefined;
		const links = frags.map((f) => (f as Extract<Fragment, { kind: "button" }>).button);
		// Social links: one paragraph (the starter draws them as round icons, column field social_icons). Two lists in a row
		// would merge into one, so only the other links become a list.
		if (links.every((b) => SOCIAL.test(b.href))) {
			const children: PtBlock["children"] = [];
			const markDefs: PtBlock["markDefs"] = [];
			links.forEach((b, i) => {
				const key = opts.keys.next();
				if (i) children.push({ _type: "span", _key: opts.keys.next(), text: " ", marks: [] });
				children.push({ _type: "span", _key: opts.keys.next(), text: b.label, marks: [key] });
				markDefs.push({ _type: "link", _key: key, href: b.href, ...(b.newTab ? { blank: true } : {}) });
			});
			return [{ kind: "rich", blocks: [{ _type: "block", _key: opts.keys.next(), style: "normal", children, markDefs }] }];
		}
		// Other links: a list of links (one item per link), drawn as a row by the starter (column field link_gap).
		const blocks: PtBlock[] = frags.map((f) => {
			const b = (f as Extract<Fragment, { kind: "button" }>).button;
			const key = opts.keys.next();
			return { _type: "block", _key: opts.keys.next(), style: "normal", listItem: "bullet", level: 1, children: [{ _type: "span", _key: opts.keys.next(), text: b.label, marks: [key] }], markDefs: [{ _type: "link", _key: key, href: b.href, ...(b.newTab ? { blank: true } : {}) }] };
		});
		return [{ kind: "rich", blocks }];
	}

	const SOCIAL = /^https?:\/\/(?:www\.)?(?:instagram\.com|tiktok\.com|facebook\.com|youtube\.com|linkedin\.com|x\.com|twitter\.com|pinterest\.[a-z.]+)\//i;
	/** Pixels of a length setting (px, rem/em, a global variable), when it is a plain length. */
	const lenPx = (v: unknown, bp = desktop) => cssPx(v, site, widthOf(bp));
	/** A typography setting's font size (px). */
	const fontPx = (s: Record<string, unknown>) => lenPx(obj(s.titleTypography)?.["font-size"] ?? obj(s._typography)?.["font-size"]);
	const LINKISH = new Set(["text-link", "underlined-hover", "icon", "button"]);
	/** The live element's measured box (audit), paired by position; only when the rendered element is of the same type. */
	const measuredBox = (x: BricksElement, vp: "desktop" | "tablet" | "mobile" = "desktop") => {
		const key = domKey.get(x);
		const b = key ? opts.measured?.(key)?.[vp] : undefined;
		return b && b.name === x.name ? b : undefined;
	};
	/** A gap: as measured on the live page, else from the settings (global / live design variables). */
	const gapOf = (x: BricksElement, axis: "row" | "column") => {
		const m = measuredBox(x);
		if (m) return Math.round((axis === "row" ? m.rowGap : m.colGap) ?? 0);
		const s = eff(x);
		const v = lenPx(atBreakpoint(s, axis === "row" ? "_rowGap" : "_columnGap", desktop, site) ?? atBreakpoint(s, "_gap", desktop, site));
		return v === undefined ? undefined : Math.round(v);
	};
	/** A text element's size: its typography setting, else as measured on the live page. */
	// Settings first: third-party elements (NextBricks titles) set the size on an inner node, so the measured outer box
	// shows the inherited body size.
	const textPx = (x: BricksElement) => fontPx(eff(x)) ?? measuredBox(x)?.font;
	const PICTURE = new Set(["image", "logo", "imagereveal"]);
	/**
	 * The weight, letter spacing (px) and line height (unitless) that every one of these elements sets the same way in
	 * its typography (`_typography`, or a NextBricks title's `titleTypography`); a value only when they all agree.
	 */
	function typeOf(list: BricksElement[]): { weight?: number; tracking?: number; leading?: number } {
		if (!list.length) return {};
		const t = (x: BricksElement) => ({ ...(obj(atBreakpoint(eff(x), "_typography", desktop, site)) ?? {}), ...(obj(atBreakpoint(eff(x), "titleTypography", desktop, site)) ?? {}) });
		const same = (read: (o: Record<string, unknown>) => number | undefined) => {
			const v = new Set(list.map((x) => read(t(x))));
			return v.size === 1 ? [...v][0] : undefined;
		};
		const weight = same((o) => Number(str(o["font-weight"]) ?? Number.NaN));
		const tracking = same((o) => (str(o["letter-spacing"]) !== undefined ? lenPx(o["letter-spacing"]) : undefined));
		const leading = same((o) => {
			const v = str(o["line-height"])?.trim();
			return v && /^\d*\.?\d+$/.test(v) ? Number(v) : undefined;
		});
		return {
			...(weight !== undefined && Number.isInteger(weight) && weight >= 100 && weight <= 900 ? { weight } : {}),
			...(tracking !== undefined && tracking >= 0 && tracking <= 5 ? { tracking } : {}),
			...(leading !== undefined && leading >= 1 && leading <= 3 ? { leading } : {}),
		};
	}
	/**
	 * Bricks blocks are flex columns: the look of a stacked column (a centred footer: logo, a row of links, social icons,
	 * the credit line) — the picture's width cap, the gap between items, link rows and their gap, text sizes.
	 */
	function stackLook(box: BricksElement): { stack?: NonNullable<Col["stack"]>; centered?: boolean } {
		let e = box;
		for (let i = 0; i < 3; i++) {
			const kids = childrenOf(e);
			if (kids.length !== 1 || !STRUCTURE.has(kids[0]?.name ?? "")) break;
			e = kids[0] as BricksElement;
		}
		if (isRowBox(e) || childrenOf(e).length < 2) return {};
		const s = eff(e);
		const out: NonNullable<Col["stack"]> = {};
		const gap = gapOf(e, "row");
		if (gap !== undefined && gap >= 0 && gap <= 200) out.itemGap = gap;
		const all: BricksElement[] = [];
		const walk = (x: BricksElement) => {
			for (const k of childrenOf(x)) {
				if (hidden(k, "", false)) continue;
				all.push(k);
				walk(k);
			}
		};
		walk(e);
		const img = all.find((x) => PICTURE.has(x.name));
		// The picture's own width (px, or a design variable such as var(--width-l)): the live box when measured.
		const wSet = img ? [eff(img)._widthMax, eff(img)._width].find((v) => str(v) && !/%$|^auto$|^fit-content$/.test((str(v) as string).trim())) : undefined;
		const w = img && wSet !== undefined ? (measuredBox(img)?.w ?? lenPx(wSet)) : undefined;
		if (w && w <= 2000) out.imageWidth = `${Math.round(w)}px`;
		if (img && out.imageWidth) {
			// A fixed picture height (NextBricks image reveal `height`, an image `_height`), desktop and phones.
			const hSet = img.name === "imagereveal" ? eff(img).height : eff(img)._height;
			const h = str(hSet) ? (measuredBox(img)?.h ?? lenPx(hSet)) : undefined;
			if (h && h >= 40 && h <= 2000) out.imageHeight = `${Math.round(h)}px`;
			const hp = str(hSet) ? (measuredBox(img, "mobile")?.h ?? lenPx(img.name === "imagereveal" ? atBreakpoint(eff(img), "height", phone, site) : atBreakpoint(eff(img), "_height", phone, site), phone)) : undefined;
			if (out.imageHeight && hp && hp >= 40 && hp <= 2000 && Math.round(hp) !== Math.round(h ?? 0)) out.imageHeightPhone = `${Math.round(hp)}px`;
			// Text before the picture in the builder: the picture comes after it.
			const firstText = all.findIndex((x) => !STRUCTURE.has(x.name) && !PICTURE.has(x.name));
			if (firstText >= 0 && firstText < all.indexOf(img)) out.imageAfter = true;
		}
		// Space under the picture beyond the stack gap: the bottom margin of the picture or of its own wrapper box.
		if (img && out.imageWidth) {
			const holders = [img, ...all.filter((x) => STRUCTURE.has(x.name) && childrenOf(x).length === 1 && childrenOf(x)[0] === img)];
			const mb = holders.map((x) => lenPx(obj(atBreakpoint(eff(x), "_margin", desktop, site))?.bottom)).find((v) => v !== undefined);
			if (mb && mb > 0 && mb <= 200) out.imageSpace = Math.round(mb);
		}
		const rows = all.filter((x) => STRUCTURE.has(x.name) && isRowBox(x) && childrenOf(x).length >= 2 && childrenOf(x).every((k) => LINKISH.has(k.name) && !!k.settings?.link) && !childrenOf(x).every((k) => k.name === "button"));
		const row = rows[0];
		if (row) {
			out.linkGap = gapOf(row, "column") ?? 0;
			const sizes = new Set(childrenOf(row).map((k) => textPx(k)));
			const size = sizes.size === 1 ? [...sizes][0] : undefined;
			if (size && size >= 10 && size <= 40) out.linkSize = Math.round(size);
			const lt = typeOf(childrenOf(row));
			if (lt.weight) out.linkWeight = lt.weight;
			if (lt.tracking !== undefined) out.linkTracking = lt.tracking;
			if (lt.leading) out.linkLeading = lt.leading;
			const icons = rows.find((r) => childrenOf(r).some((k) => k.name === "icon"));
			if (icons) out.socialIcons = gapOf(icons, "column") ?? 0;
		}
		const inRow = new Set(rows.flatMap((r) => childrenOf(r)));
		const texts = all.filter((x) => !STRUCTURE.has(x.name) && !inRow.has(x) && ["heading", "text-basic", "text"].includes(x.name));
		const tsizes = new Set(texts.map((x) => textPx(x)));
		const tsize = texts.length && tsizes.size === 1 ? [...tsizes][0] : undefined;
		if (tsize && tsize >= 10 && tsize <= 40) out.textSize = Math.round(tsize);
		// The text elements' own weight, letter spacing and line height (a 400 text in a site whose body is 300; a credit
		// line in 14px with 0.5px tracking). Headings printed as a paragraph or span (custom tag) count as text.
		const body = texts.filter((x) => x.name !== "heading" || (str(x.settings?.tag) === "custom" && /^(?:span|p|div)$/.test(str(x.settings?.customTag) ?? "")));
		const tt = typeOf(body);
		if (tt.weight) out.textWeight = tt.weight;
		if (tt.tracking !== undefined) out.textTracking = tt.tracking;
		if (tt.leading) out.textLeading = tt.leading;
		// A rich text element with several paragraphs: they keep the paragraph spacing between them (Automatic.css
		// `--paragraph-spacing`, else the browser's 1em margins), not the stack's gap between elements.
		if (out.itemGap !== undefined && texts.some((x) => x.name === "text" && ((str(x.settings?.text) ?? "").match(/<(?:p|ul|ol|h[1-6]|blockquote)[\s>]/gi)?.length ?? 0) >= 2)) {
			const ps = site.live?.widths.at(-1)?.vars["paragraph-spacing"]?.trim();
			const em = ps && /^\d*\.?\d+em$/.test(ps) ? Number.parseFloat(ps) : 1;
			if (em >= 0 && em <= 4) out.paraGap = em;
		}
		// A paragraph with its own width (`_width: var(--width-m)`): the column's paragraphs keep that measure.
		const narrow = texts.find((x) => x.name !== "heading" && str(eff(x)._width) && !/%$|^auto$/.test((str(eff(x)._width) as string).trim()));
		const tw = narrow ? (measuredBox(narrow)?.w ?? lenPx(eff(narrow)._width)) : undefined;
		if (out.itemGap !== undefined && tw && tw >= 120 && tw <= 2000) out.textWidth = Math.round(tw);
		// Else the stack box's own width (`_width: var(--width-l)`): its texts are no wider (centred items shrink to their
		// text, so a long paragraph would otherwise run the full section width).
		const boxW = str(atBreakpoint(s, "_width", desktop, site))?.trim();
		const bw = out.textWidth === undefined && boxW && !/%$|^auto$|^fit-content$/.test(boxW) ? (measuredBox(e)?.w ?? lenPx(boxW)) : undefined;
		if (out.itemGap !== undefined && bw && bw >= 120 && bw <= 2000) out.textWidth = Math.round(bw);
		// The gap per screen when the live boxes were measured (a fluid design variable): phone to desktop.
		const fg = out.itemGap !== undefined ? fluidGap(e, "row") : undefined;
		if (fg?.startsWith("clamp(")) out.itemGapFluid = fg;
		// Texts grouped in their own box inside the stack (heading + description): that box's row gap between them.
		const group = texts[0] ? all.find((x) => STRUCTURE.has(x.name) && childrenOf(e).includes(x) && childrenOf(x).filter((k) => texts.includes(k)).length >= 2) : undefined;
		const tg = group ? gapOf(group, "row") : undefined;
		if (out.itemGap !== undefined && tg !== undefined && tg !== out.itemGap && tg <= 200) out.textGap = tg;
		if (!Object.keys(out).length) return {};
		// align-items: center centres each item as a box; the text itself is centred only when its own setting says so.
		if (str(atBreakpoint(s, "_alignItems", desktop, site)) === "center") out.itemsCenter = true;
		const align = (x: BricksElement) => str(obj(atBreakpoint(eff(x), "_typography", desktop, site))?.["text-align"] ?? obj(atBreakpoint(eff(x), "titleTypography", desktop, site))?.["text-align"]);
		const centered = texts.length > 0 && texts.every((x) => align(x) === "center");
		return { stack: out, ...(centered ? { centered: true } : {}) };
	}

	/**
	 * A Bricks hero's own look: the content box's width, the heading's size (desktop, phones) and line height, the body
	 * text size, the gap between heading and text (the text block's row gap), the space above the buttons (its parent's
	 * row gap) and between them (the button row's column gap). Values resolve through global and live design variables.
	 */
	function heroLook(root: BricksElement, sec: Section): void {
		if (sec.type !== "hero") return;
		const all: BricksElement[] = [];
		const walk = (x: BricksElement) => {
			for (const k of childrenOf(x)) {
				if (hidden(k, "", false)) continue;
				all.push(k);
				walk(k);
			}
		};
		walk(root);
		const parentOf = (x: BricksElement) => all.find((p) => childrenOf(p).includes(x)) ?? root;
		const TITLE = new Set(["heading", "blade-title", "next_blur_reveal", "swap-hover", "underlined-hover", "text-basic", "text"]);
		const titleTag = (x: BricksElement) => {
			const t = str(x.settings?.tag);
			return t === "custom" ? str(x.settings?.customTag) : (t ?? (x.name === "heading" || x.name === "blade-title" ? "h3" : "p"));
		};
		const heading = all.find((x) => TITLE.has(x.name) && /^h[1-6]$/.test(titleTag(x) ?? ""));
		const look: NonNullable<Extract<Section, { type: "hero" }>["fields"]["look"]> = {};
		const box = all.find((x) => STRUCTURE.has(x.name) && lenPx(eff(x)._width ?? eff(x)._widthMax) !== undefined);
		const w = box ? lenPx(eff(box)._width ?? eff(box)._widthMax) : undefined;
		if (w && w >= 200 && w <= 2000) look.width = `${Math.round(w)}px`;
		if (heading) {
			const hs = eff(heading);
			const size = fontPx(hs);
			if (size && size >= 12 && size <= 200) sec.headingSize = `${Math.round(size)}px`;
			const small = cssPx(obj(atBreakpoint(hs, "titleTypography", phone, site))?.["font-size"] ?? obj(atBreakpoint(hs, "_typography", phone, site))?.["font-size"], site, 390);
			if (small && small >= 12 && small <= 200 && small !== size) look.headingSizePhone = `${Math.round(small)}px`;
			const lh = str(obj(hs._typography)?.["line-height"] ?? obj(hs.titleTypography)?.["line-height"])?.trim();
			const lead = lh && /^\d+(?:\.\d+)?(?:em)?$/.test(lh) ? Number.parseFloat(lh) : undefined;
			if (lead && lead >= 0.5 && lead <= 3) sec.headingLeading = lead;
			const info = parentOf(heading);
			const g = lenPx(atBreakpoint(eff(info), "_rowGap", desktop, site) ?? atBreakpoint(eff(info), "_gap", desktop, site));
			if (g !== undefined && g >= 0 && g <= 200) look.gap = Math.round(g);
			const body = all.find((x) => TITLE.has(x.name) && x !== heading && !/^h[1-6]$/.test(titleTag(x) ?? ""));
			const bs = body ? fontPx(eff(body)) : undefined;
			const base = cssPx(obj(obj(site.themeStyle?.typography)?.typographyBody)?.["font-size"], site);
			const bodySize = bs ?? base;
			if (bodySize && bodySize >= 10 && bodySize <= 60) look.bodySize = `${Math.round(bodySize)}px`;
			const outer = parentOf(info);
			const above = lenPx(atBreakpoint(eff(outer), "_rowGap", desktop, site) ?? atBreakpoint(eff(outer), "_gap", desktop, site));
			const first = sec.fields.buttons[0];
			if (first && above !== undefined && above >= 0 && above <= 200) first.spaceAbove = Math.round(above);
			// Measured per screen (a fluid design variable such as --space-l): phone to desktop.
			const fa = first ? fluidGap(outer, "row") : undefined;
			if (fa?.startsWith("clamp(")) look.buttonsAbove = fa;
		}
		const btnRow = all.find((x) => STRUCTURE.has(x.name) && childrenOf(x).length >= 2 && childrenOf(x).every((k) => k.name === "button" || k.name.startsWith("ripple_button")));
		const bg = btnRow ? lenPx(atBreakpoint(eff(btnRow), "_columnGap", desktop, site) ?? atBreakpoint(eff(btnRow), "_gap", desktop, site)) : undefined;
		if (bg !== undefined && bg >= 0 && bg <= 100) look.buttonsGap = Math.round(bg);
		if (Object.keys(look).length) sec.fields.look = look;
	}

	/** A spacing per screen: the live boxes' measurement (phone → desktop, fluid), else the setting at desktop. */
	const fluidGap = (x: BricksElement, axis: "row" | "column"): string | undefined => {
		const d = measuredBox(x)?.[axis === "row" ? "rowGap" : "colGap"];
		const m = measuredBox(x, "mobile")?.[axis === "row" ? "rowGap" : "colGap"];
		if (d !== undefined && m !== undefined && d >= 0 && d <= 200 && m >= 0 && m <= 200) return fluid(m, d);
		const g = gapOf(x, axis);
		return g !== undefined && g >= 0 && g <= 200 ? `${g}px` : undefined;
	};
	const AUTO_WIDTH = /^(?:auto|fit-content|max-content)$/;
	/** HTML a `p` tag cannot hold: the browser closes the paragraph, so each block becomes an item of the box around it. */
	const BLOCK_HTML = /<(?:p|ul|ol|h[1-6]|blockquote|figure|table|div)[\s>]/i;
	/**
	 * A Bricks text section laid out by its boxes (a page title box, then the content box): Bricks sections centre their
	 * boxes, so a box with an automatic width is centred (the title); a `text-basic` (tag `p`) showing the post content
	 * or block HTML puts every block straight into its box, spaced by the box's row gap, not by paragraph margins.
	 */
	function textBoxes(root: BricksElement, sec: Section): void {
		if (sec.type !== "rich_text") return;
		const kids = childrenOf(root).filter((k) => !hidden(k, "", false));
		if (!kids.length || !kids.every((k) => STRUCTURE.has(k.name))) return;
		const sectionAlign = str(atBreakpoint(eff(root), "_alignItems", desktop, site));
		const centred = (x: BricksElement) => (!sectionAlign || sectionAlign === "center") && AUTO_WIDTH.test(str(atBreakpoint(eff(x), "_width", desktop, site))?.trim() ?? "");
		const titleOnly = (x: BricksElement) => childrenOf(x).every((k) => hidden(k, "", false) || ["post-title", "heading", "blade-title", "next_blur_reveal", "text-basic"].includes(k.name));
		const look: NonNullable<Extract<Section, { type: "rich_text" }>["fields"]["look"]> = { ...(sec.fields.look ?? {}) };
		const first = kids[0] as BricksElement;
		if (kids.every(centred) && kids.every(titleOnly)) {
			sec.fields.align = "center";
			look.headCenter = true;
			const g = fluidGap(first, "row");
			if (g) look.headGap = g;
		} else if (kids.length >= 2 && centred(first) && titleOnly(first)) {
			look.headCenter = true;
			const g = fluidGap(root, "row");
			if (g) look.headGap = g;
		}
		const flow = kids.find((k) => childrenOf(k).some((x) => x.name === "text-basic" && (str(x.settings?.tag) ?? "p") === "p" && (isPostContent(str(x.settings?.text)) || BLOCK_HTML.test(str(x.settings?.text) ?? ""))));
		if (flow) {
			const g = fluidGap(flow, "row");
			if (g) look.blockGap = g;
			if (!str(eff(flow)._width) && !str(eff(flow)._widthMax)) sec.fields.width = "wide";
		}
		if (Object.keys(look).length) sec.fields.look = look;
	}
	const isPostContent = (t: string | undefined) => t?.trim() === "{post_content}";
	/**
	 * A form in a Bricks flex column sits under its heading (not beside it): stacked, as wide as its own box (a container
	 * with `_width`), as far below as the shared box's row gap; a heading straight in the section is centred (Bricks
	 * sections centre their children).
	 */
	function formStack(root: BricksElement, sec: Section): void {
		if (sec.type !== "form") return;
		const parentOf = new Map<BricksElement, BricksElement>();
		const walk = (x: BricksElement): BricksElement[] => childrenOf(x).flatMap((k) => (hidden(k, "", false) ? [] : (parentOf.set(k, x), [k, ...walk(k)])));
		const all = walk(root);
		const form = all.find((x) => /form/i.test(x.name) || (x.name === "text-basic" && isPostContent(str(x.settings?.text))));
		if (!form) return;
		const chain: BricksElement[] = [];
		for (let p = parentOf.get(form); p; p = parentOf.get(p)) chain.push(p);
		if ([root, ...chain].some((x) => isRowBox(x))) return;
		sec.fields.stacked = true;
		const holder = parentOf.get(form);
		const hw = holder && holder !== root ? str(atBreakpoint(eff(holder), "_width", desktop, site))?.trim() : undefined;
		const w = hw && !/%$|^auto$/.test(hw) ? (measuredBox(holder as BricksElement)?.w ?? lenPx(hw)) : undefined;
		if (w && w >= 200 && w <= 2000) sec.fields.formWidth = Math.round(w);
		const heading = all.find((x) => ["heading", "post-title"].includes(x.name) && all.indexOf(x) < all.indexOf(form));
		if (heading) {
			const shared = [root, ...[...chain].reverse()].reverse().find((p) => walk(p).includes(heading));
			const g = shared ? fluidGap(shared, "row") : undefined;
			if (g) sec.fields.formGap = g;
			if (parentOf.get(heading) === root && root.name === "section") sec.headAlign = "center";
		}
	}
	/**
	 * A row of buttons the live page stacks on phones with every button as wide as the longest (measured: the row box is
	 * about twice as tall on phones as on desktop, and the buttons there are of one width): the section's buttons are
	 * of equal width, which the starter stacks on phones.
	 */
	function buttonRows(root: BricksElement, sec: Section): void {
		const walk = (x: BricksElement): BricksElement[] => childrenOf(x).flatMap((k) => (hidden(k, "", false) ? [] : [k, ...walk(k)]));
		const row = walk(root).find((x) => STRUCTURE.has(x.name) && childrenOf(x).length >= 2 && childrenOf(x).every((k) => k.name === "button"));
		if (!row) return;
		const d = measuredBox(row);
		const m = measuredBox(row, "mobile");
		const widths = childrenOf(row).map((k) => measuredBox(k, "mobile")?.w);
		if (!d || !m || widths.some((w) => w === undefined)) return;
		const ws = widths as number[];
		if (m.h >= d.h * 1.5 && Math.max(...ws) - Math.min(...ws) <= 1) sec.buttonsWidth = "equal";
	}

	/**
	 * A block/div/container with a link (`tag: a`, a whole contact card linking to tel:/mailto:/a map): its text keeps the
	 * link (every text without a link of its own becomes a link to the address), so the address is not lost.
	 */
	function linkedBox(e: BricksElement, frags: Fragment[], path: string): Fragment[] {
		const link = linkOf(e.settings?.link, env);
		if (!link.href) return frags;
		let linked = 0;
		const out = frags.map((f): Fragment => {
			if (f.kind !== "rich") return f;
			return {
				...f,
				blocks: f.blocks.map((b) => {
					if (b.markDefs?.some((d) => d._type === "link") || !b.children.some((c) => c.text.trim())) return b;
					const key = opts.keys.next();
					linked++;
					return { ...b, markDefs: [...(b.markDefs ?? []), { _type: "link" as const, _key: key, href: link.href as string, ...(link.newTab ? { blank: true } : {}) }], children: b.children.map((c) => ({ ...c, marks: [...(c.marks ?? []), key] })) };
				}),
			};
		});
		diag({ level: linked ? "info" : "warn", code: linked ? "lossy" : "link-unknown", message: linked ? `[${e.name}] linked box: its text links to ${link.href} (the whole box is no longer one link)` : `[${e.name}] links to ${link.href}, but holds no text without a link of its own to carry it; the box link is not kept`, path, tag: e.name });
		return out;
	}

	/** A structural element as a column: its fragments, background, width and text alignment. */
	function column(e: BricksElement, path: string): Col {
		const s = eff(e);
		const bg = obj(s._background);
		const bgImage = mediaOf(bg?.image);
		const color = resolveColour(bg?.color, site);
		const align = (bp: string) => str(obj(atBreakpoint(s, "_typography", bp, site))?.["text-align"]);
		const frags = fragments(e, path);
		const w = str(s._width)?.trim();
		const width = w && /%$/.test(w) ? fraction(Number.parseFloat(w) / 100) : undefined;
		return {
			fragments: frags.length && bgImage ? [{ kind: "media", media: bgImage, role: "background" }, ...frags] : frags,
			...(width ? { width } : {}),
			...(color ? { background: { color } } : {}),
			...(align(desktop) === "center" ? { centered: true } : align(desktop) === "right" ? { right: true } : {}),
			...(align(phone) === "center" && align(desktop) !== "center" ? { phoneCenter: true } : {}),
			...(align(tablet) === "center" && align(desktop) !== "center" ? { tabletCenter: true } : {}),
		};
	}

	const env: Env = {
		site,
		opts,
		diag,
		ctx: ctxFor,
		childrenOf,
		fragments,
		column,
		forms,
		sourceId: () => currentSource ?? opts.postId,
	};

	function leaf(e: BricksElement, path: string): Fragment[] {
		if (DECORATIVE.has(e.name)) {
			diag({ level: "info", code: "dropped-decorative", message: `[${e.name}] dropped (decorative)`, path, tag: e.name });
			return [];
		}
		if (e.name === "nav-menu") {
			const links = navMenuLinks(e, path, env);
			if (links) return links;
		}
		if (DYNAMIC.has(e.name) || isFilter(e.name)) {
			diag({ level: "info", code: "dynamic", message: `[${e.name}] is rendered by the site (menu, logo, post data, filters), not migrated as content`, path, tag: e.name });
			return [];
		}
		const handler = HANDLERS[e.name];
		if (handler) {
			const prev = currentSource;
			currentSource = sourceOf.get(e.id) ?? currentSource;
			const out = handler(e, e.settings ?? {}, path, env);
			currentSource = prev;
			return out;
		}
		const s = e.settings ?? {};
		const carries = ["text", "content", "title", "html", "code", "items", "image", "file", "link", "url", "address"].some((k) => {
			const v = s[k];
			return typeof v === "string" ? v.trim() !== "" : Array.isArray(v) ? v.length > 0 : !!obj(v);
		});
		diag({ level: carries ? "error" : "warn", code: "unmapped", message: `No handler for Bricks [${e.name}]${carries ? " (carries content)" : ""}`, path, carriesContent: carries, tag: e.name });
		return [];
	}

	/** A section's columns: the first row container (or the section itself) with two or more structural children. */
	function columnsOf(section: BricksElement, path: string): Col[] {
		let box: BricksElement | undefined = section;
		for (let depth = 0; box && depth < 3; depth++) {
			if (box.cid || box.name === "template" || hidden(box, path, false)) break;
			const kids = childrenOf(box);
			if (kids.length >= 2 && kids.every((k) => STRUCTURE.has(k.name)) && isRowBox(box) && !box.settings?.hasLoop) return columnsOfBox(box, depth ? `${path}/${pathOf(box)}` : path);
			box = kids.length === 1 && STRUCTURE.has(kids[0]?.name ?? "") && !kids[0]?.cid ? kids[0] : undefined;
		}
		const look = stackLook(section);
		return [{ fragments: fragments(section, path), ...(look.stack ? { stack: look.stack } : {}), ...(look.centered ? { centered: true } : {}) }];
	}

	/** The section and the single containers inside it, outermost first (styling may sit on either). */
	function chain(e: BricksElement): Record<string, unknown>[] {
		const out = [eff(e)];
		let box = e;
		for (let i = 0; i < 2; i++) {
			const kids = childrenOf(box);
			if (kids.length !== 1 || !STRUCTURE.has(kids[0]?.name ?? "")) break;
			box = kids[0] as BricksElement;
			out.push(eff(box));
		}
		return out;
	}

	/** Padding of the row element at a breakpoint, px. */
	function padAt(s: Record<string, unknown>, side: "top" | "bottom", bp: string): number | undefined {
		const p = obj(atBreakpoint(s, "_padding", bp, site));
		return cssPx(p?.[side], site, widthOf(bp));
	}

	/** A row's styling as the WPBakery-style row attributes the recognisers read, and its padding per screen. */
	function styleOf(e: BricksElement, path: string): { attrs: Record<string, string>; pad?: Section["pad"]; minHeight?: string; valign?: "middle" | "bottom" } {
		const [s, ...inner] = chain(e) as [Record<string, unknown>, ...Record<string, unknown>[]];
		const first = <T>(read: (x: Record<string, unknown>) => T | undefined) => [s, ...inner].map(read).find((v) => v !== undefined && v !== "");
		const a: Record<string, string> = {};
		// An inner box with rounded corners is a card inside the section, not the section's background (a grey call-to-action
		// panel): its background stays off the section (reported; the section library has no inner card).
		const card = inner.find((x) => obj(x._background)?.color && Object.values(obj(obj(x._border)?.radius) ?? {}).some((v) => (pxOf(str(v)) ?? 0) > 0));
		if (card) diag({ level: "info", code: "lossy", message: `[${e.name}] rounded inner panel background ${JSON.stringify(obj(card._background)?.color)} not reproduced (no inner card in the section library); the section keeps a plain background`, path, tag: e.name });
		const bg = [s, ...inner].filter((x) => x !== card).map((x) => obj(x._background)).find((v) => v !== undefined);
		const color = resolveColour(bg?.color, site);
		if (color) a.bg_color = color;
		else if (bg?.color) diag({ level: "info", code: "lossy", message: `[${e.name}] background colour ${JSON.stringify(bg.color)} not resolved (palette/variables missing from the extract?)`, path, tag: e.name });
		const image = mediaOf(bg?.image);
		if (image) a.bg_image = image.wpId ? String(image.wpId) : (image.url as string);
		if (str(bg?.videoUrl) && mediaFrom(str(bg?.videoUrl), "video")) {
			a.video_bg = "true";
			a.video_mp4 = str(bg?.videoUrl) as string;
		}
		if (image && (str(bg?.attachment) === "fixed" || first((x) => x._motionBackgroundParallax))) a.parallax_bg = "true";
		const grad = first((x) => obj(x._gradient));
		const css = gradientCss(grad);
		if (css) {
			a.gradient_type = "advanced";
			a.advanced_gradient = css;
		}
		const pad = obj(s._padding) ? s : (inner.find((x) => obj(x._padding)) ?? (e.name === "section" ? { _padding: obj(obj(site.themeStyle?.section)?.padding) } : s));
		const top = { d: padAt(pad, "top", desktop), t: padAt(pad, "top", tablet), p: padAt(pad, "top", phone) };
		const bottom = { d: padAt(pad, "bottom", desktop), t: padAt(pad, "bottom", tablet), p: padAt(pad, "bottom", phone) };
		if (top.d !== undefined) a.top_padding = `${top.d}px`;
		if (bottom.d !== undefined) a.bottom_padding = `${bottom.d}px`;
		const typo = first((x) => obj(x._typography));
		const textColor = resolveColour(typo?.color, site);
		if (textColor) a.text_color = isLight(textColor) ? "light" : "dark";
		if (str(typo?.["text-align"]) === "center") a.text_align = "center";
		const id = str(e.settings?._cssId);
		if (id) a.id = id;
		const tall = first((x) => [x._height, x._heightMin].map((v) => str(v)?.trim()).find((v) => v && /^100(?:d|s|l)?vh$/.test(v)));
		if (tall) {
			a.full_height = "yes";
			const justify = first((x) => str(x._justifyContent));
			const pos = justify === "center" ? "middle" : justify === "flex-end" ? "bottom" : undefined;
			if (pos) a.full_screen_row_position = pos;
		}
		// A minimum height that is not a full screen (90svh): the section keeps it, content placed as `_justifyContent` says.
		const minHeight = tall ? undefined : first((x) => [x._heightMin, x._height].map((v) => str(v)?.trim()).find((v) => v && /^\d+(?:\.\d+)?(?:vh|svh|dvh|lvh)$/.test(v)))?.replace(/lvh$/, "vh");
		const justify = first((x) => str(x._justifyContent));
		const valign = minHeight ? (justify === "center" ? ("middle" as const) : justify === "flex-end" ? ("bottom" as const) : undefined) : undefined;
		// Overlay: a childless box laid absolutely over the section with a background colour (an ".overlay" div); its colour's
		// alpha is the overlay strength (the section overlay is black).
		const overlay = childrenOf(e).find((k) => STRUCTURE.has(k.name) && !childrenOf(k).length && str(eff(k)._position) === "absolute" && !!obj(eff(k)._background)?.color);
		if (overlay) {
			const c = resolveColour(obj(eff(overlay)._background)?.color, site);
			const rgba = c ? /^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+%?))?\s*\)$/i.exec(c) : null;
			const alpha = rgba?.[4] ? (rgba[4].endsWith("%") ? Number.parseFloat(rgba[4]) / 100 : Number.parseFloat(rgba[4])) : undefined;
			if (rgba && Math.max(Number(rgba[1]), Number(rgba[2]), Number(rgba[3])) <= 40) a.color_overlay = `rgba(0, 0, 0, ${alpha ?? 1})`;
			else diag({ level: "info", code: "lossy", message: `[${e.name}] overlay box ${JSON.stringify(obj(eff(overlay)._background)?.color)} ${c ? "is not black" : "not resolved"}; the section overlay is black only`, path, tag: e.name });
		}
		const inW = inner.map((x) => str(x._width)?.trim() ?? str(x._widthMax)?.trim()).find(Boolean);
		if (inW && /^(100%|100vw|none)$/.test(inW)) a.type = "full_width_content";
		const gap = first((x) => str(x._columnGap)?.trim() ?? str(x._gap)?.trim());
		if (gap !== undefined && /^0(px|rem|em|%)?$/.test(gap)) a.column_margin = "none";
		const side = (v: { d?: number; t?: number; p?: number }) => {
			if (v.d === undefined) return undefined;
			const p = v.p ?? v.d;
			const line = p + ((v.d - p) * (768 - 390)) / (1440 - 390);
			const t = v.t !== undefined && Math.abs(v.t - line) > 4 ? Math.round(v.t) : undefined;
			return { value: fluid(p, v.d), tablet: t };
		};
		const st = side(top);
		const sb = side(bottom);
		const padOut = { ...(st ? { top: st.value } : {}), ...(sb ? { bottom: sb.value } : {}), ...(st?.tablet !== undefined ? { topTablet: st.tablet } : {}), ...(sb?.tablet !== undefined ? { bottomTablet: sb.tablet } : {}) };
		return { attrs: a, ...(Object.keys(padOut).length ? { pad: padOut } : {}), ...(minHeight ? { minHeight } : {}), ...(valign ? { valign } : {}) };
	}

	function gradientCss(g: Record<string, unknown> | undefined): string | undefined {
		if (!g || (str(g.applyTo) && str(g.applyTo) !== "background" && str(g.applyTo) !== "overlay")) return undefined;
		const stops = (Array.isArray(g.colors) ? g.colors : []).flatMap((c) => {
			const col = resolveColour(obj(c)?.color, site);
			const stop = str(obj(c)?.stop);
			return col ? [`${col}${stop ? ` ${Number.parseFloat(stop)}%` : ""}`] : [];
		});
		if (stops.length < 2) return undefined;
		const type = str(g.gradientType) === "radial" ? "radial" : "linear";
		const angle = type === "linear" && str(g.angle) ? `${Number.parseFloat(str(g.angle) as string)}deg, ` : "";
		const css = `${type}-gradient(${angle}${stops.join(", ")})`;
		return /^(?:linear|radial)-gradient\([^;{}<>]*\)$/.test(css) ? css : undefined;
	}

	// ── Rows ─────────────────────────────────────────────────────────────────
	/** Top-level elements, with section templates and component instances at the top replaced by their content. */
	function expandRoots(list: BricksElement[], depth = 0): { e: BricksElement; path: string }[] {
		return list.flatMap((r) => {
			const path = pathOf(r);
			if (depth < 4 && r.name === "template") {
				const id = Number(r.settings?.template);
				const roots = templateRoots(r, path);
				if (!roots) return [];
				openTemplates.add(id);
				const out = expandRoots(roots, depth + 1).map((x) => ({ e: x.e, path: `${path}/template#${id}/${x.path}` }));
				openTemplates.delete(id);
				return out;
			}
			if (depth < 4 && r.cid) {
				const root = componentRoot(r, path);
				return root ? [{ e: root, path: `${path}/component#${r.cid}` }] : [];
			}
			return [{ e: r, path }];
		});
	}

	interface BricksRow extends Row {
		pad?: Section["pad"];
		minHeight?: string;
		valign?: "middle" | "bottom";
		/** The top-level element (hero look). */
		el?: BricksElement;
		tracks?: number;
		/** Position of its top-level element among the page's rendered top-level elements (verify pairs boxes by it). */
		index: number;
	}
	const rows: BricksRow[] = [];
	let loose: { e: BricksElement; path: string; index: number }[] = [];
	const flushLoose = () => {
		if (!loose.length) return;
		rows.push({ attrs: {}, columns: [{ fragments: mergeRich(loose.flatMap((x) => fragments(x.e, x.path))) }], path: loose.map((x) => x.path).join("+"), raw: JSON.stringify(loose.map((x) => x.e)), adapter: "bricks", index: (loose[0] as { index: number }).index });
		loose = [];
	};
	// Bricks renders from the top-level elements down (includes/frontend.php render_data): an element whose parent is
	// not in the list is never shown on the live page.
	for (const e of all.filter((x) => !isRoot(x.parent) && !byId.has(String(x.parent)))) diag({ level: "info", code: "flagged", message: `[${e.name}] its parent element ${e.parent} is not on the page, so Bricks does not render it; not migrated`, path: pathOf(e), tag: e.name });
	const roots = all.filter((e) => isRoot(e.parent));
	// Each element's position in the rendered page (the key of its measured box): top-level index, then child indexes,
	// counting the elements Bricks renders (not those hidden on the front end).
	const domKey = new Map<BricksElement, string>();
	{
		const shown = (x: BricksElement) => eff(x)._hideElementFrontend !== true && eff(x)._hideElementFrontend !== "true";
		const mark = (x: BricksElement, key: string) => {
			domKey.set(x, key);
			childrenOf(x).filter(shown).forEach((k, i) => mark(k, `${key}/${i}`));
		};
		const area = opts.kind === "partial" ? "f" : "c";
		all.filter((e) => isRoot(e.parent)).filter(shown).forEach((r, i) => mark(r, `${area}:${i}`));
	}
	// Each top-level element is one element in the rendered page (a template or component in its place included).
	for (const { e: r, path, index } of roots.flatMap((root, index) => expandRoots([root]).map((x) => ({ ...x, index })))) {
		// Structural boxes are rows with their own styling (a footer template's top-level block with its padding); other
		// top-level elements (a heading on its own) are gathered into a text row.
		if (!STRUCTURE.has(r.name)) {
			loose.push({ e: r, path, index });
			continue;
		}
		flushLoose();
		if (hidden(r, path)) continue;
		currentSource = sourceOf.get(r.id);
		if (r.settings?.hasLoop) {
			dynamicListing(r, r.settings.query, path, env);
			continue;
		}
		rowTracks = undefined;
		const style = styleOf(r, path);
		const columns = columnsOf(r, path);
		rows.push({ attrs: style.attrs, columns, path, raw: JSON.stringify(r), adapter: "bricks", index, el: r, ...(style.pad ? { pad: style.pad } : {}), ...(style.minHeight ? { minHeight: style.minHeight } : {}), ...(style.valign ? { valign: style.valign } : {}), ...(rowTracks ? { tracks: rowTracks } : {}) });
		currentSource = undefined;
	}
	flushLoose();

	const sections: Section[] = [];
	for (const row of rows) {
		const forced = opts.rowOverrides?.[row.path];
		if (forced === "drop") {
			diag({ level: "info", code: "dropped-decorative", message: "Row dropped by overrides.ts", path: row.path });
			continue;
		}
		const out: Section[] = [];
		for (const v of splitRow(row)) out.push(...recognise(v, { first: sections.length + out.length === 0, kind: opts.kind, ...(forced ? { forced } : {}), keys: opts.keys, diag }));
		for (const s of out) {
			s.sourceRef.row = row.index;
			if (row.minHeight && out.length === 1) {
				s.minHeight = row.minHeight;
				if (row.valign && !s.valign) s.valign = row.valign;
			}
			if (s.type === "hero" && row.el) heroLook(row.el, s);
			if (s.type === "rich_text" && row.el && out.length === 1) textBoxes(row.el, s);
			if (row.el && out.length === 1) buttonRows(row.el, s);
			if (s.type === "form" && row.el && out.length === 1) formStack(row.el, s);
			// A grid with more cards than tracks keeps its tracks per row.
			if (row.tracks && (s.type === "feature_grid" || s.type === "team") && (s.fields.columns ?? 0) > row.tracks) s.fields.columns = Math.min(6, row.tracks);
		}
		// Source padding (desktop → phone, tablet when off the line): the row's first section gets its top, the last its bottom.
		const head = out[0];
		const tail = out.at(-1);
		if (row.pad && head && head.type !== "hero" && !head.fullHeight && row.pad.top) head.pad = { ...head.pad, top: row.pad.top, ...(row.pad.topTablet !== undefined ? { topTablet: row.pad.topTablet } : {}) };
		if (row.pad && tail && tail.type !== "hero" && !tail.fullHeight && row.pad.bottom) tail.pad = { ...tail.pad, bottom: row.pad.bottom, ...(row.pad.bottomTablet !== undefined ? { bottomTablet: row.pad.bottomTablet } : {}) };
		sections.push(...out);
	}
	return { sections, diagnostics, forms: [...forms.values()] };
}

/** Light text colour (white-ish): the section is dark. */
function isLight(c: string): boolean {
	const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(c)?.[1];
	let rgb: number[] | undefined;
	if (hex) {
		const h = hex.length === 3 ? [...hex].map((x) => x + x).join("") : hex;
		rgb = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
	} else {
		const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(c);
		if (m) rgb = [Number(m[1]), Number(m[2]), Number(m[3])];
		else if (/^white$/i.test(c)) rgb = [255, 255, 255];
	}
	if (!rgb) return false;
	const [r, g, b] = rgb as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b >= 160;
}
