/**
 * Web sizes of a site's videos (docs/spikes/video-findings.md): 720p for desktops and tablets, 480p for phones,
 * H.264 without sound, at most 24 frames a second, index first. Stored in the site's media bucket next to the upload
 * (`_video/v1/<base>/<size>.mp4`) and served by the project's /_video route (starter/src/utils/video.ts), which falls
 * back to the upload while a size is missing. The upload itself is never changed.
 *
 * Everything goes through Wrangler in the project (the database is read, the bucket written): no EmDash token.
 * A record in sites/<slug>/load/video-sizes.json keeps a video from being encoded twice.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Bump with the route (/_video/v1/…) when the settings change, so browsers holding the old files get the new ones. */
export const VIDEO_SIZES_VERSION = "v1";
export const VIDEO_SIZES = [
	{ size: "720", height: 720, crf: 30 },
	{ size: "480", height: 480, crf: 30 },
] as const;

export const sizeKey = (storageKey: string, size: string) => `_video/${VIDEO_SIZES_VERSION}/${storageKey.replace(/\.[^.]+$/, "")}/${size}.mp4`;

/** ffmpeg arguments for one size (never upscaled). */
export function encodeArgs(src: string, dst: string, s: { height: number; crf: number }): string[] {
	return ["-v", "error", "-y", "-i", src, "-map", "0:v:0", "-an", "-sn", "-dn", "-map_metadata", "-1", "-vf", `scale=-2:'min(${s.height},ih)',fps='min(24,source_fps)'`, "-c:v", "libx264", "-preset", "slow", "-crf", String(s.crf), "-pix_fmt", "yuv420p", "-movflags", "+faststart", dst];
}

export interface VideoRow {
	id: string;
	filename: string;
	storageKey: string;
	size: number;
}
export interface SizesRecord {
	version: string;
	videos: Record<string, { at: string; original: number; sizes: Record<string, number> }>;
}

/** Videos still to do: storage keys EmDash serves from this bucket, not in the record (or all with force). */
export function videosToDo(rows: VideoRow[], record: SizesRecord | undefined, force = false): VideoRow[] {
	const SAFE = /^[A-Za-z0-9_-]{1,80}\.(mp4|webm|m4v|mov)$/i;
	return rows.filter((r) => SAFE.test(r.storageKey) && (force || record?.version !== VIDEO_SIZES_VERSION || !record.videos[r.storageKey]));
}

/** Wrangler names from the project's wrangler.jsonc: the EmDash database and media bucket. */
export function projectBindings(project: string): { db?: string; bucket?: string } {
	const f = join(project, "wrangler.jsonc");
	if (!existsSync(f)) return {};
	const text = readFileSync(f, "utf8");
	const db = /"binding"\s*:\s*"DB"\s*,\s*"database_name"\s*:\s*"([^"]+)"/.exec(text)?.[1];
	const bucket = /"binding"\s*:\s*"MEDIA"\s*,\s*"bucket_name"\s*:\s*"([^"]+)"/.exec(text)?.[1];
	return { ...(db ? { db } : {}), ...(bucket ? { bucket } : {}) };
}

export interface VideoRunner {
	/** Video rows of the EmDash media table (read-only). */
	list(project: string, db: string, remote: boolean): { rows: VideoRow[] } | { error: string };
	get(project: string, bucket: string, key: string, file: string, remote: boolean): string | undefined;
	put(project: string, bucket: string, key: string, file: string, remote: boolean): string | undefined;
	encode(src: string, dst: string, s: { height: number; crf: number }): string | undefined;
}

