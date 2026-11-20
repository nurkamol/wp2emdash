/**
 * Site widgets for site.config.json (`siteWidgets`, read by the starter's components/SiteWidgets.astro and its CSP):
 * kit.config's explicit list, none (`siteWidgets: false`), or what transform recognised in the live pages' site-wide
 * code (ir/site-snippets.json). Only entries the provider registry accepts (known provider, well-formed ID).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { KitConfig } from "../config/schema.js";
import { type SiteWidget, validWidget } from "../providers/registry.js";

export function carriedWidgets(config: KitConfig["siteWidgets"], irDir: string): SiteWidget[] {
	if (config === false) return [];
	let list: unknown = config;
	if (!config) {
		const file = join(irDir, "site-snippets.json");
		try {
			list = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { widgets?: unknown }).widgets : [];
		} catch {
			list = [];
		}
	}
	const out = new Map<string, SiteWidget>();
	for (const w of Array.isArray(list) ? list : []) {
		if (w && typeof w === "object" && validWidget(w as SiteWidget)) out.set(`${(w as SiteWidget).provider}:${(w as SiteWidget).id}`, { provider: (w as SiteWidget).provider, id: (w as SiteWidget).id });
	}
	return [...out.values()];
}
