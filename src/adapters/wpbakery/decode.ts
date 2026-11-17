/** Decoders for WPBakery attribute formats. */

const safeDecode = (s: string) => {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
};

/** `url:https%3A%2F%2F…|title:Read%20more|target:_blank|rel:nofollow` */
export function decodeVcLink(v: string | undefined): { url?: string; title?: string; target?: string; rel?: string } {
	if (!v) return {};
	if (!v.includes("url:") && !v.includes("|")) return { url: v };
	const out: Record<string, string> = {};
	for (const part of v.split("|")) {
		const i = part.indexOf(":");
		if (i > 0) out[part.slice(0, i)] = safeDecode(part.slice(i + 1));
	}
	return out;
}

/** vc_raw_html / vc_raw_js body: base64 of URL-encoded HTML (wpautop may have wrapped it in <p>). */
export function decodeRawHtml(body: string): string {
	const b64 = body.replace(/<\/?p>|<br\s*\/?>|\s/g, "");
	if (!b64) return "";
	try {
		return safeDecode(Buffer.from(b64, "base64").toString("utf8"));
	} catch {
		return body;
	}
}

/** `.vc_custom_123{padding-top: 50px !important;…}` → declarations. */
export function parseVcCss(css: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	const body = /\{([^}]*)\}/.exec(css ?? "")?.[1];
	if (!body) return out;
	for (const decl of body.split(";")) {
		const i = decl.indexOf(":");
		if (i > 0) out[decl.slice(0, i).trim().toLowerCase()] = decl.slice(i + 1).replace(/!important/g, "").trim();
	}
	return out;
}

/** "1/2" → 0.5; "5/12" → 0.4166; vc_col-sm-6 → 0.5. */
export function columnFraction(width: string | undefined): number {
	if (!width) return 1;
	const m = /^(\d+)\/(\d+)$/.exec(width.trim());
	if (m) return Number(m[1]) / Number(m[2]);
	const sm = /vc_col-\w+-(\d+)/.exec(width);
	if (sm) return Number(sm[1]) / 12;
	return 1;
}

/** Map vertical padding (px/%/vh) to the spacing enum. Percent of a 1440px wide row, vh of 900px. */
export function spacingFromPadding(top?: string, bottom?: string): "none" | "compact" | "normal" | "spacious" | undefined {
	const px = (v?: string) => {
		if (!v) return undefined;
		const n = Number.parseFloat(v);
		if (!Number.isFinite(n)) return undefined;
		if (v.endsWith("%")) return (n / 100) * 1440;
		if (v.endsWith("vh")) return (n / 100) * 900;
		return n;
	};
	const t = px(top);
	const b = px(bottom);
	if (t === undefined && b === undefined) return undefined;
	const avg = ((t ?? b ?? 0) + (b ?? t ?? 0)) / 2;
	if (avg <= 4) return "none";
	if (avg < 48) return "compact";
	if (avg < 120) return "normal";
	return "spacious";
}

/** Salient/WPBakery colour values: hex, rgb(a), or theme names ("Accent-Color", "extra-color-1"). */
export function colourValue(v: string | undefined): string | undefined {
	if (!v) return undefined;
	const t = v.trim();
	if (/^#([0-9a-f]{3,8})$/i.test(t) || /^rgba?\(/i.test(t) || /^hsla?\(/i.test(t)) return t;
	if (/accent|extra-color|color_scheme/i.test(t)) return `var(--color-${t.toLowerCase().replace(/[^a-z0-9]+/g, "-")})`;
	return undefined;
}

/** Light/dark: luminance of a hex/rgb colour. */
export function isDarkColour(c: string | undefined): boolean | undefined {
	if (!c) return undefined;
	let r: number;
	let g: number;
	let b: number;
	const hex = /^#([0-9a-f]{6}|[0-9a-f]{3})(?:[0-9a-f]{2})?$/i.exec(c.trim()) ?? /^#([0-9a-f]{6})/i.exec(c.trim());
	if (hex?.[1]) {
		const h = hex[1].length === 3 ? [...hex[1]].map((x) => x + x).join("") : hex[1];
		[r, g, b] = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
	} else {
		const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i.exec(c);
		if (!m) return undefined;
		[r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
	}
	return 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
}
