/**
 * `wp2emdash import-dump <slug> [dir]`: the owner (or operator) puts everything exported from the site in one folder —
 * plugin exports, builder/theme settings, a full backup — and this sorts it into the places the phases read:
 *
 * - form and redirect plugin exports → raw/plugin-exports/ (read by extract)
 * - a backup's database.sql → builder options, allow-listed only, credentials dropped (import-options)
 * - Automatic.css settings, Bricks theme styles / settings, Rank Math settings → raw/ (adapters, scaffold)
 *
 * Nothing is uploaded anywhere. Form entries and uploaded files in a backup are never opened. The folder stays inside
 * the site workspace (gitignored); delete it when the project ends.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { sitePaths } from "../core/paths.js";
import { recognise } from "../extract/plugin-exports.js";
import { importOptions } from "./import-options.js";

export interface DumpItem {
	file: string;
	used: string;
	ok: boolean;
}

const MAX_TEXT = 20 * 1024 * 1024;
const BACKUP_SKIP = /(^|\/)(uploads|cache|plugins|themes|mu-plugins|languages|upgrade)(\/|$)/;

function readJson(file: string): unknown {
	try {
		return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
	} catch {
		return undefined;
	}
}

/** What a settings file is, from its content. */
export function classify(name: string, text: string): { kind: "acss" | "bricks-theme-style" | "bricks-settings" | "rankmath-settings" | "rankmath-seo-csv" | "other"; json?: unknown } {
	const json = /^\s*[[{]/.test(text) ? (() => { try { return JSON.parse(text); } catch { return undefined; } })() : undefined;
	const o = json && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : undefined;
	// Automatic.css settings: its colour channels (primary-h, accent-comp-h, base-s…) are the giveaway.
	if (o && Object.keys(o).filter((k) => /^(primary|secondary|accent|base|shade|neutral)-(comp-)?[hsl](-alt)?$/.test(k)).length >= 3) return { kind: "acss", json };
	if (o && "settings" in o && "label" in o && typeof o.settings === "object") return { kind: "bricks-theme-style", json };
	if (o && ("postTypes" in o || "builderMode" in o) && ("disableOpenGraph" in o || "smoothScroll" in o || "customBreakpoints" in o)) return { kind: "bricks-settings", json };
	if (o && "general" in o && "titles" in o && ("sitemap" in o || "redirections" in o)) return { kind: "rankmath-settings", json };
	if (/^\s*"?id"?,\s*"?object_type"?,\s*"?slug"?,\s*"?seo_title/i.test(text)) return { kind: "rankmath-seo-csv" };
	return { kind: "other", ...(json !== undefined ? { json } : {}) };
}

export async function importDump(slug: string, dir?: string, sitesDir?: string): Promise<DumpItem[]> {
	const paths = sitesDir ? sitePaths(slug, sitesDir) : sitePaths(slug);
	const root = dir ?? join(paths.root, "dump");
	if (!existsSync(root)) throw new Error(`No dump folder: ${root} (put the site's exports and backup there)`);
	const items: DumpItem[] = [];
	const exportsDir = join(paths.raw, "plugin-exports");
	mkdirSync(exportsDir, { recursive: true });
	const hosts = [] as string[];
	// Files at any depth. A backup (a folder holding a .sql dump) is read for its database only: its other files —
	// uploads, form uploads, plugins, caches — are never opened, just counted.
	let backupFiles = 0;
	const countFiles = (d: string): number => readdirSync(d).reduce((n, f) => n + (statSync(join(d, f)).isDirectory() ? countFiles(join(d, f)) : 1), 0);
	const walk = (d: string): string[] => {
		const names = readdirSync(d).filter((f) => !f.startsWith("."));
		const sql = names.filter((f) => /\.sql$/i.test(f));
		if (sql.length && d !== root) {
			backupFiles += countFiles(d) - sql.length;
			return sql.map((f) => join(d, f));
		}
		return names.flatMap((f) => {
			const p = join(d, f);
			if (BACKUP_SKIP.test(relative(root, p))) return [];
			return statSync(p).isDirectory() ? walk(p) : [p];
		});
	};
	const files = walk(root);
	for (const file of files) {
		const rel = relative(root, file);
		const name = basename(file);
		if (/\.sql$/i.test(name)) {
			try {
				const r = await importOptions(slug, file, sitesDir);
				items.push({ file: rel, used: `database dump → raw/bricks-options.json (${r.found.length ? r.found.join(", ") : "no builder options"}${r.dropped.length ? `; ${r.dropped.length} credential-like setting(s) left out` : ""}). Form entries and users are never read.`, ok: true });
			} catch (e) {
				items.push({ file: rel, used: `database dump not read: ${(e as Error).message}`, ok: false });
			}
			continue;
		}
		if (/\.(zip|gz|tgz|tar|wpress|php|js|css|map|png|jpe?g|webp|gif|svg|woff2?|ttf|otf|mp4|pdf|html?|log)$/i.test(name) || statSync(file).size > MAX_TEXT) {
			items.push({ file: rel, used: "not used (binary, code or archive — kept for reference only)", ok: true });
			continue;
		}
		const text = readFileSync(file, "utf8");
		const c = classify(name, text);
		const toRaw = (target: string, what: string) => {
			copyFileSync(file, join(paths.raw, target));
			items.push({ file: rel, used: `${what} → raw/${target}`, ok: true });
		};
		if (c.kind === "acss") toRaw("acss-settings.json", "Automatic.css settings");
		else if (c.kind === "bricks-theme-style") toRaw(`bricks-theme-style-${String((c.json as { id?: unknown }).id ?? "export").replace(/[^\w.-]/g, "_")}.json`, "Bricks theme style");
		else if (c.kind === "bricks-settings") toRaw("bricks-settings.json", "Bricks settings");
		else if (c.kind === "rankmath-settings") toRaw("rankmath-settings.json", "Rank Math settings");
		else if (c.kind === "rankmath-seo-csv") items.push({ file: rel, used: "Rank Math per-page SEO fields — the exporter already carries these; not needed", ok: true });
		else {
			const r = recognise(name, text, hosts);
			if (r.kind === "unknown") items.push({ file: rel, used: `not recognised (${r.reason})`, ok: false });
			else {
				copyFileSync(file, join(exportsDir, name));
				items.push({ file: rel, used: `${r.kind === "forms" ? `${r.forms.length} ${r.provider} form(s)` : `${r.rules.length} redirect(s) from ${r.provider}`} → raw/plugin-exports/ (read by extract)`, ok: true });
			}
		}
	}
	if (backupFiles) items.push({ file: "(backup)", used: `${backupFiles} other backup files (uploads, plugins, themes, caches) not opened — kept for reference only`, ok: true });
	return items;
}
