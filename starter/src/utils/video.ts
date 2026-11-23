/**
 * Background videos in web sizes, served from Cloudflare's cache (docs/spikes/video-findings.md).
 *
 *   /_video/v1/720/<storage key>  → R2 `_video/v1/<base>/720.mp4` (desktop, tablets)
 *   /_video/v1/480/<storage key>  → R2 `_video/v1/<base>/480.mp4` (phones)
 *
 * The sizes are made by the kit (`wp2emdash videos <slug>`, and the load phase) with ffmpeg: H.264, no sound, index
 * first. A size not made yet falls back to the uploaded file (short cache, so the size takes over once it exists).
 *
 * Why here and not EmDash's media route: a player asks for byte ranges, EmDash serves those straight from R2 on every
 * request (a 206 cannot be stored with cache.put). This handler stores the whole file once per data centre and lets
 * cache.match answer each range from it (Cloudflare's Cache API returns a 206 for a Range request against a stored
 * 200 with Content-Length). Runs before Astro: no page render, no database.
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
interface Ctx {
	waitUntil(p: Promise<unknown>): void;
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
export async function serveVideo(request: Request, bucket: VideoBucket | undefined, ctx?: Ctx, cache: Cache | undefined = (globalThis as { caches?: { default?: Cache } }).caches?.default): Promise<Response | undefined> {
	const url = new URL(request.url);
	const m = ROUTE.exec(url.pathname);
	if (!m) return undefined;
	const [, size, base, ext] = m as unknown as [string, string, string, string];
	if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
	if (!bucket) return new Response("Not found", { status: 404 });
	const head = request.method === "HEAD";
	const cacheUrl = `${url.origin}${url.pathname}`;

	if (cache) {
		const ask = new Headers();
		for (const h of ["range", "if-none-match", "if-modified-since"]) {
			const v = request.headers.get(h);
			if (v) ask.set(h, v);
		}
		const hit = await cache.match(new Request(cacheUrl, { headers: ask })).catch(() => undefined);
		if (hit) {
			const headers = new Headers(hit.headers);
			headers.set("X-Video", "size; cached");
			return new Response(head ? null : hit.body, { status: hit.status, headers });
		}
	}

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
		"Accept-Ranges": "bytes",
		ETag: obj.httpEtag,
		"Last-Modified": obj.uploaded.toUTCString(),
		"X-Content-Type-Options": "nosniff",
		"X-Video": variant ? "size" : "original",
	});
	if (request.headers.get("if-none-match") === obj.httpEtag) return new Response(null, { status: 304, headers });

	// Store the whole size once in this data centre (a fresh read: its length is known, which cache.match needs to
	// answer ranges). Only from the start of a play, so a seek does not trigger a second copy.
	const range = parseRange(request.headers.get("range"), obj.size);
	if (variant && cache && ctx && !head && (!range || range.offset === 0)) {
		ctx.waitUntil(
			bucket.get(key).then((full) => {
				if (!full) return;
				const h = new Headers(headers);
				h.set("Content-Length", String(full.size));
				h.delete("X-Video");
				return cache.put(cacheUrl, new Response(full.body, { status: 200, headers: h }));
			}).catch(() => {}),
		);
	}

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
