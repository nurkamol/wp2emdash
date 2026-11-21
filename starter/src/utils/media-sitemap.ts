/**
 * Media sitemap (/sitemap/media.xml, pages/sitemap/media.xml.ts): every picture and video an entry shows, for Google's
 * image and video sitemap extensions. EmDash's own sitemaps (emdash 1.5) list one image per entry (its SEO image) and
 * no videos; this one lists the pictures inside an entry's sections and body too (hero backgrounds, image-and-text,
 * columns, cards, galleries, logos, team photos, post body images…) and the video sections (uploaded files and
 * YouTube/Vimeo links). Google accepts image and video tags in a separate sitemap that repeats page URLs listed
 * elsewhere (developers.google.com/search/docs/crawling-indexing/sitemaps/image-sitemaps, …/video-sitemaps).
 *
 * Only files on the site's own address are listed as images (EmDash media, /_emdash/api/media/file/…); a picture on
 * another host is left out. At most 1,000 images per page (the spec's limit). Background videos are decoration (muted,
 * no controls) and are not listed. A video needs a thumbnail: an uploaded file or a Vimeo link without a poster image
 * is left out (YouTube links use YouTube's own thumbnail).
 *
 * No imports: this file loads in Node (kit tests) and in the Worker.
 */

export interface SitemapVideo {
	thumbnail: string;
	title: string;
	description: string;
	/** The video file (uploaded video). */
	content?: string;
	/** The player (YouTube/Vimeo embed). */
	player?: string;
}

export interface MediaSitemapEntry {
	/** Absolute page address. */
	loc: string;
	images: string[];
	videos: SitemapVideo[];
}

/** Images per page in an image sitemap (Google's limit). */
export const MAX_IMAGES_PER_PAGE = 1000;

const MEDIA_PREFIX = "/_emdash/api/media/file/";
const SAFE = /^[\w.-]+$/;
/** Field names that hold a picture (section library and collection fields): image, media, media_2, col_1_image, bg_image, photo, poster, logo, featured_image… */
const IMAGE_KEY = /(?:^|_)(?:image|images|media|photo|poster|logo|avatar|thumbnail)(?:_\d+)?$/i;
/** Field names that hold a video file (section_video `video`, section background `bg_video`). */
const VIDEO_KEY = /(?:^|_)video$/i;

export function youtubeId(url: string): string | undefined {
	return /(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:.*[?&]v=|embed\/|shorts\/|live\/))([\w-]{6,})/.exec(url)?.[1];
}

export function vimeoId(url: string): string | undefined {
	return /vimeo\.com\/(?:video\/)?(\d+)/.exec(url)?.[1];
}

/** URL of an EmDash media value (as utils/media.ts and EmDash's Media component build it); undefined for anything else. */
function mediaValueUrl(v: Record<string, unknown>): string | undefined {
	if (typeof v.provider === "string" && v.provider !== "local") return typeof v.src === "string" ? v.src : undefined;
	const key = (v.meta as { storageKey?: unknown } | undefined)?.storageKey;
	if (typeof key === "string" && SAFE.test(key)) return `${MEDIA_PREFIX}${key}`;
	if (typeof v.src === "string" && v.src) return v.src;
	// A bare media id is not listed: EmDash serves files by storage key, /_emdash/api/media/file/<id> answers 404
	// (docs/spikes/M7-findings.md). EmDash fills `meta.storageKey` when content is saved (media/normalize.ts).
	return typeof v.url === "string" && v.url ? v.url : undefined;
}

/** An object that is an EmDash media value (image or file field). */
const isMediaValue = (v: Record<string, unknown>) => (typeof v.provider === "string" || typeof v.mimeType === "string" || !!(v.meta as { storageKey?: unknown } | undefined)?.storageKey) && (typeof v.id === "string" || typeof v.src === "string");

/** Absolute URL on the site's own origin; undefined for another host or something that is not a URL. */
export function ownUrl(u: string | undefined, origin: string): string | undefined {
	if (!u || typeof u !== "string") return undefined;
	const s = u.trim();
	if (!s || s.startsWith("data:")) return undefined;
	try {
		const abs = new URL(s, `${origin}/`);
		if (abs.origin !== origin || !/^https?:$/.test(abs.protocol)) return undefined;
		return abs.href;
	} catch {
		return undefined;
	}
}

const clip = (s: string, max: number) => {
	const t = s.replace(/\s+/g, " ").trim();
	return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};

