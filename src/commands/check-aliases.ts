import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/load.js";
import { sitePaths } from "../core/paths.js";
import { type AliasCheckResult, aliasCheckReport, checkAliasRedirects, primaryHost } from "../cutover/aliases.js";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Audited page paths of a site (snapshot/urls.json: HTML pages that answered 200). */
export function auditedPaths(snapshotDir: string): string[] {
	const file = join(snapshotDir, "urls.json");
	if (!existsSync(file)) return [];
	const urls = JSON.parse(readFileSync(file, "utf8")) as { path: string; status: number; kind: string }[];
	return urls.filter((u) => u.kind === "page" && u.status === 200).map((u) => u.path);
}

/**
 * Post-switch check (read-only): every audited path of the primary — and of the alias sites' own audits, `pathsFrom` —
 * on each alias domain, apex and www, must answer 301 to the same path on the primary. Writes cutover/aliases-check.{md,json}.
 */
export async function checkAliases(slug: string, o: { pathsFrom?: string[]; limit?: number; sitesDir?: string; fetch?: FetchLike } = {}): Promise<{ result: AliasCheckResult; md: string; json: string }> {
	const p = o.sitesDir ? sitePaths(slug, o.sitesDir) : sitePaths(slug);
	const config = await loadConfig(p.config);
	const aliases = config.target.aliasDomains;
	if (!aliases.length) throw new Error(`No target.aliasDomains in sites/${slug}/kit.config.ts`);
	let paths = auditedPaths(p.snapshot);
	for (const other of o.pathsFrom ?? []) paths.push(...auditedPaths((o.sitesDir ? sitePaths(other, o.sitesDir) : sitePaths(other)).snapshot));
	paths = [...new Set(paths)];
	if (!paths.length) throw new Error(`No audited paths: run \`wp2emdash run ${slug} audit\` first`);
	if (o.limit) paths = paths.slice(0, o.limit);
	const result = await checkAliasRedirects({ aliases, primary: primaryHost(config.target.productionUrl, config.target.canonicalHost), paths, ...(o.fetch ? { fetch: o.fetch } : {}) });
	const dir = join(p.root, "cutover");
	mkdirSync(dir, { recursive: true });
	const md = join(dir, "aliases-check.md");
	const json = join(dir, "aliases-check.json");
	writeFileSync(md, aliasCheckReport(result));
	writeFileSync(json, `${JSON.stringify(result, null, 2)}\n`);
	return { result, md, json };
}
