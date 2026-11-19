/**
 * Signature values posted by a form's signature field (see signature-pad.ts for the browser side):
 *
 * - drawn: `<name>` = `data:image/png;base64,…` — a PNG of at most 600×200 pixels and 150 KB, cropped to the strokes;
 * - typed: `<name>_typed` = the signer's full name (the keyboard and no-JavaScript alternative).
 *
 * The endpoint checks the PNG for real (prefix, base64, size before decoding, the 8 signature bytes, the IHDR chunk and
 * its dimensions) before it goes anywhere. Signatures are personal data: nothing here logs them.
 */

export const SIGNATURE_MAX_BYTES = 150_000;
export const SIGNATURE_MAX_WIDTH = 600;
export const SIGNATURE_MAX_HEIGHT = 200;
export const SIGNATURE_TYPED_MAX = 200;
const PREFIX = "data:image/png;base64,";
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** The second input of a signature field: the typed name. */
export const typedName = (field: string) => `${field}_typed`;

/** A file sent with the email (base64 content). */
export interface Attachment {
	filename: string;
	contentType: string;
	/** Base64, no data: prefix. */
	content: string;
}

export type SignatureCheck = { ok: true; base64: string; width: number; height: number; bytes: number } | { ok: false; reason: "not-png-data-url" | "bad-base64" | "too-large" | "not-png" | "bad-dimensions" };

/** Check a posted drawn signature. */
export function checkSignaturePng(value: string): SignatureCheck {
	if (!value.startsWith(PREFIX)) return { ok: false, reason: "not-png-data-url" };
	const base64 = value.slice(PREFIX.length);
	// Size first, from the length alone: nothing larger than the cap is decoded.
	if (base64.length > Math.ceil(SIGNATURE_MAX_BYTES / 3) * 4) return { ok: false, reason: "too-large" };
	if (base64.length % 4 !== 0 || !B64.test(base64)) return { ok: false, reason: "bad-base64" };
	let bin: string;
	try {
		bin = atob(base64);
	} catch {
		return { ok: false, reason: "bad-base64" };
	}
	if (bin.length > SIGNATURE_MAX_BYTES) return { ok: false, reason: "too-large" };
	if (bin.length < 33 || PNG_SIGNATURE.some((b, i) => bin.charCodeAt(i) !== b)) return { ok: false, reason: "not-png" };
	// The first chunk must be IHDR (length 13): width and height are big-endian 32-bit at bytes 16 and 20.
	if (bin.slice(12, 16) !== "IHDR") return { ok: false, reason: "not-png" };
	const u32 = (at: number) => ((bin.charCodeAt(at) << 24) >>> 0) + (bin.charCodeAt(at + 1) << 16) + (bin.charCodeAt(at + 2) << 8) + bin.charCodeAt(at + 3);
	const width = u32(16);
	const height = u32(20);
	if (!width || !height || width > SIGNATURE_MAX_WIDTH || height > SIGNATURE_MAX_HEIGHT) return { ok: false, reason: "bad-dimensions" };
	return { ok: true, base64, width, height, bytes: bin.length };
}

/** A typed signature: a name with at least one letter, no markup characters. */
export function checkTypedSignature(value: string): boolean {
	const v = value.trim();
	return v.length >= 2 && v.length <= SIGNATURE_TYPED_MAX && /\p{L}/u.test(v) && !/[<>\u0000-\u001f]/.test(v);
}

/** A stored attachment shown as an image only if it still is what the endpoint accepted (a PNG within the caps). */
export function attachmentDataUrl(a: Attachment | undefined): string | undefined {
	if (!a || a.contentType !== "image/png" || typeof a.content !== "string") return undefined;
	const url = `${PREFIX}${a.content}`;
	return checkSignaturePng(url).ok ? url : undefined;
}
