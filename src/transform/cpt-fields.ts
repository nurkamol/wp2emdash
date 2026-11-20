/**
 * Custom fields of custom post types: field definitions from ACF, Meta Box and Pods, the map from their field types to
 * EmDash's 17 field types, and the conversion of each entry's stored values. Pure functions of the extract output.
 *
 * Definition sources, richest first (src/transform/cpt.ts merges them per post type):
 *   - plugin export files the owner sent (raw/plugin-exports → raw/field-definitions/): ACF "Export field groups"
 *     JSON, Meta Box Builder JSON, Pods package JSON (sub-fields, choices, relationship targets);
 *   - the ACF configuration posts (`acf-field-group`, `acf-field`; PHP-serialized settings) when extract could read them;
 *   - the EmDash Exporter's analyze `acf` list (top-level fields and their types only).
 * Values: the Exporter's `acf` object (ACF get_fields(), images/relations reduced to ids) and the raw post meta.
 * Meta keys no definition describes are reported, never guessed (overrides.ts contentTypes.<type>.fields).
 *
 * Verified against EmDash 1.5.0: docs/spikes/cpt-findings.md.
 */
import { isPhpSerialized, phpUnserialize } from "../extract/php-unserialize.js";
import type { MediaRef } from "../ir/schema.js";

export type FieldSource = "acf" | "metabox" | "pods" | "meta";

/** A field as the WordPress plugin defines it. */
export interface WpFieldDef {
	source: FieldSource;
	/** Meta key (ACF field name, Meta Box id, Pods name). */
	name: string;
	label: string;
	/** The plugin's own type (ACF `wysiwyg`, Meta Box `image_advanced`, Pods `pick`…). */
	type: string;
	required?: boolean;
	/** Several values (select multiple, relationship, Meta Box clone, Pods multi pick/file). */
	multiple?: boolean;
	/** Choice values (select, radio, checkbox). */
	choices?: string[];
	/** Repeater / group / clone sub-fields. */
	subFields?: WpFieldDef[];
	/** Relationship targets: post types. */
	targets?: string[];
	/** Pods file fields: "images" | "any"… */
	fileType?: string;
}

export interface WpFieldGroup {
	source: Exclude<FieldSource, "meta">;
	title: string;
	postTypes: string[];
	fields: WpFieldDef[];
	/** Where the definition came from (report). */
	from: string;
}

/** EmDash field types (emdash 1.5 schema/types.ts FIELD_TYPES). */
export type EmDashFieldType = "string" | "text" | "url" | "number" | "integer" | "boolean" | "datetime" | "select" | "multiSelect" | "portableText" | "image" | "file" | "reference" | "json" | "slug" | "repeater" | "blocks";
/** Repeater sub-field types EmDash allows (REPEATER_SUB_FIELD_TYPES: flat only). */
export const REPEATER_SUB_TYPES = new Set<EmDashFieldType>(["string", "text", "url", "number", "integer", "boolean", "datetime", "select", "image"]);

/** One EmDash field of a migrated post type, and where its value comes from. */
export interface CptField {
	slug: string;
	label: string;
	type: EmDashFieldType;
	/** The WordPress field: plugin, meta key (group sub-fields: the path `group.sub`), plugin type. */
	wp: { source: FieldSource; name: string; type: string; path?: string[] };
	/** How the value is read (src kind; see `fieldKind`). */
	kind: FieldKind;
	options?: string[];
	subFields?: { slug: string; label: string; type: EmDashFieldType; options?: string[]; kind: FieldKind; wpName: string }[];
	/** reference: WordPress post types it points at; the EmDash collection once known; one or many. */
	targets?: string[];
	targetCollection?: string;
	multiple?: boolean;
	/** Kept as JSON (EmDash has no matching type) or otherwise lossy: shown in the coverage report. */
	note?: string;
	warn?: boolean;
}

/**
 * What a WordPress field holds, independent of the plugin. `layout` holds no value (tabs, messages, headings).
 */
export type FieldKind = "string" | "email" | "url" | "oembed" | "text" | "html" | "number" | "boolean" | "select" | "multiSelect" | "date" | "datetime" | "time" | "color" | "image" | "file" | "gallery" | "files" | "reference" | "repeater" | "group" | "flexible" | "link" | "password" | "taxonomy" | "user" | "map" | "json" | "layout";

