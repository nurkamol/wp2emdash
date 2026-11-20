/**
 * Divi data the extract phase needs beyond post content (docs/spikes/divi-findings.md):
 * - Theme Builder: `et_template` posts (which header/body/footer layout applies where) and the `et_header_layout`,
 *   `et_body_layout`, `et_footer_layout` posts holding those layouts as Divi shortcodes; the Divi Library
 *   (`et_pb_layout`: saved layouts, global modules);
 * - options `et_divi` (theme options: accent/text/heading/link colours, fonts, content width) and `et_global_data`
 *   (global colours that attributes name as `gcid-…`). Neither option is REST-exposed: they are read from the
 *   exporter's options.json when present, else from raw/divi-options.json (WP-CLI command below).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const DIVI_TYPES = ["et_template", "et_header_layout", "et_body_layout", "et_footer_layout", "et_theme_builder", "et_pb_layout"] as const;
export const DIVI_OPTIONS = ["et_divi", "et_global_data"] as const;
export const DIVI_OPTIONS_FILE = "divi-options.json";

/** Run on the WordPress server (read-only), save the output as sites/<slug>/raw/divi-options.json. */
export const DIVI_OPTIONS_WP_CLI = `wp eval 'echo wp_json_encode(array_combine($k = [${DIVI_OPTIONS.map((k) => `"${k}"`).join(", ")}], array_map(fn($o) => get_option($o, null), $k)));' > ${DIVI_OPTIONS_FILE}`;

/** Divi options from the exporter's options.json, completed by raw/divi-options.json (that file wins). */
export function readDiviOptions(rawDir: string, exporterOptions: Record<string, unknown> = {}): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const k of DIVI_OPTIONS) if (exporterOptions[k] !== undefined && exporterOptions[k] !== null) out[k] = exporterOptions[k];
	const file = join(rawDir, DIVI_OPTIONS_FILE);
	if (existsSync(file)) {
		try {
			const manual = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
			for (const k of DIVI_OPTIONS) if (manual[k] !== undefined && manual[k] !== null) out[k] = manual[k];
		} catch {
			// unreadable: reported by diviNote (no theme options)
		}
	}
	return out;
}

/** True when the extracted content was built with Divi (builder content, or Theme Builder / Library posts). */
export function usesDivi(posts: { post_type: string; content?: string; meta?: Record<string, unknown> }[]): boolean {
	return posts.some((p) => (DIVI_TYPES as readonly string[]).includes(p.post_type) || p.meta?._et_pb_use_builder === "on" || /\[et_pb_section\b|<!--\s+wp:divi\//.test(p.content ?? ""));
}

/** Extract note for a Divi site: theme options or Theme Builder layouts missing from the extract. */
export function diviNote(posts: { post_type: string; meta?: Record<string, unknown> }[], options: Record<string, unknown>): string | undefined {
	const notes: string[] = [];
	if (options.et_divi === undefined) notes.push(`theme options (et_divi) and global colours (et_global_data) are not in the extract, so gcid-… colours stay unresolved; run on the server (read-only) and save as raw/${DIVI_OPTIONS_FILE}: ${DIVI_OPTIONS_WP_CLI}`);
	const templates = posts.filter((p) => p.post_type === "et_template");
	const layouts = posts.filter((p) => /^et_(header|body|footer)_layout$/.test(p.post_type));
	if (templates.length && !layouts.length) notes.push("Theme Builder templates found but no et_header_layout / et_footer_layout posts (check that the exporter serves those post types)");
	return notes.length ? `Divi: ${notes.join("; ")}.` : undefined;
}
