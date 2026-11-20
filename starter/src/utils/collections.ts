/**
 * Collections migrated from WordPress custom post types (services, team, portfolio…): which address is an archive,
 * a term archive or an entry, and how a field is shown. The settings come from site.config.json `collections` (written
 * by scaffold from the kit's transform: src/transform/cpt.ts). pages/[...slug].astro dispatches with `collectionRoute`
 * and `entryCollections`.
 *
 * No imports here: this file must load in Node (kit, tests) and in the Worker (starter).
 */

export interface CollectionFieldConfig {
	slug: string;
	label: string;
	/** EmDash field type (string, text, url, number, boolean, datetime, select, multiSelect, portableText, image, file, reference, repeater, json…). */
	type: string;
	subFields?: { slug: string; label: string; type: string }[];
}

export interface CollectionConfig {
	/** EmDash collection slug. */
	slug: string;
	label: string;
	labelSingular: string;
	/** Address prefix of the entries (`/team/`): an entry's slug is its whole path, as for pages. */
	base?: string;
	/** The archive listing (WordPress `has_archive`), with numbered pages (`/team/page/2/`). */
	archive?: string;
	perPage: number;
	hierarchical: boolean;
	/** "menu": WordPress ordered the entries by hand (menu order); else newest first. */
	order?: "menu";
	/** Reference fields (and `parent`) to load with an entry. */
	references: string[];
	/** Custom fields, in order (rendered on the entry page). */
	fields: CollectionFieldConfig[];
	/** Taxonomies of this collection: term archives at `<base><term>/`. */
	taxonomies: { taxonomy: string; base: string; label: string; labelSingular: string }[];
}

export type CollectionsConfig = CollectionConfig[];

export type CollectionRoute = { kind: "archive"; collection: CollectionConfig; page: number } | { kind: "term"; collections: CollectionConfig[]; taxonomy: string; label: string; slug: string; page: number };

const trim = (p: string) => (p === "/" ? "/" : `/${p.replace(/^\/+|\/+$/g, "")}/`);

function decodeSegment(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

/** An archive or term-archive address (and its numbered pages); undefined for anything else. */
export function collectionRoute(pathname: string, cfg: CollectionsConfig): CollectionRoute | undefined {
	let path = trim(pathname);
	let page = 1;
	const pg = /^(.*\/)page\/(\d+)\/$/.exec(path);
	if (pg) {
		page = Number(pg[2]);
		path = pg[1] as string;
		if (page < 1) return undefined;
	}
	for (const c of cfg) if (c.archive && trim(c.archive) === path) return { kind: "archive", collection: c, page };
	for (const c of cfg) {
		for (const t of c.taxonomies) {
			const base = trim(t.base);
			if (path.startsWith(base) && path !== base) {
				const slug = path.slice(base.length).replace(/\/$/, "").split("/").pop() as string;
				return { kind: "term", collections: cfg.filter((x) => x.taxonomies.some((y) => y.taxonomy === t.taxonomy)), taxonomy: t.taxonomy, label: t.labelSingular, slug: decodeSegment(slug), page };
			}
		}
	}
	return undefined;
}

/** Collections an entry slug (its path without slashes, `team/jane`) may belong to: those whose base it starts with. */
export function entryCollections(slug: string, cfg: CollectionsConfig): CollectionConfig[] {
	const path = trim(slug);
	const byBase = cfg.filter((c) => c.base && c.base !== "/" && path.startsWith(trim(c.base)) && path !== trim(c.base));
	return byBase.length ? byBase : cfg.filter((c) => !c.base || c.base === "/");
}

/** An entry's address (its slug is its WordPress path), in the site's URL style. */
export function entryHref(slug: string, style: "always" | "never" | undefined = "always"): string {
	const s = slug.replace(/^\/+|\/+$/g, "");
	if (!s || s === "home") return "/";
	return style === "never" ? `/${s}` : `/${s}/`;
}

/** A field value worth showing (empty strings, empty lists and unset values are not). */
export function hasValue(v: unknown): boolean {
	if (v === undefined || v === null || v === "") return false;
	// A list counts when one of its items does (a gallery whose images are all missing shows nothing).
	if (Array.isArray(v)) return v.some(hasValue);
	if (typeof v === "object" && !("id" in v)) return Object.values(v).some(hasValue);
	return true;
}

/** Plain text of a scalar field value (dates as a readable date, booleans as Yes/No, lists joined). */
export function fieldText(type: string, v: unknown, lang = "en"): string {
	if (!hasValue(v)) return "";
	if (type === "boolean") return v === true || v === 1 || v === "1" ? "Yes" : "No";
	if (type === "datetime") {
		const d = new Date(String(v));
		if (Number.isNaN(d.getTime())) return String(v);
		const midnight = d.getUTCHours() === 0 && d.getUTCMinutes() === 0;
		return new Intl.DateTimeFormat(lang, { dateStyle: "long", ...(midnight ? {} : { timeStyle: "short" }), timeZone: "UTC" }).format(d);
	}
	if (type === "number" || type === "integer") return new Intl.NumberFormat(lang).format(Number(v));
	if (Array.isArray(v)) return v.map((x) => (typeof x === "object" ? JSON.stringify(x) : String(x))).join(", ");
	if (typeof v === "object") return JSON.stringify(v);
	return String(v);
}

/** The readable text in a JSON field (data kept as WordPress stored it): its strings and numbers, ids and links left out. */
export function jsonLines(v: unknown, max = 50): string[] {
	const out: string[] = [];
	const walk = (x: unknown, key = "") => {
		if (out.length >= max) return;
		if (typeof x === "string") {
			if (x.trim() && !/^https?:\/\//.test(x) && !/^(id|ID|type|kind|url|wpId|acf_fc_layout|target)$/.test(key)) out.push(x.trim());
			return;
		}
		if (typeof x === "number" && !/^(id|ID|wpId|width|height)$/.test(key)) out.push(String(x));
		if (Array.isArray(x)) return x.forEach((y) => walk(y, key));
		if (x && typeof x === "object") for (const [k, y] of Object.entries(x)) walk(y, k);
	};
	walk(v);
	return out;
}

/** Route-cache tags of a collection page: the collection (EmDash purges it on any entry write) and its taxonomies. */
export function collectionCacheTags(c: CollectionConfig): string[] {
	return [c.slug, ...c.taxonomies.map((t) => `emdash:taxonomy:${t.taxonomy}`)];
}
