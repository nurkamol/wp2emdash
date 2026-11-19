/**
 * IR section → EmDash block value for the starter's section library (src/starter/library.ts).
 * Media goes through a resolver: scaffold uses `$media` URLs (seed, local preview); load (M6)
 * uses uploaded media ids.
 */
import type { Button, MediaRef, PtBlock, RichText, Section } from "../../ir/schema.js";
import { BLOCK_TYPES, type Field } from "../../starter/library.js";

export type MediaResolver = (m: MediaRef | undefined) => unknown;

export interface BlockValue {
	_type: string;
	_version: 1;
	_key: string;
	[field: string]: unknown;
}

const isHeading = (b: PtBlock) => /^h[1-6]$/.test(b.style);
const plain = (b: PtBlock) => b.children.map((c) => c.text).join("");

/** IR heading blocks → eyebrow + heading + level (the editor edits plain strings). */
export function splitHeadingBlocks(blocks: RichText | undefined): { eyebrow?: string; heading?: string; heading_level?: string } {
	if (!blocks?.length) return {};
	const last = [...blocks].reverse().find(isHeading) ?? blocks[blocks.length - 1];
	if (!last) return {};
	const before = blocks.slice(0, blocks.indexOf(last)).map(plain).filter(Boolean);
	return { ...(before.length ? { eyebrow: before.join(" · ") } : {}), heading: plain(last), heading_level: isHeading(last) ? last.style : "h2" };
}

/** Leading heading run of a body → heading fields; the rest stays as body. */
function headingFromBody(body: RichText): { head: ReturnType<typeof splitHeadingBlocks>; rest: RichText } {
	const level = (b: PtBlock | undefined) => (b && isHeading(b) ? Number(b.style.slice(1)) : 7);
	if (!body.length) return { head: {}, rest: body };
	// The heading fields are plain text: a heading with a link (a footer's "© 2025 Studio / Website by Agency") stays
	// in the body so the link is kept.
	const linked = (b: PtBlock | undefined) => !!b && (b.markDefs ?? []).some((d) => d._type === "link" && b.children.some((c) => c.marks?.includes(d._key)));
	if (linked(body[0]) || (body[1] && isHeading(body[1]) && linked(body[1]))) return { head: {}, rest: body };
	let i = 0;
	if (isHeading(body[0] as PtBlock)) {
		// One heading; a smaller heading directly before a bigger one is an eyebrow (h5 "Excellence" + h3 title).
		// Two headings of the same level opening the text are a pair (Salient "Move with purpose. / Connect with
		// community."): both stay in the body, styled alike, inline marks kept.
		if (level(body[0]) === level(body[1])) return { head: {}, rest: body };
		i = level(body[0]) > level(body[1]) ? 2 : 1;
	} else if (body.length > 1 && isHeading(body[1] as PtBlock) && plain(body[0] as PtBlock).split(/\s+/).length <= 4) i = 2; // eyebrow paragraph
	if (!i) return { head: {}, rest: body };
	return { head: splitHeadingBlocks(body.slice(0, i)), rest: body.slice(i) };
}

/** Portable Text → the starter's Markdown subset (repeater text fields). */
export function ptToMd(blocks: RichText | undefined): string {
	const out: string[] = [];
	let list: string[] = [];
	const flush = () => {
		if (list.length) out.push(list.join("\n"));
		list = [];
	};
	for (const b of blocks ?? []) {
		const text = b.children
			.map((c) => {
				let t = c.text.replace(/([*[\]])/g, "\\$1");
				if (c.marks.includes("strong")) t = `**${t}**`;
				if (c.marks.includes("em")) t = `*${t}*`;
				const link = b.markDefs.find((d) => c.marks.includes(d._key));
				if (link) t = `[${t}](${link.href})`;
				return t;
			})
			.join("");
		if (b.listItem) {
			list.push(`${"  ".repeat((b.level ?? 1) - 1)}${b.listItem === "number" ? "1." : "-"} ${text}`);
			continue;
		}
		flush();
		out.push(isHeading(b) ? `**${text}**` : text);
	}
	flush();
	return out.join("\n\n");
}

/** Strip PT to the shape EmDash stores (no IR-only fields). */
const pt = (blocks: RichText | undefined) => (blocks?.length ? blocks : undefined);

