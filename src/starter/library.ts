/**
 * The section library (PLAN §5) as EmDash block types — the single source of truth for
 * seed.json `blockTypes`, the starter's components and the IR → block mapping (targets/emdash).
 *
 * EmDash 1.5 constraints (verified in src/schema/block-types.ts, see docs/spikes/M5-findings.md):
 * - block fields: string, text, url, number, integer, boolean, datetime, select, multiSelect,
 *   portableText, image, file, repeater
 * - repeater sub-fields: string, text, url, number, integer, boolean, datetime, select, image —
 *   no portableText, no nested repeaters. Rich text inside repeater items (FAQ answers, bios, card
 *   bodies) is stored as `text` with a small Markdown subset (paragraphs, lists, **bold**, *em*,
 *   [links](/x)), rendered by the starter's `md.ts`.
 */

import { EMBED_PROVIDER_IDS } from "../providers/registry.js";

export type FieldType = "string" | "text" | "url" | "number" | "integer" | "boolean" | "select" | "portableText" | "image" | "file" | "repeater";
export interface SubField {
	slug: string;
	label: string;
	type: Exclude<FieldType, "portableText" | "file" | "repeater">;
	required?: boolean;
	description?: string;
	defaultValue?: unknown;
	validation?: Record<string, unknown>;
}
export interface Field extends Omit<SubField, "type"> {
	type: FieldType;
}
export interface BlockType {
	slug: string;
	label: string;
	description: string;
	category: string;
	currentVersion: number;
	versions: { version: number; fields: Field[] }[];
}

const MD = "Supports **bold**, *italic*, [links](/page/), blank lines between paragraphs and lines starting with “- ” for lists.";

/** Links: site paths, anchors, http(s), mailto, tel. Same rule as the marketing template. */
const LINK = { pattern: "^(?:$|(?:https?://|mailto:|tel:|/(?!/)|#).+)$" };
const PAD = { pattern: "^(?:$|\\d+(?:\\.\\d+)?px|clamp\\(\\d+(?:\\.\\d+)?px, -?\\d+(?:\\.\\d+)?px \\+ -?\\d+(?:\\.\\d+)?vw, \\d+(?:\\.\\d+)?px\\))$" };
const ANCHOR = { pattern: "^(?:$|[A-Za-z][A-Za-z0-9_-]*)$" };
const COLOUR = { pattern: "^(?:$|#[0-9a-fA-F]{3,8}|rgba?\\([^)]*\\)|var\\(--[a-z0-9-]+\\))$" };

const s = (slug: string, label: string, extra: Partial<Field> = {}): Field => ({ slug, label, type: "string", ...extra });
const t = (slug: string, label: string, extra: Partial<Field> = {}): Field => ({ slug, label, type: "text", ...extra });
const pt = (slug: string, label: string, extra: Partial<Field> = {}): Field => ({ slug, label, type: "portableText", ...extra });
const img = (slug: string, label: string, extra: Partial<Field> = {}): Field => ({ slug, label, type: "image", ...extra });
const bool = (slug: string, label: string, defaultValue = false): Field => ({ slug, label, type: "boolean", defaultValue });
const sel = (slug: string, label: string, options: string[], defaultValue?: string): Field => ({ slug, label, type: "select", validation: { options }, ...(defaultValue ? { defaultValue } : {}) });
const link = (slug: string, label: string): Field => s(slug, label, { validation: LINK });
/**
 * Repeater sub-fields in EmDash 1.5 accept only slug, label, type, required and (select) options —
 * no defaults, patterns or descriptions. Hints go into the label; link checks happen in the components.
 */
const rep = (slug: string, label: string, subFields: SubField[], minItems = 0, maxItems = 24): Field => ({
	slug,
	label,
	type: "repeater",
	validation: {
		subFields: subFields.map((f) => ({
			slug: f.slug,
			label: f.description === MD ? `${f.label} (Markdown)` : f.label,
			type: f.type,
			...(f.required ? { required: true } : {}),
			...(f.type === "select" && f.validation?.options ? { options: f.validation.options } : {}),
		})),
		minItems,
		maxItems,
	},
});


/** Column spacing: px or % of the column. */
const INSET = "^(?:$|\\d+(?:\\.\\d+)?(?:px|%))$";

/** Side padding of an edge-to-edge row: px, % of the row, or vw. */
const ROW_INSET = "^(?:$|\\d+(?:\\.\\d+)?(?:px|%|vw))$";

