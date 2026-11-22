/**
 * Report folder plumbing: copy what helps diagnose a run out of the temporary site (never .env, raw media or the
 * project's node_modules), scrub the throwaway credentials from every text file, and run the generated project's dev
 * server with its output kept in a log (the kit's own ensureDevServer discards it).
 */
import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, createWriteStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

/** Paths inside a site folder that go into the report (relative to the site root). */
export const SITE_COPY = ["state.json", "kit.config.ts", "overrides.ts", "decisions.md", "ACCESS.md", "reports", "runs", "ir", "snapshot", "raw/extract.json", "raw/exporter/probe.json", "raw/exporter/analyze.json", "raw/forms", "raw/plugin-exports", "raw/multilingual.json", "raw/media-manifest.json"];
/** Paths inside the generated project that go into the report. */
export const PROJECT_COPY = ["wrangler.jsonc", "astro.config.mjs", "package.json", "seed/seed.json", "src/forms", "src/site.config.json"];

/** Never copied, wherever it appears. */
export function excluded(rel: string, keepScreens: boolean): boolean {
	const parts = rel.split(/[\\/]/);
	if (parts.some((p) => p === ".env" || p.startsWith(".env.") || p === "node_modules" || p === ".wrangler")) return true;
	if (!keepScreens && parts.some((p) => p === "screens" || p === "diff" || p === "interactions")) return true;
	return false;
}

export function copyInto(srcRoot: string, rels: string[], destRoot: string, keepScreens = false): string[] {
	const copied: string[] = [];
	for (const rel of rels) {
		const src = join(srcRoot, rel);
		if (!existsSync(src) || excluded(rel, keepScreens)) continue;
		cpSync(src, join(destRoot, rel), { recursive: true, filter: (s) => !excluded(relative(srcRoot, s), keepScreens) });
		copied.push(rel);
	}
	return copied;
}

const TEXT = /\.(md|json|jsonl|txt|log|html|ts|mjs|jsonc|csv|xml|yml|yaml)$/i;

/** Replaces each secret (≥ 8 characters, also with spaces removed) in every text file under dir. Returns files changed. */
export function scrubSecrets(dir: string, secrets: string[]): number {
	const needles = [...new Set(secrets.flatMap((s) => [s, s.replace(/\s/g, "")]).filter((s) => s.length >= 8))];
	if (!needles.length || !existsSync(dir)) return 0;
	let changed = 0;
	const walk = (d: string) => {
		for (const e of readdirSync(d)) {
			const p = join(d, e);
			if (statSync(p).isDirectory()) walk(p);
			else if (TEXT.test(e)) {
				const text = readFileSync(p, "utf8");
				let next = text;
				for (const n of needles) next = next.split(n).join("[redacted]");
				if (next !== text) {
					writeFileSync(p, next);
					changed++;
				}
			}
		}
	};
	walk(dir);
	return changed;
}

export interface DevServer {
	base: string;
	stop: () => Promise<void>;
}

/** `pnpm dev --port <port>` in the project, output to logFile; resolves once /_emdash/api/setup/status answers. */
export async function startDevServer(project: string, port: number, logFile: string, timeoutMs = 180_000): Promise<DevServer> {
	const base = `http://localhost:${port}`;
	const log = createWriteStream(logFile, { flags: "a" });
	const child: ChildProcess = spawn("pnpm", ["dev", "--port", String(port)], { cwd: project, env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1", WRANGLER_SEND_METRICS: "false", CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
	child.stdout?.pipe(log);
	child.stderr?.pipe(log);
	let exited: number | null = null;
	child.on("exit", (code) => {
		exited = code ?? -1;
	});
	const stop = async () => {
		await new Promise<void>((res) => {
			const s = spawn("pnpm", ["exec", "astro", "dev", "stop"], { cwd: project, stdio: "ignore" });
			s.on("exit", () => res());
			s.on("error", () => res());
			setTimeout(res, 15_000);
		});
		if (exited === null) child.kill("SIGTERM");
		log.end();
	};
	const t0 = Date.now();
	while (Date.now() - t0 < timeoutMs) {
		try {
			const r = await fetch(`${base}/_emdash/api/setup/status`, { signal: AbortSignal.timeout(5000) });
			await r.body?.cancel();
			if (r.status < 500) return { base, stop };
		} catch {
			// not up yet
		}
		// The launcher exiting is not fatal: Astro 7 daemonises `astro dev` (load.ts → ensureDevServer), so keep polling.
		await new Promise((r) => setTimeout(r, 2000));
	}
	await stop();
	throw new Error(`dev server did not answer ${base}/_emdash/api/setup/status within ${timeoutMs / 1000} s (see ${logFile})`);
}
