/**
 * `wp2emdash changes <slug> [--json]`: what changed in WordPress between the last two extracts (src/extract/changes.ts).
 * Reads raw/manifest.previous.json and raw/manifest.json; never contacts WordPress.
 */
import { siteExists, sitePaths } from "../core/paths.js";
import { type ChangeSet, formatChanges, siteChanges } from "../extract/changes.js";

export interface ChangesResult {
	slug: string;
	changes?: ChangeSet;
	/** Why there is nothing to compare (no extract yet, only one, or one made by an older kit). */
	reason?: string;
}

export function changesCommand(slug: string, sitesDir?: string): ChangesResult {
	if (!siteExists(slug, sitesDir)) throw new Error(`No site "${slug}" (sites/${slug}/kit.config.ts not found).`);
	const r = siteChanges(sitePaths(slug, sitesDir).raw);
	return { slug, ...r };
}

export function changesText(r: ChangesResult): string {
	if (!r.changes) return r.reason ?? "Nothing to compare.";
	const c = r.changes;
	const next = c.total ? "\nNext: run transform, scaffold and load; pages edited in the EmDash admin since the last load are kept and listed (load --overwrite-edited replaces them)." : "";
	return `${formatChanges(c)}${next}`;
}