const ACF_KIND: Record<string, FieldKind> = {
	text: "string",
	textarea: "text",
	number: "number",
	range: "number",
	email: "email",
	url: "url",
	password: "password",
	image: "image",
	file: "file",
	wysiwyg: "html",
	oembed: "oembed",
	gallery: "gallery",
	select: "select",
	checkbox: "multiSelect",
	radio: "select",
	button_group: "select",
	true_false: "boolean",
	link: "link",
	post_object: "reference",
	page_link: "url",
	relationship: "reference",
	taxonomy: "taxonomy",
	user: "user",
	google_map: "map",
	date_picker: "date",
	date_time_picker: "datetime",
	time_picker: "time",
	color_picker: "color",
	message: "layout",
	accordion: "layout",
	tab: "layout",
	group: "group",
	repeater: "repeater",
	flexible_content: "flexible",
	clone: "group",
};

const METABOX_KIND: Record<string, FieldKind> = {
	text: "string",
	textarea: "text",
	number: "number",
	range: "number",
	slider: "number",
	email: "email",
	url: "url",
	password: "password",
	wysiwyg: "html",
	checkbox: "boolean",
	switch: "boolean",
	checkbox_list: "multiSelect",
	radio: "select",
	select: "select",
	select_advanced: "select",
	button_group: "select",
	image_select: "select",
	date: "date",
	datetime: "datetime",
	time: "time",
	color: "color",
	single_image: "image",
	image: "gallery",
	image_advanced: "gallery",
	image_upload: "gallery",
	plupload_image: "gallery",
	file: "files",
	file_advanced: "files",
	file_upload: "files",
	video: "files",
	file_input: "url",
	post: "reference",
	taxonomy: "taxonomy",
	taxonomy_advanced: "taxonomy",
	user: "user",
	oembed: "oembed",
	map: "map",
	osm: "map",
	group: "group",
	heading: "layout",
	divider: "layout",
	custom_html: "layout",
	button: "layout",
	key_value: "json",
	fieldset_text: "json",
	text_list: "json",
};

const PODS_KIND: Record<string, FieldKind> = {
	text: "string",
	website: "url",
	phone: "string",
	email: "email",
	password: "password",
	paragraph: "text",
	wysiwyg: "html",
	code: "text",
	datetime: "datetime",
	date: "date",
	time: "time",
	number: "number",
	currency: "number",
	oembed: "oembed",
	boolean: "boolean",
	color: "color",
	slug: "string",
	heading: "layout",
	html: "layout",
};

/** What a plugin field holds. */
export function fieldKind(def: WpFieldDef): FieldKind {
	const t = def.type;
	// A type the owner named in overrides.ts (`fields: { key: "text" }`).
	if (t.startsWith("emdash:")) return kindOfType(t.slice(7) as EmDashFieldType);
	if (def.source === "acf") {
		const k = ACF_KIND[t] ?? "json";
		if (k === "select" && def.multiple) return "multiSelect";
		if (t === "clone" && !def.subFields?.length) return "json";
		return k;
	}
	if (def.source === "metabox") {
		const k = METABOX_KIND[t] ?? "json";
		if (k === "select" && def.multiple) return "multiSelect";
		if (k === "group" && def.multiple) return "repeater";
		return k;
	}
	if (def.source === "pods") {
		if (t === "file") return def.fileType === "images" ? (def.multiple ? "gallery" : "image") : def.multiple ? "files" : "file";
		if (t === "pick") {
			if (def.targets?.length) return "reference";
			if (def.choices?.length) return def.multiple ? "multiSelect" : "select";
			return "json";
		}
		return PODS_KIND[t] ?? "json";
	}
	return "json";
}

/** What a value of an EmDash field type is read as (fields whose type the owner chose). */
export function kindOfType(t: EmDashFieldType): FieldKind {
	const map: Partial<Record<EmDashFieldType, FieldKind>> = { string: "string", slug: "string", text: "text", url: "url", number: "number", integer: "number", boolean: "boolean", datetime: "datetime", select: "select", multiSelect: "multiSelect", portableText: "html", image: "image", file: "file", json: "json" };
	return map[t] ?? "json";
}

