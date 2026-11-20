/**
 * Optimize: a smaller original, in place.
 *
 * - Bytes are read with the plugin media API (`media.readBytes`, capability `media:bytes:read`, at most 16 MB).
 * - The Cloudflare Images binding (`env.IMAGES`, added by @astrojs/cloudflare) resizes and re-encodes:
 *   `IMAGES.input(stream).transform({ width, height, fit: "scale-down" }).output({ format, quality })` → `.image()`.
 *   Each call is one "unique transformation" (5,000 a month free per account).
 * - The old file is kept 30 days in the site's R2 bucket under `backups/media-originals/<id>/` (EmDash's public media
 *   route refuses every key under `backups/`; a top-level prefix would be downloadable).
 * - The new bytes replace the file through EmDash's own "Replace original" route (`PUT /_emdash/api/media/:id/replace`)
 *   as the editor who clicked: same media id, same storage key and URL, so every page keeps pointing at it. That
 *   route accepts only JPEG, PNG and WebP and only the SAME type, so a format change is never done in place — it is
 *   reported instead (visitors already get WebP/AVIF from `/_image`). It also clears the focal point, blurhash and
 *   dominant colour; the focal point is put back afterwards.
 */
import type { MediaLimits } from "./index.js";
import type { MediaRow } from "./scan.js";

export const REPLACEABLE = ["image/jpeg", "image/png", "image/webp"] as const;
export type Replaceable = (typeof REPLACEABLE)[number];
export const BACKUP_PREFIX = "backups/media-originals/";
export const BACKUP_DAYS = 30;
/** The plugin media API reads at most 16 MB. */
export const MAX_READ = 16 * 1024 * 1024;
/** A re-encode that saves less than this share (and does not resize) is not worth replacing the file. */
export const MIN_SAVING = 0.1;

export type Plan = { ok: true; width: number; height: number; format: Replaceable; quality?: number; resize: boolean; why: string } | { ok: false; reason: string };

/** What Optimize would do with one file. Pure. */
export function planOptimize(m: Pick<MediaRow, "mimeType" | "size" | "width" | "height">, L: Pick<MediaLimits, "maxDimension" | "maxImageBytes" | "quality">): Plan {
	if (!m.mimeType.startsWith("image/")) return { ok: false, reason: "Only images can be optimized here (videos: compress before uploading)." };
	if (!(REPLACEABLE as readonly string[]).includes(m.mimeType)) return { ok: false, reason: `${m.mimeType.slice(6).toUpperCase()} files cannot be replaced in place (EmDash replaces JPEG, PNG and WebP only).` };
	if ((m.size ?? 0) > MAX_READ) return { ok: false, reason: "The file is larger than 16 MB, the most a plugin may read. Resize it on a computer and use Replace in the media library." };
	const w = m.width ?? 0;
	const h = m.height ?? 0;
	if (!w || !h) return { ok: false, reason: "The library does not know this image's size." };
	const side = Math.max(w, h);
	const resize = side > L.maxDimension;
	const k = resize ? L.maxDimension / side : 1;
	const width = Math.max(1, Math.round(w * k));
	const height = Math.max(1, Math.round(h * k));
	const format = m.mimeType as Replaceable;
	if (!resize && (m.size ?? 0) <= L.maxImageBytes) return { ok: false, reason: "Already within the limits." };
	if (!resize && format === "image/png") return { ok: false, reason: "A PNG within the size limit cannot get smaller without changing its format (re-encoding a PNG is lossless). Upload a JPEG or WebP instead if it is a photo." };
	return { ok: true, width, height, format, ...(format === "image/png" ? {} : { quality: L.quality }), resize, why: resize ? `${w}×${h} → ${width}×${height} px` : `re-encode at quality ${L.quality}` };
}

export interface ImagesBinding {
	input(stream: ReadableStream<Uint8Array>): { transform(t: Record<string, unknown>): { output(o: { format: string; quality?: number }): Promise<{ image(): ReadableStream<Uint8Array>; contentType(): string }> } };
	info(stream: ReadableStream<Uint8Array>): Promise<{ format: string; width?: number; height?: number; fileSize?: number }>;
}

export interface Bucket {
	put(key: string, value: Uint8Array, o?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
	get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; customMetadata?: Record<string, string>; httpMetadata?: { contentType?: string } } | null>;
	delete(keys: string | string[]): Promise<void>;
	list(o?: { prefix?: string; cursor?: string; limit?: number; include?: ("customMetadata" | "httpMetadata")[] }): Promise<{ objects: { key: string; size: number; uploaded: Date; customMetadata?: Record<string, string> }[]; truncated: boolean; cursor?: string }>;
}

export const streamOf = (b: Uint8Array) =>
	new ReadableStream<Uint8Array>({
		start(c) {
			c.enqueue(b);
			c.close();
		},
	});

export async function bytesOf(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
	return new Uint8Array(await new Response(s).arrayBuffer());
}

/** Transforms with the Images binding; returns the new bytes and their size. */
export async function transform(images: ImagesBinding, bytes: Uint8Array, p: { width: number; height: number; format: string; quality?: number }): Promise<{ bytes: Uint8Array; width: number; height: number }> {
	const out = await images.input(streamOf(bytes)).transform({ width: p.width, height: p.height, fit: "scale-down" }).output({ format: p.format, ...(p.quality ? { quality: p.quality } : {}) });
	const result = await bytesOf(out.image());
	let width = p.width;
	let height = p.height;
	try {
		const info = await images.info(streamOf(result));
		if (info.width && info.height) ({ width, height } = info as { width: number; height: number });
	} catch {}
	return { bytes: result, width, height };
}

