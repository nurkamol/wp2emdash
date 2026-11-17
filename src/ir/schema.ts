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
});

export const sectionTheme = z.object({
	/** Text colour scheme: light = dark text on light background; dark = light text on dark/image background. */
	tone: z.enum(["light", "dark"]).default("light"),
	background: background.optional(),
});

export const sourceRef = z.object({
	adapter: z.enum(["wpbakery", "gutenberg", "classic"]),
	/** Path inside the source tree, e.g. `vc_row[2]` or `blocks[4]`. */
	path: z.string(),
	/** Short hash of the raw source of this section, to detect changes in the cutover delta. */
	rawHash: z.string(),
});

const base = {
	variant: z.string().optional(),
	theme: sectionTheme.default({ tone: "light" }),
	spacing: z.enum(["none", "compact", "normal", "spacious"]).default("normal"),
	fullHeight: z.boolean().optional(),
	anchorId: z.string().optional(),
	/** full = edge to edge (WPBakery "full width content", Gutenberg align full); default contained. */
	width: z.enum(["contained", "full"]).optional(),
	/** Space between columns; none = columns touch (WPBakery column_margin="none"). */
	gap: z.enum(["none", "normal"]).optional(),
	/** Vertical placement of content in a tall section (WPBakery full_screen_row_position). */
	valign: z.enum(["top", "middle", "bottom"]).optional(),
	/** Centre text on phones (WPBakery/Salient phone_text_alignment). */
	phoneAlign: z.enum(["center"]).optional(),
	sourceRef,
};

const heading = richText.optional();

// ── Section library (PLAN §5) ────────────────────────────────────────────────
const column = z.object({
	width: z.string().optional(),
	body: richText.default([]),
	media: z.array(mediaRef).default([]),
	buttons: z.array(button).default([]),
	background: background.optional(),
});
export type Column = z.infer<typeof column>;

const featureItem = z.object({
	title: z.string().optional(),
	body: richText.default([]),
	image: mediaRef.optional(),
	icon: icon.optional(),
	link: button.optional(),
});