/** EmDash field slug for a WordPress name: lowercase letters, digits, underscores, starting with a letter. */
export function fieldSlug(name: string): string {
	const s = name
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "")
		.replace(/_{2,}/g, "_");
	const out = /^[a-z]/.test(s) ? s : `f_${s || "field"}`;
	return out.slice(0, 63);
}

/** Field slugs the kit's own fields and EmDash's columns use (emdash schema/types.ts RESERVED_FIELD_SLUGS). */
export const RESERVED_SLUGS = new Set(["id", "slug", "status", "author_id", "primary_byline_id", "created_at", "updated_at", "published_at", "scheduled_at", "deleted_at", "version", "live_revision_id", "draft_revision_id", "terms", "bylines", "byline", "title", "excerpt", "featured_image", "body", "content", "menu_order", "parent", "locale", "translation_group"]);

const labelOf = (name: string) =>
	name
		.split(/[_-]+/)
		.filter(Boolean)
		.map((w) => w[0]?.toUpperCase() + w.slice(1))
		.join(" ") || name;

/**
 * The EmDash fields for one WordPress field (a group becomes one field per sub-field, `<group>_<sub>`). `collectionFor`
 * names the EmDash collection of a WordPress post type (references).
 */
export function mapField(def: WpFieldDef, ctx: { collectionFor: (postType: string) => string | undefined; taken: Set<string> }, path: string[] = []): CptField[] {
	const kind = fieldKind(def);
	if (kind === "layout") return [];
	const wpPath = [...path, def.name];
	const slugBase = fieldSlug(wpPath.join("_"));
	let slug = RESERVED_SLUGS.has(slugBase) ? `wp_${slugBase}` : slugBase;
	for (let i = 2; ctx.taken.has(slug); i++) slug = `${slugBase}_${i}`;
	const label = def.label || labelOf(def.name);
	const wp = { source: def.source, name: def.name, type: def.type, ...(path.length ? { path: wpPath } : {}) };
	// Never `required`: WordPress did not enforce it on every entry, and EmDash would refuse to save those.
	const base = { slug, label, wp, kind };
	const field = (type: EmDashFieldType, extra: Partial<CptField> = {}): CptField[] => {
		ctx.taken.add(slug);
		return [{ ...base, type, ...extra }];
	};
	const json = (note: string) => field("json", { note, warn: true });
	switch (kind) {
		case "string":
		case "color":
		case "time":
			return field("string", kind === "time" ? { note: "time of day kept as text (EmDash has no time field)" } : {});
		case "email":
			return field("string", { note: "e-mail address kept as text (EmDash has no e-mail field)" });
		case "url":
		case "oembed":
			return field("url", kind === "oembed" ? { note: "embed URL (the starter shows it as a link)" } : {});
		case "text":
			return field("text");
		case "html":
			return field("portableText");
		case "number":
			return field("number");
		case "boolean":
			return field("boolean");
		case "select":
			return field("select", { options: def.choices ?? [] });
		case "multiSelect":
			return field("multiSelect", { options: def.choices ?? [] });
		case "date":
		case "datetime":
			return field("datetime", kind === "date" ? { note: "date kept as a date and time at 00:00 UTC (EmDash has no date-only field)" } : {});
		case "image":
			return field("image");
		case "file":
			return field("file");
		case "gallery":
			return field("repeater", { subFields: [{ slug: "image", label: "Image", type: "image", kind: "image", wpName: "image" }], note: "gallery → repeater of images" });
		case "files":
			return json("several files: EmDash repeaters cannot hold files, kept as a list of media in a JSON field");
		case "password":
			return [];
		case "reference": {
			const targets = def.targets?.length ? def.targets : [];
			const cols = [...new Set(targets.map((t) => ctx.collectionFor(t)))];
			const multiple = def.multiple ?? def.type === "relationship";
			if (cols.length === 1 && cols[0]) return field("reference", { targets, targetCollection: cols[0], multiple });
			// Unknown or mixed targets: EmDash references point at one collection.
			return field("json", { targets, multiple, note: targets.length ? `points at ${targets.join(", ")}: ${cols.includes(undefined) ? "a type that is not a collection" : "several collections"}; kept as WordPress ids` : "relationship target unknown (no definition with post types); kept as WordPress ids", warn: true });
		}
		case "repeater": {
			const subs = (def.subFields ?? []).flatMap((s) => {
				const k = fieldKind(s);
				if (k === "layout" || k === "password") return [];
				const t = subType(k);
				return [{ slug: fieldSlug(s.name), label: s.label || labelOf(s.name), type: t ?? ("json" as EmDashFieldType), kind: k, wpName: s.name, ...(k === "select" ? { options: s.choices ?? [] } : {}), ok: !!t }];
			});
			if (!subs.length) return json("repeater whose rows are not described (no sub-field definitions): kept as JSON");
			const bad = subs.filter((s) => !s.ok);
			if (bad.length) return json(`repeater with ${bad.map((s) => `${s.wpName} (${s.kind})`).join(", ")}: EmDash repeater rows hold only flat text, number, date, select and image values; kept as JSON`);
			return field("repeater", { subFields: subs.map(({ ok: _ok, ...s }) => s) });
		}
		case "group": {
			if (!def.subFields?.length) return json("group whose fields are not described: kept as JSON");
			return def.subFields.flatMap((s) => mapField(s, ctx, wpPath));
		}
		case "flexible":
			return json("flexible content (layouts of rows): kept as JSON; rebuild as sections if editors need it");
		case "link":
			return json("link (title, URL, target): kept as JSON");
		case "taxonomy":
			return json("taxonomy field: term ids kept as JSON (the entry's own terms are migrated as EmDash taxonomies)");
		case "user":
			return json("user field: WordPress user ids kept as JSON (users are not migrated)");
		case "map":
			return json("map location: kept as JSON");
		default:
			return json(`${def.source} ${def.type}: no EmDash field type, kept as JSON`);
	}
}

