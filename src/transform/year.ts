/**
 * Footers often type the copyright year by hand ("© 2025"), so it goes stale every January. With
 * `overrides.copyrightYear: "current"` a single year right after © becomes the `{year}` token, which the starter fills
 * with the current year at render time. Ranges ("2019–2025") are left as written.
 */
const COPYRIGHT_YEAR = /((?:©|&copy;|\(c\))\s*)(?:19|20)\d\d(?!\s*[-–—]\s*(?:19|20)?\d\d)/gi;

export function currentYearText(text: string): string {
	return text.replace(COPYRIGHT_YEAR, "$1{year}");
}

/** Every string inside a partial's sections, deep; returns how many strings changed. */
export function currentYear(value: unknown): number {
	let n = 0;
	const walk = (v: unknown): unknown => {
		if (typeof v === "string") {
			const out = currentYearText(v);
			if (out !== v) n++;
			return out;
		}
		if (Array.isArray(v)) {
			for (let i = 0; i < v.length; i++) v[i] = walk(v[i]);
			return v;
		}
		if (v && typeof v === "object") {
			for (const [k, x] of Object.entries(v)) (v as Record<string, unknown>)[k] = walk(x);
			return v;
		}
		return v;
	};
	walk(value);
	return n;
}
