/**
 * Custom post types → EmDash collections (parity backlog P0 #8, P1 #14). Per post type the transform decides (overrides.ts
 * `contentTypes`): its own collection (`as: "collection"`, the default for a public type the Exporter describes),
 * pages, or skip. A collection gets the type's core data (title, slug, status, dates, featured image, excerpt, body or
 * builder sections, menu order, parent, terms, byline) and its custom fields (src/transform/cpt-fields.ts), an address
 * pattern from the live permalinks and, when WordPress had one, an archive at the same address.
 *
 * Pure functions of the extract output + overrides: transform writes ir/collections.json and ir/entries/<type>/*.json.
 * Verified EmDash behaviour: docs/spikes/cpt-findings.md.
 */
import type { Diagnostic } from "../ir/schema.js";
import { type CptField, convertValue, type EmDashFieldType, fieldKind, fieldSlug, fieldsForType, isInternalMeta, mapField, RESERVED_SLUGS, type WpFieldDef, type WpFieldGroup, acfFromMeta } from "./cpt-fields.js";
import type { CollectionsConfig } from "../../starter/src/utils/collections.js";
import { emdashTaxonomyName } from "./blog.js";

export type { CptField } from "./cpt-fields.js";

/** Collections the kit owns: a post type never takes one of these names. EmDash's reserved ones too. */
const TAKEN = new Set(["pages", "posts", "site_parts", "popups", "content", "media", "users", "revisions", "taxonomies", "options", "audit_logs", "reorder", "relations", "sections", "menus", "settings"]);

/** What the Exporter's analyze says about a public post type (emdash-exporter 1.2: class-content-exporter.php analyze()). */
export interface AnalyzeType {
	name: string;
	label?: string;
	label_singular?: string;
	total?: number;
	supports?: Record<string, unknown> | string[];
	taxonomies?: string[];
	hierarchical?: boolean;
	has_archive?: boolean | string;
	custom_fields?: { key: string; count: number; inferred_type?: string; sample?: string | null }[];
}

/** WordPress REST /wp/v2/types?context=edit (extract: raw/exporter/types.json). */
export interface WpRestType {
	slug?: string;
	name?: string;
	rest_base?: string;
	hierarchical?: boolean;
	has_archive?: boolean | string;
	viewable?: boolean;
	supports?: Record<string, unknown>;
	taxonomies?: string[];
}

export interface CptEntrySource {
	id: number;
	post_type: string;
	status: string;
	slug: string;
	title: string;
	content: string;
	excerpt: string;
	date_gmt: string;
	modified_gmt: string;
	parent: number | null;
	menu_order: number;
	taxonomies: Record<string, { id: number; name: string; slug: string }[]>;
	featured_image?: { id: number; url: string };
	meta: Record<string, unknown>;
	acf?: Record<string, unknown>;
	permalink?: string;
	author?: unknown;
}

export interface CptTaxonomyRef {
	/** EmDash taxonomy name. */
	name: string;
	wpName: string;
	/** Archive base on the live site (`/service-category/`). */
	base: string;
	label: string;
	labelSingular: string;
	/** Defined by the blog (posts) as well: this collection is added to it. */
	shared?: boolean;
}

export interface CptCollection {
	/** WordPress post type. */
	type: string;
	/** EmDash collection slug. */
	slug: string;
	label: string;
	labelSingular: string;
	description: string;
	hierarchical: boolean;
	/** Entries have their own address (WordPress `viewable`/pretty permalinks). */
	routable: boolean;
	/** Address prefix of single entries (`/team/`), when they share one. */
	base?: string;
	/** Archive address (WordPress `has_archive`), when WordPress had one and no page took the address. */
	archive?: string;
	perPage: number;
	/** Core fields this collection carries. */
	/** Core fields this collection carries; `ordered`: WordPress entries have a hand-set menu order. */
	core: { excerpt: boolean; featuredImage: boolean; body: boolean; sections: boolean; menuOrder: boolean; ordered: boolean; parent: boolean; bylines: boolean };
	fields: CptField[];
	taxonomies: CptTaxonomyRef[];
	/** Field definition sources used (report). */
	definitions: string[];
	/** Meta keys no definition describes, with how many entries have a value and a sample (report; gate). */
	unknownMeta: { key: string; entries: number; sample: string; decided?: string }[];
	/** Defined fields deliberately not carried (password fields: secrets never leave WordPress; owner `skip`). */
	notCarried: { name: string; why: string }[];
	/** Owner decision (overrides.ts contentTypes) or the kit's default. */
	decision: { by: "default" | "override"; reason?: string };
	entries: number;
	published: number;
	sortOrder: number;
}