function subType(k: FieldKind): EmDashFieldType | undefined {
	switch (k) {
		case "string":
		case "email":
		case "color":
		case "time":
			return "string";
		case "text":
			return "text";
		case "url":
		case "oembed":
			return "url";
		case "number":
			return "number";
		case "boolean":
			return "boolean";
		case "date":
		case "datetime":
			return "datetime";
		case "select":
			return "select";
		case "image":
			return "image";
		default:
			return undefined;
	}
}

// ── Definition parsers ─────────────────────────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v as Obj) : []);
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const truthy = (v: unknown) => v === true || v === 1 || v === "1" || v === "true";

/** Post types an ACF group's location rules assign it to (`post_type == x`). */
export function acfLocationPostTypes(location: unknown): string[] {
	const out = new Set<string>();
	for (const or of list(location)) for (const rule of list(or)) {
		const r = o(rule);
		if (r.param === "post_type" && r.operator === "==" && typeof r.value === "string") out.add(r.value);
	}
	return [...out];
}

function acfChoices(v: unknown): string[] | undefined {
	if (Array.isArray(v)) return v.map(str).filter(Boolean);
	const keys = Object.keys(o(v));
	return keys.length ? keys : undefined;
}

/** One ACF field definition (export JSON or unserialized acf-field settings). */
export function acfField(f: Obj): WpFieldDef {
	const type = str(f.type);
	const subs = list(f.sub_fields).map((s) => acfField(o(s)));
	const targets = list(f.post_type).map(str).filter(Boolean);
	return {
		source: "acf",
		name: str(f.name),
		label: str(f.label),
		type,
		...(truthy(f.required) ? { required: true } : {}),
		...(truthy(f.multiple) || type === "relationship" || (type === "post_object" && truthy(f.multiple)) ? { multiple: true } : {}),
		...(acfChoices(f.choices) ? { choices: acfChoices(f.choices) } : {}),
		...(subs.length ? { subFields: subs } : {}),
		...(targets.length ? { targets } : {}),
	};
}