/** Buttons: label, link, style, new tab, or the popup they open. */
const buttons = (max = 3): Field =>
	rep("buttons", "Buttons", [
		{ slug: "label", label: "Label", type: "string", required: true },
		{ slug: "url", label: "Link", type: "string", validation: LINK },
		{ slug: "style", label: "Style", type: "select", validation: { options: ["primary", "secondary", "link"] }, defaultValue: "primary" },
		{ slug: "size", label: "Size", type: "select", validation: { options: ["normal", "large"] }, defaultValue: "normal" },
		{ slug: "text_size", label: "Text size (e.g. 14px; empty = default)", type: "string" },
		{ slug: "space_above", label: "Space above (e.g. 40px; empty = default)", type: "string" },
		{ slug: "side_space", label: "Side space for text links (e.g. 25px; empty = none)", type: "string" },
		{ slug: "hover_label", label: "Label shown on hover (optional)", type: "string" },
		{ slug: "light", label: "Light button (white background)", type: "boolean", defaultValue: false },
		{ slug: "plain", label: "Plain builder button (square, no border, body text)", type: "boolean", defaultValue: false },
		{ slug: "fill", label: "Own background colour (empty = style colour)", type: "string", validation: COLOUR },
		{ slug: "text_color", label: "Own text colour", type: "string", validation: COLOUR },
		{ slug: "radius", label: "Corner radius (px; empty = site default)", type: "number", validation: { min: 0, max: 200 } },
		{ slug: "padding", label: "Padding (e.g. 10px 30px)", type: "string", validation: { pattern: "^(?:$|\\d{1,2}px \\d{1,2}px)$" } },
		{ slug: "min_width", label: "Minimum width (e.g. 140px; empty = text width)", type: "string" },
		{ slug: "new_tab", label: "Open in new tab", type: "boolean", defaultValue: false },
		{ slug: "popup", label: "Opens popup (slug)", type: "string", description: "Leave empty for a normal link" },
	], 0, max);

/** Heading group: optional eyebrow line, heading text and its level. */
const heading = (defaultLevel = "h2"): Field[] => [s("eyebrow", "Eyebrow"), s("heading", "Heading"), sel("heading_level", "Heading level", ["h1", "h2", "h3", "h4", "h5", "h6"], defaultLevel)];

/** Appearance shared by every section (maps to IR `theme`, `spacing`, `fullHeight`, `anchorId`). */
const appearance: Field[] = [
	sel("tone", "Text colour", ["light", "dark"], "light"),
	s("bg_color", "Background colour", { validation: COLOUR, description: "Hex, rgb() or a theme token like var(--color-accent)" }),
	img("bg_image", "Background image"),
	{ slug: "bg_video", label: "Background video", type: "file", validation: { allowedMimeTypes: ["video/mp4", "video/webm"] } },
	{ slug: "bg_overlay", label: "Overlay strength (0–1)", type: "number", validation: { min: 0, max: 1 } },
	sel("bg_motion", "Background image motion", ["none", "parallax"], "none"),
	s("bg_gradient", "Background gradient", { validation: { pattern: "^(?:$|(?:linear|radial)-gradient\\([^;{}<>]*\\))$" }, description: "CSS linear-/radial-gradient over the colour" }),
	sel("spacing", "Spacing", ["none", "compact", "normal", "spacious"], "normal"),
	sel("layout_width", "Section width", ["contained", "full"], "contained"),
	sel("gap", "Space between columns", ["normal", "none"], "normal"),
	sel("valign", "Vertical position", ["top", "middle", "bottom"], "middle"),
	sel("phone_align", "Text on phones", ["as-desktop", "center"], "as-desktop"),
	sel("tablet_align", "Text on tablets", ["as-desktop", "center"], "as-desktop"),
	{ slug: "stack_gap", label: "Space between stacked columns (px; empty = theme default)", type: "number", validation: { min: 0, max: 200 } },
	s("row_inset", "Side padding, edge-to-edge rows (e.g. 8%)", { validation: { pattern: ROW_INSET } }),
	s("row_inset_tablet", "Side padding on tablets (empty = as desktop)", { validation: { pattern: ROW_INSET } }),
	s("row_inset_phone", "Side padding on phones (empty = as tablet)", { validation: { pattern: ROW_INSET } }),
	sel("quote_style", "Quotes", ["default", "centered"], "default"),
	s("heading_size", "Heading size on desktop (e.g. 4vw; empty = type scale)", { validation: { pattern: "^(?:$|\\d+(?:\\.\\d+)?(?:px|vw|rem|em))$" } }),
	{ slug: "heading_leading", label: "Heading line height (e.g. 0.9)", type: "number", validation: { min: 0.5, max: 3 } },
	s("heading_width", "Heading width, share of its column (e.g. 85%; empty = full)", { validation: { pattern: "^(?:$|\\d+(?:\\.\\d+)?%)$" } }),
	{ slug: "eyebrow_gap", label: "Space under the eyebrow (px; empty = default)", type: "number", validation: { min: 0, max: 100 } },
	sel("head_align", "Heading position", ["left", "center"], "left"),
	s("head_gap", "Space under the heading (e.g. 7% or 60px; empty = default)", { validation: { pattern: "^(?:$|\\d+(?:\\.\\d+)?(?:px|%|vw|rem))$" } }),
	s("pad_top", "Top padding (overrides spacing)", { validation: PAD, description: "e.g. 50px, or a clamp() from the migration" }),
	s("pad_bottom", "Bottom padding (overrides spacing)", { validation: PAD }),
	{ slug: "pad_top_tablet", label: "Top padding on tablets (px; empty = as above)", type: "number", validation: { min: 0, max: 600 } },
	{ slug: "pad_bottom_tablet", label: "Bottom padding on tablets (px; empty = as above)", type: "number", validation: { min: 0, max: 600 } },
	bool("full_height", "Full screen height"),
	s("min_height", "Minimum height (e.g. 90svh; empty = content height)", { validation: { pattern: "^(?:$|\\d+(?:\\.\\d+)?(?:vh|svh|dvh|px))$" } }),
	s("anchor_id", "Anchor id", { validation: ANCHOR, description: "For in-page links, e.g. pricing → /page/#pricing" }),
];