export interface CptPlan {
	collections: CptCollection[];
	/** Taxonomies only CPTs use (the blog's own are in ir/blog.json), with terms. */
	taxonomies: { name: string; wpName: string; label: string; labelSingular: string; hierarchical: boolean; base: string; collections: string[]; terms: { wpId: number; slug: string; label: string; description?: string; parent?: string; count: number }[] }[];
	/** Bylines for CPT authors the blog does not already have. */
	bylines: { slug: string; displayName: string; bio?: string; wpId: number; path?: string; posts: number }[];
}

export type ContentTypeDecision = { as: "skip" | "pages"; reason: string } | { as: "collection"; name?: string; reason?: string; fields?: Record<string, EmDashFieldType | "skip"> };

/** Whether the kit maps a post type as a collection: decided so, or public (Exporter analyze) and undecided. */
export function collectionDecision(type: string, analyze: AnalyzeType | undefined, decision: ContentTypeDecision | undefined): { by: "default" | "override"; reason?: string } | undefined {
	if (decision?.as === "collection") return { by: "override", ...(decision.reason ? { reason: decision.reason } : {}) };
	if (decision) return undefined;
	return analyze ? { by: "default" } : undefined;
}

/** The proposal for a type the kit does not map on its own (coverage report). */
export function proposal(type: string, analyze: AnalyzeType | undefined): string {
	return analyze ? `collection "${collectionSlug(type)}"` : `{ as: "collection" } (the Exporter does not list it as a public type), "pages" or "skip"`;
}

export function collectionSlug(type: string, name?: string): string {
	const s = fieldSlug(name ?? type);
	return TAKEN.has(s) ? `wp_${s}` : s;
}

const pathOf = (u: string | undefined, hosts: Set<string>): string | undefined => {
	if (!u) return undefined;
	try {
		const x = new URL(u);
		if (!hosts.has(x.host.replace(/^www\./, "")) || x.search) return undefined;
		return x.pathname;
	} catch {
		return undefined;
	}
};

const supportsOf = (s: AnalyzeType["supports"] | WpRestType["supports"]): Set<string> => new Set(Array.isArray(s) ? s : Object.keys(s ?? {}));

export interface PlanInput {
	types: { name: string; entries: CptEntrySource[] }[];
	analyze: AnalyzeType[];
	rest: Record<string, WpRestType>;
	groups: WpFieldGroup[];
	decisions: Record<string, ContentTypeDecision | undefined>;
	/** WordPress taxonomies (exporter taxonomies.json) and the live archive base of each (discovery). */
	taxonomies: { name: string; label?: string; label_singular?: string; hierarchical?: boolean; post_types?: string[]; terms?: { id: number; name?: string; slug: string; description?: string; parent?: number | null; count?: number }[] }[];
	termBases: Record<string, string | undefined>;
	/** EmDash names of taxonomies the blog migrates (wp name → EmDash name). */
	blogTaxonomies: Map<string, string>;
	/** An entry's address on the new site (audit, permalink, else from the base). */
	routeOf: (p: CptEntrySource) => string;
	/** Paths of migrated pages (a page at the archive address keeps it). */
	pagePaths: Set<string>;
	siteHosts: Set<string>;
	perPage: number;
	/** First sortOrder for CPT collections in the admin. */
	firstSortOrder: number;
	/** Builder of an entry's post_content. */
	builderOf: (p: CptEntrySource) => string;
}

const LIVE = new Set(["publish", "future", "draft", "pending", "private"]);

