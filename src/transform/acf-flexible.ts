/**
 * ACF flexible content → kit sections. Agency themes build whole pages from one flexible content field ("page
 * sections"): each row is a layout (hero, text and image, cards, FAQ…) with its own sub-fields, rendered by the theme's
 * template. Each layout is matched to the closest section of the kit's library (PLAN §5) by its name and label, then
 * its sub-fields by what they hold (a title, rich text, images, a link, a repeater of items); a layout that matches no
 * section, or whose rows cannot fill one, is unmapped: its rows are kept as JSON on collection entries, and listed in
 * the coverage report (pages: blocking unless the live page is rebuilt another way). `overrides.ts acfLayouts` forces a
 * section type for a layout name, or skips it with the owner's decision.
 *
 * Storage formats (rows from `get_fields()` or rebuilt from post meta): docs/spikes/acf-findings.md.
 */
import { createHash } from "node:crypto";
import { htmlToPortableText, type Keys } from "../ir/portable-text.js";
import { type Button, type Diagnostic, type MediaRef, type PtBlock, type Section, type SectionType, section as sectionSchema } from "../ir/schema.js";
import { fieldKind, jsonSafe, mediaOf, safeUrl, type WpFieldDef, type WpLayout } from "./cpt-fields.js";

type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const listOf = (v: unknown): unknown[] => {
	const x = jsonSafe(v);
	return Array.isArray(x) ? x : x && typeof x === "object" ? Object.values(x as Obj) : x === undefined || x === null || x === "" ? [] : [x];
};
const rowsOf = (v: unknown): Obj[] => listOf(v).map(o);
const isEmpty = (v: unknown) => v === undefined || v === null || v === "" || v === false || (Array.isArray(v) && v.length === 0);
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

export interface FlexContext {
	/** Media library id of an upload URL. */
	mediaIdForUrl: (url: string) => number | undefined;
	/** A link on the old site → its path on the new one (other links unchanged). */
	href: (url: string) => string;
	/** Portable Text keys (deterministic per page/entry). */
	keys: Keys;
	/** overrides.ts `acfLayouts`: layout name → forced section type, or "skip". */
	decisions: Record<string, SectionType | "skip" | undefined>;
}

/** How one layout of one flexible field was carried (coverage report). */
export interface LayoutUse {
	/** Flexible content field name. */
	field: string;
	layout: string;
	label: string;
	rows: number;
	/** Section type the rows became (the most frequent one when rows differ). */
	as?: SectionType;
	by: "kit" | "override" | "skip" | "unmapped";
	/** Sub-fields with values that the section has no place for (content) or design settings (select, colour, true/false). */
	notCarried: string[];
}

export interface FlexOutcome {
	sections: Section[];
	/** Rows of unmapped layouts, as stored (with `acf_fc_layout`). */
	unmapped: Obj[];
	layouts: LayoutUse[];
	diagnostics: Diagnostic[];
	/** Rows hidden on the site (disabled in ACF), not carried. */
	disabled: number;
}

// ── Layout name → section type ─────────────────────────────────────────────────────────────────────────────

/** First match wins; tested against the layout's name and label as space-separated words. */
const BY_NAME: [RegExp, SectionType][] = [
	[/ (faqs?|accordions?|questions?|q ?a) /, "faq"],
	[/ (testimonials?|reviews?|quotes?) /, "testimonials"],
	[/ (team|staff|people|members?|instructors?|bios?) /, "team"],
	[/ (stats?|statistics|counters?|numbers|figures) /, "stats"],
	[/ (logos?|clients?|partners?|sponsors?|brands?) /, "logo_strip"],
	[/ (gallery|galleries|slider|carousel|photos|images) /, "gallery"],
	[/ (videos?|embed) /, "video"],
	[/ (map|maps|directions) /, "map"],
	[/ (steps?|process|timeline|how it works) /, "steps"],
	[/ (tabs?) /, "tabs"],
	[/ (hero|banner|masthead|jumbotron|page header) /, "hero"],
	[/ (cta|call to action|calltoaction|callout|signup|newsletter) /, "cta_banner"],
	[/ (features?|services?|cards?|grid|icons?|benefits?|columns?|boxes|tiles?|usps?) /, "feature_grid"],
	[/ (image text|text image|media text|text media|image and text|text and image|text with image|image with text|split|two col(umn)?s?|content image|image content) /, "media_text"],
	[/ (text|content|wysiwyg|editor|copy|paragraphs?|body|rich|intro|about) /, "rich_text"],
];

