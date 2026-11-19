/**
 * Bricks data the extract phase needs beyond post content (docs/spikes/bricks-findings.md):
 * - post meta on pages/posts: `_bricks_page_content_2`, `_bricks_editor_mode`, `_bricks_page_settings`;
 * - `bricks_template` posts with `_bricks_template_type`, `_bricks_template_settings` (conditions) and their
 *   elements in `_bricks_page_header_2` / `_bricks_page_footer_2` / `_bricks_page_content_2`;
 * - options `bricks_color_palette`, `bricks_global_variables`, `bricks_global_classes`, `bricks_theme_styles`,
 *   `bricks_components`, `bricks_breakpoints`, `bricks_global_settings` (BRICKS_OPTIONS).
 *
 * The options are not REST-exposed by WordPress or Bricks. They are read from the exporter's options.json when
 * it includes them, else from raw/bricks-options.json, written by hand with the WP-CLI command below.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRICKS_OPTIONS } from "../adapters/bricks/site.js";
import type { MediaRef } from "./refs.js";

export { BRICKS_OPTIONS };
export const BRICKS_OPTIONS_FILE = "bricks-options.json";

/** Run on the WordPress server (read-only), save the output as sites/<slug>/raw/bricks-options.json. */
export const BRICKS_OPTIONS_WP_CLI = `wp eval 'echo wp_json_encode(array_combine($k = [${BRICKS_OPTIONS.map((k) => `"${k}"`).join(", ")}], array_map(fn($o) => get_option($o, null), $k)));' > bricks-options.json`;

/** Bricks options from the exporter's options.json, completed by raw/bricks-options.json (that file wins). */
export function readBricksOptions(rawDir: string, exporterOptions: Record<string, unknown> = {}): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const k of BRICKS_OPTIONS) if (exporterOptions[k] !== undefined && exporterOptions[k] !== null) out[k] = exporterOptions[k];
	const file = join(rawDir, BRICKS_OPTIONS_FILE);
	if (existsSync(file)) {
		try {
			const manual = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
			for (const k of BRICKS_OPTIONS) if (manual[k] !== undefined && manual[k] !== null) out[k] = manual[k];
		} catch {
			// unreadable file: reported by bricksOptionsNote (missing keys)
		}
	}
	return out;
}

/** True when the extracted content was built with Bricks (any post with Bricks element meta, or Bricks templates). */
export function usesBricks(posts: { post_type: string; meta?: Record<string, unknown> }[]): boolean {
	return posts.some((p) => p.post_type === "bricks_template" || !!p.meta?._bricks_page_content_2 || !!p.meta?._bricks_page_header_2 || !!p.meta?._bricks_page_footer_2);
}

/** Extract note for a Bricks site whose options are incomplete (undefined when nothing is missing). */
export function bricksOptionsNote(options: Record<string, unknown>): string | undefined {
	const missing = BRICKS_OPTIONS.filter((k) => options[k] === undefined && k !== "bricks_global_settings");
	if (!missing.length) return undefined;
	return `Bricks options not in the extract (${missing.join(", ")}): palette colours, global classes, theme style, components and custom breakpoints cannot be resolved. Run on the server (read-only) and save as raw/${BRICKS_OPTIONS_FILE}: ${BRICKS_OPTIONS_WP_CLI}`;
}

/** Settings keys of Bricks elements that hold an image/media control (`{ id, url }`) or a list of them. */
const MEDIA_KEYS = /^(image|images|logo|logoInverse|file|media|videoPoster|previewImageCustom|markerIcon|maskCustom)$/;

/** Attachment ids and upload URLs used by a Bricks element list (for raw/refs.json, via `content:bricks [name key]`). */
export function bricksMediaRefs(elements: unknown): MediaRef[] {
	const out = new Map<string, MediaRef>();
	const add = (r: MediaRef) => out.set(`${r.kind}:${r.value}`, r);
	const visit = (v: unknown, via: string, key = "") => {
		if (Array.isArray(v)) return v.forEach((x) => visit(x, via, key));
		if (!v || typeof v !== "object") return;
		const o = v as Record<string, unknown>;
		if (MEDIA_KEYS.test(key) || key === "background" || key === "_background") {
			const id = Number(o.id);
			if (Number.isInteger(id) && id > 0 && (typeof o.url === "string" || typeof o.full === "string" || typeof o.filename === "string")) add({ kind: "id", value: String(id), via });
			if (typeof o.url === "string" && /\/wp-content\/uploads\//.test(o.url)) add({ kind: "url", value: o.url, via });
		}
		for (const [k, x] of Object.entries(o)) visit(x, via, k);
	};
	for (const e of Array.isArray(elements) ? elements : []) {
		if (!e || typeof e !== "object") continue;
		const el = e as { name?: string; settings?: unknown };
		visit(el.settings, `content:bricks ${el.name ?? "?"}`);
	}
	return [...out.values()];
}