/** Which collections to make and what each holds. Types without a decision or default are left out (the caller lists them). */
export function planCollections(input: PlanInput): CptPlan {
	const collections: CptCollection[] = [];
	const byType = new Map(input.analyze.map((a) => [a.name, a]));
	const chosen = input.types.filter((t) => t.entries.length && collectionDecision(t.name, byType.get(t.name), input.decisions[t.name]));
	const slugFor = new Map(chosen.map((t) => [t.name, collectionSlug(t.name, (input.decisions[t.name] as { name?: string } | undefined)?.name)]));
	const collectionFor = (postType: string) => (postType === "page" ? "pages" : postType === "post" ? undefined : slugFor.get(postType));
	const cptTaxonomies = new Map<string, CptPlan["taxonomies"][number]>();
	for (const [i, t] of chosen.entries()) {
		const a = byType.get(t.name);
		const rest = input.rest[t.name] ?? {};
		const decision = input.decisions[t.name] as Extract<ContentTypeDecision, { as: "collection" }> | undefined;
		const slug = slugFor.get(t.name) as string;
		const supports = supportsOf(a?.supports ?? rest.supports);
		const entries = t.entries.filter((e) => LIVE.has(e.status));
		const hierarchical = a?.hierarchical ?? rest.hierarchical ?? entries.some((e) => !!e.parent);
		// Addresses: the live permalinks (WordPress `rewrite.slug` is not in REST, but every permalink carries it).
		const routes = entries.map((e) => ({ e, path: input.routeOf(e) }));
		const viewable = rest.viewable ?? entries.some((e) => !!pathOf(e.permalink, input.siteHosts));
		const bases = new Map<string, number>();
		const byId = new Map(entries.map((e) => [e.id, e]));
		for (const { e, path } of routes) {
			const chain = [e.slug];
			for (let p = e.parent ? byId.get(e.parent) : undefined, g = 0; p && g < 20; p = p.parent ? byId.get(p.parent) : undefined, g++) chain.unshift(p.slug);
			const tail = `${chain.join("/")}/`;
			const norm = path.endsWith("/") ? path : `${path}/`;
			if (norm.endsWith(`/${tail}`)) {
				const b = norm.slice(0, norm.length - tail.length);
				bases.set(b, (bases.get(b) ?? 0) + 1);
			}
		}
		const base = [...bases].sort((x, y) => y[1] - x[1])[0]?.[0];
		const hasArchive = rest.has_archive ?? a?.has_archive;
		const archiveWanted = typeof hasArchive === "string" && hasArchive ? `/${hasArchive.replace(/^\/+|\/+$/g, "")}/` : hasArchive ? (base && base !== "/" ? base : `/${t.name}/`) : undefined;
		const archive = archiveWanted && !input.pagePaths.has(archiveWanted) ? archiveWanted : undefined;
		const builders = new Set(entries.map((e) => input.builderOf(e)));
		// Fields: every definition for this type, then the owner's per-field decisions.
		const { fields: defs, groups } = fieldsForType(input.groups, t.name);
		const decidedFields = decision?.fields ?? {};
		const taken = new Set<string>(RESERVED_SLUGS);
		const fields: CptField[] = [];
		const notCarried: CptCollection["notCarried"] = [];
		for (const d of defs) {
			const forced = decidedFields[d.name];
			if (forced === "skip") {
				notCarried.push({ name: d.name, why: "skip (overrides.ts)" });
				continue;
			}
			if (!forced && fieldKind(d) === "password") {
				notCarried.push({ name: d.name, why: "password field: secrets are never migrated" });
				continue;
			}
			const mapped = mapField(forced ? { ...d, ...forcedDef(forced) } : d, { collectionFor, taken });
			fields.push(...mapped);
		}
		// Meta no definition describes: reported; mapped only when the owner names a type for it.
		// ACF keeps repeater/flexible rows as `<name>_<i>_<sub>` and group sub-fields as `<name>_<sub>`.
		const covered = (key: string) => defs.some((d) => key === d.name || (["repeater", "group", "flexible"].includes(fieldKind(d)) && key.startsWith(`${d.name}_`)));
		const unknown = new Map<string, { entries: number; sample: string }>();
		for (const e of entries) {
			for (const [key, v] of Object.entries(e.meta ?? {})) {
				if (isInternalMeta(key) || covered(key)) continue;
				if (v === "" || v === null || v === undefined || (Array.isArray(v) && !v.length)) continue;
				const u = unknown.get(key) ?? { entries: 0, sample: typeof v === "string" ? v.slice(0, 60) : JSON.stringify(v).slice(0, 60) };
				u.entries++;
				unknown.set(key, u);
			}
		}
		const unknownMeta: CptCollection["unknownMeta"] = [];
		for (const [key, u] of [...unknown].sort((x, y) => x[0].localeCompare(y[0]))) {
			const forced = decidedFields[key];
			if (forced && forced !== "skip") fields.push(...mapField({ name: key, label: "", ...forcedDef(forced) }, { collectionFor, taken }));
			unknownMeta.push({ key, ...u, ...(forced ? { decided: forced } : {}) });
		}
		// Taxonomies of this type with terms: the blog's (shared), else migrated here.
		const taxRefs: CptTaxonomyRef[] = [];
		const typeTaxes = new Set([...(a?.taxonomies ?? rest.taxonomies ?? []), ...input.taxonomies.filter((x) => x.post_types?.includes(t.name)).map((x) => x.name), ...entries.flatMap((e) => Object.entries(e.taxonomies ?? {}).filter(([, l]) => l.length).map(([k]) => k))]);
		for (const wp of [...typeTaxes].sort()) {
			const tx = input.taxonomies.find((x) => x.name === wp);
			if (!tx || ["post_format", "nav_menu", "link_category"].includes(wp)) continue;
			const used = entries.some((e) => (e.taxonomies?.[wp] ?? []).length);
			if (!used) continue;
			const shared = input.blogTaxonomies.get(wp);
			const name = shared ?? emdashTaxonomyName(wp);
			if (!name) continue;
			const label = tx.label ?? wp;
			const ref: CptTaxonomyRef = { name, wpName: wp, base: input.termBases[wp] ?? `/${wp}/`, label, labelSingular: tx.label_singular ?? label, ...(shared ? { shared: true } : {}) };
			taxRefs.push(ref);
			if (shared) continue;
			const def = cptTaxonomies.get(name);
			if (def) {
				if (!def.collections.includes(slug)) def.collections.push(slug);
				continue;
			}
			const terms = tx.terms ?? [];
			const termById = new Map(terms.map((x) => [x.id, x]));
			cptTaxonomies.set(name, { name, wpName: wp, label, labelSingular: ref.labelSingular, hierarchical: !!tx.hierarchical, base: ref.base, collections: [slug], terms: parentsFirst(terms).map((x) => ({ wpId: x.id, slug: x.slug, label: x.name ?? x.slug, ...(x.description ? { description: x.description } : {}), ...(x.parent && termById.get(x.parent) ? { parent: termById.get(x.parent)?.slug as string } : {}), count: Number(x.count ?? 0) })) });
		}
		const excerpt = supports.has("excerpt") && entries.some((e) => (e.excerpt ?? "").trim());
		collections.push({
			type: t.name,
			slug,
			label: a?.label ?? rest.name ?? labelOf(t.name),
			labelSingular: a?.label_singular ?? a?.label ?? rest.name ?? labelOf(t.name),
			description: `Migrated from the WordPress post type "${t.name}"`,
			hierarchical,
			routable: viewable,
			...(base && viewable ? { base } : {}),
			...(archive && viewable ? { archive } : {}),
			perPage: input.perPage,
			core: {
				excerpt,
				featuredImage: supports.has("thumbnail") || entries.some((e) => !!e.featured_image?.id),
				body: entries.some((e) => ["classic", "html"].includes(input.builderOf(e))),
				sections: [...builders].some((b) => ["wpbakery", "bricks", "gutenberg"].includes(b)),
				menuOrder: hierarchical || supports.has("page-attributes") || entries.some((e) => e.menu_order),
				ordered: entries.some((e) => Number(e.menu_order)),
				parent: hierarchical && entries.some((e) => !!e.parent),
				bylines: supports.has("author") && entries.some((e) => !!(e.author && typeof e.author === "object")),
			},
			fields,
			taxonomies: taxRefs,
			definitions: groups,
			unknownMeta,
			notCarried,
			decision: collectionDecision(t.name, a, input.decisions[t.name]) as CptCollection["decision"],
			entries: t.entries.length,
			published: t.entries.filter((e) => e.status === "publish").length,
			sortOrder: input.firstSortOrder + i,
		});
	}
	return { collections, taxonomies: [...cptTaxonomies.values()], bylines: [] };
}

