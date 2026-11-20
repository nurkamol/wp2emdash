/**
 * Long-running dashboard actions (go-live, alias redirects, rollback, publish, Worker secrets): one at a time per site
 * (single-flight), each written to sites/<slug>/runs/<runId>.jsonl like a phase run, so the Runs tab and the SSE stream
 * show it live. Every line is passed through the site's secret scrubber before it is written.
 *
 * External effects go through ActionDeps (child processes, fetch, .env reading) so tests can replace all of them:
 * no test ever calls Cloudflare, GitHub or wrangler.
 */
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { KIT_ROOT, sitePaths } from "../core/paths.js";
import { newRunId } from "../core/progress.js";
import { loadEnv, scrubSecrets } from "../extract/credentials.js";

export interface ExecResult {
	code: number;
	stdout: string;
	stderr: string;
}
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ExecOptions {
	cwd: string;
	env?: Record<string, string | undefined>;
	/** Written to stdin, then stdin is closed. Secret values travel only this way, never on the command line. */
	input?: string;
	timeoutMs?: number;
	onLine?: (line: string, stream: "stdout" | "stderr") => void;
}

export interface ActionDeps {
	/** Runs a command and collects its output. */
	exec(cmd: string, args: string[], o: ExecOptions): Promise<ExecResult>;
	/** Runs `wp2emdash <args>` (the kit CLI) against this dashboard's sites folder. */
	runCli(args: string[], o: { sitesDir: string; onLine?: ExecOptions["onLine"]; timeoutMs?: number }): Promise<ExecResult>;
	fetch: FetchLike;
	/** The kit .env and the site .env (default: read from disk). */
	env(siteRoot: string): { kit: Record<string, string>; site: Record<string, string> };
	now(): Date;
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: removing terminal colour codes is the point
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");

export function spawnExec(cmd: string, args: string[], o: ExecOptions): Promise<ExecResult> {
	return new Promise((resolve) => {
		const child = spawn(cmd, args, { cwd: o.cwd, env: { ...(o.env ?? process.env) } as NodeJS.ProcessEnv, stdio: ["pipe", "pipe", "pipe"] });
		const out: string[] = [];
		const err: string[] = [];
		const partial = { stdout: "", stderr: "" };
		const feed = (stream: "stdout" | "stderr", chunk: Buffer) => {
			const text = stripAnsi(chunk.toString("utf8"));
			(stream === "stdout" ? out : err).push(text);
			if (!o.onLine) return;
			const lines = (partial[stream] + text).split("\n");
			partial[stream] = lines.pop() ?? "";
			for (const l of lines) if (l.trim()) o.onLine(l, stream);
		};
		child.stdout.on("data", (c: Buffer) => feed("stdout", c));
		child.stderr.on("data", (c: Buffer) => feed("stderr", c));
		const timer = o.timeoutMs ? setTimeout(() => child.kill("SIGTERM"), o.timeoutMs) : undefined;
		child.on("error", (e) => {
			if (timer) clearTimeout(timer);
			resolve({ code: 127, stdout: out.join(""), stderr: `${err.join("")}${(e as NodeJS.ErrnoException).code ?? e.message}` });
		});
		child.on("close", (code) => {
			if (timer) clearTimeout(timer);
			for (const s of ["stdout", "stderr"] as const) if (o.onLine && partial[s].trim()) o.onLine(partial[s], s);
			resolve({ code: code ?? 1, stdout: out.join(""), stderr: err.join("") });
		});
		child.stdin.on("error", () => {});
		if (o.input !== undefined) child.stdin.end(o.input);
		else child.stdin.end();
	});
}

export function defaultDeps(): ActionDeps {
	return {
		exec: spawnExec,
		runCli: (args, o) =>
			spawnExec(process.execPath, [join(KIT_ROOT, "bin", "wp2emdash.js"), ...args], {
				cwd: KIT_ROOT,
				env: { ...process.env, WP2EMDASH_SITES_DIR: o.sitesDir, NO_COLOR: "1", FORCE_COLOR: "0" },
				...(o.onLine ? { onLine: o.onLine } : {}),
				timeoutMs: o.timeoutMs ?? 30 * 60_000,
			}),
		fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(20_000) }),
		env: (siteRoot) => ({ kit: loadEnv(join(KIT_ROOT, ".env")), site: loadEnv(join(siteRoot, ".env")) }),
		now: () => new Date(),
	};
}