const buttons = (list: Button[] | undefined) =>
	(list ?? []).map((b) => ({ label: b.label, url: b.opensPopup ? `#${b.opensPopup}` : b.href, style: b.style, ...(b.size ? { size: b.size } : {}), ...(b.textSize ? { text_size: `${b.textSize}px` } : {}), ...(b.spaceAbove ? { space_above: `${b.spaceAbove}px` } : {}), ...(b.inset ? { side_space: `${b.inset}px` } : {}), ...(b.hoverLabel ? { hover_label: b.hoverLabel } : {}), ...(b.light ? { light: true } : {}), ...(b.minWidth ? { min_width: `${b.minWidth}px` } : {}), new_tab: !!b.newTab, ...(b.opensPopup ? { popup: b.opensPopup } : {}) }));

/**
 * Sections hold up to 3 buttons. Extra ones (a footer column of legal links, say) become links in a paragraph after
 * the text instead of being dropped.
 */
const MAX_BUTTONS = 3;
function overflowLinks(body: RichText | undefined, list: Button[] | undefined, key: string): { body: RichText | undefined; buttons: Button[] } {
	const all = list ?? [];
	if (all.length <= MAX_BUTTONS) return { body, buttons: all };
	const extra = all.slice(MAX_BUTTONS);
	const block = {
		_type: "block" as const,
		_key: `${key}-more`,
		style: "normal" as const,
		children: extra.flatMap((b, i) => [...(i ? [{ _type: "span" as const, _key: `${key}-sep${i}`, text: " · ", marks: [] as string[] }] : []), { _type: "span" as const, _key: `${key}-l${i}`, text: b.label, marks: [`${key}-m${i}`] }]),
		markDefs: extra.map((b, i) => ({ _type: "link" as const, _key: `${key}-m${i}`, href: b.opensPopup ? `#${b.opensPopup}` : b.href })),
	};
	return { body: [...(body ?? []), block] as RichText, buttons: all.slice(0, MAX_BUTTONS) };
}

const fraction = (w?: string) => (w && ["1/4", "1/3", "1/2", "2/3", "3/4"].includes(w) ? w : "auto");

const FIELDS = new Map(BLOCK_TYPES.map((b) => [b.slug, b.versions[b.versions.length - 1]?.fields ?? []]));

/**
 * EmDash rejects block values with keys the block type does not define, and select values outside
 * the options. Keep only defined fields; drop invalid select values (the field default applies).
 * Returns what was dropped so the caller can report it — nothing disappears silently.
 */
export function conformToBlockType(v: BlockValue): { value: BlockValue; dropped: string[] } {
	const fields = FIELDS.get(v._type);
	if (!fields) return { value: v, dropped: [`unknown block type ${v._type}`] };
	const dropped: string[] = [];
	const out: BlockValue = { _type: v._type, _version: v._version, _key: v._key };
	const okSelect = (f: { validation?: Record<string, unknown>; options?: unknown }, val: unknown) => {
		const opts = (f.validation?.options ?? f.options) as string[] | undefined;
		return !opts || opts.includes(String(val));
	};
	for (const [k, val] of Object.entries(v)) {
		if (k.startsWith("_") || val === undefined) continue;
		const f = fields.find((x) => x.slug === k) as Field | undefined;
		if (!f) {
			dropped.push(`${k}=${JSON.stringify(val).slice(0, 40)}`);
			continue;
		}
		if (f.type === "select" && !okSelect(f, val)) {
			dropped.push(`${k}=${String(val)} (not an option)`);
			continue;
		}
		if (f.type === "repeater" && Array.isArray(val)) {
			const subs = (f.validation?.subFields ?? []) as { slug: string; type: string; options?: string[] }[];
			out[k] = val.map((item) => {
				const clean: Record<string, unknown> = {};
				for (const [ik, iv] of Object.entries(item as Record<string, unknown>)) {
					const sf = subs.find((x) => x.slug === ik);
					if (!sf || iv === undefined) {
						if (iv !== undefined) dropped.push(`${k}[].${ik}`);
						continue;
					}
					if (sf.type === "select" && sf.options && !sf.options.includes(String(iv))) {
						dropped.push(`${k}[].${ik}=${String(iv)}`);
						continue;
					}
					clean[ik] = iv;
				}
				return clean;
			});
			continue;
		}
		out[k] = val;
	}
	return { value: out, dropped };
}

