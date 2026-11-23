/**
 * `wp2emdash videos <slug>`: web sizes (720p, 480p) of the site's videos, stored next to the uploads in its media
 * bucket (src/targets/emdash/video-sizes.ts). Production by default once provisioned (--local: the local dev
 * database and bucket). Dry run without --yes: lists the videos still to do. Only adds files; the uploads, the
 * database and the pages are not changed.
 */
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config/load.js";
import { noProductionTargets, readCf, siteEnvironments } from "../core/environments.js";
import { sitePaths } from "../core/paths.js";
import { defaultVideoRunner, makeVideoSizes, projectBindings, type VideoRunner, type VideoSizesResult, videosToDo } from "../targets/emdash/video-sizes.js";

export interface VideosReport {
	target: "production" | "local";
	dryRun: boolean;
	todo: string[];
	result?: VideoSizesResult;
	exitCode: number;
	error?: string;
}

export async function videosCommand(slug: string, o: { yes?: boolean; local?: boolean; force?: boolean; runner?: VideoRunner; log?: (m: string) => void } = {}): Promise<VideosReport> {
	const paths = sitePaths(slug);
	const config = await loadConfig(paths.config);
	const envs = siteEnvironments(config, readCf(paths.root));
	const target = o.local || !envs.productionProvisioned ? "local" : "production";
	if (target === "production" && noProductionTargets()) return { target, dryRun: true, todo: [], exitCode: 1, error: "this run may not target production (WP2EMDASH_NO_PRODUCTION=1)" };
	if (!existsSync(join(paths.project, "wrangler.jsonc"))) return { target, dryRun: true, todo: [], exitCode: 1, error: `no project at ${paths.project} (run scaffold first)` };
	const runner = o.runner ?? defaultVideoRunner;
	const remote = target === "production";
	mkdirSync(join(paths.root, "load"), { recursive: true });
	const recordFile = join(paths.root, "load", "video-sizes.json");
	if (!o.yes) {
		const { db } = projectBindings(paths.project);
		if (!db) return { target, dryRun: true, todo: [], exitCode: 1, error: "wrangler.jsonc has no DB database" };
		const listed = runner.list(paths.project, db, remote);
		if ("error" in listed) return { target, dryRun: true, todo: [], exitCode: 1, error: listed.error };
		const rec = existsSync(recordFile) ? JSON.parse((await import("node:fs")).readFileSync(recordFile, "utf8")) : undefined;
		return { target, dryRun: true, todo: videosToDo(listed.rows, rec, o.force).map((r) => `${r.filename} (${(r.size / 1e6).toFixed(1)} MB)`), exitCode: 0 };
	}
	const result = makeVideoSizes({ project: paths.project, recordFile, remote, ...(o.force ? { force: true } : {}), runner, ...(o.log ? { log: o.log } : {}) });
	return { target, dryRun: false, todo: [], result, exitCode: result.errors.length ? 2 : 0 };
}

export function videosText(r: VideosReport): string {
	if (r.error) return `videos (${r.target}): ${r.error}`;
	if (r.dryRun) return r.todo.length ? `videos (${r.target}): ${r.todo.length} to make web sizes for:\n${r.todo.map((t) => `  ${t}`).join("\n")}\nRun again with --yes.` : `videos (${r.target}): every video has its web sizes.`;
	const res = r.result as VideoSizesResult;
	const lines = res.done.map((d) => `  ${d.filename}: ${(d.original / 1e6).toFixed(2)} MB → ${Object.entries(d.sizes).map(([s, b]) => `${s}p ${(b / 1e6).toFixed(2)} MB`).join(", ")}`);
	return [`videos (${r.target}): ${res.done.length} made, ${res.skipped} already done${res.errors.length ? `, ${res.errors.length} failed` : ""}`, ...lines, ...res.errors.map((e) => `  ✗ ${e}`)].join("\n");
}