/**
 * Pictures and videos an entry shows: walks its fields (the `blocks` sections, Portable Text bodies, image fields).
 * `page` gives the fallback title and description of a video (the page title, its meta description).
 */
export function entryMedia(data: Record<string, unknown>, origin: string, page: { title: string; description?: string | null }): { images: string[]; videos: SitemapVideo[] } {
	const images = new Set<string>();
	const videos = new Map<string, SitemapVideo>();
	const addImage = (u: string | undefined) => {
		const abs = ownUrl(u, origin);
		if (abs && images.size < MAX_IMAGES_PER_PAGE) images.add(abs);
	};
	const imageOf = (v: unknown) => (v && typeof v === "object" ? mediaValueUrl(v as Record<string, unknown>) : typeof v === "string" ? v : undefined);
	const videoSection = (b: Record<string, unknown>) => {
		const poster = ownUrl(imageOf(b.poster), origin);
		const title = clip(String(b.heading || b.caption || page.title || "Video"), 100);
		const description = clip(String(b.caption || page.description || b.heading || page.title || "Video"), 2048);
		const file = b.video && typeof b.video === "object" ? ownUrl(mediaValueUrl(b.video as Record<string, unknown>), origin) : undefined;
		const link = typeof b.embed_url === "string" ? b.embed_url : "";
		if (file) {
			if (poster && !videos.has(file)) videos.set(file, { thumbnail: poster, title, description, content: file });
			return;
		}
		const yt = youtubeId(link);
		if (yt) {
			const player = `https://www.youtube.com/embed/${yt}`;
			if (!videos.has(player)) videos.set(player, { thumbnail: poster ?? `https://i.ytimg.com/vi/${yt}/hqdefault.jpg`, title, description, player });
			return;
		}
		const vm = vimeoId(link);
		if (vm && poster) {
			const player = `https://player.vimeo.com/video/${vm}`;
			if (!videos.has(player)) videos.set(player, { thumbnail: poster, title, description, player });
		}
	};
	const walk = (v: unknown, key: string, depth: number) => {
		if (depth > 12 || v === null || v === undefined) return;
		if (Array.isArray(v)) {
			for (const x of v) walk(x, key, depth + 1);
			return;
		}
		if (typeof v !== "object") return;
		const o = v as Record<string, unknown>;
		if (o._type === "section_video") videoSection(o);
		// Portable Text image (post bodies): the asset's file URL (load writes it next to the media id).
		if (o._type === "image" && o.asset && typeof o.asset === "object") {
			const a = o.asset as { url?: unknown };
			addImage(typeof a.url === "string" ? a.url : undefined);
			return;
		}
		if (isMediaValue(o)) {
			const mime = typeof o.mimeType === "string" ? o.mimeType : "";
			if (mime ? mime.startsWith("image/") : IMAGE_KEY.test(key) && !VIDEO_KEY.test(key)) addImage(mediaValueUrl(o));
			return;
		}
		for (const [k, x] of Object.entries(o)) {
			if (k === "markDefs" || k === "_emdash_seo" || k === "seo") continue;
			walk(x, k, depth + 1);
		}
	};
	walk(data, "", 0);
	return { images: [...images], videos: [...videos.values()] };
}

const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** The sitemap: one <url> per page that shows a picture or a video; pages without any are left out (they are in EmDash's sitemaps). */
export function mediaSitemapXml(entries: MediaSitemapEntry[]): string {
	const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">'];
	const seen = new Set<string>();
	for (const e of entries) {
		if ((!e.images.length && !e.videos.length) || seen.has(e.loc)) continue;
		seen.add(e.loc);
		out.push("  <url>", `    <loc>${escapeXml(e.loc)}</loc>`);
		for (const i of e.images.slice(0, MAX_IMAGES_PER_PAGE)) out.push("    <image:image>", `      <image:loc>${escapeXml(i)}</image:loc>`, "    </image:image>");
		for (const v of e.videos) {
			out.push("    <video:video>", `      <video:thumbnail_loc>${escapeXml(v.thumbnail)}</video:thumbnail_loc>`, `      <video:title>${escapeXml(v.title)}</video:title>`, `      <video:description>${escapeXml(v.description)}</video:description>`);
			if (v.content) out.push(`      <video:content_loc>${escapeXml(v.content)}</video:content_loc>`);
			if (v.player) out.push(`      <video:player_loc>${escapeXml(v.player)}</video:player_loc>`);
			out.push("    </video:video>");
		}
		out.push("  </url>");
	}
	out.push("</urlset>");
	return `${out.join("\n")}\n`;
}