/** The section type a layout's name suggests (undefined: decided by its shape). */
export function layoutType(name: string, label = ""): SectionType | undefined {
	const words = ` ${`${name} ${label}`.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;
	return BY_NAME.find(([re]) => re.test(words))?.[1];
}

// ── Row → what it holds ─────────────────────────────────────────────────────────────────────────────────────

interface Roles {
	heading?: string;
	lead?: string;
	body: PtBlock[];
	/** Plain text of the body (testimonial quotes). */
	plain: string;
	images: MediaRef[];
	buttons: Button[];
	items: Roles[];
	video?: { embedUrl?: string; media?: MediaRef };
	map?: { address?: string };
	/** Short texts no role took (stat values, a person's role…), in order. */
	texts: { name: string; value: string }[];
	/** select / true_false values (an image position "left"). */
	settings: { name: string; value: string }[];
	/** Sub-fields with a value the roles do not carry (references, files, users…). */
	other: string[];
}

const HEADING = /(^|_)(title|heading|headline|name|header)(_|$)/;
const LEAD = /(sub_?title|sub_?heading|eyebrow|tagline|kicker|pre_?title|super_?title|lead|subhead)/;
const BUTTON_TEXT = /(button|btn|cta|link)_?(text|label|title)/;
const BUTTON_URL = /(button|btn|cta|link)(_?(url|link|href))?$|(^|_)url$/;
const VIDEO = /(video|youtube|vimeo|embed)/;

const block = (keys: Keys, t: string, style: PtBlock["style"] = "normal"): PtBlock => ({ _type: "block", _key: keys.next(), style, children: [{ _type: "span", _key: keys.next(), text: t, marks: [] }], markDefs: [] });

function roles(row: Obj, defs: WpFieldDef[], ctx: FlexContext, path: string[] = []): Roles {
	const r: Roles = { body: [], plain: "", images: [], buttons: [], items: [], texts: [], settings: [], other: [] };
	let buttonText: string | undefined;
	let buttonUrl: string | undefined;
	for (const d of defs) {
		const v = row[d.name];
		const kind = fieldKind(d);
		if (kind === "layout" || kind === "password" || (isEmpty(v) && kind !== "group")) continue;
		const name = d.name.toLowerCase();
		const at = [...path, d.name].join(".");
		switch (kind) {
			case "string":
			case "email":
			case "time": {
				const t = text(v);
				if (!t) break;
				if (LEAD.test(name) && !r.lead) r.lead = t;
				else if (BUTTON_TEXT.test(name) && !buttonText) buttonText = t;
				else if (HEADING.test(name) && !r.heading) r.heading = t;
				else r.texts.push({ name, value: t });
				break;
			}
			case "url":
			case "oembed": {
				const u = text(v);
				if (!u) break;
				if (kind === "oembed" || VIDEO.test(name)) r.video ??= { embedUrl: u };
				else if (!buttonUrl && (BUTTON_URL.test(name) || safeUrl(u))) buttonUrl = u;
				else r.other.push(at);
				break;
			}
			case "text": {
				const t = text(v);
				if (!t) break;
				if (HEADING.test(name) && !r.heading && !t.includes("\n")) r.heading = t;
				else {
					for (const para of t.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean)) r.body.push(block(ctx.keys, para.replace(/\s*\n\s*/g, " ")));
					r.plain = [r.plain, t].filter(Boolean).join("\n\n");
				}
				break;
			}
			case "html": {
				const pt = htmlToPortableText(String(v), ctx.keys);
				r.body.push(...pt.blocks);
				r.plain = [r.plain, pt.blocks.map((b) => b.children.map((c) => c.text).join("")).join("\n\n")].filter(Boolean).join("\n\n");
				for (const img of pt.images) {
					const m = mediaOf(img.wpId ?? img.src, "image", ctx);
					if (m) r.images.push({ ...m, ...(img.alt ? { alt: img.alt } : {}) });
				}
				if (pt.leftovers.length) r.other.push(`${at} (${[...new Set(pt.leftovers.map((l) => l.tag))].join(", ")} in the text)`);
				break;
			}
			case "image": {
				const m = mediaOf(Array.isArray(v) ? v[0] : v, "image", ctx);
				if (m) r.images.push(m);
				break;
			}
			case "gallery":
				for (const x of listOf(v)) {
					const m = mediaOf(x, "image", ctx);
					if (m) r.images.push(m);
				}
				break;
			case "file": {
				const m = mediaOf(Array.isArray(v) ? v[0] : v, "file", ctx);
				if (m && VIDEO.test(name)) r.video ??= { media: { ...m, kind: "video" } };
				else r.other.push(at);
				break;
			}
			case "link": {
				const l = o(jsonSafe(v));
				const u = text(l.url);
				if (u) r.buttons.push({ label: text(l.title) || "Learn more", href: ctx.href(u), style: r.buttons.length ? "secondary" : "primary", ...(l.target === "_blank" ? { newTab: true } : {}) });
				break;
			}
			case "repeater":
				if (!r.items.length) r.items = rowsOf(v).map((x, i) => roles(x, d.subFields ?? [], ctx, [...path, `${d.name}[${i}]`]));
				else r.other.push(at);
				break;
			case "group": {
				const g = roles(o(jsonSafe(v)), d.subFields ?? [], ctx, [...path, d.name]);
				r.heading ??= g.heading;
				r.lead ??= g.lead;
				r.body.push(...g.body);
				r.plain = [r.plain, g.plain].filter(Boolean).join("\n\n");
				r.images.push(...g.images);
				r.buttons.push(...g.buttons);
				if (!r.items.length) r.items = g.items;
				r.video ??= g.video;
				r.map ??= g.map;
				r.texts.push(...g.texts);
				r.settings.push(...g.settings);
				r.other.push(...g.other);
				break;
			}
			case "map": {
				const m = o(jsonSafe(v));
				const address = text(m.address);
				if (address) r.map = { address };
				else r.other.push(at);
				break;
			}
			case "number":
				r.texts.push({ name, value: text(v) });
				break;
			case "select":
			case "boolean":
			case "color":
			case "multiSelect":
				r.settings.push({ name, value: Array.isArray(v) ? v.map(text).join(", ") : typeof v === "boolean" ? String(v) : text(v) });
				break;
			default:
				r.other.push(at);
		}
	}
	if (buttonUrl) r.buttons.unshift({ label: buttonText || "Learn more", href: ctx.href(buttonUrl), style: "primary" });
	else if (buttonText) r.texts.push({ name: "button_text", value: buttonText });
	return r;
}

// ── Roles → a section ───────────────────────────────────────────────────────────────────────────────────────

const headingOf = (r: Roles, ctx: FlexContext) => (r.heading ? [block(ctx.keys, r.heading, "h2")] : undefined);
const leadAndBody = (r: Roles, ctx: FlexContext) => [...(r.lead ? [block(ctx.keys, r.lead, "lead")] : []), ...r.body];
const firstText = (r: Roles, re?: RegExp) => (re ? r.texts.find((t) => re.test(t.name)) : r.texts[0])?.value;
const plainOf = (r: Roles) => r.plain || [r.lead, ...r.texts.map((t) => t.value)].filter(Boolean).join(" ");

/** What a section of each type uses of the roles (the rest is reported as not carried). */
const USES: Partial<Record<SectionType, (keyof Roles)[]>> = {
	hero: ["heading", "lead", "body", "buttons", "images"],
	rich_text: ["heading", "lead", "body", "buttons"],
	media_text: ["heading", "lead", "body", "buttons", "images"],
	cta_banner: ["heading", "lead", "body", "buttons", "images"],
	faq: ["heading", "lead", "body", "items"],
	gallery: ["heading", "images", "items"],
	testimonials: ["heading", "items"],
	team: ["heading", "lead", "body", "items"],
	stats: ["heading", "items"],
	logo_strip: ["heading", "images", "items"],
	steps: ["heading", "items"],
	feature_grid: ["heading", "lead", "body", "items"],
	video: ["heading", "video", "lead"],
	map: ["heading", "map"],
	tabs: ["heading", "items"],
};

/** The section's `fields` for a type from a row's roles, or undefined when the row cannot fill that type. */
function fieldsFor(type: SectionType, r: Roles, ctx: FlexContext): Record<string, unknown> | undefined {
	const heading = headingOf(r, ctx);
	const body = leadAndBody(r, ctx);
	const withHeading = <T extends object>(f: T) => ({ ...(heading ? { heading } : {}), ...f });
	switch (type) {
		case "hero":
			return heading || body.length ? withHeading({ body, buttons: r.buttons, ...(r.images[0] ? { media: r.images[0] } : {}), align: "center" }) : undefined;
		case "rich_text": {
			const all = [...(heading ?? []), ...body];
			return all.length ? { body: all, buttons: r.buttons } : undefined;
		}
		case "media_text": {
			if (!r.images.length || !(heading || body.length)) return undefined;
			const side = r.settings.some((s) => /^(left|image_left|left_image|media_left)$/.test(s.value.toLowerCase())) ? "left" : "right";
			return { media: r.images.slice(0, 1), body: [...(heading ?? []), ...body], buttons: r.buttons, mediaSide: side };
		}
		case "cta_banner":
			return heading || body.length ? withHeading({ body, buttons: r.buttons, ...(r.images[0] ? { media: r.images[0] } : {}) }) : undefined;
		case "faq": {
			const items = r.items.map((i) => ({ question: i.heading ?? firstText(i) ?? "", answer: leadAndBody(i, ctx) })).filter((i) => i.question && i.answer.length);
			return items.length ? withHeading({ intro: body, items }) : undefined;
		}
		case "gallery": {
			const images = [...r.images, ...r.items.flatMap((i) => i.images)];
			return images.length ? withHeading({ images }) : undefined;
		}
		case "testimonials": {
			const items = r.items.map((i) => ({ quote: plainOf(i), ...(i.heading ? { name: i.heading } : {}), ...(firstText(i, /(role|position|job|company|title|location)/) ? { role: firstText(i, /(role|position|job|company|title|location)/) } : {}), ...(i.images[0] ? { photo: i.images[0] } : {}) })).filter((i) => i.quote);
			return items.length ? withHeading({ items }) : undefined;
		}
		case "team": {
			const members = r.items.map((i) => ({ name: i.heading ?? firstText(i) ?? "", ...(firstText(i, /(role|position|job)/) ? { role: firstText(i, /(role|position|job)/) } : {}), ...(i.images[0] ? { photo: i.images[0] } : {}), bio: leadAndBody(i, ctx), links: i.buttons })).filter((m) => m.name);
			return members.length ? withHeading({ intro: body, members }) : undefined;
		}
		case "stats": {
			const items = r.items.map((i) => {
				const value = firstText(i, /(value|number|stat|count|figure|amount|total)/) ?? i.texts[0]?.value ?? "";
				const label = i.heading ?? i.texts.find((t) => t.value !== value)?.value ?? i.plain;
				return { value, label };
			}).filter((i) => i.value && i.label);
			return items.length ? withHeading({ items }) : undefined;
		}
		case "logo_strip": {
			const logos = [...r.images.map((image) => ({ image })), ...r.items.flatMap((i) => (i.images[0] ? [{ image: i.images[0], ...(i.buttons[0] ? { href: i.buttons[0].href } : {}) }] : []))];
			return logos.length ? withHeading({ logos }) : undefined;
		}
		case "steps": {
			const items = r.items.map((i) => ({ title: i.heading ?? firstText(i) ?? "", body: leadAndBody(i, ctx) })).filter((i) => i.title);
			return items.length ? withHeading({ items }) : undefined;
		}
		case "feature_grid": {
			const items = r.items.map((i) => ({ ...(i.heading ? { title: i.heading } : {}), body: leadAndBody(i, ctx), ...(i.images[0] ? { image: i.images[0] } : {}), ...(i.buttons[0] ? { link: i.buttons[0] } : {}) })).filter((i) => i.title || i.body.length || i.image);
			return items.length ? withHeading({ intro: body, items, columns: items.length <= 4 ? items.length : 3 }) : undefined;
		}
		case "video":
			return r.video ? withHeading({ ...(r.video.embedUrl ? { embedUrl: r.video.embedUrl } : {}), ...(r.video.media ? { video: r.video.media } : {}), ...(r.lead ? { caption: r.lead } : {}) }) : undefined;
		case "map":
			return r.map?.address ? withHeading({ address: r.map.address }) : undefined;
		case "tabs": {
			const tabs = r.items.map((i) => ({ label: i.heading ?? firstText(i) ?? "", body: leadAndBody(i, ctx) })).filter((t) => t.label && t.body.length);
			return tabs.length ? withHeading({ tabs }) : undefined;
		}
		default:
			return undefined;
	}
}

/** Fallback when a layout's name says nothing (or its type cannot be filled): by what the row holds. */
function byShape(r: Roles): SectionType[] {
	const out: SectionType[] = [];
	if (r.video) out.push("video");
	if (r.items.length) out.push("feature_grid");
	if (r.images.length > 1 && !r.body.length) out.push("gallery");
	if (r.images.length) out.push("media_text");
	out.push("rich_text");
	return out;
}

/** What a row holds that the section type has no place for. */
function leftovers(type: SectionType, r: Roles): string[] {
	const uses = new Set(USES[type] ?? []);
	const out: string[] = [];
	if (r.heading && !uses.has("heading")) out.push("heading");
	if (r.lead && !uses.has("lead")) out.push("subheading");
	if (r.body.length && !uses.has("body")) out.push("text");
	if (r.images.length && !uses.has("images") && !uses.has("items")) out.push(`${r.images.length} image(s)`);
	if (type === "media_text" && r.images.length > 1) out.push(`${r.images.length - 1} more image(s)`);
	if (r.buttons.length && !uses.has("buttons")) out.push("link(s)");
	if (r.items.length && !uses.has("items")) out.push(`${r.items.length} repeater row(s)`);
	if (r.video && !uses.has("video")) out.push("video");
	if (r.map && !uses.has("map")) out.push("map");
	if (r.texts.length && !["stats", "testimonials", "team", "faq", "steps", "tabs"].includes(type)) out.push(...r.texts.map((t) => t.name));
	out.push(...r.other);
	return out;
}

const hash = (v: unknown) => createHash("sha1").update(JSON.stringify(v) ?? "").digest("hex").slice(0, 10);

/**
 * One flexible content field's rows → sections. `rows`: as `get_fields()` returns them or as `acfFromMeta` rebuilds
 * them (each with `acf_fc_layout`). `disabled`: rows hidden on the site (counted, not carried).
 */
export function flexibleSections(field: WpFieldDef, rowsIn: unknown, ctx: FlexContext, opts: { path: string; disabled?: number } = { path: "acf" }): FlexOutcome {
	const out: FlexOutcome = { sections: [], unmapped: [], layouts: [], diagnostics: [], disabled: opts.disabled ?? 0 };
	const layouts = new Map<string, WpLayout>((field.layouts ?? []).map((l) => [l.name, l]));
	const uses = new Map<string, LayoutUse & { types: Map<SectionType, number> }>();
	rowsOf(rowsIn).forEach((row, i) => {
		const name = text(row.acf_fc_layout);
		const layout = layouts.get(name);
		const use: LayoutUse & { types: Map<SectionType, number> } = uses.get(name) ?? { field: field.name, layout: name, label: layout?.label ?? name, rows: 0, by: "unmapped", notCarried: [], types: new Map() };
		uses.set(name, use);
		use.rows++;
		const path = `${opts.path}.${field.name}[${i}]`;
		const decision = ctx.decisions[name];
		if (decision === "skip") {
			use.by = "skip";
			out.diagnostics.push({ level: "info", code: "flagged", message: `ACF layout "${name}" not carried (overrides.ts acfLayouts: skip)`, path });
			return;
		}
		if (!layout) {
			out.unmapped.push(row);
			out.diagnostics.push({ level: "warn", code: "unmapped", message: `ACF flexible content row ${i + 1} uses layout "${name}", which no field definition describes: kept as data, not as a section`, path });
			return;
		}
		const r = roles(row, layout.subFields, ctx, [`${field.name}[${i}]`]);
		const named = decision ?? layoutType(layout.name, layout.label);
		const tries = [...(named ? [named] : []), ...(decision ? [] : byShape(r).filter((t) => t !== named))];
		let built: Section | undefined;
		for (const type of tries) {
			const fields = fieldsFor(type, r, ctx);
			if (!fields) continue;
			const parsed = sectionSchema.safeParse({ type, fields, sourceRef: { adapter: "acf", path, rawHash: hash(row) } });
			if (parsed.success) {
				built = parsed.data;
				break;
			}
		}
		if (!built) {
			out.unmapped.push(row);
			out.diagnostics.push({ level: "warn", code: "unmapped", message: `ACF layout "${name}" (row ${i + 1}): ${decision ? `cannot fill a ${decision} section from its values` : "no kit section matches what it holds"}; kept as data, not as a section`, path });
			return;
		}
		out.sections.push(built);
		use.by = decision ? "override" : "kit";
		use.types.set(built.type, (use.types.get(built.type) ?? 0) + 1);
		const lost = leftovers(built.type, r);
		for (const l of lost) if (!use.notCarried.includes(l)) use.notCarried.push(l);
		// Settings the section used (an image position → media side) are carried.
		const used = (s: { value: string }) => built?.type === "media_text" && /^(left|right|image_left|left_image|media_left|image_right|right_image|media_right)$/.test(s.value.toLowerCase());
		const settings = r.settings.filter((s) => !used(s)).map((s) => s.name).filter((s) => !use.notCarried.includes(`${s} (setting)`));
		use.notCarried.push(...settings.map((s) => `${s} (setting)`));
		if (lost.length) out.diagnostics.push({ level: "warn", code: "lossy", message: `ACF layout "${name}" → ${built.type}: not carried: ${lost.join(", ")}`, path });
	});
	// A layout with some rows built and some not stays "unmapped" only if no row was built.
	out.layouts = [...uses.values()].map(({ types, ...u }) => ({ ...u, ...(types.size ? { as: [...types].sort((a, b) => b[1] - a[1])[0]?.[0] } : {}) }));
	return out;
}
