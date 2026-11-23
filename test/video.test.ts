import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRange, serveVideo, type VideoBucket, videoSources } from "../starter/src/utils/video.js";
import { encodeArgs, makeVideoSizes, sizeKey, type VideoRunner, videosToDo } from "../src/targets/emdash/video-sizes.js";

const bytes = (n: number) => new Uint8Array(n).map((_, i) => i % 256);
function bucket(files: Record<string, Uint8Array>): VideoBucket & { gets: string[] } {
	const gets: string[] = [];
	const meta = (k: string) => ({ size: files[k]!.length, httpEtag: `"${k}"`, uploaded: new Date(0), httpMetadata: { contentType: "video/mp4" } });
	return {
		gets,
		head: async (k) => (files[k] ? meta(k) : null),
		get: async (k, o) => {
			gets.push(k);
			if (!files[k]) return null;
			const b = o?.range ? files[k]!.slice(o.range.offset, o.range.offset + o.range.length) : files[k]!;
			return { ...meta(k), body: new Response(b as BlobPart).body as ReadableStream };
		},
	};
}

describe("video route", () => {
	it("maps EmDash uploads to the two sizes, leaves other addresses alone", () => {
		expect(videoSources("/_emdash/api/media/file/01ABC.mp4")).toEqual({ src: "/_video/v1/720/01ABC.mp4", small: "/_video/v1/480/01ABC.mp4" });
		expect(videoSources("https://cdn.example.com/a.mp4")).toEqual({ src: "https://cdn.example.com/a.mp4" });
		expect(videoSources(undefined)).toEqual({});
	});
	it("parses ranges", () => {
		expect(parseRange(null, 100)).toBeUndefined();
		expect(parseRange("bytes=0-9", 100)).toEqual({ offset: 0, length: 10 });
		expect(parseRange("bytes=90-", 100)).toEqual({ offset: 90, length: 10 });
		expect(parseRange("bytes=-5", 100)).toEqual({ offset: 95, length: 5 });
		expect(parseRange("bytes=0-1000", 100)).toEqual({ offset: 0, length: 100 });
		expect(parseRange("bytes=200-", 100)).toBeNull();
		expect(parseRange("bytes=0-1,5-6", 100)).toBeUndefined();
	});
	it("passes other paths on", async () => {
		expect(await serveVideo(new Request("https://s.test/about"), bucket({}))).toBeUndefined();
		expect(await serveVideo(new Request("https://s.test/_video/v1/720/../x.mp4"), bucket({}))).toBeUndefined();
	});
	it("serves the made size with ranges, immutable, and stores the whole file in the cache", async () => {
		const b = bucket({ "_video/v1/01ABC/720.mp4": bytes(1000) });
		const puts: [string, Response][] = [];
		const cache = { match: async () => undefined, put: async (k: string, r: Response) => void puts.push([k, r]) } as unknown as Cache;
		const waits: Promise<unknown>[] = [];
		const r = (await serveVideo(new Request("https://s.test/_video/v1/720/01ABC.mp4", { headers: { Range: "bytes=0-99" } }), b, { waitUntil: (p) => waits.push(p) }, cache)) as Response;
		expect(r.status).toBe(206);
		expect(r.headers.get("content-range")).toBe("bytes 0-99/1000");
		expect(r.headers.get("cache-control")).toContain("immutable");
		expect(r.headers.get("x-video")).toBe("size");
		expect((await r.arrayBuffer()).byteLength).toBe(100);
		await Promise.all(waits);
		expect(puts).toHaveLength(1);
		expect(puts[0]![0]).toBe("https://s.test/_video/v1/720/01ABC.mp4");
		expect(puts[0]![1].status).toBe(200);
		expect(puts[0]![1].headers.get("content-length")).toBe("1000");
		// A seek further in does not copy the file again.
		await serveVideo(new Request("https://s.test/_video/v1/720/01ABC.mp4", { headers: { Range: "bytes=500-" } }), b, { waitUntil: (p) => waits.push(p) }, cache);
		await Promise.all(waits);
		expect(puts).toHaveLength(1);
	});
	it("answers from the cache when it holds the file", async () => {
		const b = bucket({});
		const cache = { match: async (req: Request) => (req.headers.get("range") ? new Response("x", { status: 206 }) : undefined), put: async () => {} } as unknown as Cache;
		const r = (await serveVideo(new Request("https://s.test/_video/v1/480/01ABC.mp4", { headers: { Range: "bytes=0-0" } }), b, undefined, cache)) as Response;
		expect(r.status).toBe(206);
		expect(r.headers.get("x-video")).toBe("size; cached");
		expect(b.gets).toEqual([]);
	});
	it("falls back to the upload, briefly cached and not stored", async () => {
		const b = bucket({ "01ABC.mp4": bytes(50) });
		const puts: unknown[] = [];
		const cache = { match: async () => undefined, put: async (k: unknown) => void puts.push(k) } as unknown as Cache;
		const r = (await serveVideo(new Request("https://s.test/_video/v1/720/01ABC.mp4"), b, { waitUntil: () => {} }, cache)) as Response;
		expect(r.status).toBe(200);
		expect(r.headers.get("x-video")).toBe("original");
		expect(r.headers.get("cache-control")).toBe("public, max-age=300");
		expect(puts).toEqual([]);
	});
	it("416 past the end, 404 when nothing is there, 304 on a matching ETag", async () => {
		const b = bucket({ "_video/v1/01ABC/720.mp4": bytes(10) });
		expect((await serveVideo(new Request("https://s.test/_video/v1/720/01ABC.mp4", { headers: { Range: "bytes=50-" } }), b, undefined, undefined))!.status).toBe(416);
		expect((await serveVideo(new Request("https://s.test/_video/v1/720/NOPE.mp4"), b, undefined, undefined))!.status).toBe(404);
		expect((await serveVideo(new Request("https://s.test/_video/v1/720/01ABC.mp4", { headers: { "If-None-Match": '"_video/v1/01ABC/720.mp4"' } }), b, undefined, undefined))!.status).toBe(304);
	});
});

