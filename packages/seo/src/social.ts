/**
 * Social sharing text and archive SEO kept by the SEO & Analytics plugin (plugin KV = D1 `options` rows
 * `plugin:site-seo:<key>`), and the head tags made from them.
 *
 * - Per entry (`social:<collection>:<entryId>`): the Open Graph / Twitter title, description and image an editor set in
 *   WordPress (Yoast `_yoast_wpseo_opengraph-*` / `_yoast_wpseo_twitter-*`, Rank Math `rank_math_facebook_*` /
 *   `rank_math_twitter_*`) or in the page editor's SEO panel. EmDash 1.5 entries have SEO title, description and image,
 *   but no separate sharing text.
 * - Per term archive (`term:<taxonomy>:<termSlug>`): SEO title, meta description, noindex and the same sharing fields
 *   (Yoast `wpseo_taxonomy_meta`, Rank Math term meta, or Plugins → SEO → Archives). EmDash 1.5 terms have no SEO fields.
 *
 * Rendering (`page:metadata`, plugin/index.ts): only what is set is printed, so an empty field falls back to EmDash's own
 * tags (the entry's SEO title / description / image, or the sharing card of @wp2emdash/og). Twitter falls back to the
 * Open Graph value first, as Yoast and Rank Math do. Term archives fall back to the archive's SEO title and description.
 * The archive's `<title>` is the template's job (a plugin cannot set it): the starter reads the same row (readTermSeo).
 *
 * Worker-safe and dependency-free: imported by the plugin, the starter and the kit's load phase.
 */
import { SEO_PLUGIN } from "./meta.js";

export interface SocialText {
	ogTitle?: string;
	ogDescription?: string;
	/** Absolute URL or a site path (`/_emdash/api/media/file/<key>`). */
	ogImage?: string;
	twitterTitle?: string;
	twitterDescription?: string;
	twitterImage?: string;
}
export type SocialSource = "migration" | "editor";
export interface StoredSocial extends SocialText {
	/** "migration": written by the kit's load (WordPress or an owner override); "editor": saved in the admin (load never overwrites it). */
	source: SocialSource;
	updatedAt: string;
	updatedBy?: string;
}
export interface TermSeo extends SocialText {
	/** The archive's full `<title>`, as WordPress printed it (variables resolved). */
	title?: string;
	description?: string;
	noindex?: boolean;
}
export interface StoredTermSeo extends TermSeo {
	taxonomy: string;
	slug: string;
	/** Term name, for the admin list. */
	label?: string;
	source: SocialSource;
	updatedAt: string;
	updatedBy?: string;
}

export const SOCIAL_FIELDS = ["ogTitle", "ogDescription", "ogImage", "twitterTitle", "twitterDescription", "twitterImage"] as const;
export const TERM_FIELDS = ["title", "description", ...SOCIAL_FIELDS] as const;
const LIMITS: Record<(typeof TERM_FIELDS)[number], number> = { title: 200, description: 500, ogTitle: 200, ogDescription: 500, ogImage: 1000, twitterTitle: 200, twitterDescription: 500, twitterImage: 1000 };

export const socialKey = (collection: string, id: string) => `social:${collection}:${id}`;
/**
 * One spelling per term slug: WordPress keeps non-ASCII slugs percent-encoded (`caf%c3%a9`), the starter's routes decode
 * them (`café`). Both map to the encoded lowercase form; ASCII slugs are unchanged.
 */
export function slugKey(slug: string): string {
	let s = slug;
	try {
		s = decodeURIComponent(slug);
	} catch {}
	return encodeURIComponent(s).toLowerCase();
}
export const termKey = (taxonomy: string, slug: string) => `term:${taxonomy}:${slugKey(slug)}`;
/** The options-table row behind a term's KV key (EmDash 1.5: `plugin:<id>:<key>`), read by the starter. */
export const termOptionName = (taxonomy: string, slug: string) => `plugin:${SEO_PLUGIN.id}:${termKey(taxonomy, slug)}`;

