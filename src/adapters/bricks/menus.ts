/**
 * The site menus a Bricks header draws. Bricks themes have no menu locations: a header template places a `nav-menu`
 * element (setting `menu`: the WordPress menu's term id) or a `nav-nested` element that holds its own links
 * (`text-link`, `dropdown` with links inside). Header buttons (calls to action next to the menu) are content elements
 * of the header template. The starter's header reads a primary menu (links) and a secondary menu (buttons when the
 * item is marked `button`), so both are built here. Facts: docs/spikes/bricks-findings.md ("Header menus").
 */
import type { IrMenuItem, Section } from "../../ir/schema.js";
import type { BricksElement } from "./index.js";
import { obj, str } from "./site.js";

/** A WordPress menu as the exporter returns it (`emdash/v1/menus`). */
export interface WpMenuRef {
	id?: number;
	name: string;
}

/** `menu` settings of the nav-menu elements, in document order (the first is the desktop menu as a rule). */
export function navMenuIds(elements: BricksElement[]): string[] {
	return elements.filter((e) => e.name === "nav-menu").flatMap((e) => str(e.settings?.menu) ?? []);
}

/**
 * The menu a Bricks header renders: the live header's `<ul id="menu-<slug>">` when the audit saved the HTML (what
 * WordPress actually printed: a stale menu id falls back to another menu), else the first nav-menu whose id is a
 * menu of the site.
 */
export function headerMenu(menus: WpMenuRef[], elements: BricksElement[], liveHeaderHtml?: string): { menu?: WpMenuRef; via: string } {
	// WordPress prints the menu's slug as the list id; another copy of the same menu on the page gets "-1", "-2"….
	const live = liveHeaderHtml ? [...liveHeaderHtml.matchAll(/<ul\b[^>]*\bid=["']menu-([\w-]+)["']/g)].flatMap((m) => [m[1] as string, (m[1] as string).replace(/-\d+$/, "")]) : [];
	for (const slug of live) {
		const m = menus.find((x) => x.name === slug);
		if (m) return { menu: m, via: `live header HTML (ul#menu-${slug})` };
	}
	for (const id of navMenuIds(elements)) {
		const m = menus.find((x) => String(x.id) === id);
		if (m) return { menu: m, via: `nav-menu element (menu ${id})` };
	}
	const ids = navMenuIds(elements);
	return { via: ids.length ? `nav-menu element(s) name menu ${ids.join(", ")}, not among the site's menus` : "no nav-menu element" };
}

/**
 * Links a `nav-nested` element holds (Bricks 1.8+): `text-link` items and `dropdown` items whose content holds more
 * links (a dropdown's own `link`, if any, is its address; else `#`). Nested navs inside a dropdown are flattened.
 */
export function nestedNavItems(elements: BricksElement[], href: (link: unknown) => { href?: string; newTab?: boolean }): IrMenuItem[] {
	const byId = new Map(elements.map((e) => [e.id, e]));
	const kids = (e: BricksElement) => (e.children ?? []).flatMap((id) => byId.get(String(id)) ?? []);
	const walk = (e: BricksElement, inDropdown: boolean): IrMenuItem[] =>
		kids(e).flatMap((c): IrMenuItem[] => {
			const s = c.settings ?? {};
			if (c.name === "text-link") {
				const l = href(s.link);
				const label = (str(s.text) ?? "").replace(/<[^>]+>/g, "").trim();
				return l.href && label ? [{ label, href: l.href, ...(l.newTab ? { newTab: true } : {}), children: [] }] : [];
			}
			if (c.name === "dropdown" && !inDropdown) {
				const label = (str(s.text) ?? "").replace(/<[^>]+>/g, "").trim();
				const l = href(s.link);
				const children = walk(c, true);
				return label ? [{ label, href: l.href ?? children[0]?.href ?? "#", ...(l.newTab ? { newTab: true } : {}), children }] : children;
			}
			if (c.name === "toggle" || c.name === "logo") return [];
			return walk(c, inDropdown);
		});
	return elements.filter((e) => e.name === "nav-nested").flatMap((e) => walk(e, false));
}

type Btn = { label: string; href?: string; style?: string; hoverLabel?: string; newTab?: boolean; opensPopup?: string };

/**
 * Header calls to action: the buttons of the migrated header template (any style but plain links), once each.
 * They become the secondary menu, marked as buttons (the starter's header shows them next to the menu toggle).
 */
export function headerButtons(sections: Section[]): IrMenuItem[] {
	const all: Btn[] = [];
	for (const s of sections) {
		const f = s.fields as Record<string, unknown>;
		const lists = [f.buttons, ...(Array.isArray(f.columns) ? (f.columns as unknown[]).map((c) => obj(c)?.buttons) : [])];
		for (const l of lists) if (Array.isArray(l)) all.push(...(l as Btn[]));
	}
	const seen = new Set<string>();
	const out: IrMenuItem[] = [];
	for (const b of all) {
		if (!b?.label || b.style === "link" || (!b.href && !b.opensPopup)) continue;
		const key = `${b.label.toLowerCase()}|${b.href ?? b.opensPopup}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ label: b.label, href: b.href ?? `#${b.opensPopup}`, button: true, ...(b.hoverLabel ? { hoverLabel: b.hoverLabel } : {}), ...(b.newTab ? { newTab: true } : {}), ...(b.opensPopup ? { opensPopup: b.opensPopup } : {}), children: [] });
	}
	return out;
}