describe("video sizes", () => {
	it("never upscales, drops sound, index first", () => {
		const a = encodeArgs("in", "out", { height: 720, crf: 28 }).join(" ");
		expect(a).toContain("scale=-2:'min(720,ih)'");
		expect(a).toContain("-an");
		expect(a).toContain("+faststart");
		expect(sizeKey("01ABC.mp4", "480")).toBe("_video/v1/01ABC/480.mp4");
	});
	it("does each video once", () => {
		const rows = [{ id: "1", filename: "a.mp4", storageKey: "01A.mp4", size: 5 }, { id: "2", filename: "b.mp4", storageKey: "01B.mp4", size: 5 }, { id: "3", filename: "c.mp4", storageKey: "../x.mp4", size: 5 }];
		const rec = { version: "v1", videos: { "01A.mp4": { at: "", original: 5, sizes: {} } } };
		expect(videosToDo(rows, rec).map((r) => r.storageKey)).toEqual(["01B.mp4"]);
		expect(videosToDo(rows, rec, true).map((r) => r.storageKey)).toEqual(["01A.mp4", "01B.mp4"]);
		expect(videosToDo(rows, { version: "v0", videos: rec.videos }).map((r) => r.storageKey)).toEqual(["01A.mp4", "01B.mp4"]);
	});
	it("downloads, encodes both sizes, uploads them next to the upload and records it", () => {
		const dir = mkdtempSync(join(tmpdir(), "vs-"));
		writeFileSync(join(dir, "wrangler.jsonc"), '{"d1_databases": [{"binding":"DB","database_name":"x-db","database_id":"1"}], "r2_buckets": [{"binding":"MEDIA","bucket_name":"x-media"}]}');
		const calls: string[] = [];
		const runner: VideoRunner = {
			list: (_p, db, remote) => (calls.push(`list ${db} ${remote}`), { rows: [{ id: "1", filename: "hero.mp4", storageKey: "01A.mp4", size: 6_000_000 }] }),
			get: (_p, b, k) => void calls.push(`get ${b}/${k}`),
			encode: (_s, dst, s) => (writeFileSync(dst, bytes(s.height)), undefined),
			put: (_p, b, k) => void calls.push(`put ${b}/${k}`),
		};
		const recordFile = join(dir, "rec.json");
		const r = makeVideoSizes({ project: dir, recordFile, remote: true, runner });
		expect(r.errors).toEqual([]);
		expect(r.done[0]!.sizes).toEqual({ "720": 720, "480": 480 });
		expect(calls).toEqual(["list x-db true", "get x-media/01A.mp4", "put x-media/_video/v1/01A/720.mp4", "put x-media/_video/v1/01A/480.mp4"]);
		expect(JSON.parse(readFileSync(recordFile, "utf8")).videos["01A.mp4"].original).toBe(6_000_000);
		expect(makeVideoSizes({ project: dir, recordFile, remote: true, runner }).skipped).toBe(1);
	});
});