/** A type the owner named for a field (overrides.ts `fields`) as a plugin-neutral definition. */
function forcedDef(t: EmDashFieldType): Pick<WpFieldDef, "source" | "type"> {
	return { source: "meta", type: `emdash:${t}` };
}

const labelOf = (name: string) =>
	name
		.split(/[_-]+/)
		.filter(Boolean)
		.map((w) => w[0]?.toUpperCase() + w.slice(1))
		.join(" ") || name;

function parentsFirst<T extends { id: number; parent?: number | null }>(terms: T[]): T[] {
	const ids = new Set(terms.map((t) => t.id));
	const done = new Set<number>();
	const out: T[] = [];
	for (let guard = 0; out.length < terms.length && guard < terms.length + 2; guard++) {
		for (const t of terms) {
			if (done.has(t.id)) continue;
			if (!t.parent || !ids.has(t.parent) || done.has(t.parent)) {
				out.push(t);
				done.add(t.id);
			}
		}
	}
	for (const t of terms) if (!done.has(t.id)) out.push(t);
	return out;
}

// ── Entries ───────────────────────────────────────────────────────────────────────────────────────────────

export interface EntryContext {
	/** Media id of an upload URL. */
	mediaIdForUrl: (url: string) => number | undefined;
	/** Post type of any extracted WordPress id. */
	typeOfId: (id: number) => string | undefined;
	/** HTML → Portable Text (`_media` marked) with diagnostics. */
	html: (html: string, keyPrefix: string) => { body: unknown[]; diagnostics: Diagnostic[] };
}

