/**
 * MP4s whose index (moov) sits after the media data (mdat) cannot start playing until the browser
 * has fetched the end of the file. Background videos should start at once, so the load phase
 * rewrites them index-first with ffmpeg (stream copy, no re-encode) when ffmpeg is installed.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Top-level box types of an MP4, in file order (stops at a malformed box). */
export function topBoxes(bytes: Buffer): string[] {
	const out: string[] = [];
	let at = 0;
	while (at + 8 <= bytes.length) {
		let size = bytes.readUInt32BE(at);
		const type = bytes.toString("latin1", at + 4, at + 8);
		if (size === 1 && at + 16 <= bytes.length) size = Number(bytes.readBigUInt64BE(at + 8));
		else if (size === 0) size = bytes.length - at;
		if (size < 8 || !/^[\w ©]{4}$/.test(type)) break;
		out.push(type);
		at += size;
	}
	return out;
}

/** True when the moov box comes after mdat. */
export function needsFaststart(bytes: Buffer): boolean {
	const boxes = topBoxes(bytes);
	const moov = boxes.indexOf("moov");
	const mdat = boxes.indexOf("mdat");
	return moov > -1 && mdat > -1 && moov > mdat;
}

/** The file rewritten index-first, or the reason it could not be (no ffmpeg, ffmpeg error). */
export function faststart(bytes: Buffer): { bytes: Buffer } | { error: string } {
	const dir = mkdtempSync(join(tmpdir(), "wp2emdash-faststart-"));
	try {
		const src = join(dir, "in.mp4");
		const dst = join(dir, "out.mp4");
		writeFileSync(src, bytes);
		const r = spawnSync("ffmpeg", ["-v", "error", "-y", "-i", src, "-map", "0", "-c", "copy", "-movflags", "+faststart", dst], { encoding: "utf8" });
		if (r.error) return { error: (r.error as NodeJS.ErrnoException).code === "ENOENT" ? "ffmpeg not installed" : r.error.message };
		if (r.status !== 0) return { error: r.stderr.trim().split("\n")[0] || `ffmpeg exited ${r.status}` };
		const out = readFileSync(dst);
		return needsFaststart(out) ? { error: "ffmpeg output still has the index last" } : { bytes: out };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
