import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Kit repository root (where package.json lives). */
export const KIT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const SITES_DIR = process.env.WP2EMDASH_SITES_DIR
	? resolve(process.env.WP2EMDASH_SITES_DIR)
	: join(KIT_ROOT, "sites");

export interface SitePaths {
	root: string;
	config: string;
	state: string;
	overrides: string;
	decisions: string;
	access: string;
	raw: string;
	snapshot: string;
	ir: string;
	project: string;
	reports: string;
	runs: string;
}

export function sitePaths(slug: string, sitesDir = SITES_DIR): SitePaths {
	const root = join(sitesDir, slug);
	return {
		root,
		config: join(root, "kit.config.ts"),
		state: join(root, "state.json"),
		overrides: join(root, "overrides.ts"),
		decisions: join(root, "decisions.md"),
		access: join(root, "ACCESS.md"),
		raw: join(root, "raw"),
		snapshot: join(root, "snapshot"),
		ir: join(root, "ir"),
		project: join(root, "project"),
		reports: join(root, "reports"),
		runs: join(root, "runs"),
	};
}

export function siteExists(slug: string, sitesDir = SITES_DIR): boolean {
	return existsSync(sitePaths(slug, sitesDir).config);
}
