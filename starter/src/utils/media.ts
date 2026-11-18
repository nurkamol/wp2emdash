/**
 * URL of a local EmDash media value, built the way EmDash's own Media component does
 * (storage key, then URL, then id). Used where Media's fixed markup does not fit: a background
 * video must autoplay without controls and show its poster until the first frame.
 */
const PREFIX = "/_emdash/api/media/file/";
const SAFE = /^[\w.-]+$/;

export function mediaUrl(value: unknown, resolve?: (key: string) => string): string | undefined {
	if (!value) return undefined;
	if (typeof value === "string") return value;
	const v = value as { id?: string; src?: string; provider?: string; meta?: { storageKey?: unknown } };
	if (v.provider && v.provider !== "local") return v.src;
	const key = typeof v.meta?.storageKey === "string" && SAFE.test(v.meta.storageKey) ? v.meta.storageKey : undefined;
	if (key) return resolve ? resolve(key) : `${PREFIX}${key}`;
	if (v.src) {
		const k = v.src.startsWith(PREFIX) ? v.src.slice(PREFIX.length) : undefined;
		return resolve && k && SAFE.test(k) ? resolve(k) : v.src;
	}
	return v.id && SAFE.test(v.id) ? `${PREFIX}${v.id}` : undefined;
}