/** An image address the head may print: http(s) or a path on this site (made absolute when rendered). */
export const isImageAddress = (u: string) => /^https?:\/\/[^\s"'<>]+$/i.test(u) || /^\/(?!\/)[^\s"'<>]*$/.test(u);

const text = (v: unknown, max: number) => (typeof v === "string" && v.replace(/\s+/g, " ").trim() ? v.replace(/\s+/g, " ").trim().slice(0, max) : undefined);

/** Only the sharing fields that are set and valid (trimmed, length-capped; images must be http(s) or a site path). */
export function cleanSocial(v: unknown): SocialText {
	const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
	const out: SocialText = {};
	for (const k of SOCIAL_FIELDS) {
		const s = text(o[k], LIMITS[k]);
		if (!s) continue;
		if ((k === "ogImage" || k === "twitterImage") && !isImageAddress(s)) continue;
		out[k] = s;
	}
	return out;
}

export function cleanTermSeo(v: unknown): TermSeo {
	const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
	const title = text(o.title, LIMITS.title);
	const description = text(o.description, LIMITS.description);
	return { ...(title ? { title } : {}), ...(description ? { description } : {}), ...(o.noindex === true ? { noindex: true } : {}), ...cleanSocial(o) };
}

export const hasSocial = (s: SocialText) => SOCIAL_FIELDS.some((k) => !!s[k]);
export const hasTermSeo = (s: TermSeo) => !!s.title || !!s.description || !!s.noindex || hasSocial(s);

const sourceOf = (v: unknown): SocialSource => (v === "editor" ? "editor" : "migration");
const meta = (o: Record<string, unknown>) => ({ source: sourceOf(o.source), updatedAt: typeof o.updatedAt === "string" ? o.updatedAt.slice(0, 40) : "", ...(typeof o.updatedBy === "string" ? { updatedBy: o.updatedBy.slice(0, 80) } : {}) });

/** A stored entry value read back; undefined when it holds nothing usable. */
export function parseSocial(v: unknown): StoredSocial | undefined {
	if (!v || typeof v !== "object") return undefined;
	const s = cleanSocial(v);
	return hasSocial(s) ? { ...s, ...meta(v as Record<string, unknown>) } : undefined;
}

export function parseTermSeo(v: unknown): StoredTermSeo | undefined {
	if (!v || typeof v !== "object") return undefined;
	const o = v as Record<string, unknown>;
	const taxonomy = text(o.taxonomy, 64);
	const slug = text(o.slug, 200);
	const s = cleanTermSeo(o);
	if (!taxonomy || !slug || !hasTermSeo(s)) return undefined;
	const label = text(o.label, 200);
	return { taxonomy, slug, ...(label ? { label } : {}), ...s, ...meta(o) };
}

export type Contribution = { kind: "meta"; name: string; content: string } | { kind: "property"; property: string; content: string };
const prop = (property: string, content: string): Contribution => ({ kind: "property", property, content });
const tag = (name: string, content: string): Contribution => ({ kind: "meta", name, content });

/** A stored image as an absolute URL on the serving origin (site paths) or as written (other hosts). */
export function absoluteImage(u: string, origin: string | undefined): string | undefined {
	if (/^https?:\/\//i.test(u)) return u;
	return origin && u.startsWith("/") ? `${origin.replace(/\/$/, "")}${u}` : undefined;
}

export interface TagOptions {
	/** Origin for site-path images (the page's siteUrl: the serving address before go-live, production after). */
	origin?: string;
	/** Size and type of the stored og:image (from EmDash's media table), so a sharing card's 1200×630 does not win. */
	ogImageMeta?: { width?: number; height?: number; type?: string };
}

/**
 * Head tags for an entry's stored sharing text. Only set fields are printed (plugin tags come first and win; EmDash's
 * base tags fill the rest from the entry's SEO title, description and image). Twitter: its own value, else the Open
 * Graph one.
 */
export function socialTags(s: SocialText, o: TagOptions = {}): Contribution[] {
	const out: Contribution[] = [];
	const ogImage = s.ogImage ? absoluteImage(s.ogImage, o.origin) : undefined;
	const twImage = s.twitterImage ? absoluteImage(s.twitterImage, o.origin) : ogImage;
	if (s.ogTitle) out.push(prop("og:title", s.ogTitle));
	if (s.ogDescription) out.push(prop("og:description", s.ogDescription));
	if (ogImage) {
		out.push(prop("og:image", ogImage));
		if (o.ogImageMeta?.width) out.push(prop("og:image:width", String(o.ogImageMeta.width)));
		if (o.ogImageMeta?.height) out.push(prop("og:image:height", String(o.ogImageMeta.height)));
		if (o.ogImageMeta?.type) out.push(prop("og:image:type", o.ogImageMeta.type));
	}
	const twTitle = s.twitterTitle || s.ogTitle;
	const twDescription = s.twitterDescription || s.ogDescription;
	if (twTitle) out.push(tag("twitter:title", twTitle));
	if (twDescription) out.push(tag("twitter:description", twDescription));
	if (twImage) out.push(tag("twitter:card", "summary_large_image"), tag("twitter:image", twImage));
	return out;
}

/**
 * Head tags for a term archive: its sharing text, falling back to its SEO title and description (EmDash's base tags
 * would use the term name), the meta description, and noindex.
 */
export function termTags(t: TermSeo, o: TagOptions = {}): Contribution[] {
	const out = socialTags({ ...t, ogTitle: t.ogTitle || t.title, ogDescription: t.ogDescription || t.description }, o);
	if (t.description) out.unshift(tag("description", t.description));
	if (t.noindex) out.unshift(tag("robots", "noindex, follow"));
	return out;
}

export interface ArchiveBase {
	/** EmDash taxonomy name. */
	taxonomy: string;
	/** Archive base path (`/category/`). */
	base: string;
}
const trim = (p: string) => `/${p.replace(/^\/+|\/+$/g, "")}/`.replace(/^\/\/$/, "/");

/** The term an archive path shows (`/category/parent/child/page/2/` → category child), as the starter routes it. */
export function termFromPath(pathname: string, archives: readonly ArchiveBase[]): { taxonomy: string; slug: string } | undefined {
	let path = trim(pathname);
	path = path.replace(/feed\/(?:rss2?\/)?$/, "").replace(/page\/\d+\/$/, "");
	for (const a of archives) {
		const base = trim(a.base);
		if (base === "/" || !path.startsWith(base) || path === base) continue;
		const slug = path.slice(base.length).replace(/\/$/, "").split("/").pop();
		if (!slug) continue;
		try {
			return { taxonomy: a.taxonomy, slug: decodeURIComponent(slug) };
		} catch {
			return { taxonomy: a.taxonomy, slug };
		}
	}
	return undefined;
}

export interface D1Like {
	prepare(query: string): { bind(...values: unknown[]): { first<T>(): Promise<T | null> } };
}

/** A term archive's stored SEO, read by primary key (the starter, once per uncached render). Never throws. */
export async function readTermSeo(db: D1Like | undefined, taxonomy: string, slug: string): Promise<StoredTermSeo | undefined> {
	if (!db) return undefined;
	try {
		const row = await db.prepare("SELECT value FROM options WHERE name = ? LIMIT 1").bind(termOptionName(taxonomy, slug)).first<{ value: string }>();
		return row ? parseTermSeo(JSON.parse(row.value)) : undefined;
	} catch {
		return undefined;
	}
}

/** The `<title>` of an archive page: the stored title on page 1, with "– Page N" after it. */
export const archiveTitle = (title: string, page: number) => (page > 1 ? `${title} – Page ${page}` : title);

// ── Import from the kit's load phase ─────────────────────────────────────────────────────────────────────────────

export interface ImportPayload {
	entries?: { collection: string; id: string; social: SocialText }[];
	terms?: ({ taxonomy: string; slug: string; label?: string } & TermSeo)[];
}
export interface ImportResult {
	entries: { written: number; kept: number; rejected: number };
	terms: { written: number; kept: number; rejected: number };
}
export interface KvLike {
	get<T>(k: string): Promise<T | null>;
	set(k: string, v: unknown): Promise<void>;
}
const KEY_PART = /^[A-Za-z0-9_:.%-]{1,200}$/;

/**
 * Writes what the migration carried. A value an editor saved in the admin is kept (never overwritten by a rerun);
 * an empty value is skipped (nothing to store). Keys are validated; nothing else in KV is touched.
 */
export async function importSocial(kv: KvLike, payload: unknown, now = new Date().toISOString()): Promise<ImportResult> {
	const p = (payload && typeof payload === "object" ? payload : {}) as ImportPayload;
	const r: ImportResult = { entries: { written: 0, kept: 0, rejected: 0 }, terms: { written: 0, kept: 0, rejected: 0 } };
	for (const e of Array.isArray(p.entries) ? p.entries.slice(0, 1000) : []) {
		const social = cleanSocial(e?.social);
		if (!e || typeof e.collection !== "string" || typeof e.id !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(e.collection) || !KEY_PART.test(e.id) || !hasSocial(social)) {
			r.entries.rejected++;
			continue;
		}
		const key = socialKey(e.collection, e.id);
		if (parseSocial(await kv.get(key))?.source === "editor") {
			r.entries.kept++;
			continue;
		}
		await kv.set(key, { ...social, source: "migration", updatedAt: now } satisfies StoredSocial);
		r.entries.written++;
	}
	for (const t of Array.isArray(p.terms) ? p.terms.slice(0, 2000) : []) {
		const seo = cleanTermSeo(t);
		if (!t || typeof t.taxonomy !== "string" || typeof t.slug !== "string" || !/^[a-z][a-z0-9_]{0,62}$/.test(t.taxonomy) || !KEY_PART.test(slugKey(t.slug)) || !hasTermSeo(seo)) {
			r.terms.rejected++;
			continue;
		}
		const key = termKey(t.taxonomy, t.slug);
		if (parseTermSeo(await kv.get(key))?.source === "editor") {
			r.terms.kept++;
			continue;
		}
		const label = text(t.label, 200);
		await kv.set(key, { taxonomy: t.taxonomy, slug: t.slug, ...(label ? { label } : {}), ...seo, source: "migration", updatedAt: now } satisfies StoredTermSeo);
		r.terms.written++;
	}
	return r;
}
