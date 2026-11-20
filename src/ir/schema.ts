/**
 * Section IR v1 — the contract between builder adapters (transform) and targets (scaffold/load).
 * Every adapter emits it; every target consumes it. Validated with zod before it is written.
 * Field names here are the EmDash blockType field names the starter defines (M5).
 */
import { z } from "zod";

export const IR_VERSION = 1;

// ── Portable Text (subset EmDash renders) ─────────────────────────────────────
export const ptSpan = z.object({
	_type: z.literal("span"),
	_key: z.string(),
	text: z.string(),
	marks: z.array(z.string()).default([]),
});
export const ptLinkDef = z.object({
	_type: z.literal("link"),
	_key: z.string(),
	href: z.string(),
	blank: z.boolean().optional(),
});
export const ptBlock = z.object({
	_type: z.literal("block"),
	_key: z.string(),
	style: z.enum(["normal", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "lead", "small"]).default("normal"),
	listItem: z.enum(["bullet", "number"]).optional(),
	level: z.number().int().min(1).optional(),
	children: z.array(ptSpan),
	markDefs: z.array(ptLinkDef).default([]),
});
export type PtSpan = z.infer<typeof ptSpan>;
export type PtBlock = z.infer<typeof ptBlock>;
export type PtLinkDef = z.infer<typeof ptLinkDef>;
export const richText = z.array(ptBlock);
export type RichText = z.infer<typeof richText>;

// ── Shared field types ───────────────────────────────────────────────────────
/** Media is referenced by source; load resolves it to an EmDash media id (sha1 match or upload). */
export const mediaRef = z
	.object({
		wpId: z.number().int().positive().optional(),
		url: z.string().optional(),
		alt: z.string().optional(),
		kind: z.enum(["image", "video", "file"]).default("image"),
	})
	.refine((m) => m.wpId !== undefined || !!m.url, "media needs wpId or url");
export type MediaRef = z.infer<typeof mediaRef>;