/** How a section's button group is laid out; added to every block that has buttons (empty = as before). */
const buttonLayout: Field[] = [
	sel("buttons_direction", "Buttons: direction (default = as the section designs it)", ["default", "row", "stacked"], "default"),
	sel("buttons_align", "Buttons: alignment (default = as the section's text)", ["default", "left", "center", "right", "spread"], "default"),
	sel("buttons_width", "Buttons: width (auto = fits the text; equal = as wide as the longest)", ["default", "auto", "equal", "full"], "default"),
	bool("buttons_stack_phone", "Buttons: stacked full width on phones"),
	s("buttons_gap", "Buttons: space between (e.g. 12px; empty = default)", { validation: { pattern: "^(?:$|\\d{1,3}(?:\\.\\d+)?(?:px|rem))$" } }),
];
const hasButtons = (fields: Field[]) => fields.some((f) => f.slug === "buttons" || /^col_\d_buttons$/.test(f.slug));

const block = (slug: string, label: string, description: string, variants: string[], fields: Field[]): BlockType => ({
	slug,
	label,
	description,
	category: "Sections",
	currentVersion: 1,
	// Block fields have no `description` in EmDash 1.5: it is documentation only here.
	versions: [{ version: 1, fields: [...(variants.length ? [sel("variant", "Layout", variants, variants[0])] : []), ...fields, ...(hasButtons(fields) ? buttonLayout : []), ...appearance].map(({ description: _d, ...f }) => f) }],
});

export const SECTION_BLOCK_PREFIX = "section_";
/** Block type of the announcement bar (site part slug "announcement"). */
export const ANNOUNCEMENT_BLOCK = "section_announcement";
/** ISO 8601 date or date-time (2026-12-01, 2026-12-01T09:00, …Z or ±hh:mm). */
const WHEN = { pattern: "^(?:$|\\d{4}-\\d{2}-\\d{2}(?:T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,3})?)?(?:Z|[+-]\\d{2}:\\d{2})?)?)$" };

const CSS_LENGTH = "^(?:$|\\d+(?:\\.\\d+)?(?:px|vh|svh|vw|rem|em|%))$";
/** px, or a fluid clamp between phone and desktop (measured builder spacing). */
const FLUID = "^(?:$|\\d+(?:\\.\\d+)?px|clamp\\(\\d+(?:\\.\\d+)?px, -?\\d+(?:\\.\\d+)?px \\+ -?\\d+(?:\\.\\d+)?vw, \\d+(?:\\.\\d+)?px\\))$";