export interface EntryData {
	collection: string;
	fields: Record<string, unknown>;
	references: Record<string, string[]>;
	excerpt?: string;
	publishedAt?: string;
	modifiedAt?: string;
	menuOrder?: number;
	terms: Record<string, string[]>;
	bylines: string[];
}

/** One entry's field values, references and core data; problems become diagnostics (warn: reported, not blocking). */
export function entryData(p: CptEntrySource, col: CptCollection, ctx: EntryContext, defsByName: Map<string, WpFieldDef>): { entry: EntryData; diagnostics: Diagnostic[] } {
	const fields: Record<string, unknown> = {};
	const references: Record<string, string[]> = {};
	const diagnostics: Diagnostic[] = [];
	const keyPrefix = `${p.id.toString(36)}_`;
	for (const f of col.fields) {
		const top = f.wp.path?.[0] ?? f.wp.name;
		const def = defsByName.get(top);
		// Group sub-fields: the group's ACF object (or `<group>_<sub>` meta); otherwise the field's own key.
		let acf: unknown = p.acf?.[top];
		let raw: unknown = def && f.wp.source === "acf" && !p.acf ? acfFromMeta(def, p.meta ?? {}) : p.meta?.[top];
		for (const seg of f.wp.path?.slice(1) ?? []) {
			acf = acf && typeof acf === "object" ? (acf as Record<string, unknown>)[seg] : undefined;
			raw = raw && typeof raw === "object" ? (raw as Record<string, unknown>)[seg] : undefined;
		}
		if (f.wp.path && raw === undefined) raw = p.meta?.[f.wp.path.join("_")];
		const c = convertValue(f, acf, raw, {
			mediaIdForUrl: ctx.mediaIdForUrl,
			typeOfId: ctx.typeOfId,
			keyPrefix,
			html: (h, k) => {
				const r = ctx.html(h, k);
				diagnostics.push(...r.diagnostics.map((d) => ({ ...d, path: `fields.${f.slug}${d.path ? `.${d.path}` : ""}` })));
				return r.body;
			},
		});
		if (c.value !== undefined && !(Array.isArray(c.value) && !c.value.length && f.type !== "boolean")) fields[f.slug] = c.value;
		if (c.refs?.length) references[f.slug] = c.refs;
		for (const m of c.problems ?? []) diagnostics.push({ level: "warn", code: "lossy", message: m, path: `fields.${f.slug}` });
	}
	if (col.core.parent && p.parent) {
		const t = ctx.typeOfId(p.parent);
		if (t === col.type) references.parent = [`${t}:${p.parent}`];
	}
	const excerpt = col.core.excerpt ? (p.excerpt ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() : "";
	const iso = (d: string | undefined) => {
		if (!d || /^0000-00-00/.test(d)) return undefined;
		const t = Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(d) ? `${d.replace(" ", "T")}Z` : d);
		return Number.isNaN(t) ? undefined : new Date(t).toISOString();
	};
	const terms = Object.fromEntries(col.taxonomies.flatMap((t) => ((p.taxonomies?.[t.wpName] ?? []).length ? [[t.name, (p.taxonomies[t.wpName] ?? []).map((x) => x.slug)]] : [])));
	return {
		entry: {
			collection: col.slug,
			fields,
			references,
			...(excerpt ? { excerpt } : {}),
			...(iso(p.date_gmt) ? { publishedAt: iso(p.date_gmt) } : {}),
			...(iso(p.modified_gmt) ? { modifiedAt: iso(p.modified_gmt) } : {}),
			...(col.core.menuOrder ? { menuOrder: Number(p.menu_order) || 0 } : {}),
			terms,
			bylines: [],
		},
		diagnostics,
	};
}