const safeName = (f: string) => f.replace(/[^\w.-]+/g, "-").slice(-80) || "file";
export const backupKey = (id: string, at: number, filename: string) => `${BACKUP_PREFIX}${id}/${new Date(at).toISOString().replace(/[:.]/g, "-")}-${safeName(filename)}`;

/** Old-file backups older than 30 days (deleted by the hourly task). Pure. */
export function expiredBackups(objects: { key: string; uploaded: Date; customMetadata?: Record<string, string> }[], now: number): string[] {
	return objects.filter((o) => o.key.startsWith(BACKUP_PREFIX) && Date.parse(o.customMetadata?.until ?? new Date(o.uploaded.getTime() + BACKUP_DAYS * 86400_000).toISOString()) < now).map((o) => o.key);
}

export interface Replacer {
	/** EmDash's Replace original, as the person who confirmed. */
	replace(id: string, file: { bytes: Uint8Array; type: string; filename: string; width: number; height: number }): Promise<void>;
	/** Focal point back after a replace (EmDash clears it). */
	focal?(id: string, x: number, y: number): Promise<void>;
}

export interface OptimizeDeps {
	readBytes(id: string): Promise<{ bytes: Uint8Array; mimeType: string }>;
	images: ImagesBinding;
	bucket: Bucket;
	replacer: Replacer;
	now: number;
	/** Counts Images transformations (the free monthly allowance). */
	counted?: () => Promise<void>;
}

export type OptimizeResult = { id: string; filename: string; status: "done"; before: number; after: number; width: number; height: number; backup: string } | { id: string; filename: string; status: "skipped" | "failed"; reason: string };

export async function optimizeOne(d: OptimizeDeps, m: MediaRow, L: MediaLimits): Promise<OptimizeResult> {
	const p = planOptimize(m, L);
	if (!p.ok) return { id: m.id, filename: m.filename, status: "skipped", reason: p.reason };
	let original: { bytes: Uint8Array; mimeType: string };
	try {
		original = await d.readBytes(m.id);
	} catch {
		return { id: m.id, filename: m.filename, status: "failed", reason: "The file could not be read." };
	}
	if (original.mimeType !== p.format) return { id: m.id, filename: m.filename, status: "skipped", reason: "The stored file type changed since the scan; rescan." };
	let out: { bytes: Uint8Array; width: number; height: number };
	try {
		out = await transform(d.images, original.bytes, p);
		await d.counted?.();
	} catch (e) {
		const code = (e as { code?: number }).code;
		return { id: m.id, filename: m.filename, status: "failed", reason: code === 9422 ? "The account's free monthly image transformations are used up (Cloudflare Images error 9422)." : "The Images binding could not transform the file." };
	}
	if (!p.resize && out.bytes.byteLength > original.bytes.byteLength * (1 - MIN_SAVING)) return { id: m.id, filename: m.filename, status: "skipped", reason: `Re-encoding saves less than ${MIN_SAVING * 100}%: left as it is.` };
	if (p.resize && out.bytes.byteLength >= original.bytes.byteLength) return { id: m.id, filename: m.filename, status: "skipped", reason: "The resized file would not be smaller." };
	const key = backupKey(m.id, d.now, m.filename);
	const until = new Date(d.now + BACKUP_DAYS * 86400_000).toISOString();
	try {
		await d.bucket.put(key, original.bytes, { httpMetadata: { contentType: original.mimeType }, customMetadata: { mediaId: m.id, filename: m.filename.slice(0, 200), width: String(m.width ?? ""), height: String(m.height ?? ""), until } });
	} catch {
		return { id: m.id, filename: m.filename, status: "failed", reason: "The old file could not be kept, so nothing was replaced." };
	}
	try {
		await d.replacer.replace(m.id, { bytes: out.bytes, type: p.format, filename: m.filename, width: out.width, height: out.height });
	} catch (e) {
		await d.bucket.delete(key).catch(() => {});
		return { id: m.id, filename: m.filename, status: "failed", reason: `EmDash refused the replacement${e instanceof Error && e.message ? `: ${e.message.slice(0, 160)}` : ""}.` };
	}
	if (m.focalX !== null && m.focalX !== undefined && m.focalY !== null && m.focalY !== undefined) await d.replacer.focal?.(m.id, m.focalX, m.focalY).catch(() => {});
	return { id: m.id, filename: m.filename, status: "done", before: original.bytes.byteLength, after: out.bytes.byteLength, width: out.width, height: out.height, backup: key };
}

/** Puts a kept original back (same type, its own size). */
export async function restoreOriginal(d: Pick<OptimizeDeps, "bucket" | "replacer">, key: string, m: Pick<MediaRow, "id" | "filename" | "mimeType">): Promise<{ ok: true } | { ok: false; reason: string }> {
	if (!key.startsWith(`${BACKUP_PREFIX}${m.id}/`)) return { ok: false, reason: "That backup belongs to another file." };
	const obj = await d.bucket.get(key);
	if (!obj) return { ok: false, reason: "The kept original is gone (kept 30 days)." };
	const type = obj.httpMetadata?.contentType ?? m.mimeType;
	if (type !== m.mimeType) return { ok: false, reason: "The kept original has another file type." };
	const width = Number(obj.customMetadata?.width);
	const height = Number(obj.customMetadata?.height);
	if (!(width > 0 && height > 0)) return { ok: false, reason: "The kept original has no recorded size." };
	try {
		await d.replacer.replace(m.id, { bytes: new Uint8Array(await obj.arrayBuffer()), type, filename: m.filename, width, height });
	} catch (e) {
		return { ok: false, reason: `EmDash refused it${e instanceof Error && e.message ? `: ${e.message.slice(0, 160)}` : ""}.` };
	}
	return { ok: true };
}
