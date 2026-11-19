import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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

/**
 * Creates sites/<slug>/ with config, checklist, decisions log, overrides and state. Never overwrites.
 * With `from`, the config, overrides and decisions are copied from that existing site (a sibling: same studio,
 * another domain) instead of the blank templates — see `siblingFiles`. Nothing else is copied.
 */
export function initSite(answers: InitAnswers, sitesDir?: string, from?: string): InitResult {
	const p = sitePaths(answers.slug, sitesDir);
	if (existsSync(p.config)) {
		throw new Error(`Site "${answers.slug}" already exists at ${p.root}`);
	}
	// Read and rewrite the sibling's files before anything is created, so a failure leaves no half-made workspace.
	const sibling = from ? siblingFiles(from, answers, sitesDir) : undefined;
	for (const dir of [p.root, p.raw, p.snapshot, p.ir, p.reports, p.runs]) mkdirSync(dir, { recursive: true });

	const files: [string, string][] = [
		[p.config, sibling?.config ?? configTemplate(answers)],
		[p.access, accessTemplate(answers)],
		[p.decisions, sibling?.decisions ?? decisionsTemplate(answers)],
		[p.overrides, sibling?.overrides ?? overridesTemplate()],
		[join(p.root, ".gitignore"), SITE_GITIGNORE],
		[join(p.root, ".env.example"), "# Copy to .env — never commit real values\nEMDASH_WP_MIGRATION_KEY=\nWP_APP_USER=\nWP_APP_PASSWORD=\nEMDASH_TOKEN=\n"],
	];
	for (const [file, content] of files) writeFileSync(file, content, { flag: "wx" });
	writeState(p.state, newState(answers.slug));

	return { root: p.root, created: [...files.map(([f]) => f), p.state] };
}

const today = () => new Date().toISOString().slice(0, 10);

/**
 * Config, overrides and decisions of an existing site, adapted for a new sibling site. Only these three files: never
 * .env, raw/, dump/, snapshot/, ir/, reports/, runs/, cutover/, cloudflare.json or state.json (client data, secrets,
 * another site's resources and progress).
 */
export function siblingFiles(from: string, answers: InitAnswers, sitesDir?: string): { config: string; overrides: string; decisions: string } {
	if (from === answers.slug) throw new Error("--from must name another site");
	const src = sitePaths(from, sitesDir);
	if (!existsSync(src.config)) throw new Error(`No site "${from}" to start from (${src.config} not found)`);
	const config = siblingConfig(readFileSync(src.config, "utf8"), from, answers);
	const overrides = existsSync(src.overrides) ? readFileSync(src.overrides, "utf8") : overridesTemplate();
	const base = existsSync(src.decisions) ? readFileSync(src.decisions, "utf8") : decisionsTemplate(answers);
	const titled = base.replace(/^# Decisions — .*$/m, `# Decisions — ${answers.name}`);
	const decisions = `${titled.replace(/\n*$/, "\n")}| ${today()} | init | Started from ${from}: kit.config.ts, overrides.ts and decisions.md copied, nothing else | Sibling site (same studio, another domain) | wp2emdash init --from |\n`;
	return { config, overrides, decisions };
}

/** Rewrites slug, name, source.url and target.productionUrl; drops projectDir and stagingUrl (they belong to the other site). */
export function siblingConfig(text: string, from: string, a: InitAnswers): string {
	// A quoted string literal; `n` = number of its quote's capture group in the surrounding pattern.
	const str = (n: number) => `(["'\\x60])(?:(?!\\${n}).)*\\${n}`;
	const replaceKey = (input: string, key: string, value: string, after?: RegExp): string => {
		const start = after ? input.search(after) : 0;
		if (start < 0) throw new Error(`Cannot start from ${from}: no ${after} block in its kit.config.ts`);
		const re = new RegExp(String.raw`^([ \t]*${key}\s*:\s*)${str(2)}`, "m");
		const tail = input.slice(start);
		if (!re.test(tail)) throw new Error(`Cannot start from ${from}: "${key}" is not a plain string in its kit.config.ts — create the site without --from`);
		return input.slice(0, start) + tail.replace(re, (_m, pre: string) => `${pre}${JSON.stringify(value)}`);
	};
	// Top-level keys sit at the indentation of `slug:`; `name:` also appears in nested objects (viewports).
	const indent = /^([ \t]*)slug\s*:/m.exec(text)?.[1];
	if (indent === undefined) throw new Error(`Cannot start from ${from}: no slug in its kit.config.ts`);
	let out = replaceKey(text, "slug", a.slug);
	out = replaceKey(out, `(?<=^${indent})name`, a.name);
	out = replaceKey(out, "url", a.sourceUrl, /^[ \t]*source\s*:/m);
	out = replaceKey(out, "productionUrl", a.productionUrl);
	out = out.replace(new RegExp(String.raw`^[ \t]*(?:projectDir|stagingUrl)\s*:\s*${str(1)}\s*,?[ \t]*(?://.*)?\r?\n`, "gm"), "");
	const note = `// Started from sites/${from}/kit.config.ts on ${today()} (wp2emdash init --from ${from}): slug, name, source.url and\n// target.productionUrl replaced; projectDir and stagingUrl removed. Review what is specific to the other site:\n// source.alternateHosts, target.aliasDomains, analytics ids, email, forms.turnstileSiteKey, target.staging.host.\n`;
	return note + out;
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