/** The EmDash fields of a collection (seed, load): core fields first, then the custom fields. */
export function collectionFields(c: CptCollection, sectionSlugs: string[]): Record<string, unknown>[] {
	const out: Record<string, unknown>[] = [{ slug: "title", label: "Title", type: "string", required: true, searchable: true }];
	if (c.core.excerpt) out.push({ slug: "excerpt", label: "Excerpt", type: "text", searchable: true });
	if (c.core.featuredImage) out.push({ slug: "featured_image", label: "Featured image", type: "image" });
	if (c.core.body) out.push({ slug: "body", label: "Content", type: "portableText", searchable: true });
	if (c.core.sections) out.push({ slug: "content", label: "Sections (entries built with a page builder)", type: "blocks", validation: { allowedTypes: sectionSlugs, maxItems: 80 } });
	if (c.core.menuOrder) out.push({ slug: "menu_order", label: "Order", type: "integer" });
	if (c.core.parent) out.push({ slug: "parent", label: `Parent ${c.labelSingular.toLowerCase()}`, type: "reference", validation: { targetCollection: c.slug, multiple: false } });
	for (const f of c.fields) {
		const validation: Record<string, unknown> = {};
		if ((f.type === "select" || f.type === "multiSelect") && f.options?.length) validation.options = f.options;
		if (f.type === "repeater") validation.subFields = (f.subFields ?? []).map((s) => ({ slug: s.slug, label: s.label, type: s.type, ...(s.type === "select" && s.options?.length ? { options: s.options } : {}) }));
		if (f.type === "reference") Object.assign(validation, { targetCollection: f.targetCollection, multiple: !!f.multiple });
		out.push({ slug: f.slug, label: f.label, type: f.type, ...(Object.keys(validation).length ? { validation } : {}), ...(f.type === "string" || f.type === "text" ? { searchable: true } : {}) });
	}
	return out;
}

/** Select options: the definition's choices plus every value the entries use (EmDash refuses a value not in the list). */
export function completeOptions(c: CptCollection, entries: EntryData[]): void {
	for (const f of c.fields) {
		const add = (vals: unknown[], into: string[]) => {
			for (const v of vals) if (typeof v === "string" && v && !into.includes(v)) into.push(v);
		};
		if (f.type === "select" || f.type === "multiSelect") {
			f.options ??= [];
			for (const e of entries) {
				const v = e.fields[f.slug];
				add(Array.isArray(v) ? v : [v], f.options);
			}
		}
		if (f.type === "repeater") {
			for (const s of f.subFields ?? []) {
				if (s.type !== "select") continue;
				s.options ??= [];
				for (const e of entries) for (const row of (e.fields[f.slug] as Record<string, unknown>[] | undefined) ?? []) add([row[s.slug]], s.options);
			}
		}
	}
}

/** What the starter reads (site.config.json `collections`): addresses, archives, fields to render. */
export function starterCollectionsConfig(plan: CptPlan): CollectionsConfig {
	return plan.collections
		.filter((c) => c.routable)
		.map((c) => ({
			slug: c.slug,
			label: c.label,
			labelSingular: c.labelSingular,
			...(c.base ? { base: c.base } : {}),
			...(c.archive ? { archive: c.archive } : {}),
			perPage: c.perPage,
			hierarchical: c.hierarchical,
			...(c.core.menuOrder && c.core.ordered ? { order: "menu" as const } : {}),
			references: [...c.fields.filter((f) => f.type === "reference").map((f) => f.slug), ...(c.core.parent ? ["parent"] : [])],
			fields: c.fields.map((f) => ({ slug: f.slug, label: f.label, type: f.type, ...(f.subFields ? { subFields: f.subFields.map((s) => ({ slug: s.slug, label: s.label, type: s.type })) } : {}) })),
			taxonomies: c.taxonomies.map((t) => ({ taxonomy: t.name, base: t.base, label: t.label, labelSingular: t.labelSingular })),
		}));
}