/**
 * A section's block key. EmDash refuses to change the type of an existing block (same key), so the
 * type is part of the key: a section that becomes another type on a rerun is a new block.
 */
export const blockKey = (slug: string, index: number, type: string): string => `${slug}-${index}-${type}`;

export function sectionToBlock(s: Section, key: string, media: MediaResolver, onDrop?: (dropped: string[]) => void): BlockValue {
	const { value, dropped } = conformToBlockType(rawBlock(s, key, media));
	if (dropped.length) onDrop?.(dropped);
	return value;
}

function rawBlock(s: Section, key: string, media: MediaResolver): BlockValue {
	const appearance: Record<string, unknown> = {
		...(s.variant ? { variant: s.variant } : {}),
		tone: s.theme.tone,
		...(s.theme.background?.color ? { bg_color: s.theme.background.color } : {}),
		...(s.theme.background?.image ? { bg_image: media(s.theme.background.image) } : {}),
		...(s.theme.background?.video ? { bg_video: media(s.theme.background.video) } : {}),
		...(s.theme.background?.overlay !== undefined ? { bg_overlay: s.theme.background.overlay } : {}),
		...(s.theme.background?.motion ? { bg_motion: s.theme.background.motion } : {}),
		...(s.theme.background?.gradient ? { bg_gradient: s.theme.background.gradient } : {}),
		spacing: s.spacing,
		...(s.width ? { layout_width: s.width } : {}),
		...(s.gap ? { gap: s.gap } : {}),
		...(s.valign ? { valign: s.valign } : {}),
		...(s.phoneAlign ? { phone_align: s.phoneAlign } : {}),
		...(s.tabletAlign ? { tablet_align: s.tabletAlign } : {}),
		...(s.stackGap !== undefined ? { stack_gap: s.stackGap } : {}),
		...(s.inset ? { row_inset: s.inset.desktop, ...(s.inset.tablet ? { row_inset_tablet: s.inset.tablet } : {}), ...(s.inset.phone ? { row_inset_phone: s.inset.phone } : {}) } : {}),
		...(s.quoteStyle ? { quote_style: s.quoteStyle } : {}),
		...(s.headingSize ? { heading_size: s.headingSize } : {}),
		...(s.headingLeading ? { heading_leading: s.headingLeading } : {}),
		...(s.headingWidth ? { heading_width: s.headingWidth } : {}),
		...(s.eyebrowGap !== undefined ? { eyebrow_gap: s.eyebrowGap } : {}),
		...(s.headAlign ? { head_align: s.headAlign } : {}),
		...(s.headGap ? { head_gap: s.headGap } : {}),
		...(s.pad?.top ? { pad_top: s.pad.top } : {}),
		...(s.pad?.bottom ? { pad_bottom: s.pad.bottom } : {}),
		...(s.pad?.topTablet !== undefined ? { pad_top_tablet: s.pad.topTablet } : {}),
		...(s.pad?.bottomTablet !== undefined ? { pad_bottom_tablet: s.pad.bottomTablet } : {}),
		...(s.fullHeight ? { full_height: true } : {}),
		...(s.minHeight ? { min_height: s.minHeight } : {}),
		...(s.anchorId ? { anchor_id: s.anchorId } : {}),
	};
	const base = (type: string, fields: Record<string, unknown>): BlockValue => ({ _type: `section_${type}`, _version: 1, _key: key, ...stripUndefined({ ...fields, ...appearance }) });
	const f = s.fields as Record<string, unknown>;
	const head = splitHeadingBlocks(f.heading as RichText | undefined);

	switch (s.type) {
		case "hero":
			return base("hero", { ...head, body: pt(s.fields.body), buttons: buttons(s.fields.buttons), media: s.fields.media ? media(s.fields.media) : undefined, align: s.fields.align, ...stripUndefined({ content_width: s.fields.look?.width, body_size: s.fields.look?.bodySize, heading_size_phone: s.fields.look?.headingSizePhone, content_gap: s.fields.look?.gap, buttons_gap: s.fields.look?.buttonsGap !== undefined ? `${s.fields.look.buttonsGap}px` : undefined }) });
		case "rich_text": {
			const { head: h, rest } = headingFromBody(s.fields.body);
			const l = s.fields.look ?? {};
			const look = Object.fromEntries(Object.entries({ text_heading_size: l.headingSize, text_heading_size_tablet: l.headingSizeTablet, text_heading_size_phone: l.headingSizePhone, text_heading_leading: l.headingLeading, body_size: l.bodySize, body_size_small: l.bodySizeSmall, body_leading: l.bodyLeading, body_width: l.bodyWidth }).filter(([, v]) => v !== undefined));
			const rtMore = overflowLinks(rest, s.fields.buttons, key);
			return base("rich_text", { ...h, body: pt(rtMore.body), width: s.fields.width, align: s.fields.align, buttons: buttons(rtMore.buttons), variant: s.variant === "buttons" ? "buttons" : "default", ...look });
		}
		case "media_text": {
			const { head: h, rest } = headingFromBody(s.fields.body);
			const ratio = ["1/3", "1/2", "2/3"].includes(s.fields.ratio) ? s.fields.ratio : "1/2";
			const mtMore = overflowLinks(rest, s.fields.buttons, key);
			return base("media_text", { ...h, body: pt(mtMore.body), buttons: buttons(mtMore.buttons), media: media(s.fields.media[0]), media_2: s.fields.media[1] ? media(s.fields.media[1]) : undefined, media_side: s.fields.mediaSide, ratio, ...heightFields(s.fields.mediaHeight), ...(s.fields.textInset ? { text_inset: s.fields.textInset } : {}), ...(s.fields.textEnd ? { text_end: s.fields.textEnd } : {}), ...(s.fields.columnGap ? { column_gap: s.fields.columnGap } : {}), ...(s.fields.innerGutters ? { inner_gutters: true } : {}), ...(s.fields.textTop ? { text_top: s.fields.textTop } : {}), ...(s.fields.textParallax ? { text_parallax: s.fields.textParallax } : {}), ...(s.fields.mediaParallax ? { media_parallax: s.fields.mediaParallax } : {}), ...(s.fields.mediaRadius ? { media_radius: s.fields.mediaRadius } : {}), ...(s.fields.headingGap ? { heading_gap: `${s.fields.headingGap}px` } : {}), ...mediaTextLookFields(s.fields) });
		}
		case "columns": {
			const cols: Record<string, unknown> = {};
			s.fields.columns.slice(0, 4).forEach((c, i) => {
				const n = i + 1;
				cols[`col_${n}_body`] = pt(c.body);
				if (c.buttons.length) cols[`col_${n}_buttons`] = buttons(c.buttons);
				if (c.media[0]) cols[`col_${n}_image`] = media(c.media[0]);
				if (c.background?.image) cols[`col_${n}_bg_image`] = media(c.background.image);
				if (c.background?.color) cols[`col_${n}_bg_color`] = c.background.color;
				cols[`col_${n}_width`] = fraction(c.width);
				if (c.imageCircle) cols[`col_${n}_image_circle`] = c.imageCircle;
				if (c.align) cols[`col_${n}_align`] = c.align;
				if (c.gapPhone) cols[`col_${n}_gap_phone`] = `${c.gapPhone}px`;
				if (c.gapStacked) cols[`col_${n}_gap_stacked`] = c.gapStacked;
				if (c.gapAboveStacked) cols[`col_${n}_gap_above_stacked`] = c.gapAboveStacked;
				if (c.leading) cols[`col_${n}_leading`] = String(c.leading);
				if (c.headingGap) cols[`col_${n}_heading_gap`] = `${c.headingGap}px`;
				if (c.list) cols[`col_${n}_list`] = c.list;
				if (c.insetEnd) cols[`col_${n}_inset_end`] = c.insetEnd;
				if (c.insetPhone) cols[`col_${n}_inset_phone`] = c.insetPhone;
				if (c.imageWidth) cols[`col_${n}_image_width`] = c.imageWidth;
				if (c.imageSpace) cols[`col_${n}_image_space`] = c.imageSpace;
				if (c.imageHeight) cols[`col_${n}_image_height`] = c.imageHeight;
				if (c.imageHeightPhone) cols[`col_${n}_image_height_phone`] = c.imageHeightPhone;
				if (c.imageAfter) cols[`col_${n}_image_after`] = true;
				if (c.itemsCenter) cols[`col_${n}_items_center`] = true;
				if (c.itemGap !== undefined) cols[`col_${n}_item_gap`] = c.itemGap;
				if (c.linkGap !== undefined) cols[`col_${n}_link_gap`] = c.linkGap;
				if (c.linkSize) cols[`col_${n}_link_size`] = c.linkSize;
				if (c.textSize) cols[`col_${n}_text_size`] = c.textSize;
				if (c.socialIcons !== undefined) cols[`col_${n}_social_icons`] = c.socialIcons;
			});
			return base("columns", { ...head, ...cols });
		}
		case "feature_grid":
			return base("feature_grid", {
				...head,
				intro: pt(s.fields.intro),
				columns: s.fields.columns,
				...(s.fields.look ? stripUndefined({ card_bg: s.fields.look.cardBackground, card_radius: s.fields.look.cardRadius, card_shadow: s.fields.look.cardShadow, card_padding: s.fields.look.cardPadding, card_align: s.fields.look.align, title_level: s.fields.look.titleLevel }) : {}),
				...(s.fields.cardSpace ? { card_space: s.fields.cardSpace.desktop, ...(s.fields.cardSpace.phone ? { card_space_phone: s.fields.cardSpace.phone } : {}), ...(s.fields.cardSpace.inset !== undefined ? { card_inset: s.fields.cardSpace.inset } : {}) } : {}),
				items: s.fields.items.map((it) => stripUndefined({ title: it.title, overlay: it.overlay, image_motion: it.imageMotion, body: ptToMd(it.body) || undefined, image: it.image ? media(it.image) : undefined, icon: it.icon ? `${it.icon.library}:${it.icon.name}` : undefined, link_label: it.link?.label, link_url: it.link?.href, link_new_tab: it.link?.newTab || undefined })),
			});
		case "cta_banner":
			return base("cta_banner", { ...head, body: pt(s.fields.body), buttons: buttons(s.fields.buttons), media: s.fields.media ? media(s.fields.media) : undefined });
		case "faq":
			return base("faq", { ...head, intro: pt(s.fields.intro), ...(s.fields.look?.style ? { faq_style: s.fields.look.style } : {}), ...(s.fields.look?.radius ? { card_radius: s.fields.look.radius } : {}), ...(s.fields.look?.openFirst ? { open_first: true } : {}), ...(s.fields.look?.inset ? { list_inset: s.fields.look.inset } : {}), items: s.fields.items.map((i) => ({ question: i.question, answer: ptToMd(i.answer) || "—" })), schema: s.fields.schema });
		case "pricing":
			return base("pricing", {
				...head,
				intro: pt(s.fields.intro),
				...(s.fields.look?.radius ? { card_radius: s.fields.look.radius } : {}),
				...(s.fields.look?.inset ? { list_inset: s.fields.look.inset } : {}),
				...(s.fields.look?.insetSmall ? { list_inset_small: s.fields.look.insetSmall } : {}),
				plans: s.fields.plans.map((p) => stripUndefined({ name: p.name, price: p.price, period: p.period, description: p.description, features: p.features.length ? p.features.join("\n") : undefined, button_label: p.button?.label, button_url: p.button?.href, button_new_tab: p.button?.newTab || undefined, highlight: p.highlight || undefined })),
				buttons: buttons(s.fields.buttons),
			});
		case "testimonials":
			return base("testimonials", { ...head, items: s.fields.items.map((q) => stripUndefined({ quote: q.quote, name: q.name, role: q.role, photo: q.photo ? media(q.photo) : undefined, rating: q.rating })) });
		case "team":
			return base("team", { ...head, intro: pt(s.fields.intro), ...(s.fields.columns ? { columns: s.fields.columns } : {}), ...(s.fields.look?.photoHeight ? { photo_height: s.fields.look.photoHeight } : {}), ...(s.fields.look?.nameSize ? { name_size: s.fields.look.nameSize } : {}), ...(s.fields.look?.gap ? { card_gap: s.fields.look.gap } : {}), members: s.fields.members.map((m) => stripUndefined({ name: m.name, role: m.role, photo: m.photo ? media(m.photo) : undefined, summary: m.summary, bio: ptToMd(m.bio) || undefined, link_url: m.links[0]?.href })) });
		case "gallery":
			return base("gallery", { ...head, images: s.fields.images.map((im) => ({ image: media(im) })), lightbox: s.fields.lightbox, variant: s.fields.layout });
		case "logo_strip":
			return base("logo_strip", { ...head, logos: s.fields.logos.map((l) => stripUndefined({ image: media(l.image), url: l.href })) });
		case "stats":
			return base("stats", { ...head, items: s.fields.items });
		case "steps":
			return base("steps", { ...head, items: s.fields.items.map((i) => stripUndefined({ title: i.title, body: ptToMd(i.body) || undefined, icon: i.icon ? `${i.icon.library}:${i.icon.name}` : undefined })) });
		case "tabs":
			return base("tabs", { ...head, tabs: s.fields.tabs.map((t) => ({ label: t.label, body: ptToMd(t.body) || "—" })) });
		case "video":
			return base("video", { ...head, video: s.fields.video ? media(s.fields.video) : undefined, embed_url: s.fields.embedUrl, poster: s.fields.poster ? media(s.fields.poster) : undefined, caption: s.fields.caption });
		case "form":
			return base("form", { ...head, intro: pt(s.fields.intro), form_id: `${s.fields.formRef.provider}-${s.fields.formRef.id}`, aside: pt(s.fields.aside) });
		case "map":
			return base("map", { ...head, embed_url: s.fields.embedUrl, address: s.fields.address, height: s.fields.height });
		case "embed":
			return base("embed", { ...head, provider: s.fields.provider, html: s.fields.html, height: s.fields.height });
		case "legacy_html":
			return base("legacy_html", { html: s.fields.html, reason: s.fields.reason });
		case "announcement": {
			// A site part, not a page section: no appearance fields.
			const a = s.fields;
			return {
				_type: "section_announcement",
				_version: 1,
				_key: key,
				...stripUndefined({
					enabled: a.enabled,
					message: pt(a.message),
					buttons: a.buttons.slice(0, 2).map((b) => ({ label: b.label, url: b.opensPopup ? `#${b.opensPopup}` : b.href, style: b.style === "secondary" ? "secondary" : "primary", new_tab: !!b.newTab })),
					bg_color: a.colors.background,
					text_color: a.colors.text,
					button_bg: a.colors.buttonBackground,
					button_color: a.colors.buttonText,
					dismissible: a.dismissible,
					sticky: a.sticky,
					starts_at: a.schedule?.from,
					ends_at: a.schedule?.to,
				}),
			};
		}
	}
}