export const button = z.object({
	label: z.string(),
	href: z.string(),
	style: z.enum(["primary", "secondary", "link"]).default("primary"),
	newTab: z.boolean().optional(),
	/** Opens a site popup/dialog instead of navigating (Popup Maker, Salient modal…). */
	opensPopup: z.string().optional(),
	/** Larger padding and more space above (Salient call-to-action with its own padding). */
	size: z.literal("large").optional(),
	/** The button's own text size (px), when the source's button size sets one (Salient nectar_btn large: 14px). */
	textSize: z.number().int().min(10).max(32).optional(),
	/** Space above the button (px), when the source sets its own. */
	spaceAbove: z.number().int().min(0).max(200).optional(),
	/** Light button: white background, accent text (Bricks button style "light"). */
	light: z.boolean().optional(),
	/** The builder's default button (Bricks `.bricks-button`, no framework class): square, no border, body text, padding 0.5em 1em, 0.5px tracking. */
	plain: z.boolean().optional(),
	/** The button's minimum width (px), when the source sets one. */
	minWidth: z.number().int().min(40).max(600).optional(),
	/** A second label the button swaps to on hover / keyboard focus (NextBricks ripple buttons, swap effects). */
	hoverLabel: z.string().max(80).optional(),
	/** The button's own colours, corners and padding (px), when the builder element sets them (NextBricks ripple buttons). */
	look: z.object({ bg: z.string().regex(/^(?:#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i).optional(), color: z.string().regex(/^(?:#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i).optional(), radius: z.number().min(0).max(200).optional(), padY: z.number().min(0).max(60).optional(), padX: z.number().min(0).max(80).optional() }).optional(),
	/** Space on each side of a text link (px), when the source pads it (Salient nectar_cta padding_left/right). */
	inset: z.number().int().min(0).max(80).optional(),
});
export type Button = z.infer<typeof button>;

export const icon = z.object({ library: z.string(), name: z.string() });

export const background = z.object({
	color: z.string().optional(),
	image: mediaRef.optional(),
	video: mediaRef.optional(),
	/** 0–1 overlay strength over image/video. */
	overlay: z.number().min(0).max(1).optional(),
	/** CSS linear-/radial-gradient layered over the colour (WPBakery/Salient "advanced gradient"). */
	gradient: z.string().regex(/^(?:linear|radial)-gradient\([^;{}<>]*\)$/).optional(),
	/** The image moves with scroll on the source (parallax). */
	motion: z.enum(["parallax"]).optional(),
});

export const sectionTheme = z.object({
	/** Text colour scheme: light = dark text on light background; dark = light text on dark/image background. */
	tone: z.enum(["light", "dark"]).default("light"),
	background: background.optional(),
});

export const sourceRef = z.object({
	/**
	 * html = rebuilt from the live page HTML (audit snapshot), e.g. a plugin's announcement bar; dom-fallback = a page of
	 * a builder without an adapter, rebuilt from its rendered HTML (src/adapters/dom-fallback).
	 */
	adapter: z.enum(["wpbakery", "gutenberg", "classic", "bricks", "elementor", "divi", "html", "dom-fallback"]),
	/** Path inside the source tree, e.g. `vc_row[2]` or `blocks[4]`. */
	path: z.string(),
	/** Short hash of the raw source of this section, to detect changes in the cutover delta. */
	rawHash: z.string(),
	/**
	 * Position of the source's top-level element on the rendered page (0 = first child of the content area), when the
	 * path does not carry it (Bricks: `section#abc123`). Verify pairs the section with the live page's box by it.
	 */
	row: z.number().int().nonnegative().optional(),
});

const base = {
	variant: z.string().optional(),
	theme: sectionTheme.default({ tone: "light" }),
	spacing: z.enum(["none", "compact", "normal", "spacious"]).default("normal"),
	fullHeight: z.boolean().optional(),
	anchorId: z.string().optional(),
	/** The section's own minimum height (Bricks `_heightMin: 90svh`), when it is not a full screen. */
	minHeight: z.string().regex(/^\d+(?:\.\d+)?(?:vh|svh|dvh|px)$/).optional(),
	/** full = edge to edge (WPBakery "full width content", Gutenberg align full); default contained. */
	width: z.enum(["contained", "full"]).optional(),
	/** Space between columns; none = columns touch (WPBakery column_margin="none"). */
	gap: z.enum(["none", "normal"]).optional(),
	/** Vertical placement of content in a tall section (WPBakery full_screen_row_position). */
	valign: z.enum(["top", "middle", "bottom"]).optional(),
	/** Centre text on phones (WPBakery/Salient phone_text_alignment). */
	phoneAlign: z.enum(["center"]).optional(),
	/** Space between columns once they stack (px). Salient: none for default/none column margins, 25px for a set margin. */
	stackGap: z.number().int().min(0).max(200).optional(),
	/** Centre text on tablets too (Salient tablet_text_alignment). */
	tabletAlign: z.enum(["center"]).optional(),
	/** Side padding of an edge-to-edge row (Salient left/right_padding_*): desktop value, overridden on tablet and phone. */
	inset: z.object({ desktop: z.string().regex(/^\d+(?:\.\d+)?(?:px|%|vw)$/), tablet: z.string().regex(/^\d+(?:\.\d+)?(?:px|%|vw)$/).optional(), phone: z.string().regex(/^\d+(?:\.\d+)?(?:px|%|vw)$/).optional() }).optional(),
	/** Quotes in the text: centred display italic under a short rule (Salient italic line set centred). */
	quoteStyle: z.enum(["centered"]).optional(),
	/** The heading's own size on desktop (builder override of the type scale), and its line height. */
	headingSize: z.string().regex(/^\d+(?:\.\d+)?(?:px|vw|rem|em)$/).optional(),
	headingLeading: z.number().min(0.5).max(3).optional(),
	/** The heading's measure, a share of its column (Salient split heading max_width). */
	headingWidth: z.string().regex(/^\d+(?:\.\d+)?%$/).optional(),
	/** Space under the eyebrow, px (the inner-row padding under it in the builder). */
	eyebrowGap: z.number().min(0).max(100).optional(),
	/** The section heading centred over left-aligned content, and the space under it (% = of the content width, as builder padding). */
	headAlign: z.enum(["center"]).optional(),
	headGap: z.string().regex(/^\d+(?:\.\d+)?(?:px|%|vw|rem)$/).optional(),
	/** A builder spacer (px) above the row's first content; added to the measured top padding. */
	spaceBefore: z.number().int().min(0).max(400).optional(),
	/** The button group: every button as wide as the longest (`equal`; stacked on phones, as the source does). */
	buttonsWidth: z.enum(["auto", "equal", "full"]).optional(),
	/** Its top padding is the source box's own gap to the section before it (one builder row split in two): kept as set. */
	innerGap: z.boolean().optional(),
	/** Padding measured on the source page (px, or fluid clamp between phone and desktop); wins over spacing. */
	pad: z.object({ top: z.string().regex(/^(?:\d+(?:\.\d+)?px|clamp\(\d+(?:\.\d+)?px, -?\d+(?:\.\d+)?px \+ -?\d+(?:\.\d+)?vw, \d+(?:\.\d+)?px\))$/).optional(), bottom: z.string().regex(/^(?:\d+(?:\.\d+)?px|clamp\(\d+(?:\.\d+)?px, -?\d+(?:\.\d+)?px \+ -?\d+(?:\.\d+)?vw, \d+(?:\.\d+)?px\))$/).optional(), /** Tablet (691–999px) value where the source's tablet padding is off the phone→desktop line. */ topTablet: z.number().min(0).max(600).optional(), bottomTablet: z.number().min(0).max(600).optional() }).optional(),
	sourceRef,
};

const heading = richText.optional();

// ── Section library (PLAN §5) ────────────────────────────────────────────────
/** px, or a fluid value between the phone and desktop measurements (scaffold `fluid()`). */
const fluidLength = z.string().regex(/^(?:\d+(?:\.\d+)?px|clamp\(\d+(?:\.\d+)?px, -?\d+(?:\.\d+)?px \+ -?\d+(?:\.\d+)?vw, \d+(?:\.\d+)?px\))$/);
const column = z.object({
	width: z.string().optional(),
	body: richText.default([]),
	media: z.array(mediaRef).default([]),
	buttons: z.array(button).default([]),
	background: background.optional(),
	/** The image drawn as a circle of this diameter. */
	imageCircle: z.string().regex(/^\d+(?:\.\d+)?(?:px|rem|vw)$/).optional(),
	align: z.enum(["center", "right"]).optional(),
	/** Line height of the column's paragraphs, when the source sets one for them. */
	leading: z.number().min(1).max(3).optional(),
	/** Space under a heading that sits alone above the column's text (px). */
	headingGap: z.number().min(0).max(200).optional(),
	/** Lists drawn with small dots and a 30px indent (Salient fancy-ul). */
	list: z.enum(["dots"]).optional(),
	/** Space below the column once columns stack (tablets and phones; % of the column or px). */
	gapStacked: z.string().regex(/^\d+(?:\.\d+)?(?:%|px)$/).optional(),
	/** Space above the column once columns stack (tablets and phones; % of the column or px). */
	gapAboveStacked: z.string().regex(/^\d+(?:\.\d+)?(?:%|px)$/).optional(),
	/** Space below the column once stacked on phones (px). */
	gapPhone: z.number().int().min(0).max(400).optional(),
	/** Text kept short on desktop by space on its trailing side (% of the column or px). */
	insetEnd: z.string().regex(/^\d+(?:\.\d+)?(?:%|px)$/).optional(),
	/** Side space around the text on phones. */
	insetPhone: z.string().regex(/^\d+(?:\.\d+)?(?:%|px)$/).optional(),
	/** The column's picture at most this wide (a logo in a stacked footer), centred when the column is. */
	imageWidth: z.string().regex(/^\d+(?:\.\d+)?px$/).optional(),
	/** That picture's fixed height (px; cropped to fill), desktop and phones; and whether it comes after the text. */
	imageHeight: z.string().regex(/^\d+(?:\.\d+)?px$/).optional(),
	imageHeightPhone: z.string().regex(/^\d+(?:\.\d+)?px$/).optional(),
	imageAfter: z.boolean().optional(),
	/** The paragraphs' measure (px) and the space between grouped texts (px; a heading and its description). */
	textWidth: z.number().int().min(120).max(2000).optional(),
	textGap: z.number().int().min(0).max(200).optional(),
	/** Items centred as boxes in the column (builder align-items: center); long text keeps its own alignment. */
	itemsCenter: z.boolean().optional(),
	/** Extra space under that picture (px): its own bottom margin in the builder. */
	imageSpace: z.number().int().min(0).max(200).optional(),
	/** Space between the column's items (picture, each paragraph, buttons), px: a builder flex stack's row gap. */
	itemGap: z.number().int().min(0).max(200).optional(),
	/** …per screen, when measured on the live page (fluid between phone and desktop); wins over itemGap. */
	itemGapFluid: fluidLength.optional(),
	/** A list made only of links is a row of links this far apart (px), without bullets or underlines (builder link rows). */
	linkGap: z.number().int().min(0).max(100).optional(),
	/** Text size of those link rows, and of the column's other text (px), when the builder sets one. */
	linkSize: z.number().int().min(10).max(40).optional(),
	textSize: z.number().int().min(10).max(40).optional(),
	/** The column's text weight, when the builder text element sets its own (Bricks `_typography` font-weight). */
	textWeight: z.number().int().min(100).max(900).optional(),
	/** …and its letter spacing (px) and line height; the same three for the column's link rows. */
	textTracking: z.number().min(0).max(5).optional(),
	textLeading: z.number().min(1).max(3).optional(),
	linkWeight: z.number().int().min(100).max(900).optional(),
	linkTracking: z.number().min(0).max(5).optional(),
	linkLeading: z.number().min(1).max(3).optional(),
	/** Space between the paragraphs of one text element inside a stack (em; the stack's item gap is between elements). */
	paraGap: z.number().min(0).max(4).optional(),
	/** Links to social networks in a link row are drawn as round icons this far apart (px; the source placed icon links). */
	socialIcons: z.number().int().min(0).max(100).optional(),
});
export type Column = z.infer<typeof column>;

/** CSS length a builder spacer used (35vh, 150px, 4rem…). */
const cssLength = z.string().regex(/^\d+(?:\.\d+)?(?:px|vh|svh|vw|rem|em|%)$/);
const cssGradient = z.string().regex(/^(?:(?:linear|radial)-gradient\([^;{}<>]*\)|rgba?\([\d\s.,%]+\)|#[0-9a-f]{3,8})$/i);

const featureItem = z.object({
	title: z.string().optional(),
	/** Tint over an image card (Salient column overlay, strength folded into the colours). */
	overlay: cssGradient.optional(),
	/** The card image moves with scroll on the source (parallax). */
	imageMotion: z.enum(["parallax"]).optional(),
	body: richText.default([]),
	image: mediaRef.optional(),
	icon: icon.optional(),
	link: button.optional(),
});

/** #rrggbb: the bar's colours are contrast-checked, so they are kept as plain hex. */
const hexColour = z.string().regex(/^#[0-9a-f]{6}$/i);
export const announcementFields = z.object({
	/** Message with inline formatting and links. */
	message: richText.min(1),
	buttons: z.array(button).max(2).default([]),
	colors: z.object({ background: hexColour.optional(), text: hexColour.optional(), buttonBackground: hexColour.optional(), buttonText: hexColour.optional() }).default({}),
	/** Visitors can close it (remembered per message version). */
	dismissible: z.boolean().default(true),
	/** Stays at the top while the page scrolls. */
	sticky: z.boolean().default(false),
	enabled: z.boolean().default(true),
	/** Shown only between these instants (ISO 8601), when the source schedules it. */
	schedule: z.object({ from: z.string().optional(), to: z.string().optional() }).optional(),
	/** Where it was found on the live site (report only; not stored in EmDash). */
	detected: z
		.object({
			plugin: z.enum(["announcer", "wpfront", "salient", "astra", "generic"]),
			selector: z.string(),
			pages: z.number().int().min(0),
			of: z.number().int().min(0),
			position: z.enum(["top", "bottom"]).default("top"),
			/** The source shows the bar again after a visitor closed it (Announcer keep_closed=no). */
			reshowsAfterClose: z.boolean().optional(),
			/** Colours as the source had them, when they were changed to meet WCAG AA. */
			sourceColors: z.record(z.string(), z.string()).optional(),
		})
		.optional(),
});
export type AnnouncementFields = z.infer<typeof announcementFields>;

export const section = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("hero"),
		...base,
		fields: z.object({
			heading,
			body: richText.default([]),
			buttons: z.array(button).default([]),
			media: mediaRef.optional(),
			align: z.enum(["left", "center", "right"]).default("center"),
			/** Builder look (Bricks): the content's width, the text size, the heading size on phones, the space between items. */
			look: z.object({ width: z.string().regex(/^\d+(?:\.\d+)?px$/).optional(), bodySize: z.string().regex(/^\d+(?:\.\d+)?px$/).optional(), headingSizePhone: z.string().regex(/^\d+(?:\.\d+)?px$/).optional(), gap: z.number().int().min(0).max(200).optional(), buttonsGap: z.number().int().min(0).max(100).optional(), /** Space above the buttons per screen (Bricks: the outer box's row gap). */ buttonsAbove: fluidLength.optional() }).optional(),
		}),
	}),
	z.object({
		type: z.literal("rich_text"),
		...base,
		fields: z.object({
			body: richText,
			width: z.enum(["narrow", "normal", "wide"]).default("normal"),
			align: z.enum(["left", "center"]).default("left"),
			buttons: z.array(button).default([]),
			/** Type sizes the builder set on this text (Salient highlighted text / paragraph line): per breakpoint. */
			look: z
				.object({
					headingSize: cssLength.optional(),
					headingSizeTablet: cssLength.optional(),
					headingSizePhone: cssLength.optional(),
					headingLeading: z.number().min(1).max(3).optional(),
					bodySize: cssLength.optional(),
					bodySizeSmall: cssLength.optional(),
					bodyLeading: z.number().min(1).max(3).optional(),
					bodyWidth: z.string().regex(/^\d{2,3}%$/).optional(),
					/** Salient: the inner row holding the highlighted headings, its bottom padding (% of the content width) above the text. */
					headRowGap: z.string().regex(/^\d+(?:\.\d+)?%$/).optional(),
					/** Salient highlighted text with the scribble style: emphasised words upright, the scribble under them. */
					scribble: z.boolean().optional(),
					/** Bricks: every block of the text is an item of the builder box, this far apart (its row gap); the heading on its own above, centred and this far from the text. */
					blockGap: fluidLength.optional(),
					headGap: fluidLength.optional(),
					headCenter: z.boolean().optional(),
				})
				.optional(),
		}),
	}),
	z.object({ type: z.literal("media_text"), ...base, fields: z.object({
			media: z.array(mediaRef).min(1),
			body: richText.default([]),
			buttons: z.array(button).default([]),
			mediaSide: z.enum(["left", "right"]),
			ratio: z.string().default("1/2"),
			/** Fixed picture heights (builder spacers), per image: desktop and below the stacking breakpoint. */
			mediaHeight: z.array(z.object({ desktop: cssLength, small: cssLength.optional(), phone: cssLength.optional() }).nullable()).max(2).optional(),
			/** The first picture moves with scroll inside its box: offset = this × scroll (Salient column parallax_bg). */
			mediaParallax: z.number().min(0).max(1).optional(),
			/** Rounded corners of the first picture's box. */
			mediaRadius: cssLength.optional(),
			/** Space under the text's opening heading, px (the source set it on the heading's own block). */
			headingGap: z.number().min(0).max(200).optional(),
			/** Space before the text column on desktop (Salient column padding). */
			textInset: cssLength.optional(),
			/** Space after the text column on desktop, % of the row (Salient right column padding, e.g. 4%). */
			textEnd: z.string().regex(/^\d+(?:\.\d+)?(?:%|vw)$/).optional(),
			/** Columns of a default-margin Salient inner row: 30px gutters, widths from the row widened by 60px. */
			innerGutters: z.boolean().optional(),
			/** Space between the image and the text on desktop (the builder row's column margin, px). */
			columnGap: z.string().regex(/^\d{1,3}px$/).optional(),
			/** Space above the text on desktop (Salient inner-row top padding reset to 0 below desktop). */
			textTop: cssLength.optional(),
			/** The text column drifts with scroll: offset = this × (column centre − viewport centre) (Salient column parallax). */
			textParallax: z.number().min(0).max(1).optional(),
			/** Space under the first picture once the columns stack (% of the column width, or px). */
			stackSpace: cssLength.optional(),
			/** Space above a centred quote and above the second picture (% of the text column width, or px). */
			quoteGap: cssLength.optional(),
			media2Gap: cssLength.optional(),
			/** Paragraph size on desktop and below it, and its line height (the builder set them on the paragraph). */
			bodySize: cssLength.optional(),
			bodySizeSmall: cssLength.optional(),
			bodyLeading: z.number().min(1).max(3).optional(),
			/** Centred quote size on desktop and below it, and its width (share of the column). */
			quoteSize: cssLength.optional(),
			quoteSizeSmall: cssLength.optional(),
			quoteWidth: cssLength.optional(),
			/** Space after the paragraphs (the builder text blocks' own right padding), % of the text column. */
			bodyEnd: z.string().regex(/^\d+(?:\.\d+)?%$/).optional(),
			/** Space inside the opening heading's text block under it (builder design options), % of the text column. */
			headingPad: z.string().regex(/^\d+(?:\.\d+)?%$/).optional(),
		}),
	}),
	z.object({ type: z.literal("columns"), ...base, fields: z.object({ heading, columns: z.array(column).min(1).max(6), /** The columns sit in a rounded card (a builder call-to-action panel): text left (at most textWidth px), buttons right, stacked on phones. */ card: z.object({ bg: z.string().regex(/^(?:#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i), radius: z.number().min(0).max(100).optional(), pad: z.number().min(0).max(120).optional(), padPhone: z.number().min(0).max(120).optional(), textWidth: z.number().int().min(120).max(2000).optional() }).optional() }) }),
	z.object({
		type: z.literal("feature_grid"),
		...base,
		fields: z.object({
			heading,
			intro: richText.default([]),
			items: z.array(featureItem).min(1),
			columns: z.number().int().min(1).max(6),
			/** Space above and below each card's text (builder spacers around it), per screen. */
			cardSpace: z
				.object({
					desktop: cssLength,
					phone: cssLength.optional(),
					/** Card padding, % of the row width (Salient column_padding). */
					inset: z.number().min(0).max(20).optional(),
					/** …below 1000px, % of the row width (the theme's own value there). */
					insetSmall: z.number().min(0).max(20).optional(),
					/** Builder element spacing under the top spacer and under the text, px. */
					gap: z.number().min(0).max(100).optional(),
				})
				.optional(),
			/** Boxed cards from the builder's column look (background, radius, shadow, padding % of the row), alignment, title level. */
			look: z
				.object({
					cardBackground: z.string().regex(/^#[0-9a-f]{3,8}$|^rgba?\([\d\s.,%]+\)$/i).optional(),
					cardRadius: cssLength.optional(),
					cardShadow: z.enum(["small", "medium", "large"]).optional(),
					cardPadding: z.number().min(0).max(20).optional(),
					/** Card padding on phones (≤690px) and tablets (691–999px), CSS lengths (the theme's own values there). */
					cardPaddingSmall: z.object({ phone: cssLength, tablet: cssLength }).optional(),
					align: z.enum(["center"]).optional(),
					titleLevel: z.enum(["h4", "h5", "h6"]).optional(),
				})
				.optional(),
		}),
	}),
	z.object({ type: z.literal("cta_banner"), ...base, fields: z.object({ heading, body: richText.default([]), buttons: z.array(button).default([]), media: mediaRef.optional() }) }),
	z.object({ type: z.literal("faq"), ...base, fields: z.object({ heading, intro: richText.default([]), /** Source look: card = padded items, circled icons, the open one raised; openFirst = first answer shown; inset = side space around the list. */ look: z.object({ style: z.enum(["card", "panel"]).optional(), /** panel (Bricks accordion in a rounded box): its background, item side padding desktop/phones (px), divider colour, one item open at a time. */ bg: z.string().regex(/^(?:#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i).optional(), pad: z.number().min(0).max(120).optional(), padPhone: z.number().min(0).max(120).optional(), line: z.string().regex(/^(?:#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\))$/i).optional(), exclusive: z.boolean().optional(), radius: cssLength.optional(), openFirst: z.boolean().optional(), inset: z.string().regex(/^\d+(?:\.\d+)?(?:px|%)$/).optional() }).optional(), items: z.array(z.object({ question: z.string(), answer: richText })).min(1), schema: z.boolean().default(true) }) }),
	z.object({
		type: z.literal("pricing"),
		...base,
		fields: z.object({
			heading,
			intro: richText.default([]),
			/** Source look: corner radius of the rows; inset = side space around the list (desktop, and small screens). */
			look: z.object({ radius: cssLength.optional(), inset: z.string().regex(/^\d+(?:\.\d+)?(?:px|%)$/).optional(), insetSmall: z.string().regex(/^\d+(?:\.\d+)?(?:px|%)$/).optional() }).optional(),
			plans: z.array(z.object({ name: z.string(), price: z.string().optional(), period: z.string().optional(), description: z.string().optional(), features: z.array(z.string()).default([]), button: button.optional(), highlight: z.boolean().default(false) })).min(1),
			buttons: z.array(button).default([]),
		}),
	}),
	z.object({ type: z.literal("testimonials"), ...base, fields: z.object({ heading, items: z.array(z.object({ quote: z.string(), name: z.string().optional(), role: z.string().optional(), photo: mediaRef.optional(), rating: z.number().optional() })).min(1) }) }),
	z.object({ type: z.literal("team"), ...base, fields: z.object({ heading, intro: richText.default([]), columns: z.number().int().min(1).max(6).optional(), /** Card look from the source theme: photo height, name size, gap between cards. */ look: z.object({ photoHeight: cssLength.optional(), nameSize: cssLength.optional(), gap: cssLength.optional() }).optional(), members: z.array(z.object({ name: z.string(), role: z.string().optional(), photo: mediaRef.optional(), summary: z.string().optional(), bio: richText.default([]), links: z.array(button).default([]) })).min(1) }) }),
	z.object({ type: z.literal("gallery"), ...base, fields: z.object({ heading, images: z.array(mediaRef).min(1), layout: z.enum(["grid", "masonry", "carousel", "stack"]).default("grid"), lightbox: z.boolean().default(true) }) }),
	z.object({ type: z.literal("logo_strip"), ...base, fields: z.object({ heading, logos: z.array(z.object({ image: mediaRef, href: z.string().optional() })).min(1) }) }),
	z.object({ type: z.literal("stats"), ...base, fields: z.object({ heading, items: z.array(z.object({ value: z.string(), label: z.string(), prefix: z.string().optional(), suffix: z.string().optional() })).min(1) }) }),
	z.object({ type: z.literal("steps"), ...base, fields: z.object({ heading, items: z.array(z.object({ title: z.string(), body: richText.default([]), icon: icon.optional() })).min(1) }) }),
	z.object({ type: z.literal("tabs"), ...base, fields: z.object({ heading, tabs: z.array(z.object({ label: z.string(), body: richText })).min(1) }) }),
	z.object({ type: z.literal("video"), ...base, fields: z.object({ heading, video: mediaRef.optional(), embedUrl: z.string().optional(), poster: mediaRef.optional(), caption: z.string().optional() }) }),
	z.object({ type: z.literal("form"), ...base, fields: z.object({ heading, intro: richText.default([]), formRef: z.object({ provider: z.string(), id: z.string() }), aside: richText.default([]), /** The form under the heading, not beside it (a builder column stacks them), at most this wide (px), this far below (px or fluid). */ stacked: z.boolean().optional(), formWidth: z.number().int().min(200).max(2000).optional(), formGap: fluidLength.optional() }) }),
	z.object({ type: z.literal("map"), ...base, fields: z.object({ heading, embedUrl: z.string().optional(), address: z.string().optional(), height: z.string().optional() }) }),
	z.object({ type: z.literal("embed"), ...base, fields: z.object({ heading, provider: z.string(), html: z.string(), height: z.string().optional() }) }),
	z.object({ type: z.literal("legacy_html"), ...base, fields: z.object({ html: z.string(), reason: z.string() }) }),
	/** Site-wide announcement bar above the header (site part "announcement"; not meant for page content). */
	z.object({ type: z.literal("announcement"), ...base, fields: announcementFields }),
]);
export type Section = z.infer<typeof section>;
export type SectionType = Section["type"];
export const SECTION_TYPES = section.options.map((o) => o.shape.type.value) as SectionType[];

// ── Diagnostics ──────────────────────────────────────────────────────────────
export const diagnostic = z.object({
	level: z.enum(["info", "warn", "error"]),
	code: z.enum(["unmapped", "lossy", "dropped-decorative", "dynamic", "flagged", "media-missing", "link-unknown", "parse"]),
	message: z.string(),
	path: z.string().optional(),
	/** Unmapped node that carries content (text, links, images, forms): blocks the transform gate. */
	carriesContent: z.boolean().optional(),
	tag: z.string().optional(),
});
export type Diagnostic = z.infer<typeof diagnostic>;

// ── Documents ────────────────────────────────────────────────────────────────
/**
 * A blog post's own data. `body` is EmDash Portable Text (the @emdash-cms/gutenberg-to-portable-text block set: block,
 * image, gallery, embed, code, table, htmlBlock…) for Gutenberg/classic posts; builder posts keep `sections` instead and
 * have an empty body. Media in the body carry a `_media` MediaRef that load resolves to an EmDash media item.
 */
export const irPost = z.object({
	body: z.array(z.looseObject({ _type: z.string(), _key: z.string() })).default([]),
	excerpt: z.string().optional(),
	/** ISO 8601 UTC: WordPress date_gmt (publish date; the scheduled date for a `future` post). */
	publishedAt: z.string().optional(),
	modifiedAt: z.string().optional(),
	/** Sticky post → EmDash `featured` field. */
	sticky: z.boolean().optional(),
	/** WordPress post format (aside, gallery, quote, video…), kept as a field; the starter renders every format alike. */
	format: z.string().optional(),
	/** EmDash taxonomy name → term slugs. */
	terms: z.record(z.string(), z.array(z.string())).default({}),
	/** Byline slugs, in order. */
	bylines: z.array(z.string()).default([]),
	/** WordPress visibility: private and password-protected posts need a decision (overrides.ts protectedPosts). */
	visibility: z.enum(["public", "private", "password"]).default("public"),
});
export type IrPost = z.infer<typeof irPost>;

/**
 * An entry of a custom post type migrated as its own collection (src/transform/cpt.ts). `fields` hold EmDash values
 * by field slug (media as MediaRefs, rich text as Portable Text with `_media` marks); `references` the WordPress posts a
 * reference field points at (`<post type>:<wpId>`), resolved by load after every entry exists. Builder entries keep
 * `sections`; classic ones carry `body`.
 */
export const irEntry = z.object({
	collection: z.string(),
	fields: z.record(z.string(), z.unknown()).default({}),
	references: z.record(z.string(), z.array(z.string())).default({}),
	body: z.array(z.looseObject({ _type: z.string(), _key: z.string() })).default([]),
	excerpt: z.string().optional(),
	publishedAt: z.string().optional(),
	modifiedAt: z.string().optional(),
	menuOrder: z.number().int().optional(),
	/** EmDash taxonomy name → term slugs. */
	terms: z.record(z.string(), z.array(z.string())).default({}),
	/** Byline slugs, in order. */
	bylines: z.array(z.string()).default([]),
});
export type IrEntry = z.infer<typeof irEntry>;

export const irPage = z.object({
	version: z.literal(IR_VERSION),
	kind: z.enum(["page", "post", "partial", "popup", "entry"]),
	source: z.object({ wpId: z.number().int(), type: z.string(), status: z.string(), slug: z.string(), builder: z.enum(["wpbakery", "gutenberg", "classic", "bricks", "elementor", "divi", "empty", "html", "dom-fallback"]), modifiedGmt: z.string().optional() }),
	route: z.object({ path: z.string(), parentPath: z.string().optional(), template: z.string().optional(), isFrontPage: z.boolean().optional() }).optional(),
	title: z.string(),
	seo: z
		.object({
			title: z.string().optional(),
			description: z.string().optional(),
			canonical: z.string().optional(),
			robots: z.string().optional(),
			ogImage: z.string().optional(),
			jsonLdTypes: z.array(z.string()).default([]),
		})
		.default({ jsonLdTypes: [] }),
	/** WordPress featured image (social image fallback, listings). */
	featuredImage: mediaRef.optional(),
	sections: z.array(section),
	/** Popup-only: how it opens. */
	popup: z.object({ selectors: z.array(z.string()).default([]), autoOpen: z.object({ delayMs: z.number() }).optional(), size: z.string().optional() }).optional(),
	/** Post-only (blog): body, dates, terms and bylines (src/transform/blog.ts). */
	post: irPost.optional(),
	/** Entry-only (custom post type collections). */
	entry: irEntry.optional(),
	/**
	 * Page-only: the WordPress page attributes this page has (src/transform/pages.ts) — manual order, parent page as
	 * `page:<wpId>` (resolved by load to the migrated page), hand-written excerpt. Absent when it has none.
	 */
	page: z.object({ menuOrder: z.number().int().optional(), parent: z.string().optional(), excerpt: z.string().optional() }).optional(),
	/**
	 * Password-protected or private on WordPress, and what migration does with it (src/transform/protected.ts):
	 * protect = published behind the password page (the hash stays in raw/protected.json, never in the IR); draft; publish.
	 */
	access: z.object({ kind: z.enum(["password", "private"]), as: z.enum(["protect", "draft", "publish"]) }).optional(),
	diagnostics: z.array(diagnostic),
});
export type IrPage = z.infer<typeof irPage>;

export const irMenuItem: z.ZodType<IrMenuItem> = z.lazy(() => z.object({ label: z.string(), href: z.string(), newTab: z.boolean().optional(), opensPopup: z.string().optional(), button: z.boolean().optional(), hoverLabel: z.string().optional(), classes: z.array(z.string()).optional(), titleAttr: z.string().optional(), description: z.string().optional(), mega: z.boolean().optional(), children: z.array(irMenuItem).default([]) }));
export interface IrMenuItem {
	label: string;
	href: string;
	newTab?: boolean;
	opensPopup?: string;
	/** Shown as a button in the header (a header call to action), not as a text link. */
	button?: boolean;
	/** A button's second label, shown on hover (the kit's label swap). */
	hoverLabel?: string;
	/** The item's own CSS classes in WordPress (Appearance → Menus), minus the ones WordPress generates. */
	classes?: string[];
	/** The link's title attribute in WordPress (`attr_title`). */
	titleAttr?: string;
	/** The item's description (EmDash menus have no field for it: reported in the coverage report). */
	description?: string;
	/** A mega menu panel on the source (Max Mega Menu, theme mega menus): its children become columns of links. */
	mega?: boolean;
	children: IrMenuItem[];
}

export const irSite = z.object({
	version: z.literal(IR_VERSION),
	title: z.string(),
	tagline: z.string().optional(),
	frontPage: z.string().optional(),
	siteIcon: mediaRef.optional(),
	/** The business the live site describes in its structured data (Rank Math/Yoast LocalBusiness/Organization), schema.org fields only. */
	business: z
		.object({
			type: z.string(),
			name: z.string(),
			description: z.string().optional(),
			url: z.string().optional(),
			email: z.string().optional(),
			telephone: z.string().optional(),
			priceRange: z.string().optional(),
			address: z.object({ streetAddress: z.string().optional(), addressLocality: z.string().optional(), addressRegion: z.string().optional(), postalCode: z.string().optional(), addressCountry: z.string().optional() }).optional(),
			geo: z.object({ latitude: z.string(), longitude: z.string() }).optional(),
			hasMap: z.string().optional(),
			openingHours: z.array(z.string()).optional(),
			sameAs: z.array(z.string()).optional(),
		})
		.optional(),
	menus: z.array(z.object({ name: z.string(), role: z.enum(["primary", "secondary", "footer", "other"]), wpLocations: z.array(z.string()), items: z.array(irMenuItem) })),
	/** announcement = the bar above the header (ir/partials/announcement.json, site part slug "announcement"). */
	partials: z.array(z.object({ role: z.enum(["footer", "header", "announcement", "other"]), file: z.string() })),
	popups: z.array(z.object({ slug: z.string(), file: z.string() })),
});
export type IrSite = z.infer<typeof irSite>;
