/**
 * ACF outside custom post type collections: fields on pages and posts (flexible content → sections, other values
 * reported), ACF options pages (site-wide settings), and the coverage report section for all of it. Custom post types
 * carry their ACF fields as collection fields (src/transform/cpt.ts); this module covers what has no collection field.
 *
 * Storage formats: docs/spikes/acf-findings.md.
 */
import type { LayoutUse } from "./acf-flexible.js";
import { acfFromMeta, fieldKind, jsonSafe, type WpFieldDef, type WpFieldGroup } from "./cpt-fields.js";

type Obj = Record<string, unknown>;
const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || v === false || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && !Array.isArray(v) && v !== null && Object.values(v as Obj).every(isEmpty));

/** File written by import-options (from a database backup): ACF options (`options_<name>` rows). */
export const ACF_OPTIONS_FILE = "acf-options.json";

/** Option names import-options reads for ACF options pages (ACF stores them as `options_<field name>`). */
export const isAcfOptionName = (name: string) => /^options_[a-z0-9_]/i.test(name);

/** A short, single-line preview of a stored value (report). */
export function sample(v: unknown, max = 60): string {
	const x = jsonSafe(v);
	const s = typeof x === "string" ? x.replace(/<[^>]+>/g, " ") : typeof x === "number" || typeof x === "boolean" ? String(x) : JSON.stringify(x);
	const one = (s ?? "").replace(/\s+/g, " ").trim();
	return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** An entry's stored value of one ACF field: the Exporter's `acf` object, else rebuilt from post meta. */
export function acfValue(def: WpFieldDef, p: { meta?: Obj; acf?: Obj }): unknown {
	const meta = p.meta ?? {};
	if (meta[def.name] !== undefined || (fieldKind(def) === "group" && Object.keys(meta).some((k) => k.startsWith(`${def.name}_`)))) return acfFromMeta(def, meta);
	return p.acf?.[def.name];
}

/** ACF fields (not flexible content, not layout or password fields) with a value on one page or post. */
export function acfOtherValues(defs: WpFieldDef[], p: { meta?: Obj; acf?: Obj }): { def: WpFieldDef; value: unknown }[] {
	return defs.flatMap((def) => {
		const k = fieldKind(def);
		if (k === "layout" || k === "password" || (k === "flexible" && def.layouts?.length)) return [];
		const value = acfValue(def, p);
		return isEmpty(jsonSafe(value)) ? [] : [{ def, value }];
	});
}

/** ACF fields on pages/posts the page itself does not carry (report). */
export interface AcfPostField {
	postType: string;
	name: string;
	label: string;
	type: string;
	/** Entries with a value: slug, whether the live page was rebuilt from its HTML (values shown there), a sample. */
	entries: { slug: string; rendered: boolean; sample: string }[];
}

export function collectPostField(into: AcfPostField[], postType: string, slug: string, rendered: boolean, def: WpFieldDef, value: unknown): void {
	let row = into.find((r) => r.postType === postType && r.name === def.name);
	if (!row) {
		row = { postType, name: def.name, label: def.label || def.name, type: def.type, entries: [] };
		into.push(row);
	}
	row.entries.push({ slug, rendered, sample: sample(value) });
}

// ── Options pages ───────────────────────────────────────────────────────────────────────────────────────────

export interface AcfOptionsPlan {
	/** Options page slugs the field groups name. */
	pages: string[];
	/** Values from a database backup (import-options); false: no backup read yet. */
	valuesRead: boolean;
	fields: { name: string; label: string; type: string; group: string; value?: unknown; sample?: string }[];
	/** `options_*` rows no field definition describes (names only). */
	undescribed: string[];
}

/**
 * ACF options pages: every field of a group shown on an options page, with its value when a database backup was read
 * (ACF keeps options in wp_options as `options_<name>`; the REST API serves none of them). Password fields never.
 */
export function acfOptionsPlan(groups: WpFieldGroup[], values: Obj | undefined): AcfOptionsPlan | undefined {
	const optionGroups = groups.filter((g) => g.source === "acf" && g.optionsPages?.length);
	const describedNames = new Set<string>();
	const fields: AcfOptionsPlan["fields"] = [];
	for (const g of optionGroups) {
		for (const def of g.fields) {
			const k = fieldKind(def);
			if (k === "layout" || !def.name || fields.some((f) => f.name === def.name)) continue;
			describedNames.add(def.name);
			if (k === "password") {
				fields.push({ name: def.name, label: def.label || def.name, type: def.type, group: g.title });
				continue;
			}
			const raw = values ? acfFromMeta(def, values, "options_") : undefined;
			const value = jsonSafe(raw);
			fields.push({ name: def.name, label: def.label || def.name, type: def.type, group: g.title, ...(!isEmpty(value) ? { value, sample: sample(value) } : {}) });
		}
	}
	const prefixes = [...describedNames].map((n) => `options_${n}`);
	const undescribed = Object.keys(values ?? {})
		.filter((k) => isAcfOptionName(k) && !prefixes.some((p) => k === p || k.startsWith(`${p}_`)))
		.sort();
	if (!optionGroups.length && !undescribed.length) return undefined;
	return { pages: [...new Set(optionGroups.flatMap((g) => g.optionsPages ?? []))].sort(), valuesRead: !!values, fields, undescribed };
}

// ── Coverage report ─────────────────────────────────────────────────────────────────────────────────────────

export interface AcfReportInput {
	/** Flexible content layouts on pages and entries, with where they were found. */
	layouts: (LayoutUse & { where: string; rendered?: boolean })[];
	postFields: AcfPostField[];
	options?: AcfOptionsPlan;
}

export function acfReport(r: AcfReportInput): string[] {
	if (!r.layouts.length && !r.postFields.length && !r.options) return [];
	const esc = (s: string) => s.replace(/\|/g, "\\|");
	const L: string[] = [];
	if (r.layouts.length) {
		L.push("", "## ACF flexible content", "", "Each layout of a flexible content field and the kit section its rows became. **unmapped** rows are not sections: on a collection entry they stay in the field as data; on a page they block the transform gate unless the page was rebuilt from its rendered HTML. Force a section type or skip a layout in `overrides.ts → acfLayouts: { <layout>: \"<section type>\" | \"skip\" }`.", "", "| Field | Layout | Where | Rows | Became | Not carried |", "|---|---|---|---|---|---|");
		const merged = new Map<string, LayoutUse & { where: string[]; rendered: boolean }>();
		for (const u of r.layouts) {
			const k = `${u.field}\u0000${u.layout}\u0000${u.by}\u0000${u.as ?? ""}`;
			const m = merged.get(k) ?? { ...u, rows: 0, where: [], notCarried: [], rendered: !!u.rendered };
			m.rows += u.rows;
			if (!m.where.includes(u.where)) m.where.push(u.where);
			for (const n of u.notCarried) if (!m.notCarried.includes(n)) m.notCarried.push(n);
			merged.set(k, m);
		}
		for (const u of [...merged.values()].sort((a, b) => a.field.localeCompare(b.field) || a.layout.localeCompare(b.layout))) {
			const became = u.rendered ? "rendered page (DOM fallback)" : u.by === "skip" ? "skipped (overrides.ts)" : u.by === "unmapped" ? "❌ unmapped" : `${u.as}${u.by === "override" ? " (overrides.ts)" : ""}`;
			L.push(`| \`${esc(u.field)}\` | ${esc(u.label)} (\`${esc(u.layout)}\`) | ${esc(u.where.slice(0, 4).join(", "))}${u.where.length > 4 ? `, +${u.where.length - 4}` : ""} | ${u.rows} | ${became} | ${esc(u.notCarried.join(", ")) || "—"} |`);
		}
	}
	if (r.postFields.length) {
		L.push("", "## ACF fields on pages and posts", "", "Field values a theme template showed around the page content. Pages and posts have no custom fields of their own on EmDash: where the page was rebuilt from its rendered HTML the values are part of it; otherwise add them to the page in the admin (or as a section), or decide they are not needed.", "", "| Type | Field | ACF type | Entries with a value | Shown through the rendered page | Sample |", "|---|---|---|---|---|---|");
		for (const f of r.postFields) {
			const rendered = f.entries.filter((e) => e.rendered).length;
			L.push(`| ${f.postType} | ${esc(f.label)} (\`${esc(f.name)}\`) | ${esc(f.type)} | ${f.entries.length}: ${esc(f.entries.slice(0, 4).map((e) => e.slug).join(", "))}${f.entries.length > 4 ? ", …" : ""} | ${rendered === f.entries.length ? "yes" : rendered ? `${rendered} of ${f.entries.length}` : "⚠️ no"} | ${esc(f.entries[0]?.sample ?? "")} |`);
		}
	}
	if (r.options) {
		const o = r.options;
		L.push("", "## ACF options pages", "", `Site-wide settings from ACF options page(s)${o.pages.length ? ` (${o.pages.map((p) => `\`${p}\``).join(", ")})` : ""}. EmDash has no options pages: carry what the new site shows (contact details, social links, footer text) into Settings, a site part or a section, and decide the rest. ${o.valuesRead ? "Values read from the database backup (raw/acf-options.json)." : "**Values not read:** ACF keeps options in the database (`wp_options`, `options_<field>`), which the REST API does not serve — run `wp2emdash import-options <slug> <database.sql>` (or import-dump) with a backup, then transform again."}`);
		if (o.fields.length) {
			L.push("", "| Field | ACF type | Group | Value |", "|---|---|---|---|");
			for (const f of o.fields) L.push(`| ${esc(f.label)} (\`${esc(f.name)}\`) | ${esc(f.type)} | ${esc(f.group)} | ${f.type === "password" ? "not carried (secret)" : f.sample ? esc(f.sample) : o.valuesRead ? "—" : "not read"} |`);
		}
		if (o.undescribed.length) L.push("", `Options rows no field definition describes (names only): ${o.undescribed.slice(0, 20).map((k) => `\`${k}\``).join(", ")}${o.undescribed.length > 20 ? ", …" : ""}.`);
	}
	return L;
}
