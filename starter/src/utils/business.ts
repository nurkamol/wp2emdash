/**
 * The business's name, address, phone and opening hours as visible footer text (components/BusinessInfo.astro), from
 * the same site.config `structuredData.business` StructuredData.astro publishes as JSON-LD, so the two never disagree.
 * No imports: tests load this file directly.
 */

export interface BusinessAddress {
	streetAddress?: string;
	addressLocality?: string;
	addressRegion?: string;
	postalCode?: string;
	addressCountry?: string;
}
export interface Business {
	type: string;
	name: string;
	email?: string;
	telephone?: string;
	address?: BusinessAddress;
	hasMap?: string;
	openingHours?: string[];
}

/** JSON-LD lists opening hours for LocalBusiness subtypes only (schema.org has none on Organization); the footer follows. */
export const showsHours = (b: Pick<Business, "type" | "openingHours">) => !!b.openingHours?.length && b.type !== "Organization";

/** `tel:` link for a phone as written ("+1 (555) 010-0100 ext. 2" → "tel:+15550100100"); undefined when it has too few digits. */
export function telHref(phone: string | undefined): string | undefined {
	if (!phone) return undefined;
	const main = phone.split(/\s*(?:ext\.?|x|#|;)\s*\d*\s*$/i)[0] ?? phone;
	const digits = main.replace(/\D/g, "");
	if (digits.length < 3) return undefined;
	return `tel:${main.trim().startsWith("+") ? "+" : ""}${digits}`;
}

/** Address lines: street, then "Locality, Region Postcode", then the country when it is a name (not a 2-letter code). */
export function addressLines(a: BusinessAddress | undefined): string[] {
	if (!a) return [];
	const city = [[a.addressLocality, a.addressRegion].filter(Boolean).join(", "), a.postalCode].filter(Boolean).join(" ");
	const country = a.addressCountry && !/^[A-Z]{2,3}$/.test(a.addressCountry) ? a.addressCountry : undefined;
	return [a.streetAddress, city, country].filter((l): l is string => !!l && !!l.trim());
}

/** The business's map link (hasMap), else a Google Maps search for the address; undefined with neither. */
export function mapHref(b: Pick<Business, "hasMap" | "address">): string | undefined {
	if (b.hasMap && /^https?:\/\//i.test(b.hasMap)) return b.hasMap;
	const q = addressLines(b.address).join(", ");
	return q ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}` : undefined;
}

// schema.org day codes ("Mo") and full names ("Monday"), as offsets from Monday.
const DAYS: Record<string, number> = { mo: 0, tu: 1, we: 2, th: 3, fr: 4, sa: 5, su: 6 };
const dayIndex = (t: string) => DAYS[t.trim().slice(0, 2).toLowerCase()];

/** "Mon" in the site's language (2024-01-01 was a Monday). */
function dayName(i: number, locale: string): string {
	try {
		return new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 1 + i)));
	} catch {
		return ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][i] as string;
	}
}

/** "06:00" → "6:00 AM" (en-US), "06:00" (en-GB, de); written as is when it is not a time. */
function timeName(hhmm: string, locale: string): string {
	const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
	if (!m) return hhmm.trim();
	const h = Number(m[1]);
	const min = Number(m[2]);
	if (h > 24 || min > 59) return hhmm.trim();
	try {
		return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit", timeZone: "UTC" }).format(new Date(Date.UTC(2024, 0, 1, h % 24, min)));
	} catch {
		return hhmm.trim();
	}
}

/**
 * "Mo-Fr" → "Mon–Fri", "Mo,We" / "Monday,Wednesday" → "Mon, Wed", "Mo,Tu,We,Th,Fr" → "Mon–Fri", all seven days →
 * "Every day" (English; other languages "Mon–Sun" in their own day names); undefined when it names no day. Runs of three
 * or more consecutive days become a range; a range across the week end ("Fr-Mo") is kept as written.
 */
function formatDays(spec: string, locale: string): string | undefined {
	const parts = spec.split(",").filter((p) => p.trim());
	const days = new Set<number>();
	const wraps: string[] = [];
	for (const p of parts) {
		const [from, to] = p.split("-");
		const a = from ? dayIndex(from) : undefined;
		if (a === undefined) return undefined;
		if (to === undefined) days.add(a);
		else {
			const b = dayIndex(to);
			if (b === undefined) return undefined;
			if (b < a) wraps.push(`${dayName(a, locale)}–${dayName(b, locale)}`);
			else for (let d = a; d <= b; d++) days.add(d);
		}
	}
	if (!days.size && !wraps.length) return undefined;
	if (days.size === 7) return /^en\b/i.test(locale) ? "Every day" : `${dayName(0, locale)}–${dayName(6, locale)}`;
	const out: string[] = [];
	const sorted = [...days].sort((x, y) => x - y);
	for (let n = 0; n < sorted.length; ) {
		let end = n;
		while (end + 1 < sorted.length && sorted[end + 1] === (sorted[end] as number) + 1) end++;
		const first = sorted[n] as number;
		const last = sorted[end] as number;
		if (end - n >= 2) out.push(`${dayName(first, locale)}–${dayName(last, locale)}`);
		else for (let k = n; k <= end; k++) out.push(dayName(sorted[k] as number, locale));
		n = end + 1;
	}
	return [...out, ...wraps].join(", ");
}

/** "06:00-21:00,22:00-23:00" → "6:00 AM–9:00 PM, 10:00 PM–11:00 PM"; undefined when it is not a time range list. */
function formatTimes(spec: string, locale: string): string | undefined {
	const ranges = spec.split(",").map((r) => r.trim()).filter(Boolean);
	if (!ranges.length || !ranges.every((r) => /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(r))) return undefined;
	return ranges.map((r) => r.split("-").map((t) => timeName(t, locale)).join("–")).join(", ");
}

/**
 * One schema.org openingHours value ("Mo-Fr 06:00-21:00", "Monday,Tuesday 09:00-17:00", "Sa 08:00-12:00 Su 10:00-14:00")
 * as readable lines in the site's language. Anything it cannot read is shown as written, never dropped.
 */
export function formatOpeningHours(value: string, locale = "en"): string[] {
	const tokens = value.trim().split(/\s+/).filter(Boolean);
	const lines: string[] = [];
	let days: string | undefined;
	for (const t of tokens) {
		const d = /^[a-z,-]+$/i.test(t) ? formatDays(t, locale) : undefined;
		const times = d ? undefined : formatTimes(t, locale);
		if (d) {
			if (days) lines.push(days); // days with no hours of their own ("Mo-Su" alone)
			days = d;
		} else if (times) {
			lines.push(days ? `${days} ${times}` : times);
			days = undefined;
		} else return [value.trim()];
	}
	if (days) lines.push(days);
	return lines.length ? lines : value.trim() ? [value.trim()] : [];
}

/** Every opening-hours line of the business, in order. */
export const openingHoursLines = (hours: string[] | undefined, locale = "en") => (hours ?? []).flatMap((h) => formatOpeningHours(h, locale));

/** The footer block shows when the business has an address or a phone (with neither there is nothing to show). */
export const hasContact = (b: Business | undefined): b is Business => !!b && (addressLines(b.address).length > 0 || !!telHref(b.telephone));

// JSON escapes (\n between address lines) and tags count as spaces.
const norm = (s: string) => s.replace(/\\[nrt]/g, " ").toLowerCase().replace(/&amp;|&#0?38;/g, "&").replace(/<[^>]*>/g, " ").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * True when the migrated footer (its sections and widget areas, as text or JSON) already shows the street address or the
 * phone number: the footer block is then left out so the address is not printed twice. Street: the house number and the
 * first word of the street ("1 Main St" matches "1 Main Street"), or the whole street when it has no number. Phone: the
 * same last 10 digits (or all, when shorter) in any phone-like run, `tel:` links included.
 */
export function footerShowsContact(b: Pick<Business, "address" | "telephone">, footerText: string): boolean {
	const text = ` ${norm(footerText)} `;
	const street = b.address?.streetAddress ? norm(b.address.streetAddress) : "";
	if (street) {
		const m = /^(\d+[a-z]?) ([a-z0-9]+)/.exec(street);
		if (text.includes(` ${m ? `${m[1]} ${m[2]}` : street} `)) return true;
	}
	const phone = (b.telephone ?? "").replace(/\D/g, "");
	if (phone.length >= 7) {
		const tail = phone.slice(-10);
		for (const run of footerText.match(/\+?\d[\d\s().\-]{5,}\d/g) ?? []) {
			if (run.replace(/\D/g, "").endsWith(tail)) return true;
		}
	}
	return false;
}