function linkParagraph(b: Button, key: string): PtBlock {
	return { _type: "block", _key: `${key}p`, style: "normal", children: [{ _type: "span", _key: `${key}s`, text: b.label, marks: [`${key}l`] }], markDefs: [{ _type: "link", _key: `${key}l`, href: b.href, ...(b.newTab ? { blank: true } : {}) }] };
}

function stripUndefined<T extends Record<string, unknown>>(o: T): T {
	return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** media_text picture heights → media_height / media_height_small / media_2_height / media_2_height_small. */
function heightFields(h: ({ desktop: string; small?: string; phone?: string } | null)[] | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	(h ?? []).forEach((x, i) => {
		if (!x) return;
		const k = i === 0 ? "media" : "media_2";
		out[`${k}_height`] = x.desktop;
		if (x.small) out[`${k}_height_small`] = x.small;
		if (x.phone) out[`${k}_height_phone`] = x.phone;
	});
	return out;
}

/** IR media-text spacing and type → block fields (lengths kept as given). */
function mediaTextLookFields(f: { stackSpace?: string; quoteGap?: string; media2Gap?: string; bodySize?: string; bodySizeSmall?: string; bodyLeading?: number; quoteSize?: string; quoteSizeSmall?: string; quoteWidth?: string }): Record<string, unknown> {
	const map = { stack_space: f.stackSpace, quote_gap: f.quoteGap, media_2_gap: f.media2Gap, body_size: f.bodySize, body_size_small: f.bodySizeSmall, body_leading: f.bodyLeading, quote_size: f.quoteSize, quote_size_small: f.quoteSizeSmall, quote_width: f.quoteWidth };
	return Object.fromEntries(Object.entries(map).filter(([, v]) => v !== undefined));
}