/** kit .env overlaid by the site .env (site wins), as loadSiteEnv does, through the injectable reader. */
export const mergedEnv = (deps: ActionDeps, siteRoot: string): Record<string, string> => {
	const e = deps.env(siteRoot);
	return { ...e.kit, ...e.site };
};

// ── Single-flight ────────────────────────────────────────────────────────────────────────────────────────────

export interface BusyInfo {
	action: string;
	runId: string;
	startedAt: string;
}

/** One long-running dashboard action per site at a time. */
export class SiteLocks {
	private readonly busy = new Map<string, BusyInfo>();
	get(slug: string): BusyInfo | undefined {
		return this.busy.get(slug);
	}
	tryAcquire(slug: string, info: BusyInfo): boolean {
		if (this.busy.has(slug)) return false;
		this.busy.set(slug, info);
		return true;
	}
	release(slug: string, runId: string): void {
		if (this.busy.get(slug)?.runId === runId) this.busy.delete(slug);
	}
}

export class BusyError extends Error {
	constructor(readonly info: BusyInfo) {
		super(`Another dashboard action is running for this site (${info.action}, run ${info.runId}). Wait for it to finish.`);
	}
}

// ── Run log ──────────────────────────────────────────────────────────────────────────────────────────────────

export interface ActionRun {
	runId: string;
	log(level: "info" | "warn" | "error", message: string): void;
	step(step: string, ok: boolean, detail?: string): void;
	end(ok: boolean): void;
}

/** Action names double as the run's "phase" in the log; none of them is a pipeline phase, so no gate is touched. */
export const ACTIONS = ["golive", "golive-aliases", "golive-rollback", "golive-rollback-aliases", "publish", "secret-put"] as const;
export type ActionName = (typeof ACTIONS)[number];

export function openActionRun(slug: string, action: ActionName, sitesDir: string, deps: ActionDeps): ActionRun {
	const paths = sitePaths(slug, sitesDir);
	const runId = `${newRunId(deps.now())}-ui`;
	mkdirSync(paths.runs, { recursive: true });
	const file = join(paths.runs, `${runId}.jsonl`);
	const env = mergedEnv(deps, paths.root);
	const write = (event: Record<string, unknown>) => {
		const scrubbed = Object.fromEntries(Object.entries(event).map(([k, v]) => [k, typeof v === "string" ? scrubSecrets(v, env) : v]));
		appendFileSync(file, `${JSON.stringify({ at: deps.now().toISOString(), ...scrubbed })}\n`);
	};
	write({ type: "phase:start", phase: action });
	return {
		runId,
		log: (level, message) => write({ type: "log", level, message }),
		step: (step, ok, detail) => write({ type: "step:end", step, ok, ...(detail ? { detail } : {}) }),
		end: (ok) => write({ type: "phase:end", phase: action, ok }),
	};
}

/**
 * Starts `work` as a single-flight action for the site and returns its run id at once; the work continues in the
 * background and its progress is in the run log. Throws BusyError when another action holds the site.
 */
export function startAction(
	locks: SiteLocks,
	slug: string,
	action: ActionName,
	sitesDir: string,
	deps: ActionDeps,
	work: (run: ActionRun) => Promise<boolean>,
	onDone?: (ok: boolean) => void,
): { runId: string; done: Promise<boolean> } {
	const held = locks.get(slug);
	if (held) throw new BusyError(held);
	const run = openActionRun(slug, action, sitesDir, deps);
	if (!locks.tryAcquire(slug, { action, runId: run.runId, startedAt: deps.now().toISOString() })) throw new BusyError(locks.get(slug) as BusyInfo);
	const done = (async () => {
		let ok = false;
		try {
			ok = await work(run);
		} catch (e) {
			run.log("error", `✖ ${(e as Error).message}`);
			ok = false;
		} finally {
			run.end(ok);
			locks.release(slug, run.runId);
		}
		onDone?.(ok);
		return ok;
	})();
	return { runId: run.runId, done };
}
