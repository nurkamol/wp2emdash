/**
 * Elementor data the extract phase needs beyond post content (docs/spikes/elementor-findings.md):
 * - post meta on pages/posts: `_elementor_data` (JSON text), `_elementor_edit_mode` (`builder`),
 *   `_elementor_page_settings`, `_elementor_template_type`;
 * - `elementor_library` posts: Theme Builder templates (header, footer, popup, single…, `_elementor_conditions`),
 *   saved sections/pages, global widgets (type `widget`) and the Kit (type `kit`, global colours and fonts);
 * - option `elementor_active_kit` (which kit is active).
 *
 * The exporter returns every post meta key. The option is not REST-exposed; it is read from the exporter's
 * options.json when present, else from raw/elementor-options.json (WP-CLI command below), else the oldest published
 * kit is used.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { elementorMediaRefs } from "../adapters/elementor/site.js";

export { elementorMediaRefs };
export const ELEMENTOR_OPTIONS = ["elementor_active_kit", "elementor_cpt_support", "elementor_disable_color_schemes", "elementor_disable_typography_schemes"] as const;
export const ELEMENTOR_OPTIONS_FILE = "elementor-options.json";
/** Meta keys whose value is an Elementor element tree (media refs are read from them). */
export const ELEMENTOR_TREE_KEYS = ["_elementor_data"] as const;

/** Run on the WordPress server (read-only), save the output as sites/<slug>/raw/elementor-options.json. */
export const ELEMENTOR_OPTIONS_WP_CLI = `wp eval 'echo wp_json_encode(array_combine($k = [${ELEMENTOR_OPTIONS.map((k) => `"${k}"`).join(", ")}], array_map(fn($o) => get_option($o, null), $k)));' > ${ELEMENTOR_OPTIONS_FILE}`;

/** Elementor options from the exporter's options.json, completed by raw/elementor-options.json (that file wins). */
export function readElementorOptions(rawDir: string, exporterOptions: Record<string, unknown> = {}): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const k of ELEMENTOR_OPTIONS) if (exporterOptions[k] !== undefined && exporterOptions[k] !== null) out[k] = exporterOptions[k];
	const file = join(rawDir, ELEMENTOR_OPTIONS_FILE);
	if (existsSync(file)) {
		try {
			const manual = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
			for (const k of ELEMENTOR_OPTIONS) if (manual[k] !== undefined && manual[k] !== null) out[k] = manual[k];
		} catch {
			// unreadable: reported by elementorNote (no active kit id)
		}
	}
	return out;
}

/** True when the extracted content was built with Elementor (any post with an Elementor tree, or library templates). */
export function usesElementor(posts: { post_type: string; meta?: Record<string, unknown> }[]): boolean {
	return posts.some((p) => p.post_type === "elementor_library" || p.meta?._elementor_edit_mode === "builder");
}

/** Extract note for an Elementor site: kit or Theme Builder templates missing from the extract. */
export function elementorNote(posts: { post_type: string; meta?: Record<string, unknown> }[], options: Record<string, unknown>): string | undefined {
	const library = posts.filter((p) => p.post_type === "elementor_library");
	const notes: string[] = [];
	if (!library.length) notes.push("no elementor_library posts in the extract (Theme Builder header/footer, popups, global widgets and the Kit with the global colours and fonts cannot be read; check that the exporter serves the post type)");
	else if (!library.some((p) => p.meta?._elementor_template_type === "kit")) notes.push("no Elementor Kit post in the extract (global colours and fonts named by the pages cannot be resolved)");
	if (library.length && options.elementor_active_kit === undefined && library.filter((p) => p.meta?._elementor_template_type === "kit").length > 1) notes.push(`several Kit posts and no elementor_active_kit option: the oldest published one is used. For certainty run on the server (read-only) and save as raw/${ELEMENTOR_OPTIONS_FILE}: ${ELEMENTOR_OPTIONS_WP_CLI}`);
	return notes.length ? `Elementor: ${notes.join("; ")}.` : undefined;
}
