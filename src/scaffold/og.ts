/**
 * Sharing cards (@wp2emdash/og, experimental): the card's fonts as TrueType files in the project (Satori cannot read
 * WOFF2), its colours from the generated design tokens, the copied logo and the production domain.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OgCardOptions } from "../../packages/og/src/index.js";

/** Renderer packages added to a project with sharing cards (pinned: WebAssembly builds for workerd). */
export const OG_DEPENDENCIES = { "@cf-wasm/satori": "0.4.2", "@cf-wasm/resvg": "0.4.0" } as const;

const tokenOf = (css: string, name: string) => new RegExp(`--${name}:\\s*([^;]+);`).exec(css)?.[1]?.trim();
const rgba = (hex: string, a: number) => {
	const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
	if (!m) return hex;
	const n = Number.parseInt(m[1] as string, 16);
	return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

export function ogColors(tokensCss: string): OgCardOptions["colors"] {
	const text = tokenOf(tokensCss, "color-text") ?? "#1a1a1a";
	return { bg: tokenOf(tokensCss, "color-bg") ?? "#ffffff", text, accent: tokenOf(tokensCss, "color-accent") ?? text, muted: rgba(text, 0.62) };
}

/** TrueType files of the display and body fonts from Google Fonts (css2 serves TTF to a plain request). */
export async function ogFonts(publicDir: string, fonts: { display: string; body: string; displayWeight?: number }, fetcher: typeof fetch = fetch): Promise<OgCardOptions["fonts"]> {
	const family = (f: string, w: number) => `family=${encodeURIComponent(f).replace(/%20/g, "+")}:wght@${w}`;
	const out: Record<"display" | "body", string> = { display: "", body: "" };
	mkdirSync(join(publicDir, "fonts"), { recursive: true });
	for (const [slot, name, weight] of [["display", fonts.display, fonts.displayWeight ?? 500], ["body", fonts.body, 500]] as const) {
		const css = await (await fetcher(`https://fonts.googleapis.com/css2?${family(name, weight)}`)).text();
		const url = /url\((https:[^)]+\.ttf)\)/.exec(css)?.[1];
		if (!url) throw new Error(`no TrueType file for ${name} ${weight} on Google Fonts`);
		const res = await fetcher(url);
		if (!res.ok) throw new Error(`${name}: HTTP ${res.status}`);
		writeFileSync(join(publicDir, "fonts", `og-${slot}.ttf`), Buffer.from(await res.arrayBuffer()));
		out[slot] = `/fonts/og-${slot}.ttf`;
	}
	return out;
}
