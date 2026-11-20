/**
 * Menus beyond the header: every WordPress menu becomes an EmDash menu (not only the three roles the starter's header
 * reads), with the item's own CSS classes, title attribute and new-tab target; descriptions (EmDash menus have no field
 * for them) and mega menu panels are reported. Pure helpers shared by transform, scaffold (seed), load and the widget
 * mapping (a WordPress Navigation Menu widget names the EmDash menu its WordPress menu became).
 */
import type { IrMenuItem, IrSite } from "../ir/schema.js";

/** Menu item fields WordPress's REST API adds to the exporter's list (`wp/v2/menu-items`, WP ≥ 5.9, authenticated). */
export interface WpMenuItemRest {
	id: number;
	description?: string;
	attr_title?: string;
	classes?: string[];
	target?: string;
	xfn?: string[];
}

/** Classes WordPress (or a theme) generates on every menu item, and Popup Maker triggers (carried as the item's popup): not the editor's own. */
const GENERATED = /^(?:popmake-\d+|menu-item(?:-[\w-]+)?|current[-_][\w-]+|page[-_]item(?:-\d+)?|page_item(?:_has_children)?|nectar-regular-menu-item|sf-with-ul)$/;

/** The editor's own CSS classes of a menu item (Appearance → Menus → CSS Classes). */
export function ownClasses(classes: string | string[] | null | undefined): string[] {
	const list = (Array.isArray(classes) ? classes : (classes ?? "").split(/\s+/)).map((c) => c.trim()).filter(Boolean);
	return [...new Set(list.filter((c) => !GENERATED.test(c)))];
}

/** Max Mega Menu marks a mega panel on the rendered item: `<li class="mega-menu-item … mega-menu-megamenu … mega-menu-item-123">`. */
export function megaMenuIds(html: string | undefined): Set<number> {
	const ids = new Set<number>();
	if (!html) return ids;
	for (const m of html.matchAll(/<li\b[^>]*\bclass=["']([^"']*)["']/gi)) {
		const cls = m[1] ?? "";
		if (!/\bmega-menu-megamenu\b/.test(cls)) continue;
		const id = /\bmega-menu-item-(\d+)\b/.exec(cls)?.[1];
		if (id) ids.add(Number(id));
	}
	return ids;
}

/** A theme's own mega menu class on a top-level item (Salient `megamenu`, `mega-menu`, Astra `astra-megamenu-li`…). */
export const isMegaClass = (classes: string[]) => classes.some((c) => /^(?:mega-?menu|astra-megamenu(?:-li)?|has-mega-menu|menu-item-mega)$/i.test(c) || /^megamenu(?:-|_)/i.test(c));

/** The EmDash menu name for each IR menu, in order: the first menu of each header role keeps its role name (what the starter reads), every other menu its own slug. */
export function emdashMenuNames(menus: IrSite["menus"]): string[] {
	const taken = new Set<string>(["primary", "secondary", "footer"]);
	const roleUsed = new Set<string>();
	return menus.map((m) => {
		if (m.role !== "other" && !roleUsed.has(m.role)) {
			roleUsed.add(m.role);
			return m.role;
		}
		const base = (m.name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "menu").slice(0, 60);
		let name = base;
		for (let n = 2; taken.has(name); n++) name = `${base}-${n}`;
		taken.add(name);
		return name;
	});
}

/** Admin label of an EmDash menu. */
export function emdashMenuLabel(name: string, menu?: IrSite["menus"][number]): string {
	if (["primary", "secondary", "footer"].includes(name)) return `${name[0]?.toUpperCase()}${name.slice(1)} navigation`;
	return menu?.name ?? name;
}

/** Deepest nesting level of a menu (1 = flat). */
export function menuDepth(items: IrMenuItem[]): number {
	return items.length ? 1 + Math.max(...items.map((i) => menuDepth(i.children))) : 0;
}

const walk = (items: IrMenuItem[], f: (i: IrMenuItem, depth: number) => void, depth = 1) => {
	for (const i of items) {
		f(i, depth);
		walk(i.children, f, depth + 1);
	}
};

/** Coverage report section: every menu, where it went, and what EmDash has no field for. */
export function menusReport(menus: IrSite["menus"]): string[] {
	if (!menus.length) return [];
	const names = emdashMenuNames(menus);
	const L = ["", "## Menus", "", "Every WordPress menu is written to EmDash (Menus in the admin). The header reads `primary` (main navigation) and `secondary` (header links and buttons); a classic footer without a footer site part shows `footer`.", "", "| WordPress menu | Locations | EmDash menu | Items | Depth | Notes |", "|---|---|---|---|---|---|"];
	for (const [i, m] of menus.entries()) {
		let count = 0;
		const notes: string[] = [];
		const descriptions: string[] = [];
		const mega: string[] = [];
		walk(m.items, (it) => {
			count++;
			if (it.description) descriptions.push(`“${it.label}”: ${it.description.replace(/\s+/g, " ").slice(0, 80)}`);
			if (it.mega) mega.push(it.label);
		});
		if (mega.length) notes.push(`mega menu ${mega.map((x) => `“${x}”`).join(", ")}: partial, rebuilt as columns of links (images, widgets and custom HTML in the panel are not carried)`);
		if (descriptions.length) notes.push(`descriptions not carried (EmDash menu items have no description): ${descriptions.join("; ")}`);
		if (menuDepth(m.items) > 2) notes.push("more than two levels: the header shows the third level nested in the menu panel");
		L.push(`| ${m.name} | ${m.wpLocations.join(", ") || "—"} | \`${names[i]}\` | ${count} | ${menuDepth(m.items)} | ${notes.join(" · ").replace(/\|/g, "\\|") || "—"} |`);
	}
	return L;
}

/** Items of a menu that are mega panels (for the transform log). */
export function megaItems(menus: IrSite["menus"]): string[] {
	const out: string[] = [];
	for (const m of menus) walk(m.items, (i) => i.mega && out.push(`${m.name} → ${i.label}`));
	return out;
}