/** ACF "Export field groups" JSON (one group or a list). */
export function acfGroupsFromExport(json: unknown, from: string): WpFieldGroup[] {
	const groups = Array.isArray(json) ? json : [json];
	return groups
		.map(o)
		.filter((g) => /^group_/.test(str(g.key)) && Array.isArray(g.fields))
		.map((g) => ({ source: "acf" as const, title: str(g.title), postTypes: acfLocationPostTypes(g.location), fields: list(g.fields).map((f) => acfField(o(f))), from }));
}

/** Whether a JSON file is an ACF field group export. */
export function isAcfExport(json: unknown): boolean {
	return acfGroupsFromExport(json, "").length > 0;
}

/** The Exporter's analyze `acf` list: top-level fields with their types (no sub-fields, choices or targets). */
export function acfGroupsFromAnalyze(acf: unknown): WpFieldGroup[] {
	return list(acf).map((g) => ({ source: "acf" as const, title: str(o(g).title), postTypes: acfLocationPostTypes(o(g).location), fields: list(o(g).fields).map((f) => ({ source: "acf" as const, name: str(o(f).name), label: str(o(f).label), type: str(o(f).type), ...(truthy(o(f).required) ? { required: true } : {}) })), from: "Exporter analyze (ACF top-level fields)" }));
}

/**
 * ACF's own configuration posts (`acf-field-group`, `acf-field`), as the Exporter returns any post type: the settings
 * are PHP-serialized in post_content; a field's parent is its group's or its repeater's post id.
 */
export function acfGroupsFromPosts(groupPosts: { id: number; slug: string; title: string; content: string; status?: string }[], fieldPosts: { id: number; slug: string; title: string; excerpt: string; content: string; parent: number | null; menu_order: number }[]): WpFieldGroup[] {
	const settings = (s: string): Obj => {
		if (!isPhpSerialized(s)) return {};
		try {
			return o(phpUnserialize(s));
		} catch {
			return {};
		}
	};
	const children = (parent: number): WpFieldDef[] =>
		fieldPosts
			.filter((f) => f.parent === parent)
			.sort((a, b) => a.menu_order - b.menu_order)
			.map((f) => {
				const s = settings(f.content);
				const sub = children(f.id);
				return { ...acfField({ ...s, name: f.excerpt, label: f.title, key: f.slug }), ...(sub.length ? { subFields: sub } : {}) };
			});
	return groupPosts.filter((g) => g.status !== "trash").map((g) => ({ source: "acf" as const, title: g.title, postTypes: acfLocationPostTypes(settings(g.content).location), fields: children(g.id), from: "ACF field groups (acf-field posts)" }));
}

function metaBoxField(f: Obj): WpFieldDef {
	const subs = list(f.fields).map((s) => metaBoxField(o(s)));
	const targets = list(f.post_type ?? (typeof f.post_type === "string" ? [f.post_type] : [])).map(str).filter(Boolean);
	const opts = o(f.options);
	return {
		source: "metabox",
		name: str(f.id),
		label: str(f.name),
		type: str(f.type) || "text",
		...(truthy(f.required) ? { required: true } : {}),
		...(truthy(f.clone) || truthy(f.multiple) ? { multiple: true } : {}),
		...(Object.keys(opts).length ? { choices: Object.keys(opts) } : {}),
		...(subs.length ? { subFields: subs } : {}),
		...(typeof f.post_type === "string" ? { targets: [f.post_type] } : targets.length ? { targets } : {}),
	};
}

/** Meta Box Builder export (JSON): field groups with `post_types` and `fields` (also under `meta_box` / `settings`). */
export function metaBoxGroupsFromExport(json: unknown, from: string): WpFieldGroup[] {
	const out: WpFieldGroup[] = [];
	for (const item of Array.isArray(json) ? json : [json]) {
		const i = o(item);
		const mb = Object.keys(o(i.meta_box)).length ? o(i.meta_box) : i;
		const fields = list(mb.fields).map(o).filter((f) => typeof f.id === "string");
		const postTypes = list(mb.post_types ?? o(i.settings).post_types).map(str).filter(Boolean);
		if (!fields.length || !postTypes.length) continue;
		out.push({ source: "metabox", title: str(mb.title ?? i.post_title), postTypes, fields: fields.map(metaBoxField), from });
	}
	return out;
}

