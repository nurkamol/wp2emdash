/** Small helpers shared by the backup run, the restore planner and the views. */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const dayOf = (t: number | string | Date) => new Date(t).toISOString().slice(0, 10);
export const monthOf = (t: number | string | Date) => new Date(t).toISOString().slice(0, 7);
export const shortTime = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A stable small number from a string (FNV-1a), used to spread the nightly run over the hour per site. */
export function hash32(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

export const randomHex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");

export const hex = (buf: ArrayBuffer | Uint8Array) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
export async function sha256Hex(data: string | Uint8Array<ArrayBuffer>): Promise<string> {
	return hex(await crypto.subtle.digest("SHA-256", typeof data === "string" ? new TextEncoder().encode(data) : data));
}

/** gzip (CompressionStream: Workers and Node ≥ 18). */
export async function gzip(text: string): Promise<Uint8Array<ArrayBuffer>> {
	const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}
export async function gunzip(bytes: Uint8Array<ArrayBuffer> | ArrayBuffer): Promise<string> {
	const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
	return await new Response(stream).text();
}

export function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
	return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const EMAIL = /^[^\s@<>,;"]{1,64}@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
export const isEmail = (s: string) => s.length <= 254 && EMAIL.test(s);
