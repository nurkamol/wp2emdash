/**
 * Customizer "Additional CSS". WordPress prints it as `<style id="wp-custom-css">` in every page's head (the active
 * theme's `custom_css` post). Extract saves it (raw/custom-css.json); transform reports its size and the selectors it
 * targets and gates on a decision (overrides.ts `customCss: "carry" | "drop"`); with "carry", scaffold writes it to its
 * own stylesheet, loaded after the starter's CSS (never inline: the CSP and the editor's CSS stay clean).
 */
import { createHash } from "node:crypto";

export interface CustomCss {
	/** live-html = the audit's saved pages; exporter = the theme's custom_css post. */
	source: "live-html" | "exporter";
	css: string;
	/** Other themes' custom_css posts (not active, not carried): slug + size. */
	inactive?: { slug: string; bytes: number }[];
}

/** The Additional CSS a WordPress page prints, if any. */
export function customCssFromHtml(html: string): string | undefined {
	const m = /<style[^>]*\bid=["']wp-custom-css["'][^>]*>([\s\S]*?)<\/style>/i.exec(html);
	const css = m?.[1]?.trim();
	return css || undefined;
}

export interface CssSummary {
	bytes: number;
	rules: number;
	/** Distinct selectors (comma lists split), in order of appearance. */
	selectors: string[];
	/** Media queries used. */
	media: string[];
	/** url(...) references to the WordPress uploads folder (redirected by the middleware, one extra hop). */
	uploads: string[];
	/** @import / external url(): blocked by the Content-Security-Policy unless allowed. */
	external: string[];
}

export function describeCss(css: string): CssSummary {
	const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
	const selectors: string[] = [];
	const media: string[] = [];
	let rules = 0;
	for (const m of clean.matchAll(/([^{}@;]+)\{[^{}]*\}/g)) {
		rules++;
		for (const s of (m[1] as string).split(",").map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean)) if (!/^(?:from|to|\d+%)$/.test(s) && !selectors.includes(s)) selectors.push(s);
	}
	for (const m of clean.matchAll(/@media([^{]+)\{/g)) {
		const q = (m[1] as string).replace(/\s+/g, " ").trim();
		if (!media.includes(q)) media.push(q);
	}
	const urls = [...clean.matchAll(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g)].map((m) => m[1] as string);
	const imports = [...clean.matchAll(/@import\s+(?:url\()?\s*['"]?([^'");\s]+)/g)].map((m) => m[1] as string);
	return {
		bytes: Buffer.byteLength(css, "utf8"),
		rules,
		selectors,
		media,
		uploads: urls.filter((u) => /\/wp-content\/uploads\//.test(u)),
		external: [...new Set([...imports, ...urls.filter((u) => /^(?:https?:)?\/\//.test(u) && !/\/wp-content\/uploads\//.test(u))])],
	};
}

export function customCssReport(found: CustomCss | undefined, decision: "carry" | "drop" | undefined): string[] {
	if (!found) return [];
	const d = describeCss(found.css);
	const L = ["", "## Additional CSS (Customizer)", "", `${(d.bytes / 1024).toFixed(1)} KB, ${d.rules} rules, ${d.selectors.length} selectors (from the ${found.source === "live-html" ? "live pages" : "theme's custom_css post"}). Decision: **${decision ?? "undecided"}** (\`overrides.ts → customCss: "carry" | "drop"\`). Carried CSS goes to its own stylesheet, loaded after the starter's CSS; selectors written for the WordPress theme rarely match the new markup, so review what each rule did on the old site first.`, ""];
	L.push(`Selectors: ${d.selectors.slice(0, 40).map((s) => `\`${s.replace(/`/g, "'")}\``).join(", ")}${d.selectors.length > 40 ? `, … (${d.selectors.length - 40} more)` : ""}`);
	if (d.media.length) L.push("", `Media queries: ${d.media.map((m) => `\`${m}\``).join(", ")}`);
	if (d.uploads.length) L.push("", `Images from the uploads folder (redirected to the media library when uploaded): ${d.uploads.map((u) => `\`${u}\``).join(", ")}`);
	if (d.external.length) L.push("", `⚠️ External resources (blocked by the Content-Security-Policy): ${d.external.map((u) => `\`${u}\``).join(", ")}`);
	if (found.inactive?.length) L.push("", `Other themes' Additional CSS (inactive, not carried): ${found.inactive.map((i) => `${i.slug} (${i.bytes} B)`).join(", ")}`);
	return L;
}

/** The carried stylesheet (scaffold → public/styles/): content-hashed name so a change is never served from a stale cache. */
export function customStylesheet(css: string): { file: string; content: string } {
	const hash = createHash("sha256").update(css).digest("hex").slice(0, 10);
	return { file: `custom-${hash}.css`, content: `/* Customizer "Additional CSS" from WordPress, carried by decision (overrides.ts customCss: "carry"). Loaded after the starter's CSS (layouts/Base.astro). */\n${css}\n` };
}