const wrangler = (project: string, args: string[]) => spawnSync("npx", ["wrangler", ...args], { cwd: project, encoding: "utf8", env: { ...process.env, CI: "1", FORCE_COLOR: "0" }, maxBuffer: 64 * 1024 * 1024 });
const fail = (r: ReturnType<typeof spawnSync>) => (r.error ? r.error.message : r.status !== 0 ? String(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ") || `exit ${r.status}` : undefined);

export const defaultVideoRunner: VideoRunner = {
	list(project, db, remote) {
		const r = wrangler(project, ["d1", "execute", db, remote ? "--remote" : "--local", "--json", "--command", "SELECT id, filename, storage_key, size FROM media WHERE mime_type LIKE 'video/%'"]);
		const err = fail(r);
		if (err) return { error: err };
		try {
			const out = String(r.stdout);
			const j = JSON.parse(out.slice(out.indexOf("["))) as { results?: { id: string; filename: string; storage_key: string; size: number }[] }[];
			return { rows: (j[0]?.results ?? []).map((x) => ({ id: x.id, filename: x.filename, storageKey: x.storage_key, size: x.size })) };
		} catch (e) {
			return { error: `could not read the media list: ${(e as Error).message}` };
		}
	},
	get: (project, bucket, key, file, remote) => fail(wrangler(project, ["r2", "object", "get", `${bucket}/${key}`, "--file", file, remote ? "--remote" : "--local"])),
	put: (project, bucket, key, file, remote) => fail(wrangler(project, ["r2", "object", "put", `${bucket}/${key}`, "--file", file, "--content-type", "video/mp4", "--cache-control", "public, max-age=31536000, immutable", remote ? "--remote" : "--local"])),
	encode(src, dst, s) {
		const r = spawnSync("ffmpeg", encodeArgs(src, dst, s), { encoding: "utf8" });
		if (r.error) return (r.error as NodeJS.ErrnoException).code === "ENOENT" ? "ffmpeg not installed" : r.error.message;
		return r.status !== 0 ? r.stderr.trim().split("\n")[0] || `ffmpeg exited ${r.status}` : undefined;
	},
};

export interface VideoSizesResult {
	done: { filename: string; storageKey: string; original: number; sizes: Record<string, number> }[];
	skipped: number;
	errors: string[];
}

/** Make and store the missing sizes; the record is written after each video. */
export function makeVideoSizes(o: { project: string; recordFile: string; remote: boolean; force?: boolean; runner?: VideoRunner; log?: (m: string) => void }): VideoSizesResult {
	const runner = o.runner ?? defaultVideoRunner;
	const { db, bucket } = projectBindings(o.project);
	if (!db || !bucket) return { done: [], skipped: 0, errors: ["wrangler.jsonc has no DB database or MEDIA bucket"] };
	const listed = runner.list(o.project, db, o.remote);
	if ("error" in listed) return { done: [], skipped: 0, errors: [`media list: ${listed.error}`] };
	let record: SizesRecord | undefined;
	try {
		record = existsSync(o.recordFile) ? (JSON.parse(readFileSync(o.recordFile, "utf8")) as SizesRecord) : undefined;
	} catch {
		record = undefined;
	}
	const rec: SizesRecord = record?.version === VIDEO_SIZES_VERSION ? record : { version: VIDEO_SIZES_VERSION, videos: {} };
	const todo = videosToDo(listed.rows, record, o.force);
	const result: VideoSizesResult = { done: [], skipped: listed.rows.length - todo.length, errors: [] };
	for (const row of todo) {
		const dir = mkdtempSync(join(tmpdir(), "wp2emdash-video-"));
		try {
			const src = join(dir, "original");
			o.log?.(`${row.filename}: downloading ${(row.size / 1e6).toFixed(1)} MB`);
			const gerr = runner.get(o.project, bucket, row.storageKey, src, o.remote);
			if (gerr) throw new Error(`download: ${gerr}`);
			const sizes: Record<string, number> = {};
			for (const s of VIDEO_SIZES) {
				const dst = join(dir, `${s.size}.mp4`);
				const eerr = runner.encode(src, dst, s);
				if (eerr) throw new Error(`${s.size}p: ${eerr}`);
				sizes[s.size] = statSync(dst).size;
				const perr = runner.put(o.project, bucket, sizeKey(row.storageKey, s.size), dst, o.remote);
				if (perr) throw new Error(`${s.size}p upload: ${perr}`);
				o.log?.(`${row.filename}: ${s.size}p ${(sizes[s.size]! / 1e6).toFixed(2)} MB`);
			}
			rec.videos[row.storageKey] = { at: new Date().toISOString(), original: row.size, sizes };
			writeFileSync(o.recordFile, `${JSON.stringify(rec, null, "\t")}\n`);
			result.done.push({ filename: row.filename, storageKey: row.storageKey, original: row.size, sizes });
		} catch (e) {
			result.errors.push(`${row.filename}: ${(e as Error).message}`);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
	return result;
}