export const section = z.discriminatedUnion("type", [
	z.object({ type: z.literal("hero"), ...base, fields: z.object({ heading, body: richText.default([]), buttons: z.array(button).default([]), media: mediaRef.optional(), align: z.enum(["left", "center", "right"]).default("center") }) }),
	z.object({ type: z.literal("rich_text"), ...base, fields: z.object({ body: richText, width: z.enum(["narrow", "normal", "wide"]).default("normal"), align: z.enum(["left", "center"]).default("left"), buttons: z.array(button).default([]) }) }),
	z.object({ type: z.literal("media_text"), ...base, fields: z.object({ media: z.array(mediaRef).min(1), body: richText.default([]), buttons: z.array(button).default([]), mediaSide: z.enum(["left", "right"]), ratio: z.string().default("1/2") }) }),
	z.object({ type: z.literal("columns"), ...base, fields: z.object({ heading, columns: z.array(column).min(1).max(6) }) }),
	z.object({ type: z.literal("feature_grid"), ...base, fields: z.object({ heading, intro: richText.default([]), items: z.array(featureItem).min(1), columns: z.number().int().min(1).max(6) }) }),
	z.object({ type: z.literal("cta_banner"), ...base, fields: z.object({ heading, body: richText.default([]), buttons: z.array(button).default([]), media: mediaRef.optional() }) }),
	z.object({ type: z.literal("faq"), ...base, fields: z.object({ heading, intro: richText.default([]), items: z.array(z.object({ question: z.string(), answer: richText })).min(1), schema: z.boolean().default(true) }) }),
	z.object({
		type: z.literal("pricing"),
		...base,
		fields: z.object({
			heading,
			intro: richText.default([]),
			plans: z.array(z.object({ name: z.string(), price: z.string().optional(), period: z.string().optional(), description: z.string().optional(), features: z.array(z.string()).default([]), button: button.optional(), highlight: z.boolean().default(false) })).min(1),
			buttons: z.array(button).default([]),
		}),
	}),
	z.object({ type: z.literal("testimonials"), ...base, fields: z.object({ heading, items: z.array(z.object({ quote: z.string(), name: z.string().optional(), role: z.string().optional(), photo: mediaRef.optional(), rating: z.number().optional() })).min(1) }) }),
	z.object({ type: z.literal("team"), ...base, fields: z.object({ heading, intro: richText.default([]), members: z.array(z.object({ name: z.string(), role: z.string().optional(), photo: mediaRef.optional(), summary: z.string().optional(), bio: richText.default([]), links: z.array(button).default([]) })).min(1) }) }),
	z.object({ type: z.literal("gallery"), ...base, fields: z.object({ heading, images: z.array(mediaRef).min(1), layout: z.enum(["grid", "masonry", "carousel", "stack"]).default("grid"), lightbox: z.boolean().default(true) }) }),
	z.object({ type: z.literal("logo_strip"), ...base, fields: z.object({ heading, logos: z.array(z.object({ image: mediaRef, href: z.string().optional() })).min(1) }) }),
	z.object({ type: z.literal("stats"), ...base, fields: z.object({ heading, items: z.array(z.object({ value: z.string(), label: z.string(), prefix: z.string().optional(), suffix: z.string().optional() })).min(1) }) }),
	z.object({ type: z.literal("steps"), ...base, fields: z.object({ heading, items: z.array(z.object({ title: z.string(), body: richText.default([]), icon: icon.optional() })).min(1) }) }),
	z.object({ type: z.literal("tabs"), ...base, fields: z.object({ heading, tabs: z.array(z.object({ label: z.string(), body: richText })).min(1) }) }),
	z.object({ type: z.literal("video"), ...base, fields: z.object({ heading, video: mediaRef.optional(), embedUrl: z.string().optional(), poster: mediaRef.optional(), caption: z.string().optional() }) }),
	z.object({ type: z.literal("form"), ...base, fields: z.object({ heading, intro: richText.default([]), formRef: z.object({ provider: z.string(), id: z.string() }), aside: richText.default([]) }) }),
	z.object({ type: z.literal("map"), ...base, fields: z.object({ heading, embedUrl: z.string().optional(), address: z.string().optional(), height: z.string().optional() }) }),
	z.object({ type: z.literal("embed"), ...base, fields: z.object({ heading, provider: z.string(), html: z.string(), height: z.string().optional() }) }),
	z.object({ type: z.literal("legacy_html"), ...base, fields: z.object({ html: z.string(), reason: z.string() }) }),
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
export const irPage = z.object({
	version: z.literal(IR_VERSION),
	kind: z.enum(["page", "post", "partial", "popup"]),
	source: z.object({ wpId: z.number().int(), type: z.string(), status: z.string(), slug: z.string(), builder: z.enum(["wpbakery", "gutenberg", "classic", "empty"]), modifiedGmt: z.string().optional() }),
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
	diagnostics: z.array(diagnostic),
});
export type IrPage = z.infer<typeof irPage>;

export const irMenuItem: z.ZodType<IrMenuItem> = z.lazy(() => z.object({ label: z.string(), href: z.string(), newTab: z.boolean().optional(), opensPopup: z.string().optional(), children: z.array(irMenuItem).default([]) }));
export interface IrMenuItem {
	label: string;
	href: string;
	newTab?: boolean;
	opensPopup?: string;
	children: IrMenuItem[];
}

export const irSite = z.object({
	version: z.literal(IR_VERSION),
	title: z.string(),
	tagline: z.string().optional(),
	frontPage: z.string().optional(),
	siteIcon: mediaRef.optional(),
	menus: z.array(z.object({ name: z.string(), role: z.enum(["primary", "secondary", "footer", "other"]), wpLocations: z.array(z.string()), items: z.array(irMenuItem) })),
	partials: z.array(z.object({ role: z.enum(["footer", "header", "other"]), file: z.string() })),
	popups: z.array(z.object({ slug: z.string(), file: z.string() })),
});
export type IrSite = z.infer<typeof irSite>;
