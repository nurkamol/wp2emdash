/**
 * Finds every media reference in raw post content and meta:
 * attachment IDs in WPBakery/Salient shortcode attributes, `wp-image-N` classes,
 * gallery `ids`, and absolute/relative media URLs (incl. resized `-300x200` variants,
 * URL-encoded link attributes and base64 `vc_raw_html` blocks).
 */

export interface MediaRef {
	kind: "id" | "url";
	value: string;
	/** Where it was found, e.g. `content:[vc_row bg_image]` or `meta:_thumbnail_id`. */
	via: string;
}

/** Shortcode attributes that hold attachment IDs (single or comma list). */
const ID_ATTR = /^(image|images|img|img_id|image_id|bg_image|background_image|image_url|ids|include|poster|logo|icon_image|attachment|media|photo|gallery|gallery_ids|slide_image|image_with_animation|custom_icon|video_image|mobile_bg_image|bg_image_tablet|bg_image_phone|.*_image(_id)?|.*_img)$/i;

/** Meta keys that hold attachment IDs. */
const ID_META = /^(_thumbnail_id|.*_image_id|.*_attachment_id|site_icon|site_logo|custom_logo)$/i;

const MEDIA_EXT = "jpe?g|png|gif|webp|avif|svg|ico|bmp|tiff?|mp4|webm|ogv|ogg|mov|m4v|mp3|wav|m4a|pdf|docx?|xlsx?|pptx?|zip|kml|json|lottie";
const URL_RE = new RegExp(`(?:https?:)?//[^\\s"'<>()\\[\\]{}|\\\\^\`]+?\\.(?:${MEDIA_EXT})(?=[\\s"'<>()\\[\\]?#,;|&]|$)|/(?:wp-content/uploads|storage)/[^\\s"'<>()\\[\\]{}|\\\\^\`]+?\\.(?:${MEDIA_EXT})(?=[\\s"'<>()\\[\\]?#,;|&]|$)`, "gi");

/** More document types, only under the uploads folder (elsewhere `.txt`/`.csv` links are rarely files of this site). */
const DOC_EXT = "odt|ods|odp|rtf|csv|txt|rar|7z|epub|pps|ppsx|dotx|gz|tar|key|numbers|pages";
const DOC_RE = new RegExp(`(?:(?:https?:)?//[^\\s"'<>()\\[\\]{}|\\\\^\`/]+)?/(?:wp-content/uploads|storage)/[^\\s"'<>()\\[\\]{}|\\\\^\`]+?\\.(?:${DOC_EXT})(?=[\\s"'<>()\\[\\]?#,;|&]|$)`, "gi");

const SHORTCODE_RE = /\[([a-z][a-z0-9_-]*)((?:\s+[a-z0-9_-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s\]]+))*)\s*\/?\]/gi;
const ATTR_RE = /([a-z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s\]]+))/gi;

function safeDecode(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

/** vc_raw_html / vc_raw_js bodies are base64(urlencode(html)). */
export function decodeRawBlocks(content: string): string[] {
	const out: string[] = [];
	for (const m of content.matchAll(/\[vc_raw_(?:html|js)[^\]]*\]([\s\S]*?)\[\/vc_raw_(?:html|js)\]/gi)) {
		const body = (m[1] ?? "").replace(/<\/?p>|<br\s*\/?>/g, "").trim();
		try {
			out.push(safeDecode(Buffer.from(body, "base64").toString("utf8")));
		} catch {}
	}
	return out;
}

export function findMediaRefs(content: string, meta: Record<string, unknown> = {}): MediaRef[] {
	const refs: MediaRef[] = [];
	const seen = new Set<string>();
	const add = (r: MediaRef) => {
		const k = `${r.kind}:${r.value}`;
		if (!seen.has(k)) {
			seen.add(k);
			refs.push(r);
		}
	};

	for (const sc of content.matchAll(SHORTCODE_RE)) {
		const tag = sc[1] ?? "";
		for (const a of (sc[2] ?? "").matchAll(ATTR_RE)) {
			const name = a[1] ?? "";
			const val = (a[2] ?? a[3] ?? a[4] ?? "").trim();
			if (ID_ATTR.test(name) && /^\d+(\s*,\s*\d+)*$/.test(val)) {
				for (const id of val.split(",")) if (Number(id) > 0) add({ kind: "id", value: String(Number(id)), via: `content:[${tag} ${name}]` });
			}
		}
	}
	for (const m of content.matchAll(/wp-image-(\d+)/g)) add({ kind: "id", value: m[1] as string, via: "content:wp-image class" });

	const texts = [content, safeDecode(content.replace(/\+/g, " ")), ...decodeRawBlocks(content)];
	for (const t of texts) for (const m of t.matchAll(URL_RE)) add({ kind: "url", value: normaliseUrlRef(m[0]), via: "content:url" });
	for (const t of texts) for (const m of t.matchAll(DOC_RE)) add({ kind: "url", value: normaliseUrlRef(m[0]), via: "content:url" });

	for (const [key, raw] of Object.entries(meta)) {
		const values = Array.isArray(raw) ? raw : [raw];
		for (const v of values) {
			if (v == null) continue;
			const s = typeof v === "string" ? v : typeof v === "number" ? String(v) : JSON.stringify(v);
			if (ID_META.test(key) && /^\d+$/.test(s) && Number(s) > 0) add({ kind: "id", value: s, via: `meta:${key}` });
			for (const m of s.matchAll(URL_RE)) add({ kind: "url", value: normaliseUrlRef(m[0]), via: `meta:${key}` });
		}
	}
	return refs;
}

function normaliseUrlRef(u: string): string {
	const s = u.replace(/\\\//g, "/");
	return s.startsWith("//") ? `https:${s}` : s;
}

/** `/2025/03/photo-300x200.webp` → `2025/03/photo.webp` (path relative to the uploads root, size suffix removed). */
export function uploadsKey(url: string): string | undefined {
	const m = /\/(?:wp-content\/uploads|storage)\/(.+)$/i.exec(url.split(/[?#]/)[0] ?? "");
	if (!m?.[1]) return undefined;
	return safeDecode(m[1])
		.replace(/-\d+x\d+(?=\.[a-z0-9]+$)/i, "")
		.replace(/-scaled(?=\.[a-z0-9]+$)/i, "")
		.toLowerCase();
}