/** Pods package export (JSON): `pods` (list or by id) of type post_type with their `fields`. */
export function podsGroupsFromExport(json: unknown, from: string): WpFieldGroup[] {
	const out: WpFieldGroup[] = [];
	for (const pod of list(o(json).pods).map(o)) {
		if (pod.type !== undefined && pod.type !== "post_type") continue;
		const name = str(pod.name);
		if (!name) continue;
		const fields = list(pod.fields)
			.map(o)
			.map((f): WpFieldDef => {
				const opt = { ...o(f.options), ...f };
				const pickObject = str(opt.pick_object);
				const choices = str(opt.pick_custom)
					.split(/\r?\n/)
					.map((l) => l.split("|")[0]?.trim() ?? "")
					.filter(Boolean);
				const multi = str(opt.pick_format_type) === "multi" || str(opt.file_format_type) === "multi";
				return {
					source: "pods",
					name: str(f.name),
					label: str(f.label),
					type: str(f.type),
					...(truthy(opt.required) ? { required: true } : {}),
					...(multi ? { multiple: true } : {}),
					...(pickObject === "post_type" && str(opt.pick_val) ? { targets: [str(opt.pick_val)] } : {}),
					...(pickObject === "custom-simple" && choices.length ? { choices } : {}),
					...(str(opt.file_type) ? { fileType: str(opt.file_type) } : {}),
				};
			})
			.filter((f) => f.name);
		out.push({ source: "pods", title: str(pod.label) || name, postTypes: [name], fields, from });
	}
	return out;
}

export function isMetaBoxExport(json: unknown): boolean {
	return metaBoxGroupsFromExport(json, "").length > 0;
}
export function isPodsExport(json: unknown): boolean {
	return podsGroupsFromExport(json, "").length > 0 || (Array.isArray(o(json).pods) && !!o(json)["@meta"]);
}

/**
 * The fields of one post type from every definition source. A field described by a richer source (export, ACF
 * posts) replaces the same name from a poorer one (analyze); the first group's order is kept.
 */
export function fieldsForType(groups: WpFieldGroup[], postType: string): { fields: WpFieldDef[]; groups: string[] } {
	const rank = (g: WpFieldGroup) => (g.from.startsWith("Exporter analyze") ? 0 : 1);
	const byName = new Map<string, { def: WpFieldDef; rank: number }>();
	const order: string[] = [];
	const titles: string[] = [];
	for (const g of groups.filter((x) => x.postTypes.includes(postType))) {
		titles.push(`${g.title} (${g.from})`);
		for (const f of g.fields) {
			if (!f.name) continue;
			const known = byName.get(f.name);
			if (!known) order.push(f.name);
			if (!known || rank(g) > known.rank) byName.set(f.name, { def: f, rank: rank(g) });
		}
	}
	return { fields: order.map((n) => byName.get(n)?.def as WpFieldDef), groups: [...new Set(titles)] };
}

// ── Values ────────────────────────────────────────────────────────────────────────────────────────────────

export interface ValueContext {
	/** Media library id of an upload URL (size variants ignored). */
	mediaIdForUrl: (url: string) => number | undefined;
	/** Post type of a WordPress post id (references), when the extract has it. */
	typeOfId: (id: number) => string | undefined;
	/** HTML (wysiwyg) → Portable Text with media marked for load. */
	html: (html: string, keyPrefix: string) => unknown[];
	/** Deterministic key prefix of this entry's field. */
	keyPrefix: string;
}

/** A converted value: the field's data, the references it holds (`<type>:<wpId>`), and problems to report. */
export interface FieldValue {
	value?: unknown;
	refs?: string[];
	problems?: string[];
}

const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || v === false || (Array.isArray(v) && v.length === 0);
const asArray = (v: unknown): unknown[] => {
	if (isPhpSerialized(v)) {
		try {
			v = phpUnserialize(v);
		} catch {}
	}
	return Array.isArray(v) ? v : v && typeof v === "object" ? Object.values(v as Obj) : isEmpty(v) ? [] : [v];
};