export const BLOCK_TYPES: BlockType[] = [
	block("section_hero", "Hero", "Page introduction with heading, text, buttons and a background image or video", ["image", "video", "plain"], [...heading("h1"), pt("body", "Text"), buttons(), img("media", "Side image"), sel("align", "Alignment", ["center", "left", "right"], "center"), s("content_width", "Content width (e.g. 820px; empty = default)", { validation: { pattern: "^(?:$|\\d+(?:\\.\\d+)?px)$" } }), s("body_size", "Text size (e.g. 18px; empty = larger intro text)", { validation: { pattern: "^(?:$|\\d+(?:\\.\\d+)?px)$" } }), s("heading_size_phone", "Heading size on phones (e.g. 50px)", { validation: { pattern: "^(?:$|\\d+(?:\\.\\d+)?px)$" } }), { slug: "content_gap", label: "Space between heading, text and buttons (px; empty = default)", type: "integer", validation: { min: 0, max: 200 } }, s("buttons_above", "Space above the buttons (px or a fluid clamp; empty = default)", { validation: { pattern: FLUID } })]),
	block("section_rich_text", "Text", "Formatted text with optional buttons", ["default", "buttons"], [...heading(), pt("body", "Text"), sel("width", "Width", ["narrow", "normal", "wide"], "normal"), sel("align", "Alignment", ["left", "center"], "left"), buttons(), ...([["text_heading_size", "Size of headings in the text on desktop (e.g. 3vw; empty = site default)"], ["text_heading_size_tablet", "…on tablets"], ["text_heading_size_phone", "…on phones"], ["body_size", "Text size on desktop (e.g. 1.2vw)"], ["body_size_small", "Text size on tablets and phones"], ["body_width", "Text width (e.g. 90%)"]] as const).map(([slug, label]) => ({ slug, label, type: "string" as const, validation: { pattern: CSS_LENGTH } })), { slug: "text_heading_leading", label: "Line height of headings in the text (e.g. 1.4)", type: "number", validation: { min: 1, max: 3 } }, { slug: "body_leading", label: "Text line height (e.g. 1.8)", type: "number", validation: { min: 1, max: 3 } }, s("text_block_gap", "Space between every paragraph, heading and list (px or a fluid clamp; empty = default)", { validation: { pattern: FLUID } }), s("text_head_gap", "Space under the heading (px or a fluid clamp; empty = default)", { validation: { pattern: FLUID } }), bool("head_center", "Heading centred (the text keeps its alignment)"), s("text_head_row_gap", "Space between the headings and the text, % of the width (e.g. 7%)", { validation: { pattern: INSET } }), bool("text_scribble", "Emphasised words in headings upright (highlight style)")]),
	block("section_media_text", "Image and text", "Image (or two) beside text", ["inline", "cover", "stacked"], [...heading(), pt("body", "Text"), buttons(), img("media", "Image", { required: true }), img("media_2", "Second image"), sel("media_side", "Image side", ["left", "right"], "left"), sel("ratio", "Image width", ["1/3", "1/2", "2/3"], "1/2"), ...([["media_height", "Image height (e.g. 90vh; empty = image shape)"], ["media_height_small", "…on tablets and phones (e.g. 450px)"], ["media_height_phone", "…on phones only"], ["media_2_height", "Second image height"], ["media_2_height_small", "…on tablets and phones"], ["media_2_height_phone", "…on phones only"], ["media_radius", "Image corner rounding (e.g. 5px)"], ["heading_gap", "Space under the opening heading (e.g. 30px)"], ["text_inset", "Space before the text on desktop (e.g. 10vw)"], ["text_end", "Space after the text on desktop, % of the row (e.g. 4%)"], ["column_gap", "Space between image and text on desktop (e.g. 90px)"], ["text_top", "Space above the text on desktop (e.g. 10vh)"], ["stack_space", "Space under the image on tablets and phones (e.g. 8%)"], ["quote_gap", "Space above the centred quote (e.g. 4%)"], ["media_2_gap", "Space above the second image (e.g. 8%)"], ["body_size", "Text size on desktop (e.g. 1.05vw)"], ["body_size_small", "…on tablets and phones (e.g. 16px)"], ["quote_size", "Quote size on desktop (e.g. 1.45vw)"], ["quote_size_small", "…on tablets and phones (e.g. 22px)"], ["quote_width", "Quote width (e.g. 70%)"], ["body_end", "Space after the paragraphs, % of the text column (e.g. 10%)"], ["heading_pad", "Extra space under the opening heading, % of the text column (e.g. 1.5%)"]] as const).map(([slug, label]) => ({ slug, label, type: "string" as const, validation: { pattern: CSS_LENGTH } })), { slug: "body_leading", label: "Text line height (e.g. 1.6; empty = site default)", type: "number", validation: { min: 1, max: 3 } }, { slug: "inner_gutters", label: "Builder inner-row gutters (60px gap, widths as in the builder)", type: "boolean", defaultValue: false }, { slug: "text_parallax", label: "Text drifts on scroll (0 = off, 0.175 = gentle)", type: "number", validation: { min: 0, max: 1 } }, { slug: "media_parallax", label: "Image moves on scroll (0 = off, 0.2 = like the old site)", type: "number", validation: { min: 0, max: 1 } }]),
	block("section_columns", "Columns", "Two to four columns of text and images", [], [...heading(), ...[1, 2, 3, 4].flatMap((n) => [pt(`col_${n}_body`, `Column ${n} text`), img(`col_${n}_image`, `Column ${n} image`), { ...buttons(), slug: `col_${n}_buttons`, label: `Column ${n} buttons` }, img(`col_${n}_bg_image`, `Column ${n} background image`), s(`col_${n}_bg_color`, `Column ${n} background colour`, { validation: COLOUR }), sel(`col_${n}_width`, `Column ${n} width`, ["auto", "1/4", "1/3", "1/2", "2/3", "3/4"], "auto"), s(`col_${n}_image_circle`, `Column ${n} round image size (e.g. 320px; empty = normal image)`, { validation: { pattern: CSS_LENGTH } }), sel(`col_${n}_align`, `Column ${n} text`, ["left", "center", "right"], "left"), s(`col_${n}_inset_end`, `Column ${n} space after the text on desktop (e.g. 40%)`, { validation: { pattern: INSET } }), s(`col_${n}_inset_phone`, `Column ${n} side space on phones (e.g. 10%)`, { validation: { pattern: INSET } }), s(`col_${n}_leading`, `Column ${n} paragraph line height (e.g. 1.6; empty = site default)`, { validation: { pattern: "^(?:$|[1-2](?:\\.\\d{1,3})?|3)$" } }), s(`col_${n}_gap_stacked`, `Column ${n} space below once columns stack (e.g. 10%)`, { validation: { pattern: INSET } }), s(`col_${n}_gap_above_stacked`, `Column ${n} space above once columns stack (e.g. 10px)`, { validation: { pattern: INSET } }), s(`col_${n}_gap_phone`, `Column ${n} space below on phones (e.g. 40px)`, { validation: { pattern: INSET } }), s(`col_${n}_heading_gap`, `Column ${n} space under its first heading (e.g. 30px)`, { validation: { pattern: INSET } }), sel(`col_${n}_list`, `Column ${n} list style`, ["default", "dots"], "default"), s(`col_${n}_image_width`, `Column ${n} image width (e.g. 160px; empty = full column)`, { validation: { pattern: "^(?:$|\\d+(?:\\.\\d+)?px)$" } }), s(`col_${n}_image_height`, `Column ${n} image height (e.g. 480px; empty = image shape)`, { validation: { pattern: "^(?:$|\\d+(?:\\.\\d+)?px)$" } }), s(`col_${n}_image_height_phone`, `Column ${n} image height on phones`, { validation: { pattern: "^(?:$|\\d+(?:\\.\\d+)?px)$" } }), bool(`col_${n}_image_after`, `Column ${n} image after the text`), bool(`col_${n}_items_center`, `Column ${n} items centred (text keeps its alignment)`), { slug: `col_${n}_text_width`, label: `Column ${n} paragraph width (px; empty = full column)`, type: "integer" as const, validation: { min: 120, max: 2000 } }, { slug: `col_${n}_text_gap`, label: `Column ${n} space under a heading in a stack (px)`, type: "integer" as const, validation: { min: 0, max: 200 } }, { slug: `col_${n}_image_space`, label: `Column ${n} extra space under the image (px)`, type: "integer" as const, validation: { min: 0, max: 200 } }, { slug: `col_${n}_item_gap`, label: `Column ${n} space between its items (px; empty = default)`, type: "integer" as const, validation: { min: 0, max: 200 } }, { slug: `col_${n}_link_gap`, label: `Column ${n} lists of only links: a row with this gap (px; empty = a normal list)`, type: "integer" as const, validation: { min: 0, max: 100 } }, { slug: `col_${n}_link_size`, label: `Column ${n} link row text size (px)`, type: "integer" as const, validation: { min: 10, max: 40 } }, { slug: `col_${n}_text_size`, label: `Column ${n} text size (px; empty = default)`, type: "integer" as const, validation: { min: 10, max: 40 } }, s(`col_${n}_item_gap_fluid`, `Column ${n} space between its items per screen (px or fluid clamp; wins over the px value)`, { validation: { pattern: FLUID } }), { slug: `col_${n}_text_weight`, label: `Column ${n} text weight (e.g. 400; empty = default)`, type: "integer" as const, validation: { min: 100, max: 900 } }, { slug: `col_${n}_para_gap`, label: `Column ${n} space between paragraphs of one text in a stack (em)`, type: "number" as const, validation: { min: 0, max: 4 } }, { slug: `col_${n}_text_tracking`, label: `Column ${n} text letter spacing (px)`, type: "number" as const, validation: { min: 0, max: 5 } }, { slug: `col_${n}_text_leading`, label: `Column ${n} text line height (e.g. 1.4)`, type: "number" as const, validation: { min: 1, max: 3 } }, { slug: `col_${n}_link_weight`, label: `Column ${n} link row weight (e.g. 400)`, type: "integer" as const, validation: { min: 100, max: 900 } }, { slug: `col_${n}_link_tracking`, label: `Column ${n} link row letter spacing (px)`, type: "number" as const, validation: { min: 0, max: 5 } }, { slug: `col_${n}_link_leading`, label: `Column ${n} link row line height (e.g. 1.4)`, type: "number" as const, validation: { min: 1, max: 3 } }, bool(`col_${n}_social_icons`, `Column ${n} social links as round icons`), { slug: `col_${n}_icon_gap`, label: `Column ${n} space between social icons (px)`, type: "integer" as const, validation: { min: 0, max: 100 } }]), s("card_bg", "Columns in a rounded card: its background (empty = no card)", { validation: COLOUR }), { slug: "card_radius", label: "Card corner radius (px)", type: "number", validation: { min: 0, max: 100 } }, { slug: "card_pad", label: "Card padding (px)", type: "number", validation: { min: 0, max: 120 } }, { slug: "card_pad_phone", label: "Card padding on phones (px)", type: "number", validation: { min: 0, max: 120 } }, { slug: "card_text_width", label: "Card text width (px)", type: "integer", validation: { min: 120, max: 2000 } }]),
	block("section_feature_grid", "Feature grid", "Cards with image or icon, title, text and link", ["image-cards", "icons", "list"], [...heading(), pt("intro", "Intro"), { slug: "columns", label: "Columns", type: "integer", defaultValue: 3, validation: { min: 1, max: 6 } }, { slug: "card_bg", label: "Card background (e.g. #ffffff; empty = no card)", type: "string", validation: { pattern: "^(?:$|#[0-9a-fA-F]{3,8}|rgba?\\([\\d\\s.,%]+\\))$" } }, { slug: "card_radius", label: "Card corner rounding (e.g. 15px)", type: "string", validation: { pattern: CSS_LENGTH } }, sel("card_shadow", "Card shadow", ["none", "small", "medium", "large"], "none"), { slug: "card_padding", label: "Card padding, % of the row (e.g. 3)", type: "number", validation: { min: 0, max: 20 } }, sel("card_align", "Card content alignment", ["start", "center"], "start"), sel("title_level", "Card title style", ["h3", "h4", "h5", "h6"], "h3"), { slug: "card_space", label: "Image card space above and below text (e.g. 35vh)", type: "string", validation: { pattern: CSS_LENGTH } }, { slug: "card_space_phone", label: "…on phones (e.g. 150px)", type: "string", validation: { pattern: CSS_LENGTH } }, { slug: "card_inset", label: "Image card padding, % of the section width", type: "integer", validation: { min: 0, max: 20 } }, { slug: "card_inset_small", label: "…below 1000px (empty = same)", type: "integer", validation: { min: 0, max: 20 } }, { slug: "card_gap", label: "Image card extra space between the spacers and the text (px)", type: "integer", validation: { min: 0, max: 100 } }, { slug: "card_padding_phone", label: "Card padding on phones (e.g. 3vw; empty = as on desktop)", type: "string", validation: { pattern: CSS_LENGTH } }, { slug: "card_padding_tablet", label: "Card padding on tablets (e.g. 18px)", type: "string", validation: { pattern: CSS_LENGTH } }, rep("items", "Items", [
		{ slug: "title", label: "Title", type: "string" },
		{ slug: "body", label: "Text", type: "text", description: MD },
		{ slug: "image", label: "Image", type: "image" },
		{ slug: "overlay", label: "Image tint (CSS gradient or colour)", type: "string" },
		{ slug: "image_motion", label: "Image motion", type: "select", validation: { options: ["none", "parallax"] } },
		{ slug: "icon", label: "Icon", type: "string", description: "Icon name, e.g. ph:phone" },
		{ slug: "link_label", label: "Link label", type: "string" },
		{ slug: "link_url", label: "Link", type: "string", validation: LINK },
		{ slug: "link_new_tab", label: "Open in new tab", type: "boolean", defaultValue: false },
	], 1, 24)]),
	block("section_cta_banner", "Call to action", "Short message with buttons; marquee variant scrolls the heading", ["default", "marquee"], [...heading(), pt("body", "Text"), buttons(), img("media", "Image")]),
	block("section_faq", "FAQ", "Questions and answers (adds FAQPage structured data)", [], [...heading(), pt("intro", "Intro"), rep("items", "Questions", [
		{ slug: "question", label: "Question", type: "string", required: true },
		{ slug: "answer", label: "Answer", type: "text", required: true, description: MD },
	], 1, 60), bool("schema", "Add FAQPage structured data", true), sel("faq_style", "Look", ["lines", "card", "panel"], "lines"), s("faq_bg", "Panel background (look \"panel\")", { validation: COLOUR }), { slug: "faq_pad", label: "Panel: side padding of each question (px)", type: "number", validation: { min: 0, max: 120 } }, { slug: "faq_pad_phone", label: "Panel: side padding on phones (px)", type: "number", validation: { min: 0, max: 120 } }, s("faq_line", "Panel: divider colour", { validation: COLOUR }), bool("faq_exclusive", "Only one answer open at a time"), { slug: "card_radius", label: "Open card corner radius (e.g. 20px)", type: "string", validation: { pattern: CSS_LENGTH } }, bool("open_first", "Show the first answer open"), { slug: "list_inset", label: "Space at the sides of the list (e.g. 8%)", type: "string", validation: { pattern: CSS_LENGTH } }]),
	block("section_pricing", "Pricing", "Plans or price list", ["list", "cards", "rows"], [...heading(), pt("intro", "Intro"), { slug: "card_radius", label: "Corner radius (e.g. 5px)", type: "string", validation: { pattern: CSS_LENGTH } }, { slug: "list_inset", label: "Space at the sides of the list on desktop (e.g. 10%)", type: "string", validation: { pattern: CSS_LENGTH } }, { slug: "list_inset_small", label: "Space at the sides on tablets and phones", type: "string", validation: { pattern: CSS_LENGTH } }, rep("plans", "Plans", [
		{ slug: "name", label: "Name", type: "string", required: true },
		{ slug: "price", label: "Price", type: "string" },
		{ slug: "period", label: "Period", type: "string" },
		{ slug: "description", label: "Description", type: "text" },
		{ slug: "features", label: "Features (one per line)", type: "text" },
		{ slug: "button_label", label: "Button label", type: "string" },
		{ slug: "button_url", label: "Button link", type: "string", validation: LINK },
		{ slug: "button_new_tab", label: "Open in new tab", type: "boolean", defaultValue: false },
		{ slug: "highlight", label: "Highlight", type: "boolean", defaultValue: false },
	], 1, 30), buttons()]),
	block("section_testimonials", "Testimonials", "Quotes from clients", ["slider", "grid"], [...heading(), rep("items", "Testimonials", [
		{ slug: "quote", label: "Quote", type: "text", required: true },
		{ slug: "name", label: "Name", type: "string" },
		{ slug: "role", label: "Role / place", type: "string" },
		{ slug: "photo", label: "Photo", type: "image" },
		{ slug: "rating", label: "Stars (1–5)", type: "integer", validation: { min: 1, max: 5 } },
	], 1, 30)]),
	block("section_team", "Team", "People with photo, role and bio", ["grid", "list"], [...heading(), pt("intro", "Intro"), { slug: "columns", label: "Columns", type: "integer", defaultValue: 3, validation: { min: 1, max: 6 } }, { slug: "photo_height", label: "Photo height (e.g. 500px; empty = 3:4)", type: "string", validation: { pattern: CSS_LENGTH } }, { slug: "name_size", label: "Name size (e.g. 38px)", type: "string", validation: { pattern: CSS_LENGTH } }, { slug: "card_gap", label: "Gap between people (e.g. 80px)", type: "string", validation: { pattern: CSS_LENGTH } }, rep("members", "People", [
		{ slug: "name", label: "Name", type: "string", required: true },
		{ slug: "role", label: "Role", type: "string" },
		{ slug: "photo", label: "Photo", type: "image" },
		{ slug: "summary", label: "Short bio", type: "text" },
		{ slug: "bio", label: "Full bio", type: "text", description: MD },
		{ slug: "link_url", label: "Profile link", type: "string", validation: LINK },
	], 1, 40)]),
	block("section_gallery", "Gallery", "Images as a grid, masonry, carousel or stack", ["grid", "masonry", "carousel", "stack"], [...heading(), rep("images", "Images", [
		{ slug: "image", label: "Image", type: "image", required: true },
		{ slug: "caption", label: "Caption", type: "string" },
	], 1, 60), bool("lightbox", "Open images larger on click", true)]),
	block("section_logo_strip", "Logos", "Row of client or partner logos", [], [...heading(), rep("logos", "Logos", [
		{ slug: "image", label: "Logo", type: "image", required: true },
		{ slug: "url", label: "Link", type: "string", validation: LINK },
	], 1, 30)]),
	block("section_stats", "Numbers", "Key figures", [], [...heading(), rep("items", "Figures", [
		{ slug: "value", label: "Value", type: "string", required: true },
		{ slug: "label", label: "Label", type: "string", required: true },
		{ slug: "prefix", label: "Prefix", type: "string" },
		{ slug: "suffix", label: "Suffix", type: "string" },
	], 1, 12)]),
	block("section_steps", "Steps", "A numbered process", [], [...heading(), rep("items", "Steps", [
		{ slug: "title", label: "Title", type: "string", required: true },
		{ slug: "body", label: "Text", type: "text", description: MD },
		{ slug: "icon", label: "Icon", type: "string" },
	], 1, 12)]),
	block("section_tabs", "Tabs", "Content in tabs", [], [...heading(), rep("tabs", "Tabs", [
		{ slug: "label", label: "Tab label", type: "string", required: true },
		{ slug: "body", label: "Content", type: "text", required: true, description: MD },
	], 1, 12)]),
	block("section_video", "Video", "Uploaded video or YouTube/Vimeo embed", [], [...heading(), { slug: "video", label: "Video file", type: "file", validation: { allowedMimeTypes: ["video/mp4", "video/webm"] } }, s("embed_url", "YouTube / Vimeo link", { validation: { pattern: "^(?:$|https://.+)$" } }), img("poster", "Poster image"), s("caption", "Caption")]),
	block("section_audio", "Audio", "Audio player for an uploaded file (podcast, recording, music)", [], [...heading(), { slug: "audio", label: "Audio file", type: "file", required: true, validation: { allowedMimeTypes: ["audio/mpeg", "audio/mp4", "audio/aac", "audio/wav", "audio/ogg", "audio/webm", "audio/flac"] } }, s("caption", "Caption"), bool("autoplay", "Start playing on its own (most browsers only allow it muted)"), bool("loop", "Play again from the start when it ends")]),
	block("section_posts_list", "Latest posts", "The newest blog posts, updated on its own when a post is published", [], [...heading(), { slug: "count", label: "How many posts", type: "integer", defaultValue: 5, validation: { min: 1, max: 50 } }, s("categories", "Only these categories (slugs, comma-separated; empty = all)", { validation: { pattern: "^(?:$|[a-z0-9_%-]+(?:\\s*,\\s*[a-z0-9_%-]+)*)$" } }), bool("show_image", "Show the featured image", true), bool("show_date", "Show the date", true), bool("show_author", "Show the author"), bool("show_excerpt", "Show the excerpt", true), { slug: "columns", label: "Posts per row (empty = as many as fit)", type: "integer", validation: { min: 1, max: 6 } }]),
	block("section_form", "Form","Contact form with optional text beside it", [], [...heading(), pt("intro", "Intro"), s("form_id", "Form", { required: true, description: "Form definition id (src/forms/<id>.json)" }), pt("aside", "Text beside the form"), bool("stacked", "Form under the heading (not beside it)"), { slug: "form_width", label: "Form width when stacked (px; empty = full width)", type: "integer", validation: { min: 200, max: 2000 } }, s("form_gap", "Space between heading and form when stacked (px or fluid clamp)", { validation: { pattern: FLUID } })]),
	block("section_map", "Map", "Google Maps embed or address", [], [...heading(), s("embed_url", "Map embed link", { validation: { pattern: "^(?:$|https://.+)$" } }), s("address", "Address"), s("height", "Height", { defaultValue: "420px" })]),
	block("section_embed", "Embed", "Booking or third-party widget from an approved provider", [], [...heading(), sel("provider", "Provider", EMBED_PROVIDER_IDS), t("html", "Embed code", { required: true, description: "Only scripts/iframes from the selected provider are rendered" }), s("height", "Minimum height")]),
	block("section_legacy_html", "Legacy HTML", "Raw HTML carried over from WordPress — replace with a proper section", [], [t("html", "HTML", { required: true }), s("reason", "Why it is here")]),
	announcementBlock(),
];

