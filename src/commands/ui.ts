import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pc from "picocolors";
import { KIT_ROOT, SITES_DIR } from "../core/paths.js";
import { startUiServer, type UiServer } from "../ui/server.js";

/** Starts the local dashboard (127.0.0.1, random port, one-time token) and optionally opens the browser. */
export async function startUi(opts: { open?: boolean; port?: number; sitesDir?: string } = {}): Promise<UiServer> {
	const ui = await startUiServer({ sitesDir: opts.sitesDir ?? SITES_DIR, ...(opts.port ? { port: opts.port } : {}) });
	if (opts.open !== false) openBrowser(ui.url);
	return ui;
}

function openBrowser(url: string): void {
	const [cmd, args]: [string, string[]] =
		process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
	try {
		const child = spawn(cmd, args, { stdio: "ignore", detached: true });
		child.on("error", () => {});
		child.unref();
	} catch {
		// no browser available: the URL is printed anyway
	}
}

/** Starts the dashboard, prints its URL and keeps running until Ctrl+C. */
export async function serveUi(opts: { open?: boolean; port?: number } = {}): Promise<void> {
	const ui = await startUi(opts);
	console.log(`${pc.bold("wp2emdash dashboard")} ${pc.dim("(local only; the token in this URL is valid until you stop the server)")}`);
	console.log(`  ${pc.cyan(ui.url)}`);
	console.log(pc.dim("  Writes only what you decide in it: visual decisions, approved proposals, secrets (.env, write-only). Ctrl+C to stop."));
	const stop = () => void ui.close().then(() => process.exit(0));
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
}

export type WorkMode = "terminal" | "web";
const PREFS = () => join(KIT_ROOT, ".wp2emdash.local.json");

/** How the operator likes to work: WP2EMDASH_MODE wins, else the last choice (kept in a gitignored local file). */
export function preferredMode(env: Record<string, string | undefined> = process.env, file = PREFS()): { mode?: WorkMode; fromEnv: boolean } {
	const e = env.WP2EMDASH_MODE;
	if (e === "terminal" || e === "web") return { mode: e, fromEnv: true };
	try {
		const m = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { mode?: unknown }).mode : undefined;
		return { ...(m === "terminal" || m === "web" ? { mode: m } : {}), fromEnv: false };
	} catch {
		return { fromEnv: false };
	}
}

export function rememberMode(mode: WorkMode, file = PREFS()): void {
	try {
		const prev = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : {};
		writeFileSync(file, `${JSON.stringify({ ...prev, mode }, null, 2)}\n`);
	} catch {
		// a preference only: never fail the run over it
	}
}
