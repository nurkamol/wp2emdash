/** Announcement bar helpers: readable colours (WCAG AA) and the message version a dismissal is remembered for. */

const hex = (c: string | undefined): string | undefined => {
	const v = c?.trim().toLowerCase();
	if (!v) return undefined;
	const m3 = /^#([0-9a-f]{3})$/.exec(v);
	if (m3) return `#${[...(m3[1] as string)].map((x) => x + x).join("")}`;
	return /^#[0-9a-f]{6}$/.test(v) ? v : undefined;
};
const luminance = (h: string) => {
	const lin = (i: number) => {
		const v = Number.parseInt(h.slice(i, i + 2), 16) / 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * lin(1) + 0.7152 * lin(3) + 0.0722 * lin(5);
};
export const contrast = (a: string, b: string) => {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
	return (hi + 0.05) / (lo + 0.05);
};

/**
 * Text colour for a fill: the wanted one when it meets WCAG AA (4.5:1), else white or black, whichever reads
 * better. Colours that are not plain hex (theme tokens, rgba) are left as they are.
 */
export function readableText(fill: string | undefined, wanted: string | undefined): string | undefined {
	const f = hex(fill);
	const w = hex(wanted);
	if (!f) return wanted;
	if (w && contrast(f, w) >= 4.5) return wanted;
	if (!w && wanted) return wanted;
	return contrast(f, "#ffffff") >= contrast(f, "#000000") ? "#ffffff" : "#000000";
}

/**
 * A button fill that keeps its text readable (WCAG AA 4.5:1): the fill as it is when it does, else the same colour
 * darkened (light text) or lightened (dark text) in small steps until it does. Non-hex colours are left as they are.
 */
export function readableFill(fill: string | undefined, text: string | undefined): string | undefined {
	const f = hex(fill);
	const t = hex(text);
	if (!f || !t || contrast(f, t) >= 4.5) return fill;
	const dark = luminance(t) > luminance(f);
	const ch = [1, 3, 5].map((i) => Number.parseInt(f.slice(i, i + 2), 16));
	for (let k = 1; k <= 40; k++) {
		const c = `#${ch.map((v) => Math.round(dark ? v * (1 - k * 0.01) : v + (255 - v) * k * 0.01).toString(16).padStart(2, "0")).join("")}`;
		if (contrast(c, t) >= 4.5) return c;
	}
	return fill;
}

/** Short hash of what the bar says: a new message (or button) shows again to visitors who closed the old one. */
export function announcementVersion(b: { message?: unknown; buttons?: unknown }): string {
	const s = JSON.stringify([b.message ?? [], b.buttons ?? []], (k, v) => (k === "_key" ? undefined : v));
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h.toString(36);
}