/**
 * The bar above the header on every page. Lives in the site part "announcement" (Header & footer), not in page
 * content: no appearance fields, its own colours (the starter raises a text colour that fails WCAG AA).
 */
function announcementBlock(): BlockType {
	const fields: Field[] = [
		bool("enabled", "Show the bar", true),
		pt("message", "Message", { required: true }),
		rep("buttons", "Buttons (up to two)", [
			{ slug: "label", label: "Label", type: "string", required: true },
			{ slug: "url", label: "Link", type: "string" },
			{ slug: "style", label: "Style", type: "select", validation: { options: ["primary", "secondary"] } },
			{ slug: "new_tab", label: "Open in new tab", type: "boolean" },
		], 0, 2),
		s("bg_color", "Background colour (empty = accent colour)", { validation: COLOUR }),
		s("text_color", "Text colour (changed automatically when too faint on the background)", { validation: COLOUR }),
		s("button_bg", "Button colour (empty = text colour)", { validation: COLOUR }),
		s("button_color", "Button text colour (empty = background colour)", { validation: COLOUR }),
		bool("dismissible", "Visitors can close it (it comes back when the message changes)", true),
		bool("sticky", "Stays at the top while the page scrolls"),
		s("starts_at", "Show from (e.g. 2026-12-01T09:00:00Z; empty = now)", { validation: WHEN }),
		s("ends_at", "Hide after (empty = no end)", { validation: WHEN }),
	];
	return { slug: ANNOUNCEMENT_BLOCK, label: "Announcement bar", description: "Thin bar above the header on every page, edited in Header & footer → announcement", category: "Site parts", currentVersion: 1, versions: [{ version: 1, fields: fields.map(({ description: _d, ...f }) => f) }] };
}

export const SECTION_SLUGS = BLOCK_TYPES.map((b) => b.slug);