/** A media value in any of the shapes WordPress stores it → a MediaRef. */
export function mediaOf(v: unknown, kind: MediaRef["kind"], ctx: Pick<ValueContext, "mediaIdForUrl">): MediaRef | undefined {
	if (isEmpty(v)) return undefined;
	if (typeof v === "number" && v > 0) return { wpId: v, kind };
	if (typeof v === "string" && /^\d+$/.test(v.trim())) return Number(v) > 0 ? { wpId: Number(v), kind } : undefined;
	if (typeof v === "string" && /^https?:\/\//.test(v)) {
		const id = ctx.mediaIdForUrl(v);
		return id ? { wpId: id, kind } : { url: v, kind };
	}
	const m = o(v);
	const id = Number(m.id ?? m.ID ?? 0);
	const alt = typeof m.alt === "string" && m.alt.trim() ? m.alt.trim() : undefined;
	if (id > 0) return { wpId: id, kind, ...(alt ? { alt } : {}) };
	if (typeof m.url === "string" && m.url) return { ...(mediaOf(m.url, kind, ctx) as MediaRef), ...(alt ? { alt } : {}) };
	return undefined;
}

/** WordPress date values (ACF `Ymd`, `Y-m-d`, `Y-m-d H:i:s`, ISO, Unix seconds) → ISO 8601 UTC. */
export function dateOf(v: unknown): string | undefined {
	if (isEmpty(v)) return undefined;
	const s = String(v).trim();
	let iso: string | undefined;
	if (/^\d{8}$/.test(s)) iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T00:00:00Z`;
	else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) iso = `${s}T00:00:00Z`;
	else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) iso = `${s.replace(" ", "T")}${s.length === 16 ? ":00" : ""}Z`;
	else if (/^\d{9,11}$/.test(s)) iso = new Date(Number(s) * 1000).toISOString();
	else if (/^\d{4}-\d{2}-\d{2}T/.test(s)) iso = s;
	const t = iso ? Date.parse(iso) : Number.NaN;
	return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

const scalar = (v: unknown): string | undefined => (isEmpty(v) ? undefined : typeof v === "object" ? (str(o(v).value) || str(o(v).label) || undefined) : String(v));

/** URLs EmDash's url field accepts: http(s), mailto, tel, or a site-relative path. */
export const safeUrl = (s: string) => /^(https?:\/\/|mailto:|tel:|\/)/i.test(s.trim());

/** One field's stored value → its EmDash value. `acf`: the ACF get_fields() value; `raw`: the post meta. */
export function convertValue(field: Pick<CptField, "kind" | "type" | "subFields" | "slug">, acf: unknown, raw: unknown, ctx: ValueContext): FieldValue {
	const v = acf !== undefined && acf !== null && !(field.kind === "date" || field.kind === "datetime") ? acf : (raw ?? acf);
	if (isEmpty(v) && field.kind !== "boolean") return {};
	switch (field.kind) {
		case "string":
		case "email":
		case "color":
		case "time":
			return { value: scalar(v) };
		case "text":
			return { value: String(v) };
		case "url":
		case "oembed": {
			const s = scalar(v);
			if (!s) return {};
			return safeUrl(s) ? { value: s.trim() } : { problems: [`${field.slug}: "${s.slice(0, 60)}" is not a URL EmDash accepts (http, https, mailto, tel or /path); left empty`] };
		}
		case "html":
			return { value: ctx.html(String(v), `${ctx.keyPrefix}${field.slug}_`) };
		case "number": {
			const n = Number(v);
			return Number.isFinite(n) ? { value: n } : { problems: [`${field.slug}: "${String(v).slice(0, 40)}" is not a number; left empty`] };
		}
		case "boolean":
			return { value: v === true || v === 1 || v === "1" || v === "true" || v === "yes" || v === "on" };
		case "select":
			return { value: scalar(Array.isArray(v) ? v[0] : v) };
		case "multiSelect":
			return { value: asArray(v).map(scalar).filter((x): x is string => !!x) };
		case "date":
		case "datetime": {
			const d = dateOf(v);
			return d ? { value: d } : { problems: [`${field.slug}: date "${String(v).slice(0, 40)}" not understood; left empty`] };
		}
		case "image":
		case "file": {
			const m = mediaOf(Array.isArray(v) ? v[0] : v, field.kind, ctx);
			return m ? { value: m } : { problems: [`${field.slug}: media value not understood`] };
		}
		case "gallery": {
			const rows = asArray(v).map((x) => mediaOf(x, "image", ctx)).filter((x): x is MediaRef => !!x);
			return { value: rows.map((image) => ({ image })) };
		}
		case "files":
			return { value: asArray(v).map((x) => mediaOf(x, "file", ctx)).filter(Boolean) };
		case "reference": {
			const ids = asArray(v)
				.map((x) => Number(typeof x === "object" && x ? (o(x).ID ?? o(x).id) : x))
				.filter((x) => Number.isInteger(x) && x > 0);
			if (field.type !== "reference") return { value: ids };
			const refs: string[] = [];
			const problems: string[] = [];
			for (const id of ids) {
				const t = ctx.typeOfId(id);
				if (t) refs.push(`${t}:${id}`);
				else problems.push(`${field.slug}: points at #${id}, which the extract does not have (deleted or private)`);
			}
			return { refs, ...(problems.length ? { problems } : {}) };
		}
		case "repeater": {
			if (field.type !== "repeater") return { value: jsonSafe(v) };
			const rows = asArray(v).map(o);
			const problems: string[] = [];
			const out = rows.map((row, i) => {
				const r: Record<string, unknown> = {};
				for (const s of field.subFields ?? []) {
					const c = convertValue({ kind: s.kind, type: s.type, slug: `${field.slug}[${i}].${s.slug}` }, row[s.wpName], undefined, { ...ctx, keyPrefix: `${ctx.keyPrefix}${i}_` });
					if (c.value !== undefined) r[s.slug] = c.value;
					problems.push(...(c.problems ?? []));
				}
				return r;
			});
			return { value: out, ...(problems.length ? { problems } : {}) };
		}
		default:
			return { value: jsonSafe(v) };
	}
}

