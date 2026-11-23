/**
 * Background videos in web sizes, served from Cloudflare's cache (docs/spikes/video-findings.md).
 *
 *   /_video/v1/720/<storage key>  → R2 `_video/v1/<base>/720.mp4` (desktop, tablets)
 *   /_video/v1/480/<storage key>  → R2 `_video/v1/<base>/480.mp4` (phones)
 *
 * The sizes are made by the kit (`wp2emdash videos <slug>`, and the load phase) with ffmpeg: H.264, no sound, index
 * first. A size not made yet falls back to the uploaded file (short cache, so the size takes over once it exists).
 *
 * Why here and not EmDash's media route: EmDash keeps ranged video responses out of the cache, so every play read R2
 * in the database's region. This route marks the sizes cacheable for Cloudflare's Worker cache (wrangler.jsonc
 * `cache.enabled`, the layer in front of the Worker that also holds pages and images) with
 * `Cloudflare-CDN-Cache-Control`. That layer fetches the whole file on a miss and answers each byte range itself
 * (measured: a range request returns 206 MISS, then 206 HIT). The range handling below serves workers.dev and
 * preview addresses, where the layer is not in front. Runs before Astro: no page render, no database.
 */

const ROUTE = /^\/_video\/v1\/(720|480)\/([A-Za-z0-9_-]{1,80})\.(mp4|webm|m4v|mov)$/;
const TYPES: Record<string, string> = { mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime" };
const IMMUTABLE = "public, max-age=31536000, immutable";
/** The uploaded file stands in for a size not made yet: short, so the smaller file is picked up soon after. */
const FALLBACK = "public, max-age=300";

interface R2Range {
	offset: number;
	length: number;
}
interface R2ObjectLike {
	size: number;
	httpEtag: string;
	uploaded: Date;
	httpMetadata?: { contentType?: string };
}
interface R2BodyLike extends R2ObjectLike {
	body: ReadableStream;
}
export interface VideoBucket {
	head(key: string): Promise<R2ObjectLike | null>;
	get(key: string, opts?: { range?: R2Range }): Promise<R2BodyLike | null>;
}
/** R2 key of a made size. */
export const variantKey = (base: string, size: string) => `_video/v1/${base}/${size}.mp4`;

/** One `bytes=` range against a file of `size` bytes; undefined = serve the whole file, null = not satisfiable. */
export function parseRange(header: string | null, size: number): R2Range | undefined | null {
	if (!header) return undefined;
	const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!m || (m[1] === "" && m[2] === "")) return undefined; // several ranges or malformed: whole file
	if (m[1] === "") {
		const n = Math.min(Number(m[2]), size);
		return n > 0 ? { offset: size - n, length: n } : null;
	}
	const start = Number(m[1]);
	const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
	if (start >= size || end < start) return null;
	return { offset: start, length: end - start + 1 };
}

/** The response for /_video/…, or undefined when the path is not one (the request goes on to EmDash). */
export async function serveVideo(request: Request, bucket: VideoBucket | undefined): Promise<Response | undefined> {
	const url = new URL(request.url);
	const m = ROUTE.exec(url.pathname);
	if (!m) return undefined;
	const [, size, base, ext] = m as unknown as [string, string, string, string];
	if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
	if (!bucket) return new Response("Not found", { status: 404 });
	const head = request.method === "HEAD";

	let key = variantKey(base, size);
	let variant = true;
	let obj = await bucket.head(key);
	if (!obj) {
		key = `${base}.${ext}`;
		variant = false;
		obj = await bucket.head(key);
		if (!obj) return new Response("Not found", { status: 404 });
	}
	const headers = new Headers({
		"Content-Type": variant ? "video/mp4" : (obj.httpMetadata?.contentType ?? TYPES[ext] ?? "application/octet-stream"),
		"Cache-Control": variant ? IMMUTABLE : FALLBACK,
		// The Worker cache in front: a size for a year (purged by tag "video" or a deploy), the stand-in not at all.
		"Cloudflare-CDN-Cache-Control": variant ? "public, max-age=31536000" : "no-store",
		...(variant ? { "Cache-Tag": "video" } : {}),
		"Accept-Ranges": "bytes",
		ETag: obj.httpEtag,
		"Last-Modified": obj.uploaded.toUTCString(),
		"X-Content-Type-Options": "nosniff",
		"X-Video": variant ? "size" : "original",
	});
	if (request.headers.get("if-none-match") === obj.httpEtag) return new Response(null, { status: 304, headers });
	const range = parseRange(request.headers.get("range"), obj.size);
	if (range === null) {
		headers.set("Content-Range", `bytes */${obj.size}`);
		return new Response(null, { status: 416, headers });
	}
	if (range) {
		headers.set("Content-Range", `bytes ${range.offset}-${range.offset + range.length - 1}/${obj.size}`);
		headers.set("Content-Length", String(range.length));
		if (head) return new Response(null, { status: 206, headers });
		const part = await bucket.get(key, { range });
		return part ? new Response(part.body, { status: 206, headers }) : new Response("Not found", { status: 404 });
	}
	headers.set("Content-Length", String(obj.size));
	if (head) return new Response(null, { status: 200, headers });
	const whole = await bucket.get(key);
	return whole ? new Response(whole.body, { status: 200, headers }) : new Response("Not found", { status: 404 });
}

/** The page's addresses for a background video: the two sizes when it is an EmDash upload, else the file itself. */
export function videoSources(src: string | undefined): { src?: string; small?: string } {
	if (!src) return {};
	const m = /^\/_emdash\/api\/media\/file\/([A-Za-z0-9_-]{1,80}\.(?:mp4|webm|m4v|mov))$/.exec(src);
	return m ? { src: `/_video/v1/720/${m[1]}`, small: `/_video/v1/480/${m[1]}` } : { src };
}
