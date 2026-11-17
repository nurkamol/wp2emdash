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
	let i = 0;
	while (i < body.length && isHeading(body[i] as PtBlock)) i++;
	// eyebrow paragraph (≤ 4 words) directly before a heading
	if (i === 0 && body.length > 1 && isHeading(body[1] as PtBlock) && plain(body[0] as PtBlock).split(/\s+/).length <= 4) i = 2;
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
	(list ?? []).map((b) => ({ label: b.label, url: b.opensPopup ? `#${b.opensPopup}` : b.href, style: b.style, new_tab: !!b.newTab, ...(b.opensPopup ? { popup: b.opensPopup } : {}) }));

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
		spacing: s.spacing,
		...(s.fullHeight ? { full_height: true } : {}),
		...(s.anchorId ? { anchor_id: s.anchorId } : {}),
	};
	const base = (type: string, fields: Record<string, unknown>): BlockValue => ({ _type: `section_${type}`, _version: 1, _key: key, ...stripUndefined({ ...fields, ...appearance }) });
	const f = s.fields as Record<string, unknown>;
	const head = splitHeadingBlocks(f.heading as RichText | undefined);

	switch (s.type) {
		case "hero":
			return base("hero", { ...head, body: pt(s.fields.body), buttons: buttons(s.fields.buttons), media: s.fields.media ? media(s.fields.media) : undefined, align: s.fields.align });
		case "rich_text": {
			const { head: h, rest } = headingFromBody(s.fields.body);
			return base("rich_text", { ...h, body: pt(rest), width: s.fields.width, align: s.fields.align, buttons: buttons(s.fields.buttons), variant: s.variant === "buttons" ? "buttons" : "default" });
		}
		case "media_text": {
			const { head: h, rest } = headingFromBody(s.fields.body);
			const ratio = ["1/3", "1/2", "2/3"].includes(s.fields.ratio) ? s.fields.ratio : "1/2";
			return base("media_text", { ...h, body: pt(rest), buttons: buttons(s.fields.buttons), media: media(s.fields.media[0]), media_2: s.fields.media[1] ? media(s.fields.media[1]) : undefined, media_side: s.fields.mediaSide, ratio });
		}
		case "columns": {
			const cols: Record<string, unknown> = {};
			s.fields.columns.slice(0, 4).forEach((c, i) => {
				const n = i + 1;
				const body = [...c.body, ...c.buttons.map((b) => linkParagraph(b, `${key}c${n}b`))];
				cols[`col_${n}_body`] = pt(body);
				if (c.media[0]) cols[`col_${n}_image`] = media(c.media[0]);
				if (c.background?.image) cols[`col_${n}_bg_image`] = media(c.background.image);
				if (c.background?.color) cols[`col_${n}_bg_color`] = c.background.color;
				cols[`col_${n}_width`] = fraction(c.width);
			});
			return base("columns", { ...head, ...cols });
		}
		case "feature_grid":
			return base("feature_grid", {
				...head,
				intro: pt(s.fields.intro),
				columns: s.fields.columns,
				items: s.fields.items.map((it) => stripUndefined({ title: it.title, body: ptToMd(it.body) || undefined, image: it.image ? media(it.image) : undefined, icon: it.icon ? `${it.icon.library}:${it.icon.name}` : undefined, link_label: it.link?.label, link_url: it.link?.href, link_new_tab: it.link?.newTab || undefined })),
			});
		case "cta_banner":
			return base("cta_banner", { ...head, body: pt(s.fields.body), buttons: buttons(s.fields.buttons), media: s.fields.media ? media(s.fields.media) : undefined });
		case "faq":
			return base("faq", { ...head, intro: pt(s.fields.intro), items: s.fields.items.map((i) => ({ question: i.question, answer: ptToMd(i.answer) || "—" })), schema: s.fields.schema });
		case "pricing":
			return base("pricing", {
				...head,
				intro: pt(s.fields.intro),
				plans: s.fields.plans.map((p) => stripUndefined({ name: p.name, price: p.price, period: p.period, description: p.description, features: p.features.length ? p.features.join("\n") : undefined, button_label: p.button?.label, button_url: p.button?.href, button_new_tab: p.button?.newTab || undefined, highlight: p.highlight || undefined })),
				buttons: buttons(s.fields.buttons),
			});
		case "testimonials":
			return base("testimonials", { ...head, items: s.fields.items.map((q) => stripUndefined({ quote: q.quote, name: q.name, role: q.role, photo: q.photo ? media(q.photo) : undefined, rating: q.rating })) });
		case "team":
			return base("team", { ...head, intro: pt(s.fields.intro), members: s.fields.members.map((m) => stripUndefined({ name: m.name, role: m.role, photo: m.photo ? media(m.photo) : undefined, summary: m.summary, bio: ptToMd(m.bio) || undefined, link_url: m.links[0]?.href })) });
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
	}
}

function linkParagraph(b: Button, key: string): PtBlock {
	return { _type: "block", _key: `${key}p`, style: "normal", children: [{ _type: "span", _key: `${key}s`, text: b.label, marks: [`${key}l`] }], markDefs: [{ _type: "link", _key: `${key}l`, href: b.href, ...(b.newTab ? { blank: true } : {}) }] };
}

function stripUndefined<T extends Record<string, unknown>>(o: T): T {
	return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