/** A value for a JSON field: plain data only (images and posts as ids, ACF's arrays as they are). */
function jsonSafe(v: unknown): unknown {
	if (isPhpSerialized(v)) {
		try {
			return phpUnserialize(v);
		} catch {
			return v;
		}
	}
	return v;
}

/**
 * ACF repeater/group values from raw post meta (`<name>` = row count, `<name>_<i>_<sub>` per row; groups as
 * `<name>_<sub>`), for entries the Exporter returned without an `acf` object.
 */
export function acfFromMeta(def: WpFieldDef, meta: Record<string, unknown>, prefix = ""): unknown {
	const key = `${prefix}${def.name}`;
	const kind = fieldKind(def);
	if (kind === "repeater" && def.subFields?.length) {
		const n = Number(meta[key] ?? 0);
		if (!Number.isInteger(n) || n <= 0) return undefined;
		return Array.from({ length: n }, (_, i) => Object.fromEntries(def.subFields?.map((s) => [s.name, acfFromMeta(s, meta, `${key}_${i}_`)]) ?? []));
	}
	if (kind === "group" && def.subFields?.length) return Object.fromEntries(def.subFields.map((s) => [s.name, acfFromMeta(s, meta, `${key}_`)]));
	return meta[key];
}

/** Meta keys that belong to WordPress, plugins or a field definition, not to unmapped content. */
export function isInternalMeta(key: string): boolean {
	return key.startsWith("_") || /^(rank_math_|yoast_|_yoast|wpb_|vc_|nectar|_bricks|bricks_|_elementor|elementor_|_et_|et_|_oembed|_thumbnail_id|_wp_|_edit_|_pingme|_encloseme|ast-|site-|theme-|_genesis|footnotes$|inline_featured_image$|slide_template$|rs_page_bg_color$|sbg_|_fl_|fl_builder|_kad|kadence|_uag|uag_|spectra|_aioseo|aioseo_|_seopress|seopress_|_jetpack|jetpack_|amp_|_amp|ocean_|_ocean|_generate|generate_|_astra|astra-|_dp_|_menu_item|classic-editor-remember|_last_editor|_encloseme|_pods_|pods_)/i.test(key);
}
