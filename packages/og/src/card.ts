/**
 * The sharing card's layout as a Satori element tree (plain objects, no JSX). Pure: unit-tested in the kit.
 * Long titles get a smaller size so up to ~110 characters fit in three lines.
 */
import type { OgCardOptions } from "./index.js";

export interface CardInput {
	title: string;
	eyebrow?: string;
	domain?: string;
	logo?: string;
	colors: OgCardOptions["colors"];
}

export type Node = { type: string; props: { style?: Record<string, unknown>; children?: unknown; src?: string; height?: number; width?: number } };
const h = (type: string, style: Record<string, unknown>, children?: unknown): Node => ({ type, props: { style, ...(children !== undefined ? { children } : {}) } });

export function titleSize(title: string): number {
	const n = title.length;
	return n > 90 ? 56 : n > 64 ? 64 : n > 40 ? 76 : 88;
}

/**
 * Clean a page title for the card: no trailing site-name part ("Page - Site", "Page | Site City"), collapsed spaces,
 * at most 120 characters.
 */
export function cardTitle(raw: string, siteName: string): string {
	let t = raw.replace(/\s+/g, " ").trim();
	const site = siteName.toLowerCase();
	for (const sep of [" - ", " | ", " – ", " — ", " · "]) {
		const at = t.lastIndexOf(sep);
		if (at > 0 && site && t.slice(at + sep.length).toLowerCase().includes(site)) t = t.slice(0, at).trim();
	}
	return t.length > 120 ? `${t.slice(0, 117).trimEnd()}…` : t || siteName;
}

export function card(c: CardInput): Node {
	return h("div", { width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "72px 80px", background: c.colors.bg, color: c.colors.text, fontFamily: "Body" }, [
		h("div", { display: "flex", alignItems: "center", justifyContent: "space-between" }, [
			c.logo ? { type: "img", props: { src: c.logo, height: 96, style: { height: 96 } } } : h("div", { display: "flex" }, ""),
			c.domain ? h("div", { fontSize: 22, letterSpacing: 4, textTransform: "uppercase", color: c.colors.muted }, c.domain) : h("div", { display: "flex" }, ""),
		]),
		h("div", { display: "flex", flexDirection: "column" }, [
			...(c.eyebrow ? [h("div", { fontSize: 24, letterSpacing: 3, textTransform: "uppercase", color: c.colors.muted, marginBottom: 18 }, c.eyebrow)] : []),
			h("div", { fontFamily: "Display", fontSize: titleSize(c.title), lineHeight: 1.05, maxWidth: 1000 }, c.title),
		]),
		h("div", { display: "flex", height: 10, width: 140, background: c.colors.accent, borderRadius: 5 }),
	]);
}
