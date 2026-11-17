import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sitePaths } from "../core/paths.js";
import { newState, writeState } from "../core/state.js";
import {
	accessTemplate,
	configTemplate,
	decisionsTemplate,
	type InitAnswers,
	overridesTemplate,
	SITE_GITIGNORE,
} from "../templates/site.js";

export interface InitResult {
	root: string;
	created: string[];
}

/** Creates sites/<slug>/ with config, checklist, decisions log, overrides and state. Never overwrites. */
export function initSite(answers: InitAnswers, sitesDir?: string): InitResult {
	const p = sitePaths(answers.slug, sitesDir);
	if (existsSync(p.config)) {
		throw new Error(`Site "${answers.slug}" already exists at ${p.root}`);
	}
	for (const dir of [p.root, p.raw, p.snapshot, p.ir, p.reports, p.runs]) mkdirSync(dir, { recursive: true });

	const files: [string, string][] = [
		[p.config, configTemplate(answers)],
		[p.access, accessTemplate(answers)],
		[p.decisions, decisionsTemplate(answers)],
		[p.overrides, overridesTemplate()],
		[join(p.root, ".gitignore"), SITE_GITIGNORE],
		[join(p.root, ".env.example"), "# Copy to .env — never commit real values\nEMDASH_WP_MIGRATION_KEY=\nWP_APP_USER=\nWP_APP_PASSWORD=\nEMDASH_TOKEN=\n"],
	];
	for (const [file, content] of files) writeFileSync(file, content, { flag: "wx" });
	writeState(p.state, newState(answers.slug));

	return { root: p.root, created: [...files.map(([f]) => f), p.state] };
}

export function validateSlug(value: string): string | undefined {
	if (!/^[a-z0-9-]+$/.test(value)) return "Use lowercase letters, digits and hyphens";
	return undefined;
}

export function validateUrl(value: string): string | undefined {
	try {
		const u = new URL(value);
		if (!/^https?:$/.test(u.protocol)) return "Must start with http:// or https://";
		return undefined;
	} catch {
		return "Not a valid URL";
	}
}
