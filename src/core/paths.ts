import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
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

/**
 * Where the site's deployable project lives: `projectDir` in kit.config.ts (a plain string; `~` = home, relative =
 * from the site folder), else `sites/<slug>/project`. Read as text so path helpers stay synchronous.
 */
export function projectDirFrom(configText: string, root: string): string | undefined {
	const m = /^\s*projectDir\s*:\s*(["'`])([^"'`\n]+)\1/m.exec(configText);
	const raw = m?.[2]?.trim();
	if (!raw) return undefined;
	const expanded = raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw;
	return resolve(root, expanded);
}

export function sitePaths(slug: string, sitesDir = SITES_DIR): SitePaths {
	const root = join(sitesDir, slug);
	const configFile = join(root, "kit.config.ts");
	const projectDir = existsSync(configFile) ? projectDirFrom(readFileSync(configFile, "utf8"), root) : undefined;
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
		project: projectDir ?? join(root, "project"),
		reports: join(root, "reports"),
		runs: join(root, "runs"),
	};
}

export function siteExists(slug: string, sitesDir = SITES_DIR): boolean {
	return existsSync(sitePaths(slug, sitesDir).config);
}