/** Coverage report section: every collection, its fields and where they came from, unmapped meta. */
export function cptReport(plan: CptPlan, docs: { entry?: EntryData; source: { status: string } }[]): string[] {
	if (!plan.collections.length) return [];
	const esc = (s: string) => s.replace(/\|/g, "\\|");
	const L = ["", "## Custom post types", "", "Each post type below is an EmDash collection. Change a mapping in `overrides.ts → contentTypes`: `{ <type>: { as: \"collection\", name?: \"<collection>\", fields?: { <meta key>: \"<EmDash type>\" | \"skip\" } } }`, or `{ as: \"pages\" | \"skip\", reason }`.", ""];
	for (const c of plan.collections) {
		const mine = docs.filter((d) => d.entry?.collection === c.slug);
		L.push(`### ${c.label} (\`${c.type}\` → collection \`${c.slug}\`)`, "");
		L.push(`${c.entries} entries (${c.published} published) · ${c.decision.by === "override" ? `decided in overrides.ts${c.decision.reason ? `: ${c.decision.reason}` : ""}` : "kit default (a public post type)"} · ${c.routable ? `entries at \`${c.base ?? "/"}<slug>/\`${c.archive ? `, archive at \`${c.archive}\` (${c.perPage} per page)` : ", no archive (WordPress had none, or a page has its address)"}` : "no addresses of their own (WordPress showed them only inside other pages)"}${c.hierarchical ? " · hierarchical (parent kept)" : ""}.`);
		L.push("", `Core: title, slug, status, dates${c.core.featuredImage ? ", featured image" : ""}${c.core.excerpt ? ", excerpt" : ""}${c.core.body ? ", content (Portable Text)" : ""}${c.core.sections ? ", sections (builder content)" : ""}${c.core.menuOrder ? ", order" : ""}${c.core.parent ? ", parent" : ""}${c.taxonomies.length ? `, terms (${c.taxonomies.map((t) => t.name).join(", ")})` : ""}${c.core.bylines ? ", byline" : ""}. Field definitions: ${c.definitions.join("; ") || "none"}.`);
		if (c.fields.length) {
			L.push("", "| Field | EmDash type | WordPress | Entries with a value | Note |", "|---|---|---|---|---|");
			for (const f of c.fields) {
				const n = mine.filter((d) => d.entry && (d.entry.fields[f.slug] !== undefined || d.entry.references[f.slug]?.length)).length;
				L.push(`| ${esc(f.label)} (\`${f.slug}\`) | ${f.type}${f.type === "reference" ? ` → ${f.targetCollection}${f.multiple ? " (many)" : ""}` : ""}${f.type === "repeater" ? ` [${(f.subFields ?? []).map((s) => `${s.slug}:${s.type}`).join(", ")}]` : ""} | ${f.wp.source} ${f.wp.type} \`${(f.wp.path ?? [f.wp.name]).join(".")}\` | ${n} | ${f.warn ? "⚠️ " : ""}${esc(f.note ?? "")} |`);
			}
		}
		if (c.notCarried.length) L.push("", `Not carried: ${c.notCarried.map((n) => `\`${n.name}\` (${n.why})`).join(", ")}.`);
		if (c.unknownMeta.length) {
			L.push("", "Meta without a field definition (not guessed; map with `fields: { <key>: \"string\" | \"text\" | … }` or `\"skip\"`):", "", "| Meta key | Entries | Sample | Decision |", "|---|---|---|---|");
			for (const u of c.unknownMeta) L.push(`| \`${u.key}\` | ${u.entries} | ${esc(u.sample.replace(/\s+/g, " "))} | ${u.decided ?? "❌ undecided"} |`);
		}
		L.push("");
	}
	return L;
}
