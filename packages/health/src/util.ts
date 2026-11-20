/** Small pure helpers shared by the checks, the views and the report. */

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** UTC day (YYYY-MM-DD) and month (YYYY-MM) of a time. */
export const dayOf = (t: number | string | Date) => new Date(t).toISOString().slice(0, 10);
export const monthOf = (t: number | string | Date) => new Date(t).toISOString().slice(0, 7);

/** The month before `month` (YYYY-MM). */
export function previousMonth(month: string): string {
	const [y, m] = month.split("-").map(Number) as [number, number];
	return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}

/** First instant of a month and of the next one (UTC, ms). */
export function monthRange(month: string): { since: number; until: number } {
	const [y, m] = month.split("-").map(Number) as [number, number];
	return { since: Date.UTC(y, m - 1, 1), until: Date.UTC(y, m, 1) };
}

export const monthName = (month: string) => new Date(`${month}-15T12:00:00Z`).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

export function median(values: number[]): number | undefined {
	const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
	if (!v.length) return undefined;
	const mid = Math.floor(v.length / 2);
	return v.length % 2 ? (v[mid] as number) : Math.round(((v[mid - 1] as number) + (v[mid] as number)) / 2);
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** HTML-escape text for the report and alert emails. */
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** A stable small number from a string (FNV-1a), used to spread work over the day per site. */
export function hash32(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

export async function sha256Hex(text: string): Promise<string> {
	const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
	return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const EMAIL = /^[^\s@<>,;"]{1,64}@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;
export const isEmail = (s: string) => s.length <= 254 && EMAIL.test(s);

/** A duration in words: "4 min", "2 h 5 min", "3 days". */
export function duration(ms: number): string {
	const min = Math.max(0, Math.round(ms / MINUTE));
	if (min < 60) return `${min} min`;
	const h = Math.floor(min / 60);
	if (h < 48) return `${h} h${min % 60 ? ` ${min % 60} min` : ""}`;
	return plural(Math.round(h / 24), "day");
}

export const shortTime = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;

/** Only the path (and query) of a URL on the site, for lists people read; other hosts keep their full address. */
export function shortUrl(url: string, host: string): string {
	try {
		const u = new URL(url);
		return u.host.replace(/^www\./, "") === host.replace(/^www\./, "") ? `${u.pathname}${u.search}` : url;
	} catch {
		return url;
	}
}
